import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WorkflowEngine } from '../src/core/engine.ts';
import { projectDirectory } from '../src/core/paths.ts';
import { openRendererFixture } from './human-review-electron-fixture.mjs';

const root = resolve('.'), evidence = projectDirectory(root, '.runtime', 'implementation', 'product-domain');
const fixture = mkdtempSync(join(evidence, 'electron-'));
const engine = new WorkflowEngine({ workbenchRoot: fixture, executable: 'unused', nativeFactory() { assert.fail('Canvas verification must not start a model'); } });
await engine.init();
const created = (await engine.command({ type: 'create_project', root: projectDirectory(fixture, 'product'), name: '产品定义验收', goal: 'A product definition with four independent conversations', template: 'web-product' })).snapshot.selected;
const projectId = created.project.id, requests = [];
let rejectMove = false, moveDelay = 0;
const bridge = createServer((request, response) => { let body = ''; request.on('data', chunk => body += chunk); request.on('end', () => { void (async () => {
  try { const envelope = JSON.parse(body); requests.push(envelope.command); if (envelope.command.type === 'move_nodes' && moveDelay) await new Promise(done => setTimeout(done, moveDelay)); if (rejectMove && envelope.command.type === 'move_nodes') { rejectMove = false; throw Error('Fixture refused group movement'); } response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(await engine.command(envelope.command, envelope.id))); }
  catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: String(error.message ?? error) })); }
})(); }); });
bridge.listen(0, '127.0.0.1'); await once(bridge, 'listening');
const url = `http://127.0.0.1:${bridge.address().port}`, preload = join(fixture, 'preload.cjs');
writeFileSync(preload, `const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('mixcat',{command:e=>ipcRenderer.invoke('command',e),subscribe:()=>()=>{},chooseDirectory:async()=>null,chooseAttachments:async()=>[],panel:async()=>({panels:[],activePanelId:null}),subscribePanels:()=>()=>{}});`);
writeFileSync(join(fixture, 'main.cjs'), `const{app,BrowserWindow,ipcMain}=require('electron');const{join}=require('node:path');for(const name of ['userData','sessionData','logs','crashDumps','temp'])app.setPath(name,join(${JSON.stringify(fixture)},name));app.commandLine.appendSwitch('disk-cache-dir',join(${JSON.stringify(fixture)},'cache'));ipcMain.handle('command',async(_,e)=>{const r=await fetch(${JSON.stringify(url)},{method:'POST',body:JSON.stringify(e)});const value=await r.json();if(!r.ok)throw Error(value.error);return value;});app.on('window-all-closed',()=>app.quit());app.whenReady().then(()=>{const win=new BrowserWindow({width:1700,height:1100,show:false,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});win.loadFile(${JSON.stringify(join(root,'dist/client/renderer/index.html'))});});`);
let browser;
try {
  browser = await openRendererFixture(root, fixture);
  const { evaluate, click, poll, screenshot, rpc, fill } = browser;
  const rendered = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const snapshot = async () => (await engine.command({ type: 'snapshot', projectId })).snapshot.selected;
  const positions = async () => Object.fromEntries((await snapshot()).nodes.map(node => [node.id, node.position]));
  const scene = () => evaluate(`(()=>{const box=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}};return {group:box(document.querySelector('.workflow-group')),nodes:[...document.querySelectorAll('.react-flow__node-conversation')].map(e=>({id:e.dataset.id,...box(e)})),labels:[...document.querySelectorAll('.condition-label')].map(box),canvas:box(document.querySelector('.flow-wrap'))}})()`);
  const overlap = (a, b) => Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x) + 1 && Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y) + 1;
  async function drag(selector, dx, dy) {
    const point = await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+Math.min(45,r.width/3),y:r.y+r.height/2}})()`);
    await rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    for (let step = 1; step <= 5; step++) await rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x + dx * step / 5, y: point.y + dy * step / 5, button: 'left', buttons: 1 });
    await rendered();
    const released = await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).closest('.react-flow__node').getBoundingClientRect();return {x:r.x,y:r.y,paths:[...document.querySelectorAll('.react-flow__edge-path')].map(e=>e.getAttribute('d'))}})()`);
    await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x + dx, y: point.y + dy, button: 'left', clickCount: 1 });
    await rendered();
    return released;
  }
  await click('.project-card', '产品定义验收');
  await poll(() => evaluate("document.querySelectorAll('.react-flow__node-conversation').length===8"));
  await screenshot('initial.png');
  assert.equal(await evaluate("document.querySelectorAll('.workflow-group').length"), 1, 'Four conversations must be enclosed in a product definition group');
  await click('button[aria-label="整理画布"]');
  await poll(() => requests.some(command => command.type === 'move_nodes' && command.edgeLayouts));
  await poll(() => evaluate("!document.querySelector('button[aria-label=\"整理画布\"]').disabled")); await rendered();
  const arranged = await scene();
  const members = ['product', 'requirements', 'design', 'design-test'];
  for (const node of arranged.nodes) {
    if (members.includes(node.id)) assert(node.x >= arranged.group.x && node.y >= arranged.group.y && node.x + node.width <= arranged.group.x + arranged.group.width && node.y + node.height <= arranged.group.y + arranged.group.height, `Member ${node.id} is outside its group`);
    else assert(!overlap(node, arranged.group), `Unrelated ${node.id} was packed into the group`);
  }
  for (let i = 0; i < arranged.labels.length; i++) {
    for (const node of arranged.nodes) assert(!overlap(arranged.labels[i], node), 'A condition obscures a node');
    for (let j = i + 1; j < arranged.labels.length; j++) assert(!overlap(arranged.labels[i], arranged.labels[j]), 'Conditions overlap');
  }
  await screenshot('arranged.png');
  writeFileSync(join(fixture, 'scene.json'), JSON.stringify(arranged, null, 2));
  const before = await positions(), moveCount = requests.filter(command => command.type === 'move_nodes').length;
  moveDelay = 700;
  const released = await drag('.workflow-group-title', 60, 35);
  const pending = await scene();
  assert(Math.abs(pending.group.x - released.x) < 1 && Math.abs(pending.group.y - released.y) < 1 && pending.group.x > arranged.group.x + 20, 'Released group stays at its dragged position while its save is pending');
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.react-flow__edge-path')].map(e=>e.getAttribute('d'))"), released.paths, 'Edges must not jump back when the pointer is released');
  await poll(() => requests.filter(command => command.type === 'move_nodes').length > moveCount);
  await poll(() => evaluate("!document.querySelector('button[aria-label=\"整理画布\"]').disabled"));
  moveDelay = 0;
  const moved = await positions(), delta = { x: moved.product.x - before.product.x, y: moved.product.y - before.product.y };
  assert(delta.x > 20 && delta.y > 10, 'Dragging the group must move its members');
  for (const id of Object.keys(before)) { const expected = members.includes(id) ? { x: before[id].x + delta.x, y: before[id].y + delta.y } : before[id]; assert(Math.abs(moved[id].x - expected.x) < .1 && Math.abs(moved[id].y - expected.y) < .1, `${id} moved incorrectly`); }
  const individual = requests.filter(command => command.type === 'move_node').length;
  await drag('.react-flow__node-conversation[data-id="design-test"] h3', 15, 15);
  await poll(() => requests.filter(command => command.type === 'move_node').length > individual);
  await poll(() => evaluate("!document.querySelector('button[aria-label=\"整理画布\"]').disabled"));
  assert.deepEqual((await snapshot()).groups[0].nodeIds, members);
  const beforeFailure = await positions(); rejectMove = true;
  await drag('.workflow-group-title', 30, 20);
  await poll(() => !rejectMove);
  await poll(() => evaluate("!document.querySelector('button[aria-label=\"整理画布\"]').disabled"));
  assert.deepEqual(await positions(), beforeFailure);
  await click('button[aria-label="编辑分组 产品定义"]');
  await fill('input[aria-label="分组名称"]', '产品定义已编辑');
  await click('button', '保存分组');
  await poll(() => evaluate("!document.querySelector('dialog')"));
  assert.equal((await snapshot()).groups[0].name, '产品定义已编辑');
  await click('.workflow-group-title strong');
  const keyboardBefore = await positions();
  await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
  await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
  await poll(async () => (await positions()).product.x === keyboardBefore.product.x + 10);
  await poll(() => evaluate("!document.querySelector('button[aria-label=\"整理画布\"]').disabled"));
  await rpc('Page.reload'); await click('.project-card', '产品定义验收');
  await poll(() => evaluate("document.querySelector('.workflow-group-title')?.textContent.includes('产品定义已编辑')"));
  await click('button[aria-label="编辑分组 产品定义已编辑"]'); await click('button', '解除分组');
  await poll(() => evaluate("document.querySelectorAll('.workflow-group').length===0"));
  assert.equal((await snapshot()).nodes.length, 8); assert.equal((await snapshot()).edges.length, 18);
  await click('.react-flow__node-conversation[data-id="product"] h3');
  await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'F10', code: 'F10', modifiers: 8, windowsVirtualKeyCode: 121 });
  await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F10', code: 'F10', modifiers: 8, windowsVirtualKeyCode: 121 });
  await click('button[role="menuitem"]', '创建分组'); await fill('input[aria-label="分组名称"]', '新产品组');
  await click('input[aria-label="成员 需求分析"]'); await click('button', '保存分组');
  await poll(() => evaluate("document.querySelectorAll('.workflow-group').length===1"));
  assert.deepEqual((await snapshot()).groups[0].nodeIds, ['product', 'requirements']);
  const result = { fixture, groupMovement: delta, nodeMinWidth: Math.min(...arranged.nodes.map(node => node.width)), group: arranged.group, groups: 1, conversations: 8, checks: ['arrangement', 'whole-group movement', 'member movement', 'failed-save rollback', 'edit', 'keyboard movement', 'reload', 'ungroup', 'create from context menu'] };
  writeFileSync(join(fixture, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} finally {
  await browser?.close(); await engine.close(); bridge.closeAllConnections(); await new Promise(done => bridge.close(done));
  writeFileSync(join(fixture, 'requests.json'), JSON.stringify(requests, null, 2));
}
