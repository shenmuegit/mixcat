import { FeedEngine } from '../src/core/feed-runtime.js';
import { FeedStore } from '../src/core/feed-store.js';
import type { SharedAccount } from '../src/core/account.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, linkSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { feedFixture } from './feed-runtime-fixture.js';
import { until } from './runtime-fixture.js';

test('new collection starts goal conversation and accepts goal atomically at successful terminal', async t => {
  const f = await feedFixture(t), a = (await f.create('first-message')).admission!;
  await until(() => f.clients[0]?.calls.some(c => c.method === 'turn/start'));
  const run = (await f.engine.command({ type: 'list_feed_runs', collectionId: a.collectionId })).runs!.items[0];
  assert.equal(run.trigger, 'message');
  const client = f.clients[0], turn = client.calls.find(c => c.method === 'turn/start')!;
  assert.equal(turn.params.input[0].text, 'first-message');
  const goal = { requestId: 'goal1', name: 'News', objective: 'Read verified news', schedule: { frequency: 'daily', enabled: true, time: '09:00', timeZone: 'Asia/Shanghai' }, expectedRevision: 1 };
  writeFileSync(join(client.options.cwd!, 'goal.json'), JSON.stringify(goal));
  client.options.onEvent({ method: 'turn/completed', params: { threadId: run.threadId, turn: { id: run.turnId, status: 'completed', items: [] } } });
  const saved = (await f.engine.command({ type: 'get_feed_collection', collectionId: a.collectionId })).collection!.collection;
  assert.equal(saved.name, 'News'); assert.equal(saved.instruction, goal.objective); assert.deepEqual(saved.schedule, goal.schedule);
  client.options.onEvent({ method: 'turn/completed', params: { threadId: run.threadId, turn: { id: run.turnId, status: 'completed', items: [] } } });
  assert.deepEqual((await f.engine.command({ type: 'get_feed_collection', collectionId: a.collectionId })).collection!.collection, saved);
});


for (const kind of ['json', 'schema', 'revision', 'hardlink', 'symlink', 'oversize', 'utf8', 'failed', 'unknown']) test(`goal ${kind} leaves saved configuration intact`, async t => {
  const f = await feedFixture(t), a = (await f.create(`invalid-${kind}`)).admission!;
  await until(() => f.clients[0]?.calls.some(c => c.method === 'turn/start'));
  const before = (await f.engine.command({ type: 'get_feed_collection', collectionId: a.collectionId })).collection!.collection;
  const run = (await f.engine.command({ type: 'list_feed_runs', collectionId: a.collectionId })).runs!.items[0];
  const client = f.clients[0], path = join(client.options.cwd!, 'goal.json');
  const valid = { requestId: 'new-goal', name: 'Changed', objective: 'New objective', schedule: { frequency: 'manual' }, expectedRevision: before.revision };
  if (kind === 'hardlink' || kind === 'symlink') { const target = join(client.options.cwd!, 'target.json'); writeFileSync(target, JSON.stringify(valid)); if (kind === 'hardlink') linkSync(target, path); else symlinkSync(target, path); }
  else writeFileSync(path, kind === 'json' ? '{' : kind === 'oversize' ? ' '.repeat(512 * 1024 + 1) : kind === 'utf8' ? Buffer.from([0xff]) : JSON.stringify({ ...valid, ...(kind === 'schema' ? { extra: true } : {}), ...(kind === 'revision' ? { expectedRevision: 99 } : {}) }));
  if (kind === 'unknown') client.options.onDisconnect('lost');
  else client.options.onEvent({ method: 'turn/completed', params: { threadId: run.threadId, turn: { id: run.turnId, status: kind === 'failed' ? 'failed' : 'completed', items: [] } } });
  assert.deepEqual((await f.engine.command({ type: 'get_feed_collection', collectionId: a.collectionId })).collection!.collection, before);
  if (!['failed', 'unknown'].includes(kind)) assert.match((await f.engine.command({ type: 'read_feed_history', collectionId: a.collectionId })).history!.items.find(h => h.id === `goal:${run.id}`)!.text, /未接受/);
});

