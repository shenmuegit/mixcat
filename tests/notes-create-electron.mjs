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
let gate, rejectCreates = false, loseReply = false, changeCreated = false;
const hold = () => { let release; gate = { promise: new Promise(done => release = done), release: () => release(), entered: false }; };
const release = () => { const current = gate; gate = undefined; current?.release(); };
const bridge = createServer((request, response) => {
  let body = ''; request.on('data', chunk => body += chunk);
  request.on('end', () => { void (async () => {
    try {
      const input = JSON.parse(body);
      if (input.unsaved) { unsaved.set(input.unsaved.key, input.unsaved.value); response.end('{}'); return; }
      const create = input.command.type === 'update_note' && input.command.input.operation === 'create';
      if (create) { if (gate) { const current = gate; current.entered = true; await current.promise; } if (rejectCreates) throw Error('Creation unavailable'); }
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
  hold(); await plus(); await poll(() => gate?.entered); await editable();
  const first = await currentId(); assert(first);
  assert.equal((await get()).notes.length, 1, 'drawer is editable before the creation command finishes');
  assert.equal(await evaluate('document.activeElement?.getAttribute("aria-label")'), '笔记标题');
  assert.equal(await evaluate(`!!document.querySelector('.note-topic[data-note-id="${first}"]')`), true);
  await poll(() => unsaved.get('notes') === true);
  await evaluate('(()=>{window.__originalEditor=document.querySelector("[aria-label=笔记正文]")})()');
  await fill('[aria-label=笔记标题]', '创建期间的标题'); await body('创建期间输入'); await key('End'); await rpc('Input.insertText', { text: '，后续输入' });
  await browser.screenshot('pending-create.png'); release();
  await poll(async () => (await get()).notes.some(note => note.id === first && note.title === '创建期间的标题' && note.body === '创建期间输入，后续输入'));
  assert.equal((await get()).notes.find(note => note.id === first).parentId, parent);
  assert.equal(await evaluate('window.__originalEditor===document.querySelector("[aria-label=笔记正文]")'), true);
  await key('z', 'KeyZ', 2); await poll(async () => (await get()).notes.find(note => note.id === first).body === '创建期间输入');
  checks.push('plus creates a visible node and editable focused drawer before persistence; newer input and undo retain the editor identity');

  phase = 'failed creation and reload'; await close(); rejectCreates = true; hold(); await plus(); await poll(() => gate?.entered); await editable();
  const failed = await currentId(); await fill('[aria-label=笔记标题]', '可重试的新草稿'); await body('失败也保留正文'); release();
  await poll(() => evaluate('document.querySelector(".notes-error")?.textContent.includes("草稿")&&[...document.querySelectorAll(".notes-error button")].some(e=>e.textContent==="重试")')); await settled();
  assert.equal((await get()).notes.some(note => note.id === failed), false); assert.equal(unsaved.get('notes'), true);
  await click('.icon-rail button', '项目'); await click('.icon-rail button', '笔记');
  assert.equal(await currentId(), failed); assert.equal(await evaluate('document.querySelector("[aria-label=笔记正文]").textContent'), '失败也保留正文');
  rejectCreates = false; await click('.notes-error button', '重试');
  await poll(async () => (await get()).notes.some(note => note.id === failed && note.title === '可重试的新草稿' && note.body === '失败也保留正文'));
  assert.equal((await get()).notes.length, 3);
  checks.push('a failed creation survives reload and keeps exit protection; retry persists its original identity once');

  phase = 'lost create reply'; await close(); hold(); loseReply = true; await plus(); await poll(() => gate?.entered); await editable();
  const lost = await currentId(); await fill('[aria-label=笔记标题]', '回执丢失仍唯一'); await body('回执返回前的最新内容'); release();
  await poll(async () => (await get()).notes.some(note => note.id === lost && note.title === '回执丢失仍唯一' && note.body === '回执返回前的最新内容'));
  assert.equal((await get()).notes.length, 4);
  checks.push('lost creation reply reconciles the stable identity without duplication or overwriting newer input');

  phase = 'lost create reply with concurrent editing'; await close(); hold(); loseReply = true; changeCreated = true; await plus(); await poll(() => gate?.entered); await editable();
  const concurrent = await currentId(); await fill('[aria-label=笔记标题]', '本地待核对标题'); await body('本地待核对正文'); release();
  await poll(() => evaluate('!!document.querySelector(".notes-conflict")'));
  assert.equal((await get()).notes.find(note => note.id === concurrent).body, '并发作者正文');
  assert.equal(await evaluate('document.querySelector("[aria-label=笔记正文]").textContent'), '本地待核对正文');
  await click('.notes-conflict button', '已合并'); await click('dialog[open] .modal-actions button', '继续编辑');
  await poll(async () => (await get()).notes.find(note => note.id === concurrent).body === '本地待核对正文');
  checks.push('a lost create reply cannot rebase onto another writer’s content; conflict review precedes any overwrite');

  phase = 'stale creation'; await close(); hold(); await plus(); await poll(() => gate?.entered);
  const stale = await currentId(); await mutate({ operation: 'edit', id: parent, body: '并发更新' }); release();
  await poll(() => evaluate('[...document.querySelectorAll(".notes-error button")].some(e=>e.textContent==="重试")')); await settled();
  assert.equal((await get()).notes.some(note => note.id === stale), false);
  await click('.notes-error button', '重试'); await poll(async () => (await get()).notes.some(note => note.id === stale));
  assert.equal((await get()).notes.find(note => note.id === parent).body, '并发更新');
  checks.push('a stale create revision retains the local draft and retries against the refreshed version');

  phase = 'root draft discard'; await close(); rejectCreates = true; hold(); await click('[aria-label=新建笔记画布]'); await poll(() => gate?.entered); await editable();
  const discarded = await currentId();
  assert.equal(await evaluate('document.querySelector(".sidebar-note-list [aria-current=page]")?.textContent.trim()'), '▤新笔记');
  release(); await poll(() => evaluate('[...document.querySelectorAll(".notes-error button")].some(e=>e.textContent==="重试")')); await settled();
  await click('.notes-document-scroll button', '放弃草稿'); await click('dialog[open] .modal-actions button', '取消'); assert.equal(await currentId(), discarded);
  await click('.notes-document-scroll button', '放弃草稿'); await click('dialog[open] .modal-actions button', '放弃草稿');
  await poll(() => evaluate('!document.querySelector(".notes-document-pane")')); await poll(() => unsaved.get('notes') === false);
  assert.equal((await get()).notes.some(note => note.id === discarded), false); rejectCreates = false;
  checks.push('new root canvas is selected before persistence; failed clean drafts require confirmation to discard');

  phase = 'keyboard and menu entries';
  const selected = async () => { await click(`.note-topic[data-note-id="${parent}"]`); await evaluate(`document.querySelector('.react-flow__node[data-id="${parent}"]').focus({preventScroll:true})`); };
  await selected(); hold(); await key('Tab'); await poll(() => gate?.entered); await editable(); const tab = await currentId(); release(); await poll(async () => (await get()).notes.some(note => note.id === tab && note.parentId === parent)); await close();
  await selected(); hold(); await key('Enter'); await poll(() => gate?.entered); await editable(); const sibling = await currentId(); release(); await poll(async () => (await get()).notes.some(note => note.id === sibling && note.parentId === null)); await close();
  await click('.sidebar-note-list button', '新增验收根笔记'); await selected(); await key('ContextMenu'); hold(); await click('[role=menuitem]', '新建笔记'); await poll(() => gate?.entered); await editable(); const menu = await currentId(); release(); await poll(async () => (await get()).notes.some(note => note.id === menu && note.parentId === parent)); await settled();
  checks.push('Tab child, Enter sibling and context-menu creation open editable drafts before their command returns with correct hierarchy');

  phase = 'deleting a parent with a failed local child'; await close(); await click('[aria-label=新建笔记画布]'); await editable();
  const removedParent = await currentId(); await fill('[aria-label=笔记标题]', '删除失败草稿父级'); await poll(async () => (await get()).notes.some(note => note.id === removedParent && note.title === '删除失败草稿父级')); await close();
  rejectCreates = true; hold(); await click(`.note-topic[data-note-id="${removedParent}"] .note-topic-add`); await poll(() => gate?.entered); const removedChild = await currentId(); release();
  await poll(() => evaluate('[...document.querySelectorAll(".notes-error button")].some(e=>e.textContent==="重试")')); await settled();
  const parentPoint = await evaluate('(()=>{const r=[...document.querySelectorAll(".sidebar-note-list button")].find(e=>e.textContent.includes("删除失败草稿父级")).getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()');
  for (const type of ['mousePressed', 'mouseReleased']) await rpc('Input.dispatchMouseEvent', { type, ...parentPoint, button: 'right', clickCount: 1 });
  await click('[role=menuitem]', '删除'); await click('dialog[open] .modal-actions button', '永久删除');
  await poll(() => evaluate(`!document.querySelector('.note-topic[data-note-id="${removedChild}"]')&&!document.querySelector('.notes-document-pane')`)); await poll(() => unsaved.get('notes') === false);
  assert.equal((await get()).notes.some(note => note.id === removedParent || note.id === removedChild), false);
  rejectCreates = false; await click('[aria-label=新建笔记画布]'); await editable(); const afterDelete = await currentId(); await poll(async () => (await get()).notes.some(note => note.id === afterDelete));
  checks.push('confirming parent deletion removes failed local descendants and exit protection, and subsequent creation remains usable');
  assert.deepEqual(await evaluate('window.__errors'), []);
  await browser.screenshot('created-note.png');
  writeFileSync(join(fixture, 'result.json'), JSON.stringify({ passed: true, checks }, null, 2)); console.log(JSON.stringify({ passed: true, fixture, checks }, null, 2));
} catch (error) { console.error(JSON.stringify({ phase, checks })); try { await browser?.screenshot('failure.png'); } catch {} throw error; }
finally { release(); await browser?.close(); bridge.closeAllConnections(); await new Promise(done => bridge.close(done)); await engine.close(); }
