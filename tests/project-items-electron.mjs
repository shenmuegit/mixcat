import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WorkflowEngine } from '../src/core/engine.ts';
import { ensureProjectDirectory, insideProject, projectDirectory } from '../src/core/paths.ts';
import { openRendererFixture } from './human-review-electron-fixture.mjs';

const root = ensureProjectDirectory(resolve('.'));
const evidence = projectDirectory(root, '.runtime', 'implementation', 'project-items');
const fixture = ensureProjectDirectory(mkdtempSync(insideProject(root, join(evidence, 'electron-'))));
const engine = new WorkflowEngine({ workbenchRoot: fixture, executable: 'unused', nativeFactory() { assert.fail('Editing project items must not implicitly start an Agent'); } });
await engine.init();
const project = (await engine.command({ type: 'create_project', root: fixture, name: '项目管理验收', goal: '验证用户与节点共享工作资料' })).snapshot.selected.project;
const bridge = createServer((request, response) => {
  let body = ''; request.on('data', chunk => body += chunk);
  request.on('end', () => { void (async () => {
    try { const envelope = JSON.parse(body); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(await engine.command(envelope.command, envelope.id))); }
    catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: String(error.message ?? error) })); }
  })(); });
});
bridge.listen(0, '127.0.0.1'); await once(bridge, 'listening');
const bridgeUrl = `http://127.0.0.1:${bridge.address().port}`;
const preload = insideProject(fixture, join(fixture, 'preload.cjs'));
writeFileSync(preload, `const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('mixcat',{command:e=>ipcRenderer.invoke('command',e),subscribe:()=>()=>{},chooseDirectory:async()=>null,chooseAttachments:async()=>[],setUnsaved:async()=>{},panel:async()=>({panels:[],activePanelId:null}),subscribePanels:()=>()=>{}});`);
writeFileSync(insideProject(fixture, join(fixture, 'main.cjs')), `const{app,BrowserWindow,ipcMain}=require('electron');const{join}=require('node:path');for(const name of ['userData','sessionData','logs','crashDumps','temp'])app.setPath(name,join(${JSON.stringify(fixture)},name));app.commandLine.appendSwitch('disk-cache-dir',join(${JSON.stringify(fixture)},'cache'));ipcMain.handle('command',async(_,body)=>{const response=await fetch(${JSON.stringify(bridgeUrl)},{method:'POST',body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw Error(result.error);return result;});app.on('window-all-closed',()=>app.quit());app.whenReady().then(()=>{const win=new BrowserWindow({width:1550,height:1050,show:false,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});win.loadFile(${JSON.stringify(join(root,'dist/client/renderer/index.html'))});});`);
let browser;
const checks = [];
try {
  browser = await openRendererFixture(root, fixture);
  const { click, fill, evaluate, rpc, poll, screenshot } = browser;
  const title = '.management-detail input[aria-label="工作项标题"]', body = '.management-detail textarea[aria-label="工作项正文"]';
  const choose = label => click('.project-view-nav button', label);
  const save = () => click('.item-save-actions .button.primary');
  const saved = () => poll(() => evaluate("!!document.querySelector('.item-detail-heading')&&!document.querySelector('.item-detail-heading').textContent.includes('新建')&&!document.querySelector('.item-detail-heading').textContent.includes('未保存')"));
  const mention = async (selector, query) => {
    await fill(selector, query);
    await poll(() => evaluate("document.querySelectorAll('.reference-results [role=option]').length>0"));
    await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await poll(() => evaluate(`document.querySelector(${JSON.stringify(selector)}).value.includes('mixcat://')`));
  };
  await click('.project-card'); await choose('待办');
  assert.equal(await evaluate("Math.abs(document.querySelector('.project-workspace').getBoundingClientRect().right-window.innerWidth)<2"), true, 'project views must occupy the full available workspace');
  await click('.management-heading button', '新建待办'); await fill(title, '验收父项'); await fill(body, '建立完整的项目管理验收'); await save(); await saved();
  await click('.item-detail-heading button', '子待办'); await fill(title, '验证子项'); await save(); await saved();
  assert.equal(await evaluate("document.querySelectorAll('.management-tree .management-row').length"), 2);
  assert.equal(await evaluate("document.querySelectorAll('.management-tree>li>ul').length"), 1);
  checks.push('tree creation and hierarchy');
  await choose('Issue'); await click('.management-heading button', '新建Issue'); await fill(title, '验收引用问题');
  await mention(body, '@T-1'); await save(); await saved();
  const issueId = (await engine.command({ type: 'search_project_items', projectId: project.id, query: { kind: 'issue' } })).projectItems.items[0].id;
  assert.match((await engine.command({ type: 'get_project_item', projectId: project.id, itemId: issueId })).projectItem.item.body, /mixcat:\/\//);
  await choose('文档'); await click('.management-heading button', '新建文档'); await fill(title, '管理验收文档'); await fill('input[aria-label="文档路径"]', 'docs/acceptance.md');
  await mention(body, '# 管理验收\n\n@I-1'); await save(); await saved();
  assert.match(readFileSync(join(fixture, 'docs/acceptance.md'), 'utf8'), /mixcat:\/\//);
  await choose('待办'); await click('.management-row-main', '验收父项'); await poll(() => evaluate(`document.querySelector(${JSON.stringify(title)}).value==='验收父项'`));
  await mention(body, '@D-1'); await save(); await saved(); await click('.item-detail-heading button', '预览');
  await click('.management-detail .item-reference', 'D-1'); await poll(() => evaluate("document.querySelector('.project-view-nav [aria-current=page]').textContent==='文档'"));
  await poll(() => evaluate(`document.querySelector(${JSON.stringify(title)}).value==='管理验收文档'`));
  await poll(() => evaluate("!document.querySelector('.item-save-actions .primary').disabled"));
  await screenshot('documents.png'); checks.push('keyboard mentions, real Markdown file and reference navigation');
  await choose('Issue'); await poll(() => evaluate(`document.querySelector(${JSON.stringify(title)}).value==='验收引用问题'`));
  if (!await evaluate(`!!document.querySelector(${JSON.stringify(body)})`)) await click('.item-detail-heading button', '编辑');
  await fill(body, '尚未提交的草稿'); await choose('文档'); await choose('Issue');
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(body)}).value`), '尚未提交的草稿');
  await save(); await saved();
  await mention('textarea[aria-label="Issue 评论"]', '@D-1'); await click('.item-comments button', '发表评论');
  await poll(() => evaluate("document.querySelectorAll('.item-comments article').length===1"));
  checks.push('draft retention and issue comments');
  await choose('文档'); await poll(() => evaluate(`document.querySelector(${JSON.stringify(title)}).value==='管理验收文档'`));
  if (!await evaluate(`!!document.querySelector(${JSON.stringify(body)})`)) await click('.item-detail-heading button', '编辑');
  await fill(body, '用户待合并草稿'); writeFileSync(join(fixture, 'docs/acceptance.md'), '外部新增内容');
  await save(); await poll(() => evaluate("document.body.textContent.includes('冲突')"));
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(body)}).value`), '用户待合并草稿');
  assert.equal(readFileSync(join(fixture, 'docs/acceptance.md'), 'utf8'), '外部新增内容');
  await click('.management-heading button', '刷新'); await poll(() => evaluate("!!document.querySelector('.draft-conflict')"));
  await fill(body, '外部新增内容\n用户合并完成'); await click('.draft-conflict button', '更新保存基线'); await save(); await saved();
  assert.equal(readFileSync(join(fixture, 'docs/acceptance.md'), 'utf8'), '外部新增内容\n用户合并完成');
  checks.push('external-edit conflict and explicit draft merge');
  await choose('待办'); await click('.management-row-main', '验收父项'); await poll(() => evaluate(`document.querySelector(${JSON.stringify(title)}).value==='验收父项'`));
  await click('.item-archive button', '归档子树'); await click('.item-archive button', '确认归档');
  await poll(() => evaluate("document.querySelector('.item-detail-heading').textContent.includes('已归档')"));
  await click('.item-archive button', '恢复子树'); await poll(() => evaluate("!document.querySelector('.item-detail-heading').textContent.includes('已归档')"));
  assert.equal((await engine.command({ type: 'search_project_items', projectId: project.id, query: { kind: 'todo' } })).projectItems.total, 2);
  await evaluate("document.querySelector('.management-detail').scrollTop=0");
  await screenshot('todos.png');
  await click('.item-dispatch button', '交给节点'); await poll(() => evaluate("document.querySelector('.project-view-nav [aria-current=page]').textContent==='工作流'"));
  await poll(() => evaluate("document.querySelector('#task-instruction').value.includes('mixcat://')"));
  assert.equal((await engine.command({ type: 'snapshot' })).snapshot.selected.tasks.length, 0);
  checks.push('subtree archive/restore and explicit node-composer handoff');
  await browser.close(); browser = null; await engine.close();
  const restored = new WorkflowEngine({ workbenchRoot: fixture, executable: 'unused', nativeFactory() { assert.fail(); } });
  await restored.init();
  assert.equal((await restored.command({ type: 'search_project_items', projectId: project.id })).projectItems.total, 4);
  assert.equal((await restored.command({ type: 'get_project_item', projectId: project.id, itemId: issueId })).projectItem.item.comments.length, 1);
  await restored.close(); checks.push('persisted items and comments after backend restart');
  writeFileSync(insideProject(fixture, join(fixture, 'result.json')), JSON.stringify({ passed: true, checks }, null, 2));
  console.log(JSON.stringify({ passed: true, fixture, checks }, null, 2));
} catch (error) {
  try { await browser?.screenshot('failure.png'); } catch {}
  throw error;
} finally { await browser?.close(); bridge.closeAllConnections(); await new Promise(resolve => bridge.close(resolve)); await engine.close(); }
