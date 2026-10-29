import { dialog, ipcMain, session, WebContentsView, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { copyFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { ComfyRuntime, type RuntimeManifest } from '../core/comfy-runtime.js';
import { ComfyStore } from '../core/comfy-store.js';
import { ComfyService } from '../core/comfy-service.js';
import { ComfyRpc } from '../core/comfy-rpc.js';
import { insideProject, projectDirectory } from '../core/paths.js';
import { boundedComfy, validateGraph } from '../shared/comfy-bridge.js';
import type { AppSnapshot } from '../shared/types.js';
import type { ComfyActor, ComfyReply, ComfyRequest } from '../shared/comfy.js';
import type { PanelBounds } from '../shared/panels.js';
import { panelBounds, panelGeneration } from './policy.js';
import { authorizeComfyGuest, authorizeComfyHandshake } from './comfy-policy.js';
import { safeDownloadName } from './panel-files.js';

interface Entry {
  root: string; runtime: ComfyRuntime; view?: WebContentsView; rpc?: ComfyRpc; service: ComfyService; origin?: string; instanceId?: string;
  handshaken: boolean; ready: Promise<void>; resolveReady: () => void; rejectReady: (error: Error) => void; start?: Promise<void>; closed: boolean; busy: boolean;
  cleanupSession?: () => void;
  closing?: Promise<void>; serviceClosed?: boolean;
}
export class ComfyHost {
  private projects = new Map<string, string>();
  private entries = new Map<string, Entry>();
  private selected: string | null = null;
  private generation = 0;
  constructor(private window: BrowserWindow, private assets: string, private preload: string) {
    ipcMain.handle('mixcat:comfy-connect', this.connect);
    ipcMain.on('mixcat:comfy-reply', this.reply); ipcMain.on('mixcat:comfy-ready', this.ready);
    window.on('resize', () => this.hide()); window.webContents.on('did-start-loading', () => this.hide());
  }
  observe(snapshot: AppSnapshot) {
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
  private ready = (event: IpcMainEvent) => {
    try {
      const entry = this.trusted(event); if (!entry.handshaken) return;
      entry.service.store.markGraphInitialized(); entry.resolveReady();
    } catch (error) { try { this.trusted(event).rejectReady(error as Error); } catch {} }
  };
  private entry(projectId: string): Entry {
    const root = this.projects.get(projectId); if (!root) throw new Error('Comfy 项目未打开。');
    const existing = this.entries.get(projectId);
    if (existing?.closed) throw new Error('Comfy 项目关闭尚未完成；请重试关闭后再打开。');
    if (existing) return existing;
    let resolveReady!: () => void, rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; }); ready.catch(() => {});
    const store = new ComfyStore(root, projectId);
    const entry: Entry = { root, runtime: new ComfyRuntime(), service: new ComfyService(store, async request => {
      await this.start(projectId, entry);
      if (entry.closed) throw new Error('Comfy 项目已关闭。');
      entry.busy = request.type === 'apply_graph';
      try { const result = await entry.rpc!.request(projectId, request); validateGraph(result, projectId, entry.instanceId); return result; }
      catch (error) { if (!entry.closed && /超时/.test(String(error))) void this.closeEntry(projectId, entry).catch(console.error); throw error; }
      finally { entry.busy = false; }
    }), handshaken: false, ready, resolveReady, rejectReady, closed: false, busy: false };
    this.entries.set(projectId, entry); return entry;
  }
  private start(projectId: string, entry: Entry): Promise<void> {
    return entry.start ??= (async () => {
      const custom = projectDirectory(entry.root, '.mixcat', 'comfy', 'data', 'custom_nodes', 'mixcat');
      const web = projectDirectory(entry.root, '.mixcat', 'comfy', 'data', 'custom_nodes', 'mixcat', 'web');
      copyFileSync(join(this.assets, 'mixcat', '__init__.py'), insideProject(entry.root, join(custom, '__init__.py')));
      copyFileSync(join(this.assets, 'mixcat', 'web', 'bridge.js'), insideProject(entry.root, join(web, 'bridge.js')));
      const manifest = JSON.parse(readFileSync(join(this.assets, 'runtime-manifest.json'), 'utf8')) as RuntimeManifest;
      let port = entry.service.store.getRuntimePort();
      if (port === undefined) {
        const candidate = await new Promise<number>((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); const selected = typeof address === 'object' && address ? address.port : 0; server.close(error => error ? reject(error) : resolve(selected)); }); });
        if (entry.closed) throw new Error('Comfy 项目已关闭。');
        port = entry.service.store.setRuntimePort(candidate);
      }
      entry.runtime = new ComfyRuntime({ port });
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
      view.webContents.on('will-navigate', (event, url) => { if (!allowed(url) || entry.busy) event.preventDefault(); });
      view.webContents.on('will-redirect', (event, url) => { if (!allowed(url) || entry.busy) event.preventDefault(); });
      view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      view.webContents.on('before-input-event', event => { if (entry.busy) event.preventDefault(); });
      view.webContents.on('before-mouse-event', event => { if (entry.busy) event.preventDefault(); });
      view.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) { entry.handshaken = false; entry.rpc?.invalidate(); } });
      view.webContents.on('render-process-gone', () => { if (!entry.closed) void this.closeEntry(projectId, entry).catch(console.error); });
      await view.webContents.loadURL(instance.origin);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([entry.ready, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Comfy 原生画布握手超时。')), 60000); })]); }
      finally { clearTimeout(timer); }
    })().catch(error => { if (!entry.closed) void this.closeEntry(projectId, entry).catch(console.error); throw error; });
  }
  request(projectId: string, request: ComfyRequest, actor: ComfyActor = { kind: 'user' }): Promise<ComfyReply> { boundedComfy(request); return this.entry(projectId).service.handle(projectId, request, actor); }
  async present(projectId: string, generation: number, bounds: PanelBounds | null) {
    generation = panelGeneration(generation); if (generation < this.generation || projectId !== this.selected) return;
    this.generation = generation; this.hide(); if (!bounds) return;
    const entry = this.entry(projectId); await this.start(projectId, entry);
    if (entry.closed || generation !== this.generation || projectId !== this.selected) return;
    const rect = panelBounds(bounds, this.window.getContentBounds()); if (rect) { entry.view!.setBounds(rect); entry.view!.setVisible(true); }
  }
  hide() { for (const entry of this.entries.values()) entry.view?.setVisible(false); }
  recovery(projectId: string) { return this.entry(projectId).service.store.recoverableEdits(); }
  async close(projectId: string) {
    const entry = this.entries.get(projectId); if (!entry) return;
    await this.closeEntry(projectId, entry);
  }
  private closeEntry(projectId: string, entry: Entry): Promise<void> {
    if (this.entries.get(projectId) !== entry) return Promise.resolve();
    if (entry.closing) return entry.closing;
    entry.closed = true; entry.rpc?.invalidate(); entry.rejectReady(new Error('Comfy 项目已关闭。'));
    return entry.closing = Promise.resolve().then(async () => {
      if (entry.view) { this.window.contentView.removeChildView(entry.view); if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close(); entry.view = undefined; }
      entry.cleanupSession?.(); entry.cleanupSession = undefined;
      // Startup must settle before its store or runtime can be released.
      await entry.start?.catch(() => {});
      if (!entry.serviceClosed) { await entry.service.close(); entry.serviceClosed = true; }
      await entry.runtime.stop();
      if (this.entries.get(projectId) === entry) this.entries.delete(projectId);
    }).finally(() => { entry.closing = undefined; });
  }
  async dispose() { ipcMain.removeHandler('mixcat:comfy-connect'); ipcMain.removeListener('mixcat:comfy-reply', this.reply); ipcMain.removeListener('mixcat:comfy-ready', this.ready); await Promise.all([...this.entries.keys()].map(id => this.close(id))); }
}
