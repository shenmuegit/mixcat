import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { projectDirectory } from '../src/core/paths.js';
import { ComfyProviders, ProviderError, type AuthorizedConnection } from '../src/core/comfy-providers.js';

const fakeKey = 'FAKE-provider-secret-155';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6pFkAAAAASUVORK5CYII=', 'base64');
async function fixture(t: test.TestContext, handler: (request: IncomingMessage, response: ServerResponse, body: any) => void) {
  const root = mkdtempSync(join(projectDirectory(resolve('.'), '.runtime', 'comfy-provider-tests'), 'project-'));
  const server = createServer(async (req, res) => {
    const parts: Buffer[] = []; for await (const chunk of req) parts.push(Buffer.from(chunk));
    const text = Buffer.concat(parts).toString();
    handler(req, res, text ? JSON.parse(text) : undefined);
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }));
  const address = server.address(); assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const connection = (protocol: AuthorizedConnection['profile']['protocol'], prefix = ''): AuthorizedConnection => ({
    profile: { id: 'connection-1', name: 'Fixture', protocol, baseUrl: origin + prefix,
      revision: 1, credentialRevision: 1, configured: true, models: { text: 'custom-text', image: 'image-01', video: 'custom-video' } }, key: fakeKey,
  });
  return { root, origin, connection, client: new ComfyProviders(root) };
}
function json(res: ServerResponse, body: unknown, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }

test('Ark and MiniMax text use their own paths, preserve prefixes/model IDs and redact echoed credentials', async t => {
  const seen: unknown[] = [];
  const f = await fixture(t, (req, res, body) => {
    seen.push({ method: req.method, path: req.url, auth: req.headers.authorization, body });
    json(res, { choices: [{ message: { content: `hello ${fakeKey}` } }] });
  });
  for (const [protocol, prefix] of [['ark', '/gateway/api/v3'], ['minimax-cn', '/v1'], ['minimax-global', '/gateway']] as const) {
    assert.equal(await f.client.generateText(f.connection(protocol, prefix), { messages: [{ role: 'user', content: 'hello' }] }), 'hello [redacted]');
  }
  assert.deepEqual(seen, [
    { method: 'POST', path: '/gateway/api/v3/chat/completions', auth: `Bearer ${fakeKey}`, body: { model: 'custom-text', messages: [{ role: 'user', content: 'hello' }], stream: false } },
    { method: 'POST', path: '/v1/chat/completions', auth: `Bearer ${fakeKey}`, body: { model: 'custom-text', messages: [{ role: 'user', content: 'hello' }], stream: false } },
    { method: 'POST', path: '/gateway/v1/chat/completions', auth: `Bearer ${fakeKey}`, body: { model: 'custom-text', messages: [{ role: 'user', content: 'hello' }], stream: false } },
  ]);
});

