import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkflowEngine } from '../src/core/engine.js';
import type { HumanReviewView, MessageReceipt } from '../src/shared/types.js';
import { collaborationFixture } from './collaboration-fixture.js';
import { until } from './runtime-fixture.js';
import { accountFixture } from './account-fixture.js';
import { legacyWebReviewPolicy } from './human-review-fixture.js';

test('legacy Web gates compose HTTP submissions, trusted fixture decisions, controls, original Threads and durable restart', async t => {
  const f = await collaborationFixture(t, 'web-product');
  await f.engine.command({ type: 'save_review_policy', projectId: f.projectId, policy: legacyWebReviewPolicy() });
  assert.deepEqual(f.state.reviewPolicy.checkpoints.map(point => point.id), ['product-direction', 'ui-ue']);
  const task = (id: string) => f.state.tasks.find(task => task.id === id)!;
  const send = (from: string, to: string, id: string) => f.invoke(from, 'send_message', { request_id: id, to_node_id: to, content: { raw: `  ${id}\n`, values: [false, null, 0, ''] }, reason: id }, id) as Promise<MessageReceipt>;
  const running = async (id: string) => { await until(() => task(id).status === 'running' && !!task(id).turnId); return task(id); };
  const decide = (review: HumanReviewView, decision: 'approved' | 'changes_requested', actionId: string, comment = '') => f.engine.command({ type: 'decide_review', projectId: f.projectId, reviewId: review.id, version: review.version, bundleHash: review.bundleHash, decision, comment }, actionId);
  const submit = (node: string, checkpoint: string, id: string, path: string) => f.invoke(node, 'request_review', { request_id: id, checkpoint_id: checkpoint, title: id, content: { scope: 'one message and exact response', raw: '  preserved\n' }, attachments: [{ path }] }, id);

  const product = await f.active('product');
  const requirements = await f.active('requirements'), tester = await f.active('test');
  for (const nodeId of ['design', 'design-test', 'architect', 'backend', 'frontend']) await f.send(nodeId);
  const unsubmitted = f.state.tasks.filter(task => ['design', 'design-test', 'architect', 'backend', 'frontend'].includes(task.nodeId));
  assert(unsubmitted.every(task => task.status === 'waiting_review' && task.turnId === null));
  assert(unsubmitted.every(task => task.reviewDependencies?.[0].reviewId === null));
  assert.equal(requirements.status, 'running'); assert.equal(tester.status, 'running');
  assert.equal(f.state.edges.some(edge => edge.sourceNodeId === 'product' && edge.targetNodeId === 'backend'), false);
  const noEdge = await send('product', 'backend', 'no-edge-before-direction');
  assert.equal(task(noEdge.target_task_id).status, 'waiting_review');

  writeFileSync(join(f.root, 'direction.md'), '# Direction v1\nExact response');
  await submit('product', 'product-direction', 'direction-v1', 'direction.md');
  const first = f.state.humanReviews[0], fixed = first.attachments[0];
  assert.equal(task(noEdge.target_task_id).reviewDependencies?.[0].reviewId, first.id);
  f.finish(product); await until(() => product.status === 'completed');
  const originalComment = '  CONTROLLED FIXTURE: clarify empty response\nretain spaces  ';
  await decide(first, 'changes_requested', 'fixture-direction-changes', originalComment);
  const correction = await running(f.state.humanReviews[0].decision!.continuationTaskId!);
  assert.equal(correction.threadId, product.threadId);
  assert.equal(f.state.humanReviews[0].decision!.commandId, 'fixture-direction-changes');
  assert.equal(f.state.humanReviews[0].decision!.comment, originalComment);
  assert.equal(task(noEdge.target_task_id).status, 'waiting_review');
  writeFileSync(join(f.root, 'direction.md'), '# Direction v2\nExact response; empty response is empty');
  assert.equal(readFileSync(join(f.root, fixed.relativePath), 'utf8'), '# Direction v1\nExact response');
  await submit('product', 'product-direction', 'direction-v2', 'direction.md');
  const direction = f.state.humanReviews[1];
  assert.equal(direction.version, 2); assert.equal(f.state.humanReviews[0].supersededBy, direction.id);
  assert.equal(f.state.humanReviews[0].decision!.comment, originalComment);
  for (const stale of [...unsubmitted, task(noEdge.target_task_id)]) {
    await f.engine.command({ type: 'cancel_review_task', projectId: f.projectId, taskId: stale.id });
    assert.equal(stale.status, 'cancelled');
  }
  const designMessage = await send('requirements', 'design', 'design-v2');
  const backendMessage = await send('test', 'backend', 'backend-v2');
  await f.engine.command({ type: 'pause_node', projectId: f.projectId, nodeId: 'design' });
  await decide(direction, 'approved', 'fixture-direction-approved', 'CONTROLLED FIXTURE approval');
  assert.equal(task(backendMessage.target_task_id).status, 'waiting_review', 'backend must also wait for UI/UE approval');
  assert.equal(task(designMessage.target_task_id).status, 'queued');
  assert.equal(f.state.nodes.find(node => node.id === 'design')!.status, 'paused');
  assert.equal(task(designMessage.target_task_id).turnId, null);
  await f.engine.command({ type: 'resume_node', projectId: f.projectId, nodeId: 'design' });
  const design = await running(designMessage.target_task_id);
  await f.invoke('product', 'handoff', { to_node_id: 'backend', task: 'legacy after direction', reason: 'source must finish', result: { raw: true } }, 'legacy-after-direction');
  const legacy = f.state.tasks.at(-1)!;
  assert.equal(legacy.status, 'waiting_source');
  f.finish(correction); await until(() => correction.status === 'completed');
  assert.equal(legacy.status, 'waiting_review');

  writeFileSync(join(f.root, 'ui.md'), '# UI v1\nInput, submit, loading, response and error');
  await submit('design', 'ui-ue', 'ui-v1', 'ui.md');
  const ui = f.state.humanReviews[2];
  const frontendMessage = await send('requirements', 'frontend', 'frontend-v2');
  assert.equal(task(frontendMessage.target_task_id).status, 'waiting_review');
  assert.deepEqual(task(frontendMessage.target_task_id).reviewDependencies?.map(dependency => dependency.reviewId), [direction.id, ui.id]);
  f.finish(design); await until(() => design.status === 'completed');
  await decide(ui, 'approved', 'fixture-ui-approved');
  const frontend = await running(frontendMessage.target_task_id), designNotice = await running(f.state.humanReviews[2].decision!.continuationTaskId!);
  const backend = await running(backendMessage.target_task_id);
  f.finish(backend); await running(legacy.id); assert.equal(legacy.threadId, backend.threadId);
  assert.equal(designNotice.threadId, design.threadId);
  assert.equal(f.state.humanReviews[2].decision!.commandId, 'fixture-ui-approved');
  const noticeInput = f.state.conversation.find(entry => entry.taskId === designNotice.id && entry.direction === 'input')!;
  assert.equal((noticeInput.content as any).reviewId, ui.id);

  await submit('design', 'ui-ue', 'ui-v2', 'ui.md');
  const replacement = f.state.humanReviews[3];
  assert.equal(frontend.status, 'running', 'a replacement cannot pretend an already started native action was undone');
  assert.equal(frontend.reviewDependencies?.[1].reviewId, ui.id);
  const stopMessage = await send('requirements', 'frontend', 'stop-before-ui-v2');
  assert.equal(task(stopMessage.target_task_id).status, 'waiting_review');
  await f.engine.command({ type: 'stop', projectId: f.projectId });
  for (const active of f.state.tasks.filter(task => task.turnId && ['running', 'paused'].includes(task.status))) f.finish(active, 'interrupted');
  await decide(replacement, 'approved', 'fixture-ui-after-stop');
  assert.equal(task(stopMessage.target_task_id).status, 'cancelled');
  assert.equal(task(stopMessage.target_task_id).turnId, null);
  assert(unsubmitted.every(task => task.status === 'cancelled'));
  assert.equal(f.state.humanReviews[0].decision!.comment, originalComment);
  const before = (await f.engine.command({ type: 'snapshot', projectId: f.projectId })).snapshot.selected!;
  await f.engine.close();
  let nativeCalls = 0;
  const restoredEngine = new WorkflowEngine({ workbenchRoot: f.root, executable: 'unused', nativeFactory() { nativeCalls++; throw Error('restart must not dispatch controlled stopped work'); } });
  t.after(() => restoredEngine.close()); await restoredEngine.init();
  const restored = (await restoredEngine.command({ type: 'snapshot', projectId: f.projectId })).snapshot.selected!;
  assert.equal(restored.humanReviews![0].bundleHash, before.humanReviews![0].bundleHash);
  assert.equal(restored.humanReviews![0].decision?.continuationTaskId, before.humanReviews![0].decision?.continuationTaskId);
  assert.equal(restored.nodes.find(node => node.id === 'design')?.threadId, before.nodes.find(node => node.id === 'design')?.threadId);
  assert.deepEqual(restored.humanReviews!.map(review => review.decision), before.humanReviews!.map(review => review.decision));
  assert.equal(restored.tasks.find(task => task.id === stopMessage.target_task_id)!.status, 'cancelled');
  assert.equal(nativeCalls, 0);
  assert.equal(readFileSync(join(f.root, fixed.relativePath), 'utf8'), '# Direction v1\nExact response');
});

