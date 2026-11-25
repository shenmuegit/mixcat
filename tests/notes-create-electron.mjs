import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WorkflowEngine } from '../src/core/engine.ts';
import { CommandDispatcher } from '../src/core/commands.ts';
import { projectDirectory } from '../src/core/paths.ts';
import { openRendererFixture } from './human-review-electron-fixture.mjs';

const root = resolve('.'), fixture = mkdtempSync(join(projectDirectory(root, '.runtime', 'implementation', 'notes-create'), 'electron-'));
const engine = new WorkflowEngine({ workbenchRoot: fixture, executable: 'unused', nativeFactory() { assert.fail('Notes must not start an agent'); } });
await engine.init();
const dispatcher = new CommandDispatcher(engine), unsaved = new Map();
const get = async () => (await engine.command({ type: 'get_notes' })).notes;
const mutate = async input => engine.command({ type: 'update_note', input: { request_id: crypto.randomUUID(), expected_revision: (await get()).revision, ...input } });
const parent = (await mutate({ operation: 'create', title: '新增验收根笔记' })).noteId;
let gate, rejectCreates = false, loseReply = false, changeCreated = false, submittedCreateId;
const hold = () => { let release; gate = { promise: new Promise(done => release = done), release: () => release(), entered: false }; };
const release = () => { const current = gate; gate = undefined; current?.release(); };
const bridge = createServer((request, response) => {
  let body = ''; request.on('data', chunk => body += chunk);
  request.on('end', () => { void (async () => {
    try {
      const input = JSON.parse(body);
      if (input.unsaved) { unsaved.set(input.unsaved.key, input.unsaved.value); response.end('{}'); return; }
      const create = input.command.type === 'update_note' && input.command.input.operation === 'create';
      if (create) { submittedCreateId = input.command.input.id; if (gate) { const current = gate; current.entered = true; await current.promise; } if (rejectCreates) throw Error('Creation unavailable'); }
      const result = await dispatcher.dispatch(input);
      if (create && changeCreated) { changeCreated = false; await mutate({ operation: 'edit', id: result.noteId, title: '并发作者标题', body: '并发作者正文' }); }
      if (create && loseReply) { loseReply = false; throw Error('Lost creation response'); }
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(result));
    } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: String(error.message ?? error) })); }
  })(); });
});
bridge.listen(0, '127.0.0.1'); await once(bridge, 'listening');
const url = `http://127.0.0.1:${bridge.address().port}`, preload = join(fixture, 'preload.cjs');
writeFileSync(preload, `const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('mixcat',{command:e=>ipcRenderer.invoke('command',e),subscribe:()=>()=>{},chooseDirectory:async()=>null,chooseAttachments:async()=>[],setUnsaved:(key,value)=>ipcRenderer.invoke('command',{unsaved:{key,value}}),panel:async()=>({panels:[],activePanelId:null}),subscribePanels:()=>()=>{}});`);
writeFileSync(join(fixture, 'main.cjs'), `const{app,BrowserWindow,ipcMain}=require('electron');const{join}=require('node:path');for(const name of ['userData','sessionData','logs','crashDumps','temp'])app.setPath(name,join(${JSON.stringify(fixture)},name));app.commandLine.appendSwitch('disk-cache-dir',join(${JSON.stringify(fixture)},'cache'));ipcMain.handle('command',async(_,body)=>{const r=await fetch(${JSON.stringify(url)},{method:'POST',body:JSON.stringify(body)});const v=await r.json();if(!r.ok)throw Error(v.error);return v;});app.on('window-all-closed',()=>app.quit());app.whenReady().then(()=>{const win=new BrowserWindow({width:1500,height:1040,show:false,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});win.loadFile(${JSON.stringify(join(root,'dist/client/renderer/index.html'))});});`);