for (const protocol of ['ark', 'minimax-cn', 'minimax-global', 'vidu'] as const) {
  test(`${protocol}: rejection, malformed acceptance, redirection, cancellation and create timeout retain safe outcomes`, async t => {
    let scenario = '401', requests = 0;
    let entered: (() => void) | undefined;
    const f = await fixture(t, (req, res) => {
      requests++; entered?.();
      if (scenario === 'hang') return;
      if (scenario === 'disconnect') { res.destroy(); return; }
      if (scenario === 'malformed') { res.end('{'); return; }
      if (scenario === 'missing-id') { json(res, { echoed: fakeKey }); return; }
      if (scenario === 'redirect') { res.writeHead(307, { Location: f.origin + '/steal' }); res.end(); return; }
      if (scenario === 'business') { json(res, protocol === 'vidu' ? { code: 400, reason: 'BadRequest', message: fakeKey } : { error: { code: 'InvalidParameter', message: fakeKey } }); return; }
      const status = Number(scenario); res.setHeader('Retry-After', '12');
      json(res, { error: { code: 'RateLimit', message: `${fakeKey} https://private.invalid/?signature=secret` } }, status);
    });
    const connection = f.connection(protocol);
    const create = (signal?: AbortSignal, client = f.client) => client.submitVideo(connection, { mode: 'text', prompt: 'cat' }, signal);
    const check = (code: string, outcome: string, status?: number) => (error: unknown) => {
      assert(error instanceof ProviderError); assert.equal(error.detail.code, code); assert.equal(error.detail.outcome, outcome);
      if (status) assert.equal(error.detail.httpStatus, status);
      assert(!JSON.stringify(error).includes(fakeKey)); assert(!error.message.includes('signature')); return true;
    };
    await assert.rejects(create(), check('http_error', 'rejected', 401));
    scenario = '429';
    await assert.rejects(create(), (error: ProviderError) => { check('http_error', 'rejected', 429)(error); assert.equal(error.detail.retryAfterSeconds, 12); assert.equal(error.detail.vendorCode, 'RateLimit'); return true; });
    scenario = '500'; await assert.rejects(create(), check('http_error', 'submission_unknown', 500));
    scenario = 'business'; await assert.rejects(create(), check('vendor_error', 'rejected', 200));
    scenario = 'malformed'; await assert.rejects(create(), check('malformed_response', 'submission_unknown'));
    scenario = 'missing-id'; await assert.rejects(create(), check('malformed_response', 'submission_unknown'));
    scenario = 'disconnect'; await assert.rejects(create(), check('network_error', 'submission_unknown'));
    scenario = 'redirect'; const beforeRedirect = requests;
    await assert.rejects(create(), check('http_error', 'submission_unknown', 307)); assert.equal(requests, beforeRedirect + 1);
    const already = new AbortController(); already.abort(fakeKey); const beforeAbort = requests;
    await assert.rejects(create(already.signal), check('aborted', 'not_submitted')); assert.equal(requests, beforeAbort);
    scenario = 'hang'; const controller = new AbortController();
    const reached = new Promise<void>(done => { entered = done; }); const pending = create(controller.signal);
    await reached; entered = undefined; controller.abort(new Error(fakeKey));
    await assert.rejects(pending, check('aborted', 'submission_unknown'));
    await assert.rejects(create(undefined, new ComfyProviders(f.root, { createMs: 100 })), check('timeout', 'submission_unknown'));
    const taskProtocol = protocol === 'ark' ? 'ark-video' : protocol === 'vidu' ? 'vidu-video' : 'minimax-video-v2';
    await assert.rejects(new ComfyProviders(f.root, { queryMs: 100 }).queryVideo(connection, { protocol: taskProtocol, id: 'known-task' }), check('timeout', 'remote_task_retained'));
    assert.equal(requests, 11);
  });
  test(`${protocol}: known video source survives download failure, redirect, abort and timeout for a later download retry`, async t => {
    let scenario = 'failed', creates = 0;
    let entered: (() => void) | undefined;
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(20)]);
    const f = await fixture(t, (req, res) => {
      if (req.url === '/result.mp4?signature=private') {
        assert.equal(req.headers.authorization, undefined); entered?.();
        if (scenario === 'hang') return;
        if (scenario === 'redirect') { res.writeHead(302, { Location: f.origin + '/steal' }); res.end(); return; }
        if (scenario === 'key-echo') { res.end(Buffer.concat([mp4, Buffer.from(fakeKey)])); return; }
        if (scenario === 'failed') { res.end(fakeKey); return; }
        res.end(mp4); return;
      }
      if (req.url === '/steal') { assert.fail('media redirect must not be followed'); }
      if (req.method === 'POST') { creates++; json(res, { id: 'task', task_id: 'task' }); return; }
      const url = f.origin + '/result.mp4?signature=private';
      json(res, protocol === 'ark' ? { id: 'task', status: 'succeeded', content: { video_url: url } }
        : protocol === 'vidu' ? { id: 'task', state: 'success', creations: [{ url }] }
        : { task: { id: 'task', status: 'succeeded', content: { url } } });
    });
    const connection = f.connection(protocol), task = await f.client.submitVideo(connection, { mode: 'text', prompt: 'cat' });
    const state = await f.client.queryVideo(connection, task); assert.equal(state.status, 'succeeded');
    const source = state.sources![0], persisted = JSON.parse(JSON.stringify(source));
    const check = (code: string) => (error: ProviderError) => {
      assert.equal(error.detail.code, code); assert.equal(error.detail.outcome, 'output_source_retained');
      assert(!JSON.stringify(error).includes(fakeKey)); assert(!JSON.stringify(error).includes('signature')); return true;
    };
    await assert.rejects(f.client.materialize(connection, source), check('download_failed'));
    scenario = 'redirect'; await assert.rejects(f.client.materialize(connection, source), check('download_failed'));
    scenario = 'key-echo'; await assert.rejects(f.client.materialize(connection, source), check('download_failed'));
    scenario = 'hang'; const controller = new AbortController();
    const reached = new Promise<void>(done => { entered = done; }); const pending = f.client.materialize(connection, source, controller.signal);
    await reached; entered = undefined; controller.abort(fakeKey); await assert.rejects(pending, check('aborted'));
    await assert.rejects(new ComfyProviders(f.root, { downloadMs: 25 }).materialize(connection, source), check('timeout'));
    scenario = 'success'; const artifact = await f.client.materialize(connection, persisted);
    assert.equal(artifact.mime, 'video/mp4'); assert.deepEqual(readFileSync(join(f.root, artifact.relativePath)), mp4);
    assert.equal(creates, 1); assert.equal(readdirSync(join(f.root, '.mixcat/comfy/provider-artifacts')).length, 1);
    assert(!JSON.stringify(artifact).includes('signature'));
  });
}

