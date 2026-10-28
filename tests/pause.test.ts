import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { WorkflowEngine } from '../src/core/engine.js';
import { projectDirectory } from '../src/core/paths.js';
import type { CodexPort, NativeClientOptions } from '../src/shared/types.js';
import { deferred, fixture, until } from './runtime-fixture.js';
import { accountFixture } from './account-fixture.js';
import { collaborationFixture } from './collaboration-fixture.js';
import { reviewFixture } from './human-review-fixture.js';

for (const type of ['resume', 'resume_node'] as const) test(`enabling idle nodes after stop and pause: ${type}`, async t => {
  const f = await fixture(t);
  await f.engine.command({ type: 'stop', projectId: f.projectId });
  await f.engine.command({ type: 'pause', projectId: f.projectId });
  const result = await f.engine.command(type === 'resume'
    ? { type, projectId: f.projectId }
    : { type, projectId: f.projectId, nodeId: 'plan' });
  assert.equal(result.snapshot.selected!.nodes.find(node => node.id === 'plan')!.status, 'idle');
  assert.equal(result.snapshot.selected!.tasks.length, 0);
  assert.equal(f.clients.length, 0);
  await f.send('plan');
  await until(() => f.clients[0]?.calls.some(call => call.method === 'turn/start'));
  assert.equal((await f.engine.command({ type: 'snapshot' })).snapshot.selected!.tasks.length, 1);
});

for (const outcome of ['completed', 'interrupted', 'failed'] as const) test(`enable after settled stop retains ${outcome} history across restart`, async t => {
  const f = await fixture(t); await f.send('plan');
  await until(() => f.clients[0].calls.some(call => call.method === 'turn/start'));
  const task = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!.tasks[0];
  await f.engine.command({ type: 'stop', projectId: f.projectId });
  f.clients[0].options.onEvent({ method: 'turn/completed', params: { threadId: task.threadId, turn: { id: task.turnId, status: outcome } } });
  const settled = structuredClone((await f.engine.command({ type: 'snapshot' })).snapshot.selected!);
  assert.equal(settled.tasks[0].status, outcome === 'interrupted' ? 'cancelled' : outcome);
  await f.engine.command({ type: 'pause', projectId: f.projectId });
  await f.engine.close();
  let nativeCalls = 0;
  const restored = new WorkflowEngine({ workbenchRoot: f.root, executable: 'fixture', accountFactory: accountFixture().factory, nativeFactory() { nativeCalls++; throw Error('Enabling settled nodes must not start native execution'); } });
  t.after(() => restored.close()); await restored.init();
  await restored.command({ type: 'snapshot', projectId: f.projectId });
  await restored.command({ type: 'resume', projectId: f.projectId });
  await restored.command({ type: 'pause_node', projectId: f.projectId, nodeId: 'plan' });
  const result = (await restored.command({ type: 'resume_node', projectId: f.projectId, nodeId: 'plan' })).snapshot.selected!;
  assert.deepEqual(result.tasks, settled.tasks);
  assert.deepEqual(JSON.parse(JSON.stringify(result.conversation)), JSON.parse(JSON.stringify(settled.conversation)));
  assert.equal(result.nodes.find(node => node.id === 'plan')!.status, outcome === 'completed' ? 'completed' : outcome === 'failed' ? 'blocked' : 'idle');
  assert.equal(nativeCalls, 0);
});

test('enable cannot bypass an unacknowledged or uncertain stop or change continuation metadata', async t => {
  const f = await fixture(t); await f.send('plan');
  await until(() => f.clients[0].calls.some(call => call.method === 'turn/start'));
  await f.engine.command({ type: 'stop', projectId: f.projectId });
  for (const uncertain of [false, true]) {
    if (uncertain) f.clients[0].options.onDisconnect('Stop acknowledgement lost');
    const before = structuredClone((await f.engine.command({ type: 'snapshot' })).snapshot.selected!);
    assert.equal(before.tasks[0].status, uncertain ? 'needs_reconciliation' : 'running');
    await assert.rejects(f.engine.command({ type: 'resume', projectId: f.projectId }), /本轮已请求停止/);
    await assert.rejects(f.engine.command({ type: 'resume_node', projectId: f.projectId, nodeId: 'plan' }), /本轮已请求停止/);
    const after = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!;
    assert.deepEqual(after.tasks, before.tasks);
    assert.deepEqual(after.nodes, before.nodes);
    assert.equal(f.clients[0].calls.filter(call => call.method === 'turn/start').length, 1);
  }
});

