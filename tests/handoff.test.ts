import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkflowEngine } from '../src/core/engine.js';
import { ProjectStore } from '../src/core/store.js';
import type { ProjectState } from '../src/core/model.js';
import type { McpCallContext } from '../src/shared/types.js';
import { deferred, fixture, until } from './runtime-fixture.js';

function internal(engine: WorkflowEngine, projectId: string) {
  const owner = engine as unknown as { states: Map<string, ProjectState>; stores: Map<string, ProjectStore> };
  return { state: owner.states.get(projectId)!, store: owner.stores.get(projectId)! };
}
function rejectSave(store: ProjectStore) {
  store.db.exec("CREATE TEMP TRIGGER reject_save BEFORE INSERT ON project_state BEGIN SELECT RAISE(ABORT, 'fixture SQLite rejection'); END");
  return () => store.db.exec('DROP TRIGGER reject_save');
}
async function active(t: Parameters<typeof fixture>[0], nodeId = 'plan') {
  const f = await fixture(t); await f.send(nodeId);
  await until(() => internal(f.engine, f.projectId).state.tasks.some(task => task.nodeId === nodeId && !!task.turnId));
  const { state, store } = internal(f.engine, f.projectId), source = state.tasks[0];
  const context: McpCallContext = { identity: f.engine.nodeIdentity(f.projectId, nodeId), threadId: source.threadId!, turnId: source.turnId!, callId: 'same-native-call' };
  const finish = (status = 'completed') => f.clients[0].options.onEvent({ method: 'turn/completed', params: { threadId: source.threadId, turn: { id: source.turnId, status, items: [] } } });
  return { ...f, state, store, source, context, finish };
}
const handoff = { to_node_id: 'implement', task: '核对任意内容', reason: '独立复核', result: { text: '自由原文\n保留', custom: [false, null, { nested: 42 }] } };

test('failed_handoff_commit_cannot_acknowledge_on_retry', async t => {
  const f = await active(t), release = rejectSave(f.store), before = structuredClone(f.state);
  const beforeDisk = f.store.db.prepare('SELECT body FROM project_state WHERE id=1').get()!.body;
  try {
    for (let i = 0; i < 2; i++) {
      await assert.rejects(f.engine.invokeTool('handoff', handoff, f.context), /fixture SQLite rejection/);
      assert.deepEqual(f.state, before); assert.equal(f.state.handoffs.length, 0); assert.equal(f.source.terminal, null);
      assert.equal(f.state.tasks.filter(task => task.nodeId === 'implement').length, 0);
      assert.equal(f.clients[0].calls.filter(call => call.method === 'turn/start').length, 1);
      assert.equal(f.store.db.prepare('SELECT body FROM project_state WHERE id=1').get()!.body, beforeDisk);
      assert.deepEqual(JSON.parse(readFileSync(join(f.root, '.mixcat/artifacts', `${f.source.id}.json`), 'utf8')), handoff.result, 'an unregistered artifact is preserved without treating it as accepted');
    }
  } finally { release(); }
  const accepted = await f.engine.invokeTool('handoff', handoff, f.context);
  assert.deepEqual(await f.engine.invokeTool('handoff', handoff, f.context), accepted);
  assert.equal(f.state.tasks.length, 2); assert.equal(f.state.handoffs.length, 1);
  assert.equal(f.state.tasks[1].status, 'waiting_source');
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, '.mixcat/artifacts', `${f.source.id}.json`), 'utf8')), handoff.result);
  f.finish(); await until(() => f.clients[0].calls.filter(call => call.method === 'turn/start').length === 2);
  f.finish(); assert.equal(f.state.tasks.length, 2); assert.equal(f.state.handoffs[0].status, 'delivered');
});

for (const blocked of [false, true]) test(`failed ${blocked ? 'blocked' : 'complete'} commit leaves no terminal and retry saves arbitrary result`, async t => {
  const f = await active(t, 'review'), release = rejectSave(f.store), before = structuredClone(f.state);
  const args = { result: ['unstructured', null, false, 12, { extra: '完整保存' }], blocked, reason: 'free reason' };
  try {
    await assert.rejects(f.engine.invokeTool('complete_task', args, f.context), /fixture SQLite rejection/);
    assert.deepEqual(f.state, before); assert.equal(f.source.terminal, null);
  } finally { release(); }
  const receipt = await f.engine.invokeTool('complete_task', args, f.context);
  assert.deepEqual(await f.engine.invokeTool('complete_task', args, f.context), receipt);
  assert.equal(f.source.terminal!.kind, blocked ? 'blocked' : 'complete');
  assert.deepEqual(f.store.read()!.tasks[0].result, args.result);
  f.finish(); assert.equal(f.state.project.status, blocked ? 'blocked' : 'completed');
});

