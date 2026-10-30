import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WorkflowEngine } from '../src/core/engine.ts';
import { insideProject, projectDirectory } from '../src/core/paths.ts';
import { openRendererFixture } from './human-review-electron-fixture.mjs';

const root = resolve('.'), evidence = projectDirectory(root, '.runtime', 'implementation', 'notes-canvas');
const fixture = mkdtempSync(insideProject(root, join(evidence, 'electron-')));
const engine = new WorkflowEngine({ workbenchRoot: fixture, executable: 'unused', nativeFactory() { assert.fail('Canvas gestures do not start an agent'); } });
await engine.init();
const getNotes = async () => (await engine.command({ type: 'get_notes' })).notes;
const mutate = async input => engine.command({ type: 'update_note', input: { request_id: crypto.randomUUID(), expected_revision: (await getNotes()).revision, ...input } });
const create = async (title, parentId = null) => (await mutate({ operation: 'create', parentId, title, body: `正文 ${title}` })).noteId;
const parent = await create('原父笔记'), branch = await create('需要按真实边界拖动的长标题'.repeat(4), parent), leaf = await create('跟随的后代笔记', branch);
const target = await create('目标父笔记'), sibling = await create('目标已有子笔记', target), untouched = await create('独立笔记');
const positions = { [parent]: { x: 60, y: 250 }, [branch]: { x: 330, y: 250 }, [leaf]: { x: 650, y: 250 }, [target]: { x: 650, y: 450 }, [sibling]: { x: 920, y: 450 }, [untouched]: { x: 60, y: 900 } };
let failMove = false, moveGate, releaseMove;
const bridge = createServer((request, response) => {
  let body = ''; request.on('data', chunk => body += chunk);
  request.on('end', () => { void (async () => {
    try {
      const input = JSON.parse(body);
      if (input.command?.type === 'update_note' && input.command.input.operation === 'move') {
        if (moveGate) { moveGate.entered = true; await moveGate.promise; }
        if (failMove) { failMove = false; throw Error('Controlled relationship write failure'); }
      }
      const result = await engine.command(input.command, input.id); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(result));
    } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: String(error.message ?? error) })); }
  })(); });
});
bridge.listen(0, '127.0.0.1'); await once(bridge, 'listening');
const bridgeUrl = `http://127.0.0.1:${bridge.address().port}`, preload = join(fixture, 'preload.cjs');
writeFileSync(preload, `const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('mixcat',{command:e=>ipcRenderer.invoke('command',e),subscribe:()=>()=>{},chooseDirectory:async()=>null,chooseAttachments:async()=>[],setUnsaved:async()=>{},panel:async()=>({panels:[],activePanelId:null}),subscribePanels:()=>()=>{}});`);
writeFileSync(join(fixture, 'main.cjs'), `const{app,BrowserWindow,ipcMain}=require('electron');const{join}=require('node:path');for(const name of ['userData','sessionData','logs','crashDumps','temp'])app.setPath(name,join(${JSON.stringify(fixture)},name));app.commandLine.appendSwitch('disk-cache-dir',join(${JSON.stringify(fixture)},'cache'));ipcMain.handle('command',async(_,body)=>{const response=await fetch(${JSON.stringify(bridgeUrl)},{method:'POST',body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw Error(result.error);return result;});app.on('window-all-closed',()=>app.quit());app.whenReady().then(()=>{const win=new BrowserWindow({width:1500,height:1040,show:false,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});win.loadFile(${JSON.stringify(join(root,'dist/client/renderer/index.html'))});});`);

