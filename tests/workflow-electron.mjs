import assert from 'node:assert/strict';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import electron from 'electron';
import { installAccountFixture } from './electron-account-fixture.mjs';

const root = resolve('.');
function safe(path) {
  const absolute = resolve(path), part = relative(root, absolute);
  assert.ok(part && !part.startsWith('..') && !isAbsolute(part) && !/^c:/i.test(absolute));
  for (let p = absolute;; p = dirname(p)) { assert.ok(!existsSync(p) || !lstatSync(p).isSymbolicLink(), `Linked path: ${p}`); if (dirname(p) === p) break; }
  return absolute;
}
const evidence = safe(join(root, '.runtime/implementation')); mkdirSync(evidence, { recursive: true });
const fixture = mkdtempSync(safe(join(evidence, 'electron-')));
installAccountFixture(fixture, safe);
cpSync(join(root, 'dist/client'), safe(join(fixture, 'dist/client')), { recursive: true });
const project = safe(join(fixture, 'project')); mkdirSync(project);
for (const name of ['tmp', 'appdata', 'localappdata', 'home', 'cache']) mkdirSync(safe(join(fixture, name)));
const env = { ...process.env, MIXCAT_CODEX: process.execPath, MIXCAT_ROOT: fixture, TEMP: join(fixture, 'tmp'), TMP: join(fixture, 'tmp'), APPDATA: join(fixture, 'appdata'), LOCALAPPDATA: join(fixture, 'localappdata'), HOME: join(fixture, 'home'), XDG_CACHE_HOME: join(fixture, 'cache') };
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
  const point = await poll(() => evaluate(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => ${text ? `e.textContent.includes(${JSON.stringify(text)})` : 'true'}); if (!e) return null; e.scrollIntoView({block:'nearest',inline:'nearest'}); const r=e.getBoundingClientRect(); const x=r.x+r.width/2,y=r.y+r.height/2; if (!(e.closest('.react-flow__edge') ?? e).contains(document.elementFromPoint(x,y))) return null; return {x,y}; })()`));
  await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 }); await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
}
async function fill(selector, value) { await evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); const prototype=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype,'value').set.call(e,${JSON.stringify(value)}); e.dispatchEvent(new Event('input',{bubbles:true})); })()`); }
async function chooseModel() {
  await poll(() => evaluate("[...document.querySelectorAll('dialog select option')].some(e=>e.value==='fixture-model')"));
  await evaluate("(() => {const e=document.querySelector('dialog select');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,'fixture-model');e.dispatchEvent(new Event('change',{bubbles:true}));})()");
}
async function screenshot(name) { await delay(300); const image = await rpc('Page.captureScreenshot', { format: 'png' }); writeFileSync(safe(join(evidence, name)), Buffer.from(image.data, 'base64')); }
async function close() {
  try { if (socket?.readyState === 1) await rpc('Browser.close'); } catch {}
  socket?.close();
  if (child && child.exitCode === null) { await Promise.race([once(child, 'exit'), delay(5000)]); if (child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); }
  for (const entry of pending.values()) entry.reject(Error('Desktop closed')); pending.clear();
}
// The app-server fixture exercises the real worker/stdio path without login or model calls.
writeFileSync(safe(join(project, 'app-server')), `
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const write = value => process.stdout.write(JSON.stringify(value)+'\\n');
let next=0; const session=randomUUID();
createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line); if(m.id===undefined)return;
  appendFileSync('native-calls.jsonl',JSON.stringify(m)+'\\n');
  let result={};
  if(m.method==='initialize') result={userAgent:'session-fixture',codexHome:process.env.CODEX_HOME};
  if(m.method==='account/read') result={account:{email:'isolated fixture'}};
  if(m.method==='model/list') result={data:[{model:'fixture-model',displayName:'Fixture Model'}],nextCursor:null};
  if(m.method==='skills/list') result={data:[{skills:[],errors:[]}]};
  if(m.method==='plugin/installed') result={marketplaces:[],marketplaceLoadErrors:[]};
  if(m.method==='windowsSandbox/readiness') result={status:'configured'};
  if(m.method==='thread/start') result={thread:{id:session+'-thread-'+(++next)}};
  if(m.method==='thread/resume') result={thread:{id:m.params.threadId}};
  if(m.method==='thread/items/list') result={data:[],nextCursor:null};
  if(m.method==='turn/interrupt'){
    write({id:m.id,result});write({method:'turn/completed',params:{threadId:m.params.threadId,turn:{id:m.params.turnId,status:'interrupted',items:[]}}});return;
  }
  if(m.method==='turn/start'){
    const turnId='turn-'+(++next);result={turn:{id:turnId}};write({id:m.id,result});
    setTimeout(()=>write({method:'turn/completed',params:{threadId:m.params.threadId,turn:{id:turnId,status:'completed',items:[{id:turnId+'-reply',type:'agentMessage',text:'Fixture free reply'}]}}}),m.params.input.some(item=>item.text?.includes('hold busy'))?30000:150);
    return;
  }
  write({id:m.id,result});
});
`);
async function context(selector) {
  const point = await poll(() => evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)});const r=e.getBoundingClientRect();const x=r.x+40,y=r.y+40;if(!e.contains(document.elementFromPoint(x,y)))return null;return {x,y}; })()`));
  await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'right', clickCount: 1 });
  await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'right', clickCount: 1 });
  await poll(() => evaluate("!!document.querySelector('[role=menu]')"));
}
async function keyboardMenu(selector) {
  await poll(() => evaluate("!document.querySelector('dialog[open], [role=menu]')"));
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
  await poll(() => evaluate(`(() => {const e=document.querySelector(${JSON.stringify(selector)});e.focus();return document.activeElement===e;})()`));
  await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'F10', code: 'F10', modifiers: 8, windowsVirtualKeyCode: 121 });
  await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F10', code: 'F10', modifiers: 8, windowsVirtualKeyCode: 121 });
  await poll(() => evaluate("!!document.querySelector('[role=menu]')"));
  assert.equal(await evaluate("document.activeElement.getAttribute('role')"), 'menuitem');
}
const state = () => evaluate("window.mixcat.command({id:crypto.randomUUID(),command:{type:'snapshot'}}).then(reply=>reply.snapshot.selected)");
async function dragNode(id, dx, dy) {
  const point = await evaluate(`(() => {const e=document.querySelector('.react-flow__node[data-id="'+${JSON.stringify(id)}+'"]');const r=e.getBoundingClientRect();const x=r.x+30,y=r.y+40;if(!e.contains(document.elementFromPoint(x,y)))throw Error('Drag target covered');return{x,y};})()`);
  await rpc('Input.dispatchMouseEvent', {type:'mouseMoved',...point});
  await rpc('Input.dispatchMouseEvent', {type:'mousePressed',...point,button:'left',buttons:1,clickCount:1});
  for(let i=1;i<=8;i++) await rpc('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x+dx*i/8,y:point.y+dy*i/8,button:'left',buttons:1});
  await rpc('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x+dx,y:point.y+dy,button:'left',clickCount:1});
}
try {
  await launch();
  await click('button', '新建项目'); await poll(() => evaluate("!!document.querySelector('dialog[open]')"));
  await fill('dialog input', '工作流隔离验收'); await fill('dialog .input-with-button input', project);
  await click('dialog .modal-actions button', '创建项目');
  await poll(() => evaluate("document.querySelectorAll('.conversation-node').length===3"));
  await context('.flow-wrap'); await click('[role=menuitem]', '新增节点');
  await poll(() => evaluate("!!document.querySelector('dialog[open]')"));
  await fill('dialog input', 'Canvas node'); await fill('dialog textarea[aria-label="职责与指令"]', 'Canvas responsibility');
  await chooseModel();
  await click('dialog .modal-actions button', '创建节点');
  await poll(() => evaluate("document.querySelectorAll('.conversation-node').length===4"));
  const canvas = (await state()).nodes.find(n => n.name === 'Canvas node');
  assert.equal(canvas.model, 'fixture-model'); assert.equal(canvas.instructions, 'Canvas responsibility');
  await context('.react-flow__node[data-id="plan"]'); await click('[role=menuitem]', '新增关联节点');
  await poll(() => evaluate("!!document.querySelector('dialog[open]')"));
  await fill('dialog input', 'Related node'); await fill('dialog textarea[aria-label="关联条件"]', '成果需要独立审查时');
  await chooseModel();
  await click('dialog .modal-actions button', '创建关联节点');
  await poll(() => evaluate("document.querySelectorAll('.conversation-node').length===5"));
  const associated = (await state()).edges[0];
  const child = (await state()).nodes.find(n=>n.id===associated.targetNodeId);
  assert(child.position.y>160,'associated child starts below occupied default row');
  await click('.react-flow__node[data-id="implement"] h3');
  await click(`.react-flow__node[data-id="${child.id}"] h3`);
  await click('.condition-label', '条件 · 成果需要独立审查时');
  await poll(() => evaluate("!!document.querySelector('dialog[open]')"));
  await fill('dialog textarea[aria-label="条件"]', '自然语言条件已编辑'); await click('dialog button', '保存条件');
  await poll(async () => (await state()).edges[0].condition === '自然语言条件已编辑');
  await keyboardMenu('.flow-wrap'); assert.equal(await evaluate("document.activeElement.textContent"), '新增节点');
  await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await keyboardMenu('.react-flow__node[data-id="plan"]'); assert.equal(await evaluate("document.activeElement.textContent"), '新增关联节点');
  await click('[role=menuitem]', '新增关联节点'); await poll(() => evaluate("!!document.querySelector('dialog[open]')"));
  await fill('dialog input', 'Keyboard related'); await chooseModel(); await click('dialog .modal-actions button', '创建关联节点');
  await poll(() => evaluate("document.querySelectorAll('.conversation-node').length===6"));
  const canvasPoint = await evaluate("(() => {const r=document.querySelector('.flow-wrap').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()");
  const nodeWidth = await evaluate("document.querySelector('.conversation-node').getBoundingClientRect().width");
  await rpc('Input.dispatchMouseEvent', { type: 'mouseWheel', ...canvasPoint, deltaX: 0, deltaY: 360 });
  await poll(() => evaluate("document.querySelector('.conversation-node').getBoundingClientRect().width<" + nodeWidth));
  const keyboard = (await state()).nodes.find(n => n.name === 'Keyboard related');
  const plan = (await state()).nodes.find(n => n.id === 'plan');
  assert.equal(keyboard.position.x, plan.position.x + 300); assert(keyboard.position.y>child.position.y);
  await click('.react-flow__node[data-id="plan"] h3'); await fill('#task-instruction', 'hold busy node for layout check'); await click('.node-composer button', '发送');
  await poll(async () => (await state()).nodes.find(n => n.id === 'plan').status === 'running');
  assert.equal(await evaluate("[...document.querySelectorAll('.project-controls button')].find(e=>e.textContent==='重置工作流').disabled"), true);
  await click('[role=tab]', '配置');
  assert.equal(await evaluate("document.querySelector('.node-config').textContent.includes('后自动保存配置')"), true);
  const before = (await state()).nodes.find(n => n.id === 'plan');
  await dragNode('plan', -20, 30);
  await poll(async () => (await state()).nodes.find(n => n.id === 'plan').position.x !== before.position.x);
  const moved = (await state()).nodes.find(n => n.id === 'plan');
  assert.equal(moved.revision,before.revision); assert.equal(moved.threadId,before.threadId); assert.equal(moved.status,'running');
  const geometry = await evaluate("(() => {const c=document.querySelector('.flow-wrap').getBoundingClientRect(),d=document.querySelector('.detail-panel').getBoundingClientRect(),n=document.querySelector('.conversation-node').getBoundingClientRect();return{canvas:{x:c.x,y:c.y,width:c.width,height:c.height},details:{x:d.x,y:d.y,width:d.width,height:d.height},node:{width:n.width,height:n.height},bodyFont:getComputedStyle(document.querySelector('.conversation-node p')).fontFamily};})()");
  assert(geometry.canvas.width>250 && geometry.details.width>=300 && geometry.canvas.x+geometry.canvas.width<=geometry.details.x+1);
  await screenshot('task-3-workflow.png');
  await rpc('Page.reload'); await poll(() => evaluate("!!document.querySelector('.project-card')")); await click('.project-card');
  await poll(() => evaluate("document.querySelectorAll('.conversation-node').length===6"));
  assert.deepEqual((await state()).nodes.find(n=>n.id==='plan').position,moved.position);
  await click('.condition-label', '条件 · 自然语言条件已编辑'); await poll(() => evaluate("!!document.querySelector('dialog[open]')"));
  await click('dialog button','移除关联'); await poll(async () => !(await state()).edges.some(e=>e.id===associated.id));
  await click('.project-controls button', '停止本轮');
  await poll(async () => (await state()).tasks.every(task=>['completed','failed','cancelled'].includes(task.status)));
  await close(); await launch(); await click('.project-card'); await poll(() => evaluate("document.querySelectorAll('.conversation-node').length===6"));
  const restored = await state();
  assert.deepEqual(restored.nodes.find(n=>n.id==='plan').position,moved.position); assert(!restored.edges.some(e=>e.id===associated.id)); assert(restored.edges.some(e=>e.targetNodeId===keyboard.id));
  await screenshot('task-3-restarted.png');
  await click('.react-flow__node[data-id="plan"] h3');
  await fill('#task-instruction', 'draft to clear after reset');
  await click('.project-controls button', '重置工作流');
  await poll(() => evaluate("!!document.querySelector('dialog[open][aria-label=\"重置工作流\"]')"));
  await screenshot('issue-105-reset-confirm.png');
  await click('dialog button', '取消');
  assert.deepEqual((await state()).tasks,restored.tasks);
  assert.deepEqual((await state()).conversation,restored.conversation);
  assert.equal(await evaluate("document.querySelector('#task-instruction').value"),'draft to clear after reset');
  await click('.project-controls button', '重置工作流');
  await click('dialog button', '确认重置');
  await poll(async () => !(await state()).tasks.length);
  await poll(() => evaluate("!document.querySelector('dialog[open]') && document.querySelector('#task-instruction').value==='' && document.querySelectorAll('.chat-entry').length===0"));
  const cleared=await state(), definitions=nodes=>nodes.map(({threadId,status,...node})=>node);
  assert.deepEqual(definitions(cleared.nodes),definitions(restored.nodes));
  assert.deepEqual(cleared.edges,restored.edges); assert.deepEqual(cleared.groups,restored.groups); assert.deepEqual(cleared.edgeLayouts,restored.edgeLayouts);
  assert(cleared.nodes.every(node=>node.threadId===null && node.status==='idle'));
  for(const key of ['conversation','tasks','messages','handoffs','humanReviews']) assert.deepEqual(cleared[key],[],key+' clears');
  await click('.project-controls button', '项目会话历史');
  await poll(() => evaluate("!!document.querySelector('dialog[open][aria-label=\"项目会话历史\"]')"));
  assert.equal(await evaluate("document.querySelectorAll('dialog .chat-entry').length"),0);
  await click('dialog [aria-label="关闭弹窗"]');
  await screenshot('issue-105-reset-empty.png');
  await close(); await launch(); await click('.project-card');
  await poll(() => evaluate("document.querySelectorAll('.conversation-node').length===6"));
  const afterResetRestart=await state();
  assert.deepEqual(afterResetRestart.tasks,[]); assert.deepEqual(afterResetRestart.conversation,[]);
  assert(afterResetRestart.nodes.every(node=>node.threadId===null && node.status==='idle'));
  const callCount=readFileSync(join(project,'native-calls.jsonl'),'utf8').trim().split('\n').length;
  await click('.react-flow__node[data-id="plan"] h3'); await fill('#task-instruction', 'fresh workflow session'); await click('.node-composer button', '发送');
  await poll(async () => (await state()).tasks[0]?.status==='completed');
  const fresh=await state(), freshThread=fresh.nodes.find(node=>node.id==='plan').threadId;
  assert(freshThread && freshThread!==restored.nodes.find(node=>node.id==='plan').threadId);
  const newCalls=readFileSync(join(project,'native-calls.jsonl'),'utf8').trim().split('\n').slice(callCount).map(line=>JSON.parse(line));
  assert.equal(newCalls.filter(call=>call.method==='thread/start').length,1);
  assert.equal(newCalls.filter(call=>call.method==='thread/resume').length,0);
  assert.equal(fresh.conversation.some(entry=>entry.text.includes('hold busy node')),false);
  writeFileSync(safe(join(evidence,'task-3-electron-result.json')),JSON.stringify({passed:true,fixture,project,geometry,nodes:restored.nodes.length,checks:['canvas right click create with real model/instructions','node right click creates associated edge','condition edit/delete mouse hit targets','canvas/node Shift+F10 menu and focus','keyboard associated placement matches mouse','running node mouse drag preserves revision/thread','busy config save disabled','renderer reload preserves layout','full restart preserves layout and edge deletion','busy reset disabled','reset cancellation preserves history and draft','confirmed reset clears history/thread bindings/draft and retains graph','project history stays empty','reset survives full restart','next message starts fresh native thread'],nativeModels:false},null,2));
  console.log('PASS isolated workflow Electron interaction/reload/restart');
} catch(error) {
  console.log(JSON.stringify(await evaluate("[...document.querySelectorAll('.react-flow__edge-text')].map(e=>{const r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return{text:e.textContent,rect:{x:r.x,y:r.y,width:r.width,height:r.height},pointer:getComputedStyle(e).pointerEvents,hit:hit?.outerHTML.slice(0,350),parent:e.parentElement?.outerHTML.slice(0,200)}})")));
  await screenshot('task-3-failure.png'); throw error;
} finally { await close(); }