test('lost receipt remains readable after source completion, pause, and restart without redispatch', async t => {
  const f = await active(t);
  const receipt = await f.engine.invokeTool('handoff', handoff, f.context);
  await f.engine.command({ type: 'pause_node', projectId: f.projectId, nodeId: 'plan' });
  assert.deepEqual(await f.engine.invokeTool('handoff', handoff, f.context), receipt);
  f.finish('interrupted');
  assert.equal(f.state.tasks[1].status, 'waiting_source');
  await f.engine.close();
  const reopened = new WorkflowEngine({ workbenchRoot: f.root, executable: 'unused' });
  try {
    await reopened.init();
    const context = { ...f.context, identity: reopened.nodeIdentity(f.projectId, 'plan') };
    await assert.rejects(reopened.invokeTool('handoff', handoff, f.context), /身份/);
    assert.deepEqual(await reopened.invokeTool('handoff', handoff, context), receipt);
    await assert.rejects(reopened.invokeTool('handoff', { ...handoff, result: 'changed' }, context), /终结动作/);
    await assert.rejects(reopened.invokeTool('handoff', handoff, { ...context, threadId: 'forged' }), /身份|执行/);
    const restored = internal(reopened, f.projectId).state;
    assert.equal(restored.tasks.length, 2); assert.equal(restored.handoffs.length, 1);
    assert.equal(restored.tasks[1].status, 'waiting_source');
  } finally { await reopened.close(); }
});

for (const completed of [false, true]) test(`committed receipt survives restart with ${completed ? 'completed' : 'unconfirmed'} source`, async t => {
  const f = await active(t);
  const receipt = await f.engine.invokeTool('handoff', handoff, f.context);
  await f.engine.command({ type: 'pause_node', projectId: f.projectId, nodeId: 'implement' });
  if (completed) f.finish();
  await f.engine.close();
  const reopened = new WorkflowEngine({ workbenchRoot: f.root, executable: 'unused', nativeFactory() { assert.fail('restart must not create a native runtime'); } });
  try {
    await reopened.init();
    const state = internal(reopened, f.projectId).state;
    assert.equal(state.tasks[0].status, completed ? 'completed' : 'needs_reconciliation');
    assert.equal(state.handoffs[0].status, completed ? 'queued' : 'needs_reconciliation');
    assert.equal(state.tasks[1].status, completed ? 'queued' : 'waiting_source');
    const context = { ...f.context, identity: reopened.nodeIdentity(f.projectId, 'plan') };
    assert.deepEqual(await reopened.invokeTool('handoff', handoff, context), receipt);
    await assert.rejects(reopened.invokeTool('handoff', handoff, { ...context, identity: reopened.nodeIdentity(f.projectId, 'implement') }), /身份|执行/);
    assert.equal(state.tasks.length, 2);
  } finally { await reopened.close(); }
});

test('source completion is not published or released when its SQLite commit fails', async t => {
  const f = await active(t); await f.engine.invokeTool('handoff', handoff, f.context);
  const before = structuredClone(f.state), release = rejectSave(f.store);
  try { assert.doesNotThrow(() => f.finish()); assert.deepEqual(f.state, before); }
  finally { release(); }
  f.finish(); assert.equal(f.clients[0].calls.filter(call => call.method === 'turn/start').length, 1);
  assert.equal(f.state.tasks[1].status, 'waiting_source');
  assert.deepEqual(await f.engine.invokeTool('handoff', handoff, f.context), { accepted: true, handoffId: f.state.handoffs[0].id, status: 'waiting_source', taskId: f.source.id });
});

for (const status of ['failed', 'interrupted']) test(`accepted handoff from ${status} source is never released`, async t => {
  const f = await active(t); await f.engine.invokeTool('handoff', handoff, f.context); f.finish(status);
  assert.equal(f.state.tasks[1].status, 'waiting_source'); assert.equal(f.state.handoffs[0].status, 'needs_reconciliation');
  assert.equal(f.clients[0].calls.filter(call => call.method === 'turn/start').length, 1);
  assert.equal(f.store.read()!.handoffs[0].status, 'needs_reconciliation');
});

test('publishing a candidate retains task and node references held across native RPC awaits', async t => {
  const f = await fixture(t); await f.engine.command({ type: 'connect', projectId: f.projectId });
  const client = f.clients[0], rpc = client.port.rpc, entered = deferred(), gate = deferred();
  client.port.rpc = async (method, params) => {
    if (method === 'turn/start') {
      client.options.onEvent({ method: 'turn/started', params: { threadId: params.threadId, turn: { id: 'early-turn' } } });
      entered.resolve(); await gate.promise; return { turn: { id: 'early-turn' } };
    }
    return rpc(method, params);
  };
  await f.send('plan'); await entered.promise;
  const { state } = internal(f.engine, f.projectId), source = state.tasks[0], node = state.nodes[0];
  try {
    const context = { identity: f.engine.nodeIdentity(f.projectId, 'plan'), threadId: source.threadId!, turnId: source.turnId!, callId: 'during-await' };
    await f.engine.invokeTool('handoff', handoff, context);
    assert.equal(state.tasks[0], source); assert.equal(state.nodes[0], node);
    await f.engine.command({ type: 'pause_node', projectId: f.projectId, nodeId: 'plan' });
  } finally { gate.resolve(); }
  await until(() => client.calls.some(call => call.method === 'turn/interrupt'));
  assert.equal(state.nodes[0].status, 'pausing'); assert.equal(state.tasks[0].pauseRequested, true);
  assert.equal(state.tasks[0].terminal?.kind, 'handoff');
});
