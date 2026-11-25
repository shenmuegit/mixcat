import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WorkflowEngine } from '../src/core/engine.js';
import { projectDirectory } from '../src/core/paths.js';
import { prepareProjectDeletion, stageProjectDeletion } from '../src/core/project-deletion.js';
import { deferred, fixture, until } from './runtime-fixture.js';

test('project deletion requires the confirmed directory and permanently removes only that directory', async t => {
  const f = await fixture(t);
  const directory = projectDirectory(f.root, 'confirmed-project');
  const elsewhere = projectDirectory(f.root, 'outside-project');
  writeFileSync(join(elsewhere, 'unrelated.txt'), 'separate directory');
  symlinkSync(elsewhere, join(directory, 'local-link'), process.platform === 'win32' ? 'junction' : 'dir');
  writeFileSync(join(directory, 'project-file.md'), 'committed content');
  const selected = (await f.engine.command({ type: 'create_project', root: directory, name: 'Confirmed' })).snapshot.selected!;
  const projectId = selected.project.id;
  await assert.rejects(f.engine.command({ type: 'delete_project', projectId }), /确认.*目录/);
  await assert.rejects(f.engine.command({ type: 'delete_project', projectId, confirmedRoot: f.root }), /确认.*目录/);
  assert.equal(readFileSync(join(directory, 'project-file.md'), 'utf8'), 'committed content');
  const result = await f.engine.command({ type: 'delete_project', projectId, confirmedRoot: directory });
  assert.equal(existsSync(directory), false);
  assert.equal(readFileSync(join(elsewhere, 'unrelated.txt'), 'utf8'), 'separate directory');
  assert.deepEqual(result.snapshot.projects.map(project => project.id), [f.projectId]);
  assert(existsSync(join(f.root, '.mixcat', 'state', 'workflow.sqlite')));
});

test('deleting a project cannot erase the workbench or another registered project', async t => {
  const f = await fixture(t);
  await assert.rejects(f.engine.command({ type: 'delete_project', projectId: f.projectId, confirmedRoot: f.root }), /工作台/);
  const root = projectDirectory(f.root, 'outer-project');
  const outer = (await f.engine.command({ type: 'create_project', root, name: 'Outer' })).snapshot.selected!.project;
  const child = projectDirectory(root, 'child-project');
  await f.engine.command({ type: 'create_project', root: child, name: 'Child' });
  await assert.rejects(f.engine.command({ type: 'delete_project', projectId: outer.id, confirmedRoot: root }), /其他已登记/);
  assert(existsSync(join(root, '.mixcat/state/workflow.sqlite')));
  assert(existsSync(join(child, '.mixcat/state/workflow.sqlite')));
});

test('project deletion cannot erase a separately configured shared account directory', async t => {
  const f = await fixture(t);
  await f.engine.close();
  const accountRoot = projectDirectory(f.root, 'separate-account');
  const directory = projectDirectory(accountRoot, '.runtime', 'client', 'account');
  const credentials = join(directory, 'retained.txt');
  writeFileSync(credentials, 'fixture account data');
  const engine = new WorkflowEngine({ workbenchRoot: f.root, executable: 'fixture', accountRoot });
  t.after(() => engine.close());
  await engine.init();
  const project = (await engine.command({ type: 'create_project', root: directory, name: 'Separate account fixture' })).snapshot.selected!.project;
  await assert.rejects(engine.command({ type: 'delete_project', projectId: project.id, confirmedRoot: directory }), /账号目录/);
  assert.equal(readFileSync(credentials, 'utf8'), 'fixture account data');
});

test('project deletion protects an independent Feed working directory', async t => {
  const f = await fixture(t, undefined, undefined, undefined, 'project');
  const directory = projectDirectory(f.projectRoot, 'feed-work');
  const data = join(directory, 'report.md');
  writeFileSync(data, 'feed report');
  await f.engine.command({ type: 'create_feed_collection', requestId: 'feed-in-project', directory, name: 'Independent feed', instruction: 'Collect reports', input: { text: 'Start collection' } });
  await assert.rejects(f.engine.command({ type: 'delete_project', projectId: f.projectId, confirmedRoot: f.projectRoot }), /信息流.*目录/);
  assert.equal(readFileSync(data, 'utf8'), 'feed report');
});

