import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeUpdate, SnapshotReceiver } from '../src/shared/snapshots.js';
import type { AppSnapshot, AppUpdate } from '../src/shared/types.js';
const full = (id: string, revision: number): AppSnapshot => ({ generation: 1, revision, projects: [], runtime: null, selected: { project: { id } as any, nodes: [], tasks: [], handoffs: [], activities: [], conversation: [] } });
const delta = (id: string, revision: number): AppUpdate => ({ kind: 'delta', generation: 1, revision, baseRevision: 1, projectId: id, projects: [], runtime: null, selected: full(id, revision).selected!, entries: [] });
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
