import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkflowEngine } from '../src/core/engine.js';
import { fixture } from './runtime-fixture.js';
import type { ItemMutation, WorkContext } from '../src/shared/project-items.js';
import { issueTypeOf, todoProgress } from '../src/shared/project-items.js';
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

test('Issues and legacy todos share one searchable hierarchy and discussion while retaining their identities', async t => {
  const f = await fixture(t), api = items(f);
  const parent = await api.change({ operation: 'create', kind: 'issue', title: '统一验收' });
  assert.equal(parent.issueType, 'task');
  let legacy = await api.change({ operation: 'create', kind: 'todo', title: '原有工作' });
  legacy = await api.change({ operation: 'move', id: legacy.id, expected_revision: legacy.revision, parentId: parent.id });
  const child = await api.change({ operation: 'create', kind: 'issue', title: '新增子项', parentId: legacy.id, issueType: 'requirement' });
  const found = (await f.engine.command({ type: 'search_project_items', projectId: f.projectId, query: { kind: 'issue' } })).projectItems!;
  assert.equal(found.total, 3);
  assert.deepEqual(found.items.map(item => item.id).sort(), [parent.id, legacy.id, child.id].sort());
  const pending = (await f.engine.command({ type: 'search_project_items', projectId: f.projectId, query: { kind: 'issue', status: 'open' } })).projectItems!;
  assert.equal(pending.total, 3, 'pending Issue searches also find legacy todo status');
  assert.equal(legacy.kind, 'todo'); assert.equal(legacy.number, 1); assert.equal(parent.number, 1);
  legacy = await api.change({ operation: 'comment', id: legacy.id, expected_revision: legacy.revision, body: '同一条工作记录的讨论' });
  assert.equal((await api.get(legacy.id)).item.comments[0].body, '同一条工作记录的讨论');
  await assert.rejects(api.change({ operation: 'move', id: parent.id, expected_revision: parent.revision, parentId: child.id }), /循环|后代/);
  await assert.rejects(api.change({ operation: 'edit', id: parent.id, expected_revision: parent.revision, status: 'done', reason: '尚未完成子项' }), /未完成|未结束/);
});

test('requirement issues can be created, retyped and read after restart while invalid types are rejected', async t => {
  const f = await fixture(t), api = items(f);
  let issue = await api.change({ operation: 'create', kind: 'issue', title: '需求验收', issueType: 'requirement' });
  assert.equal(issue.issueType, 'requirement');
  for (const issueType of ['bug', 'enhancement', 'requirement'] as const) {
    issue = await api.change({ operation: 'edit', id: issue.id, expected_revision: issue.revision, issueType });
    assert.equal((await api.get(issue.id)).item.issueType, issueType);
  }
  await assert.rejects(api.change({ operation: 'edit', id: issue.id, expected_revision: issue.revision, issueType: 'unknown' as any }), /Issue 类型/);
  await assert.rejects(api.change({ operation: 'create', kind: 'document', title: '错误类型', path: 'invalid-type.md', issueType: 'requirement' }), /Issue 类型/);
  await f.engine.close();
  const reopened = new WorkflowEngine({ workbenchRoot: f.root, executable: 'unused', nativeFactory() { assert.fail('Issue edits must not start a model'); } });
  t.after(() => reopened.close()); await reopened.init();
  const detail = (await reopened.command({ type: 'get_project_item', projectId: f.projectId, itemId: issue.id })).projectItem!;
  assert.equal(detail.item.issueType, 'requirement'); assert.equal(detail.item.revision, issue.revision);
});

