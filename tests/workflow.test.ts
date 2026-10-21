import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowEngine } from '../src/core/engine.js';
import { ProjectStore } from '../src/core/store.js';
import { fixture, until } from './runtime-fixture.js';

test('related_node_and_edge_commit_together, including rejected writes and retry', async t => {
  const f = await fixture(t);
  const before = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!;
  const node = { ...before.nodes[0], id: 'related', name: 'Independent review', revision: 0 };
  const command = { type: 'save_node' as const, projectId: f.projectId, node, relatedTo: 'plan', condition: '成果需要独立审查时' };
  const identity = f.engine.nodeIdentity(f.projectId, 'plan');
  const save = ProjectStore.prototype.save;
  ProjectStore.prototype.save = () => { throw Error('fixture commit failure'); };
  try {
    await assert.rejects(f.engine.command(command), /fixture commit failure/);
    const failed = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!;
    assert.deepEqual(failed.nodes, before.nodes);
    assert.deepEqual(failed.edges, before.edges);
    assert.deepEqual(failed.activities, before.activities);
    await assert.rejects(f.engine.command({ type: 'save_node', projectId: f.projectId, node: { ...before.nodes[0], name: 'Uncommitted config' } }), /fixture commit failure/);
    assert.equal(f.engine.nodeIdentity(f.projectId, 'plan'), identity);
    const disk = new ProjectStore(f.root);
    try { assert.deepEqual(disk.read()!.edges, []); assert.equal(disk.read()!.nodes.length, before.nodes.length); } finally { disk.close(); }
  } finally { ProjectStore.prototype.save = save; }
  const saved = (await f.engine.command(command)).snapshot.selected!;
  assert.equal(saved.nodes.filter(n => n.id === node.id).length, 1);
  assert.deepEqual(saved.edges!.map(({ sourceNodeId, targetNodeId, condition }) => ({ sourceNodeId, targetNodeId, condition })), [{ sourceNodeId: 'plan', targetNodeId: node.id, condition: command.condition }]);
  const store = new ProjectStore(f.root);
  try { assert.deepEqual(store.read()!.edges, saved.edges); assert.equal(store.read()!.nodes.length, saved.nodes.length); } finally { store.close(); }
});

test('move_preserves_revision_thread_and_identity while node is busy', async t => {
  const f = await fixture(t);
  await f.send('plan');
  await until(() => f.clients[0]?.calls.some(c => c.method === 'turn/start') ?? false);
  const before = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!.nodes[0];
  const identity = f.engine.nodeIdentity(f.projectId, 'plan');
  const position = { x: 172, y: 243 };
  const moved = (await f.engine.command({ type: 'move_node', projectId: f.projectId, nodeId: 'plan', position })).snapshot.selected!.nodes[0];
  assert.deepEqual(moved, { ...before, position });
  assert.equal(f.engine.nodeIdentity(f.projectId, 'plan'), identity);
  await assert.rejects(f.engine.command({ type: 'save_node', projectId: f.projectId, node: { ...moved, name: 'blocked' } }), /活动或待处理任务/);
});

test('stale_config_cannot_undo_recent_layout; genuine config conflicts are rejected', async t => {
  const f = await fixture(t);
  const original = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!.nodes[0];
  const position = { x: 520, y: 330 };
  await f.engine.command({ type: 'move_node', projectId: f.projectId, nodeId: original.id, position });
  const updated = (await f.engine.command({ type: 'save_node', projectId: f.projectId, node: { ...original, name: 'New config' } })).snapshot.selected!.nodes[0];
  assert.deepEqual(updated.position, position);
  assert.equal(updated.revision, original.revision + 1);
  await assert.rejects(f.engine.command({ type: 'save_node', projectId: f.projectId, node: original }), /已被更新/);
  assert.deepEqual((await f.engine.command({ type: 'snapshot' })).snapshot.selected!.nodes[0], updated);
});