test('project deletion protects independently owned Feed state below a parent working directory', async t => {
  const f = await fixture(t);
  const workspace = projectDirectory(f.root, 'shared-feed-workspace');
  const feed = (await f.engine.command({ type: 'create_feed_collection', requestId: 'feed-state-in-project', directory: workspace, name: 'Feed owner', instruction: 'Collect reports', input: { text: 'Start collection' } })).feed!;
  const directory = projectDirectory(workspace, '.mixcat', 'feed', feed.admission!.collectionId);
  const data = join(directory, 'report.md');
  writeFileSync(data, 'independent feed report');
  const project = (await f.engine.command({ type: 'create_project', root: directory, name: 'Registered in Feed data' })).snapshot.selected!.project;
  await assert.rejects(f.engine.command({ type: 'delete_project', projectId: project.id, confirmedRoot: directory }), /信息流.*数据目录/);
  assert.equal(readFileSync(data, 'utf8'), 'independent feed report');
});

for (const changed of ['replacement', 'saved work'] as const) test(`a deferred permanent deletion protects ${changed} across workbenches and restart`, async t => {
  const f = await fixture(t, undefined, undefined, undefined, 'project');
  const project = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!.project;
  writeFileSync(join(f.projectRoot, 'before-delete.txt'), 'confirmed directory');
  await f.engine.close();
  const record = prepareProjectDeletion(f.root, project, []);
  writeFileSync(join(f.root, '.runtime', 'client', 'project-deletions', `${record.key}.json`), JSON.stringify({ ...record, waitForUnlock: true }));
  writeFileSync(join(f.root, '.runtime', 'client', 'projects.json'), '[]');

  const alternateWorkbench = projectDirectory(f.root, 'other-workbench');
  const other = new WorkflowEngine({ workbenchRoot: alternateWorkbench, executable: 'fixture' });
  t.after(() => other.close());
  await other.init();
  const nested = projectDirectory(f.projectRoot, 'nested');
  for (const root of [f.projectRoot, nested]) {
    await assert.rejects(other.command({ type: 'create_project', root, name: 'Different workspace' }), /已有确认的永久删除/);
  }
  await other.close();

  if (changed === 'replacement') {
    renameSync(f.projectRoot, join(f.root, 'moved-original'));
    mkdirSync(f.projectRoot);
    writeFileSync(join(f.projectRoot, 'replacement.txt'), 'independent data');
  } else {
    const db = new DatabaseSync(join(f.projectRoot, '.mixcat', 'state', 'workflow.sqlite'));
    try { db.exec("UPDATE project_state SET body = json_set(body, '$.project.name', 'Saved in older client') WHERE id = 1"); }
    finally { db.close(); }
  }

  const reopened = new WorkflowEngine({ workbenchRoot: f.root, executable: 'fixture' });
  t.after(() => reopened.close());
  await reopened.init();
  const reason = changed === 'replacement' ? /目录在删除期间发生变化/ : /保存状态在等待删除期间已变化/;
  await assert.rejects(reopened.command({ type: 'delete_project', projectId: f.projectId, confirmedRoot: f.projectRoot }), reason);
  assert.match((await reopened.command({ type: 'snapshot' })).snapshot.projects[0].unavailable!, reason);
  if (changed === 'replacement') {
    assert.equal(readFileSync(join(f.root, 'moved-original', 'before-delete.txt'), 'utf8'), 'confirmed directory');
    assert.equal(readFileSync(join(f.projectRoot, 'replacement.txt'), 'utf8'), 'independent data');
  } else assert.equal(readFileSync(join(f.projectRoot, 'before-delete.txt'), 'utf8'), 'confirmed directory');
});

test('retrying project deletion still waits for every owned native connection to close', async t => {
  const f = await fixture(t, undefined, undefined, undefined, 'project');
  await f.engine.command({ type: 'catalog', projectId: f.projectId });
  let closed = false, attempts = 0;
  f.clients[0].port.close = async () => { attempts++; if (!closed) throw new Error('Native connection still owned'); };
  t.after(() => { closed = true; });
  const remove = { type: 'delete_project', projectId: f.projectId, confirmedRoot: f.projectRoot } as const;
  try {
    await assert.rejects(f.engine.command(remove), /Native connection still owned/);
    await assert.rejects(f.engine.command(remove), /Native connection still owned/);
    assert(existsSync(f.projectRoot));
  } finally { closed = true; }
  await f.engine.command(remove);
  assert.equal(attempts, 3);
  assert.equal(existsSync(f.projectRoot), false);
});

