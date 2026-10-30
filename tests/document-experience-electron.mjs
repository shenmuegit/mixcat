import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WorkflowEngine } from '../src/core/engine.ts';
import { DocumentMediaStore } from '../src/core/document-media.ts';
import { insideProject, projectDirectory } from '../src/core/paths.ts';
import { openRendererFixture } from './human-review-electron-fixture.mjs';

const root = resolve('.'), evidence = projectDirectory(root, '.runtime', 'implementation', 'document-experience');
const fixture = mkdtempSync(insideProject(root, join(evidence, 'electron-')));
const engine = new WorkflowEngine({ workbenchRoot: fixture, executable: 'unused', nativeFactory() { assert.fail('Document interaction must not start an agent'); } });
await engine.init();
const project = (await engine.command({ type: 'create_project', root: fixture, name: '共享正文体验', goal: '验证正文体验' })).snapshot.selected.project;
const item = async id => (await engine.command({ type: 'get_project_item', projectId: project.id, itemId: id })).projectItem;
const mutation = input => engine.command({ type: 'update_project_item', projectId: project.id, input: { request_id: crypto.randomUUID(), ...input } });
const body = '# 一级标题\n\n正文与 **加粗**、[链接](https://example.com)。\n\n## 二级标题\n\n> 引用正文\n\n- 列表一\n- 列表二\n\n| 标题 | 内容 |\n| --- | --- |\n| 项目 | 原文 |\n\n```js\nconst x = 1;\n```\n\n' + Array.from({length:18}, (_,i)=>`## 段落${i + 1}\n\n${'长正文用于滚动与模式切换。'.repeat(5)}`).join('\n\n');
const doc = (await mutation({ operation: 'create', kind: 'document', title: '项目正文甲', body })).projectItem;
const other = (await mutation({ operation: 'create', kind: 'document', title: '项目正文乙', body: '乙原文' })).projectItem;
const firstLoadTargets = [];
for(const name of ['丙','丁'])firstLoadTargets.push((await mutation({operation:'create',kind:'document',title:`首次加载${name}`,body:`${name}原文`})).projectItem);
const notes = async () => (await engine.command({type:'get_notes'})).notes;
const note = (await engine.command({type:'update_note',input:{operation:'create',request_id:crypto.randomUUID(),expected_revision:(await notes()).revision,title:'笔记正文甲',body}})).noteId;
const media = new DocumentMediaStore(fixture, id => { assert.equal(id, project.id); return fixture; });
const unsaved = new Map(); let mediaGate, writeGate, detailGate, failMedia = false, failWrite = false, emptyWriteReply = false;
const holdMedia = () => { let release; const promise = new Promise(done=>release=done); mediaGate={promise,release,entered:false}; };
const releaseMedia = () => { const previous=mediaGate;mediaGate=undefined;previous?.release(); };
const holdWrite = () => { let release; const promise = new Promise(done=>release=done); writeGate={promise,release,entered:false}; };
const releaseWrite = () => { const previous=writeGate;writeGate=undefined;previous?.release(); };
const holdDetail = id => { let release;const promise=new Promise(done=>release=done);detailGate={id,promise,release,entered:false}; };
const releaseDetail = () => { const previous=detailGate;detailGate=undefined;previous?.release(); };
const bridge=createServer((request,response)=>{
  let data='';request.on('data',chunk=>data+=chunk);request.on('end',()=>{void(async()=>{
    try {
      const input=JSON.parse(data); let result;
      if(input.unsaved){unsaved.set(input.unsaved.key,input.unsaved.value);result={};}
      else if(input.media){
        if(input.media.operation==='import'){
          if(mediaGate){const current=mediaGate;current.entered=true;await current.promise;}
          if(failMedia){failMedia=false;throw Error('Simulated media failure');}
        }
        result=media.command(input.media);
      }else {
        if(input.command?.type==='update_project_item'&&input.command.input.operation==='edit'){
          if(writeGate){const current=writeGate;current.entered=true;await current.promise;}
          if(failWrite){failWrite=false;throw Error('Simulated save failure');}
          if(emptyWriteReply){emptyWriteReply=false;response.end('{}');return;}
        }
        if(input.command?.type==='get_project_item'&&detailGate?.id===input.command.itemId){const current=detailGate;current.entered=true;await current.promise;}
        result=await engine.command(input.command,input.id);
      }
      response.setHeader('Content-Type','application/json');response.end(JSON.stringify(result));
    }catch(error){response.statusCode=500;response.end(JSON.stringify({error:String(error.message??error)}));}
  })();});
});
bridge.listen(0,'127.0.0.1');await once(bridge,'listening');
const preload=join(fixture,'preload.cjs');
writeFileSync(preload,`const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('mixcat',{command:e=>ipcRenderer.invoke('command',e),documentMedia:media=>ipcRenderer.invoke('command',{media}),subscribe:()=>()=>{},chooseDirectory:async()=>null,chooseAttachments:async()=>[],setUnsaved:async(key,value)=>ipcRenderer.invoke('command',{unsaved:{key,value}}),panel:async()=>({panels:[],activePanelId:null}),subscribePanels:()=>()=>{}});`);
writeFileSync(join(fixture,'main.cjs'),`const{app,BrowserWindow,ipcMain}=require('electron');const{join}=require('node:path');for(const name of ['userData','sessionData','logs','crashDumps','temp'])app.setPath(name,join(${JSON.stringify(fixture)},name));app.commandLine.appendSwitch('disk-cache-dir',join(${JSON.stringify(fixture)},'cache'));ipcMain.handle('command',async(_,body)=>{const response=await fetch(${JSON.stringify(`http://127.0.0.1:${bridge.address().port}`)},{method:'POST',body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw Error(result.error);return result;});app.on('window-all-closed',()=>app.quit());app.whenReady().then(()=>new BrowserWindow({width:1500,height:1040,show:false,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}}).loadFile(${JSON.stringify(join(root,'dist/client/renderer/index.html'))}));`);
let browser;const checks=[];
try{
  browser=await openRendererFixture(root,fixture);
  const{click,fill,evaluate,poll,rpc}=browser;
  const frame=()=>evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const key=async(key,code=key,modifiers=0)=>{for(const type of ['keyDown','keyUp'])await rpc('Input.dispatchKeyEvent',{type,key,code,modifiers});};
  const clickVisible=async(selector,text)=>{const p=await evaluate(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent.includes(${JSON.stringify(text)})),r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);for(const type of ['mousePressed','mouseReleased'])await rpc('Input.dispatchMouseEvent',{type,...p,button:'left',clickCount:1});};
  const pasteImage=()=>evaluate(`(()=>{const d=new DataTransfer();d.items.add(new File([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6BsUAAAAASUVORK5CYII='),c=>c.charCodeAt(0))],'pixel.png',{type:'image/png'}));document.querySelector('.document-editing .cm-content').dispatchEvent(new ClipboardEvent('paste',{clipboardData:d,bubbles:true,cancelable:true}));})()`);
  const endBody=async()=>{await evaluate("document.querySelector('.document-editing .cm-content').focus({preventScroll:true})");await key('End','End',2);};
  await click('.project-card');await click('.project-view-nav button','文档');await click('.document-file','项目正文甲');
  await poll(()=>evaluate('!!document.querySelector(".document-reading h2")'));
  await evaluate("document.querySelector('.document-workspace .management-detail').scrollTop=600");await frame();
  await clickVisible('.item-detail-heading button','编辑');
  await poll(()=>evaluate('!!document.querySelector(".cm-content")'));
  await frame();
  assert.equal(await evaluate("document.querySelector('.document-workspace .management-detail').scrollTop"),600,'first project editor mount preserves the reading position');
  await endBody();holdMedia();await pasteImage();await poll(()=>mediaGate?.entered);
  await clickVisible('.item-detail-heading button','阅读');await frame();
  assert.equal(await evaluate('!!document.querySelector(".document-editing")'),true,'pending project media must retain its editor through a reading-mode request');
  assert.equal(await evaluate("window.dispatchEvent(new Event('mixcat:before-project-navigation',{cancelable:true}))"),false,'pending media protects project navigation before it has changed the draft');
  await click('.document-file','项目正文乙');await frame();
  assert.equal(await evaluate("document.querySelector('.shared-document').dataset.contentIdentity"),`project:${project.id}:${doc.item.id}`,'document selection waits for pending media');
  assert.equal(unsaved.get(project.id),true,'in-flight import is covered by exit protection');
  await endBody();await rpc('Input.insertText',{text:'导入期间继续输入'});releaseMedia();
  await poll(async()=>/!\[图片\]\(mixcat-asset:/.test((await item(doc.item.id)).item.body));
  assert.match((await item(doc.item.id)).item.body,/导入期间继续输入/);
  assert.equal((await item(other.item.id)).item.body,'乙原文');
  await click('.item-detail-heading button','阅读');await poll(()=>evaluate('!!document.querySelector(".document-reading")'));
  await poll(()=>evaluate("!!document.querySelector('.document-reading img[src^=\"data:image/png\"]')"));
  checks.push('project reading, selection, exit and newer input survive pending media');
  await click('.item-detail-heading button','编辑');await endBody();failMedia=true;await pasteImage();
  await poll(()=>evaluate("!!document.querySelector('.markdown-paste-error')"));
  assert.match(await evaluate("document.querySelector('.markdown-paste-error').textContent"),/Simulated media failure/);
  await click('.document-file','项目正文乙');await poll(()=>evaluate(`document.querySelector('.shared-document')?.dataset.contentIdentity==='project:${project.id}:${other.item.id}'`));
  checks.push('failed media reports an error and releases navigation');
  await click('.document-file','项目正文甲');
  if(!await evaluate('!!document.querySelector(".document-editing")'))await click('.item-detail-heading button','编辑');
  await endBody();failWrite=true;await rpc('Input.insertText',{text:'过期模式切换验证'});
  await poll(()=>evaluate("[...document.querySelectorAll('[role=alert]')].some(e=>e.textContent.includes('保存未完成'))"));
  holdWrite();await click('.item-detail-heading button','阅读');await poll(()=>writeGate?.entered);
  await click('.document-file','项目正文乙');await poll(()=>evaluate(`document.querySelector('.shared-document')?.dataset.contentIdentity==='project:${project.id}:${other.item.id}'`));
  await click('.document-file','项目正文甲');await poll(()=>evaluate(`document.querySelector('.shared-document')?.dataset.contentIdentity==='project:${project.id}:${doc.item.id}'`));
  releaseWrite();await poll(async()=> (await item(doc.item.id)).item.body.includes('过期模式切换验证'));await frame();
  assert.equal(await evaluate('!!document.querySelector(".document-editing")'),true,'a saved reading request from A cannot change the mode after A to B to A navigation');
  checks.push('old save completion cannot change a newly reopened editor');
  await endBody();failWrite=true;await rpc('Input.insertText',{text:'保存期间开始导入验证'});
  await poll(()=>evaluate("[...document.querySelectorAll('[role=alert]')].some(e=>e.textContent.includes('保存未完成'))"));
  holdWrite();await click('.item-detail-heading button','阅读');await poll(()=>writeGate?.entered);
  holdMedia();await endBody();await pasteImage();await poll(()=>mediaGate?.entered);
  releaseWrite();await poll(async()=> (await item(doc.item.id)).item.body.includes('保存期间开始导入验证'));await frame();
  assert.equal(await evaluate('!!document.querySelector(".document-editing")'),true,'media that starts during a mode save must still retain its editor');
  releaseMedia();await poll(async()=> ((await item(doc.item.id)).item.body.match(/!\[图片\]/g)||[]).length===2);
  checks.push('mode saves recheck media before hiding the editor');
  for(const [index,target] of firstLoadTargets.entries()){
    await endBody();holdWrite();await rpc('Input.insertText',{text:`失败后保留草稿${index}`});await poll(()=>writeGate?.entered);
    holdDetail(target.item.id);await click('.document-file',target.item.title);await poll(()=>detailGate?.entered);
    if(index===0)failWrite=true;else emptyWriteReply=true;
    releaseWrite();await poll(()=>evaluate("document.querySelector('.management-detail .inline-error')?.textContent.includes('保存未完成')"));
    releaseDetail();await poll(()=>evaluate(`document.querySelector('.shared-document')?.dataset.contentIdentity==='project:${project.id}:${target.item.id}'`));
    assert.equal((await item(target.item.id)).item.body,target.item.body,'old failure cannot overwrite the newly selected document');
    await click('.document-file','项目正文甲');await poll(()=>evaluate('!!document.querySelector(".document-editing .cm-content")'));
    await endBody();await frame();
    assert.equal(await evaluate(`document.querySelector('.cm-content').textContent.includes('失败后保留草稿${index}')`),true,'the failed source retains its draft after returning');
    await click('.item-detail-heading button','阅读');await poll(async()=> (await item(doc.item.id)).item.body.includes(`失败后保留草稿${index}`));
    await click('.item-detail-heading button','编辑');
  }
  checks.push('failed and empty save responses preserve another document first load and the original retryable draft');
  if(await evaluate('!!document.querySelector(".document-editing")'))await click('.item-detail-heading button','阅读');
  const metrics=()=>evaluate(`(()=>{const root=document.querySelector('.shared-document'),active=[...root.querySelectorAll('.project-markdown')].find(e=>e.getClientRects().length),title=root.querySelector('.document-title'),styles=e=>{const s=getComputedStyle(e);return{size:s.fontSize,line:s.lineHeight,weight:s.fontWeight}};return{title:styles(title),body:styles(active),h1:styles(active.querySelector('h1')),h2:styles(active.querySelector('h2')),table:styles(active.querySelector('table'))}})()`);
  const projectMetrics=await metrics();
  assert.equal(projectMetrics.body.size,'18px');assert.equal(projectMetrics.body.line,'32.76px');assert.equal(projectMetrics.h1.size,'30px');assert.equal(projectMetrics.h2.size,'26px');assert.equal(projectMetrics.table.size,'18px');
  await evaluate("document.querySelector('.document-workspace .management-detail').scrollTop=0");await frame();
  await browser.screenshot('project-reading.png');
  await click('.item-detail-heading button','编辑');
  await poll(()=>evaluate('!!document.querySelector(".document-editing .cm-content")'));await frame();
  const originalScroll=await evaluate("(()=>{const p=document.querySelector('.document-workspace .management-detail');p.scrollTop=600;return p.scrollTop})()");
  await frame();await clickVisible('.item-detail-heading button','阅读');await frame();
  const readingScroll=await evaluate("document.querySelector('.document-workspace .management-detail').scrollTop");
  assert(Math.abs(readingScroll-originalScroll)<2,`project mode switch preserves the scroll offset (${originalScroll} -> ${readingScroll})`);
  await click('.document-sidebar button','二级标题');await frame();
  assert.equal(await evaluate('document.activeElement.textContent'),'二级标题','outline focuses its visible heading');
  checks.push('project reading metrics, scroll and outline match the shared experience');
  await click('.workspace-sidebar nav > button','笔记');
  await fill('[aria-label=搜索笔记]','笔记正文甲');await click('.notes-search-results button','笔记正文甲');await fill('[aria-label=搜索笔记]','');
  await poll(()=>evaluate(`!!document.querySelector('[data-content-identity="note:${note}"]')`));
  assert.deepEqual(await metrics(),projectMetrics,'identical Markdown has identical reading typography for notes and project documents');
  await browser.screenshot('note-reading.png');
  await evaluate("document.querySelector('.notes-document-scroll').scrollTop=600");await frame();
  await click('.notes-document-toolbar button','编辑');await poll(()=>evaluate('!!document.querySelector(".notes-document-pane .cm-content")'));
  await frame();
  assert.equal(await evaluate("document.querySelector('.notes-document-scroll').scrollTop"),600,'first note editor mount preserves the reading position');
  const title='笔记长标题自动换行，编辑和阅读保持一致 Long title '.repeat(4).trim();
  await fill('[aria-label=笔记标题]',title);
  assert.equal(await evaluate("document.querySelector('[aria-label=笔记标题]').tagName"),'TEXTAREA');
  assert.equal(await evaluate("(()=>{const e=document.querySelector('[aria-label=笔记标题]');return e.scrollWidth<=e.clientWidth+1&&e.clientHeight>parseFloat(getComputedStyle(e).lineHeight)*2})()"),true);
  const noteScroll=await evaluate("(()=>{const p=document.querySelector('.notes-document-scroll');p.scrollTop=600;return p.scrollTop})()");
  await clickVisible('.notes-document-toolbar button','阅读');await frame();
  assert(Math.abs(await evaluate("document.querySelector('.notes-document-scroll').scrollTop")-noteScroll)<2,'note mode switch preserves the scroll offset like Grove');
  await poll(async()=> (await notes()).notes.find(n=>n.id===note)?.title===title);
  assert.equal((await item(other.item.id)).item.body,'乙原文');
  checks.push('note title wrapping, immediate persistence and mode scroll continuity');
  await evaluate("document.querySelector('.notes-document-scroll').scrollTop=0");await frame();
  const readingTitleHeight=await evaluate("document.querySelector('.document-title').getBoundingClientRect().height");
  await browser.screenshot('note-long-title-reading.png');
  await click('.notes-document-toolbar button','编辑');await frame();
  assert(Math.abs(await evaluate("document.querySelector('.document-title').getBoundingClientRect().height")-readingTitleHeight)<2,'title wrapping has matching geometry across modes');
  await browser.screenshot('note-long-title-editing.png');
  await rpc('Emulation.setDeviceMetricsOverride',{width:1100,height:800,deviceScaleFactor:1,mobile:false});await frame();
  assert.equal(await evaluate("(()=>{const e=document.querySelector('.notes-document-scroll'),t=e.querySelector('.document-title');return e.scrollWidth<=e.clientWidth+1&&t.scrollHeight<=t.clientHeight+1})()"),true,'narrow desktop note title and body remain within the drawer');
  await browser.screenshot('note-editing-1100.png');
  await click('.notes-document-toolbar button','阅读');
  await click('.workspace-sidebar nav > button','项目');await click('.project-card');await click('.project-view-nav button','文档');await click('.document-file','项目正文甲');
  if(await evaluate('!!document.querySelector(".document-editing")'))await click('.item-detail-heading button','阅读');
  await evaluate("document.querySelector('.document-workspace .management-detail').scrollTop=0");await frame();
  assert.equal(await evaluate("(()=>{const e=document.querySelector('.shared-document');return e.scrollWidth<=e.clientWidth+1})()"),true,'narrow desktop project Markdown stays inside its column');
  await browser.screenshot('project-reading-1100.png');
  checks.push('desktop 1500 and 1100 render long titles and shared Markdown without clipping');
  assert.match(readFileSync(join(fixture,doc.item.path),'utf8'),/mixcat-asset:/);
  writeFileSync(join(fixture,'result.json'),JSON.stringify({passed:true,checks,projectMetrics},null,2));
  console.log(JSON.stringify({passed:true,fixture,checks},null,2));
}catch(error){try{await browser?.screenshot('failure.png');}catch{}throw error;}
finally{releaseMedia();releaseWrite();releaseDetail();await browser?.close();bridge.closeAllConnections();await new Promise(resolve=>bridge.close(resolve));await engine.close();}
