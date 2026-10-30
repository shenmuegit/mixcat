import { app, BrowserWindow, dialog, safeStorage, utilityProcess, type WebContents, type UtilityProcess, type WebContentsView } from 'electron';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createServer as createPortBlocker } from 'node:net';
import type { GraphView, RunView } from '../../src/shared/comfy.js';
import { projectDirectory } from '../../src/core/paths.js';

const quitPhase = process.argv.includes('--quit'), feedbackPhase = process.argv.includes('--feedback'), mediaPhase = process.argv.includes('--media') || quitPhase || feedbackPhase;
const fixture = process.argv[2], project = projectDirectory(fixture, 'project'), proof = join(fixture, quitPhase ? 'evidence-quit.json' : feedbackPhase ? 'evidence-feedback.json' : mediaPhase ? 'evidence-media.json' : 'evidence.json');
const checks: string[] = [], check = (label: string) => { checks.push(label); console.log(label); writeFileSync(proof, JSON.stringify({ checks }, null, 2)); };
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(read: () => T | Promise<T>, label: string, timeout = 45000): Promise<Exclude<T, false | null | undefined>> { const end = Date.now() + timeout; while (Date.now() < end) { const value = await read(); if (value) return value as Exclude<T, false | null | undefined>; await delay(50); } throw Error(`Timed out: ${label}`); }
let win: BrowserWindow, core: UtilityProcess | undefined, quitting = false, decryptHeld = false, decryptReached = false, releaseDecrypt: (() => void) | undefined;
const forks = utilityProcess.fork.bind(utilityProcess);
(utilityProcess as any).fork = (...args: Parameters<typeof forks>) => { const child = forks(...args); if (String(args[0]).endsWith('worker.cjs')) core = child; return child; };
const originalDecrypt = safeStorage.decryptStringAsync.bind(safeStorage);
(safeStorage as any).decryptStringAsync = async (value: Buffer) => { if (decryptHeld) { decryptReached = true; await new Promise<void>(done => { releaseDecrypt = done; }); } return originalDecrypt(value); };
let quitDecision: ((value: { response: number; checkboxChecked: boolean }) => void) | undefined, warnings: string[] = [];
let shutdownDecision: ((value: { response: number; checkboxChecked: boolean }) => void) | undefined;
(dialog as any).showMessageBox = async (...args: any[]) => {
  const options = args.at(-1);
  if (options.title === '有未保存的草稿') return new Promise(resolve => { quitDecision = resolve; });
  if (options.title === '后台关闭尚未完成') return new Promise(resolve => { warnings.push(options.message); shutdownDecision = resolve; });
  warnings.push(options.message); return { response: 0, checkboxChecked: false };
};
let videoBytes: Buffer, videoHeld = false, textCreates = 0, videoCreates = 0;
const key = 'FAKE_Task8_WORKSPACE_PRIVATE_KEY';
const vendor = createServer(async (req, res) => {
  if (req.url === '/fixture.mp4') { res.end(videoBytes); return; }
  assert.equal(req.headers.authorization, `Bearer ${key}`);
  if (req.method === 'GET') { res.end(JSON.stringify(videoHeld ? { status: 'running' } : { status: 'succeeded', content: { video_url: vendorOrigin + '/fixture.mp4' } })); return; }
  for await (const _chunk of req) {}
  if (req.url?.endsWith('/contents/generations/tasks')) { videoCreates++; res.end(JSON.stringify({ id: `task8-video-${videoCreates}` })); return; }
  textCreates++; res.end(JSON.stringify({ choices: [{ message: { content: 'controlled native workspace result' } }] }));
});
let vendorOrigin = '';
const native = String.raw`
import { createInterface } from 'node:readline';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
writeFileSync(join(process.env.CODEX_HOME,'auth.json'),JSON.stringify({tokens:{access_token:'fixture-access',account_id:'fixture-account',refresh_token:'fixture-refresh'}}));
let sequence=0;const session=randomUUID();const write=value=>process.stdout.write(JSON.stringify(value)+'\n');
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;appendFileSync('native-calls.jsonl',JSON.stringify(m)+'\n');let result={};
if(m.method==='initialize')result={userAgent:'task8-fixture',codexHome:process.env.CODEX_HOME};
if(m.method==='account/read')result={account:{email:'workspace@example.invalid'}};
if(m.method==='model/list')result={data:[{model:'fixture-model',displayName:'Fixture model'}],nextCursor:null};
if(m.method==='windowsSandbox/readiness')result={status:'configured'};
if(m.method==='thread/start')result={thread:{id:session+'-'+(++sequence)}};
if(m.method==='thread/resume')result={thread:{id:m.params.threadId}};
if(m.method==='thread/items/list')result={data:[],nextCursor:null};
if(m.method==='turn/start'){const id=session+'-turn-'+(++sequence);write({id:m.id,result:{turn:{id}}});setTimeout(()=>write({method:'turn/completed',params:{threadId:m.params.threadId,turn:{id,status:'completed',items:[{id:id+'-reply',type:'agentMessage',text:'Controlled assistant reply'}]}}}),100);return;}
write({id:m.id,result});});`;
writeFileSync(join(fixture, 'app-server'), native); writeFileSync(join(project, 'app-server'), native);
const evaluate = (code: string) => win.webContents.executeJavaScript(code).catch(error => { console.error('main expression failed:', code); throw error; });
const command = (command: object) => evaluate(`window.mixcat.command({id:crypto.randomUUID(),command:${JSON.stringify(command)}})`);
let projectId: string;
const comfy = (value: object) => evaluate(`window.mixcat.comfyWorkspace(${JSON.stringify({ ...value, projectId })})`);
const view = () => win.contentView.children.find(child => 'webContents' in child && (child as WebContentsView).webContents.getURL().startsWith('http://127.0.0.1:')) as WebContentsView | undefined;
const guest = (code: string) => { const contents = view()?.webContents; if (!contents) throw Error('Missing native guest'); return contents.executeJavaScript(code).catch(error => { console.error('native expression failed:', code); throw error; }); };
async function click(selector: string, text?: string, contents = win.webContents) {
  win.focus(); contents.focus();
  const point = await until(() => contents.executeJavaScript(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.getClientRects().length&&${text ? `e.textContent.includes(${JSON.stringify(text)})` : 'true'});if(!e||e.disabled)return null;e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`), `click ${selector} ${text ?? ''}`);
  if (contents !== win.webContents) {
    contents.debugger.attach('1.3');
    try { await contents.debugger.sendCommand('Page.bringToFront'); await contents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }); await contents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point }); await contents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point }); }
    finally { contents.debugger.detach(); }
  } else { contents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point }); contents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point }); }
  await delay(60);
}
async function fill(selector: string, text: string) { await click(selector); win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] }); win.webContents.insertText(text); await delay(80); }
async function select(selector: string, value: string) { await until(()=>evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return e&&!e.disabled&&[...e.options].some(option=>option.value===${JSON.stringify(value)});})()`),'enabled select option'); await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('change',{bubbles:true}));})()`); }
async function screenshot(name: string) {
  win.show(); await delay(350);
  writeFileSync(join(fixture, name), (await win.webContents.capturePage(undefined, { stayAwake: true })).toPNG());
  if (view()) {
    const native = view()!;
    writeFileSync(join(fixture, name + '.geometry.json'), JSON.stringify({ visible: native.getVisible(), bounds: native.getBounds(), windowVisible: win.isVisible(), canvas: await guest('({width:innerWidth,height:innerHeight,canvas:[...document.querySelectorAll("canvas")].map(c=>({width:c.width,height:c.height}))})') }));
    const capture = await until(async () => { try { return await native.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }); } catch { return null; } }, 'native rendered screenshot', 5000);
    writeFileSync(join(fixture, 'native-' + name), capture.toPNG());
  }
}
async function ready() { await until(async () => { const state=await evaluate('({status:document.querySelector(".comfy-workspace .project-statusbar")?.textContent,error:document.querySelector(".comfy-workspace [role=alert]")?.textContent})');if(state.status?.includes('准备未完成'))throw Error(state.error);return state.status?.includes('已就绪'); }, 'workspace ready', 180000); await until(() => view()?.getVisible(), 'native visible'); }
async function finish(run: RunView) { return await until(async () => { const state = await comfy({ type: 'request', request: { type: 'read_run', runId: run.id } }) as RunView; if (state.status === 'failed') throw Error(JSON.stringify(state)); return state.status === 'succeeded' && state; }, 'native run completes'); }
async function queue() { const prior = (await comfy({ type: 'runs' })).runs[0]?.id; await click('.comfy-workspace .project-controls button', '运行工作流'); return await until(async () => { const page = await comfy({ type: 'runs' }); return page.runs?.[0]?.id !== prior && page.runs[0]; }, 'run receipt') as RunView; }

void (async () => {
  writeFileSync(join(fixture, 'main-import-ready.json'), JSON.stringify({ ready: app.isReady() }));
  assert.equal(app.isReady(), false, 'production schemes must register before Electron readiness');
  createRequire(join(fixture, 'harness.cjs'))(join(fixture, 'dist/client/desktop/main.cjs'));
  await new Promise<void>(done => vendor.listen(0, '127.0.0.1', done)); vendorOrigin = `http://127.0.0.1:${(vendor.address() as any).port}`;
  await app.whenReady(); win = await until(() => BrowserWindow.getAllWindows()[0], 'production window');
  await until(() => evaluate('!!window.mixcat && !!document.querySelector(".workspace-sidebar")').catch(() => false), 'actual renderer');
  win.show(); win.focus(); win.setTitle('Mixcat — Task8 isolated native proof');
  if (process.argv.includes('--shutdown-lost')) {
    const owner=await until(()=>core?.pid?core:undefined,'actual worker');const workerPid=owner.pid;
    await new Promise<void>(done=>{owner.once('exit',()=>done());owner.kill();});
    const timer=setTimeout(()=>{writeFileSync(join(fixture,'evidence-shutdown-lost.json'),JSON.stringify({passed:false,workerPid,warnings}));console.error('Normal Quit did not finish after confirmed worker exit');app.exit(1);},8000);
    app.once('will-quit',()=>{clearTimeout(timer);writeFileSync(join(fixture,'evidence-shutdown-lost.json'),JSON.stringify({passed:true,workerPid,confirmedWorkerExit:true,normalQuit:true}));vendor.close();});app.quit();return;
  }
  const shutdownMode=process.argv.find(arg=>arg==='--shutdown-reject'||arg==='--shutdown-timeout');
  if(shutdownMode){
    const owner=await until(()=>core?.pid?core:undefined,'actual worker'),workerPid=owner.pid;let kills=0;const kill=owner.kill.bind(owner);owner.kill=()=>{kills++;return kill();};
    const evidence=join(fixture,`evidence${shutdownMode.slice(1)}.json`);
    const timer=setTimeout(()=>{console.error('Core shutdown recovery did not finish');writeFileSync(evidence,JSON.stringify({passed:false,workerPid,kills,warnings}));app.exit(1);},30000);
    app.once('will-quit',()=>{clearTimeout(timer);const attempts=JSON.parse(readFileSync(join(fixture,'shutdown-attempts.json'),'utf8'));assert.deepEqual(attempts.attempts,[false,true]);assert.equal(kills,1);writeFileSync(evidence,JSON.stringify({passed:true,workerPid,kills,warnings,attempts,foregroundBlocked:true,retainedUntilAcknowledged:true}));vendor.close();});
    app.quit();await until(()=>shutdownDecision,'shutdown recovery dialog',18000);assert.equal(kills,0);assert.equal(owner.pid,workerPid);assert.equal(win.isEnabled(),false);
    await assert.rejects(command({type:'snapshot'}),/安全关闭状态/);
    shutdownDecision!({response:0,checkboxChecked:false});
    await until(()=>JSON.parse(readFileSync(join(fixture,'shutdown-attempts.json'),'utf8')).attempts.length===2,'explicit shutdown retry');
    if(shutdownMode==='--shutdown-timeout'){const attempts=JSON.parse(readFileSync(join(fixture,'shutdown-attempts.json'),'utf8'));assert.equal(attempts.feedCalls,1);assert.equal(kills,0);writeFileSync(join(fixture,'release-shutdown'),'release owned pending shutdown');}
    return;
  }
  if(process.argv.includes('--status')){
    projectId=(await command({type:'create_project',root:project,name:'Native workspace proof',template:'comfyui'})).snapshot.selected.project.id;
    await click('.sidebar-project-list button,.project-card','Native workspace proof');await ready();
    await guest('window.nativeApp=window.comfyAPI.app.app;nativeApp.loadGraphData({nodes:[],links:[],groups:[],config:{},extra:{},version:0.4},true,false,"Live status proof").then(()=>{const a=LiteGraph.createNode("EmptyImage"),b=LiteGraph.createNode("SaveImage");nativeApp.rootGraph.add(a);nativeApp.rootGraph.add(b);a.connect(0,b,0);a.widgets.find(w=>w.name==="width").value=32;a.widgets.find(w=>w.name==="height").value=32;nativeApp.graph.change();return true;})');
    const originalFetch=globalThis.fetch;let release!:()=>void,inspections=0;const gate=new Promise<void>(done=>release=done);
    const nativeOrigin=new URL(view()!.webContents.getURL()).origin;
    globalThis.fetch=async(input,init)=>{if(String(input).startsWith(nativeOrigin+'/history/')){inspections++;await gate;}return originalFetch(input,init);};
    try {
      await click('.comfy-workspace .project-controls button','运行工作流');await click('.comfy-workspace .project-controls button','运行记录');
      await until(()=>evaluate('document.querySelector(".comfy-run-row button")?.textContent.includes("原生队列中")'),'queued row without fixture run reads');
      await click('.comfy-run-row button');await until(()=>evaluate('document.querySelector(".comfy-run-detail h3")?.textContent.includes("原生队列中")'),'selected queued detail');
      release();await until(()=>evaluate('document.querySelector(".comfy-run-row button")?.textContent.includes("原生工作流完成")&&document.querySelector(".comfy-run-detail h3")?.textContent.includes("原生工作流完成")&&!!document.querySelector(".comfy-output")'),'automatic terminal row and output',15000);
      const runId=await evaluate('document.querySelector(".comfy-run-detail>p").textContent'),output=await evaluate('document.querySelector(".comfy-output span").textContent');
      const relativePath=output.split(' · ')[0],bytes=readFileSync(join(project,relativePath)).length;assert(bytes>20);assert(inspections>0);
      writeFileSync(join(fixture,'evidence-status.json'),JSON.stringify({passed:true,projectId,runId,relativePath,bytes,inspections,fixtureReadRunCalls:0,rowAndSelectedDetailUpdated:true,officialNativeCpu:true},null,2));
    } finally {release();globalThis.fetch=originalFetch;}
    await click('dialog [aria-label="关闭弹窗"]');await click('.comfy-canvas-footer button','安全关闭画布');await until(()=>evaluate('document.querySelector(".comfy-workspace .project-statusbar")?.textContent.includes("已安全关闭")'),'status proof safe close');vendor.close();app.quit();return;
  }
  if (process.argv.includes('--interactive') || process.argv.includes('--keyboard')) {
    projectId = (await command({ type: 'create_project', root: project, name: 'Native workspace proof', template: 'comfyui' })).snapshot.selected.project.id;
    await click('.sidebar-project-list button,.project-card', 'Native workspace proof'); await ready();
    const beforeShow = { windowVisible: win.isVisible(), nativeVisible: view()!.getVisible(), bounds: view()!.getBounds(), attached: win.contentView.children.includes(view()!) };
    win.show(); win.focus(); win.setTitle('Mixcat — Task8 isolated native proof');
    await delay(250);
    writeFileSync(join(fixture, 'presentation-check.json'), JSON.stringify({ beforeShow, afterShow: { windowVisible: win.isVisible(), nativeVisible: view()!.getVisible(), bounds: view()!.getBounds(), attached: win.contentView.children.includes(view()!), parent: win.contentView.getBounds(), overlay: await evaluate('!!document.querySelector("dialog[open]")') } }, null, 2));
    await guest('window.nativeApp=window.comfyAPI.app.app;nativeApp.loadGraphData({nodes:[],links:[],groups:[],config:{},extra:{},version:0.4},true,false,"Input proof").then(()=>{const n=LiteGraph.createNode("EmptyLatentImage");n.title="Task8 keyboard proof";nativeApp.rootGraph.add(n);n.pos=[100,180];nativeApp.canvas.ds.scale=1;nativeApp.canvas.ds.offset[0]=0;nativeApp.canvas.ds.offset[1]=0;nativeApp.graph.change();window.physicalKeys=[];window.addEventListener("keydown",e=>physicalKeys.push({key:e.key,target:e.target.id,trusted:e.isTrusted}),true);return true;})');
    if (process.argv.includes('--keyboard')) {
      win.setAlwaysOnTop(true);
      await until(()=>guest('document.visibilityState==="visible"'),'visible native document before keyboard',10000);
      const current=view()!, contents=current.webContents, before=await comfy({type:'request',request:{type:'read_graph'}}) as GraphView;
      await guest('nativeApp.canvas.deselectAll();true');
      const point=await guest('(()=>{const r=document.getElementById("graph-canvas-container").getBoundingClientRect();return {x:r.x+r.width*.8,y:r.y+r.height*.65};})()');
      contents.debugger.attach('1.3');try{for(const type of ['mouseMoved','mousePressed','mouseReleased'])await contents.debugger.sendCommand('Input.dispatchMouseEvent',{type,...point,...type==='mouseMoved'?{}:{button:'left',clickCount:1}});}finally{contents.debugger.detach();}
      contents.focus();const boundary:unknown[]=[];contents.on('before-input-event',(event,input)=>boundary.push({key:input.key,control:input.control,prevented:event.defaultPrevented}));
      assert.equal(view()!.webContents.id,contents.id);assert.equal(await guest('document.visibilityState'),'visible');
      contents.sendInputEvent({type:'keyDown',keyCode:'A',modifiers:['control']});contents.sendInputEvent({type:'keyUp',keyCode:'A',modifiers:['control']});await delay(200);
      const after=await comfy({type:'request',request:{type:'read_graph'}}) as GraphView;
      const evidence={passed:after.selectedNodeIds.length===1,projectId,webContentsId:contents.id,instance:before.observation.instanceId,unchangedInstance:after.observation.instanceId===before.observation.instanceId,visible:await guest('document.visibilityState'),viewVisible:current.getVisible(),attached:win.contentView.children.includes(current),bounds:current.getBounds(),selectedNodeIds:after.selectedNodeIds,events:await guest('physicalKeys'),boundary};
      writeFileSync(join(fixture,'evidence-keyboard.json'),JSON.stringify(evidence,null,2));assert(evidence.passed,'native Control+A selects the real canvas node');assert(evidence.events.some((e:any)=>e.trusted));
      vendor.close();app.quit();return;
    }
    writeFileSync(join(fixture, 'interactive-ready.json'), JSON.stringify({ pid: process.pid, projectId, project, title: win.getTitle(), visible: win.isVisible(), focused: win.isFocused(), handle: win.getNativeWindowHandle().toString('hex') }));
    console.log('Interactive native proof ready');
    while (!existsSync(join(fixture, 'finish-interaction'))) await delay(200);
    writeFileSync(join(fixture, 'interactive-evidence.json'), JSON.stringify(await guest('({nodes:nativeApp.rootGraph.nodes.map(n=>({id:n.id,title:n.title})),selectedNodeIds:Object.keys(nativeApp.canvas.selected_nodes),keys:physicalKeys,focused:document.hasFocus(),active:document.activeElement?.id,dialogs:[...document.querySelectorAll("[role=dialog]")].map(d=>({text:d.textContent.slice(0,80),visible:d.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})}))})'), null, 2));
    vendor.close(); app.quit(); return;
  }
  let graph!: GraphView, profile: any;
  if (!mediaPhase) {
  await click('nav[aria-label="工作空间"] button', '项目'); await click('.projects-page button', '新建项目');
  await fill('dialog input[placeholder="例如：产品文档更新"]', 'Native workspace proof');
  await fill('dialog input[placeholder="选择已有的非 C 盘项目目录"]', project); await select('dialog select[aria-label="工作流模板"]', 'comfyui');
  await click('dialog button', '创建项目');
  await until(() => evaluate('!!document.querySelector(".comfy-workspace")'), 'template route');
  projectId = (await command({ type: 'snapshot' })).snapshot.selected.project.id;
  assert(await evaluate('document.querySelector(".comfy-workspace").textContent.includes("正在准备")'));
  await click('nav[aria-label="工作空间"] button', '笔记');
  await until(async () => (await comfy({ type: 'request', request: { type: 'summary' } })).runtime.status === 'ready', 'background native preparation', 120000);
  assert.equal(view()!.getVisible(), false, 'an earlier asynchronous layout cannot resurrect on Notes');
  await click('.sidebar-project-list button,.project-card', 'Native workspace proof');
  await ready();
  graph = await comfy({ type: 'request', request: { type: 'read_graph' } }) as GraphView;
  assert.equal((graph.workflow.nodes as any[]).length, 0, 'brand new project must be empty');
  assert.equal(await guest('[...document.querySelectorAll("[role=dialog]")].filter(e=>e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})).length'), 0, 'fresh canvas must not be covered by the upstream template dialog');
  check('actual UI template creation, preparing state, fresh zero-node graph and usable visible canvas'); await screenshot('01-fresh.png');
  await guest('window.nativeApp=window.comfyAPI.app.app; true');
  const nativeView = view()!, oldBounds = nativeView.getBounds();
  await click('.comfy-workspace .project-controls button', '收起助手'); await until(() => nativeView.getBounds().width > oldBounds.width + 100, 'collapse expands native');
  await click('.comfy-workspace .project-controls button', '打开助手'); await until(() => nativeView.getBounds().width === oldBounds.width, 'restore assistant');
  for (const label of ['Issue', '文档']) { await click('.project-view-nav button', label); assert.equal(nativeView.getVisible(), false); await click('.project-view-nav button', '工作流'); await ready(); }
  for (const label of ['笔记', '信息流']) { await click('nav[aria-label="工作空间"] button', label); await until(() => !nativeView.getVisible(), `${label} hides native`); await click('.sidebar-project-list button,.project-card', 'Native workspace proof'); await ready(); }
  await click('button[aria-label="设置"]'); await until(() => !nativeView.getVisible(), 'settings hides native'); await click('.sidebar-project-list button,.project-card', 'Native workspace proof'); await ready();
  await click('nav[aria-label="工作空间"] button', '项目'); await until(() => !nativeView.getVisible(), 'project list hides native'); await click('.sidebar-project-list button,.project-card', 'Native workspace proof'); await ready();
  const oldBinding = await comfy({ type: 'bind' });
  await comfy({ type: 'layout', generation: oldBinding.generation, bounds: oldBounds });
  win.webContents.reload(); await until(() => evaluate('!!document.querySelector(".workspace-sidebar")').catch(() => false), 'reload'); await click('.sidebar-project-list button,.project-card', 'Native workspace proof'); await ready();
  await comfy({ type: 'layout', generation: oldBinding.generation, bounds: null }); assert(view()!.getVisible(), 'old renderer generation cannot hide fresh binding');
  await click('button[aria-label="设置"]'); await until(() => !view()!.getVisible(), 'reload surface hides native'); await comfy({ type: 'layout', generation: oldBinding.generation, bounds: oldBounds }); assert.equal(view()!.getVisible(), false, 'old renderer layout cannot resurrect a hidden view'); await click('.sidebar-project-list button,.project-card', 'Native workspace proof'); await ready();
  win.setSize(1260, 850); await until(() => view()!.getBounds().width !== oldBounds.width, 'native resized'); win.setSize(1560, 1000); await ready();
  check('assistant collapse, every app/project surface hide, remount/reload generation and actual window resize');
  await click('.comfy-workspace .project-controls button', '供应商'); await until(() => !view()!.getVisible(), 'provider modal hides native');
  await fill('[aria-label="连接名称"]', 'Local proof only'); await fill('[aria-label="完整 API 基址"]', vendorOrigin); await click('dialog input[type=checkbox]');
  await fill('[aria-label="text 模型 ID"]', 'native-text-model'); await fill('[aria-label="video 模型 ID"]', 'native-video-model'); await fill('[aria-label="API Key"]', key); await click('dialog button', '保存连接');
  await until(() => evaluate('document.querySelector("dialog").textContent.includes("已配置，待实际调用验证")'), 'provider saved'); assert.equal(await evaluate(`document.querySelector('[aria-label="API Key"]').value`), '');
  await click('dialog [aria-label="关闭弹窗"]'); await ready();
  profile = (await evaluate(`window.mixcat.comfyProviders({projectId:${JSON.stringify(projectId)},op:'list'})`))[0];
  await guest('window.nativeApp=window.comfyAPI.app.app; true');
  view()!.webContents.sendInputEvent({ type: 'mouseDown', button: 'right', clickCount: 1, x: 160, y: 180 }); view()!.webContents.sendInputEvent({ type: 'mouseUp', button: 'right', clickCount: 1, x: 160, y: 180 });
  await until(() => guest('!!document.querySelector(".litecontextmenu")'), 'native menu'); view()!.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); view()!.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await guest('nativeApp.rootGraph.add(LiteGraph.createNode("EmptyLatentImage"));nativeApp.rootGraph.convertToSubgraph(new Set(nativeApp.rootGraph.nodes));const sub=nativeApp.rootGraph.nodes[0];nativeApp.canvas.openSubgraph(sub.subgraph,sub);nativeApp.canvas.selectNode(sub.subgraph.nodes[0]); nativeApp.graph.change(); true');
  await fill('[aria-label="节点消息"]', 'pending draft with @reference'); await click('.comfy-workspace .project-controls button', '引用选中节点');
  await until(() => evaluate('document.querySelector("[aria-label=节点消息]").value.includes("选中节点")'), 'selected-node draft append');
  assert((await evaluate('document.querySelector("[aria-label=节点消息]").value')).startsWith('pending draft with @reference'));
  await guest(`window.originalStorageWrite=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key.startsWith('Comfy.Workflow.Draft'))throw Error('fixture disk quota');return originalStorageWrite.call(this,key,value)};nativeApp.rootGraph.nodes[0].title='blocked unsaved edit';nativeApp.graph.change();true`);
  await click('.comfy-canvas-footer button', '安全关闭画布'); await until(() => evaluate('document.querySelector(".comfy-workspace [role=alert]")?.textContent.includes("草稿尚未保存")'), 'failed native persistence blocks close'); assert(view()!.getVisible());
  await guest('Storage.prototype.setItem=originalStorageWrite;true');
  const immediate = 'Immediate unsaved native edit', nativePort = Number(new URL(view()!.webContents.getURL()).port); await guest(`nativeApp.rootGraph.nodes[0].title=${JSON.stringify(immediate)};nativeApp.graph.change();true`);
  await click('.comfy-canvas-footer button', '安全关闭画布'); await until(() => evaluate('document.querySelector(".comfy-workspace .project-statusbar").textContent.includes("已安全关闭")'), 'safe canvas close');
  const blocker = createPortBlocker(); await new Promise<void>(done => blocker.listen(nativePort, '127.0.0.1', done));
  await click('.comfy-native-frame button', '重新打开画布'); await until(() => evaluate('document.querySelector(".comfy-workspace .project-statusbar").textContent.includes("准备未完成")'), 'failed preparation is visible'); await new Promise<void>(done => blocker.close(() => done()));
  await click('.comfy-native-frame button', '重新打开画布'); await ready();
  graph = await comfy({ type: 'request', request: { type: 'read_graph' } }); assert.equal((graph.workflow.nodes as any[])[0].title, immediate);
  assert((await evaluate('document.querySelector("[aria-label=节点消息]").value')).startsWith('pending draft'));
  check('provider settings, native context menu, selected-node context and immediate unsaved native close/reopen');
  await guest('window.nativeApp=window.comfyAPI.app.app; true');
  await guest("nativeApp.extensionManager.command.execute('Comfy.BrowseTemplates').then(()=>true)"); await until(() => guest('[...document.querySelectorAll("[role=dialog]")].some(e=>e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))'), 'manual template dialog');
  await click('nav[aria-label="工作空间"] button', '笔记'); await click('.sidebar-project-list button,.project-card', 'Native workspace proof'); await ready();
  assert(await guest('[...document.querySelectorAll("[role=dialog]")].some(e=>e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))'), 'reuse must preserve a user-opened native dialog');
  await click('[role=dialog] button[aria-label="关闭对话框"]', undefined, view()!.webContents);
  await until(() => guest('![...document.querySelectorAll("[role=dialog]")].some(e=>e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))'), 'manual native dialog closes');
  } else {
    projectId = (await command({ type: 'create_project', root: project, name: 'Native workspace proof', template: 'comfyui' })).snapshot.selected.project.id;
    await click('.sidebar-project-list button,.project-card', 'Native workspace proof'); await ready();
    const profiles = await evaluate(`window.mixcat.comfyProviders(${JSON.stringify({ projectId, op: 'save', expectedRevision: 0, input: { name: 'Bounded media proof', protocol: 'ark', baseUrl: vendorOrigin, allowInsecureHttp: true, key, models: { text: 'native-text-model', video: 'native-video-model' } } })})`);
    profile = profiles.at(-1);
    await guest('window.nativeApp=window.comfyAPI.app.app; nativeApp.loadGraphData({nodes:[],links:[],groups:[],config:{},extra:{},version:0.4},true,false,"Media proof").then(()=>{nativeApp.rootGraph.add(LiteGraph.createNode("EmptyLatentImage"));nativeApp.graph.change();return true;})');
    graph = await comfy({ type: 'request', request: { type: 'read_graph' } });
    await fill('[aria-label="节点消息"]', 'pending draft with @reference');
    check('bounded media/quit phase reopened the actual production project and native canvas');
  }
  let firstThread: string | null = (await command({ type: 'snapshot' })).snapshot.selected.nodes[0].threadId;
  let keyboardDeleted = false, video: RunView, nextRun: RunView, media: any, tabsBefore: string[] = [];
  if (quitPhase) {
    const previous = (await comfy({ type: 'runs' })).runs.flatMap((run: RunView) => run.assets).find((asset: any) => asset.mime === 'video/mp4');
    assert(previous, 'quit phase requires an existing native video fixture'); videoBytes = readFileSync(join(project, previous.relativePath));
    await fill('[aria-label="节点消息"]', 'durable assistant draft after native feedback');
  } else {
  const imported = join(project, 'native-import.json'); const importedGraph = structuredClone(graph.workflow); (importedGraph.nodes as any[])[0].title = 'Imported native file'; writeFileSync(imported, JSON.stringify(importedGraph));
  const contents = view()!.webContents; contents.debugger.attach('1.3');
  const document = await contents.debugger.sendCommand('DOM.getDocument'); const input = await contents.debugger.sendCommand('DOM.querySelector', { nodeId: document.root.nodeId, selector: 'input[type=file][accept*="json"]' });
  assert(input.nodeId, 'official workflow file input'); await contents.debugger.sendCommand('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [imported] }); contents.debugger.detach();
  await until(async () => ((await comfy({ type: 'request', request: { type: 'read_graph' } })) as GraphView).workflow.nodes && await guest('nativeApp.rootGraph.nodes[0]?.title==="Imported native file"'), 'native file import');
  tabsBefore = await guest('nativeApp.extensionManager.workflow.openWorkflows.map(w=>w.path)'); assert(tabsBefore.length);
  await click('#graph-canvas-container', undefined, contents);
  await guest('window.proofKeys=[];window.addEventListener("keydown",e=>proofKeys.push({key:e.key,code:e.code,target:e.target.id,tag:e.target.tagName,trusted:e.isTrusted}),true);document.getElementById("graph-canvas-container").focus();nativeApp.canvas.selectNode(nativeApp.canvas.graph.nodes[0]);true');
  const keyBoundary: unknown[] = []; contents.on('before-input-event', (event, input) => { keyBoundary.push({ key: input.key, prevented: event.defaultPrevented }); });
  const beforeKey = { windowFocused: win.isFocused(), guestFocused: contents.isFocused(), ...await guest('({documentFocused:document.hasFocus(),active:document.activeElement?.id,tag:document.activeElement?.tagName,selected:Object.keys(nativeApp.canvas.selected_nodes),items:nativeApp.canvas.selectedItems.size,nodes:nativeApp.canvas.graph.nodes.map(n=>n.id),dialogs:[...document.querySelectorAll("[role=dialog]")].map(d=>({state:d.getAttribute("data-state"),visible:d.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})}))})') };
  contents.debugger.attach('1.3');
  try { for (const type of ['keyDown', 'keyUp']) await contents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 }); }
  finally { contents.debugger.detach(); }
  writeFileSync(join(fixture, 'keyboard-debug.json'), JSON.stringify({ before: beforeKey, events: await guest('proofKeys'), boundary: keyBoundary, after: await guest('({selected:Object.keys(nativeApp.canvas.selected_nodes),items:nativeApp.canvas.selectedItems.size,nodes:nativeApp.canvas.graph.nodes.map(n=>n.id)})') }, null, 2));
  keyboardDeleted = !!await guest('nativeApp.canvas.graph.nodes.length===0');
  if (!mediaPhase) assert(keyboardDeleted, 'native Delete key');
  if (!keyboardDeleted) console.log('UNRESOLVED keyboard delivery; retained keyboard-debug.json; independent media/quit phase continues');
  await guest('nativeApp.rootGraph.clear();true');
  await guest(`(()=>{const a=LiteGraph.createNode('EmptyImage'),b=LiteGraph.createNode('CreateVideo'),c=LiteGraph.createNode('SaveVideo');for(const [i,n] of [a,b,c].entries()){nativeApp.rootGraph.add(n);n.pos=[40+i*340,80];}a.connect(0,b,0);b.connect(0,c,0);a.widgets.find(w=>w.name==='width').value=32;a.widgets.find(w=>w.name==='height').value=32;a.widgets.find(w=>w.name==='batch_size').value=24;b.widgets.find(w=>w.name==='fps').value=8;c.widgets.find(w=>w.name==='filename_prefix').value='task8-video';nativeApp.graph.change();return true;})()`);
  video = await finish(await queue()); videoBytes = readFileSync(join(project, video.assets[0].relativePath));
  await guest('nativeApp.rootGraph.nodes.forEach((n,i)=>{n.pos=[40+i*280,80]});nativeApp.canvas.ds.scale=.65;nativeApp.canvas.ds.offset[0]=20;nativeApp.canvas.ds.offset[1]=20;nativeApp.canvas.setDirty(true,true);true');
  writeFileSync(join(fixture, 'player-debug.json'), JSON.stringify({ attached: win.contentView.children.includes(view()!), visible: view()!.getVisible(), bounds: view()!.getBounds(), overlay: await evaluate('!!document.querySelector("dialog[open]")'), native: await guest('({videos:[...document.querySelectorAll("video")].map(v=>({ready:v.readyState,width:v.videoWidth,height:v.videoHeight,error:v.error?.code,network:v.networkState})),nodes:nativeApp.rootGraph.nodes.map(n=>({type:n.type,widgets:n.widgets?.map(w=>({name:w.name,type:w.type,keys:Object.keys(w)}))}))})') }, null, 2));
  if (!feedbackPhase) {
  await click('.comfy-workspace .project-controls button', '运行记录'); await click('.comfy-run-row button', video.id.slice(0, 12)); await until(() => evaluate('!!document.querySelector(".comfy-output")'), 'actual video output'); await click('.comfy-output button', '打开成果');
  await delay(300);
  writeFileSync(join(fixture, 'output-preview-debug.json'), JSON.stringify({ ui: await evaluate('({tab:document.querySelector("#tab-panels")?.getAttribute("aria-selected"),dialogs:[...document.querySelectorAll("dialog[open]")].map(d=>d.getAttribute("aria-label")),errors:[...document.querySelectorAll("[role=alert]")].map(e=>e.textContent),panels:document.querySelector(".node-panels")?.textContent})'), views: win.contentView.children.filter(child => 'webContents' in child).map(child => ({ id: (child as WebContentsView).webContents.id, visible: child.getVisible(), bounds: child.getBounds(), protocol: (child as WebContentsView).webContents.getURL().split(':')[0] })) }, null, 2));
  const playerView = await until(() => win.contentView.children.find(child => 'webContents' in child && (child as WebContentsView).webContents.getURL().startsWith('mixcat-preview:') && child.getVisible()) as WebContentsView | undefined, 'actual output preview');
  const player = (code: string) => playerView.webContents.executeJavaScript(code);
  media = await until(() => player('(()=>{const v=document.querySelector("video");return v&&v.readyState>=2&&{width:v.videoWidth,height:v.videoHeight,duration:v.duration};})()'), 'actual Electron result video decoder'); assert.equal(media.width, 32); assert.equal(media.height, 32); assert(media.duration > 1);
  await player('(()=>{const v=document.querySelector("video");v.muted=true;v.currentTime=0;return v.play().then(()=>true);})()'); await delay(350); assert(await player('document.querySelector("video").currentTime>0.1')); await player('document.querySelector("video").pause();true');
  writeFileSync(join(fixture, 'player-02-video.png'), (await playerView.webContents.capturePage(undefined, { stayAwake: true })).toPNG());
  check(`official file import${keyboardDeleted ? ', native keyboard' : ''} and actual Electron result video readiness/dimensions/playback`); await screenshot('02-video.png');
  }
  await click('.comfy-workspace .project-controls button', '运行记录'); await click('.comfy-run-row button', video.id.slice(0, 12)); await until(() => evaluate('!!document.querySelector(".comfy-output")'), 'verified output details'); await click('.comfy-output button', '引用到助手并反馈');
  const draft = await evaluate('document.querySelector("[aria-label=节点消息]").value'); assert(draft.startsWith('pending draft')); assert(draft.includes(video.id)); assert(draft.includes(video.assets[0].sha256));
  await click('#tab-config'); await until(() => evaluate('document.querySelector(".node-config select")?.options.length>1'), 'real controlled capability catalog'); await select('.node-config select', 'fixture-model'); await until(async () => (await command({ type: 'snapshot' })).snapshot.selected.nodes[0].model === 'fixture-model', 'config autosave');
  const priorTurns = (await command({ type: 'snapshot' })).snapshot.selected.tasks.length;
  await click('#tab-conversation'); await click('.node-composer button[type=submit]'); await until(async () => (await command({ type: 'snapshot' })).snapshot.selected.tasks.length === priorTurns + 1 && (await command({ type: 'snapshot' })).snapshot.selected.tasks.every((t: any) => t.status === 'completed'), 'controlled assistant accepts feedback');
  firstThread = (await command({ type: 'snapshot' })).snapshot.selected.nodes[0].threadId;
  await fill('[aria-label="节点消息"]', 'Same conversation second feedback'); await click('.node-composer button[type=submit]'); await until(async () => (await command({ type: 'snapshot' })).snapshot.selected.tasks.length === priorTurns + 2 && (await command({ type: 'snapshot' })).snapshot.selected.tasks.every((t: any) => t.status === 'completed'), 'second feedback');
  assert.equal((await command({ type: 'snapshot' })).snapshot.selected.nodes[0].threadId, firstThread);
  nextRun = await finish(await queue()); assert.notEqual(nextRun.id, video.id);
  await guest('nativeApp.rootGraph.nodes[0].title="restore this manual title";nativeApp.graph.change();true');
  await click('.comfy-workspace .project-controls button', '版本恢复'); await until(() => evaluate('document.querySelector("[aria-label=工作流版本]")?.options.length>0'), 'native versions'); await click('dialog button', '恢复选中版本');
  await ready(); assert.notEqual(await guest('nativeApp.rootGraph.nodes[0].title'), 'restore this manual title');
  check('actual version picker restores a frozen native workflow with current observation checks');
  await fill('[aria-label="节点消息"]', 'durable assistant draft after native feedback');
  check('verified actual output appends preserved draft/references, same native assistant Thread and distinct explicitly requested run');
  if (feedbackPhase) {
    writeFileSync(proof, JSON.stringify({ passed: true, phase: 'feedback-restore', keyboardDeleted, checks, projectId, firstThread, videoRun: video.id, subsequentRun: nextRun.id, artifact: video.assets[0], electron: process.versions.electron }, null, 2));
    vendor.close(); app.quit(); return;
  }
  }
  await guest(`(()=>{nativeApp.rootGraph.clear(); const a=LiteGraph.createNode('MixcatAPIText'),b=LiteGraph.createNode('SaveText');nativeApp.rootGraph.add(a);nativeApp.rootGraph.add(b);a.connect(0,b,0);a.widgets.find(w=>w.name==='connection').value=${JSON.stringify(profile.id + '@' + profile.revision)};a.widgets.find(w=>w.name==='prompt').value='task8';a.widgets.find(w=>w.name==='parameters').value='{}';nativeApp.graph.change();return true;})()`);
  decryptHeld = true; decryptReached = false; const textRun = await queue(); await until(() => decryptReached, 'deferred credential boundary');
  await evaluate('window.mixcat.setFeedUnsaved(true)'); const ownerPid = core!.pid; app.quit(); await until(() => quitDecision, 'quit draft prompt');
  win.close(); assert.equal(win.isDestroyed(), false, 'a pending quit decision must retain the actual window');
  decryptHeld = false; releaseDecrypt!(); await until(() => textCreates === 1, 'accepted job retains ownership during pending quit prompt'); quitDecision!({ response: 0, checkboxChecked: false }); quitDecision = undefined;
  await finish(textRun); assert.equal(core!.pid, ownerPid); await evaluate('window.mixcat.setFeedUnsaved(false)');
  check('pending and cancelled quit prompt does not revoke accepted background credential/job ownership');
  await guest(`(()=>{nativeApp.rootGraph.clear();const a=LiteGraph.createNode('MixcatAPIVideo'),b=LiteGraph.createNode('SaveVideo');nativeApp.rootGraph.add(a);nativeApp.rootGraph.add(b);a.connect(0,b,0);a.widgets.find(w=>w.name==='connection').value=${JSON.stringify(profile.id + '@' + profile.revision)};a.widgets.find(w=>w.name==='model').value='native-video-model';a.widgets.find(w=>w.name==='prompt').value='held video';a.widgets.find(w=>w.name==='mode').value='text';a.widgets.find(w=>w.name==='parameters').value='{}';nativeApp.graph.change();return true;})()`);
  videoHeld = true; const held = await queue(); await until(() => videoCreates === 1, 'remote acceptance'); app.quit(); await until(() => warnings.some(value => /活动运行|远端操作/.test(value)), 'blocked quit warning'); assert.equal(core!.pid, ownerPid); assert(!win.isDestroyed());
  await assert.rejects(command({ type: 'delete_project', projectId }), /Comfy/);
  await click('.comfy-workspace .project-controls button', '供应商'); await select('dialog [aria-label="连接"]', profile.id); await click('dialog button', '移除连接'); await until(() => evaluate('document.querySelector("dialog [role=alert]")?.textContent'), 'provider active-reference UI guard'); await click('dialog [aria-label="关闭弹窗"]');
  await comfy({ type: 'request', request: { type: 'stop_run', runId: held.id, action: 'stop_waiting' } });
  await assert.rejects(command({ type: 'delete_project', projectId }), /未完成|核对/);
  check('blocked quit retains real worker/window, provider UI guard and stopped remote jobs still block deletion');
  videoHeld = false; const recovered = await until(async () => { const state = await comfy({ type: 'request', request: { type: 'read_run', runId: held.id } }); return state.recoveredAssets?.length && state; }, 'remote recovery as intermediate'); assert.equal(recovered.assets.length, 0); assert.notEqual(recovered.status, 'succeeded');
  await click('.comfy-workspace .project-controls button', '运行记录'); await click('.comfy-run-row button', held.id.slice(0, 12)); await until(() => evaluate('document.querySelector(".comfy-run-detail")?.textContent.includes("中间产物")'), 'recovered distinct'); await click('dialog [aria-label="关闭弹窗"]');
  await screenshot('03-workspace.png');
  await click('.comfy-canvas-footer button', '安全关闭画布'); await until(() => evaluate('document.querySelector(".comfy-workspace .project-statusbar").textContent.includes("已安全关闭")'), 'safe retained close');
  await click('.comfy-native-frame button', '重新打开画布'); await ready(); assert.equal(videoCreates, 1);
  assert.equal((await command({ type: 'snapshot' })).snapshot.selected.nodes[0].threadId, firstThread); assert.equal(await evaluate('document.querySelector("[aria-label=节点消息]").value'), 'durable assistant draft after native feedback');
  check('safe retained close/reopen queries original remote task, keeps Thread/draft and distinguishes recovered intermediates');
  const state = await command({ type: 'snapshot' }); assert(!JSON.stringify(state).includes(key)); assert(!JSON.stringify(await comfy({ type: 'runs' })).includes(key));
  writeFileSync(proof, JSON.stringify({ passed: true, phase: quitPhase ? 'quit' : mediaPhase ? 'media-quit' : 'complete', keyboardDeleted, checks, projectId, firstThread, ...(!quitPhase ? { video: { runId: video!.id, asset: video!.assets[0], media }, nextRunId: nextRun!.id } : {}), remoteRunId: held.id, textCreates, videoCreates, workerPid: ownerPid, tabsBefore, electron: process.versions.electron }, null, 2));
  quitting = true; vendor.close(); app.quit();
})().catch(async error => { console.error(error); writeFileSync(join(fixture, 'failure.txt'), String(error.stack ?? error)); if (win && !win.isDestroyed()) await screenshot('failure.png').catch(() => {}); releaseDecrypt?.(); quitDecision?.({ response: 0, checkboxChecked: false }); decryptHeld = false; videoHeld = false;
  try { if (projectId && win && !win.isDestroyed()) { await evaluate('window.mixcat.setFeedUnsaved(false)'); for (const run of (await comfy({ type: 'runs' })).runs) await comfy({ type: 'request', request: { type: 'stop_run', runId: run.id, action: 'stop_waiting' } }).catch(() => {}); await comfy({ type: 'close' }); } } catch (cleanup) { console.error(cleanup); }
  vendor.close(); app.exit(1);
});
