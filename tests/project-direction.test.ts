import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkflowEngine } from '../src/core/engine.js';
import { projectDirectory } from '../src/core/paths.js';
import { ProjectStore } from '../src/core/store.js';
import { fixture, until } from './runtime-fixture.js';
import { accountFixture } from './account-fixture.js';

test('projects can be created without a predetermined goal and old goal arguments are ignored', async t => {
  const root = mkdtempSync(join(projectDirectory(process.cwd(), '.runtime', 'implementation', 'project-direction'), 'project-'));
  const engine = new WorkflowEngine({ workbenchRoot: root, executable: 'unused' });
  t.after(() => engine.close()); await engine.init();
  const reply = await engine.command({ type: 'create_project', name: 'An evolving conversation', root });
  const project = reply.snapshot.selected!.project;
  assert.equal(project.name, 'An evolving conversation'); assert.equal(Object.hasOwn(project, 'goal'), false);
  const reopened = await engine.command({ type: 'create_project', name: 'Ignored duplicate', root, goal: 'Only a message echo app' });
  assert.equal(reopened.snapshot.selected!.project.id, project.id);
  assert.equal(Object.hasOwn(reopened.snapshot.selected!.project, 'goal'), false);
});

test('native start and same-Thread continuation use the latest discussion without a fixed project goal', async t => {
  const f = await fixture(t);
  const send = (text: string) => f.engine.command({ type: 'send_message', projectId: f.projectId, nodeId: 'plan', mode: 'codex', input: [{ type: 'text', text, text_elements: [] }] });
  const snapshot = async () => (await f.engine.command({ type: 'snapshot' })).snapshot.selected!;
  const first = '先讨论留言板的需求，不执行开发。', changed = '调整方向：改为讨论 Windows 计算器，支持加减法和 exe 交付。';
  await send(first); await until(() => f.clients[0]?.calls.some(call => call.method === 'turn/start'));
  const client = f.clients[0], starts = () => client.calls.filter(call => call.method === 'turn/start');
  const initial = client.calls.find(call => call.method === 'thread/start')!;
  assert.doesNotMatch(initial.params.developerInstructions, /项目目标：|free conversation|undefined/);
  assert.match(initial.params.developerInstructions, /持续沟通.*调整/);
  let task = (await snapshot()).tasks[0];
  const threadId = task.threadId;
  client.options.onEvent({ method: 'turn/completed', params: { threadId, turn: { id: task.turnId, status: 'completed', items: [] } } });
  await send(changed); await until(() => starts().length === 2);
  const resumed = client.calls.findLast(call => call.method === 'thread/resume')!;
  assert.equal(resumed.params.threadId, threadId);
  assert.doesNotMatch(resumed.params.developerInstructions, /项目目标：|free conversation|undefined/);
  assert.match(resumed.params.developerInstructions, /持续沟通.*调整/);
  assert.equal(starts()[1].params.input[0].text, changed);
  task = (await snapshot()).tasks[1];
  client.options.onEvent({ method: 'turn/completed', params: { threadId, turn: { id: task.turnId, status: 'completed', items: [] } } });
  await f.engine.command({ type: 'start', projectId: f.projectId, nodeId: 'plan', mode: 'codex', instruction: '根据最新沟通继续澄清需求。' });
  await until(() => starts().length === 3);
  const current = await snapshot();
  assert.equal(current.tasks[2].input, null);
  assert.equal(current.nodes[0].threadId, threadId);
  assert.deepEqual(current.conversation!.filter(entry => entry.direction === 'input').slice(0, 2).map(entry => entry.text), [first, changed]);
});

test('new template documents wait for an evolving user discussion instead of copying a creation goal', async t => {
  const root = mkdtempSync(join(projectDirectory(process.cwd(), '.runtime', 'implementation', 'project-direction'), 'template-'));
  const engine = new WorkflowEngine({ workbenchRoot: root, executable: 'unused' });
  t.after(() => engine.close()); await engine.init();
  await engine.command({ type: 'create_project', name: 'Discuss the product', root, template: 'web-product', goal: 'Discarded fixed echo-app goal' });
  for (const path of ['docs/design/product-brief.md', 'docs/design/requirements.md', 'docs/design/ui-ux.md', 'docs/design/architecture.md', 'docs/plans/mvp-001-implementation.md', '.planning/mvp-001/task_plan.md']) {
    const body = readFileSync(join(root, path), 'utf8');
    assert.doesNotMatch(body, /Discarded fixed echo-app goal|\n目标：/);
    assert.match(body, /沟通.*确认|待.*沟通/);
    assert.match(body, /调整/);
  }
});

test('legacy goals stay out of public snapshots and MCP context while the project and conversation reopen', async t => {
  const f = await fixture(t);
  const original = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!;
  await f.engine.close();
  const store = new ProjectStore(f.root);
  try {
    const legacy = store.read()!;
    legacy.project.goal = 'Stale fixed goal: message echo only';
    legacy.nodes[0].threads.codex = 'retained-thread';
    legacy.conversation.push({ id: 'original-history', seq: 1, nodeId: 'plan', taskId: null, threadId: 'retained-thread', turnId: 'old-turn', itemId: 'old-item', direction: 'output', source: { kind: 'node', nodeId: 'plan' }, text: 'Original reply and evidence', content: { type: 'agentMessage', id: 'old-item', text: 'Original reply and evidence' }, createdAt: '', status: 'completed' });
    store.save(legacy);
  } finally { store.close(); }
  const reopened = new WorkflowEngine({ workbenchRoot: f.root, executable: 'unused', accountFactory: accountFixture().factory, nativeFactory() { assert.fail('Reading the project must not run a model'); } });
  t.after(() => reopened.close()); await reopened.init();
  const result = await reopened.command({ type: 'create_project', name: 'Ignored', root: f.root });
  const snapshot = result.snapshot.selected!;
  assert.equal(snapshot.project.id, original.project.id);
  assert.equal(snapshot.nodes[0].threadId, 'retained-thread');
  assert.equal(snapshot.conversation!.find(entry => entry.id === 'original-history')!.text, 'Original reply and evidence');
  assert.equal(Object.hasOwn(snapshot.project, 'goal'), false);
  assert(result.snapshot.projects.every(project => !Object.hasOwn(project, 'goal')));
  const context: any = await reopened.invokeTool('get_project_context', {}, { identity: reopened.nodeIdentity(original.project.id, 'plan'), threadId: '', turnId: '', callId: 'read-context' });
  assert.equal(context.project.id, original.project.id); assert.equal(Object.hasOwn(context.project, 'goal'), false);
});
