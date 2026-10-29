import assert from 'node:assert/strict';
import test from 'node:test';
import { FeedEngine } from '../src/core/feed-runtime.js';
import { FeedStore } from '../src/core/feed-store.js';
import type { SharedAccount } from '../src/core/account.js';
import { feedFixture } from './feed-runtime-fixture.js';
import { deferred, until } from './runtime-fixture.js';

test('unknown start survives reconnect/reopen; idle or empty history never proves absence', async t => {
  const start = deferred(), entered = deferred();
  const { engine, clients, create, root } = await feedFixture(t, async (method) => {
    if (method === 'turn/start') { entered.resolve(); await start.promise; return { turn: { id: 'late-turn' } }; }
    if (method === 'thread/read') return { thread: { id: 'thread-1', status: { type: 'idle' }, turns: [] } };
  });
  const first = (await create('unknown')).admission!; await entered.promise;
  await engine.command({ type: 'stop_feed_run', runId: first.runId, requestId: 'stop-unknown' });
  clients[0].options.onDisconnect('lost'); start.resolve();
  await until(() => engine.snapshot().runsNeedingAttention.some(r => r.id === first.runId));
  const next = (await engine.command({ type: 'send_feed_message', collectionId: first.collectionId, input: { text: 'queued' }, requestId: 'after-unknown' })).admission!;
  await assert.rejects(engine.command({ type: 'continue_feed_queue', collectionId: first.collectionId, requestId: 'continue-unknown' }), /核对/);
  const reconciled = await engine.command({ type: 'reconcile_feed_run', runId: first.runId, requestId: 'reconcile-unknown' });
  assert.equal(reconciled.run?.status, 'needs_reconciliation');
  assert.equal(reconciled.run?.turnId, null);
  assert.equal(clients.flatMap(c => c.calls).filter(c => c.method === 'turn/start').length, 1);
  await engine.close();
  const reopened = new FeedEngine({ store: new FeedStore(root), executable: 'fixture', account: { credentials: async () => null } as unknown as SharedAccount, nativeFactory() { throw new Error('must not replay unknown/held work'); } });
  await reopened.init(); t.after(() => reopened.close());
  const runs = (await reopened.command({ type: 'list_feed_runs', collectionId: first.collectionId })).runs!.items;
  assert.equal(runs.find(r => r.id === next.runId)?.status, 'queued');
  assert.equal((await reopened.command({ type: 'get_feed_collection', collectionId: first.collectionId })).collection!.collection.queueHeld, true);
  assert.equal((await reopened.command({ type: 'reconcile_feed_run', runId: first.runId, requestId: 'reconcile-unknown' })).run?.status, 'needs_reconciliation');
});

test('known turn reconciliation uses only matching native terminal evidence and durable request results', async t => {
  let status = 'interrupted', reads = 0;
  const { engine, clients, create } = await feedFixture(t, method => {
    if (method === 'thread/read') { reads++; return { thread: { id: 'thread-1', turns: [{ id: 'unrelated', status: 'completed' }, { id: 'turn-1', status, items: [{ id: 'answer', type: 'agentMessage', text: 'confirmed' }] }] } }; }
  });
  const first = (await create('known')).admission!;
  await until(() => clients[0]?.calls.some(c => c.method === 'turn/start') === true);
  await until(() => engine.snapshot().revision > 4);
  clients[0].options.onDisconnect('lost');
  const result = await engine.command({ type: 'reconcile_feed_run', runId: first.runId, requestId: 'reconcile-known' });
  assert.equal(result.run?.status, 'stopped');
  status = 'completed';
  assert.equal((await engine.command({ type: 'reconcile_feed_run', runId: first.runId, requestId: 'reconcile-known' })).run?.status, 'stopped');
  assert.equal(reads, 1);
  assert.equal((await engine.command({ type: 'read_feed_history', collectionId: first.collectionId })).history!.items.find(h => h.itemId === 'answer')?.text, 'confirmed');
});

