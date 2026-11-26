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
const cases=[
  ['content-creation',3,[],'content-creation'],
  ['research-analysis',4,['ecc','superpowers','planning-with-files'],'research-analysis'],
  ['bug-fix',3,['ecc','superpowers','planning-with-files','ponytail','gitnexus'],'bug-fix'],
  ['web-product',8,['ecc','superpowers','planning-with-files','ponytail','gitnexus'],'web-product'],
  ['content-creation',3,['ecc'],'mixed'],
  ['content-creation',3,['ecc'],'host-only'],
];
const navigationDirectory=projectDirectory(fixture,'navigate-away');
const directories=[...cases.map(([, , , directory])=>projectDirectory(fixture,directory)),navigationDirectory,projectDirectory(fixture,'legacy')];
process.env.MIXCAT_HOST_CODEX_HOME=projectDirectory(fixture,'host');
const skillNames={ecc:['research-ops','deep-research','article-writing','content-engine','coding-standards','verification-loop','product-lens','product-capability','frontend-patterns','backend-patterns','e2e-testing','architecture-decision-records'],superpowers:['systematic-debugging'],'planning-with-files':['planning-with-files'],ponytail:['ponytail'],gitnexus:['gitnexus-exploring','gitnexus-debugging','gitnexus-impact-analysis']};
const installations=new Map(),calls=[];let failPony=true, failNextRead=false, releaseResearch, releaseNavigation;
const researchGate=new Promise(done=>releaseResearch=done);
const navigationGate=new Promise(done=>releaseNavigation=done);
const options={workbenchRoot:fixture,executable:'fixture',accountFactory:accountFixture().factory,async installTemplateSkill(cwd,overwrite){calls.push({cwd,method:'skill/install',overwrite});const folder=projectDirectory(cwd,'.agents','skills','impeccable');writeFileSync(join(folder,'SKILL.md'),'---\nname: impeccable\n---\nFixture skill');installations.get(cwd).set('impeccable','2.0.0');},nativeFactory({cwd}){
  const available=cwd.endsWith('content-creation')?['ecc','superpowers','planning-with-files']:cwd.endsWith('mixed')?['superpowers','planning-with-files']:[];
  const installed=installations.get(cwd)??new Map(available.map(id=>[id,'1.0.0']));installations.set(cwd,installed);
  return{async connect(){},async close(){},async rpc(method,params){calls.push({cwd,method,params});
    if(method==='model/list')return{data:[{model:'fixture-model',displayName:'Fixture model',isDefault:true}],nextCursor:null};
    if(method==='plugin/installed')return{marketplaces:[{plugins:[...installed].filter(([id])=>id!=='impeccable').map(([id,version])=>({id:`${id}@${id}`,name:id,installed:true,enabled:true,version}))}],marketplaceLoadErrors:[]};
    if(method==='skills/list'){
      if(cwd===navigationDirectory)await navigationGate;
      return{data:[{skills:[...installed.keys()].flatMap(id=>id==='impeccable'?[{name:id,path:join(cwd,'.agents','skills',id,'SKILL.md'),enabled:true}]:skillNames[id].map(name=>({name:`${id}:${name}`,path:join(cwd,'.mixcat','native-skills',id,name,'SKILL.md'),enabled:true}))),errors:[]}]};
    }
    if(method==='hooks/list')return{data:[{hooks:[],errors:[]}]};if(method==='mcpServerStatus/list')return{data:[],nextCursor:null};
    if(method==='marketplace/add'){const id=params.source.includes('superpowers')?'superpowers':params.source.includes('ECC')?'ecc':params.source.split('/').at(-1).toLowerCase();return{marketplaceName:id,installedRoot:projectDirectory(cwd,'.mixcat','codex','markets',id),alreadyAdded:false};}
    if(method==='plugin/list')return{marketplaces:Object.keys(skillNames).map(id=>({name:id,path:join(cwd,'.mixcat','codex','markets',id,'.claude-plugin','marketplace.json'),plugins:[{name:id,id:`${id}@${id}`}]}))};
    if(method==='plugin/install'){if(cwd.endsWith('research-analysis')&&params.pluginName==='ecc')await researchGate;if(cwd.endsWith('bug-fix')&&params.pluginName==='ponytail'&&failPony)throw Error('Fixture network failure');installed.set(params.pluginName,'2.0.0');return{appsNeedingAuth:[],authPolicy:'ON_INSTALL'};}
    if(method==='account/read')return{account:{email:'fixture'}};if(method==='windowsSandbox/readiness')return{status:'configured'};
    assert(!['thread/start','thread/resume','turn/start'].includes(method),'Setup cannot launch model work');return{};
  }};
}};
const engine=new WorkflowEngine(options);await engine.init();await engine.command({type:'create_project',root:directories.at(-1),name:'Legacy project'});
const bridge=createServer((request,response)=>{let body='';request.on('data',data=>body+=data);request.on('end',()=>void(async()=>{try{const envelope=JSON.parse(body);if(failNextRead&&envelope.command.type==='template_setup'&&envelope.command.phase==='inspect'){failNextRead=false;throw Error('Fixture catalog read failed');}response.setHeader('Content-Type','application/json');response.end(JSON.stringify(await engine.command(envelope.command,envelope.id)))}catch(error){response.statusCode=500;response.end(JSON.stringify({error:String(error)}))}})())});
bridge.listen(0,'127.0.0.1');await once(bridge,'listening');const url=`http://127.0.0.1:${bridge.address().port}`;
writeFileSync(path('preload.cjs'),`const{contextBridge,ipcRenderer}=require('electron');const listeners=[];contextBridge.exposeInMainWorld('mixcat',{command:e=>ipcRenderer.invoke('command',e),subscribe:f=>{listeners.push(f);return()=>listeners.splice(listeners.indexOf(f),1)},chooseDirectory:()=>ipcRenderer.invoke('choose-directory'),chooseAttachments:async()=>[],setUnsaved:async()=>{},panel:async()=>({panels:[],activePanelId:null}),subscribePanels:()=>()=>{}});contextBridge.exposeInMainWorld('fixture',{push:update=>listeners.forEach(f=>f(update))});`);
writeFileSync(path('main.cjs'),`const{app,BrowserWindow,ipcMain}=require('electron');const{join}=require('node:path');for(const name of ['userData','sessionData','logs','crashDumps','temp'])app.setPath(name,join(${JSON.stringify(fixture)},name));app.commandLine.appendSwitch('disk-cache-dir',join(${JSON.stringify(fixture)},'cache'));let choice=0;ipcMain.handle('choose-directory',()=>${JSON.stringify(directories)}[choice++]);ipcMain.handle('command',async(_,body)=>{const response=await fetch(${JSON.stringify(url)},{method:'POST',body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw Error(result.error);return result});app.whenReady().then(()=>{const win=new BrowserWindow({width:1600,height:1100,show:false,webPreferences:{preload:${JSON.stringify(path('preload.cjs'))},backgroundThrottling:false}});win.webContents.once('did-finish-load',()=>win.showInactive());win.loadFile(${JSON.stringify(join(root,'dist/client/renderer/index.html'))})});app.on('window-all-closed',()=>app.quit());`);
let driver;const unsubscribe=engine.subscribe(update=>{if(driver)void driver.evaluate(`window.fixture.push(${JSON.stringify(update)})`).catch(()=>{})});
try{
  driver=await openRendererFixture(root,fixture);const{evaluate,poll,click,fill,screenshot}=driver;console.log(JSON.stringify({fixture}));
  const openProjectMenu=async()=>{
    await evaluate("document.querySelector('#sidebar-project-list button.active').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:20,clientY:window.innerHeight-6}))");
    await poll(()=>evaluate("document.querySelector('[role=menu][aria-label=项目操作]')?.getBoundingClientRect().bottom <= innerHeight - 1"));
  };
  const prepareFromMenu=async()=>{
    await openProjectMenu();
    await click('[role="menuitem"]','准备模板能力');
    await poll(()=>evaluate('!!document.querySelector(\'select[aria-label="ECC 已有能力处理"]\')'));
  };
  await click('nav[aria-label="工作空间"] button[aria-label="项目"]');await poll(()=>evaluate("document.querySelectorAll('.project-card').length===1"));
  assert.equal(calls.filter(call=>call.method==='plugin/install').length,0,'Startup and ordinary projects do not install capabilities');
  for(const[template,count,expected,directory]of cases){
    const cwd=join(fixture,directory), hostOnly=directory==='host-only';
    const allExisting=directory==='content-creation'||hostOnly;
    if(hostOnly) for(const name of ['ecc','superpowers','planning-with-files']){
      const manifest=projectDirectory(process.env.MIXCAT_HOST_CODEX_HOME,'plugins','cache','official',name,'1.0.0','.codex-plugin');
      writeFileSync(join(manifest,'plugin.json'),JSON.stringify({name,version:'1.0.0'}));
    }
    await click('button','新建项目');await fill('dialog input',`Setup ${directory}`);await click('dialog button','浏览');
    await click('label:has(input[name=template][value=' + JSON.stringify(template) + '])');await click('dialog .primary');
    if(allExisting){
      const desiredStatus=hostOnly?'complete':'ready';
      await poll(async()=>{
        const selected=engine.snapshot().selected;
        return selected?.project.root===cwd && (selected.templateSetup?.status===desiredStatus || await evaluate('!!document.querySelector(\'select[aria-label="ECC 已有能力处理"]\')'));
      });
      assert.equal(engine.snapshot().selected?.templateSetup?.status,desiredStatus,'a project with all capabilities found opens without a preparation choice');
      await poll(()=>evaluate(`!document.querySelector('dialog')&&document.querySelectorAll('.conversation-node').length===${count}`));
      assert.equal(calls.filter(call=>call.cwd===cwd&&(/^(marketplace\/add|plugin\/install|skill\/install)$/.test(call.method))).length,0,'Automatic reuse never installs or adds a marketplace');
      const editor=engine.snapshot().selected.nodes.find(node=>node.name==='策划编辑');
      assert(editor,'the new content project has its editor node');
      assert.equal((editor.plugins??[]).some(plugin=>plugin.id==='ecc@ecc'),!hostOnly,'the editor uses an ECC plugin only when the project can discover it');
      assert.equal((editor.skills??[]).some(skill=>skill.name==='ecc:content-engine'&&skill.path===join(cwd,'.mixcat','native-skills','ecc','content-engine','SKILL.md')),!hostOnly,'the editor uses the skill discovered in its project');
      assert.equal(await evaluate('!!document.querySelector(".template-setup-banner")'),false,'skipped host-only capabilities do not show an unfinished banner');
      await screenshot(`setup-existing-${directory}.png`);
      if(!hostOnly){
        await openProjectMenu();
        assert(await evaluate('[...document.querySelectorAll("[role=menuitem]")].some(item=>item.textContent==="准备模板能力")'),'a ready project can also prepare skipped installations later');
        await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
        await click('nav[aria-label="工作空间"] button[aria-label="项目"]');continue;
      }
      await prepareFromMenu();
      await click('dialog button','准备所选能力');
      await poll(()=>evaluate('document.querySelector(".template-setup-results")?.textContent.includes("模板准备已完成")'));
      assert.equal(await evaluate('[...document.querySelectorAll("dialog button")].some(button=>button.textContent.includes("重试未完成项"))'),false,'skipping each choice does not offer retry');
      assert(engine.snapshot().selected?.templateSetup?.items.every(item=>item.state==='skipped'));
      assert.equal(await evaluate('document.querySelector("[role=progressbar]").getAttribute("aria-valuetext")'),'已处理 3/3');
      await click('dialog button','收起步骤');
      assert.equal(await evaluate('document.querySelector(".progress-steps-body").hidden'),true);
      assert.equal(await evaluate('document.querySelector("[role=progressbar]").getAttribute("aria-valuenow")'),'3');
      await click('dialog button','展开步骤');
      assert.equal(await evaluate('document.querySelector(".progress-steps-body").hidden'),false);
      await screenshot('skipped-preparation-complete.png');
      await click('dialog button','进入项目');
      await prepareFromMenu();
    }
    await poll(()=>evaluate('!!document.querySelector(\'dialog[aria-label="准备模板能力"]\')'));
    if(hostOnly){
      await poll(()=>evaluate('!!document.querySelector(\'select[aria-label="ECC 已有能力处理"]\')'));assert.equal(calls.filter(call=>call.cwd===cwd&&call.method==='plugin/install').length,0);
      assert.equal(await evaluate('document.querySelector(\'select[aria-label="ECC 已有能力处理"]\').value'),'skip');await screenshot('existing-default-skip.png');
      await evaluate('(()=>{const e=document.querySelector(\'select[aria-label="ECC 已有能力处理"]\');e.value="overwrite";e.dispatchEvent(new Event("change",{bubbles:true}))})()');await click('dialog button','准备所选能力');
    }
    if(directory==='mixed'){
      await poll(()=>evaluate('!!document.querySelector(\'select[aria-label="Superpowers 已有能力处理"]\')'));
      assert.equal(await evaluate('document.querySelector(\'select[aria-label="Superpowers 已有能力处理"]\').value'),'skip');
      assert.equal(calls.filter(call=>call.cwd===cwd&&call.method==='plugin/install').length,0);
      await click('dialog button','准备所选能力');
    }
    if(template==='research-analysis'){await poll(()=>evaluate('!!document.querySelector(\'.template-setup-item[data-state="installing"]\')'));await screenshot('native-install-progress.png');assert.equal(await evaluate('!!document.querySelector(".error-banner")'),false,'Preparation must allow background project observations');releaseResearch();}
    await poll(()=>evaluate('!!document.querySelector(".template-setup-results")'),500);
    if(template==='bug-fix'){
      assert(await evaluate('document.querySelector(\'dialog[aria-label="准备模板能力"]\').textContent.includes("Fixture network failure")'));
      assert.equal(await evaluate('document.querySelector("[role=progressbar]").getAttribute("aria-valuetext")'),'已处理 4/5');
      assert.equal(await evaluate('document.querySelector(".template-satisfied").open'),false);
      await click('.template-satisfied > summary');
      await poll(()=>evaluate('document.querySelector(".template-satisfied").open && document.querySelector(".template-setup-item[data-state=failed]").getClientRects().length > 0'));
      await click('.template-satisfied > summary');
      assert.equal(await evaluate('document.querySelector(".template-satisfied").open'),false);
      await screenshot('partial-install-retry.png');
      await click('dialog button','进入项目');
      await click('.template-setup-banner button','继续准备模板能力');
      await poll(()=>evaluate('document.querySelector(".progress-step-retry")?.getAttribute("aria-label").startsWith("重试")'));
      assert.equal(await evaluate('document.querySelector("[role=progressbar]").getAttribute("aria-valuetext")'),'已处理 4/5');
      assert(await evaluate('document.querySelector(".template-setup-item[data-state=failed]").textContent.includes("Fixture network failure")'));
      assert.equal(calls.filter(call=>call.cwd===cwd&&call.method==='plugin/install'&&call.params.pluginName==='ponytail').length,1);
      failNextRead=true;
      await click('.progress-step-retry');
      await poll(()=>evaluate('document.querySelector("dialog [role=alert]")?.textContent.includes("Fixture catalog read failed")'));
      assert.equal(await evaluate('document.querySelector("[role=progressbar]").getAttribute("aria-valuetext")'),'已处理 4/5');
      failPony=false;
      await click('dialog button','重新检查');
      await poll(()=>evaluate('document.querySelector(".template-setup-results")?.textContent.includes("能力已就绪")'),500);
      assert.equal(await evaluate('document.querySelector("[role=progressbar]").getAttribute("aria-valuetext")'),'已处理 5/5');
    }
    const installs=calls.filter(call=>call.cwd===cwd&&call.method==='plugin/install').map(call=>call.params.pluginName);
    assert.deepEqual([...new Set(installs)],expected);if(template==='bug-fix')assert.equal(installs.filter(id=>id==='ecc').length,1);
    if(template==='web-product')assert.equal(calls.filter(call=>call.cwd===cwd&&call.method==='skill/install').length,1);
    await screenshot(`setup-${directory}.png`);await click('dialog button','进入项目');await poll(()=>evaluate(`document.querySelectorAll('.conversation-node').length===${count}`));
    assert.equal(await evaluate('!!document.querySelector(".error-banner")'),false);await click('nav[aria-label="工作空间"] button[aria-label="项目"]');
  }
  await click('button','新建项目');await fill('dialog input','Abandoned check');await click('dialog button','浏览');
  await click('label:has(input[name=template][value=content-creation])');
  await click('dialog .primary');
  await poll(()=>calls.some(call=>call.cwd===navigationDirectory&&call.method==='skills/list'));
  await click('#sidebar-project-list button','Setup host-only');
  await poll(()=>evaluate("document.querySelector('#sidebar-project-list button.active')?.textContent.includes('Setup host-only')"));
  assert.equal(await evaluate('!!document.querySelector(".template-setup-banner")'),false,'A completed project has no unfinished notice during another project check');
  releaseNavigation();
  assert.equal(await evaluate('!!document.querySelector(\'dialog[aria-label="准备模板能力"]\')'),false,'The abandoned check does not open a preparation modal over another project');
  await click('#sidebar-project-list button','Abandoned check');
  await poll(()=>evaluate("document.querySelector('#sidebar-project-list button.active')?.textContent.includes('Abandoned check')&&!!document.querySelector('.template-setup-banner')"));
  await click('nav[aria-label="工作空间"] button[aria-label="项目"]');
  const before=calls.filter(call=>call.method==='plugin/install').length;await click('button','新建项目');await fill('dialog input','Restore existing');await click('dialog button','浏览');await click('dialog .primary');await poll(()=>evaluate('document.querySelectorAll(".conversation-node").length===3'));
  assert.equal(await evaluate('!!document.querySelector(\'dialog[aria-label="准备模板能力"]\')'),false);assert.equal(calls.filter(call=>call.method==='plugin/install').length,before);
  console.log(JSON.stringify({passed:true,fixture,directExistingReuse:true,skippedItemsComplete:true,optionalPreparationMenu:true,selectedTemplateOnly:true,existingOverwriteOrSkip:true,defaultSkip:true,partialRetry:true,noStartupOrRestoreInstall:true,noModelWork:true}));
}catch(error){await driver?.screenshot('failure.png');throw error}
finally{releaseResearch();releaseNavigation();unsubscribe();await driver?.close();await new Promise(done=>bridge.close(done));await engine.close();}
