import assert from 'node:assert/strict';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import electron from 'electron';
import { createServer as httpServer } from 'node:http';

const root = resolve('.');
function safe(path) {
  const absolute = resolve(path), part = relative(root, absolute);
  assert.ok(part && !part.startsWith('..') && !isAbsolute(part) && !/^c:/i.test(absolute));
  for (let p = absolute;; p = dirname(p)) { assert.ok(!existsSync(p) || !lstatSync(p).isSymbolicLink(), `Linked path: ${p}`); if (dirname(p) === p) break; }
  return absolute;
}
const evidence = safe(join(root, '.runtime/implementation')); mkdirSync(evidence, { recursive: true });
const fixture = mkdtempSync(safe(join(evidence, 'electron-')));
cpSync(join(root, 'dist/client'), safe(join(fixture, 'dist/client')), { recursive: true });
const project = safe(join(fixture, 'project')); mkdirSync(project);
for (const name of ['tmp', 'appdata', 'localappdata', 'home', 'cache']) mkdirSync(safe(join(fixture, name)));
const env = { ...process.env, MIXCAT_CODEX: process.execPath, MIXCAT_ROOT: fixture, TEMP: join(fixture, 'tmp'), TMP: join(fixture, 'tmp'), APPDATA: join(fixture, 'appdata'), LOCALAPPDATA: join(fixture, 'localappdata'), HOME: join(fixture, 'home'), XDG_CACHE_HOME: join(fixture, 'cache') };
delete env.ELECTRON_RUN_AS_NODE;
let child, socket, hostSocket, debugPort, nextId = 0;
const pending = new Map();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function poll(fn) { for (let i = 0; i < 120; i++) { const value = await fn(); if (value) return value; await delay(100); } throw Error('Timed out waiting for desktop state'); }
async function launch() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port; await new Promise(resolve => server.close(resolve));
  debugPort = port;
  const inspector = createServer(); inspector.listen(0, '127.0.0.1'); await once(inspector, 'listening'); const inspectPort=inspector.address().port; await new Promise(resolve=>inspector.close(resolve));
  child = spawn(electron, [`--inspect=${inspectPort}`, join(fixture, 'dist/client/desktop/main.cjs'), `--workbench-root=${fixture}`, `--remote-debugging-port=${port}`], { cwd: fixture, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', data => { log += data; }); child.stderr.on('data', data => { log += data; });
  child.once('exit', () => writeFileSync(safe(join(fixture, `electron-${port}.log`)), log));
  const page = await poll(async () => { try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(p => p.type === 'page'); } catch { return null; } });
  socket = new WebSocket(page.webSocketDebuggerUrl); await once(socket, 'open');
  socket.addEventListener('message', event => { const result = JSON.parse(String(event.data)), entry = pending.get(result.id); if (entry) { pending.delete(result.id); result.error ? entry.reject(Error(JSON.stringify(result.error))) : entry.resolve(result.result); } });
  const hostPage = await poll(async()=>{try{return (await(await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json())[0];}catch{return null;}});
  hostSocket = new WebSocket(hostPage.webSocketDebuggerUrl); await once(hostSocket,'open');
  hostSocket.addEventListener('message',event=>{const result=JSON.parse(String(event.data)),entry=pending.get(result.id);if(entry){pending.delete(result.id);result.error?entry.reject(Error(JSON.stringify(result.error))):entry.resolve(result.result);}});
  await poll(() => evaluate("document.querySelector('.page-heading h1')?.textContent"));
}
async function rpc(method, params = {}, target = socket) {
  const id = ++nextId;
  return await new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 10000); pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } }); target.send(JSON.stringify({ id, method, params })); });
}
async function host(expression) {const result=await rpc('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},hostSocket);if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value;}
async function evaluate(expression) { const result = await rpc('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value; }
async function click(selector, text) {
  const point = await poll(() => evaluate(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => ${text ? `e.textContent.includes(${JSON.stringify(text)})` : 'true'}); if (!e) return null; e.scrollIntoView({block:'nearest',inline:'nearest'}); const r=e.getBoundingClientRect(); const x=r.x+r.width/2,y=r.y+r.height/2; if (!(e.closest('.react-flow__edge') ?? e).contains(document.elementFromPoint(x,y))) return null; return {x,y}; })()`));
  await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 }); await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
}
async function fill(selector, value) { await evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); const prototype=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype,'value').set.call(e,${JSON.stringify(value)}); e.dispatchEvent(new Event('input',{bubbles:true})); })()`); }
async function screenshot(name) { await delay(300); const image = await rpc('Page.captureScreenshot', { format: 'png' }); writeFileSync(safe(join(evidence, name)), Buffer.from(image.data, 'base64')); }
async function close() {
  try { await host('__testRequire("electron").app.quit()'); } catch {}
  try { if (socket?.readyState === 1) await rpc('Browser.close'); } catch {}
  socket?.close();
  hostSocket?.close();
  if (child && child.exitCode === null) { await Promise.race([once(child, 'exit'), delay(5000)]); if (child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); }
  for (const entry of pending.values()) entry.reject(Error('Desktop closed')); pending.clear();
}

// The isolated copy exposes host objects only to its local test inspector.
const main=join(fixture,'dist/client/desktop/main.cjs');
writeFileSync(main,readFileSync(main,'utf8')+'\nglobalThis.__testPanels=()=>panels; globalThis.__testWindow=()=>window; globalThis.__testRequire=require;\n');
const server=httpServer((req,res)=>{
  if(req.url==='/slow'){setTimeout(()=>{res.setHeader('Content-Type','text/html');res.end('<h1>Late page A</h1>');},700);return;}
  if(req.url==='/download'){res.setHeader('Content-Disposition','attachment; filename="panel.txt"');res.end('project download');return;}
  res.setHeader('Content-Type','text/html');res.end(`<!doctype html><title>${req.url==='/next'?'Next page':'Panel fixture'}</title><body style="margin:20px;background:#def2e3;color:#174b29;font:18px sans-serif"><h1>${req.url==='/next'?'Next page':'Native web panel'}</h1><a id="next" href="/next">Navigate</a><button id="popup" onclick="window.open('/popup')">Popup</button><a href="/download">Download</a><p id="isolation"></p><script>document.querySelector('#isolation').textContent='require='+typeof require+', mixcat='+typeof window.mixcat;</script>`);
});
server.listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${server.address().port}`;
writeFileSync(safe(join(project,'readme.txt')),'Task 7 project text\n<not HTML>');
writeFileSync(safe(join(project,'app-server')),`import{createInterface}from'node:readline';createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;const result=m.method==='initialize'?{userAgent:'panel-fixture'}:m.method==='model/list'||m.method==='skills/list'?{data:[],nextCursor:null}:m.method==='plugin/installed'?{marketplaces:[]}:m.method==='account/read'?{account:{email:'fixture'}}:{};process.stdout.write(JSON.stringify({id:m.id,result})+'\\n')});`);
writeFileSync(safe(join(project,'design.html')),'<!doctype html><title>Project HTML</title><body style="background:#e8d9fa;font:20px sans-serif"><h1>Project HTML design</h1><img src="image.svg">');
writeFileSync(safe(join(project,'image.svg')),'<svg xmlns="http://www.w3.org/2000/svg" width="220" height="120"><rect width="220" height="120" fill="#b3e0ee"/><text x="10" y="65" font-size="24">Project image</text></svg>');
const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>','<< /Length 48 >>\nstream\nBT /F1 20 Tf 20 140 Td (Project PDF preview) Tj ET\nendstream'];
let pdf='%PDF-1.4\n',offsets=[0];objects.forEach((body,index)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${index+1} 0 obj\n${body}\nendobj\n`;});const xref=Buffer.byteLength(pdf);pdf+='xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(offset=>String(offset).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
writeFileSync(safe(join(project,'document.pdf')),pdf);
const visible=()=>host(`[...__testPanels().entries.values()].filter(e=>e.view.getVisible()).map(e=>({id:e.panel.id,nodeId:e.panel.nodeId,url:e.view.webContents.getURL(),bounds:e.view.getBounds()}))`);
const panelCall=command=>evaluate(`window.mixcat.panel(${JSON.stringify(command)})`);
async function guest(panelId,expression){return host(`__testPanels().entries.get(${JSON.stringify(panelId)}).view.webContents.executeJavaScript(${JSON.stringify(expression)})`);}
async function guestClick(panelId,selector){const point=await guest(panelId,`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();if(!e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)))throw Error('Guest hit target covered');return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);await host(`(()=>{const w=__testPanels().entries.get(${JSON.stringify(panelId)}).view.webContents;w.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...${JSON.stringify(point)}});w.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...${JSON.stringify(point)}})})()`);}
async function capture(panelId,name){const data=await poll(async()=>{try{return await host(`__testPanels().entries.get(${JSON.stringify(panelId)}).view.webContents.capturePage().then(image=>image.toPNG().toString('base64'))`);}catch{return null;}});writeFileSync(safe(join(evidence,name)),Buffer.from(data,'base64'));}
try {
  await launch(); await click('button','新建项目');await poll(()=>evaluate("!!document.querySelector('dialog[open]')"));
  await fill('dialog input','节点面板验收');await fill('dialog .input-with-button input',project);await fill('dialog textarea','项目内网页与文件');await click('dialog .modal-actions button','创建项目');await poll(()=>evaluate("!!document.querySelector('#tab-panels')"));
  const projectId=await evaluate("window.mixcat.command({id:crypto.randomUUID(),command:{type:'snapshot'}}).then(r=>r.snapshot.selected.project.id)");
  await click('#tab-panels');await fill('input[aria-label="网页地址"]',url);await click('.browser-address button','打开');
  const browser=await poll(async()=>{const views=await visible();return views.find(view=>view.url===url+'/');});
  assert.deepEqual(await guest(browser.id,"({require:typeof require,api:typeof window.mixcat})"),{require:'undefined',api:'undefined'});
  if(process.argv.includes('--delete-only')){
    const generation=await host('__testPanels().presentation.generation');
    await click('.node-controls button','删除节点');await poll(()=>evaluate("!!document.querySelector('dialog[open]')"));await poll(async()=>(await visible()).length===0);
    await click('dialog .modal-actions button','确认删除');
    await poll(()=>evaluate("!document.querySelector('.react-flow__node[data-id=\"plan\"]')"));
    assert.equal(await host(`[...__testPanels().entries.values()].some(e=>e.panel.nodeId==='plan')`),false,'removed node must close its native views');
    await assert.rejects(panelCall({type:'layout',projectId,nodeId:'plan',generation,bounds:{x:0,y:0,width:300,height:300}}),/节点|project|node/);
    const stored=await evaluate("window.mixcat.command({id:crypto.randomUUID(),command:{type:'snapshot'}}).then(r=>r.snapshot.selected)");
    assert.equal(stored.nodes.length,2);assert.equal(stored.archivedNodes[0].id,'plan');
    assert.equal((await visible()).length,0);
    await screenshot('settings-delete-native-panel.png');
    writeFileSync(safe(join(evidence,'settings-delete-native-panel-result.json')),JSON.stringify({passed:true,fixture,project,checks:['actual delete confirmation hides native view','actual worker persists node archive','removed node native WebContentsView closed','late layout for deleted node rejected'],nativeLogin:false,nativeModels:false},null,2));
    console.log('PASS Settings/delete real worker and native panel cleanup');
  }else if(process.argv.includes('--attachments-only')){
    await host("__testRequire('electron').dialog.showOpenDialog=()=>new Promise((resolve,reject)=>{globalThis.__dialogResolve=resolve;globalThis.__dialogReject=reject;globalThis.__dialogPending=true})");
    async function begin(){await click('.composer-bottom button','添加附件');await poll(()=>host('globalThis.__dialogPending===true'));await poll(()=>evaluate("document.querySelector('.composer-bottom button').textContent==='添加中…'"));await poll(async()=>(await visible()).length===0);}
    async function end(error=false){await host(error?"globalThis.__dialogPending=false;globalThis.__dialogReject(new Error('fixture chooser failure'))":"globalThis.__dialogPending=false;globalThis.__dialogResolve({canceled:true,filePaths:[]})");await poll(()=>evaluate("document.querySelector('.composer-bottom button').textContent.includes('添加附件')"));}
    await begin();await end();await poll(async()=>(await visible())[0]?.id===browser.id);
    await begin();await end(true);await poll(async()=>(await visible())[0]?.id===browser.id);await click('button[aria-label="关闭错误提示"]');
    const generationA=await host('__testPanels().presentation.generation');
    const other=await panelCall({type:'open',projectId,nodeId:'implement',target:{type:'url',url:url+'/next'}});
    const otherId=other.activePanelId;
    await begin();await click('.react-flow__node[data-id="implement"] h3');await poll(()=>evaluate("document.querySelector('.detail-heading h2').textContent==='执行'"));await end();await poll(async()=>(await visible())[0]?.id===otherId);
    await panelCall({type:'layout',projectId,nodeId:'plan',generation:generationA,bounds:{x:0,y:0,width:300,height:300}});assert.equal((await visible())[0].id,otherId);
    await begin();await click('button[aria-label="返回项目列表"]');await poll(()=>evaluate("!!document.querySelector('.project-card')"));await host("globalThis.__dialogPending=false;globalThis.__dialogResolve({canceled:true,filePaths:[]})");await delay(150);assert.equal((await visible()).length,0,'old chooser completion cannot revive a view after leaving the project');
    writeFileSync(safe(join(evidence,'task-7-fix1-attachments-result.json')),JSON.stringify({passed:true,fixture,project,checks:['cancel restores current browser view','chooser rejection restores current browser view','chooser pending hides native view','node switch restores only current binding','old binding layout cannot revive prior node','unmounted project chooser completion cannot revive native view'],nativeDialog:'fixture cancellation/rejection; actual Electron host/renderer lifecycle',nativeModels:false},null,2));
    console.log('PASS Task7 attachment cancel/error/current-binding Electron checks');
  }else{
  await capture(browser.id,'task-7-web.png');
  await guestClick(browser.id,'#next');await poll(async()=>(await visible())[0]?.url.endsWith('/next'));
  await poll(()=>evaluate("!document.querySelector('button[aria-label=\"后退\"]').disabled"));await click('button[aria-label="后退"]');await poll(async()=>(await visible())[0]?.url===url+'/');
  await guestClick(browser.id,'#popup');await poll(async()=>(await visible())[0]?.url.endsWith('/popup'));
  assert.equal(await host('__testWindow().constructor.getAllWindows().length'),1);
  const beforeDownload=new Set(await host(`__testRequire('node:fs').existsSync(${JSON.stringify(join(project,'.mixcat/downloads'))})?__testRequire('node:fs').readdirSync(${JSON.stringify(join(project,'.mixcat/downloads'))}):[]`));
  await guestClick(browser.id,'a[href="/download"]');await poll(()=>host(`__testRequire('node:fs').existsSync(${JSON.stringify(join(project,'.mixcat/downloads'))})&&__testRequire('node:fs').readdirSync(${JSON.stringify(join(project,'.mixcat/downloads'))}).length>${beforeDownload.size}`));
  // Open real Workbench overlays and verify the native child is hidden and controls receive hits.
  await click('button','＋ 添加节点');await poll(()=>evaluate("!!document.querySelector('dialog[open]')"));await poll(async()=>(await visible()).length===0);await screenshot('task-7-overlay.png');await click('dialog button[aria-label="关闭弹窗"]');await poll(async()=>(await visible()).length===1);
  const point=await evaluate("(()=>{const r=document.querySelector('.flow-wrap').getBoundingClientRect();return{x:r.x+30,y:r.y+30};})()");await rpc('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'right',clickCount:1});await rpc('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'right',clickCount:1});await poll(()=>evaluate("!!document.querySelector('[role=menu]')"));await poll(async()=>(await visible()).length===0);await click('[role=menuitem]','新增节点');await click('dialog button[aria-label="关闭弹窗"]');await poll(async()=>(await visible()).length===1);
  const generationA=await host('__testPanels().presentation.generation');
  const slow=await panelCall({type:'open',projectId,nodeId:'plan',target:{type:'url',url:url+'/slow'}});
  await click('.react-flow__node[data-id="implement"] h3');await poll(()=>evaluate("document.querySelector('.detail-heading h2').textContent==='执行'"));await poll(async()=>(await visible()).length===0);
  const generationB=await host('__testPanels().presentation.generation');assert(generationB>generationA);
  await panelCall({type:'layout',projectId,nodeId:'plan',generation:generationA,bounds:{x:0,y:0,width:300,height:300}});await delay(850);assert.equal((await visible()).length,0,'late A load/layout cannot show A over B');
  await fill('input[aria-label="网页地址"]',url+'/next');await click('.browser-address button','打开');await poll(async()=>(await visible())[0]?.nodeId==='implement');
  const staleList=await panelCall({type:'list',projectId,nodeId:'implement'});
  await panelCall({type:'layout',projectId,nodeId:'plan',generation:generationA,bounds:null});assert.equal((await visible())[0].nodeId,'implement','late A hide cannot hide B');
  const previews=[];
  await host('__testWindow().setSize(1600,1200)');await delay(250);
  for(const name of ['readme.txt','image.svg','design.html','document.pdf']){
    await fill('input[aria-label="项目文件路径"]',name);await click('.browser-address button','预览文件');
    const preview=await poll(async()=>{const views=await visible();return views.find(view=>view.url.startsWith('mixcat-preview:')&&view.url.endsWith(encodeURIComponent(name)));});
    await poll(()=>host(`!__testPanels().entries.get(${JSON.stringify(preview.id)}).panel.loading`));
    assert.equal(await host(`__testPanels().entries.get(${JSON.stringify(preview.id)}).panel.error??null`),null);
    if(name==='readme.txt')assert.match(await guest(preview.id,'document.body.textContent'),/Task 7 project text/);
    if(name==='design.html'){assert.match(await guest(preview.id,'document.body.textContent'),/Project HTML design/);assert.equal(await guest(preview.id,'document.images[0].complete&&document.images[0].naturalWidth>0'),true);}
    if(name==='document.pdf')await poll(()=>host(`__testPanels().entries.get(${JSON.stringify(preview.id)}).view.webContents.capturePage().then(image=>{const b=image.toBitmap();let white=0;for(let i=0;i<b.length;i+=4)if(b[i]>240&&b[i+1]>240&&b[i+2]>240)white++;return white/(b.length/4)>.2})`));
    await capture(preview.id,`task-7-${name.replace('.','-')}.png`);previews.push(name);
  }
  const isolated=await host(`[...__testPanels().entries.values()].every(e=>e.view.webContents.getLastWebPreferences().nodeIntegration===false&&!e.view.webContents.getLastWebPreferences().preload)`);assert(isolated);
  await host(`__testWindow().webContents.send('mixcat:panels',${JSON.stringify(staleList)})`);await delay(150);assert.match(await evaluate("document.querySelector('.panel-tabs>div.active').textContent"),/document.pdf/,'late list snapshot cannot overwrite a newer active file panel');
  const bounds=(await visible())[0].bounds,rect=await evaluate("(()=>{const r=document.querySelector('.native-panel-viewport').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()");for(const key of ['x','y','width','height'])assert(Math.abs(bounds[key]-rect[key])<=1);
  const frameDenied=await guest(browser.id,`(async()=>{try{const p=window.parent;return typeof p.mixcat}catch{return 'blocked'}})()`);assert.equal(frameDenied,'undefined');
  await rpc('Page.reload');await poll(()=>evaluate("!!document.querySelector('.project-card')"));await click('.project-card');await poll(()=>evaluate("!!document.querySelector('#tab-panels')"));await click('#tab-panels');await poll(async()=>(await visible())[0]?.nodeId==='plan');
  await click('.react-flow__node[data-id="implement"] h3');await poll(async()=>(await visible())[0]?.nodeId==='implement');
  const oldGeneration=await host('__testPanels().presentation.generation');
  await click('button[aria-label="返回项目列表"]');await poll(async()=>(await visible()).length===0);
  const other=safe(join(fixture,'other-project'));mkdirSync(other);
  await click('button','新建项目');await fill('dialog input','另一个项目');await fill('dialog .input-with-button input',other);await fill('dialog textarea','隔离旧面板');await click('dialog .modal-actions button','创建项目');await poll(()=>evaluate("document.querySelector('.project-heading h1')?.textContent==='另一个项目'"));
  await panelCall({type:'bind',projectId,nodeId:'implement'});await panelCall({type:'layout',projectId,nodeId:'implement',generation:oldGeneration,bounds:{x:0,y:0,width:300,height:300}});assert.equal((await visible()).length,0,'late old project bind/layout cannot revive old native view');
  writeFileSync(safe(join(evidence,'task-7-electron-result.json')),JSON.stringify({passed:true,fixture,project,version:await host('process.versions'),bounds,rect,previews,checks:['real WebContentsView navigation/back/popup','no Node or main IPC in pages','project download directory','real modal/menu hides native view and hit targets work','node switch late load/layout/hide fences','late list cannot overwrite newer panel snapshot','renderer reload uses fresh host generation and restores correct node','old project bind/layout cannot revive view','project text/SVG/HTML with sibling asset/PDF pixels','view bounds match actual viewport'],nativeModels:false},null,2));
  console.log('PASS Task7 real Electron panel host and renderer checks');
  }
} catch(error) {try{await screenshot('task-7-failure.png');console.log('visible',await visible());console.log('panels',await host('[...__testPanels().entries.values()].map(e=>({panel:e.panel,history:e.view.webContents.navigationHistory.getAllEntries()}))'));}catch{}throw error;}
finally {await close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