for (const phase of ['intent', 'native-receipt']) test(`storage failure at ${phase} fences native dispatch and persists uncertainty`, async t => {
  const entered = deferred(), gate = deferred();
  const { engine, clients, create, root } = await feedFixture(t, async (method, params, options) => {
    if ((phase === 'intent' && method === 'mcpServerStatus/list') || (phase === 'native-receipt' && method === 'turn/start')) {
      entered.resolve(); await gate.promise;
      if (phase === 'native-receipt') { options.onEvent({ method: 'turn/started', params: { threadId: params.threadId, turn: { id: 'accepted-before-disk-failure' } } }); return { turn: { id: 'accepted-before-disk-failure' } }; }
    }
  });
  t.after(async () => gate.resolve());
  const first = (await create(`storage-${phase}`)).admission!; await entered.promise;
  const store = engine.mcpService().store;
  store.db.exec("CREATE TRIGGER fail_run_save BEFORE INSERT ON feed_runs BEGIN SELECT RAISE(ABORT,'fixture disk unavailable'); END");
  gate.resolve();
  await until(() => !!engine.snapshot().storageError);
  assert.equal(clients[0].calls.filter(call => call.method === 'turn/start').length, phase === 'intent' ? 0 : 1);
  await assert.rejects(engine.command({ type: 'stop_feed_run', runId: first.runId, requestId: 'storage-stop' }), /fixture disk unavailable/);
  store.db.exec('DROP TRIGGER fail_run_save');
  await engine.close();
  let restoredTurns = 0;
  const reopened = new FeedEngine({ store: new FeedStore(root), executable: 'fixture', account: { credentials: async () => null } as unknown as SharedAccount, nativeFactory() { return { async connect() {}, async close() {}, async rpc(method) { if (method === 'turn/start') restoredTurns++; return {}; } }; } });
  await reopened.init(); t.after(() => reopened.close());
  if (phase === 'intent') await until(() => reopened.snapshot().runsNeedingAttention.some(run => run.id === first.runId));
  assert.equal((await reopened.command({ type: 'list_feed_runs', collectionId: first.collectionId })).runs!.items[0].status, phase === 'intent' ? 'waiting_account' : 'needs_reconciliation');
  assert.equal(restoredTurns, 0);
});

test('asynchronous native storage failure latches the live fence without throwing through the callback', async t => {
  const { engine, clients, create } = await feedFixture(t);
  const first = (await create('stream-storage')).admission!;
  await until(() => clients[0]?.calls.some(call => call.method === 'turn/start') === true);
  const run = (await engine.command({ type: 'get_feed_collection', collectionId: first.collectionId })).collection!.activeRun!;
  const store = engine.mcpService().store;
  store.db.exec("CREATE TRIGGER fail_history_save BEFORE INSERT ON feed_history BEGIN SELECT RAISE(ABORT,'fixture stream disk unavailable'); END");
  assert.doesNotThrow(() => clients[0].options.onEvent({ method: 'item/completed', params: { threadId: run.threadId, turnId: run.turnId, item: { id: 'disk-item', type: 'agentMessage', text: 'text' } } }));
  assert.match(engine.snapshot().storageError ?? '', /fixture stream disk unavailable/);
  store.db.exec('DROP TRIGGER fail_history_save');
  clients[0].options.onEvent({ method: 'turn/completed', params: { threadId: run.threadId, turn: { id: run.turnId, status: 'completed', items: [] } } });
  await assert.rejects(engine.command({ type: 'run_feed_collection', collectionId: first.collectionId, input: { text: 'after failed stream' }, requestId: 'after-stream-failure' }), /disk unavailable/);
});

test('close gates admission, waits for owned handles, persists uncertainty and caches aggregate failure', async t => {
  const retirement = deferred(), entered = deferred();
  let closedClients = 0, closedStore = false;
  const { engine, clients, create, root } = await feedFixture({ after() {} }, async method => {
    if (method === 'fixture/close') { closedClients++; entered.resolve(); await retirement.promise; throw new Error('native close fixture failure'); }
  });
  t.after(async () => { retirement.resolve(); await engine.close().catch(() => {}); });
  const first = (await create('close-aggregate')).admission!;
  await until(() => clients[0]?.calls.some(call => call.method === 'turn/start') === true);
  const store = engine.mcpService().store, actualClose = store.close.bind(store);
  store.close = () => { closedStore = true; actualClose(); throw new Error('store close fixture failure'); };
  const closing = engine.close();
  assert.equal(engine.close(), closing); await entered.promise;
  assert.equal(closedStore, false);
  await assert.rejects(engine.command({ type: 'send_feed_message', collectionId: first.collectionId, requestId: 'after-close', input: { text: 'must reject' } }), /关闭/);
  retirement.resolve();
  let failure: AggregateError | undefined;
  try { await closing; assert.fail('close must aggregate'); } catch (error) { failure = error as AggregateError; }
  assert.ok(failure instanceof AggregateError); assert.equal(failure.errors.length, 2);
  await assert.rejects(engine.close(), error => error === failure);
  assert.equal(closedClients, 1); assert.equal(closedStore, true);
  const reopened = new FeedEngine({ store: new FeedStore(root), executable: 'fixture', account: { credentials: async () => null } as unknown as SharedAccount, nativeFactory() { throw new Error('unknown run cannot replay'); } });
  await reopened.init(); t.after(() => reopened.close());
  assert.equal((await reopened.command({ type: 'list_feed_runs', collectionId: first.collectionId })).runs!.items[0].status, 'needs_reconciliation');
});

