import { app, BrowserWindow, safeStorage } from 'electron';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { ComfyHost } from '../../src/desktop/comfy-host.js';
import { ComfyStore } from '../../src/core/comfy-store.js';
import { ComfyUpdates, workspaceContent, type RuntimeCandidate, type RuntimeSelection } from '../../src/core/comfy-updates.js';
import { projectDirectory } from '../../src/core/paths.js';
import type { AppSnapshot } from '../../src/shared/types.js';
import type { GraphView, ProviderProfile, RunView } from '../../src/shared/comfy.js';
import { ProviderSettingsService } from '../../src/desktop/provider-settings.js';
import { providerSmoke } from './comfy-update-provider-smoke.js';
import { createServer, type Server } from 'node:http';

const root = process.argv[2], projectRoot = process.argv[3], proof = projectDirectory(root, '.runtime', 'task9-native');
for (const name of ['appData', 'userData', 'sessionData', 'temp', 'crashDumps'] as const) app.setPath(name, projectDirectory(projectRoot, '.electron', name));
app.setAppLogsPath(projectDirectory(projectRoot, '.electron', 'logs')); app.commandLine.appendSwitch('disk-cache-dir', projectDirectory(projectRoot, '.electron', 'cache')); app.disableHardwareAcceleration();
const projectId = 'task9-native', project = { id: projectId, root: projectRoot, template: 'comfyui' };
let host: ComfyHost | undefined, window: BrowserWindow | undefined;
let vendor: Server | undefined;
const evidence: Record<string, unknown> = {};
const deadline = setTimeout(() => { console.error('Owned rehearsal deadline exceeded'); void cleanup().finally(() => app.exit(1)); }, 400000);
async function cleanup() { clearTimeout(deadline); await host?.dispose(); vendor?.closeAllConnections(); vendor?.close(); window?.destroy(); }
app.whenReady().then(async () => {
  const oldManifest = JSON.parse(readFileSync(join(root, '.runtime/upstream/comfy042-packages/runtime-manifest.json'), 'utf8'));
  const newManifest = JSON.parse(readFileSync(join(root, 'resources/comfy/runtime-manifest.json'), 'utf8'));
  const store = new ComfyStore(projectRoot, projectId);
  const updates = new ComfyUpdates(store, join(root, 'dist/client/comfy'), { checkpoint: async () => { throw Error('Unused'); }, start: async () => {}, stop: async () => {}, qualify: async () => {} });
  const initial = updates.initialize(oldManifest); evidence.initial = { selection: initial, combination: updates.combination(initial.versionId) }; store.close();
  let fixtureVideo: Buffer = Buffer.alloc(0); let vendorOrigin = '', slowVideo = false; const creates = { ark: 0, minimax: 0, vidu: 0 };
  vendor = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/fixture.mp4') { response.setHeader('Content-Type', 'video/mp4'); response.end(fixtureVideo); return; }
    let raw = ''; for await (const chunk of request) raw += chunk;
    if (request.method === 'GET') { response.end(JSON.stringify(slowVideo ? { state: 'processing' } : { state: 'success', creations: [{ url: vendorOrigin + '/fixture.mp4' }] })); return; }
    if (request.url?.startsWith('/vidu/')) { creates.vidu++; assert.match(request.headers.authorization ?? '', /^Token /); response.end(JSON.stringify({ task_id: 'task9-video-' + creates.vidu })); return; }
    if (request.url?.startsWith('/ark/')) creates.ark++; else creates.minimax++;
    if (request.url?.endsWith('/image_generation')) { const body = JSON.parse(raw); assert.equal(body.model, 'fixture-image'); assert.match(body.subject_reference[0].image_file, /^data:image\/png;base64,/); response.end(JSON.stringify({ data: { image_base64: [body.subject_reference[0].image_file.split(',')[1]] }, metadata: { success_count: 1, failed_count: 0 }, base_resp: { status_code: 0 } })); return; }
    assert.match(request.headers.authorization ?? '', /^Bearer /); assert.equal(JSON.parse(raw).model, 'fixture-text');
    response.end(JSON.stringify({ choices: [{ message: { content: 'qualified provider text' } }] }));
  });
  await new Promise<void>(done => vendor!.listen(0, '127.0.0.1', done)); vendorOrigin = `http://127.0.0.1:${(vendor.address() as { port: number }).port}`;
  const owner = {}, snapshot = { projects: [project], selected: { project } } as AppSnapshot;
  const settings = new ProviderSettingsService(safeStorage, () => ({ owner, epoch: 0, snapshot }), (p, id, revision) => host!.assertProviderMutable(p, id, revision), () => {});
  window = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.loadURL('data:text/html,<title>Two official version rehearsal</title>');
  host = new ComfyHost(window, join(root, 'dist/client/comfy'), join(root, 'dist/client/desktop/comfy-preload.cjs'), settings); host.observe(snapshot);
  const profiles: ProviderProfile[] = [];
  for (const [protocol, name] of [['ark', 'ark'], ['minimax-cn', 'minimax'], ['vidu', 'vidu']] as const) {
    const all = await settings.handle({ projectId, op: 'save', expectedRevision: 0, input: { name: 'Task9 ' + name, protocol, baseUrl: vendorOrigin + '/' + name, allowInsecureHttp: true, key: 'TASK9_FAKE_KEY_ONLY', models: protocol === 'vidu' ? { video: 'viduq3-turbo' } : protocol === 'minimax-cn' ? { image: 'fixture-image' } : { text: 'fixture-text' } } }, () => {});
    profiles.push(all.at(-1)!);
  }
  const read = () => host!.request(projectId, { type: 'read_graph' }) as Promise<GraphView>;
  const entry = () => (host as any).entries.get(projectId);
  const guest = (code: string) => entry().view.webContents.executeJavaScript(code);
  let layout = 10;
  const capture = async (name: string) => {
    await host!.present(projectId, layout++, { x: 0, y: 0, width: 1400, height: 940 }); entry().view.webContents.startPainting(); entry().view.webContents.invalidate(); await new Promise(done => setTimeout(done, 300));
    writeFileSync(join(proof, name + '.png'), (await entry().view.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
  };
  await read(); console.log('official 0.42 native ready');
  evidence.oldHealth = await entry().runtime.health();
  const oldProviders = await providerSmoke(entry(), projectId, projectRoot, profiles, video => { fixtureVideo = video; }, () => { slowVideo = true; }); evidence.oldProviders = oldProviders;
  const makeDriver = (host as any).updateDriver.bind(host); let qualifiedProviders = false;
  (host as any).updateDriver = (id: string) => {
    const driver = makeDriver(id), qualify = driver.qualify;
    driver.qualify = async (selection: RuntimeSelection, combination: any) => {
      try { await qualify(selection, combination); }
      catch (error) { evidence.failedCandidate = await guest(`({ tabs: window.comfyAPI.app.app.extensionManager.workflow.openWorkflows.map(w=>({path:w.path,temporary:w.isTemporary,modified:w.isModified,data:w.changeTracker?.activeState})), local:Object.fromEntries(Object.keys(localStorage).map(k=>[k,localStorage.getItem(k)])) })`); throw error; }
      if (combination.manifest.backend.version === '0.43.0' && !qualifiedProviders) {
        const priorCreates = { ...creates }; slowVideo = false;
        for (let n = 0; n < 100; n++) { const recovered = await entry().runs.reconcile(oldProviders.retained!.id); if (recovered.recoveredAssets?.some((asset: any) => asset.mime.startsWith('video/')) && entry().service.store.providerJobs(oldProviders.retained!.id).filter((job: any) => job.input.kind === 'video').every((job: any) => job.status === 'succeeded')) { evidence.recovered = recovered; break; } await new Promise(done => setTimeout(done, 100)); }
        assert((evidence.recovered as any)?.recoveredAssets.some((asset: any) => asset.mime.startsWith('video/'))); assert.deepEqual(creates, priorCreates, 'retained accepted task must not create again');
        evidence.candidateProviders = await providerSmoke(entry(), projectId, projectRoot, profiles, video => { fixtureVideo = video; }); qualifiedProviders = true;
        await qualify(selection, combination);
      }
    }; return driver;
  };
  await guest(`window.nativeApp=window.comfyAPI.app.app; nativeApp.rootGraph.clear(); nativeApp.rootGraph.add(LiteGraph.createNode('EmptyLatentImage')); nativeApp.rootGraph.nodes[0].title='Upgrade retained draft'; true`);
  await guest(`nativeApp.extensionManager.workflow.saveWorkflow(nativeApp.extensionManager.workflow.activeWorkflow).then(()=>true)`);
  await guest(`nativeApp.loadGraphData({nodes:[],links:[],groups:[],config:{},extra:{},version:0.4},true,false,'Second upgrade tab').then(()=>true)`);
  await guest(`nativeApp.rootGraph.add(LiteGraph.createNode('EmptyImage'));nativeApp.rootGraph.convertToSubgraph(new Set(nativeApp.rootGraph.nodes));window.sub=nativeApp.rootGraph.nodes.find(n=>n.subgraph);nativeApp.canvas.openSubgraph(sub.subgraph,sub);nativeApp.canvas.selectNode(nativeApp.canvas.graph.nodes[0]);true`);
  await new Promise(done => setTimeout(done, 800));
  evidence.debug = await guest(`({ tabs: nativeApp.extensionManager.workflow.openWorkflows.map(w=>({path:w.path,temporary:w.isTemporary,modified:w.isModified,data:w.changeTracker.activeState})), local:Object.fromEntries(Object.keys(localStorage).map(k=>[k,localStorage.getItem(k)])) })`);
  evidence.before = await entry().rpc.snapshotWorkspace(projectId);
  await capture('official042-before');
  const candidate = await host.prepareCandidate(projectRoot, newManifest) as RuntimeCandidate; evidence.candidate = candidate; evidence.afterPrepared = await entry().rpc.snapshotWorkspace(projectId); console.log('official 0.43 candidate qualified');
  const savedTab = (evidence.before as any).tabs.find((tab: any) => !tab.temporary);
  assert(savedTab, 'a genuinely saved native workflow must participate');
  const originalSaved = join(projectRoot, candidate.source.data, 'user', 'default', savedTab.path), checkpointSaved = join(projectRoot, candidate.checkpoint.data, 'user', 'default', savedTab.path);
  assert.deepEqual(readFileSync(originalSaved), readFileSync(checkpointSaved)); assert.equal(Math.trunc(statSync(originalSaved).mtimeMs), Math.trunc(statSync(checkpointSaved).mtimeMs));
  evidence.savedFile = { path: savedTab.path, sha256: createHash('sha256').update(readFileSync(originalSaved)).digest('hex'), originalMtimeMs: statSync(originalSaved).mtimeMs, checkpointMtimeMs: statSync(checkpointSaved).mtimeMs };
  const selected = await host.activateVersion(projectRoot, candidate.selection.versionId) as RuntimeSelection; evidence.selected = selected; evidence.newHealth = await entry().runtime.health(); console.log('official 0.43 activated');
  await capture('official043-active');
  await guest(`window.nativeApp=window.comfyAPI.app.app; nativeApp.loadGraphData({nodes:[],links:[],groups:[],config:{},extra:{},version:0.4},false,false,nativeApp.extensionManager.workflow.activeWorkflow).then(()=>true)`);
  await guest(`(()=>{const a=LiteGraph.createNode('EmptyImage'),b=LiteGraph.createNode('SaveImage');for(const n of [a,b])nativeApp.rootGraph.add(n);a.connect(0,b,0);a.title='Newer retained workflow';a.widgets.find(w=>w.name==='width').value=32;a.widgets.find(w=>w.name==='height').value=32;b.widgets.find(w=>w.name==='filename_prefix').value='task9-after-activation';return true;})()`);
  await new Promise(done => setTimeout(done, 500));
  const newerRun = await host.request(projectId, { type: 'queue_graph', requestId: randomUUID(), expected: (await read()).observation }) as RunView;
  let newerResult: RunView | undefined;
  for (let n = 0; n < 150; n++) { newerResult = await host.request(projectId, { type: 'read_run', runId: newerRun.id }) as RunView; if (['succeeded', 'failed'].includes(newerResult.status)) break; await new Promise(done => setTimeout(done, 100)); }
  assert.equal(newerResult?.status, 'succeeded'); assert.equal(newerResult.assets.length, 1); evidence.newerResult = newerResult;
  const newerBytes = readFileSync(join(projectRoot, newerResult.assets[0].relativePath));
  const history = (await (await fetch(entry().origin + '/history/' + newerRun.promptId)).json() as any)[newerRun.promptId!];
  const image = (Object.values(history.outputs) as any[]).find(value => value.images).images[0]; const newerPath = join(projectRoot, selected.data, image.type, image.subfolder, image.filename);
  evidence.newer = await read();
  const restored = await host.rollbackVersion(projectRoot, initial.versionId) as RuntimeSelection; evidence.restored = restored; evidence.restoredHealth = await entry().runtime.health();
  evidence.after = await entry().rpc.snapshotWorkspace(projectId);
  assert.deepEqual(workspaceContent(evidence.after as any), workspaceContent(evidence.before as any));
  assert.deepEqual(readFileSync(newerPath), newerBytes); assert.deepEqual(readFileSync(join(projectRoot, newerResult.assets[0].relativePath)), newerBytes);
  await capture('official042-rollback');
  console.log('official 0.42 rollback and newer output retention passed');
  evidence.creates = creates; assert.deepEqual(creates, { ark: 3, minimax: 3, vidu: 3 });
  evidence.passed = true; writeFileSync(join(proof, 'evidence.json'), JSON.stringify(evidence, null, 2));
  await cleanup(); app.exit(0);
}).catch(async error => { console.error(error); evidence.error = String(error); writeFileSync(join(proof, 'evidence.json'), JSON.stringify(evidence, null, 2)); try { await cleanup(); } catch (cleanupError) { console.error(cleanupError); } app.exit(1); });
