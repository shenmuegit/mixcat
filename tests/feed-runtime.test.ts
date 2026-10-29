import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { projectDirectory } from '../src/core/paths.js';
import { FeedStore } from '../src/core/feed-store.js';
import { FeedService } from '../src/core/feed.js';
import { FeedCollections } from '../src/core/feed-collections.js';
import { feedFixture } from './feed-runtime-fixture.js';
import { until } from './runtime-fixture.js';
import { WorkflowEngine } from '../src/core/engine.js';
import { accountFixture } from './account-fixture.js';

test('atomic create replay retains the admitted material after deletion and instruction freezes at dispatch', t => {
  const root = mkdtempSync(resolve(projectDirectory(process.cwd(), '.runtime', 'tests'), 'feed-runtime-'));
  const store = new FeedStore(root); t.after(() => store.close());
  const entries = new FeedService(store), collections = new FeedCollections(store);
  const material = entries.saveResult('material', { title: 'Original', body: 'Frozen text', coverage: 'full' }, { kind: 'user' });
  const command = { type: 'create_feed_collection' as const, requestId: 'create', name: 'A', instruction: 'first', input: { text: 'Read this', materialEntryIds: [material.entryId] } };
  const accepted = collections.create(command);
  entries.mutate({ operation: 'delete', id: material.entryId, expectedRevision: 1, requestId: 'delete' }, { kind: 'user' });
  assert.deepEqual(collections.create(command), accepted);
  collections.edit(accepted.collectionId, 1, { instruction: 'second' }, 'edit');
  const run = collections.start(accepted.runId)!;
  assert.equal(run.instructionSnapshot, 'second');
  assert.equal(run.inputSnapshot.materials[0].body, 'Frozen text');
  assert.equal(collections.list().length, 1);
  assert.throws(() => collections.enqueue(accepted.collectionId, { text: 'Again', materialEntryIds: [material.entryId] }, 'collect', 'again'), /删除/);
});

test('history keeps original user input, terminal text and scoped independent pagination; saveAnswer reads owned text', async t => {
  const f = await feedFixture(t), a = (await f.create('history')).admission!;
  await until(() => f.clients[0]?.calls.some(call => call.method === 'turn/start'));
  const run = (await f.engine.command({ type: 'list_feed_runs', collectionId: a.collectionId })).runs!.items[0], client = f.clients[0];
  const emit = (type: string, item: any) => client.options.onEvent({ method: type, params: { threadId: run.threadId, turnId: run.turnId, item } });
  emit('item/completed', { id: 'native-input', type: 'userMessage', content: [{ type: 'text', text: 'augmented instructions and material' }] });
  emit('item/completed', { id: 'answer', type: 'agentMessage', text: 'Final answer' });
  emit('item/started', { id: 'answer', type: 'agentMessage', text: 'old draft', status: 'inProgress' });
  const history = (await f.engine.command({ type: 'read_feed_history', collectionId: a.collectionId })).history!;
  assert.equal(history.items.find(e => e.source === 'user')!.text, 'history');
  const answer = history.items.find(e => e.itemId === 'answer')!; assert.equal(answer.text, 'Final answer');
  const saved = await f.engine.command({ type: 'update_feed_entry', mutation: { operation: 'saveAnswer', collectionId: a.collectionId, conversationEntryId: answer.id, title: 'Answer', requestId: 'save-answer' } });
  assert.equal(saved.entry!.body, 'Final answer'); assert.equal(saved.receipt!.requestId, 'save-answer');
  const page = (await f.engine.command({ type: 'read_feed_history', collectionId: a.collectionId, limit: 1 })).history!;
  assert.ok(page.nextCursor);
  await assert.rejects(f.engine.command({ type: 'list_feed_runs', collectionId: a.collectionId, cursor: page.nextCursor! }), /游标/);
});

test('disconnect during turn start fences the late reply and close persists unknown execution', async t => {
  let release!: (value: any) => void;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await feedFixture(t, (method) => method === 'turn/start' ? gate : undefined), a = (await f.create('unknown')).admission!;
  await until(() => f.clients[0]?.calls.some(c => c.method === 'turn/start'));
  f.clients[0].options.onDisconnect('connection lost'); release({ turn: { id: 'late' } });
  await new Promise(resolve => setTimeout(resolve, 25));
  const run = (await f.engine.command({ type: 'list_feed_runs', collectionId: a.collectionId })).runs!.items[0];
  assert.equal(run.status, 'needs_reconciliation'); assert.equal(run.turnId, null);
  await f.engine.command({ type: 'run_feed_collection', collectionId: a.collectionId, requestId: 'next', input: { text: 'next' } });
  assert.equal(f.clients[0].calls.filter(c => c.method === 'turn/start').length, 1);
});

