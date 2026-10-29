import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { closeSync, createReadStream, createWriteStream, existsSync, fsyncSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { Readable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureProjectDirectory, insideProject, projectDirectory } from './paths.js';

export interface RuntimeArtifact { url: string; sha256: string; }
export interface RuntimeManifest {
  id: string;
  python: RuntimeArtifact & { version: string };
  backend: { repository: string; tag: string; version: string; commit: string };
  frontendVersion: string;
  lockSha256: string;
  packages: (RuntimeArtifact & { name: string; version: string; filename: string })[];
}
export interface PreparedRuntime { root: string; directory: string; python: string; backend: string; data: string; version: string; manifest: RuntimeManifest; }
export interface PreparationIO {
  download(url: string, destination: string): Promise<void>;
  install(prepared: PreparedRuntime, downloads: string): Promise<void>;
}
const hash = (body: string) => createHash('sha256').update(body).digest('hex');
const preparations = new Map<string, { hash: string; promise: Promise<PreparedRuntime> }>();
function requirementsLock(manifest: RuntimeManifest) { return manifest.packages.map(pkg => `${pkg.name}==${pkg.version} --hash=sha256:${pkg.sha256}`).join('\n') + '\n'; }
function checkDataTree(root: string, directory: string) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = insideProject(root, join(directory, entry.name));
    if (entry.isDirectory()) checkDataTree(root, path);
  }
}

