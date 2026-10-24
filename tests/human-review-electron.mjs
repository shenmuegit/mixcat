import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { openRendererFixture } from './human-review-electron-fixture.mjs';
import { projectDirectory, insideProject } from '../src/core/paths.ts';

// The bridge controls responses; App, SnapshotReceiver, Workbench and native PanelHost are production code.
const root = resolve('.'), base = projectDirectory(root, '.runtime', 'implementation', 'human-review-20261022', 'fixtures');
const fixture = mkdtempSync(join(base, 'review-renderer-'));
const path = name => insideProject(root, join(fixture, name));
for (const name of ['tmp', 'appdata', 'localappdata', 'home', 'cache', 'userData', 'sessionData', 'logs', 'crashDumps', 'temp', '.mixcat/attachments']) projectDirectory(fixture, name);
const documentPath = '.mixcat/attachments/fixed.md', imagePath = '.mixcat/attachments/fixed.png';
writeFileSync(path(documentPath), '# 固定需求\n原始材料 <script>window.injected=true</script>');
writeFileSync(path('需求.md'), '# 已修改的源文件，不能代替固定材料');
const node = (id, name, x) => ({ id, name, instructions: '保留职责', tools: ['get_project_context'], model: 'chosen', skills: [], plugins: [], resultSchema: {}, position: { x, y: 0 }, revision: 1, threadId: null, status: 'idle' });
const project = { id: 'p', name: '核对 Fixture', root: fixture, goal: 'Controlled renderer verification', mode: 'codex', status: 'blocked', updatedAt: '' };
const review = { id: 'review-1', projectId: 'p', checkpointId: 'direction', checkpointRevision: 1, version: 1, requestId: 'request-1', nodeId: 'product', taskId: 'source-task', threadId: 'source-thread', turnId: 'source-turn', callId: 'source-call', title: '需求方案', content: '<img src=x onerror="window.injected=true">\n自由正文', attachments: [{ artifact_id: 'fixed-md', name: '需求.md', relativePath: documentPath, sha256: 'md-hash', size: 99 }, { artifact_id: 'fixed-png', name: '方案.png', relativePath: imagePath, sha256: 'png-hash', size: 68 }], sourceFiles: [{ path: '需求.md', sha256: 'source-hash', size: 99 }], upstreamDependencies: [], bundleHash: 'bundle-1', status: 'pending', createdAt: '2026-10-24T00:00:00Z', decision: null, supersededBy: null };
const selected = { project, nodes: [node('product', '产品', 0), node('design', '设计', 350)], tasks: [{ id: 'wait', nodeId: 'product', instruction: '原始等待输入', status: 'waiting_review', reviewDependencies: [{ checkpointId: 'direction', checkpointRevision: 1, reviewId: 'review-1', version: 1 }] }], handoffs: [], activities: [], conversation: [], reviewPolicy: { revision: 1, checkpoints: [{ id: 'direction', name: '产品方向', ownerNodeId: 'product', requiredForNodeIds: ['design'], dependsOn: [], revision: 1 }] }, humanReviews: [review] };
await build({ stdin: { contents: `import React from 'react';import{createRoot}from'react-dom/client';import App from './src/renderer/App.tsx';import './src/renderer/styles.css';createRoot(document.getElementById('root')).render(<App/>);`, resolveDir: root, loader: 'tsx' }, outfile: path('renderer.js'), bundle: true, format: 'iife', platform: 'browser', logLevel: 'silent' });
writeFileSync(path('index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="renderer.css"><div id="root"></div><script src="renderer.js"></script>');
writeFileSync(path('preload.cjs'), `const{contextBridge,ipcRenderer}=require('electron');let panelSettled=0;contextBridge.exposeInMainWorld('mixcat',{command:c=>ipcRenderer.invoke('command',c),inspect:id=>ipcRenderer.invoke('inspect',id),subscribe:fn=>{const l=(_,u)=>fn(u);ipcRenderer.on('update',l);return()=>ipcRenderer.removeListener('update',l)},panel:async c=>{try{return await ipcRenderer.invoke('panel',c);}finally{if(c.type==='open')panelSettled++;}},subscribePanels:fn=>{const l=(_,s)=>fn(s);ipcRenderer.on('panels',l);return()=>ipcRenderer.removeListener('panels',l)},chooseAttachments:async()=>[]});contextBridge.exposeInMainWorld('fixture',(m,p)=>m==='panelSettled'?Promise.resolve(panelSettled):ipcRenderer.invoke('fixture',m,p));`);
await build({ stdin: { contents: `
import{app,BrowserWindow,ipcMain,protocol,nativeImage}from'electron';import{join}from'node:path';import{writeFileSync}from'node:fs';import{PanelHost}from'./src/desktop/panels.ts';
import{CommandDispatcher}from'./src/core/commands.ts';
protocol.registerSchemesAsPrivileged([{scheme:'mixcat-preview',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true}}]);
const fixture=${JSON.stringify(fixture)};for(const name of ['userData','sessionData','logs','crashDumps','temp'])app.setPath(name,join(fixture,name));app.commandLine.appendSwitch('disk-cache-dir',join(fixture,'cache'));
let win,panels,revision=1,selected=${JSON.stringify(selected)},envelopes=[],receiptReads=[],rejectDecision=null,fail=true,hold=false,release,panelHold=false,panelRelease;
const projects=[selected.project,{...selected.project,id:'q',name:'另一个项目'}];
const snapshot=()=>({generation:1,revision,projects,runtime:null,selected:structuredClone(selected)});
const publish=()=>{revision++;const state=snapshot();panels.observe(state);win.webContents.send('update',{kind:'full',snapshot:state});};
const reviewDispatcher=new CommandDispatcher({async command(c,actionId){
 if(rejectDecision){const rejected=rejectDecision;rejectDecision=null;throw Object.assign(Error('fixture terminal validation failure'),rejected==='cancelled'?{code:'COMMAND_CANCELLED'}:{});}
 const target=selected.humanReviews.find(r=>r.id===c.reviewId);const reply=snapshot();
 if(hold)await new Promise(resolve=>{release=resolve;});
 if(target){target.status=c.type==='withdraw_review'?'withdrawn':c.decision;if(c.type==='decide_review')target.decision={commandId:actionId,reviewId:c.reviewId,version:c.version,bundleHash:c.bundleHash,decision:c.decision,comment:c.comment,createdAt:'fixture-time',continuationTaskId:'fixture-continuation'};}
 if(reply.selected.project.id!==selected.project.id){reply.revision=++revision;reply.selected.humanReviews=target?[structuredClone(target)]:[];return{snapshot:reply};}
 publish();
 return{snapshot:snapshot()};}});
ipcMain.handle('inspect',(_,id)=>{receiptReads.push(id);return reviewDispatcher.inspect(id);});
ipcMain.handle('command',async(_,envelope)=>{envelopes.push(envelope);const c=envelope.command;
if(c.type==='snapshot'&&c.projectId&&c.projectId!==selected.project.id){selected={...selected,project:projects.find(p=>p.id===c.projectId),humanReviews:[],tasks:[]};revision++;}
if(c.type==='decide_review'||c.type==='withdraw_review'){if(fail){fail=false;throw Error('fixture lost response before dispatch');}return reviewDispatcher.dispatch(envelope);}
if(c.type==='cancel_review_task'){selected.tasks=selected.tasks.map(t=>t.id===c.taskId?{...t,status:'cancelled'}:t);publish();}
const state=snapshot();panels.observe(state);return{snapshot:state};});
ipcMain.handle('panel',async(_,c)=>{if(c.type==='open'&&panelHold)await new Promise(resolve=>{panelRelease=resolve;});return panels.command(c);});
ipcMain.handle('fixture',async(_,method,payload)=>{
 if(method==='inspect')return{envelopes,receiptReads,selected,held:!!release,panelHeld:!!panelRelease,panels:[...panels.entries.values()].map(e=>({panel:e.panel,visible:e.view.getVisible()}))};
 if(method==='rejectDecision'){rejectDecision=payload;return;}
 if(method==='hold'){hold=true;return;}
 if(method==='release'){hold=false;const resolve=release;release=undefined;resolve();return;}
 if(method==='panelHold'){panelHold=true;return;}
 if(method==='panelRelease'){panelHold=false;const resolve=panelRelease;panelRelease=undefined;resolve();return;}
 if(method==='version'){const old=selected.humanReviews.at(-1);old.status='superseded';old.supersededBy='review-'+payload;selected.humanReviews.push({...structuredClone(old),id:'review-'+payload,version:payload,requestId:'request-'+payload,bundleHash:'bundle-'+payload,status:'pending',decision:null,supersededBy:null});publish();return;}
 if(method==='delta'){revision++;win.webContents.send('update',{kind:'delta',generation:1,revision,baseRevision:revision-1,projectId:selected.project.id,projects,runtime:null,selected:{...selected,humanReviews:selected.humanReviews.map(r=>({...r,title:r.title+' delta'}))},entries:[]});return;}
 if(method==='guest'){const entry=[...panels.entries.values()].find(e=>e.panel.path?.endsWith(payload.endsWith));return entry?entry.view.webContents.executeJavaScript(payload.expression):null;}
 if(method==='guestCapture'){const entry=[...panels.entries.values()].find(e=>e.panel.path?.endsWith(payload));return(await entry.view.webContents.capturePage()).toPNG().toString('base64');}
 if(method==='pixels'){const img=await win.webContents.capturePage();const data=img.toBitmap();let gray=0;for(let i=0;i<data.length;i+=4)if(data[i]===data[i+1]&&data[i+1]===data[i+2])gray++;return{grayRatio:gray/(data.length/4)};}
});
app.whenReady().then(()=>{const bitmap=Buffer.alloc(320*180*4,255);for(let y=24;y<156;y++)for(let x=24;x<296;x++){const shade=y<48?90:y<60||y>148||x<32||x>288?210:240;const i=(y*320+x)*4;bitmap[i]=bitmap[i+1]=bitmap[i+2]=shade;}writeFileSync(join(fixture,${JSON.stringify(imagePath)}),nativeImage.createFromBitmap(bitmap,{width:320,height:180}).toPNG());win=new BrowserWindow({width:1550,height:1050,show:false,webPreferences:{preload:join(fixture,'preload.cjs'),contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});panels=new PanelHost(win,state=>win.webContents.send('panels',state));win.webContents.once('did-finish-load',()=>win.showInactive());win.loadFile(join(fixture,'index.html'));});app.on('window-all-closed',()=>app.quit());`, resolveDir: root, loader: 'ts' }, outfile: path('main.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' });

const driver = await openRendererFixture(root, fixture);
const { evaluate, rpc, poll, click, fill, screenshot } = driver;
const inspect = () => evaluate("window.fixture('inspect')");
const fixtureCall = (method, payload) => evaluate(`window.fixture(${JSON.stringify(method)},${JSON.stringify(payload)})`);
async function releasePanel() {
  const before = await fixtureCall('panelSettled');
  await fixtureCall('panelRelease');
  await poll(async () => await fixtureCall('panelSettled') > before);
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
}
const card = '[data-review-id="review-1"]';
async function key(key, code, value) { await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: value, ...(key === 'Enter' ? { text: '\r' } : {}) }); await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: value }); }
try {
  await poll(() => evaluate("!!document.querySelector('.project-card')"));
  await click('.project-card', '核对 Fixture');
  await poll(() => evaluate("document.querySelector('.project-statusbar')?.textContent.includes('待人工核对 1')"));
  await click('.project-statusbar button', '待人工核对 1');
  assert.match(await evaluate("document.querySelector('dialog').textContent"), /需求方案/);
  await click('dialog button[aria-label="关闭弹窗"]');
  await poll(() => evaluate(`!!document.querySelector('${card}')`));
  assert.equal(await evaluate('window.injected'), undefined);
  assert.equal(await evaluate(`document.querySelector('${card} .review-body').textContent`), review.content);
  await fill('#task-instruction', '  原始自由输入\n保留  ');
  await click(`${card} .review-actions button`, '提出修改');
  assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'), '原始用户意见');
  await click(`${card} .review-confirm button`, '保留未决');
  await poll(() => evaluate('document.activeElement.textContent==="通过"'));
  assert.equal(await evaluate('document.activeElement.textContent'), '通过');
  assert.equal((await inspect()).envelopes.filter(e => e.command.type === 'decide_review').length, 0);
  await click(`${card} .review-actions button`, '提出修改');
  const comment = '  原始用户意见\n保持空格  ';
  await fill(`${card} textarea`, comment);
  await key('Tab', 'Tab', 9); await key('Tab', 'Tab', 9); await key('Enter', 'Enter', 13);
  await poll(() => evaluate(`document.querySelector('${card}').textContent.includes('结果尚未确认')`));
  await screenshot('unknown-decision.png');
  await click('nav[aria-label="工作空间"] > button', '项目');
  await click('.project-card', '核对 Fixture');
  await poll(() => evaluate(`document.querySelector('${card}')?.textContent.includes('结果尚未确认')`));
  await fill('#task-instruction', '  原始自由输入\n保留  ');
  await fixtureCall('hold');
  const repeatPoint = await evaluate(`(()=>{const button=[...document.querySelectorAll('${card} button')].find(e=>e.textContent.includes('重试原操作'));button.scrollIntoView({block:'nearest'});const r=button.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await click(`${card} button`, '重试原操作');
  await poll(async () => (await inspect()).held);
  // Repeat the native mouse click at the same target while the request is held.
  await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', ...repeatPoint, button: 'left', clickCount: 2 });
  await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', ...repeatPoint, button: 'left', clickCount: 2 });
  const pending = (await inspect()).envelopes.filter(e => e.command.type === 'decide_review');
  assert.equal(pending.length, 2); assert.equal(pending[0].id, pending[1].id); assert.deepEqual(pending[0].command, pending[1].command);
  assert.equal(pending[0].command.comment, comment);
  assert.equal(pending[0].command.bundleHash, 'bundle-1');
  await click('.react-flow__node[data-id="design"]');
  await fixtureCall('release');
  await poll(async () => (await inspect()).selected.humanReviews[0].status === 'changes_requested');
  assert.match(await evaluate("document.querySelector('.detail-heading h2').textContent"), /设计/);
  await poll(() => evaluate('document.activeElement.getAttribute("aria-label")?.includes("设计")'));
  assert.match(await evaluate('document.activeElement.getAttribute("aria-label")'), /设计/);
  await click('.react-flow__node[data-id="product"]');
  await poll(() => evaluate(`document.querySelector('${card}').textContent.includes('用户决定')`));
  assert.equal(await evaluate(`document.querySelector('${card} .review-decision pre').textContent`), comment);
  assert.equal(await evaluate("document.querySelector('#task-instruction').value"), '  原始自由输入\n保留  ');
  await click(`${card} button`, '打开附件：需求.md');
  await poll(async () => (await inspect()).panels.some(e => e.visible && e.panel.path.endsWith('fixed.md')));
  await poll(() => fixtureCall('guest', { endsWith: 'fixed.md', expression: "document.body.textContent.includes('# 固定需求')" }));
  assert.equal(await fixtureCall('guest', { endsWith: 'fixed.md', expression: 'typeof window.injected' }), 'undefined');
  await screenshot('fixed-markdown-native-panel.png');
  writeFileSync(path('fixed-markdown-guest.png'), Buffer.from(await fixtureCall('guestCapture', 'fixed.md'), 'base64'));
  await click('#tab-conversation'); await click(`${card} button`, '打开附件：方案.png');
  await poll(async () => (await inspect()).panels.some(e => e.visible && e.panel.path.endsWith('fixed.png')));
  await poll(() => fixtureCall('guest', { endsWith: 'fixed.png', expression: "document.querySelector('img')?.naturalWidth===320" }));
  await screenshot('fixed-image-native-panel.png');
  writeFileSync(path('fixed-image-guest.png'), Buffer.from(await fixtureCall('guestCapture', 'fixed.png'), 'base64'));
  await click('#tab-conversation');
  await fixtureCall('version', 2);
  await poll(() => evaluate("document.querySelector('[data-review-id=review-2]')?.textContent.includes('版本 2')"));
  await click('[data-review-id=review-2] button', '通过');
  await fixtureCall('version', 3);
  await poll(() => evaluate("!!document.querySelector('[data-review-id=review-3]')"));
  assert.equal(await evaluate("!!document.querySelector('[data-review-id=review-3] .review-confirm')"), false);
  assert.equal(await evaluate("document.querySelector('[data-review-id=review-2]')?.textContent.includes('已被替代')"), true);
  assert.equal(await evaluate("!!document.querySelector('[data-review-id=review-2] .review-confirm')"), false);
  await fixtureCall('delta');
  await poll(() => evaluate("document.querySelector('[data-review-id=review-3] h3')?.textContent.includes('delta')"));
  const pixels = await fixtureCall('pixels'); assert(pixels.grayRatio > .95, JSON.stringify(pixels));
  await screenshot('current-and-history.png');
  await click('.review-wait button', '取消等待任务'); await click('.review-wait button', '保留等待任务');
  assert.equal((await inspect()).envelopes.some(e => e.command.type === 'cancel_review_task'), false);
  await click('.review-wait button', '取消等待任务'); await click('.review-wait button', '确认取消等待任务');
  await poll(() => evaluate('!document.querySelector(".review-wait")'));
  await click('[data-review-id=review-3] button', '通过'); await click('[data-review-id=review-3] .review-confirm button', '确认通过');
  await poll(() => evaluate("document.querySelector('[data-review-id=review-3] .review-decision')?.textContent.includes('已通过')"));
  const approved = (await inspect()).envelopes.find(e => e.command.type === 'decide_review' && e.command.reviewId === 'review-3');
  assert.equal(approved.command.decision, 'approved'); assert.equal(approved.command.bundleHash, 'bundle-3');
  await fixtureCall('version', 4);
  await click('[data-review-id=review-4] button', '撤回未决事项');
  await poll(() => evaluate("document.activeElement.textContent.includes('确认撤回版本 4')"));
  await key('Enter', 'Enter', 13);
  await poll(() => evaluate("document.querySelector('[data-review-id=review-4]')?.textContent.includes('已撤回')"));
  await fixtureCall('version', 5);
  await click('[data-review-id=review-5] button', '提出修改');
  const rejectedComment = '  被拒绝的原始意见\n保留空格  ';
  await fill('[data-review-id=review-5] textarea', rejectedComment);
  await fixtureCall('rejectDecision', 'failed');
  await click('[data-review-id=review-5] .review-confirm button', '确认提出修改');
  await poll(() => evaluate("document.querySelector('[data-review-id=review-5] .review-failure')?.textContent.includes('fixture terminal validation failure')"));
  assert.equal(await evaluate("document.querySelector('[data-review-id=review-5] textarea').value"), rejectedComment);
  const failed = (await inspect()).envelopes.find(e => e.command.reviewId === 'review-5');
  assert.equal(await evaluate(`window.mixcat.inspect(${JSON.stringify(failed.id)}).then(r=>r.status)`), 'failed');
  await click('nav[aria-label="工作空间"] > button', '项目'); await click('.project-card', '核对 Fixture');
  await poll(() => evaluate("!!document.querySelector('[data-review-id=review-5] textarea')"));
  assert.equal(await evaluate("document.querySelector('[data-review-id=review-5] textarea').value"), rejectedComment);
  const tooLong = `  ${'长'.repeat(19997)}\n `;
  assert.equal(tooLong.length, 20001);
  await fill('[data-review-id=review-5] textarea', tooLong);
  assert.equal(await evaluate("document.querySelector('[data-review-id=review-5] textarea').value"), tooLong);
  await poll(() => evaluate("document.querySelector('[data-review-id=review-5] .review-confirm [role=alert]')?.textContent.includes('20000')"));
  assert.equal(await evaluate("document.querySelector('[data-review-id=review-5] .review-confirm .primary').disabled"), true);
  await evaluate("document.querySelector('[data-review-id=review-5] form').requestSubmit()");
  assert.equal((await inspect()).envelopes.filter(e => e.command.reviewId === 'review-5').length, 1);
  const corrected = '  修正后的意见\n仍保留空格  ';
  await fill('[data-review-id=review-5] textarea', corrected); await click('[data-review-id=review-5] .review-confirm button', '确认提出修改');
  await poll(() => evaluate("document.querySelector('[data-review-id=review-5] .review-decision')?.textContent.includes('已提出修改')"));
  const correction = (await inspect()).envelopes.filter(e => e.command.reviewId === 'review-5');
  assert.equal(correction.length, 2); assert.notEqual(correction[0].id, correction[1].id);
  assert.equal(correction[0].command.comment, rejectedComment); assert.equal(correction[1].command.comment, corrected);
  await fixtureCall('version', 6);
  await click('[data-review-id=review-6] button', '通过'); await fill('[data-review-id=review-6] textarea', rejectedComment);
  await fixtureCall('rejectDecision', 'cancelled'); await click('[data-review-id=review-6] .review-confirm button', '确认通过');
  await poll(() => evaluate("!!document.querySelector('[data-review-id=review-6] .review-failure')"));
  const cancelled = (await inspect()).envelopes.find(e => e.command.reviewId === 'review-6');
  assert.equal(await evaluate(`window.mixcat.inspect(${JSON.stringify(cancelled.id)}).then(r=>r.status)`), 'cancelled');
  assert.equal(await evaluate("document.querySelector('[data-review-id=review-6] textarea').value"), rejectedComment);
  await click('[data-review-id=review-6] .review-confirm button', '保留未决');
  await click('[data-review-id=review-6] button', '撤回未决事项'); await click('[data-review-id=review-6] .review-confirm button', '确认撤回');
  await poll(() => evaluate("document.querySelector('[data-review-id=review-6]')?.textContent.includes('已撤回')"));
  const withdrawal = (await inspect()).envelopes.filter(e => e.command.reviewId === 'review-6');
  assert.equal(withdrawal.length, 2); assert.notEqual(withdrawal[0].id, withdrawal[1].id); assert.equal(withdrawal[1].command.type, 'withdraw_review');
  assert((await inspect()).receiptReads.includes(pending[0].id), 'unknown command receipt was inspected before same-ID retry');
  await screenshot('terminal-failure-recovered.png');
  await fixtureCall('version', 7);
  await fixtureCall('panelHold');
  await click('[data-review-id=review-7] button', '打开附件：需求.md');
  await poll(async () => (await inspect()).panelHeld);
  await click('.react-flow__node[data-id="design"]');
  await releasePanel();
  assert.match(await evaluate("document.querySelector('.detail-heading h2').textContent"), /设计/);
  assert.equal(await evaluate("document.querySelector('#tab-conversation').getAttribute('aria-selected')"), 'true');
  await click('.react-flow__node[data-id="product"]');
  await fixtureCall('panelHold');
  await click('[data-review-id=review-7] button', '打开附件：需求.md');
  await poll(async () => (await inspect()).panelHeld);
  await click('#tab-config');
  await releasePanel();
  assert.equal(await evaluate("document.querySelector('#tab-config').getAttribute('aria-selected')"), 'true');
  await click('#tab-conversation');
  await fixtureCall('panelHold');
  await click('[data-review-id=review-7] button', '打开附件：需求.md');
  await poll(async () => (await inspect()).panelHeld);
  await click('.project-controls button', '节点详情');
  assert.equal(await evaluate("document.querySelector('.project-controls [aria-controls=\"node-details-drawer\"]').getAttribute('aria-expanded')"), 'false');
  await releasePanel();
  assert.equal(await evaluate("document.querySelector('.project-controls [aria-controls=\"node-details-drawer\"]').getAttribute('aria-expanded')"), 'false', 'late material must not reopen a view the user closed');
  assert.equal((await inspect()).panels.some(entry => entry.visible), false, 'late material must not expose a native view after close');
  await screenshot('closed-view-survives-late-material.png');
  await click('.project-controls button', '节点详情');
  await click('#tab-conversation');
  await fixtureCall('panelHold');
  await click('[data-review-id=review-7] button', '打开附件：需求.md');
  await poll(async () => (await inspect()).panelHeld);
  await click('#sidebar-project-list button', '另一个项目');
  await poll(() => evaluate("document.querySelector('.project-statusbar')?.textContent.includes('待人工核对 0')"));
  await releasePanel();
  assert.equal(await evaluate("!!document.querySelector('[data-review-id=review-7]')"), false);
  assert.equal((await inspect()).panels.some(entry => entry.visible && entry.panel.projectId === 'p'), false);
  assert.equal(await evaluate("document.querySelector('#tab-conversation').getAttribute('aria-selected')"), 'true');
  console.log(JSON.stringify({ result: 'PASS', fixture, pixels, checks: ['production App envelope reuses exact action after lost response and reopen', 'real mouse hit tests and keyboard confirmation', 'focus return and raw comment/input preserved', 'duplicate click suppressed', 'node switch ignores delayed focus and material response', 'new version clears old confirmation', 'full/delta SnapshotReceiver', 'native PanelHost fixed Markdown and image despite changed source', 'white gray pixels', 'approve and withdraw exact versions', 'task cancellation confirmation', 'late prior project material response fenced', 'verified failed receipt restores exact raw opinion across reopen', '20001 character opinion remains intact and blocked without a command', 'explicit correction uses a new ID after failure', 'verified cancelled receipt allows explicit withdrawal', 'closed details and hidden native view survive delayed material open'], nativeModels: false, humanApproval: false }));
} catch (error) { try { await screenshot('failure.png'); } catch {} throw error; }
finally { await driver.close(); }
