import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { WorkflowEngine } from '../src/core/engine.js';
import { projectDirectory } from '../src/core/paths.js';
import type { CodexPort, NativeClientOptions } from '../src/shared/types.js';

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
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 150; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 10)); }
  assert.fail('Pause state did not settle');
}
async function fixture() {
  const base = projectDirectory(process.cwd(), '.runtime', 'pause-tests');
  const root = mkdtempSync(join(base, 'case-')), project = projectDirectory(root, 'project');
  let native!: ControlledCodex;
  const engine = new WorkflowEngine({ workbenchRoot: root, executable: 'fixture', nativeFactory: options => native = new ControlledCodex(options) });
  await engine.init();
  const projectId = (await engine.command({ type: 'create_project', root: project, name: '暂停覆盖验证', goal: '精确控制节点执行' })).snapshot.selected!.project.id;
  await engine.command({ type: 'connect', projectId });
  const snapshot = async () => (await engine.command({ type: 'snapshot', projectId })).snapshot.selected!;
  const send = (nodeId: string, value = '只执行一次原始请求') => engine.command({ type: 'send_message', projectId, nodeId, mode: 'codex', input: [{ type: 'text', text: value, text_elements: [] }] });
  const active = async (nodeId: string) => {
    await until(async () => (await snapshot()).tasks.some(t => t.nodeId === nodeId && t.status === 'running' && !!t.turnId));
    return (await snapshot()).tasks.find(t => t.nodeId === nodeId && t.status === 'running')!;
  };
  const status = async (nodeId: string) => (await snapshot()).nodes.find(n => n.id === nodeId)!.status;
  return { engine, root, projectId, native, snapshot, send, active, status };
}

test('global and node controls overwrite one state and never start an originally idle node', async t => {
  const f = await fixture(); t.after(() => f.engine.close());
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
  const f = await fixture(); t.after(() => f.engine.close());
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
  const f = await fixture(); t.after(() => f.engine.close());
  let release!: () => void, entered = false;
  f.native.beforeThread = () => { entered = true; return new Promise<void>(resolve => { release = resolve; }); };
  await f.send('plan'); await until(async () => entered);
  await f.engine.command({ type: 'pause', projectId: f.projectId }); release();
  await until(async () => await f.status('plan') === 'paused');
  assert.equal(f.native.calls.filter(c => c.method === 'turn/start').length, 0);
  assert.deepEqual((await f.snapshot()).resumeNodeIds, ['plan']);
  f.native.beforeThread = undefined;
  await f.engine.command({ type: 'resume_node', projectId: f.projectId, nodeId: 'plan' });
  await f.active('plan'); assert.equal(f.native.calls.filter(c => c.method === 'turn/start').length, 1);
});

test('normal completion wins a pause race and global enable does not replay completed work', async t => {
  const f = await fixture(); t.after(() => f.engine.close());
  await f.send('plan'); const a = await f.active('plan');
  await f.engine.command({ type: 'pause', projectId: f.projectId });
  f.native.finish(a.threadId!, a.turnId!);
  assert.equal((await f.snapshot()).tasks[0].status, 'completed');
  await f.engine.command({ type: 'resume', projectId: f.projectId });
  assert.equal(f.native.calls.filter(c => c.method === 'turn/start').length, 1);
  assert.equal(await f.status('plan'), 'completed'); assert.equal(await f.status('review'), 'idle');
});

test('paused native turns retain their original input history and resume without resending that input', async t => {
  const f = await fixture(); t.after(() => f.engine.close());
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
  const f = await fixture();
  await f.send('plan'); const a = await f.active('plan');
  await f.engine.command({ type: 'pause', projectId: f.projectId }); f.native.finish(a.threadId!, a.turnId!, 'interrupted');
  await f.engine.command({ type: 'pause', projectId: f.projectId });
  assert.deepEqual((await f.snapshot()).resumeNodeIds, ['plan']); await f.engine.close();
  let native!: ControlledCodex;
  const restored = new WorkflowEngine({ workbenchRoot: f.root, executable: 'fixture', nativeFactory: options => native = new ControlledCodex(options) });
  await restored.init(); t.after(() => restored.close());
  let s = (await restored.command({ type: 'snapshot', projectId: f.projectId })).snapshot.selected!;
  assert.equal(s.nodes.find(n => n.id === 'plan')!.status, 'paused'); assert.deepEqual(s.resumeNodeIds, ['plan']); assert.equal(Boolean(native), false);
  await restored.command({ type: 'resume', projectId: f.projectId });
  await until(async () => (await restored.command({ type: 'snapshot' })).snapshot.selected!.tasks.some(t => t.status === 'running' && !!t.turnId));
  s = (await restored.command({ type: 'snapshot' })).snapshot.selected!;
  assert.equal(s.tasks[0].threadId, a.threadId); assert.notEqual(s.tasks[0].turnId, a.turnId);
  assert.equal(native.calls.filter(c => c.method === 'turn/start').length, 1);
});

test('enable before interrupt acknowledgement waits for the old turn response before continuing', async t => {
  const f = await fixture(); t.after(() => f.engine.close());
  let release!: () => void;
  f.native.beforeTurnResponse = () => new Promise<void>(resolve => { release = resolve; });
  await f.send('plan'); const a = await f.active('plan');
  await f.engine.command({ type: 'pause_node', projectId: f.projectId, nodeId: 'plan' });
  await f.engine.command({ type: 'resume_node', projectId: f.projectId, nodeId: 'plan' });
  assert.equal(await f.status('plan'), 'resuming'); assert.equal(f.native.calls.filter(c => c.method === 'turn/start').length, 1);
  f.native.finish(a.threadId!, a.turnId!, 'interrupted');
  assert.equal(f.native.calls.filter(c => c.method === 'turn/start').length, 1);
  f.native.beforeTurnResponse = undefined; release();
  await until(async () => (await f.snapshot()).tasks.some(task => task.status === 'running' && !!task.turnId && task.turnId !== a.turnId));
  assert.equal(f.native.calls.filter(c => c.method === 'turn/start').length, 2);
});

test('accepted handoff survives pause and is released only once after successful continuation', async t => {
  const f = await fixture(); t.after(() => f.engine.close());
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
  const f = await fixture(); t.after(() => f.engine.close());
  await f.send('plan'); const a = await f.active('plan');
  const rpc = f.native.rpc.bind(f.native);
  f.native.rpc = async (method, params) => { if (method === 'turn/interrupt') throw Object.assign(new Error('unknown interruption'), { outcome: 'unknown' }); return rpc(method, params); };
  await f.engine.command({ type: 'pause', projectId: f.projectId });
  await until(async () => await f.status('plan') === 'blocked');
  await f.engine.command({ type: 'resume', projectId: f.projectId });
  await f.engine.command({ type: 'resume_node', projectId: f.projectId, nodeId: 'plan' });
  assert.equal(await f.status('plan'), 'blocked'); assert.equal((await f.snapshot()).tasks[0].status, 'needs_reconciliation');
  assert.equal(f.native.calls.filter(c => c.method === 'turn/start').length, 1);
  f.native.finish(a.threadId!, a.turnId!, 'interrupted');
  assert.equal(f.native.calls.filter(c => c.method === 'turn/start').length, 1);
});
