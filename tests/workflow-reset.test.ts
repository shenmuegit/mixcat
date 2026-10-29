import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkflowEngine } from '../src/core/engine.js';
import { fixture, until, deferred } from './runtime-fixture.js';
import type { AppUpdate } from '../src/shared/types.js';
import { reviewFixture } from './human-review-fixture.js';

test('workflow reset clears every node session, persists and starts a fresh thread while keeping the project', async t => {
  const f = await fixture(t);
  await f.engine.command({ type: 'save_edge', projectId: f.projectId, edge: { id: 'route', sourceNodeId: 'plan', targetNodeId: 'implement', condition: 'ready', revision: 0 } });
  await f.engine.command({ type: 'save_group', projectId: f.projectId, group: { id: 'group', name: 'Team', nodeIds: ['plan', 'implement'], coordinatorNodeId: 'plan', revision: 0 } });
  const item = await f.engine.command({ type: 'update_project_item', projectId: f.projectId, input: { request_id: 'keep-todo', operation: 'create', kind: 'todo', title: 'Keep this task' } });
  writeFileSync(join(f.root, 'source.txt'), 'keep this file');
  for (const nodeId of ['plan', 'review']) {
    await f.send(nodeId);
    await until(() => f.clients[0].calls.filter(call => call.method === 'turn/start').length === (nodeId === 'plan' ? 1 : 2));
    const snapshot = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!;
    const task = snapshot.tasks.find(task => task.nodeId === nodeId)!;
    f.clients[0].options.onEvent({ method: 'turn/completed', params: { threadId: task.threadId, turn: { id: task.turnId, status: 'completed' } } });
  }
  await f.engine.command({ type: 'delete_node', projectId: f.projectId, nodeId: 'review' });
  const before = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!;
  assert(before.conversation!.length > 0);
  const updates: AppUpdate[] = [];
  f.engine.subscribe(update => updates.push(update));
  await until(() => updates.length > 0);
  updates.length = 0;
  const reset = (await f.engine.command({ type: 'reset_workflow', projectId: f.projectId, confirmed: true })).snapshot.selected!;
  assert.deepEqual(reset.conversation, []);
  assert.deepEqual(reset.tasks, []);
  assert.deepEqual(reset.handoffs, []);
  assert.deepEqual(reset.messages, []);
  assert.deepEqual(reset.humanReviews, []);
  assert.deepEqual(reset.activities, []);
  assert.deepEqual(reset.resumeNodeIds, []);
  assert.equal(reset.project.status, 'idle');
  assert(reset.nodes.every(node => node.threadId === null && node.status === 'idle'));
  assert(reset.archivedNodes!.every(node => node.threadId === null));
  const definition = ({ threadId, status, ...node }: typeof reset.nodes[number]) => node;
  assert.deepEqual(reset.nodes.map(definition), before.nodes.map(definition));
  for (const key of ['edges', 'groups', 'edgeLayouts', 'reviewPolicy'] as const) assert.deepEqual(reset[key], before[key]);
  assert.equal(readFileSync(join(f.root, 'source.txt'), 'utf8'), 'keep this file');
  assert.equal((await f.engine.command({ type: 'get_project_item', projectId: f.projectId, itemId: item.projectItem!.item.id })).projectItem!.item.title, 'Keep this task');
  await until(() => updates.length > 0);
  assert.equal(updates[0].kind, 'full');
  if (updates[0].kind === 'full') assert.deepEqual(updates[0].snapshot.selected!.conversation, []);
  await f.send('plan');
  await until(() => f.clients[1]?.calls.some(call => call.method === 'turn/start') ?? false);
  assert(f.clients[1].calls.some(call => call.method === 'thread/start'));
  assert(!f.clients[1].calls.some(call => call.method === 'thread/resume'));
  const fresh = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!.tasks[0];
  assert.notEqual(fresh.threadId, before.nodes.find(node => node.id === 'plan')!.threadId);
  f.clients[1].options.onEvent({ method: 'turn/completed', params: { threadId: fresh.threadId, turn: { id: fresh.turnId, status: 'completed' } } });
  await f.engine.command({ type: 'reset_workflow', projectId: f.projectId, confirmed: true });
  await f.engine.close();
  const reopened = new WorkflowEngine({ workbenchRoot: f.root, executable: 'unused' });
  t.after(() => reopened.close()); await reopened.init();
  const restored = (await reopened.command({ type: 'snapshot', projectId: f.projectId })).snapshot.selected!;
  assert.deepEqual(restored.conversation, []); assert.deepEqual(restored.tasks, []);
  assert(restored.nodes.every(node => node.threadId === null && node.status === 'idle'));
});

