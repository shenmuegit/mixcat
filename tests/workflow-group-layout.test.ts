import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebProductTemplate } from '../src/core/web-product.js';
import { arrangeWorkflow } from '../src/renderer/workflow-layout.js';
import { anchorPoint, edgeLabelSize, edgeRoute } from '../src/renderer/edge-geometry.js';
import { groupBounds, projectEdgeBounds } from '../src/renderer/group-geometry.js';
import { getViewportForBounds } from '@xyflow/react';
import type { WorkflowGroup } from '../src/shared/types.js';

type Bounds = { x: number; y: number; width: number; height: number };
const overlap = (a: Bounds, b: Bounds) => Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x) + .01 && Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y) + .01;

test('product-definition arrangement encloses its members and internal labels while reserving the outside workflow', async () => {
  const template = createWebProductTemplate(), nodes = template.nodes.map(node => ({ id: node.id, measured: { width: 215, height: 132 } }));
  const before = structuredClone({ nodes, edges: template.edges, groups: template.groups });
  const plan = await arrangeWorkflow(nodes, template.edges, {}, { width: 1016, height: 800 }, template.groups);
  const cards = new Map(plan.positions.map(item => [item.nodeId, { ...item.position, width: 215, height: 132 }]));
  const placed = nodes.map(node => ({ ...node, position: plan.positions.find(item => item.nodeId === node.id)!.position })), layouts = Object.fromEntries(plan.edgeLayouts.map(item => [item.edgeId, item.layout]));
  const frame = groupBounds(template.groups[0], placed, template.edges, layouts)!;
  for (const [id, card] of cards) if (!template.groups[0].nodeIds.includes(id)) assert(!overlap(frame, card), `Outside node ${id} must not be enclosed by the group`);
  assert.equal(plan.positions.length, 8);
  assert.deepEqual(new Set(plan.edgeLayouts.map(item => item.edgeId)), new Set(template.edges.map(edge => edge.id)));
  const labels = plan.edgeLayouts.map(item => ({ x: item.layout.route!.label.x - edgeLabelSize.width / 2, y: item.layout.route!.label.y - edgeLabelSize.height / 2, ...edgeLabelSize }));
  for (let i = 0; i < labels.length; i++) {
    for (const card of cards.values()) assert(!overlap(labels[i], card), 'A condition label obscures a node');
    for (let j = i + 1; j < labels.length; j++) assert(!overlap(labels[i], labels[j]), 'Condition labels overlap');
  }
  const fittedCardWidth = 215 * getViewportForBounds(plan.bounds, 1016, 800, .2, 1.5, .08).zoom;
  assert(fittedCardWidth >= 120, `Fit-to-view makes grouped cards too small: ${fittedCardWidth.toFixed(1)}px`);
  for (const item of plan.edgeLayouts) {
    const definition = template.edges.find(edge => edge.id === item.edgeId)!;
    if (!template.groups[0].nodeIds.includes(definition.sourceNodeId) || !template.groups[0].nodeIds.includes(definition.targetNodeId)) continue;
    const label = item.layout.route!.label;
    assert(label.x - edgeLabelSize.width / 2 >= frame.x + 24 && label.x + edgeLabelSize.width / 2 <= frame.x + frame.width - 24);
    assert(label.y - edgeLabelSize.height / 2 >= frame.y + 60 && label.y + edgeLabelSize.height / 2 <= frame.y + frame.height - 24);
  }
  assert.deepEqual(await arrangeWorkflow(nodes, [...template.edges].reverse(), {}, { width: 1016, height: 800 }, template.groups), plan);
  assert.deepEqual({ nodes, edges: template.edges, groups: template.groups }, before);
  for (const item of plan.edgeLayouts) {
    const edge = template.edges.find(edge => edge.id === item.edgeId)!, projected = projectEdgeBounds(edge, template.groups, placed, template.edges, layouts)!;
    assert.deepEqual(item.layout.route!.points[0], anchorPoint(projected.source, item.layout.source!));
    assert.deepEqual(item.layout.route!.points.at(-1), anchorPoint(projected.target, item.layout.target!));
  }
});

