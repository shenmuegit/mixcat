import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { openRendererFixture } from './human-review-electron-fixture.mjs';
import { insideProject, projectDirectory } from '../src/core/paths.ts';

const root = resolve('.'), fixture = mkdtempSync(join(projectDirectory(root, '.runtime', 'implementation', 'node-questions'), 'electron-'));
const path = name => insideProject(root, join(fixture, name));
await build({ stdin: { contents: `
import React,{useState}from'react';import{createRoot}from'react-dom/client';import{Workbench}from'./src/renderer/Workbench.tsx';import './src/renderer/styles.css';
const node=(id,name,x)=>({id,name,instructions:'节点主动提问',tools:['get_project_context','request_review','get_review'],resultSchema:{},position:{x,y:100},revision:1,threadId:null,status:'idle'});
const question={kind:'question',id:'saved-question',projectId:'p',checkpointId:'question-saved',checkpointRevision:1,version:1,requestId:'saved',nodeId:'design',taskId:'task',threadId:'thread',turnId:'turn',callId:'call',title:'确认交付范围',content:'请补充计算器需要支持的功能。',attachments:[],sourceFiles:[],upstreamDependencies:[],bundleHash:'hash',status:'pending',createdAt:new Date().toISOString(),decision:null,supersededBy:null};
const initial={project:{id:'p',name:'Project',root:${JSON.stringify(fixture)},goal:'Question fixture',mode:'codex',status:'idle',updatedAt:''},nodes:[node('design','设计',0),node('product','产品经理',350)],tasks:[],handoffs:[],activities:[],conversation:[],reviewPolicy:{revision:0,checkpoints:[]},humanReviews:[question],requests:[{key:'native-question',id:1,projectId:'p',nodeId:'product',method:'item/tool/requestUserInput',params:{questions:[{id:'format',question:'需要 .exe 还是浏览器网页？',options:[{label:'.exe',description:'Windows 客户端'},{label:'网页',description:'浏览器页面'}]}]}},{key:'approval',id:2,projectId:'p',nodeId:'design',method:'item/commandExecution/requestApproval',params:{command:'fixture'}}]};
const commands=[],dirty=[];let nativeAttempts=0,answerAttempts=0;
window.mixcat={inspect:async id=>({id,status:'failed',error:'Fixture answer save failed'}),panel:async()=>({panels:[],activePanelId:null}),subscribePanels:()=>()=>{},chooseAttachments:async()=>[]};
function Fixture(){const[snapshot,setSnapshot]=useState(initial),[error,setError]=useState(null);window.fixture={inspect:()=>({snapshot,commands,dirty})};
async function execute(command,id){commands.push({command,id});setError(null);
if(command.type==='respond_native'){if(++nativeAttempts===1){setError('Fixture native response failed');return null;}setSnapshot(s=>({...s,requests:s.requests.filter(r=>r.key!==command.requestKey)}));}
if(command.type==='decide_review'){if(++answerAttempts===1){setError('Fixture answer save failed');return null;}setSnapshot(s=>({...s,humanReviews:s.humanReviews.map(r=>r.id===command.reviewId?{...r,status:'approved',decision:{commandId:id,reviewId:r.id,version:r.version,bundleHash:r.bundleHash,decision:'approved',comment:command.comment,createdAt:new Date().toISOString(),continuationTaskId:'continue'}}:r)}));}
return{snapshot:{projects:[],selected:snapshot,runtime:null}};}
return <Workbench snapshot={snapshot} runtime={null} execute={execute} busy={false} error={error} onError={setError} onDirty={value=>dirty.push(value)}/>;}
createRoot(document.getElementById('root')).render(<Fixture/>);`, resolveDir: root, loader: 'tsx' }, outfile: path('renderer.js'), bundle: true, format: 'iife', platform: 'browser', logLevel: 'silent' });
writeFileSync(path('index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="renderer.css"><div id="root" style="height:100vh;display:flex"></div><script src="renderer.js"></script>');
writeFileSync(path('main.cjs'), `const{app,BrowserWindow}=require('electron');for(const name of ['userData','sessionData','logs','crashDumps','temp'])app.setPath(name,require('node:path').join(${JSON.stringify(fixture)},name));app.commandLine.appendSwitch('disk-cache-dir',${JSON.stringify(path('cache'))});app.whenReady().then(()=>{const win=new BrowserWindow({width:1500,height:1100,show:false,webPreferences:{backgroundThrottling:false}});win.webContents.once('did-finish-load',()=>win.showInactive());win.loadFile(${JSON.stringify(path('index.html'))});});app.on('window-all-closed',()=>app.quit());`);
const driver = await openRendererFixture(root, fixture), { click, fill, evaluate, poll, screenshot } = driver;
try {
  await poll(() => evaluate("!!document.querySelector('#task-instruction')"));
  assert(!await evaluate("document.body.textContent.includes('人工核对规则')"));
  await fill('#task-instruction', '保留消息草稿');
  await click('.project-statusbar button', '待人工核对 2');
  await poll(() => evaluate("!!document.querySelector('dialog[open]')"));
  assert(await evaluate("document.querySelector('dialog').textContent.includes('产品经理')"));
  assert(!await evaluate("document.querySelector('dialog').textContent.includes('添加核对点')"));
  await fill('dialog .native-request input', '.exe');
  await fill('dialog .question-answer textarea', '  加法和减法\n保存原始回答  ');
  await screenshot('pending-node-questions.png');
  await click('dialog button[aria-label="关闭弹窗"]');
  assert.equal(await evaluate("document.querySelector('#task-instruction').value"), '保留消息草稿');
  assert.equal(await evaluate("document.querySelector('.question-answer textarea').value"), '  加法和减法\n保存原始回答  ');
  await click('.project-statusbar button', '待人工核对 2');
  assert.equal(await evaluate("document.querySelector('dialog .native-request input').value"), '.exe');
  await click('dialog .native-request .primary', '提交回答');
  await poll(() => evaluate("document.querySelector('dialog [role=alert]')?.textContent.includes('Fixture native response failed')"));
  assert.equal(await evaluate("document.querySelector('dialog .native-request input').value"), '.exe');
  await click('dialog .native-request .primary', '提交回答');
  await poll(() => evaluate("!document.querySelector('dialog .native-request')"));
  assert.deepEqual((await evaluate('window.fixture.inspect()')).commands.find(c => c.command.type === 'respond_native').command.result, { answers: { format: { answers: ['.exe'] } } });
  await click('dialog .question-answer .primary', '提交回答');
  await poll(() => evaluate("document.querySelector('dialog .review-failure')?.textContent.includes('Fixture answer save failed')"));
  assert.equal(await evaluate("document.querySelector('dialog .question-answer textarea').value"), '  加法和减法\n保存原始回答  ');
  await click('dialog .question-answer .primary', '提交回答');
  await poll(() => evaluate("document.querySelector('dialog').textContent.includes('已回答')"));
  const state = await evaluate('window.fixture.inspect()');
  assert.equal(state.snapshot.humanReviews[0].decision.comment, '  加法和减法\n保存原始回答  ');
  assert(state.commands.filter(c => c.command.type === 'decide_review').every(c => c.id && c.command.decision === 'approved'));
  assert.equal(state.snapshot.requests[0].key, 'approval', 'Unrelated native approval remains separate');
  await screenshot('answered-node-questions.png');
  await click('dialog button[aria-label="关闭弹窗"]');
  assert(await evaluate("[...document.querySelectorAll('.project-statusbar button')].some(b=>b.textContent==='待人工核对 0')"));
  assert.equal(await evaluate("document.querySelector('#task-instruction').value"), '保留消息草稿');
  console.log(JSON.stringify({ fixture, inbox: 'passed', nativeAnswer: 'passed', durableAnswer: 'passed', draftAndRetry: 'passed' }));
} finally { await driver.close(); }