test('node and bulk enable cannot decide a business review or release its waiting input', async t => {
  const f = await reviewFixture(t); await f.policy(); await f.send('implement');
  await f.engine.command({ type: 'pause_node', projectId: f.projectId, nodeId: 'implement' });
  await f.engine.command({ type: 'resume_node', projectId: f.projectId, nodeId: 'implement' });
  await f.engine.command({ type: 'pause', projectId: f.projectId });
  await f.engine.command({ type: 'resume', projectId: f.projectId });
  assert.equal(f.state.tasks[0].status, 'waiting_review'); assert.equal(f.state.humanReviews.length, 0); assert.equal(f.turns().length, 0);
});

test('project pause resumes only active A, leaves idle B available, and a node enable overrides a project pause', async t => {
  const f = await collaborationFixture(t), a = await f.active('plan');
  await f.engine.command({ type: 'pause', projectId: f.projectId }); f.finish(a, 'interrupted');
  await f.engine.command({ type: 'resume', projectId: f.projectId });
  await until(() => a.status === 'running' && !!a.turnId);
  assert.equal(f.state.nodes.find(node => node.id === 'implement')!.status, 'idle');
  assert.equal(f.state.tasks.length, 1);
  await f.engine.command({ type: 'pause', projectId: f.projectId }); f.finish(a, 'interrupted');
  await f.engine.command({ type: 'resume_node', projectId: f.projectId, nodeId: 'plan' });
  await until(() => a.status === 'running' && !!a.turnId);
  const receipt = await f.invoke('plan', 'send_message', { request_id: 'paused-target', to_node_id: 'implement', content: 0, reason: '排队' }, 'paused-target');
  const b = f.state.tasks.find(task => task.id === receipt.target_task_id)!;
  assert.equal(b.status, 'queued');
  await f.engine.command({ type: 'pause_node', projectId: f.projectId, nodeId: 'plan' }); f.finish(a, 'interrupted');
  assert.equal(b.status, 'queued', 'stopping the source does not withdraw an accepted message');
  await f.engine.command({ type: 'resume_node', projectId: f.projectId, nodeId: 'implement' }); await until(() => !!b.turnId);
  assert.equal(f.state.nodes.find(node => node.id === 'plan')!.status, 'paused');
});

test('project stop cancels an accepted undelivered target while preserving the message receipt', async t => {
  const f = await collaborationFixture(t); await f.engine.command({ type: 'pause_node', projectId: f.projectId, nodeId: 'implement' });
  const a = await f.active('plan');
  const receipt = await f.invoke('plan', 'send_message', { request_id: 'stop-target', to_node_id: 'implement', content: '', reason: '排队' }, 'stop-target');
  await f.engine.command({ type: 'stop', projectId: f.projectId }); f.finish(a, 'interrupted');
  assert.equal(f.state.tasks.find(task => task.id === receipt.target_task_id)!.status, 'cancelled');
  assert.equal(f.state.messages[0].message_id, receipt.message_id); assert.equal(f.state.messages[0].target_task_id, receipt.target_task_id);
});

