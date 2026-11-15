import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { openRendererFixture } from './human-review-electron-fixture.mjs';
import { insideProject, projectDirectory } from '../src/core/paths.ts';

const root = resolve('.'), fixture = mkdtempSync(join(projectDirectory(root, '.runtime', 'implementation', 'node-selection'), 'electron-'));
const path = name => insideProject(root, join(fixture, name));
await build({ stdin: { contents: `
import React,{useState}from'react';import{createRoot}from'react-dom/client';import{Workbench}from'./src/renderer/Workbench.tsx';import '@xyflow/react/dist/style.css';import './src/renderer/styles.css';
const node=(id,x)=>({id,name:'节点 '+id.toUpperCase(),instructions:'节点选择回归',tools:[],resultSchema:{},position:{x,y:140},revision:1,threadId:null,status:'idle'});
const initial={project:{id:'p',name:'节点选择',root:${JSON.stringify(fixture)},mode:'codex',status:'idle',updatedAt:''},nodes:[node('a',30),node('b',320),node('c',610)],groups:[],edges:[{id:'ab',sourceNodeId:'a',targetNodeId:'b',condition:'A 到 B',revision:1},{id:'bc',sourceNodeId:'b',targetNodeId:'c',condition:'B 到 C',revision:1}],tasks:[],handoffs:[],activities:[],reviewPolicy:{revision:0,checkpoints:[]},humanReviews:[],requests:[],messages:[],conversation:[]};
const commands=[];let held=false,replies=[];
window.mixcat={panel:async()=>({panels:[],activePanelId:null}),subscribePanels:()=>()=>{},chooseAttachments:async()=>[]};
function Fixture(){const[snapshot,setSnapshot]=useState(initial);
window.fixture={inspect:()=>({commands,nodes:snapshot.nodes}),refresh:()=>setSnapshot(s=>({...s,nodes:s.nodes.map(n=>({...n}))})),running:()=>setSnapshot(s=>({...s,nodes:s.nodes.map(n=>({...n,status:'running'}))})),hold:()=>{held=true},release:()=>{held=false;const pending=replies;replies=[];pending.forEach(reply=>reply())},group:()=>setSnapshot(s=>({...s,groups:[{id:'g',name:'分组 G',nodeIds:['a','b'],coordinatorNodeId:'a',revision:1}]}))};
async function execute(command){commands.push(command);if(command.type==='move_node'||command.type==='move_nodes'){
return new Promise(resolve=>{const commit=()=>{const positions=command.positions??[{nodeId:command.nodeId,position:command.position}];setSnapshot(s=>({...s,nodes:s.nodes.map(n=>({...n,position:positions.find(p=>p.nodeId===n.id)?.position??n.position}))}));resolve({snapshot:{projects:[],selected:snapshot,runtime:null}})};held?replies.push(commit):commit()});}
return{snapshot:{projects:[],selected:snapshot,runtime:null},catalog:{models:[],skills:[],plugins:[],errors:[]}};}
return <Workbench snapshot={snapshot} runtime={{mode:'codex',connected:true,authenticated:true,error:null}} execute={execute} busy={false} error={null} onError={message=>{throw Error(message)}}/>;}
createRoot(document.getElementById('root')).render(<Fixture/>);`, resolveDir: root, loader: 'tsx' }, outfile: path('renderer.js'), bundle: true, format: 'iife', platform: 'browser', logLevel: 'silent' });
writeFileSync(path('index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="renderer.css"><div id="root" style="height:100vh;display:flex"></div><script src="renderer.js"></script>');
writeFileSync(path('main.cjs'), `const{app,BrowserWindow}=require('electron');for(const name of ['userData','sessionData','logs','crashDumps','temp'])app.setPath(name,require('node:path').join(${JSON.stringify(fixture)},name));app.commandLine.appendSwitch('disk-cache-dir',${JSON.stringify(path('cache'))});app.whenReady().then(()=>{const win=new BrowserWindow({width:1700,height:1050,show:false,webPreferences:{backgroundThrottling:false}});win.webContents.once('did-finish-load',()=>win.showInactive());win.loadFile(${JSON.stringify(path('index.html'))});});app.on('window-all-closed',()=>app.quit());`);
const driver = await openRendererFixture(root, fixture), { click, evaluate, poll, rpc, screenshot } = driver;
const selector = id => `.react-flow__node[data-id="${id}"] h3`;
async function settle() { await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); }
async function active(id) {
  await settle();
  assert.deepEqual(await evaluate("({title:document.querySelector('.session-pane h2')?.textContent,selected:[...document.querySelectorAll('.conversation-node.is-selected')].map(e=>e.closest('.react-flow__node').dataset.id)})"), { title: `节点 ${id.toUpperCase()}`, selected: [id] });
  const highlighted = await evaluate("[...document.querySelectorAll('.react-flow__edge')].filter(e=>Number.parseFloat(getComputedStyle(e.querySelector('.react-flow__edge-path')).strokeWidth)===3).map(e=>e.dataset.id).sort()");
  assert.deepEqual(highlighted, (id === 'a' ? ['definition:ab'] : id === 'c' ? ['definition:bc'] : ['definition:ab', 'definition:bc']));
}
async function move(selector, dx, dy) {
  const point = await poll(()=>evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return e.contains(document.elementFromPoint(x,y))?{x,y}:null})()`));
  await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 });
  for (const step of [.5, 1]) {
    await rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x + dx * step, y: point.y + dy * step, button: 'left', buttons: 1 });
    await settle();
  }
  await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x + dx, y: point.y + dy, button: 'left', buttons: 0, clickCount: 1 });
}
try {
  await poll(()=>evaluate("!!document.querySelector('.react-flow__node[data-id=a] h3')"));
  await evaluate('document.fonts.ready.then(()=>true)'); await settle();
  await click(selector('a')); await active('a');
  await click(selector('b')); await active('b');
  await click(selector('a')); await active('a');
  const before = await evaluate('window.fixture.inspect().nodes.map(n=>({id:n.id,position:n.position}))');
  await move(selector('b'), 2, 1); await active('b');
  await evaluate('window.fixture.refresh()'); await active('b');
  assert.deepEqual(await evaluate('window.fixture.inspect().nodes.map(n=>({id:n.id,position:n.position}))'), before, 'A small click movement must not move the graph');

  await click(selector('a')); await active('a');
  await evaluate('window.fixture.hold()');
  await move(selector('b'), 40, 15); await active('b');
  await poll(()=>evaluate("window.fixture.inspect().commands.some(c=>c.type==='move_node'&&c.nodeId==='b')"));
  await click(selector('c')); await active('c');
  await evaluate('window.fixture.release()'); await active('c');
  const saved = await evaluate('window.fixture.inspect().nodes.find(n=>n.id==="b").position');
  assert.notDeepEqual(saved, before.find(n=>n.id==='b').position);
  await evaluate('window.fixture.refresh()'); await active('c');

  for (const id of ['b', 'a', 'c', 'b']) { await click(selector(id)); await active(id); await evaluate('window.fixture.refresh()'); await active(id); }
  const pane = await evaluate("(()=>{const r=document.querySelector('.react-flow__pane').getBoundingClientRect();return{x:r.left+12,y:r.top+12}})()");
  await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', ...pane, button: 'left', clickCount: 1 });
  await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', ...pane, button: 'left', clickCount: 1 });
  await active('b');

  await evaluate("document.querySelector('.react-flow__node[data-id=a]').focus()");
  await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await active('a');
  const context = await evaluate("(()=>{const r=document.querySelector('.react-flow__node[data-id=b] h3').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()");
  for (const type of ['mousePressed', 'mouseReleased']) await rpc('Input.dispatchMouseEvent', { type, ...context, button: 'right', clickCount: 1 });
  await click('.canvas-context-menu button', '配置此节点'); await active('b');
  await poll(()=>evaluate("!!document.querySelector('.node-config')"));

  await click(selector('c')); await active('c');
  await evaluate('window.fixture.group()'); await settle();
  await move('.workflow-group-title strong', 30, 15);
  await poll(()=>evaluate("window.fixture.inspect().commands.some(c=>c.type==='move_nodes'&&c.positions.length===2)"));
  await active('c');
  await evaluate('window.fixture.running()'); await active('c');
  const styles = await evaluate("['a','c'].map(id=>{const e=document.querySelector('.react-flow__node[data-id='+id+'] .conversation-node'),s=getComputedStyle(e);return{border:s.borderColor,shadow:s.boxShadow,outline:s.outline}})");
  assert.notDeepEqual(styles[0], styles[1], 'The selected running node must remain visually distinct');
  assert.equal(await evaluate("document.querySelector('.react-flow__node[data-id=c] .conversation-node').getAttribute('aria-busy')"), 'true');
  await screenshot('node-selection.png');
  console.log(JSON.stringify({ passed: true, fixture, checks: ['click and small movement', 'drag with delayed save', 'refresh and repeated switch', 'pane consistency', 'keyboard and context menu', 'group drag', 'running selection appearance'] }));
} catch (error) { await screenshot('node-selection-failure.png'); throw error; }
finally { await driver.close(); }
