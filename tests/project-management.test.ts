import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkflowEngine } from '../src/core/engine.js';
import { projectDirectory } from '../src/core/paths.js';
import { deferred, fixture, until } from './runtime-fixture.js';

test('project rename persists and removal retains files, history and original native Threads on reopening', async t => {
  const f = await fixture(t);
  await f.send('plan');
  const owner = f.engine as any, state = owner.states.get(f.projectId);
  await until(() => !!state.tasks[0].turnId);
  const task = state.tasks[0];
  f.clients[0].options.onEvent({ method: 'turn/completed', params: { threadId: task.threadId, turn: { id: task.turnId, status: 'completed', items: [] } } });
  writeFileSync(join(f.root, 'user-file.txt'), 'user data');
  const before = structuredClone({ nodes: state.nodes, tasks: state.tasks, conversation: state.conversation, edges: state.edges });
  before.nodes = before.nodes.map((node: any) => ({ ...node, model: node.model ?? null, skills: node.skills ?? [], plugins: node.plugins ?? [] }));
  for (const name of ['', '   ', 'a'.repeat(101), '\0']) await assert.rejects(f.engine.command({ type: 'rename_project', projectId: f.projectId, name }), /项目名称/);
  const renamed = await f.engine.command({ type: 'rename_project', projectId: f.projectId, name: '  New project name  ' });
  assert.equal(renamed.snapshot.selected!.project.name, 'New project name');
  assert.equal(renamed.snapshot.projects[0].name, 'New project name');
  const removed = await f.engine.command({ type: 'delete_project', projectId: f.projectId });
  assert.deepEqual(removed.snapshot.projects, []); assert.equal(removed.snapshot.selected, null);
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, '.runtime/client/projects.json'), 'utf8')), []);
  assert.equal(readFileSync(join(f.root, 'user-file.txt'), 'utf8'), 'user data');
  assert(existsSync(join(f.root, '.mixcat/state/workflow.sqlite')));
  await f.engine.close();
  const reopened = new WorkflowEngine({ workbenchRoot: f.root, executable: 'unused', nativeFactory() { assert.fail('Reopening must not start native work'); } });
  t.after(() => reopened.close()); await reopened.init();
  assert.deepEqual((await reopened.command({ type: 'snapshot' })).snapshot.projects, []);
  const restored = (await reopened.command({ type: 'create_project', root: f.root, name: 'Ignored', goal: 'Ignored' })).snapshot.selected!;
  assert.equal(restored.project.id, f.projectId); assert.equal(restored.project.name, 'New project name');
  assert.equal(restored.nodes[0].threadId, task.threadId);
  const saved = (reopened as any).states.get(f.projectId);
  for (const key of ['nodes', 'tasks', 'conversation', 'edges'] as const) assert.deepEqual(JSON.parse(JSON.stringify(saved[key])), JSON.parse(JSON.stringify(before[key])));
});

test('editing or removing an unselected project keeps the current project and unrelated catalog entries', async t => {
  const f = await fixture(t), other = projectDirectory(f.root, 'other');
  const second = (await f.engine.command({ type: 'create_project', root: other, name: 'Other', goal: 'Other' })).snapshot.selected!.project.id;
  await f.engine.command({ type: 'snapshot', projectId: f.projectId });
  const renamed = await f.engine.command({ type: 'rename_project', projectId: second, name: 'Other renamed' });
  assert.equal(renamed.snapshot.selected!.project.id, f.projectId);
  const removed = await f.engine.command({ type: 'delete_project', projectId: second });
  assert.equal(removed.snapshot.selected!.project.id, f.projectId); assert.equal(removed.snapshot.projects.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, '.runtime/client/projects.json'), 'utf8')), [f.root]);
});

test('unfinished work blocks deletion and a failed catalog update preserves the project and files', async t => {
  const f = await fixture(t, undefined, 'web-product');
  const { legacyWebReviewPolicy } = await import('./human-review-fixture.js');
  await f.engine.command({ type: 'save_review_policy', projectId: f.projectId, policy: legacyWebReviewPolicy() });
  await f.send('design');
  await assert.rejects(f.engine.command({ type: 'delete_project', projectId: f.projectId }), /未完成任务/);
  const waiting = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!.tasks[0];
  await f.engine.command({ type: 'cancel_review_task', projectId: f.projectId, taskId: waiting.id });
  const catalog = join(f.root, '.runtime/client/projects.json');
  const before = readFileSync(catalog, 'utf8');
  mkdirSync(`${catalog}.tmp`);
  await assert.rejects(f.engine.command({ type: 'delete_project', projectId: f.projectId }));
  assert.equal(readFileSync(catalog, 'utf8'), before);
  assert.equal((await f.engine.command({ type: 'snapshot' })).snapshot.projects[0].id, f.projectId);
  const renamed = await f.engine.command({ type: 'rename_project', projectId: f.projectId, name: 'Still accessible' });
  assert.equal(renamed.snapshot.selected!.project.name, 'Still accessible');
});

test('deletion excludes new work during runtime cleanup and ignores stale history results', async t => {
  const f = await fixture(t); await f.send('plan');
  const owner = f.engine as any, state = owner.states.get(f.projectId);
  await until(() => !!state.tasks[0].turnId);
  const task = state.tasks[0];
  f.clients[0].options.onEvent({ method: 'turn/completed', params: { threadId: task.threadId, turn: { id: task.turnId, status: 'completed', items: [] } } });
  const closeGate = deferred(), historyGate = deferred(), rpc = f.clients[0].port.rpc;
  f.clients[0].port.close = () => closeGate.promise;
  f.clients[0].port.rpc = async (method, params) => { if (method === 'thread/items/list') { await historyGate.promise; return { data: [], nextCursor: null }; } return rpc(method, params); };
  const history = f.engine.command({ type: 'read_history', projectId: f.projectId, nodeId: 'plan' });
  await new Promise(resolve => setImmediate(resolve));
  const removing = f.engine.command({ type: 'delete_project', projectId: f.projectId });
  try {
    await assert.rejects(f.send('plan'), /删除|移除/);
    await assert.rejects(f.engine.command({ type: 'rename_project', projectId: f.projectId, name: 'Late change' }), /删除/);
  } finally { closeGate.resolve(); historyGate.resolve(); }
  await removing; await history;
  assert.equal((await f.engine.command({ type: 'snapshot' })).snapshot.projects.length, 0);
});

test('removing a project during discovery cannot reuse its old connection after reopening', async t => {
  const gate = deferred(), f = await fixture(t, () => gate.promise);
  const discovery = f.engine.command({ type: 'catalog', projectId: f.projectId });
  const rejected = assert.rejects(discovery, /关闭|移除|更换/);
  await until(() => f.clients.length === 1);
  await f.engine.command({ type: 'delete_project', projectId: f.projectId });
  await f.engine.command({ type: 'create_project', root: f.root, name: 'Reopen', goal: 'Same data' });
  gate.resolve(); await rejected;
  await f.engine.command({ type: 'catalog', projectId: f.projectId });
  assert.equal(f.clients.length, 2);
});
