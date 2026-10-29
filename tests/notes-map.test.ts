import assert from 'node:assert/strict';
import test from 'node:test';
import { layoutNotes, noteSubtree, noteMoveTarget } from '../src/renderer/notes-map.js';
import type { Note } from '../src/shared/notes.js';

const note = (id: string, parentId: string | null = null, order = 0): Note => ({ id, parentId, order, title: id, body: '', relatedIds: [], revision: 1, createdAt: '', updatedAt: '' });

test('note map keeps a selected hierarchy visible with two-sided branches and collapses descendants', () => {
  const notes = [note('root'), note('first', 'root'), note('second', 'root', 1), note('leaf', 'first'), note('other', null, 1)];
  const graph = layoutNotes(notes, new Set());
  assert.deepEqual(graph.map(item => item.id).sort(), ['first', 'leaf', 'other', 'root', 'second']);
  const byId = new Map(graph.map(item => [item.id, item]));
  assert(byId.get('first')!.position.x > byId.get('root')!.position.x);
  assert(byId.get('second')!.position.x < byId.get('root')!.position.x);
  assert.equal(byId.get('leaf')!.color, byId.get('first')!.color);
  assert.deepEqual(layoutNotes(notes, new Set(['first'])).map(item => item.id).sort(), ['first', 'other', 'root', 'second']);
  assert.deepEqual([...noteSubtree(notes, 'first')].sort(), ['first', 'leaf']);
});

test('dragging a branch never proposes itself or a descendant as its new parent', () => {
  const notes = [note('root'), note('child', 'root'), note('leaf', 'child'), note('target')];
  const points = new Map([['root', { x: 0, y: 0 }], ['child', { x: 300, y: 0 }], ['leaf', { x: 600, y: 0 }], ['target', { x: 320, y: 180 }]]);
  assert.equal(noteMoveTarget(notes, 'child', { x: 590, y: 0 }, points), null);
  assert.equal(noteMoveTarget(notes, 'child', { x: 320, y: 175 }, points), 'target');
  assert.equal(noteMoveTarget(notes, 'child', { x: 800, y: 800 }, points), null);
});
