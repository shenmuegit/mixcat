import test from 'node:test';
import assert from 'node:assert/strict';
import { deferred, fixture, until } from './runtime-fixture.js';
import { ProjectStore } from '../src/core/store.js';
import type { AppUpdate } from '../src/shared/types.js';

test('native callback contains storage failure and prevents later dispatch', async t => {
  const f = await fixture(t); await f.send('plan');
  const internal = f.engine as any, state = internal.states.get(f.projectId), store = internal.stores.get(f.projectId);
  await until(() => !!state.tasks[0].turnId);
  const task = state.tasks[0];
  store.db.exec("CREATE TEMP TRIGGER reject_save BEFORE INSERT ON project_state BEGIN SELECT RAISE(ABORT, 'storage fault'); END");
  try {
    assert.doesNotThrow(() => f.clients[0].options.onEvent({ method: 'turn/completed', params: { threadId: task.threadId, turn: { id: task.turnId, status: 'completed' } } }));
    assert.equal(task.status, 'running');
    assert.match((await f.engine.command({ type: 'snapshot' })).snapshot.runtime!.error!, /storage fault/);
    await assert.rejects(f.send('implement'), /storage fault/);
  } finally { store.db.exec('DROP TRIGGER reject_save'); }
  await internal.pump(f.projectId);
  assert.equal(f.clients[0].calls.filter(c => c.method === 'turn/start').length, 1);
});
test('100 synchronous deltas coalesce with 1000 old entries and close flushes tail', async t => {
  const f = await fixture(t); await f.send('plan');
  const internal = f.engine as any, state = internal.states.get(f.projectId), store = internal.stores.get(f.projectId);
  await until(() => !!state.tasks[0].turnId);
  const task = state.tasks[0];
  for (let i = 0; i < 1000; i++) state.conversation.push({ ...state.conversation[0], id: `old-${i}`, seq: i + 2 });
  store.save(state);
  const updates: AppUpdate[] = [];
  f.engine.subscribe(update => updates.push(update));
  // Establish a broadcast baseline before measuring the changed item.
  internal.emit();
  await until(() => updates.length > 0);
  updates.length = 0;
  let writes = 0, bytes = 0;
  const save = store.save.bind(store);
  store.save = (value: any) => { writes++; bytes += Buffer.byteLength(JSON.stringify(value)); save(value); };
  const start = performance.now();
  for (let i = 0; i < 100; i++) f.clients[0].options.onEvent({ method: 'item/agentMessage/delta', params: { threadId: task.threadId, turnId: task.turnId, itemId: 'stream', delta: 'x' } });
  assert.ok(writes < 100, `writes=${writes}`);
  await until(() => store.read().conversation.some((e: any) => e.itemId === 'stream' && e.text.length === 100));
  await until(() => updates.length > 0);
  assert.equal(updates[0].kind, 'delta');
  const delta = updates[0] as Extract<AppUpdate, { kind: 'delta' }>;
  assert.deepEqual(delta.entries.map(e => e.itemId), ['stream']);
  assert.ok(!('conversation' in delta.selected));
  console.log(JSON.stringify({ writes, bytes, latencyMs: performance.now() - start }));
  f.clients[0].options.onEvent({ method: 'item/agentMessage/delta', params: { threadId: task.threadId, turnId: task.turnId, itemId: 'stream', delta: 'tail' } });
  await f.engine.close();
  // close uses the same instrumented save before releasing SQLite.
  assert.ok(writes < 100);
  assert.equal(state.conversation.find((e: any) => e.itemId === 'stream').text, 'x'.repeat(100) + 'tail');
  const reopened = new ProjectStore(f.root);
  try { assert.equal(reopened.read()!.conversation.find(e => e.itemId === 'stream')!.text, 'x'.repeat(100) + 'tail'); }
  finally { reopened.close(); }
});