test('natural language condition edit/delete survives restart and keeps actual handoff history', async t => {
  const f = await fixture(t);
  await f.send('plan');
  await until(() => f.clients[0]?.calls.some(c => c.method === 'turn/start') ?? false);
  const task = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!.tasks[0];
  await f.engine.invokeTool('handoff', { to_node_id: 'review', task: 'Review freely', reason: 'Independent check', result: 'original content' }, { identity: f.engine.nodeIdentity(f.projectId, 'plan'), threadId: task.threadId!, turnId: task.turnId!, callId: 'fixture-handoff' });
  const edge = { id: 'condition', sourceNodeId: 'plan', targetNodeId: 'review', condition: '如果成果值得审查：由节点自行判断。', revision: 0 };
  const saved = (await f.engine.command({ type: 'save_edge', projectId: f.projectId, edge })).snapshot.selected!;
  const edited = (await f.engine.command({ type: 'save_edge', projectId: f.projectId, edge: { ...saved.edges![0], condition: '条件可含换行\n无需固定 schema' } })).snapshot.selected!;
  assert.equal(edited.edges![0].revision, 2);
  assert.equal(edited.handoffs.length, 1);
  const disk = new ProjectStore(f.root);
  try { assert.deepEqual(disk.read()!.edges, edited.edges); } finally { disk.close(); }
  await assert.rejects(f.engine.command({ type: 'save_node', projectId: f.projectId, node: edited.nodes.find(n => n.id === 'review')! }), /活动或待处理任务/);
  await assert.rejects(f.engine.command({ type: 'save_edge', projectId: f.projectId, edge: saved.edges![0] }), /已更新/);
  await f.engine.command({ type: 'delete_edge', projectId: f.projectId, edgeId: edge.id });
  await f.engine.close();
  const reopened = new WorkflowEngine({ workbenchRoot: f.root, executable: 'unused' });
  try {
    await reopened.init();
    const restored = (await reopened.command({ type: 'snapshot', projectId: f.projectId })).snapshot.selected!;
    assert.deepEqual(restored.edges, []);
    assert.deepEqual(restored.handoffs.map(h => h.result), ['original content']);
    await assert.rejects(reopened.command({ type: 'save_node', projectId: f.projectId, node: restored.nodes[0] }), /活动或待处理任务/);
  } finally { await reopened.close(); }
});

test('invalid associated source or position changes neither nodes nor edges', async t => {
  const f = await fixture(t);
  const before = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!;
  await assert.rejects(f.engine.command({ type: 'save_node', projectId: f.projectId, node: { ...before.nodes[0], id: 'new' }, relatedTo: 'missing' }), /已有节点/);
  await assert.rejects(f.engine.command({ type: 'move_node', projectId: f.projectId, nodeId: 'plan', position: { x: NaN, y: 0 } }), /位置/);
  const after = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!;
  assert.deepEqual(after.nodes, before.nodes); assert.deepEqual(after.edges, before.edges);
});

test('edge save and delete publish only after SQLite commit succeeds', async t => {
  const f = await fixture(t), owner = f.engine as any;
  const state = owner.states.get(f.projectId), store = owner.stores.get(f.projectId) as ProjectStore;
  const edge = { id: 'atomic-edge', sourceNodeId: 'plan', targetNodeId: 'review', condition: 'When useful', revision: 0 };
  const reject = () => store.db.exec("CREATE TEMP TRIGGER reject_edge BEFORE INSERT ON project_state BEGIN SELECT RAISE(ABORT, 'fixture edge rejection'); END");
  const restore = () => store.db.exec('DROP TRIGGER reject_edge');
  const before = structuredClone(state); reject();
  try {
    await assert.rejects(f.engine.command({ type: 'save_edge', projectId: f.projectId, edge }), /fixture edge rejection/);
    assert.deepEqual(state, before); assert.deepEqual(store.read()!.edges, []);
  } finally { restore(); }
  await f.engine.command({ type: 'save_edge', projectId: f.projectId, edge });
  const saved = structuredClone(state); reject();
  try {
    await assert.rejects(f.engine.command({ type: 'save_edge', projectId: f.projectId, edge: { ...state.edges[0], condition: 'Rejected update' } }), /fixture edge rejection/);
    await assert.rejects(f.engine.command({ type: 'delete_edge', projectId: f.projectId, edgeId: edge.id }), /fixture edge rejection/);
    assert.deepEqual(state, saved); assert.deepEqual(store.read()!.edges, saved.edges);
  } finally { restore(); }
  await f.engine.command({ type: 'delete_edge', projectId: f.projectId, edgeId: edge.id });
  assert.deepEqual(state.edges, []); assert.deepEqual(store.read()!.edges, []);
});