test('legacy todo types start as ordinary tasks and explicit type edits persist without replacing identity', async t => {
  const f = await fixture(t), api = items(f);
  let legacy = await api.change({ operation: 'create', kind: 'todo', title: '历史普通任务', body: '原始工作说明', acceptance: '原验收条件' });
  assert.equal(legacy.issueType, 'bug');
  assert.equal(issueTypeOf(legacy), 'task');
  legacy = await api.change({ operation: 'edit', id: legacy.id, expected_revision: legacy.revision, issueType: 'task' });
  assert.equal(issueTypeOf(legacy), 'task');
  const originalId = legacy.id, originalNumber = legacy.number;
  legacy = await api.change({ operation: 'edit', id: legacy.id, expected_revision: legacy.revision, issueType: 'bug' });
  assert.equal(issueTypeOf(legacy), 'bug');
  await f.engine.close();
  const reopened = new WorkflowEngine({ workbenchRoot: f.root, executable: 'unused', nativeFactory() { assert.fail('Type edits must not start a model'); } });
  t.after(() => reopened.close()); await reopened.init();
  let detail = (await reopened.command({ type: 'get_project_item', projectId: f.projectId, itemId: originalId })).projectItem!;
  assert.equal(issueTypeOf(detail.item), 'bug');
  assert.equal(detail.item.kind, 'todo'); assert.equal(detail.item.number, originalNumber);
  const updated = await reopened.command({ type: 'update_project_item', projectId: f.projectId, input: { request_id: 'restore-task-type', operation: 'edit', id: originalId, expected_revision: detail.item.revision, issueType: 'task' } });
  assert.equal(issueTypeOf(updated.projectItem!.item), 'task');
  detail = (await reopened.command({ type: 'get_project_item', projectId: f.projectId, itemId: originalId })).projectItem!;
  assert.equal(detail.item.id, originalId); assert.equal(detail.item.body, '原始工作说明'); assert.equal(detail.item.acceptance, '原验收条件');
});

