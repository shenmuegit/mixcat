import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkflowEngine } from '../src/core/engine.js';
import { fixture } from './runtime-fixture.js';
import type { ItemMutation } from '../src/shared/project-items.js';
import { readFileSync, writeFileSync } from 'node:fs';
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
  await api.change({ operation: 'edit', id: todo.id, expected_revision: todo.revision, title: '引用问题修复' });
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
  doc = await api.change({ operation: 'edit', id: doc.id, expected_revision: doc.revision, expected_hash: current.hash, body: '# 合并后的正文' });
  assert.equal((await api.get(doc.id)).item.body, '# 合并后的正文');
  const latest = await api.get(doc.id);
  doc = await api.change({ operation: 'move', id: doc.id, expected_revision: doc.revision, expected_hash: latest.hash, path: 'docs/moved/acceptance.md' });
  assert.equal(doc.id, before.item.id);
  assert.equal(readFileSync(join(f.root, doc.path!), 'utf8'), '# 合并后的正文');
  const registered = await api.change({ operation: 'register', kind: 'document', path: doc.path! });
  assert.equal(registered.id, doc.id);
  await assert.rejects(api.change({ operation: 'create', kind: 'document', title: '越界', path: '../escape.md' }), /目录|路径|内部/);
  await assert.rejects(api.change({ operation: 'create', kind: 'document', title: '控制数据', path: '.mixcat/test.md' }), /目录|路径|内部/);
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
