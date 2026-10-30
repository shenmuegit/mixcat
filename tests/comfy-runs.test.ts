import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { projectDirectory } from '../src/core/paths.js';
import { ComfyStore } from '../src/core/comfy-store.js';
import { ComfyRuns } from '../src/core/comfy-runs.js';
import { ComfyProviders } from '../src/core/comfy-providers.js';
import type { ProviderProfile } from '../src/shared/comfy.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { ComfyBroker } from '../src/desktop/comfy-broker.js';
import { ProviderSettingsService } from '../src/desktop/provider-settings.js';
import type { AppSnapshot } from '../src/shared/types.js';
import { ComfyService } from '../src/core/comfy-service.js';
import { deferred, until } from './runtime-fixture.js';

const profile: ProviderProfile = { id: 'connection', name: 'Test', protocol: 'ark', baseUrl: 'https://example.invalid', revision: 1, credentialRevision: 1, configured: true, models: { text: 'text-model', image: 'image-model', video: 'video-model' } };
function fixture(kind: 'text' | 'image' | 'video' = 'text', model = `${kind}-model`) {
  const root = mkdtempSync(join(projectDirectory(resolve('.'), '.runtime', 'implementation', 'fixtures'), 'comfy-runs-'));
  const store = new ComfyStore(root, 'p');
  store.beginOperation('queue', 'queue');
  const submission = store.stageRun('queue', { projectId: 'p', instanceId: 'i', workflowId: 'w', tabId: 't', revision: 'r' }, {
    client_id: 'native', prompt: { '1': { class_type: `MixcatAPI${kind[0].toUpperCase()}${kind.slice(1)}`, inputs: { connection: 'connection@1', model, prompt: 'hello', parameters: '{}', ...(kind === 'video' ? { mode: 'text' } : {}) } } },
    extra_data: { comfy_usage_source: 'comfyui-frontend', extra_pnginfo: { workflow: { nodes: [] } } }
  }, { kind: 'user' });
  store.finishSubmission('queue', { status: 200, body: { prompt_id: submission.run.promptId } });
  const ownedProfile = structuredClone(profile);
  const credentials = { list: () => [ownedProfile], withCredential: async <T>(_id: string, _revision: number, fn: (value: { profile: ProviderProfile; key: string }) => Promise<T>) => fn({ profile: ownedProfile, key: 'fake-only-key' }) };
  const request = { instanceId: 'i', promptId: submission.run.promptId!, nodeId: '1', sequence: 0, connectionId: profile.id, connectionRevision: 1, kind, model, mode: 'text' as const, prompt: 'hello', parameters: {} };
  return { root, store, credentials, request, profile: ownedProfile };
}

test('run-list refresh observes native completion without an explicit run read', async () => {
  const f=fixture(),runs=new ComfyRuns(f.store,f.credentials);let inspections=0;
  runs.attachNative({queue:async()=>{throw Error('not used');},stop:async()=>{},inspect:async()=>{inspections++;return {status:'succeeded'};}});
  try { const id=runs.list().runs[0].id;assert.equal(runs.list().runs[0].status,'queued'); await until(()=>runs.list(undefined,id).selectedRun?.status==='succeeded'); assert.equal(runs.list().runs[0].status,'succeeded');assert.equal(inspections,1); }
  finally {await runs.close();f.store.close();}
});
test('native final collection uses the run instance generation and keeps immutable assets after selection changes', async () => {
  const f = fixture(), runs = new ComfyRuns(f.store, f.credentials);
  const old = projectDirectory(f.root, '.mixcat', 'comfy', 'g', 'old', 'data', 'output');
  const next = projectDirectory(f.root, '.mixcat', 'comfy', 'g', 'new', 'data', 'output');
  writeFileSync(join(old, 'result.txt'), 'old-generation-result'); writeFileSync(join(next, 'result.txt'), 'new-generation-result');
  f.store.saveRuntimeRecords({ 'instance-data:i': '.mixcat/comfy/g/old/data', selection: { data: '.mixcat/comfy/g/new/data' } });
  runs.attachNative({ data: '.mixcat/comfy/g/new/data', queue: async () => { throw Error('unused'); }, stop: async () => {}, inspect: async () => ({ status: 'succeeded', outputs: { '1': { files: [{ filename: 'result.txt', subfolder: '', type: 'output' }] } } }) });
  try {
    const result = await runs.read(runs.recent()[0].id); assert.equal(result.assets.length, 1);
    assert.equal(readFileSync(join(f.root, result.assets[0].relativePath), 'utf8'), 'old-generation-result');
    writeFileSync(join(old, 'result.txt'), 'later overwrite');
    assert.equal(readFileSync(join(f.root, result.assets[0].relativePath), 'utf8'), 'old-generation-result');
  } finally { await runs.close(); f.store.close(); }
});