test('project deletion waits for active template preparation', async t => {
  const gate = deferred();
  const f = await fixture(t, () => gate.promise, 'research-analysis', undefined, 'project');
  const preparation = f.engine.command({ type: 'template_setup', projectId: f.projectId, phase: 'inspect' });
  const settled = Promise.allSettled([preparation]);
  try {
    await until(() => f.clients.length === 1);
    await assert.rejects(f.engine.command({ type: 'delete_project', projectId: f.projectId, confirmedRoot: f.projectRoot }), /模板/);
    assert(existsSync(f.projectRoot));
  } finally { gate.resolve(); await settled; }
});

for (const committed of [false, true]) test(`restart ${committed ? 'completes' : 'rolls back'} project deletion according to the catalog`, async t => {
  const f = await fixture(t, undefined, undefined, undefined, 'data');
  const selected = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!.project;
  writeFileSync(join(f.projectRoot, 'project-file.md'), 'committed content');
  await f.engine.close();
  const record = prepareProjectDeletion(f.root, { id: selected.id, name: selected.name, root: selected.root }, []);
  stageProjectDeletion(record);
  const staged = join(f.root, `.mixcat-deleting-${record.key}`);
  if (committed) {
    writeFileSync(join(f.root, '.runtime/client/projects.json'), '[]');
    const recreated = projectDirectory(f.root, 'data');
    writeFileSync(join(recreated, 'new-file.md'), 'new directory');
  }
  const reopened = new WorkflowEngine({ workbenchRoot: f.root, executable: 'unused' });
  t.after(() => reopened.close());
  await reopened.init();
  const snapshot = (await reopened.command({ type: 'snapshot' })).snapshot;
  assert.equal(existsSync(staged), false);
  assert.deepEqual(snapshot.projects.map(project => project.id), committed ? [] : [selected.id]);
  if (committed) {
    assert.equal(existsSync(join(f.projectRoot, 'project-file.md')), false);
    assert.equal(readFileSync(join(f.projectRoot, 'new-file.md'), 'utf8'), 'new directory');
  } else {
    assert.equal(readFileSync(join(f.projectRoot, 'project-file.md'), 'utf8'), 'committed content');
  }
});

test('project rename and history persist until the confirmed project is permanently deleted', async t => {
  const f = await fixture(t, undefined, undefined, undefined, 'data');
  await f.send('plan');
  const owner = f.engine as any, state = owner.states.get(f.projectId);
  await until(() => !!state.tasks[0].turnId);
  const task = state.tasks[0];
  f.clients[0].options.onEvent({ method: 'turn/completed', params: { threadId: task.threadId, turn: { id: task.turnId, status: 'completed', items: [] } } });
  writeFileSync(join(f.projectRoot, 'user-file.txt'), 'user data');
  for (const name of ['', '   ', 'a'.repeat(101), '\0']) await assert.rejects(f.engine.command({ type: 'rename_project', projectId: f.projectId, name }), /项目名称/);
  const renamed = await f.engine.command({ type: 'rename_project', projectId: f.projectId, name: '  New project name  ' });
  assert.equal(renamed.snapshot.selected!.project.name, 'New project name');
  assert.equal(renamed.snapshot.projects[0].name, 'New project name');
  await f.engine.close();
  const reopened = new WorkflowEngine({ workbenchRoot: f.root, executable: 'unused', nativeFactory() { assert.fail('Reopening must not start native work'); } });
  t.after(() => reopened.close()); await reopened.init();
  const restored = (await reopened.command({ type: 'snapshot', projectId: f.projectId })).snapshot.selected!;
  assert.equal(restored.project.name, 'New project name');
  assert.equal(restored.nodes[0].threadId, task.threadId);
  const removed = await reopened.command({ type: 'delete_project', projectId: f.projectId, confirmedRoot: f.projectRoot });
  assert.deepEqual(removed.snapshot.projects, []);
  assert.equal(removed.snapshot.selected, null);
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, '.runtime/client/projects.json'), 'utf8')), []);
  assert.equal(existsSync(f.projectRoot), false);
});

test('editing or removing an unselected project keeps the current project and unrelated catalog entries', async t => {
  const f = await fixture(t), other = projectDirectory(f.root, 'other');
  const second = (await f.engine.command({ type: 'create_project', root: other, name: 'Other', goal: 'Other' })).snapshot.selected!.project.id;
  await f.engine.command({ type: 'snapshot', projectId: f.projectId });
  const renamed = await f.engine.command({ type: 'rename_project', projectId: second, name: 'Other renamed' });
  assert.equal(renamed.snapshot.selected!.project.id, f.projectId);
  const removed = await f.engine.command({ type: 'delete_project', projectId: second, confirmedRoot: other });
  assert.equal(removed.snapshot.selected!.project.id, f.projectId); assert.equal(removed.snapshot.projects.length, 1);
  assert.equal(existsSync(other), false);
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, '.runtime/client/projects.json'), 'utf8')), [f.root]);
});

