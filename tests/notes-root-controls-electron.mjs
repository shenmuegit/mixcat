import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WorkflowEngine } from '../src/core/engine.ts';
import { projectDirectory } from '../src/core/paths.ts';
import { openRendererFixture } from './human-review-electron-fixture.mjs';

const root = resolve('.'), fixture = mkdtempSync(join(projectDirectory(root, '.runtime', 'implementation', 'notes-root-controls'), 'electron-'));
const engine = new WorkflowEngine({ workbenchRoot: fixture, executable: 'unused', nativeFactory() { assert.fail('Note controls must not start an agent'); } }); await engine.init();
const get = async () => (await engine.command({ type: 'get_notes' })).notes;
const mutate = async input => engine.command({ type: 'update_note', input: { request_id: crypto.randomUUID(), expected_revision: (await get()).revision, ...input } });
const create = async (title, parentId = null) => (await mutate({ operation: 'create', title, parentId })).noteId;
const title = '用于检查双侧按钮与长标题居中的根节点', parent = await create(title), right = await create('右侧分支', parent), rightLeaf = await create('右侧叶笔记', right), left = await create('左侧分支', parent), leftLeaf = await create('左侧叶笔记', left);
await mutate({ operation: 'associate', id: left, targetId: right, linked: true });
let gate;
const hold = () => { let release; gate = { promise: new Promise(done => release = done), release: () => release(), entered: false }; };
const release = () => { const current = gate; gate = undefined; current?.release(); };
const bridge = createServer((request, response) => { let body = ''; request.on('data', chunk => body += chunk); request.on('end', () => { void (async () => {
  try { const input = JSON.parse(body); if (gate && input.command.type === 'update_note' && input.command.input.operation === 'create') { const current = gate; current.entered = true; await current.promise; } const result = await engine.command(input.command, input.id); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(result)); }
  catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: String(error.message ?? error) })); }
})(); }); });
bridge.listen(0, '127.0.0.1'); await once(bridge, 'listening');
const url = `http://127.0.0.1:${bridge.address().port}`, preload = join(fixture, 'preload.cjs');
writeFileSync(preload, `const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('mixcat',{command:e=>ipcRenderer.invoke('command',e),subscribe:()=>()=>{},chooseDirectory:async()=>null,chooseAttachments:async()=>[],setUnsaved:async()=>{},panel:async()=>({panels:[],activePanelId:null}),subscribePanels:()=>()=>{}});`);
writeFileSync(join(fixture, 'main.cjs'), `const{app,BrowserWindow,ipcMain}=require('electron');const{join}=require('node:path');for(const name of ['userData','sessionData','logs','crashDumps','temp'])app.setPath(name,join(${JSON.stringify(fixture)},name));app.commandLine.appendSwitch('disk-cache-dir',join(${JSON.stringify(fixture)},'cache'));ipcMain.handle('command',async(_,body)=>{const r=await fetch(${JSON.stringify(url)},{method:'POST',body:JSON.stringify(body)});const v=await r.json();if(!r.ok)throw Error(v.error);return v;});app.on('window-all-closed',()=>app.quit());app.whenReady().then(()=>{const win=new BrowserWindow({width:1500,height:1040,show:false,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});win.loadFile(${JSON.stringify(join(root,'dist/client/renderer/index.html'))});});`);

