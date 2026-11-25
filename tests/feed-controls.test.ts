import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { feedFixture } from './feed-runtime-fixture.js';
import { deferred, until } from './runtime-fixture.js';

test('stop acknowledges intent, holds the serial queue and requires matching terminal evidence', async t => {
  const { engine, clients, create } = await feedFixture(t);
  const first = (await create('A')).admission!;
  const detail = async () => (await engine.command({ type: 'get_feed_collection', collectionId: first.collectionId })).collection!;
  await until(() => clients[0]?.calls.some(c => c.method === 'turn/start') === true);
  await until(() => clients[0]?.calls.some(c => c.method === 'mcpServerStatus/list') === true);
  const a2 = (await engine.command({ type: 'run_feed_collection', collectionId: first.collectionId, input: { text: 'next' }, requestId: 'next-a' })).admission!;
  const repeated = (await engine.command({ type: 'run_feed_collection', collectionId: first.collectionId, input: { text: 'next' }, requestId: 'next-a-again' })).admission!;
  assert.equal(repeated.runId, a2.runId);
  await create('B');
  await until(() => clients.length === 2 && clients[1].calls.some(c => c.method === 'turn/start'));
  await engine.command({ type: 'stop_feed_run', runId: first.runId, requestId: 'stop-a' });
  assert.equal((await detail()).activeRun?.status, 'stopping');
  assert.equal((await detail()).collection.queueHeld, true);
  assert.equal(clients[0].calls.filter(c => c.method === 'turn/interrupt').length, 1);
  await engine.command({ type: 'stop_feed_run', runId: first.runId, requestId: 'stop-a' });
  assert.equal(clients[0].calls.filter(c => c.method === 'turn/interrupt').length, 1);
  const active = (await detail()).activeRun!;
  clients[0].options.onEvent({ method: 'turn/completed', params: { threadId: active.threadId, turn: { id: active.turnId, status: 'interrupted', items: [] } } });
  const runs = (await engine.command({ type: 'list_feed_runs', collectionId: first.collectionId })).runs!.items;
  assert.equal(runs.find(r => r.id === first.runId)?.status, 'stopped');
  assert.equal(runs.find(r => r.id === a2.runId)?.status, 'queued');
  await engine.command({ type: 'continue_feed_queue', collectionId: first.collectionId, requestId: 'continue-a' });
  await until(() => clients[0].calls.filter(c => c.method === 'turn/start').length === 2);
  await engine.command({ type: 'continue_feed_queue', collectionId: first.collectionId, requestId: 'continue-a' });
  assert.equal(clients[0].calls.filter(c => c.method === 'turn/start').length, 2);
});

test('stop returns with durable intent while interrupt acknowledgement is pending', async t => {
  const interrupt = deferred();
  const { engine, clients, create } = await feedFixture(t, async method => { if (method === 'turn/interrupt') { await interrupt.promise; return {}; } });
  t.after(async () => interrupt.resolve());
  const first = (await create('pending-interrupt')).admission!;
  await until(() => clients[0]?.calls.some(c => c.method === 'turn/start') === true);
  let accepted = false;
  const stop = engine.command({ type: 'stop_feed_run', runId: first.runId, requestId: 'pending-stop' }).then(() => { accepted = true; });
  try { await until(() => accepted); } finally { interrupt.resolve(); await stop; }
  assert.equal((await engine.command({ type: 'get_feed_collection', collectionId: first.collectionId })).collection?.activeRun?.status, 'stopping');
});

for (const gateMethod of ['model/list', 'thread/start']) test(`stop during ${gateMethod} fences late preparation and safely cancels queued input`, async t => {
  const gate = deferred(), entered = deferred(), released = deferred();
  const { engine, clients, create } = await feedFixture(t, async method => { if (method === gateMethod) { entered.resolve(); await gate.promise; released.resolve(); } });
  t.after(async () => gate.resolve());
  const first = (await create(`gate-${gateMethod.replace('/', '-')}`)).admission!; await entered.promise;
  const next = (await engine.command({ type: 'send_feed_message', collectionId: first.collectionId, input: { text: 'withdraw me' }, requestId: 'queued-message' })).admission!;
  await engine.command({ type: 'stop_feed_run', runId: first.runId, requestId: 'preflight-stop' });
  gate.resolve(); await released.promise;
  await engine.command({ type: 'cancel_feed_run', runId: next.runId, requestId: 'cancel-message' });
  assert.equal((await engine.command({ type: 'cancel_feed_run', runId: next.runId, requestId: 'cancel-message' })).run?.status, 'cancelled');
  await assert.rejects(engine.command({ type: 'cancel_feed_run', runId: first.runId, requestId: 'cancel-message' }), /冲突/);
  const runs = (await engine.command({ type: 'list_feed_runs', collectionId: first.collectionId })).runs!.items;
  assert.equal(runs.find(r => r.id === first.runId)?.status, 'stopped');
  assert.equal(clients[0].calls.filter(c => c.method === 'turn/start').length, 0);
  const collection = (await engine.command({ type: 'get_feed_collection', collectionId: first.collectionId })).collection!.collection;
  await engine.command({ type: 'delete_feed_collection', collectionId: collection.id, expectedRevision: collection.revision, requestId: 'delete-after-stop' });
  await assert.rejects(engine.command({ type: 'get_feed_collection', collectionId: collection.id }), /不存在/);
});

