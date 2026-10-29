import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  store.db.exec('PRAGMA user_version=3'); store.close();
  const file = insideProject(directory, join(directory, '.runtime', 'client', 'feed', 'feed.sqlite')), saved = readFileSync(file);
  assert.throws(() => new FeedStore(directory), /版本/);
  assert.deepEqual(readFileSync(file), saved);
  const migration = new DatabaseSync(file);
  migration.exec('PRAGMA user_version=2'); migration.close();
  const reopened = new FeedStore(directory);
  try { assert.equal(new FeedService(reopened).getEntry(receipt.entryId).body, '保留的文字'); } finally { reopened.close(); }
});

test('version one entries and receipts survive the collection schema migration', t => {
  const f = fixture(t), store = f.open(), feed = new FeedService(store);
  const input = { operation: 'createText' as const, input: { title: 'Version one', body: 'Original text', coverage: 'full' as const }, requestId: 'migration' };
  const receipt = feed.mutate(input, { kind: 'user' });
  store.db.exec('DROP TABLE feed_history; DROP TABLE feed_source_failures; DROP TABLE feed_runs; DROP TABLE feed_collections; PRAGMA user_version=1'); store.close();
  const migrated = f.open(), service = new FeedService(migrated);
  assert.equal(service.getEntry(receipt.entryId).body, 'Original text');
  assert.deepEqual(service.mutate(input, { kind: 'user' }), receipt);
  assert.equal(Number(migrated.db.prepare('PRAGMA user_version').get()!.user_version), 2);
});

test('personal storage rejects C drive and directory-link ancestors', t => {
  assert.throws(() => new FeedStore('C:\\mixcat-feed-test'), /非 C 盘/);
  const { directory } = fixture(t), client = projectDirectory(directory, '.runtime', 'client'), target = projectDirectory(directory, 'linked-target');
  const link = insideProject(directory, join(client, 'feed'));
  symlinkSync(target, link, 'junction');
  assert.throws(() => new FeedStore(directory), /符号链接|目录联接/);
  rmSync(link);
});

test('linked SQLite sidecars are rejected before either database can write to their targets', t => {
  const f = fixture(t), initial = f.open(); initial.close();
  const data = projectDirectory(f.directory, '.runtime', 'client', 'feed');
  for (const targetExists of [true, false]) for (const database of ['feed.sqlite', 'writer.sqlite']) for (const suffix of ['-wal', '-shm', '-journal']) {
    const target = insideProject(f.directory, join(f.directory, `${database}${suffix}-${targetExists}-target`));
    const link = insideProject(f.directory, join(data, `${database}${suffix}`));
    if (targetExists) writeFileSync(target, '');
    symlinkSync(target, link, 'file');
    try {
      assert.throws(() => {
        const store = f.open();
        try { new FeedService(store).mutate({ operation: 'createText', input: { title: 'probe', body: 'probe', coverage: 'full' }, requestId: 'probe' }, { kind: 'user' }); }
        finally { store.close(); }
      }, /符号链接|目录联接/, `${database}${suffix}`);
      assert.equal(existsSync(target), targetExists, `${database}${suffix} must not create a missing target`);
      if (targetExists) assert.equal(readFileSync(target).length, 0, `${database}${suffix} target must stay empty`);
      assert.equal(lstatSync(link).isSymbolicLink(), true);
    } finally { rmSync(link, { force: true }); }
    const reopened = f.open();
    assert.equal(new FeedService(reopened).query({}).items.length, 0);
    reopened.close();
  }
});

test('hard-linked SQLite database files and sidecars are rejected before opening', t => {
  for (const database of ['feed.sqlite', 'writer.sqlite']) for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const f = fixture(t), data = projectDirectory(f.directory, '.runtime', 'client', 'feed');
    const target = insideProject(f.directory, join(f.directory, 'hardlink-target'));
    const link = insideProject(f.directory, join(data, `${database}${suffix}`));
    writeFileSync(target, ''); linkSync(target, link);
    try {
      assert.throws(() => {
        const store = f.open();
        try { new FeedService(store).mutate({ operation: 'createText', input: { title: 'probe', body: 'probe', coverage: 'full' }, requestId: 'probe' }, { kind: 'user' }); }
        finally { store.close(); }
      }, /硬链接/, `${database}${suffix}`);
      assert.equal(readFileSync(target).length, 0);
      assert.equal(lstatSync(target).nlink, 2);
    } finally { rmSync(link, { force: true }); }
    const reopened = f.open();
    assert.equal(new FeedService(reopened).query({}).items.length, 0);
    reopened.close();
  }
});