test('goal replay, immutable request and unchanged schedule preserve accepted coverage', async t => {
  const f = await feedFixture(t), a = (await f.create('replay')).admission!;
  const get = async () => (await f.engine.command({ type: 'get_feed_collection', collectionId: a.collectionId })).collection!.collection;
  await until(() => f.clients[0]?.calls.some(c => c.method === 'turn/start'));
  const client = f.clients[0], path = join(client.options.cwd!, 'goal.json');
  const goal = { requestId: 'goal', name: 'News', objective: 'Objective', schedule: { frequency: 'daily', enabled: true, time: '09:00', timeZone: 'UTC' }, expectedRevision: (await get()).revision };
  const finish = async () => { const run = (await f.engine.command({ type: 'get_feed_collection', collectionId: a.collectionId })).collection!.activeRun!; client.options.onEvent({ method: 'turn/completed', params: { threadId: run.threadId, turn: { id: run.turnId, status: 'completed', items: [] } } }); };
  let count = 1;
  const next = async () => { await f.engine.command({ type: 'send_feed_message', collectionId: a.collectionId, requestId: `next-${++count}`, input: { text: 'Continue' } }); await until(() => client.calls.filter(c => c.method === 'turn/start').length === count); };
  writeFileSync(path, JSON.stringify(goal)); await finish(); const saved = await get();
  await next(); await finish(); assert.deepEqual(await get(), saved);
  await next(); writeFileSync(path, JSON.stringify({ ...goal, name: 'Forged', expectedRevision: saved.revision })); await finish(); assert.deepEqual(await get(), saved);
  await next(); writeFileSync(path, JSON.stringify({ ...goal, requestId: 'rename', name: 'Renamed', objective: 'Updated objective', expectedRevision: saved.revision })); await finish();
  const renamed = await get(); assert.equal(renamed.name, 'Renamed'); assert.equal(renamed.nextDueAt, saved.nextDueAt); assert.equal(renamed.scheduleCoverageStart, saved.scheduleCoverageStart); assert.equal(renamed.scheduleRevision, saved.scheduleRevision);
});

test('successful native reconciliation accepts goal once after reopening', async t => {
  const f = await feedFixture(t), a = (await f.create('recover-goal')).admission!;
  await until(() => f.clients[0]?.calls.some(c => c.method === 'turn/start'));
  const run = (await f.engine.command({ type: 'get_feed_collection', collectionId: a.collectionId })).collection!.activeRun!;
  writeFileSync(join(f.clients[0].options.cwd!, 'goal.json'), JSON.stringify({ requestId: 'recover', name: 'Recovered', objective: 'Recovered objective', schedule: { frequency: 'manual' }, expectedRevision: 1 }));
  await f.engine.close();
  const reopened = new FeedEngine({ store: new FeedStore(f.root), account: { credentials: async () => ({ accessToken: 'fixture', chatgptAccountId: 'fixture' }) } as unknown as SharedAccount, executable: 'fixture', nativeFactory: () => ({ async connect() {}, async close() {}, async rpc(method) { if (method === 'account/read') return { account: {} }; if (method === 'thread/read') return { thread: { id: run.threadId, turns: [{ id: run.turnId, status: 'completed', items: [] }] } }; return {}; } }) });
  await reopened.init(); t.after(() => reopened.close());
  await reopened.command({ type: 'reconcile_feed_run', runId: run.id, requestId: 'reconcile-goal' });
  const saved = (await reopened.command({ type: 'get_feed_collection', collectionId: a.collectionId })).collection!.collection;
  assert.equal(saved.name, 'Recovered');
  await reopened.command({ type: 'reconcile_feed_run', runId: run.id, requestId: 'reconcile-again' });
  assert.deepEqual((await reopened.command({ type: 'get_feed_collection', collectionId: a.collectionId })).collection!.collection, saved);
});