test('automatic native refresh is coalesced and bounded without restarting stopped waits', async () => {
  const f=fixture(),runs=new ComfyRuns(f.store,f.credentials),gate=deferred();let inspections=0;
  for(let i=0;i<6;i++){const key=`extra-${i}`;f.store.beginOperation(key,key);const staged=f.store.stageRun(key,{projectId:'p',instanceId:'i',workflowId:'w',tabId:'t',revision:'r'},{client_id:'native',prompt:{'1':{class_type:'EmptyImage',inputs:{}}},extra_data:{comfy_usage_source:'comfyui-frontend',extra_pnginfo:{workflow:{nodes:[]}}}},{kind:'user'});f.store.finishSubmission(key,{status:200,body:{prompt_id:staged.run.promptId}});}
  runs.attachNative({queue:async()=>{throw Error('not used');},stop:async()=>{},inspect:async()=>{inspections++;await gate.promise;return {};}});
  try {
    const stopped=runs.recent()[0].id;await runs.stop(stopped,'stop_waiting');
    const page=runs.list(undefined,stopped);assert.equal(page.selectedRun?.waiting,false);assert.equal(inspections,4);
    for(let i=0;i<5;i++)runs.list();assert.equal(inspections,4);assert.equal(runs.recent().find(run=>run.id===stopped)?.waiting,false);
    let closed=false;const closing=runs.close().then(()=>{closed=true;});await new Promise(done=>setImmediate(done));assert.equal(closed,false);gate.resolve();await closing;assert.equal(closed,true);
  } finally {gate.resolve();await runs.close();f.store.close();}
});
test('suspending a lost native owner immediately marks unfinished runs for reconciliation', async () => {
  const f = fixture(), runs = new ComfyRuns(f.store, f.credentials);
  try {
    runs.suspend(); const run = runs.recent()[0];
    assert.equal(run.status, 'needs_reconciliation'); assert.equal(run.waiting, false);
    assert.equal(run.promptId, f.request.promptId); assert.equal(runs.canClose(), true);
  } finally { await runs.close(); f.store.close(); }
});

test('close drains all remote acceptances and retains failed writes for recovery without creating again', async t => {
  const f=fixture('video'),responses:ServerResponse[]=[];let creates=0;
  await vendor(t,f,(_request,response)=>{creates++;responses.push(response);});
  const runs=new ComfyRuns(f.store,f.credentials),save=f.store.saveProviderJob.bind(f.store);
  const first=await runs.submit(f.request);await until(()=>responses.length===1);const second=await runs.submit({...f.request,sequence:1});await until(()=>responses.length===2);
  runs.suspend();let unhealthy=true;const privateMarker='PRIVATE_ACCEPTANCE_STORAGE_DETAIL';
  f.store.saveProviderJob=job=>{if(unhealthy&&job.id===first.jobId)throw Error(privateMarker);save(job);};
  let settled=false;const closing=runs.close().then(()=>{settled=true;return null;},error=>{settled=true;return error;});
  try {
    responses[0].end(JSON.stringify({id:'accepted-once-a'}));await until(()=>runs.activeOperations().inFlight===1);
    assert.equal(settled,false,'one failed acceptance must not short-circuit the other admitted create');
    responses[1].end(JSON.stringify({id:'accepted-once-b'}));const failure=await closing;
    assert(failure instanceof Error,'close must reject an accepted identity that is not durable');assert(!String(failure).includes(privateMarker));
    await assert.rejects(runs.close());assert.equal(f.store.providerJob(first.jobId)!.remote,undefined);
    assert.notEqual(runs.job(first.jobId).failure?.code,'network_error');
    assert(!JSON.stringify(runs.job(first.jobId)).includes('accepted-once-a'));
    unhealthy=false;await runs.close();await runs.close();
    assert.equal(f.store.providerJob(first.jobId)!.remote?.id,'accepted-once-a');assert.equal(f.store.providerJob(second.jobId)!.remote?.id,'accepted-once-b');
    assert.equal(f.store.providerJob(first.jobId)!.waiting,false);assert.equal(creates,2);
    const reopened=new ComfyStore(f.root,'p');try{assert.equal(reopened.providerJob(first.jobId)!.remote?.id,'accepted-once-a');assert.equal(reopened.providerJob(second.jobId)!.remote?.id,'accepted-once-b');}finally{reopened.close();}
  } finally {unhealthy=false;for(const response of responses)if(!response.writableEnded)response.end(JSON.stringify({id:'cleanup-accepted'}));await closing;await runs.close();f.store.close();}
});

test('a failed owner-loss save fences new provider work before the store is repaired',async()=>{
  const f=fixture('video');let creates=0;const providers={submitVideo:async()=>{creates++;return {protocol:'ark-video',id:'must-not-create'};}} as unknown as ComfyProviders;
  const runs=new ComfyRuns(f.store,f.credentials,providers),update=f.store.updateRun.bind(f.store);
  f.store.updateRun=()=>{throw Error('fixture unavailable store');};
  try {assert.throws(()=>runs.suspend(),/持久保存/);await assert.rejects(runs.submit(f.request),/closed/);await assert.rejects(runs.stop(f.store.runForPrompt(f.request.promptId)!.id,'stop_waiting'),/closed/);assert.equal(creates,0);}
  finally{f.store.updateRun=update;runs.suspend();await runs.close();f.store.close();}
});

