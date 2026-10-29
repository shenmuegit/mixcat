import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WorkflowEngine } from '../src/core/engine.ts';
import { insideProject, projectDirectory } from '../src/core/paths.ts';
import { openRendererFixture } from './human-review-electron-fixture.mjs';

const root = resolve('.'), evidence = projectDirectory(root, '.runtime', 'implementation', 'notes-context-menu');
const fixture = mkdtempSync(insideProject(root, join(evidence, 'electron-')));
const engine = new WorkflowEngine({ workbenchRoot: fixture, executable: 'unused', nativeFactory() { assert.fail('Note menu interactions must not start an agent'); } });
await engine.init();
const getNotes = async () => (await engine.command({ type: 'get_notes' })).notes;
const mutate = async input => engine.command({ type: 'update_note', input: { request_id: crypto.randomUUID(), expected_revision: (await getNotes()).revision, ...input } });
const create = async (title, parentId = null) => (await mutate({ operation: 'create', title, parentId, body: `# ${title}\n\n菜单交互验收正文。` })).noteId;
const first = await create('此前选中的笔记'), target = await create('右键目标'), leaf = await create('目标原有子笔记', target);
await mutate({ operation: 'associate', id: first, targetId: target, linked: true });

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
  const { click, fill, evaluate, poll, rpc } = browser;
  await rpc('Page.enable');
  await poll(() => evaluate('!!document.querySelector(".workspace-sidebar")'));
  await evaluate("window.__errors=[];window.addEventListener('error',e=>window.__errors.push(e.message));window.addEventListener('unhandledrejection',e=>window.__errors.push(String(e.reason?.stack??e.reason)))");
  const frame = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const box = id => evaluate(`(()=>{const e=document.querySelector('.note-topic[data-note-id="${id}"]');if(!e)return null;const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  const rightClick = async id => {
    await frame();
    const point = await poll(() => evaluate(`(()=>{const e=document.querySelector('.note-topic[data-note-id="${id}"]');if(!e)return null;const r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return e.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`));
    await rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    for (const type of ['mousePressed', 'mouseReleased']) await rpc('Input.dispatchMouseEvent', { type, ...point, button: 'right', buttons: type === 'mousePressed' ? 2 : 0, clickCount: 1 });
    await poll(() => evaluate('!!document.querySelector("[role=menu][aria-label=笔记操作]")'));
  };
  const key = async (key, code = key, modifiers = 0) => { for (const type of ['keyDown', 'keyUp']) await rpc('Input.dispatchKeyEvent', { type, key, code, modifiers }); await frame(); };
  const focusNode = async id => { await click(`.note-topic[data-note-id="${id}"]`); await evaluate(`document.querySelector('.react-flow__node[data-id="${id}"]').focus({preventScroll:true})`); };
  const closed = () => poll(() => evaluate('!document.querySelector("[role=menu][aria-label=笔记操作]")'));
  async function confirmAction(action, accept) {
    await action(); await poll(() => evaluate('!!document.querySelector("dialog.modal[open]")'));
    await click('dialog[open] .modal-actions button', accept ? '永久删除' : '取消');
    await frame();
  }
  await click('.workspace-sidebar nav > button', '笔记');
  await poll(() => evaluate('document.querySelectorAll(".note-topic").length===3'));
  assert.equal(await evaluate('!!document.querySelector(".notes-toolbar > strong, .notes-toolbar > button, .notes-map-pane .react-flow__controls, .notes-map-actions span")'), false, 'the highlighted title, toolbar buttons, zoom controls and shortcut hint are removed');
  assert.deepEqual(await evaluate('[...document.querySelectorAll(".notes-map-actions button")].map(button=>button.textContent.trim())'), ['整理脑图', '展开全部']);
  await click('.notes-map-actions button', '整理脑图'); await frame();
  await click(`.note-topic[data-note-id="${first}"]`);
  await rightClick(target);
  assert.equal(await evaluate('!!document.querySelector("[role=menu][aria-label=笔记操作]")'), true, 'right-clicking a note opens its action menu');
  assert.deepEqual(await evaluate('[...document.querySelectorAll("[role=menu][aria-label=笔记操作] [role=menuitem]")].map(e=>e.textContent.trim())'), ['新建笔记', '删除']);
  assert.equal(await evaluate('!!document.querySelector(".notes-selection-actions")'), false, 'selected notes have no permanent action bar');
  checks.push('right-clicking another note offers exactly create-child and delete actions');
  await browser.screenshot('notes-context-menu.png');

  const beforeCreate = await getNotes();
  await click('[role=menuitem]', '新建笔记');
  await poll(() => evaluate('!!document.querySelector("[aria-label=笔记标题]")'));
  const child = (await getNotes()).notes.find(note => !beforeCreate.notes.some(before => before.id === note.id));
  assert.equal(child?.parentId, target, 'menu creation uses the right-clicked note rather than the former selection');
  await fill('[aria-label=笔记标题]', '菜单新建子笔记');
  await poll(() => evaluate('!document.querySelector(".notes-toolbar .draft-indicator")&&!document.querySelector(".notes-document-toolbar button:disabled")'));
  assert.equal(await evaluate('!!document.querySelector(".notes-relations")'), false, 'document view has no below-content relation panel');
  await evaluate(`document.querySelector('.react-flow__node[data-id="${target}"]').focus({preventScroll:true})`);
  await key('F10', 'F10', 8);
  await poll(() => evaluate('!!document.querySelector("[role=menu][aria-label=笔记操作]")'));
  await key('Escape');
  assert.equal(await evaluate('document.querySelector("[aria-label=笔记标题]")?.value'), '菜单新建子笔记', 'keyboard menu leaves the open child draft in place');
  await closed(); await click('.notes-document-toolbar button', '脑图');
  await poll(() => evaluate('document.querySelectorAll(".note-topic").length===4'));
  checks.push('menu creates and opens a child of its target and removed panels are absent');

  await click('.notes-map-actions button', '整理脑图'); await frame();
  await focusNode(target); await key('ContextMenu');
  await poll(() => evaluate('document.activeElement?.textContent==="新建笔记"'));
  await key('ArrowDown'); assert.equal(await evaluate('document.activeElement?.textContent'), '删除');
  await key('Home'); assert.equal(await evaluate('document.activeElement?.textContent'), '新建笔记');
  await key('End'); assert.equal(await evaluate('document.activeElement?.textContent'), '删除');
  await key('Escape'); await closed();
  assert.equal(await evaluate('document.activeElement?.getAttribute("data-id")'), target, 'Escape returns focus to its node');
  await key('F10', 'F10', 8);
  await poll(() => evaluate('!!document.querySelector("[role=menu][aria-label=笔记操作]")'));
  await click('[aria-label=搜索笔记]'); await closed();
  await rightClick(target);
  const wheelPoint = await box(target);
  await rpc('Input.dispatchMouseEvent', { type: 'mouseWheel', ...wheelPoint, deltaX: 0, deltaY: 80 }); await closed();
  await click('.notes-map-actions button', '整理脑图'); await frame();
  await rightClick(target); await click('.workspace-sidebar nav > button', '项目');
  await click('.workspace-sidebar nav > button', '笔记'); await closed();
  checks.push('ContextMenu and Shift+F10, arrow focus, Escape, outside click, wheel and view changes dismiss the menu');

  await click('.notes-map-actions button', '整理脑图'); await frame();
  const start = await box(target), corner = await evaluate('({x:innerWidth-30,y:innerHeight-42})');
  await rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', ...start });
  await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', ...start, button: 'left', clickCount: 1 });
  for (let step = 1; step <= 12; step++) { await rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x + (corner.x - start.x) * step / 12, y: start.y + (corner.y - start.y) * step / 12, buttons: 1, button: 'left' }); await frame(); }
  await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', ...corner, button: 'left', clickCount: 1 }); await frame();
  await rightClick(target);
  const geometry = await evaluate('(()=>{const e=document.querySelector("[role=menu][aria-label=笔记操作]");const r=e.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight,clickable:[...e.querySelectorAll("[role=menuitem]")].every(button=>{const b=button.getBoundingClientRect();return button.contains(document.elementFromPoint(b.left+b.width/2,b.top+b.height/2));})};})()');
  assert(geometry.left >= 0 && geometry.top >= 0 && geometry.right <= geometry.width && geometry.bottom <= geometry.height, 'corner menu fits inside the visible window');
  assert.equal(geometry.clickable, true, 'both corner menu items are real mouse hit targets');
  await browser.screenshot('notes-context-menu-corner.png');
  await key('Escape'); await click('.notes-map-actions button', '整理脑图'); await frame();
  checks.push('right-bottom corner menu stays visible with both actions clickable');

  await click(`.note-topic[data-note-id="${first}"]`); await rightClick(target);
  const beforeCancel = await getNotes();
  await confirmAction(() => click('[role=menuitem]', '删除'), false);
  assert.deepEqual(await getNotes(), beforeCancel, 'canceling subtree confirmation makes no note changes');
  await rightClick(target); await confirmAction(() => click('[role=menuitem]', '删除'), true);
  const subtree = [target, leaf, child.id];
  await poll(async () => { const book = await getNotes(); return subtree.every(id => !book.notes.some(note => note.id === id)); });
  const remaining = (await getNotes()).notes;
  assert.deepEqual(remaining.map(note => note.id), [first], 'the former selection remains the only saved note');
  assert.equal(remaining[0].body, beforeCancel.notes.find(note => note.id === first).body);
  assert.deepEqual(remaining[0].relatedIds, []);
  await click('.workspace-sidebar nav > button', '项目'); await click('.workspace-sidebar nav > button', '笔记');
  await poll(() => evaluate('document.querySelectorAll(".note-topic").length===1'));
  assert.equal(await evaluate('document.querySelectorAll(".note-association-edge").length'), 0);
  checks.push('cancel is inert; permanent deletion removes only its target subtree and cleans incoming associations');

  await click('.notes-map-actions button', '整理脑图'); await frame();
  const firstPoint = await box(first); await rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', ...firstPoint }); await frame();
  const beforeHover = new Set((await getNotes()).notes.map(note => note.id));
  await click(`.note-topic[data-note-id="${first}"] .note-topic-add`);
  await poll(() => evaluate('!!document.querySelector("[aria-label=笔记标题]")'));
  const hoverChild = (await getNotes()).notes.find(note => !beforeHover.has(note.id)); assert.equal(hoverChild?.parentId, first);
  await click('.notes-document-toolbar button', '脑图'); await click('.notes-map-actions button', '整理脑图'); await frame();
  await focusNode(hoverChild.id); await confirmAction(() => key('Delete'), true);
  await poll(async () => !(await getNotes()).notes.some(note => note.id === hoverChild.id));
  checks.push('hover create and keyboard Delete remain available through the client confirmation');
  assert.deepEqual(await evaluate('window.__errors'), []);
  writeFileSync(join(fixture, 'result.json'), JSON.stringify({ passed: true, checks }, null, 2));
  console.log(JSON.stringify({ passed: true, fixture, checks }, null, 2));
} catch (error) { try { console.error(JSON.stringify({ checks, rendererErrors: await browser?.evaluate('window.__errors') })); await browser?.screenshot('failure.png'); } catch {} throw error; }
finally { await browser?.close(); bridge.closeAllConnections(); await new Promise(resolve => bridge.close(resolve)); await engine.close(); }
