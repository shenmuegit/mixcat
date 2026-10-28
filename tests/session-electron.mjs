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
// The app-server fixture exercises the real worker/stdio path without login or model calls.
writeFileSync(safe(join(project, 'app-server')), `
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const write = value => process.stdout.write(JSON.stringify(value)+'\\n');
let next=0;
createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line); if(m.id===undefined)return;
  appendFileSync('native-calls.jsonl',JSON.stringify(m)+'\\n');
  let result={};
  if(m.method==='initialize') result={userAgent:'session-fixture',codexHome:process.env.CODEX_HOME};
  if(m.method==='account/read') result={account:{email:'isolated fixture'}};
  if(m.method==='model/list') result={data:[{model:'fixture-model',displayName:'Fixture Model'},{model:'alternate-model',displayName:'Alternate Model'}],nextCursor:null};
  if(m.method==='skills/list') result={data:[{skills:[],errors:[]}]};
  if(m.method==='plugin/installed') result={marketplaces:[],marketplaceLoadErrors:[]};
  if(m.method==='windowsSandbox/readiness') result={status:'configured'};
  if(m.method==='thread/start') result={thread:{id:'thread-'+(++next)},model:'fixture-model'};
  if(m.method==='thread/resume') result={thread:{id:m.params.threadId}};
  if(m.method==='thread/items/list') result={data:[],nextCursor:null};
  if(m.method==='turn/start'){
    const turnId='turn-'+(++next);result={turn:{id:turnId}};write({id:m.id,result});
    setTimeout(()=>write({method:'turn/completed',params:{threadId:m.params.threadId,turn:{id:turnId,status:'completed',items:[{id:turnId+'-reply',type:'agentMessage',text:'Fixture free reply'}]}}}),350);
    return;
  }
  write({id:m.id,result});
});
`);
try {
  await launch();
  await click('button', '新建项目'); await poll(() => evaluate("!!document.querySelector('dialog[open]')"));
  await fill('dialog input', '会话隔离验收'); await fill('dialog .input-with-button input', project); await fill('dialog textarea', '节点草稿、目标和自由回复');
  await click('dialog button[type="submit"],dialog .modal-actions button', '创建项目');
  await poll(() => evaluate("document.querySelectorAll('.conversation-node').length===3"));
  await click('button[aria-label="设置"]'); await evaluate("window.mixcat.command({id:crypto.randomUUID(),command:{type:'connect_account'}})"); await poll(() => evaluate("document.querySelector('.settings-actions button')?.textContent==='已登录'")); await click('.sidebar-project-list button');
  await delay(500); await click('.conversation-node h3', '规划'); await fill('#task-instruction', 'plan draft');
  await click('.conversation-node h3', '执行'); assert.equal(await evaluate("document.querySelector('#task-instruction').value"), '');
  await fill('#task-instruction', 'implement draft');
  await click('.conversation-node h3', '规划'); assert.equal(await evaluate("document.querySelector('#task-instruction').value"), 'plan draft');
  await click('.node-composer button', '发送');
  await poll(() => evaluate("[...document.querySelectorAll('.chat-output')].some(e=>e.textContent.includes('Fixture free reply'))"));
  assert.equal(await evaluate("document.querySelector('#task-instruction').value"), '');
  await click('.conversation-node h3', '执行'); assert.equal(await evaluate("document.querySelector('#task-instruction').value"), 'implement draft');
  await click('.node-composer button', '发送');
  await poll(() => evaluate("[...document.querySelectorAll('.chat-output')].some(e=>e.textContent.includes('Fixture free reply'))"));
  const calls=readFileSync(join(project,'native-calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  const turns=calls.filter(c=>c.method==='turn/start');assert.equal(turns.length,2);
  assert.deepEqual(turns.map(c=>c.params.input[0].text),['plan draft','implement draft']);
  assert.notEqual(turns[0].params.threadId,turns[1].params.threadId);
  const alignment=await evaluate("(() => { const i=document.querySelector('.chat-input').getBoundingClientRect(),o=document.querySelector('.chat-output').getBoundingClientRect();return {input:i.x,output:o.x}; })()");
  assert(alignment.input>alignment.output,'input is right of output');
  await screenshot('task-2-session.png');
  await click('#tab-config');
  await poll(() => evaluate("document.querySelector('.node-config select[aria-label=模型]')?.value==='fixture-model'"));
  const snapshot = () => evaluate("window.mixcat.command({id:crypto.randomUUID(),command:{type:'snapshot'}}).then(r=>r.snapshot.selected)");
  assert.equal((await snapshot()).nodes.find(n=>n.id==='implement').model ?? null, null);
  await fill('.node-config textarea[aria-label="职责与指令"]', 'Updated instructions');
  await evaluate("document.querySelector('.node-config .primary').scrollIntoView({block:'center'})");
  await click('.node-config .primary');
  await poll(async () => (await snapshot()).nodes.find(n=>n.id==='implement').model === 'fixture-model');
  await click('.conversation-node h3', '规划'); await click('.conversation-node h3', '执行');
  assert.equal(await evaluate("document.querySelector('.node-config select[aria-label=模型]').value"), 'fixture-model');
  await poll(() => evaluate("[...document.querySelectorAll('.node-config select[aria-label=模型] option')].some(o=>o.value==='alternate-model')"));
  await evaluate("(()=>{const e=document.querySelector('.node-config select[aria-label=模型]');e.value='alternate-model';e.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await evaluate("document.querySelector('.node-config .text-button').scrollIntoView({block:'center'})");
  await click('.node-config .text-button');
  await poll(() => evaluate("!document.querySelector('.node-config .text-button').disabled"));
  assert.equal(await evaluate("document.querySelector('.node-config select[aria-label=模型]').value"), 'alternate-model');
  await evaluate("document.querySelector('.node-config .primary').scrollIntoView({block:'center'})");
  await click('.node-config .primary');
  await poll(async () => (await snapshot()).nodes.find(n=>n.id==='implement').model === 'alternate-model');
  await rpc('Page.reload'); await poll(() => evaluate("!!document.querySelector('.project-card')"));
  await click('.project-card'); await poll(() => evaluate("!!document.querySelector('.conversation-node h3')"));
  await click('.conversation-node h3', '执行'); await click('#tab-config');
  assert.equal(await evaluate("document.querySelector('.node-config select[aria-label=模型]').value"), 'alternate-model');
  await evaluate("document.querySelector('.node-config select[aria-label=模型]').scrollIntoView({block:'center'})");
  await screenshot('session-model-selection.png');
  console.log(JSON.stringify({fixture,turns:turns.length,alignment,modelChecks:['native receipt preselected','save another field persists displayed model','reopen retains selection','refresh retains edited model','reload retains saved explicit model'],result:'PASS'}));
} catch(error) { await screenshot('task-2-session-failure.png'); throw error; } finally { await close(); }