test('reset requires confirmation and rejects running, paused and queued work without changing it', async t => {
  const f = await fixture(t);
  await assert.rejects(f.engine.command({ type: 'reset_workflow', projectId: f.projectId, confirmed: false }), /确认/);
  await f.send('plan');
  await until(() => f.clients[0].calls.some(call => call.method === 'turn/start'));
  const rejectReset = async () => {
    const before = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!;
    await assert.rejects(f.engine.command({ type: 'reset_workflow', projectId: f.projectId, confirmed: true }), /未完成/);
    assert.deepEqual((await f.engine.command({ type: 'snapshot' })).snapshot.selected!, before);
  };
  await rejectReset();
  await f.engine.command({ type: 'pause', projectId: f.projectId });
  const task = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!.tasks[0];
  f.clients[0].options.onEvent({ method: 'turn/completed', params: { threadId: task.threadId, turn: { id: task.turnId, status: 'interrupted' } } });
  await rejectReset();
  await f.send('implement');
  await rejectReset();
  await f.engine.command({ type: 'stop', projectId: f.projectId });
  await f.engine.command({ type: 'reset_workflow', projectId: f.projectId, confirmed: true });
  assert.deepEqual((await f.engine.command({ type: 'snapshot' })).snapshot.selected!.tasks, []);
});

test('reset refuses an in-flight admission or connection and unresolved native requests', async t => {
  const entered = deferred(), release = deferred();
  t.after(async () => release.resolve());
  const f = await fixture(t, async () => { entered.resolve(); await release.promise; });
  const sending = f.send('plan');
  await entered.promise;
  await assert.rejects(f.engine.command({ type: 'reset_workflow', projectId: f.projectId, confirmed: true }), /启动/);
  release.resolve(); await sending;
  await until(() => f.clients[0].calls.some(call => call.method === 'turn/start'));
  const task = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!.tasks[0];
  f.clients[0].options.onEvent({ method: 'turn/completed', params: { threadId: task.threadId, turn: { id: task.turnId, status: 'completed' } } });
  f.clients[0].options.onRequest!({ id: 9, method: 'item/commandExecution/requestApproval', params: { threadId: task.threadId, turnId: task.turnId, itemId: 'pending', command: 'echo test' } });
  await assert.rejects(f.engine.command({ type: 'reset_workflow', projectId: f.projectId, confirmed: true }), /请求/);
  assert.equal((await f.engine.command({ type: 'snapshot' })).snapshot.selected!.requests!.length, 1);
});

