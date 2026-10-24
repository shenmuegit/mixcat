import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFileSync, readFileSync, unlinkSync, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { WorkflowEngine } from '../src/core/engine.js';
import { collaborationFixture } from './collaboration-fixture.js';
import { until } from './runtime-fixture.js';
import { nativeItem } from '../src/core/history.js';

async function setup(t: Parameters<typeof collaborationFixture>[0]) {
  const f = await collaborationFixture(t); const node = f.state.nodes.find(node => node.id === 'plan')!;
  await f.engine.command({ type: 'save_node', projectId: f.projectId, node: { ...node, tools: [...node.tools, 'request_review', 'get_review'] as any } });
  await f.engine.command({ type: 'save_review_policy', projectId: f.projectId, policy: { revision: 0, checkpoints: [{ id: 'direction', name: '方向', ownerNodeId: 'plan', requiredForNodeIds: ['implement'], dependsOn: [], revision: 1 }] } });
  const task = await f.active('plan');
  const submit = (id = 'r1', attachments: any[] = []) => f.invoke('plan', 'request_review', { request_id: id, checkpoint_id: 'direction', title: '方向', content: { body: id }, attachments }, id);
  const decide = (review = f.state.humanReviews[0], comment = '  原始意见\n', decision: 'approved' | 'changes_requested' = 'approved') => ({ type: 'decide_review' as const, projectId: f.projectId, reviewId: review.id, version: review.version, bundleHash: review.bundleHash, decision, comment });
  return { ...f, task, submit, decide };
}

test('trusted decision is atomic, preserves raw comment, queues exactly one original-thread continuation and survives restart', async t => {
  const f = await setup(t); const receipt = await f.submit(); const replay = await f.submit(); assert.equal(receipt.review_id, replay.review_id);
  await f.engine.command({ type: 'pause_node', projectId: f.projectId, nodeId: 'plan' });
  f.finish(f.task, 'interrupted'); await until(() => f.state.nodes.find(node => node.id === 'plan')!.status === 'paused');
  const command = f.decide(); await f.engine.command(command, 'decision-1'); await f.engine.command(command, 'decision-1'); await f.engine.command(command, 'same-content');
  const review = f.state.humanReviews[0], continuation = f.state.tasks.find(task => task.id === review.decision?.continuationTaskId)!;
  assert.equal(review.status, 'approved'); assert.equal(review.decision?.comment, command.comment);
  assert.equal(f.state.tasks.filter(task => task.id === review.decision?.continuationTaskId).length, 1);
  assert.equal(continuation.nodeId, 'plan'); assert.ok(continuation.nativeInput); assert.equal(continuation.threadId, f.task.threadId); assert.equal(f.state.nodes.find(node => node.id === 'plan')!.status, 'paused');
  const entry = f.state.conversation.find(entry => entry.taskId === continuation.id && entry.direction === 'input')!;
  assert.equal((entry.content as any).comment, command.comment); assert.equal(entry.source?.kind, 'system'); assert.match(entry.text, /系统.*1/);
  nativeItem(f.state, 'plan', continuation.threadId!, 'new-turn', { id: 'native-user', type: 'userMessage', content: [{ type: 'text', text: 'native envelope' }] }, continuation, true, new Date().toISOString());
  assert.equal((entry.content as any).comment, command.comment);
  await assert.rejects(f.engine.command({ ...command, comment: 'other' }, 'decision-1'), /冲突|编号/);
  await f.engine.close();
  let connected = 0; const restored = new WorkflowEngine({ workbenchRoot: f.root, executable: 'fixture', nativeFactory() { connected++; throw new Error('must remain offline'); } });
  t.after(() => restored.close()); await restored.init(); await restored.command(command, 'decision-1');
  const saved = (await restored.command({ type: 'snapshot', projectId: f.projectId })).snapshot.selected!;
  assert.equal(saved.humanReviews![0].decision!.continuationTaskId, continuation.id); assert.equal(saved.tasks.filter(task => task.id === continuation.id).length, 1); assert.equal(connected, 0);
});

