import { dialog, ipcMain, session, WebContentsView, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { copyFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createHmac, randomBytes } from 'node:crypto';
import { ComfyRuntime, type RuntimeManifest } from '../core/comfy-runtime.js';
import { ComfyStore } from '../core/comfy-store.js';
import { ComfyService } from '../core/comfy-service.js';
import { ComfyRpc } from '../core/comfy-rpc.js';
import { insideProject, projectDirectory } from '../core/paths.js';
import { boundedComfy, validateGraph, validateComfyRequest, validateNativeQueue, validateObservation, validatePrompt, comfyText, comfyObject, COMFY_GRAPH_MAX_BYTES, type ComfyPromptPayload } from '../shared/comfy-bridge.js';
import type { AppSnapshot } from '../shared/types.js';
import type { ComfyActor, ComfyReply, ComfyRequest, RunStatus, RunView, NodeCatalog } from '../shared/comfy.js';
import type { PanelBounds } from '../shared/panels.js';
import { panelBounds, panelGeneration } from './policy.js';
import { authorizeComfyGuest, authorizeComfyHandshake } from './comfy-policy.js';
import { safeDownloadName } from './panel-files.js';
import { ComfyRuns } from '../core/comfy-runs.js';
import { ComfyBroker } from './comfy-broker.js';
import type { ProviderSettingsService } from './provider-settings.js';
import { verifiedArtifactPath } from '../core/comfy-artifacts.js';
import type { ComfyFeedback } from '../shared/comfy-workspace.js';

interface Entry {
  root: string; runtime: ComfyRuntime; view?: WebContentsView; rpc?: ComfyRpc; service: ComfyService; origin?: string; instanceId?: string;
  handshaken: boolean; ready: Promise<void>; resolveReady: () => void; rejectReady: (error: Error) => void; start?: Promise<void>; closed: boolean; busy: boolean;
  cleanupSession?: () => void;
  closing?: Promise<void>; serviceClosed?: boolean;
  flushing?: Promise<void>;
  admissionSecret: string;
  runs: ComfyRuns; broker?: ComfyBroker;
}
export class ComfyHost {
  private projects = new Map<string, string>();
  private entries = new Map<string, Entry>();
  private selected: string | null = null;
  private generation = 0;
  private layoutRevision = 0;
  private quiescing = false;
  constructor(private window: BrowserWindow, private assets: string, private preload: string, private providers?: ProviderSettingsService) {
    ipcMain.handle('mixcat:comfy-connect', this.connect);
    ipcMain.handle('mixcat:comfy-queue', this.queue); ipcMain.handle('mixcat:comfy-admit', this.admit);
    ipcMain.on('mixcat:comfy-reply', this.reply); ipcMain.on('mixcat:comfy-ready', this.ready);
    window.on('resize', () => this.hide()); window.webContents.on('did-start-loading', () => { this.generation++; this.hide(); });
  }
  observe(snapshot: AppSnapshot) {
    if (this.selected !== (snapshot.selected?.project.id ?? null)) this.hide();
    this.selected = snapshot.selected?.project.id ?? null;
    this.projects = new Map(snapshot.projects.filter(project => project.template === 'comfyui' && !project.unavailable).map(project => [project.id, project.root]));
    for (const [id, entry] of this.entries) if (!entry.closed && this.projects.get(id) !== entry.root) void this.closeEntry(id, entry).catch(console.error);
    for (const [id, entry] of this.entries) if (id !== this.selected) entry.view?.setVisible(false);
  }
  private trusted(event: IpcMainEvent | IpcMainInvokeEvent): Entry {
    const entry = [...this.entries.values()].find(entry => entry.view?.webContents === event.sender && !entry.closed);
    if (!entry || !entry.origin || !event.senderFrame) throw new Error('Comfy 请求来源不受信任。');
    authorizeComfyGuest(event.sender, event.senderFrame, entry.view!.webContents, entry.view!.webContents.mainFrame, event.senderFrame.url, entry.origin);
    return entry;
  }
  private connect = (event: IpcMainInvokeEvent, instanceId: unknown) => {
    const entry = this.trusted(event);
    authorizeComfyHandshake(instanceId, entry.instanceId, entry.handshaken);
    entry.handshaken = true;
    return { projectId: entry.service.store.projectId, instanceId: entry.instanceId, initializeGraph: !entry.service.store.graphInitialized() };
  };
  private reply = (event: IpcMainEvent, value: unknown) => { try { const entry = this.trusted(event); if (entry.handshaken) entry.rpc?.receive(value); } catch {} };
  private queue = (event: IpcMainInvokeEvent, request: unknown, queue: unknown) => {
    const entry = this.trusted(event); if (!entry.handshaken) throw new Error('Comfy 尚未握手。');
    if (this.quiescing || entry.flushing) throw Error('Comfy 正在安全关闭。');
    validateComfyRequest(request); validateNativeQueue(queue);
    if (request.type !== 'queue_graph' || request.expected.instanceId !== entry.instanceId) throw new Error('Comfy 队列身份冲突。');
    return entry.service.nativeQueue(entry.service.store.projectId, request, queue);
  };
  private admit = (event: IpcMainInvokeEvent, sessionId: unknown, source: unknown, payload: unknown) => {
    const entry = this.trusted(event); if (!entry.handshaken) throw new Error('Comfy 尚未握手。');
    comfyText(sessionId); validateObservation(source); validatePrompt(payload);
    if (!entry.busy || source.instanceId !== entry.instanceId) throw new Error('Comfy 提交身份冲突。');
    return entry.service.admit(sessionId, source, payload);
  };
  private ready = (event: IpcMainEvent) => {
    try {
      const entry = this.trusted(event); if (!entry.handshaken) return;
      entry.service.store.markGraphInitialized(); entry.resolveReady();
    } catch (error) { try { this.trusted(event).rejectReady(error as Error); } catch {} }
  };
  private entry(projectId: string): Entry {
    if (this.quiescing) throw Error('Comfy 正在安全关闭。');
    const root = this.projects.get(projectId); if (!root) throw new Error('Comfy 项目未打开。');
    const existing = this.entries.get(projectId);
    if (existing?.closed || existing?.flushing) throw new Error('Comfy 项目关闭尚未完成；请重试关闭后再打开。');
    if (existing) return existing;
    let resolveReady!: () => void, rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; }); ready.catch(() => {});
    const store = new ComfyStore(root, projectId);
    const runs = new ComfyRuns(store, {
      list: () => this.providers?.listForProject(projectId) ?? [],
      withCredential: (id, revision, action) => { if (!this.providers) throw Error('Provider settings unavailable.'); return this.providers.withCredential(projectId, id, revision, action); }
    });
    const entry: Entry = { root, runtime: new ComfyRuntime(), service: new ComfyService(store, async request => {
      await this.start(projectId, entry);
      if (entry.closed) throw new Error('Comfy 项目已关闭。');
      entry.busy = request.type === 'apply_graph';
      try { const result = await entry.rpc!.request(projectId, request); validateGraph(result, projectId, entry.instanceId); return result; }
      catch (error) { if (!entry.closed && /超时/.test(String(error))) void this.closeEntry(projectId, entry).catch(console.error); throw error; }
      finally { entry.busy = false; }
    }, {
      prepare: async request => {
        await this.start(projectId, entry); if (entry.closed) throw new Error('Comfy 项目已关闭。');
        entry.busy = true;
        try { return await entry.rpc!.prepareQueue(projectId, request); }
        catch (error) { if (!entry.closed && /超时/.test(String(error))) void this.closeEntry(projectId, entry).catch(console.error); throw error; }
        finally { entry.busy = false; }
      },
      submit: payload => this.submit(entry, payload),
      validate: payload => runs.validatePrompt(payload),
      reconcile: async promptId => (await this.inspectNative(entry, promptId)).status
    }, runs), runs, handshaken: false, ready, resolveReady, rejectReady, closed: false, busy: false, admissionSecret: randomBytes(32).toString('hex') };
    runs.attachNative({
      queue: (expected, requestId, actor) => entry.service.handle(projectId, { type: 'queue_graph', expected, requestId }, actor) as Promise<RunView>,
      inspect: promptId => this.inspectNative(entry, promptId),
      stop: async promptId => { if (entry.origin && !entry.closed && store.runForPrompt(promptId)?.observation.instanceId === entry.instanceId) await this.control(entry, '/mixcat/stop', { prompt_id: promptId }); }
    });
    this.entries.set(projectId, entry); runs.recover(); return entry;
  }
  private async inspectNative(entry: Entry, promptId: string): Promise<{ status?: RunStatus; outputs?: Record<string, unknown> }> {
    if (!entry.origin || entry.closed) return {};
    const get = async (path: string) => { const response = await fetch(entry.origin + path, { signal: AbortSignal.timeout(5000), redirect: 'error' }); if (!response.ok) throw Error('Native run inspection failed.'); return response.json() as Promise<any>; };
    const history = (await get('/history/' + encodeURIComponent(promptId)))[promptId];
    if (history) {
      if (history.prompt?.[1] !== promptId) throw Error('Native history identity conflict.');
      return { status: history.status?.status_str === 'error' ? 'failed' : history.status?.completed ? 'succeeded' : undefined, outputs: history.outputs };
    }
    const queue = await get('/queue');
    return { status: queue.queue_running?.some((item: unknown[]) => item[1] === promptId) ? 'running' : queue.queue_pending?.some((item: unknown[]) => item[1] === promptId) ? 'queued' : undefined };
  }
  private start(projectId: string, entry: Entry): Promise<void> {
    return entry.start ??= (async () => {
      const custom = projectDirectory(entry.root, '.mixcat', 'comfy', 'data', 'custom_nodes', 'mixcat');
      const web = projectDirectory(entry.root, '.mixcat', 'comfy', 'data', 'custom_nodes', 'mixcat', 'web');
      copyFileSync(join(this.assets, 'mixcat', '__init__.py'), insideProject(entry.root, join(custom, '__init__.py')));
      copyFileSync(join(this.assets, 'mixcat', 'nodes.py'), insideProject(entry.root, join(custom, 'nodes.py')));
      copyFileSync(join(this.assets, 'mixcat', 'web', 'bridge.js'), insideProject(entry.root, join(web, 'bridge.js')));
      copyFileSync(join(this.assets, 'mixcat', 'web', 'queue-projection.js'), insideProject(entry.root, join(web, 'queue-projection.js')));
      const manifest = JSON.parse(readFileSync(join(this.assets, 'runtime-manifest.json'), 'utf8')) as RuntimeManifest;
      let port = entry.service.store.getRuntimePort();
      if (port === undefined) {
        const candidate = await new Promise<number>((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); const selected = typeof address === 'object' && address ? address.port : 0; server.close(error => error ? reject(error) : resolve(selected)); }); });
        if (entry.closed) throw new Error('Comfy 项目已关闭。');
        port = entry.service.store.setRuntimePort(candidate);
      }
      entry.runtime = new ComfyRuntime({ port, admissionSecret: entry.admissionSecret, onExit: instanceId => {
        if (this.entries.get(projectId) !== entry || entry.closed || entry.instanceId !== instanceId) return;
        void this.closeEntry(projectId, entry).catch(console.error);
      }, beforeSpawn: async instanceId => {
        if (entry.closed) throw Error('Comfy 项目已关闭。');
        entry.instanceId = instanceId;
        entry.broker = new ComfyBroker(entry.runs, instanceId);
        return entry.broker.start();
      } });
      const instance = await entry.runtime.start(entry.root, manifest);
      if (entry.closed || this.projects.get(projectId) !== entry.root) throw new Error('Comfy 项目已关闭。');
      entry.origin = instance.origin; entry.instanceId = instance.instanceId;
      const path = projectDirectory(entry.root, '.mixcat', 'comfy', 'browser'), directories = [path];
      while (directories.length) for (const child of readdirSync(directories.pop()!, { withFileTypes: true })) { if (child.isSymbolicLink()) throw new Error('Comfy 浏览器目录包含目录链接。'); if (child.isDirectory()) directories.push(join(child.parentPath, child.name)); }
      const browser = session.fromPath(path, { cache: false });
      browser.setPermissionCheckHandler(() => false);
      browser.setPermissionRequestHandler((_contents, permission, callback) => { void dialog.showMessageBox(this.window, { type: 'question', message: `ComfyUI 请求 ${permission} 权限`, buttons: ['拒绝', '允许'], defaultId: 0, cancelId: 0 }).then(result => callback(result.response === 1)).catch(() => callback(false)); });
      const download = (_event: Electron.Event, item: Electron.DownloadItem) => { try { item.setSavePath(insideProject(entry.root, join(projectDirectory(entry.root, '.mixcat', 'downloads'), safeDownloadName(item.getFilename())))); } catch { item.cancel(); } };
      browser.on('will-download', download);
      entry.cleanupSession = () => { browser.removeListener('will-download', download); browser.setPermissionCheckHandler(null); browser.setPermissionRequestHandler(null); };
      const view = entry.view = new WebContentsView({ webPreferences: { session: browser, preload: this.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false, offscreen: this.window.webContents.isOffscreen() } });
      view.setVisible(false); this.window.contentView.addChildView(view);
      entry.rpc = new ComfyRpc(message => { if (entry.closed || !entry.handshaken) throw new Error('Comfy 桥已关闭。'); view.webContents.send('mixcat:comfy-request', message); });
      const allowed = (url: string) => { try { return new URL(url).origin === entry.origin; } catch { return false; } };
      const inputBlocked = () => entry.busy || !!entry.flushing || entry.closed || this.quiescing;
      view.webContents.on('will-navigate', (event, url) => { if (!allowed(url) || inputBlocked()) event.preventDefault(); });
      view.webContents.on('will-redirect', (event, url) => { if (!allowed(url) || inputBlocked()) event.preventDefault(); });
      view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      view.webContents.on('before-input-event', event => { if (inputBlocked()) event.preventDefault(); });
      view.webContents.on('before-mouse-event', event => { if (inputBlocked()) event.preventDefault(); });
      view.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) { const connected = entry.handshaken; entry.handshaken = false; entry.rpc?.invalidate(); if (connected && !entry.closed) void this.closeEntry(projectId, entry).catch(console.error); } });
      view.webContents.on('render-process-gone', () => { if (!entry.closed) void this.closeEntry(projectId, entry).catch(console.error); });
      await view.webContents.loadURL(instance.origin);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([entry.ready, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Comfy 原生画布握手超时。')), 60000); })]); }
      finally { clearTimeout(timer); }
    })().catch(error => { if (!entry.closed) void this.closeEntry(projectId, entry).catch(console.error); throw error; });
  }
  async request(projectId: string, request: ComfyRequest, actor: ComfyActor = { kind: 'user' }, expiresAt = Date.now() + 30000): Promise<ComfyReply> {
    validateComfyRequest(request);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) throw Error('Comfy 请求已过期。');
    const entry = this.entry(projectId);
    // Context and catalog never wait behind accepted provider recovery/downloads.
    if (request.type === 'summary') return {
      runtime: { status: entry.closed ? 'closing' : entry.handshaken ? 'ready' : entry.start ? 'preparing' : 'unprepared', ...(entry.instanceId ? { instanceId: entry.instanceId } : {}), ...(entry.start ? { versionId: (JSON.parse(readFileSync(join(this.assets, 'runtime-manifest.json'), 'utf8')) as RuntimeManifest).id } : {}) },
      providers: this.providers?.listForProject(projectId) ?? [], recentRuns: entry.runs.recent(),
    };
    if (request.type === 'inspect_nodes') {
      if (!request.nodeTypes.length || request.nodeTypes.length > 50) throw Error('请提供 1–50 个原生节点类型。');
      await this.start(projectId, entry);
      const result: NodeCatalog = { nodes: [], missing: [] };
      for (const classType of request.nodeTypes) {
        if (entry.closed || this.projects.get(projectId) !== entry.root || expiresAt <= Date.now()) throw Error('Comfy 节点目录实例已关闭或请求已过期；请在准备完成后重试。');
        const response = await fetch(entry.origin + '/object_info/' + encodeURIComponent(classType), { signal: AbortSignal.timeout(Math.min(10000, expiresAt - Date.now())), redirect: 'error' });
        if (!response.ok || !response.body) throw Error('Comfy 原生节点目录读取失败。');
        const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
        try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.length; if (bytes > COMFY_GRAPH_MAX_BYTES) throw Error('Comfy 节点目录超过 8 MiB。'); chunks.push(chunk.value); } }
        finally { await reader.cancel(); reader.releaseLock(); }
        const catalog: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); comfyObject(catalog);
        const node = catalog[classType];
        if (node === undefined) result.missing.push(classType);
        else { comfyObject(node); comfyObject(node.input); if (!Array.isArray(node.output) || node.output.some(output => typeof output !== 'string')) throw Error('Comfy 原生节点目录格式不正确。'); result.nodes.push({ classType, inputs: node.input, outputs: node.output as string[] }); }
        boundedComfy(result);
      }
      if (entry.closed || expiresAt <= Date.now()) throw Error('Comfy 节点目录实例已关闭或请求已过期。');
      return result;
    }
    return entry.service.handle(projectId, request, actor, expiresAt);
  }
  private async submit(entry: Entry, payload: ComfyPromptPayload) {
    if (entry.closed || !entry.origin || !entry.instanceId) throw new Error('Comfy 提交实例已关闭。');
    const body = JSON.stringify(payload);
    const signature = createHmac('sha256', entry.admissionSecret).update(entry.instanceId + '\n' + body).digest('hex');
    const response = await fetch(entry.origin + '/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mixcat-Admission': signature }, body, signal: AbortSignal.timeout(15000), redirect: 'error' });
    const result = { status: response.status, body: await response.json() as Record<string, unknown> }; boundedComfy(result); return result;
  }
  private async control(entry: Entry, path: string, value: unknown) {
    const body = JSON.stringify(value), signature = createHmac('sha256', entry.admissionSecret).update(entry.instanceId + '\n' + body).digest('hex');
    const response = await fetch(entry.origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mixcat-Admission': signature }, body, signal: AbortSignal.timeout(5000), redirect: 'error' });
    if (!response.ok) throw Error('Native control request failed.');
  }
  async present(projectId: string, generation: number, bounds: PanelBounds | null) {
    generation = panelGeneration(generation); if (generation < this.generation || projectId !== this.selected) return;
    this.generation = generation; this.hide(); const revision = this.layoutRevision; if (!bounds) return;
    const entry = this.entry(projectId); await this.start(projectId, entry);
    if (entry.closed || revision !== this.layoutRevision || generation !== this.generation || projectId !== this.selected) return;
    const rect = panelBounds(bounds, this.window.getContentBounds()); if (rect) { entry.view!.setBounds(rect); entry.view!.setVisible(true); }
  }
  bind(projectId: string) { if (projectId !== this.selected || !this.projects.has(projectId)) throw Error('Comfy 项目不是当前工作区。'); this.hide(); return { generation: ++this.generation }; }
  hide() { this.layoutRevision++; for (const entry of this.entries.values()) entry.view?.setVisible(false); }
  listRuns(projectId: string, cursor?: string, selectedRunId?: string) { if (selectedRunId !== undefined) comfyText(selectedRunId); return this.entry(projectId).runs.list(cursor, selectedRunId); }
  versions(projectId: string) { const store = this.entry(projectId).service.store; return { versions: store.listVersions(), recovery: store.recoverableEdits().map(({ requestId, beforeVersionId }) => ({ requestId, beforeVersionId })) }; }
  async feedback(projectId: string, runId: string, assetId: string): Promise<ComfyFeedback> {
    comfyText(runId); comfyText(assetId);
    const entry = this.entry(projectId), run = await entry.runs.read(runId);
    const final = run.assets.find(asset => asset.id === assetId), artifact = final ?? run.recoveredAssets?.find(asset => asset.id === assetId);
    if (!artifact) throw Error('该成果不属于指定运行。');
    const path = await verifiedArtifactPath(entry.root, artifact);
    if (entry.closed || this.entries.get(projectId) !== entry) throw Error('Comfy 成果所属项目已关闭。');
    return { path, text: `请依据这次实际输出继续修改并按我的反馈创建一次新的运行。\nComfy 运行：${run.id}（${run.status}）\n${final ? '原生工作流成果' : '恢复的供应商中间产物，原生后处理未完成'}：${artifact.relativePath}\nSHA256：${artifact.sha256}\n工作流上下文：${JSON.stringify(run.observation)}`,
      attachments: artifact.mime.startsWith('image/') ? [{ type: 'localImage', path }] : [{ type: 'text', text: `附件：${artifact.relativePath}\n项目内文件：${path}`, text_elements: [] }] };
  }
  recovery(projectId: string) { return this.entry(projectId).service.store.recoverableEdits(); }
  assertProviderMutable(projectId: string, id: string, revision: number) { this.entry(projectId).runs.assertMutable(id, revision); }
  async refreshProviders(projectId: string) { const entry = this.entries.get(projectId); if (entry?.origin && !entry.closed) await this.control(entry, '/mixcat/connections-changed', {}); }
  activeOperations(projectId: string) { const entry = this.entry(projectId); return entry.runs.activeOperations(entry.instanceId ?? ''); }
  canClose(projectId: string) { const entry = this.entry(projectId); return entry.runs.canClose(entry.instanceId ?? ''); }
  async close(projectId: string, deleting = false) {
    const entry = this.entries.get(projectId) ?? (deleting ? this.entry(projectId) : undefined); if (!entry) return;
    if (deleting && (entry.closed || entry.flushing)) throw Error('Comfy 关闭尚未完成，请先重试安全关闭，再核对保留任务后删除。');
    if (entry.flushing) return entry.flushing;
    if (!entry.closed) {
      if (entry.busy || entry.service.pendingMutations || deleting && (entry.start && !entry.handshaken || entry.service.store.recoverableEdits().length)) throw Error('Comfy 正在准备、编辑或有待核对编辑，请处理后再关闭项目。');
      if (entry.runs.activeOperations().inFlight) throw Error('Comfy 正在保存已受理的远端操作，请等待完成后再关闭。');
      for (const run of entry.runs.activeOperations(entry.instanceId ?? '').runs) await entry.runs.read(run.id);
      if (entry.busy || entry.service.pendingMutations) throw Error('Comfy 正在编辑或提交，请等待当前操作完成后再关闭。');
      if (!entry.runs.canClose(entry.instanceId ?? '')) throw Error('Comfy 有活动运行；请先停止等待，再关闭项目。');
      const retained = entry.runs.activeOperations();
      if (deleting && (entry.service.store.activeRuns().length || retained.retainedJobs.length)) throw Error('Comfy 有未完成或状态待核对的运行；停止等待不会取消远端任务，请核对后再删除项目。');
    }
    if (!entry.closed && entry.handshaken && entry.view && !entry.view.webContents.isDestroyed()) {
      entry.flushing = (async () => {
        try { await entry.rpc!.flushGraph(projectId); entry.view!.webContents.session.flushStorageData(); await this.closeEntry(projectId, entry); }
        finally { entry.flushing = undefined; }
      })();
      return entry.flushing;
    }
    await this.closeEntry(projectId, entry);
  }
  private closeEntry(projectId: string, entry: Entry): Promise<void> {
    if (this.entries.get(projectId) !== entry) return Promise.resolve();
    if (entry.closing) return entry.closing;
    entry.closed = true; entry.busy = false; entry.rpc?.invalidate(); entry.rejectReady(new Error('Comfy 项目已关闭。'));
    return entry.closing = Promise.resolve().then(async () => {
      const failures: unknown[] = [];
      if (!entry.serviceClosed) { try { entry.runs.suspend(); } catch (error) { failures.push(error); } }
      if (entry.view) { this.window.contentView.removeChildView(entry.view); if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close(); entry.view = undefined; }
      entry.cleanupSession?.(); entry.cleanupSession = undefined;
      // Startup must settle before its store or runtime can be released.
      await entry.start?.catch(() => {});
      try { await entry.broker?.close(); entry.broker = undefined; } catch (error) { failures.push(error); }
      if (!entry.serviceClosed) { try { await entry.runs.close(); } catch (error) { failures.push(error); } }
      if (failures.length) throw new AggregateError(failures, 'Comfy 已受理操作尚未安全保存或结束，请修复后重试关闭。');
      if (!entry.serviceClosed) { await entry.service.close(); entry.serviceClosed = true; }
      await entry.runtime.stop();
      if (this.entries.get(projectId) === entry) this.entries.delete(projectId);
    }).finally(() => { entry.closing = undefined; });
  }
  async dispose(ownerLost = false) {
    this.quiescing = true;
    try { await Promise.all([...this.entries].map(([id, entry]) => ownerLost ? this.closeEntry(id, entry) : this.close(id))); }
    catch (error) { this.quiescing = false; throw error; }
    ipcMain.removeHandler('mixcat:comfy-connect'); ipcMain.removeHandler('mixcat:comfy-queue'); ipcMain.removeHandler('mixcat:comfy-admit'); ipcMain.removeListener('mixcat:comfy-reply', this.reply); ipcMain.removeListener('mixcat:comfy-ready', this.ready);
  }
}