function validateManifest(manifest: RuntimeManifest) {
  if (!/^[a-z0-9][a-z0-9.-]{0,100}$/.test(manifest.id)) throw new Error('Comfy 运行版本格式不正确。');
  if (!/^\d+\.\d+\.\d+$/.test(manifest.python.version) || !/^\d+\.\d+\.\d+$/.test(manifest.frontendVersion)
    || !/^[a-f0-9]{40}$/.test(manifest.backend.commit)) throw new Error('Comfy 版本清单格式不正确。');
  const repository = new URL(manifest.backend.repository);
  if (repository.protocol !== 'https:' || repository.username || repository.password) throw new Error('Comfy 上游仓库格式不正确。');
  for (const artifact of [manifest.python, ...manifest.packages]) {
    const url = new URL(artifact.url);
    if (url.protocol !== 'https:' || url.username || url.password || !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error('Comfy 下载校验清单格式不正确。');
  }
  for (const pkg of manifest.packages) {
    if (!/^[a-zA-Z0-9_.+-]+\.whl$/.test(pkg.filename) || !/^[a-zA-Z0-9_.-]+$/.test(pkg.name) || !/^[a-zA-Z0-9_.+!-]+$/.test(pkg.version)) throw new Error('Comfy 依赖锁格式不正确。');
  }
  if (hash(requirementsLock(manifest)) !== manifest.lockSha256) throw new Error('Comfy 依赖锁 SHA-256 校验失败。');
}
export function runtimeEnvironment(root: string): NodeJS.ProcessEnv {
  const directory = (...parts: string[]) => projectDirectory(root, '.mixcat', 'comfy', ...parts);
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'OS', 'SystemDrive', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'GIT_SSL_CAINFO', 'GIT_SSL_CAPATH', 'NODE_EXTRA_CA_CERTS', 'NODE_USE_SYSTEM_CA', 'NODE_USE_ENV_PROXY']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.NO_PROXY = env.no_proxy = [...new Set([env.NO_PROXY, env.no_proxy, '127.0.0.1', 'localhost', '::1'].filter(Boolean))].join(',');
  return { ...env, PYTHONHOME: '', PYTHONPATH: '', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1',
    HOME: directory('home'), USERPROFILE: directory('home'), APPDATA: directory('home', 'AppData', 'Roaming'), LOCALAPPDATA: directory('home', 'AppData', 'Local'),
    TEMP: directory('tmp'), TMP: directory('tmp'), TMPDIR: directory('tmp'), PIP_CACHE_DIR: directory('cache', 'pip'),
    PIP_CONFIG_FILE: 'NUL', PIP_DISABLE_PIP_VERSION_CHECK: '1', HF_HOME: directory('cache', 'huggingface'),
    TORCH_HOME: directory('cache', 'torch'), XDG_CACHE_HOME: directory('cache'), XDG_CONFIG_HOME: directory('home', 'config'), XDG_DATA_HOME: directory('home', 'data'), UV_CACHE_DIR: directory('cache', 'uv'),
    MPLCONFIGDIR: directory('cache', 'matplotlib'), NUMBA_CACHE_DIR: directory('cache', 'numba'), TORCHINDUCTOR_CACHE_DIR: directory('cache', 'inductor'), TRITON_CACHE_DIR: directory('cache', 'triton') };
}
function runRuntimeCommand(executable: string, args: string[], root: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = runtimeEnvironment(root);
    const log = createWriteStream(insideProject(root, join(projectDirectory(root, '.mixcat', 'comfy', 'logs'), 'prepare.log')), { flags: 'a' });
    let logError: Error | undefined;
    log.on('error', error => { logError = error; });
    const child = spawn(executable, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', chunk => { output = (output + chunk.toString()).slice(-1_000_000); });
    child.stderr.on('data', () => {});
    child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
    child.once('error', error => { log.end(); reject(error); });
    child.once('close', code => {
      log.end();
      void finished(log).then(() => code === 0 ? resolve(output) : reject(new Error(`Comfy 准备命令失败 (${code})；详见项目内 prepare.log。`)), error => reject(logError ?? error));
    });
  });
}
const defaultIO: PreparationIO = {
  async download(url, destination) {
    const response = await fetch(url, { signal: AbortSignal.timeout(600_000) });
    if (!response.ok || !response.body) throw new Error(`Comfy 下载失败 (${response.status})。`);
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(destination, { flags: 'wx' }));
  },
  install: installRuntime
};
export async function installRuntime(prepared: PreparedRuntime, downloads: string, runCommand = runRuntimeCommand): Promise<void> {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('当前 Comfy 运行组合仅支持 Windows x64。');
  const runtime = projectDirectory(prepared.root, '.mixcat', 'comfy', 'runtime', prepared.version, 'interpreter');
  // CPython documents extracting its official offline runtime ZIP without system registration.
  await runCommand('tar.exe', ['-xf', join(downloads, 'python.zip'), '-C', runtime], prepared.root);
  await runCommand(join(runtime, 'python.exe'), ['-m', 'venv', join(prepared.directory, 'venv')], prepared.root);
  let reusable = false;
  if (existsSync(insideProject(prepared.root, join(prepared.backend, '.git')))) {
    try {
      await runCommand('git', ['-C', prepared.backend, 'cat-file', '-e', `${prepared.manifest.backend.commit}^{commit}`], prepared.root);
      await runCommand('git', ['-C', prepared.backend, 'fsck', '--connectivity-only', '--no-reflogs', '--no-dangling', prepared.manifest.backend.commit], prepared.root);
      await runCommand('git', ['-C', prepared.backend, 'checkout', '--detach', prepared.manifest.backend.commit], prepared.root);
      reusable = true;
    } catch { /* An interrupted clone may have .git without the commit/tree needed by checkout. */ }
  }
  if (!reusable) {
    const source = process.env.MIXCAT_COMFY_BACKEND_SOURCE;
    if (source) insideProject(prepared.root, source);
    if (existsSync(insideProject(prepared.root, join(prepared.directory, 'ready.json')))) throw new Error('不能重建已发布的 Comfy 运行版本。');
    if (readdirSync(insideProject(prepared.root, prepared.backend)).length) {
      renameSync(insideProject(prepared.root, prepared.backend), insideProject(prepared.root, join(prepared.directory, `backend-incomplete-${randomUUID()}`)));
      projectDirectory(prepared.root, '.mixcat', 'comfy', 'runtime', prepared.version, 'backend');
    }
    await runCommand('git', ['clone', '--no-hardlinks', '--no-checkout', source ?? prepared.manifest.backend.repository, prepared.backend], prepared.root);
    await runCommand('git', ['-C', prepared.backend, 'checkout', '--detach', prepared.manifest.backend.commit], prepared.root);
  }
  await runCommand('git', ['-C', prepared.backend, 'remote', 'set-url', 'origin', prepared.manifest.backend.repository], prepared.root);
  if ((await runCommand('git', ['-C', prepared.backend, 'rev-parse', 'HEAD'], prepared.root)).trim() !== prepared.manifest.backend.commit
    || (await runCommand('git', ['-C', prepared.backend, 'status', '--porcelain'], prepared.root)).trim()
    || existsSync(insideProject(prepared.root, join(prepared.backend, '.git', 'objects', 'info', 'alternates')))) throw new Error('Comfy 上游检出版本或工作区校验失败。');
  const lock = insideProject(prepared.root, join(prepared.directory, 'requirements.lock'));
  writeFileSync(lock, requirementsLock(prepared.manifest));
  await runCommand(prepared.python, ['-m', 'pip', 'install', '--no-index', '--only-binary=:all:', '--require-hashes', '--find-links', downloads, '-r', lock], prepared.root);
  await runCommand(prepared.python, ['-m', 'pip', 'check'], prepared.root);
  const verify = `import importlib.metadata as m,json,platform,struct,sys,sysconfig,torch\nassert platform.python_version()==${JSON.stringify(prepared.manifest.python.version)}\nassert struct.calcsize('P')==8 and torch.version.cuda is None and not sysconfig.get_config_var('Py_GIL_DISABLED')\nassert m.version('comfyui-frontend-package')==${JSON.stringify(prepared.manifest.frontendVersion)}\nfor name,version in json.loads(sys.argv[1]).items():\n assert m.version(name)==version,(name,m.version(name))\n`;
  await runCommand(prepared.python, ['-c', verify, JSON.stringify(Object.fromEntries(prepared.manifest.packages.map(pkg => [pkg.name, pkg.version])))], prepared.root);
}
async function fileHash(path: string) {
  const checksum = createHash('sha256');
  for await (const chunk of createReadStream(path)) checksum.update(chunk);
  return checksum.digest('hex');
}
export async function prepareRuntime(root: string, manifest: RuntimeManifest, io: PreparationIO = defaultIO): Promise<PreparedRuntime> {
  root = ensureProjectDirectory(root); validateManifest(manifest);
  const directory = projectDirectory(root, '.mixcat', 'comfy', 'runtime', manifest.id), manifestHash = hash(JSON.stringify(manifest));
  const active = preparations.get(directory);
  if (active) { if (active.hash !== manifestHash) throw new Error('Comfy 运行版本清单冲突。'); return active.promise; }
  const promise = prepare(); preparations.set(directory, { hash: manifestHash, promise });
  try { return await promise; } finally { preparations.delete(directory); }
  async function prepare(): Promise<PreparedRuntime> {
    const prepared: PreparedRuntime = { root, directory, python: insideProject(root, join(projectDirectory(root, '.mixcat', 'comfy', 'runtime', manifest.id, 'venv', 'Scripts'), 'python.exe')),
      backend: projectDirectory(root, '.mixcat', 'comfy', 'runtime', manifest.id, 'backend'), data: projectDirectory(root, '.mixcat', 'comfy', 'data'), version: manifest.id, manifest };
    const ready = insideProject(root, join(directory, 'ready.json'));
    const verifyFiles = () => {
      if (![prepared.python, join(prepared.backend, 'main.py'), join(prepared.backend, 'LICENSE')].every(path => existsSync(insideProject(root, path)))) throw new Error('Comfy 运行文件损坏。');
    };
    const readReady = () => {
      if (!existsSync(ready)) return false;
      if (JSON.parse(readFileSync(ready, 'utf8')).manifestHash !== manifestHash) throw new Error('Comfy 已准备版本清单冲突。');
      verifyFiles();
      return true;
    };
    if (readReady()) return prepared;
    // SQLite releases this cross-process lease even if the installer's owner crashes.
    const lease = new DatabaseSync(insideProject(root, join(directory, 'prepare.sqlite')));
    try {
      for (let attempt = 0;; attempt++) {
        try { lease.exec('BEGIN IMMEDIATE'); break; } catch (error) {
          if (![5, 6].includes((error as { errcode: number }).errcode)) throw error;
          if (readReady()) return prepared;
          if (attempt >= 120) throw new Error('Comfy 环境正在由另一个进程准备；请稍后重试。');
          await delay(500);
        }
      }
      if (readReady()) return prepared;
      const downloads = projectDirectory(root, '.mixcat', 'comfy', 'downloads', manifest.id);
      const artifacts = [{ ...manifest.python, filename: 'python.zip' }, ...manifest.packages];
      for (const artifact of artifacts) {
        const destination = insideProject(root, join(downloads, artifact.filename));
        if (existsSync(destination) && await fileHash(destination) === artifact.sha256) continue;
        rmSync(destination, { force: true });
        const partial = insideProject(root, join(downloads, `${artifact.filename}.${randomUUID()}.partial`));
        try {
          await io.download(artifact.url, partial);
          if (await fileHash(partial) !== artifact.sha256) throw new Error('Comfy 下载文件 SHA-256 校验失败。');
          renameSync(partial, destination);
        } finally { rmSync(partial, { force: true }); }
      }
      await io.install(prepared, downloads);
      verifyFiles();
      const temporary = insideProject(root, join(directory, `ready-${randomUUID()}.json`));
      try {
        const file = openSync(temporary, 'wx');
        try { writeFileSync(file, JSON.stringify({ manifestHash, manifest, preparedAt: new Date().toISOString() })); fsyncSync(file); } finally { closeSync(file); }
        renameSync(temporary, ready);
      } finally { rmSync(temporary, { force: true }); }
      readReady();
      return prepared;
    } finally { lease.close(); }
  }
}

