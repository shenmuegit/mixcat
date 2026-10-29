import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WorkflowEngine } from '../src/core/engine.ts';
import { CommandDispatcher } from '../src/core/commands.ts';
import { insideProject, projectDirectory } from '../src/core/paths.ts';
import { openRendererFixture } from './human-review-electron-fixture.mjs';

const root = resolve('.'), evidence = projectDirectory(root, '.runtime', 'implementation', 'document-autosave');
const fixture = mkdtempSync(insideProject(root, join(evidence, 'electron-')));
const engine = new WorkflowEngine({ workbenchRoot: fixture, executable: 'unused', nativeFactory() { assert.fail('Document edits must not start an agent'); } });
await engine.init();
const dispatcher = new CommandDispatcher(engine), unsaved = new Map();
const getNotes = async () => (await engine.command({ type: 'get_notes' })).notes;
const noteMutation = async input => engine.command({ type: 'update_note', input: { request_id: crypto.randomUUID(), expected_revision: (await getNotes()).revision, ...input } });
const noteA = (await noteMutation({ operation: 'create', title: '自动保存甲', body: '原始甲' })).noteId;
const noteB = (await noteMutation({ operation: 'create', title: '自动保存乙', body: '原始乙' })).noteId;
const project = (await engine.command({ type: 'create_project', name: '自动保存项目', root: fixture, goal: '验证自动保存' })).snapshot.selected.project;
const getItem = async id => (await engine.command({ type: 'get_project_item', projectId: project.id, itemId: id })).projectItem;
const itemMutation = async input => engine.command({ type: 'update_project_item', projectId: project.id, input: { request_id: crypto.randomUUID(), ...input } });
const doc = (await itemMutation({ operation: 'create', kind: 'document', title: '项目自动保存', body: '项目原文' })).projectItem;
let gate, failNext = false, loseReplyNext = false, writes = 0;
const bridge = createServer((request, response) => {
  let body = ''; request.on('data', chunk => body += chunk);
  request.on('end', () => { void (async () => {
    try {
      const input = JSON.parse(body), command = input.command;
      if (input.inspectId) { response.end(JSON.stringify(dispatcher.inspect(input.inspectId))); return; }
      if (input.unsaved) { unsaved.set(input.unsaved.key, input.unsaved.value); response.end('{}'); return; }
      if (command?.type === 'update_note' && command.input.operation === 'edit' || command?.type === 'update_project_item' && ['create', 'edit'].includes(command.input.operation)) {
        writes++;
        if (gate) { const current = gate; current.entered = true; await current.promise; }
        if (failNext) { failNext = false; throw Error('Simulated transport failure'); }
      }
      const result = await dispatcher.dispatch(input);
      if (loseReplyNext && command?.type === 'update_project_item' && command.input.operation === 'create') { loseReplyNext = false; throw Error('Response lost after document creation'); }
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(result));
    } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: String(error.message ?? error) })); }
  })(); });
});
bridge.listen(0, '127.0.0.1'); await once(bridge, 'listening');
const bridgeUrl = `http://127.0.0.1:${bridge.address().port}`, preload = join(fixture, 'preload.cjs');
writeFileSync(preload, `const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('mixcat',{command:e=>ipcRenderer.invoke('command',e),inspect:inspectId=>ipcRenderer.invoke('command',{inspectId}),subscribe:()=>()=>{},chooseDirectory:async()=>null,chooseAttachments:async()=>[],setUnsaved:async(key,value)=>ipcRenderer.invoke('command',{unsaved:{key,value}}),panel:async()=>({panels:[],activePanelId:null}),subscribePanels:()=>()=>{}});`);
writeFileSync(join(fixture, 'main.cjs'), `const{app,BrowserWindow,ipcMain}=require('electron');const{join}=require('node:path');for(const name of ['userData','sessionData','logs','crashDumps','temp'])app.setPath(name,join(${JSON.stringify(fixture)},name));app.commandLine.appendSwitch('disk-cache-dir',join(${JSON.stringify(fixture)},'cache'));ipcMain.handle('unsaved',()=>{});ipcMain.handle('command',async(_,body)=>{const response=await fetch(${JSON.stringify(bridgeUrl)},{method:'POST',body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw Error(result.error);return result;});app.on('window-all-closed',()=>app.quit());app.whenReady().then(()=>{const win=new BrowserWindow({width:1500,height:1040,show:false,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});win.loadFile(${JSON.stringify(join(root,'dist/client/renderer/index.html'))});});`);
const hold = () => { let release; const promise = new Promise(done => release = done); gate = { promise, release, entered: false }; };
const release = () => { const current = gate; gate = undefined; current?.release(); };
const checks = []; let browser, phase = 'note saves during editing';
try {
  browser = await openRendererFixture(root, fixture);
  const { click, fill, evaluate, poll, rpc } = browser;
  await poll(() => evaluate('!!document.querySelector(".workspace-sidebar")'));
  await evaluate("window.__errors=[];window.__resizeWarnings=0;window.addEventListener('error',e=>e.message.startsWith('ResizeObserver loop')?window.__resizeWarnings++:window.__errors.push(e.message));window.addEventListener('unhandledrejection',e=>window.__errors.push(String(e.reason)))");
  const key = async (key, code, modifiers = 0) => { for (const type of ['keyDown', 'keyUp']) await rpc('Input.dispatchKeyEvent', { type, key, code: code ?? key, modifiers }); };
  const fillBody = async (label, text) => { await poll(() => evaluate(`!!document.querySelector('[aria-label="${label}"]')`)); await evaluate(`document.querySelector('[aria-label="${label}"]').focus({preventScroll:true})`); await key('a', 'KeyA', 2); await rpc('Input.insertText', { text }); };
  const openNote = async id => {
    const point = await poll(() => evaluate(`(()=>{const e=document.querySelector('.note-topic[data-note-id="${id}"]');if(!e)return null;const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`));
    for (const type of ['mousePressed', 'mouseReleased']) await rpc('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 2 });
    await poll(() => evaluate(`!!document.querySelector('[data-content-identity="note:${id}"]')`));
  };
  await click('.workspace-sidebar nav > button', '笔记'); await openNote(noteA); await click('.notes-document-toolbar button', '编辑');
  await fill('[aria-label=笔记标题]', '自动保存甲改名'); await fillBody('笔记正文', '输入后直接持久化');
  await poll(async () => (await getNotes()).notes.some(note => note.id === noteA && note.title === '自动保存甲改名' && note.body === '输入后直接持久化'));
  assert.equal(await evaluate("[...document.querySelectorAll('.notes-document-pane button')].some(e=>e.textContent.trim()==='保存')"), false);
  checks.push('note title and body persist during editing without a Save button');
  phase = 'newer note input survives a pending save'; hold(); await fillBody('笔记正文', '较早输入'); await poll(() => gate?.entered);
  assert.equal(await evaluate("document.querySelector('[aria-label=笔记正文]').getAttribute('contenteditable')"), 'true');
  await new Promise(done => setTimeout(done, 600));
  await rpc('Input.insertText', { text: '，后续输入' }); release();
  await poll(async () => (await getNotes()).notes.find(note => note.id === noteA).body === '较早输入，后续输入');
  assert.equal(await evaluate("document.querySelector('[aria-label=笔记正文]').textContent"), '较早输入，后续输入');
  await key('z', 'KeyZ', 2); await poll(async () => (await getNotes()).notes.find(note => note.id === noteA).body === '较早输入');
  checks.push('pending note saves keep typing enabled, preserve newer input and autosave undo');
  phase = 'note navigation during autosave'; hold(); await fillBody('笔记正文', '切换后仍保存甲'); await poll(() => gate?.entered);
  await fill('[aria-label=搜索笔记]', '自动保存乙'); await click('.notes-search-results button', '自动保存乙'); release();
  await poll(async () => (await getNotes()).notes.find(note => note.id === noteA).body === '切换后仍保存甲');
  assert.equal((await getNotes()).notes.find(note => note.id === noteB).body, '原始乙');
  await fill('[aria-label=搜索笔记]', '自动保存甲改名'); await click('.notes-search-results button', '自动保存甲改名'); await fill('[aria-label=搜索笔记]', '');
  checks.push('note navigation during autosave retains the source identity');
  phase = 'empty and normalized note titles'; await fill('[aria-label=笔记标题]', '');
  await poll(() => evaluate("document.querySelector('.notes-document-toolbar [role=status]')?.textContent.includes('请填写标题')"));
  await fillBody('笔记正文', '空标题时保留的正文'); assert.notEqual((await getNotes()).notes.find(note => note.id === noteA).body, '空标题时保留的正文');
  await fill('[aria-label=笔记标题]', '  自动保存甲改名  ');
  await poll(async () => { const note = (await getNotes()).notes.find(note => note.id === noteA); return note.title === '自动保存甲改名' && note.body === '空标题时保留的正文'; });
  await poll(() => evaluate("!document.querySelector('.notes-toolbar .draft-indicator')"));
  checks.push('empty titles preserve content until valid; normalized titles settle without repeated saves');
  phase = 'undo during a pending save keeps exit protection';
  await new Promise(done => setTimeout(done, 600)); hold();
  await evaluate("document.querySelector('[aria-label=笔记正文]').focus({preventScroll:true})"); await key('End', 'End', 2); await rpc('Input.insertText', { text: '，待写入' }); await poll(() => gate?.entered);
  await key('z', 'KeyZ', 2);
  assert.equal(await evaluate("document.querySelector('[aria-label=笔记正文]').textContent"), '空标题时保留的正文');
  await poll(() => unsaved.get('notes') === true);
  assert.equal(await evaluate("!window.dispatchEvent(new Event('beforeunload',{cancelable:true}))"), true, 'a pending save is protected even after undo returns to the saved text');
  release(); await poll(async () => (await getNotes()).notes.find(note => note.id === noteA).body === '空标题时保留的正文' && unsaved.get('notes') === false);
  checks.push('undo back to the saved baseline keeps close protection until pending writes settle');
  phase = 'note retry and conflict'; failNext = true; await fillBody('笔记正文', '失败后保留');
  await poll(() => evaluate("document.querySelector('.notes-error')?.textContent.includes('草稿已保留')"));
  assert.equal(await evaluate("document.querySelector('[aria-label=笔记正文]').textContent"), '失败后保留');
  await click('.notes-error button', '重试'); await poll(async () => (await getNotes()).notes.find(note => note.id === noteA).body === '失败后保留');
  phase = 'read-mode retry keeps exit protection'; await new Promise(done => setTimeout(done, 600)); failNext = true; await fillBody('笔记正文', '阅读重试期间的输入');
  await poll(() => evaluate("document.querySelector('.notes-error')?.textContent.includes('草稿已保留')"));
  hold(); await click('.notes-document-toolbar button', '阅读'); await poll(() => gate?.entered);
  await evaluate("document.querySelector('[aria-label=笔记正文]').focus({preventScroll:true})"); await key('z', 'KeyZ', 2);
  assert.equal(await evaluate("document.querySelector('[aria-label=笔记正文]').textContent"), '失败后保留');
  assert.equal(await evaluate("!window.dispatchEvent(new Event('beforeunload',{cancelable:true}))"), true, 'a read-mode retry keeps exit protection when undo returns to its baseline');
  release(); await poll(async () => (await getNotes()).notes.find(note => note.id === noteA).body === '失败后保留' && unsaved.get('notes') === false);
  await poll(() => evaluate('!!document.querySelector(".notes-document-pane .document-reading")')); await click('.notes-document-toolbar button', '编辑');
  checks.push('read-mode retries also keep exit protection through in-flight undo');
  hold(); await fillBody('笔记正文', '冲突本地草稿'); await poll(() => gate?.entered);
  await noteMutation({ operation: 'edit', id: noteA, body: '笔记外部版本' }); release();
  await poll(() => evaluate('!!document.querySelector(".notes-conflict")'));
  assert.equal((await getNotes()).notes.find(note => note.id === noteA).body, '笔记外部版本');
  assert.equal(await evaluate("document.querySelector('[aria-label=笔记正文]').textContent"), '冲突本地草稿');
  await click('.notes-conflict button', '已合并'); await click('dialog[open] .modal-actions button', '继续编辑');
  await poll(async () => (await getNotes()).notes.find(note => note.id === noteA).body === '冲突本地草稿');
  checks.push('failed note saves preserve drafts and retry; conflicts require an explicit merged baseline');
  phase = 'project document autosave'; await click('.workspace-sidebar nav > button', '项目'); await click('.project-card'); await click('.project-view-nav button', '文档'); await click('.document-file', '项目自动保存'); await click('.item-detail-heading button', '编辑');
  await fillBody('工作项正文', '项目输入后持久化'); await poll(async () => (await getItem(doc.item.id)).item.body === '项目输入后持久化');
  assert.equal(await evaluate("[...document.querySelectorAll('.document-form button')].some(e=>e.textContent.trim()==='保存')"), false);
  phase = 'newer project input and section navigation'; hold(); await fillBody('工作项正文', '项目较早输入'); await poll(() => gate?.entered);
  assert.equal(await evaluate("document.querySelector('[aria-label=工作项正文]').getAttribute('contenteditable')"), 'true');
  await rpc('Input.insertText', { text: '，后续输入' }); await click('.project-view-nav button', 'Issue'); release();
  await poll(async () => (await getItem(doc.item.id)).item.body === '项目较早输入，后续输入');
  await click('.project-view-nav button', '文档'); await click('.document-file', '项目自动保存');
  await poll(() => evaluate("document.querySelector('[aria-label=工作项正文]')?.textContent.includes('后续输入')"));
  checks.push('project content autosaves without a button and retains newer input through section navigation');
  phase = 'first project save preserves editor'; hold(); await click('.management-actions button', '新建'); await fill('[aria-label=工作项标题]', '首次自动保存'); await poll(() => gate?.entered);
  await fillBody('工作项正文', '创建期间的正文');
  await evaluate("document.querySelector('[aria-label=工作项正文]').__autosaveIdentity='same editor'"); release();
  const created = await poll(async () => { const items = (await engine.command({ type: 'search_project_items', projectId: project.id, query: { kind: 'document', limit: 200 } })).projectItems.items; const found = items.filter(item => item.title === '首次自动保存'); assert(found.length <= 1, 'first autosave must not duplicate the document'); return found[0] && (await getItem(found[0].id)).item.body === '创建期间的正文' && found[0]; });
  assert.equal(await evaluate("document.querySelector('[aria-label=工作项正文]').__autosaveIdentity"), 'same editor');
  await key('z', 'KeyZ', 2); await poll(async () => (await getItem(created.id)).item.body === '');
  await key('y', 'KeyY', 2); await poll(async () => (await getItem(created.id)).item.body === '创建期间的正文');
  checks.push('first project autosave keeps editor identity and undo/redo without duplicate creation');
  phase = 'project retry and conflict'; failNext = true; await fillBody('工作项正文', '项目失败草稿'); await poll(() => evaluate("document.querySelector('.management-detail .inline-error')?.textContent.includes('草稿已保留')"));
  await click('.management-detail .inline-error button', '重试'); await poll(async () => (await getItem(created.id)).item.body === '项目失败草稿');
  hold(); await fillBody('工作项正文', '项目冲突草稿'); await poll(() => gate?.entered);
  const external = await getItem(created.id); await itemMutation({ operation: 'edit', id: created.id, expected_revision: external.item.revision, expected_hash: external.hash, body: '项目外部版本' }); release();
  await poll(() => evaluate('!!document.querySelector(".draft-conflict")'));
  assert.equal((await getItem(created.id)).item.body, '项目外部版本');
  assert.equal(await evaluate("document.querySelector('[aria-label=工作项正文]').textContent"), '项目冲突草稿');
  await click('.draft-conflict button', '已手动合并'); await poll(async () => (await getItem(created.id)).item.body === '项目冲突草稿');
  checks.push('project failures retain drafts and retry; external conflicts preserve both versions until merged');
  phase = 'lost first-create response'; loseReplyNext = true; hold(); await click('.management-actions button', '新建'); await fill('[aria-label=工作项标题]', '回执丢失的新文档'); await poll(() => gate?.entered);
  await fillBody('工作项正文', '创建回执前的最新输入'); release();
  await poll(async () => { const items = (await engine.command({ type: 'search_project_items', projectId: project.id, query: { kind: 'document', limit: 200 } })).projectItems.items.filter(item => item.title === '回执丢失的新文档'); assert(items.length <= 1, 'retry after a lost response reuses the create receipt'); return items[0] && (await getItem(items[0].id)).item.body === '创建回执前的最新输入'; });
  checks.push('retrying a lost first-create response does not duplicate the document or lose newer input');
  phase = 'correcting a rejected new document path'; await click('.management-actions button', '新建'); await click('.document-file-operations summary'); await fill('[aria-label=文档路径]', '../outside.md'); await fill('[aria-label=工作项标题]', '修正路径的文档');
  await poll(() => evaluate("document.querySelector('.management-detail .inline-error')?.textContent.includes('草稿已保留')"));
  await fill('[aria-label=文档路径]', 'docs/recovered.md');
  await poll(async () => (await engine.command({ type: 'search_project_items', projectId: project.id, query: { kind: 'document', limit: 200 } })).projectItems.items.some(item => item.title === '修正路径的文档' && item.path === 'docs/recovered.md'));
  checks.push('a rejected first-create path can be corrected and autosaved with a new confirmed request');
  await browser.screenshot('autosave-project.png'); await click('.workspace-sidebar nav > button', '笔记'); await browser.screenshot('autosave-note.png');
  assert.deepEqual(await evaluate('window.__errors'), []);
  writeFileSync(join(fixture, 'result.json'), JSON.stringify({ passed: true, checks, writes }, null, 2));
  console.log(JSON.stringify({ passed: true, fixture, checks }, null, 2));
} catch (error) { console.error('Autosave phase:', phase); try { console.error('Renderer errors:', await browser?.evaluate('window.__errors')); await browser?.screenshot('failure.png'); } catch {} throw error; }
finally { release(); await browser?.close(); bridge.closeAllConnections(); await new Promise(done => bridge.close(done)); await engine.close(); }
