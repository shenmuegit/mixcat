import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WorkflowEngine } from '../src/core/engine.ts';
import { projectDirectory } from '../src/core/paths.ts';
import { openRendererFixture } from './human-review-electron-fixture.mjs';

const root = resolve('.'), evidence = projectDirectory(root, '.runtime', 'implementation', 'readable-arrange');
const fixture = mkdtempSync(join(evidence, 'electron-'));
const engine = new WorkflowEngine({ workbenchRoot: fixture, executable: 'unused', nativeFactory() { assert.fail('Diagram verification must not start a model'); } });
await engine.init();
const adjacency = { product: ['requirements'], requirements: ['design', 'architect'], design: ['frontend'], frontend: ['test', 'architect'], backend: ['frontend', 'architect'], test: ['frontend', 'backend', 'product'], architect: ['backend', 'frontend'] };
const projects = [];
for (const count of [13, 11]) {
  const created = (await engine.command({ type: 'create_project', root: projectDirectory(fixture, `product-${count}`), name: `Workflow ${count}`, goal: 'Readable workflow arrangement', template: 'web-product' })).snapshot.selected;
  for (const edge of created.edges) if (!adjacency[edge.sourceNodeId].includes(edge.targetNodeId) || count === 11 && edge.sourceNodeId === 'test' && ['frontend', 'product'].includes(edge.targetNodeId)) await engine.command({ type: 'delete_edge', projectId: created.project.id, edgeId: edge.id });
  projects.push({ count, id: created.project.id, before: (await engine.command({ type: 'snapshot', projectId: created.project.id })).snapshot.selected, identity: structuredClone(engine.nodeIdentity(created.project.id, 'product')) });
}
const requests = [];
let rejectArrange = false;
const bridge = createServer((request, response) => { let body = ''; request.on('data', chunk => body += chunk); request.on('end', () => { void (async () => {
  try { const envelope = JSON.parse(body); requests.push(envelope.command); if (rejectArrange && envelope.command.type === 'move_nodes') { rejectArrange = false; throw Error('Fixture refused readable arrangement'); } response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(await engine.command(envelope.command, envelope.id))); }
  catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: String(error.message ?? error) })); }
})(); }); });
bridge.listen(0, '127.0.0.1'); await once(bridge, 'listening');
const url = `http://127.0.0.1:${bridge.address().port}`, preload = join(fixture, 'preload.cjs');
writeFileSync(preload, `const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('mixcat',{command:e=>ipcRenderer.invoke('command',e),subscribe:()=>()=>{},chooseDirectory:async()=>null,chooseAttachments:async()=>[],panel:async()=>({panels:[],activePanelId:null}),subscribePanels:()=>()=>{}});`);
writeFileSync(join(fixture, 'main.cjs'), `const{app,BrowserWindow,ipcMain}=require('electron');const{join}=require('node:path');for(const name of ['userData','sessionData','logs','crashDumps','temp'])app.setPath(name,join(${JSON.stringify(fixture)},name));app.commandLine.appendSwitch('disk-cache-dir',join(${JSON.stringify(fixture)},'cache'));ipcMain.handle('command',async(_,e)=>{const r=await fetch(${JSON.stringify(url)},{method:'POST',body:JSON.stringify(e)});const value=await r.json();if(!r.ok)throw Error(value.error);return value;});app.on('window-all-closed',()=>app.quit());app.whenReady().then(()=>{const win=new BrowserWindow({width:1700,height:1100,show:false,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});win.loadFile(${JSON.stringify(join(root,'dist/client/renderer/index.html'))});});`);

