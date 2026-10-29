import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync,writeFileSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { WorkflowEngine } from '../src/core/engine.ts';
import { ProjectStore } from '../src/core/store.ts';
import { projectDirectory,insideProject } from '../src/core/paths.ts';
import { accountFixture } from './account-fixture.ts';
import { openRendererFixture } from './human-review-electron-fixture.mjs';

const root=resolve('.'),fixture=mkdtempSync(join(projectDirectory(root,'.runtime','implementation','project-direction'),'electron-'));
const path=name=>insideProject(root,join(fixture,name));
const directories=['basic','web'].map(name=>projectDirectory(fixture,name)),nativeCalls=[],commands=[];
const options={workbenchRoot:fixture,executable:'fixture',accountFactory:accountFixture().factory,nativeFactory(){return{async connect(){},async close(){},async rpc(method){nativeCalls.push(method);if(['thread/start','thread/resume','turn/start'].includes(method))throw Error('Creation must not run a model');if(method==='account/read')return{account:{email:'fixture'}};if(method==='windowsSandbox/readiness')return{status:'configured'};if(method==='model/list')return{data:[{id:'fixture-model',model:'fixture-model',displayName:'Fixture model',isDefault:true}],nextCursor:null};if(method==='skills/list')return{data:[{skills:[],errors:[]}]};if(method==='plugin/installed')return{marketplaces:[],marketplaceLoadErrors:[]};if(method==='hooks/list'||method==='mcpServerStatus/list')return{data:[],nextCursor:null};return{}}}}};
let engine=new WorkflowEngine(options);await engine.init();
const oldRoot=projectDirectory(fixture,'legacy');await engine.command({type:'create_project',root:oldRoot,name:'已有项目'});await engine.close();
const store=new ProjectStore(oldRoot);try{const state=store.read();state.project.goal='STALE_GOAL_MUST_NOT_APPEAR';store.save(state)}finally{store.close()}
engine=new WorkflowEngine(options);await engine.init();
const bridge=createServer((request,response)=>{let body='';request.on('data',data=>body+=data);request.on('end',()=>{void(async()=>{try{const envelope=JSON.parse(body);commands.push(structuredClone(envelope.command));response.setHeader('Content-Type','application/json');response.end(JSON.stringify(await engine.command(envelope.command,envelope.id)))}catch(error){response.statusCode=500;response.end(JSON.stringify({error:String(error)}))}})()})});
bridge.listen(0,'127.0.0.1');await once(bridge,'listening');const url=`http://127.0.0.1:${bridge.address().port}`;
writeFileSync(path('preload.cjs'),`const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('mixcat',{command:e=>ipcRenderer.invoke('command',e),subscribe:()=>()=>{},chooseDirectory:()=>ipcRenderer.invoke('choose-directory'),chooseAttachments:async()=>[],panel:async()=>({panels:[],activePanelId:null}),subscribePanels:()=>()=>{}});`);
writeFileSync(path('main.cjs'),`const{app,BrowserWindow,ipcMain}=require('electron');for(const name of ['userData','sessionData','logs','crashDumps','temp'])app.setPath(name,require('node:path').join(${JSON.stringify(fixture)},name));app.commandLine.appendSwitch('disk-cache-dir',${JSON.stringify(path('cache'))});let choice=0;ipcMain.handle('choose-directory',()=>${JSON.stringify(directories)}[choice++]);ipcMain.handle('command',async(_,body)=>{const response=await fetch(${JSON.stringify(url)},{method:'POST',body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw Error(result.error);return result});app.whenReady().then(()=>{const win=new BrowserWindow({width:1600,height:1000,show:false,webPreferences:{preload:${JSON.stringify(path('preload.cjs'))},backgroundThrottling:false}});win.webContents.once('did-finish-load',()=>win.showInactive());win.loadFile(${JSON.stringify(join(root,'dist/client/renderer/index.html'))})});app.on('window-all-closed',()=>app.quit());`);
let driver;
try{
  driver=await openRendererFixture(root,fixture);console.log(JSON.stringify({fixture}));
  const{evaluate,poll,click,fill,screenshot,rpc}=driver;
  await poll(()=>evaluate("document.querySelectorAll('.project-card').length===1"));
  await screenshot('before-card-check.png');
  assert.equal(await evaluate("document.querySelector('.projects-page .page-heading h1').textContent"),'项目','The project title must not include a count');
  assert.equal(await evaluate("document.querySelectorAll('.heading-count,.project-card-bottom,.projects-hint').length"),0,'Remove the redundant project count and entry hints');
  assert.equal(await evaluate("document.querySelectorAll('.project-goal').length"),0,'Retired goal rows must be removed from cards');
  assert.equal(await evaluate("document.body.textContent.includes('STALE_GOAL_MUST_NOT_APPEAR')"),false);
  for(const template of ['basic','web-product']){
    await click('button','新建项目');await poll(()=>evaluate("!!document.querySelector('dialog[open]')"));
    assert.equal(await evaluate("document.querySelectorAll('dialog textarea').length"),0,'Project setup must not require an immediate goal');
    assert.equal(await evaluate("document.querySelector('dialog').textContent.includes('项目目标')"),false);
    await fill('dialog input',template==='basic'?'开始讨论需求':'可调整方向的模板');await click('dialog button','浏览');
    if(template==='web-product')await evaluate("(()=>{const e=document.querySelector('select[aria-label=工作流模板]');e.value='web-product';e.dispatchEvent(new Event('change',{bubbles:true}))})()");
    await poll(()=>evaluate("!document.querySelector('dialog .primary').disabled"));
    await screenshot(`create-${template}-without-goal.png`);await click('dialog .primary');
    await poll(()=>evaluate(`document.querySelectorAll('.conversation-node').length===${template==='basic'?3:8}`));
    const state=(await engine.command({type:'snapshot'})).snapshot.selected;
    assert.equal(Object.hasOwn(state.project,'goal'),false);assert.equal(state.tasks.length,0);
    await click('nav[aria-label="工作空间"] > button');await poll(()=>evaluate(`document.querySelectorAll('.project-card').length===${template==='basic'?2:3}`));
    assert.equal(await evaluate("document.querySelectorAll('.project-goal').length"),0);
  }
  const creates=commands.filter(command=>command.type==='create_project');assert.equal(creates.length,2);assert(creates.every(command=>!Object.hasOwn(command,'goal')));
  assert(!nativeCalls.some(method=>['thread/start','thread/resume','turn/start'].includes(method)));
  await screenshot('projects-without-fixed-goals.png');
  const firstCardRoot=await evaluate("document.querySelector('.project-card .project-path').getAttribute('title')");
  await click('.project-card');await poll(()=>evaluate("!!document.querySelector('.workbench')"));
  assert.equal((await engine.command({type:'snapshot'})).snapshot.selected.project.root,firstCardRoot);
  await click('nav[aria-label="工作空间"] > button');await poll(()=>evaluate("document.querySelectorAll('.project-card').length===3"));
  await evaluate("document.querySelector('.project-card').focus()");
  await rpc('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});await rpc('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await poll(()=>evaluate("!!document.querySelector('.workbench')"));
  assert.equal((await engine.command({type:'snapshot'})).snapshot.selected.project.root,firstCardRoot);
  console.log(JSON.stringify({fixture,basicAndTemplateCreation:'passed',legacyCards:'passed',noFixedGoalPayload:'passed',noModelWorkDuringCreation:'passed',minimalProjectList:'passed',wholeCardMouseAndEnter:'passed'}));
}finally{await driver?.close();await new Promise(done=>bridge.close(done));await engine.close()}
