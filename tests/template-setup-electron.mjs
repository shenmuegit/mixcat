import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WorkflowEngine } from '../src/core/engine.ts';
import { projectDirectory, insideProject } from '../src/core/paths.ts';
import { accountFixture } from './account-fixture.ts';
import { openRendererFixture } from './human-review-electron-fixture.mjs';

const root=resolve('.'), fixture=mkdtempSync(join(projectDirectory(root,'.runtime','implementation','template-capabilities-193'),'electron-'));
const path=name=>insideProject(fixture,join(fixture,name));
const cases=[['research-analysis',4,['ecc','superpowers','planning-with-files']],['content-creation',3,['ecc']],['bug-fix',3,['ecc','superpowers','planning-with-files','ponytail','gitnexus']],['web-product',8,['ecc','superpowers','planning-with-files','ponytail','gitnexus']]];
const directories=[...cases.map(([id])=>projectDirectory(fixture,id)),projectDirectory(fixture,'legacy')];
process.env.MIXCAT_HOST_CODEX_HOME=projectDirectory(fixture,'host');
const skillNames={ecc:['research-ops','deep-research','article-writing','content-engine','coding-standards','verification-loop','product-lens','product-capability','frontend-patterns','backend-patterns','e2e-testing','architecture-decision-records'],superpowers:['systematic-debugging'],'planning-with-files':['planning-with-files'],ponytail:['ponytail'],gitnexus:['gitnexus-exploring','gitnexus-debugging','gitnexus-impact-analysis']};
const installations=new Map(),calls=[];let failPony=true, releaseResearch;
const researchGate=new Promise(done=>releaseResearch=done);
const options={workbenchRoot:fixture,executable:'fixture',accountFactory:accountFixture().factory,async installTemplateSkill(cwd,overwrite){calls.push({cwd,method:'skill/install',overwrite});const folder=projectDirectory(cwd,'.agents','skills','impeccable');writeFileSync(join(folder,'SKILL.md'),'---\nname: impeccable\n---\nFixture skill');installations.get(cwd).set('impeccable','2.0.0');},nativeFactory({cwd}){
  const installed=installations.get(cwd)??new Map(cwd.endsWith('content-creation')?['ecc','superpowers','planning-with-files'].map(id=>[id,'1.0.0']):[]);installations.set(cwd,installed);
  return{async connect(){},async close(){},async rpc(method,params){calls.push({cwd,method,params});
    if(method==='model/list')return{data:[{model:'fixture-model',displayName:'Fixture model',isDefault:true}],nextCursor:null};
    if(method==='plugin/installed')return{marketplaces:[{plugins:[...installed].filter(([id])=>id!=='impeccable').map(([id,version])=>({id:`${id}@${id}`,name:id,installed:true,enabled:true,version}))}],marketplaceLoadErrors:[]};
    if(method==='skills/list')return{data:[{skills:[...installed.keys()].flatMap(id=>id==='impeccable'?[{name:id,path:join(cwd,'.agents','skills',id,'SKILL.md'),enabled:true}]:skillNames[id].map(name=>({name:`${id}:${name}`,path:join(cwd,'.mixcat','native-skills',id,name,'SKILL.md'),enabled:true}))),errors:[]}]};
    if(method==='hooks/list')return{data:[{hooks:[],errors:[]}]};if(method==='mcpServerStatus/list')return{data:[],nextCursor:null};
    if(method==='marketplace/add'){const id=params.source.includes('superpowers')?'superpowers':params.source.includes('ECC')?'ecc':params.source.split('/').at(-1).toLowerCase();return{marketplaceName:id,installedRoot:projectDirectory(cwd,'.mixcat','codex','markets',id),alreadyAdded:false};}
    if(method==='plugin/list')return{marketplaces:Object.keys(skillNames).map(id=>({name:id,path:join(cwd,'.mixcat','codex','markets',id,'.claude-plugin','marketplace.json'),plugins:[{name:id,id:`${id}@${id}`}]}))};
    if(method==='plugin/install'){if(cwd.endsWith('research-analysis')&&params.pluginName==='ecc')await researchGate;if(cwd.endsWith('bug-fix')&&params.pluginName==='ponytail'&&failPony)throw Error('Fixture network failure');installed.set(params.pluginName,'2.0.0');return{appsNeedingAuth:[],authPolicy:'ON_INSTALL'};}
    if(method==='account/read')return{account:{email:'fixture'}};if(method==='windowsSandbox/readiness')return{status:'configured'};
    assert(!['thread/start','thread/resume','turn/start'].includes(method),'Setup cannot launch model work');return{};
  }};
}};
const engine=new WorkflowEngine(options);await engine.init();await engine.command({type:'create_project',root:directories.at(-1),name:'Legacy project'});
const bridge=createServer((request,response)=>{let body='';request.on('data',data=>body+=data);request.on('end',()=>void(async()=>{try{const envelope=JSON.parse(body);response.setHeader('Content-Type','application/json');response.end(JSON.stringify(await engine.command(envelope.command,envelope.id)))}catch(error){response.statusCode=500;response.end(JSON.stringify({error:String(error)}))}})())});
bridge.listen(0,'127.0.0.1');await once(bridge,'listening');const url=`http://127.0.0.1:${bridge.address().port}`;
writeFileSync(path('preload.cjs'),`const{contextBridge,ipcRenderer}=require('electron');const listeners=[];contextBridge.exposeInMainWorld('mixcat',{command:e=>ipcRenderer.invoke('command',e),subscribe:f=>{listeners.push(f);return()=>listeners.splice(listeners.indexOf(f),1)},chooseDirectory:()=>ipcRenderer.invoke('choose-directory'),chooseAttachments:async()=>[],setUnsaved:async()=>{},panel:async()=>({panels:[],activePanelId:null}),subscribePanels:()=>()=>{}});contextBridge.exposeInMainWorld('fixture',{push:update=>listeners.forEach(f=>f(update))});`);
writeFileSync(path('main.cjs'),`const{app,BrowserWindow,ipcMain}=require('electron');const{join}=require('node:path');for(const name of ['userData','sessionData','logs','crashDumps','temp'])app.setPath(name,join(${JSON.stringify(fixture)},name));app.commandLine.appendSwitch('disk-cache-dir',join(${JSON.stringify(fixture)},'cache'));let choice=0;ipcMain.handle('choose-directory',()=>${JSON.stringify(directories)}[choice++]);ipcMain.handle('command',async(_,body)=>{const response=await fetch(${JSON.stringify(url)},{method:'POST',body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw Error(result.error);return result});app.whenReady().then(()=>{const win=new BrowserWindow({width:1600,height:1100,show:false,webPreferences:{preload:${JSON.stringify(path('preload.cjs'))},backgroundThrottling:false}});win.webContents.once('did-finish-load',()=>win.showInactive());win.loadFile(${JSON.stringify(join(root,'dist/client/renderer/index.html'))})});app.on('window-all-closed',()=>app.quit());`);
let driver;const unsubscribe=engine.subscribe(update=>{if(driver)void driver.evaluate(`window.fixture.push(${JSON.stringify(update)})`).catch(()=>{})});
try{
  driver=await openRendererFixture(root,fixture);const{evaluate,poll,click,fill,screenshot}=driver;console.log(JSON.stringify({fixture}));
  await click('nav[aria-label="工作空间"] button[aria-label="项目"]');await poll(()=>evaluate("document.querySelectorAll('.project-card').length===1"));
  assert.equal(calls.filter(call=>call.method==='plugin/install').length,0,'Startup and ordinary projects do not install capabilities');
  for(const[template,count,expected]of cases){
    await click('button','新建项目');await fill('dialog input',`Setup ${template}`);await click('dialog button','浏览');
    await evaluate(`(()=>{const e=document.querySelector('select[aria-label=工作流模板]');e.value=${JSON.stringify(template)};e.dispatchEvent(new Event('change',{bubbles:true}))})()`);await click('dialog .primary');
    await poll(()=>evaluate('!!document.querySelector(\'dialog[aria-label="准备模板能力"]\')'));const cwd=directories.find(folder=>folder.endsWith(template));
    if(template==='content-creation'){
      await poll(()=>evaluate('!!document.querySelector(\'select[aria-label="ECC 已有能力处理"]\')'));assert.equal(calls.filter(call=>call.cwd===cwd&&call.method==='plugin/install').length,0);
      assert.equal(await evaluate('document.querySelector(\'select[aria-label="ECC 已有能力处理"]\').value'),'skip');await screenshot('existing-default-skip.png');
      await evaluate('(()=>{const e=document.querySelector(\'select[aria-label="ECC 已有能力处理"]\');e.value="overwrite";e.dispatchEvent(new Event("change",{bubbles:true}))})()');await click('dialog button','准备所选能力');
    }
    if(template==='research-analysis'){await poll(()=>evaluate('!!document.querySelector(\'.template-setup-item[data-state="installing"]\')'));await screenshot('native-install-progress.png');assert.equal(await evaluate('!!document.querySelector(".error-banner")'),false,'Preparation must allow background project observations');releaseResearch();}
    await poll(()=>evaluate('!!document.querySelector(".template-setup-results")'),500);
    if(template==='bug-fix'){assert(await evaluate('document.querySelector(\'dialog[aria-label="准备模板能力"]\').textContent.includes("Fixture network failure")'));await screenshot('partial-install-retry.png');failPony=false;await click('dialog button','重试未完成项');await poll(()=>evaluate('document.querySelector(".template-setup-results")?.textContent.includes("能力已就绪")'),500);}
    const installs=calls.filter(call=>call.cwd===cwd&&call.method==='plugin/install').map(call=>call.params.pluginName);
    assert.deepEqual([...new Set(installs)],expected);if(template==='bug-fix')assert.equal(installs.filter(id=>id==='ecc').length,1);
    if(template==='web-product')assert.equal(calls.filter(call=>call.cwd===cwd&&call.method==='skill/install').length,1);
    await screenshot(`setup-${template}.png`);await click('dialog button','进入项目');await poll(()=>evaluate(`document.querySelectorAll('.conversation-node').length===${count}`));
    assert.equal(await evaluate('!!document.querySelector(".error-banner")'),false);await click('nav[aria-label="工作空间"] button[aria-label="项目"]');
  }
  const before=calls.filter(call=>call.method==='plugin/install').length;await click('button','新建项目');await fill('dialog input','Restore existing');await click('dialog button','浏览');await click('dialog .primary');await poll(()=>evaluate('document.querySelectorAll(".conversation-node").length===3'));
  assert.equal(await evaluate('!!document.querySelector(\'dialog[aria-label="准备模板能力"]\')'),false);assert.equal(calls.filter(call=>call.method==='plugin/install').length,before);
  console.log(JSON.stringify({passed:true,fixture,selectedTemplateOnly:true,existingOverwriteOrSkip:true,defaultSkip:true,partialRetry:true,noStartupOrRestoreInstall:true,noModelWork:true}));
}catch(error){await driver?.screenshot('failure.png');throw error}
finally{releaseResearch();unsubscribe();await driver?.close();await new Promise(done=>bridge.close(done));await engine.close();}
