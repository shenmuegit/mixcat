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
async function screenshot(name) { await delay(300); const image = await rpc('Page.captureScreenshot', { format: 'png' }); writeFileSync(safe(join(evidence, name)), Buffer.from(image.data, 'base64')); }
async function close() {
  try { if (socket?.readyState === 1) await rpc('Browser.close'); } catch {}
  socket?.close();
  if (child && child.exitCode === null) { await Promise.race([once(child, 'exit'), delay(5000)]); if (child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); }
  for (const entry of pending.values()) entry.reject(Error('Desktop closed')); pending.clear();
}

writeFileSync(safe(join(project,'app-server')), `
import {createInterface} from 'node:readline';
import {existsSync,watch} from 'node:fs';
const write=m=>process.stdout.write(JSON.stringify(m)+'\\n'); const held=[];
watch('.',()=>{if(existsSync('release-send'))while(held.length)write(held.shift());});
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(m.id===undefined)return;let result={};
 if(m.method==='initialize')result={userAgent:'history-fixture'};
 if(m.method==='account/read'){result={account:{email:'fixture'}};if(existsSync('hold-send')&&!existsSync('release-send')){held.push({id:m.id,result});return;}}
 if(m.method==='windowsSandbox/readiness')result={status:'configured'};
 if(m.method==='thread/start')result={thread:{id:'thread'}};
 if(m.method==='thread/items/list')result={data:[],nextCursor:null};
 if(m.method==='turn/start'){
  write({id:m.id,result:{turn:{id:'turn'}}});
  write({method:'item/completed',params:{threadId:'thread',turnId:'turn',item:{id:'user',type:'userMessage',content:[{type:'text',text:'native context plus original'}]}}});
  write({method:'item/completed',params:{threadId:'thread',turnId:'turn',item:{id:'reply',type:'agentMessage',text:'原始回复正文'}}});return;
 }
 write({id:m.id,result});
});
`);
try {
 await launch(); await click('button','新建项目'); await poll(()=>evaluate("!!document.querySelector('dialog[open]')"));
 await fill('dialog input','历史同步验收');await fill('dialog .input-with-button input',project);await fill('dialog textarea','原话与草稿不丢失');
 await click('dialog .modal-actions button','创建项目');await poll(()=>evaluate("!!document.querySelector('#task-instruction')"));
 await click('button[aria-label="设置"]');await evaluate("window.mixcat.command({id:crypto.randomUUID(),command:{type:'connect_account'}})");await poll(()=>evaluate("document.querySelector('.settings-actions button')?.textContent==='已登录'"));await click('.tab-strip .project-tab');
 writeFileSync(safe(join(project,'hold-send')),'hold');
 await fill('#task-instruction','用户原始正文');await click('.node-composer button','发送');
 await fill('#task-instruction','等待期间的新草稿');
 writeFileSync(safe(join(project,'release-send')),'release');
 await poll(()=>evaluate("document.querySelector('.conversation-feed')?.textContent.includes('原始回复正文')"));
 assert.equal(await evaluate("document.querySelector('#task-instruction').value"),'等待期间的新草稿');
 assert.match(await evaluate("document.querySelector('.conversation-feed').textContent"),/用户原始正文/);
 assert.doesNotMatch(await evaluate("document.querySelector('.conversation-feed').textContent"),/native context plus/);
 const geometry=await evaluate("(()=>{const a=document.querySelector('.chat-input .chat-bubble').getBoundingClientRect(),b=document.querySelector('.chat-output .chat-bubble').getBoundingClientRect();return {inputRight:a.right,outputRight:b.right,inputLeft:a.left,outputLeft:b.left}})()");
 assert.ok(geometry.inputRight>geometry.outputRight);
 await screenshot('task-6-node-history.png');
 await click('button','项目会话历史'); await poll(()=>evaluate("!!document.querySelector('.project-timeline')"));
 assert.match(await evaluate("document.querySelector('.project-timeline').textContent"),/用户原始正文/);
 assert.match(await evaluate("document.querySelector('.project-timeline').textContent"),/原始回复正文/);
 await screenshot('task-6-project-history.png');
 await click('dialog button[aria-label="关闭弹窗"]');
 const other=safe(join(fixture,'other'));mkdirSync(other);
 await evaluate(`window.mixcat.command({id:crypto.randomUUID(),command:{type:'create_project',name:'other',root:${JSON.stringify(other)},goal:'other'}})`);
 await delay(250);
 assert.equal(await evaluate("document.querySelector('#task-instruction').value"),'等待期间的新草稿');
 assert.equal(await evaluate("document.querySelector('.project-heading h1').textContent"),'历史同步验收');
 writeFileSync(safe(join(evidence,'task-6-electron-result.json')),JSON.stringify({passed:true,fixture,geometry,checks:['pending send preserves newer draft','raw input preserved','node and project same text','input right output left','unrelated project preserves current draft'],nativeModels:false},null,2));
 console.log('PASS history and draft isolated Electron checks');
}finally{await close();}
