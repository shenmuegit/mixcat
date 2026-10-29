import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { projectDirectory } from '../src/core/paths.js';
import { FeedStore } from '../src/core/feed-store.js';
import { FeedService } from '../src/core/feed.js';
import type { FeedActor, FeedEntryInput } from '../src/shared/feed.js';

const agent: FeedActor = { kind: 'agent', collectionId: 'collection-1', runId: 'run-1', threadId: 'thread-1', turnId: 'turn-1', callId: 'call-1' };
const material: FeedEntryInput = { title: '资料', body: '正文', coverage: 'full', sourceUrl: 'https://EXAMPLE.com:443/article?q=1#top' };

function fixture(t: TestContext) {
  const root = mkdtempSync(resolve(projectDirectory(process.cwd(), '.runtime', 'tests'), 'feed-'));
  const stores: FeedStore[] = [];
  t.after(() => { for (const store of stores) store.close(); rmSync(root, { recursive: true, force: true }); });
  const open = () => { const store = new FeedStore(root); stores.push(store); return { store, feed: new FeedService(store) }; };
  return { root, open, ...open() };
}

test('manual text persists independently of a project', t => {
  const f = fixture(t);
  const receipt = f.feed.mutate({ operation: 'createText', input: { title: '资料', body: '原始文字', coverage: 'full' }, requestId: 'save-1' }, { kind: 'user' });
  assert.equal(receipt.outcome, 'new');
  assert.equal(receipt.revision, 1);
  assert.equal(f.feed.getEntry(receipt.entryId).body, '原始文字');
  f.store.close();
  const reopened = f.open().feed;
  assert.equal(reopened.getEntry(receipt.entryId).publishedAt, null);
  assert.equal(reopened.query({ view: 'all' }).items.length, 1);
});

test('distinct results preserve each execution and existing personal state', t => {
  const { feed } = fixture(t);
  const first = feed.saveResult('first', material, agent);
  feed.mutate({ operation: 'saveNote', id: first.entryId, note: '我的备注', expectedRevision: 1, requestId: 'note' }, { kind: 'user' });
  feed.mutate({ operation: 'setStarred', id: first.entryId, starred: true, expectedRevision: 2, requestId: 'star' }, { kind: 'user' });
  feed.mutate({ operation: 'setRead', id: first.entryId, read: true, expectedRevision: 3, requestId: 'read' }, { kind: 'user' });
  const before = feed.getEntry(first.entryId);
  const repeated = feed.saveResult('again', { ...material, title: '新标题', body: '新正文', sourceUrl: 'https://example.com/article?q=1#different' }, { ...agent, collectionId: 'collection-2' });
  const after = feed.getEntry(first.entryId);
  assert.equal(repeated.outcome, 'new');
  assert.notEqual(repeated.entryId, first.entryId);
  assert.equal(feed.getEntry(repeated.entryId).body, '新正文');
  assert.equal(feed.getEntry(repeated.entryId).title, '新标题');
  assert.equal(after.firstCollectedAt, before.firstCollectedAt);
  assert.equal(after.note, '我的备注');
  assert.equal(after.starred, true);
  assert.equal(after.readAt, before.readAt);
  assert.equal(after.body, '正文');
  assert.equal(after.discoveries.items.length, 1);
  assert.equal(feed.query({ collectionId: 'collection-2' }).items[0].id, repeated.entryId);
});

test('receipt_replay_survives_restart', t => {
  const f = fixture(t);
  const originalReceipt = f.feed.saveResult('stable-request', material, agent);
  f.store.close();
  const { feed } = f.open();
  const revision = feed.query({}).revision;
  const replayedReceipt = feed.saveResult('stable-request', { coverage: 'full', sourceUrl: material.sourceUrl, body: '正文', title: '资料' }, { ...agent, callId: 'retry-call' });
  assert.deepEqual(replayedReceipt, originalReceipt);
  assert.equal(feed.query({ view: 'all' }).items.length, 1);
  assert.equal(feed.query({}).revision, revision);
  assert.equal(feed.getEntry(originalReceipt.entryId).discoveries.items.length, 1);
  assert.throws(() => feed.saveResult('stable-request', { ...material, body: '不同参数' }, agent), /请求.*冲突/);
  assert.throws(() => feed.saveResult('stable-request', material, { ...agent, threadId: 'forged-thread' }), /请求.*冲突/);
});

