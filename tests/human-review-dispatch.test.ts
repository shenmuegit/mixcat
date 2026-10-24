import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { reviewFixture } from './human-review-fixture.js';
import { deferred, until } from './runtime-fixture.js';

test('gated direct input and start persist offline without any native/account connection', async t => {
  const f = await reviewFixture(t); await f.policy();
  let connections = 0;
  (f.engine as any).options.nativeFactory = () => { connections++; throw new Error('unexpected connection'); };
  (f.engine as any).account.restore = async () => { connections++; throw new Error('unexpected account restore'); };
  await f.send('implement');
  await f.engine.command({ type: 'start', projectId: f.projectId, nodeId: 'implement', mode: 'codex', instruction: 'start original' });
  assert.equal(connections, 0); assert.deepEqual(f.state.tasks.map(task => task.status), ['waiting_review', 'waiting_review']);
  assert.deepEqual(f.state.tasks.map(task => task.instruction), ['hello', 'start original']);
  assert.equal(f.state.conversation.filter(e => e.direction === 'input').length, 2);
  assert.equal(f.state.project.status, 'blocked');
});

test('direct and no-edge MCP sends wait, independent work runs, approval releases original FIFO', async t => {
  const f = await reviewFixture(t); await f.policy(); const source = await f.active('plan');
  await f.send('implement'); const first = f.state.tasks.at(-1)!; const before = f.turns().length;
  const receipt = await f.invoke('plan', 'send_message', { request_id: 'direct', to_node_id: 'implement', content: { original: 1 }, reason: 'no edge' }, 'direct');
  const second = f.state.tasks.find(task => task.id === receipt.target_task_id)!;
  assert.equal(first.status, 'waiting_review'); assert.equal(second.status, 'waiting_review'); assert.equal(f.turns().length, before);
  await f.active('review'); await f.submit(); await f.approve();
  await until(() => !!first.turnId); assert.equal(second.status, 'queued'); assert.deepEqual(second.input, { original: 1 });
  f.finish(first); await until(() => !!second.turnId); assert.equal(first.threadId, second.threadId); assert.equal(source.status, 'running');
});

for (const outcome of ['completed', 'failed']) test(`legacy handoff keeps source success prerequisite after approval: ${outcome}`, async t => {
  const f = await reviewFixture(t); await f.policy(); const source = await f.active('plan'); await f.submit();
  await f.invoke('plan', 'handoff', { to_node_id: 'implement', task: 'legacy', reason: 'review', result: { summary: 'result' } }, 'handoff');
  const target = f.state.tasks.find(task => task.nodeId === 'implement')!; assert.equal(target.status, 'waiting_source');
  await f.approve(); assert.equal(target.status, 'waiting_source'); f.finish(source, outcome);
  if (outcome === 'completed') await until(() => !!target.turnId);
  else { await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(target.status, 'waiting_source'); assert.equal(target.turnId, null); }
});

test('source completion before first review submission enters business waiting without dispatch', async t => {
  const f = await reviewFixture(t); await f.policy(); const source = await f.active('plan');
  await f.invoke('plan', 'handoff', { to_node_id: 'implement', task: 'legacy', reason: 'review', result: 'original' }, 'handoff');
  const target = f.state.tasks.find(task => task.nodeId === 'implement')!; f.finish(source);
  assert.equal(target.status, 'waiting_review'); assert.equal(target.turnId, null);
});

test('two checkpoints release design then frontend, never treating direction approval as UI approval', async t => {
  const f = await reviewFixture(t);
  await f.engine.command({ type: 'save_review_policy', projectId: f.projectId, policy: { revision: 0, checkpoints: [
    { id: 'direction', name: '方向', ownerNodeId: 'plan', requiredForNodeIds: ['implement', 'review'], dependsOn: [], revision: 1 },
    { id: 'ui', name: 'UI', ownerNodeId: 'implement', requiredForNodeIds: ['review'], dependsOn: ['direction'], revision: 1 },
  ] } });
  await f.active('plan'); await f.send('implement'); await f.send('review');
  const design = f.state.tasks.find(task => task.nodeId === 'implement')!, frontend = f.state.tasks.find(task => task.nodeId === 'review')!;
  assert.equal(design.status, 'waiting_review'); assert.equal(frontend.status, 'waiting_review');
  await f.submit(); await f.approve(); await until(() => !!design.turnId); assert.equal(frontend.status, 'waiting_review');
  await f.invoke('implement', 'request_review', { request_id: 'ui', checkpoint_id: 'ui', title: 'UI', content: ['screen'] }, 'ui');
  await f.approve(1); await until(() => !!frontend.turnId);
});

