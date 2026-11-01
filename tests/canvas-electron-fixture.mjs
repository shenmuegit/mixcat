import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WorkflowEngine } from '../src/core/engine.ts';
import { CommandDispatcher } from '../src/core/commands.ts';
import { CanvasStore } from '../src/core/canvases.ts';
import { insideProject, projectDirectory } from '../src/core/paths.ts';
import { openRendererFixture } from './human-review-electron-fixture.mjs';

export async function openCanvasFixture(t, directory) {
  const root = resolve('.'), fixture = directory ? insideProject(root, directory) : mkdtempSync(join(projectDirectory(root, '.runtime', 'issue-180'), 'renderer-'));
  const store = new CanvasStore(fixture);
  const engine = new WorkflowEngine({ workbenchRoot: fixture, executable: 'unused', accountFactory: () => ({ async connect() {}, async close() {}, async rpc() { return { account: null }; } }) });
  await engine.init(); const dispatcher = new CommandDispatcher(engine);
  let browser, closed = false, dirty = false, hold, rejectSave = false;
  const bridge = createServer((request, response) => {
    let body = ''; request.on('data', chunk => body += chunk);
    request.on('end', () => { void (async () => {
      try {
        const input = JSON.parse(body);
        const reply = request.url === '/canvases' ? store.command(input) : request.url === '/dirty' ? (dirty = input, {}) : await dispatcher.dispatch(input);
        if (request.url === '/canvases' && input.operation === 'save') {
          if (hold) { const gate = hold; hold = null; gate.entered(); await gate.wait; }
          if (rejectSave) { rejectSave = false; throw Error('测试：保存确认丢失'); }
        }
        response.end(JSON.stringify(reply));
      } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: error.message })); }
    })(); });
  });
  bridge.listen(0, '127.0.0.1'); await once(bridge, 'listening'); const url = `http://127.0.0.1:${bridge.address().port}`;
  writeFileSync(join(fixture, 'preload.cjs'), `const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('mixcat',{canvases:value=>ipcRenderer.invoke('canvases',value),command:value=>ipcRenderer.invoke('command',value),setUnsaved:(_,dirty)=>ipcRenderer.invoke('dirty',dirty),subscribe:()=>()=>{},subscribeFeed:()=>()=>{},setFeedUnsaved:async()=>{},chooseDirectory:async()=>null,panel:async()=>({panels:[],activePanelId:null}),subscribePanels:()=>()=>{},openExternal:async()=>{}});`);
  writeFileSync(join(fixture, 'main.cjs'), `const{app,BrowserWindow,ipcMain}=require('electron');const{join,basename}=require('node:path');const{mkdirSync}=require('node:fs');for(const name of ['userData','sessionData','logs','crashDumps','temp'])app.setPath(name,join(${JSON.stringify(fixture)},name));app.commandLine.appendSwitch('disk-cache-dir',join(${JSON.stringify(fixture)},'cache'));for(const channel of ['command','canvases','dirty'])ipcMain.handle(channel,(_,body)=>new Promise((resolve,reject)=>{const req=require('node:http').request(${JSON.stringify(url)}+'/'+channel,{method:'POST',agent:false},res=>{let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>{const result=JSON.parse(text);res.statusCode>=400?reject(Error(result.error)):resolve(result);});});req.on('error',reject);req.end(JSON.stringify(body));}));app.on('window-all-closed',()=>app.quit());app.whenReady().then(()=>{const win=new BrowserWindow({width:1460,height:960,show:false,webPreferences:{preload:${JSON.stringify(join(fixture, 'preload.cjs'))},contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});win.webContents.session.on('will-download',(_,item)=>{const dir=join(${JSON.stringify(fixture)},'exports');mkdirSync(dir,{recursive:true});const file=join(dir,require('node:crypto').randomUUID()+'-'+basename(item.getFilename()));item.setSavePath(file);item.once('done',(_,state)=>{if(state==='completed')require('node:fs').writeFileSync(file+'.done','complete');});});win.loadFile(${JSON.stringify(join(root, 'dist/client/renderer/index.html'))});});`);
  async function close() {
    if (closed) return; closed = true; hold?.release();
    await browser?.close(); bridge.closeAllConnections(); await new Promise(done => bridge.close(done));
    store.close(); await engine.close();
  }
  t.after(close);
  browser = await openRendererFixture(root, fixture);
  return { ...browser, fixture, store, close, dirty: () => dirty,
    rejectCommittedSave() { rejectSave = true; },
    holdSave() { let entered, release; const arrived = new Promise(done => entered = done), wait = new Promise(done => release = done); hold = { entered, wait, release }; return { arrived, release }; },
  };
}
