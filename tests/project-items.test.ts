import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkflowEngine } from '../src/core/engine.js';
import { fixture } from './runtime-fixture.js';
import type { ItemMutation } from '../src/shared/project-items.js';
import { linkSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function items(f: Awaited<ReturnType<typeof fixture>>) {
  let next = 0;
  return {
    async change(input: Omit<ItemMutation, 'request_id'>) { const result = await f.engine.command({ type: 'update_project_item', projectId: f.projectId, input: { request_id: `change-${++next}`, ...input } }); return result.projectItem!.item; },
    async get(id: string) { return (await f.engine.command({ type: 'get_project_item', projectId: f.projectId, itemId: id })).projectItem!; },
    async list(archived = false) { return (await f.engine.command({ type: 'search_project_items', projectId: f.projectId, query: { archived } })).projectItems!; },
  };
}

test('business items persist across restart and replay one durable creation', async t => {
  const f = await fixture(t);
  const command = { type: 'update_project_item', projectId: f.projectId, input: { request_id: 'create-one', operation: 'create', kind: 'todo', title: '准备验收' } };
  const created = await f.engine.command(command as any) as any;
  assert.equal(created.projectItem.item.title, '准备验收');
  const repeated = await f.engine.command(command as any) as any;
  assert.equal(repeated.itemReceipt.itemId, created.itemReceipt.itemId);
  await f.engine.close();
  const reopened = new WorkflowEngine({ workbenchRoot: f.root, executable: 'unused', nativeFactory() { assert.fail('Management must not start an Agent'); } });
  t.after(() => reopened.close()); await reopened.init();
  const result = await reopened.command({ type: 'search_project_items', projectId: f.projectId, query: {} } as any) as any;
  assert.equal(result.projectItems.items.length, 1);
  assert.equal(result.projectItems.items[0].id, created.itemReceipt.itemId);
  await assert.rejects(reopened.command({ ...command, input: { ...command.input, title: '另一个标题' } } as any), /请求|冲突/);
});

test('todo hierarchy prevents cycles and premature completion and restores the archived branch', async t => {
  const f = await fixture(t), api = items(f);
  let parent = await api.change({ operation: 'create', kind: 'todo', title: '验收闭环' });
  let child = await api.change({ operation: 'create', kind: 'todo', title: '验证引用', parentId: parent.id });
  const nested = await api.change({ operation: 'create', kind: 'todo', title: '反向引用', parentId: child.id });
  await assert.rejects(api.change({ operation: 'move', id: parent.id, expected_revision: parent.revision, parentId: nested.id }), /循环|后代/);
  await assert.rejects(api.change({ operation: 'edit', id: parent.id, expected_revision: parent.revision, status: 'done', reason: '已完成' }), /未完成/);
  await api.change({ operation: 'edit', id: nested.id, expected_revision: nested.revision, status: 'done', reason: '点击反向引用成功' });
  child = await api.change({ operation: 'edit', id: child.id, expected_revision: child.revision, status: 'done', reason: '引用已验证' });
  parent = await api.change({ operation: 'edit', id: parent.id, expected_revision: parent.revision, status: 'done', reason: '闭环验证通过' });
  await assert.rejects(api.change({ operation: 'create', kind: 'todo', title: '补充项目', parentId: parent.id }), /重开/);
  await api.change({ operation: 'reopen', id: child.id, expected_revision: child.revision, reason: '增加覆盖' });
  assert.equal((await api.get(parent.id)).item.status, 'todo');
  parent = (await api.get(parent.id)).item;
  parent = await api.change({ operation: 'archive', id: parent.id, expected_revision: parent.revision });
  assert.equal((await api.list()).total, 0);
  assert.equal((await api.list(true)).total, 3);
  await api.change({ operation: 'restore', id: parent.id, expected_revision: parent.revision });
  assert.equal((await api.list()).total, 3);
  assert.equal((await api.get(nested.id)).item.parentId, child.id);
});

test('issue comments and Markdown links produce stable backlinks while code examples do not', async t => {
  const f = await fixture(t), api = items(f);
  const todo = await api.change({ operation: 'create', kind: 'todo', title: '待修复' });
  const link = `[@T-1 待修复](mixcat://${f.projectId}/todo/${todo.id})`;
  let issue = await api.change({ operation: 'create', kind: 'issue', title: '引用缺陷', issueType: 'bug', body: `关联 ${link}` });
  let detail = await api.get(todo.id);
  assert.deepEqual(detail.backlinks.map(link => link.itemId), [issue.id]);
  issue = await api.change({ operation: 'comment', id: issue.id, expected_revision: issue.revision, body: `再次验证 ${link}` });
  assert.equal((await api.get(todo.id)).backlinks.filter(link => link.commentId).length, 1);
  await api.change({ operation: 'edit', id: todo.id, expected_revision: todo.revision, title: '引用问题修复', body: `[@I-1 引用缺陷](mixcat://${f.projectId}/issue/${issue.id})` });
  const found = (await f.engine.command({ type: 'search_project_items', projectId: f.projectId, query: { text: 'I-1' } })).projectItems!;
  assert.equal(found.items[0].id, issue.id, 'a direct number match precedes items mentioning that number');
  assert.equal((await api.get(issue.id)).references[0].id, todo.id);
  issue = await api.change({ operation: 'edit', id: issue.id, expected_revision: issue.revision, body: `示例：\`${link}\`\n\n\`\`\`md\n${link}\n\`\`\`` });
  assert.equal((await api.get(todo.id)).backlinks.length, 1, 'only the saved comment still references the todo');
  await assert.rejects(api.change({ operation: 'edit', id: issue.id, expected_revision: issue.revision, status: 'closed' }), /说明/);
  await assert.rejects(api.change({ operation: 'edit', id: issue.id, expected_revision: 1, title: '过期更新' }), /冲突/);
  issue = await api.change({ operation: 'edit', id: issue.id, expected_revision: issue.revision, status: 'closed', reason: '通过引用跳转验收' });
  assert.equal(issue.status, 'closed');
  detail = await api.get(issue.id);
  assert.equal(detail.events.at(-1)!.actor.kind, 'user');
  assert.equal(detail.events.at(-1)!.reason, '通过引用跳转验收');
});

test('documents keep real files authoritative and reject stale saves without losing either version', async t => {
  const f = await fixture(t), api = items(f);
  let doc = await api.change({ operation: 'create', kind: 'document', title: '验收说明', path: 'docs/acceptance.md', body: '# 验收\n第一版' });
  assert.equal(readFileSync(join(f.root, 'docs/acceptance.md'), 'utf8'), '# 验收\n第一版');
  const before = await api.get(doc.id);
  writeFileSync(join(f.root, doc.path!), '# 外部更新');
  await assert.rejects(api.change({ operation: 'edit', id: doc.id, expected_revision: doc.revision, expected_hash: before.hash, body: '# 过期草稿' }), /冲突|外部/);
  assert.equal(readFileSync(join(f.root, doc.path!), 'utf8'), '# 外部更新');
  const current = await api.get(doc.id);
  assert.equal(current.item.revision, doc.revision + 1);
  assert.equal(current.events.at(-1)!.actor.kind, 'external');
  doc = await api.change({ operation: 'edit', id: doc.id, expected_revision: current.item.revision, expected_hash: current.hash, body: '# 合并后的正文' });
  assert.equal((await api.get(doc.id)).item.body, '# 合并后的正文');
  const latest = await api.get(doc.id);
  doc = await api.change({ operation: 'move', id: doc.id, expected_revision: doc.revision, expected_hash: latest.hash, path: 'docs/moved/acceptance.md' });
  assert.equal(doc.id, before.item.id);
  assert.equal(readFileSync(join(f.root, doc.path!), 'utf8'), '# 合并后的正文');
  const registered = await api.change({ operation: 'register', kind: 'document', path: doc.path! });
  assert.equal(registered.id, doc.id);
  await assert.rejects(api.change({ operation: 'create', kind: 'document', title: '越界', path: '../escape.md' }), /目录|路径|内部/);
  await assert.rejects(api.change({ operation: 'create', kind: 'document', title: '控制数据', path: '.mixcat/test.md' }), /目录|路径|内部/);
  await assert.rejects(api.change({ operation: 'create', kind: 'document', title: '目录别名', path: '.mixcat /test.md' }), /目录|路径|内部/);
  await assert.rejects(api.change({ operation: 'create', kind: 'document', title: '大文档', path: 'large.md', body: '字'.repeat(90000) }), /256 KiB|大小|字节/);
});

test('a document replaced before a failed state commit is recovered once after restart', async t => {
  const f = await fixture(t), api = items(f);
  const doc = await api.change({ operation: 'create', kind: 'document', title: '恢复测试', path: 'recover.md', body: 'before' });
  const detail = await api.get(doc.id);
  const db = new DatabaseSync(join(f.root, '.mixcat/state/workflow.sqlite'));
  db.exec("CREATE TRIGGER reject_management BEFORE UPDATE ON project_state BEGIN SELECT RAISE(FAIL, 'injected storage failure'); END");
  const command = { type: 'update_project_item' as const, projectId: f.projectId, input: { request_id: 'recover-write', operation: 'edit' as const, id: doc.id, expected_revision: doc.revision, expected_hash: detail.hash, body: 'after' } };
  await assert.rejects(f.engine.command(command), /injected storage/);
  assert.equal(readFileSync(join(f.root, 'recover.md'), 'utf8'), 'after');
  assert((await api.list()).recovery);
  db.exec('DROP TRIGGER reject_management'); db.close(); await f.engine.close();
  const reopened = new WorkflowEngine({ workbenchRoot: f.root, executable: 'unused', nativeFactory() { assert.fail('Recovery must not start a model'); } });
  t.after(() => reopened.close()); await reopened.init();
  const replay = await reopened.command(command);
  assert.equal(replay.projectItem!.item.body, 'after');
  assert.equal(replay.projectItem!.item.revision, doc.revision + 1);
  assert.equal((await reopened.command({ type: 'search_project_items', projectId: f.projectId })).projectItems!.recovery, undefined);
});

test('recovery preserves a later external edit and allows the user to cancel the interrupted write', async t => {
  const f = await fixture(t), api = items(f);
  const doc = await api.change({ operation: 'create', kind: 'document', title: '冲突恢复', path: 'conflict.md', body: 'before' });
  const detail = await api.get(doc.id), db = new DatabaseSync(join(f.root, '.mixcat/state/workflow.sqlite'));
  db.exec("CREATE TRIGGER reject_management BEFORE UPDATE ON project_state BEGIN SELECT RAISE(FAIL, 'injected storage failure'); END");
  await assert.rejects(api.change({ operation: 'edit', id: doc.id, expected_revision: doc.revision, expected_hash: detail.hash, body: 'pending draft' }));
  db.exec('DROP TRIGGER reject_management'); db.close(); await f.engine.close();
  writeFileSync(join(f.root, 'conflict.md'), 'later external edit');
  const reopened = new WorkflowEngine({ workbenchRoot: f.root, executable: 'unused', nativeFactory() { assert.fail(); } });
  t.after(() => reopened.close()); await reopened.init();
  const page = (await reopened.command({ type: 'search_project_items', projectId: f.projectId })).projectItems!;
  assert.equal(readFileSync(join(f.root, 'conflict.md'), 'utf8'), 'later external edit');
  assert.equal(page.recovery!.draft, 'pending draft');
  await reopened.command({ type: 'cancel_document_write', projectId: f.projectId, recoveryId: page.recovery!.id });
  assert.equal((await reopened.command({ type: 'search_project_items', projectId: f.projectId })).projectItems!.recovery, undefined);
  assert.equal(readFileSync(join(f.root, 'conflict.md'), 'utf8'), 'later external edit');
});

test('public item operations enforce ordering, field validation and linked-file boundaries', async t => {
  const f = await fixture(t), api = items(f);
  const a = await api.change({ operation: 'create', kind: 'todo', title: 'A' });
  const b = await api.change({ operation: 'create', kind: 'todo', title: 'B' });
  await api.change({ operation: 'move', id: b.id, expected_revision: b.revision, parentId: null, beforeId: a.id });
  assert.deepEqual((await api.list()).items.map(item => item.title), ['B', 'A']);
  await assert.rejects(api.change({ operation: 'create', kind: 'todo', title: '未知负责人', ownerId: 'other-project-node' }), /负责人/);
  await assert.rejects(f.engine.command({ type: 'search_project_items', projectId: f.projectId, query: { limit: 201 } }), /范围/);
  writeFileSync(join(f.root, 'original.md'), 'do not follow links'); linkSync(join(f.root, 'original.md'), join(f.root, 'linked.md'));
  await assert.rejects(api.change({ operation: 'register', path: 'linked.md' }), /链接|普通文件/);
  mkdirSync(join(f.root, 'real')); writeFileSync(join(f.root, 'real', 'doc.md'), 'linked directory');
  symlinkSync(join(f.root, 'real'), join(f.root, 'shortcut'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(api.change({ operation: 'register', path: 'shortcut/doc.md' }), /链接|联接/);
  assert.equal((await api.list()).total, 2);
});

test('item detail pages retain recent discussion and reject cursors after concurrent updates', async t => {
  const f = await fixture(t), api = items(f);
  let issue = await api.change({ operation: 'create', kind: 'issue', title: '分页讨论' });
  for (const body of ['第一条', '第二条', '第三条']) issue = await api.change({ operation: 'comment', id: issue.id, expected_revision: issue.revision, body });
  const first = (await f.engine.command({ type: 'get_project_item', projectId: f.projectId, itemId: issue.id, limit: 1 } as any)).projectItem as any;
  assert.deepEqual(first.item.comments.map((comment: any) => comment.body), ['第三条']);
  assert(first.nextCursor);
  const second = (await f.engine.command({ type: 'get_project_item', projectId: f.projectId, itemId: issue.id, limit: 1, cursor: first.nextCursor } as any)).projectItem!;
  assert.deepEqual(second.item.comments.map(comment => comment.body), ['第二条']);
  const oldest = issue.comments[0];
  const focused = (await f.engine.command({ type: 'get_project_item', projectId: f.projectId, itemId: issue.id, limit: 1, commentId: oldest.id } as any)).projectItem as any;
  assert.equal(focused.focusedComment.id, oldest.id);
  assert.equal(focused.focusedComment.body, '第一条');
  assert.equal(focused.item.comments.length, 1);
  assert(!('comments' in focused.events[0].after), 'event snapshots must not bypass comment pagination');
  await api.change({ operation: 'comment', id: issue.id, expected_revision: issue.revision, body: '并发新增' });
  await assert.rejects(f.engine.command({ type: 'get_project_item', projectId: f.projectId, itemId: issue.id, cursor: first.nextCursor } as any), /分页|刷新/);
});

test('archiving an owner permits edits but does not permit new assignments to the archived node', async t => {
  const f = await fixture(t), api = items(f);
  const todo = await api.change({ operation: 'create', kind: 'todo', title: '原负责人工作', ownerId: 'review' });
  await f.engine.command({ type: 'delete_node', projectId: f.projectId, nodeId: 'review' });
  const updated = await api.change({ operation: 'edit', id: todo.id, expected_revision: todo.revision, title: '修改标题', ownerId: 'review' });
  assert.equal(updated.ownerId, 'review'); assert.equal(updated.title, '修改标题');
  await assert.rejects(api.change({ operation: 'create', kind: 'issue', title: '新的分配', ownerId: 'review' }), /负责人/);
});

test('a damaged document journal remains readable and can be cancelled without changing document bytes', async t => {
  const f = await fixture(t), api = items(f);
  const doc = await api.change({ operation: 'create', kind: 'document', title: '损坏恢复记录', path: 'journal.md', body: 'original bytes' });
  await f.engine.close();
  writeFileSync(join(f.root, '.mixcat/state/document-pending.json'), '{"id":"truncated');
  const reopened = new WorkflowEngine({ workbenchRoot: f.root, executable: 'unused', nativeFactory() { assert.fail(); } });
  t.after(() => reopened.close()); await reopened.init();
  const page = (await reopened.command({ type: 'search_project_items', projectId: f.projectId })).projectItems!;
  assert.equal(page.total, 1); assert(page.recovery?.id); assert.match(page.recovery!.message, /损坏|无效/);
  await reopened.command({ type: 'cancel_document_write', projectId: f.projectId, recoveryId: page.recovery!.id });
  const saved = await reopened.command({ type: 'update_project_item', projectId: f.projectId, input: { request_id: 'after-damage', operation: 'edit', id: doc.id, expected_revision: doc.revision, title: '恢复后可编辑' } });
  assert.equal(saved.projectItem!.item.title, '恢复后可编辑');
  assert.equal(readFileSync(join(f.root, 'journal.md'), 'utf8'), 'original bytes');
});
