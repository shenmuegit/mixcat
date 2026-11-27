import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkflowEngine } from '../src/core/engine.js';
import { accountFixture } from './account-fixture.js';
import { deferred, fixture, until } from './runtime-fixture.js';
import type { AppCommand, TaskView } from '../src/shared/types.js';

async function queue(t: Parameters<typeof fixture>[0]) {
  const f = await fixture(t);
  const snapshot = async () => (await f.engine.command({ type: 'snapshot', projectId: f.projectId })).snapshot.selected!;
  await f.send('plan');
  await until(() => f.clients[0]?.calls.some(call => call.method === 'turn/start'));
  const active = (await snapshot()).tasks[0];
  assert(active.threadId && active.turnId);
  const send = async (text: string, nodeId = 'plan') => {
    await f.engine.command({ type: 'send_message', projectId: f.projectId, nodeId, mode: 'codex', input: [{ type: 'text', text, text_elements: [] }] });
    return (await snapshot()).tasks.at(-1)!;
  };
  const steer = (task: TaskView): AppCommand => ({ type: 'steer_node_message', projectId: f.projectId, nodeId: task.nodeId, taskId: task.id, activeTaskId: active.id, expectedTurnId: active.turnId! });
  const client = f.clients[0];
  const finish = () => client.options.onEvent({ method: 'turn/completed', params: { threadId: active.threadId, turn: { id: active.turnId, status: 'completed', items: [] } } });
  return { ...f, snapshot, active, send, steer, client, finish };
}

test('waiting user messages dispatch in order and the chosen guidance joins the same native turn once', async t => {
  const f = await queue(t);
  const next = await f.send('等下一轮');
  const following = await f.send('等前一条消息答复');
  const guiding = await f.send('继续原回答并补一个例子');
  assert.deepEqual((await f.snapshot()).tasks.slice(1).map(task => [task.instruction, task.status]),
    [[next.instruction, 'queued'], [following.instruction, 'queued'], [guiding.instruction, 'queued']]);
  assert.equal(f.client.calls.filter(call => call.method === 'turn/start').length, 1);
  const original = f.client.port.rpc.bind(f.client.port);
  const gate = deferred(); t.after(gate.resolve);
  const calls: unknown[] = [];
  f.client.port.rpc = async (method, params) => {
    if (method !== 'turn/steer') return original(method, params);
    calls.push(params);
    f.client.options.onEvent({ method: 'item/completed', params: { threadId: params.threadId, turnId: params.expectedTurnId,
      item: { id: 'guided-input', clientId: params.clientUserMessageId, type: 'userMessage', content: params.input } } });
    await gate.promise;
    return { turnId: params.expectedTurnId };
  };
  const command = f.steer(guiding);
  const first = f.engine.command(command);
  await until(() => calls.length === 1);
  await f.engine.command(command);
  gate.resolve(); await first;
  assert.deepEqual(calls, [{ threadId: f.active.threadId, expectedTurnId: f.active.turnId, clientUserMessageId: guiding.id, input: [{ type: 'text', text: guiding.instruction, text_elements: [] }] }]);
  const snapshot = await f.snapshot();
  assert.equal(snapshot.tasks.find(task => task.id === f.active.id)?.status, 'running');
  assert.equal(snapshot.tasks.find(task => task.id === guiding.id)?.steering, 'accepted');
  assert.deepEqual(snapshot.conversation!.filter(entry => entry.text === guiding.instruction).map(entry => [entry.taskId, entry.itemId, entry.turnId]), [[guiding.id, 'guided-input', f.active.turnId]]);
  f.finish();
  await until(() => f.client.calls.filter(call => call.method === 'turn/start').length === 2);
  const running = (await f.snapshot()).tasks.find(task => task.id === next.id)!;
  f.client.options.onEvent({ method: 'turn/completed', params: { threadId: running.threadId, turn: { id: running.turnId, status: 'completed', items: [] } } });
  await until(() => f.client.calls.filter(call => call.method === 'turn/start').length === 3);
  assert.deepEqual(f.client.calls.filter(call => call.method === 'turn/start').slice(1).map(call => call.params.input[0].text), [next.instruction, following.instruction]);
});

