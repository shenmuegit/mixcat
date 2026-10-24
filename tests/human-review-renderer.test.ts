import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NodeConfig } from '../src/renderer/NodeSettings.js';
import { Workbench } from '../src/renderer/Workbench.js';
import { ConversationFeed } from '../src/renderer/Conversation.js';
import type { HumanReviewPolicy, HumanReviewView, NodeView, ProjectSnapshot, TaskView } from '../src/shared/types.js';

const node: NodeView = { id: 'design', name: '设计', instructions: '保留职责', tools: ['get_project_context'], model: 'chosen', skills: [{ name: 'Saved skill', path: 'G:/fixture/skill' }], plugins: [{ name: 'Saved plugin', id: 'saved@local' }], resultSchema: {}, position: { x: 0, y: 0 }, revision: 1, threadId: null, status: 'idle' };
const policy: HumanReviewPolicy = { revision: 3, checkpoints: [
  { id: 'direction', name: '产品方向', ownerNodeId: 'product', requiredForNodeIds: ['design'], dependsOn: [], revision: 2 },
  { id: 'ui', name: '界面方案', ownerNodeId: 'design', requiredForNodeIds: [], dependsOn: ['direction'], revision: 1 },
] };
const nodes = [{ ...node, id: 'product', name: '产品', tools: ['request_review'] as NodeView['tools'] }, node];
const snapshot: ProjectSnapshot = { project: { id: 'p', name: 'Project', root: 'G:/fixture', goal: 'Goal', mode: 'codex', status: 'blocked', updatedAt: '' }, nodes: [node, nodes[0]], tasks: [], handoffs: [], activities: [], reviewPolicy: policy };
const workbench = (value: ProjectSnapshot) => renderToStaticMarkup(createElement(Workbench, { snapshot: value, runtime: null, execute: async () => null, busy: false, error: null, onError() {} }));

test('policy editor uses explicit owners, target nodes and prerequisites and exposes a local grant gap', async () => {
  const { ReviewPolicyEditor } = await import('../src/renderer/HumanReviews.js');
  const html = renderToStaticMarkup(createElement(ReviewPolicyEditor, { policy, nodes, busy: false, async onSave() {}, onError() {} }));
  for (const label of ['提交责任节点', '适用节点', '上游核对', '保存核对规则', '产品方向', '界面方案']) assert(html.includes(label), label);
  assert.match(html, /设计.*request_review.*节点配置/);
  assert.doesNotMatch(html, /仅提醒|自动通过|<textarea/);
  assert.equal(node.tools.includes('request_review'), false);
});

test('policy editor visibly rejects missing references and cycles, including owner deadlocks', async () => {
  const { ReviewPolicyEditor } = await import('../src/renderer/HumanReviews.js');
  for (const checkpoints of [
    [{ ...policy.checkpoints[0], ownerNodeId: 'removed' }],
    [{ ...policy.checkpoints[0], requiredForNodeIds: ['removed'] }],
    [{ ...policy.checkpoints[0], dependsOn: ['removed'] }],
    [policy.checkpoints[0], { ...policy.checkpoints[1], requiredForNodeIds: ['product'] }],
    [{ ...policy.checkpoints[0], dependsOn: ['ui'] }, policy.checkpoints[1]],
  ]) {
    const html = renderToStaticMarkup(createElement(ReviewPolicyEditor, { policy: { ...policy, checkpoints }, nodes, busy: false, async onSave() {}, onError() {} }));
    assert.match(html, /role="alert"/);
    assert.match(html, /不存在|循环|责任节点/);
    assert.match(html, /<button[^>]*disabled=""[^>]*>保存核对规则/);
  }
});

test('waiting review locks config and deletion while keeping capabilities, message input and rule entry accessible', () => {
  const task = { id: 'wait', nodeId: node.id, status: 'waiting_review', reviewDependencies: [{ checkpointId: 'direction', checkpointRevision: 2, reviewId: null, version: null }] } as TaskView;
  const config = renderToStaticMarkup(createElement(NodeConfig, { node, tasks: [task], busy: false, async onSave() { return node; }, onError() {} }));
  assert.match(config, /等待人工核对/);
  assert.match(config, /<button[^>]*disabled=""[^>]*>保存配置/);
  for (const text of ['可继续编辑草稿', 'Saved skill', 'Saved plugin', 'chosen', '保留职责']) assert(config.includes(text));
  assert.doesNotMatch(config, /<textarea[^>]*disabled|<select[^>]*disabled/);
  const html = workbench({ ...snapshot, tasks: [task] });
  assert.match(html, /人工核对规则/);
  assert.match(html, /产品方向.*等待首次提交/);
  assert.match(html, /<div class="detail-scroll session-scroll"[^>]*><div[^>]*><div class="field-note" role="status">1 条任务等待人工核对/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>删除节点/);
  assert.doesNotMatch(html, /<textarea id="task-instruction"[^>]*disabled/);
  assert.match(html, /输入.*保存.*通过后.*执行/);
  assert.match(workbench({ ...snapshot, reviewPolicy: undefined }), /人工核对规则/);
});