let browser;
const results = [];
const overlap = (a, b) => Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x) + 2 && Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y) + 2;
try {
  browser = await openRendererFixture(root, fixture);
  const { evaluate, rpc, click, poll } = browser;
  const rendered = () => evaluate('new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))');
  const scene = () => evaluate(`(() => {
    const rect = e => { const r=e.getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height }; };
    return { canvas:rect(document.querySelector('.flow-wrap')), nodes:[...document.querySelectorAll('.react-flow__node')].map(e=>({id:e.dataset.id,...rect(e)})), labels:[...document.querySelectorAll('.condition-label')].map(e=>({id:e.dataset.edgeId,...rect(e)})), paths:[...document.querySelectorAll('.react-flow__edge-path')].map(e=>{
      const numbers=e.getAttribute('d').match(/[-+]?\\d*\\.?\\d+(?:e[-+]?\\d+)?/ig).map(Number), matrix=e.getScreenCTM(),points=[];
      for(let i=0;i<numbers.length;i+=2){const p=new DOMPoint(numbers[i],numbers[i+1]).matrixTransform(matrix);points.push({x:p.x,y:p.y});}
      return { id:e.closest('.react-flow__edge').dataset.id, points };
    }) };
  })()`);
  for (const project of projects) {
    if (results.length) { await rpc('Page.reload'); await poll(() => evaluate("document.querySelectorAll('.project-card').length===2")); }
    await click('.project-card', `Workflow ${project.count}`);
    await poll(() => evaluate("document.querySelectorAll('.react-flow__node').length===7"));
    const previousRequests = requests.filter(command => command.type === 'move_nodes').length;
    await click('button[aria-label="整理画布"]');
    await poll(() => requests.filter(command => command.type === 'move_nodes').length > previousRequests);
    await poll(() => evaluate("!document.querySelector('button[aria-label=\"整理画布\"]').disabled")); await rendered();
    assert.equal(await evaluate("!!document.querySelector('.error-banner')"), false);
    const measured = await scene();
    assert.equal(measured.nodes.length, 7); assert.equal(measured.paths.length, project.count); assert.equal(measured.labels.length, project.count);
    for (const node of measured.nodes) assert(node.width >= 130, 'Fit-to-view made the cards unnecessarily small');
    for (let i = 0; i < measured.labels.length; i++) {
      for (const node of measured.nodes) assert(!overlap(measured.labels[i], node), 'A condition label obscures a card');
      for (let j = i + 1; j < measured.labels.length; j++) assert(!overlap(measured.labels[i], measured.labels[j]), 'Condition labels pile up');
    }
    for (const item of [...measured.nodes, ...measured.labels]) assert(item.x >= measured.canvas.x && item.y >= measured.canvas.y && item.x + item.width <= measured.canvas.x + measured.canvas.width && item.y + item.height <= measured.canvas.y + measured.canvas.height, 'A diagram element is clipped');
    const segments = measured.paths.flatMap(path => path.points.slice(1).map((end, index) => ({ edge: path.id, start: path.points[index], end })));
    let longSharedSegments = 0, cardCrossings = 0;
    for (const segment of segments) {
      const a = segment.start, b = segment.end;
      for (const card of measured.nodes) {
        const cross = Math.abs(a.y - b.y) < .1 ? a.y > card.y + 2 && a.y < card.y + card.height - 2 && Math.min(Math.max(a.x, b.x), card.x + card.width - 2) > Math.max(Math.min(a.x, b.x), card.x + 2) : a.x > card.x + 2 && a.x < card.x + card.width - 2 && Math.min(Math.max(a.y, b.y), card.y + card.height - 2) > Math.max(Math.min(a.y, b.y), card.y + 2);
        if (cross) cardCrossings++;
      }
    }
    for (let i = 0; i < segments.length; i++) for (let j = i + 1; j < segments.length; j++) {
      const a = segments[i], b = segments[j]; if (a.edge === b.edge) continue;
      const horizontal = Math.abs(a.start.y - a.end.y) < .1 && Math.abs(b.start.y - b.end.y) < .1 && Math.abs(a.start.y - b.start.y) < .1;
      const vertical = Math.abs(a.start.x - a.end.x) < .1 && Math.abs(b.start.x - b.end.x) < .1 && Math.abs(a.start.x - b.start.x) < .1;
      const axis = horizontal ? 'x' : 'y';
      if ((horizontal || vertical) && Math.min(Math.max(a.start[axis], a.end[axis]), Math.max(b.start[axis], b.end[axis])) - Math.max(Math.min(a.start[axis], a.end[axis]), Math.min(b.start[axis], b.end[axis])) > 18) longSharedSegments++;
    }
    assert.equal(cardCrossings, 0); assert.equal(longSharedSegments, 0);
    const saved = (await engine.command({ type: 'snapshot', projectId: project.id })).snapshot.selected;
    assert.deepEqual(saved.edges, project.before.edges); assert.deepEqual(saved.tasks, project.before.tasks); assert.deepEqual(engine.nodeIdentity(project.id, 'product'), project.identity);
    for (const before of project.before.nodes) { const current=saved.nodes.find(node=>node.id===before.id); for(const key of ['revision','instructions','tools','model','skills','plugins','threadId'])assert.deepEqual(current[key],before[key]); }
    await browser.screenshot(`readable-${project.count}.png`);
    const capture = await rpc('Page.captureScreenshot', { format: 'png', clip: { ...measured.canvas, scale: 1 } });
    writeFileSync(join(fixture, `canvas-${project.count}.png`), Buffer.from(capture.data, 'base64'));
    await rpc('Page.reload'); await poll(() => evaluate("document.querySelectorAll('.project-card').length===2")); await click('.project-card', `Workflow ${project.count}`); await poll(() => evaluate(`document.querySelectorAll('.react-flow__edge-path').length===${project.count}`)); await rendered();
    const restored = await scene();
    assert.deepEqual(restored.paths.map(path => path.points.map(point => [Math.round(point.x * 10), Math.round(point.y * 10)])), measured.paths.map(path => path.points.map(point => [Math.round(point.x * 10), Math.round(point.y * 10)])));
    rejectArrange = true; await click('button[aria-label="整理画布"]');
    await poll(() => evaluate("document.body.textContent.includes('Fixture refused readable arrangement')")); await rendered();
    const rejected=(await engine.command({type:'snapshot',projectId:project.id})).snapshot.selected;
    assert.deepEqual(rejected.nodes,saved.nodes);assert.deepEqual(rejected.edgeLayouts,saved.edgeLayouts);
    await click('.error-banner button');
    const edgeId = 'architect-backend', pathSelector = `.react-flow__edge[data-id="definition:${edgeId}"] .react-flow__edge-path`;
    const hit = await evaluate(`(()=>{const path=document.querySelector(${JSON.stringify(pathSelector)});for(let f=.1;f<1;f+=.1){const p=path.getPointAtLength(path.getTotalLength()*f),s=new DOMPoint(p.x,p.y).matrixTransform(path.getScreenCTM());if(document.elementFromPoint(s.x,s.y)?.closest('.react-flow__edge')?.dataset.id==='definition:${edgeId}')return{x:s.x,y:s.y}}throw Error('No connector hit target')})()`);
    await rpc('Input.dispatchMouseEvent',{type:'mousePressed',...hit,button:'left',clickCount:1});await rpc('Input.dispatchMouseEvent',{type:'mouseReleased',...hit,button:'left',clickCount:1});
    const controls = `.edge-controls[data-edge-id="${edgeId}"]`;
    await poll(()=>evaluate(`document.querySelectorAll('${controls} .edge-middle-control').length===1&&document.querySelectorAll('${controls} .edge-endpoint').length===2`));
    await click(`${controls} .edge-middle-control`);
    await rpc('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40});await rpc('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40});
    await poll(()=>evaluate(`!document.querySelector('${controls} .edge-middle-control').disabled`));
    const edited=(await engine.command({type:'snapshot',projectId:project.id})).snapshot.selected.edgeLayouts[edgeId];
    assert.equal(edited.route,undefined);assert(Number.isFinite(edited.controlOffset.y));
    const designBefore=(await engine.command({type:'snapshot',projectId:project.id})).snapshot.selected.nodes.find(node=>node.id==='design').position;
    const heading=await evaluate("(()=>{const r=document.querySelector('.react-flow__node[data-id=\"design\"] h3').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()");
    await rpc('Input.dispatchMouseEvent',{type:'mousePressed',...heading,button:'left',buttons:1,clickCount:1});
    for(let step=1;step<=8;step++){
      await rpc('Input.dispatchMouseEvent',{type:'mouseMoved',x:heading.x+step*3,y:heading.y+step*2,buttons:1});
      if(step===4){await rendered();const gap=await evaluate(`(()=>{const path=document.querySelector('.react-flow__edge[data-id="definition:requirements-design"] .react-flow__edge-path'),p=path.getPointAtLength(path.getTotalLength()),s=new DOMPoint(p.x,p.y).matrixTransform(path.getScreenCTM()),r=document.querySelector('.react-flow__node[data-id="design"]').getBoundingClientRect(),a=${JSON.stringify(saved.edgeLayouts['requirements-design'].target)},x=r.x+(a.side==='right'?r.width:a.side==='left'?0:r.width*a.offset),y=r.y+(a.side==='bottom'?r.height:a.side==='top'?0:r.height*a.offset);return Math.hypot(s.x-x,s.y-y)})()`);assert(gap<1,'Planned connector must follow a node during the drag');}
    }
    await rpc('Input.dispatchMouseEvent',{type:'mouseReleased',x:heading.x+24,y:heading.y+16,button:'left',buttons:0,clickCount:1});
    await poll(async()=> (await engine.command({type:'snapshot',projectId:project.id})).snapshot.selected.nodes.find(node=>node.id==='design').position.x!==designBefore.x);
    results.push({ edges: project.count, labelOverlaps: 0, cardCrossings, longSharedSegments, minCardWidth: Math.min(...measured.nodes.map(node=>node.width)), savedAndReloaded: true, failedSaveRestored: true, manualControlsWorking: true, movedNodeFollows: true });
  }
  writeFileSync(join(evidence, 'readable-ui-result.json'), JSON.stringify({ passed: true, fixture, results }, null, 2));
  console.log(JSON.stringify({ passed: true, fixture, results }, null, 2));
} catch (error) { try { await browser?.screenshot('failure.png'); writeFileSync(join(fixture,'failure-state.json'),JSON.stringify(await browser.evaluate("({error:document.querySelector('.error-banner')?.textContent,body:document.body.textContent.slice(-1000)})"),null,2)); } catch {} throw error; }
finally { await browser?.close(); bridge.closeAllConnections(); await new Promise(resolve => bridge.close(resolve)); await engine.close(); }
