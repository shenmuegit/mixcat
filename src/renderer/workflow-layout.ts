import type { ElkNode } from 'elkjs';
import type { EdgeAnchor, EdgeLayout, EdgePoint, WorkflowEdge, WorkflowGroup } from '../shared/types';
import { anchorPoint, edgeLabelSize, edgeRoute, type NodeBounds } from './edge-geometry';
import { groupBounds, projectEdgeBounds } from './group-geometry';

type LayoutNode = { id: string; measured?: { width?: number; height?: number } };

export function workflowBounds(nodes: (LayoutNode & { position: EdgePoint })[], definitions: WorkflowEdge[], layouts: Record<string, EdgeLayout>, groups: WorkflowGroup[] = []) {
  const byId = new Map(nodes.map(node => [node.id, { ...node.position, width: node.measured?.width ?? 215, height: node.measured?.height ?? 200 }]));
  const points = [...byId.values()].flatMap(node => [{ x: node.x, y: node.y }, { x: node.x + node.width, y: node.y + node.height }]);
  for (const group of groups) {
    const bounds = groupBounds(group, nodes, definitions, layouts);
    if (bounds) points.push({ x: bounds.x, y: bounds.y }, { x: bounds.x + bounds.width, y: bounds.y + bounds.height });
  }
  for (const edge of definitions) {
    const projected = groups.length ? projectEdgeBounds(edge, groups, nodes, definitions, layouts) : null;
    const source = projected?.source ?? byId.get(edge.sourceNodeId), target = projected?.target ?? byId.get(edge.targetNodeId);
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

function memberConnector(start: EdgePoint, anchor: EdgeAnchor, boundary: EdgePoint, obstacles: NodeBounds[]): EdgePoint[] {
  const stub = { x: start.x + (anchor.side === 'right' ? 8 : anchor.side === 'left' ? -8 : 0), y: start.y + (anchor.side === 'bottom' ? 8 : anchor.side === 'top' ? -8 : 0) };
  const xs = [...new Set([stub.x, boundary.x, ...obstacles.flatMap(box => [box.x, box.x + box.width])])].sort((a, b) => a - b);
  const ys = [...new Set([stub.y, boundary.y, ...obstacles.flatMap(box => [box.y, box.y + box.height])])].sort((a, b) => a - b);
  const points = ys.flatMap(y => xs.map(x => ({ x, y })));
  const valid = points.map(point => !obstacles.some(box => point.x > box.x && point.x < box.x + box.width && point.y > box.y && point.y < box.y + box.height));
  const from = ys.indexOf(stub.y) * xs.length + xs.indexOf(stub.x), to = ys.indexOf(boundary.y) * xs.length + xs.indexOf(boundary.x);
  const distance = points.map(() => Infinity), previous = points.map(() => -1), visited = new Set<number>();
  distance[from] = 0;
  while (!visited.has(to)) {
    let current = -1;
    for (let i = 0; i < points.length; i++) if (valid[i] && !visited.has(i) && (current < 0 || distance[i] < distance[current])) current = i;
    if (current < 0 || !Number.isFinite(distance[current])) throw new Error('分组连线未能连接实际成员。');
    visited.add(current);
    const a = points[current], column = current % xs.length, row = Math.floor(current / xs.length);
    const neighbors = [column ? current - 1 : -1, column + 1 < xs.length ? current + 1 : -1, row ? current - xs.length : -1, row + 1 < ys.length ? current + xs.length : -1];
    for (const next of neighbors) {
      if (next < 0 || !valid[next] || visited.has(next)) continue;
      const b = points[next];
      if (obstacles.some(box => a.y === b.y ? a.y > box.y && a.y < box.y + box.height && Math.min(Math.max(a.x, b.x), box.x + box.width) > Math.max(Math.min(a.x, b.x), box.x) : a.x > box.x && a.x < box.x + box.width && Math.min(Math.max(a.y, b.y), box.y + box.height) > Math.max(Math.min(a.y, b.y), box.y))) continue;
      const cost = distance[current] + Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
      if (cost < distance[next]) { distance[next] = cost; previous[next] = current; }
    }
  }
  const path: EdgePoint[] = [];
  for (let index = to; index >= 0; index = previous[index]) path.unshift(points[index]);
  path.unshift(start);
  return path.filter((point, index) => !index || index === path.length - 1 || !(path[index - 1].x === point.x && point.x === path[index + 1].x || path[index - 1].y === point.y && point.y === path[index + 1].y));
}

export async function arrangeWorkflow(nodes: LayoutNode[], definitions: WorkflowEdge[], previous: Record<string, EdgeLayout> = {}, viewport = { width: 1000, height: 750 }, groups: WorkflowGroup[] = []) {
  if (!groups.length || !nodes.length) return arrangeFlatWorkflow(nodes, definitions, previous, viewport);
  const units = await Promise.all(groups.map(async group => {
    const members = nodes.filter(node => group.nodeIds.includes(node.id));
    if (!members.length) return null;
    const internal = definitions.filter(edge => group.nodeIds.includes(edge.sourceNodeId) && group.nodeIds.includes(edge.targetNodeId));
    const plan = await arrangeFlatWorkflow(members, internal, previous, { width: viewport.height * .7, height: viewport.height }, 'DOWN');
    const placed = members.map(node => ({ ...node, position: plan.positions.find(item => item.nodeId === node.id)!.position }));
    return { group, plan, bounds: groupBounds(group, placed, internal, Object.fromEntries(plan.edgeLayouts.map(item => [item.edgeId, item.layout])))! };
  }));
  const active = units.filter(unit => unit !== null), membership = new Map(active.flatMap(unit => unit.group.nodeIds.map(id => [id, unit] as const)));
  const outerNodes = nodes.filter(node => !membership.has(node.id) || membership.get(node.id)!.group.coordinatorNodeId === node.id).map(node => {
    const unit = membership.get(node.id);
    return unit ? { id: node.id, measured: { width: unit.bounds.width, height: unit.bounds.height } } : node;
  });
  const outerEdges = definitions.filter(edge => !membership.has(edge.sourceNodeId) || membership.get(edge.sourceNodeId) !== membership.get(edge.targetNodeId)).map(edge => ({ ...edge, sourceNodeId: membership.get(edge.sourceNodeId)?.group.coordinatorNodeId ?? edge.sourceNodeId, targetNodeId: membership.get(edge.targetNodeId)?.group.coordinatorNodeId ?? edge.targetNodeId }));
  const outer = await arrangeFlatWorkflow(outerNodes, outerEdges, previous, viewport);
  const shifts = new Map(active.map(unit => {
    const position = outer.positions.find(item => item.nodeId === unit.group.coordinatorNodeId)!.position;
    return [unit.group.id, { x: position.x - unit.bounds.x, y: position.y - unit.bounds.y }];
  }));
  const positions = nodes.map(node => {
    const unit = membership.get(node.id);
    if (!unit) return outer.positions.find(item => item.nodeId === node.id)!;
    const position = unit.plan.positions.find(item => item.nodeId === node.id)!.position, shift = shifts.get(unit.group.id)!;
    return { nodeId: node.id, position: { x: position.x + shift.x, y: position.y + shift.y } };
  });
  const internalLayouts = active.flatMap(unit => {
    const shift = shifts.get(unit.group.id)!, move = (point: EdgePoint) => ({ x: point.x + shift.x, y: point.y + shift.y });
    return unit.plan.edgeLayouts.map(item => ({ ...item, layout: { ...item.layout, route: { points: item.layout.route!.points.map(move), label: move(item.layout.route!.label) } } }));
  });
  const placed = nodes.map(node => ({ ...node, position: positions.find(item => item.nodeId === node.id)!.position }));
  const obstacles = new Map(active.map(unit => [unit.group.id, [
    ...placed.filter(node => unit.group.nodeIds.includes(node.id)).map(node => ({ x: node.position.x - 8, y: node.position.y - 8, width: (node.measured?.width ?? 215) + 16, height: (node.measured?.height ?? 200) + 16 })),
    ...internalLayouts.filter(item => unit.plan.edgeLayouts.some(internal => internal.edgeId === item.edgeId)).map(item => ({ x: item.layout.route!.label.x - edgeLabelSize.width / 2 - 4, y: item.layout.route!.label.y - edgeLabelSize.height / 2 - 4, width: edgeLabelSize.width + 8, height: edgeLabelSize.height + 8 })),
  ]]));
  const outerLayouts = outer.edgeLayouts.map(item => {
    const edge = definitions.find(edge => edge.id === item.edgeId)!, layout = { ...item.layout, route: { ...item.layout.route!, points: [...item.layout.route!.points] } };
    for (const end of ['source', 'target'] as const) {
      const nodeId = edge[`${end}NodeId`], unit = membership.get(nodeId);
      if (!unit || nodeId === unit.group.coordinatorNodeId) continue;
      const node = placed.find(node => node.id === nodeId)!, bounds = { ...node.position, width: node.measured?.width ?? 215, height: node.measured?.height ?? 200 };
      const anchor = { ...layout[end]!, offset: .5 }, point = anchorPoint(bounds, anchor), boundary = end === 'source' ? layout.route.points[0] : layout.route.points.at(-1)!;
      const connector = memberConnector(point, anchor, boundary, obstacles.get(unit.group.id)!);
      layout[end] = anchor;
      layout.route.points = end === 'source' ? [...connector, ...layout.route.points.slice(1)] : [...layout.route.points.slice(0, -1), ...connector.reverse()];
    }
    return { ...item, layout };
  });
  const edgeLayouts = [...outerLayouts, ...internalLayouts];
  return { positions, edgeLayouts, bounds: workflowBounds(placed, definitions, Object.fromEntries(edgeLayouts.map(item => [item.edgeId, item.layout])), groups) };
}

async function arrangeFlatWorkflow(nodes: LayoutNode[], definitions: WorkflowEdge[], previous: Record<string, EdgeLayout>, viewport: { width: number; height: number }, direction: 'RIGHT' | 'DOWN' = 'RIGHT') {
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
      'elk.algorithm': 'layered', 'elk.direction': direction, 'elk.edgeRouting': 'ORTHOGONAL',
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
  const routed = (graph: ElkNode) => graph.edges?.every(edge => {
    if (edge.sections?.length !== 1 || edge.labels?.length !== 1 || !edge.labels.every(label => Number.isFinite(label.x) && Number.isFinite(label.y))) return false;
    const section = edge.sections[0], points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
    const attached = (point: EdgePoint, port: string) => {
      const node = graph.children?.find(node => node.ports?.some(item => item.id === port));
      if (!node) return false;
      const x = point.x - node.x!, y = point.y - node.y!, width = node.width!, height = node.height!;
      return x >= -.01 && x <= width + .01 && y >= -.01 && y <= height + .01
        && (Math.abs(x) <= .01 || Math.abs(x - width) <= .01 || Math.abs(y) <= .01 || Math.abs(y - height) <= .01);
    };
    return points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))
      && points.slice(1).every((point, index) => Math.abs(point.x - points[index].x) <= .01 || Math.abs(point.y - points[index].y) <= .01)
      && attached(points[0], edge.sources[0]) && attached(points.at(-1)!, edge.targets[0]);
  });
  let result: ElkNode | undefined, best = -Infinity;
  const ratio = Math.max(.7, viewport.width / Math.max(1, viewport.height));
  for (const aspect of [ratio, ratio * 1.5]) {
    const candidate = await elk.layout({ ...structuredClone(graph), layoutOptions: { ...graph.layoutOptions, 'elk.aspectRatio': String(aspect) } });
    if (!routed(candidate)) continue;
    const score = Math.min(viewport.width / candidate.width!, viewport.height / candidate.height!);
    if (score > best) { best = score; result = candidate; }
  }
  // shortcut: invalid wrapped routes use a wider complete layout; revisit packing for larger cyclic diagrams.
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
