import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WorkflowEngine } from '../src/core/engine.ts';
import { DocumentMediaStore } from '../src/core/document-media.ts';
import { insideProject, projectDirectory } from '../src/core/paths.ts';
import { openRendererFixture } from './human-review-electron-fixture.mjs';

const root = resolve('.'), evidence = projectDirectory(root, '.runtime', 'implementation', 'notes-confirmations');
const fixture = mkdtempSync(insideProject(root, join(evidence, 'electron-')));
const engine = new WorkflowEngine({ workbenchRoot: fixture, executable: 'unused', nativeFactory() { assert.fail('Confirmations must not start an agent'); } });
await engine.init();
const getNotes = async () => (await engine.command({ type: 'get_notes' })).notes;
const mutate = async input => engine.command({ type: 'update_note', input: { request_id: crypto.randomUUID(), expected_revision: (await getNotes()).revision, ...input } });
const title = '需要核对删除范围的长标题'.repeat(7) + 'UnbrokenNoteTitle'.repeat(3);
const target = (await mutate({ operation: 'create', title, body: '确认框验收正文' })).noteId;
const child = (await mutate({ operation: 'create', parentId: target, title: '子笔记草稿', body: '子笔记原文' })).noteId;
await mutate({ operation: 'create', parentId: child, title: '孙笔记一', body: '' });
await mutate({ operation: 'create', parentId: target, title: '子笔记二', body: '' });
await mutate({ operation: 'create', parentId: target, title: '子笔记三', body: '' });
const other = (await mutate({ operation: 'create', title: '独立草稿笔记', body: '原正文' })).noteId;
const media = new DocumentMediaStore(fixture, () => { assert.fail('Note media does not require a project'); });
let rejectEdits = false, failDelete = false, deleteAttempts = 0, editAttempts = 0, readGate, mediaGate, releaseRead, releaseMedia;
const bridge = createServer((request, response) => {
  let body = ''; request.on('data', chunk => body += chunk);
  request.on('end', () => { void (async () => {
    try {
      const input = JSON.parse(body), command = input.command;
      if (command?.type === 'get_notes' && readGate) { readGate.entered = true; await readGate.promise; }
      if (input.media?.operation === 'import' && mediaGate) { mediaGate.entered = true; await mediaGate.promise; }
      if (command?.type === 'update_note' && command.input.operation === 'delete') deleteAttempts++;
      if (command?.type === 'update_note' && command.input.operation === 'edit') editAttempts++;
      if (command?.type === 'update_note' && (rejectEdits && command.input.operation === 'edit' || failDelete && command.input.operation === 'delete')) { failDelete = false; throw Error('Controlled note write failure'); }
      const result = input.media ? media.command(input.media) : await engine.command(command, input.id); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(result));
    } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: String(error.message ?? error) })); }
  })(); });
});
bridge.listen(0, '127.0.0.1'); await once(bridge, 'listening');
const bridgeUrl = `http://127.0.0.1:${bridge.address().port}`, preload = join(fixture, 'preload.cjs');
writeFileSync(preload, `const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('mixcat',{command:e=>ipcRenderer.invoke('command',e),documentMedia:media=>ipcRenderer.invoke('command',{media}),subscribe:()=>()=>{},chooseDirectory:async()=>null,chooseAttachments:async()=>[],setUnsaved:async()=>{},panel:async()=>({panels:[],activePanelId:null}),subscribePanels:()=>()=>{}});`);
writeFileSync(join(fixture, 'main.cjs'), `const{app,BrowserWindow,ipcMain}=require('electron');const{join}=require('node:path');for(const name of ['userData','sessionData','logs','crashDumps','temp'])app.setPath(name,join(${JSON.stringify(fixture)},name));app.commandLine.appendSwitch('disk-cache-dir',join(${JSON.stringify(fixture)},'cache'));ipcMain.handle('command',async(_,body)=>{const response=await fetch(${JSON.stringify(bridgeUrl)},{method:'POST',body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw Error(result.error);return result;});app.on('window-all-closed',()=>app.quit());app.whenReady().then(()=>{const win=new BrowserWindow({width:1500,height:1040,show:false,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});win.loadFile(${JSON.stringify(join(root,'dist/client/renderer/index.html'))});});`);
let browser, phase = 'client confirmation replaces native dialog'; const checks = [];
try {
  browser = await openRendererFixture(root, fixture);
  const { click, fill, evaluate, poll, rpc } = browser;
  await poll(() => evaluate('!!document.querySelector(".workspace-sidebar")'));
  await evaluate("window.__errors=[];window.__nativeConfirms=[];window.confirm=text=>{window.__nativeConfirms.push(text);return false;};window.addEventListener('error',e=>{if(!e.message.startsWith('ResizeObserver loop'))window.__errors.push(e.message)});window.addEventListener('unhandledrejection',e=>window.__errors.push(String(e.reason)))");
  const frame = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const key = async (key, code = key, modifiers = 0) => { for (const type of ['keyDown', 'keyUp']) await rpc('Input.dispatchKeyEvent', { type, key, code, modifiers, windowsVirtualKeyCode: { Enter: 13, Escape: 27, Tab: 9, Delete: 46, ContextMenu: 93 }[key], ...(key === 'Enter' && type === 'keyDown' ? { text: '\r', unmodifiedText: '\r' } : {}) }); await frame(); };
  const modal = async title => {
    await poll(() => evaluate(`document.querySelector('dialog.modal[open]')?.getAttribute('aria-label')===${JSON.stringify(title)}`));
    assert.deepEqual(await evaluate('window.__nativeConfirms'), [], 'notes actions never open a system JavaScript confirmation');
    assert.equal(await evaluate('document.activeElement?.textContent.trim()'), '取消', 'safe cancel is initially focused');
    assert.equal(await evaluate('!!document.getElementById(document.querySelector("dialog[open]").getAttribute("aria-describedby"))'), true);
  };
  const closed = () => poll(() => evaluate('!document.querySelector("dialog[open]")'));
  const choose = async text => { await click('dialog[open] .modal-actions button', text); await closed(); };
  const capture = async name => {
    if (!process.env.NOTES_CONFIRMATION_VISUALS) return;
    for (const width of [1500, 1100]) {
      await rpc('Emulation.setDeviceMetricsOverride', { width, height: width === 1500 ? 960 : 760, deviceScaleFactor: 1, mobile: false }); await frame();
      const geometry = await evaluate('(()=>{const d=document.querySelector("dialog[open]"),p=d.querySelector("p"),r=d.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight,overflow:p.scrollWidth>p.clientWidth,clickable:[...d.querySelectorAll("button")].every(b=>{const r=b.getBoundingClientRect();return b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}),font:getComputedStyle(p).fontFamily,background:getComputedStyle(d).backgroundColor,button:getComputedStyle(d.querySelector(".button.primary")).backgroundColor};})()');
      assert(geometry.left >= 0 && geometry.right <= width && geometry.top >= 0 && geometry.bottom <= geometry.height && !geometry.overflow && geometry.clickable, `${name} fits the desktop viewport with working controls`);
      await browser.screenshot(`${name}-${width}.png`); writeFileSync(join(fixture, `${name}-${width}.json`), JSON.stringify(geometry, null, 2));
    }
    await rpc('Emulation.clearDeviceMetricsOverride'); await frame();
  };
  const requestDelete = async id => {
    await frame();
    await evaluate(`document.querySelector('.react-flow__node[data-id="${id}"]').focus({preventScroll:true})`); await key('ContextMenu');
    await poll(() => evaluate('!!document.querySelector(".notes-context-menu")')); await click('.notes-context-menu [role=menuitem]', '删除');
    await poll(() => evaluate('!!document.querySelector("dialog[open]")||window.__nativeConfirms.length>0'));
    assert.deepEqual(await evaluate('window.__nativeConfirms'), [], 'notes actions never open a system JavaScript confirmation');
    await modal('删除笔记');
  };
  const openNote = async (id, name) => {
    await fill('[aria-label=搜索笔记]', name); await click('.notes-search-results button', name); await click('[aria-label=清除笔记搜索]');
    await poll(() => evaluate(`!!document.querySelector('[data-content-identity="note:${id}"]')`));
  };
  const body = () => evaluate('document.querySelector("[aria-label=笔记正文]")?.textContent');
  const failedDraft = async text => { const before = editAttempts; rejectEdits = true; await fill('[aria-label=笔记正文]', text); await poll(() => editAttempts > before); await poll(() => evaluate('document.querySelector(".notes-error")?.textContent.includes("草稿已保留")&&!document.querySelector(".notes-document-toolbar button:disabled")')); };
  const refresh = async () => { await click('.workspace-sidebar nav > button', '项目'); await click('.workspace-sidebar nav > button', '笔记'); await frame(); };
  await click('.workspace-sidebar nav > button', '笔记'); await poll(() => evaluate('document.querySelectorAll(".note-topic").length===6'));
  await requestDelete(target);
  assert.match(await evaluate('document.querySelector("dialog[open]").textContent'), /4 个后代笔记/);
  await capture('delete');
  const original = await getNotes(); await choose('取消'); await frame();
  assert.equal(await evaluate('document.activeElement?.getAttribute("data-id")'), target, 'cancel restores focus to the originating node');
  await requestDelete(target); await key('Escape'); await closed();
  await requestDelete(target); await click('dialog[open] [aria-label=关闭弹窗]'); await closed();
  await requestDelete(target); await key('Enter'); await closed();
  assert.deepEqual(await getNotes(), original, 'Cancel, Escape, close and the safe default Enter are inert');
  await requestDelete(target);
  for (let i = 0; i < 8; i++) { await key('Tab', 'Tab', i % 2 ? 8 : 0); assert.equal(await evaluate('!!document.activeElement?.closest("dialog[open]")'), true, 'Tab stays inside the modal'); }
  await key('Delete'); assert.equal(await evaluate('document.querySelectorAll("dialog[open]").length'), 1, 'repeated structural keys cannot open another confirmation');
  await choose('取消'); checks.push('client modal has safe focus, trapped Tab, focus restoration and inert Cancel/Escape/close/default Enter');

  phase = 'stale subtree and failed delete';
  await requestDelete(target);
  const added = (await mutate({ operation: 'create', parentId: target, title: '确认期间新建', body: '' })).noteId;
  await choose('移入回收站'); await poll(() => evaluate('!!document.querySelector(".notes-error")'));
  await poll(() => evaluate('document.querySelectorAll(".note-topic").length===7'));
  assert((await getNotes()).notes.every(note => !note.deletedAt), 'a stale revision cannot delete a newly enlarged subtree');
  failDelete = true; await requestDelete(target); const attempts = deleteAttempts; await choose('移入回收站');
  await poll(() => deleteAttempts === attempts + 1); await poll(() => evaluate('document.querySelector(".notes-error")?.textContent.includes("草稿已保留")'));
  assert((await getNotes()).notes.every(note => !note.deletedAt), 'transport failure leaves the subtree intact');
  checks.push('stale subtree revisions and write failures preserve all notes');

  phase = 'image import finishing during deletion confirmation';
  await openNote(child, '子笔记草稿'); await click('.notes-document-toolbar button', '编辑');
  await poll(() => evaluate('!!document.querySelector("[aria-label=笔记正文]")'));
  mediaGate = { promise: new Promise(done => releaseMedia = done), entered: false };
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  await evaluate(`(()=>{const data=new DataTransfer();data.items.add(new File([Uint8Array.from(atob(${JSON.stringify(png)}),c=>c.charCodeAt(0))],'图片.png',{type:'image/png'}));document.querySelector('[aria-label=笔记正文]').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));})()`);
  await poll(() => mediaGate.entered); await requestDelete(target);
  assert.equal(await evaluate('document.querySelector("dialog[open]").textContent.includes("未保存草稿")'), false);
  rejectEdits = true; releaseMedia(); mediaGate = undefined;
  await poll(() => evaluate('!!document.querySelector(".notes-toolbar .draft-indicator")'));
  const beforeMediaDelete = deleteAttempts; await choose('移入回收站'); await frame();
  assert.equal(deleteAttempts, beforeMediaDelete, 'an image draft arriving during confirmation requires a fresh confirmation');
  assert((await getNotes()).notes.every(note => !note.deletedAt));
  await poll(() => evaluate('!document.querySelector(".notes-document-toolbar button:disabled")'));
  await click('.notes-document-scroll > button', '放弃草稿'); await choose('放弃草稿');
  await poll(() => body().then(text => text === '子笔记原文'));
  checks.push('an asynchronous image import cannot silently enlarge the draft impact of an existing deletion confirmation');

  phase = 'dirty subtree delete';
  await failedDraft('子笔记未保存草稿');
  await openNote(target, title); await click('.notes-document-toolbar button', '脑图'); await requestDelete(target);
  assert.match(await evaluate('document.querySelector("dialog[open]").textContent'), /5 个后代笔记.*未保存草稿/);
  await choose('取消'); await openNote(child, '子笔记草稿'); assert.equal(await body(), '子笔记未保存草稿');
  await openNote(target, title); await click('.notes-document-toolbar button', '脑图'); await requestDelete(target); await choose('移入回收站');
  await poll(async () => (await getNotes()).notes.filter(note => note.deletedAt).length === 6);
  assert.equal((await getNotes()).notes.find(note => note.id === added).deletedAt !== undefined, true);
  assert.equal((await getNotes()).notes.find(note => note.id === other).deletedAt, undefined);
  await poll(() => evaluate('!document.querySelector(".notes-toolbar .draft-indicator")'));
  checks.push('dirty subtree warning is explicit; cancellation preserves its draft and confirmation recycles only that subtree');

  phase = 'discard draft';
  await openNote(other, '独立草稿笔记'); await click('.notes-document-toolbar button', '编辑'); await failedDraft('待放弃的草稿');
  await click('.notes-document-scroll > button', '放弃草稿'); await modal('放弃草稿'); await capture('discard'); await choose('取消');
  assert.equal(await body(), '待放弃的草稿'); assert.equal((await getNotes()).notes.find(note => note.id === other).body, '原正文');
  readGate = { promise: new Promise(done => releaseRead = done), entered: false };
  await click('.notes-document-scroll > button', '放弃草稿'); await choose('放弃草稿'); await poll(() => readGate.entered); await frame();
  assert.equal(await evaluate('document.activeElement?.getAttribute("aria-label")'), '搜索笔记', 'accepting a delayed discard restores focus to a stable enabled control');
  releaseRead(); readGate = undefined;
  await poll(() => body().then(text => text === '原正文'));
  assert.equal(await evaluate('document.activeElement?.getAttribute("aria-label")'), '搜索笔记');
  checks.push('discard cancellation keeps the failed draft; accepting restores the saved content');

  phase = 'load latest content with revision recheck';
  await failedDraft('冲突时保留的草稿'); await mutate({ operation: 'edit', id: other, body: '外部版本一' }); await refresh();
  await poll(() => evaluate('!!document.querySelector(".notes-conflict")'));
  await click('.notes-conflict button', '载入最新内容'); await modal('载入最新内容'); await capture('load-latest'); await choose('取消');
  assert.equal(await body(), '冲突时保留的草稿');
  await click('.notes-conflict button', '载入最新内容'); await mutate({ operation: 'edit', id: other, body: '外部版本二' }); await choose('载入最新内容');
  await poll(() => evaluate('document.querySelector(".notes-error")?.textContent.includes("笔记或草稿已变化")'));
  assert.equal(await body(), '冲突时保留的草稿', 'a version changed during confirmation cannot discard the draft');
  await click('.notes-conflict button', '载入最新内容'); await choose('载入最新内容');
  await poll(() => body().then(text => text === '外部版本二'));
  assert.equal(await evaluate('!!document.querySelector(".notes-conflict")'), false);
  checks.push('load-latest cancellation and stale confirmation keep the draft; a fresh confirmation loads the current source');

  phase = 'merged baseline acknowledgement';
  await failedDraft('已核对的合并正文'); await mutate({ operation: 'edit', id: other, body: '外部版本三' }); await refresh();
  await poll(() => evaluate('!!document.querySelector(".notes-conflict")'));
  await click('.notes-conflict button', '已合并'); await modal('确认合并'); await capture('merge'); await choose('取消');
  assert.equal(await body(), '已核对的合并正文'); assert.equal((await getNotes()).notes.find(note => note.id === other).body, '外部版本三');
  await click('.notes-conflict button', '已合并'); await mutate({ operation: 'edit', id: other, body: '外部版本四' }); await choose('继续编辑');
  await poll(() => evaluate('document.querySelector(".notes-error")?.textContent.includes("笔记或草稿已变化")'));
  assert.equal((await getNotes()).notes.find(note => note.id === other).body, '外部版本四');
  rejectEdits = false; await click('.notes-conflict button', '已合并'); await choose('继续编辑');
  await poll(async () => (await getNotes()).notes.find(note => note.id === other).body === '已核对的合并正文');
  await poll(() => evaluate('!document.querySelector(".notes-toolbar .draft-indicator")'));
  checks.push('merge acknowledgement is inert on cancel or stale versions; a fresh acknowledgement retains the merged text and resumes autosave');
  assert.deepEqual(await evaluate('window.__nativeConfirms'), []);
  assert.deepEqual(await evaluate('window.__errors'), []);
  writeFileSync(join(fixture, 'result.json'), JSON.stringify({ passed: true, checks }, null, 2)); console.log(JSON.stringify({ passed: true, fixture, checks }, null, 2));
} catch (error) { console.error('Confirmation phase:', phase); try { console.error(await browser?.evaluate('JSON.stringify({native:window.__nativeConfirms,errors:window.__errors,focus:document.activeElement?.tagName,noteError:document.querySelector(".notes-error")?.textContent})')); await browser?.screenshot('failure.png'); } catch {} throw error; }
finally { releaseRead?.(); releaseMedia?.(); await browser?.close(); bridge.closeAllConnections(); await new Promise(done => bridge.close(done)); await engine.close(); }
