import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WorkflowEngine } from '../src/core/engine.ts';
import { ensureProjectDirectory, insideProject, projectDirectory } from '../src/core/paths.ts';
import { openRendererFixture } from './human-review-electron-fixture.mjs';

const root = ensureProjectDirectory(resolve('.'));
const evidence = projectDirectory(root, '.runtime', 'implementation', 'shared-document');
const fixture = ensureProjectDirectory(mkdtempSync(insideProject(root, join(evidence, 'electron-'))));
const engine = new WorkflowEngine({ workbenchRoot: fixture, executable: 'unused', nativeFactory() { assert.fail('Document editing must not start an Agent'); } });
await engine.init();
const project = (await engine.command({ type: 'create_project', root: fixture, name: '共享编辑器验收', goal: '验证 Grove 编辑行为' })).snapshot.selected.project;
const update = input => engine.command({ type: 'update_project_item', projectId: project.id, input: { request_id: crypto.randomUUID(), ...input } });
const original = '# 原始标题\r\n\r\n第一段落。\r\n\r\n| 项目 | 内容 |\r\n| :--- | ---: |\r\n| 甲 | **原文** |\r\n\r\n[引用][official]\r\n\r\n[official]: https://example.com\r\n';
const created = (await update({ operation: 'create', kind: 'document', title: '共享表格正文', body: original })).projectItem;
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
writeFileSync(insideProject(fixture, join(fixture, 'main.cjs')), `const{app,BrowserWindow,ipcMain}=require('electron');const{join}=require('node:path');for(const name of ['userData','sessionData','logs','crashDumps','temp'])app.setPath(name,join(${JSON.stringify(fixture)},name));app.commandLine.appendSwitch('disk-cache-dir',join(${JSON.stringify(fixture)},'cache'));ipcMain.handle('command',async(_,body)=>{const response=await fetch(${JSON.stringify(bridgeUrl)},{method:'POST',body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw Error(result.error);return result;});app.on('window-all-closed',()=>app.quit());app.whenReady().then(()=>{const win=new BrowserWindow({width:1400,height:1000,show:false,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});win.loadFile(${JSON.stringify(join(root,'dist/client/renderer/index.html'))});});`);
let browser;
try {
  browser = await openRendererFixture(root, fixture);
  const { click, fill, evaluate, poll, rpc } = browser;
  const key = async (key, code, modifiers = 0) => { for (const type of ['keyDown', 'keyUp']) await rpc('Input.dispatchKeyEvent', { type, key, code: code ?? key, modifiers }); };
  await click('.project-card'); await click('.project-view-nav button', '文档'); await click('.document-file', '共享表格正文');
  await poll(() => evaluate("!!document.querySelector('.document-reading .project-markdown')"));
  await click('.item-detail-heading button', '编辑');
  assert.equal(await evaluate("!!document.querySelector('.document-editing td[contenteditable=true]')"), true, 'Grove tables can be edited directly in preview');
  await fill('.document-editing td[contenteditable=true]:last-child', '修改原文');
  await click('.item-detail-heading button', '阅读');
  await poll(() => evaluate("!!document.querySelector('.document-reading')"));
  const afterTable = original.replace('**原文**', '**修改原文**');
  assert.equal(readFileSync(join(fixture, created.item.path), 'utf8'), afterTable, 'editing one rendered table cell preserves other Markdown bytes, alignment and CRLF');
  assert.equal(await evaluate("document.querySelector('.document-reading a[href=\"https://example.com\"]')?.textContent"), '引用');
  await click('.item-detail-heading button', '编辑');
  await evaluate("document.querySelector('[aria-label=工作项正文]').focus({preventScroll:true})");
  await key('End', 'End', 2);
  await evaluate(`(()=>{const data=new DataTransfer();data.setData('text/html','<h2>粘贴标题</h2><p>中文<strong>强调</strong>与链接。</p><table><thead><tr><th>列</th></tr></thead><tbody><tr><td>值</td></tr></tbody></table>');document.querySelector('[aria-label=工作项正文]').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));})()`);
  await click('.item-detail-heading button', '阅读');
  await poll(() => evaluate("!!document.querySelector('.document-reading h2')"));
  const rich = readFileSync(join(fixture, created.item.path), 'utf8');
  assert.match(rich, /## 粘贴标题\r\n/); assert.match(rich, /中文\*\*强调\*\*与链接。/); assert.match(rich, /\| 列\s*\|/);
  assert.equal(rich.replace(/\r\n/g, '').includes('\n'), false, 'rich paste follows the source line endings');
  await click('.item-detail-heading button', '编辑');
  await evaluate("document.querySelector('[aria-label=工作项正文]').focus({preventScroll:true})");
  await key('a', 'KeyA', 2); await rpc('Input.insertText', { text: '一段足够长的正文，用于验证列表退出。\r\n\r\n- 已有条目\r\n- ' });
  await key('End', 'End', 2); await key('Enter', 'Enter'); await rpc('Input.insertText', { text: '退出列表后的正文' });
  await click('.item-detail-heading button', '阅读');
  await poll(() => evaluate("!!document.querySelector('.document-reading')"));
  assert.equal(readFileSync(join(fixture, created.item.path), 'utf8'), '一段足够长的正文，用于验证列表退出。\r\n\r\n- 已有条目\r\n\r\n退出列表后的正文', 'Enter exits a trailing empty list after long text without throwing or merging paragraphs');
  await browser.screenshot('table-and-rich-paste.png');
  writeFileSync(join(fixture, 'result.json'), JSON.stringify({ passed: true, checks: ['direct table edits preserve inline Markdown, alignment and CRLF', 'whole-document reference links', 'HTML headings, emphasis and table paste into Markdown', 'trailing empty list exits to a fresh paragraph'] }, null, 2));
  console.log(JSON.stringify({ passed: true, fixture }, null, 2));
} catch (error) { try { await browser?.screenshot('failure.png'); } catch {} throw error; }
finally { await browser?.close(); bridge.closeAllConnections(); await new Promise(resolve => bridge.close(resolve)); await engine.close(); }