test('a stale or foreign target is rejected and a native rejection leaves the original message waiting', async t => {
  const f = await queue(t);
  const second = await f.send('继续排队');
  const command = f.steer(second);
  assert(command.type === 'steer_node_message');
  await assert.rejects(f.engine.command({ ...command, expectedTurnId: 'stale' }), /当前轮/);
  await assert.rejects(f.engine.command({ ...command, nodeId: 'implement' }), /排队消息/);
  const original = f.client.port.rpc.bind(f.client.port);
  let calls = 0;
  f.client.port.rpc = async (method, params) => {
    if (method !== 'turn/steer') return original(method, params);
    calls++;
    throw Object.assign(new Error('turn already ended'), { code: -32000 });
  };
  const after = (await f.engine.command(command)).snapshot.selected!.tasks.find(task => task.id === second.id)!;
  assert.equal(calls, 1);
  assert.equal(after.status, 'queued');
  assert.match(after.error!, /引导未送达/);
  f.finish();
  await until(() => f.client.calls.filter(call => call.method === 'turn/start').length === 2);
  assert.equal(f.client.calls.filter(call => call.method === 'turn/start')[1].params.input[0].text, second.instruction);
});

test('a lost guidance receipt survives a reopen and native history confirms the existing message', async t => {
  const f = await queue(t);
  const second = await f.send('这条引导只发送一次');
  const original = f.client.port.rpc.bind(f.client.port);
  const item = { id: 'guided-history', type: 'userMessage', clientId: second.id, content: [{ type: 'text', text: second.instruction, text_elements: [] }] };
  f.client.port.rpc = async (method, params) => {
    if (method !== 'turn/steer') return original(method, params);
    throw Object.assign(new Error('lost receipt'), { outcome: 'unknown' });
  };
  const after = (await f.engine.command(f.steer(second))).snapshot.selected!;
  assert.equal(after.tasks.find(task => task.id === second.id)?.steering, 'unknown');
  f.finish(); await f.engine.close();
  const newCalls: string[] = [];
  const reopened = new WorkflowEngine({ workbenchRoot: f.root, executable: 'unused', accountFactory: accountFixture().factory,
    nativeFactory: () => ({ async connect() {}, async close() {}, async rpc(method) {
      newCalls.push(method);
      if (method === 'thread/items/list') return { data: [{ turnId: f.active.turnId, item }], nextCursor: null };
      return {};
    } }) });
  t.after(() => reopened.close()); await reopened.init();
  const restored = (await reopened.command({ type: 'snapshot', projectId: f.projectId })).snapshot.selected!;
  assert.equal(restored.tasks.find(task => task.id === second.id)?.steering, 'unknown');
  const checked = (await reopened.command({ type: 'read_history', projectId: f.projectId, nodeId: 'plan' })).snapshot.selected!;
  assert.equal(checked.tasks.find(task => task.id === second.id)?.steering, 'accepted');
  assert.deepEqual(checked.conversation!.filter(entry => entry.text === second.instruction).map(entry => entry.itemId), [item.id]);
  assert(!newCalls.some(method => method === 'turn/start' || method === 'turn/steer'));
});

test('a late rejection cannot requeue guidance from a stopped cycle', async t => {
  const f = await queue(t);
  const second = await f.send('这条属于已停止的一轮');
  const original = f.client.port.rpc.bind(f.client.port);
  const entered = deferred(), release = deferred(); t.after(release.resolve);
  f.client.port.rpc = async (method, params) => {
    if (method !== 'turn/steer') return original(method, params);
    entered.resolve(); await release.promise;
    throw Object.assign(new Error('turn already ended'), { code: -32000 });
  };
  const steering = f.engine.command(f.steer(second));
  await entered.promise;
  f.finish();
  await assert.rejects(f.engine.command({ type: 'retry_task', projectId: f.projectId, taskId: second.id, confirmed: true }), /等待原生回执/);
  await f.engine.command({ type: 'stop', projectId: f.projectId });
  await f.send('另一个节点的新一轮', 'implement');
  release.resolve(); await steering;
  assert.equal((await f.snapshot()).tasks.find(task => task.id === second.id)?.status, 'cancelled');
  const starts = f.client.calls.filter(call => call.method === 'turn/start');
  assert(starts.every(call => call.params.input[0].text !== second.instruction));
});