let browser, phase = 'pending node creation'; const checks = [];
try {
  browser = await openRendererFixture(root, fixture);
  const { click, fill, evaluate, poll, rpc } = browser;
  const key = async (key, code = key, modifiers = 0) => { for (const type of ['keyDown', 'keyUp']) await rpc('Input.dispatchKeyEvent', { type, key, code, modifiers }); };
  const body = async text => { await evaluate('document.querySelector("[aria-label=笔记正文]").focus({preventScroll:true})'); await key('a', 'KeyA', 2); await rpc('Input.insertText', { text }); };
  const currentId = () => evaluate('document.querySelector(".notes-document-pane [data-content-identity]")?.dataset.contentIdentity.slice(5)');
  const editable = () => poll(() => evaluate('!document.querySelector("[aria-label=笔记标题]")?.disabled&&document.querySelector("[aria-label=笔记正文]")?.getAttribute("contenteditable")==="true"'));
  const settled = () => poll(() => evaluate('!document.querySelector(".notes-document-toolbar button:disabled")'));
  const close = async () => { await settled(); await click('.notes-document-toolbar button', '脑图'); await poll(() => evaluate('!document.querySelector(".notes-document-pane")')); };
  const plus = () => click(`.note-topic[data-note-id="${parent}"] .note-topic-add`);
  await poll(() => evaluate('!!document.querySelector(".icon-rail")')); await click('.icon-rail button', '笔记');
  await poll(() => evaluate('document.querySelectorAll(".note-topic").length===1'));
  await evaluate("window.__errors=[];window.addEventListener('error',e=>{if(!e.message.startsWith('ResizeObserver loop'))window.__errors.push(e.message)});window.addEventListener('unhandledrejection',e=>window.__errors.push(String(e.reason)))");
  const visibleNotes = () => evaluate('document.querySelectorAll(".note-topic").length');
  const retry = () => click('.notes-error button', '重试创建');
  hold(); await plus(); await poll(() => gate?.entered);
  assert.equal(await currentId(), undefined);
  assert.equal(await visibleNotes(), 1);
  assert.equal((await get()).notes.length, 1);
  await browser.screenshot('pending-create.png'); release();
  await editable();
  const first = await currentId();
  assert.equal(first, submittedCreateId);
  assert.equal((await get()).notes.find(note => note.id === first).parentId, parent);
  assert.equal(await evaluate('document.activeElement?.getAttribute("aria-label")'), '笔记标题');
  await fill('[aria-label=笔记标题]', '已创建的标题'); await body('新笔记正文');
  await poll(async () => (await get()).notes.some(note => note.id === first && note.title === '已创建的标题' && note.body === '新笔记正文'));
  checks.push('pending creation stays off the canvas until storage confirms the note and the editor opens');

  phase = 'failed creation and retry';
  await close(); rejectCreates = true; await plus();
  await poll(() => evaluate('document.querySelector(".notes-error")?.textContent.includes("操作未完成")'));
  const failed = submittedCreateId;
  assert.equal(await currentId(), undefined); assert.equal((await get()).notes.length, 2);
  assert.equal(unsaved.get('notes'), false);
  rejectCreates = false; await retry(); await editable();
  assert.equal(await currentId(), failed); assert.equal((await get()).notes.length, 3);
  checks.push('failed creation leaves no visible note or unsaved edit and retry commits the same identity once');

  phase = 'lost create reply';
  await close(); loseReply = true; changeCreated = true; await plus(); await editable();
  assert.equal(await currentId(), submittedCreateId);
  assert.equal((await get()).notes.length, 4);
  assert.equal(await evaluate('document.querySelector("[aria-label=笔记正文]").textContent'), '并发作者正文');
  checks.push('a lost reply opens the confirmed identity with the latest stored content');

  phase = 'stale creation';
  await close(); hold(); await plus(); await poll(() => gate?.entered);
  const stale = submittedCreateId; await mutate({ operation: 'edit', id: parent, body: '并发更新' }); release();
  await poll(() => evaluate('document.querySelector(".notes-error")?.textContent.includes("操作未完成")')); await settled();
  assert.equal(await currentId(), undefined);
  assert.equal((await get()).notes.some(note => note.id === stale), false);
  await retry(); await editable(); assert.equal(await currentId(), stale);
  assert.equal((await get()).notes.find(note => note.id === parent).body, '并发更新');
  checks.push('retry after a stale revision creates once without changing the refreshed parent');

  phase = 'keyboard and context menu';
  await close();
  const selected = async () => { await click(`.note-topic[data-note-id="${parent}"]`); await evaluate(`document.querySelector('.react-flow__node[data-id="${parent}"]').focus({preventScroll:true})`); };
  await selected(); hold(); await key('Tab'); await poll(() => gate?.entered); assert.equal(await currentId(), undefined); release();
  await editable(); const child = await currentId(); assert.equal((await get()).notes.find(note => note.id === child).parentId, parent); await close();
  await selected(); hold(); await key('Enter'); await poll(() => gate?.entered); assert.equal(await currentId(), undefined); release();
  await editable(); const sibling = await currentId(); assert.equal((await get()).notes.find(note => note.id === sibling).parentId, null); await close();
  await click('.sidebar-note-list button', '新增验收根笔记'); await selected(); await key('ContextMenu'); hold(); await click('[role=menuitem]', '新建笔记');
  await poll(() => gate?.entered); assert.equal(await currentId(), undefined); release();
  await editable(); const menu = await currentId(); assert.equal((await get()).notes.find(note => note.id === menu).parentId, parent);
  checks.push('keyboard and context-menu creation wait for commit and keep the requested parent');
  assert.deepEqual(await evaluate('window.__errors'), []);
  await browser.screenshot('created-note.png');
  writeFileSync(join(fixture, 'result.json'), JSON.stringify({ passed: true, checks }, null, 2)); console.log(JSON.stringify({ passed: true, fixture, checks }, null, 2));
} catch (error) { console.error(JSON.stringify({ phase, checks })); try { await browser?.screenshot('failure.png'); } catch {} throw error; }
finally { release(); await browser?.close(); bridge.closeAllConnections(); await new Promise(done => bridge.close(done)); await engine.close(); }
