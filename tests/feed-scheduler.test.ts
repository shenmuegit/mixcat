import { feedFixture } from './feed-runtime-fixture.js';
import { until } from './runtime-fixture.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { nextDueAt } from '../src/core/feed-scheduler.js';
import { mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { FeedEngine } from '../src/core/feed-runtime.js';
import { FeedStore } from '../src/core/feed-store.js';
import { FeedCollections } from '../src/core/feed-collections.js';
import { projectDirectory } from '../src/core/paths.js';
import type { SharedAccount } from '../src/core/account.js';

test('daily Shanghai due is strictly after clock and weekly follows local weekday', () => {
  const daily = { frequency: 'daily', enabled: true, time: '09:00', timeZone: 'Asia/Shanghai' } as const;
  assert.equal(nextDueAt(daily, '2026-10-29T00:59:00Z'), '2026-10-29T01:00:00.000Z');
  assert.equal(nextDueAt(daily, '2026-10-29T01:00:00Z'), '2026-10-30T01:00:00.000Z');
  assert.equal(nextDueAt({ ...daily, frequency: 'weekly', weekday: 1 }, '2026-10-29T00:59:00Z'), '2026-11-02T01:00:00.000Z');
});

async function scheduledFixture(t: any, initial = '2026-10-26T02:00:00Z') {
  const root = mkdtempSync(resolve(projectDirectory(process.cwd(), '.runtime', 'tests'), 'feed-schedules-'));
  let now = initial;
  const store = new FeedStore(root), collections = new FeedCollections(store);
  const admission = collections.create({ type: 'create_feed_collection', name: 'scheduled', instruction: 'verified news', requestId: 'fixture-create', input: { text: 'first' } });
  const collection = collections.get(admission.collectionId); collection.queueHeld = true; collections.save(collection);
  const engine = new FeedEngine({ store, account: { credentials: async () => null } as unknown as SharedAccount, executable: 'fixture', now: () => now });
  await engine.init(); t.after(() => engine.close());
  return { root, store, collections, engine, id: collection.id, clock: (at: string) => { now = at; } };
}

test('three missed dates merge once while held, and pause only cancels automatic work', async t => {
  const f = await scheduledFixture(t);
  await f.engine.command({ type: 'set_feed_schedule', collectionId: f.id, expectedRevision: f.collections.get(f.id).revision, requestId: 'set-schedule', schedule: { frequency: 'daily', enabled: true, time: '09:00', timeZone: 'Asia/Shanghai' } });
  f.engine.reconcileSchedules('2026-10-29T01:00:30Z');
  f.engine.reconcileSchedules('2026-10-29T01:00:30Z');
  let automatic = f.collections.runs(f.id).filter(r => r.scheduleRevision);
  assert.equal(automatic.length, 1); assert.equal(automatic[0].trigger, 'catchup'); assert.equal(automatic[0].status, 'queued');
  assert.deepEqual(automatic[0].coverageWindow, { start: '2026-10-26T02:00:00.000Z', end: '2026-10-29T01:00:00.000Z' });
  assert.equal(f.collections.get(f.id).nextDueAt, '2026-10-30T01:00:00.000Z');
  f.engine.reconcileSchedules('2026-10-30T01:00:30Z');
  automatic = f.collections.runs(f.id).filter(r => r.scheduleRevision);
  assert.equal(automatic.length, 1); assert.equal(automatic[0].coverageWindow?.end, '2026-10-30T01:00:00.000Z');
  await f.engine.command({ type: 'send_feed_message', collectionId: f.id, requestId: 'message', input: { text: 'keep message' } });
  const c = f.collections.get(f.id);
  await f.engine.command({ type: 'pause_feed_schedule', collectionId: f.id, expectedRevision: c.revision, requestId: 'pause' });
  assert.equal(f.collections.run(automatic[0].id).status, 'cancelled');
  assert.equal(f.collections.runs(f.id).filter(r => ['collect', 'message'].includes(r.trigger)).every(r => r.status === 'queued'), true);
  assert.equal(f.collections.get(f.id).nextDueAt, null);
  f.clock('2026-11-02T02:00:00Z');
  await f.engine.command({ type: 'resume_feed_schedule', collectionId: f.id, expectedRevision: f.collections.get(f.id).revision, requestId: 'resume' });
  assert.equal(f.collections.get(f.id).nextDueAt, '2026-11-03T01:00:00.000Z');
  assert.equal(f.collections.get(f.id).queueHeld, true);
});

test('IANA DST gaps skip the local day and folds never select the second copy', () => {
  const daily = { frequency: 'daily', enabled: true, time: '02:30', timeZone: 'America/New_York' } as const;
  assert.equal(nextDueAt(daily, '2026-03-08T05:00:00Z'), '2026-03-09T06:30:00.000Z');
  assert.equal(nextDueAt({ ...daily, frequency: 'weekly', weekday: 0 }, '2026-03-08T05:00:00Z'), '2026-03-15T06:30:00.000Z');
  assert.equal(nextDueAt({ ...daily, time: '01:30' }, '2026-11-01T05:29:59.999Z'), '2026-11-01T05:30:00.000Z');
  for (const at of ['2026-11-01T05:30:00Z', '2026-11-01T05:45:00Z', '2026-11-01T06:10:00Z']) assert.equal(nextDueAt({ ...daily, time: '01:30' }, at), '2026-11-02T06:30:00.000Z');
  assert.equal(nextDueAt({ ...daily, time: '02:15', timeZone: 'Australia/Lord_Howe' }, '2026-10-03T14:00:00Z'), '2026-10-04T15:15:00.000Z');
  assert.equal(nextDueAt({ ...daily, time: '01:45', timeZone: 'Australia/Lord_Howe' }, '2026-04-04T14:50:00Z'), '2026-04-05T15:15:00.000Z');
  assert.equal(nextDueAt({ ...daily, time: '09:00', timeZone: 'Asia/Kathmandu' }, '2026-10-29T03:14:00Z'), '2026-10-29T03:15:00.000Z');
  assert.equal(nextDueAt({ ...daily, time: '00:00', timeZone: 'UTC' }, '2026-12-31T23:59:00Z'), '2027-01-01T00:00:00.000Z');
  assert.equal(nextDueAt({ ...daily, time: '00:00', timeZone: 'UTC' }, '2028-02-28T23:59:00Z'), '2028-02-29T00:00:00.000Z');
});

test('schedule validation rejects invalid timezone, wall time, weekday, instant and extra fields', async t => {
  const base = { frequency: 'daily', enabled: true, time: '09:00', timeZone: 'Asia/Shanghai' } as const;
  for (const invalid of [{ ...base, time: '24:00' }, { ...base, timeZone: 'Mars/Olympus' }, { ...base, timeZone: '+08:00' }, ...[-1, 7, 1.5].map(weekday => ({ ...base, frequency: 'weekly', weekday })), { ...base, extra: 1 }]) assert.throws(() => nextDueAt(invalid as any, '2026-10-29T00:00:00Z'));
  assert.throws(() => nextDueAt(base, 'invalid'));
  assert.equal(nextDueAt({ frequency: 'manual' }, '2026-10-29T00:00:00Z'), null);
  assert.equal(nextDueAt({ ...base, enabled: false }, '2026-10-29T00:00:00Z'), null);
  const f = await scheduledFixture(t), before = f.store.revision;
  await assert.rejects(f.engine.command({ type: 'set_feed_schedule', collectionId: f.id, schedule: { ...base, timeZone: 'Mars/Olympus' }, expectedRevision: f.collections.get(f.id).revision, requestId: 'bad' }));
  assert.equal(f.store.revision, before); assert.equal(f.collections.get(f.id).schedule.frequency, 'manual');
});

test('restart merges recovered not_sent automatic queue before its first pump, receipts survive clock rewind', async t => {
  const f = await scheduledFixture(t);
  await f.engine.command({ type: 'set_feed_schedule', collectionId: f.id, schedule: { frequency: 'daily', enabled: true, time: '09:00', timeZone: 'Asia/Shanghai' }, expectedRevision: f.collections.get(f.id).revision, requestId: 'restart-set' });
  f.engine.reconcileSchedules('2026-10-27T01:00:00Z');
  const run = f.collections.runs(f.id).find(r => r.scheduleRevision)!;
  run.status = 'starting'; run.startedAt = '2026-10-27T01:00:00Z'; f.collections.saveRun(run);
  await f.engine.close();
  const store = new FeedStore(f.root), collections = new FeedCollections(store);
  const engine = new FeedEngine({ store, account: {} as SharedAccount, executable: 'fixture', now: () => '2026-10-29T01:00:30Z' });
  await engine.init(); t.after(() => engine.close());
  assert.equal(collections.runs(f.id).filter(r => r.scheduleRevision).length, 1);
  assert.equal(collections.run(run.id).trigger, 'catchup'); assert.equal(collections.run(run.id).coverageWindow?.end, '2026-10-29T01:00:00.000Z');
  let c = collections.get(f.id); c.nextDueAt = '2026-10-27T01:00:00.000Z'; collections.save(c);
  engine.reconcileSchedules('2026-10-29T01:00:30Z');
  assert.equal(collections.runs(f.id).filter(r => r.scheduleRevision).length, 1);
  engine.reconcileSchedules('2026-10-28T00:00:00Z');
  assert.equal(collections.get(f.id).nextDueAt, '2026-10-30T01:00:00.000Z');
});

for (const stage of ['receipt', 'cursor', 'merge']) test(`scheduler ${stage} write failure rolls back all state and emits no phantom admission`, async t => {
  const f = await scheduledFixture(t);
  await f.engine.command({ type: 'set_feed_schedule', collectionId: f.id, schedule: { frequency: 'daily', enabled: true, time: '09:00', timeZone: 'Asia/Shanghai' }, expectedRevision: f.collections.get(f.id).revision, requestId: 'failure-set' });
  if (stage === 'merge') f.engine.reconcileSchedules('2026-10-27T01:00:00Z');
  const revision = f.store.revision, before = JSON.stringify(f.collections.runs(f.id)), cursor = f.collections.get(f.id).nextDueAt;
  const seen: number[] = []; f.engine.subscribe(snapshot => seen.push(snapshot.revision));
  const trigger = stage === 'receipt' ? "CREATE TEMP TRIGGER fail_schedule BEFORE INSERT ON feed_receipts WHEN NEW.key LIKE 'schedule:%' BEGIN SELECT RAISE(ABORT,'schedule receipt failure'); END;" : stage === 'cursor' ? "CREATE TEMP TRIGGER fail_schedule BEFORE UPDATE ON feed_collections BEGIN SELECT RAISE(ABORT,'schedule cursor failure'); END;" : "CREATE TEMP TRIGGER fail_schedule BEFORE UPDATE ON feed_runs BEGIN SELECT RAISE(ABORT,'schedule merge failure'); END;";
  f.store.db.exec(trigger);
  assert.throws(() => f.engine.reconcileSchedules('2026-10-29T01:00:30Z'), /schedule/);
  assert.equal(f.store.revision, revision); assert.equal(JSON.stringify(f.collections.runs(f.id)), before); assert.equal(f.collections.get(f.id).nextDueAt, cursor);
  assert.equal(seen.every(value => value === revision), true);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM feed_receipts WHERE key LIKE 'schedule:%'").get()!.n, stage === 'merge' ? 1 : 0);
  f.store.db.exec('DROP TRIGGER fail_schedule');
  await f.engine.close();
  const store = new FeedStore(f.root), engine = new FeedEngine({ store, account: {} as SharedAccount, executable: 'fixture', now: () => '2026-10-29T01:00:30Z' });
  await engine.init(); t.after(() => engine.close());
  assert.equal(new FeedCollections(store).runs(f.id).filter(r => r.scheduleRevision).length, 1);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM feed_receipts WHERE key LIKE 'schedule:%'").get()!.n, 3);
});



test('pause/due ordering preserves active and uncertain attempts and receipt replay is durable', async t => {
  const f = await scheduledFixture(t);
  const schedule = { frequency: 'daily', enabled: true, time: '09:00', timeZone: 'Asia/Shanghai' } as const;
  await f.engine.command({ type: 'set_feed_schedule', collectionId: f.id, schedule, expectedRevision: f.collections.get(f.id).revision, requestId: 'race-set' });
  f.engine.reconcileSchedules('2026-10-27T01:00:00Z');
  const automatic = f.collections.runs(f.id).find(r => r.scheduleRevision)!;
  automatic.status = 'running'; automatic.dispatchState = 'acknowledged'; automatic.turnId = 'owned-turn'; f.collections.saveRun(automatic);
  f.engine.reconcileSchedules('2026-10-28T01:00:00Z');
  const pending = f.collections.runs(f.id).find(r => r.scheduleRevision && r.status === 'queued')!;
  const c = f.collections.get(f.id), command = { type: 'pause_feed_schedule', collectionId: f.id, expectedRevision: c.revision, requestId: 'race-pause' } as const;
  await f.engine.command(command); await f.engine.command(command);
  assert.equal(f.collections.run(automatic.id).status, 'running'); assert.equal(f.collections.run(pending.id).status, 'cancelled');
  f.engine.reconcileSchedules('2026-10-30T01:00:00Z'); assert.equal(f.collections.runs(f.id).filter(r => r.scheduleRevision).length, 2);
  await assert.rejects(f.engine.command({ ...command, requestId: 'stale-pause' }), /冲突/);
  f.clock('2026-10-30T01:00:00Z');
  await f.engine.command({ type: 'resume_feed_schedule', collectionId: f.id, expectedRevision: f.collections.get(f.id).revision, requestId: 'race-resume' });
  assert.equal(f.collections.get(f.id).nextDueAt, '2026-10-31T01:00:00.000Z');
  f.engine.reconcileSchedules('2026-10-31T01:00:00Z');
  const next = f.collections.runs(f.id).find(r => r.scheduleRevision && r.status === 'queued')!;
  assert.deepEqual(next.coverageWindow, { start: '2026-10-30T01:00:00.000Z', end: '2026-10-31T01:00:00.000Z' });
  await f.engine.close();
  const store = new FeedStore(f.root), collections = new FeedCollections(store), engine = new FeedEngine({ store, account: {} as SharedAccount, executable: 'fixture', now: () => '2026-10-31T01:00:00Z' });
  await engine.init(); t.after(() => engine.close());
  assert.equal(collections.run(automatic.id).status, 'needs_reconciliation');
  await engine.command(command); // A stale revision is allowed only for the same durable receipt.
  const restoredSchedule = collections.get(f.id).schedule; assert.equal(restoredSchedule.frequency === 'daily' && restoredSchedule.enabled, true);
  assert.equal(collections.runs(f.id).filter(r => r.scheduleRevision).length, 3);
});

test('30-second tick uses the reconciler, same-time resume is a no-op and close clears the timer', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = await scheduledFixture(t);
  await f.engine.command({ type: 'set_feed_schedule', collectionId: f.id, schedule: { frequency: 'daily', enabled: true, time: '09:00', timeZone: 'Asia/Shanghai' }, expectedRevision: f.collections.get(f.id).revision, requestId: 'tick-set' });
  f.clock('2026-10-27T01:00:00Z'); t.mock.timers.tick(30000);
  const revision = f.store.revision; f.engine.reconcileSchedules();
  assert.equal(f.store.revision, revision); assert.equal(f.collections.runs(f.id).filter(r => r.scheduleRevision).length, 1);
  await f.engine.close(); f.clock('2026-10-28T01:00:00Z'); t.mock.timers.tick(60000);
  assert.throws(() => f.engine.reconcileSchedules(), /关闭/);
});

