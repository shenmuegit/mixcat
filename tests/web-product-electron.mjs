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
contextBridge.exposeInMainWorld('fixture',{inspect:()=>ipcRenderer.invoke('inspect'),delayProduct:()=>ipcRenderer.invoke('delayProduct'),holdConfiguration:()=>ipcRenderer.invoke('holdConfiguration'),releaseConfiguration:()=>ipcRenderer.invoke('releaseConfiguration'),show:()=>ipcRenderer.invoke('show'),close:()=>ipcRenderer.send('close')});`);
const main = safe(join(fixture, 'main.cjs'));
writeFileSync(main, `const {app,BrowserWindow,ipcMain}=require('electron');const {join}=require('node:path');
for(const name of ['userData','sessionData','logs','crashDumps','temp'])app.setPath(name,join(${JSON.stringify(fixture)},name));
app.commandLine.appendSwitch('disk-cache-dir',join(${JSON.stringify(fixture)},'cache'));
let snapshot={generation:1,revision:1,projects:[],selected:null,runtime:null,account:null},commands=[],attempts=0,trustAttempts=0,hookHash='hook-hash-v1',hookTrust='untrusted',delayProduct=false,holdConfiguration=false,configurationPending,win;
const catalog=nodeId=>({models:[{id:'actual-model',name:'Actual catalog model',isDefault:true}],skills:[],plugins:[],errors:['推荐能力 GitNexus 尚未发现'],mcpServers:[{name:'browser-'+(nodeId??'project'),status:'connected',toolCount:3},{name:'gitnexus',status:'failed',toolCount:0}],hooks:[
{key:'stop',eventName:'Stop',enabled:true,trustStatus:hookTrust,sourcePath:${JSON.stringify(join(fixture, '.mixcat/hooks.json'))},command:'node ./review-hook.cjs',matcher:'*',currentHash:hookHash},
{key:'disabled',eventName:'SessionStart',enabled:false,trustStatus:hookTrust,sourcePath:${JSON.stringify(join(fixture, '.mixcat/hooks.json'))},command:'node ./disabled-hook.cjs',currentHash:'disabled-hash'},
{key:'managed',eventName:'PreToolUse',enabled:true,trustStatus:'managed',sourcePath:${JSON.stringify(join(fixture, '.mixcat/managed.json'))},command:'managed-command',currentHash:'managed-hash'},
{key:'global',eventName:'PostToolUse',enabled:true,trustStatus:'untrusted',sourcePath:'G:/global/hooks.json',command:'global-command',currentHash:'global-hash'}]});
ipcMain.handle('inspect',()=>({snapshot,commands,configurationPending:!!configurationPending}));
ipcMain.handle('delayProduct',()=>{delayProduct=true;});
ipcMain.handle('holdConfiguration',()=>{holdConfiguration=true;});
ipcMain.handle('releaseConfiguration',()=>{const finish=configurationPending;configurationPending=undefined;holdConfiguration=false;finish();});
ipcMain.handle('command',(_,envelope)=>{const c=envelope.command;commands.push(c);
 if(c.type==='create_project'){const project={id:'project-'+commands.length,name:c.name,root:c.root,goal:c.goal,template:c.template,status:'idle',mode:'codex',updatedAt:''};snapshot.projects.push(project);const roles=c.template?['product','requirements','design','frontend','backend','test','architect','design-test']:['plan','implement','review'];const positions=[{x:70,y:80},{x:440,y:80},{x:70,y:380},{x:1270,y:80},{x:900,y:380},{x:1270,y:380},{x:900,y:80},{x:440,y:380}];snapshot.selected={project,nodes:roles.map((id,i)=>({id,name:id,instructions:'Fixture role',model:null,planId:c.template?'mvp-001':undefined,skills:[],plugins:[],tools:[],resultSchema:{},position:c.template?positions[i]:{x:60+i%3*330,y:60+Math.floor(i/3)*260},revision:1,status:'idle',threadId:'thread-'+id})),edges:[],groups:c.template?[{id:'product-definition',name:'产品定义',nodeIds:['product','requirements','design','design-test'],coordinatorNodeId:'product',revision:1}]:[],tasks:[],handoffs:[],activities:[],conversation:[]};}
 if(c.type==='configure_template'&&++attempts===1)throw Error('推荐能力配置失败：受控失败，可重试');
 if(c.type==='configure_template'&&holdConfiguration)return new Promise(done=>{configurationPending=()=>{snapshot={...snapshot,revision:snapshot.revision+1};done({snapshot,catalog:catalog('stale-project')});};});
 if(c.type==='trust_hooks'){trustAttempts++;if(trustAttempts===1){hookHash='hook-hash-v2';hookTrust='modified';throw Error('Hook内容已变化');}if(trustAttempts===2)throw Error('受控信任写入失败');hookTrust='trusted';snapshot={...snapshot,revision:snapshot.revision+1};return {snapshot,catalog:catalog('stale-trust-project')};}
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
  await click('dialog .modal-actions .primary');
  await poll(() => evaluate("document.querySelectorAll('.conversation-node').length===8 && document.querySelector('.error-banner')?.textContent.includes('可重试')"));
  let state = await inspect();
  assert.equal(state.commands.filter(c => c.type === 'create_project').length, 1);
  assert.equal(state.commands.find(c => c.type === 'create_project').template, 'web-product');
  assert.deepEqual(state.snapshot.selected.groups, [{ id: 'product-definition', name: '产品定义', nodeIds: ['product', 'requirements', 'design', 'design-test'], coordinatorNodeId: 'product', revision: 1 }]);
  assert.equal(state.commands.find(c => c.type === 'configure_template').projectId, state.snapshot.selected.project.id);
  await screenshot('configuration-retry.png');
  await click('.project-controls button', '配置推荐能力');
  await poll(async () => (await inspect()).commands.filter(c => c.type === 'configure_template').length === 2);
  await poll(() => evaluate("document.querySelector('.error-banner')?.textContent.includes('部分推荐能力尚未配置')"));
  await click('#tab-config');
  await poll(() => evaluate("document.querySelector('.node-config')?.textContent.includes('browser-product')"));
  const beforeConfiguration = (await inspect()).commands.length;
  await evaluate('window.fixture.holdConfiguration()'); await click('.project-controls button', '配置推荐能力');
  await poll(async () => (await inspect()).configurationPending);
  await click('.react-flow__node[data-id="requirements"] h3');
  await poll(() => evaluate("document.querySelector('.node-config')?.textContent.includes('browser-requirements')"));
  const requirementsQueries = (await inspect()).commands.filter(c => c.type === 'catalog' && c.nodeId === 'requirements').length;
  await evaluate('window.fixture.releaseConfiguration()');
  await poll(() => evaluate("!document.querySelector('.project-controls button').disabled"));
  assert(!(await evaluate("document.querySelector('.node-config').textContent")).includes('browser-stale-project'), 'project configuration reply cannot overwrite current Thread catalog');
  await poll(async () => (await inspect()).commands.filter(c => c.type === 'catalog' && c.nodeId === 'requirements').length > requirementsQueries);
  assert((await inspect()).commands.slice(beforeConfiguration).some(c => c.type === 'catalog' && c.nodeId === 'requirements'));
  await click('.react-flow__node[data-id="product"] h3');
  await poll(() => evaluate("document.querySelector('.node-config')?.textContent.includes('browser-product')"));
  assert.equal(await evaluate('document.querySelector(\'select[aria-label="模型"]\').value'), '');
  assert.equal(await evaluate('document.querySelector(\'input[aria-label="计划 ID"]\').value'), 'mvp-001');
  for (const text of ['待信任', '失败', '尚未发现']) assert((await evaluate("document.querySelector('.node-config').textContent")).includes(text));
  await fill('input[aria-label="计划 ID"]', '../escape');
  assert.equal(await evaluate('document.querySelector(\'input[aria-label="计划 ID"]\').checkValidity()'), false);
  const beforeSave = (await inspect()).commands.filter(c => c.type === 'save_node').length;
  await click('.node-config .primary'); await delay(100);
  assert.equal((await inspect()).commands.filter(c => c.type === 'save_node').length, beforeSave);
  await fill('input[aria-label="计划 ID"]', 'Release_1');
  assert.equal(await evaluate('document.querySelector(\'input[aria-label="计划 ID"]\').checkValidity()'), true);
  await click('.node-config .primary');
  await poll(async () => (await inspect()).commands.filter(c => c.type === 'save_node').length > beforeSave);
  const saved = (await inspect()).commands.findLast(c => c.type === 'save_node').node;
  assert.equal(saved.model, null); assert.equal(saved.planId, 'Release_1');
  await fill('.node-config > label > input', 'Renamed product'); await click('.node-config .primary');
  await poll(async () => (await inspect()).commands.findLast(c => c.type === 'save_node')?.node.name === 'Renamed product');
  assert.equal((await inspect()).commands.findLast(c => c.type === 'save_node').node.planId, 'Release_1');
  await evaluate('window.fixture.delayProduct()'); await click('.node-config .text-button', '刷新可用能力');
  await click('.react-flow__node[data-id="requirements"] h3');
  await poll(() => evaluate("document.querySelector('.node-config')?.textContent.includes('browser-requirements')"));
  await delay(650);
  assert(!(await evaluate("document.querySelector('.node-config').textContent")).includes('browser-stale-product'));
  state = await inspect();
  assert(state.commands.some(c => c.type === 'catalog' && c.nodeId === 'requirements'));
  await evaluate("[...document.querySelectorAll('.node-config fieldset')].find(e=>e.textContent.includes('MCP 与 hooks 状态')).scrollIntoView({block:'center'})");
  await screenshot('node-capability-status.png');
  assert.equal((await inspect()).commands.filter(c => c.type === 'trust_hooks').length, 0, 'discovery never grants trust');
  assert.equal(await evaluate("document.querySelector('.node-config details').open"), false);
  await click('.node-config details summary');
  assert.equal((await inspect()).commands.filter(c => c.type === 'trust_hooks').length, 0, 'opening review never grants trust');
  const review = await evaluate("document.querySelector('.node-config details').textContent");
  for (const text of ['node ./review-hook.cjs', 'hook-hash-v1', '.mixcat', 'disabled-hash', '未启用']) assert(review.includes(text));
  assert(!review.includes('managed-hash') && !review.includes('global-hash'));
  await evaluate("document.querySelector('.node-config details').scrollIntoView({block:'start'})");
  await screenshot('hooks-review.png');
  await click('.node-config details button');
  await poll(() => evaluate("document.querySelector('.node-config details')?.textContent.includes('hook-hash-v2') && document.querySelector('.error-banner')?.textContent.includes('信任未完成')"));
  assert.equal(await evaluate("document.querySelector('.node-config details').open"), false, 'changed hash requires opening the refreshed review');
  assert.deepEqual((await inspect()).commands.find(c => c.type === 'trust_hooks').hooks, [{ key: 'stop', currentHash: 'hook-hash-v1' }, { key: 'disabled', currentHash: 'disabled-hash' }]);
  await click('.node-config details summary'); await click('.node-config details button');
  await poll(async () => (await inspect()).commands.filter(c => c.type === 'trust_hooks').length === 2);
  await poll(() => evaluate("!document.querySelector('.node-config details button').disabled && document.querySelector('.error-banner')?.textContent.includes('信任未完成')"));
  assert.deepEqual((await inspect()).commands.filter(c => c.type === 'trust_hooks')[1].hooks, [{ key: 'stop', currentHash: 'hook-hash-v2' }, { key: 'disabled', currentHash: 'disabled-hash' }]);
  await click('.node-config details button');
  await poll(() => evaluate("!document.querySelector('.node-config details') && document.querySelector('.node-config').textContent.includes('宿主已信任')"));
  assert((await evaluate("document.querySelector('.node-config').textContent")).includes('会话开始 · 未启用'));
  assert(!(await evaluate("document.querySelector('.node-config').textContent")).includes('browser-stale-trust-project'));
  assert((await evaluate("document.querySelector('.node-config').textContent")).includes('browser-requirements'));
  assert((await evaluate("document.querySelector('.node-config').textContent")).includes('推荐能力 GitNexus 尚未发现'));
  await click('button', '添加节点');
  await poll(() => evaluate("!!document.querySelector('dialog[open]')"));
  await fill('dialog input', 'Native default node'); await fill('dialog input[aria-label="计划 ID"]', 'Release_1');
  assert.equal(await evaluate('document.querySelector(\'dialog input[aria-label="计划 ID"]\').checkValidity()'), true);
  await click('dialog .modal-actions .primary');
  await poll(async () => (await inspect()).commands.findLast(c => c.type === 'save_node')?.node.name === 'Native default node');
  assert.equal((await inspect()).commands.findLast(c => c.type === 'save_node').node.model, null);
  assert.equal((await inspect()).commands.findLast(c => c.type === 'save_node').node.planId, 'Release_1');
  // Basic creation omits template and does not attempt recommendation configuration.
  await click('nav button', '项目'); await click('button', '新建项目');
  await fill('dialog input', 'Basic UI'); await fill('dialog .input-with-button input', fixture); await fill('dialog textarea', 'Basic workflow'); await click('dialog .modal-actions .primary');
  await poll(() => evaluate("document.querySelectorAll('.conversation-node').length===3"));
  state = await inspect(); assert.equal(state.commands.filter(c => c.type === 'configure_template').length, 3);
  assert(!('template' in state.commands.filter(c => c.type === 'create_project').at(-1)));
  await click('nav button', '项目'); await click('button', '新建项目');
  await fill('dialog input', 'Partial capability UI'); await fill('dialog .input-with-button input', fixture); await fill('dialog textarea', 'Keep successfully created workflow');
  await choose('select[aria-label="工作流模板"]', 'web-product'); await click('dialog .modal-actions .primary');
  await poll(() => evaluate("document.querySelectorAll('.conversation-node').length===8 && document.querySelector('.error-banner')?.textContent.includes('项目已创建，部分推荐能力尚未配置')"));
  console.log(JSON.stringify({ result: 'PASS', fixture, checks: ['template and basic creation', 'configuration failure retained project and retried', 'null model save', 'plan slug validation', 'node-specific catalog', 'untrusted hooks and failed MCP', 'explicit reviewed hook hashes only', 'changed hash and failed trust retry', 'disabled hooks remain disabled'] }));
} catch (error) { if (socket?.readyState === 1) try { await screenshot('failure.png'); } catch {} throw error; }
finally {
  try { if (socket?.readyState === 1) await evaluate('window.fixture.close()'); } catch {}
  socket?.close();
  if (child.exitCode === null) { await Promise.race([once(child, 'exit'), delay(5000)]); if (child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); }
  writeFileSync(safe(join(fixture, 'electron.log')), log);
}
