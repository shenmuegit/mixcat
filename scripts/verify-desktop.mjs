import assert from 'node:assert/strict';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import electron from 'electron';
import { installAccountFixture } from '../tests/electron-account-fixture.mjs';
import { createServer as httpServer } from 'node:http';

const root = resolve('.');
function safe(path) {
  const absolute = resolve(path), part = relative(root, absolute);
  assert.ok(part && !part.startsWith('..') && !isAbsolute(part) && !/^c:/i.test(absolute));
  for (let p = absolute;; p = dirname(p)) { assert.ok(!existsSync(p) || !lstatSync(p).isSymbolicLink(), `Linked path: ${p}`); if (dirname(p) === p) break; }
  return absolute;
}
const evidence = safe(join(root, '.runtime/implementation/mcp-collaboration/task-7/desktop')); mkdirSync(evidence, { recursive: true });
const fixture = mkdtempSync(safe(join(evidence, 'desktop-')));
installAccountFixture(fixture, safe);
const accountScript = safe(join(fixture, 'app-server'));
writeFileSync(accountScript, `import {appendFileSync as recordPid} from 'node:fs';recordPid(${JSON.stringify(join(fixture, 'account-pids.jsonl'))},process.pid+'\\n');\n` + readFileSync(accountScript, 'utf8'));
cpSync(join(root, 'dist/client'), safe(join(fixture, 'dist/client')), { recursive: true });
const project = safe(join(fixture, 'project')); mkdirSync(project);
for (const name of ['tmp', 'appdata', 'localappdata', 'home', 'cache']) mkdirSync(safe(join(fixture, name)));
const env = { ...process.env, MIXCAT_CODEX: process.execPath, MIXCAT_ROOT: fixture, TEMP: join(fixture, 'tmp'), TMP: join(fixture, 'tmp'), APPDATA: join(fixture, 'appdata'), LOCALAPPDATA: join(fixture, 'localappdata'), HOME: join(fixture, 'home'), XDG_CACHE_HOME: join(fixture, 'cache') };
delete env.ELECTRON_RUN_AS_NODE;
let child, socket, hostSocket, debugPort, nextId = 0;
const ownedDesktopPids = [];
const pending = new Map();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function poll(fn) { for (let i = 0; i < 120; i++) { const value = await fn(); if (value) return value; await delay(100); } throw Error('Timed out waiting for desktop state'); }
async function launch() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port; await new Promise(resolve => server.close(resolve));
  debugPort = port;
  const inspector = createServer(); inspector.listen(0, '127.0.0.1'); await once(inspector, 'listening'); const inspectPort=inspector.address().port; await new Promise(resolve=>inspector.close(resolve));
  child = spawn(electron, [`--inspect=${inspectPort}`, join(fixture, 'dist/client/desktop/main.cjs'), `--workbench-root=${fixture}`, `--remote-debugging-port=${port}`], { cwd: fixture, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  ownedDesktopPids.push(child.pid);
  let log = ''; child.stdout.on('data', data => { log += data; }); child.stderr.on('data', data => { log += data; });
  child.once('exit', () => writeFileSync(safe(join(fixture, `electron-${port}.log`)), log));
  const page = await poll(async () => { try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(p => p.type === 'page'); } catch { return null; } });
  socket = new WebSocket(page.webSocketDebuggerUrl); await once(socket, 'open');
  socket.addEventListener('message', event => { const result = JSON.parse(String(event.data)), entry = pending.get(result.id); if (entry) { pending.delete(result.id); result.error ? entry.reject(Error(JSON.stringify(result.error))) : entry.resolve(result.result); } });
  const hostPage = await poll(async()=>{try{return (await(await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json())[0];}catch{return null;}});
  hostSocket = new WebSocket(hostPage.webSocketDebuggerUrl); await once(hostSocket,'open');
  hostSocket.addEventListener('message',event=>{const result=JSON.parse(String(event.data)),entry=pending.get(result.id);if(entry){pending.delete(result.id);result.error?entry.reject(Error(JSON.stringify(result.error))):entry.resolve(result.result);}});
  await poll(() => evaluate("document.querySelector('.page-heading h1')?.textContent"));
  ownedDesktopPids.push(...await host('__testRequire("electron").app.getAppMetrics().map(metric=>metric.pid)'));
}
async function rpc(method, params = {}, target = socket) {
  const id = ++nextId;
  return await new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 10000); pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } }); target.send(JSON.stringify({ id, method, params })); });
}
async function host(expression) {const result=await rpc('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},hostSocket);if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value;}
async function evaluate(expression) { const result = await rpc('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value; }
async function click(selector, text) {
  const point = await poll(() => evaluate(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => ${text ? `e.textContent.includes(${JSON.stringify(text)})` : 'true'}); if (!e || e.disabled) return null; e.scrollIntoView({block:'nearest',inline:'nearest'}); const r=e.getBoundingClientRect(); const x=r.x+r.width/2,y=r.y+r.height/2; if (!(e.closest('.react-flow__edge') ?? e).contains(document.elementFromPoint(x,y))) return null; return {x,y}; })()`));
  await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 }); await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
}
async function fill(selector, value) {
  await click(selector);
  await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
  await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
  await rpc('Input.insertText', { text: value });
  await poll(() => evaluate(`document.querySelector(${JSON.stringify(selector)})?.value===${JSON.stringify(value)}`));
}
async function screenshot(name) { await delay(300); const image = await rpc('Page.captureScreenshot', { format: 'png' }); writeFileSync(safe(join(evidence, name)), Buffer.from(image.data, 'base64')); }
async function close() {
  try { await host('__testRequire("electron").app.quit()'); } catch {}
  try { if (socket?.readyState === 1) await rpc('Browser.close'); } catch {}
  socket?.close();
  hostSocket?.close();
  if (child && child.exitCode === null) { await Promise.race([once(child, 'exit'), delay(5000)]); if (child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); }
  for (const entry of pending.values()) entry.reject(Error('Desktop closed')); pending.clear();
}

// Inspector references are appended only to this disposable copy of the real bundles.
const main = safe(join(fixture, 'dist/client/desktop/main.cjs'));
const mainSource = readFileSync(main, 'utf8');
assert.match(mainSource, /tray\.setContextMenu\(/);
writeFileSync(main, mainSource.replace('tray.setContextMenu(', 'tray.setContextMenu(globalThis.__testTrayMenu=') + '\nglobalThis.__testPanels=()=>panels;globalThis.__testWindow=()=>window;globalThis.__testTray=()=>tray;globalThis.__testRequire=require;\n');
const worker = safe(join(fixture, 'dist/client/core/worker.cjs'));
writeFileSync(worker, readFileSync(worker, 'utf8') + `\nconst testClose=engine.close.bind(engine);engine.close=async()=>{await testClose();while(require('node:fs').existsSync(${JSON.stringify(join(fixture, 'hold-shutdown'))}))await new Promise(r=>setTimeout(r,20));};\n`);
writeFileSync(safe(join(project, 'readme.txt')), 'Integrated project preview — 原始工作文件');
// A native stdio fixture chooses this rehearsal route; production contains no fixed route.
writeFileSync(safe(join(project, 'app-server')), String.raw`
import {createInterface} from 'node:readline';
import {appendFileSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
appendFileSync('native-pids.jsonl',process.pid+'\n');
const write=value=>process.stdout.write(JSON.stringify(value)+'\n');
let next=0;const threads=new Map();
const statePath='fixture-native-state.json';
const state=existsSync(statePath)?JSON.parse(readFileSync(statePath,'utf8')):{round:0,next:0};
const save=()=>{state.next=next;writeFileSync(statePath,JSON.stringify(state));};next=state.next;
const event=(method,threadId,turnId,extra={})=>write({method,params:{threadId,turnId,...extra}});
const finished=(threadId,turnId,status='completed')=>event('turn/completed',threadId,turnId,{turn:{id:turnId,status,items:[]}});
async function tool(threadId,turnId,server,name,args,discard=false){
 const body={jsonrpc:'2.0',id:++next,method:'tools/call',params:{name,arguments:args,_meta:{threadId,callId:'fixture-call-'+next,'x-codex-turn-metadata':{turn_id:turnId}}}};
 const response=await fetch(server.url,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',...server.http_headers},body:JSON.stringify(body)});
 if(discard){await response.body.cancel();appendFileSync('mcp-evidence.jsonl',JSON.stringify({name,args,status:response.status,discarded:true})+'\n');return;}
 const reply=await response.json();appendFileSync('mcp-evidence.jsonl',JSON.stringify({name,args,status:response.status,reply})+'\n');
 if(response.status!==200||reply.error||reply.result?.isError)throw Error(JSON.stringify(reply));return reply;
}
async function handle(m){
 if(m.id===undefined)return;appendFileSync('native-calls.jsonl',JSON.stringify({id:m.id,method:m.method,params:{...m.params,config:undefined}})+'\n');let result={};
 if(m.method==='initialize')result={userAgent:'integrated-fixture; no real model'};
 if(m.method==='account/read')result={account:{email:'isolated fixture'}};
 if(m.method==='model/list')result={data:[{id:'fixture-model',model:'fixture-model',displayName:'Fixture model'}],nextCursor:null};
 if(m.method==='skills/list')result={data:[{cwd:process.cwd(),errors:[],skills:[{name:'Fixture skill',path:process.cwd()+'/SKILL.md',enabled:true}]}]};if(m.method==='plugin/installed')result={marketplaces:[{plugins:[{id:'fixture@local',name:'Fixture plugin',installed:true,enabled:true}]}]};
 if(m.method==='windowsSandbox/readiness')result={status:'configured'};
 if(m.method==='thread/start'||m.method==='thread/resume'){
  const id=m.params.threadId??'thread-'+(++next);threads.set(id,m.params.config.mcp_servers.mixcat);result={thread:{id},model:'fixture-model'};save();
 }
 if(m.method==='thread/items/list')result={data:[],nextCursor:null};
 if(m.method==='turn/interrupt'){write({id:m.id,result});finished(m.params.threadId,m.params.turnId,'interrupted');return;}
 if(m.method==='turn/start'){
  const threadId=m.params.threadId,turnId='turn-'+(++next),text=m.params.input[0].text;save();
  write({id:m.id,result:{turn:{id:turnId}}});event('turn/started',threadId,turnId,{turn:{id:turnId,status:'inProgress'}});
  // Yield until the actual engine has consumed the turn/start RPC response.
  await new Promise(r=>setTimeout(r,120));
  event('item/completed',threadId,turnId,{item:{id:'input-'+turnId,type:'userMessage',content:[{type:'text',text:'native context plus '+text}]}});
  if(existsSync('collaboration-mode')){
   const server=threads.get(threadId),context=(await tool(threadId,turnId,server,'get_project_context',{})).result.structuredContent;
   appendFileSync('collaboration-contexts.jsonl',JSON.stringify({threadId,turnId,context})+'\n');
   const envelope={request_id:'parallel-message',to_node_id:'implement',content:{fixture:'parallel',values:[null,false,0,'',['nested']],text:'  exact\nbody  ',changes:{filename:'report.md'},result:{content:3}},reason:'Direct send without an edge',attachments:[{path:'evidence.txt'}]};
   if(text==='MCP-parallel'){
    await tool(threadId,turnId,server,'send_message',envelope,true);
    const delivery=(await tool(threadId,turnId,server,'get_delivery',{request_id:envelope.request_id})).result.structuredContent;
    const replays=await Promise.all([1,2,3].map(()=>tool(threadId,turnId,server,'send_message',envelope)));
    writeFileSync('parallel-receipt.json',JSON.stringify({receipt:delivery.receipt,replays:replays.map(r=>r.result.structuredContent)}));
    while(!existsSync('release-source'))await new Promise(r=>setTimeout(r,20));
   }else if(text==='MCP-replay'){
    const replay=(await tool(threadId,turnId,server,'send_message',envelope)).result.structuredContent;
    writeFileSync('restarted-receipt.json',JSON.stringify(replay));
   }else if(text==='MCP-retry'||text==='MCP-queued'){
    await tool(threadId,turnId,server,'send_message',{request_id:text,to_node_id:'implement',content:{fixture:text.slice(4),type:'agentMessage',native:{type:'agentMessage',text:'business property'},changes:[null]},reason:'Controlled recovery',attachments:[{path:'evidence.txt'}]});
   }else if(text==='MCP-stop')return;
   else if(text==='MCP-disconnect'){writeFileSync('dispatched-before-disconnect.json',JSON.stringify({threadId,turnId}));process.exit(41);}
   else if(context.incoming_message){
    const incoming=context.incoming_message;
    if(context.task.input?.fixture==='retry'&&!m.params.input.some(item=>item.text?.includes('避免重复外部操作'))){finished(threadId,turnId,'failed');return;}
    if(context.task.input?.fixture==='parallel'||context.task.input?.fixture==='retry'){
     const reply=(await tool(threadId,turnId,server,'send_message',{request_id:'reply-'+context.task.input.fixture,to_node_id:incoming.from.nodeId,reply_to:incoming.message_id,content:false,reason:'Explicit reply',attachments:[{artifact_id:incoming.attachments[0].artifact_id}]})).result.structuredContent;
     writeFileSync(context.task.input.fixture+'-reply.json',JSON.stringify(reply));
    }
   }
   event('item/completed',threadId,turnId,{item:{id:'reply-'+turnId,type:'agentMessage',text:'MCP ordinary output; no automatic broadcast'}});
   finished(threadId,turnId);return;
  }
  if(text.startsWith('暂停恢复正文')||text.startsWith('退出待核对'))return;
  if(text.startsWith('用户已启用')){
   event('item/completed',threadId,turnId,{item:{id:'reply-'+turnId,type:'agentMessage',text:'续接完成，保留已有原文'}});finished(threadId,turnId);return;
  }
  const round=state.round++,route=['implement','review','implement','review'];save();
  const output=['规划自由回复','执行第一版','审查回流：需要修改','执行修改版','审查通过：保留任意内容'][round];
  event('item/agentMessage/delta',threadId,turnId,{itemId:'reply-'+turnId,delta:output});
  event('item/completed',threadId,turnId,{item:{id:'reply-'+turnId,type:'agentMessage',text:output}});
  const result={原始:'完整正文\nsecond line',round,custom:[false,null,{nested:42}]};
  await tool(threadId,turnId,threads.get(threadId),'get_project_context',{});
  if(round<4)await tool(threadId,turnId,threads.get(threadId),'handoff',{to_node_id:route[round],task:'保持自由内容并独立核对',reason:round===2?'审查提出修改':'交给适合的节点',result});
  else await tool(threadId,turnId,threads.get(threadId),'complete_task',{result,blocked:false});
  finished(threadId,turnId);return;
 }
 write({id:m.id,result});
}
createInterface({input:process.stdin}).on('line',line=>{void handle(JSON.parse(line)).catch(error=>{appendFileSync('fixture-errors.log',String(error)+'\n');process.stderr.write(String(error)+'\n');});});
`);
const web = httpServer((_req, res) => { res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'}); res.end('<!doctype html><title>Integrated browser</title><body style="background:#e4eee0;color:#183c2d;font:24px sans-serif"><h1>Integrated browser preview</h1><p>真实 WebContentsView / 本地 HTTP</p></body>'); });
web.listen(0, '127.0.0.1'); await once(web, 'listening');
const url = `http://127.0.0.1:${web.address().port}/`;
const state = () => evaluate("window.mixcat.command({id:crypto.randomUUID(),command:{type:'snapshot'}}).then(r=>r.snapshot.selected)");
const visible = () => host('[...__testPanels().entries.values()].filter(e=>e.view.getVisible()).map(e=>({id:e.panel.id,nodeId:e.panel.nodeId,url:e.view.webContents.getURL(),bounds:e.view.getBounds()}))');
const guest = (id, expression) => host(`__testPanels().entries.get(${JSON.stringify(id)}).view.webContents.executeJavaScript(${JSON.stringify(expression)})`);
async function panelImage(id, name) { await delay(300);const data=await poll(async()=>{try{return await host(`__testPanels().entries.get(${JSON.stringify(id)}).view.webContents.capturePage().then(image=>image.toPNG().toString('base64'))`);}catch{return null;}});writeFileSync(safe(join(evidence,name)),Buffer.from(data,'base64'));ownedDesktopPids.push(...await host('__testRequire("electron").app.getAppMetrics().map(metric=>metric.pid)')); }
async function reopen() { await launch(); await click('.project-card'); await poll(()=>evaluate("!!document.querySelector('.workbench')")); }
async function quit() {
  const owned=child, exited=once(owned,'exit');
  ownedDesktopPids.push(...await host('__testRequire("electron").app.getAppMetrics().map(metric=>metric.pid)'));
  await host('__testTrayMenu.items.find(item=>item.label==="退出 Mixcat").click()');
  socket?.close();hostSocket?.close();
  const result=await Promise.race([exited,delay(10000).then(()=>{throw Error('Explicit quit did not finish');})]);
  assert.equal(result[0],0);socket?.close();hostSocket?.close();
}
const checks = [], lifecycle = [];
const collaborationProject = safe(join(fixture, 'collaboration-project'));
async function collaborationStory() {
  mkdirSync(collaborationProject);
  cpSync(join(project, 'app-server'), safe(join(collaborationProject, 'app-server')));
  writeFileSync(safe(join(collaborationProject, 'collaboration-mode')), 'controlled fixture');
  writeFileSync(safe(join(collaborationProject, 'SKILL.md')), '# Fixture skill\nControlled integration only.');
  writeFileSync(safe(join(collaborationProject, 'evidence.txt')), 'accepted original bytes');
  const command = value => evaluate(`window.mixcat.command({id:crypto.randomUUID(),command:${JSON.stringify(value)}})`);
  await click('nav button', '项目'); await click('button', '新建项目');
  await poll(() => evaluate("!!document.querySelector('dialog[open]')"));
  await fill('dialog input', 'MCP collaboration'); await fill('dialog .input-with-button input', collaborationProject); await fill('dialog textarea', 'Complete freely without a review node');
  await click('dialog .modal-actions button', '创建项目');
  const created = await poll(async () => { const s = await state(); return s.project.root === collaborationProject && s; });
  const projectId = created.project.id;
  const control = value => command({ projectId, ...value });
  for (const node of created.nodes) assert.ok(!['send_message', 'get_delivery', 'read_history'].some(tool => node.tools.includes(tool)));
  await control({ type: 'delete_node', nodeId: 'review' });
  for (const node of (await state()).nodes) await control({ type: 'save_node', node: { ...node, model: 'fixture-model', skills: [{ name: 'Fixture skill', path: collaborationProject.replaceAll('\\', '/') + '/SKILL.md' }], plugins: [{ name: 'Fixture plugin', id: 'fixture@local' }], tools: [...node.tools, 'send_message', 'get_delivery', 'read_history'] } });
  const send = (nodeId, text) => control({ type: 'send_message', nodeId, mode: 'codex', input: [{ type: 'text', text, text_elements: [] }] });
  const json = name => JSON.parse(readFileSync(join(collaborationProject, name), 'utf8'));
  const nativeCalls = () => readFileSync(join(collaborationProject, 'native-calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  await send('plan', 'MCP-parallel');
  await poll(() => existsSync(join(collaborationProject, 'parallel-receipt.json')) && existsSync(join(collaborationProject, 'parallel-reply.json')));
  const { receipt, replays } = json('parallel-receipt.json'), reply = json('parallel-reply.json');
  for (const replay of replays) assert.deepEqual(replay, receipt);
  await poll(async () => (await state()).tasks.find(task => task.id === receipt.target_task_id)?.status === 'completed');
  const busy = await state(), source = busy.tasks.find(task => task.nodeId === 'plan' && !task.incomingMessageId), target = busy.tasks.find(task => task.id === receipt.target_task_id);
  assert.equal(source.status, 'running'); assert.equal(target.status, 'completed');
  assert.equal(source.result, null); assert.deepEqual(target.input, { fixture: 'parallel', values: [null, false, 0, '', ['nested']], text: '  exact\nbody  ', changes: { filename: 'report.md' }, result: { content: 3 } });
  assert.equal(busy.tasks.find(task => task.id === reply.target_task_id).status, 'queued');
  assert.equal(busy.messages.length, 2); assert.equal(busy.edges.length, 0); assert.equal(busy.nodes.length, 2);
  writeFileSync(safe(join(collaborationProject, 'evidence.txt')), 'later source bytes');
  writeFileSync(safe(join(collaborationProject, 'release-source')), 'complete A');
  await poll(async () => (await state()).tasks.every(task => task.status === 'completed'));
  const finished = await state(), replyTask = finished.tasks.find(task => task.id === reply.target_task_id);
  assert.equal(replyTask.threadId, source.threadId); assert.equal(finished.messages.length, 2); assert.equal(finished.handoffs.length, 0);
  let contexts = readFileSync(join(collaborationProject, 'collaboration-contexts.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const received = contexts.find(entry => entry.context.incoming_message?.reply_to === receipt.message_id).context;
  assert.equal(received.task.input, false);
  assert.equal(readFileSync(safe(join(collaborationProject, received.incoming_message.attachments[0].relativePath)), 'utf8'), 'accepted original bytes');
  await poll(() => evaluate("document.querySelectorAll('.conversation-node').length===2 && document.querySelector('.conversation-feed')?.textContent.includes('MCP ordinary output')"));
  await screenshot('collaboration-reply.png');
  checks.push('MCP defaults explicitly granted; no-edge concurrent send, discarded receipt recovery, concurrent replay, busy explicit reply, original Thread, fixed attachment bytes and no review node');
  await send('plan', 'MCP-retry');
  const failed = await poll(async () => (await state()).tasks.find(task => task.nodeId === 'implement' && task.status === 'failed'));
  await control({ type: 'retry_task', taskId: failed.id, confirmed: true });
  await poll(async () => { const s = await state(); return s.tasks.some(task => task.retryOfTaskId === failed.id && task.status === 'completed') && s.tasks.every(task => task.status !== 'running' && task.status !== 'queued'); });
  const retried = await state(), attempt = retried.tasks.find(task => task.retryOfTaskId === failed.id);
  assert.equal(attempt.incomingMessageId, failed.incomingMessageId); assert.equal(attempt.threadId, failed.threadId);
  contexts = readFileSync(join(collaborationProject, 'collaboration-contexts.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const retryContexts = contexts.filter(entry => entry.context.incoming_message?.message_id === failed.incomingMessageId);
  assert.equal(retryContexts.length, 2); assert.deepEqual(retryContexts[1].context.incoming_message, retryContexts[0].context.incoming_message);
  assert.equal(retryContexts[1].context.task.source.nodeId, 'plan');
  checks.push('confirmed receiver retry keeps original message/source/file registration and replies to that original message');
  await control({ type: 'pause_node', nodeId: 'implement' }); await send('plan', 'MCP-queued');
  const queued = await poll(async () => { const s = await state(); return s.tasks.find(task => task.nodeId === 'implement' && task.status === 'queued'); });
  await poll(async () => !(await state()).tasks.some(task => task.status === 'running'));
  const beforeRestart = nativeCalls().filter(call => call.method === 'turn/start').length;
  const queuedInput = (await state()).conversation.find(entry => entry.taskId === queued.id && entry.direction === 'input');
  assert.equal(queuedInput.rawItem, undefined); assert.equal(queuedInput.nativeRole, undefined);
  assert.equal(queuedInput.content.type, 'agentMessage'); assert.equal(queuedInput.content.native.text, 'business property');
  await quit(); await launch(); await click('.project-card', 'MCP collaboration');
  assert.equal((await state()).tasks.find(task => task.id === queued.id).status, 'queued');
  const reopenedInput = (await state()).conversation.find(entry => entry.id === queuedInput.id);
  assert.deepEqual(reopenedInput, queuedInput);
  assert.equal(reopenedInput.threadId, null); assert.equal(reopenedInput.turnId, null); assert.equal(reopenedInput.itemId, null);
  await screenshot('collaboration-opaque-queued.png');
  await delay(250); assert.equal(nativeCalls().filter(call => call.method === 'turn/start').length, beforeRestart);
  await control({ type: 'resume_node', nodeId: 'implement' });
  await poll(async () => (await state()).tasks.find(task => task.id === queued.id).status === 'completed');
  const nativeInput = (await state()).conversation.find(entry => entry.id === queuedInput.id);
  assert.equal(nativeInput.nativeRole, 'user'); assert.equal(nativeInput.rawItem.type, 'userMessage'); assert.deepEqual(nativeInput.content, queuedInput.content);
  assert.equal(nativeCalls().filter(call => call.method === 'turn/start').length, beforeRestart + 1);
  await send('plan', 'MCP-replay'); await poll(() => existsSync(join(collaborationProject, 'restarted-receipt.json')));
  assert.deepEqual(json('restarted-receipt.json'), receipt);
  await poll(async () => !(await state()).tasks.some(task => task.status === 'running'));
  checks.push('queued delivery persists while paused across complete app restart; explicit resume dispatches once; original request receipt replays in a later Thread Turn after restart');
  const requests = nativeCalls();
  assert.ok(requests.filter(call => ['thread/start', 'thread/resume'].includes(call.method)).every(call => resolve(call.params.cwd) === collaborationProject && call.params.model === 'fixture-model'));
  assert.ok(requests.filter(call => call.method === 'turn/start').every(call => call.params.model === 'fixture-model' && call.params.input.some(item => item.type === 'skill' && item.name === 'Fixture skill') && call.params.input.some(item => item.type === 'mention' && item.path === 'plugin://fixture@local')));
  await send('implement', 'MCP-stop'); await poll(async () => (await state()).tasks.at(-1).status === 'running' && !!(await state()).tasks.at(-1).turnId);
  await control({ type: 'stop' }); await poll(async () => (await state()).tasks.at(-1).status === 'cancelled');
  await send('plan', 'MCP-disconnect');
  await poll(async () => (await state()).tasks.at(-1).status === 'needs_reconciliation');
  const dispatched = json('dispatched-before-disconnect.json'), count = nativeCalls().filter(call => call.method === 'turn/start').length;
  await quit(); await launch(); await click('.project-card', 'MCP collaboration');
  const unknown = (await state()).tasks.at(-1);
  assert.equal(unknown.status, 'needs_reconciliation'); assert.equal(unknown.turnId, dispatched.turnId);
  await delay(350); assert.equal(nativeCalls().filter(call => call.method === 'turn/start').length, count);
  assert.equal(existsSync(join(collaborationProject, 'fixture-errors.log')), false);
  await screenshot('collaboration-recovery.png');
  checks.push('selected model/skill/plugin and project cwd survive native requests; stop interrupts; actual stdio disconnect after dispatch and restart never replay unknown work');
  return { project: collaborationProject, receipt, reply, retryTaskId: attempt.id, queuedTaskId: queued.id, unknownTaskId: unknown.id, turnCount: count };
}
try {
  await launch();await click('button','新建项目');await poll(()=>evaluate("!!document.querySelector('dialog[open]')"));
  await fill('dialog input','完整桌面验收');await fill('dialog .input-with-button input',project);await fill('dialog textarea','自由内容、交接回流、退出恢复');
  await click('dialog .modal-actions button','创建项目');await poll(()=>evaluate("document.querySelectorAll('.conversation-node').length===3"));
  await click('#tab-config');await fill('.node-config input','规划验收');await fill('.node-config textarea','保留任意输入，选择适合的协作节点');
  await poll(()=>evaluate("[...document.querySelectorAll('select[aria-label=模型] option')].some(e=>e.value==='fixture-model')"));
  await evaluate("(()=>{const e=document.querySelector('select[aria-label=模型]');e.value='fixture-model';e.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await click('.node-config button','保存配置');await poll(async()=>(await state()).nodes.find(n=>n.id==='plan').model==='fixture-model');
  checks.push('real form create and node configuration');await click('#tab-conversation');
  const raw='自由正文\n任意结构由用户决定';await fill('#task-instruction',raw);await click('.node-composer button','发送');
  await poll(async()=>{const s=await state();return s.tasks.length===5&&s.tasks.every(t=>t.status==='completed');});
  const route=await state();assert.deepEqual(route.tasks.map(t=>t.nodeId),['plan','implement','review','implement','review']);
  assert.equal(route.handoffs.length,4);assert.equal(route.handoffs[2].fromNodeId,'review');assert.equal(route.handoffs[2].toNodeId,'implement');
  assert.equal(route.conversation.find(e=>e.id===`input:${route.tasks[0].id}`).text,raw);
  assert.deepEqual(route.tasks[4].result.custom,[false,null,{nested:42}]);
  assert.equal(route.nodes.filter(n=>n.threadId).length,3);checks.push('five native stdio turns, real MCP HTTP handoff/review return and arbitrary result');
  await screenshot('task-8-workflow.png');
  await click('.conversation-node h3','规划验收');
  await poll(()=>evaluate("document.querySelector('.conversation-feed').textContent.includes('规划自由回复')"));
  const alignment=await evaluate("(()=>{const a=document.querySelector('.chat-input .chat-bubble').getBoundingClientRect(),b=document.querySelector('.chat-output .chat-bubble').getBoundingClientRect();return{inputRight:a.right,outputRight:b.right}})()");
  assert.ok(alignment.inputRight>alignment.outputRight);await screenshot('task-8-node-history.png');
  await click('button','项目会话历史');await poll(()=>evaluate("!!document.querySelector('.project-timeline')"));
  const timeline=await evaluate("document.querySelector('.project-timeline').textContent");assert.match(timeline,/审查回流/);assert.match(timeline,/自由正文/);
  await screenshot('task-8-project-history.png');await click('dialog button[aria-label="关闭弹窗"]');checks.push('original node/project history, source and input-right/output-left pixels');
  await fill('#task-instruction','暂停恢复正文\n重启后保留');await click('.node-composer button','发送');
  await poll(async()=>(await state()).tasks.some(t=>t.nodeId==='plan'&&t.status==='running'&&t.turnId));
  await click('.node-controls button','暂停节点');await poll(async()=>(await state()).tasks.at(-1).status==='paused');
  await host('__testWindow().setSize(1600,1200);__testWindow().show();__testWindow().focus()');await delay(250);
  await click('#tab-panels');
  if (!await evaluate('!!document.querySelector(\'input[aria-label="网页地址"]\')')) await click('.panel-start button', '打开网页');
  await fill('input[aria-label="网页地址"]',url);await click('.browser-address button','打开');
  const browser=await poll(async()=>(await visible()).find(p=>p.url===url));await poll(async()=>/Integrated browser preview/.test(await guest(browser.id,'document.body.textContent')));
  await panelImage(browser.id,'task-8-web.png');
  if (!await evaluate('!!document.querySelector(\'input[aria-label="项目文件路径"]\')')) { await click('button[aria-label="新建面板"]'); await click('.panel-open-types button','项目文件'); }
  await fill('input[aria-label="项目文件路径"]','readme.txt');await click('.browser-address button','预览文件');
  const preview=await poll(async()=>(await visible()).find(p=>p.url.startsWith('mixcat-preview:')));await poll(async()=>/原始工作文件/.test(await guest(preview.id,'document.body.textContent')));
  await panelImage(preview.id,'task-8-file.png');await screenshot('task-8-panel.png');checks.push('actual isolated browser and project file WebContentsViews');
  assert.equal(await host('__testTray().isDestroyed()'),false);await host('__testWindow().close()');
  await poll(()=>host('!__testWindow().isVisible()'));assert.equal(child.exitCode,null);
  lifecycle.push({windowClose:'hidden',trayAlive:await host('!__testTray().isDestroyed()'),workerAlive:await host('__testRequire("electron").app.getAppMetrics().some(m=>m.type==="Utility")')});
  await host('__testTray().emit("double-click")');await poll(()=>host('__testWindow().isVisible()'));
  // Hold an actual worker shutdown acknowledgement to catch reentrant app.quit bypass.
  ownedDesktopPids.push(...await host('__testRequire("electron").app.getAppMetrics().map(metric=>metric.pid)'));
  writeFileSync(safe(join(fixture,'hold-shutdown')),'fixture shutdown latch');
  await host('__testRequire("electron").app.quit()');await host('__testRequire("electron").app.quit()').catch(()=>{});await delay(200);
  const destroyed=await host('__testWindow().isDestroyed()').catch(()=>true);
  assert.equal(destroyed,false,'a second quit must wait for the same shutdown, not destroy its window or inspector context early');
  const {unlinkSync}=await import('node:fs');unlinkSync(safe(join(fixture,'hold-shutdown')));
  socket.close();hostSocket.close();
  await poll(()=>child.exitCode!==null);assert.equal(child.exitCode,0);
  checks.push('real tray hide/show and explicit exit; reentrant quit waits for shutdown');
  await reopen();
  await click('button[aria-label="设置"]');await poll(()=>evaluate("document.querySelector('.login-success')?.textContent==='已登录'"));
  assert.equal(await evaluate("document.querySelectorAll('.settings-actions button').length"),1);
  await screenshot('login-restored-after-restart.png');await click('.sidebar-project-list button, .tab-strip .project-tab');
  checks.push('saved client login restores after worker restart without another login action');
  const paused=await state();assert.equal(paused.tasks.at(-1).status,'paused');assert.equal(paused.nodes.find(n=>n.id==='plan').status,'paused');
  await click('.node-controls button','启用节点');await poll(async()=>(await state()).tasks.at(-1).status==='completed');
  assert.equal((await state()).tasks.length,6);assert.ok((await state()).conversation.some(e=>e.source?.kind==='system'&&e.text.startsWith('用户已启用')));
  checks.push('confirmed pause survives full application restart and explicit continue uses same task/thread');
  await fill('#task-instruction','退出待核对\n不得自动重复');await click('.node-composer button','发送');await poll(async()=>(await state()).tasks.at(-1).status==='running'&&!!(await state()).tasks.at(-1).turnId);
  await quit();await reopen();const recovered=await state();assert.equal(recovered.tasks.at(-1).status,'needs_reconciliation');
  const calls=readFileSync(join(project,'native-calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse),turnCount=calls.filter(c=>c.method==='turn/start').length;
  await delay(350);assert.equal(readFileSync(join(project,'native-calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse).filter(c=>c.method==='turn/start').length,turnCount);
  assert.equal(existsSync(join(project,'fixture-errors.log')),false);checks.push('active exit restarts blocked with no automatic replay');
  await screenshot('task-8-recovery.png');
  const collaboration = await collaborationStory(); await quit();
  const nativePids=[project,collaborationProject].flatMap(directory=>readFileSync(join(directory,'native-pids.jsonl'),'utf8').trim().split('\n').map(Number));
  const accountPids=readFileSync(join(fixture,'account-pids.jsonl'),'utf8').trim().split('\n').map(Number);
  const ownedPids=[...new Set([...ownedDesktopPids,...nativePids,...accountPids])];
  const alive=()=>ownedPids.filter(pid=>{try{process.kill(pid,0);return true;}catch{return false;}});
  await poll(()=>alive().length===0);const remaining=alive();
  assert.deepEqual(remaining,[],'every owned desktop and native fixture process must exit');
  writeFileSync(safe(join(evidence,'result.json')),JSON.stringify({passed:true,fixture,project,checks,lifecycle,alignment,turnCount,collaboration,cleanup:{ownedPids,remaining,computerUseSessionUsed:false},evidenceLevel:{modelTransport:'controlled stdio fixture',mcp:'actual loopback HTTP',desktop:'actual Electron main/preload/utility/renderer/panels; mouse/hit/pixels',tray:'real Electron Tray/window APIs and actual menu callback; OS physical tray pixels not automated',realModel:false}},null,2));
  console.log(`PASS isolated integrated Electron story; ${join(evidence,'result.json')}`);
} catch(error) {try{await screenshot('task-8-failure.png');console.log(JSON.stringify({fixture,body:await evaluate('document.body.innerText'),state:await state()},null,2));}catch{}throw error;}
finally {
  const {unlinkSync}=await import('node:fs');if(existsSync(join(fixture,'hold-shutdown')))unlinkSync(safe(join(fixture,'hold-shutdown')));
  await close();await new Promise(resolve=>web.close(resolve));
}
