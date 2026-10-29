import test from 'node:test';
import assert from 'node:assert/strict';
import { CommandDispatcher } from '../src/core/commands.js';
import { deferred, fixture, until } from './runtime-fixture.js';

test('receipts keep one execution per ID, reject conflicts and allow equal bodies under different IDs', async () => {
  const gate = deferred(), entered = deferred(); let calls = 0;
  const dispatcher = new CommandDispatcher({ async command() { calls++; entered.resolve(); await gate.promise; return { snapshot: { projects: [], selected: null, runtime: null } }; } });
  const envelope = { id: 'same', command: { type: 'snapshot' as const } };
  assert.equal(dispatcher.inspect('missing').status, 'unknown');
  const first = dispatcher.dispatch(envelope);
  assert.equal(dispatcher.inspect('same').status, 'queued');
  await entered.promise; assert.equal(dispatcher.inspect('same').status, 'running');
  const duplicate = dispatcher.dispatch(envelope);
  await assert.rejects(dispatcher.dispatch({ id: 'same', command: { type: 'create_demo' } }), /编号/);
  gate.resolve(); assert.deepEqual(await first, await duplicate);
  assert.equal(calls, 1); assert.equal(dispatcher.inspect('same').status, 'succeeded');
  await dispatcher.dispatch({ ...envelope, id: 'different' }); assert.equal(calls, 2);
  await dispatcher.dispatch(envelope); assert.equal(calls, 2);
});

test('receipts distinguish failure, cancellation and unknown outcomes without replay', async () => {
  for (const [error, expected] of [[new Error('failed'), 'failed'], [Object.assign(new Error('cancelled'), { code: 'COMMAND_CANCELLED' }), 'cancelled'], [Object.assign(new Error('lost outcome'), { outcome: 'unknown' }), 'unknown']] as const) {
    let calls = 0;
    const dispatcher = new CommandDispatcher({ async command() { calls++; throw error; } });
    const envelope = { id: expected, command: { type: 'snapshot' as const } };
    await assert.rejects(dispatcher.dispatch(envelope));
    assert.equal(dispatcher.inspect(expected).status, expected);
    await assert.rejects(dispatcher.dispatch(envelope)); assert.equal(calls, 1);
  }
});

test('blocked catalog/history do not block controls or native responses', async t => {
  const f = await fixture(t); await f.send('plan');
  await until(() => f.clients[0].calls.some(call => call.method === 'turn/start'));
  const first = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!.tasks[0];
  f.clients[0].options.onEvent({ method: 'turn/completed', params: { threadId: first.threadId, turn: { id: first.turnId, status: 'completed' } } });
  await f.send('plan'); await until(() => f.clients[0].calls.filter(call => call.method === 'turn/start').length === 2);
  const client = f.clients[0], original = client.port.rpc;
  const gate = deferred(); let held = 0;
  client.port.rpc = async (method, params) => {
    if (['model/list', 'thread/items/list'].includes(method)) { held++; await gate.promise; return { data: [] }; }
    if (method === 'skills/list') return { data: [] };
    return original(method, params);
  };
  let responded = false; client.port.respond = () => { responded = true; };
  client.options.onRequest!({ id: 'approval', method: 'item/commandExecution/requestApproval', params: {} });
  const dispatcher = new CommandDispatcher(f.engine);
  const history = dispatcher.dispatch({ id: 'history', command: { type: 'read_history', projectId: f.projectId, nodeId: 'plan' } });
  const catalog = dispatcher.dispatch({ id: 'catalog', command: { type: 'catalog', projectId: f.projectId } });
  try {
    const pausePromise = dispatcher.dispatch({ id: 'pause', command: { type: 'pause', projectId: f.projectId } });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(held, 2, 'catalog and history must both reach their RPC latches');
    const pause = await pausePromise;
    assert.equal(pause.snapshot.selected!.nodes[0].status, 'pausing');
    const requestKey = pause.snapshot.selected!.requests![0].key;
    await dispatcher.dispatch({ id: 'approval', command: { type: 'respond_native', projectId: f.projectId, requestKey, result: { decision: 'decline' } } });
    assert(responded); assert.equal(dispatcher.inspect('history').status, 'running');
  } finally { gate.resolve(); await Promise.all([history, catalog]); }
});

test('command validation rejects invalid IDs and caller mutation cannot alter an accepted command', async () => {
  let body: unknown;
  const dispatcher = new CommandDispatcher({ async command(command) { body = command; return { snapshot: { projects: [], selected: null, runtime: null } }; } });
  await assert.rejects(dispatcher.dispatch({ id: '', command: { type: 'snapshot' } }), /编号/);
  const envelope = { id: 'copy', command: { type: 'snapshot' as const, projectId: 'before' } };
  const result = dispatcher.dispatch(envelope); envelope.command.projectId = 'after'; await result;
  assert.deepEqual(body, { type: 'snapshot', projectId: 'before' });
  const receipt = dispatcher.inspect('copy'); receipt.status = 'failed';
  assert.equal(dispatcher.inspect('copy').status, 'succeeded');
});

test('completed receipts have a finite count and replay window without evicting pending or unknown work', async t => {
  let now = 0; t.mock.method(Date, 'now', () => now);
  const gate = deferred(), entered = deferred(); let unknownCalls = 0;
  const dispatcher = new CommandDispatcher({ async command(command) {
    if (command.type === 'create_demo') { unknownCalls++; throw Object.assign(Error('uncertain'), { outcome: 'unknown' }); }
    if (command.type === 'read_history') { entered.resolve(); await gate.promise; }
    return { snapshot: { projects: [], selected: null, runtime: null } };
  } });
  const pending = dispatcher.dispatch({ id: 'pending', command: { type: 'read_history', projectId: 'p', nodeId: 'n' } });
  await entered.promise;
  await assert.rejects(dispatcher.dispatch({ id: 'uncertain', command: { type: 'create_demo' } }));
  for (let i = 0; i < 100; i++) await dispatcher.dispatch({ id: `read-${i}`, command: { type: 'snapshot' } });
  assert.equal(dispatcher.inspect('read-0').status, 'unknown');
  assert.equal(dispatcher.inspect('read-99').status, 'succeeded');
  assert.equal(dispatcher.inspect('pending').status, 'running');
  await assert.rejects(dispatcher.dispatch({ id: 'uncertain', command: { type: 'create_demo' } }));
  assert.equal(unknownCalls, 1);
  now = 120001;
  assert.equal(dispatcher.inspect('read-99').status, 'unknown');
  assert.equal(dispatcher.inspect('pending').status, 'running');
  await assert.rejects(dispatcher.dispatch({ id: 'uncertain', command: { type: 'snapshot' } }), /编号/);
  gate.resolve(); await pending;
});
