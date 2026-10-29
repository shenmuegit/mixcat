import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FeedAdmission, FeedCollection, FeedCollectionCommand, FeedConversationEntry, FeedInput, FeedPage, FeedRun, FeedTrigger } from '../shared/feed.js';
import { FeedStore } from './feed-store.js';
import { FeedService } from './feed.js';

export const feedId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const text = z.string().refine(value => Buffer.byteLength(value, 'utf8') <= 256 * 1024, '文字超过 256 KiB。');
const sourcePreferences = z.string().refine(value => Buffer.byteLength(value, 'utf8') <= 64 * 1024, '来源偏好超过 64 KiB。');
export const feedCapabilities = z.strictObject({ model: z.string().min(1).max(200).nullable(), reasoningEffort: z.string().min(1).max(200).nullable().optional(), skills: z.array(z.strictObject({ name: z.string().min(1), path: z.string().min(1) })).max(100), plugins: z.array(z.strictObject({ id: z.string().min(1), name: z.string().min(1) })).max(100) });
const inputSchema = z.strictObject({ text, materialEntryIds: z.array(feedId).max(50).refine(ids => new Set(ids).size === ids.length).optional() });
const changesSchema = z.strictObject({ name: z.string().trim().min(1).max(512).optional(), instruction: text.optional(), sourcePreferences: sourcePreferences.optional(), capabilities: feedCapabilities.optional() });
const pageFields = { collectionId: feedId, runId: feedId.optional(), cursor: z.string().max(4096).optional(), limit: z.number().int().min(1).max(200).optional() };
export const collectionCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('create_feed_collection'), requestId: feedId, name: z.string().trim().min(1).max(512), instruction: text, sourcePreferences: sourcePreferences.optional(), input: inputSchema, capabilities: feedCapabilities.optional() }),
  z.strictObject({ type: z.literal('get_feed_collection'), collectionId: feedId }),
  z.strictObject({ type: z.literal('edit_feed_collection'), collectionId: feedId, expectedRevision: z.number().int().positive(), requestId: feedId, changes: changesSchema }),
  z.strictObject({ type: z.enum(['run_feed_collection', 'send_feed_message']), collectionId: feedId, input: inputSchema, requestId: feedId }),
  z.strictObject({ type: z.enum(['read_feed_history', 'list_feed_runs', 'list_feed_results', 'list_feed_failures']), ...pageFields }),
  z.strictObject({ type: z.literal('load_feed_native_history'), collectionId: feedId, cursor: z.string().max(4096).optional() }),
  z.strictObject({ type: z.literal('feed_capabilities'), collectionId: feedId }),
  z.strictObject({ type: z.literal('respond_feed_native'), collectionId: feedId, requestKey: z.string().min(1), result: z.unknown() }),
]);
export const collectionCommandTypes = ['create_feed_collection', 'get_feed_collection', 'edit_feed_collection', 'run_feed_collection', 'send_feed_message', 'read_feed_history', 'list_feed_runs', 'list_feed_results', 'list_feed_failures', 'load_feed_native_history', 'feed_capabilities', 'respond_feed_native'];
export const activeFeedRun = (run: FeedRun) => ['starting', 'running', 'needs_reconciliation'].includes(run.status);
export const feedNow = () => new Date().toISOString();

