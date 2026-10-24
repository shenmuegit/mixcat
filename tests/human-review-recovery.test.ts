import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowEngine } from '../src/core/engine.js';
import { reviewFixture } from './human-review-fixture.js';
import { until } from './runtime-fixture.js';

test('waiting-only node is excluded from bulk running snapshot and enabled by bulk resume', async t => {
  const f = await reviewFixture(t); await f.policy(); const source = await f.active('plan'); await f.send('implement');
  const originalTurn = source.turnId;
  await f.engine.command({ type: 'pause', projectId: f.projectId }); f.finish(source, 'interrupted');
  assert.equal(f.state.pauseSnapshot?.includes('implement'), false);
  await f.engine.command({ type: 'resume', projectId: f.projectId });
  assert.notEqual(f.state.nodes.find(n => n.id === 'implement')!.status, 'paused');
  assert.equal(f.state.tasks.find(task => task.nodeId === 'implement')!.status, 'waiting_review');
  await until(() => source.status === 'running' && !!source.turnId && source.turnId !== originalTurn); await f.submit(); await f.approve();
  await until(() => !!f.state.tasks.find(task => task.nodeId === 'implement')!.turnId);
});

test('approval preserves explicit node pause and stop never revives waiting work', async t => {
  const f = await reviewFixture(t); await f.policy(); await f.active('plan'); await f.send('implement');
  const target = f.state.tasks.at(-1)!;
  await f.engine.command({ type: 'pause_node', projectId: f.projectId, nodeId: 'implement' }); await f.submit(); await f.approve();
  assert.equal(target.status, 'queued'); assert.equal(f.state.nodes.find(n => n.id === 'implement')!.status, 'paused'); assert.equal(target.turnId, null);
  await f.submit('r2'); assert.equal(target.status, 'waiting_review'); await f.engine.command({ type: 'stop', projectId: f.projectId });
  await f.approve(1); assert.equal(target.status, 'cancelled'); assert.equal(target.turnId, null);
});

test('paused native continuation retains turn identity when a new rule blocks resume; retry is gated too', async t => {
  const f = await reviewFixture(t); const task = await f.active('implement'), originalTurn = task.turnId, originalThread = task.threadId;
  await f.engine.command({ type: 'pause_node', projectId: f.projectId, nodeId: 'implement' }); f.finish(task, 'interrupted'); await f.policy();
  const before = f.turns().length; await f.engine.command({ type: 'resume_node', projectId: f.projectId, nodeId: 'implement' });
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(task.status, 'paused'); assert.equal(task.turnId, originalTurn); assert.equal(f.turns().length, before);
  assert.equal(f.state.project.status, 'blocked');
  await f.active('plan'); await f.submit(); await f.approve(); await until(() => task.status === 'running' && task.turnId !== originalTurn);
  assert.equal(task.threadId, originalThread); assert(task.previousTurnIds?.includes(originalTurn!));
  f.finish(task, 'failed'); await f.submit('r2'); await f.engine.command({ type: 'retry_task', projectId: f.projectId, taskId: task.id, confirmed: true });
  assert.equal(f.state.tasks.at(-1)!.status, 'waiting_review');
});

test('retry retains the input captured version even after a newer version is approved', async t => {
  const f = await reviewFixture(t); await f.policy(); await f.active('plan'); await f.submit(); await f.approve();
  const task = await f.active('implement'), capture = structuredClone(task.reviewDependencies); f.finish(task, 'failed');
  await f.submit('r2'); await f.approve(1); const before = f.turns().length;
  await f.engine.command({ type: 'retry_task', projectId: f.projectId, taskId: task.id, confirmed: true });
  const retry = f.state.tasks.at(-1)!; assert.equal(retry.status, 'waiting_review'); assert.deepEqual(retry.reviewDependencies, capture); assert.equal(f.turns().length, before);
});

test('restart preserves stale waiting captures after newer approval and prevents changing execution mode', async t => {
  const f = await reviewFixture(t); await f.policy(); const source = await f.active('plan'); await f.send('implement'); await f.submit();
  const target = f.state.tasks.find(task => task.nodeId === 'implement')!, capture = structuredClone(target.reviewDependencies);
  await f.submit('r2'); await f.approve(1); assert.equal(target.status, 'waiting_review'); assert.deepEqual(target.reviewDependencies, capture);
  f.finish(source); await until(() => source.status === 'completed');
  await assert.rejects(f.engine.command({ type: 'send_message', projectId: f.projectId, nodeId: 'review', mode: 'demo', input: [{ type: 'text', text: 'mode change' }] }), /模式|环境/);
  await f.engine.close(); let calls = 0;
  const engine = new WorkflowEngine({ workbenchRoot: f.root, executable: 'fixture', nativeFactory() { calls++; throw new Error('offline'); } }); t.after(() => engine.close()); await engine.init();
  const state = (engine as any).states.get(f.projectId);
  assert.equal(state.tasks.find((t: any) => t.id === target.id).status, 'waiting_review'); assert.deepEqual(state.tasks.find((t: any) => t.id === target.id).reviewDependencies, capture);
  assert.equal(calls, 0);
});