test('MiniMax image character references, counts, business errors and base64 results remain distinct from Ark', async t => {
  const seen: any[] = []; let scenario = 'partial';
  const f = await fixture(t, (req, res, body) => {
    seen.push({ path: req.url, auth: req.headers.authorization, body });
    if (scenario === 'business') json(res, { base_resp: { status_code: 1004, status_msg: fakeKey } });
    else if (scenario === 'counts') json(res, { data: { image_urls: [] }, metadata: { success_count: '1', failed_count: '0' }, base_resp: { status_code: 0 } });
    else json(res, { data: { image_base64: [png.toString('base64')] }, metadata: { success_count: '1', failed_count: body.n === 2 ? '1' : '0' }, base_resp: { status_code: 0 } });
  });
  const connection = f.connection('minimax-cn', '/gateway/v1');
  writeFileSync(join(f.root, 'input.png'), png);
  const reference = { id: 'input', relativePath: 'input.png', mime: 'image/png', sha256: createHash('sha256').update(png).digest('hex'), bytes: png.length };
  const response = await f.client.generateImage(connection, { prompt: 'portrait', references: [reference], n: 2, aspectRatio: '1:1' });
  assert.equal(response.sources.length, 1); assert.equal(response.failures.length, 1);
  const artifact = await f.client.materialize(connection, response.sources[0]); assert.deepEqual(readFileSync(join(f.root, artifact.relativePath)), png);
  assert.deepEqual(seen[0], { path: '/gateway/v1/image_generation', auth: `Bearer ${fakeKey}`, body: { model: 'image-01', prompt: 'portrait', n: 2, response_format: 'url', aspect_ratio: '1:1', subject_reference: [{ type: 'character', image_file: 'data:image/png;base64,' + png.toString('base64') }] } });
  await f.client.generateImage(connection, { prompt: 'portrait' }); assert.equal(seen[1].body.n, 1);
  scenario = 'business'; await assert.rejects(f.client.generateImage(connection, { prompt: 'portrait' }), (error: ProviderError) => error.detail.vendorCode === '1004' && !JSON.stringify(error).includes(fakeKey));
  scenario = 'counts'; await assert.rejects(f.client.generateImage(connection, { prompt: 'portrait' }), (error: ProviderError) => error.detail.code === 'malformed_response');
});