for (const terminal of ['interrupted', 'completed']) test(`early turn/items/request and ${terminal} before start response never revive a terminal attempt`, async t => {
  const gate = deferred(), entered = deferred();
  const { engine, clients, create } = await feedFixture(t, async (method, params, options) => {
    if (method === 'turn/start') {
      options.onEvent({ method: 'turn/started', params: { threadId: params.threadId, turn: { id: 'early-turn' } } });
      options.onEvent({ method: 'item/completed', params: { threadId: params.threadId, turnId: 'early-turn', item: { id: 'early-item', type: 'agentMessage', text: 'early text' } } });
      options.onRequest?.({ id: 42, method: 'item/commandExecution/requestApproval', params: { threadId: params.threadId, turnId: 'early-turn' } });
      entered.resolve(); await gate.promise; return { turn: { id: 'early-turn' } };
    }
  });
  t.after(async () => gate.resolve());
  const first = (await create(`early-${terminal}`)).admission!; await entered.promise;
  const detail = (await engine.command({ type: 'get_feed_collection', collectionId: first.collectionId })).collection!;
  assert.equal(detail.requests.length, 1);
  await engine.command({ type: 'stop_feed_run', runId: first.runId, requestId: 'early-stop' });
  clients[0].options.onEvent({ method: 'turn/completed', params: { threadId: detail.activeRun!.threadId, turn: { id: 'early-turn', status: terminal, items: [] } } });
  gate.resolve();
  await until(() => clients[0].calls.some(c => c.method === 'turn/interrupt'));
  const runs = (await engine.command({ type: 'list_feed_runs', collectionId: first.collectionId })).runs!.items;
  assert.equal(runs[0].status, terminal === 'completed' ? 'completed' : 'stopped');
  assert.equal((await engine.command({ type: 'get_feed_collection', collectionId: first.collectionId })).collection!.requests.length, 0);
  assert.equal((await engine.command({ type: 'read_feed_history', collectionId: first.collectionId })).history!.items.filter(h => h.itemId === 'early-item').length, 1);
});

test('native response validation and resolution remain bound to collection and handle generation', async t => {
  const { engine, clients, create } = await feedFixture(t);
  const first = (await create('request-A')).admission!;
  const second = (await create('request-B')).admission!;
  await until(() => clients.length === 2 && clients.every(c => c.calls.some(call => call.method === 'turn/start')));
  const detail = async (collectionId: string) => (await engine.command({ type: 'get_feed_collection', collectionId })).collection!;
  const a = (await detail(first.collectionId)).activeRun!, b = (await detail(second.collectionId)).activeRun!;
  clients[0].options.onRequest?.({ id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: a.threadId, turnId: a.turnId } });
  clients[1].options.onRequest?.({ id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: b.threadId, turnId: b.turnId } });
  const aKey = (await detail(first.collectionId)).requests[0].key, bKey = (await detail(second.collectionId)).requests[0].key;
  await assert.rejects(engine.command({ type: 'respond_feed_native', collectionId: first.collectionId, requestKey: aKey, result: { decision: 'invented' } }));
  assert.equal((await detail(first.collectionId)).requests.length, 1);
  await assert.rejects(engine.command({ type: 'respond_feed_native', collectionId: first.collectionId, requestKey: bKey, result: { decision: 'accept' } }), /过期/);
  clients[0].options.onEvent({ method: 'serverRequest/resolved', params: { requestId: 7 } });
  await assert.rejects(engine.command({ type: 'respond_feed_native', collectionId: first.collectionId, requestKey: aKey, result: { decision: 'accept' } }), /过期/);
  assert.equal((await detail(second.collectionId)).requests[0].key, bKey);
  await engine.command({ type: 'respond_feed_native', collectionId: second.collectionId, requestKey: bKey, result: { decision: 'accept' } });
  assert.equal(clients[1].replies.filter(r => r.id === 7 && r.result).length, 1);
  await assert.rejects(engine.command({ type: 'respond_feed_native', collectionId: second.collectionId, requestKey: bKey, result: { decision: 'accept' } }), /过期/);
  clients[0].options.onRequest?.({ id: '7', method: 'item/commandExecution/requestApproval', params: { threadId: a.threadId, turnId: a.turnId } });
  const oldKey = (await detail(first.collectionId)).requests[0].key;
  clients[0].options.onDisconnect('lost');
  await engine.command({ type: 'feed_capabilities', collectionId: first.collectionId });
  clients[0].options.onRequest?.({ id: '7', method: 'item/commandExecution/requestApproval', params: {} });
  await assert.rejects(engine.command({ type: 'respond_feed_native', collectionId: first.collectionId, requestKey: oldKey, result: { decision: 'accept' } }), /过期/);
  assert.equal((await detail(first.collectionId)).requests.length, 0);
});

