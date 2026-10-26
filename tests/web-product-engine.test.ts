import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WorkflowEngine } from '../src/core/engine.js';
import { projectDirectory } from '../src/core/paths.js';
import { accountFixture } from './account-fixture.js';
import { ProjectStore } from '../src/core/store.js';
import { createWebProductReviewPolicy } from '../src/core/web-product.js';
import type { CodexPort, NativeClientOptions } from '../src/shared/types.js';

async function setup(t: { after(fn: () => Promise<void>): void }) {
  const root = mkdtempSync(join(projectDirectory(resolve('.'), '.runtime', 'implementation', 'web-product-team-20261022', 'evidence'), 'template-engine-'));
  process.env.MIXCAT_HOST_CODEX_HOME = projectDirectory(root, 'host');
  const nativeFactory = (_options: NativeClientOptions): CodexPort => ({
    async connect() {}, async close() {}, async rpc(method) {
      if (method === 'model/list') return { data: [{ model: 'actual-model', displayName: 'Actual model', isDefault: true }], nextCursor: null };
      if (method === 'skills/list') return { data: [{ skills: [], errors: [] }] };
      if (method === 'plugin/installed') return { marketplaces: [], marketplaceLoadErrors: [] };
      if (method === 'hooks/list') return { data: [{ hooks: [], errors: [], warnings: [] }] };
      if (method === 'mcpServerStatus/list') return { data: [], nextCursor: null };
      return {};
    },
  });
  const options = { workbenchRoot: root, executable: 'fixture', nativeFactory, accountFactory: accountFixture().factory };
  const engine = new WorkflowEngine(options); await engine.init();
  t.after(() => engine.close());
  return { root, engine, options };
}

test('Web product creation persists seven independent role definitions, guidance edges and owned documents without replacing user files', async t => {
  const f = await setup(t), root = projectDirectory(f.root, 'product');
  const brief = join(projectDirectory(root, 'docs', 'design'), 'product-brief.md');
  writeFileSync(brief, 'User-authored product brief');
  const reply = await f.engine.command({ type: 'create_project', root, name: 'Tiny message', goal: 'Submit one message and display it', template: 'web-product' });
  const selected = reply.snapshot.selected!;
  assert.equal(selected.project.template, 'web-product');
  assert.deepEqual(selected.reviewPolicy, createWebProductReviewPolicy());
  assert.deepEqual(selected.nodes.map(node => node.id), ['product', 'requirements', 'design', 'frontend', 'backend', 'test', 'architect']);
  assert(selected.nodes.every(node => node.threadId === null && node.model === null && node.planId === 'mvp-001'));
  assert(selected.edges!.some(edge => edge.sourceNodeId === 'test' && edge.targetNodeId === 'frontend'));
  assert.equal(readFileSync(brief, 'utf8'), 'User-authored product brief');
  assert.match(readFileSync(join(root, '.planning', 'mvp-001', 'task_plan.md'), 'utf8'), /产品经理/);
  const product = selected.nodes[0];
  await f.engine.command({ type: 'save_node', projectId: selected.project.id, node: { ...product, name: 'My coordinator' } });
  const repeated = await f.engine.command({ type: 'create_project', root, name: 'Ignored rename', goal: 'Ignored goal', template: 'web-product' });
  assert.equal(repeated.snapshot.selected!.nodes[0].name, 'My coordinator');
  assert.deepEqual(repeated.snapshot.selected!.reviewPolicy, selected.reviewPolicy);
  await f.engine.close();
  const reopened = new WorkflowEngine(f.options); t.after(() => reopened.close()); await reopened.init();
  const restored = (await reopened.command({ type: 'snapshot', projectId: selected.project.id })).snapshot.selected!;
  assert.equal(restored.nodes[0].name, 'My coordinator');
  assert.equal(restored.nodes.length, 7);
  assert.equal(readFileSync(brief, 'utf8'), 'User-authored product brief');
});

test('omitted template keeps legacy nodes, invalid templates reject and planning IDs cannot escape the project', async t => {
  const f = await setup(t);
  const reply = await f.engine.command({ type: 'create_project', root: f.root, name: 'Basic', goal: 'Keep legacy behavior' });
  assert.deepEqual(reply.snapshot.selected!.nodes.map(node => node.id), ['plan', 'implement', 'review']);
  assert.deepEqual(reply.snapshot.selected!.reviewPolicy, { revision: 0, checkpoints: [] });
  await assert.rejects(f.engine.command({ type: 'create_project', root: projectDirectory(f.root, 'bad'), name: 'Bad', goal: 'Bad template', template: 'unknown' } as any), /模板/);
  await assert.rejects(f.engine.command({ type: 'save_node', projectId: reply.snapshot.selected!.project.id, node: { ...reply.snapshot.selected!.nodes[0], planId: '../other-project' } }), /计划/);
});