test('New York first fold occurrence receipt survives reopening and the missing local day creates no occurrence', async t => {
  const f = await scheduledFixture(t, '2026-10-31T07:00:00Z');
  await f.engine.command({ type: 'set_feed_schedule', collectionId: f.id, schedule: { frequency: 'daily', enabled: true, time: '01:30', timeZone: 'America/New_York' }, expectedRevision: f.collections.get(f.id).revision, requestId: 'fold-set' });
  f.engine.reconcileSchedules('2026-11-01T05:30:00Z'); await f.engine.close();
  const store = new FeedStore(f.root), collections = new FeedCollections(store), engine = new FeedEngine({ store, account: {} as SharedAccount, executable: 'fixture', now: () => '2026-11-01T06:10:00Z' });
  await engine.init(); t.after(() => engine.close()); engine.reconcileSchedules('2026-11-01T06:30:00Z');
  assert.equal(collections.runs(f.id).filter(r => r.scheduleRevision).length, 1); assert.equal(collections.get(f.id).nextDueAt, '2026-11-02T06:30:00.000Z');
  const gap = await scheduledFixture(t, '2026-03-07T08:00:00Z');
  await gap.engine.command({ type: 'set_feed_schedule', collectionId: gap.id, schedule: { frequency: 'daily', enabled: true, time: '02:30', timeZone: 'America/New_York' }, expectedRevision: gap.collections.get(gap.id).revision, requestId: 'gap-set' });
  gap.engine.reconcileSchedules('2026-03-08T20:00:00Z'); assert.equal(gap.collections.runs(gap.id).filter(r => r.scheduleRevision).length, 0);
  gap.engine.reconcileSchedules('2026-03-09T06:30:00Z');
  assert.deepEqual(gap.collections.runs(gap.id).find(r => r.scheduleRevision)?.coverageWindow, { start: '2026-03-07T08:00:00.000Z', end: '2026-03-09T06:30:00.000Z' });
});

