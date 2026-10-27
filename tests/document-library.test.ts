import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, until } from './runtime-fixture.js';
import { WorkflowEngine } from '../src/core/engine.js';
import { scanProjectDocuments } from '../src/core/document-discovery.js';
import { itemLink } from '../src/shared/project-items.js';
import { DatabaseSync } from 'node:sqlite';

test('project Markdown materials appear without registration and keep their identity across scans and restart', async t => {
  const f = await fixture(t);
  mkdirSync(join(f.root, 'docs/design'), { recursive: true });
  writeFileSync(join(f.root, 'docs/design/需求.md'), '# 需求\n\n节点直接写出的资料。');
  writeFileSync(join(f.root, 'docs/进展.markdown'), '# 进展');
  writeFileSync(join(f.root, 'README.md'), 'not a workflow material directory');
  const query = { type: 'search_project_items' as const, projectId: f.projectId, query: { kind: 'document' as const } };
  const first = (await f.engine.command(query)).projectItems!;
  assert.deepEqual(first.items.map(item => item.path).sort(), ['docs/design/需求.md', 'docs/进展.markdown']);
  const repeated = (await f.engine.command(query)).projectItems!;
  assert.deepEqual(repeated.items.map(item => item.id), first.items.map(item => item.id));
  assert.equal(repeated.revision, first.revision);
  const detail = (await f.engine.command({ type: 'get_project_item', projectId: f.projectId, itemId: first.items[0].id })).projectItem!;
  assert.equal(detail.events[0].actor.kind, 'external');
  await f.engine.close();
  const reopened = new WorkflowEngine({ workbenchRoot: f.root, executable: 'unused', nativeFactory() { assert.fail(); } });
  t.after(() => reopened.close()); await reopened.init();
  assert.deepEqual((await reopened.command(query)).projectItems!.items.map(item => item.id), first.items.map(item => item.id));
});

test('document summaries expose file modification time without turning metadata reads into edits', async t => {
  const f = await fixture(t); mkdirSync(join(f.root, 'docs'));
  const file = join(f.root, 'docs/time.md'), original = new Date('2024-01-02T03:04:05Z');
  writeFileSync(file, '# 原有资料'); utimesSync(file, original, original);
  const query = { type: 'search_project_items' as const, projectId: f.projectId, query: { kind: 'document' as const } };
  const first = (await f.engine.command(query)).projectItems!;
  assert.equal(first.items[0].fileModifiedAt, original.toISOString());
  const later = new Date('2025-05-06T07:08:09Z'); utimesSync(file, later, later);
  const next = (await f.engine.command(query)).projectItems!;
  assert.equal(next.items[0].fileModifiedAt, later.toISOString());
  assert.equal(next.revision, first.revision); assert.equal(next.items[0].revision, first.items[0].revision);
});

test('interrupted deletion recovers once and cancelling an already committed journal does not restore the file', async t => {
  const f = await fixture(t);
  const doc = (await f.engine.command({ type: 'update_project_item', projectId: f.projectId, input: { request_id: 'recovery-doc', operation: 'create', kind: 'document', title: '恢复删除', path: 'docs/recover-delete.md', body: '# 可恢复正文' } })).projectItem!;
  const db = new DatabaseSync(join(f.root, '.mixcat/state/workflow.sqlite'));
  db.exec("CREATE TRIGGER reject_library BEFORE UPDATE ON project_state BEGIN SELECT RAISE(FAIL, 'injected delete commit failure'); END");
  const command = { type: 'update_project_item' as const, projectId: f.projectId, input: { request_id: 'recover-delete', operation: 'delete' as const, id: doc.item.id, expected_revision: doc.item.revision, expected_hash: doc.hash } };
  await assert.rejects(f.engine.command(command), /injected delete commit failure/);
  const journal = readFileSync(join(f.root, '.mixcat/state/document-pending.json'), 'utf8');
  assert.equal(existsSync(join(f.root, 'docs/recover-delete.md')), false);
  db.exec('DROP TRIGGER reject_library'); db.close(); await f.engine.close();
  const reopened = new WorkflowEngine({ workbenchRoot: f.root, executable: 'unused', nativeFactory() { assert.fail(); } });
  t.after(() => reopened.close()); await reopened.init();
  const replay = (await reopened.command(command)).projectItem!;
  assert(replay.item.deletedAt); assert.equal(replay.item.body, '# 可恢复正文');
  writeFileSync(join(f.root, '.mixcat/state/document-pending.json'), journal);
  await reopened.command({ type: 'cancel_document_write', projectId: f.projectId, recoveryId: JSON.parse(journal).id });
  assert.equal(existsSync(join(f.root, 'docs/recover-delete.md')), false);
  assert((await reopened.command({ type: 'get_project_item', projectId: f.projectId, itemId: doc.item.id })).projectItem!.item.deletedAt);
});

