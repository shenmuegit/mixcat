import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { projectDirectory } from '../src/core/paths.js';
import { createWebProductTemplate, initializeWebProductFiles, selectWebProductCapabilities } from '../src/core/web-product.js';
import { WORKFLOW_TOOLS, type CapabilityCatalog } from '../src/shared/types.js';

test('new Web review policy has exactly the two versioned business checkpoints and independent values', async () => {
  const { createWebProductReviewPolicy } = await import('../src/core/web-product.js');
  const policy = createWebProductReviewPolicy();
  assert.deepEqual(policy, { revision: 1, checkpoints: [
    { id: 'product-direction', name: '产品需求方向', ownerNodeId: 'product', requiredForNodeIds: ['design', 'backend', 'frontend', 'architect'], dependsOn: [], revision: 1 },
    { id: 'ui-ue', name: 'UI/UE 方案', ownerNodeId: 'design', requiredForNodeIds: ['frontend'], dependsOn: ['product-direction'], revision: 1 },
  ] });
  policy.checkpoints[0].requiredForNodeIds.pop();
  assert.deepEqual(createWebProductReviewPolicy().checkpoints[0].requiredForNodeIds, ['design', 'backend', 'frontend', 'architect']);
  const nodes = createWebProductTemplate().nodes;
  for (const node of nodes) {
    assert.match(node.instructions, /当前.*get_project_context/);
    assert.match(node.instructions, /request_review/);
    assert.match(node.instructions, /回执.*编号/);
    assert.match(node.instructions, /保留.*材料版本/);
    assert.match(node.instructions, /计划.*进展/);
  }
});

const base = projectDirectory(resolve('.'), '.runtime', 'implementation', 'web-product-team-20261022', 'fixtures');
const fixture = () => mkdtempSync(resolve(base, 'template-'));

test('architecture and backend have separate responsibilities and explicit technical collaboration routes', () => {
  const { nodes, edges } = createWebProductTemplate();
  const architect = nodes.find(node => node.id === 'architect');
  const backend = nodes.find(node => node.id === 'backend')!;
  assert.equal(architect?.name, '架构师');
  assert.equal(backend.name, '后端开发');
  assert.match(architect!.instructions, /architecture\.md.*接口契约.*主要维护者/);
  assert.match(backend.instructions, /依据架构师.*接口契约/);
  assert.doesNotMatch(backend.instructions, /牵头技术架构|architecture\.md.*主要维护者/);
  assert.deepEqual(edges.filter(edge => edge.sourceNodeId === 'architect').map(edge => edge.targetNodeId), ['backend', 'frontend']);
  for (const [source, target] of [['requirements', 'architect'], ['backend', 'architect'], ['frontend', 'architect']])
    assert.ok(edges.some(edge => edge.sourceNodeId === source && edge.targetNodeId === target));
  assert.ok(!edges.some(edge => edge.sourceNodeId === 'requirements' && edge.targetNodeId === 'backend'));
});

test('Web template has seven independent roles, free results and ordinary message routes', () => {
  const { nodes, edges } = createWebProductTemplate();
  assert.deepEqual(nodes.map(node => node.id), ['product', 'requirements', 'design', 'frontend', 'backend', 'test', 'architect']);
  for (const node of nodes) {
    assert.equal(node.revision, 1); assert.equal(node.planId, 'mvp-001');
    assert.deepEqual(node.resultSchema, {}); assert.equal(node.model, null);
    assert.deepEqual(node.tools, [...WORKFLOW_TOOLS]);
    assert.match(node.instructions, /出边动态生成的 edge_ 工具/); assert.match(node.instructions, /reply_to/);
    assert.match(node.instructions, /原生/); assert.match(node.instructions, /维护者/);
  }
  for (const id of ['frontend', 'backend', 'test']) {
    const role = nodes.find(node => node.id === id)!;
    assert.match(role.instructions, /Ponytail.*full/); assert.match(role.instructions, /GitNexus/);
  }
  for (const [source, target] of [['requirements', 'test'], ['backend', 'frontend'], ['test', 'frontend'], ['test', 'backend'], ['test', 'design'], ['test', 'requirements'], ['test', 'product']]) {
    assert.ok(edges.some(edge => edge.sourceNodeId === source && edge.targetNodeId === target));
  }
  assert.equal(new Set(edges.map(edge => edge.id)).size, edges.length);
  assert.ok(edges.every(edge => edge.revision === 1 && edge.condition.trim() && nodes.some(node => node.id === edge.sourceNodeId) && nodes.some(node => node.id === edge.targetNodeId)));
  nodes[0].tools.pop();
  assert.deepEqual(createWebProductTemplate().nodes[0].tools, [...WORKFLOW_TOOLS]);
});

