import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CANVAS_LIBRARY_LIMIT, CANVAS_SCENE_LIMIT, type CanvasCommand, type CanvasDocument, type CanvasReply, type CanvasSummary } from '../shared/canvases.js';
import { insideProject, projectDirectory } from './paths.js';

const identifier = /^[A-Za-z0-9_-]{1,128}$/;
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const elements = (value: unknown): value is Record<string, unknown>[] => Array.isArray(value) && value.every(element => record(element) && typeof element.id === 'string' && identifier.test(element.id) && typeof element.type === 'string' && !['x', 'y', 'width', 'height'].some(key => key in element && !Number.isFinite(element[key])));
function validate(input: CanvasCommand): string {
  const fields: Record<CanvasCommand['operation'], string[]> = { list: [], read: ['id'], create: ['requestId', 'name'], save: ['requestId', 'id', 'expectedRevision', 'scene'], rename: ['requestId', 'id', 'expectedRevision', 'name'], delete: ['requestId', 'id', 'expectedRevision'], get_library: [], save_library: ['requestId', 'expectedRevision', 'items'] };
  if (!record(input) || !Object.hasOwn(fields, input.operation) || Object.keys(input).some(key => key !== 'operation' && !fields[input.operation].includes(key))) throw Error('画布操作或字段不正确。');
  if ('id' in input && (typeof input.id !== 'string' || !identifier.test(input.id)) || 'requestId' in input && (typeof input.requestId !== 'string' || !identifier.test(input.requestId))) throw Error('画布标识或请求编号不正确。');
  for (const field of fields[input.operation]) if (field !== 'name' && !Object.hasOwn(input, field)) throw Error('画布操作缺少必要字段。');
  if ('expectedRevision' in input && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < (input.operation === 'save_library' ? 0 : 1))) throw Error('画布预期版本不正确。');
  if ('name' in input && (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 200 || /[\0-\x1f]/.test(input.name)) || input.operation === 'rename' && !input.name) throw Error('画布名称不能为空且不能超过 200 字。');
  if (input.operation === 'save') {
    const scene = input.scene;
    if (!record(scene) || !elements(scene.elements) || !record(scene.appState) || !record(scene.files)) throw Error('画布场景格式不正确。');
    for (const [id, file] of Object.entries(scene.files)) if (!identifier.test(id) || !record(file) || file.id !== id || typeof file.mimeType !== 'string' || !/^image\/[a-z0-9.+-]+$/i.test(file.mimeType) || typeof file.dataURL !== 'string' || !file.dataURL.startsWith(`data:${file.mimeType};base64,`) || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.dataURL.slice(file.dataURL.indexOf(',') + 1))) throw Error('画布图片格式不正确。');
    if (Buffer.byteLength(JSON.stringify(scene)) > CANVAS_SCENE_LIMIT) throw Error('画布场景超过 64 MiB。');
  }
  if (input.operation === 'save_library' && (!Array.isArray(input.items) || input.items.some(item => !record(item) || typeof item.id !== 'string' || !identifier.test(item.id) || !['published', 'unpublished'].includes(item.status) || !Number.isFinite(item.created) || !elements(item.elements)) || Buffer.byteLength(JSON.stringify(input.items)) > CANVAS_LIBRARY_LIMIT)) throw Error('素材库格式不正确或超过 8 MiB。');
  return JSON.stringify(input, (_, value) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && !record(value) || ['undefined', 'function', 'symbol', 'bigint'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value)) throw Error('画布内容必须是有效 JSON 数据。');
    return record(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value;
  });
}

