import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFileSync, readFileSync, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { collaborationFixture } from './collaboration-fixture.js';
import { deferred } from './runtime-fixture.js';
import { reviewFixture } from './human-review-fixture.js';
import { reviewGate } from '../src/core/reviews.js';

async function setup(t: Parameters<typeof collaborationFixture>[0]) {
  const f = await collaborationFixture(t);
  const node = f.state.nodes.find(node => node.id === 'plan')!;
  await f.engine.command({ type: 'save_node', projectId: f.projectId, node: { ...node, tools: [...node.tools, 'request_review', 'get_review'] as any } });
  await f.engine.command({ type: 'save_review_policy', projectId: f.projectId, policy: { revision: 0, checkpoints: [{ id: 'direction', name: '方向', ownerNodeId: 'plan', requiredForNodeIds: ['implement'], dependsOn: [], revision: 1 }] } });
  return f;
}
const submission = { request_id: 'review-1', checkpoint_id: 'direction', title: '方向核对', content: { any: ['自由', 3, null] } };

for (const stage of ['before', 'prepare', 'validate', 'current'] as const) test(`review submission preserves running source ancestry: ${stage}`, async t => {
  const f = await reviewFixture(t);
  await f.engine.command({ type: 'save_review_policy', projectId: f.projectId, policy: { revision: 0, checkpoints: [
    { id: 'direction', name: '方向', ownerNodeId: 'plan', requiredForNodeIds: ['implement'], dependsOn: [], revision: 1 },
    { id: 'ui', name: 'UI', ownerNodeId: 'implement', requiredForNodeIds: ['review'], dependsOn: ['direction'], revision: 1 },
  ] } });
  await f.active('plan'); await f.submit(); await f.approve();
  const source = await f.active('implement'), captures = structuredClone(source.reviewDependencies);
  await f.send('review'); const downstream = f.state.tasks.find(task => task.nodeId === 'review')!;
  writeFileSync(join(f.root, 'ui.md'), 'old direction work');
  const args = { request_id: 'ui-1', checkpoint_id: 'ui', title: 'UI', content: 'old direction work', attachments: [{ path: 'ui.md' }] };
  const replace = async () => { await f.submit('r2'); await f.approve(f.state.humanReviews.findIndex(review => review.requestId === 'r2')); };
  if (stage === 'before') await replace();
  const entered = deferred(), release = deferred(), original = fs.readFile; let reads = 0;
  t.mock.method(fs, 'readFile', async (...args: Parameters<typeof original>) => {
    const bytes = await (original as any)(...args);
    if (String(args[0]) === join(f.root, 'ui.md') && ++reads === (stage === 'prepare' ? 1 : stage === 'validate' ? 2 : -1)) { entered.resolve(); await release.promise; }
    return bytes;
  });
  const pending = f.raw('implement', 'request_review', args, 'ui-submit');
  if (stage === 'prepare' || stage === 'validate') { await entered.promise; try { await replace(); } finally { release.resolve(); } }
  const response = await pending;
  assert.deepEqual(source.reviewDependencies, captures); assert.equal(source.status, 'running');
  if (stage === 'current') {
    assert.equal(response.result.isError, undefined);
    const ui = f.state.humanReviews.find(review => review.checkpointId === 'ui')!;
    assert.deepEqual(ui.upstreamDependencies, captures);
    await replace();
    const replay = await f.invoke('implement', 'request_review', args, 'ui-replay');
    assert.equal(replay.review_id, ui.id); assert.deepEqual(ui.upstreamDependencies, captures);
    await assert.rejects(f.approve(f.state.humanReviews.findIndex(review => review.id === ui.id)), /上游|变化/);
  } else {
    assert.equal(response.result.structuredContent.error?.code, 'REVISION_CONFLICT');
    assert.equal(f.state.humanReviews.some(review => review.checkpointId === 'ui'), false);
  }
  assert.equal(reviewGate(f.state, captures!).state, 'stale');
  assert.equal(downstream.status, 'waiting_review'); assert.equal(downstream.turnId, null);
});

