import type { Note } from '../shared/notes';
import type { Node } from '@xyflow/react';

export interface NoteMoveGuide { childId: string; parentId: string; side: 'left' | 'right' }

export interface NoteMapItem {
  id: string; parentId: string | null; position: { x: number; y: number };
  side: 'left' | 'right'; kind: 'central' | 'main' | 'sub' | 'floating'; color: string; descendants: number;
  width: number; height: number;
}
const colors = ['#dc655d', '#d99b42', '#3b9b81', '#6385cf', '#a070b6', '#4c9cac'];
const horizontalGap = 64, verticalGap = 24, margin = 8;
const topicMetrics = {
  central: { font: 22, line: 30, x: 24, y: 14, min: 100, max: 300 },
  main: { font: 16, line: 22, x: 16, y: 9, min: 64, max: 240 },
  sub: { font: 14, line: 20, x: 8, y: 5, min: 40, max: 220 },
  floating: { font: 14, line: 20, x: 12, y: 8, min: 60, max: 240 },
};

export function noteSubtree(notes: Note[], id: string): Set<string> {
  const ids = new Set([id]);
  const children = new Map<string, string[]>();
  for (const note of notes) if (note.parentId) children.set(note.parentId, [...(children.get(note.parentId) ?? []), note.id]);
  for (const current of ids) for (const child of children.get(current) ?? []) ids.add(child);
  return ids;
}

export function layoutNotes(notes: Note[], collapsed: Set<string>, measuredNodes: Node[] = []): NoteMapItem[] {
  const active = notes.filter(note => !note.deletedAt), byId = new Map(active.map(note => [note.id, note]));
  const children = new Map<string | null, Note[]>();
  for (const note of [...active].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))) {
    const parent = note.parentId && byId.has(note.parentId) ? note.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), note]);
  }
  const measured = new Map(measuredNodes.map(node => [node.id, node]));
  const topics = new Map<string, { kind: NoteMapItem['kind']; color: string; width: number; height: number }>();
  function topic(note: Note, depth: number, color: string) {
    if (topics.has(note.id)) return;
    const kind = depth === 0 ? children.get(note.id)?.length ? 'central' : 'floating' : depth === 1 ? 'main' : 'sub';
    const { font, line, x, y, min, max } = topicMetrics[kind];
    const lines = (note.title || '未命名').split(/\r?\n/).map(text => Array.from(text).reduce((width, character) => width + (character.charCodeAt(0) < 128 ? .55 : 1), 0) * font);
    const estimatedWidth = Math.ceil(Math.max(min, Math.min(max, Math.max(...lines) + x * 2 + 2)));
    const rows = Math.min(3, lines.reduce((count, length) => count + Math.max(1, Math.ceil(length / (estimatedWidth - x * 2 - 2))), 0));
    const node = measured.get(note.id);
    topics.set(note.id, { kind, color, width: node?.measured?.width ?? estimatedWidth, height: node?.measured?.height ?? rows * line + y * 2 + (kind === 'sub' ? 3 : 2) });
    (children.get(note.id) ?? []).forEach((child, index) => topic(child, depth + 1, depth === 0 ? colors[index % colors.length] : color));
  }
  for (const root of children.get(null) ?? []) topic(root, 0, '#29364b');
  type Band = { height: number; center: number; childTop: number };
  const bands = new Map<string, Band>();
  function measure(id: string): Band {
    const descendants = (collapsed.has(id) ? [] : children.get(id) ?? []).map(child => measure(child.id));
    const childrenHeight = descendants.reduce((sum, child) => sum + child.height, 0) + Math.max(0, descendants.length - 1) * verticalGap;
    const last = descendants.at(-1), height = topics.get(id)!.height;
    const center = last ? (descendants[0].center + childrenHeight - last.height + last.center) / 2 : height / 2;
    const top = Math.min(0, center - height / 2);
    const band = { height: Math.max(childrenHeight, center + height / 2) - top, center: center - top, childTop: -top };
    bands.set(id, band); return band;
  }
  function group(items: Note[]) {
    let height = 0, first = 0, last = 0;
    items.forEach((item, index) => { const band = bands.get(item.id)!; last = height + band.center; if (!index) first = last; height += band.height + verticalGap; });
    return { height: Math.max(0, height - verticalGap), center: (first + last) / 2 };
  }
  const graph: NoteMapItem[] = [], placed = new Set<string>();
  function branch(note: Note, parent: NoteMapItem, top: number, side: 'left' | 'right') {
    if (placed.has(note.id)) return;
    placed.add(note.id);
    const size = topics.get(note.id)!, band = bands.get(note.id)!;
    const item = { id: note.id, parentId: note.parentId, position: { x: side === 'right' ? parent.position.x + parent.width + horizontalGap : parent.position.x - horizontalGap - size.width, y: top + band.center - size.height / 2 }, side, ...size, descendants: noteSubtree(active, note.id).size - 1 };
    graph.push(item);
    if (collapsed.has(note.id)) return;
    let childTop = top + band.childTop;
    for (const child of children.get(note.id) ?? []) { branch(child, item, childTop, side); childTop += bands.get(child.id)!.height + verticalGap; }
  }
  let rootTop = margin;
  for (const root of children.get(null) ?? []) {
    const branches = collapsed.has(root.id) ? [] : children.get(root.id) ?? [];
    for (const child of branches) measure(child.id);
    let rightCount = branches.length <= 1 ? branches.length : 1, difference = Infinity;
    for (let count = 1; count < branches.length; count++) {
      const next = Math.abs(group(branches.slice(0, count)).height - group(branches.slice(count)).height), preferred = Math.ceil(branches.length / 2);
      if (next < difference || next === difference && Math.abs(count - preferred) < Math.abs(rightCount - preferred)) { rightCount = count; difference = next; }
    }
    const start = graph.length, size = topics.get(root.id)!;
    const item: NoteMapItem = { id: root.id, parentId: null, position: { x: 0, y: -size.height / 2 }, side: 'right', ...size, descendants: noteSubtree(active, root.id).size - 1 };
    graph.push(item); placed.add(root.id);
    [branches.slice(0, rightCount), branches.slice(rightCount).reverse()].forEach((items, index) => {
      let top = -group(items).center;
      for (const child of items) { branch(child, item, top, index === 0 ? 'right' : 'left'); top += bands.get(child.id)!.height + verticalGap; }
    });
    const tree = graph.slice(start), left = Math.min(...tree.map(node => node.position.x)), top = Math.min(...tree.map(node => node.position.y)), bottom = Math.max(...tree.map(node => node.position.y + node.height));
    for (const node of tree) node.position = { x: node.position.x + margin - left, y: node.position.y + rootTop - top };
    rootTop += bottom - top + verticalGap;
  }
  return graph;
}