test('new result using a deleted source stays distinct from the original tombstone', t => {
  const { feed } = fixture(t), original = feed.saveResult('first', material, agent);
  const deleted = feed.mutate({ operation: 'delete', id: original.entryId, expectedRevision: 1, requestId: 'delete' }, { kind: 'user' });
  const deletedReceipt = feed.saveResult('rediscovery', material, agent);
  assert.equal(deletedReceipt.outcome, 'new');
  assert.notEqual(deletedReceipt.entryId, original.entryId);
  assert.equal(feed.query({ view: 'all' }).items.length, 1);
  assert.equal(feed.query({ view: 'trash' }).items[0].id, original.entryId);
  assert.ok(feed.getEntry(original.entryId).deletedAt);
  feed.mutate({ operation: 'restore', id: original.entryId, expectedRevision: deleted.revision, requestId: 'undo' }, { kind: 'user' });
  assert.equal(feed.query({ view: 'all' }).items.length, 2);
  assert.equal(feed.getEntry(original.entryId).discoveries.items.length, 1);
});

test('stale_note_rejected and draft revisions survive retries and restart', t => {
  const f = fixture(t), { entryId } = f.feed.saveResult('first', material, agent);
  const note = { operation: 'saveNote' as const, id: entryId, expectedRevision: 1, requestId: 'note', note: '已保存的备注' };
  const receipt = f.feed.mutate(note, { kind: 'user' });
  assert.deepEqual(f.feed.mutate(note, { kind: 'user' }), receipt);
  assert.throws(() => f.feed.mutate({ ...note, note: '过期备注', requestId: 'stale' }, { kind: 'user' }), /版本冲突/);
  assert.equal(f.feed.getEntry(entryId).note, '已保存的备注');
  assert.equal(f.feed.readDraft('new-text'), null);
  const first = f.feed.saveDraft({ key: 'new-text', text: '未完成文字' }, 0, 'draft-1');
  assert.equal(first.revision, 1);
  assert.deepEqual(f.feed.saveDraft({ key: 'new-text', text: '未完成文字' }, 0, 'draft-1'), first);
  const second = f.feed.saveDraft({ key: 'new-text', text: '' }, 1, 'draft-2');
  assert.throws(() => f.feed.saveDraft({ key: 'new-text', text: '迟到文字' }, 1, 'draft-stale'), /版本冲突/);
  f.store.close();
  assert.deepEqual(f.open().feed.readDraft('new-text'), second);
});