test('admission wake waits for the outer commit and is discarded on rollback', async t => {
  const f = await scheduledFixture(t);
  const original = f.engine.wake.bind(f.engine); let wakes = 0;
  f.engine.wake = () => { wakes++; original(); };
  assert.throws(() => f.store.transaction(() => {
    f.engine.enqueueCollectionRun(f.id, { trigger: 'schedule', text: 'outer input', scheduleRevision: 1, coverageWindow: { start: '2026-10-26T01:00:00Z', end: '2026-10-27T01:00:00Z' } }, 'outer-request');
    assert.equal(wakes, 0); throw new Error('rollback outer');
  }), /rollback outer/);
  assert.equal(wakes, 0); assert.equal(f.collections.runs(f.id).filter(r => r.scheduleRevision).length, 0);
  f.store.transaction(() => {
    f.engine.enqueueCollectionRun(f.id, { trigger: 'schedule', text: 'outer input', scheduleRevision: 1, coverageWindow: { start: '2026-10-26T01:00:00Z', end: '2026-10-27T01:00:00Z' } }, 'outer-request');
    assert.equal(wakes, 0);
  });
  assert.equal(wakes, 1);
});

test('startup merges provably undispatched input before even the first public wake', async t => {
  const f = await scheduledFixture(t);
  await f.engine.command({ type: 'set_feed_schedule', collectionId: f.id, schedule: { frequency: 'daily', enabled: true, time: '09:00', timeZone: 'Asia/Shanghai' }, expectedRevision: f.collections.get(f.id).revision, requestId: 'startup-set' });
  f.engine.reconcileSchedules('2026-10-27T01:00:00Z');
  const first = f.collections.runs(f.id).find(r => r.scheduleRevision)!; first.status = 'starting'; f.collections.saveRun(first);
  await f.engine.close();
  const store = new FeedStore(f.root), collections = new FeedCollections(store), engine = new FeedEngine({ store, account: {} as SharedAccount, executable: 'fixture', now: () => '2026-10-29T01:00:30Z' });
  const original = engine.wake.bind(engine); let observed = false;
  engine.wake = () => {
    const automatic = collections.runs(f.id).filter(r => r.scheduleRevision);
    assert.equal(automatic.length, 1); assert.equal(automatic[0].status, 'queued'); assert.equal(automatic[0].coverageWindow?.end, '2026-10-29T01:00:00.000Z'); observed = true; original();
  };
  await engine.init(); t.after(() => engine.close()); assert.equal(observed, true);
});


