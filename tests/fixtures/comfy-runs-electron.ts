import { app, BrowserWindow, safeStorage } from 'electron';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { ComfyHost } from '../../src/desktop/comfy-host.js';
import { ProviderSettingsService } from '../../src/desktop/provider-settings.js';
import { projectDirectory } from '../../src/core/paths.js';
import type { AppSnapshot } from '../../src/shared/types.js';
import type { GraphView, RunView } from '../../src/shared/comfy.js';

const root = process.argv[2], proof = projectDirectory(root, '.runtime', 'comfy-runs-proof');
for (const name of ['appData', 'userData', 'sessionData', 'temp', 'crashDumps'] as const) app.setPath(name, projectDirectory(proof, name));
app.setAppLogsPath(projectDirectory(proof, 'logs')); app.commandLine.appendSwitch('disk-cache-dir', projectDirectory(proof, 'cache')); app.disableHardwareAcceleration();
const projectId = 'task-3a-native', project = { id: projectId, root, template: 'comfyui' };
let host: ComfyHost | undefined, window: BrowserWindow | undefined, vendor: Server | undefined;
app.whenReady().then(async () => {
  let textCreates = 0, imageCreates = 0, videoCreates = 0, videoQueries = 0; let fixtureVideo: Buffer, vendorOrigin: string, slowVideos = false;
  const fakeKey = 'FAKE_Task6_PRIVATE_VENDOR_KEY_674033';
  vendor = createServer(async (req, res) => {
    if (req.url === '/fixture.mp4') { assert.equal(req.headers.authorization, undefined); res.end(fixtureVideo); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    assert.equal(req.headers.authorization, `Bearer ${fakeKey}`);
    if (req.method === 'GET') { videoQueries++; res.end(JSON.stringify(slowVideos ? { status: 'running' } : { status: 'succeeded', content: { video_url: vendorOrigin + '/fixture.mp4' } })); return; }
    const body = JSON.parse(raw);
    if (req.url?.endsWith('/contents/generations/tasks')) { assert.equal(body.model, 'native-video-model'); videoCreates++; res.end(JSON.stringify({ id: 'native-video-' + videoCreates })); return; }
    if (req.url?.endsWith('/images/generations')) {
      assert.equal(body.model, 'native-image-model'); assert.equal(body.prompt, 'native text result');
      assert.match(body.image[0], /^data:image\/png;base64,/); imageCreates++;
      res.end(JSON.stringify({ data: [{ b64_json: body.image[0].split(',')[1] }] })); return;
    }
    assert.equal(body.model, 'native-text-model'); textCreates++;
    res.end(JSON.stringify({ choices: [{ message: { content: 'native text result' } }] }));
  });
  await new Promise<void>(done => vendor!.listen(0, '127.0.0.1', done));
  vendorOrigin = `http://127.0.0.1:${(vendor.address() as { port: number }).port}`;
  const owner = {}, snapshot = { projects: [project], selected: { project } } as AppSnapshot;
  const settings = new ProviderSettingsService(safeStorage, () => ({ owner, epoch: 0, snapshot }), (p, id, rev) => host!.assertProviderMutable(p, id, rev), p => { void host?.refreshProviders(p); });
  window = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.loadURL('data:text/html,<title>Native provider proof</title>');
  host = new ComfyHost(window, join(root, 'dist/client/comfy'), join(root, 'dist/client/desktop/comfy-preload.cjs'), settings); host.observe(snapshot);
  const profiles = await settings.handle({ projectId, op: 'save', expectedRevision: 0, input: { name: 'Task6 proof ' + randomUUID(), protocol: 'ark', baseUrl: `http://127.0.0.1:${(vendor.address() as { port: number }).port}`, allowInsecureHttp: true, key: fakeKey, models: { text: 'native-text-model' } } }, () => {});
  const profile = profiles.at(-1)!;
  const read = () => host!.request(projectId, { type: 'read_graph' }) as Promise<GraphView>;
  await read(); const entry = (host as any).entries.get(projectId);
  const catalog = await (await fetch(entry.origin + '/object_info')).json() as any;
  for (const [name, output] of [['MixcatAPIText', 'STRING'], ['MixcatAPIImage', 'IMAGE'], ['MixcatAPIVideo', 'VIDEO']]) {
    assert.deepEqual(catalog[name].output, [output]);
    for (const group of Object.values(catalog[name].input) as Record<string, unknown>[]) for (const key of Object.keys(group)) assert(!['api_key', 'base_url'].includes(key));
  }
  const guest = (code: string) => entry.view.webContents.executeJavaScript(code);
  await host.present(projectId, 1, { x: 0, y: 0, width: 1400, height: 940 });
  await guest(`window.nativeApp=window.comfyAPI.app.app; nativeApp.loadGraphData({nodes:[],links:[],groups:[],config:{},extra:{},version:0.4},true,false,nativeApp.extensionManager.workflow.activeWorkflow).then(()=>true)`);
  await guest(`(()=>{const a=LiteGraph.createNode('MixcatAPIText'),b=LiteGraph.createNode('SaveText'); if(!a||!b)throw Error('native nodes unavailable'); nativeApp.rootGraph.add(a);nativeApp.rootGraph.add(b);a.connect(0,b,0);a.widgets.find(w=>w.name==='connection').value=${JSON.stringify(profile.id + '@' + profile.revision)};a.widgets.find(w=>w.name==='model').value='native-text-model';a.widgets.find(w=>w.name==='prompt').value='hello native';a.widgets.find(w=>w.name==='parameters').value='{}';b.widgets.find(w=>w.name==='filename_prefix').value='task6-text'; return true;})()`);
  await guest('new Promise(requestAnimationFrame).then(()=>new Promise(requestAnimationFrame)).then(()=>true)');
  const run = await host.request(projectId, { type: 'queue_graph', requestId: randomUUID(), expected: (await read()).observation }) as RunView;
  let history: any;
  for (let n = 0; n < 150; n++) { history = (await (await fetch(entry.origin + '/history/' + run.promptId)).json() as any)[run.promptId!]; if (history) break; await new Promise(done => setTimeout(done, 100)); }
  assert(history?.status.completed, JSON.stringify(history)); assert.equal(textCreates, 1);
  const output = Object.values(history.outputs).find((output: any) => output.files) as any;
  assert(output); assert.equal(readFileSync(join(root, '.mixcat/comfy/data/output', output.files[0].subfolder, output.files[0].filename), 'utf8'), 'native text result');
  assert(!JSON.stringify(history).includes(fakeKey));
  assert.equal(entry.runs.job(entry.service.store.providerJobs(run.id)[0].id).text, 'native text result');
  const textResult = await host.request(projectId, { type: 'read_run', runId: run.id }) as RunView;
  assert.equal(textResult.assets.length, 1);
  await guest(`nativeApp.loadGraphData({nodes:[],links:[],groups:[],config:{},extra:{},version:0.4},true,false,nativeApp.extensionManager.workflow.activeWorkflow).then(()=>true)`);
  await guest(`(()=>{const a=LiteGraph.createNode('EmptyImage'),t=LiteGraph.createNode('MixcatAPIText'),b=LiteGraph.createNode('MixcatAPIImage'),c=LiteGraph.createNode('ImageScale'),d=LiteGraph.createNode('SaveImage');for(const n of [a,t,b,c,d])nativeApp.rootGraph.add(n); a.connect(0,b,b.inputs.findIndex(i=>i.name==='images'));t.connect(0,b,b.inputs.findIndex(i=>i.name==='prompt'));b.connect(0,c,0);c.connect(0,d,0);
    for(const n of [t,b]){n.widgets.find(w=>w.name==='connection').value=${JSON.stringify(profile.id + '@' + profile.revision)};n.widgets.find(w=>w.name==='parameters').value='{}';}
    t.widgets.find(w=>w.name==='model').value='native-text-model';t.widgets.find(w=>w.name==='prompt').value='chain';b.widgets.find(w=>w.name==='model').value='native-image-model';a.widgets.find(w=>w.name==='width').value=32;a.widgets.find(w=>w.name==='height').value=32;c.widgets.find(w=>w.name==='width').value=16;c.widgets.find(w=>w.name==='height').value=24;d.widgets.find(w=>w.name==='filename_prefix').value='task6-image';return true;})()`);
  await guest('new Promise(requestAnimationFrame).then(()=>new Promise(requestAnimationFrame)).then(()=>true)');
  const imageRun = await host.request(projectId, { type: 'queue_graph', requestId: randomUUID(), expected: (await read()).observation }) as RunView;
  let imageResult: RunView | undefined;
  for (let n = 0; n < 150; n++) { imageResult = await host.request(projectId, { type: 'read_run', runId: imageRun.id }) as RunView; if (['succeeded', 'failed'].includes(imageResult.status)) break; await new Promise(done => setTimeout(done, 100)); }
  assert.equal(imageResult!.status, 'succeeded', JSON.stringify(await (await fetch(entry.origin + '/history/' + imageRun.promptId)).json()));
  assert.equal(textCreates, 2); assert.equal(imageCreates, 1); assert.equal(imageResult!.assets.length, 1);
  const finalPng = readFileSync(join(root, imageResult!.assets[0].relativePath)); assert.equal(finalPng.readUInt32BE(16), 16); assert.equal(finalPng.readUInt32BE(20), 24);
  const rawImage = entry.service.store.providerJobs(imageRun.id).find((job: any) => job.input.kind === 'image').assets[0];
  assert.notEqual(imageResult!.assets[0].sha256, rawImage.sha256); assert(!finalPng.includes(Buffer.from(fakeKey)));
  assert.deepEqual(imageResult!.recoveredAssets, []);
  const emptyGraph = () => guest(`nativeApp.loadGraphData({nodes:[],links:[],groups:[],config:{},extra:{},version:0.4},true,false,nativeApp.extensionManager.workflow.activeWorkflow).then(()=>true)`);
  const finishGraph = async () => {
    await guest('new Promise(requestAnimationFrame).then(()=>new Promise(requestAnimationFrame)).then(()=>true)');
    const queued = await host!.request(projectId, { type: 'queue_graph', requestId: randomUUID(), expected: (await read()).observation }) as RunView;
    for (let n = 0; n < 300; n++) { const result = await host!.request(projectId, { type: 'read_run', runId: queued.id }) as RunView; if (['succeeded', 'failed'].includes(result.status)) { assert.equal(result.status, 'succeeded', JSON.stringify(await (await fetch(entry.origin + '/history/' + queued.promptId)).json())); return result; } await new Promise(done => setTimeout(done, 100)); }
    throw Error('Native media graph did not finish.');
  };
  await emptyGraph();
  await guest(`(()=>{const a=LiteGraph.createNode('EmptyImage'),b=LiteGraph.createNode('CreateVideo'),c=LiteGraph.createNode('SaveVideo');for(const n of [a,b,c])nativeApp.rootGraph.add(n);a.connect(0,b,0);b.connect(0,c,0);a.widgets.find(w=>w.name==='width').value=32;a.widgets.find(w=>w.name==='height').value=32;a.widgets.find(w=>w.name==='batch_size').value=2;c.widgets.find(w=>w.name==='filename_prefix').value='task6-fixture';return true;})()`);
  const fixtureResult = await finishGraph(); assert.equal(fixtureResult.assets.length, 1); fixtureVideo = readFileSync(join(root, fixtureResult.assets[0].relativePath));
  await emptyGraph();
  await guest(`(()=>{const a=LiteGraph.createNode('MixcatAPIVideo'),b=LiteGraph.createNode('SaveVideo');for(const n of [a,b])nativeApp.rootGraph.add(n);a.connect(0,b,0);a.widgets.find(w=>w.name==='connection').value=${JSON.stringify(profile.id + '@' + profile.revision)};a.widgets.find(w=>w.name==='model').value='native-video-model';a.widgets.find(w=>w.name==='prompt').value='video';a.widgets.find(w=>w.name==='mode').value='text';a.widgets.find(w=>w.name==='parameters').value='{}';b.widgets.find(w=>w.name==='filename_prefix').value='task6-final-video';return true;})()`);
  const videoResult = await finishGraph(); assert.equal(videoCreates, 1); assert.equal(videoQueries, 1); assert.equal(videoResult.assets.length, 1);
  const finalVideo = readFileSync(join(root, videoResult.assets[0].relativePath)); assert(!finalVideo.includes(Buffer.from(fakeKey)));
  const videoHistory = await (await fetch(entry.origin + '/history/' + videoResult.promptId)).json(); assert(!JSON.stringify(videoHistory).includes(fakeKey));
  await guest(`nativeApp.rootGraph.nodes[0].pos=[40,60];nativeApp.rootGraph.nodes[1].pos=[650,60];nativeApp.canvas.ds.scale=0.8;nativeApp.canvas.ds.offset[0]=20;nativeApp.canvas.ds.offset[1]=20;nativeApp.canvas.setDirty(true,true);true`);
  entry.view.webContents.startPainting(); entry.view.webContents.invalidate(); await new Promise(done => setTimeout(done, 300));
  writeFileSync(join(proof, 'native-video.png'), (await entry.view.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
  slowVideos = true;
  const stoppedRun = await host.request(projectId, { type: 'queue_graph', requestId: randomUUID(), expected: (await read()).observation }) as RunView;
  for (let n = 0; n < 100 && !entry.service.store.providerJobs(stoppedRun.id)[0]?.remote; n++) await new Promise(done => setTimeout(done, 50));
  assert.equal(videoCreates, 2, 'unchanged graph with new logical run must not reuse provider cache');
  await assert.rejects(host.close(projectId), /活动运行/); assert.equal((host as any).entries.get(projectId), entry); assert.equal(entry.closed, false);
  await assert.rejects(host.dispose(), /活动运行/);
  assert.equal(host.canClose(projectId), false);
  await emptyGraph();
  await guest(`(()=>{const a=LiteGraph.createNode('MixcatAPIText'),b=LiteGraph.createNode('SaveText');for(const n of [a,b])nativeApp.rootGraph.add(n);a.connect(0,b,0);a.widgets.find(w=>w.name==='connection').value=${JSON.stringify(profile.id + '@' + profile.revision)};a.widgets.find(w=>w.name==='model').value='native-text-model';a.widgets.find(w=>w.name==='prompt').value='successor';a.widgets.find(w=>w.name==='parameters').value='{}';return true;})()`);
  await guest('new Promise(requestAnimationFrame).then(()=>new Promise(requestAnimationFrame)).then(()=>true)');
  const successor = await host.request(projectId, { type: 'queue_graph', requestId: randomUUID(), expected: (await read()).observation }) as RunView;
  await host.request(projectId, { type: 'stop_run', runId: stoppedRun.id, action: 'stop_waiting' });
  let successorResult: RunView | undefined;
  for (let n = 0; n < 150; n++) { successorResult = await host.request(projectId, { type: 'read_run', runId: successor.id }) as RunView; if (['succeeded', 'failed'].includes(successorResult.status)) break; await new Promise(done => setTimeout(done, 100)); }
  assert.equal(successorResult!.status, 'succeeded', 'targeted interrupt must not stop queued successor');
  const stopped = await host.request(projectId, { type: 'read_run', runId: stoppedRun.id }) as RunView;
  assert.equal(stopped.waiting, false); assert.equal(stopped.providerJobs![0].status, 'remote_running');
  slowVideos = false; let recovered: RunView | undefined;
  for (let n = 0; n < 70; n++) { recovered = await entry.runs.reconcile(stoppedRun.id); if (recovered!.recoveredAssets?.length) break; await new Promise(done => setTimeout(done, 100)); }
  assert.equal(recovered!.recoveredAssets?.length, 1); assert.equal(recovered!.assets.length, 0); assert.notEqual(recovered!.status, 'succeeded'); assert.equal(videoCreates, 2);
  const evidence = { passed: true, run, history, textResult, imageResult, rawImage, fixtureResult, videoResult, videoHistory, stopped, successorResult, recovered, textCreates, imageCreates, videoCreates, videoQueries };
  for (const secret of [fakeKey, entry.admissionSecret, entry.broker.token]) {
    assert(!JSON.stringify(evidence).includes(secret)); assert(!finalPng.includes(Buffer.from(secret))); assert(!finalVideo.includes(Buffer.from(secret)));
    for (const directory of ['workflows', 'logs']) for (const name of readdirSync(join(root, '.mixcat/comfy', directory))) assert(!readFileSync(join(root, '.mixcat/comfy', directory, name)).includes(Buffer.from(secret)));
    for (const name of ['state.sqlite', 'state.sqlite-wal']) { try { assert(!readFileSync(join(root, '.mixcat/comfy', name)).includes(Buffer.from(secret))); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
  }
  writeFileSync(join(proof, 'evidence.json'), JSON.stringify(evidence, null, 2));
  await settings.handle({ projectId, op: 'remove', id: profile.id, expectedRevision: profile.revision }, () => {});
  for (let n = 0; n < 100; n++) { if (await guest(`!nativeApp.rootGraph.nodes[0].widgets.find(w=>w.name==='connection').options.values.includes(${JSON.stringify(profile.id + '@' + profile.revision)})`)) break; await new Promise(done => setTimeout(done, 50)); }
  assert.equal(await guest(`nativeApp.rootGraph.nodes[0].widgets.find(w=>w.name==='connection').value`), profile.id + '@' + profile.revision, 'deleted connection must remain visible instead of selecting another');
  assert.equal(await guest(`nativeApp.rootGraph.nodes[0].widgets.find(w=>w.name==='connection').options.values.includes(${JSON.stringify(profile.id + '@' + profile.revision)})`), false);
  await assert.rejects(host.request(projectId, { type: 'queue_graph', requestId: randomUUID(), expected: (await read()).observation }), /未提交/);
  await host.dispose(); host = undefined; vendor.closeAllConnections(); await new Promise<void>(done => vendor!.close(() => done())); window.destroy(); app.quit();
}).catch(async error => { console.error(error); if (host) await host.dispose(true).catch(console.error); vendor?.closeAllConnections(); vendor?.close(); window?.destroy(); app.exit(1); });