test('stop fences sends awaiting account and queued same-node admissions; later actions can start', async t => {
  const f = await fixture(t); await f.engine.command({ type: 'connect', projectId: f.projectId });
  const client = f.clients[0], original = client.port.rpc, entered = deferred(), gate = deferred();
  client.port.rpc = async (method, params) => { if (method === 'account/read') { entered.resolve(); await gate.promise; } return original(method, params); };
  const first = f.send('plan'), second = f.send('plan');
  const settled = Promise.allSettled([first, second]);
  await entered.promise;
  await f.engine.command({ type: 'stop', projectId: f.projectId }); gate.resolve();
  assert((await settled).every(result => result.status === 'rejected'), 'pre-stop admissions must be cancelled');
  assert.equal((await f.engine.command({ type: 'snapshot' })).snapshot.selected!.tasks.length, 0);
  await f.send('plan'); await until(() => client.calls.some(call => call.method === 'turn/start'));
});

test('close fences an account response before it can add a task', async t => {
  const f = await fixture(t); await f.engine.command({ type: 'connect', projectId: f.projectId });
  const client = f.clients[0], original = client.port.rpc, entered = deferred(), gate = deferred();
  client.port.rpc = async (method, params) => { if (method === 'account/read') { entered.resolve(); await gate.promise; } return original(method, params); };
  const send = f.send('plan'); const settled = Promise.allSettled([send]);
  await entered.promise; await f.engine.close(); gate.resolve();
  const [result] = await settled; assert.equal(result.status, 'rejected');
  if (result.status === 'rejected') assert.equal(result.reason.code, 'COMMAND_CANCELLED');
  assert.equal(client.calls.filter(call => call.method === 'turn/start').length, 0);
});

test('same-node admissions preserve FIFO even when account queries resolve out of order', async t => {
  const f = await fixture(t); await f.engine.command({ type: 'pause_node', projectId: f.projectId, nodeId: 'plan' });
  await f.engine.command({ type: 'connect', projectId: f.projectId });
  const client = f.clients[0], original = client.port.rpc, entered = deferred(), gate = deferred(); let accounts = 0;
  client.port.rpc = async (method, params) => { if (method === 'account/read' && ++accounts === 1) { entered.resolve(); await gate.promise; } return original(method, params); };
  const send = (text: string) => f.engine.command({ type: 'send_message', projectId: f.projectId, nodeId: 'plan', mode: 'codex', input: [{ type: 'text', text }] });
  const first = send('first'); await entered.promise; const second = send('second');
  try { await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(accounts, 1, 'later same-node admission waits its predecessor'); }
  finally { gate.resolve(); await Promise.all([first, second]); }
  const snapshot = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!;
  assert.deepEqual(snapshot.tasks.map(task => task.instruction), ['first', 'second']);
  assert.equal(snapshot.nodes[0].status, 'paused'); assert.equal(client.calls.filter(call => call.method === 'turn/start').length, 0);
});

test('stop cancels retry waiting on the original thread without creating a new attempt', async t => {
  const f = await fixture(t); await f.send('plan');
  await until(() => f.clients[0].calls.some(call => call.method === 'turn/start'));
  f.clients[0].options.onDisconnect('uncertain execution');
  await f.engine.command({ type: 'connect', projectId: f.projectId });
  const client = f.clients[1], original = client.port.rpc, entered = deferred(), gate = deferred();
  client.port.rpc = async (method, params) => { if (method === 'thread/read') { entered.resolve(); await gate.promise; } return original(method, params); };
  const taskId = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!.tasks[0].id;
  const retry = f.engine.command({ type: 'retry_task', projectId: f.projectId, taskId, confirmed: true });
  const settled = Promise.allSettled([retry]); await entered.promise;
  await f.engine.command({ type: 'stop', projectId: f.projectId }); gate.resolve();
  const [result] = await settled; assert.equal(result.status, 'rejected');
  if (result.status === 'rejected') assert.equal(result.reason.code, 'COMMAND_CANCELLED');
  assert.equal((await f.engine.command({ type: 'snapshot' })).snapshot.selected!.tasks.length, 1);
});