test('goal change cancels old unstarted automatic work and freezes the active instruction', async t => {
  const f = await feedFixture(t), a = (await f.create('goal-queue')).admission!;
  await until(() => f.clients[0]?.calls.some(c => c.method === 'turn/start'));
  const get = async () => (await f.engine.command({ type: 'get_feed_collection', collectionId: a.collectionId })).collection!;
  const active = (await get()).activeRun!;
  await f.engine.command({ type: 'set_feed_schedule', collectionId: a.collectionId, requestId: 'existing-schedule', expectedRevision: 1, schedule: { frequency: 'daily', enabled: true, time: '09:00', timeZone: 'UTC' } });
  const automatic = f.engine.enqueueCollectionRun(a.collectionId, { trigger: 'schedule', text: 'Scheduled work', scheduleRevision: 1 }, 'automatic');
  const manual = (await f.engine.command({ type: 'send_feed_message', collectionId: a.collectionId, requestId: 'manual', input: { text: 'Follow-up' } })).admission!;
  const before = (await get()).collection;
  writeFileSync(join(f.clients[0].options.cwd!, 'goal.json'), JSON.stringify({ requestId: 'pause', name: 'Paused', objective: 'New objective', schedule: { ...before.schedule, enabled: false }, expectedRevision: before.revision }));
  f.clients[0].options.onEvent({ method: 'turn/completed', params: { threadId: active.threadId, turn: { id: active.turnId, status: 'completed', items: [] } } });
  const runs = (await f.engine.command({ type: 'list_feed_runs', collectionId: a.collectionId })).runs!.items;
  assert.equal(runs.find(r => r.id === automatic.id)!.status, 'cancelled');
  assert.notEqual(runs.find(r => r.id === manual.runId)!.status, 'cancelled');
  assert.equal(runs.find(r => r.id === active.id)!.instructionSnapshot, 'Collect verified text');
  assert.equal((await get()).collection.instruction, 'New objective');
  await until(() => f.clients[0].calls.filter(c => c.method === 'turn/start').length === 2);
  assert.equal((await get()).activeRun!.instructionSnapshot, 'New objective');
});

test('goal receipt storage failure rolls back name objective and schedule together', async t => {
  const f = await feedFixture(t), a = (await f.create('goal-atomic')).admission!;
  await until(() => f.clients[0]?.calls.some(c => c.method === 'turn/start'));
  const before = (await f.engine.command({ type: 'get_feed_collection', collectionId: a.collectionId })).collection!;
  const run = before.activeRun!;
  writeFileSync(join(f.clients[0].options.cwd!, 'goal.json'), JSON.stringify({ requestId: 'atomic', name: 'Must rollback', objective: 'Must rollback', schedule: { frequency: 'daily', time: '09:00', timeZone: 'UTC', enabled: true }, expectedRevision: 1 }));
  const store = f.engine.mcpService().store;
  store.db.exec("CREATE TRIGGER fail_goal_receipt BEFORE INSERT ON feed_receipts BEGIN SELECT RAISE(ABORT,'goal receipt failed'); END");
  f.clients[0].options.onEvent({ method: 'turn/completed', params: { threadId: run.threadId, turn: { id: run.turnId, status: 'completed', items: [] } } });
  assert.match(f.engine.snapshot().storageError!, /goal receipt failed/);
  store.db.exec('DROP TRIGGER fail_goal_receipt');
  await f.engine.close();
  const reopened = new FeedEngine({ store: new FeedStore(f.root), account: { credentials: async () => null } as unknown as SharedAccount, executable: 'fixture' });
  await reopened.init(); t.after(() => reopened.close());
  assert.deepEqual((await reopened.command({ type: 'get_feed_collection', collectionId: a.collectionId })).collection!.collection, before.collection);
});

