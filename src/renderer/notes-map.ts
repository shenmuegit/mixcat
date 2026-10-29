import type { Note } from '../shared/notes';
import type { Node } from '@xyflow/react';

export interface NoteMoveGuide { childId: string; parentId: string; side: 'left' | 'right' }

export interface NoteMapItem {
  id: string; parentId: string | null; position: { x: number; y: number };
  side: 'left' | 'right'; kind: 'central' | 'main' | 'sub'; color: string; descendants: number;
}
const colors = ['#dc655d', '#d99b42', '#3b9b81', '#6385cf', '#a070b6', '#4c9cac'];

export function noteSubtree(notes: Note[], id: string): Set<string> {
  const ids = new Set([id]);
  const children = new Map<string, string[]>();
  for (const note of notes) if (note.parentId) children.set(note.parentId, [...(children.get(note.parentId) ?? []), note.id]);
  for (const current of ids) for (const child of children.get(current) ?? []) ids.add(child);
  return ids;
}

export function layoutNotes(notes: Note[], collapsed: Set<string>): NoteMapItem[] {
  const active = notes.filter(note => !note.deletedAt), byId = new Map(active.map(note => [note.id, note]));
  const children = new Map<string | null, Note[]>();
  for (const note of [...active].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))) {
    const parent = note.parentId && byId.has(note.parentId) ? note.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), note]);
  }
  const heights = new Map<string, number>();
  const measure = (id: string): number => {
    if (heights.has(id)) return heights.get(id)!;
    heights.set(id, 72);
    const branches = collapsed.has(id) ? [] : children.get(id) ?? [];
    const height = Math.max(72, branches.reduce((sum, child) => sum + measure(child.id), 0));
    heights.set(id, height); return height;
  };
  const graph: NoteMapItem[] = [], placed = new Set<string>();
  function branch(note: Note, x: number, y: number, side: 'left' | 'right', color: string, depth: number) {
    if (placed.has(note.id)) return;
    placed.add(note.id);
    graph.push({ id: note.id, parentId: note.parentId, position: { x, y }, side, color, kind: depth === 0 ? 'central' : depth === 1 ? 'main' : 'sub', descendants: noteSubtree(active, note.id).size - 1 });
    if (collapsed.has(note.id)) return;
    const descendants = children.get(note.id) ?? [], height = descendants.reduce((sum, child) => sum + measure(child.id), 0);
    let top = y - height / 2;
    for (const child of descendants) { const band = measure(child.id); branch(child, x + (side === 'right' ? 270 : -270), top + band / 2, side, color, depth + 1); top += band; }
  }
  let rootTop = 0;
  for (const root of children.get(null) ?? []) {
    const branches = collapsed.has(root.id) ? [] : children.get(root.id) ?? [];
    const sides = [branches.filter((_, i) => i % 2 === 0), branches.filter((_, i) => i % 2 === 1)];
    const height = Math.max(110, ...sides.map(side => side.reduce((sum, child) => sum + measure(child.id), 0)));
    const center = rootTop + height / 2;
    graph.push({ id: root.id, parentId: null, position: { x: 0, y: center }, side: 'right', kind: 'central', color: '#354842', descendants: noteSubtree(active, root.id).size - 1 }); placed.add(root.id);
    sides.forEach((items, sideIndex) => {
      const side = sideIndex === 0 ? 'right' : 'left';
      let top = center - items.reduce((sum, child) => sum + measure(child.id), 0) / 2;
      for (const child of items) { const band = measure(child.id); branch(child, side === 'right' ? 290 : -290, top + band / 2, side, colors[branches.indexOf(child) % colors.length], 1); top += band; }
    });
    rootTop += height + 140;
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
