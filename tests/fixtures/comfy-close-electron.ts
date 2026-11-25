import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { ComfyHost } from '../../src/desktop/comfy-host.js';
import { ComfyRuntime } from '../../src/core/comfy-runtime.js';
import { projectDirectory } from '../../src/core/paths.js';
import type { AppSnapshot } from '../../src/shared/types.js';
import { deferred } from '../runtime-fixture.js';

const root=process.argv[2],proof=process.argv[3];
for(const name of ['appData','userData','sessionData','temp','crashDumps'] as const)app.setPath(name,projectDirectory(proof,name));
app.setAppLogsPath(projectDirectory(proof,'logs'));
let host:ComfyHost,window:BrowserWindow;
const editedWorkflow = { nodes: [{ id: 1, title: 'Current edit' }] };
let committedWorkflow = { nodes: [{ id: 1, title: 'Before the edit' }] };
let starts = 0;
let failedRead: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined;
const server = createServer(async (request, response) => {
  if (request.url === '/userdata/workflows%2FFixture.json') {
    if (failedRead) {
      failedRead.entered.resolve(); await failedRead.release.promise;
      response.statusCode = 503; response.end(); return;
    }
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(committedWorkflow)); return;
  }
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(`<label data-setting-id="Comfy.Workflow.Persist">Persist workflow state</label><script>
    const graph = ${JSON.stringify(editedWorkflow)};
    const workflow = window.fixtureWorkflow = { path: 'workflows/Fixture.json', isTemporary: false, isModified: ${starts === 1}, changeTracker: { activeState: graph }, activeState: graph,
      async load() { this.activeState = await (await fetch('/userdata/workflows%2FFixture.json')).json(); this.changeTracker.activeState = this.activeState; } };
    const blank = { path: 'workflows/Blank.json', isTemporary: true, isModified: false, activeState: { nodes: [] } };
    const initial = ${starts === 1 ? 'workflow' : 'blank'};
    const store = { activeWorkflow: initial, openWorkflows: [initial], async loadWorkflows() {}, getWorkflowByPath: path => path === workflow.path ? workflow : null,
      openWorkflowsInBackground() { this.openWorkflows.push(workflow); }, async closeWorkflow(tab) { this.openWorkflows = this.openWorkflows.filter(item => item !== tab); } };
    const app = { rootGraph: { serialize: () => store.activeWorkflow.activeState }, extensionManager: { spinner: false, workflow: store },
      async loadGraphData(_graph, _clean, _view, active) { store.activeWorkflow = active; return true; } };
    window.comfyAPI = { app: { app } };
    window.mixcatComfy.connect('fixture-instance').then(() => {
      window.mixcatComfy.listen(message => window.mixcatComfy.reply({ ...message, type: 'comfy_reply', result: { observation: { projectId: 'close-proof', instanceId: 'fixture-instance', workflowId: 'workflow', tabId: store.activeWorkflow.path, revision: 'revision' }, workflow: app.rootGraph.serialize(), subgraphPath: [], selectedNodeIds: [] } }));
      window.mixcatComfy.ready();
    });
  </script>`);
});
app.whenReady().then(async()=>{
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  // Controlled process/graph boundary; exercise the real Electron host, preload and admission guards.
  const projectRoot = mkdtempSync(join(proof, 'managed-project-'));
  const preferences = join(projectDirectory(projectRoot, '.mixcat', 'comfy', 'data', 'user', 'default'), 'comfy.settings.json');
  writeFileSync(preferences, JSON.stringify({ 'Comfy.ColorPalette': 'dark' }));
  ComfyRuntime.prototype.start=async function(){
    assert.deepEqual(JSON.parse(readFileSync(preferences, 'utf8')), { 'Comfy.ColorPalette': 'dark', 'Comfy.Workflow.Persist': false });
    starts++;
    await (this as any).options.beforeSpawn?.('fixture-instance');
    return {instanceId:'fixture-instance',origin:`http://127.0.0.1:${(server.address() as any).port}`,pid:1};
  };
  ComfyRuntime.prototype.stop=async()=>{};
  window=new BrowserWindow({show:false,width:1000,height:700,webPreferences:{offscreen:true,sandbox:true}});
  await window.loadURL('data:text/html,Close ownership proof');
  host=new ComfyHost(window,join(root,'dist/client/comfy'),join(root,'dist/client/desktop/comfy-preload.cjs'));
  const project={id:'close-proof',root:projectRoot,template:'comfyui'};host.observe({projects:[project],selected:{project}} as AppSnapshot);
  await host.request(project.id,{type:'read_graph'});
  const entry=(host as any).entries.get(project.id),contents=entry.view.webContents;
  assert.equal(await contents.executeJavaScript('getComputedStyle(document.querySelector(\'[data-setting-id="Comfy.Workflow.Persist"]\')).display'), 'none');
  await assert.rejects(host.close(project.id), /工作流.*保存/);
  assert.equal(contents.isDestroyed(), false, 'modified graph remains available after close is refused');
  await contents.executeJavaScript('window.fixtureWorkflow.isModified = false');
  await assert.rejects(host.close(project.id), /工作流.*保存/);
  assert.equal(contents.isDestroyed(), false, 'a clean editor flag does not acknowledge an older disk version');
  committedWorkflow = editedWorkflow;
  const originalRead=entry.rpc.request.bind(entry.rpc);
  const readReady=deferred(),releaseRead=deferred();
  entry.rpc.request=async(...args:any[])=>{const result=await originalRead(...args);readReady.resolve();await releaseRead.promise;return result;};
  const nativeRead = failedRead = { entered: deferred(), release: deferred() };
  const reading=host.request(project.id,{type:'read_graph'});await readReady.promise;
  const closing=host.close(project.id);const rejected=assert.rejects(closing,/保存文件无法读取/);await nativeRead.entered.promise;
  const blocked=(name:string)=>{let prevented=false;contents.emit(name,{preventDefault(){prevented=true;}},entry.origin);return prevented;};
  const guards=['before-input-event','before-mouse-event','will-navigate','will-redirect'];
  try {
    releaseRead.resolve();await reading;
    for(const event of guards)assert.equal(blocked(event),true,`${event} stays blocked while another read completes`);
    await assert.rejects(host.request(project.id,{type:'read_graph'}),/关闭/);
  } finally {releaseRead.resolve();nativeRead.release.resolve();await rejected;entry.rpc.request=originalRead;failedRead=undefined;}
  for(const event of guards)assert.equal(blocked(event),false,`${event} is usable after the failed read-back`);
  await host.request(project.id,{type:'read_graph'});
  const originalSuspend=entry.runs.suspend.bind(entry.runs),originalClose=entry.runs.close.bind(entry.runs),drainEntered=deferred(),drainReleased=deferred();let drained=false;
  entry.runs.suspend=()=>{throw Error('fixture suspend persistence failure');};entry.runs.close=async()=>{drained=true;drainEntered.resolve();await drainReleased.promise;};
  const destroyed=new Promise<void>(done=>contents.once('destroyed',done)),failedClose=host.close(project.id).then(()=>null,error=>error);
  const didDrain=await Promise.race([drainEntered.promise.then(()=>true),failedClose.then(()=>false)]);
  try {assert.equal(didDrain&&drained,true,'suspend failure must still drain admitted work');assert(entry.service.store.listRuns());}
  finally {drainReleased.resolve();await failedClose;entry.runs.suspend=originalSuspend;entry.runs.close=originalClose;}
  assert(await failedClose instanceof Error);assert(entry.service.store.listRuns());await host.close(project.id);
  if(!contents.isDestroyed())for(const event of guards)assert.equal(blocked(event),true,`${event} stays blocked until destruction`);
  await destroyed;assert(contents.isDestroyed());
  const reopened = await host.request(project.id, { type: 'read_graph' });
  assert('observation' in reopened && 'workflow' in reopened);
  assert.equal(reopened.observation.tabId, 'workflows/Fixture.json');
  assert.deepEqual(reopened.workflow, committedWorkflow);
  await host.dispose();
  writeFileSync(join(proof,'evidence.json'),JSON.stringify({passed:true,guards,persistPreferenceHidden:true,failedReadRestored:true,staleDiskRejected:true,suspendFailureDrained:true,failedCloseRetainedStore:true,successfulRetryDestroyed:true,committedFileReopened:true,actualNativeInput:false,controlledRuntime:true},null,2));server.close();window.destroy();app.exit(0);
}).catch(async error=>{console.error(error);try{await host?.dispose(true);}catch{}server.close();window?.destroy();app.exit(1);});
