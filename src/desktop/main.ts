import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, shell, Tray, utilityProcess, type UtilityProcess, type IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { appendFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { ensureProjectDirectory, projectDirectory } from '../core/paths.js';
import { allowedLoginUrl } from './policy.js';
import type { AppReply, AppSnapshot, CommandEnvelope, CommandReceipt } from '../shared/types.js';
import { COMMAND_JSON_LIMIT } from '../shared/commands.js';
import type { PanelCommand } from '../shared/panels.js';
import { SnapshotReceiver } from '../shared/snapshots.js';
import { PanelHost } from './panels.js';

protocol.registerSchemesAsPrivileged([{ scheme: 'mixcat-preview', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

const arg = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const root = ensureProjectDirectory(arg('workbench-root') ?? process.env.MIXCAT_ROOT ?? process.cwd());
const runtime = projectDirectory(root, '.runtime', 'client', 'desktop');
for (const name of ['userData', 'sessionData', 'logs', 'crashDumps', 'temp'] as const) app.setPath(name, projectDirectory(root, '.runtime', 'client', 'desktop', name));
app.setAppLogsPath(projectDirectory(root, '.runtime', 'client', 'desktop', 'logs'));
app.commandLine.appendSwitch('disk-cache-dir', projectDirectory(root, '.runtime', 'client', 'desktop', 'cache'));
app.commandLine.appendSwitch('disable-http-cache');
process.env.TEMP = app.getPath('temp'); process.env.TMP = process.env.TEMP;
if (!app.requestSingleInstanceLock()) app.exit(0);
let window: BrowserWindow | undefined, tray: Tray | undefined, worker: UtilityProcess | undefined;
let panels: PanelHost | undefined, lastSnapshot: AppSnapshot | undefined;
let quitting = false, quitReady = false, startupError: string | undefined;
let feedUnsaved = false;
const unsavedProjects = new Set<string>();
const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
let readyResolve!: () => void, readyReject!: (error: Error) => void;
const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
ready.catch(() => {});
const htmlPath = join(root, 'dist', 'client', 'renderer', 'index.html');
const logPath = join(runtime, 'logs', 'desktop.log');
const log = (message: string) => appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);

function resolveCodex(): string {
  const explicit = arg('codex') ?? process.env.MIXCAT_CODEX;
  if (explicit) return explicit;
  const candidates = (process.env.PATH ?? '').split(';').map(p => join(p, 'codex.exe'));
  const found = candidates.find(p => existsSync(p));
  if (found) return found;
  return 'codex';
}
function request(data: { envelope?: CommandEnvelope; inspectId?: string; shutdown?: boolean }, timeout = data.shutdown ? 12000 : 90000): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!worker) { reject(new Error(startupError ?? '本地后台尚未启动。')); return; }
    const id = randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(Object.assign(new Error('后台请求超时。'), { code: 'COMMAND_TIMEOUT' })); }, timeout);
    pending.set(id, { resolve, reject, timer }); worker.postMessage({ id, ...data });
  });
}
function authorize(event: IpcMainInvokeEvent) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== pathToFileURL(htmlPath).href) throw new Error('不受信任的界面请求。');
}
function showWindow() { if (window && !window.isDestroyed()) { window.show(); window.focus(); } }
const snapshots = new SnapshotReceiver(async id => (await request({ envelope: { id: randomUUID(), command: { type: 'snapshot', projectId: id, background: true } } })).snapshot, snapshot => { lastSnapshot = snapshot; panels?.observe(snapshot); }, error => log('snapshot resync: ' + String(error)));
function observe(snapshot: AppSnapshot, creationToken?: number) { snapshots.accept({ kind: 'full', snapshot }, creationToken); }

