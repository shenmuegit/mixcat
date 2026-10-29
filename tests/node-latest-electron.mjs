import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { openRendererFixture } from './human-review-electron-fixture.mjs';
import { projectDirectory, insideProject } from '../src/core/paths.ts';

const root = resolve('.'), fixture = mkdtempSync(join(projectDirectory(root, '.runtime', 'implementation', 'node-latest'), 'electron-'));
const path = name => insideProject(root, join(fixture, name));
await build({ stdin: { contents: `
import React,{useState}from'react';import{createRoot}from'react-dom/client';import{Workbench}from'./src/renderer/Workbench.tsx';import './src/renderer/styles.css';
const node=(id,x)=>({id,name:'节点 '+id.toUpperCase(),instructions:'节点消息定位',tools:[],resultSchema:{},position:{x,y:100},revision:1,threadId:id==='c'?'thread-c':null,status:'idle'});
let seq=0;const entry=(id,nodeId,extra={})=>({id,seq:++seq,nodeId,taskId:null,threadId:null,turnId:null,itemId:null,direction:'output',source:{kind:'node',nodeId},text:id+'\\n消息正文，保留完整历史。',content:{},createdAt:new Date(1700000000000+seq*1000).toISOString(),status:'completed',...extra});
const initial={project:{id:'p',name:'消息定位',root:${JSON.stringify(fixture)},goal:'Latest message',mode:'codex',status:'idle',updatedAt:''},nodes:[node('a',30),node('b',300),node('c',570),node('empty',840)],tasks:[],handoffs:[],activities:[],reviewPolicy:{revision:0,checkpoints:[]},humanReviews:[],requests:[],messages:[{message_id:'original-a',target_task_id:'unused',sourceTaskId:'unused',fromNodeId:'a',fromName:'节点 A',toNodeId:'b',toName:'节点 B',replyTo:null,accepted_at:''}],conversation:[...Array.from({length:40},(_,i)=>entry('a-'+i,'a',i===0?{messageId:'original-a'}:i===1?{direction:'input',taskId:'old-task',source:{kind:'user'}}:{})),entry('a-latest','a',{replyTo:'original-a'}),...Array.from({length:65},(_,i)=>entry('b-'+i,'b')),entry('b-latest','b')]};
const commands=[];let released=false;
window.mixcat={panel:async()=>({panels:[],activePanelId:null}),subscribePanels:()=>()=>{},chooseAttachments:async()=>[]};
function Fixture(){const[snapshot,setSnapshot]=useState(initial),[request,setRequest]=useState();
window.fixture={inspect:()=>({commands,requestId:request?.id}),append:nodeId=>setSnapshot(s=>({...s,conversation:[...s.conversation,entry(nodeId+'-newest',nodeId)]})),release:()=>{released=true;setSnapshot(s=>({...s,nodes:s.nodes.map(n=>n.id==='c'?{...n,historyPending:false}:n),conversation:[...s.conversation,...Array.from({length:75},(_,i)=>entry('c-'+i,'c')),entry('c-latest','c')]}));},locateTask:()=>setRequest({id:'work-task',nodeId:'a',taskId:'old-task'}),locateDelayed:()=>setRequest({id:'delayed-work',nodeId:'a',taskId:'delayed-task'}),releaseTask:()=>setSnapshot(s=>({...s,conversation:[...s.conversation,entry('a-delayed','a',{direction:'input',taskId:'delayed-task',createdAt:new Date(1700000001500).toISOString(),source:{kind:'user'}})]}))};
async function execute(command){commands.push(command);if(command.type==='read_history'&&!released){setSnapshot(s=>({...s,nodes:s.nodes.map(n=>n.id==='c'?{...n,historyPending:true}:n)}));return{snapshot:{projects:[],selected:snapshot,runtime:null},historyPending:true};}return{snapshot:{projects:[],selected:snapshot,runtime:null},catalog:{models:[],skills:[],plugins:[],errors:[]}};}
return <Workbench snapshot={snapshot} runtime={{mode:'codex',connected:true,authenticated:true,accountLabel:'fixture',error:null}} execute={execute} busy={false} error={null} onError={message=>{throw Error(message)}} workRequest={request}/>;}
createRoot(document.getElementById('root')).render(<Fixture/>);`, resolveDir: root, loader: 'tsx' }, outfile: path('renderer.js'), bundle: true, format: 'iife', platform: 'browser', logLevel: 'silent' });
writeFileSync(path('index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="renderer.css"><div id="root" style="height:100vh;display:flex"></div><script src="renderer.js"></script>');
writeFileSync(path('main.cjs'), `const{app,BrowserWindow}=require('electron');for(const name of ['userData','sessionData','logs','crashDumps','temp'])app.setPath(name,require('node:path').join(${JSON.stringify(fixture)},name));app.commandLine.appendSwitch('disk-cache-dir',${JSON.stringify(path('cache'))});app.whenReady().then(()=>{const win=new BrowserWindow({width:1650,height:1000,show:false,webPreferences:{backgroundThrottling:false}});win.webContents.once('did-finish-load',()=>win.showInactive());win.loadFile(${JSON.stringify(path('index.html'))});});app.on('window-all-closed',()=>app.quit());`);
const driver = await openRendererFixture(root, fixture), { click, fill, evaluate, poll, rpc, screenshot } = driver;
const metrics = () => evaluate("(()=>{const e=document.querySelector('.session-scroll');return{top:e.scrollTop,gap:e.scrollHeight-e.clientHeight-e.scrollTop,height:e.clientHeight}})()");
async function latest(id) {
  await poll(() => evaluate(`(()=>{const e=document.querySelector('.session-scroll'),last=e.querySelector('[data-entry-id=${id}]');if(!last)return false;const r=last.getBoundingClientRect(),v=e.getBoundingClientRect();return e.scrollHeight-e.clientHeight-e.scrollTop<=2&&r.bottom<=v.bottom+2&&r.bottom>v.top})()`));
}
async function scrollUp() {
  const point = await evaluate("(()=>{const r=document.querySelector('.session-scroll').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()");
  await rpc('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: -2000 });
  await poll(async () => (await metrics()).gap > 500);
}
try {
  await poll(() => evaluate("!!document.querySelector('[data-entry-id=a-latest]')"));
  await click('.react-flow__node[data-id=a] h3');
  await latest('a-latest');
  await fill('#task-instruction', '保留消息草稿');
  await scrollUp();
  const previous = (await metrics()).top;
  await evaluate("window.fixture.append('a')");
  await poll(() => evaluate("!!document.querySelector('[data-entry-id=a-newest]')"));
  assert(Math.abs((await metrics()).top - previous) < 3, 'Reading old messages must not be pulled to the latest update');
  await click('.react-flow__node[data-id=a] h3');
  await latest('a-newest');
  assert.equal(await evaluate("document.querySelector('#task-instruction').value"), '保留消息草稿');
  await click('.react-flow__node[data-id=b] h3'); await latest('b-latest');
  await click('.react-flow__node[data-id=c] h3');
  await poll(() => evaluate("window.fixture.inspect().commands.some(c=>c.type==='read_history'&&c.nodeId==='c')"));
  await evaluate('window.fixture.release()'); await latest('c-latest');
  await click('[aria-label="收起节点详情"]');
  await click('.react-flow__node[data-id=c] h3'); await latest('c-latest');
  await click('.react-flow__node[data-id=a] h3'); await latest('a-newest');
  await click('[data-entry-id=a-latest] [data-reply-to=original-a]');
  await poll(() => evaluate("document.querySelector('[data-entry-id=a-0]').classList.contains('is-located')"));
  assert((await metrics()).top < 100, 'Explicit original-message navigation stays at the old message');
  await click('.react-flow__node[data-id=a] h3'); await latest('a-newest');
  await evaluate('window.fixture.locateTask()');
  await poll(() => evaluate("document.querySelector('[data-entry-id=a-1]').classList.contains('is-located')"));
  assert((await metrics()).top < 150);
  await click('.react-flow__node[data-id=a] h3'); await latest('a-newest');
  await evaluate('window.fixture.locateDelayed()');
  await poll(() => evaluate("window.fixture.inspect().requestId==='delayed-work'"));
  await click('.react-flow__node[data-id=a] h3'); await latest('a-newest');
  await evaluate('window.fixture.releaseTask()');
  await poll(() => evaluate("!!document.querySelector('[data-entry-id=a-delayed]')"));
  await latest('a-newest');
  await click('.react-flow__node[data-id=empty] h3');
  await poll(() => evaluate("document.querySelector('.chat-history').textContent.includes('开始这个会话')"));
  await click('.react-flow__node[data-id=b] h3'); await latest('b-latest');
  await scrollUp(); const bTop = (await metrics()).top;
  await evaluate("window.fixture.append('c')");
  await new Promise(done => setTimeout(done, 100));
  assert(Math.abs((await metrics()).top - bTop) < 3, 'Another node update must not change this node reading position');
  await click('.react-flow__node[data-id=b] h3'); await latest('b-latest');
  await screenshot('latest-node-message.png');
  console.log(JSON.stringify({ fixture, initialAndRepeated: 'passed', switchingAndReopen: 'passed', delayedHistory: 'passed', manualReading: 'passed', references: 'passed', emptyAndOtherNode: 'passed' }));
} finally { await driver.close(); }