test('reset fences late history and native callbacks and blocks new commands until close settles', async t => {
  const f = await fixture(t); await f.send('plan');
  await until(() => f.clients[0].calls.some(call => call.method === 'turn/start'));
  const client = f.clients[0], task = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!.tasks[0];
  client.options.onEvent({ method: 'turn/completed', params: { threadId: task.threadId, turn: { id: task.turnId, status: 'completed' } } });
  const oldIdentity = f.engine.nodeIdentity(f.projectId, 'plan');
  const entered = deferred(), release = deferred(), closing = deferred(), closed = deferred();
  t.after(async () => { release.resolve(); closed.resolve(); });
  const rpc = client.port.rpc;
  client.port.rpc = async (method, params) => {
    if (method !== 'thread/items/list') return rpc(method, params);
    entered.resolve(); await release.promise;
    return { data: [{ turnId: task.turnId, item: { id: 'late-history', type: 'agentMessage', text: 'old history' } }], nextCursor: null };
  };
  client.port.close = async () => { closing.resolve(); await closed.promise; };
  const history = f.engine.command({ type: 'read_history', projectId: f.projectId, nodeId: 'plan' });
  await entered.promise;
  const reset = f.engine.command({ type: 'reset_workflow', projectId: f.projectId, confirmed: true });
  await closing.promise;
  await assert.rejects(f.send('plan'), /重置/);
  closed.resolve(); await reset;
  release.resolve(); await history;
  client.options.onEvent({ method: 'item/completed', params: { threadId: task.threadId, turnId: task.turnId, item: { id: 'late-event', type: 'agentMessage', text: 'old callback' } } });
  client.options.onRequest!({ id: 10, method: 'item/commandExecution/requestApproval', params: { threadId: task.threadId, turnId: task.turnId, itemId: 'late' } });
  const snapshot = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!;
  assert.deepEqual(snapshot.conversation, []); assert.deepEqual(snapshot.requests, []);
  assert.notEqual(f.engine.nodeIdentity(f.projectId, 'plan').token, oldIdentity.token);
});

test('failed reset storage leaves the complete old state available and can be retried', async t => {
  const f = await fixture(t); await f.send('plan');
  await until(() => f.clients[0].calls.some(call => call.method === 'turn/start'));
  const task = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!.tasks[0];
  f.clients[0].options.onEvent({ method: 'turn/completed', params: { threadId: task.threadId, turn: { id: task.turnId, status: 'completed' } } });
  const before = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!;
  const identity = f.engine.nodeIdentity(f.projectId, 'plan');
  const store = (f.engine as any).stores.get(f.projectId);
  store.db.exec("CREATE TEMP TRIGGER reject_reset BEFORE INSERT ON project_state BEGIN SELECT RAISE(ABORT, 'disk full'); END");
  await assert.rejects(f.engine.command({ type: 'reset_workflow', projectId: f.projectId, confirmed: true }), /disk full/);
  store.db.exec('DROP TRIGGER reject_reset');
  assert.deepEqual((await f.engine.command({ type: 'snapshot' })).snapshot.selected!, before);
  assert.equal(f.engine.nodeIdentity(f.projectId, 'plan').token, identity.token);
  await f.engine.command({ type: 'reset_workflow', projectId: f.projectId, confirmed: true });
  assert.deepEqual((await f.engine.command({ type: 'snapshot' })).snapshot.selected!.conversation, []);
});

test('reset clears review and message history while the next execution still obeys review policy', async t => {
  const f = await reviewFixture(t); await f.policy();
  await f.engine.command({ type: 'save_edge', projectId: f.projectId, edge: { id: 'route', sourceNodeId: 'plan', targetNodeId: 'review', condition: 'ready', revision: 0 } });
  await f.engine.command({ type: 'pause_node', projectId: f.projectId, nodeId: 'review' });
  const task = await f.active('plan');
  await f.submit();
  await f.invoke('plan', 'send_message', { request_id: 'message', to_node_id: 'review', content: 'old message', reason: 'review the result' }, 'message-call');
  f.finish(task);
  await f.engine.command({ type: 'stop', projectId: f.projectId });
  const before = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!;
  assert.equal(before.humanReviews!.length, 1); assert.equal(before.messages!.length, 1);
  const reset = (await f.engine.command({ type: 'reset_workflow', projectId: f.projectId, confirmed: true })).snapshot.selected!;
  assert.deepEqual(reset.humanReviews, []); assert.deepEqual(reset.messages, []);
  assert.deepEqual(reset.reviewPolicy, before.reviewPolicy);
  await f.send('implement');
  const next = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!;
  assert.equal(next.tasks[0].status, 'waiting_review');
  assert.equal(next.nodes.find(node => node.id === 'implement')!.threadId, null);
});

