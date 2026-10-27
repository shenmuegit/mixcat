import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebProductTemplate } from '../src/core/web-product.js';
import { arrangeWorkflow } from '../src/renderer/workflow-layout.js';
import { edgeLabelSize, edgeRoute } from '../src/renderer/edge-geometry.js';
import { fixture } from './runtime-fixture.js';
import { WorkflowEngine } from '../src/core/engine.js';

const adjacency: Record<string, string[]> = { product: ['requirements'], requirements: ['design', 'architect'], design: ['frontend'], frontend: ['test', 'architect'], backend: ['frontend', 'architect'], test: ['frontend', 'backend', 'product'], architect: ['backend', 'frontend'] };
const overlap = (a: { x: number; y: number; width: number; height: number }, b: typeof a) => Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x) + .01 && Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y) + .01;

for (const count of [11, 13]) test(`${count}-edge Web arrangement reserves label space and separate orthogonal channels at a moderate scale`, async () => {
  const nodes = Object.keys(adjacency).map(id => ({ id, measured: { width: 215, height: 132 } }));
  const edges = Object.entries(adjacency).flatMap(([sourceNodeId, targets]) => targets.map(targetNodeId => ({ id: `${sourceNodeId}-${targetNodeId}`, sourceNodeId, targetNodeId, condition: '旧版工作流条件', revision: 1 }))).filter(edge => !(count === 11 && edge.sourceNodeId === 'test' && ['frontend', 'product'].includes(edge.targetNodeId)));
  assert.equal(edges.length, count);
  const plan = await arrangeWorkflow(nodes, edges, {}, { width: 1016, height: 800 });
  assert.equal(plan.positions.length, 7); assert.equal(plan.edgeLayouts.length, count);
  assert(plan.bounds.width < 1500 && plan.bounds.height < 1100, 'The seven-node diagram must not become an oversized strip or tower');
  const cards = plan.positions.map(item => ({ ...item.position, width: 215, height: 132 }));
  const labels = plan.edgeLayouts.map(item => ({ x: item.layout.route!.label.x - edgeLabelSize.width / 2, y: item.layout.route!.label.y - edgeLabelSize.height / 2, ...edgeLabelSize }));
  for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) assert(!overlap(cards[i], cards[j]));
  for (let i = 0; i < labels.length; i++) {
    for (const card of cards) assert(!overlap(labels[i], card), 'A condition label overlaps a node');
    for (let j = i + 1; j < labels.length; j++) assert(!overlap(labels[i], labels[j]), 'Condition labels overlap');
  }
  const segments = plan.edgeLayouts.flatMap(item => item.layout.route!.points.slice(1).map((end, index) => ({ edge: item.edgeId, start: item.layout.route!.points[index], end })));
  for (const segment of segments) for (const card of cards) {
    const a = segment.start, b = segment.end;
    const crossing = Math.abs(a.y - b.y) < .01 ? a.y > card.y + 1 && a.y < card.y + card.height - 1 && Math.min(Math.max(a.x, b.x), card.x + card.width - 1) > Math.max(Math.min(a.x, b.x), card.x + 1) : a.x > card.x + 1 && a.x < card.x + card.width - 1 && Math.min(Math.max(a.y, b.y), card.y + card.height - 1) > Math.max(Math.min(a.y, b.y), card.y + 1);
    assert(!crossing, 'A connector cuts through a card');
  }
  for (let i = 0; i < segments.length; i++) for (let j = i + 1; j < segments.length; j++) {
    const a = segments[i], b = segments[j]; if (a.edge === b.edge) continue;
    const horizontal = Math.abs(a.start.y - a.end.y) < .01 && Math.abs(b.start.y - b.end.y) < .01 && Math.abs(a.start.y - b.start.y) < .01;
    const vertical = Math.abs(a.start.x - a.end.x) < .01 && Math.abs(b.start.x - b.end.x) < .01 && Math.abs(a.start.x - b.start.x) < .01;
    const axis = horizontal ? 'x' : 'y';
    if (horizontal || vertical) assert(Math.min(Math.max(a.start[axis], a.end[axis]), Math.max(b.start[axis], b.end[axis])) - Math.max(Math.min(a.start[axis], a.end[axis]), Math.min(b.start[axis], b.end[axis])) <= 24, 'Different connectors share a long segment');
  }
  assert.deepEqual(await arrangeWorkflow(nodes, [...edges].reverse(), {}, { width: 1016, height: 800 }), plan);
});