for (const methodToGate of ['account/read', 'thread/start']) test(`reopen during ${methodToGate} restores only definitely undispatched input`, async t => {
  const entered = deferred(), gate = deferred();
  const { engine, create, root, clients } = await feedFixture(t, async method => { if (method === methodToGate) { entered.resolve(); await gate.promise; } });
  t.after(async () => gate.resolve());
  const first = (await create(`reopen-${methodToGate.replace('/', '-')}`)).admission!; await entered.promise;
  await engine.close();
  let turns = 0;
  const reopened = new FeedEngine({ store: new FeedStore(root), executable: 'fixture', account: { credentials: async () => null } as unknown as SharedAccount, nativeFactory() { return { async connect() {}, async close() {}, async rpc(method) { if (method === 'turn/start') turns++; return {}; } }; } });
  await reopened.init(); t.after(() => reopened.close());
  gate.resolve();
  await until(() => reopened.snapshot().runsNeedingAttention.some(run => run.id === first.runId));
  const run = (await reopened.command({ type: 'list_feed_runs', collectionId: first.collectionId })).runs!.items[0];
  assert.equal(run.status, 'waiting_account'); assert.equal(run.dispatchState, 'not_sent'); assert.equal(turns, 0);
  assert.equal(clients[0].calls.some(call => call.method === 'turn/start'), false);
});

test('matching active native evidence never releases a queue on an unattached replacement handle', async t => {
  const { engine, clients, create } = await feedFixture(t, method => method === 'thread/read' ? { thread: { id: 'thread-1', turns: [{ id: 'turn-1', status: 'inProgress', items: [] }] } } : undefined);
  const first = (await create('active-recovery')).admission!;
  await until(() => clients[0]?.calls.some(call => call.method === 'turn/start') === true);
  await engine.command({ type: 'stop_feed_run', runId: first.runId, requestId: 'stop-active-recovery' });
  clients[0].options.onDisconnect('lost');
  const result = await engine.command({ type: 'reconcile_feed_run', runId: first.runId, requestId: 'read-active' });
  assert.equal(result.run?.status, 'needs_reconciliation');
  await assert.rejects(engine.command({ type: 'continue_feed_queue', collectionId: first.collectionId, requestId: 'continue-active' }), /核对/);
  assert.equal((await engine.command({ type: 'get_feed_collection', collectionId: first.collectionId })).collection!.collection.queueHeld, true);
});

test('late reconciliation from a retired handle cannot settle a current run or import its history', async t => {
  const gate = deferred(), entered = deferred();
  const { engine, clients, create } = await feedFixture(t, async method => {
    if (method === 'thread/read') { entered.resolve(); await gate.promise; return { thread: { id: 'thread-1', turns: [{ id: 'turn-1', status: 'completed', items: [{ id: 'stale-read', type: 'agentMessage', text: 'stale evidence' }] }] } }; }
  });
  t.after(async () => gate.resolve());
  const first = (await create('replaced-read')).admission!;
  await until(() => clients[0]?.calls.some(call => call.method === 'turn/start') === true);
  clients[0].options.onDisconnect('first disconnect');
  const reconciliation = engine.command({ type: 'reconcile_feed_run', runId: first.runId, requestId: 'gated-reconcile' });
  await entered.promise; clients[1].options.onDisconnect('replacement disconnected');
  await engine.command({ type: 'feed_capabilities', collectionId: first.collectionId });
  gate.resolve(); await assert.rejects(reconciliation, /失效/);
  assert.equal((await engine.command({ type: 'list_feed_runs', collectionId: first.collectionId })).runs!.items[0].status, 'needs_reconciliation');
  assert.equal((await engine.command({ type: 'read_feed_history', collectionId: first.collectionId })).history!.items.some(item => item.itemId === 'stale-read'), false);
});