for (const controls of [['pause_node'], ['pause'], ['pause_node', 'resume_node', 'pause_node'], ['pause', 'resume_node']] as const) {
  test(`retry waiting on history preserves latest control: ${controls.join(' -> ')}`, async t => {
    const f = await fixture(t); await f.send('plan');
    const client = f.clients[0], rpc = client.port.rpc;
    await until(() => client.calls.some(call => call.method === 'turn/start'));
    const task = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!.tasks[0];
    client.options.onEvent({ method: 'turn/completed', params: { threadId: task.threadId, turn: { id: task.turnId, status: 'failed' } } });
    const entered = deferred(), gate = deferred();
    client.port.rpc = async (method, params) => { if (method === 'thread/read') { entered.resolve(); await gate.promise; } return rpc(method, params); };
    const retry = f.engine.command({ type: 'retry_task', projectId: f.projectId, taskId: task.id, confirmed: true });
    try {
      await entered.promise;
      for (const type of controls) await f.engine.command(type === 'pause' ? { type, projectId: f.projectId } : { type, projectId: f.projectId, nodeId: 'plan' });
    } finally { gate.resolve(); await retry; }
    if (controls.at(-1) !== 'resume_node') {
      const snapshot = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!;
      assert.equal(snapshot.nodes[0].status, 'paused'); assert.equal(snapshot.tasks[1].status, 'queued');
      assert.equal(client.calls.filter(call => call.method === 'turn/start').length, 1);
      await f.engine.command({ type: 'resume_node', projectId: f.projectId, nodeId: 'plan' });
    }
    await until(() => client.calls.filter(call => call.method === 'turn/start').length === 2);
    const snapshot = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!;
    assert.equal(snapshot.tasks.length, 2); assert.equal(snapshot.tasks[1].attempt, 2);
    assert.equal(snapshot.tasks[1].threadId, task.threadId); assert.equal(snapshot.nodes[0].status, 'running');
    assert.equal(client.calls.filter(call => call.method === 'turn/start').length, 2);
  });
}

test('stop returns while native interrupt is still awaiting its acknowledgement', async t => {
  const f = await fixture(t); await f.send('plan');
  await until(() => f.clients[0].calls.some(call => call.method === 'turn/start'));
  const client = f.clients[0], original = client.port.rpc, gate = deferred(); let entered = false;
  client.port.rpc = async (method, params) => { if (method === 'turn/interrupt') { entered = true; await gate.promise; } return original(method, params); };
  try {
    const reply = await f.engine.command({ type: 'stop', projectId: f.projectId });
    assert(entered); assert.equal(reply.snapshot.selected!.nodes[0].status, 'pausing');
  } finally { gate.resolve(); }
});

test('acknowledged user stop marks unfinished work cancelled rather than failed', async t => {
  const f = await fixture(t); await f.send('plan');
  await until(() => f.clients[0].calls.some(call => call.method === 'turn/start'));
  const task = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!.tasks[0];
  await f.engine.command({ type: 'stop', projectId: f.projectId });
  f.clients[0].options.onEvent({ method: 'turn/completed', params: { threadId: task.threadId, turn: { id: task.turnId, status: 'interrupted' } } });
  const snapshot = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!;
  assert.equal(snapshot.tasks[0].status, 'cancelled'); assert.equal(snapshot.nodes[0].status, 'idle');
});

test('send rechecks current node definition after account wait instead of dispatching a replaced object', async t => {
  const f = await fixture(t); await f.engine.command({ type: 'connect', projectId: f.projectId });
  const client = f.clients[0], original = client.port.rpc, entered = deferred(), gate = deferred();
  client.port.rpc = async (method, params) => { if (method === 'account/read') { entered.resolve(); await gate.promise; } return original(method, params); };
  const send = f.send('plan'); await entered.promise;
  const node = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!.nodes[0];
  await f.engine.command({ type: 'save_node', projectId: f.projectId, node: { ...node, name: 'current name', instructions: 'current instructions', model: 'current model' } });
  gate.resolve(); await send;
  await until(() => client.calls.some(call => call.method === 'turn/start'));
  const session = client.calls.find(call => call.method === 'thread/start')!.params;
  assert.equal(session.model, 'current model'); assert.match(session.developerInstructions, /current instructions/);
  assert.equal((await f.engine.command({ type: 'snapshot' })).snapshot.selected!.nodes[0].status, 'running');
});