test('permanent collection deletion retires its handle, queue, history and owned files without touching the selected workspace', async t => {
  let closes = 0;
  const f = await feedFixture(t, method => { if (method === 'fixture/close') closes++; });
  const { engine, clients, root } = f, directory = join(root, 'selected-workspace');
  mkdirSync(directory);
  const untouched = join(directory, 'keep.txt');
  writeFileSync(untouched, 'unrelated workspace file');
  const create = { type: 'create_feed_collection' as const, name: 'delete-owner', instruction: 'collection under test', directory, requestId: 'create-delete-owner', input: { text: 'first input' } };
  const first = (await engine.command(create)).admission!;
  await until(() => clients[0]?.calls.some(call => call.method === 'turn/start') === true);
  const detail = (await engine.command({ type: 'get_feed_collection', collectionId: first.collectionId })).collection!;
  const owned = join(directory, '.mixcat', 'feed', first.collectionId);
  assert.ok(existsSync(join(owned, '.codex')));
  const result = engine.mcpService().saveResult('owned-result', { title: 'owned result', body: 'owned result body', coverage: 'full' }, { kind: 'agent', collectionId: first.collectionId, runId: first.runId, threadId: detail.activeRun!.threadId!, turnId: detail.activeRun!.turnId!, callId: 'result' });
  const unrelated = (await engine.command({ type: 'update_feed_entry', mutation: { operation: 'createText', input: { title: 'unrelated', body: 'standalone entry', coverage: 'full' }, requestId: 'keep-entry' } })).entry!;
  await assert.rejects(engine.command({ type: 'delete_feed_collection', collectionId: first.collectionId, expectedRevision: detail.collection.revision, requestId: 'delete-running' }), /安全停止/);
  const queued = { type: 'send_feed_message' as const, collectionId: first.collectionId, input: { text: 'later' }, requestId: 'delete-queued' };
  await engine.command(queued);
  await engine.command({ type: 'stop_feed_run', runId: first.runId, requestId: 'delete-stop' });
  clients[0].options.onEvent({ method: 'turn/completed', params: { threadId: detail.activeRun!.threadId, turn: { id: detail.activeRun!.turnId, status: 'interrupted', items: [] } } });
  const stopped = (await engine.command({ type: 'get_feed_collection', collectionId: first.collectionId })).collection!;
  const remove = { type: 'delete_feed_collection' as const, collectionId: first.collectionId, expectedRevision: stopped.collection.revision, requestId: 'delete-stopped' };
  await engine.command(remove);
  assert.equal(closes, 1);
  assert.equal(existsSync(owned), false);
  assert.equal(readFileSync(untouched, 'utf8'), 'unrelated workspace file');
  clients[0].options.onEvent({ method: 'item/completed', params: { threadId: detail.activeRun!.threadId, turnId: detail.activeRun!.turnId, item: { id: 'after-delete', type: 'agentMessage', text: 'late' } } });
  await assert.rejects(engine.command({ type: 'list_feed_runs', collectionId: first.collectionId }), /不存在/);
  await assert.rejects(engine.command({ type: 'read_feed_history', collectionId: first.collectionId }), /不存在/);
  await assert.rejects(engine.command({ type: 'get_feed_entry', entryId: result.entryId }), /不存在/);
  assert.equal((await engine.command({ type: 'get_feed_entry', entryId: unrelated.id })).entry!.body, 'standalone entry');
  await engine.command(remove);
  const reopened = await f.reopen();
  await reopened.command(remove);
  await assert.rejects(reopened.command(create), /已经永久删除/);
  await assert.rejects(reopened.command(queued), /已经永久删除/);
  assert.deepEqual((await reopened.command({ type: 'list_feed_collections' })).collectionPage!.items, []);
});

