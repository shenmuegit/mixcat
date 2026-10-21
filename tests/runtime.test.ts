import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { deferred, fixture, until } from './runtime-fixture.js';

test('concurrent_first_messages_share_runtime', async t => {
  const gate = deferred(); const f = await fixture(t, () => gate.promise);
  const messages = Promise.all([f.send('plan'), f.send('implement')]);
  await delay(15); const count = f.clients.length; gate.resolve(); await messages;
  assert.equal(count, 1, 'a project shares its pending connection');
  await until(() => f.clients[0].calls.filter(c => c.method === 'turn/start').length === 2);
  const starts = f.clients[0].calls.filter(c => c.method === 'turn/start');
  assert.notEqual(starts[0].params.threadId, starts[1].params.threadId);
});

test('old_runtime_callbacks_are_ignored', async t => {
  const f = await fixture(t); await f.engine.command({ type: 'connect', projectId: f.projectId });
  const old = f.clients[0]; old.options.onDisconnect('replace');
  await f.engine.command({ type: 'connect', projectId: f.projectId }); await f.send('plan');
  await until(() => f.clients[1].calls.some(c => c.method === 'turn/start'));
  const before = (await f.engine.command({ type: 'snapshot' })).snapshot;
  const task = before.selected!.tasks[0];
  old.options.onEvent({ method: 'turn/completed', params: { threadId: task.threadId, turn: { id: task.turnId, status: 'completed', items: [] } } });
  old.options.onRequest!({ id: 'old-request', method: 'item/commandExecution/requestApproval', params: { threadId: task.threadId } });
  old.options.onDisconnect('stale disconnect');
  const after = (await f.engine.command({ type: 'snapshot' })).snapshot;
  assert.ok(after.revision! > before.revision!);
  assert.deepEqual({ ...after, revision: before.revision }, before);
});

test('failed initialization is shared and retry creates one fresh runtime', async t => {
  const gate = deferred(); let fail = true;
  const f = await fixture(t, async () => { await gate.promise; if (fail) throw new Error('fixture connect failure'); });
  const results = Promise.allSettled([f.send('plan'), f.send('implement')]);
  await delay(10); gate.resolve(); assert((await results).every(r => r.status === 'rejected'));
  assert.equal(f.clients.length, 1); fail = false;
  await f.engine.command({ type: 'connect', projectId: f.projectId }); assert.equal(f.clients.length, 2);
});

test('late account errors from a replaced runtime cannot change current state', async t => {
  const f = await fixture(t); await f.engine.command({ type: 'connect', projectId: f.projectId });
  const old = f.clients[0], original = old.port.rpc;
  const gate = deferred(), entered = deferred(); let failAccount = false;
  old.port.rpc = async (method, params) => { if (method === 'account/read' && failAccount) { entered.resolve(); await gate.promise; throw new Error('late account failure'); } return original(method, params); };
  failAccount = true;
  const account = f.engine.command({ type: 'connect', projectId: f.projectId });
  await entered.promise;
  old.options.onDisconnect('replace'); await f.engine.command({ type: 'connect', projectId: f.projectId });
  const before = (await f.engine.command({ type: 'snapshot' })).snapshot;
  gate.resolve(); await account;
  const after = (await f.engine.command({ type: 'snapshot' })).snapshot;
  assert.ok(after.revision! > before.revision!);
  assert.deepEqual({ ...after, revision: before.revision }, before);
});

test('late turn response after disconnect cannot turn reconciliation back into running', async t => {
  const f = await fixture(t); await f.engine.command({ type: 'connect', projectId: f.projectId });
  const old = f.clients[0], original = old.port.rpc, gate = deferred(), entered = deferred();
  old.port.rpc = async (method, params) => { if (method === 'turn/start') { entered.resolve(); await gate.promise; } return original(method, params); };
  await f.send('plan'); await entered.promise;
  old.options.onDisconnect('lost during turn/start');
  await f.engine.command({ type: 'connect', projectId: f.projectId });
  const before = (await f.engine.command({ type: 'snapshot' })).snapshot;
  gate.resolve(); await delay(25);
  const after = (await f.engine.command({ type: 'snapshot' })).snapshot;
  assert.ok(after.revision! > before.revision!);
  assert.deepEqual({ ...after, revision: before.revision }, before);
  assert.equal(before.selected!.tasks[0].status, 'needs_reconciliation');
  assert.equal(before.selected!.tasks[0].turnId, null);
});

test('close during shared initialization never activates a late runtime', async t => {
  const gate = deferred(); const f = await fixture(t, () => gate.promise);
  const connect = f.engine.command({ type: 'connect', projectId: f.projectId });
  await until(() => f.clients.length === 1);
  await f.engine.close(); gate.resolve(); await assert.rejects(connect, /关闭或更换/);
  assert.equal(f.clients[0].calls.length, 0);
});