test('close retains a confirmed cancellation across failed persistence without cancelling again', async t => {
  const f=fixture('video');f.profile.protocol='vidu';let creates=0,cancels=0,cancelResponse:ServerResponse|undefined;
  await vendor(t,f,(request,response)=>{if(request.url?.endsWith('/cancel')){cancels++;cancelResponse=response;}else{creates++;response.end(JSON.stringify({task_id:'cancelled-known-remote'}));}});
  const runs=new ComfyRuns(f.store,f.credentials),save=f.store.saveProviderJob.bind(f.store);const accepted=await runs.submit(f.request);await runs.drain();
  const stopping=runs.stopJob(accepted.jobId,'cancel_remote').then(()=>null,error=>error);await until(()=>!!cancelResponse);
  let unhealthy=true;f.store.saveProviderJob=job=>{if(unhealthy&&job.cancelOutcome)throw Error('PRIVATE_CANCEL_STORAGE_DETAIL');save(job);};
  const closing=runs.close().then(()=>null,error=>error);
  try {
    cancelResponse!.end('{}');assert(await stopping instanceof Error);const failure=await closing;assert(failure instanceof Error);assert(!String(failure).includes('PRIVATE_CANCEL_STORAGE_DETAIL'));
    await assert.rejects(runs.close());assert.notEqual(f.store.providerJob(accepted.jobId)!.cancelOutcome,'cancelled');
    unhealthy=false;await runs.close();const durable=f.store.providerJob(accepted.jobId)!;assert.equal(durable.cancelOutcome,'cancelled');assert.equal(durable.status,'cancelled');assert.equal(durable.remote?.id,'cancelled-known-remote');assert.equal(durable.waiting,false);assert.equal(creates,1);assert.equal(cancels,1);
    const reopened=new ComfyStore(f.root,'p');try{assert.equal(reopened.providerJob(accepted.jobId)!.cancelOutcome,'cancelled');}finally{reopened.close();}
  } finally {unhealthy=false;if(!cancelResponse!.writableEnded)cancelResponse!.end('{}');await stopping;await closing;await runs.close();f.store.close();}
});

test('close waits for an admitted cancellation still awaiting its native stop', async t => {
  const f=fixture('video');f.profile.protocol='vidu';let cancels=0;
  await vendor(t,f,(request,response)=>{if(request.url?.endsWith('/cancel')){cancels++;response.end('{}');}else response.end(JSON.stringify({task_id:'deferred-native-stop'}));});
  const runs=new ComfyRuns(f.store,f.credentials),native=deferred(),entered=deferred();const accepted=await runs.submit(f.request);await runs.drain();
  runs.attachNative({queue:async()=>{throw Error('unused');},inspect:async()=>({}),stop:async()=>{entered.resolve();await native.promise;}});
  const stopping=runs.stopJob(accepted.jobId,'cancel_remote');await entered.promise;let closed=false;const closing=runs.close().then(()=>{closed=true;});
  try {await new Promise(done=>setImmediate(done));assert.equal(closed,false,'accepted control must drain even before vendor cancellation begins');native.resolve();await stopping;await closing;assert.equal(cancels,1);assert.equal(f.store.providerJob(accepted.jobId)!.cancelOutcome,'cancelled');}
  finally{native.resolve();await stopping;await closing;f.store.close();}
});

for(const [boundary,nativeStatus] of [['updateRun','succeeded'],['registerArtifact','succeeded'],['updateRun','running']] as const)test(`native ${nativeStatus} ${boundary} failure remains consequential until its known output is durable`,async()=>{
  const f=fixture(),runs=new ComfyRuns(f.store,f.credentials),entered=deferred(),release=deferred();let inspections=0,failedWrites=0,unhealthy=true;
  const output=projectDirectory(f.root,'.mixcat','comfy','data','output');writeFileSync(join(output,'known.txt'),'known native output');
  runs.attachNative({queue:async()=>{throw Error('unused');},stop:async()=>{},inspect:async()=>{inspections++;entered.resolve();await release.promise;return {status:nativeStatus,outputs:{'1':{files:[{filename:'known.txt',subfolder:'',type:'output'}]}}};}});
  const id=runs.list().runs[0].id;await entered.promise;await runs.stop(id,'stop_waiting');const original=f.store[boundary].bind(f.store);
  (f.store as any)[boundary]=(...args:any[])=>{if(unhealthy){failedWrites++;throw Error('PRIVATE_NATIVE_WRITE');}return (original as any)(...args);};
  try {
    release.resolve();await until(()=>failedWrites>0);await assert.rejects(runs.close(),error=>!String(error).includes('PRIVATE_NATIVE_WRITE'));await assert.rejects(runs.close());
    const copies=readdirSync(join(f.root,'.mixcat','comfy','artifacts'));unhealthy=false;const healed=runs.close();assert.equal(runs.close(),healed);await healed;
    const durable=f.store.getRun(id)!;assert.equal(durable.status,nativeStatus==='running'?'needs_reconciliation':nativeStatus);assert.equal(durable.waiting,false);assert.equal(durable.assets.length,1);assert.deepEqual(f.store.artifact(id,durable.assets[0].id),durable.assets[0]);assert.equal(inspections,1);assert.deepEqual(readdirSync(join(f.root,'.mixcat','comfy','artifacts')),copies);
    const reopened=new ComfyStore(f.root,'p');try{assert.deepEqual(reopened.getRun(id)!.assets,durable.assets);}finally{reopened.close();}
  } finally {unhealthy=false;release.resolve();await runs.close();f.store.close();}
});

test('observational native-history failure alone does not prevent a fully drained close',async()=>{
  const f=fixture(),runs=new ComfyRuns(f.store,f.credentials),entered=deferred(),release=deferred();
  runs.attachNative({queue:async()=>{throw Error('unused');},stop:async()=>{},inspect:async()=>{entered.resolve();await release.promise;throw Error('offline native history');}});
  try {runs.list();await entered.promise;const closing=runs.close();release.resolve();await closing;assert.equal(f.store.activeRuns().length,1);}
  finally {release.resolve();await runs.close();f.store.close();}
});
async function vendor(t: test.TestContext, f: ReturnType<typeof fixture>, handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler); await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }));
  f.profile.baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

