import { createHash } from 'node:crypto';
import type { CodexPort, NativeClientOptions, RuntimeStatus } from '../shared/types.js';
import { classifyNativeRequest } from '../shared/native-requests.js';
import { SharedAccount } from './account.js';
import { createCodexClient } from './codex.js';
import { createDemoClient } from './demo.js';

export interface NativeRuntimeHostOptions extends NativeClientOptions {
  mode: 'codex' | 'demo';
  account: SharedAccount;
  nativeFactory?: (options: NativeClientOptions) => CodexPort;
  isCurrent(): boolean;
  onStatus(status: RuntimeStatus): void;
}
export interface NativeRuntimeHandle {
  client: CodexPort;
  status: RuntimeStatus;
  connect(): Promise<void>;
  ensureAccount(): Promise<void>;
  close(): Promise<void>;
}

// The owner registers this handle before connect can deliver native callbacks.
export function createNativeRuntime(options: NativeRuntimeHostOptions): NativeRuntimeHandle {
  const status: RuntimeStatus = { connected: false, authenticated: false, accountLabel: null, error: null, mode: options.mode };
  let valid = true, accountFingerprint: string | undefined, closing: Promise<void> | undefined;
  const current = () => valid && options.isCurrent();
  const connected = () => current() && status.connected;
  const changed = () => options.onStatus(status);
  const pendingRefreshes = new Set<number | string>();
  const clientOptions: NativeClientOptions = {
    executable: options.executable, home: options.home, cwd: options.cwd,
    onEvent(event) {
      if (!current()) return;
      if (event.method === 'serverRequest/resolved') pendingRefreshes.delete(event.params?.requestId);
      options.onEvent(event);
    },
    onDisconnect(error) {
      if (!current()) return;
      try { status.connected = false; options.onDisconnect(error); }
      finally { valid = false; pendingRefreshes.clear(); }
    },
    onRequest(request) {
      if (!current()) return;
      if (request.method === 'currentTime/read') { client.respond?.(request.id, { currentTimeAt: Math.floor(Date.now() / 1000) }); return; }
      if (request.method === 'account/chatgptAuthTokens/refresh') {
        pendingRefreshes.add(request.id);
        void options.account.credentials(true).then(tokens => {
          if (!current() || !pendingRefreshes.has(request.id)) return;
          if (!tokens || (request.params?.previousAccountId && request.params.previousAccountId !== tokens.chatgptAccountId)) throw new Error('账号已失效或发生变化，请停止并核对当前任务。');
          pendingRefreshes.delete(request.id);
          try { client.respond?.(request.id, tokens); } catch { /* The native request may already have expired. */ }
        }).catch(() => {
          if (current() && pendingRefreshes.delete(request.id)) {
            try { client.reject?.(request.id, { code: -32000, message: '共享账号刷新失败，请在设置中核对登录状态。' }); } catch { /* The native request may already have expired. */ }
            status.authenticated = false; status.error = '共享账号刷新失败，请在设置中核对登录状态。'; changed();
          }
        });
        return;
      }
      if (classifyNativeRequest(request) === 'unsupported') client.reject?.(request.id, { code: -32601, message: `Mixcat has not implemented this host request: ${request.method}` });
      options.onRequest?.(request);
    },
  };
  const client = options.mode === 'demo' ? createDemoClient(clientOptions) : (options.nativeFactory ?? createCodexClient)(clientOptions);
  return {
    client, status,
    async connect() {
      try {
        await client.connect();
        if (!current()) throw new Error('连接期间原生环境已关闭或更换。');
        status.connected = true; status.native = client.info?.(); status.version = status.native?.version ?? undefined; changed();
      } catch (error) {
        if (current()) { status.connected = false; status.error = String(error); changed(); }
        valid = false; throw error;
      }
    },
    async ensureAccount() {
      if (!connected()) return;
      if (options.mode === 'codex') {
        const tokens = await options.account.credentials();
        if (!connected()) return;
        if (!tokens) { status.authenticated = false; status.accountLabel = null; status.error = null; changed(); return; }
        const fingerprint = createHash('sha256').update(JSON.stringify(tokens)).digest('hex');
        if (accountFingerprint !== fingerprint) {
          try { await client.rpc('account/login/start', { type: 'chatgptAuthTokens', ...tokens }); }
          catch {
            if (connected()) { status.authenticated = false; status.error = '当前 Codex 版本无法接入共享账号，请核对原生协议兼容性。'; changed(); }
            throw new Error('当前 Codex 版本无法接入共享账号，请核对原生协议兼容性。');
          }
          if (!connected()) return;
          accountFingerprint = fingerprint;
        }
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const result = await client.rpc('account/read', { refreshToken: false });
          if (!connected()) return;
          status.authenticated = !!result.account;
          status.accountLabel = result.account?.email ?? (result.account ? 'Codex 已登录' : null);
          status.error = null; changed(); return;
        } catch (error) {
          if (!connected()) return;
          const routingTimeout = error instanceof Error && error.message === 'workspace routing discovery timed out';
          if (routingTimeout && attempt === 0) {
            await new Promise(resolve => setTimeout(resolve, 250));
            if (!connected()) return;
            continue;
          }
          const message = routingTimeout ? '读取 Codex 工作区路由超时，请重试连接。现有登录信息和任务记录已保留。' : error instanceof Error ? error.message : String(error);
          status.error = message; changed();
          if (routingTimeout) throw new Error(message, { cause: error });
          throw error;
        }
      }
    },
    close() {
      valid = false; pendingRefreshes.clear();
      closing ??= Promise.resolve().then(() => client.close());
      return closing;
    },
  };
}
