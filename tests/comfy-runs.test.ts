import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
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

test('service registers cancel before deferred recovery and drains its late result before closing the ledger', { timeout: 10000 }, async t => {
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
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(runs.job(job.jobId).status, 'cancel_requested', 'cancel intent must precede the pending query response');
    closing = service.close().then(() => { closed = true; });
    releaseQuery(); await reading; await cancelStarted;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(closed, false, 'close must drain the bypassed control even after the read tail settles');
    assert.equal(runs.job(job.jobId).status, 'cancel_requested');
    releaseCancel(); await stopping; await closing;
    const reopened = new ComfyStore(f.root, 'p');
    try { assert.equal(reopened.providerJob(job.jobId)!.status, 'cancelled'); assert.equal(reopened.providerJob(job.jobId)!.cancelOutcome, 'cancelled'); } finally { reopened.close(); }
  } finally { releaseQuery(); releaseCancel(); void cancelStarted.then(() => releaseCancel()); await Promise.allSettled([reading, stopping]); await runs.close(); if (closing) await closing; else await service.close(); }
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