test('accepted native text persists before create and replay never creates twice', async t => {
  const f = fixture(); const providers = new ComfyProviders(f.root); let posts = 0;
  await vendor(t, f, (_req, res) => { posts++; assert.equal(f.store.providerJobs()[0].status, 'submitting'); res.end(JSON.stringify({ choices: [{ message: { content: 'native result' } }] })); });
  const runs = new ComfyRuns(f.store, f.credentials, providers);
  try {
    const [job, concurrent] = await Promise.all([runs.submit(f.request), runs.submit(f.request)]); assert.equal(job.jobId, concurrent.jobId);
    await runs.drain();
    assert.equal(runs.job(job.jobId).text, 'native result');
    assert.deepEqual(await runs.submit(f.request), { jobId: job.jobId, status: 'succeeded' });
    await assert.rejects(runs.submit({ ...f.request, prompt: 'different' }), /conflict|冲突/);
    assert.equal(posts, 1);
  } finally { await runs.close(); f.store.close(); }
});

test('accepted later nodes outlive admission deadline and persist the actual configured default model', async t => {
  const f = fixture('text', ''); let posts = 0;
  await vendor(t, f, async (req, res) => { let body = ''; for await (const chunk of req) body += chunk; assert.equal(JSON.parse(body).model, 'text-model'); posts++; res.end(JSON.stringify({ choices: [{ message: { content: 'later node' } }] })); });
  const runs = new ComfyRuns(f.store, f.credentials);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() }); t.mock.timers.tick(60000);
  try {
    const job = await runs.submit(f.request); await runs.drain();
    assert.equal(runs.job(job.jobId).status, 'succeeded'); assert.equal(f.store.providerJob(job.jobId)!.input.model, 'text-model'); assert.equal(posts, 1);
  } finally { await runs.close(); f.store.close(); }
});

test('accepted image source survives failed download and reopening without regenerating', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = fixture('image'); let posts = 0, transfers = 0, available = false;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6pFkAAAAASUVORK5CYII=', 'base64');
  await vendor(t, f, (req, res) => {
    if (req.method === 'POST') { posts++; res.end(JSON.stringify({ data: [{ url: f.profile.baseUrl + '/image.png' }] })); }
    else { transfers++; assert(f.store.providerJobs()[0].sources?.length, 'private source must precede transfer'); if (!available) { res.writeHead(503); res.end(); } else res.end(png); }
  });
  let store = f.store, runs = new ComfyRuns(store, f.credentials);
  const accepted = await runs.submit(f.request); await runs.drain();
  assert.equal(runs.job(accepted.jobId).status, 'needs_reconciliation');
  assert.equal(JSON.stringify(runs.job(accepted.jobId)).includes('/image.png'), false);
  await runs.close(); store.close();
  t.mock.timers.tick(5000);
  store = new ComfyStore(f.root, 'p'); f.store = store; available = true; runs = new ComfyRuns(store, f.credentials);
  try {
    await Promise.all([runs.read(store.providerJob(accepted.jobId)!.runId), runs.read(store.providerJob(accepted.jobId)!.runId)]);
    assert.equal(runs.job(accepted.jobId).status, 'succeeded'); assert.equal(runs.job(accepted.jobId).assets[0].bytes, png.length);
    assert.equal(posts, 1); assert.equal(transfers, 2);
    assert.deepEqual(store.getRun(store.providerJob(accepted.jobId)!.runId)!.assets, [], 'vendor intermediate is not a final native graph result');
  } finally { await runs.close(); store.close(); }
});

test('lost provider acceptance remains uncertain across reopening without a second create', async t => {
  const f = fixture(); const providers = new ComfyProviders(f.root); let posts = 0;
  await vendor(t, f, (req) => { posts++; req.socket.destroy(); });
  let runs = new ComfyRuns(f.store, f.credentials, providers);
  const job = await runs.submit(f.request); await runs.drain();
  assert.equal(runs.job(job.jobId).status, 'submission_unknown');
  assert.throws(() => runs.assertMutable(profile.id, 1), /使用|引用/);
  runs.assertMutable('unrelated', 1);
  await runs.close(); f.store.close();
  const reopened = new ComfyStore(f.root, 'p'); runs = new ComfyRuns(reopened, f.credentials, providers);
  try { await runs.reconcile(reopened.providerJobs()[0].runId); assert.equal((await runs.submit(f.request)).status, 'submission_unknown'); assert.equal(posts, 1); }
  finally { await runs.close(); reopened.close(); }
});

