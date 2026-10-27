import assert from 'node:assert/strict';
import test from 'node:test';
import { arrangeWorkflow } from '../src/renderer/workflow-layout.js';
import { anchorPoint } from '../src/renderer/edge-geometry.js';
import { projectEdgeBounds } from '../src/renderer/group-geometry.js';
import { WorkflowEngine } from '../src/core/engine.js';
import { fixture } from './runtime-fixture.js';
import { configureGroupedCycle, groupedCycleFixture } from './grouped-cycle-fixture.js';

const { nodes, edges, groups, viewport } = groupedCycleFixture();
const measured = nodes.map(node => ({ ...node, measured: { width: 215, height: 132 } }));

test('grouped legacy cycles produce orthogonal routes attached to their actual endpoints', async () => {
  const plan = await arrangeWorkflow(measured, edges, {}, viewport, groups);
  assert.deepEqual(new Set(plan.positions.map(item => item.nodeId)), new Set(nodes.map(node => node.id)));
  assert.deepEqual(new Set(plan.edgeLayouts.map(item => item.edgeId)), new Set(edges.map(edge => edge.id)));
  const placed = measured.map(node => ({ ...node, position: plan.positions.find(item => item.nodeId === node.id)!.position }));
  const layouts = Object.fromEntries(plan.edgeLayouts.map(item => [item.edgeId, item.layout]));
  for (const edge of edges) {
    const layout = layouts[edge.id], points = layout.route!.points;
    for (let index = 1; index < points.length; index++) assert(Math.abs(points[index].x - points[index - 1].x) <= .01 || Math.abs(points[index].y - points[index - 1].y) <= .01, `Diagonal ${edge.id}: ${JSON.stringify(points)}`);
    const bounds = projectEdgeBounds(edge, groups, placed, edges, layouts)!;
    for (const [actual, expected] of [[points[0], anchorPoint(bounds.source, layout.source!)], [points.at(-1)!, anchorPoint(bounds.target, layout.target!)]]) assert(Math.abs(actual.x - expected.x) <= .01 && Math.abs(actual.y - expected.y) <= .01, `Detached ${edge.id}`);
  }
});

test('grouped cyclic arrangement saves and reopens while diagonal user input remains rejected', async t => {
  const f = await fixture(t);
  await configureGroupedCycle(f.engine, f.projectId);
  const before = (await f.engine.command({ type: 'snapshot', projectId: f.projectId })).snapshot.selected!;
  const plan = await arrangeWorkflow(measured, before.edges!, {}, viewport, before.groups);
  const command = { type: 'move_nodes' as const, projectId: f.projectId, positions: plan.positions, edgeLayouts: plan.edgeLayouts };
  const malformed = structuredClone(command); malformed.edgeLayouts[0].layout.route!.points = [{ x: 0, y: 0 }, { x: 10, y: 10 }];
  await assert.rejects(f.engine.command(malformed), /正交走线/);
  const saved = (await f.engine.command(command)).snapshot.selected!;
  await f.engine.close(); const reopened = new WorkflowEngine({ workbenchRoot: f.root, executable: 'unused' });
  t.after(() => reopened.close()); await reopened.init();
  const restored = (await reopened.command({ type: 'snapshot', projectId: f.projectId })).snapshot.selected!;
  assert.deepEqual(restored.edgeLayouts, saved.edgeLayouts); assert.deepEqual(restored.groups, saved.groups);
  assert.deepEqual(restored.nodes.map(node => node.position), saved.nodes.map(node => node.position));
});