test('early native requests bind to the confirmed turn and reject foreign pending requests', async t => {
  const f = await feedFixture(t, (method, params, options) => {
    if (method === 'turn/start') {
      options.onRequest!({ id: 'early', method: 'item/commandExecution/requestApproval', params: { threadId: params.threadId, turnId: 'early-turn' } });
      options.onRequest!({ id: 'foreign', method: 'item/commandExecution/requestApproval', params: { threadId: params.threadId, turnId: 'foreign-turn' } });
      options.onEvent({ method: 'turn/started', params: { threadId: params.threadId, turn: { id: 'early-turn' } } });
      options.onEvent({ method: 'item/completed', params: { threadId: params.threadId, turnId: 'early-turn', item: { id: 'early-answer', type: 'agentMessage', text: 'Early answer' } } });
      return { turn: { id: 'early-turn' } };
    }
  });
  const a = (await f.create('early')).admission!;
  await until(() => f.clients[0]?.calls.some(c => c.method === 'turn/start'));
  const detail = (await f.engine.command({ type: 'get_feed_collection', collectionId: a.collectionId })).collection!;
  assert.deepEqual(detail.requests.map(r => r.request.id), ['early']);
  const request = detail.requests[0];
  await assert.rejects(f.engine.command({ type: 'respond_feed_native', collectionId: a.collectionId, requestKey: request.key, result: { decision: 'invented' } }));
  await f.engine.command({ type: 'respond_feed_native', collectionId: a.collectionId, requestKey: request.key, result: { decision: 'accept' } });
  assert.ok(f.clients[0].replies.some(r => r.id === 'early' && r.result?.decision === 'accept'));
  assert.equal((await f.engine.command({ type: 'read_feed_history', collectionId: a.collectionId })).history!.items.find(e => e.itemId === 'early-answer')!.text, 'Early answer');
});