test('HTTP accepts a fixed JSON/image/document bundle immediately and durably replays one receipt', async t => {
  const f = await setup(t); await f.active('plan');
  const identity = f.engine.nodeIdentity(f.projectId, 'plan');
  const listing = await fetch((f.engine as any).gateway.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${identity.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 'list', method: 'tools/list', params: {} }) });
  assert.deepEqual((await listing.json() as any).result.tools.map((tool: any) => tool.name).sort(), identity.tools.filter(tool => tool !== 'handoff' && tool !== 'send_message').sort());
  writeFileSync(join(f.root, 'screen.png'), Buffer.from([1, 2, 3])); writeFileSync(join(f.root, 'spec.md'), '# 方向');
  const args = { ...submission, attachments: [{ path: 'screen.png' }, { path: 'spec.md' }] };
  const receipt = await f.invoke('plan', 'request_review', args, 'submit');
  const replay = await f.invoke('plan', 'request_review', args, 'replay');
  assert.deepEqual(receipt, replay); assert.equal(f.state.humanReviews.length, 1);
  const review = f.state.humanReviews[0];
  assert.equal(review.status, 'pending'); assert.deepEqual(review.content, submission.content);
  assert.equal(review.attachments.length, 2); assert.equal(review.sourceFiles.length, 2);
  assert.equal(readFileSync(join(f.root, review.attachments[1].relativePath), 'utf8'), '# 方向');
  assert.equal(f.store.read()!.humanReviews[0].id, receipt.review_id);
  const view = await f.invoke('plan', 'get_review', { request_id: 'review-1' }, 'query');
  assert.equal(view.id, receipt.review_id);
  for (const field of ['request', 'replayCalls', 'bundle']) assert.equal(field in view, false);
  const snapshot = (await f.engine.command({ type: 'snapshot', projectId: f.projectId })).snapshot.selected!;
  for (const field of ['request', 'replayCalls', 'bundle']) assert.equal(field in snapshot.humanReviews![0], false);
  const changed = await f.raw('plan', 'request_review', { ...args, content: 'changed' }, 'changed');
  assert.equal(changed.result.structuredContent.error.code, 'REQUEST_CONFLICT');
  const sameCall = await f.raw('plan', 'request_review', { ...args, request_id: 'different' }, 'replay');
  assert.equal(sameCall.result.structuredContent.error.code, 'REQUEST_CONFLICT');
});

test('HTTP requires native Thread/Turn/call ownership, active source and checkpoint owner; no approval tool exists', async t => {
  const f = await setup(t); const task = await f.active('plan');
  for (const context of [{ ...f.context('plan', 'x'), callId: '' }, { ...f.context('plan', 'x'), turnId: 'other' }, { ...f.context('plan', 'x'), threadId: 'other' }]) {
    const result = await f.raw('plan', 'request_review', submission, 'x', context);
    assert.equal(result.result.structuredContent.error.code, 'PERMISSION_DENIED');
  }
  const other = f.state.nodes.find(node => node.id === 'review')!;
  await f.engine.command({ type: 'save_node', projectId: f.projectId, node: { ...other, tools: [...other.tools, 'request_review'] as any } }); await f.active('review');
  const denied = await f.raw('review', 'request_review', submission, 'owner'); assert.equal(denied.result.structuredContent.error.code, 'PERMISSION_DENIED');
  const approve = await f.raw('plan', 'decide_review', {}, 'approve'); assert.ok(approve.error || approve.result?.isError);
  f.finish(task); await new Promise(resolve => setTimeout(resolve, 20));
  const ended = await f.raw('plan', 'request_review', submission, 'ended', f.context('plan', 'ended', task)); assert.equal(ended.result.structuredContent.error.code, 'SOURCE_NOT_ACTIVE');
  assert.equal(f.state.humanReviews.length, 0);
});

test('review admission rejects unsafe paths and SQLite failure without publishing a review or event', async t => {
  const f = await setup(t); await f.active('plan');
  const bad = await f.raw('plan', 'request_review', { ...submission, attachments: [{ path: '.mixcat/project.sqlite' }] }, 'bad'); assert.equal(bad.result.isError, true);
  const before = f.state.conversation.length, restore = f.rejectSave();
  const rejected = await f.raw('plan', 'request_review', submission, 'db'); restore();
  assert.equal(rejected.result.structuredContent.error.code, 'STORAGE_UNAVAILABLE');
  assert.equal(f.state.humanReviews.length, 0); assert.equal(f.state.conversation.length, before);
});

