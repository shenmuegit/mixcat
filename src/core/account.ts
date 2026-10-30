import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CodexPort, NativeClientOptions, RuntimeStatus } from '../shared/types.js';
import { createCodexClient } from './codex.js';
import { insideProject, projectDirectory } from './paths.js';

interface AccountTokens { accessToken: string; chatgptAccountId: string; chatgptPlanType: string | null; }
interface Connection { client: CodexPort; connected: boolean; closing?: Promise<void>; closeFailed?: boolean; }

// Only the account owner holds refresh credentials; project servers receive access tokens in memory.
export class SharedAccount {
  readonly status: RuntimeStatus = { connected: false, authenticated: false, accountLabel: null, error: null, mode: 'codex' };
  private connection: Connection | undefined;
  private connecting: Promise<Connection> | undefined;
  private reading: { force: boolean; promise: Promise<AccountTokens | null> } | undefined;
  private authRevision = 0;
  private owned = new Set<Connection>();
  private closed = false;
  private closing: Promise<void> | undefined;
  private closeFailed = false;
  constructor(private root: string, private executable: string, private changed: () => void, private factory = createCodexClient) {}
  private current(connection: Connection) { return !this.closed && this.connection === connection && connection.connected; }
  private retire(connection: Connection, retryFailed = false) {
    if (retryFailed && connection.closeFailed) { connection.closing = undefined; connection.closeFailed = false; }
    connection.closing ??= Promise.resolve().then(() => connection.client.close()).catch(error => { connection.closeFailed = true; throw error; });
    void connection.closing.then(() => this.owned.delete(connection), () => {});
    return connection.closing;
  }
  private client(): Promise<Connection> {
    if (this.closed) return Promise.reject(new Error('客户端账号连接已关闭。'));
    if (this.connecting) return this.connecting;
    if (this.connection?.connected) return Promise.resolve(this.connection);
    const pending = (async () => {
      if (this.connection) { const old = this.connection; this.connection = undefined; await this.retire(old); }
      if (this.closed) throw new Error('客户端账号连接已关闭。');
      const home = projectDirectory(this.root, '.runtime', 'client', 'account');
      let connection: Connection;
      const alive = () => !this.closed && this.connection === connection;
      const options: NativeClientOptions = { executable: this.executable, home, cwd: this.root,
        onDisconnect: error => { if (alive()) { connection.connected = false; Object.assign(this.status, { connected: false, authenticated: false, error }); this.changed(); } },
        onEvent: event => {
          if (!alive()) return;
          if (event.method === 'account/login/completed' && !event.params?.success) { this.status.error = 'Codex 登录未完成，请重试。'; this.changed(); return; }
          if (['account/login/completed', 'account/updated'].includes(event.method)) { this.authRevision++; void this.credentials().catch(() => {}); }
        },
        onRequest: request => {
          if (!alive()) return;
          if (request.method === 'currentTime/read') connection.client.respond?.(request.id, { currentTimeAt: Math.floor(Date.now() / 1000) });
          else connection.client.reject?.(request.id, { code: -32601, message: 'The account connection does not run project tasks.' });
        } };
      connection = { client: this.factory(options), connected: false };
      this.owned.add(connection); this.connection = connection;
      try {
        await connection.client.connect();
        if (!alive()) throw new Error('客户端账号连接已关闭或更换。');
        connection.connected = true;
        const native = connection.client.info?.();
        Object.assign(this.status, { connected: true, error: null, native, version: native?.version ?? undefined });
        this.changed(); return connection;
      } catch (error) {
        if (alive()) { connection.connected = false; this.status.connected = false; this.status.error = 'Codex 账号连接失败，请重试连接。'; this.changed(); }
        await this.retire(connection); throw error;
      }
    })();
    this.connecting = pending;
    void pending.finally(() => { if (this.connecting === pending) this.connecting = undefined; }).catch(() => {});
    return pending;
  }
  credentials(force = false): Promise<AccountTokens | null> {
    if (this.closed) return Promise.reject(new Error('客户端账号连接已关闭。'));
    if (this.reading) return force && !this.reading.force ? this.reading.promise.then(() => this.credentials(true)) : this.reading.promise;
    const operation = { force, promise: this.readCredentials(force) };
    this.reading = operation;
    void operation.promise.finally(() => { if (this.reading === operation) this.reading = undefined; }).catch(() => {});
    return operation.promise;
  }
  private async readCredentials(force: boolean): Promise<AccountTokens | null> {
    const connection = await this.client();
    if (!this.current(connection)) throw new Error('客户端账号连接已关闭或更换。');
    const revision = this.authRevision;
    try {
      let result: any;
      for (let attempt = 0; attempt < 2; attempt++) {
        try { result = await connection.client.rpc('account/read', { refreshToken: force }); break; }
        catch (error) {
          if (attempt || !(error instanceof Error) || error.message !== 'workspace routing discovery timed out') throw error;
          await new Promise(resolve => setTimeout(resolve, 250));
          if (!this.current(connection)) throw new Error('客户端账号连接已关闭或更换。');
        }
      }
      if (!this.current(connection)) throw new Error('客户端账号连接已关闭或更换。');
      if (revision !== this.authRevision) return this.readCredentials(force);
      Object.assign(this.status, { authenticated: !!result.account, accountLabel: result.account?.email ?? (result.account ? 'Codex 已登录' : null), error: null });
      if (!result.account) { this.changed(); return null; }
      let auth: any;
      try { auth = JSON.parse(readFileSync(insideProject(this.root, join(this.root, '.runtime', 'client', 'account', 'auth.json')), 'utf8')); }
      catch { throw new Error('无法读取客户端 Codex 登录凭据，请在设置中重新登录。'); }
      const accessToken = auth?.tokens?.access_token, chatgptAccountId = auth?.tokens?.account_id;
      if (typeof accessToken !== 'string' || !accessToken || typeof chatgptAccountId !== 'string' || !chatgptAccountId) throw new Error('客户端 Codex 登录凭据不完整，请在设置中重新登录。');
      this.changed();
      return { accessToken, chatgptAccountId, chatgptPlanType: result.account.planType ?? null };
    } catch (error) {
      if (this.current(connection) && revision !== this.authRevision) return this.readCredentials(force);
      if (this.current(connection)) { this.status.authenticated = false; this.status.error = '读取 Codex 账号失败，请重试连接或重新登录。'; this.changed(); }
      throw error;
    }
  }
  async connect() { await this.credentials(); }
  async restore() {
    if (this.closed) throw new Error('客户端账号连接已关闭。');
    if (existsSync(insideProject(this.root, join(this.root, '.runtime', 'client', 'account', 'auth.json')))) await this.connect();
  }
  async login() {
    const connection = await this.client();
    if (!this.current(connection)) throw new Error('客户端账号连接已关闭或更换。');
    const result = await connection.client.rpc('account/login/start', { type: 'chatgpt' });
    if (!this.current(connection)) throw new Error('客户端账号连接已关闭或更换。');
    if (typeof result.authUrl !== 'string' || !result.authUrl) throw new Error('Codex 未返回登录地址。');
    return result.authUrl;
  }
  close(retryFailed = false): Promise<void> {
    if (retryFailed && this.closeFailed) { this.closing = undefined; this.closeFailed = false; }
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      const results = await Promise.allSettled([...this.owned].map(connection => this.retire(connection, retryFailed)));
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, '客户端账号连接未全部关闭。');
    })().catch(error => { this.closeFailed = true; throw error; });
    return this.closing;
  }
}
