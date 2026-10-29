import assert from 'node:assert/strict';
import test from 'node:test';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WorkflowEngine } from '../src/core/engine.js';
import { projectDirectory } from '../src/core/paths.js';
import type { NoteMutation } from '../src/shared/notes.js';

async function notesFixture(t: { after(fn: () => Promise<void>): void }) {
  const root = mkdtempSync(join(projectDirectory(resolve('.'), '.runtime', 'implementation', 'notes-fixtures'), 'notes-'));
  const engine = new WorkflowEngine({ workbenchRoot: root, executable: 'unused', nativeFactory() { assert.fail('Notes must not start a native Agent'); } });
  await engine.init(); t.after(() => engine.close());
  const get = async () => (await engine.command({ type: 'get_notes' })).notes!;
  let sequence = 0;
  const mutate = async (input: Omit<NoteMutation, 'expected_revision' | 'request_id'>) => engine.command({ type: 'update_note', input: { ...input, expected_revision: (await get()).revision, request_id: `request-${++sequence}` } });
  return { root, engine, get, mutate };
}

test('notes can be created without a project, edited and reopened with the same identity', async t => {
  const root = mkdtempSync(join(projectDirectory(resolve('.'), '.runtime', 'implementation', 'notes-fixtures'), 'notes-'));
  const open = async () => {
    const engine = new WorkflowEngine({ workbenchRoot: root, executable: 'unused', nativeFactory() { assert.fail('Notes must not start a native Agent'); } });
    await engine.init(); t.after(() => engine.close()); return engine;
  };
  const engine = await open();
  const empty = await engine.command({ type: 'get_notes' });
  assert.deepEqual(empty.notes, { revision: 0, notes: [] });
  assert.equal(empty.snapshot.selected, null);
  const created = await engine.command({ type: 'update_note', input: { request_id: 'create-note', operation: 'create', expected_revision: 0, title: '独立笔记', body: '# 原文\r\n\r\n中文内容' } });
  assert(created.noteId);
  const edited = await engine.command({ type: 'update_note', input: { request_id: 'edit-note', operation: 'edit', expected_revision: created.notes!.revision, id: created.noteId, title: '改名笔记', body: '# 修改后\r\n\r\n保留换行' } });
  assert.equal(edited.notes!.notes[0].id, created.noteId);
  assert.equal(edited.notes!.notes[0].title, '改名笔记');
  await engine.close();
  const reopened = await open();
  assert.deepEqual((await reopened.command({ type: 'get_notes' })).notes, edited.notes);
});

test('note hierarchy supports sibling ordering and reparenting and rejects cycles atomically', async t => {
  const f = await notesFixture(t);
  const a = (await f.mutate({ operation: 'create', title: 'A' })).noteId!;
  const b = (await f.mutate({ operation: 'create', title: 'B' })).noteId!;
  const first = (await f.mutate({ operation: 'create', title: 'First', parentId: a })).noteId!;
  const second = (await f.mutate({ operation: 'create', title: 'Second', parentId: a })).noteId!;
  const child = (await f.mutate({ operation: 'create', title: 'Grandchild', parentId: first })).noteId!;
  await f.mutate({ operation: 'move', id: b, parentId: null, beforeId: a });
  await f.mutate({ operation: 'move', id: second, parentId: a, beforeId: first });
  let state = await f.get();
  const titles = (parentId: string | null) => state.notes.filter(note => note.parentId === parentId).sort((x, y) => x.order - y.order).map(note => note.title);
  assert.deepEqual(titles(null), ['B', 'A']);
  assert.deepEqual(titles(a), ['Second', 'First']);
  await f.mutate({ operation: 'move', id: first, parentId: b });
  state = await f.get();
  assert.deepEqual(titles(a), ['Second']);
  assert.deepEqual(titles(b), ['First']);
  assert.equal(state.notes.find(note => note.id === child)!.parentId, first);
  await assert.rejects(f.mutate({ operation: 'move', id: b, parentId: child }), /循环|后代/);
  await assert.rejects(f.mutate({ operation: 'move', id: a, parentId: a }), /自身|循环/);
  await assert.rejects(f.mutate({ operation: 'move', id: a, parentId: null, beforeId: child }), /同级/);
  await assert.rejects(f.mutate({ operation: 'create', parentId: 'missing' }), /父笔记/);
  assert.deepEqual(await f.get(), state);
});