// All durable collection operations share the entry service's SQLite writer and receipts.
export class FeedCollections {
  private entries: FeedService;
  constructor(readonly store: FeedStore) { this.entries = new FeedService(store); }
  list(): FeedCollection[] { return this.store.db.prepare('SELECT body FROM feed_collections ORDER BY rowid').all().map(row => ({ sourcePreferences: '', ...JSON.parse(String(row.body)) })); }
  get(id: string): FeedCollection { feedId.parse(id); const row = this.store.db.prepare('SELECT body FROM feed_collections WHERE id=?').get(id); if (!row) throw new Error('采集任务不存在。'); return { sourcePreferences: '', ...JSON.parse(String(row.body)) }; }
  save(collection: FeedCollection) { this.store.db.prepare('INSERT INTO feed_collections VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(collection.id, JSON.stringify(collection)); this.store.bumpRevision(); }
  runs(collectionId?: string): FeedRun[] { return this.store.db.prepare(`SELECT body FROM feed_runs ${collectionId ? 'WHERE collection_id=?' : ''} ORDER BY seq`).all(...(collectionId ? [collectionId] : [])).map(row => this.withCounts(JSON.parse(String(row.body)))); }
  run(id: string): FeedRun { const row = this.store.db.prepare('SELECT body FROM feed_runs WHERE id=?').get(id); if (!row) throw new Error('采集运行不存在。'); return this.withCounts(JSON.parse(String(row.body))); }
  saveRun(run: FeedRun) { this.store.db.prepare('INSERT INTO feed_runs(id,collection_id,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(run.id, run.collectionId, JSON.stringify(run)); this.store.bumpRevision(); }
  create(command: Extract<FeedCollectionCommand, { type: 'create_feed_collection' }>): FeedAdmission {
    command = collectionCommandSchema.parse(command) as typeof command;
    return this.entries.request(command.requestId, command, { kind: 'user' }, () => {
      const at = feedNow(), collection: FeedCollection = { id: randomUUID(), name: command.name, instruction: command.instruction, sourcePreferences: command.sourcePreferences ?? '', instructionRevision: 1, revision: 1, capabilities: command.capabilities ?? { model: null, skills: [], plugins: [] }, threadId: null, queueHeld: false, deletedAt: null, createdAt: at, updatedAt: at };
      this.save(collection);
      return this.admit(collection.id, command.input, 'collect', command.requestId);
    });
  }
  enqueue(collectionId: string, input: FeedInput, trigger: FeedTrigger, requestId: string): FeedAdmission {
    feedId.parse(collectionId); feedId.parse(requestId); input = inputSchema.parse(input); z.enum(['collect', 'message', 'schedule']).parse(trigger);
    return this.entries.request(requestId, { collectionId, input, trigger }, { kind: 'user' }, () => this.admit(collectionId, input, trigger, requestId));
  }
  private admit(collectionId: string, input: FeedInput, trigger: FeedTrigger, requestId: string): FeedAdmission {
    const collection = this.get(collectionId); if (collection.deletedAt) throw new Error('采集任务已删除。');
    const materials = (input.materialEntryIds ?? []).map(id => { const entry = this.entries.getEntry(id); if (entry.deletedAt) throw new Error('选中的素材已删除。'); return { entryId: id, revision: entry.revision, title: entry.title, body: entry.body }; });
    if (Buffer.byteLength(JSON.stringify({ text: input.text, materials }), 'utf8') > 1024 * 1024) throw new Error('输入素材总量超过 1 MiB。');
    const run: FeedRun = { id: randomUUID(), collectionId, trigger, status: 'queued', inputSnapshot: { text: input.text, materials }, instructionSnapshot: null, sourcePreferencesSnapshot: null, instructionRevision: null, capabilitiesSnapshot: null, threadId: null, turnId: null, createdAt: feedNow(), startedAt: null, completedAt: null, error: null, counts: { new: 0, duplicate: 0, suppressed: 0, failed: 0 }, outcome: null };
    this.saveRun(run);
    this.historySave({ id: `input:${run.id}`, seq: 0, collectionId, runId: run.id, threadId: null, turnId: null, itemId: null, source: 'user', text: input.text, createdAt: run.createdAt, completed: true, revision: 1 });
    return { accepted: true, requestId, collectionId, runId: run.id };
  }
  edit(id: string, expectedRevision: number, changes: { name?: string; instruction?: string; sourcePreferences?: string; capabilities?: FeedCollection['capabilities'] }, requestId: string): FeedCollection {
    feedId.parse(id); feedId.parse(requestId); changes = changesSchema.parse(changes);
    return this.entries.request(requestId, { id, expectedRevision, changes }, { kind: 'user' }, () => { const collection = this.get(id); if (collection.revision !== expectedRevision) throw new Error('采集任务版本冲突。'); if ((changes.instruction !== undefined && changes.instruction !== collection.instruction) || (changes.sourcePreferences !== undefined && changes.sourcePreferences !== collection.sourcePreferences)) collection.instructionRevision++; Object.assign(collection, changes, { revision: collection.revision + 1, updatedAt: feedNow() }); this.save(collection); return collection; });
  }
  start(id: string): FeedRun | null {
    return this.store.transaction(() => {
      const run = this.run(id), collection = this.get(run.collectionId), all = this.runs();
      if (!['queued', 'waiting_account'].includes(run.status) || collection.queueHeld || collection.deletedAt || all.some(other => other.collectionId === collection.id && activeFeedRun(other)) || all.filter(other => ['starting', 'running'].includes(other.status)).length >= 2) return null;
      run.status = 'starting'; run.instructionSnapshot = collection.instruction; run.sourcePreferencesSnapshot = collection.sourcePreferences; run.instructionRevision = collection.instructionRevision; run.capabilitiesSnapshot = collection.capabilities; run.startedAt = feedNow(); run.threadId = collection.threadId;
      this.saveRun(run); return run;
    });
  }
  withCounts(run: FeedRun): FeedRun {
    run.sourcePreferencesSnapshot ??= null;
    const rows = this.store.db.prepare("SELECT json_extract(response,'$.outcome') AS outcome,count(*) AS count FROM feed_receipts WHERE json_extract(input,'$.actor.runId')=? GROUP BY outcome").all(run.id);
    run.counts = { new: 0, duplicate: 0, suppressed: 0, failed: 0 };
    for (const row of rows) { const key = row.outcome === 'suppressed_deleted' ? 'suppressed' : row.outcome; if (key === 'new' || key === 'duplicate' || key === 'suppressed') run.counts[key] = Number(row.count); }
    run.counts.failed = Number(this.store.db.prepare('SELECT count(*) AS count FROM feed_source_failures WHERE run_id=?').get(run.id)!.count);
    if (run.status === 'completed') run.outcome = run.counts.failed ? (run.counts.new + run.counts.duplicate + run.counts.suppressed ? 'partial' : 'failed') : run.counts.new ? 'success' : 'zero';
    else if (run.status === 'failed') run.outcome = 'failed';
    return run;
  }
  historyGet(id: string): FeedConversationEntry | null { const row = this.store.db.prepare('SELECT seq,body FROM feed_history WHERE id=?').get(id); return row ? { ...JSON.parse(String(row.body)), seq: Number(row.seq) } : null; }
  historySave(entry: FeedConversationEntry): FeedConversationEntry {
    this.store.db.prepare('INSERT INTO feed_history(id,collection_id,thread_id,turn_id,item_id,body) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET thread_id=excluded.thread_id,turn_id=excluded.turn_id,item_id=excluded.item_id,body=excluded.body').run(entry.id, entry.collectionId, entry.threadId, entry.turnId, entry.itemId, JSON.stringify(entry)); this.store.bumpRevision(); return this.historyGet(entry.id)!;
  }
  page<T>(kind: 'history' | 'runs' | 'results' | 'failures', collectionId: string, runId?: string, cursor?: string, limit = 50): FeedPage<T> {
    this.get(collectionId); z.number().int().min(1).max(200).parse(limit);
    if (runId && this.run(runId).collectionId !== collectionId) throw new Error('运行不属于该采集任务。');
    const scope = JSON.stringify([kind, collectionId, runId ?? null]); let before = Number.MAX_SAFE_INTEGER;
    if (cursor) { let decoded; try { decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString()); } catch { throw new Error('分页游标无效。'); } if (!Array.isArray(decoded) || decoded.length !== 2 || decoded[0] !== scope || !Number.isSafeInteger(decoded[1]) || decoded[1] < 1) throw new Error('分页游标不属于本次查询。'); before = decoded[1]; }
    let rows: any[];
    if (kind === 'results') rows = this.store.db.prepare(`SELECT d.id AS seq,d.entry_id,d.actor,d.collected_at,e.body FROM feed_discoveries d JOIN feed_entries e ON e.id=d.entry_id WHERE d.collection_id=? AND d.id<? ${runId ? "AND json_extract(d.actor,'$.runId')=?" : ''} ORDER BY d.id DESC LIMIT ?`).all(collectionId, before, ...(runId ? [runId] : []), limit + 1);
    else if (kind === 'failures') rows = this.store.db.prepare(`SELECT f.seq,f.body FROM feed_source_failures f JOIN feed_runs r ON r.id=f.run_id WHERE r.collection_id=? AND f.seq<? ${runId ? 'AND f.run_id=?' : ''} ORDER BY f.seq DESC LIMIT ?`).all(collectionId, before, ...(runId ? [runId] : []), limit + 1);
    else rows = this.store.db.prepare(`SELECT seq,body FROM feed_${kind === 'history' ? 'history' : 'runs'} WHERE collection_id=? AND seq<? ${runId ? kind === 'history' ? "AND json_extract(body,'$.runId')=?" : 'AND id=?' : ''} ORDER BY seq DESC LIMIT ?`).all(collectionId, before, ...(runId ? [runId] : []), limit + 1);
    const items = rows.slice(0, limit).map(row => { const value = JSON.parse(String(row.body)); return kind === 'history' ? { ...value, seq: Number(row.seq) } : kind === 'runs' ? this.withCounts(value) : kind === 'results' ? { discoveryId: Number(row.seq), entryId: row.entry_id, title: value.title, deletedAt: value.deletedAt, actor: JSON.parse(row.actor), collectedAt: row.collected_at } : { ...value, id: Number(row.seq) }; });
    return { items, revision: this.store.revision, nextCursor: rows.length > limit ? Buffer.from(JSON.stringify([scope, Number(rows[limit - 1].seq)])).toString('base64url') : null };
  }
}
