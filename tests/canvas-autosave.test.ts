import assert from 'node:assert/strict';
import test from 'node:test';
import { CanvasSaveQueue } from '../src/renderer/canvas-autosave.js';

test('canvas saves drain later edits before becoming clean', async () => {
  let complete!: (revision: number) => void;
  const calls: { requestId: string; expectedRevision: number; value: string }[] = [];
  const queue = new CanvasSaveQueue(1, 'initial', request => {
    calls.push(request);
    return calls.length === 1 ? new Promise<number>(resolve => complete = resolve) : Promise.resolve(3);
  }, () => {});
  queue.change('first'); const saving = queue.flush();
  queue.change('second'); assert.equal(queue.dirty, true);
  complete(2); assert.equal(await saving, true);
  assert.deepEqual(calls.map(call => [call.expectedRevision, call.value]), [[1, 'first'], [2, 'second']]);
  assert.equal(queue.dirty, false); assert.equal(queue.revision, 3);
});

test('failed canvas saves retain edits and retry the identical request before newer edits', async () => {
  const calls: { requestId: string; expectedRevision: number; value: string }[] = [];
  const queue = new CanvasSaveQueue(1, 'initial', async request => {
    calls.push(request); if (calls.length === 1) throw Error('connection interrupted');
    return calls.length === 2 ? 2 : 3;
  }, () => {});
  queue.change('first'); assert.equal(await queue.flush(), false);
  queue.change('second'); assert.equal(queue.dirty, true); assert.match(queue.error!, /interrupted/);
  assert.equal(await queue.flush(), true);
  assert.deepEqual(calls[0], calls[1]); assert.equal(calls[2].value, 'second');
  assert.equal(queue.error, null); assert.equal(queue.dirty, false);
});