test('cancelling an interrupted restore returns the file to the recycle area without losing its body', async t => {
  const f = await fixture(t);
  const change = async (input: any) => (await f.engine.command({ type: 'update_project_item', projectId: f.projectId, input })).projectItem!;
  const doc = await change({ request_id: 'cancel-doc', operation: 'create', kind: 'document', title: '取消恢复', path: 'docs/cancel.md', body: '# 回收正文' });
  writeFileSync(join(f.root, 'docs/cancel.md'), '# 外部新内容');
  await assert.rejects(change({ request_id: 'stale-delete', operation: 'delete', id: doc.item.id, expected_revision: doc.item.revision, expected_hash: doc.hash }), /冲突/);
  const fresh = (await f.engine.command({ type: 'get_project_item', projectId: f.projectId, itemId: doc.item.id })).projectItem!;
  const deleted = await change({ request_id: 'cancel-delete', operation: 'delete', id: doc.item.id, expected_revision: fresh.item.revision, expected_hash: fresh.hash });
  const db = new DatabaseSync(join(f.root, '.mixcat/state/workflow.sqlite'));
  db.exec("CREATE TRIGGER reject_library BEFORE UPDATE ON project_state BEGIN SELECT RAISE(FAIL, 'injected restore commit failure'); END");
  await assert.rejects(change({ request_id: 'cancel-restore', operation: 'restore', id: doc.item.id, expected_revision: deleted.item.revision, expected_hash: deleted.hash, path: 'docs/returned.md' }), /injected restore commit failure/);
  db.exec('DROP TRIGGER reject_library'); db.close();
  const recovery = (await f.engine.command({ type: 'search_project_items', projectId: f.projectId })).projectItems!.recovery!;
  await f.engine.command({ type: 'cancel_document_write', projectId: f.projectId, recoveryId: recovery.id });
  assert.equal(existsSync(join(f.root, 'docs/returned.md')), false);
  const result = (await f.engine.command({ type: 'get_project_item', projectId: f.projectId, itemId: doc.item.id })).projectItem!;
  assert(result.item.deletedAt); assert.equal(result.item.body, '# 外部新内容');
});

