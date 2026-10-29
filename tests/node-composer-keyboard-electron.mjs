import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { openRendererFixture } from './human-review-electron-fixture.mjs';
import { projectDirectory, insideProject } from '../src/core/paths.ts';

const root = resolve('.'), fixture = mkdtempSync(join(projectDirectory(root, '.runtime', 'implementation', 'node-composer-keyboard'), 'electron-'));
const path = name => insideProject(root, join(fixture, name));
await build({ stdin: { contents: `
import React,{useState}from'react';import{createRoot}from'react-dom/client';import{Workbench}from'./src/renderer/Workbench.tsx';import{ReferenceEditor}from'./src/renderer/ReferenceEditor.tsx';import './src/renderer/styles.css';
const node=(id,x)=>({id,name:'节点 '+id.toUpperCase(),instructions:'键盘消息',tools:[],resultSchema:{},position:{x,y:100},revision:1,threadId:null,status:'idle'});
const initial={project:{id:'p',name:'消息快捷键',root:${JSON.stringify(fixture)},goal:'Composer keyboard',mode:'codex',status:'idle',updatedAt:''},nodes:[node('a',30),node('b',300)],tasks:[],handoffs:[],activities:[],reviewPolicy:{revision:0,checkpoints:[]},humanReviews:[],requests:[],messages:[],conversation:[]};
const commands=[];let sendMode='success',searchMode='ready',pendingSend,pendingSearch;
const item={id:'i',kind:'issue',number:1,title:'引用示例',status:'open',priority:'normal',ownerId:null,parentId:null,position:0,issueType:'task',path:null,archived:false,revision:1,createdAt:'',updatedAt:'',excerpt:''};
window.mixcat={panel:async()=>({panels:[],activePanelId:null}),subscribePanels:()=>()=>{},chooseAttachments:async()=>[{type:'localImage',path:${JSON.stringify(path('attachment.png'))}}]};
function Fixture(){const[snapshot,setSnapshot]=useState(initial),[busy,setBusy]=useState(false),[other,setOther]=useState('');
window.fixture={messages:()=>commands.filter(c=>c.type==='send_message'),busy:setBusy,sendMode:value=>{sendMode=value},searchMode:value=>{searchMode=value},releaseSend:()=>{sendMode='success';pendingSend?.()},releaseSearch:()=>{searchMode='ready';pendingSearch?.()}};
async function execute(command){
  commands.push(command);
  if(command.type==='search_project_items'){
    if(searchMode==='pending')await new Promise(done=>{pendingSearch=done});
    return{snapshot:{projects:[],selected:snapshot,runtime:null},projectItems:{items:searchMode==='empty'?[]:[item],nextCursor:null,revision:1,total:searchMode==='empty'?0:1}};
  }
  if(command.type==='send_message'){
    setBusy(true);
    if(sendMode==='hold')await new Promise(done=>{pendingSend=done});
    await new Promise(done=>setTimeout(done,40));
    setBusy(false);if(sendMode==='fail')return null;
    setSnapshot(s=>({...s,conversation:[...s.conversation,{id:'message-'+commands.filter(c=>c.type==='send_message').length,seq:s.conversation.length+1,nodeId:command.nodeId,taskId:null,threadId:null,turnId:null,itemId:null,direction:'input',source:{kind:'user'},text:command.input.filter(i=>i.type==='text').map(i=>i.text).join(''),content:{},createdAt:new Date().toISOString(),status:'completed'}]}));
  }
  return{snapshot:{projects:[],selected:snapshot,runtime:null},catalog:{models:[],skills:[],plugins:[],errors:[]}};
}
return <><Workbench snapshot={snapshot} runtime={{mode:'codex',connected:true,authenticated:true,accountLabel:'fixture',error:null}} execute={execute} busy={busy} error={null} onError={message=>{throw Error(message)}}/><div style={{position:'absolute',left:20,bottom:20,width:240}}><ReferenceEditor projectId="p" id="other-editor" label="正文示例" value={other} onChange={setOther} execute={execute} rows={2}/></div></>;}
createRoot(document.getElementById('root')).render(<Fixture/>);`, resolveDir: root, loader: 'tsx' }, outfile: path('renderer.js'), bundle: true, format: 'iife', platform: 'browser', logLevel: 'silent' });
writeFileSync(path('index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="renderer.css"><div id="root" style="height:100vh;display:flex"></div><script src="renderer.js"></script>');
writeFileSync(path('attachment.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/acsAAAAASUVORK5CYII=', 'base64'));
writeFileSync(path('main.cjs'), `const{app,BrowserWindow}=require('electron');for(const name of ['userData','sessionData','logs','crashDumps','temp'])app.setPath(name,require('node:path').join(${JSON.stringify(fixture)},name));app.commandLine.appendSwitch('disk-cache-dir',${JSON.stringify(path('cache'))});app.whenReady().then(()=>{const win=new BrowserWindow({width:1650,height:1000,show:false,webPreferences:{backgroundThrottling:false}});win.webContents.once('did-finish-load',()=>win.showInactive());win.loadFile(${JSON.stringify(path('index.html'))});});app.on('window-all-closed',()=>app.quit());`);
const driver = await openRendererFixture(root, fixture), { click, fill, evaluate, poll, rpc, screenshot } = driver;
async function enter(modifiers = 0) { await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers, text: modifiers ? '' : '\r' }); await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers }); }
try {
  await poll(() => evaluate("!!document.querySelector('#task-instruction')"));
  await fill('#task-instruction', '第一条消息');
  await enter();
  await poll(() => evaluate("window.fixture.messages().length===1&&document.querySelector('#task-instruction').value===''"));
  assert.equal(await evaluate("window.fixture.messages()[0].input[0].text"), '第一条消息');
  await poll(() => evaluate("document.querySelector('[data-entry-id=message-1]')?.textContent.includes('第一条消息')"));
  await fill('#task-instruction', '第一行');
  await enter(2);
  await poll(() => evaluate("document.querySelector('#task-instruction').value==='第一行\\n'"));
  assert.equal(await evaluate("window.fixture.messages().length"), 1, 'Ctrl+Enter must not send');
  assert.equal(await evaluate("document.querySelector('#task-instruction').selectionStart"), 4);
  await fill('#task-instruction', '左侧待替换右侧');
  await evaluate("document.querySelector('#task-instruction').setSelectionRange(2,5)");
  await enter(2);
  await poll(() => evaluate("document.querySelector('#task-instruction').value==='左侧\\n右侧'&&document.querySelector('#task-instruction').selectionStart===3"));
  assert.equal(await evaluate("document.querySelector('#task-instruction').selectionStart"), 3);
  assert.equal(await evaluate("window.fixture.messages().length"), 1);
  await fill('#task-instruction', '中文候选');
  await evaluate("document.querySelector('#task-instruction').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,cancelable:true,isComposing:true}))");
  assert.equal(await evaluate("window.fixture.messages().length"), 1, 'Composition Enter must not send');
  await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 });
  await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 });
  assert.equal(await evaluate("window.fixture.messages().length"), 1, 'IME process-key Enter must not send');
  await fill('#task-instruction', 'x'.repeat(131072)); await enter(2);
  assert.equal(await evaluate("document.querySelector('#task-instruction').value.length"), 131072, 'Ctrl+Enter respects the text limit');
  await fill('#task-instruction', '@');
  await poll(() => evaluate("document.querySelector('.reference-results [role=option]')?.textContent.includes('引用示例')"));
  await enter();
  await poll(() => evaluate("document.querySelector('#task-instruction').value.includes('mixcat://p/issue/i')"));
  assert.equal(await evaluate("window.fixture.messages().length"), 1, 'Enter selects a reference without sending');
  await fill('#task-instruction', '@');
  await poll(() => evaluate("!!document.querySelector('.reference-results [role=option]')"));
  await enter(2);
  await poll(() => evaluate("document.querySelector('#task-instruction').value==='@\\n'&&!document.querySelector('.reference-results')"));
  await evaluate("window.fixture.searchMode('pending')"); await fill('#task-instruction', '@等待');
  await poll(() => evaluate("document.querySelector('.reference-results [role=status]')?.textContent.includes('正在查找')"));
  await enter();
  assert.equal(await evaluate("document.querySelector('#task-instruction').value"), '@等待', 'Enter waits for reference choices');
  assert.equal(await evaluate("window.fixture.messages().length"), 1);
  await evaluate('window.fixture.releaseSearch()');
  await poll(() => evaluate("!!document.querySelector('.reference-results [role=option]')"));
  await evaluate("window.fixture.searchMode('empty')"); await fill('#task-instruction', '@无匹配');
  await poll(() => evaluate("document.querySelector('.reference-results')?.textContent.includes('没有匹配')"));
  await enter();
  assert.equal(await evaluate("document.querySelector('#task-instruction').value"), '@无匹配');
  assert.equal(await evaluate("window.fixture.messages().length"), 1);
  await evaluate('window.fixture.busy(true)'); await fill('#task-instruction', '忙碌草稿'); await enter();
  assert.equal(await evaluate("window.fixture.messages().length"), 1);
  assert.equal(await evaluate("document.querySelector('#task-instruction').value"), '忙碌草稿');
  await evaluate('window.fixture.busy(false)'); await fill('#task-instruction', ''); await enter();
  assert.equal(await evaluate("window.fixture.messages().length"), 1, 'Empty input does not send');
  await click('.node-composer button', '添加附件'); await click('#task-instruction'); await enter();
  await poll(() => evaluate("window.fixture.messages().length===2&&!document.querySelector('.attachment-list')"));
  assert.equal(await evaluate("window.fixture.messages()[1].input[0].type"), 'localImage');
  await evaluate("window.fixture.sendMode('fail')"); await fill('#task-instruction', '保留失败草稿'); await enter();
  await poll(() => evaluate("window.fixture.messages().length===3&&!document.querySelector('.node-composer button[type=submit]').disabled"));
  assert.equal(await evaluate("document.querySelector('#task-instruction').value"), '保留失败草稿');
  await click('.react-flow__node[data-id=b] h3'); await fill('#task-instruction', 'B 草稿');
  await click('.react-flow__node[data-id=a] h3');
  assert.equal(await evaluate("document.querySelector('#task-instruction').value"), '保留失败草稿');
  await evaluate("window.fixture.sendMode('hold')"); await click('#task-instruction'); await enter();
  await poll(() => evaluate("window.fixture.messages().length===4"));
  await click('.react-flow__node[data-id=b] h3'); await fill('#task-instruction', 'B 的新草稿');
  await evaluate('window.fixture.releaseSend()');
  await poll(() => evaluate("!document.querySelector('.node-composer button[type=submit]').disabled"));
  assert.equal(await evaluate("document.querySelector('#task-instruction').value"), 'B 的新草稿');
  await click('.react-flow__node[data-id=a] h3');
  await poll(() => evaluate("document.querySelector('#task-instruction').value===''"));
  await fill('#other-editor', '正文第一行'); await enter();
  await poll(() => evaluate("document.querySelector('#other-editor').value==='正文第一行\\n'"));
  assert.equal(await evaluate("window.fixture.messages().length"), 4, 'Other reference editors remain multiline');
  await fill('#task-instruction', '第一行'); await enter(2); await rpc('Input.insertText', { text: '第二行' });
  await screenshot('keyboard-newline.png');
  console.log(JSON.stringify({ fixture, enterSend: 'passed', ctrlNewline: 'passed', composition: 'passed', references: 'passed', limitsAndDisabled: 'passed', attachmentsAndDrafts: 'passed', otherEditors: 'passed' }));
} finally { await driver.close(); }