test('unfinished work blocks deletion and a failed catalog update preserves the project and files', async t => {
  const f = await fixture(t, undefined, 'web-product', undefined, 'data');
  const { legacyWebReviewPolicy } = await import('./human-review-fixture.js');
  await f.engine.command({ type: 'save_review_policy', projectId: f.projectId, policy: legacyWebReviewPolicy() });
  await f.send('design');
  await assert.rejects(f.engine.command({ type: 'delete_project', projectId: f.projectId, confirmedRoot: f.projectRoot }), /未完成任务/);
  const waiting = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!.tasks[0];
  await f.engine.command({ type: 'cancel_review_task', projectId: f.projectId, taskId: waiting.id });
  const catalog = join(f.root, '.runtime/client/projects.json');
  const before = readFileSync(catalog, 'utf8');
  writeFileSync(join(f.projectRoot, 'important.txt'), 'keep intact');
  mkdirSync(`${catalog}.tmp`);
  await assert.rejects(f.engine.command({ type: 'delete_project', projectId: f.projectId, confirmedRoot: f.projectRoot }));
  assert.equal(readFileSync(catalog, 'utf8'), before);
  assert.equal(readFileSync(join(f.projectRoot, 'important.txt'), 'utf8'), 'keep intact');
  assert.equal((await f.engine.command({ type: 'snapshot' })).snapshot.projects[0].id, f.projectId);
  const renamed = await f.engine.command({ type: 'rename_project', projectId: f.projectId, name: 'Still accessible' });
  assert.equal(renamed.snapshot.selected!.project.name, 'Still accessible');
});

test('deletion excludes new work during runtime cleanup and ignores stale history results', async t => {
  const f = await fixture(t, undefined, undefined, undefined, 'data'); await f.send('plan');
  const owner = f.engine as any, state = owner.states.get(f.projectId);
  await until(() => !!state.tasks[0].turnId);
  const task = state.tasks[0];
  f.clients[0].options.onEvent({ method: 'turn/completed', params: { threadId: task.threadId, turn: { id: task.turnId, status: 'completed', items: [] } } });
  const closeGate = deferred(), historyGate = deferred(), rpc = f.clients[0].port.rpc;
  f.clients[0].port.close = () => closeGate.promise;
  f.clients[0].port.rpc = async (method, params) => { if (method === 'thread/items/list') { await historyGate.promise; return { data: [], nextCursor: null }; } return rpc(method, params); };
  const history = f.engine.command({ type: 'read_history', projectId: f.projectId, nodeId: 'plan' });
  await new Promise(resolve => setImmediate(resolve));
  const removing = f.engine.command({ type: 'delete_project', projectId: f.projectId, confirmedRoot: f.projectRoot });
  try {
    await assert.rejects(f.send('plan'), /删除|移除/);
    await assert.rejects(f.engine.command({ type: 'rename_project', projectId: f.projectId, name: 'Late change' }), /删除/);
  } finally { closeGate.resolve(); historyGate.resolve(); }
  await removing; await history;
  assert.equal((await f.engine.command({ type: 'snapshot' })).snapshot.projects.length, 0);
});

test('a new project at a deleted directory cannot reuse the old discovery connection', async t => {
  const gate = deferred(), f = await fixture(t, () => gate.promise, undefined, undefined, 'data');
  const discovery = f.engine.command({ type: 'catalog', projectId: f.projectId });
  const rejected = assert.rejects(discovery, /关闭|移除|更换/);
  await until(() => f.clients.length === 1);
  await f.engine.command({ type: 'delete_project', projectId: f.projectId, confirmedRoot: f.projectRoot });
  const root = projectDirectory(f.root, 'data');
  const replacement = (await f.engine.command({ type: 'create_project', root, name: 'Replacement' })).snapshot.selected!;
  assert.notEqual(replacement.project.id, f.projectId);
  gate.resolve(); await rejected;
  await f.engine.command({ type: 'catalog', projectId: replacement.project.id });
  assert.equal(f.clients.length, 2);
});
