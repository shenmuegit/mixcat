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
const evidence = safe(join(root, '.runtime/implementation/mcp-collaboration/task-6'));
mkdirSync(evidence, { recursive: true });
const fixture = mkdtempSync(safe(join(evidence, 'settings-delete-ui-')));
for (const name of ['tmp', 'appdata', 'localappdata', 'home', 'cache', 'userData', 'sessionData', 'logs', 'crashDumps', 'temp']) mkdirSync(safe(join(fixture, name)));
const initial = { generation: 1, revision: 1, projects: [], selected: null, runtime: null, account: null };
const preload = safe(join(fixture, 'preload.cjs'));
writeFileSync(preload, `const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('mixcat', {
 command: envelope => ipcRenderer.invoke('command', envelope),
 subscribe: listener => { const handler = (_, update) => listener(update); ipcRenderer.on('update', handler); return () => ipcRenderer.removeListener('update', handler); },
 panel: command => ipcRenderer.invoke('panel', command), subscribePanels: () => () => {}, chooseAttachments: async () => [], choosePanelFile: async () => null, chooseDirectory: async () => null
});
contextBridge.exposeInMainWorld('fixture', { set: snapshot => ipcRenderer.invoke('set', snapshot), publish: update => ipcRenderer.invoke('publish', update), inspect: () => ipcRenderer.invoke('inspect'), show: () => ipcRenderer.invoke('show'), close: () => ipcRenderer.send('close') });`);
const main = safe(join(fixture, 'main.cjs'));
writeFileSync(main, `const {app,BrowserWindow,ipcMain}=require('electron');const {join}=require('node:path');
for(const name of ['userData','sessionData','logs','crashDumps','temp'])app.setPath(name,join(${JSON.stringify(fixture)},name));
app.commandLine.appendSwitch('disk-cache-dir',join(${JSON.stringify(fixture)},'cache'));
let snapshot=${JSON.stringify(initial)},commands=[],panels=[],win,projects=new Map();
ipcMain.handle('set',(_,value)=>{if(snapshot.selected)projects.set(snapshot.selected.project.id,snapshot.selected);snapshot={...value,generation:1,revision:snapshot.revision+1};if(snapshot.selected)projects.set(snapshot.selected.project.id,snapshot.selected);win.webContents.send('update',{kind:'full',snapshot});});
ipcMain.handle('publish',(_,update)=>win.webContents.send('update',update));
ipcMain.handle('inspect',()=>({snapshot,commands,panels}));
ipcMain.handle('show',()=>{win.showInactive();win.showInactive();});
ipcMain.handle('command',(_,envelope)=>{const c=envelope.command;commands.push(c);
 if(c.type==='snapshot'&&c.projectId==='unavailable')throw new Error('Fixture project unavailable');
 if(c.type==='snapshot'&&projects.has(c.projectId)){if(snapshot.selected)projects.set(snapshot.selected.project.id,snapshot.selected);snapshot={...snapshot,selected:projects.get(c.projectId)};}
 if(c.type==='connect_account')snapshot.account={connected:true,authenticated:false,accountLabel:null,error:null,mode:'codex'};
 if(c.type==='login')snapshot.account={connected:true,authenticated:false,accountLabel:null,error:null,mode:'codex'};
 if(c.type==='delete_node'){const p=snapshot.selected;const node=p.nodes.find(n=>n.id===c.nodeId);p.nodes=p.nodes.filter(n=>n.id!==c.nodeId);p.archivedNodes=[...(p.archivedNodes??[]),node];p.edges=(p.edges??[]).filter(e=>e.sourceNodeId!==c.nodeId&&e.targetNodeId!==c.nodeId);}
 if(c.type==='save_node'){const node=snapshot.selected.nodes.find(n=>n.id===c.node.id);Object.assign(node,{tools:c.node.tools,model:c.node.model,revision:node.revision+1});}
 snapshot={...snapshot,revision:snapshot.revision+1};return {snapshot,...(c.type==='catalog'?{catalog:{models:[{id:'other-model',name:'Other model'},{id:'default-model',name:'Actual default',isDefault:true}],skills:[],plugins:[],errors:[]}}:{})};
});
ipcMain.handle('panel',(_,c)=>{panels.push(c);return {projectId:c.projectId,nodeId:c.nodeId,revision:1,generation:1,panels:[],activePanelId:null};});
ipcMain.on('close',()=>app.exit(0));
app.whenReady().then(()=>{win=new BrowserWindow({width:1500,height:980,show:false,titleBarStyle:'hidden',titleBarOverlay:{color:'#f9f9f9',symbolColor:'#333333',height:32},webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});win.loadFile(${JSON.stringify(join(root, 'dist/client/renderer/index.html'))});});`);
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
async function openProject(name) {
  if (await evaluate("!!document.querySelector('.sidebar-project-list')")) {
    if (await evaluate("document.querySelector('.sidebar-project-list').hidden")) await click('nav button', '项目');
    await click('.sidebar-project-list button', name);
  } else {
    await click('nav button', '项目'); await click('.project-card', name);
  }
}
async function screenshot(name) { await evaluate('window.fixture.show()'); await delay(300); const image = await rpc('Page.captureScreenshot', { format: 'png' }); writeFileSync(safe(join(fixture, name)), Buffer.from(image.data, 'base64')); }
const node = id => ({ id, name: id === 'one' ? 'First' : 'Second', instructions: '', tools: [], resultSchema: {}, position: { x: id === 'one' ? 80 : 420, y: 100 }, revision: 1, threadId: `thread-${id}`, status: 'idle' });
const project = { id: 'p', name: 'Preserved Project', root: fixture, goal: 'Renderer fixture', status: 'idle', mode: 'codex', updatedAt: '' };
const entry = { id: 'old-input', seq: 1, nodeId: 'one', taskId: null, threadId: 'thread-one', turnId: null, itemId: null, direction: 'input', source: { kind: 'user' }, text: 'Saved historical message', content: [{ type: 'mention', path: join(fixture, 'retained.txt') }], createdAt: '' };
async function verifyCollaboration() {
  await click('.react-flow__node[data-id="one"] h3'); await click('#tab-config');
  await poll(() => evaluate("!!document.querySelector('input[aria-label=send_message]')"));
  const requestedModel = await evaluate("document.querySelector('select[aria-label=模型]').value||null");
  const beforeSave = (await inspect()).commands.filter(command => command.type === 'save_node').length;
  assert.equal(await evaluate("document.querySelector('input[aria-label=send_message]').checked"), false);
  await click('input[aria-label="send_message"]'); await click('input[aria-label="get_delivery"]'); await click('input[aria-label="read_history"]');
  assert.equal((await inspect()).snapshot.selected.nodes[0].tools.length, 0, 'checkbox edits remain a draft until save');
  await screenshot('collaboration-tools.png');
  await click('.node-config .button.primary');
  await poll(async () => (await inspect()).commands.filter(command => command.type === 'save_node').length > beforeSave);
  const saved = (await inspect()).commands.findLast(command => command.type === 'save_node').node;
  assert.deepEqual(saved.tools, ['send_message', 'get_delivery', 'read_history']); assert.equal(saved.model ?? null, requestedModel);
  await poll(() => evaluate("document.querySelector('input[aria-label=send_message]').checked"));
  await click('#tab-conversation');
  const baseline = (await inspect()).snapshot;
  const attachmentPath = '.mixcat/artifacts/messages/report.txt';
  const originalMessage = { message_id: 'original-message', target_task_id: 'receiving', sourceTaskId: 'sending', fromNodeId: 'one', fromName: '来源节点', toNodeId: 'two', toName: '接收节点', replyTo: null, accepted_at: '' };
  const replyMessage = { ...originalMessage, message_id: 'reply-message', target_task_id: 'reply-task', fromNodeId: 'two', fromName: '接收节点', toNodeId: 'one', toName: '来源节点', replyTo: originalMessage.message_id };
  const sent = { ...entry, id: 'sent-original', nodeId: 'one', direction: 'event', source: { kind: 'node', nodeId: 'one', name: '来源节点' }, messageId: originalMessage.message_id, text: '发送至「接收节点」：原始原因', content: { type: 'messageSent', toNodeId: 'two', toName: '接收节点', reason: '原始原因', receipt: { accepted: true, message_id: originalMessage.message_id, target_task_id: 'receiving', accepted_at: '' } }, sentMessage: { content: ' 原始正文\n ' } };
  const received = { ...entry, id: 'received-original', seq: 2, nodeId: 'two', taskId: 'receiving', source: { kind: 'node', nodeId: 'one', name: '来源节点' }, messageId: originalMessage.message_id, text: ' 原始正文\n ', content: { free: [null, false, 0, ''] }, attachments: [{ artifact_id: 'snapshot', name: '报告.txt', relativePath: attachmentPath, sha256: 'fixture', size: 3 }] };
  const replied = { ...sent, id: 'sent-reply', seq: 3, nodeId: 'two', messageId: replyMessage.message_id, replyTo: originalMessage.message_id, text: '显式回复记录', sentMessage: { content: '显式回复原文' } };
  let state = await inspect();
  const collaboration = { ...state.snapshot, selected: { ...state.snapshot.selected, messages: [originalMessage, replyMessage], conversation: [entry, sent, received, replied, { ...entry, id: 'model-output', seq: 4, nodeId: 'two', direction: 'output', source: null, text: '模型输出', content: null }], tasks: [{ id: 'receiving', nodeId: 'two', status: 'failed', error: '受控失败' }, { id: 'reply-task', nodeId: 'one', status: 'completed' }] } };
  await evaluate(`window.fixture.set(${JSON.stringify(collaboration)})`);
  await click('.react-flow__node[data-id="one"] h3');
  await click('#task-instruction');
  await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
  await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
  await rpc('Input.insertText', { text: '来源节点定位草稿' });
  await click('.react-flow__node[data-id="two"] h3');
  await click('#task-instruction'); await rpc('Input.insertText', { text: '接收节点草稿' });
  await poll(() => evaluate("document.querySelector('[data-entry-id=received-original] .feed-meta').textContent.includes('来源节点 → 接收节点')"));
  assert.match(await evaluate("document.querySelector('[data-entry-id=received-original]').textContent"), /投递 · 失败/);
  const bubbles = await evaluate("(()=>{const a=document.querySelector('[data-entry-id=received-original]').getBoundingClientRect(),b=document.querySelector('[data-entry-id=model-output]').getBoundingClientRect();return{inputRight:a.right,outputLeft:b.left,inputLeft:a.left,outputRight:b.right}})()");
  assert(bubbles.inputRight > bubbles.outputRight && bubbles.inputLeft > bubbles.outputLeft, 'incoming collaboration input is right aligned and model output is left aligned');
  const edgeLabels = await poll(() => evaluate("(()=>{const facts=[...document.querySelectorAll('.react-flow__edge-text')].filter(e=>e.textContent.includes('条消息'));if(facts.length!==2)return null;const box=e=>{const r=e.getBoundingClientRect();return{text:e.textContent,left:r.left,right:r.right,top:r.top,bottom:r.bottom}};return{facts:facts.map(box),condition:box(document.querySelector('.condition-label'))}})()"));
  const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  assert(edgeLabels.facts.every(label => !overlaps(label, edgeLabels.condition)) && !overlaps(...edgeLabels.facts), 'ordinary-message counts remain visible beside configured conditions and return traffic');
  await screenshot('collaboration-feed.png');
  await click('[data-entry-id=sent-reply] button[data-reply-to="original-message"]');
  await poll(() => evaluate("document.querySelector('.detail-heading h2').textContent==='First'&&document.activeElement?.dataset.entryId==='sent-original'"));
  assert.equal(await evaluate("document.querySelector('[data-entry-id=sent-original] .sent-message-body p').textContent"), ' 原始正文\n ');
  await screenshot('collaboration-source-location.png');
  assert.equal(await evaluate("document.querySelector('#task-instruction').value"), '来源节点定位草稿');
  await click('#task-instruction');
  let continuedDraft = '来源节点定位草稿';
  for (const text of ['甲', '乙', '丙']) {
    await rpc('Input.insertText', { text }); continuedDraft += text;
    await poll(() => evaluate(`document.querySelector('#task-instruction').value===${JSON.stringify(continuedDraft)}`));
    assert.equal(await evaluate("document.activeElement===document.querySelector('#task-instruction')"), true, 'location must not steal focus during subsequent typing');
  }
  state = await inspect();
  const composeScroll = await evaluate("document.querySelector('.session-scroll').scrollTop");
  await evaluate(`window.fixture.set(${JSON.stringify({ ...state.snapshot, selected: { ...state.snapshot.selected, activities: [{ id: 1, nodeId: null, taskId: null, kind: 'fixture', text: '无关更新', createdAt: '' }] } })})`);
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  assert.equal(await evaluate("document.activeElement===document.querySelector('#task-instruction')"), true, 'an unrelated snapshot cannot reapply a consumed location');
  assert.equal(await evaluate("document.querySelector('#task-instruction').value"), continuedDraft);
  assert.equal(await evaluate("document.querySelector('.session-scroll').scrollTop"), composeScroll);
  await screenshot('collaboration-typing-after-location.png');
  await click('.react-flow__node[data-id="two"] h3');
  await click('[data-entry-id=sent-reply] button[data-reply-to="original-message"]');
  await poll(() => evaluate("document.activeElement?.dataset.entryId==='sent-original'"));
  assert.equal(await evaluate("document.querySelector('#task-instruction').value"), continuedDraft);
  await click('.react-flow__node[data-id="two"] h3');
  assert.equal(await evaluate("document.querySelector('#task-instruction').value"), '接收节点草稿');
  await click('[data-entry-id=received-original] .resource-actions button', '报告.txt');
  await poll(async () => (await inspect()).panels.some(command => command.type === 'open' && command.nodeId === 'two' && command.target.path.replace(/\\/g, '/') === `${fixture.replace(/\\/g, '/')}/${attachmentPath}`));
  await click('#tab-conversation');
  state = await inspect();
  await evaluate(`window.fixture.set(${JSON.stringify({ ...state.snapshot, selected: { ...state.snapshot.selected, nodes: [node('two')], archivedNodes: [node('one')], tasks: [] } })})`);
  await click('[data-entry-id=sent-reply] button[data-reply-to="original-message"]');
  await poll(() => evaluate("document.querySelector('dialog[open] [data-entry-id=sent-original]')?.classList.contains('is-located')&&document.activeElement?.dataset.entryId==='sent-original'"));
  assert.match(await evaluate("document.querySelector('dialog[open]').textContent"), /来源节点已移除/);
  assert.equal(await evaluate("document.querySelector('dialog[open] [data-entry-id=sent-original] .sent-message-body p').textContent"), ' 原始正文\n ');
  await screenshot('collaboration-archived-source.png');
  await click('dialog button[aria-label="关闭弹窗"]');
  assert.equal(await evaluate("document.querySelector('#task-instruction').value"), '接收节点草稿');
  state = await inspect();
  await evaluate(`window.fixture.set(${JSON.stringify({ ...state.snapshot, selected: { ...state.snapshot.selected, nodes: [node('one'), node('two')], archivedNodes: [], conversation: [entry, received, replied] } })})`);
  await click('[data-entry-id=sent-reply] button[data-reply-to="original-message"]');
  await poll(() => evaluate("document.querySelector('dialog[open]')?.textContent.includes('原始发送记录缺失')&&document.activeElement?.dataset.entryId==='received-original'"));
  await screenshot('collaboration-retained-receipt.png');
  await click('dialog button[aria-label="关闭弹窗"]');
  state = await inspect();
  await evaluate(`window.fixture.set(${JSON.stringify({ ...state.snapshot, selected: { ...state.snapshot.selected, conversation: [entry, replied] } })})`);
  await click('[data-entry-id=sent-reply] button[data-reply-to="original-message"]');
  await poll(() => evaluate("document.querySelector('dialog[open]')?.textContent.includes('未找到原消息记录')"));
  await screenshot('collaboration-missing-source.png');
  state = await inspect();
  await evaluate(`window.fixture.set(${JSON.stringify({ ...state.snapshot, selected: { ...state.snapshot.selected, conversation: [...state.snapshot.selected.conversation, sent] } })})`);
  await poll(() => evaluate("document.querySelector('dialog[open] [data-entry-id=sent-original]')?.classList.contains('is-located')&&document.activeElement?.dataset.entryId==='sent-original'"));
  await screenshot('collaboration-delayed-location.png');
  await click('dialog button[aria-label="关闭弹窗"]');
  assert.equal(await evaluate("document.querySelector('#task-instruction').value"), '接收节点草稿');
  state = await inspect();
  await evaluate(`window.fixture.set(${JSON.stringify({ ...collaboration, revision: state.snapshot.revision })})`);
  state = await inspect();
  const delta = { kind: 'delta', generation: state.snapshot.generation, revision: state.snapshot.revision + 1, baseRevision: state.snapshot.revision, projectId: 'p', projects: state.snapshot.projects, runtime: state.snapshot.runtime, account: state.snapshot.account, selected: { ...state.snapshot.selected, messages: [{ ...originalMessage, fromName: '增量来源快照' }, replyMessage] }, entries: [] };
  delete delta.selected.conversation;
  await evaluate(`window.fixture.publish(${JSON.stringify(delta)})`);
  await poll(() => evaluate("document.querySelector('[data-entry-id=received-original] .feed-meta')?.textContent.includes('增量来源快照 → 接收节点')"));
  state = await inspect();
  const otherProject = { ...project, id: 'q', name: '其他项目' };
  const otherSnapshot = { ...state.snapshot, projects: [...state.snapshot.projects, otherProject], selected: { project: otherProject, nodes: [{ ...node('one'), id: 'other', name: '其他会话' }], tasks: [], handoffs: [], activities: [], conversation: [], messages: [], edges: [] } };
  await evaluate(`window.fixture.set(${JSON.stringify(otherSnapshot)})`);
  await evaluate(`window.fixture.set(${JSON.stringify({ ...state.snapshot, projects: otherSnapshot.projects })})`);
  await openProject('其他项目');
  await poll(() => evaluate("document.querySelector('.detail-heading h2')?.textContent==='其他会话'"));
  await evaluate(`window.fixture.publish(${JSON.stringify({ kind: 'full', snapshot: { ...collaboration, generation: 0, revision: 99999 } })})`);
  assert.equal(await evaluate("document.querySelectorAll('[data-message-id]').length"), 0);
  assert.equal(await evaluate("document.querySelector('.detail-heading h2').textContent"), '其他会话');
  await openProject('Preserved Project');
  await poll(() => evaluate("document.querySelectorAll('.react-flow__node').length===2"));
  await evaluate(`window.fixture.set(${JSON.stringify({ ...baseline })})`);
  return { ...bubbles, edgeLabels, focusChecks: ['three separate characters retain composer focus', 'unrelated snapshot preserves focus and scroll', 'repeated same-message location focuses again', 'delayed history entry receives pending focus'], projectSwitch: 'actual project list or existing sidebar' };
}