class ControlledCodex implements CodexPort {
  calls: { method: string; params: any }[] = [];
  beforeThread?: () => Promise<void>;
  beforeTurnResponse?: () => Promise<void>;
  constructor(readonly options: NativeClientOptions) {}
  async connect() {}
  async close() {}
  async rpc(method: string, params: any): Promise<any> {
    this.calls.push({ method, params });
    if (method === 'account/read') return { account: { type: 'chatgpt', email: 'pause@example.invalid' } };
    if (method === 'windowsSandbox/readiness') return { status: 'ready' };
    if (method === 'thread/start') { await this.beforeThread?.(); return { thread: { id: randomUUID() } }; }
    if (method === 'thread/resume' || method === 'thread/read') return { thread: { id: params.threadId, status: { type: 'idle' } } };
    if (method === 'turn/start') {
      const turn = { id: randomUUID(), status: 'inProgress' };
      this.options.onEvent({ method: 'turn/started', params: { threadId: params.threadId, turn } });
      await this.beforeTurnResponse?.();
      return { turn };
    }
    return {};
  }
  finish(threadId: string, turnId: string, status = 'completed') {
    this.options.onEvent({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status } } });
  }
}
async function pauseUntil(check: () => Promise<boolean>) {
  for (let i = 0; i < 150; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 10)); }
  assert.fail('Pause state did not settle');
}
async function pauseFixture() {
  const base = projectDirectory(process.cwd(), '.runtime', 'implementation', 'pause-tests');
  const root = mkdtempSync(join(base, 'case-')), project = projectDirectory(root, 'project');
  let native!: ControlledCodex;
  const engine = new WorkflowEngine({ workbenchRoot: root, executable: 'pauseFixture', accountFactory: accountFixture().factory, nativeFactory: options => native = new ControlledCodex(options) });
  await engine.init();
  const projectId = (await engine.command({ type: 'create_project', root: project, name: '暂停覆盖验证', goal: '精确控制节点执行' })).snapshot.selected!.project.id;
  await engine.command({ type: 'connect', projectId });
  const snapshot = async () => (await engine.command({ type: 'snapshot', projectId })).snapshot.selected!;
  const send = (nodeId: string, value = '只执行一次原始请求') => engine.command({ type: 'send_message', projectId, nodeId, mode: 'codex', input: [{ type: 'text', text: value, text_elements: [] }] });
  const active = async (nodeId: string) => {
    await pauseUntil(async () => (await snapshot()).tasks.some(t => t.nodeId === nodeId && t.status === 'running' && !!t.turnId));
    return (await snapshot()).tasks.find(t => t.nodeId === nodeId && t.status === 'running')!;
  };
  const status = async (nodeId: string) => (await snapshot()).nodes.find(n => n.id === nodeId)!.status;
  return { engine, root, projectId, native, snapshot, send, active, status };
}