test('control receipts survive reopen and old continue acknowledgements cannot release a new hold', async t => {
  const { engine, clients, create, root } = await feedFixture(t);
  const first = (await create('durable-controls')).admission!;
  await until(() => clients[0]?.calls.some(call => call.method === 'turn/start') === true);
  const a = (await engine.command({ type: 'get_feed_collection', collectionId: first.collectionId })).collection!.activeRun!;
  await engine.command({ type: 'stop_feed_run', runId: first.runId, requestId: 'stop-original' });
  clients[0].options.onEvent({ method: 'turn/completed', params: { threadId: a.threadId, turn: { id: a.turnId, status: 'interrupted', items: [] } } });
  await engine.command({ type: 'continue_feed_queue', collectionId: first.collectionId, requestId: 'old-continue' });
  const second = (await engine.command({ type: 'send_feed_message', collectionId: first.collectionId, input: { text: 'second' }, requestId: 'second-admission' })).admission!;
  await until(() => clients[0].calls.filter(call => call.method === 'turn/start').length === 2);
  await engine.command({ type: 'stop_feed_run', runId: second.runId, requestId: 'second-stop' });
  const queued = (await engine.command({ type: 'send_feed_message', collectionId: first.collectionId, input: { text: 'withdraw' }, requestId: 'cancel-admission' })).admission!;
  await engine.command({ type: 'cancel_feed_run', runId: queued.runId, requestId: 'durable-cancel' });
  await engine.close();
  const reopened = new FeedEngine({ store: new FeedStore(root), executable: 'fixture', account: { credentials: async () => null } as unknown as SharedAccount, nativeFactory() { throw new Error('held controls cannot replay native execution'); } });
  await reopened.init(); t.after(() => reopened.close());
  await reopened.command({ type: 'stop_feed_run', runId: first.runId, requestId: 'stop-original' });
  await reopened.command({ type: 'continue_feed_queue', collectionId: first.collectionId, requestId: 'old-continue' });
  assert.equal((await reopened.command({ type: 'get_feed_collection', collectionId: first.collectionId })).collection!.collection.queueHeld, true);
  assert.equal((await reopened.command({ type: 'cancel_feed_run', runId: queued.runId, requestId: 'durable-cancel' })).run!.status, 'cancelled');
  await assert.rejects(reopened.command({ type: 'cancel_feed_run', runId: first.runId, requestId: 'durable-cancel' }), /冲突/);
});

test('late final items for an owned prior turn update only its history after the next turn starts', async t => {
  const { engine, clients, create } = await feedFixture(t);
  const first = (await create('late-prior-history')).admission!;
  await until(() => clients[0]?.calls.some(call => call.method === 'turn/start') === true);
  const previous = (await engine.command({ type: 'get_feed_collection', collectionId: first.collectionId })).collection!.activeRun!;
  const next = (await engine.command({ type: 'send_feed_message', collectionId: first.collectionId, input: { text: 'next turn' }, requestId: 'next-owned-turn' })).admission!;
  clients[0].options.onEvent({ method: 'turn/completed', params: { threadId: previous.threadId, turn: { id: previous.turnId, status: 'completed', items: [] } } });
  await until(() => clients[0].calls.filter(call => call.method === 'turn/start').length === 2);
  clients[0].options.onEvent({ method: 'item/completed', params: { threadId: previous.threadId, turnId: previous.turnId, item: { id: 'prior-final-item', type: 'agentMessage', text: 'prior final bytes' } } });
  const detail = (await engine.command({ type: 'get_feed_collection', collectionId: first.collectionId })).collection!;
  assert.equal(detail.activeRun!.id, next.runId); assert.equal(detail.activeRun!.status, 'running');
  const history = (await engine.command({ type: 'read_feed_history', collectionId: first.collectionId })).history!.items.find(item => item.itemId === 'prior-final-item');
  assert.equal(history?.runId, previous.id); assert.equal(history?.text, 'prior final bytes'); assert.equal(history?.completed, true);
  assert.throws(() => engine.admitWrite({ kind: 'agent', collectionId: first.collectionId, runId: previous.id, threadId: previous.threadId!, turnId: previous.turnId!, callId: 'late-old-call' }), /授权|结束/);
  clients[0].options.onRequest?.({ id: 'prior-request', method: 'item/commandExecution/requestApproval', params: { threadId: previous.threadId, turnId: previous.turnId } });
  assert.equal((await engine.command({ type: 'get_feed_collection', collectionId: first.collectionId })).collection!.requests.length, 0);
});
