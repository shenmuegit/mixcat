import { createWebProductTemplate } from '../src/core/web-product.js';
import type { WorkflowEngine } from '../src/core/engine.js';

export function groupedCycleFixture() {
  const nodes = createWebProductTemplate().nodes.filter(node => node.id !== 'design-test');
  const pairs = [['requirements', 'architect'], ['backend', 'frontend'], ['frontend', 'test'], ['test', 'backend'], ['architect', 'backend'], ['architect', 'frontend'], ['backend', 'architect'], ['frontend', 'architect']];
  return { nodes, edges: pairs.map(([sourceNodeId, targetNodeId]) => ({ id: `${sourceNodeId}-${targetNodeId}`, sourceNodeId, targetNodeId, condition: 'Existing workflow connection', revision: 1 })),
    groups: [{ id: 'definition', name: '产品定义', nodeIds: ['product', 'requirements', 'design'], coordinatorNodeId: 'product', revision: 1 }], viewport: { width: 800, height: 800 } };
}

export async function configureGroupedCycle(engine: WorkflowEngine, projectId: string) {
  const data = groupedCycleFixture();
  const snapshot = (await engine.command({ type: 'snapshot', projectId })).snapshot.selected!;
  for (const node of snapshot.nodes) await engine.command({ type: 'delete_node', projectId, nodeId: node.id });
  for (const node of data.nodes) await engine.command({ type: 'save_node', projectId, node: { ...node, revision: 0 } });
  for (const edge of data.edges) await engine.command({ type: 'save_edge', projectId, edge: { ...edge, revision: 0 } });
  await engine.command({ type: 'save_group', projectId, group: { ...data.groups[0], revision: 0 } });
  return data;
}
