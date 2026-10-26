import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowEngine } from '../src/core/engine.js';
import { fixture, until } from './runtime-fixture.js';

test('arranged coordinates save together while node identity and custom connector layout persist', async t => {
  const f = await fixture(t);
  await f.engine.command({ type: 'save_edge', projectId: f.projectId, edge: { id: 'route', sourceNodeId: 'plan', targetNodeId: 'implement', condition: 'Ready', revision: 0 } });
  await f.engine.command({ type: 'save_edge_layout', projectId: f.projectId, edgeId: 'route', layout: { revision: 0, source: { side: 'top', offset: .25 }, target: { side: 'bottom', offset: .75 }, controlOffset: { x: 80, y: 40 } } });
  const before = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!;
  const identity = structuredClone(f.engine.nodeIdentity(f.projectId, 'plan'));
  const positions = [{ nodeId: 'plan', position: { x: 70, y: 80 } }, { nodeId: 'implement', position: { x: 430, y: 80 } }, { nodeId: 'review', position: { x: 790, y: 80 } }];
  const saved = (await f.engine.command({ type: 'move_nodes', projectId: f.projectId, positions })).snapshot.selected!;
  assert.deepEqual(saved.nodes.map(node => node.position), positions.map(item => item.position));
  for (const node of before.nodes) assert.deepEqual(saved.nodes.find(item => item.id === node.id), { ...node, position: positions.find(item => item.nodeId === node.id)!.position });
  for (const key of ['tasks', 'edges', 'edgeLayouts', 'conversation', 'messages', 'humanReviews'] as const) assert.deepEqual(saved[key], before[key]);
  assert.deepEqual(f.engine.nodeIdentity(f.projectId, 'plan'), identity);
  await f.engine.close();
  const reopened = new WorkflowEngine({ workbenchRoot: f.root, executable: 'unused' });
  try { await reopened.init(); const restored = (await reopened.command({ type: 'snapshot', projectId: f.projectId })).snapshot.selected!; assert.deepEqual(restored.nodes.map(node => ({ id: node.id, position: node.position })), positions.map(item => ({ id: item.nodeId, position: item.position }))); assert.deepEqual(restored.edgeLayouts, before.edgeLayouts); }
  finally { await reopened.close(); }
});

test('invalid arrangements and storage failures cannot partially move nodes, including a running conversation', async t => {
  const f = await fixture(t);
  await f.send('plan');
  const owner = f.engine as any;
  await until(() => owner.states.get(f.projectId).tasks[0]?.turnId);
  const command = { type: 'move_nodes' as const, projectId: f.projectId, positions: [{ nodeId: 'plan', position: { x: 400, y: 80 } }] };
  const before = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!;
  for (const positions of [null, [], [null], [...command.positions, { nodeId: 'missing', position: { x: 1, y: 2 } }], [...command.positions, ...command.positions], [{ nodeId: 'plan', position: { x: Infinity, y: 2 } }]]) {
    await assert.rejects(f.engine.command({ ...command, positions } as never));
    assert.deepEqual((await f.engine.command({ type: 'snapshot' })).snapshot.selected!.nodes, before.nodes);
  }
  const store = owner.stores.get(f.projectId), save = store.save;
  store.save = () => { throw Error('Fixture refused arrangement'); };
  try { await assert.rejects(f.engine.command(command), /Fixture refused/); }
  finally { store.save = save; }
  assert.deepEqual((await f.engine.command({ type: 'snapshot' })).snapshot.selected!.nodes, before.nodes);
  const saved = (await f.engine.command(command)).snapshot.selected!;
  assert.deepEqual(saved.tasks, before.tasks);
  assert.equal(saved.nodes[0].revision, before.nodes[0].revision);
  assert.equal(saved.nodes[0].threadId, before.nodes[0].threadId);
  assert.equal(saved.nodes[0].status, 'running');
});

test('arrangement separates measured branches, return cycles and disconnected cards deterministically', async () => {
  const { arrangeWorkflow } = await import('../src/renderer/workflow-layout.js');
  const nodes = [
    { id: 'a', measured: { width: 300, height: 220 } },
    { id: 'b', measured: { width: 260, height: 180 } },
    { id: 'c', measured: { width: 240, height: 270 } },
    { id: 'd', measured: { width: 400, height: 160 } },
    { id: 'island', measured: { width: 215, height: 170 } },
  ];
  const edges = [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd'], ['d', 'a']].map(([sourceNodeId, targetNodeId], index) => ({ id: 'route-' + index, sourceNodeId, targetNodeId, condition: '相关工作已就绪', revision: 1 }));
  const original = structuredClone(nodes), result = await arrangeWorkflow(nodes, edges);
  assert.deepEqual(await arrangeWorkflow(nodes, edges), result);
  assert.deepEqual(nodes, original);
  const byId = new Map(result.positions.map(item => [item.nodeId, item.position]));
  assert.equal(result.positions.length, nodes.length); assert.equal(result.edgeLayouts.length, edges.length);
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = byId.get(nodes[i].id)!, b = byId.get(nodes[j].id)!;
    assert(a.x + nodes[i].measured.width < b.x || b.x + nodes[j].measured.width < a.x || a.y + nodes[i].measured.height < b.y || b.y + nodes[j].measured.height < a.y);
  }
  assert.deepEqual((await arrangeWorkflow([], [])).positions, []);
});
