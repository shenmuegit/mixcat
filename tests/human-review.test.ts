import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { ProjectState, StoredHumanReview, StoredTask } from '../src/core/model.js';
import type { HumanReviewPolicy, ReviewDependency, TaskStatus } from '../src/shared/types.js';
import { ProjectStore } from '../src/core/store.js';
import { projectDirectory } from '../src/core/paths.js';

async function domain() {
  const module = await import('../src/core/reviews.js').catch(() => null);
  assert.ok(module, 'the review domain must exist before configured tasks can be released');
  return module;
}
const createdAt = '2026-10-22T00:00:00.000Z';
function fixture(): ProjectState {
  return {
    project: { id: 'project', root: resolve('.'), name: 'review', goal: 'review', status: 'idle', mode: 'codex', updatedAt: createdAt, template: 'web-product' },
    nodes: ['product', 'design', 'frontend'].map(id => ({ id, name: id, instructions: '', tools: ['get_project_context'], resultSchema: {}, position: { x: 0, y: 0 }, revision: 1, threads: {}, status: id === 'frontend' ? 'paused' : 'idle' })),
    tasks: [], handoffs: [], activities: [], edges: [], conversation: [], messages: [], workflowReceipts: [], runId: null, maxSteps: 12,
    reviewPolicy: { revision: 0, checkpoints: [] }, humanReviews: [],
  };
}
function policy(): HumanReviewPolicy {
  return { revision: 1, checkpoints: [
    { id: 'direction', name: '方向', ownerNodeId: 'product', requiredForNodeIds: ['design'], dependsOn: [], revision: 1 },
    { id: 'ui', name: '界面', ownerNodeId: 'design', requiredForNodeIds: ['frontend'], dependsOn: ['direction'], revision: 1 },
  ] };
}
function review(checkpointId = 'direction', version = 1, upstreamDependencies: ReviewDependency[] = []): StoredHumanReview {
  const bundle = '{"title":" 原始标题 ","content":{"a":1}}', id = `${checkpointId}-${version}`;
  return {
    id, projectId: 'project', checkpointId, checkpointRevision: 1, version, nodeId: checkpointId === 'ui' ? 'design' : 'product', taskId: 'source-task', threadId: 'thread', turnId: 'turn', callId: 'call', requestId: `request-${id}`,
    request: { request_id: `request-${id}`, checkpoint_id: checkpointId, title: ' 原始标题 ', content: { a: 1 }, attachments: [] },
    title: ' 原始标题 ', content: { a: 1 }, attachments: [], sourceFiles: [], upstreamDependencies, bundle,
    bundleHash: createHash('sha256').update(bundle).digest('hex'), status: 'pending', createdAt, decision: null, supersededBy: null,
  };
}
function approve(item: StoredHumanReview) {
  item.status = 'approved'; item.decision = { commandId: `command-${item.id}`, reviewId: item.id, version: item.version, bundleHash: item.bundleHash, decision: 'approved', comment: ' 原始意见\n ', createdAt, continuationTaskId: `continue-${item.id}` };
}
function task(state: ProjectState, status: TaskStatus, deps?: ReviewDependency[]): StoredTask {
  return { id: `task-${status}`, nodeId: 'frontend', instruction: ' 原始输入\n ', input: { original: true }, status, threadId: null, turnId: null, attempt: 1, result: null, error: null, createdAt, finishedAt: null, runId: 'run', terminal: null, nodeSnapshot: structuredClone(state.nodes[2]), ...(deps ? { reviewDependencies: structuredClone(deps) } : {}) };
}

