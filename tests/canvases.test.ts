import assert from 'node:assert/strict';
import test from 'node:test';
import { linkSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { projectDirectory } from '../src/core/paths.js';
import { CanvasStore } from '../src/core/canvases.js';

test('independent canvases persist distinct scenes, images and viewports without a project', t => {
  const root = mkdtempSync(join(projectDirectory(resolve('.'), '.runtime', 'issue-180', 'fixtures'), 'store-'));
  let store = new CanvasStore(root);
  t.after(() => store.close());
  assert.deepEqual(store.command({ operation: 'list' }).canvases, []);
  const first = store.command({ operation: 'create', requestId: 'create-first', name: '第一张' }).canvas!;
  const second = store.command({ operation: 'create', requestId: 'create-second', name: '第二张' }).canvas!;
  const scene = { elements: [{ id: 'rect', type: 'rectangle', x: 40, y: 80, width: 120, height: 60 }], appState: { scrollX: 70, scrollY: -20, zoom: { value: 1.25 }, theme: 'dark' }, files: { image: { id: 'image', mimeType: 'image/png', dataURL: 'data:image/png;base64,iVBORw0KGgo=', created: 1 } } };
  const saved = store.command({ operation: 'save', requestId: 'save-first', id: first.id, expectedRevision: first.revision, scene }).saved!;
  assert.equal(saved.revision, first.revision + 1);
  store.close(); store = new CanvasStore(root);
  assert.deepEqual(store.command({ operation: 'read', id: first.id }).canvas!.scene, scene);
  assert.deepEqual(store.command({ operation: 'read', id: second.id }).canvas!.scene.elements, []);
  assert.equal(store.command({ operation: 'list' }).canvases!.length, 2);
});

test('canvas mutations are replayable, versioned independently and reject stale changes', t => {
  const root = mkdtempSync(join(projectDirectory(resolve('.'), '.runtime', 'issue-180', 'fixtures'), 'versions-'));
  const store = new CanvasStore(root); t.after(() => store.close());
  const create = { operation: 'create' as const, requestId: 'create', name: '草图' };
  const first = store.command(create).canvas!;
  assert.deepEqual(store.command(create).canvas, first);
  assert.throws(() => store.command({ ...create, name: '别的内容' }), /编号/);
  const renamed = store.command({ operation: 'rename', requestId: 'rename', id: first.id, expectedRevision: 1, name: '新名称' }).saved!;
  assert.equal(renamed.name, '新名称'); assert.equal(renamed.revision, 2);
  assert.throws(() => store.command({ operation: 'delete', requestId: 'stale-delete', id: first.id, expectedRevision: 1 }), /版本/);
  const scene = { elements: [], appState: { theme: 'dark' }, files: {} };
  const save = { operation: 'save' as const, requestId: 'save', id: first.id, expectedRevision: 2, scene };
  const saved = store.command(save);
  assert.deepEqual(store.command(save), saved);
  assert.throws(() => store.command({ ...save, requestId: 'stale-save' }), /版本/);
  const library = { operation: 'save_library' as const, requestId: 'library', expectedRevision: 0, items: [{ id: 'library-item', status: 'unpublished', created: 1, elements: [] }] };
  assert.equal(store.command(library).libraryRevision, 1);
  assert.equal(store.command(library).libraryRevision, 1);
  assert.deepEqual(store.command({ operation: 'get_library' }).library, { revision: 1, items: library.items });
  assert.throws(() => store.command({ ...library, requestId: 'stale-library' }), /版本/);
  store.command({ operation: 'delete', requestId: 'delete', id: first.id, expectedRevision: saved.saved!.revision });
  assert.throws(() => store.command({ operation: 'read', id: first.id }), /不存在/);
});

test('canvas payload limits and library validation reject unsafe data atomically', t => {
  const root = mkdtempSync(join(projectDirectory(resolve('.'), '.runtime', 'issue-180', 'fixtures'), 'limits-'));
  const store = new CanvasStore(root); t.after(() => store.close());
  for (const items of [[null], [{ id: 'bad', elements: null }], [{ id: 'bad', status: 'other', created: 1, elements: [] }]]) assert.throws(() => store.command({ operation: 'save_library', requestId: 'invalid-library', expectedRevision: 0, items }));
  const canvas = store.command({ operation: 'create', requestId: 'create' }).canvas!;
  assert.throws(() => store.command({ operation: 'save', id: canvas.id, requestId: 'too-big', expectedRevision: 1, scene: { elements: [], files: {}, appState: { content: 'x'.repeat(64 * 1024 * 1024) } } }), /64 MiB/);
  assert.throws(() => store.command({ operation: 'save_library', requestId: 'large-library', expectedRevision: 0, items: [{ id: 'large', status: 'unpublished', created: 1, elements: [], name: 'x'.repeat(8 * 1024 * 1024) }] }), /8 MiB/);
  assert.equal(store.command({ operation: 'read', id: canvas.id }).canvas!.revision, 1);
  assert.deepEqual(store.command({ operation: 'get_library' }).library, { revision: 0, items: [] });
});

test('canvas boundary rejects malformed commands and linked files without changing stored content', t => {
  const root = mkdtempSync(join(projectDirectory(resolve('.'), '.runtime', 'issue-180', 'fixtures'), 'boundary-'));
  const store = new CanvasStore(root); t.after(() => store.close());
  const first = store.command({ operation: 'create', requestId: 'create' }).canvas!;
  for (const input of [null, { operation: 'other' }, { operation: 'read', id: '../escape' }, { operation: 'create', requestId: 'bad', name: '' }, { operation: 'list', path: 'outside' }, { operation: 'save', requestId: 'bad-save', id: first.id, expectedRevision: 1, scene: { elements: [], appState: {}, files: { bad: { dataURL: 'https://example.com/private' } } } }]) assert.throws(() => store.command(input as any));
  assert.equal(store.command({ operation: 'read', id: first.id }).canvas!.revision, 1);
  const linkedRoot = projectDirectory(root, 'linked'), directory = projectDirectory(linkedRoot, '.mixcat', 'canvases');
  const source = join(root, 'source.sqlite'); writeFileSync(source, 'not a database');
  linkSync(source, join(directory, 'canvases.sqlite'));
  assert.throws(() => new CanvasStore(linkedRoot), /链接/);
});