test('pending native review alone prevents demo mode and notification resumes the recorded source Thread', async t => {
  const f = await reviewFixture(t); await f.policy(); const source = await f.active('plan'); await f.submit(); f.finish(source);
  await assert.rejects(f.engine.command({ type: 'start', projectId: f.projectId, nodeId: 'review', mode: 'demo', instruction: 'other' }), /模式|环境/);
  f.state.nodes.find(n => n.id === 'plan')!.threads.codex = 'different-later-thread';
  await f.approve(); const notification = f.state.tasks.find(task => task.id === f.state.humanReviews[0].decision!.continuationTaskId)!;
  await until(() => !!notification.turnId); assert.equal(notification.threadId, source.threadId);
  assert.equal(f.clients[0].calls.filter(c => c.method === 'thread/resume').at(-1)!.params.threadId, source.threadId);
});

test('policy change during account preparation blocks both thread and turn RPCs', async t => {
  const f = await reviewFixture(t); await f.engine.command({ type: 'connect', projectId: f.projectId });
  const client = f.clients[0], rpc = client.port.rpc, entered = deferred(), release = deferred(); let reads = 0;
  client.port.rpc = async (method, params) => { if (method === 'account/read' && ++reads === 2) { entered.resolve(); await release.promise; } return rpc(method, params); };
  await f.send('implement'); await entered.promise;
  try { await f.policy(); } finally { release.resolve(); }
  await until(() => f.state.tasks[0].status === 'waiting_review');
  assert.equal(client.calls.filter(c => ['thread/start', 'thread/resume', 'turn/start'].includes(c.method)).length, 0);
});

test('replacement after submitted turn/start preserves the real native execution and its old capture', async t => {
  const f = await reviewFixture(t); await f.policy(); await f.active('plan'); await f.submit(); await f.approve();
  const client = f.clients[0], rpc = client.port.rpc, entered = deferred(), release = deferred();
  client.port.rpc = async (method, params) => { const result = await rpc(method, params); if (method === 'turn/start') { entered.resolve(); await release.promise; } return result; };
  await f.send('implement'); await entered.promise;
  const target = f.state.tasks.find(task => task.nodeId === 'implement')!, capture = structuredClone(target.reviewDependencies);
  try { await f.submit('r2'); } finally { release.resolve(); }
  await until(() => !!target.turnId); assert.equal(target.status, 'running'); assert.deepEqual(target.reviewDependencies, capture);
});

for (const change of ['policy', 'new-requirement', 'replacement', 'stop', 'material'] as const) test(`dispatch preparation rechecks ${change} before turn/start`, async t => {
  const f = await reviewFixture(t); await f.policy(); await f.active('plan');
  writeFileSync(join(f.root, 'direction.md'), 'first'); await f.submit('r1', [{ path: 'direction.md' }]); await f.approve();
  const client = f.clients[0], rpc = client.port.rpc, entered = deferred(), release = deferred();
  client.port.rpc = async (method, params) => { if (method === 'thread/start') { entered.resolve(); await release.promise; } return rpc(method, params); };
  await f.send('implement'); await entered.promise; const target = f.state.tasks.find(task => task.nodeId === 'implement')!, before = f.turns().length;
  try {
    if (change === 'policy') await f.engine.command({ type: 'save_review_policy', projectId: f.projectId, policy: { revision: f.state.reviewPolicy.revision, checkpoints: f.state.reviewPolicy.checkpoints.map(p => ({ ...p, name: 'changed' })) } });
    if (change === 'new-requirement') await f.engine.command({ type: 'save_review_policy', projectId: f.projectId, policy: { revision: f.state.reviewPolicy.revision, checkpoints: [...f.state.reviewPolicy.checkpoints, { id: 'extra', name: '额外核对', ownerNodeId: 'review', requiredForNodeIds: ['implement'], dependsOn: [], revision: 1 }] } });
    if (change === 'replacement') await f.submit('r2');
    if (change === 'stop') await f.engine.command({ type: 'stop', projectId: f.projectId });
    if (change === 'material') writeFileSync(join(f.root, 'direction.md'), 'changed');
  } finally { release.resolve(); }
  await until(() => target.status !== 'running'); assert.equal(target.status, change === 'stop' ? 'cancelled' : 'waiting_review');
  assert.equal(f.turns().length, before); assert(target.threadId, 'actual created Thread remains recorded');
});