test('global and node controls overwrite one state and never start an originally idle node', async t => {
  const f = await pauseFixture(); t.after(() => f.engine.close());
  await f.send('plan'); await f.send('implement');
  const a = await f.active('plan'), b = await f.active('implement');
  await f.engine.command({ type: 'pause', projectId: f.projectId });
  assert.deepEqual(new Set((await f.snapshot()).resumeNodeIds), new Set(['plan', 'implement']));
  assert.equal(await f.status('plan'), 'pausing'); assert.equal(await f.status('implement'), 'pausing');
  await f.engine.command({ type: 'resume_node', projectId: f.projectId, nodeId: 'plan' });
  assert.equal(await f.status('plan'), 'resuming'); assert.equal(await f.status('implement'), 'pausing');
  assert.equal(f.native.calls.filter(c => c.method === 'turn/start').length, 2);
  await f.engine.command({ type: 'pause_node', projectId: f.projectId, nodeId: 'plan' });
  assert.equal(await f.status('plan'), 'pausing');
  f.native.finish(a.threadId!, a.turnId!, 'interrupted'); f.native.finish(b.threadId!, b.turnId!, 'interrupted');
  assert.equal(await f.status('plan'), 'paused'); assert.equal(await f.status('implement'), 'paused');
  await f.engine.command({ type: 'resume', projectId: f.projectId });
  const nextA = await f.active('plan'), nextB = await f.active('implement');
  assert.equal(nextA.threadId, a.threadId); assert.equal(nextB.threadId, b.threadId);
  assert.notEqual(nextA.turnId, a.turnId); assert.equal(await f.status('review'), 'idle');
  assert.equal(f.native.calls.filter(c => c.method === 'turn/start').length, 4);
  f.native.finish(a.threadId!, a.turnId!);
  assert.equal((await f.active('plan')).turnId, nextA.turnId, 'late old completion cannot finish the resumed turn');
  await f.engine.command({ type: 'pause_node', projectId: f.projectId, nodeId: 'plan' });
  await f.engine.command({ type: 'resume', projectId: f.projectId });
  assert.equal(await f.status('plan'), 'resuming', 'global enable overrides a later individual pause within the recorded batch');
});

test('global resume leaves previously queued work paused while idle nodes can receive future handoffs', async t => {
  const f = await pauseFixture(); t.after(() => f.engine.close());
  await f.send('plan'); const a = await f.active('plan');
  await f.engine.command({ type: 'pause_node', projectId: f.projectId, nodeId: 'implement' });
  await f.send('implement', '已经排队但尚未执行');
  await f.engine.command({ type: 'pause', projectId: f.projectId });
  f.native.finish(a.threadId!, a.turnId!, 'interrupted');
  await f.engine.command({ type: 'resume', projectId: f.projectId });
  const resumed = await f.active('plan');
  assert.equal(await f.status('implement'), 'paused'); assert.equal(await f.status('review'), 'idle');
  assert.equal(f.native.calls.filter(c => c.method === 'turn/start').length, 2);
  await f.engine.invokeTool('handoff', { to_node_id: 'review', task: '新的交接', reason: '继续流程', result: '成果' }, { identity: f.engine.nodeIdentity(f.projectId, 'plan'), threadId: resumed.threadId!, turnId: resumed.turnId!, callId: randomUUID() });
  f.native.finish(resumed.threadId!, resumed.turnId!);
  await f.active('review');
  assert.equal(await f.status('implement'), 'paused');
  await f.engine.command({ type: 'resume_node', projectId: f.projectId, nodeId: 'implement' });
  await f.active('implement');
});

test('pause during session startup never dispatches a turn until that node is enabled', async t => {
  const f = await pauseFixture(); t.after(() => f.engine.close());
  let release!: () => void, entered = false;
  f.native.beforeThread = () => { entered = true; return new Promise<void>(resolve => { release = resolve; }); };
  await f.send('plan'); await pauseUntil(async () => entered);
  await f.engine.command({ type: 'pause', projectId: f.projectId }); release();
  await pauseUntil(async () => await f.status('plan') === 'paused');
  assert.equal(f.native.calls.filter(c => c.method === 'turn/start').length, 0);
  assert.deepEqual((await f.snapshot()).resumeNodeIds, ['plan']);
  f.native.beforeThread = undefined;
  await f.engine.command({ type: 'resume_node', projectId: f.projectId, nodeId: 'plan' });
  await f.active('plan'); assert.equal(f.native.calls.filter(c => c.method === 'turn/start').length, 1);
});