test('reset cannot discard execution requiring reconciliation after a disconnect', async t => {
  const f = await fixture(t); await f.send('plan');
  await until(() => f.clients[0].calls.some(call => call.method === 'turn/start'));
  f.clients[0].options.onDisconnect('unknown native outcome');
  const before = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!;
  assert.equal(before.tasks[0].status, 'needs_reconciliation');
  await assert.rejects(f.engine.command({ type: 'reset_workflow', projectId: f.projectId, confirmed: true }), /待核对/);
  assert.deepEqual((await f.engine.command({ type: 'snapshot' })).snapshot.selected!, before);
});

test('a review decision awaiting validation cannot create new work during reset', async t => {
  const f = await reviewFixture(t); await f.policy();
  const task = await f.active('plan'); await f.submit(); f.finish(task);
  const closing = deferred(), release = deferred();
  t.after(async () => release.resolve());
  f.clients[0].port.close = async () => { closing.resolve(); await release.promise; };
  const approval = f.approve();
  const rejected = assert.rejects(approval, /重置/);
  const reset = f.engine.command({ type: 'reset_workflow', projectId: f.projectId, confirmed: true });
  await closing.promise;
  try {
    await rejected;
    const during = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!;
    assert(during.tasks.every(task => task.status === 'completed'));
    assert.equal(during.humanReviews![0].status, 'pending');
  } finally { release.resolve(); await reset; }
  assert.deepEqual((await f.engine.command({ type: 'snapshot' })).snapshot.selected!.tasks, []);
});

test('reset invalidates hook discovery before it can trust hooks or append session activity', async t => {
  const f = await fixture(t); await f.engine.command({ type: 'connect', projectId: f.projectId });
  const client = f.clients[0], entered = deferred(), release = deferred(), rpc = client.port.rpc;
  t.after(async () => release.resolve());
  client.port.rpc = async (method, params) => {
    if (method !== 'hooks/list') return rpc(method, params);
    entered.resolve(); await release.promise;
    return { data: [{ hooks: [{ key: 'hook', currentHash: 'hash', command: 'echo test', sourcePath: join(f.root, 'hooks.json') }] }] };
  };
  const trust = f.engine.command({ type: 'trust_hooks', projectId: f.projectId, hooks: [{ key: 'hook', currentHash: 'hash' }] });
  const rejected = assert.rejects(trust, /连接已结束/);
  await entered.promise;
  await f.engine.command({ type: 'reset_workflow', projectId: f.projectId, confirmed: true });
  release.resolve(); await rejected;
  assert(!client.calls.some(call => call.method === 'config/batchWrite'));
  assert.deepEqual((await f.engine.command({ type: 'snapshot' })).snapshot.selected!.activities, []);
});

test('an already-started demo open cannot mutate the project while it resets', async t => {
  const f = await fixture(t);
  const demo = (await f.engine.command({ type: 'create_demo' })).snapshot.selected!;
  await f.engine.command({ type: 'connect', projectId: demo.project.id });
  const closing = deferred(), release = deferred();
  t.after(async () => release.resolve());
  f.clients[0].port.close = async () => { closing.resolve(); await release.promise; };
  const opening = f.engine.command({ type: 'create_demo' });
  const rejected = assert.rejects(opening, /重置/);
  const reset = f.engine.command({ type: 'reset_workflow', projectId: demo.project.id, confirmed: true });
  await closing.promise;
  try { await rejected; }
  finally { release.resolve(); await reset; }
  assert.deepEqual((await f.engine.command({ type: 'snapshot', projectId: demo.project.id })).snapshot.selected!.tasks, []);
});