test('on-demand native pages retain unknown time, reject foreign cursors and cannot overwrite a concurrent terminal update', async t => {
  let release!: (value: any) => void, fetchStarted!: () => void;
  const fetching = new Promise<void>(resolve => { fetchStarted = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = await feedFixture(t, (method, params) => {
    if (method === 'thread/items/list') { fetchStarted(); if (!params.cursor) return gate; return { data: [{ turnId: 'old-turn', item: { id: 'old-user', type: 'userMessage', content: [{ type: 'text', text: 'Imported text' }] } }], nextCursor: null }; }
  });
  const a = (await f.create('pages')).admission!;
  await until(() => f.clients[0]?.calls.some(c => c.method === 'turn/start'));
  const run = (await f.engine.command({ type: 'list_feed_runs', collectionId: a.collectionId })).runs!.items[0], client = f.clients[0];
  assert.equal((await f.engine.command({ type: 'load_feed_native_history', collectionId: a.collectionId })).nativeHistory!.nextCursor, null);
  assert.equal(client.calls.some(c => c.method === 'thread/items/list'), false);
  client.options.onEvent({ method: 'turn/completed', params: { threadId: run.threadId, turn: { id: run.turnId, status: 'completed', items: [] } } });
  const loading = f.engine.command({ type: 'load_feed_native_history', collectionId: a.collectionId }); await fetching;
  client.options.onEvent({ method: 'item/completed', params: { threadId: run.threadId, turnId: run.turnId, item: { id: 'answer', type: 'agentMessage', text: 'Latest terminal answer' } } });
  release({ data: [{ turnId: run.turnId, item: { id: 'answer', type: 'agentMessage', text: 'Stale completed snapshot' } }], nextCursor: 'page-2' });
  const next = (await loading).nativeHistory!.nextCursor!; assert.ok(next);
  await assert.rejects(f.engine.command({ type: 'load_feed_native_history', collectionId: a.collectionId, cursor: 'foreign' }), /游标/);
  await f.engine.command({ type: 'load_feed_native_history', collectionId: a.collectionId, cursor: next });
  await assert.rejects(f.engine.command({ type: 'load_feed_native_history', collectionId: a.collectionId, cursor: next }), /游标/);
  const entries = (await f.engine.command({ type: 'read_feed_history', collectionId: a.collectionId })).history!.items;
  assert.equal(entries.find(e => e.itemId === 'answer')!.text, 'Latest terminal answer');
  assert.equal(entries.find(e => e.itemId === 'old-user')!.source, 'unknown');
  assert.equal(entries.find(e => e.itemId === 'old-user')!.createdAt, '');
  assert.equal(entries.find(e => e.itemId === 'old-user')!.completed, false);
});

test('two runs maximum and same collection serial, saved instructions change only the next queued run', async t => {
  const f = await feedFixture(t);
  const a = (await f.create('serial-A')).admission!, b = (await f.create('serial-B')).admission!;
  await f.create('serial-C');
  await f.engine.command({ type: 'send_feed_message', collectionId: a.collectionId, requestId: 'queued', input: { text: 'follow-up' } });
  await f.engine.command({ type: 'edit_feed_collection', collectionId: a.collectionId, expectedRevision: 1, requestId: 'instructions', changes: { instruction: 'Next instruction' } });
  await until(() => f.clients.length === 2 && f.clients.every(c => c.calls.some(call => call.method === 'turn/start')));
  const old = (await f.engine.command({ type: 'list_feed_runs', collectionId: a.collectionId })).runs!.items.find(r => r.id === a.runId)!;
  assert.equal(old.instructionSnapshot, 'Collect verified text');
  assert.equal(f.clients.length, 2);
  f.clients[0].options.onEvent({ method: 'turn/completed', params: { threadId: old.threadId, turn: { id: old.turnId, status: 'completed', items: [] } } });
  await until(() => f.clients[0].calls.filter(c => c.method === 'turn/start').length === 2);
  const next = (await f.engine.command({ type: 'list_feed_runs', collectionId: a.collectionId })).runs!.items[0];
  assert.equal(next.instructionSnapshot, 'Next instruction');
  assert.equal((await f.engine.command({ type: 'list_feed_runs', collectionId: b.collectionId })).runs!.items[0].status, 'running');
});

test('shared account readiness wakes the durable waiting run without creating another admission', async t => {
  let authenticated = false;
  const f = await feedFixture(t, method => method === 'account/read' ? { account: authenticated ? { email: 'fixture' } : null } : undefined);
  const a = (await f.create('account')).admission!;
  await until(() => f.clients[0]?.calls.some(c => c.method === 'account/read'));
  assert.equal((await f.engine.command({ type: 'list_feed_runs', collectionId: a.collectionId })).runs!.items[0].status, 'waiting_account');
  assert.equal(f.clients[0].calls.some(c => c.method === 'turn/start'), false);
  authenticated = true; f.engine.wake();
  await until(() => f.clients[0].calls.some(c => c.method === 'turn/start'));
  const runs = (await f.engine.command({ type: 'list_feed_runs', collectionId: a.collectionId })).runs!.items;
  assert.equal(runs.length, 1); assert.equal(runs[0].id, a.runId); assert.equal(runs[0].status, 'running');
});

test('during-connect host requests retain owned history and native model/permission receipts stay authoritative', async t => {
  const f = await feedFixture(t, (method, _params, options) => {
    if (method === 'fixture/connect') options.onRequest!({ id: 'unsupported', method: 'item/tool/call', params: { tool: 'unknown' } });
    if (method === 'thread/start') return { thread: { id: 'receipt-thread' }, model: 'native-selected', sandbox: { type: 'readOnly' }, approvalPolicy: 'on-request', activePermissionProfile: 'restricted' };
  });
  const a = (await f.create('receipts')).admission!;
  await until(() => f.clients[0]?.calls.some(c => c.method === 'turn/start'));
  const entries = (await f.engine.command({ type: 'read_feed_history', collectionId: a.collectionId })).history!.items;
  assert.ok(entries.some(e => e.runId === a.runId && e.text === 'item/tool/call'));
  const config = entries.find(e => (e.rawItem as any)?.type === 'sessionConfiguration')!.rawItem as any;
  assert.equal(config.model, 'native-selected'); assert.equal(config.requestedModel, null); assert.equal(config.sandbox.type, 'readOnly'); assert.equal(config.activePermissionProfile, 'restricted');
  assert.equal(f.clients[0].calls.find(c => c.method === 'turn/start')!.params.model, undefined);
});

test('removing an explicit reasoning effort requires the native default before resuming the next turn', async t => {
  let catalogHasDefault = true;
  const f = await feedFixture(t, method => method === 'model/list' ? { data: [{ model: 'fixture-model', displayName: 'Fixture', ...(catalogHasDefault ? { defaultReasoningEffort: 'medium' } : {}), supportedReasoningEfforts: [{ reasoningEffort: 'high', description: '' }] }], nextCursor: null } : undefined);
  const a = (await f.engine.command({ type: 'create_feed_collection', name: 'effort', instruction: 'collect', requestId: 'effort', input: { text: '' }, capabilities: { model: 'fixture-model', reasoningEffort: 'high', skills: [], plugins: [] } })).admission!;
  await until(() => f.clients[0]?.calls.some(c => c.method === 'turn/start'));
  const first = (await f.engine.command({ type: 'list_feed_runs', collectionId: a.collectionId })).runs!.items[0];
  assert.equal(f.clients[0].calls.find(c => c.method === 'turn/start')!.params.effort, 'high');
  f.clients[0].options.onEvent({ method: 'turn/completed', params: { threadId: first.threadId, turn: { id: first.turnId, status: 'completed', items: [] } } });
  await f.engine.command({ type: 'edit_feed_collection', collectionId: a.collectionId, expectedRevision: 1, requestId: 'reset-effort', changes: { capabilities: { model: 'fixture-model', reasoningEffort: null, skills: [], plugins: [] } } });
  catalogHasDefault = false;
  await f.engine.command({ type: 'run_feed_collection', collectionId: a.collectionId, requestId: 'next-effort', input: { text: '' } });
  await until(() => f.clients[0].calls.some(c => c.method === 'thread/resume'));
  const latest = (await f.engine.command({ type: 'list_feed_runs', collectionId: a.collectionId })).runs!.items[0];
  assert.equal(latest.status, 'failed'); assert.match(latest.error!, /默认思考强度/);
  assert.equal(f.clients[0].calls.filter(c => c.method === 'turn/start').length, 1);
});

test('application login cannot replace the shared account during an admitted personal collection', async t => {
  const root = mkdtempSync(resolve(projectDirectory(process.cwd(), '.runtime', 'tests'), 'feed-account-guard-'));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const account = accountFixture();
  const engine = new WorkflowEngine({ workbenchRoot: root, executable: 'fixture', accountFactory: account.factory, nativeFactory: () => ({ connect: () => gate, async close() {}, async rpc() { return { account: null }; } }) });
  t.after(() => engine.close()); await engine.init();
  await engine.command({ type: 'create_feed_collection', name: 'guard', instruction: '', input: { text: 'collect' }, requestId: 'guard' });
  try { await assert.rejects(engine.command({ type: 'login' }), /采集|任务/); } finally { release(); }
  assert.equal(account.calls.some(c => c.method === 'account/login/start'), false);
});

test('independent native conversations resume their own thread and chat claims never save entries', async t => {
  const f = await feedFixture(t);
  const a = (await f.create('A')).admission!, b = (await f.create('B')).admission!;
  await until(() => f.clients.length === 2 && f.clients.every(c => c.calls.some(call => call.method === 'turn/start')));
  const aRun = (await f.engine.command({ type: 'list_feed_runs', collectionId: a.collectionId })).runs!.items[0];
  const bRun = (await f.engine.command({ type: 'list_feed_runs', collectionId: b.collectionId })).runs!.items[0];
  assert.notEqual(aRun.threadId, bRun.threadId);
  const client = f.clients.find(c => c.calls.some(call => call.method === 'turn/start' && call.params.threadId === aRun.threadId))!;
  client.options.onEvent({ method: 'item/completed', params: { threadId: aRun.threadId, turnId: aRun.turnId, item: { id: 'answer', type: 'agentMessage', text: '已保存' } } });
  client.options.onEvent({ method: 'turn/completed', params: { threadId: aRun.threadId, turn: { id: aRun.turnId, status: 'completed', items: [] } } });
  assert.equal((await f.engine.command({ type: 'search_feed_entries', query: {} })).entries!.items.length, 0);
  await f.engine.command({ type: 'send_feed_message', collectionId: a.collectionId, requestId: 'again', input: { text: 'Follow up' } });
  await until(() => client.calls.filter(call => call.method === 'turn/start').length === 2);
  assert.equal(client.calls.find(call => call.method === 'thread/resume')!.params.threadId, aRun.threadId);
});
