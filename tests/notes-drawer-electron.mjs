import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WorkflowEngine } from '../src/core/engine.ts';
import { insideProject, projectDirectory } from '../src/core/paths.ts';
import { openRendererFixture } from './human-review-electron-fixture.mjs';

const root = resolve('.'), evidence = projectDirectory(root, '.runtime', 'implementation', 'notes-drawer');
const fixture = mkdtempSync(insideProject(root, join(evidence, 'electron-')));
const engine = new WorkflowEngine({ workbenchRoot: fixture, executable: 'unused', nativeFactory() { assert.fail('Note drawers must not start an agent'); } });
await engine.init();
const created = await engine.command({ type: 'update_note', input: { operation: 'create', request_id: crypto.randomUUID(), expected_revision: 0, title: '抽屉验收', body: '抽屉原文' } });
const noteId = created.noteId;
const getNote = async () => (await engine.command({ type: 'get_notes' })).notes.notes.find(note => note.id === noteId);
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
const checks = []; let browser, phase = 'drawer overlays the map';
try {
  browser = await openRendererFixture(root, fixture);
  const { click, evaluate, poll, rpc } = browser;
  await poll(() => evaluate('!!document.querySelector(".workspace-sidebar")'));
  const captureErrors = "window.__errors=[];window.addEventListener('error',e=>{if(!e.message.startsWith('ResizeObserver loop'))window.__errors.push(e.message)});window.addEventListener('unhandledrejection',e=>window.__errors.push(String(e.reason)))";
  await rpc('Page.addScriptToEvaluateOnNewDocument', { source: captureErrors }); await evaluate(captureErrors);
  const frame = () => evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');
  const geometry = () => evaluate(`(()=>{const rect=e=>{if(!e)return null;const r=e.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,width:r.width,height:r.height};};const handle=document.querySelector('[aria-label="调整笔记抽屉宽度"]');return {body:rect(document.querySelector('.notes-body')),map:rect(document.querySelector('.notes-map-pane')),node:rect(document.querySelector('.note-topic[data-note-id="${noteId}"]')),drawer:rect(document.querySelector('.notes-document-pane')),handle:rect(handle),min:Number(handle?.getAttribute('aria-valuemin')),max:Number(handle?.getAttribute('aria-valuemax')),width:Number(handle?.getAttribute('aria-valuenow')),viewport:JSON.parse(localStorage.getItem('mixcat.notes.canvas.v1'))?.viewport};})()`);
  const openNote = async () => {
    const point = await poll(() => evaluate(`(()=>{const e=document.querySelector('.note-topic[data-note-id="${noteId}"]');if(!e)return null;const r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return e.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`));
    for (const type of ['mousePressed', 'mouseReleased']) await rpc('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 2 });
    await poll(() => evaluate('!!document.querySelector(".notes-document-pane")')); await frame();
  };
  const key = async (key, code = key, modifiers = 0) => { for (const type of ['keyDown', 'keyUp']) await rpc('Input.dispatchKeyEvent', { type, key, code, modifiers }); await frame(); };
  const handleSelector = '[aria-label="调整笔记抽屉宽度"]';
  const drag = async dx => {
    const rect = (await geometry()).handle, start = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    assert.equal(await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(handleSelector)});return e.contains(document.elementFromPoint(${start.x},${start.y}));})()`), true, 'resize edge is a real hit target');
    await rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', ...start });
    await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', ...start, button: 'left', clickCount: 1 });
    for (let step = 1; step <= 8; step++) { await rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x + dx * step / 8, y: start.y, button: 'left', buttons: 1 }); await frame(); }
    await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', x: start.x + dx, y: start.y, button: 'left', clickCount: 1 }); await frame();
  };
  await click('.workspace-sidebar nav > button', '笔记'); await poll(() => evaluate('document.querySelectorAll(".note-topic").length===1')); await frame();
  const before = await geometry(); await openNote(); const opened = await geometry();
  assert.deepEqual(opened.map, before.map, 'opening the drawer keeps the whole map size and position');
  assert.deepEqual(opened.node, before.node, 'opening the drawer does not move or scale the note');
  assert(Math.abs(opened.drawer.right - opened.body.right) < 1, 'drawer stays attached to the right edge');
  assert(opened.handle?.width >= 8, 'left edge has a usable resize hit target');
  checks.push('note content overlays the right side without resizing or moving the map');
  phase = 'mouse resize and editing continuity'; await drag(-120);
  const grown = await geometry(); assert.equal(grown.drawer.width, opened.drawer.width + 120); assert.equal(grown.width, grown.drawer.width);
  assert.deepEqual(grown.map, before.map); assert.deepEqual(grown.node, before.node); assert.deepEqual(grown.viewport, opened.viewport);
  await click('.notes-document-toolbar button', '编辑');
  await poll(() => evaluate('!!document.querySelector("[aria-label=笔记正文]")'));
  await evaluate("document.querySelector('[aria-label=笔记正文]').focus({preventScroll:true})"); await key('a', 'KeyA', 2); await rpc('Input.insertText', { text: '抽屉编辑内容' });
  await poll(async () => (await getNote()).body === '抽屉编辑内容');
  await evaluate("document.querySelector('[aria-label=笔记正文]').__drawerEditor='same editor'"); await drag(140);
  assert.equal((await geometry()).drawer.width, grown.drawer.width - 140);
  assert.equal(await evaluate("document.querySelector('[aria-label=笔记正文]').__drawerEditor"), 'same editor');
  await new Promise(done => setTimeout(done, 600)); await evaluate("document.querySelector('[aria-label=笔记正文]').focus({preventScroll:true})"); await frame(); await rpc('Input.insertText', { text: '，继续输入' });
  phase = 'caret after resize'; await poll(async () => (await getNote()).body === '抽屉编辑内容，继续输入');
  phase = 'undo after resize'; await key('z', 'KeyZ', 2); await poll(async () => (await getNote()).body === '抽屉编辑内容');
  checks.push('real left-edge dragging grows/shrinks the drawer while retaining editor identity, caret, undo and autosave');
  phase = 'close and reopen retain width'; const chosen = (await geometry()).drawer.width;
  await click('.notes-document-toolbar button', '脑图'); await frame(); assert.deepEqual((await geometry()).map, before.map); assert.deepEqual((await geometry()).node, before.node);
  await openNote(); assert.equal((await geometry()).drawer.width, chosen);
  checks.push('closing and reopening retains the chosen width and original map geometry');
  phase = 'keyboard limits'; await click(handleSelector); await key('Home'); let sizes = await geometry(); assert.equal(sizes.drawer.width, sizes.min);
  await key('ArrowLeft'); assert.equal((await geometry()).drawer.width, sizes.min + 16);
  await key('End'); sizes = await geometry(); assert.equal(sizes.drawer.width, sizes.max);
  await key('ArrowRight'); assert.equal((await geometry()).drawer.width, sizes.max - 16);
  await drag(300); const preferred = (await geometry()).drawer.width;
  checks.push('focusable separator supports arrow keys and Home/End with workspace bounds');
  phase = 'touch cancellation'; await rpc('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  const touchRect = (await geometry()).handle, touch = { x: touchRect.left + 5, y: touchRect.top + 180, id: 1 };
  await rpc('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touch] }); await rpc('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...touch, x: touch.x - 30 }] }); await frame();
  assert.equal((await geometry()).drawer.width, preferred + 30);
  await rpc('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }); await frame();
  const cancelledWidth = (await geometry()).drawer.width; await rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', x: touch.x - 80, y: touch.y }); await frame(); assert.equal((await geometry()).drawer.width, cancelledWidth);
  await rpc('Emulation.setTouchEmulationEnabled', { enabled: false }); await drag(20); const remembered = (await geometry()).drawer.width;
  checks.push('native touch cancellation releases the gesture and a subsequent mouse resize works');
  phase = 'window constraints'; await rpc('Emulation.setDeviceMetricsOverride', { width: 1100, height: 820, deviceScaleFactor: 1, mobile: false });
  await poll(async () => { const g = await geometry(); return g.drawer.right <= 1100 && g.drawer.left >= g.body.left && g.drawer.width <= g.max; });
  assert.equal(await evaluate("JSON.parse(localStorage.getItem('mixcat.notes.canvas.v1')).drawerWidth"), remembered, 'temporary viewport clamping keeps the preferred width');
  await rpc('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1040, deviceScaleFactor: 1, mobile: false }); await poll(async () => (await geometry()).drawer.width === remembered);
  checks.push('narrow desktop windows clamp the drawer and restoring the viewport restores its preferred width');
  phase = 'persisted preference reload';
  const reopen = async () => { await rpc('Page.reload'); await poll(() => evaluate('!!document.querySelector(".workspace-sidebar")&&!document.querySelector(".notes-document-pane")&&!document.querySelector(".note-topic")')); await click('.workspace-sidebar nav > button', '笔记'); await poll(() => evaluate('document.querySelectorAll(".note-topic").length===1')); await frame(); await openNote(); };
  await reopen(); assert.equal((await geometry()).drawer.width, remembered); assert.equal((await getNote()).body, '抽屉编辑内容');
  await evaluate("(()=>{const value=JSON.parse(localStorage.getItem('mixcat.notes.canvas.v1'));value.drawerWidth='invalid';localStorage.setItem('mixcat.notes.canvas.v1',JSON.stringify(value));})()");
  await reopen(); assert.equal((await geometry()).drawer.width, 820);
  checks.push('reload restores the chosen width and invalid stored width safely falls back');
  await browser.screenshot('notes-drawer.png');
  assert.deepEqual(await evaluate('window.__errors'), []);
  writeFileSync(join(fixture, 'result.json'), JSON.stringify({ passed: true, checks }, null, 2));
  console.log(JSON.stringify({ passed: true, fixture, checks }, null, 2));
} catch (error) { console.error('Drawer phase:', phase); try { console.error({ body: (await getNote()).body, renderer: await browser?.evaluate('({errors:window.__errors,text:document.querySelector("[aria-label=笔记正文]")?.textContent,active:document.activeElement?.getAttribute("aria-label")})') }); await browser?.screenshot('failure.png'); } catch {} throw error; }
finally { await browser?.close(); bridge.closeAllConnections(); await new Promise(done => bridge.close(done)); await engine.close(); }
