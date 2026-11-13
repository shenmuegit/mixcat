import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { openRendererFixture } from './human-review-electron-fixture.mjs';
import { insideProject, projectDirectory } from '../src/core/paths.ts';

const root = resolve('.'), fixture = mkdtempSync(join(projectDirectory(root, '.runtime', 'implementation', 'node-questions'), 'electron-'));
const path = name => insideProject(root, join(fixture, name));
await build({ stdin: { contents: `
import React,{useState}from'react';import{createRoot}from'react-dom/client';import{Workbench}from'./src/renderer/Workbench.tsx';import './src/renderer/styles.css';import './src/renderer/theme.css';
const node=(id,name,x)=>({id,name,instructions:'节点主动提问',tools:['get_project_context','request_review','get_review'],resultSchema:{},position:{x,y:100},revision:1,threadId:null,status:'idle'});
const question={kind:'question',id:'saved-question',projectId:'p',checkpointId:'question-saved',checkpointRevision:1,version:1,requestId:'saved',nodeId:'design',taskId:'task',threadId:'thread',turnId:'turn',callId:'call',title:'确认交付范围',content:'请确认：A. Windows 桌面程序（推荐），还是 B. 界面设计稿，或 C. 浏览器网页？也可以补充需求。',attachments:[],sourceFiles:[],upstreamDependencies:[],bundleHash:'hash',status:'pending',createdAt:new Date().toISOString(),decision:null,supersededBy:null};
const initial={project:{id:'p',name:'Project',root:${JSON.stringify(fixture)},goal:'Question fixture',mode:'codex',status:'idle',updatedAt:''},nodes:[node('design','设计',0),node('product','产品经理',350)],tasks:[],handoffs:[],activities:[],conversation:[],reviewPolicy:{revision:0,checkpoints:[]},humanReviews:[question],requests:[{key:'native-question',id:1,projectId:'p',nodeId:'product',method:'item/tool/requestUserInput',params:{questions:[{id:'format',question:'需要 .exe 还是浏览器网页？',options:[{label:'.exe',description:'Windows 客户端'},{label:'网页',description:'浏览器页面'}]}]}},{key:'approval',id:2,projectId:'p',nodeId:'design',method:'item/commandExecution/requestApproval',params:{command:'fixture'}}]};
const commands=[],dirty=[];let nativeAttempts=0,answerAttempts=0;
window.mixcat={inspect:async id=>({id,status:'failed',error:'Fixture answer save failed'}),panel:async()=>({panels:[],activePanelId:null}),subscribePanels:()=>()=>{},chooseAttachments:async()=>[]};
function Fixture(){const[snapshot,setSnapshot]=useState(initial),[error,setError]=useState(null);window.fixture={inspect:()=>({snapshot,commands,dirty}),free:()=>setSnapshot(s=>({...s,humanReviews:[...s.humanReviews,{...question,id:'free-question',checkpointId:'free-question',content:'请补充需要的功能。'}]})),multi:()=>setSnapshot(s=>({...s,requests:[...s.requests,{key:'multi-native',id:4,projectId:'p',nodeId:'design',method:'item/tool/requestUserInput',params:{questions:[{id:'format',question:'交付形式？',options:[{label:'桌面'},{label:'网页'}]},{id:'theme',question:'配色？',options:[{label:'浅色'},{label:'深色'}]}]}}]})),history:()=>setSnapshot(s=>({...s,humanReviews:[...s.humanReviews,...Array.from({length:8},(_,i)=>({...question,id:'history-'+i,checkpointId:'history-'+i,status:'approved',content:'已回答的历史问题。'.repeat(30),decision:{comment:'保留历史回答',createdAt:''}}))]})),ask:()=>setSnapshot(s=>({...s,requests:[...s.requests,{key:'new-native',id:3,projectId:'p',nodeId:'design',method:'item/tool/requestUserInput',params:{questions:[{id:'latest',question:'新提问：是否继续？',options:[{label:'继续',description:'继续处理本任务'},{label:'补充要求',description:'先说明具体要求'}]}]}}]}))};
async function execute(command,id){commands.push({command,id});setError(null);
if(command.type==='respond_native'){if(++nativeAttempts===1){setError('Fixture native response failed');return null;}setSnapshot(s=>({...s,requests:s.requests.filter(r=>r.key!==command.requestKey)}));}
if(command.type==='decide_review'){if(++answerAttempts===1){setError('Fixture answer save failed');return null;}setSnapshot(s=>({...s,humanReviews:s.humanReviews.map(r=>r.id===command.reviewId?{...r,status:'approved',decision:{commandId:id,reviewId:r.id,version:r.version,bundleHash:r.bundleHash,decision:'approved',comment:command.comment,createdAt:new Date().toISOString(),continuationTaskId:'continue'}}:r)}));}
return{snapshot:{projects:[],selected:snapshot,runtime:null}};}
return <Workbench snapshot={snapshot} runtime={null} execute={execute} busy={false} error={error} onError={setError} onDirty={value=>dirty.push(value)}/>;}
createRoot(document.getElementById('root')).render(<Fixture/>);`, resolveDir: root, loader: 'tsx' }, outfile: path('renderer.js'), bundle: true, format: 'iife', platform: 'browser', logLevel: 'silent' });
writeFileSync(path('index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="renderer.css"><div id="root" style="height:100vh;display:flex"></div><script src="renderer.js"></script>');
writeFileSync(path('main.cjs'), `const{app,BrowserWindow}=require('electron');for(const name of ['userData','sessionData','logs','crashDumps','temp'])app.setPath(name,require('node:path').join(${JSON.stringify(fixture)},name));app.commandLine.appendSwitch('disk-cache-dir',${JSON.stringify(path('cache'))});app.whenReady().then(()=>{const win=new BrowserWindow({width:1500,height:1100,show:false,webPreferences:{backgroundThrottling:false}});win.webContents.once('did-finish-load',()=>win.showInactive());win.loadFile(${JSON.stringify(path('index.html'))});});app.on('window-all-closed',()=>app.quit());`);
const driver = await openRendererFixture(root, fixture), { click, fill, evaluate, poll, screenshot, rpc } = driver;
try {
  await poll(() => evaluate("!!document.querySelector('#task-instruction')"));
  assert.equal(await evaluate("document.querySelectorAll('.session-detail button.question-option').length"), 3);
  assert(!await evaluate("!!document.querySelector('.session-detail .question-answer')"));
  await fill('#task-instruction', '保留消息草稿');
  await click('.project-statusbar button', '待人工核对 2');
  await poll(() => evaluate("!!document.querySelector('dialog[open]')"));
  assert.equal((await evaluate('window.fixture.inspect()')).commands.length, 0, 'Opening a question must not answer it');
  assert(!await evaluate("!!document.querySelector('dialog input,dialog textarea,dialog .question-answer')"));
  for (const width of [1460, 1100]) {
    await rpc('Emulation.setDeviceMetricsOverride', { width, height: 1100, deviceScaleFactor: 1, mobile: false });
    for (const theme of ['light', 'dark', 'violet']) {
      await evaluate('document.documentElement.dataset.theme='+JSON.stringify(theme));
      await evaluate('new Promise(requestAnimationFrame).then(()=>true)');
      assert.equal(await evaluate("getComputedStyle(document.documentElement).getPropertyValue('--theme-surface').trim()"), { light: '#fafafa', dark: '#141415', violet: '#211b46' }[theme]);
      assert(await evaluate("[...document.querySelectorAll('dialog .question-option')].every(e=>e.scrollWidth<=e.clientWidth+1&&e.getBoundingClientRect().height>=44)"));
      await screenshot('direct-'+theme+'-'+width+'.png');
    }
  }
  await rpc('Emulation.clearDeviceMetricsOverride');
  await click('dialog .native-request .question-option', '.exe');
  await poll(() => evaluate("document.querySelector('dialog [role=alert]')?.textContent.includes('Fixture native response failed')"));
  assert.equal((await evaluate('window.fixture.inspect()')).commands.filter(c=>c.command.type==='respond_native').length, 1);
  await click('dialog .native-request .question-option', '.exe');
  await poll(() => evaluate("!document.querySelector('dialog .native-request')"));
  const native = (await evaluate('window.fixture.inspect()')).commands.filter(c=>c.command.type==='respond_native');
  assert.equal(native.length, 2);
  assert(native.every(c=>JSON.stringify(c.command.result)===JSON.stringify({answers:{format:{answers:['.exe']}}})));
  await evaluate("[...document.querySelectorAll('dialog .review-card button.question-option')].find(e=>e.textContent.includes('B. 界面设计稿')).focus()");
  assert(await evaluate("document.activeElement?.textContent.includes('B. 界面设计稿')"));
  await rpc('Input.dispatchKeyEvent', { type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r' });
  await rpc('Input.dispatchKeyEvent', { type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13 });
  await poll(() => evaluate("document.querySelector('dialog .review-failure')?.textContent.includes('Fixture answer save failed')"));
  assert.equal((await evaluate('window.fixture.inspect()')).commands.filter(c=>c.command.type==='decide_review').length, 1);
  assert(!await evaluate("!!document.querySelector('dialog textarea')"));
  await click('dialog .review-card .question-option', 'B. 界面设计稿');
  await poll(() => evaluate("document.querySelector('dialog').textContent.includes('已回答')"));
  const state=await evaluate('window.fixture.inspect()');
  assert.equal(state.snapshot.humanReviews[0].decision.comment,'B. 界面设计稿');
  assert(state.commands.filter(c=>c.command.type==='decide_review').every(c=>c.id&&c.command.version===1&&c.command.bundleHash==='hash'&&c.command.comment==='B. 界面设计稿'));
  assert.equal(state.snapshot.requests[0].key,'approval');
  await click('dialog button[aria-label="关闭弹窗"]');
  assert.equal(await evaluate("document.querySelector('#task-instruction').value"),'保留消息草稿');
  await evaluate('window.fixture.free()');
  await click('.project-statusbar button','待人工核对 1');
  await fill('dialog .question-answer textarea','  加法和减法\n保留原始回答  ');
  await click('dialog button[aria-label="关闭弹窗"]');
  assert.equal(await evaluate("document.querySelector('.question-answer textarea').value"),'  加法和减法\n保留原始回答  ');
  await click('.project-statusbar button','待人工核对 1');
  await click('dialog .question-answer .primary','提交回答');
  await poll(()=>evaluate("window.fixture.inspect().snapshot.humanReviews.find(q=>q.id==='free-question').status==='approved'"));
  assert.equal((await evaluate('window.fixture.inspect()')).snapshot.humanReviews.find(q=>q.id==='free-question').decision.comment,'  加法和减法\n保留原始回答  ');
  await click('dialog button[aria-label="关闭弹窗"]');
  await evaluate('window.fixture.history()');
  await click('.react-flow__node[data-id=design]');
  await evaluate('window.fixture.ask()');
  await poll(()=>evaluate("(()=>{const c=[...document.querySelectorAll('.session-detail .native-request')].find(e=>e.textContent.includes('新提问'));if(!c)return false;const a=c.getBoundingClientRect(),v=document.querySelector('.session-scroll').getBoundingClientRect();return a.top>=v.top-1&&a.bottom<=v.bottom+1;})()"));
  assert(!await evaluate("!!document.querySelector('.session-detail .native-question input')"));
  await screenshot('latest-direct-after-history.png');
  await click('.session-detail .native-request .question-option','继续');
  await poll(()=>evaluate("!document.querySelector('.session-detail .native-question')"));
  await evaluate('window.fixture.multi()');
  await poll(()=>evaluate("document.querySelectorAll('.session-detail .native-question').length===2"));
  const before=(await evaluate('window.fixture.inspect()')).commands.length;
  await click('.session-detail .native-request .question-option','桌面');
  assert.equal((await evaluate('window.fixture.inspect()')).commands.length,before,'Multi-question request waits only for its remaining answer');
  await click('.session-detail .native-request .question-option','深色');
  await poll(()=>evaluate("!document.querySelector('.session-detail .native-question')"));
  const after=await evaluate('window.fixture.inspect()');
  assert.equal(after.commands.length,before+1);
  assert.deepEqual(after.commands.at(-1).command.result,{answers:{format:{answers:['桌面']},theme:{answers:['深色']}}});
  assert.equal(await evaluate("document.querySelector('#task-instruction').value"),'保留消息草稿');
  console.log(JSON.stringify({fixture,directClick:'passed',keyboard:'passed',nativeSingleAndMultiple:'passed',freeAnswer:'passed',retryAndDrafts:'passed',themesAndLatest:'passed'}));
} finally { await driver.close(); }
