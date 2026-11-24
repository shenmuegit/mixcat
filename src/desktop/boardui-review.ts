import { app, BrowserWindow, protocol, session } from 'electron';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const scheme = 'boardui-review';
const origin = scheme + '://local';
const title = 'Mixcat 设计评审';
const startUrl = new URL(origin + '/index.html');
startUrl.hash = process.argv[2] ?? '#/074/agent-runtime';
const resources = new Map([
  [origin + '/index.html', { name: 'index.html', contentType: 'text/html; charset=utf-8' }],
  [origin + '/review.js', { name: 'review.js', contentType: 'text/javascript; charset=utf-8' }],
  [origin + '/review.css', { name: 'review.css', contentType: 'text/css; charset=utf-8' }],
  [origin + '/mixcat.ico', { name: 'mixcat.ico', contentType: 'image/x-icon' }],
]);
const csp = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:",
  "font-src 'self'", "connect-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join('; ');

app.setName(title);
for (const name of ['userData', 'sessionData', 'logs', 'crashDumps', 'temp'] as const) {
  const path = join(__dirname, '..', 'profile', name);
  mkdirSync(path, { recursive: true });
  app.setPath(name, path);
}
if (!app.requestSingleInstanceLock({ hash: process.argv[2] ?? '' })) app.exit(0);
protocol.registerSchemesAsPrivileged([{ scheme, privileges: { standard: true, secure: true } }]);

app.on('window-all-closed', () => app.quit());
void app.whenReady().then(async () => {
  const reviewSession = session.defaultSession;
  reviewSession.protocol.handle(scheme, async request => {
    const resource = resources.get(request.url.split('#', 1)[0]);
    if (!resource || request.method !== 'GET') return new Response(null, { status: 404 });
    const contents = await readFile(join(__dirname, resource.name));
    return new Response(new Uint8Array(contents), {
      headers: { 'Content-Type': resource.contentType, 'Content-Security-Policy': csp },
    });
  });
  reviewSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !resources.has(details.url.split('#', 1)[0]) });
  });
  reviewSession.setPermissionCheckHandler(() => false);
  reviewSession.setPermissionRequestHandler((_contents, _permission, respond) => respond(false));
  reviewSession.setDevicePermissionHandler(() => false);
  reviewSession.on('will-download', event => event.preventDefault());

  const window = new BrowserWindow({
    title, icon: join(__dirname, 'mixcat.ico'), width: 1280, height: 830, minWidth: 1100, minHeight: 720,
    show: false, backgroundColor: '#f3f3f5', autoHideMenuBar: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false },
  });
  window.removeMenu();
  window.webContents.on('will-frame-navigate', event => {
    if (!event.isMainFrame || event.url.split('#', 1)[0] !== origin + '/index.html') event.preventDefault();
  });
  window.webContents.on('will-redirect', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  app.on('second-instance', (_event, _argv, _directory, data) => {
    if (window.isDestroyed()) return;
    if (data && typeof data === 'object' && 'hash' in data && typeof data.hash === 'string' && data.hash.startsWith('#/')) {
      const next = new URL(startUrl.href);
      next.hash = data.hash;
      void window.loadURL(next.href).catch(console.error);
    }
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  await window.loadURL(startUrl.href);
  window.show();
  console.log('boardui review ready ' + startUrl.href);
}).catch(error => {
  console.error(error);
  app.exit(1);
});
