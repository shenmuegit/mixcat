import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowEngine } from '../src/core/engine.js';
import { fixture, until } from './runtime-fixture.js';

test('connector layout persists independently from its condition, nodes and MCP routes', async t => {
  const f = await fixture(t);
  const edge = { id: 'route', sourceNodeId: 'plan', targetNodeId: 'implement', condition: 'Ready to implement', revision: 0 };
  const before = (await f.engine.command({ type: 'save_edge', projectId: f.projectId, edge })).snapshot.selected!;
  const identity = structuredClone(f.engine.nodeIdentity(f.projectId, 'plan'));
  const layout = { revision: 0, source: { side: 'top' as const, offset: .25 }, target: { side: 'bottom' as const, offset: .75 }, bends: [{ x: 80, y: 40 }, { x: 240, y: 40 }] };
  const saved = (await f.engine.command({ type: 'save_edge_layout', projectId: f.projectId, edgeId: edge.id, layout })).snapshot.selected!;
  assert.deepEqual(saved.edgeLayouts?.route, { ...layout, revision: 1 });
  assert.deepEqual(saved.edges, before.edges);
  assert.deepEqual(saved.nodes, before.nodes);
  assert.deepEqual(saved.tasks, before.tasks);
  assert.deepEqual(f.engine.nodeIdentity(f.projectId, 'plan'), identity);
  await f.engine.close();
  const reopened = new WorkflowEngine({ workbenchRoot: f.root, executable: 'unused' });
  try {
    await reopened.init();
    const restored = (await reopened.command({ type: 'snapshot', projectId: f.projectId })).snapshot.selected!;
    assert.deepEqual(restored.edgeLayouts, saved.edgeLayouts);
    assert.deepEqual(restored.edges, before.edges);
  } finally { await reopened.close(); }
});

test('layout edits reject stale and invalid requests and are cleaned up with their edge', async t => {
  const f = await fixture(t);
  const edge = { id: 'route', sourceNodeId: 'plan', targetNodeId: 'implement', condition: 'Ready', revision: 0 };
  await f.engine.command({ type: 'save_edge', projectId: f.projectId, edge });
  const command = { type: 'save_edge_layout' as const, projectId: f.projectId, edgeId: edge.id, layout: { revision: 0, source: { side: 'top' as const, offset: .5 } } };
  const saved = (await f.engine.command(command)).snapshot.selected!;
  await assert.rejects(f.engine.command(command), /布局已更新/);
  for (const layout of [null, { revision: -1 }, { revision: 1, source: { side: 'inside', offset: .5 } }, { revision: 1, source: { side: 'top', offset: 1.1 } }, { revision: 1, bends: [{ x: NaN, y: 0 }] }, { revision: 1, bends: Array(129).fill({ x: 1, y: 1 }) }]) {
    await assert.rejects(f.engine.command({ ...command, layout } as never));
    assert.deepEqual((await f.engine.command({ type: 'snapshot' })).snapshot.selected!.edgeLayouts, saved.edgeLayouts);
  }
  await assert.rejects(f.engine.command({ ...command, edgeId: 'missing' }), /不存在/);
  await f.engine.command({ type: 'save_edge', projectId: f.projectId, edge: { ...saved.edges![0], condition: 'Updated condition' } });
  assert.deepEqual((await f.engine.command({ type: 'snapshot' })).snapshot.selected!.edgeLayouts, saved.edgeLayouts);
  await f.engine.command({ type: 'delete_edge', projectId: f.projectId, edgeId: edge.id });
  assert.deepEqual((await f.engine.command({ type: 'snapshot' })).snapshot.selected!.edgeLayouts, {});
  await f.engine.command({ type: 'save_edge', projectId: f.projectId, edge });
  await f.engine.command(command);
  await f.engine.command({ type: 'delete_node', projectId: f.projectId, nodeId: 'implement' });
  assert.deepEqual((await f.engine.command({ type: 'snapshot' })).snapshot.selected!.edgeLayouts, {});
});

test('active native work retains its task, thread and tools while an edge layout changes', async t => {
  const f = await fixture(t);
  await f.engine.command({ type: 'save_edge', projectId: f.projectId, edge: { id: 'route', sourceNodeId: 'plan', targetNodeId: 'implement', condition: 'Ready', revision: 0 } });
  await f.send('plan'); await until(() => f.clients.some(client => client.calls.some(call => call.method === 'turn/start')));
  const before = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!;
  const identity = structuredClone(f.engine.nodeIdentity(f.projectId, 'plan'));
  const after = (await f.engine.command({ type: 'save_edge_layout', projectId: f.projectId, edgeId: 'route', layout: { revision: 0, target: { side: 'top', offset: .75 } } })).snapshot.selected!;
  assert.equal(after.tasks[0].status, 'running');
  assert.deepEqual(after.tasks, before.tasks); assert.deepEqual(after.nodes, before.nodes);
  assert.deepEqual(f.engine.nodeIdentity(f.projectId, 'plan'), identity);
});
