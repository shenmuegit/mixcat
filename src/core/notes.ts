import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { insideProject, projectDirectory } from './paths.js';
import type { Note, NoteMutation, NotesSnapshot } from '../shared/notes.js';

const identifier = /^[A-Za-z0-9_-]{1,128}$/;

function validateMutation(input: NoteMutation) {
  const fields = { create: ['title', 'body', 'parentId', 'beforeId'], edit: ['id', 'title', 'body'], move: ['id', 'parentId', 'beforeId'], associate: ['id', 'targetId', 'linked'], delete: ['id'], restore: ['id'] };
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.request_id !== 'string' || !identifier.test(input.request_id) || !Number.isSafeInteger(input.expected_revision) || input.expected_revision < 0 || !Object.hasOwn(fields, input.operation)) throw new Error('笔记请求编号、操作或预期版本不正确。');
  const allowed = ['request_id', 'expected_revision', 'operation', ...fields[input.operation]];
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error('笔记操作含不支持的字段。');
  for (const key of ['id', 'targetId', 'parentId', 'beforeId'] as const) {
    const value = input[key];
    if (value === undefined || value === null && (key === 'parentId' || key === 'beforeId')) continue;
    if (typeof value !== 'string' || !identifier.test(value)) throw new Error('笔记标识格式不正确。');
  }
  if (input.operation !== 'create' && input.id === undefined) throw new Error('笔记操作必须指定笔记。');
  if (input.operation === 'edit' && input.title === undefined && input.body === undefined) throw new Error('请提供要修改的笔记标题或正文。');
  if (input.title !== undefined) noteText(input.title, true);
  if (input.body !== undefined) noteText(input.body);
}

function noteText(value: unknown, title = false): string {
  if (typeof value !== 'string' || value.includes('\0') || (title ? !value.trim() || value.length > 200 : Buffer.byteLength(value, 'utf8') > 262144)) throw new Error(title ? '笔记标题不能为空且不能超过 200 个字符。' : '笔记正文必须是有效文本且不能超过 256 KiB。');
  return title ? value.trim() : value;
}

function placeNote(notes: Note[], note: Note, parentId: string | null, beforeId?: string | null) {
  let parent = parentId;
  const ancestors = new Set<string>();
  while (parent !== null) {
    if (parent === note.id || ancestors.has(parent)) throw new Error('笔记不能移入自身或后代，层级不能形成循环。');
    ancestors.add(parent);
    const ancestor = notes.find(item => item.id === parent && !item.deletedAt);
    if (!ancestor) throw new Error('父笔记不存在或已删除。');
    parent = ancestor.parentId;
  }
  const siblings = notes.filter(item => item.id !== note.id && item.parentId === parentId && !item.deletedAt).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const index = beforeId == null ? siblings.length : siblings.findIndex(item => item.id === beforeId);
  if (index < 0) throw new Error('排序目标必须是其他有效的同级笔记。');
  const oldParent = note.parentId;
  note.parentId = parentId;
  siblings.splice(index, 0, note);
  siblings.forEach((item, order) => item.order = order);
  if (oldParent !== parentId) notes.filter(item => item.parentId === oldParent && !item.deletedAt).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)).forEach((item, order) => item.order = order);
}

function subtree(notes: Note[], id: string): Note[] {
  const children = new Map<string, Note[]>();
  for (const note of notes) if (note.parentId !== null) children.set(note.parentId, [...children.get(note.parentId) ?? [], note]);
  const result = notes.filter(note => note.id === id);
  for (let index = 0; index < result.length; index++) result.push(...children.get(result[index].id) ?? []);
  return result;
}

