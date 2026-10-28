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
  const point = await poll(() => evaluate(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => ${text ? `e.textContent.includes(${JSON.stringify(text)})` : 'true'}); if (!e || e.disabled) return null; e.scrollIntoView({block:'nearest',inline:'nearest'}); const r=e.getBoundingClientRect(); const x=r.x+r.width/2,y=r.y+r.height/2; if (!(e.closest('.react-flow__edge') ?? e).contains(document.elementFromPoint(x,y))) return null; return {x,y}; })()`));
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
// Only the held history query gets a short deadline; fixture startup and controls keep their normal budget.
const mainPath = safe(join(fixture, 'dist/client/desktop/main.cjs'));
const mainSource = readFileSync(mainPath, 'utf8');
const timeoutPattern = /timeout = data\.shutdown \? (?:12000|12e3) : (?:90000|9e4)/;
assert(timeoutPattern.test(mainSource), 'production command timeout must be found');
writeFileSync(mainPath, mainSource.replace(timeoutPattern, "timeout = data.shutdown ? 12000 : data.envelope?.command.type === 'read_history' ? 250 : 90000"));
writeFileSync(safe(join(project, 'hold-history')), 'hold');
writeFileSync(safe(join(project, 'app-server')), `
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, watch } from 'node:fs';
const write = value => process.stdout.write(JSON.stringify(value)+'\\n');
let next=0;const history=[],interrupts=[];
const flush=()=>{if(existsSync('release-history'))while(history.length)write(history.shift());if(existsSync('release-interrupt'))while(interrupts.length)write(interrupts.shift());};
watch('.',flush);
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(m.id===undefined)return;
 appendFileSync('native-calls.jsonl',JSON.stringify({...m,params:{...m.params,config:undefined}})+'\\n');let result={};
 if(m.method==='initialize')result={userAgent:'control-fixture'};
 if(m.method==='account/read')result={account:{email:'isolated fixture'}};
 if(m.method==='model/list')result={data:[],nextCursor:null};
 if(m.method==='skills/list')result={data:[]};
 if(m.method==='plugin/installed')result={marketplaces:[]};
 if(m.method==='windowsSandbox/readiness')result={status:'configured'};
 if(m.method==='thread/start')result={thread:{id:'thread-'+(++next)}};
 if(m.method==='thread/resume')result={thread:{id:m.params.threadId}};
 if(m.method==='thread/items/list'){history.push({id:m.id,result:{data:[],nextCursor:null}});flush();return;}
 if(m.method==='turn/start'){
  const turn={id:'turn-'+(++next)};write({id:m.id,result:{turn}});write({method:'turn/started',params:{threadId:m.params.threadId,turn}});return;
 }
 if(m.method==='turn/interrupt'){interrupts.push({method:'turn/completed',params:{threadId:m.params.threadId,turn:{id:m.params.turnId,status:'interrupted',items:[]}}});}
 write({id:m.id,result});flush();
});
`);
const state = () => evaluate("window.mixcat.command({id:crypto.randomUUID(),command:{type:'snapshot'}}).then(reply=>reply.snapshot.selected)");
const calls = () => readFileSync(join(project, 'native-calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
try {
 await launch(); await click('button','新建项目'); await poll(()=>evaluate("!!document.querySelector('dialog[open]')"));
 await fill('dialog input','控制隔离验收');await fill('dialog .input-with-button input',project);await fill('dialog textarea','慢查询时控制可响应与命令核对');
 await click('dialog .modal-actions button','创建项目');await poll(()=>evaluate("!!document.querySelector('#task-instruction')"));
 await fill('#task-instruction','original input once');await click('.node-composer button','发送');
 await poll(async()=>(await state()).nodes[0].status==='running');const original=(await state()).tasks[0];
 await evaluate(`window.controlEnvelope={id:'held-history',command:{type:'read_history',projectId:${JSON.stringify((await state()).project.id)},nodeId:'plan'}};window.controlOutcome=null;window.mixcat.command(window.controlEnvelope).then(()=>window.controlOutcome='succeeded',error=>window.controlOutcome=error.message);`);
 await poll(()=>evaluate("window.mixcat.inspect('held-history').then(r=>r.status==='running')"));
 await click('.project-controls button','全部暂停');await poll(async()=>(await state()).nodes[0].status==='pausing');
 await click('.node-controls button','启用节点');await poll(async()=>(await state()).nodes[0].status==='resuming');
 await click('.node-controls button','暂停节点');await poll(async()=>(await state()).nodes[0].status==='pausing');
 const timeoutError=await poll(()=>evaluate('window.controlOutcome'));
 assert.match(timeoutError,/held-history.*running/);assert.match(timeoutError,/未自动重发/);
 const count=calls().filter(call=>call.method==='thread/items/list').length;
 await evaluate("window.duplicateOutcome=null;window.mixcat.command(window.controlEnvelope).then(()=>window.duplicateOutcome='succeeded',error=>window.duplicateOutcome=error.message)");
 await poll(()=>evaluate('window.duplicateOutcome'));
 assert.equal(calls().filter(call=>call.method==='thread/items/list').length,count,'same-ID transport retry must reuse the pending receipt');
 await screenshot('task-4-controls-held-history.png');
 writeFileSync(safe(join(project,'release-interrupt')),'release');
 await poll(async()=>(await state()).nodes[0].status==='paused');
 writeFileSync(safe(join(project,'release-history')),'release');
 await poll(()=>evaluate("window.mixcat.inspect('held-history').then(r=>r.status==='succeeded')"));
 await click('.project-controls button','全部开启');await poll(async()=>(await state()).nodes[0].status==='running');
 const resumed=(await state()).tasks[0];assert.equal(resumed.id,original.id);assert.equal(resumed.threadId,original.threadId);assert.notEqual(resumed.turnId,original.turnId);
 assert.equal((await state()).nodes[1].status,'idle');
 const starts=calls().filter(call=>call.method==='turn/start');assert.equal(starts.length,2);assert.equal(starts.filter(call=>call.params.input.some(item=>item.text==='original input once')).length,1);
 await click('.project-controls button','停止本轮');await poll(async()=>(await state()).tasks[0].status==='cancelled');
 await screenshot('task-4-stopped.png');
 const stoppedTasks=(await state()).tasks;
 await click('.project-controls button','全部暂停');await poll(async()=>(await state()).nodes.every(node=>node.status==='paused'));
 await click('.project-controls button','全部开启');await poll(async()=>(await state()).nodes.every(node=>node.status==='idle'));
 await click('.node-controls button','暂停节点');await poll(async()=>(await state()).nodes[0].status==='paused');
 await click('.node-controls button','启用节点');await poll(async()=>(await state()).nodes[0].status==='idle');
 assert.equal(await evaluate("!!document.querySelector('.error-banner')"),false);
 assert.deepEqual((await state()).tasks,stoppedTasks);
 assert.equal(calls().filter(call=>call.method==='turn/start').length,starts.length);
 await screenshot('task-4-enabled-after-stop.png');
 writeFileSync(safe(join(evidence,'task-4-electron-result.json')),JSON.stringify({passed:true,fixture,project,timeoutError,historyRequests:count,turnStarts:starts.length,checks:['real renderer/preload/main/utility-worker/native-stdio path','held history remains queryable by original ID','native mouse hit targets respond during busy query','pause-enable-pause final intent','timeout inspects original ID without replay','same-ID duplicate transport does not start native RPC twice','idle node stays idle on bulk resume','same task/thread new turn and original input once','stop cancels running turn','settled stop permits bulk and node enable without replay or remote-command errors'],nativeModels:false},null,2));
 console.log('PASS isolated Electron controls, timeout receipt inspection, duplicate transport and stop');
} catch (error) {
 await screenshot('task-4-failure.png');
 console.error(await evaluate("document.querySelector('.error-banner')?.textContent"));
 throw error;
} finally { await close(); }