test('rejected input admission leaves no queued task for a later pump', async t => {
  const f = await fixture(t), owner = f.engine as any, store = owner.stores.get(f.projectId);
  store.db.exec("CREATE TEMP TRIGGER reject_save BEFORE INSERT ON project_state BEGIN SELECT RAISE(ABORT, 'input fault'); END");
  try { await assert.rejects(f.send('plan'), /input fault/); }
  finally { store.db.exec('DROP TRIGGER reject_save'); }
  assert.equal(owner.states.get(f.projectId).tasks.length, 0);
  await owner.pump(f.projectId);
  assert.equal(f.clients.flatMap(c => c.calls).filter(c => c.method === 'turn/start').length, 0);
});

test('item completion flushes text and command output immediately', async t => {
  const f = await fixture(t); await f.send('plan');
  const owner = f.engine as any, state = owner.states.get(f.projectId), store = owner.stores.get(f.projectId);
  await until(() => !!state.tasks[0].turnId);
  const task = state.tasks[0], event = (method: string, data: any) => f.clients[0].options.onEvent({ method, params: { threadId: task.threadId, turnId: task.turnId, ...data } });
  event('item/commandExecution/outputDelta', { itemId: 'cmd', delta: 'tail' });
  event('item/completed', { item: { id: 'cmd', type: 'commandExecution', command: 'echo tail', aggregatedOutput: 'tail', status: 'completed' } });
  const entry = store.read().conversation.find((e: any) => e.itemId === 'cmd');
  assert.equal(entry.rawItem.aggregatedOutput, 'tail');
  assert.equal(entry.status, 'completed');
});
test('asynchronous interrupt rejection with failed recovery save stays in visible health channel', async t => {
  const f = await fixture(t); await f.send('plan');
  const owner = f.engine as any, state = owner.states.get(f.projectId), store = owner.stores.get(f.projectId);
  await until(() => !!state.tasks[0].turnId);
  const gate = deferred(), original = f.clients[0].port.rpc;
  f.clients[0].port.rpc = async (method, params) => { if (method === 'turn/interrupt') { await gate.promise; throw Error('interrupt unknown'); } return original(method, params); };
  await f.engine.command({ type: 'pause_node', projectId: f.projectId, nodeId: 'plan' });
  store.db.exec("CREATE TEMP TRIGGER reject_save BEFORE INSERT ON project_state BEGIN SELECT RAISE(ABORT, 'async recovery fault'); END");
  try {
    gate.resolve(); await until(() => owner.storageErrors.has(f.projectId));
    await new Promise(r => setImmediate(r));
    assert.equal(state.tasks[0].status, 'needs_reconciliation');
    assert.match((await f.engine.command({ type: 'snapshot' })).snapshot.runtime!.error!, /async recovery fault/);
  } finally { store.db.exec('DROP TRIGGER reject_save'); }
});
test('step-limit pump save failure is contained before a detached caller can reject', async t => {
  const f = await fixture(t); await f.send('plan');
  const owner = f.engine as any, state = owner.states.get(f.projectId), store = owner.stores.get(f.projectId);
  await until(() => !!state.tasks[0].turnId && owner.pumping.size === 0);
  state.tasks[0].status = 'queued'; state.tasks[0].nativeInput = undefined; state.maxSteps = 0;
  store.db.exec("CREATE TEMP TRIGGER reject_save BEFORE INSERT ON project_state BEGIN SELECT RAISE(ABORT, 'limit fault'); END");
  try { await assert.doesNotReject(owner.pump(f.projectId)); assert.ok(owner.storageErrors.has(f.projectId)); }
  finally { store.db.exec('DROP TRIGGER reject_save'); }
});
for (const type of ['stop', 'pause_node'] as const) test(`unhealthy ${type} interrupts existing execution and late completion cannot claim durable success`, async t => {
  const f = await fixture(t); await f.send('plan');
  const owner = f.engine as any, state = owner.states.get(f.projectId), store = owner.stores.get(f.projectId);
  await until(() => !!state.tasks[0].turnId);
  const task = state.tasks[0];
  store.db.exec("CREATE TEMP TRIGGER reject_save BEFORE INSERT ON project_state BEGIN SELECT RAISE(ABORT, 'stream fault'); END");
  try {
    f.clients[0].options.onEvent({ method: 'item/agentMessage/delta', params: { threadId: task.threadId, turnId: task.turnId, itemId: 'fault', delta: 'tail' } });
    await until(() => owner.storageErrors.has(f.projectId));
    await assert.rejects(f.engine.command({ type, projectId: f.projectId, nodeId: 'plan' } as any), (e: any) => e.outcome === 'unknown');
    assert.equal(f.clients[0].calls.filter(c => c.method === 'turn/interrupt').length, 1);
    f.clients[0].options.onEvent({ method: 'turn/completed', params: { threadId: task.threadId, turn: { id: task.turnId, status: 'interrupted' } } });
    assert.equal(task.status, 'running');
    await assert.rejects(f.send('implement'));
  } finally { store.db.exec('DROP TRIGGER reject_save'); }
});
test('a first control-save failure still requests interruption with an unknown receipt', async t => {
  const f = await fixture(t); await f.send('plan'); const owner = f.engine as any, state = owner.states.get(f.projectId), store = owner.stores.get(f.projectId);
  await until(() => !!state.tasks[0].turnId);
  store.db.exec("CREATE TEMP TRIGGER reject_save BEFORE INSERT ON project_state BEGIN SELECT RAISE(ABORT, 'control fault'); END");
  try {
    await assert.rejects(f.engine.command({ type: 'pause_node', projectId: f.projectId, nodeId: 'plan' }), (e: any) => e.outcome === 'unknown');
    assert.equal(f.clients[0].calls.filter(c => c.method === 'turn/interrupt').length, 1);
    assert.equal(state.tasks[0].status, 'running');
  } finally { store.db.exec('DROP TRIGGER reject_save'); }
});
test('late turn-start reply after storage fault is interrupted without publishing success', async t => {
  const f = await fixture(t); await f.engine.command({ type: 'connect', projectId: f.projectId });
  const gate = deferred(), entered = deferred(), client = f.clients[0], original = client.port.rpc;
  client.port.rpc = async (method, params) => { if (method === 'turn/start') { entered.resolve(); await gate.promise; } return original(method, params); };
  await f.send('plan'); await entered.promise;
  const owner = f.engine as any, state = owner.states.get(f.projectId), store = owner.stores.get(f.projectId);
  store.db.exec("CREATE TEMP TRIGGER reject_save BEFORE INSERT ON project_state BEGIN SELECT RAISE(ABORT, 'late fault'); END");
  try {
    await assert.rejects(f.engine.command({ type: 'stop', projectId: f.projectId }), (e: any) => e.outcome === 'unknown');
    gate.resolve(); await until(() => client.calls.some(c => c.method === 'turn/interrupt'));
    assert.equal(state.tasks[0].turnId, null); assert.equal(state.tasks[0].status, 'running');
    assert.equal(store.read().tasks[0].turnId, null);
  } finally { gate.resolve(); store.db.exec('DROP TRIGGER reject_save'); }
});
test('stop event interrupt rejection contains a failed disconnect recovery save', async t => {
  const f = await fixture(t); await f.send('plan'); const owner = f.engine as any, state = owner.states.get(f.projectId), store = owner.stores.get(f.projectId);
  await until(() => !!state.tasks[0].turnId);
  const task = state.tasks[0], gate = deferred(), original = f.clients[0].port.rpc;
  f.clients[0].port.rpc = async (method, params) => { if (method === 'turn/interrupt') { await gate.promise; throw Error('stop interrupt unknown'); } return original(method, params); };
  state.stopRequested = true;
  f.clients[0].options.onEvent({ method: 'turn/started', params: { threadId: task.threadId, turn: { id: task.turnId } } });
  store.db.exec("CREATE TEMP TRIGGER reject_save BEFORE INSERT ON project_state BEGIN SELECT RAISE(ABORT, 'disconnect fault'); END");
  try { gate.resolve(); await until(() => owner.storageErrors.has(f.projectId)); await new Promise(r => setImmediate(r)); assert.equal(task.status, 'needs_reconciliation'); }
  finally { store.db.exec('DROP TRIGGER reject_save'); }
});