let browser, phase = 'initialization'; const checks = [];
try {
  browser = await openRendererFixture(root, fixture);
  const { rpc, evaluate, poll, click } = browser;
  await poll(() => evaluate('!!document.querySelector(".workspace-sidebar")'));
  const frame = () => evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');
  const canvas = () => evaluate("JSON.parse(localStorage.getItem('mixcat.notes.canvas.v1'))");
  const box = id => evaluate(`(()=>{const e=document.querySelector('.react-flow__node[data-id="${id}"]');if(!e)return null;const r=e.getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height,x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  async function reset(zoom = .75, collapsed = []) {
    if ((await getNotes()).notes.find(note => note.id === branch).parentId !== parent) await mutate({ operation: 'move', id: branch, parentId: parent });
    const viewport = zoom > 1 ? { x: -150, y: -150, zoom } : { x: 40, y: 0, zoom };
    await evaluate(`localStorage.setItem('mixcat.notes.canvas.v1',${JSON.stringify(JSON.stringify({ positions, collapsed, viewport }))})`);
    await rpc('Page.reload'); await poll(() => evaluate('!!document.querySelector(".workspace-sidebar")'));
    await evaluate("window.__errors=[];window.addEventListener('error',e=>{if(!e.message.startsWith('ResizeObserver loop'))window.__errors.push(e.message)});window.addEventListener('unhandledrejection',e=>window.__errors.push(String(e.reason)))");
    await click('.workspace-sidebar nav > button', '笔记'); await poll(() => evaluate(`document.querySelectorAll('.note-topic').length===${collapsed.length ? 5 : 6}`)); await frame();
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".notes-map-pane")).backgroundColor'), 'rgb(255, 255, 255)');
    assert.equal(await evaluate('!!document.querySelector(".notes-map-pane .react-flow__background")'), false);
    return viewport;
  }
  async function drag(id, destination, beforeRelease) {
    const start = await box(id); assert(start);
    await rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x, y: start.y });
    await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', x: start.x, y: start.y, button: 'left', clickCount: 1 });
    await rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x + 8, y: start.y, buttons: 1, button: 'left' }); await frame();
    for (let step = 1; step <= 12; step++) { await rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x + (destination.x - start.x) * step / 12, y: start.y + (destination.y - start.y) * step / 12, buttons: 1, button: 'left' }); await frame(); }
    const held = await box(id); await beforeRelease?.(held);
    await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', ...destination, button: 'left', clickCount: 1 }); await frame();
    return held;
  }
  const nearTarget = async gap => { const source = await box(branch), destination = await box(target); return { x: destination.left - gap - source.width / 2, y: destination.y }; };
  const assertClearGuide = async () => assert.equal(await evaluate('document.querySelectorAll(".note-topic.is-guide,.notes-map-pane .react-flow__edge.animated").length'), 0);
  async function assertStable(viewport, before, after) {
    const stored = await canvas();
    for (const id of [parent, target, sibling, untouched]) assert.deepEqual(stored.positions[id], positions[id], 'unmoved notes keep their world positions');
    assert.deepEqual(stored.viewport, viewport, 'reparenting does not change the viewport');
    const dx = after.left - before.left, dy = after.top - before.top;
    assert(Math.abs(stored.positions[branch].x - (positions[branch].x + dx / viewport.zoom)) < 2);
    assert(Math.abs(stored.positions[branch].y - (positions[branch].y + dy / viewport.zoom)) < 2);
    assert(Math.abs(stored.positions[leaf].x - (positions[leaf].x + dx / viewport.zoom)) < 2);
    assert(Math.abs(stored.positions[leaf].y - (positions[leaf].y + dy / viewport.zoom)) < 2);
    await assertClearGuide(); return stored;
  }
  phase = 'natural measured hierarchy';
  await click('.workspace-sidebar nav > button', '笔记'); await poll(() => evaluate('document.querySelectorAll(".note-topic").length===6'));
  await poll(async () => (await canvas())?.viewport?.zoom > 0); await frame();
  for (const [from, to] of [[parent, branch], [branch, leaf], [target, sibling]]) {
    const source = await box(from), child = await box(to), zoom = (await canvas()).viewport.zoom;
    const gap = child.x > source.x ? child.left - source.left - source.width : source.left - child.left - child.width;
    assert(Math.abs(gap / zoom - 64) < 1, `actual ${from}->${to} topic edge gap follows Grove's 64px hierarchy spacing`);
    assert(Math.abs((source.y - child.y) / zoom) < 1, 'a single-child branch aligns actual vertical centers');
  }
  checks.push('first layout uses actual topic dimensions with Grove edge gaps and center alignment');
  if (process.env.NOTES_CANVAS_VISUALS) await browser.screenshot('grove-measured-layout.png');
  for (const zoom of [.5, 1.25]) {
    phase = `measured target at zoom ${zoom}`; const viewport = await reset(zoom), source = await box(branch), destination = await nearTarget(80);
    const heldDrop = await drag(branch, destination, async held => {
      const targetBox = await box(target); assert(targetBox.left - held.left - held.width <= 90, 'the actual held node is within the screen-space target threshold');
      assert.deepEqual(await evaluate('[...document.querySelectorAll(".note-topic.is-guide")].map(e=>e.dataset.noteId).sort()'), [branch, target].sort(), 'both guide endpoints are highlighted');
      const preview = await evaluate('(()=>{const edge=document.querySelector(".notes-map-pane .react-flow__edge.animated .react-flow__edge-path");return edge?{stroke:getComputedStyle(edge).stroke,width:getComputedStyle(edge).strokeWidth,dash:getComputedStyle(edge).strokeDasharray}:null;})()');
      assert(preview, 'a visible connection preview shows the proposed parent'); assert.equal(preview.stroke, 'rgb(234, 88, 12)'); assert.equal(preview.width, '3px');
      assert.match(preview.dash, /6(?:px)?,?\s+4/);
      if (process.env.NOTES_CANVAS_VISUALS && zoom === .5) await browser.screenshot('grove-drag-guide.png');
    });
    await poll(async () => (await getNotes()).notes.find(note => note.id === branch).parentId === target);
    const after = await box(branch); assert(Math.abs(after.x - heldDrop.x) < 2 && Math.abs(after.y - heldDrop.y) < 2, `the branch remains at the held drop position: ${JSON.stringify({heldDrop,after})}`);
    assert.deepEqual((await getNotes()).notes.filter(note => note.parentId === target).sort((a,b)=>a.order-b.order).map(note=>note.id), [sibling, branch]);
    const stored = await assertStable(viewport, source, after);
    await rpc('Page.reload'); await poll(() => evaluate('!!document.querySelector(".workspace-sidebar")')); await click('.workspace-sidebar nav > button', '笔记'); await poll(() => evaluate('document.querySelectorAll(".note-topic").length===6')); await frame();
    assert.deepEqual((await canvas()).positions, stored.positions, 'reloading restores the full manual layout');
    const restored = await box(branch); assert(Math.abs(restored.left - after.left) < 2 && Math.abs(restored.top - after.top) < 2);
    checks.push(`real long-node edge targeting, guide, append and stable persisted drop at zoom${zoom}`);
    phase = `outside screen threshold at zoom ${zoom}`; await reset(zoom); const original = await getNotes();
    await drag(branch, await nearTarget(100), assertClearGuide); assert.deepEqual(await getNotes(), original, 'a 100-screen-pixel gap does not change the parent');
    checks.push(`outside90px is a free manual move at zoom${zoom}`);
  }
  phase = 'collapsed branch positions'; const viewport = await reset(.75, [branch]), before = await box(branch);
  await drag(branch, { x: before.x + 50, y: before.y - 160 });
  assert.equal((await getNotes()).notes.find(note => note.id === branch).parentId, parent);
  const folded = await assertStable(viewport, before, await box(branch));
  await click(`.note-topic[data-note-id="${branch}"] .note-topic-fold`); await poll(() => evaluate(`!!document.querySelector('.note-topic[data-note-id="${leaf}"]')`));
  assert.deepEqual((await canvas()).positions, folded.positions, 'unfolding keeps the translated hidden descendant');
  checks.push('collapsed descendants keep their relative positions while the branch moves');

  phase = 'failed relationship write'; await reset(); const originalBody = new Map((await getNotes()).notes.map(note=>[note.id,note.body]));
  failMove = true; const failureStart = await box(branch), failureDrop = await drag(branch, await nearTarget(30));
  await poll(() => evaluate('!!document.querySelector(".notes-error")'));
  assert.equal((await getNotes()).notes.find(note=>note.id===branch).parentId, parent); await assertStable({x:40,y:0,zoom:.75}, failureStart, failureDrop);
  checks.push('failed relationship writes keep the original parent and the manual drop');
  phase = 'stale relationship reply'; await reset();
  moveGate = { promise: new Promise(done=>releaseMove=done), entered:false }; await drag(branch, await nearTarget(30)); await poll(()=>moveGate.entered);
  await mutate({operation:'edit',id:untouched,body:originalBody.get(untouched)+' 外部新版本'}); releaseMove(); moveGate=undefined;
  await poll(()=>evaluate('!!document.querySelector(".notes-error")')); assert.equal((await getNotes()).notes.find(note=>note.id===branch).parentId,parent); await assertClearGuide();
  for(const note of (await getNotes()).notes) if(note.id!==untouched) assert.equal(note.body,originalBody.get(note.id));
  checks.push('a delayed stale move cannot overwrite another writer or change note bodies');

  phase = 'blur cleanup'; await reset(); const blurStart=await box(branch), original=await getNotes();
  await drag(branch,await nearTarget(30),async held=>{
    await evaluate('window.dispatchEvent(new Event("blur"))');await frame();await assertClearGuide();
    const cancelled=await box(branch),cancelledLeaf=await box(leaf);
    await rpc('Input.dispatchMouseEvent',{type:'mouseMoved',x:held.x-45,y:held.y-30,button:'left',buttons:1});await frame();
    assert.deepEqual(await box(branch),cancelled,'a cancelled gesture cannot continue moving the root');
    assert.deepEqual(await box(leaf),cancelledLeaf,'a cancelled gesture cannot separate the branch');
  });
  assert.deepEqual(await getNotes(),original,'losing the gesture context cancels the structural action');
  const nextStart=await box(branch);await drag(branch,{x:nextStart.x+20,y:nextStart.y-140});await assertClearGuide();
  assert.notEqual((await canvas()).positions[branch].y,positions[branch].y,'a subsequent gesture can still save a position');
  checks.push('blur clears the guide and a subsequent pointer gesture still works');
  phase = 'Grove zoom range'; await reset(1);
  const wheelPoint = await evaluate('(()=>{const r=document.querySelector(".notes-map-pane").getBoundingClientRect();return {x:r.left+40,y:r.top+150};})()');
  await rpc('Input.dispatchMouseEvent', { type: 'mouseWheel', ...wheelPoint, deltaX: 0, deltaY: -10000 });
  await new Promise(done => setTimeout(done, 250)); assert.equal((await canvas()).viewport.zoom, 1.5, 'Grove caps zoom at 150%');
  await rpc('Input.dispatchMouseEvent', { type: 'mouseWheel', ...wheelPoint, deltaX: 0, deltaY: 100000 });
  await new Promise(done => setTimeout(done, 250)); assert.equal((await canvas()).viewport.zoom, .000001, 'large maps use the same lower zoom bound as Grove');
  await rpc('Page.reload'); await poll(() => evaluate('!!document.querySelector(".workspace-sidebar")')); await click('.workspace-sidebar nav > button', '笔记');
  await evaluate("window.__errors=[];window.addEventListener('error',e=>{if(!e.message.startsWith('ResizeObserver loop'))window.__errors.push(e.message)});window.addEventListener('unhandledrejection',e=>window.__errors.push(String(e.reason)))");
  await poll(async () => (await canvas()).viewport.zoom === .000001);
  checks.push('wheel zoom uses Grove bounds and a very small saved viewport survives reload');
  if(process.env.NOTES_CANVAS_VISUALS){
    await reset(); await browser.screenshot('grove-white-canvas.png');
    await rpc('Emulation.setDeviceMetricsOverride',{width:1100,height:760,deviceScaleFactor:1,mobile:false});await frame();
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".notes-map-pane")).backgroundColor'),'rgb(255, 255, 255)');await browser.screenshot('grove-white-canvas-1100.png');
    await evaluate(`document.querySelector('.react-flow__node[data-id="${parent}"]').focus({preventScroll:true})`);
    for(const type of ['keyDown','keyUp'])await rpc('Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',modifiers:2,windowsVirtualKeyCode:13});
    await poll(()=>evaluate('!!document.querySelector(".notes-document-pane")'));await frame();
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".notes-map-pane")).backgroundColor'),'rgb(255, 255, 255)');
    assert.equal(await evaluate('!!document.querySelector(".notes-map-pane .react-flow__node.draggable")'),false,'the open drawer disables node dragging like Grove');
    await browser.screenshot('grove-canvas-drawer-1100.png');
  }
  assert.deepEqual(await evaluate('window.__errors'),[]);
  writeFileSync(join(fixture,'result.json'),JSON.stringify({passed:true,checks},null,2));console.log(JSON.stringify({passed:true,fixture,checks},null,2));
}catch(error){console.error('Grove canvas phase:',phase);try{console.error(await browser?.evaluate('JSON.stringify({errors:window.__errors,error:document.querySelector(".notes-error")?.textContent})'));await browser?.screenshot('failure.png');}catch{}throw error;}
finally{releaseMove?.();if(browser)try{await browser.rpc('Input.dispatchMouseEvent',{type:'mouseReleased',x:0,y:0,button:'left',clickCount:1});}catch{}await browser?.close();bridge.closeAllConnections();await new Promise(done=>bridge.close(done));await engine.close();}
