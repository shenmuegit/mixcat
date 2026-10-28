import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WorkflowEngine } from '../src/core/engine.ts';
import { insideProject, projectDirectory } from '../src/core/paths.ts';
import { openRendererFixture } from './human-review-electron-fixture.mjs';

const root = resolve('.');
const evidence = projectDirectory(root, '.runtime', 'implementation', 'single-control');
const fixture = mkdtempSync(insideProject(root, join(evidence, 'electron-')));
const engine = new WorkflowEngine({ workbenchRoot: fixture, executable: 'unused', nativeFactory() { assert.fail('Connector editing must not run a native model'); } });
await engine.init();
const project = (await engine.command({ type: 'create_project', root: projectDirectory(fixture, 'product'), name: 'Connector editing', goal: 'Real pointer acceptance' })).snapshot.selected;
const projectId = project.project.id;
for (const [nodeId, position] of [['plan', { x: 80, y: 100 }], ['implement', { x: 460, y: 280 }], ['review', { x: 840, y: 100 }]]) await engine.command({ type: 'move_node', projectId, nodeId, position });
const edge = { id: 'route', sourceNodeId: 'plan', targetNodeId: 'implement', condition: 'Implementation is ready', revision: 0 };
await engine.command({ type: 'save_edge', projectId, edge });
await engine.command({ type: 'save_edge', projectId, edge: { ...edge, id: 'unrelated', sourceNodeId: 'implement', targetNodeId: 'review', condition: 'Review' } });
await engine.command({ type: 'save_edge_layout', projectId, edgeId: edge.id, layout: { revision: 0, bends: [{ x: 315, y: 165 }, { x: 360, y: 165 }, { x: 360, y: 220 }, { x: 420, y: 220 }, { x: 420, y: 345 }, { x: 440, y: 345 }] } });
const snapshot = async () => (await engine.command({ type: 'snapshot', projectId })).snapshot.selected;
const before = await snapshot(), identity = structuredClone(engine.nodeIdentity(projectId, 'plan'));
let rejectNext = false, rejectArrange = false;
const layoutRequests = [], arrangeRequests = [];
let nextHold;
const holds = new Set();
function hold(type, after = false) {
  let release, reject;
  const gate = { type, after, started: false, promise: new Promise((resolve, fail) => { release = resolve; reject = fail; }), release: () => release(), reject: () => reject(Error('Fixture refused the node move')) };
  holds.add(gate); nextHold = gate; return gate;
}
const bridge = createServer((request, response) => {
  let body = ''; request.on('data', chunk => body += chunk);
  request.on('end', () => { void (async () => {
    try {
      const envelope = JSON.parse(body);
      if (envelope.command.type === 'move_nodes') { arrangeRequests.push(envelope.command); if (rejectArrange) { rejectArrange = false; throw Error('Fixture refused arrangement'); } }
      const gate = nextHold?.type === envelope.command.type ? nextHold : null;
      if (gate) nextHold = null;
      if (envelope.command.type === 'save_edge_layout') layoutRequests.push(envelope.command);
      if (rejectNext && envelope.command.type === 'save_edge_layout') { rejectNext = false; throw Error('Fixture refused the layout write'); }
      if (gate && !gate.after) { gate.started = true; await gate.promise; }
      const reply = await engine.command(envelope.command, envelope.id);
      if (gate?.after) { gate.started = true; await gate.promise; }
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(reply));
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
app.whenReady().then(()=>{const win=new BrowserWindow({width:1600,height:1000,show:false,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});win.loadFile(${JSON.stringify(join(root,'dist/client/renderer/index.html'))}).then(()=>{win.focus();win.webContents.focus()});});
`);
let browser;
const checks = [];
try {
  browser = await openRendererFixture(root, fixture);
  const { evaluate, rpc, click, poll } = browser;
  const controls = '.edge-controls[data-edge-id="route"]';
  const middle = `${controls} .edge-middle-control`;
  const pathSelector = '.react-flow__edge[data-id="definition:route"] .react-flow__edge-path';
  const point = selector => poll(() => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)return null;const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`));
  const mouse = (type, position, pressed = true) => rpc('Input.dispatchMouseEvent', { type, ...position, button: type === 'mouseMoved' ? 'none' : 'left', buttons: pressed ? 1 : 0, clickCount: 1 });
  const rendered = () => evaluate('new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))');
  const path = () => evaluate(`document.querySelector(${JSON.stringify(pathSelector)}).getAttribute('d')`);
  async function stablePath(expected) {
    const frames = await evaluate(`new Promise(done => { const paths=[]; const sample=()=>{paths.push(document.querySelector(${JSON.stringify(pathSelector)}).getAttribute('d'));if(paths.length===12)done(paths);else requestAnimationFrame(sample)};requestAnimationFrame(sample); })`);
    assert.deepEqual([...new Set(frames)], [expected], 'The dropped connector must stay in place while saving');
  }
  const drag = async (selector, destination, during) => {
    await poll(() => evaluate(`!!document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled`));
    const from = await point(selector);
    const hit = await evaluate(`(()=>{const e=document.elementFromPoint(${from.x},${from.y});return{tag:e?.tagName,aria:e?.getAttribute('aria-label'),className:e?.getAttribute('class')}})()`);
    assert.equal(hit.tag, 'BUTTON', `Expected connector control at pointer: ${JSON.stringify(hit)}`);
    assert(await evaluate(`document.querySelector(${JSON.stringify(selector)}).contains(document.elementFromPoint(${from.x},${from.y}))`), `Another control covers ${selector}`);
    await mouse('mousePressed', from);
    for (let step = 1; step <= 8; step++) await mouse('mouseMoved', { x: from.x + (destination.x - from.x) * step / 8, y: from.y + (destination.y - from.y) * step / 8 });
    if (during) await during();
    await mouse('mouseReleased', destination, false);
  };
  async function selectEdge() {
    const location = await evaluate(`(()=>{const path=document.querySelector(${JSON.stringify(pathSelector)}),matrix=path.getScreenCTM();for(let f=.1;f<1;f+=.1){const p=path.getPointAtLength(path.getTotalLength()*f);const s=new DOMPoint(p.x,p.y).matrixTransform(matrix);if(document.elementFromPoint(s.x,s.y)?.closest('.react-flow__edge[data-id="definition:route"]'))return{x:s.x,y:s.y}}throw Error('No visible connector hit target')})()`);
    await mouse('mousePressed', location); await mouse('mouseReleased', location, false);
    await poll(() => evaluate(`!!document.querySelector('${controls}')`));
    return location;
  }
  let expectedRevision = 1;
  async function savedLayout() {
    expectedRevision++;
    await poll(async () => (await snapshot()).edgeLayouts?.route?.revision === expectedRevision);
    await poll(() => evaluate(`!!document.querySelector('${middle}') && !document.querySelector('${middle}').disabled`));
    assert.equal(await evaluate(`document.querySelectorAll('${middle}').length`), 1);
    assert.equal(await evaluate(`document.querySelectorAll('${controls} .edge-endpoint').length`), 2);
    assert.equal((await snapshot()).edgeLayouts.route.bends, undefined);
  }
  await poll(() => evaluate("document.querySelectorAll('.project-card').length===1"));
  await click('.project-card');
  await poll(() => evaluate("document.querySelectorAll('.react-flow__edge').length===2"));
  await click('[aria-label="收起节点详情"]');
  await selectEdge();
  assert.equal(await evaluate("!!document.querySelector('dialog')"), false);
  assert.equal(await evaluate(`document.querySelectorAll('${middle}').length`), 1, 'A legacy connector exposes one middle control');
  const initialPath = await evaluate(`document.querySelector(${JSON.stringify(pathSelector)}).getAttribute('d')`);
  const v = await point(middle);
  const middleSave = hold('save_edge_layout');
  await drag(middle, { x: v.x + 40, y: v.y });
  await poll(() => middleSave.started); await rendered();
  const droppedMiddle = await path();
  await evaluate('window.fixture.refresh()'); await stablePath(droppedMiddle);
  middleSave.release();
  await savedLayout();
  assert.notEqual(await evaluate(`document.querySelector(${JSON.stringify(pathSelector)}).getAttribute('d')`), initialPath);
  const h = await point(middle);
  await drag(middle, { x: h.x, y: h.y - 55 });
  await savedLayout();
  for (const step of [10, -10, 10, -10]) {
    const p = await point(middle);
    await drag(middle, { x: p.x + step, y: p.y });
    await savedLayout();
  }
  const line = await selectEdge();
  await mouse('mousePressed', line);
  for (let step = 1; step <= 6; step++) await mouse('mouseMoved', { x: line.x + step * 2, y: line.y });
  await mouse('mouseReleased', { x: line.x + 12, y: line.y }, false);
  await savedLayout();
  checks.push('a legacy route and repeated two-axis drags expose exactly one middle control and save one relative offset');

  const source = `${controls} [aria-label="调整连线起点"]`, target = `${controls} [aria-label="调整连线终点"]`;
  const nodeRect = id => evaluate(`(()=>{const r=document.querySelector('.react-flow__node[data-id="${id}"]').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()`);
  const sourceNode = await nodeRect('plan');
  const endpointSave = hold('save_edge_layout');
  await drag(source, { x: sourceNode.x + sourceNode.width * .25 + 2, y: sourceNode.y - 3 }, async () => {
    await evaluate('window.fixture.refresh()');
    await poll(() => evaluate(`document.querySelector('${source}').classList.contains('is-snapped') && document.querySelectorAll('.edge-snap-point').length===12`));
  });
  await poll(() => endpointSave.started);
  await rendered();
  const droppedEndpoint = await path();
  await evaluate('window.fixture.refresh()');
  await click('.react-flow__node[data-id="review"] h3');
  await stablePath(droppedEndpoint);
  endpointSave.release();
  await selectEdge();
  await savedLayout();
  assert.deepEqual((await snapshot()).edgeLayouts.route.source, { side: 'top', offset: .25 });
  const targetNode = await nodeRect('implement');
  await drag(target, { x: targetNode.x + targetNode.width * .75, y: targetNode.y + targetNode.height + 4 });
  await savedLayout();
  assert.deepEqual((await snapshot()).edgeLayouts.route.target, { side: 'bottom', offset: .75 });
  checks.push('both endpoints snap with visible feedback to quarter-point attachments on their original nodes');

  const saved = structuredClone((await snapshot()).edgeLayouts.route);
  await drag(source, { x: targetNode.x + targetNode.width / 2, y: targetNode.y + targetNode.height / 2 }, async () => {
    await poll(() => evaluate(`document.querySelector('${source}').classList.contains('is-unsnapped') || !document.querySelector('.edge-controls [role=status]')`));
  });
  assert.deepEqual((await snapshot()).edgeLayouts.route, saved);
  await selectEdge();
  const p = await point(middle);
  await drag(middle, { x: p.x, y: p.y + 40 }, async () => { await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); });
  assert.deepEqual((await snapshot()).edgeLayouts.route, saved);
  await selectEdge();
  checks.push('dropping away from the original node and pressing Escape preserve the saved layout');

  const requestsBeforeFocusLoss = layoutRequests.length;
  const captureStart = await point(middle);
  await drag(middle, { x: captureStart.x, y: captureStart.y + 35 }, async () => {
    await evaluate("window.dispatchEvent(new Event('blur'))");
  });
  await poll(() => evaluate("!document.querySelector('.edge-controls [role=status]')"));
  assert.equal(layoutRequests.length, requestsBeforeFocusLoss);
  assert.deepEqual((await snapshot()).edgeLayouts.route, saved);
  await selectEdge();
  checks.push('losing window focus cancels the drag without issuing a save');

  rejectNext = true;
  const q = await point(middle);
  await drag(middle, { x: q.x, y: q.y + 30 });
  await poll(() => evaluate("document.querySelector('.edge-layout-error')?.textContent.includes('未保存')"));
  assert.deepEqual((await snapshot()).edgeLayouts.route, saved);
  checks.push('a rejected persistence request reports failure and restores the saved connector');
  await browser.screenshot('edited-connectors.png');

  console.log('single control, snapping and cancellation verified');
  const pathBeforeReload = await evaluate(`document.querySelector(${JSON.stringify(pathSelector)}).getAttribute('d')`);
  await rpc('Page.reload'); await poll(() => evaluate("document.querySelectorAll('.project-card').length===1")); await click('.project-card');
  await poll(() => evaluate(`document.querySelector(${JSON.stringify(pathSelector)})?.getAttribute('d')===${JSON.stringify(pathBeforeReload)}`));
  await selectEdge();
  assert.equal(await evaluate(`document.querySelectorAll('${middle}').length`), 1);
  await click(middle); await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 }); await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
  await savedLayout();
  assert.deepEqual((await snapshot()).edges, before.edges);
  assert.deepEqual((await snapshot()).nodes, before.nodes);
  assert.deepEqual(engine.nodeIdentity(projectId, 'plan'), identity);
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.react-flow__edge[data-id=\"definition:unrelated\"] .react-flow__edge-path')).opacity"), '1');
  console.log('reload and keyboard verified; checking live node movement');
  const geometry = () => evaluate(`(()=>{const path=document.querySelector(${JSON.stringify(pathSelector)}),matrix=path.getScreenCTM().inverse();const at=(selector,center)=>{const e=document.querySelector(selector);if(!e)return null;const r=e.getBoundingClientRect();const p=new DOMPoint(r.x+(center?r.width/2:0),r.y+(center?r.height/2:0)).matrixTransform(matrix);return{x:p.x,y:p.y}};const middle=at('${middle}',true);return{middle,source:at('.react-flow__node[data-id="plan"]',false),target:at('.react-flow__node[data-id="implement"]',false),path:path.getAttribute('d')}})()`);
  const onRoute = point => evaluate(`document.querySelector(${JSON.stringify(pathSelector)}).isPointInStroke(new DOMPoint(${point.x},${point.y}))`);
  for (const [id, key] of [['plan', 'source'], ['implement', 'target']]) {
    await selectEdge();
    const beforeMove = await geometry(), nodeBefore = (await snapshot()).nodes.find(node => node.id === id);
    const heading = await point(`.react-flow__node[data-id="${id}"] h3`);
    const moveSave = hold('move_node');
    await mouse('mousePressed', heading);
    for (let step = 1; step <= 8; step++) {
      await mouse('mouseMoved', { x: heading.x + step * 4, y: heading.y + step * 3 });
      if (step === 4) {
        await poll(async () => { const live = await geometry(); return Math.abs(live[key].x - beforeMove[key].x) > 1; });
        const live = await geometry();
        const expectedControl = { x: beforeMove.middle.x + (live[key].x - beforeMove[key].x) / 2, y: beforeMove.middle.y + (live[key].y - beforeMove[key].y) / 2 };
        await poll(() => onRoute(expectedControl));
        assert.notEqual(live.path, beforeMove.path);
      }
    }
    await rendered();
    const droppedPath = await path();
    await mouse('mouseReleased', { x: heading.x + 32, y: heading.y + 24 }, false);
    await poll(() => moveSave.started);
    await evaluate('window.fixture.refresh()');
    await click('.react-flow__node[data-id="review"] h3');
    await stablePath(droppedPath);
    moveSave.release();
    await poll(async () => (await snapshot()).nodes.find(node => node.id === id).position.x !== nodeBefore.position.x);
    assert.equal((await snapshot()).nodes.find(node => node.id === id).revision, nodeBefore.revision);
    await selectEdge();
    const afterMove = await geometry();
    assert(Math.abs(afterMove.middle.x - beforeMove.middle.x - (afterMove[key].x - beforeMove[key].x) / 2) < .01);
    assert(Math.abs(afterMove.middle.y - beforeMove.middle.y - (afterMove[key].y - beforeMove[key].y) / 2) < .01);
  }
  checks.push('node drops and endpoint edits stay at their preview position through delayed saves, background snapshots and selection changes');

  async function moveNode(id, dx, dy, during) {
    const heading = await point(`.react-flow__node[data-id="${id}"] h3`);
    await mouse('mousePressed', heading);
    for (let step = 1; step <= 8; step++) await mouse('mouseMoved', { x: heading.x + dx * step / 8, y: heading.y + dy * step / 8 });
    await rendered(); const dropped = await path();
    if (during) await during(dropped);
    await mouse('mouseReleased', { x: heading.x + dx, y: heading.y + dy }, false);
    return dropped;
  }
  const persistedPath = await path(), persistedNode = (await snapshot()).nodes.find(node => node.id === 'implement');
  const failedMove = hold('move_node');
  const rejectedPath = await moveNode('implement', 24, 20);
  await poll(() => failedMove.started); await stablePath(rejectedPath);
  failedMove.reject();
  await poll(() => evaluate("document.body.textContent.includes('Fixture refused the node move')"));
  await poll(async () => await path() === persistedPath);
  assert.deepEqual((await snapshot()).nodes.find(node => node.id === 'implement').position, persistedNode.position);
  checks.push('a rejected node move restores the saved node and connector with visible error feedback');

  const olderMove = hold('move_node', true);
  await moveNode('implement', 24, 20);
  await poll(() => olderMove.started);
  const newerMove = hold('move_node');
  const newestPath = await moveNode('implement', 24, 20);
  await poll(() => newerMove.started);
  olderMove.release();
  await evaluate('window.fixture.refresh()'); await stablePath(newestPath);
  newerMove.release();
  await poll(async () => await path() === newestPath);
  await rendered(); await stablePath(newestPath);
  checks.push('a late response for an older move cannot overwrite the latest drop');

  const activeOlderMove = hold('move_node', true);
  await moveNode('implement', -16, 16);
  await poll(() => activeOlderMove.started);
  const activeNewerMove = hold('move_node');
  const activePath = await moveNode('implement', -16, 16, async dropped => {
    activeOlderMove.release();
    await evaluate('window.fixture.refresh()'); await stablePath(dropped);
  });
  await poll(() => activeNewerMove.started); await stablePath(activePath);
  activeNewerMove.release();
  await poll(async () => await path() === activePath);
  checks.push('an older acknowledgement arriving during the next active gesture does not move its node or connector');
  assert.deepEqual((await snapshot()).edgeLayouts.route.controlOffset, { x: saved.controlOffset.x + 10, y: saved.controlOffset.y });
  assert.deepEqual((await snapshot()).edgeLayouts.route.source, saved.source);
  await poll(() => evaluate(`(()=>{const p=document.querySelector(${JSON.stringify(pathSelector)}),s=p.getPointAtLength(0),point=new DOMPoint(s.x,s.y).matrixTransform(p.getScreenCTM()),r=document.querySelector('.react-flow__node[data-id="plan"]').getBoundingClientRect();return Math.abs(point.x-r.x-r.width*.25)<1&&Math.abs(point.y-r.y)<1})()`));
  checks.push('moving either node updates the single control and the complete rendered route during the drag');
  await selectEdge();
  const movedGeometry = await geometry();
  await rpc('Page.reload'); await poll(() => evaluate("document.querySelectorAll('.project-card').length===1")); await click('.project-card');
  await poll(() => evaluate(`document.querySelector(${JSON.stringify(pathSelector)})?.getAttribute('d')===${JSON.stringify(movedGeometry.path)}`));
  await selectEdge();
  assert.equal(await evaluate(`document.querySelectorAll('${middle}').length`), 1);
  const reopenedGeometry = await geometry();
  assert(Math.abs(reopenedGeometry.middle.x - movedGeometry.middle.x) < .01 && Math.abs(reopenedGeometry.middle.y - movedGeometry.middle.y) < .01);
  await browser.screenshot('single-control-following.png');
  const organize = 'button[aria-label="整理画布"]';
  const displayed = () => evaluate(`(() => {
    const matrix = document.querySelector(${JSON.stringify(pathSelector)}).getScreenCTM().inverse();
    return [...document.querySelectorAll('.react-flow__node')].map(e => {
      const r = e.getBoundingClientRect(), p = new DOMPoint(r.x, r.y).matrixTransform(matrix);
      return { nodeId: e.dataset.id, position: { x: p.x, y: p.y } };
    });
  })()`);
  const closePositions = (actual, expected) => { for (const item of expected) { const position = actual.find(node => node.nodeId === item.nodeId).position; assert(Math.abs(position.x - item.position.x) < .01 && Math.abs(position.y - item.position.y) < .01); } };
  const buttonCorner = async () => {
    const location = await point(organize), rect = await evaluate("(()=>{const r=document.querySelector('.flow-wrap').getBoundingClientRect();return{x:r.x,bottom:r.bottom}})()");
    assert(location.x - rect.x < 90 && rect.bottom - location.y < 60, 'Arrange stays at the canvas bottom-left');
    return location;
  };
  const beforeArrange = await snapshot();
  await buttonCorner();
  const heldArrange = hold('move_nodes');
  await click(organize); await poll(() => heldArrange.started); await rendered();
  const requested = arrangeRequests.at(-1).positions;
  closePositions(await displayed(), requested);
  assert.deepEqual((await snapshot()).nodes, beforeArrange.nodes, 'Pending arrangement has not written a partial layout');
  assert.equal(await evaluate(`document.querySelector('${organize}').disabled`), true);
  const disabledPoint = await evaluate(`(()=>{const r=document.querySelector('${organize}').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await mouse('mousePressed', disabledPoint); await mouse('mouseReleased', disabledPoint, false);
  assert.equal(arrangeRequests.length, 1, 'A disabled Arrange button cannot submit twice');
  await evaluate('window.fixture.refresh()'); await rendered(); closePositions(await displayed(), requested);
  await moveNode('plan', 20, 20); closePositions(await displayed(), requested);
  heldArrange.release();
  await poll(() => evaluate(`!document.querySelector('${organize}').disabled`));
  closePositions((await snapshot()).nodes.map(node => ({ nodeId: node.id, position: node.position })), requested);
  assert.equal(Object.keys((await snapshot()).edgeLayouts).length, beforeArrange.edges.length);
  assert(Object.values((await snapshot()).edgeLayouts).every(layout => layout.route?.points.length >= 2));
  assert.deepEqual((await snapshot()).edges, beforeArrange.edges);
  assert.deepEqual(engine.nodeIdentity(projectId, 'plan'), identity);
  assert.equal(new Set(requested.map(item => `${item.position.x},${item.position.y}`)).size, requested.length, 'Arrange gives every connected node its own position');
  assert.equal(await evaluate("(()=>{const canvas=document.querySelector('.flow-wrap').getBoundingClientRect();return [...document.querySelectorAll('.react-flow__node')].every(e=>{const r=e.getBoundingClientRect();return r.left>=canvas.left&&r.right<=canvas.right&&r.top>=canvas.top&&r.bottom<=canvas.bottom})})()"), true);
  await browser.screenshot('arranged-canvas.png');
  checks.push('bottom-left Arrange previews every node together, blocks duplicate clicks and dragging, survives background snapshots and fits the saved layout');

  const arranged = (await snapshot()).nodes.map(node => ({ nodeId: node.id, position: node.position }));
  await rpc('Page.reload'); await poll(() => evaluate("document.querySelectorAll('.project-card').length===1")); await click('.project-card');
  await poll(() => evaluate("document.querySelectorAll('.react-flow__node').length===3")); await rendered(); closePositions(await displayed(), arranged);
  for (let tab = 0; tab < 50 && !(await evaluate(`document.activeElement===document.querySelector('${organize}')`)); tab++) {
    await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  }
  assert.equal(await evaluate(`document.activeElement===document.querySelector('${organize}')`), true);
  await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
  await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await poll(() => arrangeRequests.length >= 2);
  assert.equal(arrangeRequests.length, 2);
  await poll(() => evaluate(`!document.querySelector('${organize}').disabled`));
  const pane = await point('.flow-wrap');
  await rpc('Input.dispatchMouseEvent', { type: 'mouseWheel', ...pane, deltaY: -160, deltaX: 0 });
  await mouse('mousePressed', { x: pane.x, y: pane.y + 100 }); await mouse('mouseMoved', { x: pane.x + 40, y: pane.y + 130 }); await mouse('mouseReleased', { x: pane.x + 40, y: pane.y + 130 }, false);
  await buttonCorner();
  checks.push('saved arrangement reloads correctly; Tab/Enter activates Arrange and its corner placement stays fixed through pan/zoom');

  await click(organize); await poll(() => arrangeRequests.length === 3); await poll(() => evaluate(`!document.querySelector('${organize}').disabled`));
  const reviewBefore = (await snapshot()).nodes.find(node => node.id === 'review').position;
  await moveNode('review', -24, -20);
  await poll(async () => (await snapshot()).nodes.find(node => node.id === 'review').position.x !== reviewBefore.x);
  const beforeRejectedArrange = await snapshot();
  rejectArrange = true; await click(organize);
  await poll(() => evaluate("document.body.textContent.includes('Fixture refused arrangement')"));
  await poll(() => evaluate(`!document.querySelector('${organize}').disabled`)); await rendered();
  assert.deepEqual((await snapshot()).nodes, beforeRejectedArrange.nodes);
  closePositions(await displayed(), beforeRejectedArrange.nodes.map(node => ({ nodeId: node.id, position: node.position })));
  checks.push('a rejected arrangement restores every node to the saved layout and displays the existing error');
  await selectEdge();
  await click('.condition-label', 'Implementation is ready');
  await poll(() => evaluate("document.querySelector('dialog[open]')?.textContent.includes('关联条件')"));
  checks.push('reload restores the route; keyboard nudges and condition editing work without changing node configuration, conditions or MCP identity');
  writeFileSync(join(evidence, 'ui-result.json'), JSON.stringify({ passed: true, fixture, checks, nativeModels: false }, null, 2));
  console.log(JSON.stringify({ passed: true, fixture, checks: checks.length }, null, 2));
} catch (error) { try { await browser?.screenshot('failure.png'); } catch {} throw error; }
finally { for (const gate of holds) gate.release(); writeFileSync(join(fixture, 'arrange-requests.json'), JSON.stringify(arrangeRequests, null, 2)); writeFileSync(join(fixture, 'layout-requests.json'), JSON.stringify(layoutRequests, null, 2)); await browser?.close(); bridge.closeAllConnections(); await new Promise(resolve => bridge.close(resolve)); await engine.close(); }