export interface RuntimeInstance { instanceId: string; origin: string; pid: number; }
export interface RuntimeHealth { healthy: boolean; instanceId?: string; origin?: string; backendVersion?: string; frontendVersion?: string; pythonVersion?: string; }
interface RuntimeOptions {
  preparationIO?: PreparationIO;
  spawn?: (executable: string, args: string[], options: SpawnOptions) => ChildProcess;
  stopProcessTree?: (pid: number, root: string) => Promise<void>;
  port?: number;
  startupTimeoutMs?: number;
}
export class ComfyRuntime {
  private current?: { instance: RuntimeInstance; prepared: PreparedRuntime; child: ChildProcess; listening: boolean; lock: string; stopping: boolean; terminationFailed?: Error };
  private starting?: { root: string; manifestHash: string; promise: Promise<RuntimeInstance> };
  constructor(private options: RuntimeOptions = {}) {}
  async start(root: string, manifest: RuntimeManifest): Promise<RuntimeInstance> {
    root = ensureProjectDirectory(root); validateManifest(manifest);
    if (this.starting) {
      if (this.starting.root !== root || this.starting.manifestHash !== hash(JSON.stringify(manifest))) throw new Error('Comfy 实例属于另一个项目或版本。');
      return this.starting.promise;
    }
    if (this.current) {
      if (this.current.stopping) throw new Error('Comfy 实例正在停止或等待停止核实。');
      if (this.current.prepared.root !== root || JSON.stringify(this.current.prepared.manifest) !== JSON.stringify(manifest)) throw new Error('Comfy 实例属于另一个项目或版本。');
      return { ...this.current.instance };
    }
    this.starting = { root, manifestHash: hash(JSON.stringify(manifest)), promise: this.launch(root, manifest) };
    try { return await this.starting.promise; } finally { this.starting = undefined; }
  }
  private async launch(root: string, manifest: RuntimeManifest): Promise<RuntimeInstance> {
    const prepared = await prepareRuntime(root, manifest, this.options.preparationIO);
    const lock = insideProject(root, join(projectDirectory(root, '.mixcat', 'comfy'), 'instance.lock'));
    let fd: number;
    try { fd = openSync(lock, 'wx'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('此项目已有 Comfy 实例；拒绝接管或停止陌生进程。');
      throw error;
    }
    closeSync(fd);
    try {
      const port = await new Promise<number>((resolve, reject) => {
        const probe = createServer(); probe.once('error', reject);
        probe.listen({ host: '127.0.0.1', port: this.options.port ?? 0, exclusive: true }, () => {
          const port = (probe.address() as { port: number }).port; probe.close(error => error ? reject(error) : resolve(port));
        });
      });
      for (const name of ['input', 'output', 'temp', 'user', 'models', 'custom_nodes']) projectDirectory(root, '.mixcat', 'comfy', 'data', name);
      checkDataTree(root, prepared.data);
      const instanceId = randomUUID();
      const logPath = insideProject(root, join(projectDirectory(root, '.mixcat', 'comfy', 'logs'), `${instanceId}.log`));
      const child = (this.options.spawn ?? spawn)(prepared.python, [join(prepared.backend, 'main.py'), '--cpu', '--disable-auto-launch', '--listen', '127.0.0.1', '--port', String(port), '--base-directory', prepared.data],
        { cwd: prepared.backend, env: { ...runtimeEnvironment(root), MIXCAT_COMFY_INSTANCE_ID: instanceId }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const instance = { instanceId, origin: `http://127.0.0.1:${port}`, pid: child.pid ?? 0 };
      const state = { instance, prepared, child, listening: false, lock, stopping: false, terminationFailed: undefined as Error | undefined }; this.current = state;
      writeFileSync(lock, JSON.stringify({ ...instance, ownerPid: process.pid, version: manifest.id }));
      const log = createWriteStream(logPath, { flags: 'a' });
      let startupError: Error | undefined, tail = '';
      log.on('error', error => { startupError = error; });
      child.once('error', error => { startupError = error; });
      const output = (chunk: Buffer) => {
        log.write(chunk); tail = (tail + chunk.toString()).slice(-4096);
        if (tail.includes(`To see the GUI go to: ${instance.origin}`)) state.listening = true;
      };
      child.stdout?.on('data', output); child.stderr?.on('data', output);
      child.once('close', () => { log.end(); if (this.current === state && !state.stopping) { this.current = undefined; rmSync(lock, { force: true }); } });
      const deadline = Date.now() + (this.options.startupTimeoutMs ?? 120_000);
      while (Date.now() < deadline) {
        if (startupError) throw startupError;
        if (child.exitCode !== null || child.signalCode !== null) throw new Error('Comfy 进程在启动期间退出；详见项目日志。');
        if (state.listening && (await this.health()).healthy) return { ...instance };
        await delay(200);
      }
      throw new Error('Comfy 原生前端或核心健康检查超时；详见项目日志。');
    } catch (error) {
      await this.terminate(); rmSync(lock, { force: true }); throw error;
    }
  }
  async health(): Promise<RuntimeHealth> {
    const state = this.current;
    if (!state || state.stopping || !state.listening || state.child.exitCode !== null || state.child.signalCode !== null) return { healthy: false };
    try {
      const get = async (path: string) => {
        const response = await fetch(state.instance.origin + path, { signal: AbortSignal.timeout(3000), redirect: 'error' });
        if (!response.ok) throw new Error('Comfy 健康检查失败。'); return response;
      };
      const stats = await (await get('/system_stats')).json() as { system?: { comfyui_version?: string; required_frontend_version?: string; python_version?: string } };
      const info = await (await get('/object_info')).json() as Record<string, unknown>;
      const extensions = await (await get('/extensions')).json();
      const html = await (await get('/')).text();
      const script = /<script\b[^>]*\bsrc=["']([^"']+)["']/i.exec(html)?.[1];
      if (!script || !Array.isArray(extensions) || !['KSampler', 'SaveImage', 'EmptyLatentImage', 'CheckpointLoaderSimple'].every(name => info[name])) return { healthy: false };
      const asset = new URL(script, state.instance.origin);
      if (asset.origin !== state.instance.origin) return { healthy: false };
      const resource = await get(asset.pathname + asset.search), code = await resource.text();
      if (!/(?:java|ecma)script/i.test(resource.headers.get('content-type') ?? '') || !code.trim()) return { healthy: false };
      const system = stats.system, manifest = state.prepared.manifest;
      return { healthy: this.current === state && !state.stopping && system?.comfyui_version === manifest.backend.version && system?.required_frontend_version === manifest.frontendVersion && !!system?.python_version?.startsWith(manifest.python.version),
        instanceId: state.instance.instanceId, origin: state.instance.origin, backendVersion: system?.comfyui_version, frontendVersion: system?.required_frontend_version, pythonVersion: system?.python_version };
    } catch { return { healthy: false }; }
  }
  async stop(): Promise<void> {
    if (this.starting) { try { await this.starting.promise; } catch (error) { if (this.current) throw error; return; } }
    if (!this.current) return;
    const state = this.current;
    if (state.stopping) throw state.terminationFailed ?? new Error('Comfy 实例正在停止。');
    state.stopping = true;
    try {
      const response = await fetch(`${state.instance.origin}/queue`, { signal: AbortSignal.timeout(3000), redirect: 'error' });
      if (!response.ok) throw new Error('无法确认 Comfy 队列空闲，拒绝停止。');
      const queue = await response.json() as { queue_running?: unknown[]; queue_pending?: unknown[] };
      if (!Array.isArray(queue.queue_running) || !Array.isArray(queue.queue_pending) || queue.queue_running.length || queue.queue_pending.length) throw new Error('Comfy 有未完成任务，拒绝停止运行环境。');
      await this.terminate();
    } catch (error) { if (!state.terminationFailed) state.stopping = false; throw error; }
  }
  private async terminate() {
    const state = this.current; if (!state) return;
    if (state.terminationFailed) throw state.terminationFailed;
    state.stopping = true;
    const closed = new Promise<void>(resolve => state.child.once('close', () => resolve()));
    if (state.child.exitCode === null && state.child.signalCode === null) {
      // Windows venv python.exe redirects to a descendant; stopping only the launcher orphans the server.
      try {
        if (this.options.stopProcessTree) await this.options.stopProcessTree(state.instance.pid, state.prepared.root);
        else if (process.platform === 'win32') await runRuntimeCommand('taskkill.exe', ['/PID', String(state.instance.pid), '/T', '/F'], state.prepared.root);
        else state.child.kill();
      } catch (error) { state.terminationFailed = error instanceof Error ? error : new Error('Comfy 进程树停止失败，需核实。'); throw error; }
      await closed;
    }
    if (this.current === state) { this.current = undefined; rmSync(state.lock, { force: true }); }
  }
}