test('local broker authenticates instance and accepted prompt ownership before a real text request', async t => {
  const f = fixture(); let posts = 0;
  await vendor(t, f, (_req, res) => { posts++; res.end(JSON.stringify({ choices: [{ message: { content: 'through broker' } }] })); });
  const runs = new ComfyRuns(f.store, f.credentials), broker = new ComfyBroker(runs, 'i');
  const connection = await broker.start();
  const headers = { Authorization: `Bearer ${connection.token}`, 'X-Mixcat-Instance': 'i', 'X-Mixcat-Prompt': f.request.promptId, 'Content-Type': 'application/json' };
  try {
    assert.equal((await fetch(connection.origin + '/v1/connections')).status, 403);
    assert.equal((await fetch(connection.origin + '/v1/connections', { headers: { ...headers, 'X-Mixcat-Instance': 'foreign' } })).status, 403);
    const metadata = await (await fetch(connection.origin + '/v1/connections', { headers })).json();
    assert.equal(JSON.stringify(metadata).includes('fake-only-key'), false);
    assert.equal((await fetch(connection.origin + '/v1/jobs', { method: 'POST', headers, body: JSON.stringify({ ...f.request, promptId: 'foreign' }) })).status, 400);
    const accepted = await (await fetch(connection.origin + '/v1/jobs', { method: 'POST', headers, body: JSON.stringify(f.request) })).json() as { jobId: string };
    await runs.drain();
    assert.equal((await (await fetch(connection.origin + '/v1/jobs/' + accepted.jobId, { headers })).json() as { text: string }).text, 'through broker');
    assert.equal((await fetch(connection.origin + '/v1/jobs/' + accepted.jobId, { headers: { ...headers, 'X-Mixcat-Prompt': 'foreign' } })).status, 400);
    const input = join(projectDirectory(f.root, '.mixcat', 'comfy', 'data', 'input'), 'reference.png');
    writeFileSync(input, Buffer.from('89504e470d0a1a0a', 'hex'));
    for (const relativePath of ['../outside.png', input, '.mixcat/comfy/state.sqlite']) assert.equal((await fetch(connection.origin + '/v1/artifacts', { method: 'POST', headers, body: JSON.stringify({ relativePath }) })).status, 400);
    const artifact = await (await fetch(connection.origin + '/v1/artifacts', { method: 'POST', headers, body: JSON.stringify({ relativePath: '.mixcat/comfy/data/input/reference.png' }) })).json() as { id: string };
    assert.equal((await fetch(connection.origin + '/v1/artifacts/' + artifact.id, { headers })).status, 200);
    writeFileSync(input, 'changed'); assert.equal((await fetch(connection.origin + '/v1/artifacts/' + artifact.id, { headers })).status, 400);
    assert.equal(posts, 1);
  } finally { await broker.close(); await runs.close(); f.store.close(); }
});

test('closing drains accepted video identity and cannot start another create', async t => {
  const f = fixture('video'); let reply!: () => void, received!: () => void, posts = 0;
  const reached = new Promise<void>(resolve => { received = resolve; });
  await vendor(t, f, (_req, res) => { posts++; reply = () => res.end(JSON.stringify({ id: 'accepted-during-close' })); received(); });
  const runs = new ComfyRuns(f.store, f.credentials);
  const job = await runs.submit(f.request); await reached;
  runs.suspend(); const closing = runs.close();
  await assert.rejects(runs.submit({ ...f.request, sequence: 1 }), /closed/);
  reply(); await closing;
  assert.equal(f.store.providerJob(job.jobId)!.remote!.id, 'accepted-during-close'); assert.equal(runs.job(job.jobId).waiting, false); assert.equal(posts, 1);
  f.store.close();
});

test('image partial acceptance uncertainty survives transfer failure and later recovery', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = fixture('image'); let available = false, posts = 0;
  await vendor(t, f, (req, res) => {
    if (req.method === 'POST') { posts++; res.end(JSON.stringify({ data: [{ url: f.profile.baseUrl + '/image.png' }, { error: { code: 'InternalError' } }] })); }
    else if (available) res.end(Buffer.from('89504e470d0a1a0a', 'hex')); else { res.writeHead(503); res.end(); }
  });
  const runs = new ComfyRuns(f.store, f.credentials);
  try {
    const job = await runs.submit(f.request); await runs.drain(); assert.equal(runs.job(job.jobId).status, 'needs_reconciliation');
    available = true; t.mock.timers.tick(5000); await runs.read(f.store.providerJob(job.jobId)!.runId);
    assert.equal(runs.job(job.jobId).status, 'submission_unknown'); assert.equal(runs.job(job.jobId).assets.length, 1); assert.equal(posts, 1);
  } finally { await runs.close(); f.store.close(); }
});

test('expired video source refreshes by querying the same remote task without another create', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = fixture('video'); let posts = 0, queries = 0;
  await vendor(t, f, (req, res) => {
    if (req.method === 'POST') { posts++; res.end(JSON.stringify({ id: 'refresh-source' })); }
    else if (req.url === '/old.mp4') { res.writeHead(403); res.end(); }
    else if (req.url === '/fresh.mp4') res.end(Buffer.from('00000018667479706d703432000000006d70343269736f6d', 'hex'));
    else { queries++; res.end(JSON.stringify({ status: 'succeeded', content: { video_url: f.profile.baseUrl + (queries === 1 ? '/old.mp4' : '/fresh.mp4') } })); }
  });
  const runs = new ComfyRuns(f.store, f.credentials);
  try {
    const job = await runs.submit(f.request); await runs.drain(); const runId = f.store.providerJob(job.jobId)!.runId;
    t.mock.timers.tick(5000); await runs.read(runId); assert.equal(runs.job(job.jobId).status, 'needs_reconciliation');
    t.mock.timers.tick(5000); await runs.read(runId); assert.equal(runs.job(job.jobId).status, 'succeeded'); assert.equal(posts, 1); assert.equal(queries, 2);
  } finally { await runs.close(); f.store.close(); }
});

