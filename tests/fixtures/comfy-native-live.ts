import { app, BrowserWindow, safeStorage, utilityProcess } from 'electron';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { projectDirectory } from '../../src/core/paths.js';
import { ComfyHost } from '../../src/desktop/comfy-host.js';
import { ProviderSettingsService } from '../../src/desktop/provider-settings.js';
import { boundedComfy, validateRpcRequest } from '../../src/shared/comfy-bridge.js';
import { mergeUpdate } from '../../src/shared/snapshots.js';
import type { AppCommand, AppReply, AppSnapshot } from '../../src/shared/types.js';
import type { GraphView, RunView } from '../../src/shared/comfy.js';

const root = process.argv[2], proof = projectDirectory(root, '.runtime', process.env.MIXCAT_PROOF_EARLY_EXIT ? 'm10-negative' : 'm10'), projectRoot = projectDirectory(proof, 'p');
for (const name of ['appData', 'userData', 'sessionData', 'temp', 'crashDumps'] as const) app.setPath(name, projectDirectory(proof, name));
app.setAppLogsPath(projectDirectory(proof, 'logs')); app.commandLine.appendSwitch('disk-cache-dir', projectDirectory(proof, 'cache')); app.disableHardwareAcceleration();
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let worker: ReturnType<typeof utilityProcess.fork> | undefined, host: ComfyHost | undefined, window: BrowserWindow | undefined, vendor: Server | undefined;
let workerExited = false, snapshot: AppSnapshot | null = null;
const pending = new Map<string, { resolve(value: any): void; reject(error: Error): void }>();
const nativeCalls: any[] = [], evidence: any = { realModel: true, officialGuest: true, productionWorker: true };
const fakeKey = 'FAKE_Task10_LOCAL_ONLY_619138';
const nativeOnly = process.env.MIXCAT_PROOF_NATIVE_ONLY === '1';
if (nativeOnly) evidence.realModel = false;
let imageCreates = 0, textCreates = 0, videoCreates = 0;
function request(data: object) { return new Promise<any>((resolve, reject) => { if (!worker || workerExited) return reject(Error('Worker unavailable')); const id = randomUUID(); pending.set(id, { resolve, reject }); worker.postMessage({ id, ...data }); }); }
const command = (value: AppCommand): Promise<AppReply> => request({ envelope: { id: randomUUID(), command: value } });
const persist = () => writeFileSync(join(proof, nativeOnly ? 'native-video-evidence.json' : 'evidence.json'), JSON.stringify({ ...evidence, imageCreates, textCreates, videoCreates, nativeCalls }, null, 2));
async function cleanup() {
  try { if (worker && !workerExited) await request({ shutdown: true }); } catch {}
  try { await host?.dispose(true); } catch {}
  worker?.kill(); window?.destroy(); vendor?.closeAllConnections(); await new Promise<void>(done => vendor ? vendor.close(() => done()) : done());
}
app.whenReady().then(async () => {
  assert(process.env.MIXCAT_CODEX); assert(process.env.MIXCAT_ACCOUNT_ROOT);
  const owner = {};
  const settings = new ProviderSettingsService(safeStorage, () => ({ owner, epoch: 0, snapshot: snapshot ?? undefined }), (p, id, rev) => host!.assertProviderMutable(p, id, rev), p => { void host?.refreshProviders(p); });
  window = new BrowserWindow({ show: true, width: 1440, height: 1000, title: 'Mixcat Task10 owned native acceptance', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.loadURL('data:text/html,<title>Mixcat Task10 owned native acceptance</title><body style="background:#20242a;color:white">Mixcat Task10 native acceptance</body>');
  host = new ComfyHost(window, join(root, 'dist/client/comfy'), join(root, 'dist/client/desktop/comfy-preload.cjs'), settings);
  let resolveReady!: () => void, rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  worker = utilityProcess.fork(join(root, process.env.MIXCAT_PROOF_EARLY_EXIT ? 'tests/fixtures/comfy-worker-early-exit.cjs' : 'dist/client/core/worker.cjs'), [proof, process.env.MIXCAT_CODEX!, process.env.MIXCAT_ACCOUNT_ROOT!], { cwd: root, stdio: 'pipe', serviceName: 'Mixcat Task10 real model proof' });
  worker.on('message', (message: any) => {
    if (message.type === 'ready') { resolveReady(); return; }
    if (message.type === 'fatal') { rejectReady(Error(message.error)); return; }
    if (message.type === 'snapshot') { snapshot = mergeUpdate(snapshot, message.snapshot).snapshot; if (snapshot) host!.observe(snapshot); return; }
    if (message.type === 'comfy_request') {
      void (async () => {
        const record: any = { request: message.request, actor: message.actor, imageCreatesBefore: imageCreates }; nativeCalls.push(record);
        try {
          validateRpcRequest(message);
          if (message.request.type === 'native_queue' || message.request.type === 'flush_graph' || message.request.type === 'snapshot_workspace' || message.request.type === 'restore_context' || message.request.type === 'restore_workspace') throw Error('Guest native operation is internal only');
          const result = message.request.type === 'close_project' ? await host!.close(message.projectId).then(() => true) : await host!.request(message.projectId, message.request, message.actor, message.expiresAt);
          record.result = result; record.succeeded = true;
          if (message.request.type === 'summary') record.result = { ...(result as any), providers: (result as any).providers.map(({ baseUrl, ...profile }: any) => profile) };
          persist();
          const reply = { type: 'comfy_reply', id: message.id, generation: message.generation, projectId: message.projectId, result }; boundedComfy(reply); worker!.postMessage(reply);
        } catch (error) { record.error = String(error); persist(); worker!.postMessage({ type: 'comfy_reply', id: message.id, generation: message.generation, projectId: message.projectId, error: String(error) }); }
      })(); return;
    }
    const entry = pending.get(message.id); if (entry) { pending.delete(message.id); message.error ? entry.reject(Error(message.error)) : entry.resolve(message.result); }
  });
  worker.on('exit', code => { workerExited = true; const error = Error('Worker exited: ' + code); rejectReady(error); for (const entry of pending.values()) entry.reject(error); pending.clear(); });
  await ready;
  let created = nativeOnly ? await command({ type: 'snapshot' }) : await command({ type: 'create_project', root: projectRoot, name: 'Task10 actual empty graph proof', template: 'comfyui' });
  if (nativeOnly) { const project = created.snapshot.projects.find(project => project.root === projectRoot); assert(project, 'Existing proof project identity required'); created = await command({ type: 'snapshot', projectId: project.id }); }
  snapshot = created.snapshot; host.observe(snapshot);
  const projectId = snapshot.selected!.project.id; evidence.projectId = projectId;
  if (!nativeOnly) {
  assert.equal(snapshot.selected!.tasks.length, 0, 'Proof project must be genuinely fresh');
  const account = await command({ type: 'connect_account' }); assert.equal(account.snapshot.account?.authenticated, true);
  vendor = createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, `Bearer ${fakeKey}`);
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      if (req.url?.endsWith('/images/generations')) {
        assert.equal(body.model, 'native-image-model'); assert.equal(typeof body.prompt, 'string'); assert(body.prompt.length);
        assert.match(body.image[0], /^data:image\/png;base64,/); assert(imageCreates < 2, 'Only two image creates authorized');
        imageCreates++; res.end(JSON.stringify({ data: [{ b64_json: body.image[0].split(',')[1] }] })); return;
      }
      if (req.url?.includes('chat')) textCreates++; else videoCreates++;
      throw Error('Unexpected generation capability');
    } catch (error) { res.statusCode = 400; res.end(JSON.stringify({ error: { message: String(error) } })); }
  });
  await new Promise<void>(done => vendor!.listen(0, '127.0.0.1', done));
  await settings.handle({ projectId, op: 'save', expectedRevision: 0, input: { name: 'Task10 local fake image fixture', protocol: 'ark', baseUrl: `http://127.0.0.1:${(vendor.address() as { port: number }).port}`, allowInsecureHttp: true, key: fakeKey, models: { image: 'native-image-model' } } }, () => {});
  }
  const read = () => host!.request(projectId, { type: 'read_graph' }) as Promise<GraphView>;
  evidence.empty = await read(); if (!nativeOnly) assert.deepEqual(evidence.empty.workflow.nodes, []);
  await host.present(projectId, 1, { x: 0, y: 30, width: 1400, height: 900 });
  const entry = (host as any).entries.get(projectId), guest = entry.view.webContents;
  await guest.executeJavaScript(`window.nativeApp=window.comfyAPI.app.app; [...document.querySelectorAll('[role=dialog] button')].find(b=>b.getAttribute('aria-label')==='Close')?.click(); true`);
  evidence.combination = entry.selection; persist();
  async function turn(text: string) {
    const started = await command({ type: 'send_message', projectId, nodeId: 'comfy-assistant', mode: 'codex', input: [{ type: 'text', text_elements: [], text }] });
    const taskId = started.snapshot.selected!.tasks.at(-1)!.id; let task: any;
    for (let i = 0; i < 900; i++) {
      const current = await command({ type: 'snapshot', projectId, background: true }); task = current.snapshot.selected!.tasks.find(task => task.id === taskId)!;
      if (i % 15 === 0) console.log('Actual native task:', task.status, 'calls:', nativeCalls.length, 'images:', imageCreates);
      if (current.snapshot.selected!.requests?.length) throw Error('Native approval requires controller: ' + current.snapshot.selected!.requests.map(request => request.method).join(','));
      if (task.status === 'completed') return task;
      if (['failed', 'cancelled', 'needs_reconciliation'].includes(task.status)) throw Error('Actual model task failed: ' + task.error);
      await delay(1000);
    }
    throw Error('Actual model turn timed out');
  }
  if (!nativeOnly) {
  const first = await turn('这是已批准的本地假供应商验收：请从当前空 ComfyUI 画布自动搭建参考图片生成流程，使用已配置的 Task10 连接和默认图像模型。用原生空白图片作为32×32参考图，生成后用原生缩放得到16×24，并由原生 SaveImage 保存。请先查项目上下文、实际节点 schema 和当前图，通过 Mixcat Comfy 工具搭建、回读、运行、查询最终原生结果。本轮仅授权一次 image 创建；不调用 text/video，不安装节点，不用 shell/browser 绕过画布工具。无需再次确认，完成后报告实际 runId、最终文件和尺寸。');
  evidence.firstTask = { id: first.id, threadId: first.threadId, turnId: first.turnId, provenance: first.provenance };
  function effects(task: any) { const effects = nativeCalls.filter(call => call.succeeded && ['apply_graph', 'queue_graph'].includes(call.request.type) && call.actor?.turnId === task.turnId); for (const call of effects) { assert.equal(call.actor.kind, 'codex'); assert.equal(call.actor.nodeId, 'comfy-assistant'); assert.equal(call.actor.threadId, task.threadId); assert(call.actor.callId); } assert(effects.some(call => call.request.type === 'apply_graph')); assert(effects.some(call => call.request.type === 'queue_graph')); return effects; }
  const firstEffects = effects(first), firstQueue = firstEffects.find(call => call.request.type === 'queue_graph');
  assert(firstEffects.find(call => call.request.type === 'apply_graph').request.workflow.nodes.length > 0);
  const result = async (queue: any, width: number, height: number) => {
    const run = await host!.request(projectId, { type: 'read_run', runId: queue.result.id }) as RunView;
    assert.equal(run.status, 'succeeded'); assert.equal(run.assets.length, 1); assert.deepEqual(run.recoveredAssets, []);
    const bytes = readFileSync(join(projectRoot, run.assets[0].relativePath)); assert.equal(bytes.readUInt32BE(16), width); assert.equal(bytes.readUInt32BE(20), height);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), run.assets[0].sha256); assert.equal(bytes.length, run.assets[0].bytes); assert(!bytes.includes(Buffer.from(fakeKey)));
    const submission = entry.service.store.submission(run.requestId); assert.equal(submission.actor.turnId, queue.actor.turnId);
    const raw = entry.service.store.providerJobs(run.id).find((job: any) => job.input.kind === 'image').assets[0]; assert.notEqual(raw.sha256, run.assets[0].sha256);
    return { run, width, height, submission };
  };
  evidence.firstResult = await result(firstQueue, 16, 24); evidence.firstGraph = await read(); assert.equal(imageCreates, 1);
  await guest.executeJavaScript(`(()=>{const n=nativeApp.rootGraph.nodes.find(n=>n.type==='ImageScale');const w=n.widgets.find(w=>w.name==='width');w.value=24;w.callback?.(24);nativeApp.rootGraph.change();return true;})()`);
  evidence.manual = { method: 'programmatic native widget callback, not Windows input', graph: await read(), imageCreates };
  assert.notEqual(evidence.manual.graph.observation.revision, evidence.firstGraph.observation.revision);
  const scale = (graph: GraphView) => (graph.workflow.nodes as any[]).find(node => node.type === 'ImageScale');
  assert.deepEqual(scale(evidence.manual.graph).widgets_values.slice(1, 3), [24, 24]); persist();
  const secondStart = nativeCalls.length;
  const second = await turn(`我已经手动把缩放宽度改为24，现在应为24×24。请先回读当前图和上一次结果 ${evidence.firstResult.run.id}，保留我的宽度，仅将高度改成16，再用同一已配置的本地假供应商运行一次并查询最终原生文件。本轮只授权一次 image 创建，不调用 text/video。请报告实际结果。`);
  evidence.secondTask = { id: second.id, threadId: second.threadId, turnId: second.turnId, provenance: second.provenance };
  assert.equal(second.threadId, first.threadId); assert.notEqual(second.turnId, first.turnId);
  const secondCalls = nativeCalls.slice(secondStart), firstRead = secondCalls.find(call => call.succeeded && call.request.type === 'read_graph'); assert.deepEqual(scale(firstRead.result).widgets_values.slice(1, 3), [24, 24]);
  assert(secondCalls.some(call => call.succeeded && call.request.type === 'read_run' && call.request.runId === evidence.firstResult.run.id));
  const secondQueue = effects(second).find(call => call.request.type === 'queue_graph'); evidence.secondResult = await result(secondQueue, 24, 16);
  assert.notEqual(evidence.secondResult.run.id, evidence.firstResult.run.id); assert.notEqual(evidence.secondResult.run.promptId, evidence.firstResult.run.promptId); assert.notEqual(evidence.secondResult.run.assets[0].sha256, evidence.firstResult.run.assets[0].sha256);
  assert.deepEqual(await result(firstQueue, 16, 24), evidence.firstResult); assert.equal(imageCreates, 2); assert.equal(textCreates, 0); assert.equal(videoCreates, 0);
  evidence.finalGraph = await read(); await guest.executeJavaScript('nativeApp.canvas.fitView?.();nativeApp.canvas.setDirty(true,true);true'); await delay(700);
  writeFileSync(join(proof, 'native-final.png'), (await guest.capturePage()).toPNG());
  evidence.modelPassed = true; assert(!JSON.stringify(evidence).includes(fakeKey)); persist(); console.log('Actual EMPTY two-turn native proof passed');
  await guest.executeJavaScript(`nativeApp.canvas.deselectAllNodes();document.getElementById('graph-canvas').focus();window.proofKeys=[];window.addEventListener('keydown',e=>proofKeys.push({key:e.key,ctrl:e.ctrlKey,target:e.target.id,trusted:e.isTrusted}),true);true`);
  window.show(); window.focus(); guest.focus();
  await guest.executeJavaScript(`document.getElementById('graph-canvas').focus();true`);
  evidence.keyboardBefore = await guest.executeJavaScript(`({active:document.activeElement?.id,documentFocused:document.hasFocus(),selected:Object.keys(nativeApp.canvas.selected_nodes),items:nativeApp.canvas.selectedItems.size})`);
  writeFileSync(join(proof, 'keyboard-ready.json'), JSON.stringify({ pid: process.pid, windowId: window.id, title: window.getTitle(), ...evidence.keyboardBefore }));
  console.log('KEYBOARD READY: exact owned Task10 window; waiting bounded 180 seconds for controller marker'); persist();
  for (let i = 0; i < 180 && !existsSync(join(proof, 'keyboard-done')); i++) await delay(1000);
  evidence.keyboardAfter = await guest.executeJavaScript(`({active:document.activeElement?.id,documentFocused:document.hasFocus(),selected:Object.keys(nativeApp.canvas.selected_nodes),items:nativeApp.canvas.selectedItems.size,events:proofKeys})`);
  evidence.keyboardGraph = await read(); evidence.keyboardPassed = existsSync(join(proof, 'keyboard-done')) && evidence.keyboardAfter.events.some((event: any) => event.key.toLowerCase() === 'a' && event.ctrl && event.trusted) && evidence.keyboardGraph.selectedNodeIds.length === (evidence.finalGraph.workflow.nodes as any[]).length;
  persist();
  }
  await guest.executeJavaScript(`nativeApp.loadGraphData({nodes:[],links:[],groups:[],config:{},extra:{},version:0.4},true,false,nativeApp.extensionManager.workflow.activeWorkflow).then(()=>{const a=LiteGraph.createNode('EmptyImage'),b=LiteGraph.createNode('CreateVideo'),c=LiteGraph.createNode('SaveVideo');for(const [i,n] of [a,b,c].entries()){nativeApp.rootGraph.add(n);n.pos=[40+i*340,100];}a.connect(0,b,0);b.connect(0,c,0);a.widgets.find(w=>w.name==='width').value=32;a.widgets.find(w=>w.name==='height').value=32;a.widgets.find(w=>w.name==='batch_size').value=24;b.widgets.find(w=>w.name==='fps').value=8;c.widgets.find(w=>w.name==='filename_prefix').value='task10-native-preview';nativeApp.rootGraph.change();nativeApp.canvas.setDirty(true,true);return true;})`);
  await guest.executeJavaScript('nativeApp.canvas.ds.scale=.7;nativeApp.canvas.ds.offset=[60,100];nativeApp.canvas.setDirty(true,true);true');
  await delay(500);
  const video = await host.request(projectId, { type: 'queue_graph', requestId: randomUUID(), expected: (await read()).observation }) as RunView;
  for (let i = 0; i < 150; i++) { const run = await host.request(projectId, { type: 'read_run', runId: video.id }) as RunView; evidence.nativeVideoRun = run; if (['succeeded', 'failed'].includes(run.status)) break; await delay(200); }
  for (let i = 0; i < 100; i++) { const ready = await guest.executeJavaScript(`(()=>{const n=nativeApp.rootGraph.nodes.find(n=>n.type==='SaveVideo');const v=n.videoContainer?.querySelector('video')||document.querySelector('[data-node-id="'+n.id+'"] video')||document.querySelector('video');return !!v?.isConnected&&v.readyState>=2})()`); if (ready) break; await delay(200); }
  evidence.videoBefore = await guest.executeJavaScript(`(()=>{const n=nativeApp.rootGraph.nodes.find(n=>n.type==='SaveVideo');window.proofVideo=n.videoContainer?.querySelector('video')||document.querySelector('[data-node-id="'+n.id+'"] video')||document.querySelector('video');const v=proofVideo;return JSON.parse(JSON.stringify({nodeId:n.id,outputs:nativeApp.nodeOutputs[n.id],widgets:n.widgets?.map(w=>({name:w.name,type:w.type})),visible:document.visibilityState,...(v?{connected:v.isConnected,width:v.videoWidth,height:v.videoHeight,readyState:v.readyState,currentTime:v.currentTime,error:v.error?.code,bounds:v.getBoundingClientRect().toJSON()}: {})}))})()`);
  if (evidence.videoBefore.connected) { await guest.executeJavaScript('proofVideo.play().then(()=>true)', true); await delay(600); evidence.videoAfter = await guest.executeJavaScript('({currentTime:proofVideo.currentTime,paused:proofVideo.paused,readyState:proofVideo.readyState})'); }
  evidence.nativeVideoPassed = evidence.nativeVideoRun.status === 'succeeded' && evidence.videoBefore.connected && evidence.videoAfter && !evidence.videoAfter.paused && evidence.videoAfter.currentTime > evidence.videoBefore.currentTime + .2;
  writeFileSync(join(proof, 'native-video.png'), (await guest.capturePage()).toPNG());
  evidence.passed = (nativeOnly || evidence.modelPassed && evidence.keyboardPassed) && evidence.nativeVideoPassed; persist(); console.log('Native acceptance:', JSON.stringify({ model: evidence.modelPassed, keyboard: evidence.keyboardPassed, video: evidence.nativeVideoPassed }));
  assert(evidence.passed, 'Required native acceptance gate failed; inspect retained evidence');
  await cleanup(); app.exit(0);
}).catch(async error => { console.error(error); evidence.failure = String(error); persist(); writeFileSync(join(proof, 'failure.txt'), String(error.stack ?? error)); await cleanup(); app.exit(1); });
