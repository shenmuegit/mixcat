import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import electron from 'electron';
// Real renderer and Electron mouse input; the controlled bridge does not claim native capability activation.
const root = resolve('.');
function safe(path) {
  const absolute = resolve(path), part = relative(root, absolute);
  assert(part && !part.startsWith('..') && !isAbsolute(part) && !/^c:/i.test(absolute));
  for (let p = absolute;; p = dirname(p)) { assert(!existsSync(p) || !lstatSync(p).isSymbolicLink(), `Linked path: ${p}`); if (dirname(p) === p) break; }
  return absolute;
}
const evidence = safe(join(root, '.runtime/implementation/web-product-team-20261022/ui'));
mkdirSync(evidence, { recursive: true });
const fixture = mkdtempSync(safe(join(evidence, 'electron-')));
for (const name of ['tmp', 'appdata', 'localappdata', 'home', 'cache', 'userData', 'sessionData', 'logs', 'crashDumps', 'temp']) mkdirSync(safe(join(fixture, name)));
const preload = safe(join(fixture, 'preload.cjs'));
writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('mixcat',{command:e=>ipcRenderer.invoke('command',e),subscribe:()=>()=>{},panel:async()=>({panels:[],activePanelId:null}),subscribePanels:()=>()=>{},chooseDirectory:async()=>null,chooseAttachments:async()=>[]});
contextBridge.exposeInMainWorld('fixture',{inspect:()=>ipcRenderer.invoke('inspect'),rejectConfiguration:value=>ipcRenderer.invoke('rejectConfiguration',value),fixCapabilities:()=>ipcRenderer.invoke('fixCapabilities'),delayProduct:()=>ipcRenderer.invoke('delayProduct'),holdConfiguration:()=>ipcRenderer.invoke('holdConfiguration'),releaseConfiguration:()=>ipcRenderer.invoke('releaseConfiguration'),show:()=>ipcRenderer.invoke('show'),close:()=>ipcRenderer.send('close')});`);
const main = safe(join(fixture, 'main.cjs'));
writeFileSync(main, `const {app,BrowserWindow,ipcMain}=require('electron');const {join}=require('node:path');
for(const name of ['userData','sessionData','logs','crashDumps','temp'])app.setPath(name,join(${JSON.stringify(fixture)},name));
app.commandLine.appendSwitch('disk-cache-dir',join(${JSON.stringify(fixture)},'cache'));
let snapshot={generation:1,revision:1,projects:[],selected:null,runtime:null,account:null},commands=[],delayProduct=false,holdConfiguration=false,configurationPending,win,rejectConfiguration=false,fixedCapabilities=false;
const catalog=nodeId=>({models:[{id:'actual-model',name:'Actual catalog model',isDefault:true}],skills:[{name:'Skill '+(nodeId??'project'),path:'skill-'+(nodeId??'project')}],plugins:[{id:'fixture@local',name:'Fixture plugin'}],errors:fixedCapabilities?[]:['推荐能力 GitNexus 尚未发现'],mcpServers:[{name:'browser-'+(nodeId??'project'),status:'connected',toolCount:3},{name:'gitnexus',status:'failed',toolCount:0}],hooks:[
{key:'stop',eventName:'Stop',enabled:true,trustStatus:'untrusted',sourcePath:${JSON.stringify(join(fixture, '.mixcat/hooks.json'))},command:'node ./review-hook.cjs',matcher:'*',currentHash:'hook-hash-v1'},
{key:'disabled',eventName:'SessionStart',enabled:false,trustStatus:'untrusted',sourcePath:${JSON.stringify(join(fixture, '.mixcat/hooks.json'))},command:'node ./disabled-hook.cjs',currentHash:'disabled-hash'},
{key:'managed',eventName:'PreToolUse',enabled:true,trustStatus:'managed',sourcePath:${JSON.stringify(join(fixture, '.mixcat/managed.json'))},command:'managed-command',currentHash:'managed-hash'},
{key:'global',eventName:'PostToolUse',enabled:true,trustStatus:'untrusted',sourcePath:'G:/global/hooks.json',command:'global-command',currentHash:'global-hash'}]});
ipcMain.handle('inspect',()=>({snapshot,commands,configurationPending:!!configurationPending}));
ipcMain.handle('delayProduct',()=>{delayProduct=true;});
ipcMain.handle('holdConfiguration',()=>{holdConfiguration=true;});
ipcMain.handle('rejectConfiguration',(_,value)=>{rejectConfiguration=value;});
ipcMain.handle('fixCapabilities',()=>{fixedCapabilities=true;});
ipcMain.handle('releaseConfiguration',()=>{const finish=configurationPending;configurationPending=undefined;holdConfiguration=false;finish();});
ipcMain.handle('command',(_,envelope)=>{const c=envelope.command;commands.push(c);
 if(c.type==='configure_template'&&rejectConfiguration)throw Error('Fixture configuration rejected');
 if(c.type==='create_project'){const project={id:'project-'+commands.length,name:c.name,root:c.root,goal:c.goal,template:c.template,status:'idle',mode:'codex',updatedAt:''};snapshot.projects.push(project);const roles=c.template?['product','requirements','design','frontend','backend','test','architect','design-test']:['plan','implement','review'];const positions=[{x:70,y:80},{x:440,y:80},{x:70,y:380},{x:1270,y:80},{x:900,y:380},{x:1270,y:380},{x:900,y:80},{x:440,y:380}];snapshot.selected={project,nodes:roles.map((id,i)=>({id,name:id,instructions:'Fixture role',model:null,planId:c.template?'mvp-001':undefined,skills:[],plugins:[],tools:[],resultSchema:{},position:c.template?positions[i]:{x:60+i%3*330,y:60+Math.floor(i/3)*260},revision:1,status:'idle',threadId:'thread-'+id})),edges:[],groups:c.template?[{id:'product-definition',name:'产品定义',nodeIds:['product','requirements','design','design-test'],coordinatorNodeId:'product',revision:1}]:[],tasks:[],handoffs:[],activities:[],conversation:[]};}

 if(c.type==='configure_template'&&holdConfiguration)return new Promise(done=>{configurationPending=()=>{snapshot={...snapshot,revision:snapshot.revision+1};done({snapshot,catalog:catalog('stale-project')});};});
 if(c.type==='catalog'&&c.nodeId==='product'&&delayProduct){delayProduct=false;return new Promise(done=>setTimeout(()=>done({snapshot,catalog:catalog('stale-product')}),500));}
 if(c.type==='save_node'){const p=snapshot.selected,index=p.nodes.findIndex(n=>n.id===c.node.id),node={...c.node,revision:(p.nodes[index]?.revision??0)+1,threadId:p.nodes[index]?.threadId??null,status:'idle'};if(index<0)p.nodes.push(node);else p.nodes[index]=node;}
 snapshot={...snapshot,revision:snapshot.revision+1};return {snapshot,...(['catalog','configure_template'].includes(c.type)?{catalog:catalog(c.nodeId)}:{})};
});
ipcMain.on('close',()=>app.exit(0));
ipcMain.handle('show',()=>win.showInactive());
app.whenReady().then(()=>{win=new BrowserWindow({width:1550,height:1050,show:false,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});win.loadFile(${JSON.stringify(join(root, 'dist/client/renderer/index.html'))});});`);
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
async function click(selector, text) {
  const point = await poll(() => evaluate(`(async()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>${text ? `e.textContent.includes(${JSON.stringify(text)})` : 'true'});if(!e||e.disabled)return null;e.scrollIntoView({block:'nearest'});await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return e.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`));
  await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 }); await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
}
async function fill(selector, text) { await click(selector); await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 }); await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 }); await rpc('Input.insertText', { text }); }
async function choose(selector, value) { await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`); }
async function inspect() { return evaluate('window.fixture.inspect()'); }
async function screenshot(name) { await evaluate('window.fixture.show()'); await delay(300); const image = await rpc('Page.captureScreenshot', { format: 'png' }); writeFileSync(safe(join(fixture, name)), Buffer.from(image.data, 'base64')); }
try {
  const page = await poll(async () => { try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(p => p.type === 'page'); } catch { return null; } });
  socket = new WebSocket(page.webSocketDebuggerUrl); await once(socket, 'open');
  socket.addEventListener('message', event => { const result = JSON.parse(String(event.data)), entry = pending.get(result.id); if (entry) { pending.delete(result.id); result.error ? entry.reject(Error(JSON.stringify(result.error))) : entry.resolve(result.result); } });
  await poll(() => evaluate("!!document.querySelector('.projects-page')"));
  await click('button', '新建项目');
  assert.equal(await evaluate('document.querySelector(\'select[aria-label="工作流模板"]\')?.value'), 'basic');
  await fill('dialog input', 'Eight node UI'); await fill('dialog .input-with-button input', fixture); await fill('dialog textarea', 'Core web product');
  await choose('select[aria-label="工作流模板"]', 'web-product'); await screenshot('template-selection.png');
  await evaluate('window.fixture.holdConfiguration()');
  await click('dialog .modal-actions .primary');
  await poll(() => evaluate("document.querySelectorAll('.conversation-node').length===8"));
  await poll(async () => (await inspect()).configurationPending);
  let state = await inspect();
  assert.equal(state.commands.filter(c=>c.type==='create_project').length,1);
  assert.equal(state.commands.find(c=>c.type==='create_project').template,'web-product');
  assert.deepEqual(state.snapshot.selected.groups,[{id:'product-definition',name:'产品定义',nodeIds:['product','requirements','design','design-test'],coordinatorNodeId:'product',revision:1}]);
  assert.equal(state.commands.find(c=>c.type==='configure_template').projectId,state.snapshot.selected.project.id);
  assert.equal(await evaluate("[...document.querySelectorAll('.project-controls button')].some(e=>e.textContent==='配置推荐能力')"),false);
  assert.equal(await evaluate("[...document.querySelectorAll('.project-controls button')].find(e=>e.textContent==='停止本轮').disabled"),true,'automatic configuration must not enable idle Stop');
  await screenshot('automatic-configuration-pending.png');
  await click('#tab-config');
  await poll(() => evaluate("document.querySelector('.node-config')?.textContent.includes('Skill product')"));
  await click('.react-flow__node[data-id="requirements"] h3');
  await poll(() => evaluate("document.querySelector('.node-config')?.textContent.includes('Skill requirements')"));
  await evaluate('window.fixture.releaseConfiguration()');
  await poll(() => evaluate("document.querySelector('.error-banner')?.textContent.includes('节点配置')"));
  await click('.project-view-nav button', 'Issue');
  await poll(() => evaluate("document.querySelector('.project-workspace').dataset.view==='issue'"));
  assert.match(await evaluate("document.querySelector('.error-banner').textContent"), /节点配置/);
  await click('.project-view-nav button', '工作流');
  assert.equal((await inspect()).commands.filter(c=>c.type==='configure_template').length,1);
  assert((await evaluate("document.querySelector('.node-config').textContent")).includes('Skill requirements'),'automatic project reply keeps the current Thread catalog');
  await click('.react-flow__node[data-id="product"] h3');
  await poll(() => evaluate("document.querySelector('.node-config')?.textContent.includes('Skill product')"));
  assert.equal(await evaluate('document.querySelector(\'select[aria-label="模型"]\').value'), '');
  const configText = await evaluate("document.querySelector('.node-config').textContent");
  assert.doesNotMatch(configText, /原生默认|计划 ID|节点使用的技能与插件|MCP 与 hooks 状态|待信任|browser-product/);
  assert.match(configText, /推荐能力 GitNexus 尚未发现/);
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.node-config select[aria-label=模型] option')].filter(o=>!o.disabled).map(o=>o.value)"), ['actual-model']);
  const beforeSave = (await inspect()).commands.filter(c => c.type === 'save_node').length;
  assert.equal(await evaluate("document.querySelector('.node-config .primary')"), null);
  await delay(100);
  assert.equal((await inspect()).commands.filter(c => c.type === 'save_node').length, beforeSave);
  await choose('.node-config select[aria-label="模型"]', 'actual-model');
  await click('.node-config .tool-choice', 'Skill product');
  await click('.node-config .tool-choice', 'Fixture plugin');
  await click('.node-config input[aria-label="get_project_context"]');
  await poll(() => evaluate("!document.querySelector('.draft-indicator')"));
  await poll(async () => { const n = (await inspect()).commands.findLast(c => c.type === 'save_node')?.node; return n?.model === 'actual-model' && n.skills?.length === 1 && n.plugins?.length === 1 && n.tools?.length === 1 && n.tools[0] === 'get_project_context'; });
  const saved = (await inspect()).commands.findLast(c => c.type === 'save_node').node;
  assert.equal(saved.model, 'actual-model'); assert.equal(saved.planId, 'mvp-001');
  assert.deepEqual(saved.skills, [{ name: 'Skill product', path: 'skill-product' }]);
  assert.deepEqual(saved.plugins, [{ id: 'fixture@local', name: 'Fixture plugin' }]);
  assert.deepEqual(saved.tools, ['get_project_context']);
  await fill('.node-config > label > input', 'Renamed product');
  await poll(() => evaluate("!document.querySelector('.draft-indicator')"));
  await poll(async () => (await inspect()).commands.findLast(c => c.type === 'save_node')?.node.name === 'Renamed product');
  const renamed = (await inspect()).commands.findLast(c => c.type === 'save_node').node;
  for (const key of ['planId', 'model', 'skills', 'plugins', 'tools']) assert.deepEqual(renamed[key], saved[key]);
  await fill('.node-config input[aria-label="搜索技能"]', 'unmatched');
  assert.equal(await evaluate("document.querySelectorAll('.node-config fieldset:first-of-type .tool-choice').length"), 0);
  await fill('.node-config input[aria-label="搜索技能"]', '');
  await evaluate("document.querySelector('.node-config').scrollIntoView({block:'start'})");
  await screenshot('simplified-node-config.png');
  await evaluate('window.fixture.delayProduct()'); await click('.node-config .text-button', '刷新可用能力');
  await click('.react-flow__node[data-id="requirements"] h3');
  await poll(() => evaluate("document.querySelector('.node-config')?.textContent.includes('Skill requirements')"));
  await delay(650);
  assert(!(await evaluate("document.querySelector('.node-config').textContent")).includes('Skill stale-product'));
  state = await inspect();
  assert(state.commands.some(c => c.type === 'catalog' && c.nodeId === 'requirements'));
  assert.equal((await inspect()).commands.filter(c => c.type === 'trust_hooks').length, 0, 'discovery never grants trust');
  assert.equal(await evaluate("document.querySelector('.node-config details')"), null);
  await click('button', '添加节点');
  await poll(() => evaluate("!!document.querySelector('dialog[open]')"));
  await fill('dialog input', 'Explicit model node');
  assert.doesNotMatch(await evaluate("document.querySelector('dialog').textContent"), /原生默认|计划 ID|MCP 与 hooks 状态/);
  const beforeCreation = (await inspect()).commands.filter(c => c.type === 'save_node').length;
  await click('dialog .modal-actions .primary'); await delay(100);
  assert.equal((await inspect()).commands.filter(c => c.type === 'save_node').length, beforeCreation);
  await choose('dialog select[aria-label="模型"]', 'actual-model');
  await screenshot('simplified-node-creation.png');
  await click('dialog .modal-actions .primary');
  await poll(async () => (await inspect()).commands.findLast(c => c.type === 'save_node')?.node.name === 'Explicit model node');
  assert.equal((await inspect()).commands.findLast(c => c.type === 'save_node').node.model, 'actual-model');
  assert.equal((await inspect()).commands.findLast(c => c.type === 'save_node').node.planId, undefined);
  // Basic creation omits template and does not attempt recommendation configuration.
  await click('nav button', '项目'); await click('button', '新建项目');
  await fill('dialog input', 'Basic UI'); await fill('dialog .input-with-button input', fixture); await fill('dialog textarea', 'Basic workflow'); await click('dialog .modal-actions .primary');
  await poll(() => evaluate("document.querySelectorAll('.conversation-node').length===3"));
  state = await inspect(); assert.equal(state.commands.filter(c => c.type === 'configure_template').length, 1);
  assert(!('template' in state.commands.filter(c => c.type === 'create_project').at(-1)));
  assert.equal(await evaluate("document.querySelector('.error-banner')"), null, 'another project does not inherit the configuration warning');
  await click('nav button', '项目'); await click('button', '新建项目');
  await fill('dialog input', 'Rejected configuration'); await fill('dialog .input-with-button input', fixture); await fill('dialog textarea', 'Retry configuration');
  await choose('select[aria-label="工作流模板"]', 'web-product'); await evaluate('window.fixture.rejectConfiguration(true)');
  await click('dialog .modal-actions .primary');
  await poll(() => evaluate("document.querySelector('.error-banner')?.textContent.includes('Fixture configuration rejected')"));
  assert.equal(await evaluate("document.querySelectorAll('.conversation-node').length"), 8);
  await click('.project-view-nav button', 'Issue');
  await poll(() => evaluate("document.querySelector('.project-workspace').dataset.view==='issue'"));
  assert.match(await evaluate("document.querySelector('.error-banner').textContent"), /重试配置/);
  await click('.project-view-nav button', '工作流');
  await evaluate('window.fixture.rejectConfiguration(false)'); await evaluate('window.fixture.fixCapabilities()');
  await click('.error-banner button', '重试配置'); await poll(() => evaluate("!document.querySelector('.error-banner')"));
  assert.equal((await inspect()).commands.filter(c => c.type === 'configure_template').length, 3);
  console.log(JSON.stringify({ result: 'PASS', fixture, checks: ['template and basic creation', 'pending configuration and visible discovery errors', 'concrete model required for edit and creation', 'removed plan and MCP/hooks block', 'stored plan and selected capabilities survive save and rename', 'skill filtering', 'refresh and node-specific catalog isolation', 'discovery does not grant trust'] }));
} catch (error) { if (socket?.readyState === 1) try { await screenshot('failure.png'); } catch {} throw error; }
finally {
  try { if (socket?.readyState === 1) await evaluate('window.fixture.close()'); } catch {}
  socket?.close();
  if (child.exitCode === null) { await Promise.race([once(child, 'exit'), delay(5000)]); if (child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); }
  writeFileSync(safe(join(fixture, 'electron.log')), log);
}
