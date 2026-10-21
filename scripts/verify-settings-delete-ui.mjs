import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import electron from 'electron';

// Real renderer and Electron input with a controlled desktop bridge; core behavior has separate tests.
const root = resolve('.');
function safe(path) {
  const absolute = resolve(path), part = relative(root, absolute);
  assert(part && !part.startsWith('..') && !isAbsolute(part) && !/^c:/i.test(absolute));
  for (let p = absolute;; p = dirname(p)) { assert(!existsSync(p) || !lstatSync(p).isSymbolicLink(), `Linked path: ${p}`); if (dirname(p) === p) break; }
  return absolute;
}
const evidence = safe(join(root, '.runtime/implementation'));
mkdirSync(evidence, { recursive: true });
const fixture = mkdtempSync(safe(join(evidence, 'settings-delete-ui-')));
for (const name of ['tmp', 'appdata', 'localappdata', 'home', 'cache', 'userData', 'sessionData', 'logs', 'crashDumps', 'temp']) mkdirSync(safe(join(fixture, name)));
const initial = { generation: 1, revision: 1, projects: [], selected: null, runtime: null, account: null };
const preload = safe(join(fixture, 'preload.cjs'));
writeFileSync(preload, `const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('mixcat', {
 command: envelope => ipcRenderer.invoke('command', envelope),
 subscribe: listener => { const handler = (_, update) => listener(update); ipcRenderer.on('update', handler); return () => ipcRenderer.removeListener('update', handler); },
 panel: command => ipcRenderer.invoke('panel', command), subscribePanels: () => () => {}, chooseAttachments: async () => [], chooseDirectory: async () => null
});
contextBridge.exposeInMainWorld('fixture', { set: snapshot => ipcRenderer.invoke('set', snapshot), inspect: () => ipcRenderer.invoke('inspect'), show: () => ipcRenderer.invoke('show'), close: () => ipcRenderer.send('close') });`);
const main = safe(join(fixture, 'main.cjs'));
writeFileSync(main, `const {app,BrowserWindow,ipcMain}=require('electron');const {join}=require('node:path');
for(const name of ['userData','sessionData','logs','crashDumps','temp'])app.setPath(name,join(${JSON.stringify(fixture)},name));
app.commandLine.appendSwitch('disk-cache-dir',join(${JSON.stringify(fixture)},'cache'));
let snapshot=${JSON.stringify(initial)},commands=[],panels=[],win;
ipcMain.handle('set',(_,value)=>{snapshot={...value,generation:1,revision:snapshot.revision+1};win.webContents.send('update',{kind:'full',snapshot});});
ipcMain.handle('inspect',()=>({snapshot,commands,panels}));
ipcMain.handle('show',()=>{win.showInactive();win.showInactive();});
ipcMain.handle('command',(_,envelope)=>{const c=envelope.command;commands.push(c);
 if(c.type==='connect_account')snapshot.account={connected:true,authenticated:false,accountLabel:null,error:null,mode:'codex'};
 if(c.type==='login')snapshot.account={connected:true,authenticated:false,accountLabel:null,error:null,mode:'codex'};
 if(c.type==='delete_node'){const p=snapshot.selected;const node=p.nodes.find(n=>n.id===c.nodeId);p.nodes=p.nodes.filter(n=>n.id!==c.nodeId);p.archivedNodes=[...(p.archivedNodes??[]),node];p.edges=(p.edges??[]).filter(e=>e.sourceNodeId!==c.nodeId&&e.targetNodeId!==c.nodeId);}
 snapshot={...snapshot,revision:snapshot.revision+1};return {snapshot};
});
ipcMain.handle('panel',(_,c)=>{panels.push(c);return {projectId:c.projectId,nodeId:c.nodeId,revision:1,generation:1,panels:[],activePanelId:null};});
ipcMain.on('close',()=>app.exit(0));
app.whenReady().then(()=>{win=new BrowserWindow({width:1500,height:980,show:false,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});win.loadFile(${JSON.stringify(join(root, 'dist/client/renderer/index.html'))});});`);
const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port; await new Promise(done => server.close(done));
const env = { ...process.env, TEMP: join(fixture, 'tmp'), TMP: join(fixture, 'tmp'), APPDATA: join(fixture, 'appdata'), LOCALAPPDATA: join(fixture, 'localappdata'), HOME: join(fixture, 'home'), XDG_CACHE_HOME: join(fixture, 'cache') };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [main, `--remote-debugging-port=${port}`], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '', socket, next = 0; const pending = new Map();
child.stdout.on('data', data => log += data); child.stderr.on('data', data => log += data);
const delay = ms => new Promise(done => setTimeout(done, ms));
async function poll(fn) { for (let i = 0; i < 100; i++) { const value = await fn(); if (value) return value; await delay(100); } throw Error('Timed out waiting for renderer'); }
async function rpc(method, params = {}) { const id = ++next; return new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 10000); pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } }); socket.send(JSON.stringify({ id, method, params })); }); }
async function evaluate(expression) { const result = await rpc('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value; }
async function click(selector, text, button = 'left') {
  const point = await poll(() => evaluate(`(async () => { const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>${text ? `e.textContent.includes(${JSON.stringify(text)})` : 'true'});if(!e||e.disabled)return null;e.scrollIntoView({block:'nearest'});const before=e.getBoundingClientRect();await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);if(!e.isConnected)return null;const r=e.getBoundingClientRect();if(['x','y','width','height'].some(key=>Math.abs(r[key]-before[key])>.5))return null;const x=r.x+r.width/2,y=r.y+r.height/2;return e.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`));
  await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button, clickCount: 1 }); await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button, clickCount: 1 });
}
async function inspect() { return evaluate('window.fixture.inspect()'); }
async function screenshot(name) { await evaluate('window.fixture.show()'); await delay(300); const image = await rpc('Page.captureScreenshot', { format: 'png' }); writeFileSync(safe(join(fixture, name)), Buffer.from(image.data, 'base64')); }
const node = id => ({ id, name: id === 'one' ? 'First' : 'Second', instructions: '', tools: [], resultSchema: {}, position: { x: id === 'one' ? 80 : 420, y: 100 }, revision: 1, threadId: `thread-${id}`, status: 'idle' });
const project = { id: 'p', name: 'Preserved Project', root: fixture, goal: 'Renderer fixture', status: 'idle', mode: 'codex', updatedAt: '' };
const entry = { id: 'old-input', seq: 1, nodeId: 'one', taskId: null, threadId: 'thread-one', turnId: null, itemId: null, direction: 'input', source: { kind: 'user' }, text: 'Saved historical message', content: [{ type: 'mention', path: join(fixture, 'retained.txt') }], createdAt: '' };
try {
  const page = await poll(async () => { if (child.exitCode !== null) throw Error(`Electron exited (${child.exitCode}): ${log}`); try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(p => p.type === 'page'); } catch { return null; } });
  socket = new WebSocket(page.webSocketDebuggerUrl); await once(socket, 'open');
  socket.addEventListener('message', event => { const value = JSON.parse(String(event.data)), entry = pending.get(value.id); if (entry) { pending.delete(value.id); value.error ? entry.reject(Error(JSON.stringify(value.error))) : entry.resolve(value.result); } });
  await poll(() => evaluate("document.querySelector('.page-heading h1')?.textContent"));
  const settingsPosition = await evaluate("(()=>{const rail=document.querySelector('.icon-rail').getBoundingClientRect(),button=document.querySelector('.rail-settings').getBoundingClientRect();return {inside:button.left>=rail.left&&button.right<=rail.right,bottomGap:rail.bottom-button.bottom,inLowerHalf:button.top>rail.top+rail.height/2,duplicate:!!document.querySelector('.workspace-sidebar [aria-label=\"设置\"]')}})()");
  assert(settingsPosition.inside && settingsPosition.inLowerHalf && settingsPosition.bottomGap >= 8 && settingsPosition.bottomGap <= 24 && !settingsPosition.duplicate);
  await click('button[aria-label="设置"]');
  assert.equal(await evaluate("document.querySelector('.rail-settings').getAttribute('aria-current')"), 'page');
  assert.equal(await evaluate("document.querySelectorAll('.settings-actions button').length"), 1);
  assert.equal(await evaluate("document.querySelectorAll('.account-settings dl,.account-settings>.muted').length"), 0);
  await screenshot('login.png');
  await click('button', '登录 Codex');
  await poll(async () => (await inspect()).commands.some(command => command.type === 'login'));
  assert.equal(await evaluate("document.querySelector('.settings-actions button').textContent"), '登录 Codex');
  const waiting = await inspect();
  await evaluate(`window.fixture.set(${JSON.stringify({ ...waiting.snapshot, account: { ...waiting.snapshot.account, authenticated: true, accountLabel: 'shared@example.test' } })})`);
  await poll(() => evaluate("document.querySelector('.login-success')?.textContent==='已登录'&&document.querySelector('.login-success').disabled"));
  assert.equal(await evaluate("!!document.querySelector('.login-success svg')&&getComputedStyle(document.querySelector('.login-success')).opacity==='1'"), true);
  await screenshot('logged-in.png');
  await rpc('Page.reload'); await poll(() => evaluate("!!document.querySelector('.rail-settings')")); await click('button[aria-label="设置"]');
  await poll(() => evaluate("document.querySelector('.login-success')?.textContent==='已登录'"));
  let state = await inspect();
  assert.deepEqual(state.commands.filter(c => ['connect_account', 'login'].includes(c.type)), [{ type: 'login' }]);
  const snapshot = { ...state.snapshot, projects: [project], selected: { project, nodes: [node('one'), node('two')], tasks: [], handoffs: [], activities: [], conversation: [entry], edges: [{ id: 'edge', sourceNodeId: 'one', targetNodeId: 'two', condition: '' }] }, runtime: state.snapshot.account };
  await evaluate(`window.fixture.set(${JSON.stringify(snapshot)})`);
  await click('nav button', '项目');
  assert.equal(await evaluate("document.querySelector('.project-card-bottom').textContent"), '进入工作流 →');
  assert.equal(await evaluate("document.querySelectorAll('.sidebar-space').length"), 0);
  assert.equal(await evaluate("document.querySelector('.workspace-status').textContent"), 'Mixcat · 本地工作空间');
  assert.equal(await evaluate("(()=>{const box=document.querySelector('.project-card-bottom').getBoundingClientRect(),link=document.querySelector('.project-card-bottom span').getBoundingClientRect();return Math.abs(box.right-link.right)<=1})()"), true);
  await screenshot('projects.png');
  await click('.project-card', 'Preserved Project');
  await poll(() => evaluate("document.querySelectorAll('.react-flow__node').length===2"));
  assert.equal(await evaluate("!![...document.querySelectorAll('.detail-panel button')].find(e=>e.textContent==='登录')"), false);
  assert.equal(await evaluate("document.querySelectorAll('.runtime-box,.resume-summary,.canvas-caption,.node-directory,.mode-select,.detail-heading>.eyebrow').length"), 0);
  assert.equal(await evaluate("document.querySelectorAll('.node-controls button').length"), 3);
  assert.equal(await evaluate("!!document.querySelector('#task-instruction')"), true);
  assert.equal(await evaluate("document.querySelectorAll('.session-workbench>.execution-overview,.canvas-heading,.react-flow__background').length"), 0);
  assert.equal(await evaluate("document.querySelector('.project-statusbar .workflow-summary').textContent"), 'WORKFLOW · 2 个会话');
  async function headerLayout() {
    return evaluate("(()=>{const header=document.querySelector('.project-header').getBoundingClientRect();const boxes=['.project-heading','.project-statusbar','.project-controls'].map(selector=>{const r=document.querySelector(selector).getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}});return {contained:boxes.every(r=>r.left>=header.left&&r.right<=header.right&&r.top>=header.top&&r.bottom<=header.bottom),separated:boxes[0].right<=boxes[1].left&&boxes[1].right<=boxes[2].left,white:['.session-workbench','.canvas-column','.flow-wrap','.react-flow','.session-detail','.activity-strip','.node-composer>textarea'].every(selector=>getComputedStyle(document.querySelector(selector)).backgroundColor==='rgb(255, 255, 255)')}})()");
  }
  assert.deepEqual(await headerLayout(), { contained: true, separated: true, white: true });
  await click('.project-statusbar button', '添加节点');
  assert.match(await evaluate("document.querySelector('dialog[open]').getAttribute('aria-label')"), /新增节点/);
  await click('dialog button[aria-label="关闭弹窗"]');
  await screenshot('workflow.png');
  const originalWidth = await evaluate('innerWidth');
  await rpc('Emulation.setDeviceMetricsOverride', { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false });
  await poll(() => evaluate('innerWidth===1100'));
  assert.deepEqual(await headerLayout(), { contained: true, separated: true, white: true });
  await screenshot('workflow-compact.png');
  await rpc('Emulation.clearDeviceMetricsOverride');
  await poll(() => evaluate(`innerWidth===${originalWidth}`));
  await click('button[aria-label="设置"]'); await click('.tab-strip button', 'Preserved Project');
  await poll(() => evaluate("document.querySelector('.project-heading h1')?.textContent==='Preserved Project'"));
  await click('.react-flow__node[data-id="one"]', null, 'right'); await click('[role="menuitem"]', '删除节点');
  assert.match(await evaluate("document.querySelector('dialog').textContent"), /历史.*项目文件.*保留/);
  await click('dialog button', '取消'); assert.equal((await inspect()).snapshot.selected.nodes.length, 2);
  await click('.node-controls button', '删除节点'); await click('dialog button', '确认删除');
  await poll(() => evaluate("document.querySelectorAll('.react-flow__node').length===1"));
  assert.equal((await inspect()).snapshot.selected.edges.length, 0);
  await click('.project-controls button', '项目会话历史');
  await poll(() => evaluate("document.querySelector('dialog')?.textContent.includes('First（已移除）')"));
  assert.match(await evaluate("document.querySelector('dialog').textContent"), /Saved historical message/);
  assert((await inspect()).commands.some(c => c.type === 'read_history' && c.nodeId === 'one'));
  await click('dialog .resource-actions button', '打开附件');
  await poll(async () => (await inspect()).panels.some(p => p.type === 'open' && p.nodeId === 'two'));
  state = await inspect();
  await evaluate(`window.fixture.set(${JSON.stringify({ ...state.snapshot, selected: { ...state.snapshot.selected, tasks: [{ id: 'pending', nodeId: 'two', status: 'needs_reconciliation', instruction: 'Check old work' }] } })})`);
  await poll(() => evaluate("[...document.querySelectorAll('.node-controls button')].find(e=>e.textContent==='删除节点')?.disabled"));
  state = await inspect();
  await evaluate(`window.fixture.set(${JSON.stringify({ ...state.snapshot, selected: { ...state.snapshot.selected, nodes: [], tasks: [], archivedNodes: [node('one'), node('two')] } })})`);
  await click('.project-controls button', '项目会话历史'); await click('dialog .resource-actions button', '打开附件');
  await poll(() => evaluate("document.querySelector('[role=alert]')?.textContent.includes('先添加一个会话节点')"));
  await click('dialog button[aria-label="关闭弹窗"]'); await click('button[aria-label="关闭错误提示"]'); await click('button[aria-label="设置"]');
  assert.equal((await inspect()).snapshot.account.accountLabel, 'shared@example.test');
  assert.equal(await evaluate("document.querySelector('.settings-actions button').textContent"), '已登录');
  await screenshot('settings.png');
  writeFileSync(safe(join(fixture, 'result.json')), JSON.stringify({ passed: true, checks: ['settings without projects', 'global account commands', 'project selection retained', 'node context deletion and cancel', 'archived history and resource targeting', 'unfinished deletion blocked', 'zero nodes with history', 'shared account persists', 'annotated metadata and hints removed', 'project card action stays right aligned', 'node controls and message input retained'], scope: 'Actual Electron renderer, preload, DOM and mouse hit testing with controlled IPC boundary; core and real Codex login are separate verification.' }, null, 2));
  console.log(JSON.stringify({ passed: true, evidence: fixture }));
} finally {
  try { if (socket?.readyState === 1) await evaluate('window.fixture.close()'); } catch {}
  socket?.close();
  if (child.exitCode === null) { await Promise.race([once(child, 'exit'), delay(3000)]); if (child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); }
  for (const entry of pending.values()) entry.reject(Error('Fixture closed')); pending.clear();
  writeFileSync(safe(join(fixture, 'electron.log')), log);
}