test('delete pauses future schedules and restore requires an explicit from-now resume', async t => {
  const f = await scheduledFixture(t);
  const get = () => f.collections.get(f.id);
  await f.engine.command({ type: 'set_feed_schedule', collectionId: f.id, schedule: { frequency: 'daily', enabled: true, time: '09:00', timeZone: 'Asia/Shanghai' }, expectedRevision: get().revision, requestId: 'delete-set' });
  f.engine.reconcileSchedules('2026-10-27T01:00:00Z');
  await f.engine.command({ type: 'delete_feed_collection', collectionId: f.id, expectedRevision: get().revision, requestId: 'delete-scheduled' });
  assert.equal(((schedule) => schedule.frequency === 'daily' && schedule.enabled)(get().schedule), false); assert.equal(get().nextDueAt, null); assert.equal(get().scheduleCoverageStart, null);
  assert.equal(f.collections.runs(f.id).filter(r => r.scheduleRevision).every(r => r.status === 'cancelled'), true);
  f.engine.reconcileSchedules('2026-10-29T01:00:00Z');
  await f.engine.command({ type: 'restore_feed_collection', collectionId: f.id, expectedRevision: get().revision, requestId: 'restore-scheduled' });
  assert.equal(((schedule) => schedule.frequency === 'daily' && schedule.enabled)(get().schedule), false); assert.equal(get().queueHeld, true);
  f.clock('2026-10-30T02:00:00Z');
  await f.engine.command({ type: 'resume_feed_schedule', collectionId: f.id, expectedRevision: get().revision, requestId: 'resume-restored' });
  f.engine.reconcileSchedules('2026-10-31T01:00:00Z');
  assert.deepEqual(f.collections.runs(f.id).find(r => r.status === 'queued')?.coverageWindow, { start: '2026-10-30T02:00:00.000Z', end: '2026-10-31T01:00:00.000Z' });
});

