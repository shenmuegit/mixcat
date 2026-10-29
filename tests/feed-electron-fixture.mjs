import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WorkflowEngine } from '../src/core/engine.ts';
import { CommandDispatcher } from '../src/core/commands.ts';
import { projectDirectory } from '../src/core/paths.ts';
import { openRendererFixture } from './human-review-electron-fixture.mjs';
export async function openFeedFixture(t, options = {}) {
  const root = resolve('.'), fixture = mkdtempSync(join(projectDirectory(root, '.runtime', 'implementation', 'feed'), 'races-'));
  const engine = new WorkflowEngine({ workbenchRoot: fixture, executable: 'unused', accountFactory: () => ({ async connect() {}, async close() {}, async rpc() { return { account: null }; } }), nativeFactory: () => ({ async connect() {}, async close() {}, async rpc() { return {}; } }), ...options });
  const releases = [], subscribers = new Set(); let browser, hold, rejectAfter;
  const unsubscribe = engine.subscribeFeed(value => { for (const response of subscribers) response.write(JSON.stringify(value)+'\n'); });
  await engine.init();
  const dispatcher = new CommandDispatcher(engine);
  const bridge = createServer((request, response) => {
    if (request.method === 'GET') { response.writeHead(200, {'Content-Type':'application/x-ndjson'}); response.write('\n'); subscribers.add(response); request.on('close',()=>subscribers.delete(response)); return; }
    let body = ''; request.on('data', data => body += data); request.on('end', () => { void (async () => {
      try {
        const envelope = JSON.parse(body), command = envelope.command; let reply, rejection;
        try { reply = await dispatcher.dispatch(envelope); } catch (error) { rejection = error; }
        if (hold?.match(command)) { const gate = hold; hold = null; gate.entered(rejection ? { error: rejection.message } : reply); await gate.promise; }
        if (rejection) throw rejection;
        if (rejectAfter?.(command)) { rejectAfter = null; throw Error('已提交但确认丢失'); }
        response.end(JSON.stringify(reply));
      } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: error.message })); }
    })(); });
  });
  bridge.listen(0, '127.0.0.1'); await once(bridge, 'listening');
  const url = `http://127.0.0.1:${bridge.address().port}`;
  writeFileSync(join(fixture, 'preload.cjs'), `const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('mixcat',{command:e=>ipcRenderer.invoke('command',e),subscribe:()=>()=>{},subscribeFeed:callback=>{const listener=(_,value)=>callback(value);ipcRenderer.on('feed',listener);return()=>ipcRenderer.removeListener('feed',listener);},setFeedUnsaved:async()=>{},setUnsaved:async()=>{},chooseDirectory:async()=>null,panel:async()=>({panels:[],activePanelId:null}),subscribePanels:()=>()=>{}});`);
  writeFileSync(join(fixture, 'main.cjs'), `const{app,BrowserWindow,ipcMain}=require('electron');const{join}=require('node:path');for(const name of ['userData','sessionData','logs','crashDumps','temp'])app.setPath(name,join(${JSON.stringify(fixture)},name));app.commandLine.appendSwitch('disk-cache-dir',join(${JSON.stringify(fixture)},'cache'));ipcMain.handle('command',(_,body)=>new Promise((resolve,reject)=>{const request=require('node:http').request(${JSON.stringify(url)},{method:'POST',agent:false},response=>{let data='';response.on('data',chunk=>data+=chunk);response.on('end',()=>{const value=JSON.parse(data);response.statusCode>=400?reject(Error(value.error)):resolve(value);});});request.on('error',reject);request.end(JSON.stringify(body));}));app.on('window-all-closed',()=>app.quit());app.whenReady().then(()=>{const win=new BrowserWindow({width:1460,height:960,show:false,webPreferences:{preload:${JSON.stringify(join(fixture,'preload.cjs'))},contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});require('node:http').get(${JSON.stringify(url)},response=>{let buffer='';response.on('data',chunk=>{buffer+=chunk;let index;while((index=buffer.indexOf('\\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(line&&!win.isDestroyed())win.webContents.send('feed',JSON.parse(line));}});}).on('error',()=>{});win.loadFile(${JSON.stringify(join(root,'dist/client/renderer/index.html'))});});`);
  t.after(async () => { for (const release of releases) release(); await browser?.close(); unsubscribe(); for (const response of subscribers) response.end(); bridge.closeAllConnections(); await new Promise(done => bridge.close(done)); await engine.close(); console.log(JSON.stringify({ test: t.name, fixture })); });
  browser = await openRendererFixture(root, fixture);
  await browser.click('.workspace-sidebar nav button', '信息流');
  return { ...browser, engine, fixture, emitFeed(value) { for (const response of subscribers) response.write(JSON.stringify(value)+'\n'); }, hold(match) { let entered, release; const arrived = new Promise((done, reject) => { const timer = setTimeout(() => reject(Error('Expected held command did not arrive')), 10000); entered = reply => { clearTimeout(timer); done(reply); }; }), promise = new Promise(done => release = done); hold = { match, entered, promise }; releases.push(release); return { arrived, release }; }, rejectCommitted(match) { rejectAfter = match; } };
}

export async function reloadFeed(f) {
  const origin = await f.evaluate('performance.timeOrigin'); await f.rpc('Page.reload');
  await f.poll(async () => { try { return await f.evaluate(`performance.timeOrigin!==${origin}&&document.readyState==='complete'&&!!document.querySelector('.workspace-sidebar nav')`); } catch (error) { if (/Execution context|Cannot find context|Inspected target navigated or closed/i.test(String(error))) return false; throw error; } });
  await f.click('.workspace-sidebar nav button', '信息流');
}
export async function createCollection(f, name) { return (await f.engine.command({ type: 'create_feed_collection', requestId: crypto.randomUUID(), name, instruction: '', input: { text: `沟通 ${name}` } })).feed.admission; }
export async function openCollection(f, name) {
  if (await f.evaluate('!!document.querySelector(".feed-collection,.feed-new")')) await f.click('.feed-collection>header button,.feed-new>button', '返回信息流');
  await f.click('.feed-card', name); await f.poll(() => f.evaluate(`document.querySelector('.feed-collection h2')?.textContent===${JSON.stringify(name)}`));
}
export async function storedForm(f, key = 'collection:new') { const value = (await f.engine.command({ type: 'read_feed_draft', key })).feed.draft; return value ? JSON.parse(value.text) : null; }
export function saveResult(f, admission, title, body = '完整结果正文') {
  return f.engine.feed.service.saveResult(crypto.randomUUID(), { title, body, coverage: 'full' }, { kind: 'agent', collectionId: admission.collectionId, runId: admission.runId, threadId: 'fixture-thread', turnId: 'fixture-turn', callId: crypto.randomUUID() });
}