test('terminal video failure without a vendor code remains a terminal failure', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() }); const f = fixture('video');
  await vendor(t, f, (req, res) => res.end(JSON.stringify(req.method === 'POST' ? { id: 'failed-task' } : { id: 'failed-task', status: 'failed', error: {} })));
  const runs = new ComfyRuns(f.store, f.credentials);
  try { const job = await runs.submit(f.request); await runs.drain(); t.mock.timers.tick(5000); await runs.read(f.store.providerJob(job.jobId)!.runId); assert.equal(runs.job(job.jobId).status, 'failed', JSON.stringify(runs.job(job.jobId))); assert.equal(runs.job(job.jobId).rawStatus, 'failed'); }
  finally { await runs.close(); f.store.close(); }
});

test('known video survives stop waiting and service reopen; only queries resume and downloads stay intermediate', async t => {
  const f = fixture('video'); let posts = 0, queries = 0; let complete = false;
  const mp4 = Buffer.from('00000018667479706d703432000000006d70343269736f6d', 'hex');
  await vendor(t, f, (req, res) => {
    if (req.method === 'POST') { posts++; res.end(JSON.stringify({ id: 'known-video' })); }
    else if (req.url === '/result.mp4') res.end(mp4);
    else { queries++; res.end(JSON.stringify(complete ? { id: 'known-video', status: 'succeeded', content: { video_url: f.profile.baseUrl + '/result.mp4' } } : { id: 'known-video', status: 'running' })); }
  });
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  let store = f.store, runs = new ComfyRuns(store, f.credentials);
  const reference = { id: 'registered-reference', relativePath: '.runtime/reference.png', bytes: 8, sha256: '0'.repeat(64), mime: 'image/png' };
  store.registerArtifact(store.runForPrompt(f.request.promptId)!.id, reference);
  await assert.rejects(runs.submit({ ...f.request, mode: 'image', references: [reference] }), /mode conflict/);
  const accepted = await runs.submit(f.request); await runs.drain();
  assert.equal(runs.job(accepted.jobId).status, 'remote_running');
  assert.equal(queries, 0); const runId = store.providerJob(accepted.jobId)!.runId;
  await runs.stop(runId, 'stop_waiting'); assert.equal(runs.job(accepted.jobId).waiting, false);
  assert.throws(() => runs.assertMutable(profile.id, 1), /引用/);
  await runs.close(); store.close();
  t.mock.timers.tick(5000); complete = true; store = new ComfyStore(f.root, 'p'); runs = new ComfyRuns(store, f.credentials);
  try {
    const [recovered] = await Promise.all([runs.read(runId), runs.read(runId)]);
    assert.equal(runs.job(accepted.jobId).status, 'succeeded'); assert.equal(posts, 1); assert.equal(queries, 1);
    assert.equal(recovered.recoveredAssets?.length, 1); assert.notEqual(recovered.status, 'succeeded'); assert.deepEqual(recovered.assets, []);
    runs.assertMutable(profile.id, 1);
  } finally { await runs.close(); store.close(); }
});

test('video polling honors bounded Retry-After and 24h reconciliation without resubmission', async t => {
  const f = fixture('video'); let posts = 0, queries = 0;
  await vendor(t, f, (req, res) => {
    if (req.method === 'POST') { posts++; res.end(JSON.stringify({ id: 'rate-limited' })); }
    else { queries++; if (queries === 1) { res.writeHead(429, { 'Retry-After': '120' }); res.end('{}'); } else res.end(JSON.stringify({ status: 'running' })); }
  });
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const runs = new ComfyRuns(f.store, f.credentials);
  try {
    const accepted = await runs.submit(f.request); await runs.drain(); const runId = f.store.providerJob(accepted.jobId)!.runId;
    await runs.reconcile(runId); assert.equal(queries, 0);
    t.mock.timers.tick(5000); await runs.reconcile(runId); assert.equal(queries, 1);
    assert.equal(f.store.providerJob(accepted.jobId)!.nextPollAt, Date.now() + 60000);
    t.mock.timers.tick(59000); await runs.reconcile(runId); assert.equal(queries, 1);
    t.mock.timers.tick(1000); await runs.reconcile(runId); assert.equal(queries, 2); assert.equal(runs.job(accepted.jobId).rawStatus, 'running');
    t.mock.timers.tick(86400000); await runs.reconcile(runId); assert.equal(runs.job(accepted.jobId).status, 'needs_reconciliation'); assert.equal(queries, 2);
    await runs.reconcile(runId); assert.equal(queries, 3); assert.equal(posts, 1);
  } finally { await runs.close(); f.store.close(); }
});

test('remote cancellation distinguishes confirmed cancellation from terminal record deletion', async t => {
  for (const protocol of ['vidu', 'minimax-global'] as const) {
    const f = fixture('video'); f.profile.protocol = protocol; let creates = 0, cancellations = 0;
    await vendor(t, f, (req, res) => {
      if (req.url?.endsWith('/cancel')) { cancellations++; res.end('{}'); }
      else if (req.method === 'DELETE') { cancellations++; res.end(JSON.stringify({ action: 'deleted' })); }
      else if (req.method === 'POST') { creates++; res.end(JSON.stringify({ id: 'cancel-task', task_id: 'cancel-task', base_resp: { status_code: 0 } })); }
      else res.end(JSON.stringify({ task: { status: 'queued' }, base_resp: { status_code: 0 } }));
    });
    const runs = new ComfyRuns(f.store, f.credentials);
    try {
      const job = await runs.submit(f.request); await runs.drain();
      const runId = f.store.providerJob(job.jobId)!.runId;
      const stopped = await runs.stop(runId, 'cancel_remote');
      assert.equal(creates, 1); assert.equal(cancellations, 1);
      assert.equal(runs.job(job.jobId).status, protocol === 'vidu' ? 'cancelled' : 'needs_reconciliation');
      assert.equal(stopped.providerJobs![0].cancelOutcome, protocol === 'vidu' ? 'cancelled' : 'record_deleted');
      assert.equal(stopped.waiting, false);
    } finally { await runs.close(); f.store.close(); }
  }
});

