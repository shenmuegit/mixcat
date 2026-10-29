import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FeedStore } from '../src/core/feed-store.js';
import { FeedService } from '../src/core/feed.js';
import { insideProject, projectDirectory } from '../src/core/paths.js';

function fixture(t: TestContext) {
  const directory = insideProject(process.cwd(), mkdtempSync(resolve(projectDirectory(process.cwd(), '.runtime', 'tests'), 'feed-store-')));
  const stores: FeedStore[] = [];
  t.after(() => { for (const store of stores) store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, open() { const store = new FeedStore(directory); stores.push(store); return store; } };
}

test('save_failure_is_atomic for entries, discoveries, revisions and persisted receipts', t => {
  const store = fixture(t).open(), feed = new FeedService(store);
  const input = { operation: 'createText' as const, input: { title: '资料', body: '文本', coverage: 'full' as const }, requestId: 'atomic' };
  store.db.exec("CREATE TEMP TRIGGER fail_receipt BEFORE INSERT ON feed_receipts BEGIN SELECT RAISE(ABORT,'injected write failure'); END");
  assert.throws(() => feed.mutate(input, { kind: 'user' }), /injected write failure/);
  assert.deepEqual(feed.query({}), { items: [], nextCursor: null, revision: 0 });
  store.db.exec('DROP TRIGGER fail_receipt');
  const receipt = feed.mutate(input, { kind: 'user' });
  assert.equal(receipt.outcome, 'new');
  assert.equal(feed.getEntry(receipt.entryId).discoveries.items.length, 1);
  assert.deepEqual(feed.mutate(input, { kind: 'user' }), receipt);
});

test('an outer transaction rollback also rolls back service savepoints and draft receipts', t => {
  const store = fixture(t).open(), feed = new FeedService(store);
  assert.throws(() => store.transaction(() => {
    feed.saveDraft({ key: 'draft', text: '保留输入' }, 0, 'draft-request');
    feed.mutate({ operation: 'createText', input: { title: '资料', body: '文本', coverage: 'full' }, requestId: 'entry-request' }, { kind: 'user' });
    throw new Error('cancel transaction');
  }), /cancel transaction/);
  assert.equal(feed.readDraft('draft'), null);
  assert.equal(feed.query({}).items.length, 0);
  assert.equal(feed.query({}).revision, 0);
  assert.equal(feed.saveDraft({ key: 'draft', text: '保留输入' }, 0, 'draft-request').revision, 1);
});

test('a second personal writer is rejected until the owner closes', t => {
  const f = fixture(t), directory = f.directory, store = f.open();
  assert.throws(() => new FeedStore(directory), /其他工作台/);
  store.close();
  const reopened = new FeedStore(directory);
  try { assert.equal(reopened.revision, 0); } finally { reopened.close(); }
});

test('a corrupt SQLite file is reported without replacement and failed open releases ownership', t => {
  const { directory } = fixture(t), data = projectDirectory(directory, '.runtime', 'client', 'feed'), file = insideProject(directory, join(data, 'feed.sqlite'));
  const damaged = Buffer.from('this is damaged SQLite data');
  writeFileSync(file, damaged);
  assert.throws(() => new FeedStore(directory), /database|file/i);
  assert.deepEqual(readFileSync(file), damaged);
  rmSync(file);
  const recovered = new FeedStore(directory);
  recovered.close();
});

test('a damaged ownership database reports storage corruption instead of another active writer', t => {
  const { directory } = fixture(t), data = projectDirectory(directory, '.runtime', 'client', 'feed');
  const file = insideProject(directory, join(data, 'writer.sqlite')), damaged = Buffer.from('damaged writer database');
  writeFileSync(file, damaged);
  assert.throws(() => new FeedStore(directory), /database|file/i);
  assert.deepEqual(readFileSync(file), damaged);
});

test('a newer schema is rejected without resetting its data', t => {
  const f = fixture(t), directory = f.directory, store = f.open(), feed = new FeedService(store);
  const receipt = feed.mutate({ operation: 'createText', input: { title: '资料', body: '保留的文字', coverage: 'full' }, requestId: 'save' }, { kind: 'user' });
  store.db.exec('PRAGMA user_version=2'); store.close();
  const file = insideProject(directory, join(directory, '.runtime', 'client', 'feed', 'feed.sqlite')), saved = readFileSync(file);
  assert.throws(() => new FeedStore(directory), /版本/);
  assert.deepEqual(readFileSync(file), saved);
  const migration = new DatabaseSync(file);
  migration.exec('PRAGMA user_version=1'); migration.close();
  const reopened = new FeedStore(directory);
  try { assert.equal(new FeedService(reopened).getEntry(receipt.entryId).body, '保留的文字'); } finally { reopened.close(); }
});

test('personal storage rejects C drive and directory-link ancestors', t => {
  assert.throws(() => new FeedStore('C:\\mixcat-feed-test'), /非 C 盘/);
  const { directory } = fixture(t), client = projectDirectory(directory, '.runtime', 'client'), target = projectDirectory(directory, 'linked-target');
  const link = insideProject(directory, join(client, 'feed'));
  symlinkSync(target, link, 'junction');
  assert.throws(() => new FeedStore(directory), /符号链接|目录联接/);
  rmSync(link);
});
