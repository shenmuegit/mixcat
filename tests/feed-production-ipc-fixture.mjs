import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import electron from 'electron';
import { projectDirectory, insideProject } from '../src/core/paths.ts';

// Production main/preload/worker are copied intact; only the configured native executable is synthetic.
export async function launchFeedProductionFixture(root, fixture, generation) {
  insideProject(root, fixture);
  const path = name => insideProject(fixture, join(fixture, name));
  for (const name of ['tmp', 'appdata', 'localappdata', 'home', 'cache', 'config', 'data', 'host-codex']) projectDirectory(fixture, name);
  const env = { ...process.env, MIXCAT_ROOT: fixture, MIXCAT_ACCOUNT_ROOT: fixture, MIXCAT_HOST_CODEX_HOME: path('host-codex'), TEMP: path('tmp'), TMP: path('tmp'), TMPDIR: path('tmp'), APPDATA: path('appdata'), LOCALAPPDATA: path('localappdata'), HOME: path('home'), USERPROFILE: path('home'), XDG_CACHE_HOME: path('cache'), XDG_CONFIG_HOME: path('config'), XDG_DATA_HOME: path('data'), ELECTRON_CACHE: path('cache'), TSX_DISABLE_CACHE: '1', NODE_DISABLE_COMPILE_CACHE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port; await new Promise(done => server.close(done));
  const main = path('dist/client/desktop/main.cjs'), startedAt = new Date().toISOString();
  const child = spawn(electron, [main, `--workbench-root=${fixture}`, `--codex=${process.execPath}`, `--remote-debugging-port=${port}`], { cwd: fixture, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const outputPath = path(`electron-${generation}.log`), desktopPath = path('.runtime/client/desktop/logs/desktop.log');
  child.stdout.on('data', data => appendFileSync(outputPath, data)); child.stderr.on('data', data => appendFileSync(outputPath, data));
  writeFileSync(path(`launch-${generation}.json`), JSON.stringify({ pid: child.pid, executable: electron, main, startedAt, fixture }, null, 2));
  let socket, sequence = 0, closed = false; const pending = new Map();
  async function poll(fn, label = 'desktop condition', attempts = 400) {
    for (let i = 0; i < attempts; i++) { const value = await fn(); if (value) return value; await new Promise(done => setTimeout(done, 50)); }
    throw Error(`Timed out: ${label}; fixture ${fixture}`);
  }
  async function rpc(method, params = {}) {
    const id = ++sequence;
    return new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 10000); pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } }); socket.send(JSON.stringify({ id, method, params })); });
  }
  async function evaluate(expression) { const result = await rpc('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value; }
  async function command(command) { return evaluate(`window.mixcat.command({id:crypto.randomUUID(),command:${JSON.stringify(command)}}).then(reply=>reply.feed)`); }
  async function click(selector, text) {
    const point = await poll(() => evaluate(`(async()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.getClientRects().length&&${text ? `e.textContent.includes(${JSON.stringify(text)})` : 'true'});if(!e||e.disabled)return null;e.scrollIntoView({block:'nearest'});await new Promise(requestAnimationFrame);const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return e.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`), `click ${selector} ${text ?? ''}`);
    await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 }); await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  }
  async function fill(selector, text) { await click(selector); for (const type of ['keyDown', 'keyUp']) await rpc('Input.dispatchKeyEvent', { type, key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 }); await rpc('Input.insertText', { text }); }
  async function screenshot(name) { const result = await rpc('Page.captureScreenshot', { format: 'png' }); writeFileSync(path(name), Buffer.from(result.data, 'base64')); }
  async function close() {
    if (closed) return;
    const previous = existsSync(desktopPath) ? readFileSync(desktopPath, 'utf8').length : 0;
    if (socket?.readyState === 1) await rpc('Browser.close').catch(error => { if (!String(error).includes('CDP timeout')) throw error; });
    await poll(() => child.exitCode !== null, 'normal Electron exit', 400);
    assert.equal(child.exitCode, 0);
    assert.match(readFileSync(desktopPath, 'utf8').slice(previous), /core shutdown: complete/);
    socket?.close(); closed = true;
    writeFileSync(path(`shutdown-${generation}.json`), JSON.stringify({ pid: child.pid, exitCode: child.exitCode, completedAt: new Date().toISOString(), normalShutdown: true }, null, 2));
  }
  const page = await poll(async () => {
    if (child.exitCode !== null) throw Error(`Electron exited ${child.exitCode}; ${outputPath}`);
    try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })).json()).find(page => page.type === 'page' && page.url === pathToFileURL(path('dist/client/renderer/index.html')).href); } catch { return null; }
  }, 'exact production renderer');
  socket = new WebSocket(page.webSocketDebuggerUrl); await once(socket, 'open');
  socket.addEventListener('message', event => { const result = JSON.parse(String(event.data)), entry = pending.get(result.id); if (entry) { pending.delete(result.id); result.error ? entry.reject(Error(JSON.stringify(result.error))) : entry.resolve(result.result); } });
  await poll(() => existsSync(desktopPath) && readFileSync(desktopPath, 'utf8').split('\n').some(line => line.includes('desktop ready') && line.slice(0, 24) >= startedAt), 'new desktop ready');
  await poll(() => evaluate('!!window.mixcat && !!document.querySelector(".workspace-sidebar nav button")'), 'production preload and sidebar');
  return { pid: child.pid, startedAt, evaluate, command, poll, rpc, click, fill, screenshot, close };
}