test('existing projects retain grants and context exposes policy/dependencies without discovery', async t => {
  const f = await collaborationFixture(t);
  for (const node of [...f.state.nodes]) await f.engine.command({ type: 'save_node', projectId: f.projectId, node: { ...node, tools: node.tools.filter(tool => !['request_review', 'get_review'].includes(tool)) } });
  assert.equal(f.state.nodes.some(node => node.tools.some(tool => ['request_review', 'get_review'].includes(tool))), false);
  await f.active('plan'); const before = f.clients.flatMap(client => client.calls).length;
  const ctx = await f.invoke('plan', 'get_project_context', {}, 'ctx');
  assert.deepEqual(ctx.review_policy, { revision: 0, checkpoints: [] }); assert.deepEqual(ctx.review_dependencies, []); assert.deepEqual(ctx.human_reviews, []);
  assert.equal(f.clients.flatMap(client => client.calls).length, before);
  const node = f.state.nodes.find(node => node.id === 'review')!;
  const denied = await f.raw('plan', 'update_workflow', { operation: 'save_node', request_id: 'grant', node: { ...node, tools: [...node.tools, 'request_review'] } }, 'grant');
  assert.equal(denied.result.structuredContent.error.code, 'PERMISSION_DENIED');
  const legacy = await f.raw('plan', 'update_workflow', { node: { ...node, id: 'legacy-grant', revision: 0, tools: ['get_project_context', 'request_review'] } }, 'legacy');
  assert.equal(legacy.result.isError, true); assert.equal(f.state.nodes.some(node => node.id === 'legacy-grant'), false);
});

test('concurrent identical HTTP submissions commit once and superseded attachments stay registered', async t => {
  const f = await setup(t); await f.active('plan'); writeFileSync(join(f.root, 'spec.md'), 'original');
  const args = { ...submission, attachments: [{ path: 'spec.md' }] };
  const receipts = await Promise.all([f.invoke('plan', 'request_review', args, 'one'), f.invoke('plan', 'request_review', args, 'two')]);
  assert.equal(receipts[0].review_id, receipts[1].review_id); assert.equal(f.state.humanReviews.length, 1);
  const first = structuredClone(f.state.humanReviews[0]);
  await f.invoke('plan', 'request_review', { ...submission, request_id: 'r2', attachments: [{ artifact_id: first.attachments[0].artifact_id }] }, 'next');
  assert.equal(f.state.humanReviews[0].supersededBy, f.state.humanReviews[1].id);
  assert.deepEqual(f.state.humanReviews[0].attachments, first.attachments); assert.equal(f.state.humanReviews[0].bundle, first.bundle);
  assert.equal(f.state.humanReviews[1].attachments[0].name, 'spec.md'); assert.deepEqual(f.state.humanReviews[1].sourceFiles, []);
  assert.deepEqual(await f.invoke('plan', 'request_review', args, 'late-replay'), receipts[0]);
});

test('asynchronous material preparation rechecks policy, source controls and revoked identity', async t => {
  for (const change of ['policy', 'pause', 'stop', 'revoke'] as const) await t.test(change, async t => {
    const f = await setup(t); await f.active('plan'); writeFileSync(join(f.root, 'spec.md'), 'original');
    const entered = deferred(), release = deferred(), original = fs.readFile;
    fs.readFile = (async (...args: Parameters<typeof original>) => {
      const bytes = await (original as any)(...args); if (String(args[0]) === join(f.root, 'spec.md')) { entered.resolve(); await release.promise; } return bytes;
    }) as typeof original;
    try {
      const pending = f.raw('plan', 'request_review', { ...submission, attachments: [{ path: 'spec.md' }] }, change); await entered.promise;
      if (change === 'policy') await f.engine.command({ type: 'save_review_policy', projectId: f.projectId, policy: { ...f.state.reviewPolicy, checkpoints: f.state.reviewPolicy.checkpoints.map(point => ({ ...point, name: 'changed' })) } });
      else if (change === 'revoke') (f.engine as any).revoke(f.projectId, 'plan');
      else await f.engine.command({ type: change === 'stop' ? 'stop' : 'pause_node', projectId: f.projectId, nodeId: 'plan' } as any);
      release.resolve(); const response = await pending;
      assert.equal(response.result.isError, true); assert.equal(f.state.humanReviews.length, 0);
      assert.equal(response.result.structuredContent.error.code, change === 'policy' ? 'REVISION_CONFLICT' : change === 'revoke' ? 'PERMISSION_DENIED' : 'SOURCE_NOT_ACTIVE');
    } finally { release.resolve(); fs.readFile = original; }
  });
});