test('initialization creates owned documents once and preserves existing user contents on retry', () => {
  const root = fixture();
  projectDirectory(root, 'docs', 'design');
  const brief = resolve(root, 'docs/design/product-brief.md'); writeFileSync(brief, '用户的产品目标\n');
  const created = initializeWebProductFiles(root, '留言板', '发布并查看留言');
  assert.ok(created.length >= 8); assert.ok(!created.includes(brief));
  assert.equal(readFileSync(brief, 'utf8'), '用户的产品目标\n');
  assert.match(readFileSync(resolve(root, '.planning/mvp-001/task_plan.md'), 'utf8'), /产品经理/);
  assert.match(readFileSync(resolve(root, 'docs/plans/mvp-001-implementation.md'), 'utf8'), /留言板/);
  assert.match(readFileSync(resolve(root, 'docs/design/requirements.md'), 'utf8'), /发布并查看留言/);
  assert.match(readFileSync(resolve(root, 'docs/reports/mvp-001/test-report.md'), 'utf8'), /未验证/);
  assert.match(readFileSync(resolve(root, 'docs/design/architecture.md'), 'utf8'), /主要维护者：架构师/);
  for (const path of ['docs/design/product-brief.md', 'docs/design/requirements.md', 'docs/design/ui-ux.md', 'docs/plans/mvp-001-implementation.md', '.planning/mvp-001/progress.md']) {
    if (path === 'docs/design/product-brief.md') continue; // user-authored document is preserved
    assert.match(readFileSync(resolve(root, path), 'utf8'), /人工核对/);
  }
  assert.deepEqual(initializeWebProductFiles(root, '不同名称', '不同目标'), []);
  assert.equal(readFileSync(brief, 'utf8'), '用户的产品目标\n');
});

test('all target ancestors and existing target files are checked before any initialization writes', () => {
  for (const obstacle of ['.planning/mvp-001/progress.md', 'docs/plans', 'docs/reports/mvp-001/test-report.md']) {
    const root = fixture(), path = resolve(root, obstacle);
    if (obstacle === 'docs/plans') { projectDirectory(root, 'docs'); writeFileSync(path, 'user file'); }
    else mkdirSync(path, { recursive: true });
    assert.throws(() => initializeWebProductFiles(root, '产品', '目标'), /目录|文件/);
    assert.equal(existsSync(resolve(root, 'docs/design/product-brief.md')), false);
  }
});

test('initialization rejects directory junctions and dangling file links without writing through them', () => {
  for (const dangling of [false, true]) {
    const root = fixture(), target = fixture();
    if (dangling) {
      projectDirectory(root, '.planning', 'mvp-001');
      symlinkSync(resolve(target, 'missing.md'), resolve(root, '.planning/mvp-001/progress.md'), 'file');
    } else symlinkSync(target, resolve(root, '.planning'), 'junction');
    assert.throws(() => initializeWebProductFiles(root, '产品', '目标'), /链接|联接/);
    assert.equal(existsSync(resolve(root, 'docs')), false);
    assert.equal(existsSync(resolve(target, 'missing.md')), false);
  }
  assert.throws(() => initializeWebProductFiles('C:/invalid', '产品', '目标'), /非 C/);
});

test('capability selection resolves actual catalog entries and preserves user selections and model', () => {
  const nodes = createWebProductTemplate().nodes;
  nodes[0].skills = [{ name: 'custom', path: 'G:/user/custom/SKILL.md' }];
  nodes[0].plugins = [{ name: 'Custom', id: 'custom@user' }];
  nodes[1].model = 'user-selected-model';
  const names = ['product-lens', 'ecc:product-capability', 'impeccable', 'frontend-patterns', 'backend-patterns', 'e2e-testing', 'planning-with-files', 'ponytail:ponytail', 'gitnexus-exploring', 'gitnexus-impact-analysis', 'ecc:architecture-decision-records'];
  const catalog: CapabilityCatalog = {
    models: [{ id: 'catalog-model', name: 'Actual model' }],
    skills: names.map((name, index) => ({ name, path: `G:/actual/skill-${index}/SKILL.md` })),
    plugins: [{ id: 'ecc@actual', name: 'Everything Claude Code' }, { id: 'superpowers@actual', name: 'Superpowers' }, { id: 'ponytail@actual', name: 'Ponytail', installed: false }], errors: [],
  };
  const before = structuredClone(nodes), result = selectWebProductCapabilities(nodes, catalog);
  assert.deepEqual(nodes, before); assert.deepEqual(result.missing, []);
  assert.equal(result.nodes[0].model, null); assert.equal(result.nodes[1].model, 'user-selected-model');
  assert.ok(result.nodes[0].skills!.some(skill => skill.path === 'G:/user/custom/SKILL.md'));
  assert.ok(result.nodes[0].plugins!.some(plugin => plugin.id === 'custom@user'));
  assert.ok(result.nodes[0].skills!.some(skill => skill.name === 'product-lens'));
  assert.ok(result.nodes[3].skills!.some(skill => skill.name === 'ponytail:ponytail'));
  assert.ok(result.nodes[3].plugins!.some(plugin => plugin.id === 'ponytail@actual'));
  assert.ok(result.nodes.find(node => node.id === 'architect')!.skills!.some(skill => skill.name === 'ecc:architecture-decision-records'));
  assert.deepEqual(selectWebProductCapabilities(result.nodes, catalog), result);
});

test('missing capability entries stay visibly missing without invented selections', () => {
  const nodes = createWebProductTemplate().nodes;
  const { nodes: selected, missing } = selectWebProductCapabilities(nodes, { models: [], skills: [], plugins: [], errors: ['offline'] });
  assert.ok(missing.some(item => item.includes('product') && item.includes('product-lens')));
  assert.ok(missing.some(item => item.includes('frontend') && item.includes('ponytail')));
  assert.ok(missing.some(item => item.includes('superpowers')));
  assert.ok(selected.every(node => node.model === null && !node.skills?.length && !node.plugins?.length));
});

test('a different skill namespace does not accidentally activate a similarly named role skill', () => {
  const result = selectWebProductCapabilities(createWebProductTemplate().nodes, {
    models: [], skills: [{ name: 'other:product-lens', path: 'G:/other/SKILL.md' }], plugins: [], errors: [],
  });
  assert.ok(result.missing.includes('product: skill ecc:product-lens'));
  assert.deepEqual(result.nodes[0].skills, []);
});