test('submission preserves arbitrary JSON, text and attachment references without sharing mutable input', async () => {
  const { parseReviewSubmission } = await domain();
  for (const content of [null, false, 0, '', [' 任意\n ', { native: { type: 'userMessage' }, a: 1 }]]) {
    const input = { request_id: 'request-1', checkpoint_id: 'ui', title: ' 原始标题 ', content, attachments: [{ path: 'docs/design.png' }] };
    const parsed = parseReviewSubmission(input);
    assert.deepEqual(parsed, input); assert.notEqual(parsed.attachments, input.attachments);
  }
});
test('submission rejects malformed envelope, non-JSON bodies and ambiguous attachment sources', async () => {
  const { parseReviewSubmission } = await domain();
  const base = { request_id: 'request-1', checkpoint_id: 'ui', title: 'title', content: null };
  for (const patch of [{ request_id: '' }, { request_id: 'x'.repeat(129) }, { checkpoint_id: '../x' }, { title: ' ' }, { title: 'x'.repeat(81) }, { content: undefined }, { content: NaN }, { content: { x: undefined } }, { content: new Date() }, { attachments: null }, { attachments: [{ path: 'a', artifact_id: 'b' }] }, { attachments: [{ path: '' }] }, { extra: true }]) assert.throws(() => parseReviewSubmission({ ...base, ...patch }));
  assert.throws(() => parseReviewSubmission(null));
});
test('policy validates active node references and rejects duplicate, missing, self and cyclic dependencies', async () => {
  const { validateReviewPolicy } = await domain(), state = fixture(), input = policy(); input.revision = 0;
  assert.equal(validateReviewPolicy(input, state).revision, 1);
  const variants = [
    (p: HumanReviewPolicy) => { p.checkpoints[0].ownerNodeId = 'missing'; },
    (p: HumanReviewPolicy) => { p.checkpoints[0].requiredForNodeIds = ['missing']; },
    (p: HumanReviewPolicy) => { p.checkpoints[1].id = 'direction'; },
    (p: HumanReviewPolicy) => { p.checkpoints[1].dependsOn = ['missing']; },
    (p: HumanReviewPolicy) => { p.checkpoints[0].dependsOn = ['direction']; },
    (p: HumanReviewPolicy) => { p.checkpoints[0].dependsOn = ['ui']; },
    (p: HumanReviewPolicy) => { p.checkpoints[0].requiredForNodeIds = ['design', 'design']; },
    (p: HumanReviewPolicy) => { p.checkpoints[0].requiredForNodeIds = ['product']; },
    (p: HumanReviewPolicy) => { p.checkpoints[1].dependsOn = []; p.checkpoints[1].requiredForNodeIds = ['product']; },
  ];
  for (const mutate of variants) { const invalid = structuredClone(input); mutate(invalid); assert.throws(() => validateReviewPolicy(invalid, state)); }
  assert.deepEqual(state.reviewPolicy, { revision: 0, checkpoints: [] });
});
test('policy save checks revisions and increments only edited checkpoints', async () => {
  const { validateReviewPolicy } = await domain(), state = fixture(); state.reviewPolicy = policy();
  const input = policy(); input.checkpoints[1].name = '新界面';
  const saved = validateReviewPolicy(input, state);
  assert.equal(saved.revision, 2); assert.deepEqual(saved.checkpoints.map(p => p.revision), [1, 2]);
  assert.equal(input.revision, 1); assert.equal(input.checkpoints[1].revision, 1);
  assert.throws(() => validateReviewPolicy({ ...input, revision: 0 }, state), (e: any) => e.code === 'REVISION_CONFLICT');
  input.checkpoints[0].revision = 0;
  assert.throws(() => validateReviewPolicy(input, state), (e: any) => e.code === 'REVISION_CONFLICT');
});
for (const retained of ['approved-review', 'captured-input']) test(`removed checkpoint identity cannot be recreated with retained ${retained}`, async () => {
  const { validateReviewPolicy, reviewDependencies, reviewGate } = await domain(), state = fixture(); state.reviewPolicy = policy();
  if (retained === 'approved-review') { const item = review(); approve(item); state.humanReviews.push(item); }
  const previous = reviewDependencies(state, 'design');
  if (retained === 'captured-input') { const input = task(state, 'waiting_review', previous); input.nodeId = 'design'; state.tasks.push(input); }
  const originalReviews = structuredClone(state.humanReviews), originalTasks = structuredClone(state.tasks);
  state.reviewPolicy = validateReviewPolicy({ revision: state.reviewPolicy.revision, checkpoints: [] }, state);
  assert.equal(reviewGate(state, previous).state, 'stale');
  const replacement = { id: 'direction', name: '不同规则', ownerNodeId: 'design', requiredForNodeIds: ['frontend'], dependsOn: [], revision: 1 };
  assert.throws(() => validateReviewPolicy({ revision: state.reviewPolicy.revision, checkpoints: [replacement] }, state), (e: any) => e.code === 'REVISION_CONFLICT');
  state.reviewPolicy = validateReviewPolicy({ revision: state.reviewPolicy.revision, checkpoints: [{ ...replacement, id: 'direction-v2' }] }, state);
  assert.equal(reviewGate(state, reviewDependencies(state, 'frontend')).state, 'waiting');
  assert.equal(reviewGate(state, previous).state, 'stale');
  assert.deepEqual(state.humanReviews, originalReviews); assert.deepEqual(state.tasks, originalTasks);
});
test('receipt replay uses exact JSON equality and bundle hashes use the saved serialized bytes', async () => {
  const { findReviewReceipt, hashReviewBundle } = await domain(), state = fixture(), item = review(); state.humanReviews.push(item);
  const context = { threadId: 'other-thread', turnId: 'other-turn', callId: 'other-call' };
  assert.equal(hashReviewBundle(item.bundle), item.bundleHash);
  assert.notEqual(hashReviewBundle('{ "a":1 }'), hashReviewBundle('{"a":1}'));
  assert.deepEqual(findReviewReceipt(state, 'product', structuredClone(item.request), context), { accepted: true, review_id: 'direction-1', checkpoint_id: 'direction', version: 1, accepted_at: createdAt });
  item.status = 'superseded';
  assert.equal(findReviewReceipt(state, 'product', item.request, context)!.version, 1);
  assert.throws(() => findReviewReceipt(state, 'product', { ...item.request, content: { a: 2 } }, context), (e: any) => e.code === 'REQUEST_CONFLICT');
  assert.throws(() => findReviewReceipt(state, 'product', { ...item.request, request_id: 'new' }, item), (e: any) => e.code === 'REQUEST_CONFLICT');
  assert.equal(findReviewReceipt(state, 'design', item.request, context), null);
});
test('empty legacy policy is ready while configured zero-submission dependencies wait without granting tools', async () => {
  const { reviewDependencies, reviewGate } = await domain(), state = fixture(), tools = structuredClone(state.nodes.map(n => n.tools));
  assert.deepEqual(reviewGate(state, reviewDependencies(state, 'frontend')), { state: 'ready', checkpointIds: [] });
  state.reviewPolicy = policy();
  assert.deepEqual(reviewDependencies(state, 'frontend'), [
    { checkpointId: 'direction', checkpointRevision: 1, reviewId: null, version: null },
    { checkpointId: 'ui', checkpointRevision: 1, reviewId: null, version: null },
  ]);
  assert.equal(reviewGate(state, reviewDependencies(state, 'frontend')).state, 'waiting');
  assert.deepEqual(state.nodes.map(n => n.tools), tools); assert.equal(state.nodes[2].status, 'paused');
});
test('only approved exact current versions satisfy the gate; replacing a package never releases old input', async () => {
  const { reviewDependencies, reviewGate } = await domain(), state = fixture(); state.reviewPolicy = policy();
  const first = review(); state.humanReviews.push(first); const dependencies = reviewDependencies(state, 'design');
  assert.equal(reviewGate(state, dependencies).state, 'waiting');
  first.status = 'approved'; assert.equal(reviewGate(state, dependencies).state, 'waiting');
  approve(first); assert.equal(reviewGate(state, dependencies).state, 'ready');
  const second = review('direction', 2); first.supersededBy = second.id; first.status = 'superseded'; state.humanReviews.push(second); approve(second);
  assert.equal(reviewGate(state, dependencies).state, 'stale'); assert.equal(first.decision?.comment, ' 原始意见\n ');
  assert.equal(reviewGate(state, reviewDependencies(state, 'design')).state, 'ready');
  second.status = 'withdrawn'; assert.equal(reviewGate(state, reviewDependencies(state, 'design')).state, 'waiting');
});
test('downstream approval stays stale after an upstream version or checkpoint revision changes', async () => {
  const { reviewDependencies, reviewGate } = await domain(), state = fixture(); state.reviewPolicy = policy();
  const first = review(); approve(first); state.humanReviews.push(first);
  const ui = review('ui', 1, reviewDependencies(state, 'design')); approve(ui); state.humanReviews.push(ui);
  assert.equal(reviewGate(state, reviewDependencies(state, 'frontend')).state, 'ready');
  const next = review('direction', 2); approve(next); state.humanReviews.push(next);
  assert.equal(reviewGate(state, reviewDependencies(state, 'frontend')).state, 'stale');
  state.humanReviews.pop(); state.reviewPolicy.checkpoints[0].revision = 2;
  assert.equal(reviewGate(state, reviewDependencies(state, 'frontend')).state, 'stale');
});
test('new input after a policy revision waits for that revisions first submission while old input stays stale', async () => {
  const { reviewDependencies, reviewGate, reconcileReviewTasks } = await domain(), state = fixture(); state.reviewPolicy = policy();
  const old = review(); approve(old); state.humanReviews.push(old);
  const previous = reviewDependencies(state, 'design'); state.reviewPolicy.checkpoints[0].revision = 2;
  const current = reviewDependencies(state, 'design');
  assert.deepEqual(current, [{ checkpointId: 'direction', checkpointRevision: 2, reviewId: null, version: null }]);
  assert.equal(reviewGate(state, current).state, 'waiting'); assert.equal(reviewGate(state, previous).state, 'stale');
  const queued = task(state, 'waiting_review', current); queued.nodeId = 'design'; state.tasks.push(queued);
  const next = review('direction', 2); next.checkpointRevision = 2; approve(next); state.humanReviews.push(next);
  reconcileReviewTasks(state);
  assert.equal(queued.status, 'queued'); assert.equal(queued.reviewDependencies![0].reviewId, next.id);
  assert.equal(reviewGate(state, previous).state, 'stale');
});
test('reconciliation binds first submission and changes only never-dispatched queued/waiting tasks', async () => {
  const { reviewDependencies, reconcileReviewTasks } = await domain(), state = fixture(); state.reviewPolicy = policy();
  state.tasks = ['queued', 'waiting_review', 'waiting_source', 'paused', 'cancelled', 'running', 'needs_reconciliation', 'completed', 'failed'].map(status => task(state, status as TaskStatus, reviewDependencies(state, 'frontend')));
  const untouched = structuredClone(state.tasks.slice(2)); reconcileReviewTasks(state);
  assert.deepEqual(state.tasks.slice(0, 2).map(t => t.status), ['waiting_review', 'waiting_review']);
  const first = review(); approve(first); state.humanReviews.push(first);
  const ui = review('ui', 1, reviewDependencies(state, 'design')); approve(ui); state.humanReviews.push(ui);
  reconcileReviewTasks(state);
  assert.deepEqual(state.tasks.slice(0, 2).map(t => t.status), ['queued', 'queued']);
  assert.equal(state.tasks[0].reviewDependencies![1].reviewId, 'ui-1'); assert.deepEqual(state.tasks.slice(2), untouched);
  assert.equal(state.nodes[2].status, 'paused'); assert.equal(state.tasks[0].instruction, ' 原始输入\n ');
  state.humanReviews.push(review('ui', 2)); reconcileReviewTasks(state);
  assert.equal(state.tasks[0].status, 'waiting_review'); assert.equal(state.tasks[0].reviewDependencies![1].reviewId, 'ui-1');
});
test('reconciliation cannot rebind an old checkpoint revision or dispatch a queued task with native execution identity', async () => {
  const { reviewDependencies, reconcileReviewTasks } = await domain(), state = fixture(); state.reviewPolicy = policy();
  const pending = task(state, 'waiting_review', reviewDependencies(state, 'frontend'));
  const dispatched = task(state, 'queued'); dispatched.threadId = 'thread'; dispatched.turnId = 'turn';
  state.tasks = [pending, dispatched]; const original = structuredClone(dispatched);
  state.reviewPolicy.checkpoints[0].revision = 2;
  const first = review(); first.checkpointRevision = 2; approve(first); state.humanReviews.push(first);
  reconcileReviewTasks(state);
  assert.equal(pending.reviewDependencies![0].reviewId, null); assert.equal(pending.status, 'waiting_review'); assert.deepEqual(dispatched, original);
});
for (const schema of [1, 2, 3]) test(`schema ${schema} migrates to v4 with no policy or grants and retains original history/control`, () => {
  const root = mkdtempSync(join(projectDirectory(resolve('.'), '.runtime', 'implementation', 'human-review-20261022', 'fixtures'), 'legacy-'));
  const store = new ProjectStore(root);
  try {
    const state = fixture(); state.project.root = root; state.project.status = 'paused'; state.pauseSnapshot = ['product'];
    const item = task(state, 'paused'); item.threadId = 'original-thread'; item.turnId = 'original-turn'; state.tasks.push(item);
    state.conversation.push({ id: 'input:task-paused', seq: 1, nodeId: 'frontend', taskId: item.id, threadId: item.threadId, turnId: item.turnId, itemId: null, direction: 'input', source: { kind: 'user' }, text: ' 原文\n ', content: { opaque: [null, false] }, createdAt, status: 'paused', rawItem: undefined, nativeRole: undefined });
    const legacy: any = structuredClone(state); delete legacy.reviewPolicy; delete legacy.humanReviews;
    store.db.prepare('INSERT INTO project_state VALUES(1,?,?)').run(schema, JSON.stringify(legacy));
    const migrated = store.read()!;
    assert.deepEqual(migrated.reviewPolicy, { revision: 0, checkpoints: [] }); assert.deepEqual(migrated.humanReviews, []);
    assert.deepEqual(migrated.nodes.map(n => ({ tools: n.tools, status: n.status, threads: n.threads })), state.nodes.map(n => ({ tools: n.tools, status: n.status, threads: n.threads })));
    assert.deepEqual(migrated.tasks, state.tasks); assert.deepEqual(migrated.conversation, state.conversation); assert.deepEqual(migrated.pauseSnapshot, ['product']);
    assert.equal(store.db.prepare('SELECT schema_version FROM project_state').get()!.schema_version, 4);
  } finally { store.close(); }
});
for (const field of ['reviewPolicy', 'humanReviews']) for (const value of ['missing', 'null']) {
  for (const operation of ['read', 'save']) test(`v4 ${operation} rejects ${value} ${field} without rewriting storage`, () => {
    const root = mkdtempSync(join(projectDirectory(resolve('.'), '.runtime', 'implementation', 'human-review-20261022', 'fixtures'), 'malformed-v4-'));
    const store = new ProjectStore(root);
    try {
      const state = fixture(); state.project.root = root; state.reviewPolicy = policy(); store.save(state);
      const malformed: any = structuredClone(state);
      if (value === 'missing') delete malformed[field]; else malformed[field] = null;
      if (operation === 'read') store.db.prepare('UPDATE project_state SET body=?').run(JSON.stringify(malformed));
      const originalBody = store.db.prepare('SELECT body FROM project_state').get()!.body;
      assert.throws(() => operation === 'read' ? store.read() : store.save(malformed), /核对数据/);
      assert.equal(store.db.prepare('SELECT body FROM project_state').get()!.body, originalBody);
    } finally { store.close(); }
  });
}
for (const schema of [1, 2, 3]) test(`schema ${schema} still defaults null review fields during legacy migration`, () => {
  const root = mkdtempSync(join(projectDirectory(resolve('.'), '.runtime', 'implementation', 'human-review-20261022', 'fixtures'), 'null-legacy-'));
  const store = new ProjectStore(root);
  try {
    const legacy: any = fixture(); legacy.project.root = root; legacy.reviewPolicy = null; legacy.humanReviews = null;
    store.db.prepare('INSERT INTO project_state VALUES(1,?,?)').run(schema, JSON.stringify(legacy));
    const migrated = store.read()!;
    assert.deepEqual(migrated.reviewPolicy, { revision: 0, checkpoints: [] }); assert.deepEqual(migrated.humanReviews, []);
    assert.equal(store.db.prepare('SELECT schema_version FROM project_state').get()!.schema_version, 4);
    assert.deepEqual(store.read()!.reviewPolicy, migrated.reviewPolicy);
  } finally { store.close(); }
});
test('v4 roundtrip retains review packages, original decisions and task dependencies, rejecting future schemas', () => {
  const root = mkdtempSync(join(projectDirectory(resolve('.'), '.runtime', 'implementation', 'human-review-20261022', 'fixtures'), 'v4-'));
  const store = new ProjectStore(root);
  try {
    const state = fixture(); state.project.root = root; state.reviewPolicy = policy(); const item = review(); approve(item); state.humanReviews.push(item);
    state.tasks.push(task(state, 'waiting_review', [{ checkpointId: 'direction', checkpointRevision: 1, reviewId: item.id, version: 1 }]));
    store.save(state); const loaded = store.read()!;
    assert.equal(store.db.prepare('SELECT schema_version FROM project_state').get()!.schema_version, 4);
    assert.deepEqual(loaded.humanReviews, state.humanReviews); assert.deepEqual(loaded.reviewPolicy, state.reviewPolicy); assert.deepEqual(loaded.tasks, state.tasks);
    store.db.prepare('UPDATE project_state SET schema_version=5').run(); assert.throws(() => store.read(), /版本不受/);
  } finally { store.close(); }
});
