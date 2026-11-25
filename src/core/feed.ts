import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FeedActor, FeedCommand, FeedEntry, FeedEntryInput, FeedEntryMutation, FeedEntrySummary, FeedPage, FeedQuery, FeedReceipt } from '../shared/feed.js';
import { collectionCommandTypes } from './feed-collections.js';
import { FeedStore } from './feed-store.js';

type StoredEntry = Omit<FeedEntry, 'discoveries' | 'references'> & { deletedAt?: string | null };
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, '标识格式不正确。');
const textBody = z.string().refine(value => Buffer.byteLength(value, 'utf8') <= 256 * 1024, '文字超过 256 KiB。');
const personalText = z.string().max(131072);
const userActor = z.strictObject({ kind: z.literal('user') });
const actorSchema = z.discriminatedUnion('kind', [userActor, z.strictObject({ kind: z.literal('agent'), collectionId: identifier, runId: identifier, threadId: identifier, turnId: identifier, callId: identifier })]);
const entryInput = z.strictObject({
  title: z.string().max(512).refine(value => !!value.trim(), '标题不能为空。'), body: textBody.refine(value => !!value.trim(), '正文不能为空。'),
  aiSummary: personalText.optional(), sourceUrl: z.string().optional(), publishedAt: z.iso.datetime({ offset: true }).optional(),
  coverage: z.enum(['full', 'partial', 'excerpt']), referenceEntryIds: z.array(identifier).max(50).refine(ids => new Set(ids).size === ids.length, '引用不能重复。').optional(),
});
const editFields = { id: identifier, expectedRevision: z.number().int().positive(), requestId: identifier };
const mutationSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('createText'), input: entryInput, requestId: identifier }),
  z.strictObject({ operation: z.literal('setRead'), ...editFields, read: z.boolean() }),
  z.strictObject({ operation: z.literal('setStarred'), ...editFields, starred: z.boolean() }),
  z.strictObject({ operation: z.literal('saveNote'), ...editFields, note: personalText }),
  z.strictObject({ operation: z.literal('delete'), ...editFields }),
  z.strictObject({ operation: z.literal('saveAnswer'), collectionId: identifier, conversationEntryId: identifier, title: z.string().max(512), requestId: identifier }),
]);
const querySchema = z.strictObject({ text: personalText.optional(), view: z.enum(['all', 'unread', 'saved']).optional(), collectionId: identifier.optional(), cursor: z.string().max(524288).optional(), limit: z.number().int().min(1).max(200).optional() });
export class FeedService {
  constructor(readonly store: FeedStore) {}
  query(query: FeedQuery): FeedPage<FeedEntrySummary> {
    query = querySchema.parse(query);
    const limit = query.limit ?? 50, scope = canonical({ text: query.text ?? '', view: query.view ?? 'all', collectionId: query.collectionId ?? null });
    const where = ["json_extract(body,'$.deletedAt') IS NULL"], parameters: (string | number | null)[] = [];
    if (query.view === 'unread') where.push("json_extract(body,'$.readAt') IS NULL");
    if (query.view === 'saved') where.push("json_extract(body,'$.starred')=1");
    if (query.collectionId === 'manual') where.push("id IN (SELECT entry_id FROM feed_discoveries WHERE json_extract(actor,'$.kind')='user')");
    else if (query.collectionId !== undefined) { where.push('id IN (SELECT entry_id FROM feed_discoveries WHERE collection_id=?)'); parameters.push(query.collectionId); }
    if (query.text) {
      where.push("instr(lower(json_extract(body,'$.title') || char(10) || json_extract(body,'$.body') || char(10) || coalesce(json_extract(body,'$.aiSummary'),'') || char(10) || json_extract(body,'$.note')),lower(?))>0"); parameters.push(query.text);
    }
    if (query.cursor) {
      let cursor: unknown;
      try { cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')); } catch { throw new Error('信息流游标无效。'); }
      if (!Array.isArray(cursor) || cursor.length !== 3 || cursor.some(item => typeof item !== 'string') || cursor[0] !== scope) throw new Error('信息流游标与查询不匹配。');
      where.push("(json_extract(body,'$.firstCollectedAt')<? OR (json_extract(body,'$.firstCollectedAt')=? AND id<?))"); parameters.push(cursor[1], cursor[1], cursor[2]);
    }
    const rows = this.store.db.prepare(`SELECT body FROM feed_entries WHERE ${where.join(' AND ')} ORDER BY json_extract(body,'$.firstCollectedAt') DESC,id DESC LIMIT ?`).all(...parameters, limit + 1);
    const items = rows.slice(0, limit).map(row => {
      const { body, note, deletedAt, ...entry } = JSON.parse(String(row.body)) as StoredEntry;
      return { ...entry, excerpt: body.slice(0, 240) };
    });
    const last = items.at(-1);
    return { items, nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify([scope, last.firstCollectedAt, last.id])).toString('base64url') : null, revision: this.store.revision };
  }
  getEntry(id: string, discoveryCursor?: string): FeedEntry {
    identifier.parse(id);
    const row = this.store.db.prepare("SELECT body FROM feed_entries WHERE id=? AND json_extract(body,'$.deletedAt') IS NULL").get(id);
    if (!row) throw new Error('信息条目不存在。');
    let before = Number.MAX_SAFE_INTEGER;
    if (discoveryCursor !== undefined) {
      let cursor: unknown;
      try { cursor = JSON.parse(Buffer.from(z.string().max(1024).parse(discoveryCursor), 'base64url').toString('utf8')); } catch { throw new Error('发现记录游标无效。'); }
      if (!Array.isArray(cursor) || cursor.length !== 2 || cursor[0] !== id || !Number.isSafeInteger(cursor[1]) || cursor[1] < 1) throw new Error('发现记录游标与条目不匹配。');
      before = cursor[1];
    }
    const { deletedAt, ...entry } = JSON.parse(String(row.body)) as StoredEntry;
    const discoveries = this.store.db.prepare('SELECT * FROM feed_discoveries WHERE entry_id=? AND id<? ORDER BY id DESC LIMIT 51').all(id, before);
    const references = entry.referenceEntryIds.flatMap(id => {
      const row = this.store.db.prepare("SELECT json_extract(body,'$.title') AS title FROM feed_entries WHERE id=? AND json_extract(body,'$.deletedAt') IS NULL").get(id);
      return row ? [{ id, title: String(row.title) }] : [];
    });
    return { ...entry, answerOrigin: entry.answerOrigin ?? null, discoveries: { items: discoveries.slice(0, 50).map(row => {
      const actor = JSON.parse(String(row.actor)) as FeedActor;
      const origin = actor.kind === 'user' && row.collection_id === entry.answerOrigin?.collectionId ? entry.answerOrigin : null;
      const collectionId = actor.kind === 'agent' ? actor.collectionId : origin?.collectionId;
      const source = collectionId ? this.store.db.prepare("SELECT body FROM feed_collections WHERE id=? AND json_extract(body,'$.deletedAt') IS NULL").get(collectionId) : undefined;
      const collection = source ? JSON.parse(String(source.body)) : null;
      return { id: Number(row.id), actor, collectedAt: String(row.collected_at), collection: collection ? { id: collection.id, name: collection.name } : null,
        runId: actor.kind === 'agent' ? actor.runId : origin?.runId ?? null, historyAvailable: !!collection && (actor.kind === 'agent' ? !!this.store.db.prepare('SELECT 1 FROM feed_history WHERE collection_id=? AND thread_id=? AND turn_id=? LIMIT 1').get(actor.collectionId, actor.threadId, actor.turnId) : !!origin && !!this.store.db.prepare('SELECT 1 FROM feed_history WHERE id=? AND collection_id=?').get(origin.conversationEntryId, origin.collectionId)) };
    }),
      nextCursor: discoveries.length > 50 ? Buffer.from(JSON.stringify([id, Number(discoveries[49].id)])).toString('base64url') : null, revision: this.store.revision }, references };
  }
  mutate(input: FeedEntryMutation, actor: { kind: 'user' }): FeedReceipt {
    userActor.parse(actor); input = mutationSchema.parse(input);
    if (input.operation === 'createText') return this.saveResult(input.requestId, input.input, { kind: 'user' });
    if (input.operation === 'saveAnswer') return this.request(input.requestId, input, actor, () => {
      const row = this.store.db.prepare("SELECT h.body FROM feed_history h JOIN feed_collections c ON c.id=h.collection_id WHERE h.id=? AND h.collection_id=? AND json_extract(c.body,'$.deletedAt') IS NULL").get(input.conversationEntryId, input.collectionId);
      const answer = row && JSON.parse(String(row.body));
      if (!answer || answer.source !== 'assistant' || (answer.rawItem as any)?.type !== 'agentMessage' || !answer.completed || !answer.text.trim()) throw new Error('只能保存本采集任务已完成的文字回答。');
      const receipt = this.saveResult(`answer-${randomUUID()}`, { title: input.title, body: answer.text, coverage: 'full' }, actor);
      const stored = JSON.parse(String(this.store.db.prepare('SELECT body FROM feed_entries WHERE id=?').get(receipt.entryId)!.body)) as StoredEntry;
      stored.answerOrigin = { collectionId: answer.collectionId, runId: answer.runId ?? null, threadId: answer.threadId ?? null, turnId: answer.turnId ?? null, conversationEntryId: answer.id };
      this.store.db.prepare('UPDATE feed_entries SET body=? WHERE id=?').run(JSON.stringify(stored), receipt.entryId);
      // User saves have no content dedup key; this new discovery and its trusted origin commit with the receipt.
      this.store.db.prepare("UPDATE feed_discoveries SET collection_id=? WHERE entry_id=? AND json_extract(actor,'$.kind')='user'").run(answer.collectionId, receipt.entryId);
      return { ...receipt, requestId: input.requestId };
    });
    return this.request(input.requestId, input, { kind: 'user' }, () => {
      const { discoveries, references, ...entry } = this.getEntry(input.id);
      if (entry.revision !== input.expectedRevision) throw new Error('条目版本冲突，请重新读取。');
      if (input.operation === 'delete') {
        this.deleteEntries([entry.id]);
        this.store.bumpRevision();
        return { accepted: true, requestId: input.requestId, entryId: entry.id, outcome: 'duplicate', revision: entry.revision + 1 };
      }
      const now = new Date().toISOString();
      if (input.operation === 'saveNote') entry.note = input.note;
      if (input.operation === 'setStarred') entry.starred = input.starred;
      if (input.operation === 'setRead') entry.readAt = input.read ? now : null;
      entry.revision++; entry.updatedAt = now;
      this.store.db.prepare('UPDATE feed_entries SET body=? WHERE id=?').run(JSON.stringify(entry), entry.id);
      this.store.bumpRevision();
      return { accepted: true, requestId: input.requestId, entryId: entry.id, outcome: 'duplicate', revision: entry.revision };
    });
  }
  saveResult(requestId: string, input: Omit<FeedEntryInput, 'title'> & { title?: string }, actor: FeedActor, admit: () => void = () => {}): FeedReceipt {
    identifier.parse(requestId); actor = actorSchema.parse(actor);
    input = (actor.kind === 'agent' ? entryInput.partial({ title: true }) : entryInput).parse(input);
    if (input.sourceUrl !== undefined) normalizeUrl(input.sourceUrl);
    return this.request(requestId, { operation: 'createText', input, requestId }, actor, () => {
      for (const id of input.referenceEntryIds ?? []) this.getEntry(id);
      admit();
      const at = new Date(), now = at.toISOString(), id = randomUUID();
      let title = input.title;
      if (title === undefined && actor.kind === 'agent') {
        const collection = this.store.db.prepare("SELECT json_extract(body,'$.name') AS name FROM feed_collections WHERE id=?").get(actor.collectionId);
        if (!collection) throw new Error('采集任务不存在。');
        title = `${collection.name}_${at.toLocaleString('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}`;
      }
      const sourceUrl = input.sourceUrl ? normalizeUrl(input.sourceUrl) : null;
      const entry: StoredEntry = { id, title: title!, body: input.body, aiSummary: input.aiSummary ?? null, sourceUrl: input.sourceUrl ?? null,
        publishedAt: input.publishedAt ?? null, coverage: input.coverage, referenceEntryIds: input.referenceEntryIds ?? [], firstCollectedAt: now,
        updatedAt: now, readAt: null, starred: false, note: '', revision: 1 };
      entry.sourceUrl = sourceUrl;
      this.store.db.prepare('INSERT INTO feed_entries VALUES(?,?,?)').run(id, null, JSON.stringify(entry));
      this.discover(id, actor, now);
      this.store.bumpRevision();
      return { accepted: true, requestId, entryId: id, outcome: 'new', revision: 1 };
    });
  }
  deleteEntries(ids: string[]) {
    if (!ids.length) return;
    const values = JSON.stringify(ids), removed = new Set(ids), db = this.store.db;
    const referents = db.prepare("SELECT body FROM feed_entries WHERE json_extract(body,'$.deletedAt') IS NULL AND id NOT IN (SELECT value FROM json_each(?)) AND EXISTS (SELECT 1 FROM json_each(body,'$.referenceEntryIds') WHERE value IN (SELECT value FROM json_each(?)))").all(values, values);
    const update = db.prepare('UPDATE feed_entries SET body=? WHERE id=?'), now = new Date().toISOString();
    for (const row of referents) {
      const entry = JSON.parse(String(row.body)) as StoredEntry;
      entry.referenceEntryIds = entry.referenceEntryIds.filter(id => !removed.has(id));
      entry.updatedAt = now;
      entry.revision++;
      update.run(JSON.stringify(entry), entry.id);
    }
    this.retireReceipts("json_extract(response,'$.entryId') IN (SELECT value FROM json_each(?))", values);
    db.prepare('DELETE FROM feed_discoveries WHERE entry_id IN (SELECT value FROM json_each(?))').run(values);
    db.prepare('DELETE FROM feed_entries WHERE id IN (SELECT value FROM json_each(?))').run(values);
  }
  retireReceipts(where: string, ...parameters: string[]) {
    const db = this.store.db, update = db.prepare('UPDATE feed_receipts SET input=?,response=? WHERE key=?');
    for (const row of db.prepare(`SELECT key,input,response FROM feed_receipts WHERE ${where}`).all(...parameters)) {
      const input = String(row.input), stored = JSON.parse(input), outcome = JSON.parse(String(row.response))?.outcome;
      // Only an immutable identity and the execution's counter survive removal of its content.
      update.run(JSON.stringify({ fingerprint: stored.fingerprint ?? requestFingerprint(input), actor: { runId: stored.actor?.runId } }), JSON.stringify({ removed: true, outcome }), row.key);
    }
  }
  private discover(id: string, actor: FeedActor, at: string) {
    this.store.db.prepare('INSERT INTO feed_discoveries(entry_id,collection_id,actor,collected_at) VALUES(?,?,?,?)').run(id, actor.kind === 'agent' ? actor.collectionId : null, JSON.stringify(actor), at);
  }
  request<T>(requestId: string, input: unknown, actor: FeedActor, operation: () => T): T {
    const key = JSON.stringify(actor.kind === 'user' ? ['user', requestId] : [actor.collectionId, actor.runId, requestId]);
    const identity = actor.kind === 'agent' ? { ...actor, callId: undefined } : actor;
    const fingerprint = canonical({ input, actor: identity });
    return this.store.transaction(() => {
      const previous = this.readReceipt<T>(key, fingerprint);
      if (previous) return previous.response;
      const response = operation();
      this.store.db.prepare('INSERT INTO feed_receipts VALUES(?,?,?)').run(key, fingerprint, JSON.stringify(response));
      return response;
    });
  }
  checkUserRequest(requestId: string, input: unknown) {
    this.readReceipt(JSON.stringify(['user', requestId]), canonical({ input, actor: { kind: 'user' } }));
  }
  private readReceipt<T>(key: string, fingerprint: string): { response: T } | undefined {
    const previous = this.store.db.prepare('SELECT input,response FROM feed_receipts WHERE key=?').get(key);
    if (!previous) return;
    if (previous.input !== fingerprint && JSON.parse(String(previous.input)).fingerprint !== requestFingerprint(fingerprint)) throw new Error('请求标识与已保存参数冲突。');
    const response = JSON.parse(String(previous.response));
    if (response?.removed === true) throw new Error('请求对应的内容已经永久删除。');
    return { response };
  }
  completeUserRequest<T>(requestId: string, input: unknown, response: T): T {
    return this.store.transaction(() => {
      this.request(requestId, input, { kind: 'user' }, () => { throw new Error('操作意图尚未保存。'); });
      this.store.db.prepare('UPDATE feed_receipts SET response=? WHERE key=?').run(JSON.stringify(response), JSON.stringify(['user', requestId]));
      return response;
    });
  }
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, child) => child && typeof child === 'object' && !Array.isArray(child)
    ? Object.fromEntries(Object.keys(child).sort().map(key => [key, child[key]])) : child);
}

function requestFingerprint(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function normalizeUrl(value: string): string {
  const url = new URL(value), match = /^(https?):\/\/([^/?#]*)([^#]*)/i.exec(value);
  if (!match || /[\s\\\u0000-\u001f\u007f]/.test(value) || match[2].includes('@') || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('来源链接只允许不含账号的 HTTP/HTTPS URL。');
  return `${url.protocol}//${url.host}${match[3]}`;
}
export const entryCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('feed_snapshot') }),
  z.strictObject({ type: z.literal('search_feed_entries'), query: querySchema }),
  z.strictObject({ type: z.literal('get_feed_entry'), entryId: identifier, discoveryCursor: z.string().max(1024).optional() }),
  z.strictObject({ type: z.literal('update_feed_entry'), mutation: mutationSchema }),
]);

export function isFeedCommand(command: { type: string }): command is FeedCommand {
  return [...collectionCommandTypes, 'feed_snapshot', 'search_feed_entries', 'get_feed_entry', 'update_feed_entry'].includes(command.type);
}
