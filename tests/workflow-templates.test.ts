import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WorkflowEngine } from '../src/core/engine.js';
import { projectDirectory } from '../src/core/paths.js';
import type { CodexPort } from '../src/shared/types.js';
import { accountFixture } from './account-fixture.js';
import { selectWebProductCapabilities } from '../src/core/web-product.js';
import { collaborationFixture } from './collaboration-fixture.js';
import { until } from './runtime-fixture.js';
import { edgeToolName } from '../src/core/mcp.js';

const scenarios = [
  { template: 'research-analysis', roles: ['research-lead', 'researcher', 'fact-checker', 'reporter'], feedback: ['fact-checker', 'researcher'] },
  { template: 'content-creation', roles: ['editor', 'writer', 'content-checker'], feedback: ['content-checker', 'writer'] },
  { template: 'bug-fix', roles: ['diagnose', 'fix', 'verify'], feedback: ['verify', 'fix'] },
] as const;

test('new built-in workflows create independent roles and feedback routes and restore edited definitions', async t => {
  const root = mkdtempSync(join(projectDirectory(resolve('.'), '.runtime', 'implementation', 'builtin-templates-20261103'), 'engine-'));
  const options = { workbenchRoot: root, executable: 'unused', nativeFactory() { assert.fail('Creating or reopening a template must not start native work'); } };
  const engine = new WorkflowEngine(options); t.after(() => engine.close()); await engine.init();
  const created = [];
  for (const scenario of scenarios) {
    const result = await engine.command({ type: 'create_project', root: projectDirectory(root, scenario.template), name: scenario.template, template: scenario.template });
    assert.equal(result.projectCreated, true);
    const state = result.snapshot.selected!;
    assert.equal(state.project.template, scenario.template);
    assert.deepEqual(state.nodes.map(node => node.id), [...scenario.roles]);
    assert(state.nodes.every(node => node.threadId === null && node.model === null && node.planId === scenario.template));
    assert(state.nodes.every(node => node.instructions.includes('request_review') && node.instructions.includes('get_project_context')));
    assert(state.nodes.every(node => node.tools.every(tool => !tool.startsWith('comfy_'))));
    assert.deepEqual([state.tasks, state.messages, state.conversation, state.reviewPolicy?.checkpoints], [[], [], [], []]);
    assert.equal(Object.hasOwn(state.project, 'goal'), false);
    assert(state.edges!.some(edge => edge.sourceNodeId === scenario.feedback[0] && edge.targetNodeId === scenario.feedback[1] && edge.condition.trim()));
    const ids = new Set(state.nodes.map(node => node.id));
    assert(state.edges!.every(edge => ids.has(edge.sourceNodeId) && ids.has(edge.targetNodeId) && edge.condition.trim()));
    await engine.command({ type: 'save_node', projectId: state.project.id, node: { ...state.nodes[0], name: 'My coordinator' } });
    await engine.command({ type: 'save_edge', projectId: state.project.id, edge: { ...state.edges![0], condition: 'User-edited delivery condition' } });
    created.push({ id: state.project.id, root: state.project.root, template: scenario.template });
  }
  assert.equal(new Set(created.map(project => project.id)).size, 3);
  await engine.close();
  const reopened = new WorkflowEngine(options); t.after(() => reopened.close()); await reopened.init();
  for (const project of created) {
    const reply = await reopened.command({ type: 'create_project', root: project.root, name: 'Ignored', template: 'web-product' });
    assert.equal(reply.projectCreated, false);
    const state = reply.snapshot.selected!;
    assert.equal(state.project.id, project.id);
    assert.equal(state.project.template, project.template);
    assert.equal(state.nodes[0].name, 'My coordinator');
    assert.equal(state.edges![0].condition, 'User-edited delivery condition');
    assert.deepEqual(state.tasks, []);
    assert.equal((await reopened.command({ type: 'create_project', root: project.root, name: 'Already open' })).projectCreated, false);
  }
});

