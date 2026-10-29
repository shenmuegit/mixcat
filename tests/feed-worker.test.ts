import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import '../src/core/feed-runtime.js';
import { projectDirectory } from '../src/core/paths.js';
import { FeedStore } from '../src/core/feed-store.js';
import { FeedCollections } from '../src/core/feed-collections.js';
import type { CoreWorkerRequest } from '../src/shared/worker.js';

// Exercise the actual worker message handler at Electron's parentPort boundary.
test('internal power resume awaits initialization and remains independent of project commands', async () => {
  const root = mkdtempSync(resolve(projectDirectory(process.cwd(), '.runtime', 'tests'), 'feed-worker-'));
  const store = new FeedStore(root), collections = new FeedCollections(store);
  const admission = collections.create({ type: 'create_feed_collection', name: 'worker schedule', instruction: 'news', requestId: 'worker-fixture', input: { text: 'fixture' } });
  const c = collections.get(admission.collectionId);
  c.queueHeld = true; c.schedule = { frequency: 'daily', enabled: true, time: '09:00', timeZone: 'Asia/Shanghai' }; c.scheduleRevision = 1; c.nextDueAt = '2026-10-27T01:00:00.000Z'; c.scheduleCoverageStart = '2026-10-26T02:00:00Z'; collections.save(c); store.close();
  const messages: any[] = [], emitter = new EventEmitter(), port = Object.assign(emitter, { postMessage(message: any) { messages.push(message); emitter.emit('posted', message); } });
  const wait = (predicate: (message: any) => boolean): Promise<any> => {
    const found = messages.find(predicate); if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => { const timer = setTimeout(() => { port.off('posted', listener); reject(new Error('worker reply timeout')); }, 15000); const listener = (message: any) => { if (predicate(message)) { clearTimeout(timer); port.off('posted', listener); resolve(message); } }; port.on('posted', listener); });
  };
  const send = async (request: CoreWorkerRequest) => { port.emit('message', { data: request }); return wait(message => message.id === request.id); };
  const oldArgs = process.argv, oldPort = (process as any).parentPort;
  process.argv = [oldArgs[0], 'worker.ts', root, 'fixture', root]; (process as any).parentPort = port;
  try {
    await import('../src/core/worker.js');
    const early = await send({ id: 'early-power', systemEvent: 'power-resume' }); assert.equal(early.result, true); assert.equal(early.error, undefined);
    await wait(message => message.type === 'ready');
    const first = await send({ id: 'query-first', envelope: { id: 'query-first', command: { type: 'list_feed_runs', collectionId: c.id } } });
    assert.equal(first.result.snapshot.projects.length, 0);
    const automatic = first.result.feed.runs.items.filter((run: any) => run.scheduleRevision);
    assert.equal(automatic.length, 1); assert.equal(automatic[0].trigger, 'catchup');
    assert.equal((await send({ id: 'power-again', systemEvent: 'power-resume' })).result, true);
    const second = await send({ id: 'query-second', envelope: { id: 'query-second', command: { type: 'list_feed_runs', collectionId: c.id } } });
    assert.deepEqual(second.result.feed.runs.items, first.result.feed.runs.items);
    assert.equal((await send({ id: 'shutdown-worker', shutdown: true })).result, true);
    assert.match((await send({ id: 'closed-power', systemEvent: 'power-resume' })).error, /关闭/);
  } finally { await send({ id: 'final-shutdown', shutdown: true }); process.argv = oldArgs; (process as any).parentPort = oldPort; }
});