test('search, personal views and collection filters compose with stable cursor pages', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1800000000000 });
  const { feed } = fixture(t);
  const first = feed.saveResult('first', { ...material, title: 'title needle', body: 'first', sourceUrl: undefined }, agent);
  t.mock.timers.tick(1);
  const second = feed.mutate({ operation: 'createText', requestId: 'second', input: { title: 'second', body: 'body needle', aiSummary: 'summary only', coverage: 'excerpt' } }, { kind: 'user' });
  t.mock.timers.tick(1);
  const third = feed.saveResult('third', { ...material, title: 'third', aiSummary: 'summary needle', sourceUrl: 'https://example.com/third' }, agent);
  feed.mutate({ operation: 'saveNote', id: third.entryId, note: 'note only', expectedRevision: 1, requestId: 'note' }, { kind: 'user' });
  feed.mutate({ operation: 'setStarred', id: third.entryId, starred: true, expectedRevision: 2, requestId: 'star' }, { kind: 'user' });
  feed.mutate({ operation: 'setRead', id: third.entryId, read: true, expectedRevision: 3, requestId: 'read' }, { kind: 'user' });
  const page = feed.query({ text: 'needle', limit: 2 });
  assert.deepEqual(page.items.map(item => item.id), [third.entryId, second.entryId]);
  assert.ok(page.nextCursor);
  const last = feed.query({ text: 'needle', limit: 2, cursor: page.nextCursor! });
  assert.deepEqual(last.items.map(item => item.id), [first.entryId]);
  assert.equal(last.nextCursor, null);
  assert.deepEqual(feed.query({ view: 'unread', collectionId: 'collection-1', text: 'needle' }).items.map(item => item.id), [first.entryId]);
  assert.deepEqual(feed.query({ view: 'saved', text: 'note only' }).items.map(item => item.id), [third.entryId]);
  assert.deepEqual(feed.query({ collectionId: 'manual', text: 'summary only' }).items.map(item => item.id), [second.entryId]);
  assert.throws(() => feed.query({ text: 'changed query', cursor: page.nextCursor! }), /游标/);
  assert.equal(Object.hasOwn(page.items[0], 'body'), false);
  assert.equal(Object.hasOwn(page.items[0], 'note'), false);
});

test('strict text/state/draft payloads reject forged identities, fields and oversized input atomically', t => {
  const { feed } = fixture(t), before = feed.query({}).revision;
  const invalidInputs: unknown[] = [
    { ...material, title: '' }, { ...material, title: 'x'.repeat(513) }, { ...material, body: '中'.repeat(87382) },
    { ...material, coverage: 'invented' }, { ...material, publishedAt: 'yesterday' }, { ...material, publishedAt: '2026-02-30T00:00:00Z' },
    { ...material, aiSummary: 'x'.repeat(131073) }, { ...material, referenceEntryIds: ['missing'] },
    { ...material, referenceEntryIds: Array(51).fill('entry') }, { ...material, firstCollectedAt: '2000-01-01' },
  ];
  for (const input of invalidInputs) assert.throws(() => feed.saveResult('invalid', input as FeedEntryInput, agent));
  assert.throws(() => feed.saveResult('bad-agent', material, { ...agent, runId: '' }));
  assert.throws(() => feed.mutate({ operation: 'createText', input: material, requestId: 'bad-user' }, agent as any));
  assert.throws(() => feed.mutate({ operation: 'createText', input: material, requestId: 'bad-field', actor: agent } as any, { kind: 'user' }));
  assert.throws(() => feed.saveDraft({ key: 'draft', text: 'x', revision: 9 } as any, 0, 'draft-forged'));
  assert.throws(() => feed.saveDraft({ key: '', text: 'x' }, 0, 'empty-draft'));
  assert.throws(() => feed.query({ limit: 201 }));
  assert.throws(() => feed.query({ limit: 0 }));
  assert.throws(() => feed.query({ limit: 1.5 }));
  assert.throws(() => feed.query({ view: 'unknown' } as any));
  assert.equal(feed.query({}).revision, before);
  assert.equal(feed.query({}).items.length, 0);
  const saved = feed.saveResult('valid', material, agent);
  for (const mutation of [
    { operation: 'setRead', read: 'true' }, { operation: 'setStarred', starred: 1 },
    { operation: 'saveNote', note: 'x'.repeat(131073) }, { operation: 'saveNote', note: 'valid', starred: true },
    { operation: 'unexpected' },
  ]) assert.throws(() => feed.mutate({ ...mutation, id: saved.entryId, expectedRevision: 1, requestId: 'bad-edit' } as any, { kind: 'user' }));
  assert.equal(feed.getEntry(saved.entryId).revision, 1);
});