try {
  const page = await poll(async () => { if (child.exitCode !== null) throw Error(`Electron exited (${child.exitCode}): ${log}`); try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(p => p.type === 'page'); } catch { return null; } });
  socket = new WebSocket(page.webSocketDebuggerUrl); await once(socket, 'open');
  socket.addEventListener('message', event => { const value = JSON.parse(String(event.data)), entry = pending.get(value.id); if (entry) { pending.delete(value.id); value.error ? entry.reject(Error(JSON.stringify(value.error))) : entry.resolve(value.result); } });
  await poll(() => evaluate("document.querySelector('.projects-page .page-heading h1')?.textContent"));
  assert.equal(await evaluate("document.querySelector('.projects-page .page-heading h1').textContent"), '项目');
  assert.equal(await evaluate("document.querySelectorAll('.heading-count,.project-card-bottom,.projects-hint').length"), 0);
  assert.equal(await evaluate("!!document.querySelector('.empty-workspace button')"), true);
  await screenshot('projects-empty.png');
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
  const snapshot = { ...state.snapshot, projects: [project, { ...project, id: 'unavailable', name: 'Unavailable project' }], selected: { project, nodes: [node('one'), node('two')], tasks: [], handoffs: [], activities: [], conversation: [entry], edges: [{ id: 'edge', sourceNodeId: 'one', targetNodeId: 'two', condition: '' }] }, runtime: state.snapshot.account };
  await evaluate(`window.fixture.set(${JSON.stringify(snapshot)})`);
  await click('nav button', '项目');
  assert.equal(await evaluate("document.querySelector('[aria-controls=sidebar-project-list]').getAttribute('aria-expanded')"), 'true');
  assert.equal(await evaluate("document.querySelector('.sidebar-project-list').hidden"), false);
  assert.equal(await evaluate("document.querySelectorAll('.project-chevron').length"), 0);
  await click('nav button', '项目');
  assert.equal(await evaluate("document.querySelector('[aria-controls=sidebar-project-list]').getAttribute('aria-expanded')"), 'false');
  assert.equal(await evaluate("document.querySelector('.sidebar-project-list').getBoundingClientRect().height"), 0);
  await screenshot('projects-collapsed.png');
  await click('nav button', '项目');
  assert.equal(await evaluate("document.querySelector('[aria-controls=sidebar-project-list]').getAttribute('aria-expanded')"), 'true');
  assert.equal(await evaluate("document.querySelector('.sidebar-project-list').hidden"), false);
  assert.equal(await evaluate("document.querySelector('.projects-page .page-heading h1').textContent"), '项目');
  assert.equal(await evaluate("document.querySelectorAll('.sidebar-space').length"), 0);
  assert.equal(await evaluate("document.querySelectorAll('.workspace-status').length"), 0);
  assert.equal(await evaluate("document.title"), 'Mixcat');
  assert.equal(await evaluate("document.querySelectorAll('.heading-count,.project-card-bottom,.projects-hint').length"), 0);
  await screenshot('projects.png');
  await click('.project-card', 'Preserved Project');
  await poll(() => evaluate("document.querySelectorAll('.react-flow__node').length===2"));
  assert.equal(await evaluate("!![...document.querySelectorAll('.detail-panel button')].find(e=>e.textContent==='登录')"), false);
  assert.equal(await evaluate("document.querySelectorAll('.runtime-box,.resume-summary,.canvas-caption,.node-directory,.mode-select,.detail-heading>.eyebrow,.tab-strip,.project-tab,.project-heading,.project-objective,.detail-heading .status,.react-flow__controls,.activity-strip').length"), 0);
  assert.equal(await evaluate("document.querySelectorAll('.node-controls button').length"), 3);
  assert.equal(await evaluate("!!document.querySelector('#task-instruction')"), true);
  assert.equal(await evaluate("document.querySelectorAll('.session-workbench>.execution-overview,.canvas-heading,.react-flow__background').length"), 0);
  assert.equal(await evaluate("document.querySelector('.project-statusbar .workflow-summary').textContent"), '2 个会话');
  await click('#task-instruction');
  await rpc('Input.insertText', { text: 'Drawer conversation draft' });
  const expandedCanvasWidth = await evaluate("document.querySelector('.flow-wrap').getBoundingClientRect().width");
  await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await poll(() => evaluate("document.querySelector('#node-details-drawer').hidden"));
  assert.equal(await evaluate("document.activeElement===document.querySelector('.flow-wrap')"), true);
  const collapsedCanvas = await evaluate("(()=>{const canvas=document.querySelector('.flow-wrap').getBoundingClientRect(),body=document.querySelector('.workbench-body').getBoundingClientRect();return{width:canvas.width,bodyWidth:body.width};})()");
  assert(collapsedCanvas.width>expandedCanvasWidth+250); assert(Math.abs(collapsedCanvas.width-collapsedCanvas.bodyWidth)<=1);
  await screenshot('drawer-collapsed.png');
  await click('.react-flow__node.selected h3');
  await poll(() => evaluate("!document.querySelector('#node-details-drawer').hidden"));
  assert.equal(await evaluate("document.querySelector('#task-instruction').value"), 'Drawer conversation draft');
  await click('#tab-config');
  await poll(() => evaluate("document.querySelector('.node-config select[aria-label=模型]')?.value==='default-model'"));
  assert.equal(await evaluate("[...document.querySelectorAll('.node-config select[aria-label=模型] option')].some(option=>option.textContent.includes('原生默认模型'))"),false);
  assert.equal(await evaluate("/所选能力随节点消息|版本 [0-9]/.test(document.querySelector('.node-config').textContent)"),false);
  await screenshot('node-configuration.png');
  await click('.node-config input');
  await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
  await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
  await rpc('Input.insertText', { text: 'Unsaved drawer name' });
  await click('.detail-heading button[aria-label="收起节点详情"]');
  await poll(() => evaluate("document.querySelector('#node-details-drawer').hidden"));
  await click('.react-flow__node.selected h3');
  assert.equal(await evaluate("document.querySelector('#tab-config').getAttribute('aria-selected')"), 'true');
  assert.equal(await evaluate("document.querySelector('.node-config input').value"), 'Unsaved drawer name');
  await click('.node-config .button.primary');
  await poll(async () => (await inspect()).commands.some(command=>command.type==='save_node'&&command.node.model==='default-model'));
  await click('#tab-conversation');
  assert.equal(await evaluate("document.querySelector('.composer-bottom').textContent.includes('自由输入 · 保留会话上下文')"),false);
  await click('[aria-label="收起节点详情"]');
  await click('.react-flow__node[data-id="two"] h3');
  await poll(() => evaluate("!document.querySelector('#node-details-drawer').hidden&&document.querySelector('.detail-heading h2').textContent==='Second'"));
  await click('.react-flow__node[data-id="one"] h3');
  assert.equal(await evaluate("document.querySelector('#task-instruction').value"), 'Drawer conversation draft');
  async function headerLayout() {
    return evaluate("(()=>{const header=document.querySelector('.project-header').getBoundingClientRect();const boxes=['.project-statusbar','.project-controls'].map(selector=>{const r=document.querySelector(selector).getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}});return {contained:boxes.every(r=>r.left>=header.left&&r.right<=header.right&&r.top>=header.top&&r.bottom<=header.bottom),separated:boxes[0].right<=boxes[1].left,canvasAtHeader:Math.abs(document.querySelector('.flow-wrap').getBoundingClientRect().top-header.bottom)<=1,white:['.session-workbench','.canvas-column','.flow-wrap','.react-flow','.session-detail','.node-composer>textarea'].every(selector=>getComputedStyle(document.querySelector(selector)).backgroundColor==='rgb(255, 255, 255)'),neutralShell:['.window-titlebar','.icon-rail','.workspace-sidebar','.workspace-sidebar nav button.active','.sidebar-project-list button[aria-current=page]'].every(selector=>{const channels=getComputedStyle(document.querySelector(selector)).backgroundColor.match(/[0-9]+/g);return channels[0]===channels[1]&&channels[1]===channels[2]})&&getComputedStyle(document.querySelector('.workspace-sidebar')).backgroundColor==='rgb(253, 253, 253)',cornersMatchRequest:getComputedStyle(document.querySelector('.workspace-sidebar nav button.active')).borderTopLeftRadius==='8px'&&getComputedStyle(document.querySelector('.app-content')).borderTopLeftRadius==='0px'&&getComputedStyle(document.querySelector('.workspace-sidebar')).borderTopLeftRadius==='12px',canvasFillsColumn:Math.abs(document.querySelector('.flow-wrap').getBoundingClientRect().bottom-document.querySelector('.canvas-column').getBoundingClientRect().bottom)<=1,captionMatchesRail:getComputedStyle(document.querySelector('.window-titlebar')).backgroundColor===getComputedStyle(document.querySelector('.icon-rail')).backgroundColor&&getComputedStyle(document.querySelector('.window-titlebar')).getPropertyValue('-webkit-app-region')==='drag'&&getComputedStyle(document.querySelector('.window-titlebar')).backgroundColor==='rgb(249, 249, 249)',fillsViewport:['.icon-rail','.workspace-sidebar','.workspace-shell'].every(selector=>Math.abs(document.querySelector(selector).getBoundingClientRect().bottom-innerHeight)<=1)&&document.querySelector('.window-titlebar').getBoundingClientRect().height===32,contentAtTitlebar:Math.abs(document.querySelector('.app-content').getBoundingClientRect().top-document.querySelector('.window-titlebar').getBoundingClientRect().bottom)<=1}})()");
  }
  assert.deepEqual(await headerLayout(), { contained: true, separated: true, canvasAtHeader: true, white: true, neutralShell: true, cornersMatchRequest: true, canvasFillsColumn: true, captionMatchesRail: true, fillsViewport: true, contentAtTitlebar: true });
  await click('.project-statusbar button', '添加节点');
  assert.match(await evaluate("document.querySelector('dialog[open]').getAttribute('aria-label')"), /新增节点/);
  await poll(() => evaluate("document.querySelector('dialog select[aria-label=模型]')?.value==='default-model'"));
  await click('dialog button[aria-label="关闭弹窗"]');
  await screenshot('workflow.png');
  const originalWidth = await evaluate('innerWidth');
  await rpc('Emulation.setDeviceMetricsOverride', { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false });
  await poll(() => evaluate('innerWidth===1100'));
  assert.deepEqual(await headerLayout(), { contained: true, separated: true, canvasAtHeader: true, white: true, neutralShell: true, cornersMatchRequest: true, canvasFillsColumn: true, captionMatchesRail: true, fillsViewport: true, contentAtTitlebar: true });
  await screenshot('workflow-compact.png');
  await rpc('Emulation.clearDeviceMetricsOverride');
  await poll(() => evaluate(`innerWidth===${originalWidth}`));
  const bubbles = await verifyCollaboration();
  await click('button[aria-label="设置"]'); await click('.sidebar-project-list button', 'Preserved Project');
  await poll(() => evaluate("document.querySelector('.sidebar-project-list button[aria-current=page]')?.textContent==='Preserved Project'"));
  await click('.sidebar-project-list button', 'Unavailable project');
  await poll(() => evaluate("document.querySelector('[role=alert]')?.textContent.includes('Fixture project unavailable')"));
  assert.equal(await evaluate("document.querySelector('.sidebar-project-list button[aria-current=page]')?.textContent"), 'Preserved Project');
  await click('button[aria-label="关闭错误提示"]');

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
  writeFileSync(safe(join(fixture, 'result.json')), JSON.stringify({ passed: true, checks: ['settings without projects', 'global account commands', 'project selection retained', 'node context deletion and cancel', 'archived history and resource targeting', 'unfinished deletion blocked', 'zero nodes with history', 'shared account persists', 'annotated metadata and hints removed', 'project tab and header metadata removed', 'goal row removed without a gap', 'node heading status removed', 'toolbar fits at 1100px', 'zoom controls and bottom activity strip removed', 'canvas fills the full column in pure white', 'neutral gray navigation and Codex #FDFDFD sidebar', 'rounded navigation and square main content corner', 'footer and reserved bottom row removed', 'window caption only says Mixcat', 'workflow prefix removed', 'draggable title bar and icon rail match Codex #F9F9F9 frame', 'project submenu automatically expands', 'repeated project clicks collapse and reopen the list', 'project disclosure arrow removed', 'settings returns through sidebar', 'failed switch retains current project and accepts further updates', 'removed top tabs leave no gap', 'details drawer closes and frees the full canvas', 'Escape returns focus to drawer toggle', 'drawer preserves conversation and configuration drafts', 'node selection reopens the drawer', 'sidebar corner is rounded', 'real catalog default is shown and submitted', 'synthetic model and configuration footnotes removed', 'idle composer hint removed', 'project card action stays right aligned', 'node controls and message input retained'], collaboration: { bubbles, checks: ['explicit tool selection remains draft until save', 'saved native model and tool grant coexist', 'accepted source and target name snapshots', 'live task delivery state', 'incoming right and model output left', 'mouse reply location focuses source entry', 'source and target node drafts survive location', 'archived source opens and focuses project history', 'missing source entry locates retained receipt', 'missing original record is explicit', 'snapshot attachment uses restricted panel command', 'delta message metadata merges', 'actual project switch fences old generation'], limits: 'Controlled IPC data; existing settings page unmount lifetime is unchanged; no real account or model.' }, scope: 'Actual Electron renderer, preload, DOM and mouse hit testing with controlled IPC boundary; core and real Codex login are separate verification.' }, null, 2));
  console.log(JSON.stringify({ passed: true, evidence: fixture }));
} finally {
  try { if (socket?.readyState === 1) await evaluate('window.fixture.close()'); } catch {}
  socket?.close();
  if (child.exitCode === null) { await Promise.race([once(child, 'exit'), delay(3000)]); if (child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); }
  for (const entry of pending.values()) entry.reject(Error('Fixture closed')); pending.clear();
  writeFileSync(safe(join(fixture, 'electron.log')), log);
}
