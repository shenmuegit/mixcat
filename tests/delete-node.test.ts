import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowEngine } from '../src/core/engine.js';
import { fixture, until, deferred } from './runtime-fixture.js';

test('delete removes configured edges and identity, keeps history and prevents ID reuse across restart', async t => {
  const f = await fixture(t); await f.send('plan');
  const owner = f.engine as any, state = owner.states.get(f.projectId);
  await until(() => !!state.tasks[0].turnId);
  const task = state.tasks[0];
  f.clients[0].options.onEvent({ method: 'turn/completed', params: { threadId: task.threadId, turn: { id: task.turnId, status: 'completed' } } });
  const identity = f.engine.nodeIdentity(f.projectId, 'plan');
  await f.engine.command({ type: 'save_edge', projectId: f.projectId, edge: { id: 'edge', sourceNodeId: 'plan', targetNodeId: 'implement', condition: 'ready', revision: 0 } });
  const before = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!;
  const original = before.nodes.find(node => node.id === 'plan')!;
  const deleted = (await f.engine.command({ type: 'delete_node', projectId: f.projectId, nodeId: 'plan' } as any)).snapshot.selected!;
  assert.equal(deleted.nodes.some(node => node.id === 'plan'), false);
  assert.equal(deleted.edges!.length, 0);
  assert.deepEqual(deleted.tasks, before.tasks);
  assert.deepEqual(deleted.conversation, before.conversation);
  assert.equal((deleted as any).archivedNodes[0].name, '规划');
  assert.equal((deleted as any).archivedNodes[0].threadId, original.threadId);
  assert.equal(owner.identities.has(identity.token), false);
  await assert.rejects(f.send('plan'), /节点/);
  await assert.rejects(f.engine.command({ type: 'save_node', projectId: f.projectId, node: original }), /删除|历史/);
  await assert.rejects(f.engine.command({ type: 'retry_task', projectId: f.projectId, taskId: task.id, confirmed: true }), /重试|节点/);
  await f.engine.close();
  const restored = new WorkflowEngine({ workbenchRoot: f.root, executable: 'unused' }); t.after(() => restored.close()); await restored.init();
  const after = (await restored.command({ type: 'snapshot', projectId: f.projectId })).snapshot.selected!;
  assert.equal(after.nodes.length, 2); assert.equal((after as any).archivedNodes[0].threadId, original.threadId);
  assert.equal(JSON.stringify(after.conversation), JSON.stringify(before.conversation));
});

test('deletion rejects unfinished work and failed persistence leaves node, edges and identity intact', async t => {
  const f = await fixture(t), owner = f.engine as any, state = owner.states.get(f.projectId);
  await f.send('plan'); await until(() => !!state.tasks[0].turnId);
  for (const status of ['running', 'paused', 'queued', 'waiting_source', 'waiting_review', 'needs_reconciliation']) {
    state.tasks[0].status = status;
    await assert.rejects(f.engine.command({ type: 'delete_node', projectId: f.projectId, nodeId: 'plan' } as any), /任务|处理|核对/);
    assert.equal(state.nodes.length, 3);
  }
  state.tasks[0].status = 'completed';
  const identity = f.engine.nodeIdentity(f.projectId, 'plan');
  const store = owner.stores.get(f.projectId), save = store.save.bind(store);
  store.save = () => { throw Error('delete persistence failure'); };
  await assert.rejects(f.engine.command({ type: 'delete_node', projectId: f.projectId, nodeId: 'plan' } as any), /delete persistence failure/);
  store.save = save;
  assert.equal(state.nodes.length, 3); assert.equal(state.archivedNodes?.length ?? 0, 0);
  assert.equal(owner.identities.has(identity.token), true);
});

test('deletion while retry awaits native account leaves retained failure unchanged', async t => {
  const f = await fixture(t); await f.send('plan');
  const state = (f.engine as any).states.get(f.projectId), client = f.clients[0];
  await until(() => !!state.tasks[0].turnId); const task = state.tasks[0];
  client.options.onEvent({ method: 'turn/completed', params: { threadId: task.threadId, turn: { id: task.turnId, status: 'failed', error: { message: 'original failure' } } } });
  const before = JSON.stringify(task), entered = deferred(), gate = deferred(), original = client.port.rpc;
  client.port.rpc = async (method, params) => { if (method === 'account/read') { entered.resolve(); await gate.promise; } return original(method, params); };
  const retry = f.engine.command({ type: 'retry_task', projectId: f.projectId, taskId: task.id, confirmed: true });
  const settled = Promise.allSettled([retry]);
  await entered.promise; await f.engine.command({ type: 'delete_node', projectId: f.projectId, nodeId: 'plan' }); gate.resolve();
  const [result] = await settled;
  assert.equal(result.status, 'rejected');
  if (result.status === 'rejected') assert.match(String(result.reason), /删除|历史/);
  assert.equal(JSON.stringify(task), before);
});