for (const scenario of scenarios) test(`${scenario.template} delivers work and linked feedback through public conditional-edge MCP`, async t => {
  const f = await collaborationFixture(t, scenario.template);
  const [checkerId, workerId] = scenario.feedback;
  const source = await f.active(workerId);
  const forwardEdge = f.state.edges.find(edge => edge.sourceNodeId === workerId && edge.targetNodeId === checkerId)!;
  const receipt = await f.invoke(workerId, edgeToolName(forwardEdge.id, forwardEdge.targetNodeId), { request_id: 'submit-v1', reason: 'Ready for independent verification', content: { document: 'Draft v1', evidence: 'Original source' } }, 'submit-v1');
  f.finish(source);
  await until(() => f.state.tasks.some(task => task.id === receipt.target_task_id && task.status === 'running' && !!task.turnId));
  const checker = f.state.tasks.find(task => task.id === receipt.target_task_id)!;
  assert.notEqual(checker.threadId, source.threadId);
  const returnEdge = f.state.edges.find(edge => edge.sourceNodeId === checkerId && edge.targetNodeId === workerId)!;
  const feedback = await f.invoke(checkerId, edgeToolName(returnEdge.id, returnEdge.targetNodeId), { request_id: 'feedback-v1', reason: 'Verification found a specific evidence gap', content: { issue: 'Missing evidence', expected: 'Attach the original source' }, reply_to: receipt.message_id }, 'feedback-v1');
  f.finish(checker);
  await until(() => f.state.tasks.some(task => task.id === feedback.target_task_id && task.status === 'running' && !!task.turnId));
  const snapshot = (await f.engine.command({ type: 'snapshot', projectId: f.projectId })).snapshot.selected!;
  const resumed = snapshot.tasks.find(task => task.id === feedback.target_task_id)!;
  assert.equal(resumed.nodeId, workerId);
  assert.equal(resumed.threadId, source.threadId);
  assert.deepEqual(resumed.input, { issue: 'Missing evidence', expected: 'Attach the original source' });
  assert.equal(snapshot.messages!.find(message => message.message_id === feedback.message_id)!.replyTo, receipt.message_id);
  f.finish(f.state.tasks.find(task => task.id === feedback.target_task_id)!);
  await until(() => f.state.tasks.every(task => task.status === 'completed'));
});

test('template configuration selects native catalog capabilities and reports missing entries without starting model work', async t => {
  const root = mkdtempSync(join(projectDirectory(resolve('.'), '.runtime', 'implementation', 'builtin-templates-20261103'), 'capabilities-'));
  process.env.MIXCAT_HOST_CODEX_HOME = projectDirectory(root, 'host');
  const calls: string[] = [];
  const names = ['ecc:research-ops', 'ecc:deep-research', 'ecc:article-writing', 'ecc:content-engine', 'superpowers:systematic-debugging', 'ecc:coding-standards', 'ecc:verification-loop', 'ponytail:ponytail'];
  const nativeFactory = (): CodexPort => ({ async connect() {}, async close() {}, async rpc(method) {
    calls.push(method);
    if (method === 'account/read') return { account: { email: 'fixture' } };
    if (method === 'windowsSandbox/readiness') return { status: 'configured' };
    if (method === 'model/list') return { data: [], nextCursor: null };
    if (method === 'skills/list') return { data: [{ skills: names.map((name, index) => ({ name, path: join(root, `skill-${index}`, 'SKILL.md'), enabled: true })), errors: [] }] };
    if (method === 'plugin/installed') return { marketplaces: [{ plugins: ['ecc', 'superpowers', 'ponytail'].map(name => ({ id: `${name}@native`, name, installed: true, enabled: true })) }], marketplaceLoadErrors: [] };
    if (method === 'hooks/list') return { data: [{ hooks: [], errors: [] }] };
    if (method === 'mcpServerStatus/list') return { data: [], nextCursor: null };
    assert.fail(`Unexpected native operation during configuration: ${method}`);
  } });
  const engine = new WorkflowEngine({ workbenchRoot: root, executable: 'fixture', nativeFactory, accountFactory: accountFixture().factory });
  t.after(() => engine.close()); await engine.init();
  for (const scenario of scenarios) {
    const created = (await engine.command({ type: 'create_project', root: projectDirectory(root, scenario.template), name: scenario.template, template: scenario.template })).snapshot.selected!;
    const custom = { name: 'user-skill', path: join(root, 'user', 'SKILL.md') };
    await engine.command({ type: 'save_node', projectId: created.project.id, node: { ...created.nodes[0], model: 'user-model', skills: [custom] } });
    const result = await engine.command({ type: 'configure_template', projectId: created.project.id });
    const selected = result.snapshot.selected!;
    assert.equal(selected.nodes[0].model, 'user-model');
    assert(selected.nodes[0].skills!.some(skill => skill.path === custom.path));
    assert(selected.nodes.every(node => node.skills!.some(skill => names.includes(skill.name))));
    assert(selected.nodes.every(node => node.plugins!.some(plugin => plugin.id === 'ecc@native')));
    assert(result.catalog!.errors.some(error => error.includes('planning-with-files')));
    assert(selected.nodes.every(node => node.skills!.every(skill => skill.name !== 'planning-with-files')));
    assert.deepEqual(selected.tasks, []);
    const repeated = (await engine.command({ type: 'configure_template', projectId: created.project.id })).snapshot.selected!;
    assert.deepEqual(repeated.nodes, selected.nodes);
  }
  assert(calls.every(method => !['thread/start', 'thread/resume', 'turn/start', 'plugin/install', 'marketplace/add'].includes(method)));
});

test('template recommendations do not select a host-cache plugin that is not installed in the native catalog', () => {
  const result = selectWebProductCapabilities([{ id: 'product', name: 'Product', instructions: '', tools: [], resultSchema: {}, position: { x: 0, y: 0 }, revision: 1 }], {
    models: [], skills: [], plugins: [{ id: 'ecc@host-import', name: 'ecc', installed: false }], errors: [],
  });
  assert.deepEqual(result.nodes[0].plugins, []);
  assert(result.missing.includes('product: plugin ecc'));
});
