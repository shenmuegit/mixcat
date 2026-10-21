import assert from 'node:assert/strict';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import electron from 'electron';

const root = resolve('.');
function safe(path) {
  const absolute = resolve(path), part = relative(root, absolute);
  assert.ok(part && !part.startsWith('..') && !isAbsolute(part) && !/^c:/i.test(absolute));
  for (let p = absolute;; p = dirname(p)) { assert.ok(!existsSync(p) || !lstatSync(p).isSymbolicLink(), `Linked path: ${p}`); if (dirname(p) === p) break; }
  return absolute;
}
const evidence = safe(join(root, '.runtime/implementation')); mkdirSync(evidence, { recursive: true });
const fixture = mkdtempSync(safe(join(evidence, 'electron-')));
cpSync(join(root, 'dist/client'), safe(join(fixture, 'dist/client')), { recursive: true });
const project = safe(join(fixture, 'project')); mkdirSync(project);
for (const name of ['tmp', 'appdata', 'localappdata', 'home', 'cache']) mkdirSync(safe(join(fixture, name)));
const env = { ...process.env, MIXCAT_ROOT: fixture, TEMP: join(fixture, 'tmp'), TMP: join(fixture, 'tmp'), APPDATA: join(fixture, 'appdata'), LOCALAPPDATA: join(fixture, 'localappdata'), HOME: join(fixture, 'home'), XDG_CACHE_HOME: join(fixture, 'cache') };
delete env.ELECTRON_RUN_AS_NODE;
let child, socket, nextId = 0;
const pending = new Map();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function poll(fn) { for (let i = 0; i < 120; i++) { const value = await fn(); if (value) return value; await delay(100); } throw Error('Timed out waiting for desktop state'); }
async function launch() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port; await new Promise(resolve => server.close(resolve));
  child = spawn(electron, [join(fixture, 'dist/client/desktop/main.cjs'), `--workbench-root=${fixture}`, `--remote-debugging-port=${port}`], { cwd: fixture, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', data => { log += data; }); child.stderr.on('data', data => { log += data; });
  child.once('exit', () => writeFileSync(safe(join(fixture, `electron-${port}.log`)), log));
  const page = await poll(async () => { try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(p => p.type === 'page'); } catch { return null; } });
  socket = new WebSocket(page.webSocketDebuggerUrl); await once(socket, 'open');
  socket.addEventListener('message', event => { const result = JSON.parse(String(event.data)), entry = pending.get(result.id); if (entry) { pending.delete(result.id); result.error ? entry.reject(Error(JSON.stringify(result.error))) : entry.resolve(result.result); } });
  await poll(() => evaluate("document.querySelector('.page-heading h1')?.textContent"));
}
async function rpc(method, params = {}) {
  const id = ++nextId;
  return await new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 10000); pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } }); socket.send(JSON.stringify({ id, method, params })); });
}
async function evaluate(expression) { const result = await rpc('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value; }
async function click(selector, text) {
  const point = await evaluate(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => ${text ? `e.textContent.includes(${JSON.stringify(text)})` : 'true'}); if (!e) throw Error('Missing click target'); const r=e.getBoundingClientRect(); const x=r.x+r.width/2,y=r.y+r.height/2; if (!e.contains(document.elementFromPoint(x,y))) throw Error('Click target covered'); return {x,y}; })()`);
  await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 }); await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
}
async function fill(selector, value) { await evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); const prototype=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype,'value').set.call(e,${JSON.stringify(value)}); e.dispatchEvent(new Event('input',{bubbles:true})); })()`); }
async function screenshot(name) { await delay(300); const image = await rpc('Page.captureScreenshot', { format: 'png' }); writeFileSync(safe(join(evidence, name)), Buffer.from(image.data, 'base64')); }
async function close() {
  try { if (socket?.readyState === 1) await rpc('Browser.close'); } catch {}
  socket?.close();
  if (child && child.exitCode === null) { await Promise.race([once(child, 'exit'), delay(5000)]); if (child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); }
  for (const entry of pending.values()) entry.reject(Error('Desktop closed')); pending.clear();
}
try {
  await launch();
  assert.equal(await evaluate("document.querySelectorAll('.project-card').length"), 0);
  await screenshot('task-1-projects-empty.png');
  await click('button', '新建项目'); await poll(() => evaluate("!!document.querySelector('dialog[open]')"));
  await fill('dialog input', '桌面隔离验收'); await fill('dialog .input-with-button input', project); await fill('dialog textarea', '核验项目创建、打开和重启后的目录绑定');
  await screenshot('task-1-create.png');
  await click('dialog button', '创建项目'); await poll(() => evaluate("!!document.querySelector('.workbench')"));
  assert.equal(await evaluate("document.querySelector('.project-heading h1').textContent"), '桌面隔离验收');
  await screenshot('task-1-workflow.png');
  await click('button[aria-label="返回项目列表"]'); await poll(() => evaluate("document.querySelectorAll('.project-card:not(:disabled)').length===1"));
  await screenshot('task-1-projects.png');
  const geometry = await evaluate("({sidebar:document.querySelector('.workspace-sidebar').getBoundingClientRect().width,rail:document.querySelector('.icon-rail').getBoundingClientRect().width,cards:document.querySelectorAll('.project-card').length,background:getComputedStyle(document.querySelector('.projects-page')).backgroundColor})");
  await click('.project-card'); await poll(() => evaluate("!!document.querySelector('.workbench')"));
  await click('nav button', '笔记'); assert.match(await evaluate('document.body.innerText'), /待设计/);
  await click('nav button', '知识库'); assert.match(await evaluate('document.body.innerText'), /待设计/);
  await close(); await launch();
  assert.equal(await evaluate("document.querySelectorAll('.project-card').length"), 1);
  await click('.project-card'); await poll(() => evaluate("!!document.querySelector('.workbench')"));
  assert.equal(await evaluate("document.querySelector('.project-directory').getAttribute('title')"), project);
  const index = JSON.parse(readFileSync(join(fixture, '.runtime/client/projects.json'), 'utf8')); assert.deepEqual(index, [project]);
  assert.equal(existsSync(join(fixture, '.runtime/workbench')), false);
  writeFileSync(safe(join(evidence, 'task-1-electron-result.json')), JSON.stringify({ passed: true, fixture, project, geometry, checks: ['empty list', 'real form create', 'workflow heading', 'card mouse hit test and open', 'notes and knowledge pending', 'restart preserves project root'], nativeModels: false }, null, 2));
  console.log('PASS isolated Electron create/card/workflow/restart; screenshots saved under .runtime/implementation');
} finally { await close(); }