test('recovery rejects journals with missing or inconsistent document identities before moving files', async t => {
  for (const { name, corrupt } of [
    { name: 'missing item ID', corrupt: (entry: any) => { delete entry.itemId; } },
    { name: 'unknown item ID', corrupt: (entry: any) => { entry.itemId = 'unrelated-document'; } },
    { name: 'different document path', corrupt: (entry: any) => { entry.next.items.find((item: any) => item.id === entry.itemId).path = 'docs/other.md'; } },
  ]) await t.test(name, async t => {
    const f = await fixture(t);
    const doc = (await f.engine.command({ type: 'update_project_item', projectId: f.projectId, input: { request_id: 'journal-doc', operation: 'create', kind: 'document', title: '恢复边界', path: 'docs/journal.md', body: '# 原始资料' } })).projectItem!;
    const db = new DatabaseSync(join(f.root, '.mixcat/state/workflow.sqlite'));
    db.exec("CREATE TRIGGER reject_library BEFORE UPDATE ON project_state BEGIN SELECT RAISE(FAIL, 'injected journal commit failure'); END");
    await assert.rejects(f.engine.command({ type: 'update_project_item', projectId: f.projectId, input: { request_id: 'journal-delete', operation: 'delete', id: doc.item.id, expected_revision: doc.item.revision, expected_hash: doc.hash } }), /injected journal commit failure/);
    db.exec('DROP TRIGGER reject_library'); db.close(); await f.engine.close();
    // Model interruption before the file move, then corrupt the published journal.
    renameSync(join(f.root, '.mixcat/document-trash', `${doc.item.id}.md`), join(f.root, 'docs/journal.md'));
    const journalPath = join(f.root, '.mixcat/state/document-pending.json'), entry = JSON.parse(readFileSync(journalPath, 'utf8'));
    corrupt(entry); const bytes = JSON.stringify(entry); writeFileSync(journalPath, bytes);
    const reopened = new WorkflowEngine({ workbenchRoot: f.root, executable: 'unused', nativeFactory() { assert.fail(); } });
    t.after(() => reopened.close()); await reopened.init();
    const page = (await reopened.command({ type: 'search_project_items', projectId: f.projectId })).projectItems!;
    assert.match(page.recovery?.message ?? '', /损坏|无效/);
    assert.equal(readFileSync(join(f.root, 'docs/journal.md'), 'utf8'), '# 原始资料');
    await reopened.command({ type: 'cancel_document_write', projectId: f.projectId, recoveryId: page.recovery!.id });
    assert.equal(readFileSync(join(f.root, '.mixcat/state', `document-cancelled-${page.recovery!.id}.json`), 'utf8'), bytes);
    assert.equal(readFileSync(join(f.root, 'docs/journal.md'), 'utf8'), '# 原始资料');
  });
});

test('document deletion moves the file to a project recycle area and restores its identity without overwriting', async t => {
  const f = await fixture(t);
  const change = async (input: any) => (await f.engine.command({ type: 'update_project_item', projectId: f.projectId, input })).projectItem!;
  const doc = await change({ request_id: 'doc', operation: 'create', kind: 'document', title: '可删除资料', path: 'docs/removable.md', body: '# 保留这份正文' });
  const todo = await change({ request_id: 'todo-ref', operation: 'create', kind: 'todo', title: '引用资料', body: itemLink(f.projectId, doc.item) });
  const input = { request_id: 'delete-doc', operation: 'delete', id: doc.item.id, expected_revision: doc.item.revision, expected_hash: doc.hash };
  const deleted = await change(input);
  assert(deleted.item.deletedAt); assert(deleted.item.archived); assert.equal(deleted.item.body, '# 保留这份正文');
  assert.equal(existsSync(join(f.root, 'docs/removable.md')), false);
  assert(deleted.backlinks.some(link => link.itemId === todo.item.id));
  assert.equal((await change(input)).item.revision, deleted.item.revision);
  assert.equal((await f.engine.command({ type: 'search_project_items', projectId: f.projectId, query: { kind: 'document' } })).projectItems!.total, 0);
  writeFileSync(join(f.root, 'docs/removable.md'), '后来产生的另一份文件');
  await assert.rejects(change({ request_id: 'restore-occupied', operation: 'restore', id: deleted.item.id, expected_revision: deleted.item.revision, expected_hash: deleted.hash }), /存在|占用|覆盖/);
  const restored = await change({ request_id: 'restore-elsewhere', operation: 'restore', id: deleted.item.id, expected_revision: deleted.item.revision, expected_hash: deleted.hash, path: 'docs/restored.md' });
  assert.equal(restored.item.id, doc.item.id); assert.equal(restored.item.deletedAt, undefined); assert.equal(restored.item.archived, false);
  assert.equal(readFileSync(join(f.root, 'docs/removable.md'), 'utf8'), '后来产生的另一份文件');
  assert.equal(readFileSync(join(f.root, 'docs/restored.md'), 'utf8'), '# 保留这份正文');
});