let browser, phase = 'control geometry'; const checks = [], measurements = [];
try {
  browser = await openRendererFixture(root, fixture); const { click, fill, evaluate, poll, rpc } = browser;
  const topic = id => `.note-topic[data-note-id="${id}"]`, control = (kind, side) => `${topic(parent)} .note-topic-${kind}[data-side=${side}]`;
  const visible = id => evaluate(`!!document.querySelector('${topic(id)}')`);
  const box = id => evaluate(`(()=>{const r=document.querySelector('${topic(id)}').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`);
  const key = async (key, code = key, modifiers = 0) => { for (const type of ['keyDown', 'keyUp']) await rpc('Input.dispatchKeyEvent', { type, key, code, modifiers }); };
  const open = async () => { await poll(() => evaluate('!!document.querySelector(".icon-rail")')); await click('.icon-rail button', '笔记'); await poll(() => visible(parent)); };
  const reload = async () => {
    assert.deepEqual(await evaluate('window.__errors'), []);
    await evaluate('window.__controlsReloadPending=true'); await rpc('Page.reload');
    await poll(() => evaluate('!window.__controlsReloadPending&&!!document.querySelector(".icon-rail")')); await open();
  };
  const close = async () => { await poll(() => evaluate('!document.querySelector(".notes-document-toolbar button:disabled")')); await click('.notes-document-toolbar button', '脑图'); await poll(() => evaluate('!document.querySelector(".notes-document-pane")')); };
  const canvasKey = `mixcat.notes.canvas.v1:${parent}`;
  const captureErrors = "window.__errors=[];window.addEventListener('error',e=>{if(!e.message.startsWith('ResizeObserver loop'))window.__errors.push(e.message)});window.addEventListener('unhandledrejection',e=>window.__errors.push(String(e.reason)))";
  await rpc('Page.enable'); await rpc('Page.addScriptToEvaluateOnNewDocument', { source: captureErrors }); await evaluate(captureErrors);
  await open(); await poll(() => evaluate('document.querySelectorAll(".note-topic").length===5'));
  for (const zoom of [.5, 1, 1.5]) {
    await evaluate(`localStorage.setItem(${JSON.stringify(canvasKey)},JSON.stringify({collapsed:[],positions:{},viewport:{x:200,y:250,zoom:${zoom}}}))`); await reload(); await click(topic(parent));
    const values = await evaluate(`(()=>{const root=document.querySelector('${topic(parent)}'),r=root.getBoundingClientRect();return [...root.querySelectorAll('button')].map(b=>{const p=b.getBoundingClientRect(),g=b.querySelector('svg,span').getBoundingClientRect(),x=p.x+p.width/2,y=p.y+p.height/2;return{side:b.dataset.side,kind:b.classList.contains('note-topic-add')?'add':'fold',dy:y-r.y-r.height/2,gx:g.x+g.width/2-x,gy:g.y+g.height/2-y,hit:b.contains(document.elementFromPoint(x,y))};});})()`);
    for (const side of ['left', 'right']) for (const kind of ['add', 'fold']) assert.equal(values.filter(v => v.side === side && v.kind === kind).length, 1);
    assert(values.every(v => Math.abs(v.dy) < 1 && Math.abs(v.gx) < 1 && Math.abs(v.gy) < 1 && v.hit), JSON.stringify({ zoom, values })); measurements.push({ zoom, values });
    if (zoom === 1) await browser.screenshot('root-controls.png');
  }
  checks.push('both sides offer independently clickable add/fold controls with centered SVGs on a long root at zoom .5, 1 and 1.5');

  phase = 'independent side folding';
  const rightBefore = await box(right), rootBefore = await box(parent);
  const press = await evaluate(`(()=>{const r=document.querySelector('${control('fold', 'left')}').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', ...press, button: 'left', buttons: 1, clickCount: 1 });
  const pressedOffset = await evaluate(`(()=>{const r=document.querySelector('${topic(parent)}').getBoundingClientRect(),b=document.querySelector('${control('fold', 'left')}').getBoundingClientRect();return b.y+b.height/2-r.y-r.height/2})()`); assert(Math.abs(pressedOffset) < 1, 'the client press animation must not replace the center transform');
  await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', ...press, button: 'left', buttons: 0, clickCount: 1 }); await poll(async () => !await visible(left) && await visible(right));
  assert.equal(await visible(leftLeaf), false); assert.deepEqual(await box(right), rightBefore); assert.deepEqual(await box(parent), rootBefore);
  assert.equal(await evaluate('document.querySelectorAll(".react-flow__edge").length'), 2, 'hidden side and association edges are not rendered');
  await reload(); await poll(async () => !await visible(left) && await visible(right));
  await click(control('fold', 'right')); await poll(() => evaluate('document.querySelectorAll(".note-topic").length===1'));
  assert.equal(await evaluate('document.querySelectorAll(".react-flow__edge").length'), 0);
  assert.deepEqual(await evaluate(`['left','right'].map(side=>document.querySelector('${topic(parent)} .note-topic-fold[data-side='+side+']').textContent)`), ['2', '2']);
  await browser.screenshot('root-controls-folded.png');
  await click(control('fold', 'left')); await poll(async () => await visible(leftLeaf) && !await visible(right));
  await click('.notes-map-actions button', '展开全部'); await poll(() => evaluate('document.querySelectorAll(".note-topic").length===5'));
  checks.push('left/right folding is independent, persists on reload, retains other geometry and hides incident edges; expand-all restores the tree');

  phase = 'legacy root folding';
  await evaluate(`(()=>{const key=${JSON.stringify(canvasKey)},c=JSON.parse(localStorage.getItem(key));c.collapsed=[${JSON.stringify(parent)}];localStorage.setItem(key,JSON.stringify(c));})()`); await reload(); await poll(() => evaluate('document.querySelectorAll(".note-topic").length===1'));
  await click(control('fold', 'left')); await poll(async () => await visible(leftLeaf) && !await visible(right));
  await click(control('fold', 'right')); await poll(() => evaluate('document.querySelectorAll(".note-topic").length===5'));
  checks.push('legacy whole-root collapse can expand one side while retaining the opposite fold');

  phase = 'side-specific creation'; await click('.notes-map-actions button', '整理脑图'); await click(topic(parent));
  const before = await evaluate(`Object.fromEntries([...document.querySelectorAll('.note-topic')].map(e=>{const r=e.getBoundingClientRect();return[e.dataset.noteId,{x:r.x,y:r.y}]}))`), viewport = await evaluate('document.querySelector(".notes-map-pane .react-flow__viewport").style.transform');
  for (const side of ['left', 'right']) {
    hold(); await click(control('add', side)); await poll(() => gate?.entered);
    await poll(() => evaluate('!document.querySelector("[aria-label=笔记标题]")?.disabled&&document.querySelector("[aria-label=笔记正文]")?.getAttribute("contenteditable")==="true"'));
    const id = await evaluate('document.querySelector(".notes-document-pane [data-content-identity]").dataset.contentIdentity.slice(5)');
    assert.equal((await get()).notes.some(n => n.id === id), false); release(); await fill('[aria-label=笔记标题]', side === 'left' ? '新增左侧' : '新增右侧');
    await poll(async () => (await get()).notes.some(n => n.id === id && n.parentId === parent && n.title === (side === 'left' ? '新增左侧' : '新增右侧'))); await close();
    const p = await box(parent), n = await box(id); assert(side === 'left' ? n.x + n.width <= p.x - 63 : n.x >= p.x + p.width + 63);
    assert.equal(await evaluate('document.querySelector(".notes-map-pane .react-flow__viewport").style.transform'), viewport);
  }
  for (const [id, point] of Object.entries(before)) { const current = await box(id); assert(Math.abs(current.x - point.x) < 1 && Math.abs(current.y - point.y) < 1); }
  checks.push('each add control immediately opens an editable draft on its requested side, persists its parent and preserves existing positions/viewport');

  phase = 'search and inner folds'; await click(control('fold', 'left')); await fill('[aria-label=搜索笔记]', '左侧叶笔记'); await click('.notes-search-results button', '左侧叶笔记'); await fill('[aria-label=搜索笔记]', ''); await close();
  await poll(() => visible(leftLeaf)); await click(`${topic(left)} .note-topic-fold`); await poll(async () => !await visible(leftLeaf));
  await click(control('fold', 'left')); await click(control('fold', 'left')); assert.equal(await visible(leftLeaf), false);
  await click(`${topic(left)} .note-topic-fold`); await poll(() => visible(leftLeaf));
  checks.push('search reveals a folded branch and root folds retain independent non-root collapse state');

  phase = 'empty root and deletion cleanup'; await click('[aria-label=新建笔记]'); await poll(() => evaluate('!!document.querySelector("[aria-label=笔记标题]")'));
  const empty = await evaluate('document.querySelector(".notes-document-pane [data-content-identity]").dataset.contentIdentity.slice(5)'); await poll(async () => (await get()).notes.some(n => n.id === empty)); await close();
  assert.equal(await evaluate(`document.querySelectorAll('${topic(empty)} .note-topic-add').length`), 2); assert.equal(await evaluate(`document.querySelectorAll('${topic(empty)} .note-topic-fold:disabled').length`), 2);
  await click('.sidebar-note-list button', title); await click(control('fold', 'left'));
  const point = await evaluate(`(()=>{const r=[...document.querySelectorAll('.sidebar-note-list button')].find(e=>e.textContent.includes(${JSON.stringify(title)})).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  for (const type of ['mousePressed', 'mouseReleased']) await rpc('Input.dispatchMouseEvent', { type, ...point, button: 'right', clickCount: 1 });
  await click('[role=menuitem]', '删除'); await poll(() => evaluate('!!document.querySelector("dialog[open]")')); await click('dialog[open] .modal-actions button', '永久删除'); await poll(async () => (await get()).notes.length === 1);
  await poll(() => evaluate(`!JSON.parse(localStorage.getItem(${JSON.stringify(canvasKey)})).collapsed.some(key=>key.startsWith(${JSON.stringify(parent)}))`));
  await poll(() => visible(empty)); checks.push('empty sides disable fold actions and deleting a folded root clears its side keys without leaving ghost nodes');
  assert.deepEqual(await evaluate('window.__errors'), []);
  writeFileSync(join(fixture, 'result.json'), JSON.stringify({ passed: true, checks, measurements }, null, 2)); console.log(JSON.stringify({ passed: true, fixture, checks, measurements }, null, 2));
} catch (error) { console.error(JSON.stringify({ phase, checks })); try { console.error(JSON.stringify(await browser?.evaluate('({canvas:Object.fromEntries(Object.entries(localStorage).filter(([k])=>k.startsWith("mixcat.notes.canvas"))),visible:[...document.querySelectorAll(".note-topic")].map(e=>({id:e.dataset.noteId,title:e.querySelector("strong").textContent})),buttons:[...document.querySelectorAll(".note-topic-fold")].map(e=>({label:e.getAttribute("aria-label"),expanded:e.getAttribute("aria-expanded")}))})'))); await browser?.screenshot('failure.png'); } catch {} throw error; }
finally { release(); await browser?.close(); bridge.closeAllConnections(); await new Promise(done => bridge.close(done)); await engine.close(); }