test('reopening completes only the filesystem cleanup of a confirmed feed deletion', async t => {
  const f = await feedFixture(t);
  const accepted = (await f.create('pending-cleanup')).admission!;
  await until(() => f.clients[0]?.calls.some(call => call.method === 'turn/start') === true);
  const { engine, root } = f, collectionId = accepted.collectionId;
  const active = (await engine.command({ type: 'get_feed_collection', collectionId })).collection!.activeRun!;
  await engine.command({ type: 'stop_feed_run', runId: accepted.runId, requestId: 'stop-cleanup' });
  f.clients[0].options.onEvent({ method: 'turn/completed', params: { threadId: active.threadId, turn: { id: active.turnId, status: 'interrupted', items: [] } } });
  const directory = join(root, '.runtime', 'client', 'feed', 'collections', collectionId);
  assert.ok(existsSync(directory));
  const sibling = mkdirSync(join(root, 'preserved'), { recursive: true })!;
  const marker = join(sibling, 'keep.txt');
  writeFileSync(marker, 'owned by another workspace');
  symlinkSync(sibling, join(directory, 'link-outside'), process.platform === 'win32' ? 'junction' : 'dir');
  const current = (await engine.command({ type: 'get_feed_collection', collectionId })).collection!.collection;
  const remove = { type: 'delete_feed_collection' as const, collectionId, expectedRevision: current.revision, requestId: 'cleanup-remove' };
  t.mock.method(engine.mcpService().store, 'finishCollectionCleanup', () => { throw Error('fixture file locked'); });
  await assert.rejects(engine.command(remove), /fixture file locked/);
  await assert.rejects(engine.command({ type: 'get_feed_collection', collectionId }), /不存在/);
  assert.ok(existsSync(directory));
  const reopened = await f.reopen();
  await reopened.command(remove);
  assert.equal(existsSync(directory), false);
  assert.equal(readFileSync(marker, 'utf8'), 'owned by another workspace');
  assert.equal(reopened.snapshot().cleanupError, undefined);
});

test('queued materials freeze at admission, instructions freeze at dispatch, and automatic metadata stays internal', async t => {
  const { engine, clients, create } = await feedFixture(t);
  const first = (await create('snapshot-queue')).admission!;
  await until(() => clients[0]?.calls.some(call => call.method === 'turn/start') === true);
  const material = (await engine.command({ type: 'update_feed_entry', mutation: { operation: 'createText', requestId: 'material', input: { title: 'Original', body: 'material bytes', coverage: 'full' } } })).entry!;
  const queued = engine.enqueueCollectionRun(first.collectionId, { trigger: 'catchup', text: 'fill gap', entryIds: [material.id], coverageWindow: { start: '2026-10-28T00:00:00+08:00', end: '2026-10-29T00:00:00+08:00' }, scheduleRevision: 3 }, 'scheduled-gap');
  const message1 = (await engine.command({ type: 'send_feed_message', collectionId: first.collectionId, input: { text: 'same message' }, requestId: 'message-one' })).admission!;
  const message2 = (await engine.command({ type: 'send_feed_message', collectionId: first.collectionId, input: { text: 'same message' }, requestId: 'message-two' })).admission!;
  assert.notEqual(message1.runId, message2.runId);
  assert.throws(() => engine.enqueueCollectionRun(first.collectionId, { trigger: 'catchup', text: 'different' }, 'scheduled-gap'), /冲突/);
  await assert.rejects(engine.command({ type: 'enqueue_feed_run', collectionId: first.collectionId, requestId: 'forged-auto', input: { trigger: 'schedule', text: '' } } as any));
  await engine.command({ type: 'update_feed_entry', mutation: { operation: 'delete', id: material.id, expectedRevision: material.revision, requestId: 'delete-material' } });
  let detail = (await engine.command({ type: 'get_feed_collection', collectionId: first.collectionId })).collection!;
  await engine.command({ type: 'edit_feed_collection', collectionId: first.collectionId, expectedRevision: detail.collection.revision, requestId: 'queued-guidance', changes: { instruction: 'new instruction', sourcePreferences: 'new sources' } });
  assert.equal(detail.activeRun!.instructionSnapshot, 'Collect verified text');
  clients[0].options.onEvent({ method: 'turn/completed', params: { threadId: detail.activeRun!.threadId, turn: { id: detail.activeRun!.turnId, status: 'completed', items: [] } } });
  await until(() => clients[0].calls.filter(call => call.method === 'turn/start').length === 2);
  detail = (await engine.command({ type: 'get_feed_collection', collectionId: first.collectionId })).collection!;
  assert.equal(detail.activeRun!.id, queued.id);
  assert.equal(detail.activeRun!.instructionSnapshot, 'new instruction');
  assert.equal(detail.activeRun!.sourcePreferencesSnapshot, 'new sources');
  assert.equal(detail.activeRun!.inputSnapshot.materials[0].body, 'material bytes');
  assert.deepEqual(detail.activeRun!.coverageWindow, { start: '2026-10-28T00:00:00+08:00', end: '2026-10-29T00:00:00+08:00' });
  assert.equal(detail.activeRun!.scheduleRevision, 3);
});