test('actual settings guard blocks queued and uncertain references while unrelated/background connections remain usable', async t => {
  const f = fixture(); await vendor(t, f, req => req.socket.destroy());
  const project = { id: 'p', root: f.root, template: 'comfyui' }, other = { id: 'other', root: f.root, template: 'comfyui' };
  const snapshot = { projects: [project, other], selected: { project } } as AppSnapshot;
  let runs: ComfyRuns;
  const owner = {};
  const settings = new ProviderSettingsService({ isAsyncEncryptionAvailable: async () => true, encryptStringAsync: async value => Buffer.from(value), decryptStringAsync: async value => ({ result: value.toString(), shouldReEncrypt: false }) }, () => ({ owner, epoch: 0, snapshot }), (_p, id, rev) => runs.assertMutable(id, rev));
  const input = { name: 'Pinned', protocol: 'ark' as const, baseUrl: f.profile.baseUrl, key: 'fake-guard-key', models: { text: 'text-model' }, allowInsecureHttp: true };
  const pinned = (await settings.handle({ projectId: 'p', op: 'save', input, expectedRevision: 0 }, () => {}))[0];
  const free = (await settings.handle({ projectId: 'p', op: 'save', input: { ...input, name: 'Free' }, expectedRevision: 0 }, () => {}))[1];
  runs = new ComfyRuns(f.store, { list: () => settings.listForProject('p'), withCredential: (id, rev, action) => settings.withCredential('p', id, rev, action) });
  const original = f.store.submission('queue')!;
  f.store.beginOperation('guard', 'guard'); const payload = structuredClone(original.payload); delete payload.prompt_id;
  (payload.prompt['1'] as { inputs: { connection: string } }).inputs.connection = `${pinned.id}@1`;
  const staged = f.store.stageRun('guard', original.run.observation, payload, { kind: 'user' });
  f.store.finishSubmission('guard', { status: 200, body: { prompt_id: staged.run.promptId } });
  try {
    await assert.rejects(settings.handle({ projectId: 'p', op: 'remove', id: pinned.id, expectedRevision: 1 }, () => {}), /引用/);
    await settings.handle({ projectId: 'p', op: 'save', input: { ...input, id: free.id, name: 'Still usable' }, expectedRevision: 1 }, () => {});
    snapshot.selected!.project = other as AppSnapshot['projects'][number];
    assert.equal(settings.listForProject('p').length, 2);
    await assert.rejects(settings.handle({ projectId: 'p', op: 'list' }, () => {}), /失效/);
    const accepted = await runs.submit({ ...f.request, promptId: staged.run.promptId!, connectionId: pinned.id }); await runs.drain();
    assert.equal(runs.job(accepted.jobId).status, 'submission_unknown');
    f.store.updateRun(staged.run.id, { status: 'failed' }); snapshot.selected!.project = project as AppSnapshot['projects'][number];
    await assert.rejects(settings.handle({ projectId: 'p', op: 'remove', id: pinned.id, expectedRevision: 1 }, () => {}), /引用/);
  } finally { await runs.close(); f.store.close(); }
});

test('service stop waiting persists before a deferred recovery read finishes', { timeout: 10000 }, async t => {
  const f = fixture('video'); let queryReached!: () => void, releaseQuery = () => {};
  const reached = new Promise<void>(resolve => { queryReached = resolve; });
  await vendor(t, f, (req, res) => {
    if (req.method === 'POST') res.end(JSON.stringify({ id: 'deferred-read' }));
    else { releaseQuery = () => res.end(JSON.stringify({ status: 'running' })); queryReached(); }
  });
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const runs = new ComfyRuns(f.store, f.credentials), service = new ComfyService(f.store, async () => { throw Error('Unexpected graph read'); }, undefined, runs);
  const job = await runs.submit(f.request); await runs.drain(); const runId = f.store.providerJob(job.jobId)!.runId;
  t.mock.timers.tick(5000);
  const reading = service.handle('p', { type: 'read_run', runId }, { kind: 'user' }); await reached;
  const current = runs.recent().find(run => run.id === runId)!;
  assert.equal(current.providerJobs![0].status, 'remote_running', 'lightweight summary reads persisted current status without waiting for recovery');
  const stop = { type: 'stop_run' as const, runId, action: 'stop_waiting' as const };
  await assert.rejects(service.handle('foreign', stop, { kind: 'user' }), /身份冲突/);
  await assert.rejects(service.handle('p', stop, { kind: 'user' }, Date.now() - 1), /超时/);
  await assert.rejects(service.handle('p', { ...stop, action: 'invalid' } as never, { kind: 'user' }));
  assert.equal(runs.job(job.jobId).waiting, true);
  const stopping = service.handle('p', { type: 'stop_run', runId, action: 'stop_waiting' }, { kind: 'user' }); void stopping.catch(() => {});
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(runs.job(job.jobId).waiting, false, 'stop must persist while recovery HTTP is still pending');
    t.mock.timers.tick(31000);
    assert.equal((await stopping as { waiting: boolean }).waiting, false);
  } finally { releaseQuery(); await Promise.allSettled([reading, stopping]); await runs.close(); await service.close(); }
});

