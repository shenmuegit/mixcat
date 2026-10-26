import type { ElkNode } from 'elkjs';
import type { EdgeAnchor, EdgeLayout, EdgePoint, WorkflowEdge } from '../shared/types';
import { anchorPoint, edgeLabelSize, edgeRoute } from './edge-geometry';

type LayoutNode = { id: string; measured?: { width?: number; height?: number } };

export function workflowBounds(nodes: (LayoutNode & { position: EdgePoint })[], definitions: WorkflowEdge[], layouts: Record<string, EdgeLayout>) {
  const byId = new Map(nodes.map(node => [node.id, { ...node.position, width: node.measured?.width ?? 215, height: node.measured?.height ?? 200 }]));
  const points = [...byId.values()].flatMap(node => [{ x: node.x, y: node.y }, { x: node.x + node.width, y: node.y + node.height }]);
  for (const edge of definitions) {
    const source = byId.get(edge.sourceNodeId), target = byId.get(edge.targetNodeId);
    if (!source || !target) continue;
    const layout = Object.hasOwn(layouts, edge.id) ? layouts[edge.id] : undefined;
    const a = layout?.source ?? { side: 'right' as const, offset: .5 }, b = layout?.target ?? { side: 'left' as const, offset: .5 };
    const route = edgeRoute(anchorPoint(source, a), a.side, anchorPoint(target, b), b.side, layout?.controlOffset, layout?.route);
    points.push(...(route.points ?? [route.control]));
    const label = route.label ?? route.control, width = route.label ? edgeLabelSize.width : 200;
    points.push({ x: label.x - width / 2, y: label.y - edgeLabelSize.height / 2 }, { x: label.x + width / 2, y: label.y + edgeLabelSize.height / 2 });
  }
  if (!points.length) return { x: 0, y: 0, width: 0, height: 0 };
  const x = Math.min(...points.map(point => point.x)) - 24, y = Math.min(...points.map(point => point.y)) - 24;
  return { x, y, width: Math.max(...points.map(point => point.x)) + 24 - x, height: Math.max(...points.map(point => point.y)) + 24 - y };
}

function attachment(point: EdgePoint, node: { x: number; y: number; width: number; height: number }): EdgeAnchor {
  const x = point.x - node.x, y = point.y - node.y;
  const sides = [{ side: 'left', distance: Math.abs(x), offset: y / node.height }, { side: 'right', distance: Math.abs(x - node.width), offset: y / node.height }, { side: 'top', distance: Math.abs(y), offset: x / node.width }, { side: 'bottom', distance: Math.abs(y - node.height), offset: x / node.width }] as const;
  const nearest = [...sides].sort((a, b) => a.distance - b.distance)[0];
  return { side: nearest.side, offset: Math.max(0, Math.min(1, nearest.offset)) };
}

