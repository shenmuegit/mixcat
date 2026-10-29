import assert from 'node:assert/strict';
import test from 'node:test';
import { layoutNotes, noteSubtree, noteMoveTarget } from '../src/renderer/notes-map.js';
import type { Note } from '../src/shared/notes.js';
import type { Node } from '@xyflow/react';

const note = (id: string, parentId: string | null = null, order = 0): Note => ({ id, parentId, order, title: id, body: '', relatedIds: [], revision: 1, createdAt: '', updatedAt: '' });
const flowNode = (id: string, x: number, y: number, width = 160, height = 40): Node => ({ id, data: {}, position: { x, y }, measured: { width, height } });

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
  const nodes = [flowNode('root', 0, 0), flowNode('child', 300, 0), flowNode('leaf', 600, 0), flowNode('target', 320, 180)];
  assert.equal(noteMoveTarget(notes, flowNode('child', 590, 0), nodes, 1), null);
  assert.deepEqual(noteMoveTarget(notes, flowNode('child', 320, 175), nodes, 1), { childId: 'child', parentId: 'target', side: 'right' });
  assert.equal(noteMoveTarget(notes, flowNode('child', 800, 800), nodes, 1), null);
});

test('the current parent does not steal a nearby reparent target', () => {
  const notes = [note('root'), note('child', 'root'), note('target')];
  const nodes = [flowNode('root', 0, 0), flowNode('child', 300, 0), flowNode('target', 80, 0)];
  assert.deepEqual(noteMoveTarget(notes, flowNode('child', 20, 0), nodes, 1), { childId: 'child', parentId: 'target', side: 'left' });
});

test('a long target can be reached at its visible edge rather than its top left', () => {
  const notes = [note('child'), note('target')];
  const nodes = [flowNode('child', 700, 0, 100), flowNode('target', 0, 0, 300)];
  assert.deepEqual(noteMoveTarget(notes, flowNode('child', 350, 0, 100), nodes, 1), { childId: 'child', parentId: 'target', side: 'right' });
});

test('reparent proximity uses screen pixels and vertical centers at different zoom levels', () => {
  const notes = [note('child'), note('target')], target = flowNode('target', 0, 0, 300, 80);
  assert.deepEqual(noteMoveTarget(notes, flowNode('child', 380, 100, 100), [target], .5), { childId: 'child', parentId: 'target', side: 'right' });
  assert.equal(noteMoveTarget(notes, flowNode('child', 380, 100, 100), [target], 1), null);
  assert.deepEqual(noteMoveTarget(notes, flowNode('child', -150, 20, 100), [target], 1), { childId: 'child', parentId: 'target', side: 'left' });
});

test('the 90 screen-pixel boundary is inclusive and shrinks in canvas space when zoomed in', () => {
  const notes = [note('child'), note('target')], target = flowNode('target', 0, 0, 300);
  assert.deepEqual(noteMoveTarget(notes, flowNode('child', 390, 0, 100), [target], 1), { childId: 'child', parentId: 'target', side: 'right' });
  assert.equal(noteMoveTarget(notes, flowNode('child', 390.01, 0, 100), [target], 1), null);
  assert.deepEqual(noteMoveTarget(notes, flowNode('child', 345, 0, 100), [target], 2), { childId: 'child', parentId: 'target', side: 'right' });
  assert.equal(noteMoveTarget(notes, flowNode('child', 345.01, 0, 100), [target], 2), null);
});

test('hidden, deleted, unrelated and descendant nodes cannot replace a valid visible target', () => {
  const deleted = { ...note('deleted'), deletedAt: 'removed' };
  const notes = [note('root'), note('child', 'root'), note('leaf', 'child'), note('target'), note('hidden'), deleted];
  const nodes = [flowNode('target', 0, 50), flowNode('root', 0, 0), flowNode('child', 0, 0), flowNode('leaf', 0, 0), { ...flowNode('hidden', 0, 0), hidden: true }, flowNode('deleted', 0, 0), flowNode('not-in-book', 0, 0)];
  assert.deepEqual(noteMoveTarget(notes, flowNode('child', 0, 0), nodes, 1), { childId: 'child', parentId: 'target', side: 'right' });
  assert.equal(noteMoveTarget(notes, flowNode('deleted', 0, 0), nodes, 1), null);
});

test('measured dimensions win over estimates and unmeasured nodes use available width and height', () => {
  const notes = [note('child'), note('target')], dragged = flowNode('child', 350, 0, 100);
  assert.deepEqual(noteMoveTarget(notes, dragged, [{ ...flowNode('target', 0, 0, 300), width: 10 }], 1), { childId: 'child', parentId: 'target', side: 'right' });
  assert.deepEqual(noteMoveTarget(notes, dragged, [{ id: 'target', data: {}, position: { x: 0, y: 0 }, width: 300, height: 40 }], 1), { childId: 'child', parentId: 'target', side: 'right' });
});