test('planned routes translate together and fall back to live endpoints when either node moves', () => {
  const source = { x: 100, y: 100 }, target = { x: 400, y: 200 };
  const route = { points: [source, { x: 150, y: 100 }, { x: 150, y: 50 }, { x: 350, y: 50 }, { x: 350, y: 200 }, target], label: { x: 250, y: 35 } };
  const initial = edgeRoute(source, 'right', target, 'left', undefined, route);
  assert.deepEqual(initial.control, { x: 250, y: 50 }); assert.deepEqual(initial.label, route.label);
  const moved = edgeRoute({ x: 120, y: 120 }, 'right', { x: 420, y: 220 }, 'left', undefined, route);
  assert.deepEqual(moved.control, { x: 270, y: 70 }); assert.deepEqual(moved.label, { x: 270, y: 55 });
  const sourceOnly = edgeRoute({ x: 120, y: 100 }, 'right', target, 'left', undefined, route);
  assert.equal(sourceOnly.label, undefined); assert(sourceOnly.path.startsWith('M120 100'));
  const targetOnly = edgeRoute(source, 'right', { x: 420, y: 200 }, 'left', undefined, route);
  assert.equal(targetOnly.label, undefined); assert.notEqual(targetOnly.path, initial.path);
});

test('dense cyclic graphs retain every edge when wrapping cannot produce complete sections', async () => {
  const nodes = createWebProductTemplate().nodes.map(node => ({ id: node.id, measured: { width: 215, height: 132 } }));
  const edges = nodes.flatMap(source => nodes.filter(target => target.id !== source.id).map(target => ({ id: `${source.id}-${target.id}`, sourceNodeId: source.id, targetNodeId: target.id, condition: 'Explicit connection', revision: 1 })));
  const plan = await arrangeWorkflow(nodes, edges);
  assert.equal(plan.edgeLayouts.length, edges.length);
  assert.deepEqual(new Set(plan.edgeLayouts.map(item => item.edgeId)), new Set(edges.map(edge => edge.id)));
  assert(plan.edgeLayouts.every(item => item.layout.route!.points.length >= 2 && Number.isFinite(item.layout.route!.label.x)));
});

test('node positions and planned routes commit atomically, reject stale graph/layout data and survive restart', async t => {
  const f = await fixture(t);
  for (const [id, sourceNodeId, targetNodeId] of [['forward', 'plan', 'implement'], ['check', 'implement', 'review'], ['return', 'review', 'plan']]) await f.engine.command({ type: 'save_edge', projectId: f.projectId, edge: { id, sourceNodeId, targetNodeId, condition: 'Work is ready', revision: 0 } });
  const before = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!;
  const identity = structuredClone(f.engine.nodeIdentity(f.projectId, 'plan'));
  const plan = await arrangeWorkflow(before.nodes.map(node => ({ ...node, measured: { width: 215, height: 132 } })), before.edges!);
  const command = { type: 'move_nodes' as const, projectId: f.projectId, positions: plan.positions, edgeLayouts: plan.edgeLayouts };
  for (const invalid of [ { ...command, edgeLayouts: plan.edgeLayouts.slice(1) }, { ...command, edgeLayouts: plan.edgeLayouts.map((item, index) => index ? item : { ...item, edgeRevision: 99 }) }, { ...command, edgeLayouts: plan.edgeLayouts.map((item, index) => index ? item : { ...item, layout: { ...item.layout, route: { ...item.layout.route!, points: [{ x: 0, y: 0 }, { x: Infinity, y: 0 }] } } }) } ]) {
    await assert.rejects(f.engine.command(invalid));
    const snapshot = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!; assert.deepEqual(snapshot.nodes, before.nodes); assert.deepEqual(snapshot.edgeLayouts, before.edgeLayouts);
  }
  const store = (f.engine as any).stores.get(f.projectId), save = store.save;
  store.save = () => { throw Error('Fixture refused complete layout'); };
  try { await assert.rejects(f.engine.command(command), /Fixture refused/); } finally { store.save = save; }
  const unchanged = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!; assert.deepEqual(unchanged.nodes, before.nodes); assert.deepEqual(unchanged.edgeLayouts, before.edgeLayouts);
  const saved = (await f.engine.command(command)).snapshot.selected!;
  for (const item of plan.edgeLayouts) assert.deepEqual(saved.edgeLayouts![item.edgeId].route, item.layout.route);
  assert.deepEqual(f.engine.nodeIdentity(f.projectId, 'plan'), identity); assert.deepEqual(saved.edges, before.edges); assert.deepEqual(saved.tasks, before.tasks);
  await assert.rejects(f.engine.command(command), /布局已更新/);
  await f.engine.close(); const reopened = new WorkflowEngine({ workbenchRoot: f.root, executable: 'unused' });
  try { await reopened.init(); const restored = (await reopened.command({ type: 'snapshot', projectId: f.projectId })).snapshot.selected!; assert.deepEqual(restored.edgeLayouts, saved.edgeLayouts); assert.deepEqual(restored.nodes.map(node => node.position), plan.positions.map(item => item.position)); }
  finally { await reopened.close(); }
});