test('a positively not-sent start rejection can settle a stop without inventing native completion', async t => {
  const entered = deferred(), gate = deferred();
  const { engine, clients, create } = await feedFixture(t, async method => { if (method === 'turn/start') { entered.resolve(); await gate.promise; throw Object.assign(new Error('not sent'), { outcome: 'not-sent' }); } });
  t.after(async () => gate.resolve());
  const first = (await create('not-sent-stop')).admission!; await entered.promise;
  await engine.command({ type: 'stop_feed_run', runId: first.runId, requestId: 'stop-not-sent' }); const before = engine.snapshot().revision; gate.resolve();
  await until(() => engine.snapshot().revision > before);
  const run = (await engine.command({ type: 'list_feed_runs', collectionId: first.collectionId })).runs!.items[0];
  assert.equal(run.status, 'stopped'); assert.equal(run.dispatchState, 'not_sent');
  assert.equal(clients[0].calls.some(call => call.method === 'turn/interrupt'), false);
});

test('continue during a stopped preflight waits for old preparation to retire then dispatches the next input', async t => {
  const gate = deferred(), entered = deferred(); let firstThread = true;
  const { engine, clients, create } = await feedFixture(t, async method => {
    if (method === 'thread/start' && firstThread) { firstThread = false; entered.resolve(); await gate.promise; }
  });
  t.after(async () => gate.resolve());
  const first = (await create('continue-preflight')).admission!; await entered.promise;
  const next = (await engine.command({ type: 'send_feed_message', collectionId: first.collectionId, input: { text: 'next input' }, requestId: 'next-preflight' })).admission!;
  await engine.command({ type: 'stop_feed_run', runId: first.runId, requestId: 'stop-preflight-continue' });
  await engine.command({ type: 'continue_feed_queue', collectionId: first.collectionId, requestId: 'continue-preflight' });
  assert.equal(clients[0].calls.some(call => call.method === 'turn/start'), false);
  gate.resolve(); await until(() => clients[0].calls.some(call => call.method === 'turn/start'));
  assert.equal((await engine.command({ type: 'get_feed_collection', collectionId: first.collectionId })).collection!.activeRun!.id, next.runId);
  assert.equal(clients[0].calls.filter(call => call.method === 'turn/start').length, 1);
});

test('a new explicit stop can retry an unknown interrupt while replaying its receipt cannot', async t => {
  let interrupts = 0;
  const { engine, clients, create } = await feedFixture(t, method => { if (method === 'turn/interrupt' && ++interrupts === 1) throw Object.assign(new Error('unknown interrupt'), { outcome: 'unknown' }); });
  const first = (await create('interrupt-retry')).admission!;
  await until(() => clients[0]?.calls.some(call => call.method === 'turn/start') === true);
  await engine.command({ type: 'stop_feed_run', runId: first.runId, requestId: 'interrupt-first' });
  await until(() => engine.snapshot().runsNeedingAttention.some(run => run.id === first.runId));
  await engine.command({ type: 'stop_feed_run', runId: first.runId, requestId: 'interrupt-first' }); assert.equal(interrupts, 1);
  await engine.command({ type: 'stop_feed_run', runId: first.runId, requestId: 'interrupt-explicit-retry' });
  await until(() => interrupts === 2);
  assert.equal(clients[0].calls.filter(call => call.method === 'turn/start').length, 1);
});