test('note associations are symmetric, deduplicated and explicitly removable', async t => {
  const f = await notesFixture(t);
  const a = (await f.mutate({ operation: 'create', title: 'A' })).noteId!;
  const b = (await f.mutate({ operation: 'create', title: 'B' })).noteId!;
  await f.mutate({ operation: 'associate', id: a, targetId: b, linked: true });
  await f.mutate({ operation: 'associate', id: b, targetId: a, linked: true });
  const state = await f.get();
  assert.deepEqual(state.notes.find(note => note.id === a)!.relatedIds, [b]);
  assert.deepEqual(state.notes.find(note => note.id === b)!.relatedIds, [a]);
  await assert.rejects(f.mutate({ operation: 'associate', id: a, targetId: a, linked: true }), /自身/);
  await assert.rejects(f.mutate({ operation: 'associate', id: a, targetId: 'missing', linked: true }), /关联目标/);
  assert.deepEqual(await f.get(), state);
  await f.mutate({ operation: 'associate', id: b, targetId: a, linked: false });
  assert((await f.get()).notes.every(note => note.relatedIds.length === 0));
});

test('recycling a note preserves its subtree and relationships and restores only the selected deletion group', async t => {
  const f = await notesFixture(t);
  const root = (await f.mutate({ operation: 'create', title: 'Root' })).noteId!;
  const first = (await f.mutate({ operation: 'create', title: 'First', parentId: root })).noteId!;
  const priorDeleted = (await f.mutate({ operation: 'create', title: 'Previously deleted', parentId: first })).noteId!;
  const sibling = (await f.mutate({ operation: 'create', title: 'Sibling', parentId: root })).noteId!;
  const other = (await f.mutate({ operation: 'create', title: 'Other' })).noteId!;
  await f.mutate({ operation: 'associate', id: first, targetId: other, linked: true });
  await f.mutate({ operation: 'associate', id: sibling, targetId: other, linked: true });
  await f.mutate({ operation: 'delete', id: priorDeleted });
  const firstDeletion = (await f.get()).notes.find(note => note.id === priorDeleted)!.deletedAt;
  await f.mutate({ operation: 'delete', id: root });
  let state = await f.get();
  assert(state.notes.filter(note => note.id !== other).every(note => note.deletedAt));
  assert.deepEqual(state.notes.find(note => note.id === other)!.relatedIds.sort(), [first, sibling].sort());
  await assert.rejects(f.mutate({ operation: 'edit', id: first, body: 'must not write' }), /已删除/);
  await assert.rejects(f.mutate({ operation: 'associate', id: other, targetId: first, linked: true }), /已删除/);
  assert.deepEqual(await f.get(), state);
  await f.mutate({ operation: 'associate', id: other, targetId: sibling, linked: false });
  assert.deepEqual((await f.get()).notes.find(note => note.id === other)!.relatedIds, [first]);
  await f.mutate({ operation: 'restore', id: first });
  state = await f.get();
  assert.equal(state.notes.find(note => note.id === root)!.deletedAt, undefined);
  assert.equal(state.notes.find(note => note.id === first)!.deletedAt, undefined);
  assert(state.notes.find(note => note.id === sibling)!.deletedAt, 'restoring a child must not restore an unrelated sibling');
  assert.equal(state.notes.find(note => note.id === priorDeleted)!.deletedAt, firstDeletion);
  assert.deepEqual(state.notes.find(note => note.id === first)!.relatedIds, [other]);
  await f.mutate({ operation: 'restore', id: sibling });
  await f.mutate({ operation: 'restore', id: priorDeleted });
  assert((await f.get()).notes.every(note => !note.deletedAt));
});