test('replacing timezone withdraws old automatic queue without changing manual work or instruction revision', async t => {
  const f = await scheduledFixture(t), get = () => f.collections.get(f.id);
  await f.engine.command({ type: 'set_feed_schedule', collectionId: f.id, schedule: { frequency: 'daily', enabled: true, time: '09:00', timeZone: 'Asia/Shanghai' }, expectedRevision: get().revision, requestId: 'replace-first' });
  f.engine.reconcileSchedules('2026-10-27T01:00:00Z'); const old = f.collections.runs(f.id).find(r => r.scheduleRevision)!;
  const previousRevision = get().scheduleRevision, instructionRevision = get().instructionRevision;
  await f.engine.command({ type: 'edit_feed_collection', collectionId: f.id, expectedRevision: get().revision, changes: { name: 'renamed' }, requestId: 'rename-schedule' });
  assert.equal(get().scheduleRevision, previousRevision);
  f.clock('2026-10-27T02:00:00Z');
  await f.engine.command({ type: 'set_feed_schedule', collectionId: f.id, schedule: { frequency: 'weekly', weekday: 2, enabled: true, time: '09:00', timeZone: 'UTC' }, expectedRevision: get().revision, requestId: 'replace-zone' });
  assert.equal(f.collections.run(old.id).status, 'cancelled'); assert.equal(f.collections.runs(f.id).find(r => r.trigger === 'collect')?.status, 'queued');
  assert.equal(get().nextDueAt, '2026-10-27T09:00:00.000Z'); assert.equal(get().scheduleRevision, previousRevision + 1); assert.equal(get().instructionRevision, instructionRevision);
  f.engine.reconcileSchedules('2026-10-27T09:00:00Z');
  const current = f.collections.runs(f.id).find(r => r.scheduleRevision === previousRevision + 1)!;
  assert.deepEqual(current.coverageWindow, { start: '2026-10-27T02:00:00.000Z', end: '2026-10-27T09:00:00.000Z' });
});