export class NotesStore {
  private db: DatabaseSync;
  constructor(root: string) {
    const directory = projectDirectory(root, '.mixcat', 'notes');
    const path = insideProject(root, join(directory, 'notes.sqlite'));
    for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) if (existsSync(file)) {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('笔记数据库必须是项目内无链接的普通文件。');
    }
    this.db = new DatabaseSync(path);
    try { this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS notes_state (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS note_receipts (id TEXT PRIMARY KEY, request TEXT NOT NULL, note_id TEXT NOT NULL);'); }
    catch (error) { this.db.close(); throw error; }
  }
  read(): NotesSnapshot {
    const row = this.db.prepare('SELECT schema_version, revision, body FROM notes_state WHERE id=1').get();
    if (!row) return { revision: 0, notes: [] };
    if (row.schema_version !== 1 || !Number.isSafeInteger(row.revision) || Number(row.revision) < 0) throw new Error('笔记数据版本不受支持。');
    const notes: Note[] = JSON.parse(String(row.body));
    if (!Array.isArray(notes)) throw new Error('笔记数据格式损坏。');
    const ids = new Map<string, Note>();
    for (const note of notes) {
      if (!note || typeof note.id !== 'string' || !identifier.test(note.id) || ids.has(note.id) || !Number.isSafeInteger(note.order) || note.order < 0 || !Number.isSafeInteger(note.revision) || note.revision < 1 || !Array.isArray(note.relatedIds) || new Set(note.relatedIds).size !== note.relatedIds.length || ![note.createdAt, note.updatedAt, ...(note.deletedAt === undefined ? [] : [note.deletedAt])].every(value => typeof value === 'string' && Number.isFinite(Date.parse(value)))) throw new Error('笔记数据格式损坏。');
      noteText(note.title, true); noteText(note.body); ids.set(note.id, note);
    }
    const checked = new Set<string>();
    for (const note of notes) {
      if (note.parentId !== null && (!ids.has(note.parentId) || !note.deletedAt && ids.get(note.parentId)!.deletedAt) || note.relatedIds.some(id => id === note.id || !ids.has(id) || !ids.get(id)!.relatedIds.includes(note.id))) throw new Error('笔记层级或关联数据损坏。');
      const branch = new Set<string>();
      let current: Note | undefined = note;
      while (current && !checked.has(current.id)) {
        if (branch.has(current.id)) throw new Error('笔记层级包含循环。');
        branch.add(current.id); current = current.parentId === null ? undefined : ids.get(current.parentId);
      }
      for (const id of branch) checked.add(id);
    }
    return { revision: Number(row.revision), notes };
  }
  mutate(input: NoteMutation): { notes: NotesSnapshot; noteId: string } {
    validateMutation(input);
    const request = JSON.stringify(input);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.db.prepare('SELECT request, note_id FROM note_receipts WHERE id=?').get(input.request_id);
      if (previous) {
        if (!isDeepStrictEqual(JSON.parse(String(previous.request)), JSON.parse(request))) throw new Error('同一笔记请求编号不能用于不同内容。');
        const result = { notes: this.read(), noteId: String(previous.note_id) };
        this.db.exec('COMMIT'); return result;
      }
      const snapshot = this.read();
      if (snapshot.revision !== input.expected_revision) throw new Error('笔记版本已变化，请刷新并核对草稿后重试。');
      const before = structuredClone(snapshot.notes);
      const at = new Date(snapshot.notes.reduce((time, item) => Math.max(time, Date.parse(item.updatedAt) + 1), Date.now())).toISOString();
      let note: Note;
      if (input.operation === 'create') {
        const parentId = input.parentId ?? null;
        if (parentId !== null && !snapshot.notes.some(item => item.id === parentId && !item.deletedAt)) throw new Error('父笔记不存在或已删除。');
        note = { id: randomUUID(), title: noteText(input.title === undefined ? '未命名笔记' : input.title, true), body: noteText(input.body === undefined ? '' : input.body), parentId, order: snapshot.notes.filter(item => item.parentId === parentId && !item.deletedAt).length, relatedIds: [], revision: 1, createdAt: at, updatedAt: at };
        snapshot.notes.push(note);
        placeNote(snapshot.notes, note, parentId, input.beforeId);
      } else {
        note = snapshot.notes.find(item => item.id === input.id)!;
        if (!note || note.deletedAt && input.operation !== 'restore') throw new Error('笔记不存在或已删除。');
        if (input.operation === 'edit') {
          if (input.title !== undefined) note.title = noteText(input.title, true);
          if (input.body !== undefined) note.body = noteText(input.body);
        } else if (input.operation === 'move') placeNote(snapshot.notes, note, input.parentId === undefined ? note.parentId : input.parentId, input.beforeId);
        else if (input.operation === 'associate') {
          if (input.targetId === note.id) throw new Error('笔记不能关联自身。');
          const target = snapshot.notes.find(item => item.id === input.targetId && (!item.deletedAt || input.linked === false));
          if (!target) throw new Error('关联目标不存在或已删除。');
          if (typeof input.linked !== 'boolean') throw new Error('必须明确添加或移除笔记关联。');
          for (const [from, to] of [[note, target], [target, note]]) from.relatedIds = input.linked ? [...new Set([...from.relatedIds, to.id])].sort() : from.relatedIds.filter(id => id !== to.id);
        }
        else if (input.operation === 'delete') {
          for (const item of subtree(snapshot.notes, note.id)) if (!item.deletedAt) item.deletedAt = at;
          snapshot.notes.filter(item => item.parentId === note.parentId && !item.deletedAt).sort((a, b) => a.order - b.order).forEach((item, order) => item.order = order);
        } else if (input.operation === 'restore') {
          if (!note.deletedAt) throw new Error('笔记未被删除。');
          const deletedAt = note.deletedAt;
          for (const item of subtree(snapshot.notes, note.id)) if (item.deletedAt === deletedAt) delete item.deletedAt;
          let parent = note.parentId;
          while (parent !== null) {
            const ancestor = snapshot.notes.find(item => item.id === parent)!;
            delete ancestor.deletedAt; parent = ancestor.parentId;
          }
          const groups = new Map<string | null, Note[]>();
          for (const item of snapshot.notes.filter(item => !item.deletedAt)) groups.set(item.parentId, [...groups.get(item.parentId) ?? [], item]);
          for (const siblings of groups.values()) siblings.sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt)).forEach((item, order) => item.order = order);
        }
        else throw new Error('不支持的笔记操作。');
      }
      for (const item of snapshot.notes) {
        const original = before.find(previous => previous.id === item.id);
        if (original && !isDeepStrictEqual(original, item)) { item.revision++; item.updatedAt = at; }
      }
      snapshot.revision++;
      this.db.prepare('INSERT INTO notes_state VALUES(1,1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, body=excluded.body').run(snapshot.revision, JSON.stringify(snapshot.notes));
      this.db.prepare('INSERT INTO note_receipts VALUES(?,?,?)').run(input.request_id, request, note.id);
      this.db.exec('COMMIT'); return { notes: snapshot, noteId: note.id };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}