test('decision rejects missing action id, blank change request, old versions/hashes and superseded package', async t => {
  const f = await setup(t); await f.submit(); const first = f.decide();
  await assert.rejects(f.engine.command(first), /编号/);
  await assert.rejects(f.engine.command(f.decide(undefined, ' \n', 'changes_requested'), 'blank'), /意见/);
  await assert.rejects(f.engine.command({ ...first, version: 99 }, 'old-version'), /版本|变化/);
  await assert.rejects(f.engine.command({ ...first, bundleHash: 'wrong' }, 'old-hash'), /版本|变化/);
  await f.submit('r2'); await assert.rejects(f.engine.command(first, 'old'), /版本|变化/);
  assert.equal(f.state.humanReviews[0].supersededBy, f.state.humanReviews[1].id); assert.equal(f.state.humanReviews[0].decision, null);
});

test('selected source and fixed snapshot changes reject approval; unrelated files do not invalidate', async t => {
  const f = await setup(t); writeFileSync(join(f.root, 'design.md'), 'original'); await f.submit('r1', [{ path: 'design.md' }]);
  writeFileSync(join(f.root, 'unrelated.md'), 'ok'); writeFileSync(join(f.root, 'design.md'), 'modified');
  await assert.rejects(f.engine.command(f.decide(), 'source'), /变化|摘要/); assert.equal(f.state.humanReviews[0].status, 'pending');
  writeFileSync(join(f.root, 'design.md'), 'original'); const snapshot = f.state.humanReviews[0].attachments[0]; writeFileSync(join(f.root, snapshot.relativePath), 'modified');
  await assert.rejects(f.engine.command(f.decide(), 'snapshot'), /变化|摘要/);
  writeFileSync(join(f.root, snapshot.relativePath), 'original'); await f.engine.command(f.decide(), 'ok'); assert.equal(f.state.humanReviews[0].status, 'approved');
});

for (const kind of ['text', 'binary', 'missing', 'unreadable', 'snapshot'] as const) test(`changed material diagnostics identify saved/current evidence and block decisions: ${kind}`, async t => {
  const f = await setup(t), name = kind === 'binary' ? 'screen.png' : 'design.md';
  const original = kind === 'binary' ? Buffer.from([0, 1, 2]) : Buffer.from('same line\nold <script>text</script>\n');
  writeFileSync(join(f.root, 'unchanged.md'), 'other selected material');
  writeFileSync(join(f.root, name), original); await f.submit('r1', [{ path: 'unchanged.md' }, { path: name }]);
  const review = f.state.humanReviews[0], snapshot = review.attachments[1], before = structuredClone(review);
  const taskCount = f.state.tasks.length, changed = kind === 'binary' ? Buffer.from([0, 3, 4, 5]) : Buffer.from('same line\nnew <script>text</script>\n');
  if (kind === 'missing') unlinkSync(join(f.root, name));
  else if (kind === 'unreadable') { const originalRead = fs.readFile; t.mock.method(fs, 'readFile', async (...args: Parameters<typeof originalRead>) => { if (String(args[0]) === join(f.root, name)) throw Object.assign(new Error('fixture denied'), { code: 'EACCES' }); return (originalRead as any)(...args); }); }
  else writeFileSync(join(f.root, kind === 'snapshot' ? snapshot.relativePath : name), changed);
  await assert.rejects(f.engine.command(f.decide(), `bad-${kind}`), error => {
    const message = String(error);
    for (const value of ['本事项', review.id, 'direction', '版本 1', kind === 'snapshot' ? snapshot.relativePath : name, snapshot.sha256, String(snapshot.size), '当前']) assert(message.includes(value), value + ': ' + message);
    if (kind === 'missing') assert.match(message, /缺失/);
    else if (kind === 'unreadable') assert.match(message, /不可读.*EACCES/s);
    else {
      assert(message.includes(createHash('sha256').update(changed).digest('hex')));
      if (kind === 'text') { assert.match(message, /-.*old <script>text<\/script>/); assert.match(message, /\+.*new <script>text<\/script>/); }
      if (kind === 'binary') assert.match(message, /二进制.*无法.*文本/s);
      if (kind === 'snapshot') { assert(message.includes(snapshot.artifact_id)); assert.match(message, /无法.*文本|原始字节/s); }
    }
    return true;
  });
  assert.equal(f.state.tasks.length, taskCount); assert.deepEqual(f.state.humanReviews[0], before); assert.equal(review.decision, null);
  if (kind !== 'snapshot') assert.deepEqual(readFileSync(join(f.root, snapshot.relativePath)), original);
});