test('automatic admission uses the serial native path and dispatches its committed coverage window', async t => {
  const { engine, clients, create } = await feedFixture(t);
  const first = (await create('native-schedule')).admission!;
  await until(() => clients[0]?.calls.some(call => call.method === 'turn/start') === true);
  const detail = async () => (await engine.command({ type: 'get_feed_collection', collectionId: first.collectionId })).collection!;
  let c = (await detail()).collection;
  await engine.command({ type: 'set_feed_schedule', collectionId: c.id, schedule: { frequency: 'daily', enabled: true, time: '09:00', timeZone: 'Asia/Shanghai' }, expectedRevision: c.revision, requestId: 'native-schedule-set' });
  c = (await detail()).collection; engine.reconcileSchedules(c.nextDueAt!);
  assert.equal(clients[0].calls.filter(call => call.method === 'turn/start').length, 1);
  const active = (await detail()).activeRun!;
  clients[0].options.onEvent({ method: 'turn/completed', params: { threadId: active.threadId, turn: { id: active.turnId, status: 'completed', items: [] } } });
  await until(() => clients[0].calls.filter(call => call.method === 'turn/start').length === 2);
  const automatic = (await detail()).activeRun!; assert.equal(automatic.trigger, 'schedule'); assert.equal(automatic.coverageWindow?.end, c.nextDueAt);
  const input = clients[0].calls.filter(call => call.method === 'turn/start')[1].params.input;
  assert.equal(input.some((item: any) => item.text?.includes(automatic.coverageWindow!.start) && item.text?.includes(automatic.coverageWindow!.end)), true);
  await engine.command({ type: 'pause_feed_schedule', collectionId: c.id, expectedRevision: (await detail()).collection.revision, requestId: 'native-active-pause' });
  assert.equal((await detail()).activeRun?.id, automatic.id); assert.equal((await detail()).activeRun?.status, 'running');
});
