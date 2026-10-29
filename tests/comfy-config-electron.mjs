import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WorkflowEngine } from '../src/core/engine.ts';
import { projectDirectory } from '../src/core/paths.ts';
import { openRendererFixture } from './human-review-electron-fixture.mjs';

const root = resolve('.'), fixture = mkdtempSync(join(projectDirectory(root, '.runtime', 'comfy-config-proof'), 'render-'));
const engine = new WorkflowEngine({ workbenchRoot: fixture, executable: 'unused', nativeFactory() { assert.fail('Configuration does not start native tasks'); } });
await engine.init();
const ordinary = (await engine.command({ type: 'create_project', root: projectDirectory(fixture, 'ordinary'), name: 'Ordinary config' })).snapshot.selected.project;
const comfy = (await engine.command({ type: 'create_project', root: projectDirectory(fixture, 'comfy'), name: 'Comfy config', template: 'comfyui' })).snapshot.selected.project;
const node = (await engine.command({ type: 'snapshot', projectId: comfy.id })).snapshot.selected.nodes[0];
await engine.command({ type: 'save_node', projectId: comfy.id, node: { ...node, model: 'fixture-model' } });
const bridge = createServer((req, res) => {
  let raw = ''; req.on('data', chunk => { raw += chunk; }); req.on('end', () => { void (async () => {
    try { const { command } = JSON.parse(raw); const reply = command.type === 'catalog' ? { ...(await engine.command({ type: 'snapshot' })), catalog: { models: [{ id: 'fixture-model', name: 'Fixture model' }], skills: [], plugins: [], errors: [] } } : await engine.command(command); res.end(JSON.stringify(reply)); }
    catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: error.message })); }
  })(); });
});
bridge.listen(0, '127.0.0.1'); await once(bridge, 'listening');
const bridgeUrl = `http://127.0.0.1:${bridge.address().port}`, preload = join(fixture, 'preload.cjs');
writeFileSync(preload, `const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('mixcat',{command:e=>ipcRenderer.invoke('command',e),subscribe:()=>()=>{},chooseDirectory:async()=>null,chooseAttachments:async()=>[],setUnsaved:async()=>{},panel:async()=>({panels:[],activePanelId:null}),subscribePanels:()=>()=>{}});`);
writeFileSync(join(fixture, 'main.cjs'), `const{app,BrowserWindow,ipcMain}=require('electron');const{join}=require('node:path');for(const name of ['userData','sessionData','logs','crashDumps','temp'])app.setPath(name,join(${JSON.stringify(fixture)},name));app.commandLine.appendSwitch('disk-cache-dir',join(${JSON.stringify(fixture)},'cache'));ipcMain.handle('command',async(_,body)=>{const response=await fetch(${JSON.stringify(bridgeUrl)},{method:'POST',body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw Error(result.error);return result;});app.on('window-all-closed',()=>app.quit());app.whenReady().then(()=>{const win=new BrowserWindow({width:1550,height:1050,show:false,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});win.loadFile(${JSON.stringify(join(root,'dist/client/renderer/index.html'))});});`);
let browser;
try {
  browser = await openRendererFixture(root, fixture);
  const { click, evaluate, poll, screenshot } = browser;
  await poll(() => evaluate("!!document.querySelector('.workspace-sidebar')"));
  await click('nav[aria-label=工作空间] button', '项目'); await click('.sidebar-project-list button', 'Ordinary config'); await click('#tab-config');
  assert.equal(await evaluate("!!document.querySelector('input[aria-label=get_comfy_workflow]')"), false);
  await click('.sidebar-project-list button', 'Comfy config'); await click('#tab-config');
  assert.equal(await evaluate("document.querySelectorAll('.node-config input[aria-label*=comfy]').length"), 7);
  await click('.node-config input[aria-label=apply_comfy_workflow]');
  await poll(async () => !(await engine.command({ type: 'snapshot', projectId: comfy.id })).snapshot.selected.nodes[0].tools.includes('apply_comfy_workflow'));
  await screenshot('comfy-grants.png');
  console.log(JSON.stringify({ passed: true, ordinaryHidden: true, comfyTools: 7, savedRevocation: true, proof: fixture }));
} finally { await browser?.close(); await engine.close(); await new Promise(done => bridge.close(done)); }