test('primary Issue associations accept both legacy identities and reject conflicting aliases and documents', async t => {
  const f = await fixture(t), api = items(f);
  const legacy = await api.change({ operation: 'create', kind: 'todo', title: '历史主工作' });
  const issue = await api.change({ operation: 'create', kind: 'issue', title: '统一主工作' });
  const doc = await api.change({ operation: 'create', kind: 'document', title: '只能引用的文档', path: 'docs/reference.md', body: '# 资料' });
  const send = (work_context: WorkContext) => f.engine.command({ type: 'send_message', projectId: f.projectId, nodeId: 'plan', mode: 'codex', input: [{ type: 'text', text: '处理关联工作' }], work_context });
  await assert.rejects(send({ primary_issue_id: legacy.id, primary_todo_id: issue.id, references: [] }), /冲突/);
  await assert.rejects(send({ primary_issue_id: null, primary_todo_id: legacy.id, references: [] }), /冲突/);
  for (const work_context of [{ primary_issue_id: doc.id, references: [] }, { primary_todo_id: doc.id, references: [] }]) await assert.rejects(send(work_context), /Issue|工作关联/);
  const canonical = (await send({ primary_issue_id: legacy.id, references: [] })).snapshot.selected!.tasks.at(-1)!.workContext!;
  assert.equal(canonical.primary_issue_id, legacy.id); assert(!('primary_todo_id' in canonical));
  assert.equal(canonical.observed[0].kind, 'todo'); assert.equal(canonical.observed[0].id, legacy.id);
  const compatible = (await send({ primary_todo_id: issue.id, references: [] })).snapshot.selected!.tasks.at(-1)!.workContext!;
  assert.equal(compatible.primary_todo_id, issue.id); assert(!('primary_issue_id' in compatible));
  assert.equal(compatible.observed[0].kind, 'issue'); assert.equal(compatible.observed[0].id, issue.id);
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

test('mixed Issue trees require explicit end reasons and reopen ended ancestors without silently changing them', async t => {
  const f = await fixture(t), api = items(f);
  let parent = await api.change({ operation: 'create', kind: 'issue', title: '发布工作' });
  let legacy = await api.change({ operation: 'create', kind: 'todo', title: '旧任务分支', parentId: parent.id });
  let child = await api.change({ operation: 'create', kind: 'issue', title: '验证子项', parentId: legacy.id });
  await assert.rejects(api.change({ operation: 'edit', id: parent.id, expected_revision: parent.revision, status: 'canceled' }), /说明/);
  await assert.rejects(api.change({ operation: 'edit', id: parent.id, expected_revision: parent.revision, status: 'canceled', reason: '仍需先处理子项' }), /未完成|未结束/);
  child = await api.change({ operation: 'edit', id: child.id, expected_revision: child.revision, status: 'done', reason: '已验证' });
  legacy = await api.change({ operation: 'edit', id: legacy.id, expected_revision: legacy.revision, status: 'canceled', reason: '后续不再维护此分支' });
  parent = await api.change({ operation: 'edit', id: parent.id, expected_revision: parent.revision, status: 'done', reason: '全部子项已结束' });
  await assert.rejects(api.change({ operation: 'edit', id: child.id, expected_revision: child.revision, status: 'doing' }), /重开/);
  await assert.rejects(api.change({ operation: 'create', kind: 'issue', title: '不能新增', parentId: legacy.id }), /重开/);
  await assert.rejects(api.change({ operation: 'reopen', id: child.id, expected_revision: child.revision }), /说明/);
  child = await api.change({ operation: 'reopen', id: child.id, expected_revision: child.revision, reason: '新增验证范围' });
  assert.equal(child.status, 'open');
  assert.equal((await api.get(legacy.id)).item.status, 'todo');
  assert.equal((await api.get(parent.id)).item.status, 'open');
  parent = (await api.get(parent.id)).item;
  await api.change({ operation: 'archive', id: parent.id, expected_revision: parent.revision });
  assert.equal((await api.list()).total, 0);
  child = (await api.get(child.id)).item;
  await api.change({ operation: 'restore', id: child.id, expected_revision: child.revision });
  assert.equal((await api.list()).total, 3);
});

test('changing a finished Issue back to an active status requires a reopening explanation', async t => {
  const f = await fixture(t), api = items(f);
  let issue = await api.change({ operation: 'create', kind: 'issue', title: '需要说明的重开' });
  issue = await api.change({ operation: 'edit', id: issue.id, expected_revision: issue.revision, status: 'done', reason: '已通过验收' });
  await assert.rejects(api.change({ operation: 'edit', id: issue.id, expected_revision: issue.revision, status: 'doing' }), /重开|说明/);
  assert.equal((await api.get(issue.id)).item.status, 'done');
  issue = await api.change({ operation: 'edit', id: issue.id, expected_revision: issue.revision, status: 'doing', reason: '新增验收范围' });
  assert.equal(issue.status, 'doing');
});

test('Issue progress counts completed mixed leaves and excludes canceled and historical closed leaves', async t => {
  const f = await fixture(t), api = items(f);
  const parent = await api.change({ operation: 'create', kind: 'issue', title: '交付进度' });
  for (const [kind, status, title] of [['issue', 'done', '完成工作'], ['todo', 'canceled', '取消工作'], ['issue', 'closed', '历史关闭'], ['todo', 'blocked', '阻塞工作']] as const) {
    const item = await api.change({ operation: 'create', kind, title, parentId: parent.id });
    await api.change({ operation: 'edit', id: item.id, expected_revision: item.revision, status, reason: '记录实际结论' });
  }
  const found = (await f.engine.command({ type: 'search_project_items', projectId: f.projectId, query: { kind: 'issue' } })).projectItems!;
  assert.deepEqual(todoProgress(found.items, parent.id), { completed: 1, total: 2 });
  assert.equal(found.items.find(item => item.title === '历史关闭')!.status, 'closed');
  const canceled = (await f.engine.command({ type: 'search_project_items', projectId: f.projectId, query: { kind: 'issue', status: 'canceled' } })).projectItems!;
  assert.equal(canceled.total, 1); assert.equal(canceled.items[0].kind, 'todo');
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

test('moving a legacy todo after an Issue uses displayed sibling order when positions collide and persists it', async t => {
  const f = await fixture(t), api = items(f);
  const a = await api.change({ operation: 'create', kind: 'todo', title: 'A' });
  let b = await api.change({ operation: 'create', kind: 'todo', title: 'B' });
  const c = await api.change({ operation: 'create', kind: 'todo', title: 'C' });
  b = await api.change({ operation: 'move', id: b.id, expected_revision: b.revision, parentId: a.id });
  await api.change({ operation: 'create', kind: 'issue', title: 'D' });
  assert.deepEqual((await api.list()).items.filter(item => item.parentId === null).map(item => item.title), ['A', 'D', 'C']);
  await api.change({ operation: 'move', id: b.id, expected_revision: b.revision, parentId: null, beforeId: c.id });
  assert.deepEqual((await api.list()).items.filter(item => item.parentId === null).map(item => item.title), ['A', 'D', 'B', 'C']);
  await f.engine.close();
  const reopened = new WorkflowEngine({ workbenchRoot: f.root, executable: 'unused', nativeFactory() { assert.fail('Ordering must not start a model'); } });
  t.after(() => reopened.close()); await reopened.init();
  const persisted = (await reopened.command({ type: 'search_project_items', projectId: f.projectId, query: { kind: 'issue' } })).projectItems!;
  assert.deepEqual(persisted.items.filter(item => item.parentId === null).map(item => item.title), ['A', 'D', 'B', 'C']);
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