test('live review references prevent deletion even without unfinished tasks', () => {
  const html = workbench(snapshot);
  assert.match(html, /<button[^>]*disabled=""[^>]*>删除节点/);
  assert.match(html, /核对规则|核对事项/);
});

const review: HumanReviewView = { id: 'review-2', projectId: 'p', checkpointId: 'direction', checkpointRevision: 2, version: 2, requestId: 'request-2', nodeId: 'product', taskId: 'origin-task', threadId: 'origin-thread', turnId: 'origin-turn', callId: 'origin-call', title: '需求方案', content: '<img src=x onerror="window.injected=true">\n# 原文', attachments: [{ artifact_id: 'fixed', name: '需求.md', relativePath: '.mixcat/attachments/fixed.md', sha256: 'fixed-hash', size: 12 }], sourceFiles: [{ path: '需求.md', sha256: 'source-hash', size: 12 }], upstreamDependencies: [{ checkpointId: 'ui', checkpointRevision: 1, reviewId: 'upstream', version: 3 }], bundleHash: 'bundle-2', status: 'pending', createdAt: '2026-10-24T00:00:00Z', decision: null, supersededBy: null };

for (const change of ['replacement', 'rule', 'removed-rule', 'new-rule', 'transitive', 'current'] as const) test(`running review basis warning preserves execution: ${change}`, () => {
  const approved = (item: HumanReviewView): HumanReviewView => ({ ...item, status: 'approved', decision: { commandId: 'ok', reviewId: item.id, version: item.version, bundleHash: item.bundleHash, decision: 'approved', comment: '', createdAt: '', continuationTaskId: 'continue' } });
  const direction = approved({ ...review, upstreamDependencies: [] });
  const capture = { checkpointId: direction.checkpointId, checkpointRevision: direction.checkpointRevision, reviewId: direction.id, version: direction.version };
  const task = { id: 'running-task', nodeId: node.id, status: 'running', instruction: 'original', reviewDependencies: [capture] } as TaskView;
  const value = { ...structuredClone(snapshot), tasks: [task], humanReviews: [direction] };
  value.nodes[0].status = 'running';
  if (change === 'replacement' || change === 'transitive') value.humanReviews.push(approved({ ...direction, id: 'direction-3', version: 3 }));
  if (change === 'rule') value.reviewPolicy!.checkpoints[0].revision++;
  if (change === 'removed-rule') value.reviewPolicy!.checkpoints = value.reviewPolicy!.checkpoints.slice(1);
  if (change === 'new-rule') value.reviewPolicy!.checkpoints.push({ id: 'new', name: '新增规则', ownerNodeId: 'product', requiredForNodeIds: ['design'], dependsOn: [], revision: 1 });
  if (change === 'transitive') {
    const ui = approved({ ...review, id: 'ui-1', checkpointId: 'ui', checkpointRevision: 1, version: 1, upstreamDependencies: [capture] });
    value.humanReviews.push(ui); task.reviewDependencies = [{ checkpointId: 'ui', checkpointRevision: 1, reviewId: ui.id, version: 1 }];
  }
  const before = structuredClone(value), html = workbench(value);
  if (change === 'current') assert.doesNotMatch(html, /运行中任务的核对依据已过期/);
  else { assert.match(html, /运行中任务的核对依据已过期/); assert.match(html, /role="status"/); assert.match(html, change === 'new-rule' ? /新增规则/ : /产品方向|direction/); assert.match(html, change === 'new-rule' ? /新增/ : /版本 2/); }
  assert.match(html, /暂停节点/); assert.match(html, /停止本轮/); assert.deepEqual(value, before);
});

