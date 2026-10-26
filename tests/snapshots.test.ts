import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeUpdate, SnapshotReceiver } from '../src/shared/snapshots.js';
import type { AppSnapshot, AppUpdate, MessageReceipt } from '../src/shared/types.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collaborationFixture } from './collaboration-fixture.js';
import { until } from './runtime-fixture.js';
const full = (id: string, revision: number): AppSnapshot => ({ generation: 1, revision, projects: [], runtime: null, selected: { project: { id } as any, nodes: [], tasks: [], handoffs: [], activities: [], conversation: [] } });
const delta = (id: string, revision: number): AppUpdate => ({ kind: 'delta', generation: 1, revision, baseRevision: 1, projectId: id, projects: [], runtime: null, selected: full(id, revision).selected!, entries: [] });

test('late replies cannot revive a removed project or block navigation to another project', () => {
  const receiver = new SnapshotReceiver(async () => full('A', 1), () => {});
  receiver.accept({ kind: 'full', snapshot: full('A', 1) });
  const token = receiver.navigate(null);
  receiver.accept({ kind: 'full', snapshot: { ...full('A', 2), selected: null } }, token);
  receiver.accept({ kind: 'full', snapshot: full('A', 1) });
  assert.equal(receiver.snapshot!.selected, null);
  receiver.accept({ kind: 'full', snapshot: full('B', 3) });
  assert.equal(receiver.snapshot!.selected!.project.id, 'B');
});
test('missing baseline never advances applied revision, including A to B out of order', () => {
  assert.equal(mergeUpdate(null, delta('B', 3)).resyncProjectId, 'B');
  const a = full('A', 1);
  const missing = mergeUpdate(a, delta('B', 3));
  assert.equal(missing.snapshot, a);
  assert.equal(mergeUpdate(missing.snapshot, { kind: 'full', snapshot: full('B', 2) }).snapshot?.selected?.project.id, 'B');
});
test('older full and older generation cannot downgrade terminal state', () => {
  const latest = full('A', 4); latest.selected!.tasks = [{ id: 't', status: 'completed' } as any];
  assert.equal(mergeUpdate(latest, { kind: 'full', snapshot: full('A', 3) }).snapshot, latest);
  const old = full('B', 99); old.generation = 0;
  assert.equal(mergeUpdate(latest, { kind: 'full', snapshot: old }).snapshot, latest);
});

test('message metadata and reply associations survive delta merge and stale generations cannot replace them', () => {
  const baseline = full('A', 1);
  const update = delta('A', 2) as Extract<AppUpdate, { kind: 'delta' }>;
  update.selected.messages = [{ message_id: 'm', target_task_id: 'target', sourceTaskId: 'source', fromNodeId: 'a', fromName: '原名', toNodeId: 'b', toName: '接收者', replyTo: 'original', accepted_at: '' }];
  update.entries = [{ id: 'input', seq: 1, messageId: 'm', replyTo: 'original' } as any];
  const merged = mergeUpdate(baseline, update).snapshot!;
  assert.equal(merged.selected!.messages![0].fromName, '原名');
  assert.equal(merged.selected!.conversation![0].replyTo, 'original');
  const stale = delta('A', 99) as Extract<AppUpdate, { kind: 'delta' }>;
  stale.generation = 0; stale.selected.messages = [];
  assert.equal(mergeUpdate(merged, stale).snapshot, merged);
});

test('review policy and current version arrive through full and delta while legacy omissions stay valid', () => {
  const baseline = full('A', 1);
  const policy = { revision: 2, checkpoints: [] };
  baseline.selected!.reviewPolicy = policy;
  baseline.selected!.humanReviews = [{ id: 'review-1', version: 1, status: 'pending', bundleHash: 'fixed-1', attachments: [{ artifact_id: 'fixed' }] } as any];
  const receiver = new SnapshotReceiver(async () => baseline, () => {});
  receiver.accept({ kind: 'full', snapshot: baseline });
  assert.equal(receiver.snapshot!.selected!.humanReviews![0].bundleHash, 'fixed-1');
  const next = delta('A', 2) as Extract<AppUpdate, { kind: 'delta' }>;
  next.selected.reviewPolicy = policy;
  next.selected.humanReviews = [{ ...baseline.selected!.humanReviews[0], status: 'superseded' }, { ...baseline.selected!.humanReviews[0], id: 'review-2', version: 2, bundleHash: 'fixed-2' }];
  receiver.accept(next);
  assert.equal(receiver.snapshot!.selected!.humanReviews!.at(-1)!.bundleHash, 'fixed-2');
  assert.deepEqual(receiver.snapshot!.selected!.reviewPolicy, policy);
  receiver.accept({ kind: 'full', snapshot: baseline });
  assert.equal(receiver.snapshot!.selected!.humanReviews!.at(-1)!.version, 2);
  assert.equal(mergeUpdate(null, { kind: 'full', snapshot: full('old', 1) }).snapshot!.selected!.humanReviews, undefined);
});