test('document discovery reports unreadable materials and refuses links and dependency directories', async t => {
  const f = await fixture(t);
  mkdirSync(join(f.root, 'docs/node_modules'), { recursive: true }); mkdirSync(join(f.root, 'private'));
  writeFileSync(join(f.root, 'docs/good.md'), '# 正常资料');
  writeFileSync(join(f.root, 'docs/bad.md'), Buffer.from([0xff]));
  writeFileSync(join(f.root, 'docs/large.md'), 'x'.repeat(262145));
  writeFileSync(join(f.root, 'docs/node_modules/package.md'), 'not project material');
  writeFileSync(join(f.root, 'private/internal.md'), 'linked content must not be read');
  linkSync(join(f.root, 'private/internal.md'), join(f.root, 'docs/hard.md'));
  symlinkSync(join(f.root, 'private'), join(f.root, 'docs/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const page = (await f.engine.command({ type: 'search_project_items', projectId: f.projectId, query: { kind: 'document' } })).projectItems!;
  assert.deepEqual(page.items.map(item => item.path), ['docs/good.md']);
  for (const name of ['bad.md', 'large.md', 'hard.md', 'linked']) assert(page.documentWarnings?.some(message => message.includes(name)), name);
  const stable = (await f.engine.command({ type: 'search_project_items', projectId: f.projectId })).projectItems!;
  assert.equal(stable.revision, page.revision);
});

test('document scanning reports its file bound instead of claiming complete discovery', async t => {
  const f = await fixture(t); mkdirSync(join(f.root, 'docs'));
  for (let index = 0; index < 1001; index++) writeFileSync(join(f.root, 'docs', `${index}.md`), 'bounded scan');
  const scan = scanProjectDocuments(f.root);
  assert.equal(scan.paths.length, 1000); assert(scan.warnings.some(message => message.includes('未完整扫描')));
});

test('finishing a native turn publishes newly generated document metadata without a management read', async t => {
  const f = await fixture(t); await f.send('plan');
  let snapshot = (await f.engine.command({ type: 'snapshot', projectId: f.projectId })).snapshot.selected!;
  await until(() => f.clients[0].calls.some(call => call.method === 'turn/start'));
  snapshot = (await f.engine.command({ type: 'snapshot', projectId: f.projectId })).snapshot.selected!;
  const task = snapshot.tasks[0]; mkdirSync(join(f.root, 'docs')); writeFileSync(join(f.root, 'docs/result.md'), '# 节点成果');
  f.clients[0].options.onEvent({ method: 'turn/completed', params: { threadId: task.threadId, turn: { id: task.turnId, status: 'completed', items: [] } } });
  const after = (await f.engine.command({ type: 'snapshot', projectId: f.projectId })).snapshot.selected!;
  assert.equal(after.tasks[0].status, 'completed'); assert((after.managementRevision ?? 0) > (snapshot.managementRevision ?? 0));
});

test('discovery leaves matching moved files available for explicit stable-identity relinking', async t => {
  const f = await fixture(t);
  const doc = (await f.engine.command({ type: 'update_project_item', projectId: f.projectId, input: { request_id: 'source', operation: 'create', kind: 'document', title: '需求', path: 'docs/original.md', body: '# 同一份资料' } })).projectItem!.item;
  renameSync(join(f.root, 'docs/original.md'), join(f.root, 'docs/moved.md'));
  for (let i = 0; i < 2; i++) {
    const page = (await f.engine.command({ type: 'search_project_items', projectId: f.projectId, query: { kind: 'document' } })).projectItems!;
    assert.equal(page.total, 1); assert(page.documentWarnings?.some(message => message.includes('moved.md') && message.includes('重新关联')));
  }
  const latest = (await f.engine.command({ type: 'get_project_item', projectId: f.projectId, itemId: doc.id })).projectItem!;
  const restored = (await f.engine.command({ type: 'update_project_item', projectId: f.projectId, input: { request_id: 'relink', operation: 'relink', id: doc.id, expected_revision: latest.item.revision, path: 'docs/moved.md' } })).projectItem!;
  assert.equal(restored.item.id, doc.id); assert.equal(restored.item.body, '# 同一份资料');
  assert.equal((await f.engine.command({ type: 'search_project_items', projectId: f.projectId })).projectItems!.documentWarnings?.length ?? 0, 0);
});
