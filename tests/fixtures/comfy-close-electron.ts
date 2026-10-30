import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { ComfyHost } from '../../src/desktop/comfy-host.js';
import { ComfyRuntime } from '../../src/core/comfy-runtime.js';
import { projectDirectory } from '../../src/core/paths.js';
import type { AppSnapshot } from '../../src/shared/types.js';
import { deferred } from '../runtime-fixture.js';

const root=process.argv[2],proof=projectDirectory(root,'.runtime','comfy-close-proof');
for(const name of ['appData','userData','sessionData','temp','crashDumps'] as const)app.setPath(name,projectDirectory(proof,name));
app.setAppLogsPath(projectDirectory(proof,'logs'));
let host:ComfyHost,window:BrowserWindow;
const server=createServer((_request,response)=>response.end(`<script>window.mixcatComfy.connect('fixture-instance').then(()=>{window.mixcatComfy.listen(message=>window.mixcatComfy.reply({...message,type:'comfy_reply',result:{observation:{projectId:'close-proof',instanceId:'fixture-instance',workflowId:'workflow',tabId:'tab',revision:'revision'},workflow:{nodes:[]},subgraphPath:[],selectedNodeIds:[]}}));window.mixcatComfy.ready();});</script>`));
app.whenReady().then(async()=>{
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  // Controlled process/graph boundary; exercise the real Electron host, preload and admission guards.
  ComfyRuntime.prototype.start=async function(){await (this as any).options.beforeSpawn?.('fixture-instance');return {instanceId:'fixture-instance',origin:`http://127.0.0.1:${(server.address() as any).port}`,pid:1};};
  ComfyRuntime.prototype.stop=async()=>{};
  window=new BrowserWindow({show:false,width:1000,height:700,webPreferences:{offscreen:true,sandbox:true}});
  await window.loadURL('data:text/html,Close ownership proof');
  host=new ComfyHost(window,join(root,'dist/client/comfy'),join(root,'dist/client/desktop/comfy-preload.cjs'));
  const project={id:'close-proof',root:projectDirectory(proof,'project'),template:'comfyui'};host.observe({projects:[project],selected:{project}} as AppSnapshot);
  await host.request(project.id,{type:'read_graph'});
  const entry=(host as any).entries.get(project.id),contents=entry.view.webContents;
  const originalRead=entry.rpc.request.bind(entry.rpc),originalFlush=entry.rpc.flushGraph.bind(entry.rpc);
  const readReady=deferred(),releaseRead=deferred(),flushReady=deferred(),releaseFlush=deferred();
  entry.rpc.request=async(...args:any[])=>{const result=await originalRead(...args);readReady.resolve();await releaseRead.promise;return result;};
  entry.rpc.flushGraph=async()=>{flushReady.resolve();await releaseFlush.promise;throw Error('fixture flush failure');};
  const reading=host.request(project.id,{type:'read_graph'});await readReady.promise;
  const closing=host.close(project.id);const rejected=assert.rejects(closing,/fixture flush failure/);await flushReady.promise;
  const blocked=(name:string)=>{let prevented=false;contents.emit(name,{preventDefault(){prevented=true;}},entry.origin);return prevented;};
  const guards=['before-input-event','before-mouse-event','will-navigate','will-redirect'];
  try {
    releaseRead.resolve();await reading;
    for(const event of guards)assert.equal(blocked(event),true,`${event} stays blocked while another read completes`);
    await assert.rejects(host.request(project.id,{type:'read_graph'}),/关闭/);
  } finally {releaseRead.resolve();releaseFlush.resolve();await rejected;entry.rpc.request=originalRead;entry.rpc.flushGraph=originalFlush;}
  for(const event of guards)assert.equal(blocked(event),false,`${event} is usable after the failed flush`);
  await host.request(project.id,{type:'read_graph'});
  const originalSuspend=entry.runs.suspend.bind(entry.runs),originalClose=entry.runs.close.bind(entry.runs),drainEntered=deferred(),drainReleased=deferred();let drained=false;
  entry.runs.suspend=()=>{throw Error('fixture suspend persistence failure');};entry.runs.close=async()=>{drained=true;drainEntered.resolve();await drainReleased.promise;};
  const destroyed=new Promise<void>(done=>contents.once('destroyed',done)),failedClose=host.close(project.id).then(()=>null,error=>error);
  const didDrain=await Promise.race([drainEntered.promise.then(()=>true),failedClose.then(()=>false)]);
  try {assert.equal(didDrain&&drained,true,'suspend failure must still drain admitted work');assert(entry.service.store.listRuns());}
  finally {drainReleased.resolve();await failedClose;entry.runs.suspend=originalSuspend;entry.runs.close=originalClose;}
  assert(await failedClose instanceof Error);assert(entry.service.store.listRuns());await host.close(project.id);
  if(!contents.isDestroyed())for(const event of guards)assert.equal(blocked(event),true,`${event} stays blocked until destruction`);
  await destroyed;assert(contents.isDestroyed());await host.dispose();
  writeFileSync(join(proof,'evidence.json'),JSON.stringify({passed:true,guards,failedFlushRestored:true,suspendFailureDrained:true,failedCloseRetainedStore:true,successfulRetryDestroyed:true,actualNativeInput:false,controlledRuntime:true},null,2));server.close();window.destroy();app.exit(0);
}).catch(async error=>{console.error(error);try{await host?.dispose(true);}catch{}server.close();window?.destroy();app.exit(1);});