export function noteMoveTarget(notes: Note[], dragged: Node, nodes: Node[], zoom: number): NoteMoveGuide | null {
  const active = notes.filter(note => !note.deletedAt), note = active.find(note => note.id === dragged.id);
  if (!note) return null;
  const available = new Set(active.map(note => note.id)), excluded = noteSubtree(active, dragged.id);
  const size = (node: Node) => ({ width: node.measured?.width ?? node.width ?? node.initialWidth ?? 160, height: node.measured?.height ?? node.height ?? node.initialHeight ?? 40 });
  const currentSize = size(dragged);
  let nearest: NoteMoveGuide | null = null, distance = 90;
  for (const candidate of nodes) {
    if (candidate.hidden || !available.has(candidate.id) || excluded.has(candidate.id) || candidate.id === note.parentId) continue;
    const candidateSize = size(candidate);
    const side = dragged.position.x + currentSize.width / 2 < candidate.position.x + candidateSize.width / 2 ? 'left' : 'right';
    const horizontalGap = side === 'left' ? Math.max(candidate.position.x - dragged.position.x - currentSize.width, 0) : Math.max(dragged.position.x - candidate.position.x - candidateSize.width, 0);
    const verticalOffset = Math.abs(dragged.position.y + currentSize.height / 2 - candidate.position.y - candidateSize.height / 2);
    const proximity = Math.hypot(horizontalGap, verticalOffset) * zoom;
    if (proximity <= distance) { nearest = { childId: dragged.id, parentId: candidate.id, side }; distance = proximity; }
  }
  return nearest;
}