test('material failure evidence remains escaped and line-preserving in the existing card', async () => {
  const { HumanReviews } = await import('../src/renderer/HumanReviews.js');
  const error = '本事项 direction · 版本 2\n- <script>saved</script>\n+ <img src=x onerror=bad>';
  const actionStore = new Map([[JSON.stringify(['p', review.id]), { id: 'failed', state: 'failed' as const, error, command: { type: 'decide_review' as const, projectId: 'p', reviewId: review.id, version: review.version, bundleHash: review.bundleHash, decision: 'approved' as const, comment: '' } }]]);
  const html = renderToStaticMarkup(createElement(HumanReviews, { project: snapshot.project, policy, reviews: [review], tasks: [], nodes, actionStore, execute: async () => null, onOpen() {}, onError() {} }));
  assert.match(html, /<pre[^>]*role="alert"/); assert.match(html, /&lt;script&gt;saved/); assert.doesNotMatch(html, /<script|<img/);
});
test('review cards preserve fixed material, provenance, exact comments and distinct version history', async () => {
  const { HumanReviews } = await import('../src/renderer/HumanReviews.js');
  const older = { ...review, id: 'review-1', version: 1, status: 'superseded' as const, supersededBy: review.id, decision: { commandId: 'old-decision', reviewId: 'review-1', version: 1, bundleHash: 'old-bundle', decision: 'changes_requested' as const, comment: '  原始意见\n保留两边空格  ', createdAt: review.createdAt, continuationTaskId: 'continuation' } };
  const approved = { ...review, id: 'approved', checkpointId: 'ui', version: 1, status: 'approved' as const, decision: { ...older.decision, decision: 'approved' as const } };
  const html = renderToStaticMarkup(createElement(HumanReviews, { project: snapshot.project, policy, reviews: [older, review, approved], tasks: [], nodes, execute: async () => null, onOpen() {}, onError() {} }));
  for (const text of ['需求方案', '提出修改', '通过', '撤回未决事项', '版本 2', '版本历史', '已被替代', '已通过', '提出修改', '  原始意见\n保留两边空格  ', 'bundle-2', 'origin-thread', 'origin-task', 'origin-turn', 'origin-call', 'request-2', 'fixed-hash', 'source-hash', '需求.md', '版本 3']) assert(html.includes(text), text);
  assert.match(html, /&lt;img/); assert.doesNotMatch(html, /<img|<script|dangerouslySetInnerHTML/);
  assert.match(workbench({ ...snapshot, humanReviews: [review] }), /待人工核对 1/);
});

test('review history keeps original user/system input separate from formal decision controls', () => {
  const comment = '  原始意见\n  不覆盖';
  const entry = { id: 'decision-input', seq: 1, nodeId: 'design', taskId: 'continue', threadId: 'original-thread', turnId: null, itemId: null, direction: 'input' as const, source: { kind: 'system' as const }, text: comment, content: { type: 'reviewDecision', reviewId: 'review-1', version: 1, comment }, createdAt: review.createdAt };
  const html = renderToStaticMarkup(createElement(ConversationFeed, { entries: [entry, { ...entry, id: 'direct-user', seq: 2, source: { kind: 'user' } }], nodes, onOpen() {} }));
  assert(html.includes(comment)); assert.match(html, /系统续接 → 设计/); assert.match(html, /用户 → 设计/);
  assert.doesNotMatch(html, /确认通过|提出修改|decide_review/);
});

test('a failed decision restores its exact opinion and validates its length without truncation', async () => {
  const { HumanReviews } = await import('../src/renderer/HumanReviews.js');
  for (const decision of ['approved', 'changes_requested'] as const) for (const comment of ['  原始意见\n保留  ', `  ${'长'.repeat(19996)}\n `, `  ${'长'.repeat(19997)}\n `]) {
    const actionStore = new Map([[JSON.stringify(['p', review.id]), { id: 'failed-action', state: 'failed' as const, error: 'fixture validation failure', command: { type: 'decide_review' as const, projectId: 'p', reviewId: review.id, version: review.version, bundleHash: review.bundleHash, decision, comment } }]]);
    const html = renderToStaticMarkup(createElement(HumanReviews, { project: snapshot.project, policy, reviews: [review], tasks: [], nodes, actionStore, execute: async () => null, onOpen() {}, onError() {} }));
    assert.match(html, /role="alert"/); assert.match(html, /fixture validation failure/);
    assert.match(html, /<textarea/); assert(html.includes(comment));
    assert.doesNotMatch(html, /重试原操作|maxlength/);
    assert.match(html, /保留未决，返回/);
    if (comment.length > 20000) {
      assert.match(html, /20000/); assert.match(html, /aria-invalid="true"/);
      assert.match(html, /<button[^>]*disabled=""[^>]*>确认(?:提出修改|通过)/);
    } else assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>确认(?:提出修改|通过)/);
  }
});