export class CanvasStore {
  private db: DatabaseSync;
  private path: string;
  constructor(private root: string) {
    this.path = insideProject(root, join(projectDirectory(root, '.mixcat', 'canvases'), 'canvases.sqlite'));
    this.checkFiles();
    this.db = new DatabaseSync(this.path);
    try { this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS canvases (id TEXT PRIMARY KEY, name TEXT NOT NULL, revision INTEGER NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, scene TEXT NOT NULL); CREATE TABLE IF NOT EXISTS canvas_receipts (id TEXT PRIMARY KEY, hash TEXT NOT NULL, result TEXT NOT NULL); CREATE TABLE IF NOT EXISTS canvas_library (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, body TEXT NOT NULL);'); }
    catch (error) { this.db.close(); throw error; }
  }
  private checkFiles() {
    insideProject(this.root, this.path);
    for (const path of [this.path, `${this.path}-wal`, `${this.path}-shm`, `${this.path}-journal`]) if (existsSync(path)) {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw Error('画布数据库必须是工作空间内无链接的普通文件。');
    }
  }
  private read(id: string): CanvasDocument {
    const row = this.db.prepare('SELECT * FROM canvases WHERE id=?').get(id);
    if (!row) throw Error('画布不存在或已删除。');
    const canvas = { ...row, scene: JSON.parse(String(row.scene)) } as unknown as CanvasDocument;
    validate({ operation: 'save', requestId: 'read', id: canvas.id, expectedRevision: canvas.revision, scene: canvas.scene });
    validate({ operation: 'rename', requestId: 'read', id: canvas.id, expectedRevision: canvas.revision, name: canvas.name });
    if (![canvas.createdAt, canvas.updatedAt].every(value => typeof value === 'string' && Number.isFinite(Date.parse(value)))) throw Error('画布时间数据损坏。');
    return canvas;
  }
  command(input: CanvasCommand): CanvasReply {
    const serialized = validate(input);
    this.checkFiles();
    if (input.operation === 'list') return { canvases: this.db.prepare('SELECT id,name,revision,createdAt,updatedAt FROM canvases ORDER BY updatedAt DESC,id').all() as unknown as CanvasSummary[] };
    if (input.operation === 'read') return { canvas: this.read(input.id) };
    if (input.operation === 'get_library') {
      const row = this.db.prepare('SELECT revision,body FROM canvas_library WHERE id=1').get();
      const library = row ? { revision: Number(row.revision), items: JSON.parse(String(row.body)) } : { revision: 0, items: [] };
      validate({ operation: 'save_library', requestId: 'read', expectedRevision: library.revision, items: library.items });
      return { library };
    }
    const hash = createHash('sha256').update(serialized).digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const receipt = this.db.prepare('SELECT hash,result FROM canvas_receipts WHERE id=?').get(input.requestId);
      if (receipt) {
        if (receipt.hash !== hash) throw Error('同一请求编号不能用于不同内容。');
        this.db.exec('COMMIT'); return JSON.parse(String(receipt.result));
      }
      const result = this.mutate(input);
      this.db.prepare('INSERT INTO canvas_receipts VALUES(?,?,?)').run(input.requestId, hash, JSON.stringify(result));
      this.db.exec('COMMIT'); return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private mutate(input: Exclude<CanvasCommand, { operation: 'list' | 'read' | 'get_library' }>): CanvasReply {
    if (input.operation === 'create') {
      const date = new Date().toISOString();
      const canvas: CanvasDocument = { id: randomUUID(), name: input.name?.trim() ?? '未命名画布', revision: 1, createdAt: date, updatedAt: date, scene: { elements: [], appState: {}, files: {} } };
      this.db.prepare('INSERT INTO canvases VALUES(?,?,?,?,?,?)').run(canvas.id, canvas.name, canvas.revision, date, date, JSON.stringify(canvas.scene));
      return { canvas };
    }
    if (input.operation === 'save_library') {
      const current = Number(this.db.prepare('SELECT revision FROM canvas_library WHERE id=1').get()?.revision ?? 0);
      if (current !== input.expectedRevision) throw Error('素材库版本已变化，请先处理冲突。');
      const revision = current + 1;
      this.db.prepare('INSERT INTO canvas_library VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,body=excluded.body').run(revision, JSON.stringify(input.items));
      return { libraryRevision: revision };
    }
    {
      const canvas = this.read(input.id);
      if (canvas.revision !== input.expectedRevision) throw Error('画布版本已变化，请先处理冲突。');
      if (input.operation === 'delete') { this.db.prepare('DELETE FROM canvases WHERE id=?').run(input.id); return { deletedId: input.id }; }
      const { scene: _, ...saved } = { ...canvas, name: input.operation === 'rename' ? input.name.trim() : canvas.name, revision: canvas.revision + 1, updatedAt: new Date().toISOString() };
      this.db.prepare('UPDATE canvases SET name=?,revision=?,updatedAt=?,scene=? WHERE id=?').run(saved.name, saved.revision, saved.updatedAt, JSON.stringify(input.operation === 'save' ? input.scene : canvas.scene), input.id);
      return { saved };
    }
  }
  close() { this.db.close(); }
}
