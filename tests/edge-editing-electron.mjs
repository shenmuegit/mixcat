import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WorkflowEngine } from '../src/core/engine.ts';
import { insideProject, projectDirectory } from '../src/core/paths.ts';
import { openRendererFixture } from './human-review-electron-fixture.mjs';

const root = resolve('.');
const evidence = projectDirectory(root, '.runtime', 'implementation', 'edge-routing');
const fixture = mkdtempSync(insideProject(root, join(evidence, 'electron-')));
const engine = new WorkflowEngine({ workbenchRoot: fixture, executable: 'unused', nativeFactory() { assert.fail('Connector editing must not run a native model'); } });
await engine.init();
const project = (await engine.command({ type: 'create_project', root: projectDirectory(fixture, 'product'), name: 'Connector editing', goal: 'Real pointer acceptance' })).snapshot.selected;
const projectId = project.project.id;
for (const [nodeId, position] of [['plan', { x: 80, y: 100 }], ['implement', { x: 460, y: 280 }], ['review', { x: 840, y: 100 }]]) await engine.command({ type: 'move_node', projectId, nodeId, position });
const edge = { id: 'route', sourceNodeId: 'plan', targetNodeId: 'implement', condition: 'Implementation is ready', revision: 0 };
await engine.command({ type: 'save_edge', projectId, edge });
await engine.command({ type: 'save_edge', projectId, edge: { ...edge, id: 'unrelated', sourceNodeId: 'implement', targetNodeId: 'review', condition: 'Review' } });
const snapshot = async () => (await engine.command({ type: 'snapshot', projectId })).snapshot.selected;
const before = await snapshot(), identity = structuredClone(engine.nodeIdentity(projectId, 'plan'));
let rejectNext = false;
const layoutRequests = [];
const bridge = createServer((request, response) => {
  let body = ''; request.on('data', chunk => body += chunk);
  request.on('end', () => { void (async () => {
    try {
      const envelope = JSON.parse(body);
      if (envelope.command.type === 'save_edge_layout') layoutRequests.push(envelope.command);
      if (rejectNext && envelope.command.type === 'save_edge_layout') { rejectNext = false; throw Error('Fixture refused the layout write'); }
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(await engine.command(envelope.command, envelope.id)));
    } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: String(error.message ?? error) })); }
  })(); });
});
bridge.listen(0, '127.0.0.1'); await once(bridge, 'listening');
const bridgeUrl = `http://127.0.0.1:${bridge.address().port}`;
const preload = insideProject(root, join(fixture, 'preload.cjs'));
writeFileSync(preload, `const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('mixcat',{command:e=>ipcRenderer.invoke('command',e),subscribe:fn=>{const listener=(_,update)=>fn(update);ipcRenderer.on('snapshot',listener);return()=>ipcRenderer.removeListener('snapshot',listener)},chooseDirectory:async()=>null,chooseAttachments:async()=>[],panel:async()=>({panels:[],activePanelId:null}),subscribePanels:()=>()=>{}});contextBridge.exposeInMainWorld('fixture',{refresh:()=>ipcRenderer.invoke('refresh')});`);
writeFileSync(join(fixture, 'main.cjs'), `
const {app,BrowserWindow,ipcMain}=require('electron'); const {join}=require('node:path');
for(const name of ['userData','sessionData','logs','crashDumps','temp']) app.setPath(name,join(${JSON.stringify(fixture)},name));
app.commandLine.appendSwitch('disk-cache-dir',join(${JSON.stringify(fixture)},'cache'));
async function command(body) {
  const response=await fetch(${JSON.stringify(bridgeUrl)},{method:'POST',body:JSON.stringify(body)});
  const result=await response.json(); if(!response.ok)throw Error(result.error); return result;
}
ipcMain.handle('command',(_,body)=>command(body));
ipcMain.handle('refresh',async event=>event.sender.send('snapshot',{kind:'full',snapshot:(await command({id:'refresh-'+Date.now(),command:{type:'snapshot',projectId:${JSON.stringify(projectId)}}})).snapshot}));
app.on('window-all-closed',()=>app.quit());
app.whenReady().then(()=>{const win=new BrowserWindow({width:1600,height:1000,show:false,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});win.loadFile(${JSON.stringify(join(root,'dist/client/renderer/index.html'))});});
`);
let browser;
const checks = [];
try {
  browser = await openRendererFixture(root, fixture);
  const { evaluate, rpc, click, poll } = browser;
  const controls = '.edge-controls[data-edge-id="route"]';
  const pathSelector = '.react-flow__edge[data-id="definition:route"] .react-flow__edge-path';
  const point = selector => poll(() => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)return null;const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`));
  const mouse = (type, position, pressed = true) => rpc('Input.dispatchMouseEvent', { type, ...position, button: type === 'mouseMoved' ? 'none' : 'left', buttons: pressed ? 1 : 0, clickCount: 1 });
  const drag = async (selector, destination, during) => {
    await poll(() => evaluate(`!!document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled`));
    const from = await point(selector);
    const hit = await evaluate(`(()=>{const e=document.elementFromPoint(${from.x},${from.y});return{tag:e?.tagName,aria:e?.getAttribute('aria-label'),className:e?.getAttribute('class')}})()`);
    assert.equal(hit.tag, 'BUTTON', `Expected connector control at pointer: ${JSON.stringify(hit)}`);
    await mouse('mousePressed', from);
    for (let step = 1; step <= 8; step++) await mouse('mouseMoved', { x: from.x + (destination.x - from.x) * step / 8, y: from.y + (destination.y - from.y) * step / 8 });
    if (during) await during();
    await mouse('mouseReleased', destination, false);
  };
  async function selectEdge() {
    const location = await evaluate(`(()=>{const path=document.querySelector(${JSON.stringify(pathSelector)}),matrix=path.getScreenCTM();for(let f=.1;f<1;f+=.1){const p=path.getPointAtLength(path.getTotalLength()*f);const s=new DOMPoint(p.x,p.y).matrixTransform(matrix);if(document.elementFromPoint(s.x,s.y)?.closest('.react-flow__edge[data-id="definition:route"]'))return{x:s.x,y:s.y}}throw Error('No visible connector hit target')})()`);
    await mouse('mousePressed', location); await mouse('mouseReleased', location, false);
    await poll(() => evaluate(`!!document.querySelector('${controls}')`));
  }
  await poll(() => evaluate("document.querySelectorAll('.project-card').length===1"));
  await click('.project-card');
  await poll(() => evaluate("document.querySelectorAll('.react-flow__edge').length===2"));
  await click('.project-controls button', '节点详情');
  await selectEdge();
  assert.equal(await evaluate("!!document.querySelector('dialog')"), false);
  const initialPath = await evaluate(`document.querySelector(${JSON.stringify(pathSelector)}).getAttribute('d')`);
  const vertical = `${controls} .edge-segment-control.vertical`;
  const v = await point(vertical);
  await drag(vertical, { x: v.x + 74, y: v.y });
  await poll(async () => (await snapshot()).edgeLayouts?.route?.revision === 1);
  assert.notEqual(await evaluate(`document.querySelector(${JSON.stringify(pathSelector)}).getAttribute('d')`), initialPath);
  const horizontal = `${controls} .edge-segment-control.horizontal`;
  const h = await point(horizontal);
  await drag(horizontal, { x: h.x, y: h.y + 55 });
  await poll(async () => (await snapshot()).edgeLayouts?.route?.revision === 2);
  checks.push('real vertical and horizontal segment drags change and persist the orthogonal route');

  const source = `${controls} [aria-label="调整连线起点"]`, target = `${controls} [aria-label="调整连线终点"]`;
  const nodeRect = id => evaluate(`(()=>{const r=document.querySelector('.react-flow__node[data-id="${id}"]').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()`);
  const sourceNode = await nodeRect('plan');
  await drag(source, { x: sourceNode.x + sourceNode.width * .25 + 2, y: sourceNode.y - 3 }, async () => {
    await evaluate('window.fixture.refresh()');
    await poll(() => evaluate(`document.querySelector('${source}').classList.contains('is-snapped') && document.querySelectorAll('.edge-snap-point').length===12`));
  });
  await poll(async () => (await snapshot()).edgeLayouts?.route?.revision === 3);
  assert.deepEqual((await snapshot()).edgeLayouts.route.source, { side: 'top', offset: .25 });
  const targetNode = await nodeRect('implement');
  await drag(target, { x: targetNode.x + targetNode.width * .75, y: targetNode.y + targetNode.height + 4 });
  await poll(async () => (await snapshot()).edgeLayouts?.route?.revision === 4);
  assert.deepEqual((await snapshot()).edgeLayouts.route.target, { side: 'bottom', offset: .75 });
  checks.push('both endpoints snap with visible feedback to quarter-point attachments on their original nodes');

  const saved = structuredClone((await snapshot()).edgeLayouts.route);
  await drag(source, { x: targetNode.x + targetNode.width / 2, y: targetNode.y + targetNode.height / 2 }, async () => {
    await poll(() => evaluate(`document.querySelector('${source}').classList.contains('is-unsnapped')`));
  });
  assert.deepEqual((await snapshot()).edgeLayouts.route, saved);
  const p = await point(horizontal);
  await drag(horizontal, { x: p.x, y: p.y + 40 }, async () => { await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); });
  assert.deepEqual((await snapshot()).edgeLayouts.route, saved);
  checks.push('dropping away from the original node and pressing Escape preserve the saved layout');

  rejectNext = true;
  const q = await point(horizontal);
  await drag(horizontal, { x: q.x, y: q.y + 30 });
  await poll(() => evaluate("document.querySelector('.edge-layout-error')?.textContent.includes('未保存')"));
  assert.deepEqual((await snapshot()).edgeLayouts.route, saved);
  checks.push('a rejected persistence request reports failure and restores the saved connector');
  await browser.screenshot('edited-connectors.png');

  const pathBeforeReload = await evaluate(`document.querySelector(${JSON.stringify(pathSelector)}).getAttribute('d')`);
  await rpc('Page.reload'); await poll(() => evaluate("document.querySelectorAll('.project-card').length===1")); await click('.project-card');
  await poll(() => evaluate(`document.querySelector(${JSON.stringify(pathSelector)})?.getAttribute('d')===${JSON.stringify(pathBeforeReload)}`));
  await selectEdge();
  const control = `${controls} .edge-segment-control.vertical`;
  await click(control); await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 }); await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
  await poll(async () => (await snapshot()).edgeLayouts.route.revision === 5);
  assert.deepEqual((await snapshot()).edges, before.edges);
  assert.deepEqual((await snapshot()).nodes, before.nodes);
  assert.deepEqual(engine.nodeIdentity(projectId, 'plan'), identity);
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.react-flow__edge[data-id=\"definition:unrelated\"] .react-flow__edge-path')).opacity"), '1');
  const nodeBefore = (await snapshot()).nodes[0];
  const heading = await point('.react-flow__node[data-id="plan"] h3');
  await mouse('mousePressed', heading);
  for (let step = 1; step <= 8; step++) await mouse('mouseMoved', { x: heading.x + step * 4, y: heading.y + step * 3 });
  await mouse('mouseReleased', { x: heading.x + 32, y: heading.y + 24 }, false);
  await poll(async () => (await snapshot()).nodes[0].position.x !== nodeBefore.position.x);
  assert.equal((await snapshot()).nodes[0].revision, nodeBefore.revision);
  assert.deepEqual((await snapshot()).edgeLayouts.route.source, saved.source);
  await poll(() => evaluate(`(()=>{const p=document.querySelector(${JSON.stringify(pathSelector)}),s=p.getPointAtLength(0),point=new DOMPoint(s.x,s.y).matrixTransform(p.getScreenCTM()),r=document.querySelector('.react-flow__node[data-id="plan"]').getBoundingClientRect();return Math.abs(point.x-r.x-r.width*.25)<1&&Math.abs(point.y-r.y)<1})()`));
  checks.push('background snapshots do not interrupt a drag and moved nodes retain their saved attachment position');
  await selectEdge();
  await click('.condition-label', 'Implementation is ready');
  await poll(() => evaluate("document.querySelector('dialog[open]')?.textContent.includes('关联条件')"));
  checks.push('reload restores the route; keyboard nudges and condition editing work without changing node configuration, conditions or MCP identity');
  writeFileSync(join(evidence, 'ui-result.json'), JSON.stringify({ passed: true, fixture, checks, nativeModels: false }, null, 2));
  console.log(JSON.stringify({ passed: true, fixture, checks: checks.length }, null, 2));
} catch (error) { try { await browser?.screenshot('failure.png'); } catch {} throw error; }
finally { writeFileSync(join(fixture, 'layout-requests.json'), JSON.stringify(layoutRequests, null, 2)); await browser?.close(); bridge.closeAllConnections(); await new Promise(resolve => bridge.close(resolve)); await engine.close(); }