test('accepted image sources survive malformed sibling items and count metadata for durable download recovery', async t => {
  let provider = 'ark';
  const f = await fixture(t, (_req, res) => json(res, provider === 'ark'
    ? { data: [{ b64_json: png.toString('base64') }, { url: 'broken vendor URL' }] }
    : { data: { image_base64: [png.toString('base64')] }, metadata: { success_count: '2', failed_count: '0' }, base_resp: { status_code: 0 } }));
  for (const protocol of ['ark', 'minimax-cn'] as const) {
    provider = protocol;
    const response = await f.client.generateImage(f.connection(protocol), { prompt: 'cat' });
    assert.equal(response.sources.length, 1); assert.equal(response.failures[0].code, 'malformed_response');
    assert.equal(response.failures[0].outcome, 'submission_unknown');
    const artifact = await f.client.materialize(f.connection(protocol), response.sources[0]);
    assert.deepEqual(readFileSync(join(f.root, artifact.relativePath)), png);
  }
});

test('media enforces 64MiB image and 512MiB video limits from headers and streamed bytes, cleans partial files', async t => {
  const f = await fixture(t, (req, res) => {
    if (req.url === '/large-image') { res.writeHead(200, { 'Content-Length': 64 * 1024 * 1024 + 1 }); res.flushHeaders(); return; }
    if (req.url === '/large-video') { res.writeHead(200, { 'Content-Length': 512 * 1024 * 1024 + 1 }); res.flushHeaders(); return; }
    res.write(png); res.end(Buffer.alloc(64 * 1024 * 1024));
  });
  const connection = f.connection('ark');
  for (const [path, kind] of [['/large-image', 'image'], ['/large-video', 'video'], ['/chunked-image', 'image']] as const) {
    await assert.rejects(f.client.materialize(connection, { kind, url: f.origin + path }), (error: ProviderError) => error.detail.code === 'media_too_large' && error.detail.outcome === 'output_source_retained');
    assert.deepEqual(readdirSync(join(f.root, '.mixcat/comfy/provider-artifacts')), []);
  }
});