test('normal completion wins a pause race and global enable does not replay completed work', async t => {
  const f = await pauseFixture(); t.after(() => f.engine.close());
  await f.send('plan'); const a = await f.active('plan');
  await f.engine.command({ type: 'pause', projectId: f.projectId });
  f.native.finish(a.threadId!, a.turnId!);
  assert.equal((await f.snapshot()).tasks[0].status, 'completed');
  await f.engine.command({ type: 'resume', projectId: f.projectId });
  assert.equal(f.native.calls.filter(c => c.method === 'turn/start').length, 1);
  assert.equal(await f.status('plan'), 'completed'); assert.equal(await f.status('review'), 'idle');
});

test('paused native turns retain their original input history and resume without resending that input', async t => {
  const f = await pauseFixture(); t.after(() => f.engine.close());
  await f.send('plan', '原始请求不应重新派发'); const a = await f.active('plan');
  const original = (await f.snapshot()).conversation!.find(e => e.direction === 'input' && e.taskId === a.id)!;
  await f.engine.command({ type: 'pause_node', projectId: f.projectId, nodeId: 'plan' });
  f.native.finish(a.threadId!, a.turnId!, 'interrupted');
  await f.engine.command({ type: 'resume_node', projectId: f.projectId, nodeId: 'plan' });
  const resumed = await f.active('plan');
  const history = (await f.snapshot()).conversation!;
  assert.equal(history.find(e => e.id === original.id)!.turnId, a.turnId);
  assert.equal(history.find(e => e.id === original.id)!.text, original.text);
  assert.equal(history.find(e => e.id === original.id)!.status, 'paused');
  assert.ok(history.some(e => e.direction === 'input' && e.taskId === a.id && e.turnId === resumed.turnId && e.id !== original.id));
  const input = f.native.calls.filter(c => c.method === 'turn/start').at(-1)!.params.input;
  assert.ok(!input.some((i: any) => i.type === 'text' && i.text === '原始请求不应重新派发'));
  const firstContinuation = history.find(e => e.direction === 'input' && e.turnId === resumed.turnId)!;
  await f.engine.command({ type: 'pause_node', projectId: f.projectId, nodeId: 'plan' });
  f.native.finish(resumed.threadId!, resumed.turnId!, 'interrupted');
  await f.engine.command({ type: 'resume_node', projectId: f.projectId, nodeId: 'plan' }); await f.active('plan');
  const later = (await f.snapshot()).conversation!;
  assert.equal(later.find(e => e.id === original.id)!.status, 'paused');
  assert.equal(later.find(e => e.id === firstContinuation.id)!.status, 'paused');
});

test('confirmed pauses survive restart and repeated global pause retains recovery targets', async t => {
  const f = await pauseFixture();
  await f.send('plan'); const a = await f.active('plan');
  await f.engine.command({ type: 'pause', projectId: f.projectId }); f.native.finish(a.threadId!, a.turnId!, 'interrupted');
  await f.engine.command({ type: 'pause', projectId: f.projectId });
  assert.deepEqual((await f.snapshot()).resumeNodeIds, ['plan']); await f.engine.close();
  let native!: ControlledCodex;
  const restored = new WorkflowEngine({ workbenchRoot: f.root, executable: 'pauseFixture', accountFactory: accountFixture().factory, nativeFactory: options => native = new ControlledCodex(options) });
  await restored.init(); t.after(() => restored.close());
  let s = (await restored.command({ type: 'snapshot', projectId: f.projectId })).snapshot.selected!;
  assert.equal(s.nodes.find(n => n.id === 'plan')!.status, 'paused'); assert.deepEqual(s.resumeNodeIds, ['plan']); assert.equal(Boolean(native), false);
  await restored.command({ type: 'resume', projectId: f.projectId });
  await pauseUntil(async () => (await restored.command({ type: 'snapshot' })).snapshot.selected!.tasks.some(t => t.status === 'running' && !!t.turnId));
  s = (await restored.command({ type: 'snapshot' })).snapshot.selected!;
  assert.equal(s.tasks[0].threadId, a.threadId); assert.notEqual(s.tasks[0].turnId, a.turnId);
  assert.equal(native.calls.filter(c => c.method === 'turn/start').length, 1);
});

