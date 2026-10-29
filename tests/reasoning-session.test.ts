import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, until } from './runtime-fixture.js';
import { ProjectStore } from '../src/core/store.js';

test('reasoning selection survives save and snapshots; explicit to default resets reused native turns', async t => {
  const f = await fixture(t);
  await f.engine.command({ type: 'catalog', projectId: f.projectId });
  const state = (f.engine as any).states.get(f.projectId), client = f.clients[0], rpc = client.port.rpc.bind(client.port);
  let catalogAvailable = true;
  client.port.rpc = async (method, params) => {
    if (method === 'model/list') {
      if (!catalogAvailable) throw new Error('catalog unavailable');
      return { data: [{ model: 'chosen', displayName: 'Chosen', defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Low' }, { reasoningEffort: 'high', description: 'High' }] }] };
    }
    return rpc(method, params);
  };
  const save = (reasoningEffort: string | null) => f.engine.command({ type: 'save_node', projectId: f.projectId, node: { ...state.nodes[0], model: 'chosen', reasoningEffort } });
  await save('high');
  const disk = new ProjectStore(f.root);
  try { assert.equal(disk.read()!.nodes[0].reasoningEffort, 'high'); } finally { disk.close(); }
  await f.send('plan'); await until(() => !!state.tasks[0].turnId);
  const first = state.tasks[0];
  assert.equal(first.nodeSnapshot.reasoningEffort, 'high');
  assert.equal(client.calls.find(c => c.method === 'thread/start')!.params.config.model_reasoning_effort, 'high');
  assert.equal(client.calls.find(c => c.method === 'turn/start')!.params.effort, 'high');
  const finish = (task: typeof first) => client.options.onEvent({ method: 'turn/completed', params: { threadId: task.threadId, turn: { id: task.turnId, status: 'completed' } } });
  finish(first);
  await save(null); await f.send('plan'); await until(() => !!state.tasks[1].turnId);
  assert.equal(state.tasks[1].threadId, first.threadId);
  assert.equal(client.calls.find(c => c.method === 'thread/resume')!.params.config.model_reasoning_effort, 'low');
  assert.equal(client.calls.filter(c => c.method === 'turn/start')[1].params.effort, 'low');
  assert.equal(state.tasks[1].provenance.resolvedReasoningEffort, 'low');
  finish(state.tasks[1]);
  await save('high'); await f.send('plan'); await until(() => !!state.tasks[2].turnId); finish(state.tasks[2]);
  catalogAvailable = false; await save(null); await f.send('plan');
  await until(() => state.tasks[3].status === 'failed');
  assert.match(state.tasks[3].error, /默认思考强度/);
  assert.equal(client.calls.filter(c => c.method === 'turn/start').length, 3, 'unknown default must not silently reuse high');
});

test('reasoning effort validates text at save boundary while allowing future native strings', async t => {
  const f = await fixture(t), state = (f.engine as any).states.get(f.projectId);
  for (const value of [12, {}, '\0bad', ' '.repeat(3), 'x'.repeat(201)]) {
    await assert.rejects(f.engine.command({ type: 'save_node', projectId: f.projectId, node: { ...state.nodes[0], reasoningEffort: value } as any }), /思考强度/);
  }
  const reply = await f.engine.command({ type: 'save_node', projectId: f.projectId, node: { ...state.nodes[0], reasoningEffort: 'future-effort' } });
  assert.equal(reply.snapshot.selected!.nodes[0].reasoningEffort, 'future-effort');
});

test('legacy node without a chosen model resolves effort from the native session model', async t => {
  const f = await fixture(t);
  await f.engine.command({ type: 'catalog', projectId: f.projectId });
  const state = (f.engine as any).states.get(f.projectId), client = f.clients[0], rpc = client.port.rpc.bind(client.port);
  state.nodes[0].threads.codex = 'legacy-thread';
  client.port.rpc = async (method, params) => {
    if (method === 'model/list') return { data: [
      { model: 'catalog-default', displayName: 'Default', isDefault: true, defaultReasoningEffort: 'low' },
      { model: 'session-model', displayName: 'Session model', defaultReasoningEffort: 'medium' },
    ] };
    if (method === 'thread/resume') {
      assert.equal((params.config as Record<string, unknown>).model_reasoning_effort, undefined, 'do not apply another model default before knowing the session model');
      await rpc(method, params); return { thread: { id: params.threadId }, model: 'session-model' };
    }
    return rpc(method, params);
  };
  await f.send('plan'); await until(() => !!state.tasks[0].turnId || state.tasks[0].status === 'failed');
  assert.equal(state.tasks[0].error, null);
  assert.equal(client.calls.find(c => c.method === 'turn/start')!.params.effort, 'medium');
});