test('explicit outside edges from ordinary members keep their real endpoints and visible labels', async () => {
  const template = createWebProductTemplate(), nodes = template.nodes.map(node => ({ id: node.id, measured: { width: 215, height: 132 } }));
  const extra = [ ['design', 'frontend'], ['frontend', 'requirements'] ].map(([sourceNodeId, targetNodeId]) => ({ id: `${sourceNodeId}-${targetNodeId}`, sourceNodeId, targetNodeId, condition: 'Explicit user connection', revision: 3 }));
  const edges = [...template.edges, ...extra], plan = await arrangeWorkflow(nodes, edges, {}, { width: 1016, height: 800 }, template.groups);
  const placed = nodes.map(node => ({ ...node, position: plan.positions.find(item => item.nodeId === node.id)!.position })), layouts = Object.fromEntries(plan.edgeLayouts.map(item => [item.edgeId, item.layout]));
  for (const edge of extra) {
    const bounds = projectEdgeBounds(edge, template.groups, placed, edges, layouts)!, layout = layouts[edge.id];
    assert.deepEqual(layout.route!.points[0], anchorPoint(bounds.source, layout.source!));
    assert.deepEqual(layout.route!.points.at(-1), anchorPoint(bounds.target, layout.target!));
    assert.deepEqual(edgeRoute(anchorPoint(bounds.source, layout.source!), layout.source!.side, anchorPoint(bounds.target, layout.target!), layout.target!.side, undefined, layout.route).label, layout.route!.label);
    for (let i = 1; i < layout.route!.points.length; i++) for (const node of placed) {
      const a = layout.route!.points[i - 1], b = layout.route!.points[i], card = { ...node.position, width: 215, height: 132 };
      const crossing = a.y === b.y ? a.y > card.y + .01 && a.y < card.y + card.height - .01 && Math.min(Math.max(a.x, b.x), card.x + card.width) > Math.max(Math.min(a.x, b.x), card.x) : a.x > card.x + .01 && a.x < card.x + card.width - .01 && Math.min(Math.max(a.y, b.y), card.y + card.height) > Math.max(Math.min(a.y, b.y), card.y);
      assert(!crossing, `Explicit edge ${edge.id} cuts through member ${node.id}`);
    }
  }
  assert.deepEqual(new Set(plan.edgeLayouts.map(item => item.edgeId)), new Set(edges.map(edge => edge.id)));
});

test('group geometry encloses internal route labels, translates stored routes and projects only coordinator outside edges', () => {
  const group: WorkflowGroup = { id: 'g', name: 'Product', nodeIds: ['a', 'b'], coordinatorNodeId: 'a', revision: 1 };
  const nodes = [ { id: 'a', position: { x: 100, y: 100 }, measured: { width: 200, height: 100 } }, { id: 'b', position: { x: 400, y: 100 }, measured: { width: 100, height: 80 } }, { id: 'outside', position: { x: 1000, y: 100 }, measured: { width: 200, height: 100 } } ];
  const internal = { id: 'internal', sourceNodeId: 'a', targetNodeId: 'b', condition: 'Internal', revision: 1 };
  const layouts = { internal: { revision: 4, source: { side: 'right' as const, offset: .5 }, target: { side: 'left' as const, offset: .5 }, route: { points: [{ x: 300, y: 150 }, { x: 300, y: 40 }, { x: 400, y: 40 }, { x: 400, y: 140 }], label: { x: 150, y: 40 } } } };
  const frame = groupBounds(group, nodes, [internal], layouts)!;
  assert.deepEqual(frame, { x: 66, y: -31, width: 458, height: 255 });
  assert.equal(groupBounds({ ...group, nodeIds: [] }, nodes), null);
  const moved = nodes.map(node => group.nodeIds.includes(node.id) ? { ...node, position: { x: node.position.x + 50, y: node.position.y - 70 } } : node);
  assert.deepEqual(groupBounds(group, moved, [internal], layouts), { ...frame, x: 116, y: -101 });
  const external = { ...internal, id: 'external', targetNodeId: 'outside' };
  assert.deepEqual(projectEdgeBounds(external, [group], nodes, [internal], layouts)!.source, frame);
  assert.deepEqual(projectEdgeBounds(internal, [group], nodes, [internal], layouts)!.source, { x: 100, y: 100, width: 200, height: 100 });
  assert.deepEqual(projectEdgeBounds({ ...external, sourceNodeId: 'b' }, [group], nodes, [internal], layouts)!.source, { x: 400, y: 100, width: 100, height: 80 });
  assert.deepEqual(projectEdgeBounds({ ...external, sourceNodeId: 'outside', targetNodeId: 'a' }, [group], nodes, [internal], layouts)!.target, frame);
});

test('empty groups use the same flat layout and isolated groups keep all real nodes', async () => {
  const nodes = ['a', 'b', 'outside'].map(id => ({ id, measured: { width: 215, height: 132 } }));
  const edges = [{ id: 'a-b', sourceNodeId: 'a', targetNodeId: 'b', condition: 'Ready', revision: 2 }];
  assert.deepEqual(await arrangeWorkflow(nodes, edges, {}, undefined, []), await arrangeWorkflow(nodes, edges));
  const group: WorkflowGroup = { id: 'g', name: 'Group', nodeIds: ['a', 'b'], coordinatorNodeId: 'a', revision: 1 };
  const plan = await arrangeWorkflow(nodes, [], {}, undefined, [group]);
  assert.deepEqual(new Set(plan.positions.map(item => item.nodeId)), new Set(['a', 'b', 'outside']));
  assert.deepEqual(plan.edgeLayouts, []);
});
