import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, protocol, shell, Tray, utilityProcess, type UtilityProcess, type IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { appendFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { ensureProjectDirectory, projectDirectory } from '../core/paths.js';
import { allowedLoginUrl } from './policy.js';
import type { AppCommand, AppReply, AppSnapshot } from '../shared/types.js';
import type { PanelCommand } from '../shared/panels.js';
import { PanelHost } from './panels.js';

protocol.registerSchemesAsPrivileged([{ scheme: 'mixcat-preview', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

const arg = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const root = ensureProjectDirectory(arg('workbench-root') ?? process.env.MIXCAT_ROOT ?? process.cwd());
const runtime = projectDirectory(root, '.runtime', 'desktop');
for (const name of ['userData', 'sessionData', 'logs', 'crashDumps', 'temp'] as const) app.setPath(name, projectDirectory(root, '.runtime', 'desktop', name));
app.setAppLogsPath(projectDirectory(root, '.runtime', 'desktop', 'logs'));
app.commandLine.appendSwitch('disk-cache-dir', projectDirectory(root, '.runtime', 'desktop', 'cache'));
app.commandLine.appendSwitch('disable-http-cache');
process.env.TEMP = app.getPath('temp'); process.env.TMP = process.env.TEMP;
if (!app.requestSingleInstanceLock()) app.exit(0);
let window: BrowserWindow | undefined, tray: Tray | undefined, worker: UtilityProcess | undefined;
let panels: PanelHost | undefined, lastSnapshot: AppSnapshot | undefined;
let quitting = false, startupError: string | undefined;
const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
let readyResolve!: () => void, readyReject!: (error: Error) => void;
const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
ready.catch(() => {});
const htmlPath = join(root, 'dist', 'renderer', 'index.html');
const logPath = join(runtime, 'logs', 'desktop.log');
const log = (message: string) => appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);

function resolveCodex(): string {
  const explicit = arg('codex') ?? process.env.MIXCAT_CODEX;
  if (explicit) return explicit;
  const candidates = (process.env.PATH ?? '').split(';').map(p => join(p, 'codex.exe'));
  const found = candidates.find(p => existsSync(p));
  if (found) return found;
  throw new Error('未找到 Codex。请使用 scripts/dev.ps1，或通过 MIXCAT_CODEX 指定 codex.exe。');
}
function request(command?: AppCommand, shutdown = false): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!worker) { reject(new Error(startupError ?? '本地后台尚未启动。')); return; }
    const id = randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('后台请求超时，请查看当前状态后再操作。')); }, shutdown ? 12000 : 90000);
    pending.set(id, { resolve, reject, timer }); worker.postMessage({ id, command, shutdown });
  });
}
function authorize(event: IpcMainInvokeEvent) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== pathToFileURL(htmlPath).href) throw new Error('不受信任的界面请求。');
}
function showWindow() { if (window && !window.isDestroyed()) { window.show(); window.focus(); } }
function observe(snapshot: AppSnapshot) { lastSnapshot = snapshot; panels?.observe(snapshot); }

app.on('second-instance', showWindow);
app.on('window-all-closed', () => {});
app.on('activate', showWindow);
app.on('before-quit', event => {
  if (quitting) return; event.preventDefault(); quitting = true;
  void request(undefined, true).catch(error => log(`shutdown: ${error.message}`)).finally(() => { worker?.kill(); tray?.destroy(); app.quit(); });
});

app.whenReady().then(async () => {
  const executable = resolveCodex();
  worker = utilityProcess.fork(join(root, 'dist', 'core', 'worker.cjs'), [root, executable], { cwd: root, stdio: 'pipe', serviceName: 'Mixcat workflow core' });
  worker.stdout?.on('data', chunk => log(String(chunk).trimEnd()));
  worker.stderr?.on('data', chunk => log(String(chunk).trimEnd()));
  worker.on('message', (message: any) => {
    if (message.type === 'ready') { readyResolve(); return; }
    if (message.type === 'fatal') { startupError = message.error; readyReject(new Error(message.error)); return; }
    if (message.type === 'snapshot') { observe(message.snapshot); if (window && !window.isDestroyed()) window.webContents.send('mixcat:snapshot', message.snapshot); return; }
    const entry = pending.get(message.id); if (!entry) return;
    clearTimeout(entry.timer); pending.delete(message.id); message.error ? entry.reject(new Error(message.error)) : entry.resolve(message.result);
  });
  worker.on('exit', code => {
    startupError = `本地后台已退出（${code}）。请重新启动应用，未确认执行会保留。`; worker = undefined; readyReject(new Error(startupError));
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(startupError)); } pending.clear();
    if (!quitting) { log(startupError); void dialog.showMessageBox({ type: 'error', title: 'Mixcat 后台已退出', message: startupError }); }
  });
  ipcMain.handle('mixcat:command', async (event, command: AppCommand): Promise<AppReply> => {
    authorize(event); if (!command || typeof command !== 'object' || JSON.stringify(command).length > 1000000) throw new Error('请求格式或大小不正确。');
    await ready; const result: AppReply = await request(command); observe(result.snapshot);
    if (result.authUrl) { if (!allowedLoginUrl(result.authUrl)) throw new Error('Codex 返回了不受支持的登录地址。'); await shell.openExternal(result.authUrl); }
    return { snapshot: result.snapshot, catalog: result.catalog };
  });
  ipcMain.handle('mixcat:panel', async (event, command: PanelCommand) => { authorize(event); await ready; return panels!.command(command); });
  ipcMain.handle('mixcat:attachments', async (event, projectId: string, nodeId: string) => { authorize(event); await ready; return panels!.attachments(projectId, nodeId); });
  ipcMain.handle('mixcat:directory', async event => {
    authorize(event); panels?.hide(); const result = await dialog.showOpenDialog(window!, { title: '选择非 C 盘的项目目录', properties: ['openDirectory'], defaultPath: root });
    return result.canceled ? null : ensureProjectDirectory(result.filePaths[0]);
  });
  window = new BrowserWindow({ width: 1460, height: 960, minWidth: 1100, minHeight: 720, title: 'Mixcat', backgroundColor: '#f7f6f3', show: false,
    webPreferences: { preload: join(root, 'dist', 'desktop', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false } });
  panels = new PanelHost(window, snapshot => { if (window && !window.isDestroyed()) window.webContents.send('mixcat:panels', snapshot); });
  if (lastSnapshot) panels.observe(lastSnapshot);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== pathToFileURL(htmlPath).href) event.preventDefault(); });
  window.on('close', event => { if (!quitting) { event.preventDefault(); window?.hide(); } });
  window.once('ready-to-show', () => window?.show());
  window.webContents.on('render-process-gone', (_event, details) => log(`renderer exited: ${details.reason}`));
  Menu.setApplicationMenu(null);
  const icon = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==').resize({ width: 16, height: 16 });
  tray = new Tray(icon); tray.setToolTip('Mixcat · 本地会话工作台'); tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开工作台', click: showWindow }, { label: '退出 Mixcat', click: () => app.quit() }])); tray.on('double-click', showWindow);
  await window.loadFile(htmlPath);
  log('desktop ready');
}).catch(error => { log(`startup: ${error.message}`); void dialog.showMessageBox({ type: 'error', title: 'Mixcat 启动失败', message: error.message }).then(() => app.exit(1)); });