test('sender body projection preserves every JSON value, receipt event and attachments through delta and source archive', async t => {
  const f = await collaborationFixture(t), source = await f.active('plan');
  await f.engine.command({ type: 'pause_node', projectId: f.projectId, nodeId: 'implement' });
  writeFileSync(join(f.root, 'projection.txt'), '不可变附件');
  const updates: AppUpdate[] = [];
  f.engine.subscribe(update => updates.push(update));
  (f.engine as any).emit(); await until(() => updates.length > 0); updates.length = 0;
  const values = [null, false, 0, '', ' 原始正文\n ', { free: [null, false, 0, ''] }];
  const receipts: MessageReceipt[] = [];
  for (const [index, content] of values.entries()) receipts.push(await f.invoke('plan', 'send_message', { request_id: `projection-${index}`, to_node_id: 'implement', content, reason: '保留原始原因', ...(index === 0 ? { attachments: [{ path: 'projection.txt' }] } : {}) }, `projection-${index}`));
  const snapshot = (await f.engine.command({ type: 'snapshot', projectId: f.projectId })).snapshot.selected!;
  const stored = f.store.read()!;
  for (const [index, receipt] of receipts.entries()) {
    const sent = snapshot.conversation!.find(entry => entry.id === `sent:${receipt.message_id}`)!;
    const raw = stored.conversation.find(entry => entry.id === sent.id)!;
    assert.deepEqual(sent.sentMessage, { content: values[index] });
    assert.deepEqual(sent.content, raw.content); assert.equal(sent.text, raw.text);
    assert.equal('sentMessage' in raw, false);
    assert.deepEqual(sent.attachments, stored.messages[index].attachments);
    assert.equal(snapshot.conversation!.find(entry => entry.messageId === receipt.message_id && entry.direction === 'input')!.sentMessage, undefined);
    assert.equal('content' in snapshot.messages![index], false);
  }
  await until(() => updates.some(update => update.kind === 'delta' && update.entries.some(entry => entry.sentMessage?.content === false)));
  f.finish(source); await until(() => source.status === 'completed');
  const archived = (await f.engine.command({ type: 'delete_node', projectId: f.projectId, nodeId: 'plan' })).snapshot.selected!;
  assert.ok(archived.archivedNodes!.some(node => node.id === 'plan'));
  assert.deepEqual(archived.conversation!.find(entry => entry.id === `sent:${receipts[5].message_id}`)!.sentMessage, { content: values[5] });
  assert.deepEqual(f.store.read()!.conversation.find(entry => entry.id === `sent:${receipts[0].message_id}`), stored.conversation.find(entry => entry.id === `sent:${receipts[0].message_id}`));
});
test('resync is deduplicated, fenced by navigation, and other project does not replace current', async () => {
  let resolve!: (s: AppSnapshot) => void, reads = 0;
  const receiver = new SnapshotReceiver(() => { reads++; return new Promise(r => resolve = r); }, () => {});
  receiver.navigate('A'); receiver.accept(delta('A', 3)); receiver.accept(delta('A', 4));
  assert.equal(reads, 1);
  receiver.navigate('B'); receiver.accept({ kind: 'full', snapshot: full('B', 5) });
  resolve(full('A', 8)); await new Promise(r => setImmediate(r));
  receiver.accept({ kind: 'full', snapshot: full('A', 9) });
  assert.equal(receiver.snapshot?.selected?.project.id, 'B');
});
test('pending resync replays each incremental entry after an earlier baseline', async () => {
  let resolve!: (s: AppSnapshot) => void;
  const receiver = new SnapshotReceiver(() => new Promise(r => resolve = r), () => {});
  const first = delta('B', 3) as Extract<AppUpdate, { kind: 'delta' }>;
  first.entries = [{ id: 'first', seq: 1 } as any];
  const second = delta('B', 4) as Extract<AppUpdate, { kind: 'delta' }>;
  second.baseRevision = 3; second.entries = [{ id: 'second', seq: 2 } as any];
  receiver.accept(first); receiver.accept(second);
  resolve(full('B', 2)); await new Promise(r => setImmediate(r));
  assert.deepEqual(receiver.snapshot?.selected?.conversation?.map(e => e.id), ['first', 'second']);
  assert.equal(receiver.snapshot?.revision, 4);
});
test('both creation consumers fence A broadcasts until the matching B command reply', () => {
  for (const consumer of ['renderer', 'panel host']) {
    const receiver = new SnapshotReceiver(async () => full('A', 1), () => {});
    receiver.accept({ kind: 'full', snapshot: full('A', 1) });
    const token = receiver.navigate(null);
    receiver.accept({ kind: 'full', snapshot: full('A', 2) }); receiver.accept(delta('A', 3));
    (receiver.accept as any)({ kind: 'full', snapshot: full('B', 4) }, token);
    assert.equal(receiver.snapshot?.selected?.project.id, 'B', consumer);
    const abandoned = receiver.navigate(null); receiver.navigate('C');
    receiver.accept({ kind: 'full', snapshot: full('C', 5) });
    (receiver.accept as any)({ kind: 'full', snapshot: full('B', 6) }, abandoned);
    assert.equal(receiver.snapshot?.selected?.project.id, 'C');
    const failed = receiver.navigate(null);
    (receiver as any).cancelNavigation(failed);
    receiver.accept({ kind: 'full', snapshot: full('C', 7) });
    assert.equal(receiver.snapshot?.revision, 7);
    const outdated = receiver.navigate(null); receiver.navigate('D');
    (receiver as any).cancelNavigation(outdated);
    receiver.accept({ kind: 'full', snapshot: full('D', 8) });
    assert.equal(receiver.snapshot?.selected?.project.id, 'D');
  }
});
test('insufficient compensation baseline retries once without overlapping, then reports a persistent gap', async () => {
  for (const repairs of [true, false]) {
    let reads = 0, active = 0, errors = 0;
    const receiver = new SnapshotReceiver(async () => {
      assert.equal(active++, 0); reads++; await new Promise(r => setImmediate(r)); active--;
      return full('B', repairs && reads === 2 ? 4 : 2);
    }, () => {}, () => errors++);
    const update = delta('B', 5) as Extract<AppUpdate, { kind: 'delta' }>; update.baseRevision = 4;
    receiver.accept(update);
    for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r));
    assert.equal(reads, 2); assert.equal(errors, repairs ? 0 : 1);
    assert.equal(receiver.snapshot?.revision, repairs ? 5 : 2);
  }
});
