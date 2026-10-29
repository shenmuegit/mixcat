import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WorkflowEngine } from '../src/core/engine.ts';
import { ensureProjectDirectory, insideProject, projectDirectory } from '../src/core/paths.ts';
import { openRendererFixture } from './human-review-electron-fixture.mjs';

const root = ensureProjectDirectory(resolve('.'));
const evidence = projectDirectory(root, '.runtime', 'implementation', 'project-controls');
const fixture = ensureProjectDirectory(mkdtempSync(insideProject(root, join(evidence, 'electron-'))));
const engine = new WorkflowEngine({ workbenchRoot: fixture, executable: 'unused', nativeFactory() { assert.fail('UI management must not start a native model'); } });
await engine.init();
const projects = [];
for (const name of ['Alpha', 'Beta', 'Gamma']) {
  const path = projectDirectory(fixture, name.toLowerCase());
  writeFileSync(join(path, 'keep.txt'), `${name} project files`);
  const project = (await engine.command({ type: 'create_project', root: path, name, goal: 'Project controls fixture' })).snapshot.selected;
  projects.push(project.project);
}
const alpha = projects[0], beta = projects[1];
for (const [from, to] of [['plan', 'implement'], ['implement', 'review'], ['review', 'plan']]) {
  await engine.command({ type: 'save_edge', projectId: alpha.id, edge: { id: `${from}-${to}`, sourceNodeId: from, targetNodeId: to, condition: `${from} to ${to}`, revision: 0 } });
}
const bridge = createServer((request, response) => {
  let body = '';
  request.on('data', chunk => body += chunk);
  request.on('end', () => { void (async () => {
    try { const envelope = JSON.parse(body); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(await engine.command(envelope.command, envelope.id))); }
    catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: String(error.message ?? error) })); }
  })(); });
});
bridge.listen(0, '127.0.0.1'); await once(bridge, 'listening');
const bridgeUrl = `http://127.0.0.1:${bridge.address().port}`;
const preload = insideProject(fixture, join(fixture, 'preload.cjs'));
writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('mixcat',{command:e=>ipcRenderer.invoke('command',e),subscribe:()=>()=>{},chooseDirectory:async()=>null,chooseAttachments:async()=>[],panel:async()=>({panels:[],activePanelId:null}),subscribePanels:()=>()=>{}});`);
writeFileSync(insideProject(fixture, join(fixture, 'main.cjs')), `const{app,BrowserWindow,ipcMain}=require('electron');const{join}=require('node:path');for(const name of ['userData','sessionData','logs','crashDumps','temp'])app.setPath(name,join(${JSON.stringify(fixture)},name));app.commandLine.appendSwitch('disk-cache-dir',join(${JSON.stringify(fixture)},'cache'));ipcMain.handle('command',async(_,body)=>{const response=await fetch(${JSON.stringify(bridgeUrl)},{method:'POST',body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw Error(result.error);return result;});app.on('window-all-closed',()=>app.quit());app.whenReady().then(()=>{const win=new BrowserWindow({width:1600,height:1050,show:false,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});win.loadFile(${JSON.stringify(join(root,'dist/client/renderer/index.html'))});});`);
let browser;
const checks = [];
try {
  browser = await openRendererFixture(root, fixture);
  const { evaluate, rpc, click, fill, poll } = browser;
  const menu = '[role="menu"][aria-label="项目操作"]';
  const rightClick = async name => {
    const point = await evaluate(`(()=>{const e=[...document.querySelectorAll('.sidebar-project-list button')].find(e=>e.textContent===${JSON.stringify(name)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'right', clickCount: 1 });
    await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'right', clickCount: 1 });
    await poll(() => evaluate(`!!document.querySelector('${menu}')`));
  };
  const confirmDelete = async name => { await rightClick(name); await click(`${menu} button`, '删除项目'); await poll(() => evaluate("!!document.querySelector('dialog[open]')")); await click('dialog button', '确认删除'); await poll(() => evaluate("!document.querySelector('dialog')")); };
  await poll(() => evaluate("document.querySelectorAll('.project-card').length===3"));
  console.log('UI loaded; testing real input');
  await click('nav[aria-label="工作空间"] > button', '项目');
  await click('.sidebar-project-list button', 'Alpha');
  await poll(() => evaluate("document.querySelectorAll('.react-flow__edge').length===3"));
  const edgeStyles = () => evaluate("[...document.querySelectorAll('.react-flow__edge')].map(e=>({id:e.getAttribute('data-id'),stroke:getComputedStyle(e.querySelector('.react-flow__edge-path')).stroke,width:getComputedStyle(e.querySelector('.react-flow__edge-path')).strokeWidth,opacity:getComputedStyle(e.querySelector('.react-flow__edge-path')).opacity}))");
  let edges = await edgeStyles();
  assert.equal(edges.filter(edge => edge.width === '3px' && edge.opacity === '1').length, 2);
  assert(edges.every(edge => edge.opacity === '1'));
  assert.equal(edges.find(edge => edge.id.endsWith('implement-review')).stroke, 'rgb(136, 136, 136)');
  assert(edges.filter(edge => edge.width === '3px').every(edge => edge.stroke === 'rgb(37, 99, 235)'));
  await click('.react-flow__node[data-id="implement"] h3');
  await poll(async () => (await edgeStyles()).find(edge => edge.id.endsWith('review-plan'))?.width === '1.5px');
  edges = await edgeStyles(); assert.equal(edges.find(edge => edge.id.endsWith('implement-review')).width, '3px');
  assert(edges.every(edge => edge.opacity === '1'));
  assert.equal(edges.find(edge => edge.id.endsWith('review-plan')).stroke, 'rgb(136, 136, 136)');
  assert.equal(await evaluate("document.querySelectorAll('.condition-label.is-highlighted').length"), 2);
  assert(await evaluate("[...document.querySelectorAll('.condition-label')].every(e=>getComputedStyle(e).opacity==='1')"));
  await browser.screenshot('connected-edges.png'); checks.push('real node clicks color and thicken incoming/outgoing edges; unrelated edges and labels retain full opacity');

  await rightClick('Beta');
  assert.equal(await evaluate("document.querySelector('.sidebar-project-list [aria-current=page]').textContent"), 'Alpha');
  await browser.screenshot('project-context-menu.png');
  await click(`${menu} button`, '重命名'); await fill('dialog input', 'Beta renamed'); await click('dialog button', '保存名称');
  await poll(() => evaluate("[...document.querySelectorAll('.sidebar-project-name')].some(e=>e.textContent==='Beta renamed')"));
  assert.equal(await evaluate("document.querySelector('.sidebar-project-list [aria-current=page]').textContent"), 'Alpha');
  checks.push('right-clicking another project preserves current workflow and saves the correct project name');
  await click('.sidebar-project-list button', 'Alpha');
  await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'F10', code: 'F10', modifiers: 8, windowsVirtualKeyCode: 121 });
  await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F10', code: 'F10', modifiers: 8, windowsVirtualKeyCode: 121 });
  await poll(() => evaluate(`!!document.querySelector('${menu}')`));
  await click(`${menu} button`, '重命名'); await fill('dialog input', 'Alpha renamed'); await click('dialog button', '保存名称');
  await poll(() => evaluate("document.querySelector('.sidebar-project-list [aria-current=page]')?.textContent==='Alpha renamed'"));
  checks.push('Shift+F10 opens project operations and the active project can be renamed');

  await rightClick('Beta renamed'); await click(`${menu} button`, '删除项目');
  assert.match(await evaluate("document.querySelector('dialog').textContent"), /会话和历史记录都会保留/);
  await browser.screenshot('delete-project-confirmation.png'); await click('dialog button', '取消');
  assert.equal(await evaluate("document.querySelectorAll('.sidebar-project-list li').length"), 3);
  await confirmDelete('Beta renamed');
  assert.equal(await evaluate("document.querySelector('.sidebar-project-list [aria-current=page]').textContent"), 'Alpha renamed');
  assert.equal(readFileSync(join(beta.root, 'keep.txt'), 'utf8'), 'Beta project files');
  assert(existsSync(join(beta.root, '.mixcat/state/workflow.sqlite')));
  await confirmDelete('Alpha renamed');
  await poll(() => evaluate("document.querySelectorAll('.project-card').length===1 && !document.querySelector('.workbench')"));
  await confirmDelete('Gamma');
  await poll(() => evaluate("!!document.querySelector('.empty-workspace')"));
  checks.push('cancel retains projects; deleting another/active/last project updates navigation and retains project directories');
  await rpc('Page.reload'); await poll(() => evaluate("!!document.querySelector('.empty-workspace')"));
  assert.deepEqual(JSON.parse(readFileSync(join(fixture, '.runtime/client/projects.json'), 'utf8')), []);
  await click('button', '新建项目'); await fill('dialog input', 'Ignored new name'); await fill('dialog .input-with-button input', alpha.root); await click('dialog .modal-actions button', '创建项目');
  await poll(() => evaluate("document.querySelector('.sidebar-project-list [aria-current=page]')?.textContent==='Alpha renamed' && document.querySelectorAll('.react-flow__edge').length===3"));
  assert.equal(readFileSync(join(alpha.root, 'keep.txt'), 'utf8'), 'Alpha project files');
  const restored = (await engine.command({ type: 'snapshot', projectId: alpha.id })).snapshot.selected;
  assert.equal(restored.project.name, 'Alpha renamed'); assert.equal(restored.edges.length, 3);
  checks.push('removal survives reload and selecting the original directory restores the renamed project and workflow');
  await browser.screenshot('restored-project.png');
  writeFileSync(insideProject(root, join(evidence, 'ui-result.json')), JSON.stringify({ passed: true, fixture, checks, nativeModels: false }, null, 2));
  console.log(JSON.stringify({ passed: true, fixture, checks: checks.length }, null, 2));
} catch (error) { try { await browser?.screenshot('failure.png'); } catch {} throw error; }
finally { await browser?.close(); bridge.closeAllConnections(); await new Promise(resolve => bridge.close(resolve)); await engine.close(); }