export async function arrangeWorkflow(nodes: LayoutNode[], definitions: WorkflowEdge[], previous: Record<string, EdgeLayout> = {}, viewport = { width: 1000, height: 750 }) {
  if (!nodes.length) return { positions: [], edgeLayouts: [], bounds: { x: 0, y: 0, width: 0, height: 0 } };
  const outgoing = new Map(nodes.map(node => [node.id, [] as string[]])), incoming = new Set<string>();
  const nodeOrder = new Map(nodes.map((node, index) => [node.id, index]));
  const edges = definitions.filter(edge => outgoing.has(edge.sourceNodeId) && outgoing.has(edge.targetNodeId)).sort((a, b) => nodeOrder.get(a.sourceNodeId)! - nodeOrder.get(b.sourceNodeId)! || nodeOrder.get(a.targetNodeId)! - nodeOrder.get(b.targetNodeId)! || a.id.localeCompare(b.id));
  for (const edge of edges) { outgoing.get(edge.sourceNodeId)!.push(edge.targetNodeId); incoming.add(edge.targetNodeId); }
  const order = nodes.filter(node => !incoming.has(node.id)).map(node => node.id), seen = new Set(order);
  for (let cursor = 0; cursor < order.length || seen.size < nodes.length; cursor++) {
    if (cursor === order.length) { const node = nodes.find(node => !seen.has(node.id))!; seen.add(node.id); order.push(node.id); }
    for (const id of outgoing.get(order[cursor])!) if (!seen.has(id)) { seen.add(id); order.push(id); }
  }
  const ids = new Map(order.map((id, index) => [id, `node:${index}`]));
  const graph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.edgeRouting': 'ORTHOGONAL',
      'elk.layered.cycleBreaking.strategy': 'MODEL_ORDER', 'elk.layered.wrapping.strategy': 'MULTI_EDGE',
      'elk.spacing.nodeNode': '48', 'elk.layered.spacing.nodeNodeBetweenLayers': '28',
      'elk.spacing.edgeNode': '16', 'elk.spacing.edgeEdge': '16', 'elk.layered.spacing.edgeEdgeBetweenLayers': '16',
      'elk.layered.wrapping.additionalEdgeSpacing': '8', 'elk.layered.mergeEdges': 'false',
      'elk.layered.edgeLabels.centerLabelPlacementStrategy': 'TAIL_LAYER',
    },
    children: order.map((id, index) => {
      const node = nodes.find(node => node.id === id)!;
      return { id: ids.get(id)!, width: node.measured?.width ?? 215, height: node.measured?.height ?? 200,
        layoutOptions: { 'elk.portConstraints': 'FREE', ...(index === 0 ? { 'elk.layered.layering.layerConstraint': 'FIRST' } : {}) },
        ports: edges.flatMap((edge, i) => [...(edge.sourceNodeId === id ? [{ id: `port:${i}:out`, width: 0, height: 0 }] : []), ...(edge.targetNodeId === id ? [{ id: `port:${i}:in`, width: 0, height: 0 }] : [])]),
      };
    }),
    edges: edges.map((edge, index) => ({ id: `edge:${index}`, sources: [`port:${index}:out`], targets: [`port:${index}:in`], labels: [{ id: `label:${index}`, text: edge.condition, ...edgeLabelSize }] })),
  };
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  const elk = new ELK();
  const routed = (graph: ElkNode) => graph.edges?.every(edge => edge.sections?.length === 1 && edge.labels?.every(label => Number.isFinite(label.x) && Number.isFinite(label.y)));
  let result: ElkNode | undefined, best = -Infinity;
  const ratio = Math.max(.7, viewport.width / Math.max(1, viewport.height));
  for (const aspect of [ratio, ratio * 1.5]) {
    const candidate = await elk.layout({ ...structuredClone(graph), layoutOptions: { ...graph.layoutOptions, 'elk.aspectRatio': String(aspect) } });
    if (!routed(candidate)) continue;
    const score = Math.min(viewport.width / candidate.width!, viewport.height / candidate.height!);
    if (score > best) { best = score; result = candidate; }
  }
  // shortcut: dense wrap failures use a wider complete layout; revisit packing for larger cyclic diagrams.
  if (!result) result = await elk.layout({ ...structuredClone(graph), layoutOptions: { ...graph.layoutOptions, 'elk.layered.wrapping.strategy': 'OFF' } });
  if (!result?.children || !result.edges || !routed(result) || !Number.isFinite(result.width) || !Number.isFinite(result.height)) throw new Error('工作流布局未能生成有效坐标。');
  const placed = new Map(result.children.map(node => [node.id, { x: node.x!, y: node.y!, width: node.width!, height: node.height! }]));
  const positions = nodes.map(node => { const position = placed.get(ids.get(node.id)!)!; return { nodeId: node.id, position: { x: position.x, y: position.y } }; });
  const edgeLayouts = edges.map((edge, index) => {
    const route = result!.edges!.find(item => item.id === `edge:${index}`)!, section = route.sections?.[0], label = route.labels?.[0];
    if (!section || !label || !Number.isFinite(label.x) || !Number.isFinite(label.y)) throw new Error('工作流连线未能生成有效走线。');
    const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
    return { edgeId: edge.id, edgeRevision: edge.revision, layout: {
      revision: Object.hasOwn(previous, edge.id) ? previous[edge.id].revision : 0,
      source: attachment(points[0], placed.get(ids.get(edge.sourceNodeId)!)!), target: attachment(points.at(-1)!, placed.get(ids.get(edge.targetNodeId)!)!),
      route: { points, label: { x: label.x! + edgeLabelSize.width / 2, y: label.y! + edgeLabelSize.height / 2 } },
    } satisfies EdgeLayout };
  });
  return { positions, edgeLayouts, bounds: workflowBounds(nodes.map(node => ({ ...node, position: positions.find(item => item.nodeId === node.id)!.position })), definitions, Object.fromEntries(edgeLayouts.map(item => [item.edgeId, item.layout]))) };
}