test('confirming a lost guidance receipt respects a deliberate node pause', async t => {
  const f = await queue(t);
  const steering = await f.send('确认这条引导');
  const waiting = await f.send('暂停期间等待');
  const original = f.client.port.rpc.bind(f.client.port);
  f.client.port.rpc = async (method, params) => {
    if (method === 'turn/steer') throw Object.assign(new Error('lost receipt'), { outcome: 'unknown' });
    if (method === 'thread/items/list') return { data: [{ turnId: f.active.turnId,
      item: { id: 'paused-guidance', type: 'userMessage', clientId: steering.id, content: [{ type: 'text', text: steering.instruction }] } }], nextCursor: null };
    return original(method, params);
  };
  await f.engine.command(f.steer(steering));
  f.finish();
  await f.engine.command({ type: 'pause_node', projectId: f.projectId, nodeId: 'plan' });
  const checked = (await f.engine.command({ type: 'read_history', projectId: f.projectId, nodeId: 'plan' })).snapshot.selected!;
  assert.equal(checked.tasks.find(task => task.id === steering.id)?.steering, 'accepted');
  assert.equal(checked.nodes.find(node => node.id === 'plan')?.status, 'paused');
  assert.equal(checked.tasks.find(task => task.id === waiting.id)?.status, 'queued');
  assert.equal(f.client.calls.filter(call => call.method === 'turn/start').length, 1);
});

test('routed work, structured references and review gates retain normal queue admission', async t => {
  const f = await queue(t);
  const sender = await f.send('准备成果', 'implement');
  await until(() => f.client.calls.filter(call => call.method === 'turn/start').length === 2);
  const source = (await f.snapshot()).tasks.find(task => task.id === sender.id)!;
  const handoff = await f.engine.invokeTool('handoff', { to_node_id: 'plan', task: '阅读交接成果', reason: '保留路由', result: '成果正文' },
    { identity: f.engine.nodeIdentity(f.projectId, 'implement'), threadId: source.threadId!, turnId: source.turnId!, callId: 'fixture-handoff' }) as { handoffId: string };
  f.client.options.onEvent({ method: 'turn/completed', params: { threadId: source.threadId, turn: { id: source.turnId, status: 'completed', items: [] } } });
  const routed = (await f.snapshot()).tasks.find(task => task.id === handoff.handoffId)!;
  assert.equal(routed.status, 'queued'); assert.equal(routed.userMessage, undefined);
  await assert.rejects(f.engine.command(f.steer(routed)), /排队消息/);

  const issue = (await f.engine.command({ type: 'update_project_item', projectId: f.projectId,
    input: { operation: 'create', kind: 'issue', title: '引用的工作项', request_id: 'fixture-issue' } })).projectItem!.item;
  await f.engine.command({ type: 'send_message', projectId: f.projectId, nodeId: 'plan', mode: 'codex', input: [{ type: 'text', text: '按引用继续' }],
    work_context: { references: [{ projectId: f.projectId, kind: 'issue', id: issue.id }] } });
  const linked = (await f.snapshot()).tasks.at(-1)!;
  assert.equal(linked.userMessage, true); assert.equal(linked.canSteer, undefined);
  await assert.rejects(f.engine.command(f.steer(linked)), /不能引导/);

  const ordinary = await f.send('等待审核');
  assert.equal(ordinary.canSteer, true);
  await f.engine.command({ type: 'save_review_policy', projectId: f.projectId, policy: { revision: 0,
    checkpoints: [{ id: 'manual', ownerNodeId: 'implement', name: '人工验收', requiredForNodeIds: ['plan'], dependsOn: [], revision: 1 }] } });
  assert.equal((await f.snapshot()).tasks.find(task => task.id === ordinary.id)?.status, 'waiting_review');
  await assert.rejects(f.engine.command(f.steer(ordinary)), /不能引导/);
  assert(!f.client.calls.some(call => call.method === 'turn/steer'));
});
