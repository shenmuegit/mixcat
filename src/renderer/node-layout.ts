import type { WorkflowEdge } from '../shared/types';

export function arrangeNodes(nodes: { id: string; measured?: { width?: number; height?: number } }[], edges: Pick<WorkflowEdge, 'sourceNodeId' | 'targetNodeId'>[]) {
  const outgoing = new Map(nodes.map(node => [node.id, [] as string[]])), incoming = new Set<string>();
  for (const edge of edges) if (outgoing.has(edge.sourceNodeId) && outgoing.has(edge.targetNodeId)) {
    outgoing.get(edge.sourceNodeId)!.push(edge.targetNodeId); incoming.add(edge.targetNodeId);
  }
  const levels = new Map<string, number>(), queue = nodes.filter(node => !incoming.has(node.id)).map(node => node.id);
  for (const id of queue) levels.set(id, 0);
  for (let cursor = 0; cursor < queue.length || levels.size < nodes.length; cursor++) {
    if (cursor === queue.length) { const node = nodes.find(node => !levels.has(node.id))!; levels.set(node.id, 0); queue.push(node.id); }
    const id = queue[cursor];
    for (const target of outgoing.get(id)!) if (!levels.has(target)) { levels.set(target, levels.get(id)! + 1); queue.push(target); }
  }
  const widths: number[] = [];
  for (const node of nodes) { const column = levels.get(node.id)!; widths[column] = Math.max(widths[column] ?? 0, node.measured?.width ?? 215); }
  let x = 70;
  const columns = widths.map(width => { const position = x; x += width + 100; return position; });
  const rows = widths.map(() => 80);
  return nodes.map(node => {
    const column = levels.get(node.id)!, position = { x: columns[column], y: rows[column] };
    rows[column] += (node.measured?.height ?? 200) + 64;
    return { nodeId: node.id, position };
  });
}