test('text difference diagnostics bound large files and long changed lines', async t => {
  const f = await setup(t), name = 'large.md';
  writeFileSync(join(f.root, name), 'old '.repeat(20000)); await f.submit('large', [{ path: name }]);
  writeFileSync(join(f.root, name), 'new '.repeat(20000));
  await assert.rejects(f.engine.command(f.decide(), 'large-error'), error => { assert.match(String(error), /64 KiB/); assert(String(error).length < 2000); return true; });
  writeFileSync(join(f.root, name), 'old '.repeat(1000)); await f.submit('long-line', [{ path: name }]);
  writeFileSync(join(f.root, name), 'new '.repeat(1000));
  await assert.rejects(f.engine.command(f.decide(f.state.humanReviews[1]), 'long-line-error'), error => { assert.match(String(error), /- old/); assert.match(String(error), /\+ new/); assert(String(error).length < 2000); return true; });
  assert(f.state.humanReviews.every(review => review.decision === null));
});

test('SQLite rejection publishes no decision/continuation/history; withdrawn review does not approve; only waiting_review can cancel', async t => {
  const f = await setup(t); await f.submit(); const before = { tasks: f.state.tasks.length, entries: f.state.conversation.length }, restore = f.rejectSave();
  await assert.rejects(f.engine.command(f.decide(), 'db'), /SQLite/); restore();
  assert.equal(f.state.humanReviews[0].decision, null); assert.equal(f.state.tasks.length, before.tasks); assert.equal(f.state.conversation.length, before.entries);
  const review = f.state.humanReviews[0]; await f.engine.command({ type: 'withdraw_review', projectId: f.projectId, reviewId: review.id, version: review.version, bundleHash: review.bundleHash });
  assert.equal(f.state.humanReviews[0].status, 'withdrawn'); assert.equal(f.state.humanReviews[0].decision, null);
  await assert.rejects(f.engine.command(f.decide(), 'withdrawn'), /版本|状态|变化/);
  await assert.rejects(f.engine.command({ type: 'cancel_review_task', projectId: f.projectId, taskId: f.task.id }), /等待|核对/);
  const waiting = structuredClone(f.task); waiting.id = 'waiting'; waiting.status = 'waiting_review'; waiting.turnId = null; f.state.tasks.push(waiting);
  await f.engine.command({ type: 'cancel_review_task', projectId: f.projectId, taskId: waiting.id }); assert.equal(waiting.status, 'cancelled');
});

test('active policy and pending review prevent deleting their owner', async t => {
  const f = await setup(t); await f.submit(); f.finish(f.task); await new Promise(resolve => setTimeout(resolve, 20));
  await assert.rejects(f.engine.command({ type: 'delete_node', projectId: f.projectId, nodeId: 'plan' }), /核对|责任/);
  await assert.rejects(f.engine.command({ type: 'delete_node', projectId: f.projectId, nodeId: 'implement' }), /核对|责任/);
  await f.engine.command({ type: 'save_review_policy', projectId: f.projectId, policy: { revision: f.state.reviewPolicy.revision, checkpoints: [] } });
  await assert.rejects(f.engine.command({ type: 'delete_node', projectId: f.projectId, nodeId: 'plan' }), /核对|责任/);
  const review = f.state.humanReviews[0];
  await f.engine.command({ type: 'withdraw_review', projectId: f.projectId, reviewId: review.id, version: review.version, bundleHash: review.bundleHash });
  await f.engine.command({ type: 'delete_node', projectId: f.projectId, nodeId: 'plan' }); assert.equal(f.state.nodes.some(node => node.id === 'plan'), false);
});

test('upstream replacement or selected upstream material changes reject a downstream decision', async t => {
  const f = await setup(t); writeFileSync(join(f.root, 'direction.md'), 'direction'); await f.submit('r1', [{ path: 'direction.md' }]); await f.engine.command(f.decide(), 'direction-approved');
  const owner = f.state.nodes.find(node => node.id === 'review')!;
  await f.engine.command({ type: 'save_node', projectId: f.projectId, node: { ...owner, tools: [...owner.tools, 'request_review'] as any } });
  await f.engine.command({ type: 'save_review_policy', projectId: f.projectId, policy: { revision: f.state.reviewPolicy.revision, checkpoints: [...f.state.reviewPolicy.checkpoints, { id: 'ui', name: 'UI', ownerNodeId: 'review', requiredForNodeIds: [], dependsOn: ['direction'], revision: 1 }] } });
  await f.active('review'); await f.invoke('review', 'request_review', { request_id: 'ui-1', checkpoint_id: 'ui', title: 'UI', content: ['screen'] }, 'ui');
  const downstream = f.state.humanReviews.find(review => review.checkpointId === 'ui')!, command = f.decide(downstream);
  writeFileSync(join(f.root, 'direction.md'), 'changed'); await assert.rejects(f.engine.command(command, 'bad-upstream-file'), error => {
    const text = String(error); for (const value of ['上游事项', f.state.humanReviews[0].id, 'direction.md', '版本 1', f.state.humanReviews[0].sourceFiles[0].sha256, '- direction', '+ changed']) assert(text.includes(value), text);
    return true;
  });
  writeFileSync(join(f.root, 'direction.md'), 'direction'); await f.submit('r2');
  await assert.rejects(f.engine.command(command, 'bad-upstream-version'), /上游|变化/); assert.equal(f.state.humanReviews.find(review => review.id === downstream.id)!.decision, null);
});

