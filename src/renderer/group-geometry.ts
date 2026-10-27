import type { EdgeLayout, EdgePoint, WorkflowEdge, WorkflowGroup } from '../shared/types';
import { anchorPoint, edgeLabelSize, edgeRoute, type NodeBounds } from './edge-geometry';

export type GroupLayoutNode = { id: string; position: EdgePoint; measured?: { width?: number; height?: number } };
const boundsOf = (node: GroupLayoutNode): NodeBounds => ({ ...node.position, width: node.measured?.width ?? 215, height: node.measured?.height ?? 200 });

export function groupBounds(group: WorkflowGroup, nodes: GroupLayoutNode[], definitions: WorkflowEdge[] = [], layouts: Record<string, EdgeLayout> = {}): NodeBounds | null {
  const members = new Map(nodes.filter(node => group.nodeIds.includes(node.id)).map(node => [node.id, boundsOf(node)]));
  if (!members.size) return null;
  const points = [...members.values()].flatMap(node => [{ x: node.x, y: node.y }, { x: node.x + node.width, y: node.y + node.height }]);
  for (const edge of definitions) {
    const source = members.get(edge.sourceNodeId), target = members.get(edge.targetNodeId);
    if (!source || !target) continue;
    const layout = Object.hasOwn(layouts, edge.id) ? layouts[edge.id] : undefined;
    const a = layout?.source ?? { side: 'right' as const, offset: .5 }, b = layout?.target ?? { side: 'left' as const, offset: .5 };
    const route = edgeRoute(anchorPoint(source, a), a.side, anchorPoint(target, b), b.side, layout?.controlOffset, layout?.route);
    const label = route.label ?? route.control, width = route.label ? edgeLabelSize.width : 200;
    points.push(...(route.points ?? [route.control]), { x: label.x - width / 2, y: label.y - edgeLabelSize.height / 2 }, { x: label.x + width / 2, y: label.y + edgeLabelSize.height / 2 });
  }
  const x = Math.min(...points.map(point => point.x)) - 24, y = Math.min(...points.map(point => point.y)) - 60;
  return { x, y, width: Math.max(180, Math.max(...points.map(point => point.x)) + 24 - x), height: Math.max(...points.map(point => point.y)) + 24 - y };
}

export function projectEdgeBounds(definition: WorkflowEdge, groups: WorkflowGroup[], nodes: GroupLayoutNode[], definitions: WorkflowEdge[] = [], layouts: Record<string, EdgeLayout> = {}): { source: NodeBounds; target: NodeBounds } | null {
  const source = nodes.find(node => node.id === definition.sourceNodeId), target = nodes.find(node => node.id === definition.targetNodeId);
  if (!source || !target) return null;
  const projected = (node: GroupLayoutNode, otherId: string) => {
    const group = groups.find(group => group.coordinatorNodeId === node.id && !group.nodeIds.includes(otherId));
    return group && groupBounds(group, nodes, definitions, layouts) || boundsOf(node);
  };
  return { source: projected(source, target.id), target: projected(target, source.id) };
}
