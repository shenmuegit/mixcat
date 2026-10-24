import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import electron from 'electron';
import { projectDirectory, insideProject } from '../src/core/paths.ts';

// Shared controlled Electron driver for review UI tests; all state and artifacts stay in the fixture.
export async function openRendererFixture(root, fixture) {
  insideProject(root, fixture);
  const path = name => insideProject(root, join(fixture, name));
  for (const name of ['tmp', 'appdata', 'localappdata', 'home', 'cache', 'userData', 'sessionData', 'logs', 'crashDumps', 'temp']) projectDirectory(fixture, name);
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port; await new Promise(done => server.close(done));
  const env = { ...process.env, TEMP: path('tmp'), TMP: path('tmp'), TMPDIR: path('tmp'), APPDATA: path('appdata'), LOCALAPPDATA: path('localappdata'), HOME: path('home'), XDG_CACHE_HOME: path('cache') }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [path('main.cjs'), `--remote-debugging-port=${port}`], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', socket, sequence = 0; const pending = new Map(); child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data);
  const delay = ms => new Promise(done => setTimeout(done, ms));
  async function poll(fn) { for (let i = 0; i < 100; i++) { const value = await fn(); if (value) return value; await delay(50); } throw Error('Renderer condition timed out'); }
  async function rpc(method, params = {}) { const id = ++sequence; return new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 10000); pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } }); socket.send(JSON.stringify({ id, method, params })); }); }
  async function evaluate(expression) { const result = await rpc('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value; }
  async function click(selector, text) {
    const point = await poll(() => evaluate(`(async()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>${text ? `e.textContent.includes(${JSON.stringify(text)})` : 'true'});if(!e||e.disabled)return null;e.scrollIntoView({block:'nearest'});await new Promise(requestAnimationFrame);const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return e.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`));
    await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 }); await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  }
  async function fill(selector, text) { await click(selector); await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 }); await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 }); await rpc('Input.insertText', { text }); }
  async function screenshot(name) { const result = await rpc('Page.captureScreenshot', { format: 'png' }); writeFileSync(path(name), Buffer.from(result.data, 'base64')); }
  async function close() {
    if (socket?.readyState === 1) try { await rpc('Browser.close'); } catch {} socket?.close();
    if (child.exitCode === null) { await Promise.race([once(child, 'exit'), delay(3000)]); if (child.exitCode === null) child.kill(); }
    writeFileSync(path('electron.log'), output);
  }
  try {
    const page = await poll(async () => { try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(page => page.type === 'page'); } catch { return null; } });
    socket = new WebSocket(page.webSocketDebuggerUrl); await once(socket, 'open'); socket.addEventListener('message', event => { const result = JSON.parse(String(event.data)), entry = pending.get(result.id); if (entry) { pending.delete(result.id); result.error ? entry.reject(Error(JSON.stringify(result.error))) : entry.resolve(result.result); } });
  } catch (error) { await close(); throw error; }
  return { evaluate, rpc, poll, click, fill, screenshot, close };
}