test('reference modes use Ark reference_image roles and Vidu arrays, malformed and foreign artifacts never reach HTTP', async t => {
  const seen: any[] = [];
  const f = await fixture(t, (req, res, body) => { seen.push({ path: req.url, body }); json(res, { id: 'task', task_id: 'task' }); });
  writeFileSync(join(f.root, 'input.png'), png);
  const reference = { id: 'input', relativePath: 'input.png', mime: 'image/png', sha256: createHash('sha256').update(png).digest('hex'), bytes: png.length };
  const ark = f.connection('ark'); ark.profile.models.video = 'doubao-seedance-2-0-260128';
  const vidu = f.connection('vidu'); vidu.profile.models.video = 'viduq3-turbo';
  await f.client.submitVideo(ark, { mode: 'reference', prompt: 'two cats', images: [reference, reference], duration: 5 });
  await f.client.submitVideo(vidu, { mode: 'reference', prompt: 'two cats', images: [reference, reference], duration: 5 });
  assert.equal(seen[0].path, '/api/v3/contents/generations/tasks');
  assert.deepEqual(seen[0].body.content.slice(1), [
    { type: 'image_url', image_url: { url: 'data:image/png;base64,' + png.toString('base64') }, role: 'reference_image' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,' + png.toString('base64') }, role: 'reference_image' },
  ]);
  assert.equal(seen[1].path, '/ent/v2/reference2video'); assert.equal(seen[1].body.images.length, 2);
  for (const invalid of [{ ...reference, relativePath: '../outside.png' }, { ...reference, sha256: 'b'.repeat(64) }, { ...reference, bytes: 2 }, { ...reference, mime: 'image/jpeg' }]) {
    await assert.rejects(f.client.submitVideo(ark, { mode: 'image', prompt: 'cat', images: [invalid] }), (error: ProviderError) => error.detail.outcome === 'not_submitted');
  }
  await assert.rejects(f.client.submitVideo(vidu, { mode: 'reference', prompt: 'cat', images: Array(8).fill(reference) }), ProviderError);
  assert.equal(seen.length, 2);
});

test('unrecognized provider states, mixed protocol responses and uncertain business errors cannot become success or retry-safe', async t => {
  let body: unknown = {};
  const f = await fixture(t, (_req, res) => json(res, body));
  for (const protocol of ['ark', 'minimax-cn', 'vidu'] as const) {
    const connection = f.connection(protocol);
    body = protocol === 'ark' ? { id: 'task', status: 'new-vendor-state', content: { video_url: f.origin + '/private' } }
      : protocol === 'vidu' ? { id: 'task', state: fakeKey, creations: [{ url: f.origin + '/private' }] }
      : { task: { id: 'task', status: 'new-vendor-state', content: { url: f.origin + '/private' } } };
    const state = await f.client.queryVideo(connection, { protocol: protocol === 'ark' ? 'ark-video' : protocol === 'vidu' ? 'vidu-video' : 'minimax-video-v2', id: 'task' });
    assert.equal(state.status, 'unknown'); assert.equal(state.sources, undefined); assert(!JSON.stringify(state).includes(fakeKey));
    body = { error: { code: 'InternalError', message: fakeKey } };
    await assert.rejects(f.client.submitVideo(connection, { mode: 'text', prompt: 'cat' }), (error: ProviderError) => error.detail.outcome === 'submission_unknown');
    body = { id: 9007199254740992, task_id: 9007199254740992 };
    await assert.rejects(f.client.submitVideo(connection, { mode: 'text', prompt: 'cat' }), (error: ProviderError) => error.detail.code === 'malformed_response' && error.detail.outcome === 'submission_unknown');
  }
  const mini = f.connection('minimax-cn'); body = { id: 'task', status: 'succeeded', content: { video_url: f.origin + '/private' } };
  await assert.rejects(f.client.queryVideo(mini, { protocol: 'minimax-video-v2', id: 'task' }), (error: ProviderError) => error.detail.code === 'malformed_response' && error.detail.outcome === 'remote_task_retained');
  await assert.rejects(f.client.queryVideo(mini, { protocol: 'ark-video', id: 'task' }), (error: ProviderError) => error.detail.outcome === 'not_submitted');
});

test('terminal task errors remain failed states with safe codes, including Ark top-level error and MiniMax V1 states', async t => {
  let body: unknown;
  const f = await fixture(t, (_req, res) => json(res, body));
  body = { id: 'task', status: 'failed', error: { code: 'ContentRejected', message: fakeKey } };
  const failed = await f.client.queryVideo(f.connection('ark'), { protocol: 'ark-video', id: 'task' });
  assert.equal(failed.status, 'failed'); assert.equal(failed.error?.vendorCode, 'ContentRejected'); assert(!JSON.stringify(failed).includes(fakeKey));
  const mini = f.connection('minimax-cn'); mini.profile.videoApi = 'v1';
  for (const [raw, status] of [['Preparing', 'queued'], ['Queueing', 'queued'], ['Processing', 'running'], ['Fail', 'failed'], ['succeeded', 'unknown']] as const) {
    body = { task_id: 'task', status: raw, base_resp: { status_code: 0 } };
    assert.equal((await f.client.queryVideo(mini, { protocol: 'minimax-video-v1', id: 'task' })).status, status);
  }
});

test('known video model limits reject unsupported modes/options before HTTP while custom IDs reach the service unchanged', async t => {
  let calls = 0;
  const f = await fixture(t, (_req, res) => { calls++; json(res, { task_id: 'task-id', id: 'task-id', base_resp: { status_code: 0 } }); });
  const mini = f.connection('minimax-cn'); mini.profile.models.video = 'MiniMax-H3-Highspeed';
  await assert.rejects(f.client.submitVideo(mini, { mode: 'text', prompt: 'cat', resolution: '2K', duration: 5, aspectRatio: '16:9' }), (error: ProviderError) => error.detail.outcome === 'not_submitted');
  await assert.rejects(f.client.submitVideo(mini, { mode: 'text', prompt: 'cat', resolution: '768P', duration: 3, aspectRatio: '16:9' }), ProviderError);
  await assert.rejects(f.client.submitVideo(mini, { mode: 'text', prompt: 'cat' }), ProviderError);
  const vidu = f.connection('vidu'); vidu.profile.models.video = 'viduq3-turbo';
  await assert.rejects(f.client.submitVideo(vidu, { mode: 'text', prompt: 'cat', duration: 17 }), ProviderError);
  const ark = f.connection('ark'); ark.profile.models.video = 'doubao-seedance-1-0-pro-250528';
  await assert.rejects(f.client.submitVideo(ark, { mode: 'text', prompt: 'cat', duration: 13 }), ProviderError);
  assert.equal(calls, 0);
  mini.profile.models.video = 'custom-unlisted-endpoint';
  assert.equal((await f.client.submitVideo(mini, { mode: 'text', prompt: 'cat' })).id, 'task-id'); assert.equal(calls, 1);
});

test('known Ark image model sizes/reference limits and unsupported image seed fail before creating a request', async t => {
  let calls = 0;
  const f = await fixture(t, (_req, res) => { calls++; json(res, { data: [{ b64_json: png.toString('base64') }] }); });
  const connection = f.connection('ark'); connection.profile.models.image = 'doubao-seedream-5-0-pro-260628';
  for (const size of ['4K', '512x512', '9000x15']) await assert.rejects(f.client.generateImage(connection, { prompt: 'cat', size }), ProviderError);
  await assert.rejects(f.client.generateImage(connection, { prompt: 'cat', seed: 7 }), ProviderError);
  assert.equal(calls, 0);
  await f.client.generateImage(connection, { prompt: 'cat', size: '2048x1024' }); assert.equal(calls, 1);
});

test('local artifact storage failures retain the source with a sanitized machine-readable outcome', async t => {
  const f = await fixture(t, () => { assert.fail('storage rejection must happen before download'); });
  writeFileSync(join(f.root, '.mixcat'), 'blocked');
  const source = { kind: 'image' as const, url: f.origin + '/output.png?signature=private' };
  await assert.rejects(f.client.materialize(f.connection('ark'), source), (error: ProviderError) => {
    assert.equal(error.detail.code, 'download_failed'); assert.equal(error.detail.outcome, 'output_source_retained');
    assert(!error.message.includes(f.root)); assert(!JSON.stringify(error).includes('signature')); return true;
  });
  assert.equal(source.url, f.origin + '/output.png?signature=private');
  assert.throws(() => new ComfyProviders('C:/'), /非 C/);
});

test('Vidu refused cancellation retains observed remote state and never reports success', async t => {
  const f = await fixture(t, (req, res) => json(res, req.method === 'POST'
    ? { code: 400, reason: 'BadRequest', message: fakeKey }
    : { id: 'task', state: 'processing' }));
  const result = await f.client.cancelVideo(f.connection('vidu'), { protocol: 'vidu-video', id: 'task' });
  assert.equal(result.outcome, 'not_cancellable'); assert.equal(result.state?.status, 'running'); assert(!JSON.stringify(result).includes(fakeKey));
});

test('cancellation distinguishes confirmed cancellation, running task, deleted record and ambiguous Ark DELETE race', async t => {
  let status = 'queued', action = 'cancelled', arkDeleted = false;
  const seen: any[] = [];
  const f = await fixture(t, (req, res, body) => {
    seen.push({ path: req.url, method: req.method, body });
    if (req.url?.includes('/api/v3/')) {
      if (req.method === 'DELETE') { arkDeleted = true; json(res, {}); }
      else if (arkDeleted && action === 'deleted') json(res, {}, 404);
      else json(res, { id: 'task-id', status: arkDeleted ? 'cancelled' : status });
    } else if (req.url?.includes('/v2/query/')) json(res, { task: { id: 'task-id', status } });
    else if (req.method === 'DELETE') json(res, { task_id: 'task-id', action });
    else json(res, {});
  });
  const ark = f.connection('ark');
  assert.equal((await f.client.cancelVideo(ark, { protocol: 'ark-video', id: 'task-id' })).outcome, 'cancelled');
  arkDeleted = false; action = 'deleted';
  assert.equal((await f.client.cancelVideo(ark, { protocol: 'ark-video', id: 'task-id' })).outcome, 'unknown');
  arkDeleted = false; status = 'running';
  const before = seen.length;
  assert.equal((await f.client.cancelVideo(ark, { protocol: 'ark-video', id: 'task-id' })).outcome, 'not_cancellable');
  assert.equal(seen.length, before + 1);
  const minimax = f.connection('minimax-cn'); status = 'queued';
  assert.equal((await f.client.cancelVideo(minimax, { protocol: 'minimax-video-v2', id: 'task-id' })).outcome, 'record_deleted');
  action = 'cancelled';
  assert.equal((await f.client.cancelVideo(minimax, { protocol: 'minimax-video-v2', id: 'task-id' })).outcome, 'cancelled');
  const vidu = f.connection('vidu');
  assert.equal((await f.client.cancelVideo(vidu, { protocol: 'vidu-video', id: 'task-id' })).outcome, 'cancelled');
  assert.deepEqual(seen.at(-1), { path: '/ent/v2/tasks/task-id/cancel', method: 'POST', body: { id: 'task-id' } });
  minimax.profile.videoApi = 'v1';
  assert.equal((await f.client.cancelVideo(minimax, { protocol: 'minimax-video-v1', id: 'task-id' })).outcome, 'not_cancellable');
});

test('video submit/query keep Ark contents, MiniMax V1 file retrieval, V2 nested task and Vidu arrays distinct', async t => {
  const seen: any[] = [];
  const f = await fixture(t, (req, res, body) => {
    seen.push({ path: req.url, method: req.method, auth: req.headers.authorization, body });
    if (req.method === 'POST') { json(res, req.url?.includes('/api/v3/') ? { id: 'ark-id' } : { task_id: 'video-id', base_resp: { status_code: 0 } }); return; }
    if (req.url === '/api/v3/contents/generations/tasks/ark-id') json(res, { id: 'ark-id', status: 'succeeded', content: { video_url: f.origin + '/result.mp4?private=1' } });
    else if (req.url === '/v1/query/video_generation?task_id=video-id') json(res, { task_id: 'video-id', status: 'Success', file_id: 'file-id', base_resp: { status_code: 0 } });
    else if (req.url === '/v1/files/retrieve?file_id=file-id') json(res, { file: { download_url: f.origin + '/result.mp4' }, base_resp: { status_code: 0 } });
    else if (req.url === '/v2/query/video_generation/video-id') json(res, { task: { id: 'video-id', status: 'succeeded', content: { url: f.origin + '/result.mp4' } } });
    else if (req.url === '/ent/v2/tasks/video-id/creations') json(res, { id: 'video-id', state: 'success', creations: [{ url: f.origin + '/result.mp4' }] });
    else json(res, {}, 404);
  });
  writeFileSync(join(f.root, 'input.png'), png);
  const reference = { id: 'input', relativePath: 'input.png', mime: 'image/png', sha256: createHash('sha256').update(png).digest('hex'), bytes: png.length };
  for (const [protocol, version] of [['ark', undefined], ['minimax-cn', 'v1'], ['minimax-global', 'v2'], ['vidu', undefined]] as const) {
    const connection = f.connection(protocol); connection.profile.videoApi = version;
    const task = await f.client.submitVideo(connection, { prompt: 'cat', mode: 'image', images: [reference], duration: 5, resolution: '720p' });
    assert.deepEqual(task, { protocol: protocol === 'ark' ? 'ark-video' : protocol === 'vidu' ? 'vidu-video' : `minimax-video-${version}`, id: protocol === 'ark' ? 'ark-id' : 'video-id' });
    const state = await f.client.queryVideo(connection, task);
    assert.equal(state.status, 'succeeded'); assert.equal(state.sources?.length, 1);
  }
  const image = 'data:image/png;base64,' + png.toString('base64');
  assert.deepEqual(seen.filter(x => x.method === 'POST'), [
    { path: '/api/v3/contents/generations/tasks', method: 'POST', auth: `Bearer ${fakeKey}`, body: { model: 'custom-video', content: [{ type: 'text', text: 'cat' }, { type: 'image_url', image_url: { url: image }, role: 'first_frame' }], duration: 5, resolution: '720p' } },
    { path: '/v1/video_generation', method: 'POST', auth: `Bearer ${fakeKey}`, body: { model: 'custom-video', prompt: 'cat', first_frame_image: image, duration: 5, resolution: '720p' } },
    { path: '/v2/video_generation', method: 'POST', auth: `Bearer ${fakeKey}`, body: { model: 'custom-video', content: [{ type: 'text', text: 'cat' }, { type: 'image_url', image_url: { url: image }, role: 'first_frame' }], duration: 5, resolution: '720p' } },
    { path: '/ent/v2/img2video', method: 'POST', auth: `Token ${fakeKey}`, body: { model: 'custom-video', prompt: 'cat', images: [image], duration: 5, resolution: '720p' } },
  ]);
  assert.deepEqual(seen.filter(x => x.method === 'GET').map(x => x.path), ['/api/v3/contents/generations/tasks/ark-id', '/v1/query/video_generation?task_id=video-id', '/v1/files/retrieve?file_id=file-id', '/v2/query/video_generation/video-id', '/ent/v2/tasks/video-id/creations']);
});

test('Ark image references use image and partial outputs become local bounded artifacts', async t => {
  const seen: any[] = [];
  const f = await fixture(t, (req, res, body) => {
    seen.push({ path: req.url, method: req.method, auth: req.headers.authorization, body });
    if (req.url === '/media.png?signature=private') { res.end(png); return; }
    json(res, { data: [{ url: f.origin + '/media.png?signature=private' }, { error: { code: 'Blocked', message: fakeKey } }] });
  });
  writeFileSync(join(f.root, 'input.png'), png);
  const reference = { id: 'input', relativePath: 'input.png', mime: 'image/png', sha256: createHash('sha256').update(png).digest('hex'), bytes: png.length };
  const response = await f.client.generateImage(f.connection('ark', '/api/v3'), { prompt: 'cat', references: [reference] });
  assert.equal(response.sources.length, 1); assert.equal(response.failures.length, 1);
  const artifact = await f.client.materialize(f.connection('ark', '/api/v3'), response.sources[0]);
  assert.deepEqual(readFileSync(join(f.root, artifact.relativePath)), png);
  assert.equal(artifact.sha256, reference.sha256);
  assert.deepEqual(seen, [
    { path: '/api/v3/images/generations', method: 'POST', auth: `Bearer ${fakeKey}`, body: { model: 'image-01', prompt: 'cat', stream: false, image: ['data:image/png;base64,' + png.toString('base64')] } },
    { path: '/media.png?signature=private', method: 'GET', auth: undefined, body: undefined },
  ]);
  assert(!JSON.stringify(response).includes(fakeKey)); assert(!JSON.stringify(artifact).includes('signature='));
});
