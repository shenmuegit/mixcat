import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WorkflowEngine } from '../src/core/engine.ts';
import { insideProject, projectDirectory } from '../src/core/paths.ts';
import { openRendererFixture } from './human-review-electron-fixture.mjs';

const root = resolve('.'), evidence = projectDirectory(root, '.runtime', 'implementation', 'notes-map');
const fixture = mkdtempSync(insideProject(root, join(evidence, 'electron-')));
const engine = new WorkflowEngine({ workbenchRoot: fixture, executable: 'unused', nativeFactory() { assert.fail('Note map interactions must not start an agent'); } });
await engine.init();
const getNotes = async () => (await engine.command({ type: 'get_notes' })).notes;
const mutate = async input => engine.command({ type: 'update_note', input: { request_id: crypto.randomUUID(), expected_revision: (await getNotes()).revision, ...input } });
const create = async (title, parentId = null) => (await mutate({ operation: 'create', title, parentId, body: `# ${title}\n\n交互验收正文。` })).noteId;
const firstRoot = await create('根甲'), branch = await create('拖动分支', firstRoot), leaf = await create('跟随叶子', branch);
await create('原同级', firstRoot);
const secondRoot = await create('根乙');
await create('目标现有分支', secondRoot);

const bridge = createServer((request, response) => {
  let body = ''; request.on('data', chunk => body += chunk);
  request.on('end', () => { void (async () => {
    try { const input = JSON.parse(body); const result = await engine.command(input.command, input.id); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(result)); }
    catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: String(error.message ?? error) })); }
  })(); });
});
bridge.listen(0, '127.0.0.1'); await once(bridge, 'listening');
const bridgeUrl = `http://127.0.0.1:${bridge.address().port}`, preload = join(fixture, 'preload.cjs');
writeFileSync(preload, `const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('mixcat',{command:e=>ipcRenderer.invoke('command',e),subscribe:()=>()=>{},chooseDirectory:async()=>null,chooseAttachments:async()=>[],setUnsaved:async()=>{},panel:async()=>({panels:[],activePanelId:null}),subscribePanels:()=>()=>{}});`);
writeFileSync(join(fixture, 'main.cjs'), `const{app,BrowserWindow,ipcMain}=require('electron');const{join}=require('node:path');for(const name of ['userData','sessionData','logs','crashDumps','temp'])app.setPath(name,join(${JSON.stringify(fixture)},name));app.commandLine.appendSwitch('disk-cache-dir',join(${JSON.stringify(fixture)},'cache'));ipcMain.handle('command',async(_,body)=>{const response=await fetch(${JSON.stringify(bridgeUrl)},{method:'POST',body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw Error(result.error);return result;});app.on('window-all-closed',()=>app.quit());app.whenReady().then(()=>{const win=new BrowserWindow({width:1500,height:1040,show:false,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});win.loadFile(${JSON.stringify(join(root,'dist/client/renderer/index.html'))});});`);