for (const terminal of ['failed', 'interrupted']) test(`${terminal} proposal is not adopted by untouched later chat, but a new proposal can correct it`, async t => {
  const f = await feedFixture(t), a = (await f.create('abandoned')).admission!;
  await until(() => f.clients[0]?.calls.some(c => c.method === 'turn/start'));
  const client = f.clients[0], path = join(client.options.cwd!, 'goal.json');
  const get = async () => (await f.engine.command({ type: 'get_feed_collection', collectionId: a.collectionId })).collection!;
  const before = (await get()).collection;
  const proposal = { requestId: 'abandoned', name: 'Wrong carryover', objective: 'Abandoned objective', schedule: { frequency: 'manual' }, expectedRevision: before.revision };
  writeFileSync(path, JSON.stringify(proposal));
  const finish = async (status: string) => { const run = (await get()).activeRun!; client.options.onEvent({ method: 'turn/completed', params: { threadId: run.threadId, turn: { id: run.turnId, status, items: [] } } }); };
  await finish(terminal);
  await f.engine.command({ type: 'send_feed_message', collectionId: a.collectionId, input: { text: 'Unrelated chat' }, requestId: 'unrelated' });
  await until(() => client.calls.filter(c => c.method === 'turn/start').length === 2);
  await finish('completed'); assert.deepEqual((await get()).collection, before);
  await f.engine.command({ type: 'send_feed_message', collectionId: a.collectionId, input: { text: 'Correct goal' }, requestId: 'correct' });
  await until(() => client.calls.filter(c => c.method === 'turn/start').length === 3);
  writeFileSync(path, JSON.stringify({ ...proposal, requestId: 'corrected', name: 'Accepted correction' }));
  await finish('completed'); assert.equal((await get()).collection.name, 'Accepted correction');
});

test('later conversation gets current goal revision in turn input after schedule advances even when resume instructions are ignored', async t => {
  let pauseContext: any;
  const f = await feedFixture(t, (method, params, options) => {
    // This native peer consumes turn input only; it never applies resumed developer instructions.
    if (method === 'turn/start' && params.input[0].text === 'Pause this schedule') {
      const context = params.input.find((item: any) => item.type === 'text' && item.text.includes('<mixcat_current_goal>'));
      if (context) {
        pauseContext = JSON.parse(context.text.match(/<mixcat_current_goal>([\s\S]*?)<\/mixcat_current_goal>/)[1]);
        writeFileSync(join(options.cwd!, 'goal.json'), JSON.stringify({ ...pauseContext, requestId: 'pause-current', schedule: { ...pauseContext.schedule, enabled: false } }));
      }
    }
  });
  const a = (await f.create('fresh-goal-context')).admission!;
  const get = async () => (await f.engine.command({ type: 'get_feed_collection', collectionId: a.collectionId })).collection!;
  await until(() => f.clients[0]?.calls.some(call => call.method === 'turn/start'));
  const client = f.clients[0];
  const finish = async () => { const run = (await get()).activeRun!; client.options.onEvent({ method: 'turn/completed', params: { threadId: run.threadId, turn: { id: run.turnId, status: 'completed', items: [] } } }); };
  const goal = { requestId: 'initial-goal', name: 'Daily', objective: 'Daily result', schedule: { frequency: 'daily', enabled: true, time: '00:10', timeZone: 'Asia/Shanghai' }, expectedRevision: 1 };
  writeFileSync(join(client.options.cwd!, 'goal.json'), JSON.stringify(goal)); await finish();
  const accepted = (await get()).collection; assert.equal(accepted.revision, 2);
  f.engine.reconcileSchedules(accepted.nextDueAt!);
  await until(() => client.calls.filter(call => call.method === 'turn/start').length === 2);
  await finish();
  const advanced = (await get()).collection; assert.equal(advanced.revision, 3);
  await f.engine.command({ type: 'send_feed_message', collectionId: a.collectionId, requestId: 'pause-message', input: { text: 'Pause this schedule' } });
  await until(() => client.calls.filter(call => call.method === 'turn/start').length === 3);
  assert.deepEqual(pauseContext, { name: advanced.name, objective: advanced.instruction, schedule: advanced.schedule, expectedRevision: 3 });
  await finish();
  const paused = (await get()).collection;
  assert.equal(paused.schedule.frequency !== 'manual' && paused.schedule.enabled, false);
  assert.equal(paused.nextDueAt, null);
  assert.equal(paused.revision, 4);
  const initialInstructions = client.calls.find(call => call.method === 'thread/start')!.params.developerInstructions;
  assert.match(initialInstructions, /本轮.*快照/); assert.doesNotMatch(initialInstructions, /"expectedRevision":1/);
});