test('enable before interrupt acknowledgement waits for the old turn response before continuing', async t => {
  const f = await pauseFixture(); t.after(() => f.engine.close());
  let release!: () => void;
  f.native.beforeTurnResponse = () => new Promise<void>(resolve => { release = resolve; });
  await f.send('plan'); const a = await f.active('plan');
  await f.engine.command({ type: 'pause_node', projectId: f.projectId, nodeId: 'plan' });
  await f.engine.command({ type: 'resume_node', projectId: f.projectId, nodeId: 'plan' });
  assert.equal(await f.status('plan'), 'resuming'); assert.equal(f.native.calls.filter(c => c.method === 'turn/start').length, 1);
  f.native.finish(a.threadId!, a.turnId!, 'interrupted');
  assert.equal(f.native.calls.filter(c => c.method === 'turn/start').length, 1);
  f.native.beforeTurnResponse = undefined; release();
  await pauseUntil(async () => (await f.snapshot()).tasks.some(task => task.status === 'running' && !!task.turnId && task.turnId !== a.turnId));
  assert.equal(f.native.calls.filter(c => c.method === 'turn/start').length, 2);
});

test('accepted handoff survives pause and is released only once after successful continuation', async t => {
  const f = await pauseFixture(); t.after(() => f.engine.close());
  await f.send('plan'); const a = await f.active('plan');
  await f.engine.invokeTool('handoff', { to_node_id: 'implement', task: '接收已提交成果', reason: '来源收尾后处理', result: '保留这份成果' }, { identity: f.engine.nodeIdentity(f.projectId, 'plan'), threadId: a.threadId!, turnId: a.turnId!, callId: randomUUID() });
  await f.engine.command({ type: 'pause_node', projectId: f.projectId, nodeId: 'plan' });
  f.native.finish(a.threadId!, a.turnId!, 'interrupted');
  assert.equal((await f.snapshot()).tasks[1].status, 'waiting_source');
  await f.engine.command({ type: 'resume_node', projectId: f.projectId, nodeId: 'plan' }); const resumed = await f.active('plan');
  assert.equal((await f.snapshot()).handoffs.length, 1);
  assert.match(f.native.calls.filter(c => c.method === 'turn/start').at(-1)!.params.input[0].text, /已受理.*收尾/);
  f.native.finish(resumed.threadId!, resumed.turnId!); await f.active('implement');
  const count = f.native.calls.filter(c => c.method === 'turn/start').length;
  f.native.finish(a.threadId!, a.turnId!); f.native.finish(resumed.threadId!, resumed.turnId!);
  assert.equal((await f.snapshot()).handoffs.length, 1); assert.equal((await f.snapshot()).tasks.length, 2);
  assert.equal(f.native.calls.filter(c => c.method === 'turn/start').length, count);
});

test('unknown interruption stays blocked and is never replayed by either enable control', async t => {
  const f = await pauseFixture(); t.after(() => f.engine.close());
  await f.send('plan'); const a = await f.active('plan');
  const rpc = f.native.rpc.bind(f.native);
  f.native.rpc = async (method, params) => { if (method === 'turn/interrupt') throw Object.assign(new Error('unknown interruption'), { outcome: 'unknown' }); return rpc(method, params); };
  await f.engine.command({ type: 'pause', projectId: f.projectId });
  await pauseUntil(async () => await f.status('plan') === 'blocked');
  await f.engine.command({ type: 'resume', projectId: f.projectId });
  await f.engine.command({ type: 'resume_node', projectId: f.projectId, nodeId: 'plan' });
  assert.equal(await f.status('plan'), 'blocked'); assert.equal((await f.snapshot()).tasks[0].status, 'needs_reconciliation');
  assert.equal(f.native.calls.filter(c => c.method === 'turn/start').length, 1);
  f.native.finish(a.threadId!, a.turnId!, 'interrupted');
  assert.equal(f.native.calls.filter(c => c.method === 'turn/start').length, 1);
});
