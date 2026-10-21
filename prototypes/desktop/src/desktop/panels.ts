import { dialog, session, WebContentsView, type BrowserWindow, type Session } from 'electron';
import { readFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { insideProject, projectDirectory } from '../core/paths.js';
import type { AppSnapshot, NativeInput } from '../shared/types.js';
import type { NodePanel, PanelBounds, PanelCommand, PanelSnapshot } from '../shared/panels.js';
import { panelBounds, panelUrl } from './policy.js';
import { importAttachment, panelFilePath, previewType, safeDownloadName } from './panel-files.js';

interface PanelEntry { panel: NodePanel; view: WebContentsView; root: string; }
const previewCsp = "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'";
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

export class PanelHost {
  private projects = new Map<string, { root: string; nodes: Set<string> }>();
  private entries = new Map<string, PanelEntry>();
  private sessions = new Map<string, Session>();
  private active = new Map<string, string>();
  private layout: { projectId: string; nodeId: string; bounds: PanelBounds } | null = null;
  constructor(private window: BrowserWindow, private notify: (snapshot: PanelSnapshot) => void) {
    window.on('resize', () => this.hide());
    window.webContents.on('render-process-gone', () => this.hide());
    window.on('closed', () => this.close());
  }
  observe(snapshot: AppSnapshot) {
    for (const project of snapshot.projects) {
      const previous = this.projects.get(project.id);
      this.projects.set(project.id, { root: project.root, nodes: previous?.root === project.root ? previous.nodes : new Set() });
    }
    if (snapshot.selected) this.projects.set(snapshot.selected.project.id, { root: snapshot.selected.project.root, nodes: new Set(snapshot.selected.nodes.map(node => node.id)) });
    if (this.layout && snapshot.selected?.project.id !== this.layout.projectId) this.hide();
  }
  private scope(projectId: string, nodeId: string) {
    const project = this.projects.get(projectId);
    if (!project || !project.nodes.has(nodeId)) throw new Error('面板必须属于已打开项目的会话节点。');
    return project;
  }
  private key(projectId: string, nodeId: string) { return JSON.stringify([projectId, nodeId]); }
  private snapshot(projectId: string, nodeId: string): PanelSnapshot {
    return { projectId, nodeId, panels: [...this.entries.values()].filter(({ panel }) => panel.projectId === projectId && panel.nodeId === nodeId).map(({ panel }) => ({ ...panel })), activePanelId: this.active.get(this.key(projectId, nodeId)) ?? null };
  }
  private emit(projectId: string, nodeId: string) { this.notify(this.snapshot(projectId, nodeId)); }
  private find(command: { projectId: string; nodeId: string; panelId: string }): PanelEntry {
    const entry = this.entries.get(command.panelId);
    if (!entry || entry.panel.projectId !== command.projectId || entry.panel.nodeId !== command.nodeId) throw new Error('面板不属于当前节点。');
    return entry;
  }
  hide() { this.layout = null; for (const { view } of this.entries.values()) view.setVisible(false); }
  private show() {
    for (const { panel, view } of this.entries.values()) {
      const bounds = this.layout?.projectId === panel.projectId && this.layout.nodeId === panel.nodeId && this.active.get(this.key(panel.projectId, panel.nodeId)) === panel.id ? this.layout.bounds : null;
      if (bounds && bounds.width > 0 && bounds.height > 0) view.setBounds(bounds);
      view.setVisible(Boolean(bounds && bounds.width > 0 && bounds.height > 0));
    }
  }
  private browserSession(root: string, preview: boolean): Session {
    const path = projectDirectory(root, '.mixcat', preview ? 'previews' : 'browser');
    const existing = this.sessions.get(path); if (existing) return existing;
    const directories = [path];
    while (directories.length) for (const child of readdirSync(directories.pop()!, { withFileTypes: true })) {
      if (child.isSymbolicLink()) throw new Error('浏览器数据目录不能包含符号链接或目录联接。');
      if (child.isDirectory()) directories.push(join(child.parentPath, child.name));
    }
    const browser = session.fromPath(path, { cache: false });
    const permissions = new Set<string>();
    browser.setPermissionCheckHandler((_contents, permission, origin) => permissions.has(`${origin}:${permission}`));
    browser.setPermissionRequestHandler((contents, permission, callback, details) => {
      let origin: string;
      try { origin = new URL(details.requestingUrl || contents.getURL()).origin; } catch { callback(false); return; }
      if (preview) { callback(false); return; }
      void dialog.showMessageBox(this.window, { type: 'question', title: '网页权限', message: `${origin} 请求 ${permission} 权限`, buttons: ['拒绝', '允许'], defaultId: 0, cancelId: 0 }).then(result => {
        if (result.response === 1) permissions.add(`${origin}:${permission}`);
        callback(result.response === 1);
      }).catch(() => callback(false));
    });
    browser.on('will-download', (_event, item) => {
      try { item.setSavePath(insideProject(root, join(projectDirectory(root, '.mixcat', 'downloads'), safeDownloadName(item.getFilename())))); }
      catch { item.cancel(); }
    });
    if (preview) browser.protocol.handle('mixcat-preview', async request => {
      try {
        const url = new URL(request.url), entry = this.entries.get(url.hostname);
        if (!entry || entry.panel.kind !== 'file' || entry.root !== root || !entry.panel.path) return new Response('Not found', { status: 404 });
        const resource = panelFilePath(root, resolve(dirname(entry.panel.path), decodeURIComponent(url.pathname).slice(1)));
        const scope = relative(dirname(entry.panel.path), resource);
        if (scope === '..' || scope.startsWith(`..${sep}`) || /^[a-z]:/i.test(scope)) return new Response('Forbidden', { status: 403 });
        const type = previewType(resource);
        if (resource !== entry.panel.path && !type) return new Response('Unsupported preview resource', { status: 415 });
        const data = await readFile(resource);
        if (type) return new Response(data, { headers: { 'Content-Type': type, 'Content-Security-Policy': previewCsp, 'X-Content-Type-Options': 'nosniff' } });
        const html = `<!doctype html><meta charset="utf-8"><title>${escapeHtml(basename(resource))}</title><style>body{margin:24px;color:#252923;background:#fafaf8}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.6 monospace}</style><pre>${escapeHtml(data.toString('utf8'))}</pre>`;
        return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': previewCsp } });
      } catch { return new Response('This project resource cannot be opened', { status: 403 }); }
    });
    this.sessions.set(path, browser); return browser;
  }
  async command(command: PanelCommand): Promise<PanelSnapshot> {
    if (!command || typeof command !== 'object') throw new Error('面板请求不正确。');
    const { root } = this.scope(command.projectId, command.nodeId), key = this.key(command.projectId, command.nodeId);
    if (command.type === 'open') {
      if (!command.target || !['url', 'file'].includes(command.target.type)) throw new Error('面板内容不正确。');
      const file = command.target.type === 'file' ? panelFilePath(root, command.target.path) : undefined;
      const url = command.target.type === 'url' ? panelUrl(command.target.url) : undefined;
      const previous = [...this.entries.values()].find(({ panel }) => panel.projectId === command.projectId && panel.nodeId === command.nodeId && (file ? panel.path === file : panel.kind === 'browser' && panel.url === url));
      if (previous) this.active.set(key, previous.panel.id);
      else {
        const id = randomUUID(), panel: NodePanel = { id, projectId: command.projectId, nodeId: command.nodeId, kind: file ? 'file' : 'browser', title: typeof command.title === 'string' ? command.title.slice(0, 160) : file ? basename(file) : new URL(url!).hostname, url, path: file, loading: true, canGoBack: false, canGoForward: false };
        const view = new WebContentsView({ webPreferences: { session: this.browserSession(root, Boolean(file)), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false } });
        view.setVisible(false); this.window.contentView.addChildView(view);
        const entry = { panel, view, root }; this.entries.set(id, entry); this.active.set(key, id);
        const update = () => {
          if (!this.entries.has(id) || view.webContents.isDestroyed()) return;
          panel.loading = view.webContents.isLoading(); panel.canGoBack = view.webContents.navigationHistory.canGoBack(); panel.canGoForward = view.webContents.navigationHistory.canGoForward();
          if (!file) { panel.url = view.webContents.getURL() || url; panel.title = view.webContents.getTitle() || panel.title; }
          this.emit(panel.projectId, panel.nodeId);
        };
        const allowed = (target: string) => { try { return file ? new URL(target).protocol === 'mixcat-preview:' && new URL(target).hostname === id : Boolean(panelUrl(target)); } catch { return false; } };
        view.webContents.on('will-navigate', (event, target) => { if (!allowed(target)) event.preventDefault(); });
        view.webContents.on('will-redirect', (event, target) => { if (!allowed(target)) event.preventDefault(); });
        view.webContents.setWindowOpenHandler(({ url: target }) => { if (allowed(target)) void view.webContents.loadURL(target).catch(() => {}); return { action: 'deny' }; });
        view.webContents.on('did-start-loading', update); view.webContents.on('did-stop-loading', update);
        view.webContents.on('did-navigate', update); view.webContents.on('did-navigate-in-page', update); view.webContents.on('page-title-updated', update);
        view.webContents.on('did-start-loading', () => { panel.error = undefined; });
        view.webContents.on('did-fail-load', (_event, code, description, _url, mainFrame) => { if (mainFrame && code !== -3) { panel.error = description; update(); } });
        view.webContents.on('render-process-gone', (_event, details) => { panel.loading = false; panel.error = `页面进程已退出：${details.reason}`; this.emit(panel.projectId, panel.nodeId); });
        // The preview origin serves only this file and sibling assets, without desktop IPC.
        const target = file ? `mixcat-preview://${id}/${encodeURIComponent(basename(file))}` : url!;
        void view.webContents.loadURL(target).catch(error => { if (this.entries.has(id)) { panel.loading = false; panel.error = error.message; this.emit(panel.projectId, panel.nodeId); } });
      }
    } else if (command.type === 'activate') { this.find(command); this.active.set(key, command.panelId); }
    else if (command.type === 'close') {
      const entry = this.find(command); this.entries.delete(command.panelId); this.window.contentView.removeChildView(entry.view); entry.view.webContents.close();
      if (this.active.get(key) === command.panelId) { const next = this.snapshot(command.projectId, command.nodeId).panels.at(-1); next ? this.active.set(key, next.id) : this.active.delete(key); }
    } else if (command.type === 'navigate') {
      const { panel, view } = this.find(command);
      if (command.url !== undefined) { if (panel.kind !== 'browser') throw new Error('文件预览不能导航到网页。'); void view.webContents.loadURL(panelUrl(command.url)).catch(() => {}); }
      else if (command.action === 'reload') view.webContents.reload();
      else if (command.action === 'back' && view.webContents.navigationHistory.canGoBack()) view.webContents.navigationHistory.goBack();
      else if (command.action === 'forward' && view.webContents.navigationHistory.canGoForward()) view.webContents.navigationHistory.goForward();
    } else if (command.type === 'layout') {
      const bounds = panelBounds(command.bounds, this.window.getContentBounds());
      if (bounds) this.layout = { projectId: command.projectId, nodeId: command.nodeId, bounds };
      else if (this.layout?.projectId === command.projectId && this.layout.nodeId === command.nodeId) this.layout = null;
    } else if (command.type !== 'list') throw new Error('不支持的面板操作。');
    this.show(); const result = this.snapshot(command.projectId, command.nodeId); this.notify(result); return result;
  }
  async attachments(projectId: string, nodeId: string): Promise<NativeInput[]> {
    const { root } = this.scope(projectId, nodeId);
    const result = await dialog.showOpenDialog(this.window, { title: '添加节点会话附件', defaultPath: root, properties: ['openFile', 'multiSelections'] });
    return result.canceled ? [] : result.filePaths.map(source => importAttachment(root, source));
  }
  close() { for (const { view } of this.entries.values()) if (!view.webContents.isDestroyed()) view.webContents.close(); this.entries.clear(); }
}