test('path_links_rejected and URL normalization preserves path and query meaning', t => {
  const { feed } = fixture(t);
  for (const sourceUrl of ['file:///G:/secrets', 'javascript:alert(1)', 'data:text/plain,hello', '//example.com', 'https://name:password@example.com/a', 'https://@example.com/a', 'https://example.com\\path', ' https://example.com/a', 'https://example.com/\npath']) {
    assert.throws(() => feed.saveResult('bad-url', { ...material, sourceUrl }, agent), `must reject ${JSON.stringify(sourceUrl)}`);
  }
  const sourceUrl = 'https://EXAMPLE.com:443/a/../b?x=%2f&y=2&y=1#section';
  const result = feed.saveResult('safe-url', { ...material, sourceUrl }, agent);
  assert.equal(feed.getEntry(result.entryId).sourceUrl, 'https://example.com/a/../b?x=%2f&y=2&y=1');
  assert.equal(feed.saveResult('changed-query', { ...material, sourceUrl: 'https://example.com/a/../b?x=%2f&y=1&y=2' }, agent).outcome, 'new');
});

test('identical text results remain distinct while historical discoveries and deleted references stay readable', t => {
  const { feed, store } = fixture(t);
  const first = feed.saveResult('text-first', { title: '无来源', body: '第一行\r\n第二行', coverage: 'partial' }, agent);
  const duplicate = feed.saveResult('text-again', { title: '同正文', body: '第一行\n第二行', coverage: 'excerpt' }, agent);
  assert.notEqual(duplicate.entryId, first.entryId);
  assert.equal(duplicate.outcome, 'new');
  const one = feed.mutate({ operation: 'createText', input: { title: '手动', body: '第一行\n第二行', coverage: 'full' }, requestId: 'manual-1' }, { kind: 'user' });
  const two = feed.mutate({ operation: 'createText', input: { title: '手动', body: '第一行\n第二行', coverage: 'full' }, requestId: 'manual-2' }, { kind: 'user' });
  assert.notEqual(one.entryId, two.entryId);
  const research = feed.saveResult('research', { title: '研究', body: '研究结果', coverage: 'full', referenceEntryIds: [one.entryId] }, agent);
  feed.mutate({ operation: 'delete', id: one.entryId, expectedRevision: 1, requestId: 'delete-ref' }, { kind: 'user' });
  assert.deepEqual(feed.getEntry(research.entryId).references.map(ref => [ref.id, ref.title, !!ref.deletedAt]), [[one.entryId, '手动', true]]);
  // Seed legacy discoveries to exercise pagination for existing stored data.
  store.transaction(() => { for (let i = 0; i < 51; i++) store.db.prepare('INSERT INTO feed_discoveries(entry_id,collection_id,actor,collected_at) VALUES(?,?,?,?)').run(first.entryId, agent.collectionId, JSON.stringify(agent), '2026-10-29T00:00:00Z'); });
  const page = feed.getEntry(first.entryId).discoveries;
  assert.equal(page.items.length, 50);
  assert.ok(page.nextCursor);
  const rest = feed.getEntry(first.entryId, page.nextCursor!).discoveries;
  assert.equal(rest.items.length, 2);
  assert.equal(rest.nextCursor, null);
  assert.equal(new Set([...page.items, ...rest.items].map(item => item.id)).size, 52);
  assert.throws(() => feed.getEntry(research.entryId, page.nextCursor!), /游标/);
});

test('distinct executions retain same-URL result bodies while each request replays once', t => {
  const { feed } = fixture(t);
  const first = feed.saveResult('result', { ...material, title: 'Day one', body: 'First analysis' }, agent);
  const laterActor = { ...agent, runId: 'run-2', turnId: 'turn-2' };
  const laterInput = { ...material, title: 'Day two', body: 'Changed analysis' };
  const second = feed.saveResult('result', laterInput, laterActor);
  assert.notEqual(second.entryId, first.entryId);
  assert.equal(feed.getEntry(first.entryId).body, 'First analysis');
  assert.equal(feed.getEntry(second.entryId).body, 'Changed analysis');
  assert.equal(feed.getEntry(second.entryId).title, 'Day two');
  assert.deepEqual(feed.saveResult('result', laterInput, { ...laterActor, callId: 'retry' }), second);
  assert.equal(feed.query({}).items.length, 2);
});