for (const authenticated of [true, false]) test(`review decision after restart ${authenticated ? 'lazily starts work with restored account' : 'persists offline without connecting'}`, async t => {
  const f = await collaborationFixture(t, 'web-product');
  await f.engine.command({ type: 'save_review_policy', projectId: f.projectId, policy: legacyWebReviewPolicy() });
  const product = await f.active('product');
  for (const nodeId of ['design', 'backend', 'frontend']) await f.send(nodeId);
  await f.invoke('product', 'request_review', { request_id: 'direction-restart', checkpoint_id: 'product-direction', title: 'Controlled restart direction', content: { fixture: true } }, 'direction-restart');
  f.finish(product); await until(() => product.status === 'completed');
  const review = f.state.humanReviews[0], initialConnections = f.clients.length;
  const nativeFactory = (f.engine as any).options.nativeFactory;
  await f.engine.close();
  const restored = new WorkflowEngine({ workbenchRoot: f.root, executable: 'fixture', accountFactory: accountFixture().factory, nativeFactory });
  t.after(() => restored.close()); await restored.init();
  if (authenticated) await restored.restoreAccount();
  const snapshot = () => restored.command({ type: 'snapshot', projectId: f.projectId }).then(reply => reply.snapshot);
  const before = await snapshot();
  assert.equal(before.account!.authenticated, authenticated);
  assert.equal(before.runtime, null);
  assert.equal(f.clients.length, initialConnections, 'restoring account with only gated input must not create a project runtime');
  assert(before.selected!.tasks.filter(task => task.nodeId !== 'product').every(task => task.status === 'waiting_review' && task.turnId === null));
  const command = { type: 'decide_review' as const, projectId: f.projectId, reviewId: review.id, version: review.version, bundleHash: review.bundleHash, decision: 'approved' as const, comment: 'CONTROLLED FIXTURE restart decision' };
  await restored.command(command, 'fixture-restart-approval');
  await restored.command(command, 'fixture-restart-approval');
  const state = (restored as any).states.get(f.projectId) as typeof f.state;
  const decision = state.humanReviews[0].decision!;
  assert.equal(decision.commandId, 'fixture-restart-approval');
  assert.equal(state.tasks.filter(task => task.id === decision.continuationTaskId).length, 1);
  const notice = state.tasks.find(task => task.id === decision.continuationTaskId)!;
  assert.equal(notice.threadId, product.threadId);
  const eligible = state.tasks.filter(task => task.nodeId === 'design' || task.id === notice.id);
  assert.equal(eligible.length, 2);
  if (authenticated) {
    await until(() => eligible.every(task => task.status === 'running' && !!task.turnId));
    assert.equal(f.clients.length, initialConnections + 1);
    assert.equal(f.clients.at(-1)!.calls.filter(call => call.method === 'turn/start').length, 2);
  } else {
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(f.clients.length, initialConnections);
    assert(eligible.every(task => task.status === 'queued' && task.turnId === null));
  }
  for (const nodeId of ['frontend', 'backend']) {
    assert.equal(state.tasks.find(task => task.nodeId === nodeId)!.status, 'waiting_review');
    assert.equal(state.tasks.find(task => task.nodeId === nodeId)!.turnId, null);
  }
});