for (const failedSave of [false, true]) test(`service drains deferred cancellation ${failedSave ? 'and retains its failed persistence' : 'before closing the ledger'}`, { timeout: 10000 }, async t => {
  const f = fixture('video'); f.profile.protocol = 'vidu';
  let queryReached!: () => void, cancelReached!: () => void, releaseQuery = () => {}, releaseCancel = () => {};
  const queryStarted = new Promise<void>(resolve => { queryReached = resolve; }), cancelStarted = new Promise<void>(resolve => { cancelReached = resolve; });
  await vendor(t, f, (req, res) => {
    if (req.url?.endsWith('/cancel')) { releaseCancel = () => res.end('{}'); cancelReached(); }
    else if (req.method === 'POST') res.end(JSON.stringify({ task_id: 'deferred-cancel' }));
    else { releaseQuery = () => res.end(JSON.stringify({ state: 'processing' })); queryReached(); }
  });
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const runs = new ComfyRuns(f.store, f.credentials), service = new ComfyService(f.store, async () => { throw Error('Unexpected graph read'); }, undefined, runs);
  const job = await runs.submit(f.request); await runs.drain(); const runId = f.store.providerJob(job.jobId)!.runId;
  t.mock.timers.tick(5000);
  const reading = service.handle('p', { type: 'read_run', runId }, { kind: 'user' }); await queryStarted;
  const stopping = service.handle('p', { type: 'stop_run', runId, action: 'cancel_remote' }, { kind: 'user' }); void stopping.catch(() => {});
  let closing: Promise<void> | undefined, closed = false;
  const save = f.store.saveProviderJob.bind(f.store);
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(runs.job(job.jobId).status, 'cancel_requested', 'cancel intent must precede the pending query response');
    closing = service.close().then(() => { closed = true; });
    releaseQuery(); await reading; await cancelStarted;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(closed, false, 'close must drain the bypassed control even after the read tail settles');
    assert.equal(runs.job(job.jobId).status, 'cancel_requested');
    if (failedSave) f.store.saveProviderJob = value => { if (value.cancelOutcome) throw Error('fixture cancel persistence'); save(value); };
    releaseCancel();
    if (failedSave) { await assert.rejects(stopping); await assert.rejects(closing); assert(f.store.getRun(runId)); f.store.saveProviderJob = save; closing = service.close(); }
    else await stopping;
    await closing;
    const reopened = new ComfyStore(f.root, 'p');
    try { assert.equal(reopened.providerJob(job.jobId)!.status, 'cancelled'); assert.equal(reopened.providerJob(job.jobId)!.cancelOutcome, 'cancelled'); } finally { reopened.close(); }
  } finally { f.store.saveProviderJob = save; releaseQuery(); releaseCancel(); void cancelStarted.then(() => releaseCancel()); await Promise.allSettled([reading, stopping]); await runs.close(); if (closing) await closing; else await service.close(); }
});

test('service stop bypasses graph work and close retains the ledger through a deferred native control response', { timeout: 10000 }, async () => {
  const f = fixture(); const runs = new ComfyRuns(f.store, f.credentials);
  let graphEntered!: () => void, nativeEntered!: () => void, releaseGraph!: () => void, releaseNative!: () => void;
  const graphStarted = new Promise<void>(resolve => { graphEntered = resolve; }), nativeStarted = new Promise<void>(resolve => { nativeEntered = resolve; });
  const graphGate = new Promise<void>(resolve => { releaseGraph = resolve; }), nativeGate = new Promise<void>(resolve => { releaseNative = resolve; });
  const run = f.store.runForPrompt(f.request.promptId)!;
  runs.attachNative({ queue: async () => { throw Error('Unexpected queue'); }, inspect: async () => ({}), stop: async () => { nativeEntered(); await nativeGate; } });
  const service = new ComfyService(f.store, async () => { graphEntered(); await graphGate; return { observation: run.observation, workflow: { nodes: [] }, subgraphPath: [], selectedNodeIds: [] }; }, undefined, runs);
  const reading = service.handle('p', { type: 'read_graph' }, { kind: 'user' }); void reading.catch(() => {}); await graphStarted;
  const stopping = service.handle('p', { type: 'stop_run', runId: run.id, action: 'stop_waiting' }, { kind: 'user' }); void stopping.catch(() => {});
  let closing: Promise<void> | undefined, closed = false;
  try {
    await nativeStarted; assert.equal(f.store.getRun(run.id)!.waiting, false);
    closing = service.close().then(() => { closed = true; }); releaseGraph(); await assert.rejects(reading, /关闭/);
    await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(closed, false); assert.equal(f.store.getRun(run.id)!.waiting, false);
    releaseNative(); assert.equal((await stopping as { waiting: boolean }).waiting, false); await closing;
    await assert.rejects(service.handle('p', { type: 'stop_run', runId: run.id, action: 'stop_waiting' }, { kind: 'user' }), /关闭/);
  } finally { releaseGraph(); releaseNative(); await Promise.allSettled([reading, stopping]); await runs.close(); if (closing) await closing; else await service.close(); }
});