const checks = []; let browser;
try {
  browser = await openRendererFixture(root, fixture);
  const { click, evaluate, poll, rpc } = browser;
  await rpc('Page.enable');
  await evaluate("window.__errors=[];window.addEventListener('error',e=>window.__errors.push(e.message));window.addEventListener('unhandledrejection',e=>window.__errors.push(String(e.reason?.stack??e.reason)))");
  const frame = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const box = id => evaluate(`(()=>{const e=document.querySelector('.react-flow__node[data-id="${id}"]');if(!e)return null;const r=e.getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height,x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  const canvas = () => evaluate("JSON.parse(localStorage.getItem('mixcat.notes.canvas.v1'))");
  const key = async (key, code = key, modifiers = 0) => { for (const type of ['keyDown', 'keyUp']) await rpc('Input.dispatchKeyEvent', { type, key, code, modifiers }); };
  const focusNode = async id => { await click(`.note-topic[data-note-id="${id}"]`); await evaluate(`document.querySelector('.react-flow__node[data-id="${id}"]').focus({preventScroll:true})`); };
  const rightClick = async id => { const point = await box(id); assert(point, 'menu target is visible'); for (const type of ['mousePressed', 'mouseReleased']) await rpc('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'right', clickCount: 1 }); await poll(() => evaluate('!!document.querySelector("[role=menu][aria-label=笔记操作]")')); };
  async function mouseDrag(id, destination, during) {
    const start = await box(id); assert(start, 'drag source is visible');
    await rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x, y: start.y });
    await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', x: start.x, y: start.y, button: 'left', clickCount: 1 });
    for (let step = 1; step <= 12; step++) {
      const x = start.x + (destination.x - start.x) * step / 12, y = start.y + (destination.y - start.y) * step / 12;
      await rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 }); await frame();
      if (step === 6 && during) await during(await box(id));
    }
    await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', ...destination, button: 'left', clickCount: 1 });
    await frame();
  }
  async function confirmAction(action) {
    await action(); await poll(() => evaluate('!!document.querySelector("dialog.modal[open]")'));
    await click('dialog[open] .modal-actions button', '移入回收站');
  }
  await click('.workspace-sidebar nav > button', '笔记');
  await poll(() => evaluate('document.querySelectorAll(".note-topic").length===6'));
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".notes-map-pane")).backgroundColor'), 'rgb(255, 255, 255)', 'Grove note canvas has a white surface');
  assert.equal(await evaluate('!!document.querySelector(".notes-map-pane .react-flow__background")'), false, 'Grove note canvas has no dot or grid pattern');
  await click('.notes-map-actions button', '整理脑图'); await frame();
  const sourceBox = await box(branch), leafBox = await box(leaf), targetBox = await box(secondRoot);
  await mouseDrag(branch, { x: targetBox.left + sourceBox.width / 2, y: targetBox.top + sourceBox.height / 2 }, async current => {
    const movedLeaf = await box(leaf);
    assert(Math.abs((current.left - sourceBox.left) - (movedLeaf.left - leafBox.left)) < 3, 'descendant follows branch horizontal drag');
    assert(Math.abs((current.top - sourceBox.top) - (movedLeaf.top - leafBox.top)) < 3, 'descendant follows branch vertical drag');
  });
  await poll(async () => (await getNotes()).notes.find(note => note.id === branch)?.parentId === secondRoot);
  assert.equal((await getNotes()).notes.find(note => note.id === leaf).parentId, branch);
  const dropped = await box(branch), droppedLeaf = await box(leaf);
  assert(Math.abs(dropped.left - targetBox.left) < 3 && Math.abs(dropped.top - targetBox.top) < 3, 'reparenting keeps the branch at the pointer drop position');
  assert(Math.abs((dropped.left - sourceBox.left) - (droppedLeaf.left - leafBox.left)) < 3 && Math.abs((dropped.top - sourceBox.top) - (droppedLeaf.top - leafBox.top)) < 3, 'reparenting preserves the full branch offsets');
  assert((await canvas()).positions[branch] && (await canvas()).positions[leaf], 'reparented branch positions persist');
  checks.push('real mouse branch reparenting persists and descendants follow the drag');
  await click('.notes-map-actions button', '整理脑图'); await frame();
  const manualStart = await box(branch), manualLeaf = await box(leaf);
  await mouseDrag(branch, { x: manualStart.x + 100, y: manualStart.y + 100 });
  assert.equal((await getNotes()).notes.find(note => note.id === branch).parentId, secondRoot);
  const manualAfter = await box(branch), leafAfter = await box(leaf);
  assert(Math.abs((manualAfter.left - manualStart.left) - (leafAfter.left - manualLeaf.left)) < 3);
  assert(Math.abs((manualAfter.top - manualStart.top) - (leafAfter.top - manualLeaf.top)) < 3);
  const savedCanvas = await canvas(); assert(savedCanvas.positions[branch] && savedCanvas.positions[leaf]);
  await focusNode(branch); await key('Enter', 'Enter', 2);
  await poll(() => evaluate('!!document.querySelector(".notes-document-pane")'));
  await click('.notes-document-toolbar button', '脑图'); await frame();
  const returnedCanvas = await canvas();
  assert.deepEqual(returnedCanvas.positions, savedCanvas.positions);
  assert(Math.abs(returnedCanvas.viewport.x - savedCanvas.viewport.x) < 1 && Math.abs(returnedCanvas.viewport.y - savedCanvas.viewport.y) < 1 && Math.abs(returnedCanvas.viewport.zoom - savedCanvas.viewport.zoom) < .001, 'opening and returning preserves the viewport');
  checks.push('manual branch positions, descendant offsets and viewport survive open/return');

  const beforeTab = new Set((await getNotes()).notes.map(note => note.id));
  await focusNode(branch); await key('Tab');
  await poll(() => evaluate('!!document.querySelector("[aria-label=笔记标题]")'));
  const tabChild = (await getNotes()).notes.find(note => !beforeTab.has(note.id)); assert.equal(tabChild.parentId, branch);
  await click('.notes-document-toolbar button', '脑图'); await frame();
  await click('.notes-map-actions button', '整理脑图'); await frame();
  const beforeEnter = new Set((await getNotes()).notes.map(note => note.id));
  await focusNode(tabChild.id); await key('Enter');
  await poll(() => evaluate('!!document.querySelector("[aria-label=笔记标题]")'));
  const enterSibling = (await getNotes()).notes.find(note => !beforeEnter.has(note.id)); assert.equal(enterSibling.parentId, branch);
  await click('.notes-document-toolbar button', '脑图');
  checks.push('real Tab/Enter create child/sibling notes');

  await click('.notes-map-actions button', '整理脑图'); await frame();
  await rightClick(branch);
  const subtreeIds = [branch, leaf, tabChild.id, enterSibling.id];
  await confirmAction(() => click('[role=menuitem]', '删除'));
  await poll(async () => { const book = await getNotes(); return subtreeIds.every(id => book.notes.find(note => note.id === id)?.deletedAt); });
  assert.equal((await getNotes()).notes.find(note => note.id === secondRoot).deletedAt, undefined);
  await mutate({ operation: 'restore', id: branch });
  await poll(async () => { const book = await getNotes(); return subtreeIds.every(id => !book.notes.find(note => note.id === id)?.deletedAt); });
  await click('.workspace-sidebar nav > button', '项目'); await click('.workspace-sidebar nav > button', '笔记');
  await poll(() => evaluate('document.querySelectorAll(".note-topic").length===8'));
  checks.push('client confirmation recycles a whole subtree and public recovery retains stable identities');

  await click('.notes-map-actions button', '整理脑图'); await frame();
  await click(`.note-topic[data-note-id="${firstRoot}"]`);
  const handle = (id, name) => evaluate(`(()=>{const e=document.querySelector('.note-topic[data-note-id="${id}"] [data-handleid="${name}"]');const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  const wireStart = await handle(firstRoot, 'right-out'), wireEnd = await handle(secondRoot, 'left-in');
  await rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', ...wireStart }); await frame();
  await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', ...wireStart, button: 'left', clickCount: 1 });
  for (let step = 1; step <= 12; step++) { await rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', x: wireStart.x + (wireEnd.x - wireStart.x) * step / 12, y: wireStart.y + (wireEnd.y - wireStart.y) * step / 12, buttons: 1, button: 'left' }); await frame(); }
  await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', ...wireEnd, button: 'left', clickCount: 1 });
  await poll(async () => (await getNotes()).notes.find(note => note.id === firstRoot).relatedIds.includes(secondRoot));
  assert((await getNotes()).notes.find(note => note.id === secondRoot).relatedIds.includes(firstRoot));
  checks.push('real handle dragging creates a symmetric note association');
  assert.deepEqual(await evaluate('window.__errors'), []);
  await browser.screenshot('notes-map-accepted.png');
  writeFileSync(join(fixture, 'result.json'), JSON.stringify({ passed: true, checks }, null, 2));
  console.log(JSON.stringify({ passed: true, fixture, checks }, null, 2));
} catch (error) { try { console.error(await browser?.evaluate('JSON.stringify(window.__errors)')); await browser?.screenshot('failure.png'); } catch {} throw error; }
finally { await browser?.close(); bridge.closeAllConnections(); await new Promise(resolve => bridge.close(resolve)); await engine.close(); }