test('first submission binds existing null captures; approval releases only eligible tasks and concurrent decisions notify once', async t => {
  const f = await setup(t), waiting = structuredClone(f.task);
  waiting.id = 'waiting'; waiting.nodeId = 'implement'; waiting.status = 'waiting_review'; waiting.threadId = null; waiting.turnId = null;
  waiting.reviewDependencies = [{ checkpointId: 'direction', checkpointRevision: 1, reviewId: null, version: null }];
  f.state.tasks.push(waiting);
  const cancelled = structuredClone(waiting); cancelled.id = 'cancelled'; cancelled.status = 'cancelled'; f.state.tasks.push(cancelled);
  await f.submit(); assert.equal(waiting.reviewDependencies![0].reviewId, f.state.humanReviews[0].id);
  // Pause the target while testing the atomic saved decision/queue transition.
  await f.engine.command({ type: 'pause_node', projectId: f.projectId, nodeId: 'implement' });
  const command = f.decide(); await Promise.all([f.engine.command(command, 'concurrent'), f.engine.command(command, 'concurrent')]);
  assert.equal(waiting.status, 'queued'); assert.equal(cancelled.status, 'cancelled');
  const review = f.state.humanReviews[0]; assert.equal(f.state.tasks.filter(task => task.id === review.decision?.continuationTaskId).length, 1);
  assert.equal(f.state.conversation.filter(entry => entry.controlActionId === 'concurrent').length, 1);
});

test('a first offline decision persists without runtime/account connection or replaying uncertain source work', async t => {
  const f = await setup(t); await f.submit(); const command = f.decide(); await f.engine.close();
  let connections = 0;
  const offline = new WorkflowEngine({ workbenchRoot: f.root, executable: 'fixture', nativeFactory() { connections++; throw new Error('unexpected native connection'); } });
  t.after(() => offline.close()); await offline.init(); await offline.command(command, 'offline-first');
  const snapshot = (await offline.command({ type: 'snapshot', projectId: f.projectId })).snapshot.selected!;
  assert.equal(connections, 0); assert.equal(snapshot.humanReviews![0].status, 'approved');
  assert.equal(snapshot.tasks.find(task => task.id === f.task.id)!.status, 'needs_reconciliation');
  assert.equal(snapshot.tasks.find(task => task.id === snapshot.humanReviews![0].decision!.continuationTaskId)!.status, 'queued');
  assert.equal(snapshot.nodes.find(node => node.id === 'plan')!.status, 'blocked');
});

test('a change request retains exact feedback and fixed material in the original conversation without approving waiting work', async t => {
  const f = await setup(t); writeFileSync(join(f.root, 'screen.png'), Buffer.from([1, 2, 3])); await f.submit('r1', [{ path: 'screen.png' }]);
  const comment = '  请修改\n布局  '; await f.engine.command(f.decide(undefined, comment, 'changes_requested'), 'feedback');
  const review = f.state.humanReviews[0], task = f.state.tasks.find(task => task.id === review.decision!.continuationTaskId)!;
  assert.equal(review.status, 'changes_requested'); assert.equal(review.decision!.comment, comment); assert.equal(task.threadId, review.threadId);
  assert.ok(task.nativeInput!.some(item => item.type === 'localImage')); assert.match(String(task.nativeInput![0].text), /请修改\n布局/);
  assert.equal(f.state.conversation.find(entry => entry.taskId === task.id && entry.direction === 'input')!.source!.kind, 'system');
});