app.on('second-instance', showWindow);
app.on('window-all-closed', () => {});
app.on('activate', showWindow);
app.on('before-quit', event => {
  if (quitReady) return;
  event.preventDefault(); if (quitting) return; quitting = true;
  void (async () => {
    if (unsavedProjects.size || feedUnsaved) {
      const decision = await dialog.showMessageBox({ type: 'question', title: '有未保存的草稿', message: '退出会放弃尚未持久保存的输入。', buttons: ['继续编辑', '放弃草稿并退出'], defaultId: 0, cancelId: 0 });
      if (decision.response !== 1) { quitting = false; return; }
    }
    await request({ shutdown: true }).catch(error => log(`shutdown: ${error.message}`));
    worker?.kill(); tray?.destroy(); quitReady = true; app.quit();
  })().catch(error => { quitting = false; log(`quit: ${String(error)}`); });
});

app.whenReady().then(async () => {
  const executable = resolveCodex();
  const accountRoot = process.env.MIXCAT_ACCOUNT_ROOT ? ensureProjectDirectory(process.env.MIXCAT_ACCOUNT_ROOT) : root;
  worker = utilityProcess.fork(join(root, 'dist', 'client', 'core', 'worker.cjs'), [root, executable, accountRoot], { cwd: root, stdio: 'pipe', serviceName: 'Mixcat workflow core' });
  worker.stdout?.on('data', chunk => log(String(chunk).trimEnd()));
  worker.stderr?.on('data', chunk => log(String(chunk).trimEnd()));
  worker.on('message', (message: any) => {
    if (message.type === 'ready') { readyResolve(); return; }
    if (message.type === 'fatal') { startupError = message.error; readyReject(new Error(message.error)); return; }
    if (message.type === 'feed_snapshot') { if (window && !window.isDestroyed()) window.webContents.send('mixcat:feed', message.snapshot); return; }
    if (message.type === 'snapshot') { snapshots.accept(message.snapshot); if (window && !window.isDestroyed()) window.webContents.send('mixcat:snapshot', message.snapshot); return; }
    const entry = pending.get(message.id); if (!entry) return;
    clearTimeout(entry.timer); pending.delete(message.id); message.error ? entry.reject(new Error(message.error)) : entry.resolve(message.result);
  });
  worker.on('exit', code => {
    startupError = `本地后台已退出（${code}）。请重新启动应用，未确认执行会保留。`; worker = undefined; readyReject(new Error(startupError));
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(startupError)); } pending.clear();
    if (!quitting) { log(startupError); void dialog.showMessageBox({ type: 'error', title: 'Mixcat 后台已退出', message: startupError }); }
  });
  ipcMain.handle('mixcat:command', async (event, envelope: CommandEnvelope): Promise<AppReply> => {
    authorize(event); if (!envelope || typeof envelope !== 'object' || typeof envelope.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(envelope.id) || !envelope.command || typeof envelope.command !== 'object' || JSON.stringify(envelope).length > COMMAND_JSON_LIMIT) throw new Error('请求格式或大小不正确。');
    await ready;
    if (envelope.command.type === 'snapshot' && envelope.command.projectId && !envelope.command.background) snapshots.navigate(envelope.command.projectId);
    const creationToken = envelope.command.type === 'create_project' || envelope.command.type === 'delete_project' && snapshots.snapshot?.selected?.project.id === envelope.command.projectId ? snapshots.navigate(null) : undefined;
    let result: AppReply;
    try { result = await request({ envelope }); }
    catch (error) {
      if ((error as any).code !== 'COMMAND_TIMEOUT') { if (creationToken !== undefined) snapshots.cancelNavigation(creationToken); throw error; }
      const receipt: CommandReceipt = await request({ inspectId: envelope.id }, 3000).catch(() => ({ id: envelope.id, status: 'unknown' }));
      if (receipt.status !== 'succeeded' || !receipt.result) { if (creationToken !== undefined) snapshots.cancelNavigation(creationToken); throw new Error(`命令 ${envelope.id} 的回执为 ${receipt.status}。${receipt.error ?? '请核对任务与原生会话，未自动重发。'}`); }
      result = receipt.result;
    }
    observe(result.snapshot, creationToken);
    if (result.authUrl) { if (!allowedLoginUrl(result.authUrl)) throw new Error('Codex 返回了不受支持的登录地址。'); await shell.openExternal(result.authUrl); }
    return { snapshot: result.snapshot, catalog: result.catalog, projectItems: result.projectItems, projectItem: result.projectItem, itemReceipt: result.itemReceipt, feed: result.feed };
  });
  ipcMain.handle('mixcat:inspect', async (event, id: string): Promise<CommandReceipt> => {
    authorize(event); if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('命令编号不正确。');
    await ready; const receipt: CommandReceipt = await request({ inspectId: id }, 3000);
    if (receipt.result) receipt.result = { snapshot: receipt.result.snapshot, catalog: receipt.result.catalog, projectItems: receipt.result.projectItems, projectItem: receipt.result.projectItem, itemReceipt: receipt.result.itemReceipt, feed: receipt.result.feed };
    return receipt;
  });
  ipcMain.handle('mixcat:panel', async (event, command: PanelCommand) => { authorize(event); await ready; return panels!.command(command); });
  ipcMain.handle('mixcat:choose-panel-file', async (event, projectId: string, nodeId: string, generation: number) => { authorize(event); await ready; return panels!.chooseFile(projectId, nodeId, generation); });
  ipcMain.handle('mixcat:attachments', async (event, projectId: string, nodeId: string) => { authorize(event); await ready; return panels!.attachments(projectId, nodeId); });
  ipcMain.handle('mixcat:directory', async event => {
    authorize(event); panels?.hide(); const result = await dialog.showOpenDialog(window!, { title: '选择非 C 盘的项目目录', properties: ['openDirectory'], defaultPath: root });
    return result.canceled ? null : ensureProjectDirectory(result.filePaths[0]);
  });
  ipcMain.handle('mixcat:open-external', async (event, value: unknown) => {
    authorize(event);
    if (typeof value !== 'string' || value.length > 8192) throw new Error('链接格式不正确。');
    const url = new URL(value); if (!['https:', 'http:'].includes(url.protocol)) throw new Error('只能打开 HTTP 或 HTTPS 链接。');
    await shell.openExternal(url.href);
  });
  ipcMain.handle('mixcat:feed-unsaved', (event, dirty: unknown) => { authorize(event); if (typeof dirty !== 'boolean') throw new Error('草稿状态格式不正确。'); feedUnsaved = dirty; });
  ipcMain.handle('mixcat:unsaved', (event, projectId: unknown, dirty: unknown) => {
    authorize(event);
    if (typeof projectId !== 'string' || typeof dirty !== 'boolean') throw new Error('草稿状态格式不正确。');
    if (dirty && !lastSnapshot?.projects.some(project => project.id === projectId)) throw new Error('项目不在当前工作台中。');
    dirty ? unsavedProjects.add(projectId) : unsavedProjects.delete(projectId);
  });
  const icon = join(root, 'dist', 'client', 'desktop', 'mixcat.ico');
  window = new BrowserWindow({ width: 1460, height: 960, minWidth: 1100, minHeight: 720, title: 'Mixcat', icon, backgroundColor: '#ffffff', show: false,
    titleBarStyle: 'hidden', titleBarOverlay: { color: '#f9f9f9', symbolColor: '#333333', height: 32 },
    webPreferences: { preload: join(root, 'dist', 'client', 'desktop', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false } });
  panels = new PanelHost(window, snapshot => { if (window && !window.isDestroyed()) window.webContents.send('mixcat:panels', snapshot); });
  if (lastSnapshot) panels.observe(lastSnapshot);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== pathToFileURL(htmlPath).href) event.preventDefault(); });
  window.on('close', event => { if (!quitting) { event.preventDefault(); window?.hide(); } });
  window.once('ready-to-show', () => window?.show());
  window.webContents.on('render-process-gone', (_event, details) => log(`renderer exited: ${details.reason}`));
  Menu.setApplicationMenu(null);
  tray = new Tray(icon); tray.setToolTip('Mixcat · 本地会话工作台'); tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开工作台', click: showWindow }, { label: '退出 Mixcat', click: () => app.quit() }])); tray.on('double-click', showWindow);
  await window.loadFile(htmlPath);
  log('desktop ready');
}).catch(error => { log(`startup: ${error.message}`); void dialog.showMessageBox({ type: 'error', title: 'Mixcat 启动失败', message: error.message }).then(() => app.exit(1)); });