test('note mutations reject stale versions and invalid fields without changing saved notes', async t => {
  const f = await notesFixture(t);
  const note = (await f.mutate({ operation: 'create', title: 'Saved', body: 'Keep this' })).noteId!;
  const initial = await f.get();
  await assert.rejects(f.engine.command({ type: 'update_note', input: { request_id: 'stale', operation: 'edit', expected_revision: 0, id: note, body: 'Stale body' } }), /版本已变化/);
  const invalid: unknown[] = [
    { operation: 'create', title: ' ', body: '' },
    { operation: 'create', title: 'Unexpected field', parentId: null, linked: true },
    { operation: 'create', title: 'Null body', body: null },
    { operation: 'create', title: 'Huge body', body: 'x'.repeat(262145) },
    { operation: 'create', title: 'Embedded NUL', body: 'a\0b' },
    { operation: 'edit', id: note, parentId: null, body: 'Wrong operation' },
    { operation: 'edit', id: note },
    { operation: 'move', id: note, parentId: 9 },
    { operation: 'associate', id: note, targetId: note, linked: 'yes' },
    { operation: 'delete', id: note, body: 'Ignored body' },
    { operation: 'restore', id: note },
  ];
  for (const [index, input] of invalid.entries()) await assert.rejects(f.engine.command({ type: 'update_note', input: { ...(input as NoteMutation), expected_revision: initial.revision, request_id: `invalid-${index}` } }));
  assert.deepEqual(await f.get(), initial);
});

test('note receipts survive restart and stale create replay returns the same identity and current content', async t => {
  const f = await notesFixture(t);
  const create: NoteMutation = { request_id: 'durable-create', operation: 'create', expected_revision: 0, title: 'Initial', body: '' };
  const first = await f.engine.command({ type: 'update_note', input: create });
  await f.mutate({ operation: 'edit', id: first.noteId, title: 'Current', body: 'Latest content' });
  await f.engine.close();
  const second = new WorkflowEngine({ workbenchRoot: f.root, executable: 'unused', nativeFactory() { assert.fail(); } });
  await second.init(); t.after(() => second.close());
  const replay = await second.command({ type: 'update_note', input: create });
  assert.equal(replay.noteId, first.noteId);
  assert.equal(replay.notes!.notes.length, 1);
  assert.equal(replay.notes!.notes[0].title, 'Current');
  assert.equal(replay.notes!.notes[0].body, 'Latest content');
  await assert.rejects(second.command({ type: 'update_note', input: { ...create, title: 'Different request' } }), /同一笔记请求编号/);
  assert.deepEqual((await second.command({ type: 'get_notes' })).notes, replay.notes);
});

test('failed note receipt persistence rolls back content and permits the same request to succeed once', async t => {
  const f = await notesFixture(t);
  const id = (await f.mutate({ operation: 'create', title: 'Before', body: 'Saved body' })).noteId!;
  const before = await f.get();
  const fault = new DatabaseSync(join(f.root, '.mixcat', 'notes', 'notes.sqlite'));
  t.after(async () => fault.close());
  fault.exec("CREATE TRIGGER reject_note_receipt BEFORE INSERT ON note_receipts BEGIN SELECT RAISE(FAIL, 'injected note receipt failure'); END");
  const command = { type: 'update_note' as const, input: { request_id: 'retry-after-rollback', expected_revision: before.revision, operation: 'edit' as const, id, title: 'After', body: 'New saved body' } };
  await assert.rejects(f.engine.command(command), /injected note receipt failure/);
  assert.deepEqual(await f.get(), before);
  fault.exec('DROP TRIGGER reject_note_receipt');
  const saved = await f.engine.command(command);
  assert.equal(saved.notes!.notes[0].body, 'New saved body');
  const replay = await f.engine.command(command);
  assert.deepEqual(replay.notes, saved.notes);
});

test('notes refuse a hardlinked database without changing its target', async t => {
  const f = await notesFixture(t);
  const notes = join(f.root, '.mixcat', 'notes');
  mkdirSync(notes, { recursive: true });
  const target = join(f.root, 'protected-file');
  writeFileSync(target, 'Protected bytes');
  linkSync(target, join(notes, 'notes.sqlite'));
  await assert.rejects(f.engine.command({ type: 'get_notes' }), /无链接/);
  assert.equal(readFileSync(target, 'utf8'), 'Protected bytes');
});