test('recommended setup keeps native default and user capabilities while reporting unavailable catalog entries', async t => {
  const f = await setup(t);
  const reply = await f.engine.command({ type: 'create_project', root: f.root, name: 'Web', goal: 'One feature', template: 'web-product' });
  const node = reply.snapshot.selected!.nodes[3];
  const policy = { ...reply.snapshot.selected!.reviewPolicy!, checkpoints: [] };
  const saved = await f.engine.command({ type: 'save_review_policy', projectId: reply.snapshot.selected!.project.id, policy });
  assert.deepEqual(saved.snapshot.selected!.reviewPolicy, { revision: policy.revision + 1, checkpoints: [] });
  await f.engine.command({ type: 'save_node', projectId: reply.snapshot.selected!.project.id, node: { ...node, tools: ['get_project_context'], model: null, skills: [{ name: 'custom', path: join(f.root, 'custom', 'SKILL.md') }] } });
  const result = await f.engine.command({ type: 'configure_template', projectId: reply.snapshot.selected!.project.id });
  assert.equal(result.snapshot.selected!.nodes[3].model, null);
  assert(result.snapshot.selected!.nodes[3].skills!.some(skill => skill.name === 'custom'));
  assert(result.catalog!.errors.some(error => /skill|插件|能力|plugin/.test(error)));
  assert.equal(result.catalog!.models[0].id, 'actual-model');
  assert.deepEqual(result.snapshot.selected!.reviewPolicy, saved.snapshot.selected!.reviewPolicy);
  assert.deepEqual(result.snapshot.selected!.nodes[3].tools, ['get_project_context']);
  const repeated = await f.engine.command({ type: 'configure_template', projectId: reply.snapshot.selected!.project.id });
  assert.deepEqual(repeated.snapshot.selected!.reviewPolicy, saved.snapshot.selected!.reviewPolicy);
  assert.deepEqual(repeated.snapshot.selected!.nodes[3].tools, ['get_project_context']);
  const custom = await f.engine.command({ type: 'save_review_policy', projectId: reply.snapshot.selected!.project.id, policy: { revision: repeated.snapshot.selected!.reviewPolicy!.revision, checkpoints: [{ id: 'custom', name: '用户规则', ownerNodeId: 'requirements', requiredForNodeIds: ['test'], dependsOn: [], revision: 1 }] } });
  const configuredAgain = await f.engine.command({ type: 'configure_template', projectId: reply.snapshot.selected!.project.id });
  assert.deepEqual(configuredAgain.snapshot.selected!.reviewPolicy, custom.snapshot.selected!.reviewPolicy);
  const createAgain = await f.engine.command({ type: 'create_project', root: f.root, name: 'Retry', goal: 'Retry', template: 'web-product' });
  assert.deepEqual(createAgain.snapshot.selected!.reviewPolicy, custom.snapshot.selected!.reviewPolicy);
});

test('legacy Web migration and create retry do not retrofit policy or grants', async t => {
  const f = await setup(t), root = projectDirectory(f.root, 'legacy');
  const created = await f.engine.command({ type: 'create_project', root, name: 'Legacy', goal: 'Legacy', template: 'web-product' });
  const projectId = created.snapshot.selected!.project.id;
  await f.engine.close();
  const store = new ProjectStore(root), legacy: any = store.read()!;
  legacy.nodes = legacy.nodes.filter((node: any) => node.id !== 'architect');
  legacy.edges = legacy.edges.filter((edge: any) => edge.sourceNodeId !== 'architect' && edge.targetNodeId !== 'architect');
  delete legacy.reviewPolicy; delete legacy.humanReviews;
  for (const node of legacy.nodes) node.tools = ['get_project_context'];
  store.db.prepare('UPDATE project_state SET schema_version=3, body=? WHERE id=1').run(JSON.stringify(legacy));
  store.close();
  const reopened = new WorkflowEngine(f.options); t.after(() => reopened.close()); await reopened.init();
  const result = await reopened.command({ type: 'create_project', root, name: 'Retry', goal: 'Retry', template: 'web-product' });
  assert.equal(result.snapshot.selected!.project.id, projectId);
  assert.equal(result.snapshot.selected!.nodes.length, 6);
  assert.deepEqual(result.snapshot.selected!.reviewPolicy, { revision: 0, checkpoints: [] });
  const configured = await reopened.command({ type: 'configure_template', projectId });
  assert.deepEqual(configured.snapshot.selected!.reviewPolicy, { revision: 0, checkpoints: [] });
  assert(configured.snapshot.selected!.nodes.every(node => JSON.stringify(node.tools) === JSON.stringify(['get_project_context'])));
});

test('default Web gate saves arbitrary input, locks configuration/deletion and still allows movement', async t => {
  const f = await setup(t);
  const created = await f.engine.command({ type: 'create_project', root: f.root, name: 'Gated', goal: 'Gated', template: 'web-product' });
  const selected = created.snapshot.selected!, projectId = selected.project.id;
  const input = [{ type: 'text', text: '  保留原文\n', text_elements: [], arbitrary: { value: null } }];
  const architecture = await f.engine.command({ type: 'send_message', projectId, nodeId: 'architect', input, mode: 'codex' });
  assert.equal(architecture.snapshot.selected!.tasks.at(-1)!.status, 'waiting_review');
  assert.deepEqual(architecture.snapshot.selected!.tasks.at(-1)!.reviewDependencies!.map(item => item.checkpointId), ['product-direction']);
  const sent = await f.engine.command({ type: 'send_message', projectId, nodeId: 'design', input, mode: 'codex' });
  assert.equal(sent.snapshot.selected!.tasks.at(-1)!.status, 'waiting_review');
  assert.deepEqual(sent.snapshot.selected!.tasks.at(-1)!.input, input);
  await assert.rejects(f.engine.command({ type: 'save_node', projectId, node: { ...selected.nodes.find(node => node.id === 'design')!, name: 'Changed' } }), /任务/);
  await assert.rejects(f.engine.command({ type: 'delete_node', projectId, nodeId: 'design' }), /核对规则/);
  const moved = await f.engine.command({ type: 'move_node', projectId, nodeId: 'design', position: { x: 100, y: 200 } });
  assert.deepEqual(moved.snapshot.selected!.nodes.find(node => node.id === 'design')!.position, { x: 100, y: 200 });
  assert.equal(moved.snapshot.selected!.tasks.at(-1)!.status, 'waiting_review');
});
