import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { CodexPort, NativeClientOptions, NativeRuntimeInfo } from '../shared/types.js';

type Pending = { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

function executablePath(executable: string, cwd: string, env: NodeJS.ProcessEnv): string | null {
  const bases = path.isAbsolute(executable) ? [executable] : executable.includes('/') || executable.includes('\\')
    ? [path.resolve(cwd, executable)] : [cwd, ...(env.PATH ?? '').split(path.delimiter)].map(directory => path.join(directory, executable));
  const extensions = process.platform === 'win32' && !path.extname(executable) ? ['', ...(env.PATHEXT ?? '.EXE;.COM').split(';')] : [''];
  for (const base of bases) for (const extension of extensions) {
    const candidate = base + extension;
    if (lstatSync(candidate, { throwIfNoEntry: false })?.isFile()) return realpathSync(candidate);
  }
  return null;
}

function executableVersion(executable: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise(resolve => {
    // Optional discovery must not prevent initialization of older binaries.
    execFile(executable, ['--version'], { cwd, env, windowsHide: true, timeout: 1500, maxBuffer: 4096 }, (error, stdout) => {
      resolve(error ? null : stdout.trim().match(/^(?:codex(?:-cli)?\s+)?v?(\d+\.\d+\.\d+[a-zA-Z0-9.+-]*)$/)?.[1] ?? null);
    });
  });
}

function dispatchError(message: string, outcome: 'not-sent' | 'unknown') {
  return Object.assign(new Error(message), { outcome });
}

function runtimeEnvironment(cwd: string, home: string): NodeJS.ProcessEnv {
  if (!path.isAbsolute(cwd) || !path.isAbsolute(home)) throw new Error('Native paths must be absolute');
  const root = path.resolve(cwd);
  const target = path.resolve(home);
  if (/^(?:\\\\\?\\)?c:/i.test(root) || /^(?:\\\\\?\\)?c:/i.test(target)) throw new Error('Native runtime data cannot be on C:');
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Native home must be inside its project');
  for (const entry of [root, target]) {
    for (let current = entry; ; current = path.dirname(current)) {
      if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('Native paths cannot contain a symlink or junction');
      if (path.dirname(current) === current) break;
    }
  }
  if (!lstatSync(root).isDirectory() || path.relative(root, realpathSync(root)) !== '') throw new Error('Native project must be a real directory');
  const directories = [target];
  while (directories.length) {
    const directory = directories.pop()!;
    const stat = lstatSync(directory, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw new Error('Native home cannot contain a symlink or junction');
    if (stat?.isDirectory()) directories.push(...readdirSync(directory).map(entry => path.join(directory, entry)));
  }
  const dirs = {
    CODEX_HOME: target, TEMP: path.join(target, 'tmp'), TMP: path.join(target, 'tmp'),
    XDG_CACHE_HOME: path.join(target, 'cache'), XDG_CONFIG_HOME: path.join(target, 'config'),
    XDG_DATA_HOME: path.join(target, 'data'), HOME: path.join(target, 'profile'),
    USERPROFILE: path.join(target, 'profile'), APPDATA: path.join(target, 'appdata'),
    LOCALAPPDATA: path.join(target, 'localappdata'),
  };
  for (const directory of new Set(Object.values(dirs))) {
    mkdirSync(directory, { recursive: true });
  }
  if (process.platform === 'win32') mkdirSync(path.join(dirs.APPDATA, 'npm'), { recursive: true });
  // Keep OS and network settings without borrowing the host's API credentials.
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'OS', 'SystemDrive', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.NO_PROXY = env.no_proxy = [...new Set([env.NO_PROXY, env.no_proxy, '127.0.0.1', 'localhost', '::1'].filter(Boolean))].join(',');
  return { ...env, ...dirs };
}

export function createCodexClient(options: NativeClientOptions): CodexPort {
  let child: ChildProcessWithoutNullStreams | null = null;
  let owned: ChildProcessWithoutNullStreams | null = null;
  let processClosed: Promise<void> = Promise.resolve();
  let connecting: Promise<void> | null = null;
  let ready = false;
  let info: NativeRuntimeInfo = { executable: null, version: null, initialize: null };
  let nextId = 1;
  const pending = new Map<number, Pending>();
  const serverRequests = new Set<number | string>();

  function drain(message: string) {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(dispatchError(message, 'unknown'));
    }
    pending.clear();
    serverRequests.clear();
  }

  function disconnect(process: ChildProcessWithoutNullStreams, message: string) {
    if (child !== process) return;
    ready = false;
    child = null;
    drain(message);
    if (process.exitCode === null && process.signalCode === null) process.kill();
    options.onDisconnect(message);
  }

  function request(method: string, params: Record<string, unknown>): Promise<any> {
    const process = child;
    if (!process || !process.stdin.writable) return Promise.reject(dispatchError('Codex is not connected', 'not-sent'));
    let encoded: string;
    const id = nextId++;
    try { encoded = JSON.stringify({ id, method, params }) + '\n'; }
    catch { return Promise.reject(dispatchError('Request is not JSON serializable', 'not-sent')); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(dispatchError(`Codex request timed out: ${method}; its outcome is unknown`, 'unknown'));
      }, 30_000);
      pending.set(id, { resolve, reject, timer });
      process.stdin.write(encoded, error => {
        if (error) disconnect(process, 'Codex input stream failed; outstanding outcomes are unknown');
      });
    });
  }

  function receive(process: ChildProcessWithoutNullStreams, line: string) {
    if (child !== process) return;
    let message: any;
    try {
      message = JSON.parse(line);
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error();
    } catch {
      disconnect(process, 'Codex emitted an invalid protocol message');
      return;
    }
    if (typeof message.method === 'string') {
      if (message.id !== undefined) {
        if (options.onRequest) {
          if ((typeof message.id !== 'string' && typeof message.id !== 'number') || serverRequests.has(message.id)) {
            disconnect(process, 'Codex emitted an invalid or duplicate server request');
            return;
          }
          serverRequests.add(message.id);
          try { options.onRequest({ id: message.id, method: message.method, params: message.params ?? {} }); }
          catch { disconnect(process, 'The workbench could not handle a Codex server request'); }
          return;
        }
        let response: Record<string, unknown>;
        switch (message.method) {
          case 'item/commandExecution/requestApproval':
          case 'item/fileChange/requestApproval': response = { result: { decision: 'decline' } }; break;
          case 'mcpServer/elicitation/request': response = { result: { action: 'cancel', content: null, _meta: null } }; break;
          case 'item/permissions/requestApproval': response = { result: { permissions: {}, scope: 'turn' } }; break;
          case 'applyPatchApproval':
          case 'execCommandApproval': response = { result: { decision: { denied: { rejection: 'Approval is not supported by this workbench' } } } }; break;
          default: response = { error: { code: -32601, message: 'This workbench does not handle this server request' } };
        }
        process.stdin.write(JSON.stringify({ id: message.id, ...response }) + '\n');
      }
      if (message.method === 'serverRequest/resolved') serverRequests.delete(message.params?.requestId);
      options.onEvent({ method: message.method, params: message.params ?? {} });
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(Object.assign(new Error(message.error.message ?? 'Codex rejected the request'), { code: message.error.code, data: message.error.data }));
    else if ('result' in message) request.resolve(message.result);
    else request.reject(dispatchError('Codex response had neither a result nor an error', 'unknown'));
  }

  return {
    async connect() {
      if (ready) return;
      if (connecting) return connecting;
      connecting = (async () => {
        const env = runtimeEnvironment(options.cwd, options.home);
        const executable = executablePath(options.executable, options.cwd, env);
        info = { executable, version: null, initialize: null };
        const version = executableVersion(executable ?? options.executable, options.cwd, env);
        const process = spawn(executable ?? options.executable, ['app-server', '--listen', 'stdio://', '-c', 'cli_auth_credentials_store="file"'], { cwd: options.cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        child = process;
        owned = process;
        processClosed = new Promise(resolve => process.once('close', () => { if (owned === process) owned = null; resolve(); }));
        process.stderr.resume();
        process.stdin.on('error', () => disconnect(process, 'Codex input stream failed; outstanding outcomes are unknown'));
        process.on('error', error => disconnect(process, `Codex could not start: ${error.message}`));
        process.on('exit', (code, signal) => {
          // Descendants can inherit stdio; release our pipes only after the direct child exits.
          process.stdin.destroy(); process.stdout.destroy(); process.stderr.destroy();
          disconnect(process, `Codex disconnected (${signal ?? code ?? 'unknown'})`);
        });
        createInterface({ input: process.stdout }).on('line', line => receive(process, line));
        await new Promise<void>((resolve, reject) => {
          process.once('spawn', resolve);
          process.once('error', error => reject(dispatchError(`Codex could not start: ${error.message}`, 'not-sent')));
        });
        const initialized = await request('initialize', { clientInfo: { name: 'mixcat', title: 'Mixcat', version: '0.1.0' }, capabilities: { experimentalApi: true, requestAttestation: false } });
        const actualVersion = await version;
        if (child !== process) throw dispatchError('Codex disconnected during initialization', 'unknown');
        info = { executable, version: actualVersion, initialize: initialized && typeof initialized === 'object' && !Array.isArray(initialized) ? structuredClone(initialized) : null };
        process.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
        ready = true;
      })();
      try { await connecting; }
      catch (error) { if (child) disconnect(child, 'Codex initialization failed'); throw error; }
      finally { connecting = null; }
    },
    rpc(method, params) {
      if (!ready) return Promise.reject(dispatchError('Codex is not connected', 'not-sent'));
      return request(method, params);
    },
    respond(id, result) {
      const process = child;
      if (!process || !process.stdin.writable || !serverRequests.has(id)) throw new Error('This Codex server request is no longer pending');
      if (result === undefined) throw new Error('A Codex server response must contain a result');
      const encoded = JSON.stringify({ id, result }) + '\n';
      serverRequests.delete(id);
      process.stdin.write(encoded, error => {
        if (error) disconnect(process, 'Codex input stream failed; outstanding outcomes are unknown');
      });
    },
    reject(id, error) {
      const process = child;
      if (!process || !process.stdin.writable || !serverRequests.has(id)) throw new Error('This Codex server request is no longer pending');
      const encoded = JSON.stringify({ id, error }) + '\n';
      serverRequests.delete(id);
      process.stdin.write(encoded, failure => { if (failure) disconnect(process, 'Codex input stream failed; outstanding outcomes are unknown'); });
    },
    info() { return structuredClone(info); },
    async close() {
      const process = owned;
      child = null;
      ready = false;
      drain('Codex was closed; outstanding outcomes are unknown');
      if (!process) return;
      process.stdin.end();
      if (process.exitCode === null && process.signalCode === null) process.kill();
      const timer = setTimeout(() => { if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL'); }, 1000);
      try { await processClosed; }
      finally { clearTimeout(timer); }
    },
  };
}