test('three owner-gated levels reject changed ancestral source or snapshot without deciding, notifying or releasing work', async t => {
  for (const material of ['source', 'snapshot'] as const) await t.test(material, async t => {
    const f = await setup(t);
    for (const id of ['implement', 'review']) {
      const node = f.state.nodes.find(node => node.id === id)!;
      await f.engine.command({ type: 'save_node', projectId: f.projectId, node: { ...node, tools: [...node.tools, 'request_review'] } });
    }
    const node = f.state.nodes.find(node => node.id === 'implement')!;
    await f.engine.command({ type: 'save_node', projectId: f.projectId, node: { ...node, id: 'final', name: '最终执行', revision: 0 } });
    await f.engine.command({ type: 'save_review_policy', projectId: f.projectId, policy: { revision: f.state.reviewPolicy.revision, checkpoints: [
      ...f.state.reviewPolicy.checkpoints,
      { id: 'B', name: 'B', ownerNodeId: 'implement', requiredForNodeIds: ['review'], dependsOn: [], revision: 1 },
      { id: 'C', name: 'C', ownerNodeId: 'review', requiredForNodeIds: ['final'], dependsOn: [], revision: 1 },
    ] } });
    const sourcePath = join(f.root, 'direction.md'); writeFileSync(sourcePath, 'original'); await f.submit('A', [{ path: 'direction.md' }]);
    await f.engine.command(f.decide(), 'approve-A');
    await f.active('implement'); await f.invoke('implement', 'request_review', { request_id: 'B', checkpoint_id: 'B', title: 'B', content: 'B' }, 'B');
    const b = f.state.humanReviews.find(review => review.checkpointId === 'B')!; await f.engine.command(f.decide(b), 'approve-B');
    await f.active('review'); await f.invoke('review', 'request_review', { request_id: 'C', checkpoint_id: 'C', title: 'C', content: 'C' }, 'C');
    const a = f.state.humanReviews.find(review => review.checkpointId === 'direction')!, c = f.state.humanReviews.find(review => review.checkpointId === 'C')!;
    assert.deepEqual(b.upstreamDependencies.map(dependency => dependency.reviewId), [a.id]);
    assert.deepEqual(c.upstreamDependencies.map(dependency => dependency.reviewId), [b.id]);
    assert.ok(f.state.reviewPolicy.checkpoints.every(point => point.dependsOn.length === 0));
    const waiting = structuredClone(f.task); waiting.id = 'waiting-C'; waiting.nodeId = 'final'; waiting.nodeSnapshot = f.state.nodes.find(node => node.id === 'final')!;
    waiting.status = 'waiting_review'; waiting.threadId = null; waiting.turnId = null;
    waiting.reviewDependencies = [{ checkpointId: c.checkpointId, checkpointRevision: c.checkpointRevision, reviewId: c.id, version: c.version }]; f.state.tasks.push(waiting); f.store.save(f.state);
    await f.engine.command({ type: 'pause_node', projectId: f.projectId, nodeId: 'final' });
    const before = f.store.read()!, path = material === 'source' ? sourcePath : join(f.root, a.attachments[0].relativePath);
    writeFileSync(path, 'changed!');
    await assert.rejects(f.engine.command(f.decide(c), `reject-${material}`), /变化|摘要/);
    const rejected = f.store.read()!;
    assert.equal(rejected.humanReviews.find(review => review.id === c.id)!.decision, null);
    assert.equal(rejected.humanReviews.find(review => review.id === c.id)!.status, 'pending');
    assert.deepEqual(rejected.tasks, before.tasks); assert.deepEqual(rejected.conversation, before.conversation); assert.deepEqual(rejected.activities, before.activities);
    assert.equal(waiting.status, 'waiting_review');
    writeFileSync(path, 'original'); await f.engine.command(f.decide(c), `approve-${material}`);
    const accepted = f.store.read()!, saved = accepted.humanReviews.find(review => review.id === c.id)!;
    assert.equal(saved.status, 'approved'); assert.equal(accepted.tasks.filter(task => task.id === saved.decision!.continuationTaskId).length, 1);
    assert.equal(accepted.tasks.find(task => task.id === waiting.id)!.status, 'queued');
    writeFileSync(path, 'changed!');
    await f.invoke('review', 'request_review', { request_id: 'C-next', checkpoint_id: 'C', title: 'C-next', content: 'C-next' }, 'C-next');
    const pending = f.state.humanReviews.find(review => review.requestId === 'C-next')!;
    assert.equal(pending.status, 'pending'); assert.equal(pending.decision, null); assert.deepEqual(pending.upstreamDependencies, c.upstreamDependencies);
  });
});
