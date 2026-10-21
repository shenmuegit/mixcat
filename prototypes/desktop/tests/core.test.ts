import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import type { CodexPort, NativeClientOptions, McpCallContext } from '../src/shared/types.js';
import { WorkflowEngine } from '../src/core/engine.js';

class FakeCodex implements CodexPort {
  turn = 0; thread = 0; lastThread = ''; lastTurn = '';
  calls: { method: string; params: any }[] = [];
  responses: { id: string | number; result: unknown }[] = [];
  constructor(readonly options: NativeClientOptions) {}
  async connect() {}
  async close() {}
  respond(id: string | number, result: unknown) { this.responses.push({ id, result }); }
  async rpc(method: string, p: any): Promise<any> {
    this.calls.push({ method, params: p });
    if (method === 'account/read') return { account: { type: 'chatgpt', email: 'fixture@example.invalid' } };
    if (method === 'thread/start') return { thread: { id: `thread-${++this.thread}` } };
    if (method === 'thread/resume' || method === 'thread/read') return { thread: { id: p.threadId, status: { type: 'idle' } } };
    if (method === 'turn/start') {
      this.lastThread = p.threadId; this.lastTurn = `turn-${++this.turn}`;
      this.options.onEvent({ method: 'turn/started', params: { threadId: p.threadId, turn: { id: this.lastTurn, status: 'inProgress' } } });
      return { turn: { id: this.lastTurn, status: 'inProgress' } };
    }
    return {};
  }
  finish(status = 'completed', threadId = this.lastThread, turnId = this.lastTurn) { this.options.onEvent({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status } } }); }
}
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 10)); }
  assert.fail('State did not settle');
}
async function fixture(startNode = 'implement') {
  const base = resolve('.runtime/tests'); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(resolve(base, 'core-')); const projectRoot = resolve(root, 'project'); mkdirSync(projectRoot);
  let native!: FakeCodex;
  const engine = new WorkflowEngine({ workbenchRoot: root, executable: 'fixture', nativeFactory: o => native = new FakeCodex(o) });
  await engine.init();
  const created = await engine.command({ type: 'create_project', root: projectRoot, name: '工作流验收', goal: '形成经过审查的清单' });
  const projectId = created.snapshot.selected!.project.id;
  const nodes = created.snapshot.selected!.nodes;
  const writer = nodes.find(n => n.id === startNode)!; const reviewer = nodes.find(n => n.id === 'review')!;
  await engine.command({ type: 'start', projectId, nodeId: writer.id, instruction: '写出清单', mode: 'codex' });
  const snapshot = async () => (await engine.command({ type: 'snapshot', projectId })).snapshot.selected!;
  await until(async () => !!(await snapshot()).tasks.find(t => t.status === 'running')?.turnId);
  const context = (): McpCallContext => ({ identity: engine.nodeIdentity(projectId, writer.id), threadId: native.lastThread, turnId: native.lastTurn, callId: 'call-1' });
  return { engine, root, projectId, writer, reviewer, snapshot, context, native };
}
test('handoff waits for source completion and duplicate calls create only one task', async t => {
  const f = await fixture(); t.after(() => f.engine.close());
  const args = { to_node_id: f.reviewer.id, task: '审查清单', reason: '需要独立检查', result: { summary: '清单第一版' } };
  const first = await f.engine.invokeTool('handoff', args, f.context());
  const second = await f.engine.invokeTool('handoff', args, f.context());
  assert.deepEqual(second, first);
  let s = await f.snapshot(); assert.equal(s.handoffs.length, 1); assert.equal(s.tasks.filter(x => x.status === 'waiting_source').length, 1); assert.equal(f.native.turn, 1);
  f.native.finish();
  await until(async () => f.native.turn === 2);
  s = await f.snapshot(); assert.equal(s.handoffs[0].status, 'delivered'); assert.equal(s.tasks.filter(x => x.status === 'running').length, 1);
});

test('native sessions restore project write and request-based approval when starting or resuming legacy threads', async t => {
  const f = await fixture(); t.after(() => f.engine.close());
  const check = (method: string) => {
    const params = f.native.calls.findLast(call => call.method === method)!.params;
    const config = params.config.mcp_servers.mixcat;
    assert.equal(params.approvalPolicy, 'on-request'); assert.equal(params.sandbox, 'workspace-write'); assert.equal(params.cwd, resolve(f.root, 'project'));
    assert.equal(config.default_tools_approval_mode, 'prompt');
    assert.deepEqual(Object.keys(config.tools), f.writer.tools);
    for (const tool of f.writer.tools) assert.equal(config.tools[tool].approval_mode, 'approve');
    assert.equal(config.tools.update_workflow, undefined); assert.equal(config.tools.complete_task, undefined);
  };
  check('thread/start');
  f.native.finish('failed');
  await f.engine.command({ type: 'retry_task', projectId: f.projectId, taskId: (await f.snapshot()).tasks[0].id, confirmed: true });
  await until(async () => f.native.turn === 2); check('thread/resume');
});
test('forged thread cannot change workflow state while result content remains unrestricted', async t => {
  const f = await fixture(); t.after(() => f.engine.close());
  const args = { to_node_id: f.reviewer.id, task: '审查', reason: '检查', result: { wrong: true } };
  await assert.rejects(f.engine.invokeTool('handoff', { ...args, result: { summary: '结果' } }, { ...f.context(), threadId: 'forged' }), /身份|会话|执行/);
  await assert.rejects(f.engine.invokeTool('complete_task', { result: { summary: '我直接通过' } }, f.context()), /权限|工具/);
  assert.equal((await f.snapshot()).handoffs.length, 0);
  await f.engine.invokeTool('handoff', args, f.context()); assert.deepEqual((await f.snapshot()).handoffs[0].result, { wrong: true });
});
test('failed source keeps its accepted handoff from starting', async t => {
  const f = await fixture(); t.after(() => f.engine.close());
  await f.engine.invokeTool('handoff', { to_node_id: f.reviewer.id, task: '审查', reason: '检查', result: { summary: '未确认成果' } }, f.context());
  f.native.finish('failed');
  await until(async () => (await f.snapshot()).project.status === 'blocked');
  assert.equal(f.native.turn, 1); assert.equal((await f.snapshot()).handoffs[0].status, 'needs_reconciliation');
});
test('restart marks active execution uncertain without automatic redispatch', async () => {
  const f = await fixture(); await f.engine.close();
  let starts = 0;
  const resumed = new WorkflowEngine({ workbenchRoot: f.root, executable: 'fixture', nativeFactory: o => { starts++; return new FakeCodex(o); } });
  await resumed.init();
  try { const s = (await resumed.command({ type: 'snapshot', projectId: f.projectId })).snapshot.selected!; assert.equal(s.project.status, 'blocked'); assert.ok(s.tasks.some(t => t.status === 'needs_reconciliation')); assert.equal(starts, 0); }
  finally { await resumed.close(); }
});

test('real MCP rehearsal completes an independent review and feedback cycle', async t => {
  const base = resolve('.runtime/tests'); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(resolve(base, 'rehearsal-'));
  const engine = new WorkflowEngine({ workbenchRoot: root, executable: 'unused' });
  await engine.init(); t.after(() => engine.close());
  const project = (await engine.command({ type: 'create_demo' })).snapshot.selected!;
  await engine.command({ type: 'start', projectId: project.project.id, nodeId: 'plan', mode: 'demo', instruction: '制定发布清单，必须包含回滚方案' });
  let state = (await engine.command({ type: 'snapshot', projectId: project.project.id })).snapshot.selected!;
  for (let i = 0; i < 150 && state.project.status === 'running'; i++) { await new Promise(r => setTimeout(r, 100)); state = (await engine.command({ type: 'snapshot' })).snapshot.selected!; }
  assert.equal(state.project.status, 'completed', state.activities.at(-1)?.text);
  assert.equal(state.tasks.length, 5); assert.equal(state.handoffs.length, 4);
  assert.ok(state.handoffs.some(h => h.fromNodeId === 'review' && h.toNodeId === 'implement'));
  assert.equal((state.tasks.at(-1)?.result as any).verdict, 'approved');
});

test('Agent workflow updates use the same revision check as human edits', async t => {
  const f = await fixture('plan'); t.after(() => f.engine.close());
  const before: any = await f.engine.invokeTool('get_project_context', {}, f.context());
  const old = before.nodes.find((n: any) => n.id === 'review'); assert.equal(old.revision, 1);
  await f.engine.command({ type: 'save_node', projectId: f.projectId, node: { ...old, name: '用户刚修改的审查节点' } });
  await assert.rejects(f.engine.invokeTool('update_workflow', { node: { ...old, name: '过期的 Agent 内容' } }, f.context()), /更新|重新读取/);
  assert.equal((await f.snapshot()).nodes.find(n => n.id === 'review')!.name, '用户刚修改的审查节点');
});

test('moving active and pending nodes preserves configuration, tasks and MCP identity', async t => {
  const f = await fixture(); t.after(() => f.engine.close());
  const context = f.context();
  const before = await f.snapshot();
  const writer = before.nodes.find(n => n.id === f.writer.id)!;
  const position = { x: 123, y: 456 };
  await f.engine.command({ type: 'move_node', projectId: f.projectId, nodeId: writer.id, position });
  let after = await f.snapshot();
  assert.deepEqual(after.nodes.find(n => n.id === writer.id), { ...writer, position });
  assert.deepEqual(after.tasks, before.tasks);
  assert.equal(f.engine.nodeIdentity(f.projectId, writer.id).token, context.identity.token);
  await f.engine.invokeTool('get_project_context', {}, context);
  await assert.rejects(f.engine.command({ type: 'save_node', projectId: f.projectId, node: { ...writer, name: '运行时修改' } }), /活动或待处理/);
  await f.engine.invokeTool('handoff', { to_node_id: 'review', task: '审查', reason: '检查', result: { summary: '结果' } }, context);
  const pending = (await f.snapshot()).tasks;
  assert.equal(pending.at(-1)!.status, 'waiting_source');
  await f.engine.command({ type: 'move_node', projectId: f.projectId, nodeId: 'review', position });
  after = await f.snapshot(); assert.deepEqual(after.tasks, pending);
  assert.equal(after.nodes.find(n => n.id === 'review')!.revision, f.reviewer.revision);
  await assert.rejects(f.engine.command({ type: 'save_node', projectId: f.projectId, node: { ...f.reviewer, name: '待执行修改' } }), /活动或待处理/);
  f.native.finish(); await until(async () => f.native.turn === 2);
  const secondRunning = await f.snapshot();
  assert.equal(secondRunning.handoffs[0].status, 'delivered');
  assert.equal(secondRunning.tasks[0].status, 'completed'); assert.equal(secondRunning.tasks[1].status, 'running');
  const reviewerContext: McpCallContext = { identity: f.engine.nodeIdentity(f.projectId, 'review'), threadId: f.native.lastThread, turnId: f.native.lastTurn, callId: 'review-call' };
  for (const nodeId of [writer.id, 'review']) await f.engine.command({ type: 'move_node', projectId: f.projectId, nodeId, position: { x: 500, y: 300 } });
  await f.engine.command({ type: 'save_node', projectId: f.projectId, node: { ...writer, name: '首节点完成后修改' } });
  await assert.rejects(f.engine.command({ type: 'save_node', projectId: f.projectId, node: { ...f.reviewer, name: '次节点仍在执行' } }), /活动或待处理/);
  assert.deepEqual((await f.snapshot()).tasks, secondRunning.tasks);
  await f.engine.invokeTool('get_project_context', {}, reviewerContext);
  await f.engine.invokeTool('complete_task', { result: { summary: '验证通过', verdict: 'approved' } }, reviewerContext);
  f.native.finish();
  assert.equal((await f.snapshot()).project.status, 'completed');
});

test('moving a node validates coordinates and persists without changing its definition revision', async t => {
  const f = await fixture(); t.after(() => f.engine.close());
  const before = await f.snapshot();
  for (const position of [null, {}, { x: NaN, y: 0 }, { x: 0, y: Infinity }, { x: 100000, y: 0 }, { x: '1', y: 0 }]) {
    await assert.rejects(f.engine.command({ type: 'move_node', projectId: f.projectId, nodeId: 'implement', position } as any), /位置/);
  }
  await assert.rejects(f.engine.command({ type: 'move_node', projectId: f.projectId, nodeId: 'missing', position: { x: 0, y: 0 } }), /节点/);
  assert.deepEqual(await f.snapshot(), before);
  const position = { x: -250.5, y: 600 };
  await f.engine.command({ type: 'move_node', projectId: f.projectId, nodeId: 'implement', position });
  await f.engine.close();
  const restored = new WorkflowEngine({ workbenchRoot: f.root, executable: 'fixture' });
  await restored.init(); t.after(() => restored.close());
  const s = (await restored.command({ type: 'snapshot', projectId: f.projectId })).snapshot.selected!;
  assert.deepEqual(s.nodes.find(n => n.id === 'implement')!.position, position);
  assert.equal(s.nodes.find(n => n.id === 'implement')!.revision, f.writer.revision);
  assert.equal(s.tasks[0].status, 'needs_reconciliation');
  await restored.command({ type: 'move_node', projectId: f.projectId, nodeId: 'implement', position: { x: 0, y: 0 } });
  assert.equal((await restored.command({ type: 'snapshot' })).snapshot.selected!.tasks[0].status, 'needs_reconciliation');
});

test('an Agent configuration update preserves a layout moved since it read the node', async t => {
  const f = await fixture('plan'); t.after(() => f.engine.close());
  const context: any = await f.engine.invokeTool('get_project_context', {}, f.context());
  const old = context.nodes.find((n: any) => n.id === 'review');
  const position = { x: 432, y: 321 };
  await f.engine.command({ type: 'move_node', projectId: f.projectId, nodeId: old.id, position });
  await f.engine.invokeTool('update_workflow', { node: { ...old, instructions: '补充独立验证步骤' } }, f.context());
  const updated = (await f.snapshot()).nodes.find(n => n.id === old.id)!;
  assert.deepEqual(updated.position, position);
  assert.equal(updated.instructions, '补充独立验证步骤'); assert.equal(updated.revision, old.revision + 1);
});

test('copied project data cannot retain the original execution root', async t => {
  const f = await fixture(); await f.engine.close();
  const copy = resolve(f.root, 'copied'); mkdirSync(copy); cpSync(resolve(f.root, 'project/.mixcat'), resolve(copy, '.mixcat'), { recursive: true });
  const engine = new WorkflowEngine({ workbenchRoot: f.root, executable: 'fixture' }); await engine.init(); t.after(() => engine.close());
  await assert.rejects(engine.command({ type: 'create_project', root: copy, name: '复制项目', goal: '检查路径' }), /原始目录|搬迁/);
});

test('retry cancels the unstarted recipient and pause/resume remains possible', async t => {
  const f = await fixture(); t.after(() => f.engine.close());
  const source = (await f.snapshot()).tasks[0];
  await f.engine.invokeTool('handoff', { to_node_id: 'review', task: '审查', reason: '检查', result: { summary: '结果' } }, f.context());
  f.native.finish('failed');
  await f.engine.command({ type: 'retry_task', projectId: f.projectId, taskId: source.id, confirmed: true });
  await until(async () => f.native.turn === 2);
  assert.ok((await f.snapshot()).tasks.some(t => t.nodeId === 'review' && t.status === 'cancelled'));
  await f.engine.command({ type: 'pause', projectId: f.projectId });
  await f.engine.command({ type: 'resume', projectId: f.projectId });
  assert.equal((await f.snapshot()).project.status, 'running');
});

test('loop limit can be stopped and followed by a fresh run', async t => {
  const f = await fixture(); t.after(() => f.engine.close());
  for (let step = 0; step < 12; step++) {
    const active = (await f.snapshot()).tasks.find(t => t.status === 'running')!;
    await f.engine.invokeTool('handoff', { to_node_id: active.nodeId === 'implement' ? 'review' : 'implement', task: '继续检查', reason: '循环边界测试', result: { summary: '需要继续', verdict: 'changes_requested' } }, { identity: f.engine.nodeIdentity(f.projectId, active.nodeId), threadId: f.native.lastThread, turnId: f.native.lastTurn, callId: `loop-${step}` });
    f.native.finish();
    if (step < 11) await until(async () => f.native.turn === step + 2);
  }
  await until(async () => (await f.snapshot()).project.status === 'blocked');
  await f.engine.command({ type: 'stop', projectId: f.projectId });
  assert.ok((await f.snapshot()).tasks.some(t => t.status === 'cancelled'));
  await f.engine.command({ type: 'start', projectId: f.projectId, nodeId: 'implement', instruction: '新的运行', mode: 'codex' });
  await until(async () => f.native.turn === 13);
});

test('a historical failure cannot start a second turn while its node is already active', async t => {
  const f = await fixture(); t.after(() => f.engine.close()); const old = (await f.snapshot()).tasks[0];
  f.native.finish('failed');
  await f.engine.command({ type: 'start', projectId: f.projectId, nodeId: 'implement', instruction: '新任务', mode: 'codex' });
  await assert.rejects(f.engine.command({ type: 'retry_task', projectId: f.projectId, taskId: old.id, confirmed: true }), /正在运行/);
});

test('stop during thread creation cancels the task before any turn can start', async t => {
  const base = resolve('.runtime/tests'); const root = mkdtempSync(resolve(base, 'stop-race-')); const projectRoot = resolve(root, 'project'); mkdirSync(projectRoot);
  let release!: () => void, entered = false, native!: FakeCodex;
  const gate = new Promise<void>(resolve => release = resolve);
  const engine = new WorkflowEngine({ workbenchRoot: root, executable: 'fixture', nativeFactory: options => {
    native = new FakeCodex(options); const rpc = native.rpc.bind(native);
    native.rpc = async (method, params) => { if (method === 'thread/start') { entered = true; await gate; } return rpc(method, params); }; return native;
  } });
  await engine.init(); t.after(() => engine.close());
  const id = (await engine.command({ type: 'create_project', name: '停止边界', root: projectRoot, goal: '核对停止意图' })).snapshot.selected!.project.id;
  await engine.command({ type: 'start', projectId: id, nodeId: 'implement', mode: 'codex', instruction: '不能在停止后启动' });
  await until(async () => entered); await engine.command({ type: 'stop', projectId: id });
  await assert.rejects(engine.command({ type: 'resume', projectId: id }), /停止/); release();
  await until(async () => (await engine.command({ type: 'snapshot' })).snapshot.selected!.tasks[0].status === 'cancelled');
  assert.equal(native.turn, 0); assert.equal((await engine.command({ type: 'snapshot' })).snapshot.selected!.project.status, 'idle');
});

test('normal source completion after stop keeps its recipient cancelled and project idle', async t => {
  const f = await fixture(); t.after(() => f.engine.close());
  await f.engine.invokeTool('handoff', { to_node_id: 'review', task: '审查', reason: '检查', result: { summary: '结果' } }, f.context());
  await f.engine.command({ type: 'stop', projectId: f.projectId });
  f.native.finish();
  const s = await f.snapshot(); assert.equal(s.project.status, 'idle'); assert.equal(f.native.turn, 1); assert.equal(s.tasks[1].status, 'cancelled'); assert.match(s.activities.at(-1)!.text, /取消/);
});

async function accountFixture(t: import('node:test').TestContext, failures: number, message = 'workspace routing discovery timed out') {
  const base = resolve('.runtime/tests'); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(resolve(base, 'account-')); const projectRoot = resolve(root, 'project'); mkdirSync(projectRoot);
  const scenario = { failures, message, reads: 0 };
  const engine = new WorkflowEngine({ workbenchRoot: root, executable: 'fixture', nativeFactory: options => {
    const native = new FakeCodex(options); const rpc = native.rpc.bind(native);
    native.rpc = async (method, params) => { if (method === 'account/read') { scenario.reads++; if (scenario.failures-- > 0) throw Object.assign(new Error(scenario.message), { code: -32603 }); } return rpc(method, params); }; return native;
  } });
  await engine.init(); t.after(() => engine.close());
  const id = (await engine.command({ type: 'create_project', root: projectRoot, name: '账号恢复检查', goal: '账户查询失败不影响任务记录' })).snapshot.selected!.project.id;
  return { engine, id, scenario };
}

test('account routing timeout retries once on the same connection without starting a task', async t => {
  const { engine, id, scenario } = await accountFixture(t, 1);
  const reply = await engine.command({ type: 'connect', projectId: id });
  assert.equal(scenario.reads, 2); assert.equal(reply.snapshot.runtime!.connected, true); assert.equal(reply.snapshot.runtime!.authenticated, true); assert.equal(reply.snapshot.runtime!.error, null); assert.equal(reply.snapshot.selected!.tasks.length, 0);
});

test('persistent routing timeout stays connected and manual retry clears the account error', async t => {
  const { engine, id, scenario } = await accountFixture(t, 2);
  await assert.rejects(engine.command({ type: 'connect', projectId: id }), /工作区路由.*超时/);
  const failed = (await engine.command({ type: 'snapshot' })).snapshot;
  assert.equal(scenario.reads, 2); assert.equal(failed.runtime!.connected, true); assert.equal(failed.runtime!.authenticated, false); assert.match(failed.runtime!.error!, /重试连接/); assert.equal(failed.selected!.tasks.length, 0);
  const recovered = await engine.command({ type: 'connect', projectId: id });
  assert.equal(scenario.reads, 3); assert.equal(recovered.snapshot.runtime!.error, null); assert.equal(recovered.snapshot.runtime!.authenticated, true);
});

test('account errors other than the explicit discovery timeout are not retried', async t => {
  const { engine, id, scenario } = await accountFixture(t, 5, 'account permission denied');
  await assert.rejects(engine.command({ type: 'connect', projectId: id }), /account permission denied/);
  const s = (await engine.command({ type: 'snapshot' })).snapshot;
  assert.equal(scenario.reads, 1); assert.equal(s.runtime!.connected, true); assert.match(s.runtime!.error!, /account permission denied/);
});

test('login account lookup failure does not turn a running task into a transport failure', async t => {
  const f = await fixture(); t.after(() => f.engine.close());
  const rpc = f.native.rpc.bind(f.native); let reads = 0;
  f.native.rpc = async (method, params) => { if (method === 'account/read') { reads++; throw Object.assign(new Error('workspace routing discovery timed out'), { code: -32603 }); } return rpc(method, params); };
  f.native.options.onEvent({ method: 'account/login/completed', params: { success: true } });
  await until(async () => !!(await f.engine.command({ type: 'snapshot' })).snapshot.runtime?.error);
  const s = (await f.engine.command({ type: 'snapshot' })).snapshot;
  assert.equal(reads, 2); assert.equal(s.runtime!.connected, true); assert.equal(s.runtime!.authenticated, true); assert.equal(s.selected!.project.status, 'running'); assert.equal(s.selected!.tasks[0].status, 'running');
});

test('free messages retain exact native content, complete without MCP and serialize only their own node', async t => {
  const f = await fixture(); t.after(() => f.engine.close());
  const first = (await f.snapshot()).tasks[0];
  const input = [{ type: 'text', text: '  原样保留\n无需 JSON 输出  ', text_elements: [] }, { type: 'image', url: 'https://example.invalid/reference.png' }];
  await f.engine.command({ type: 'send_message', projectId: f.projectId, nodeId: 'implement', mode: 'codex', input });
  await f.engine.command({ type: 'send_message', projectId: f.projectId, nodeId: 'review', mode: 'codex', input: [{ type: 'text', text: '独立聊天' }] });
  await until(async () => f.native.turn === 2);
  let state = await f.snapshot();
  assert.equal(state.tasks.filter(task => task.status === 'running').length, 2);
  assert.equal(state.tasks[1].status, 'queued');
  f.native.finish('completed', first.threadId!, first.turnId!);
  await until(async () => f.native.turn === 3);
  state = await f.snapshot();
  const queued = state.tasks[1]; assert.equal(queued.status, 'running'); assert.equal(queued.threadId, first.threadId);
  assert.deepEqual(f.native.calls.findLast(call => call.method === 'turn/start')!.params.input, input);
  f.native.options.onEvent({ method: 'item/completed', params: { threadId: queued.threadId, turnId: queued.turnId, item: { id: 'free-answer', type: 'agentMessage', text: '普通文本已经足够。' } } });
  f.native.finish('completed', queued.threadId!, queued.turnId!);
  const other = (await f.snapshot()).tasks[2]; f.native.finish('completed', other.threadId!, other.turnId!);
  state = await f.snapshot(); assert.equal(state.project.status, 'completed'); assert.ok(state.tasks.every(task => task.status === 'completed'));
  assert.equal(state.tasks[1].result, '普通文本已经足够。');
  assert.deepEqual(state.conversation!.find(entry => entry.taskId === queued.id && entry.direction === 'input')!.content, input);
});

test('free conversation handoffs preserve every result field and are not capped by legacy workflow steps', async t => {
  const f = await fixture(); t.after(() => f.engine.close()); f.native.finish();
  await f.engine.command({ type: 'send_message', projectId: f.projectId, nodeId: 'implement', mode: 'codex', input: [{ type: 'text', text: '自由协作' }] });
  await until(async () => f.native.turn === 2);
  const result = { summary: '简短摘要', requirements: ['不可省略的原始要求'], evidence: { exact: '完整输入' } };
  for (let step = 0; step < 13; step++) {
    const active = (await f.snapshot()).tasks.find(task => task.status === 'running')!;
    await f.engine.invokeTool('handoff', { to_node_id: active.nodeId === 'implement' ? 'review' : 'implement', task: '继续', reason: '验证自由协作', result }, { identity: f.engine.nodeIdentity(f.projectId, active.nodeId), threadId: active.threadId!, turnId: active.turnId!, callId: `free-${step}` });
    f.native.finish(); await until(async () => f.native.turn === step + 3);
  }
  assert.equal((await f.snapshot()).project.status, 'running');
  const input = f.native.calls.findLast(call => call.method === 'turn/start')!.params.input;
  assert.match(input[0].text, /不可省略的原始要求/); assert.match(input[0].text, /完整输入/);
});

test('sending while paused queues input without resuming existing work', async t => {
  const f = await fixture(); t.after(() => f.engine.close());
  await f.engine.command({ type: 'pause', projectId: f.projectId });
  await f.engine.command({ type: 'send_message', projectId: f.projectId, nodeId: 'review', mode: 'codex', input: [{ type: 'text', text: '稍后继续' }] });
  f.native.finish();
  const paused = await f.snapshot(); assert.equal(paused.project.status, 'paused'); assert.equal(paused.tasks[1].status, 'queued'); assert.equal(f.native.turn, 1);
  await f.engine.command({ type: 'resume', projectId: f.projectId });
  assert.equal(f.native.turn, 1); assert.equal((await f.snapshot()).nodes.find(node => node.id === 'review')!.status, 'paused');
  await f.engine.command({ type: 'resume_node', projectId: f.projectId, nodeId: 'review' }); await until(async () => f.native.turn === 2);
});

test('selected model and native skills/plugins reach the actual thread and turn while cwd stays in project', async t => {
  const f = await fixture(); t.after(() => f.engine.close()); f.native.finish();
  const node = (await f.snapshot()).nodes.find(node => node.id === 'implement')!;
  const skill = { name: 'project-skill', path: resolve(f.root, 'project/SKILL.md') };
  const plugin = { id: 'plugin@fixture', name: 'Fixture Plugin' };
  const rpc = f.native.rpc.bind(f.native);
  f.native.rpc = async (method, params) => method === 'plugin/installed' ? { marketplaces: [{ plugins: [{ ...plugin, installed: true, enabled: true }] }] } : rpc(method, params);
  await f.engine.command({ type: 'save_node', projectId: f.projectId, node: { ...node, model: 'fixture-model', skills: [skill], plugins: [plugin] } });
  await f.engine.command({ type: 'send_message', projectId: f.projectId, nodeId: node.id, mode: 'codex', input: [{ type: 'text', text: '按我的要求回答' }] });
  await until(async () => f.native.turn === 2);
  const session = f.native.calls.findLast(call => call.method === 'thread/resume')!.params;
  assert.equal(session.model, 'fixture-model'); assert.equal(session.cwd, resolve(f.root, 'project'));
  const turn = f.native.calls.findLast(call => call.method === 'turn/start')!.params;
  assert.deepEqual(turn.input, [{ type: 'text', text: '按我的要求回答' }, { type: 'skill', ...skill }, { type: 'mention', name: plugin.name, path: `plugin://${plugin.id}` }]);
});

test('Windows sessions initialize only an unconfigured sandbox and record the actual returned policy', async t => {
  if (process.platform !== 'win32') return t.skip('Windows native sandbox initialization');
  const f = await fixture(); t.after(() => f.engine.close()); f.native.finish();
  let readiness = 'notConfigured'; const rpc = f.native.rpc.bind(f.native);
  f.native.rpc = async (method, params) => {
    if (method === 'windowsSandbox/readiness') return { status: readiness };
    const result = await rpc(method, params);
    if (method === 'thread/resume') return { ...result, sandbox: { type: readiness === 'notConfigured' ? 'workspaceWrite' : 'readOnly' }, approvalPolicy: 'on-request', cwd: params.cwd };
    return result;
  };
  const send = () => f.engine.command({ type: 'send_message', projectId: f.projectId, nodeId: 'implement', mode: 'codex', input: [{ type: 'text', text: '继续当前会话' }] });
  await send(); await until(async () => f.native.turn === 2);
  assert.equal(f.native.calls.findLast(call => call.method === 'thread/resume')!.params.config['windows.sandbox'], 'unelevated');
  assert.ok((await f.snapshot()).conversation!.some(entry => (entry.content as any)?.sandbox?.type === 'workspaceWrite'));
  f.native.finish(); readiness = 'ready'; await send(); await until(async () => f.native.turn === 3);
  assert.equal(f.native.calls.findLast(call => call.method === 'thread/resume')!.params.config['windows.sandbox'], undefined);
  const policy = (await f.snapshot()).conversation!.findLast(entry => (entry.content as any)?.type === 'sessionConfiguration')!;
  assert.equal((policy.content as any).sandbox.type, 'readOnly'); assert.match(policy.text, /仍为只读/);
});

test('related node and editable conditions are saved atomically and remain separate from handoff history', async t => {
  const f = await fixture(); t.after(() => f.engine.close());
  const original = (await f.snapshot()).nodes.find(node => node.id === 'review')!;
  await assert.rejects(f.engine.command({ type: 'save_node', projectId: f.projectId, node: { ...original, id: 'child', revision: 0 }, relatedTo: 'missing', condition: '需要复审' }), /关联/);
  assert.equal((await f.snapshot()).nodes.some(node => node.id === 'child'), false);
  await f.engine.command({ type: 'save_node', projectId: f.projectId, node: { ...original, id: 'child', revision: 0 }, relatedTo: 'review', condition: '需要复审' });
  let state = await f.snapshot(); assert.equal(state.edges!.length, 1); assert.equal(state.handoffs.length, 0);
  const edge = state.edges![0]; assert.equal(edge.sourceNodeId, 'review'); assert.equal(edge.targetNodeId, 'child');
  await f.engine.command({ type: 'save_edge', projectId: f.projectId, edge: { ...edge, condition: '检查未通过时' } });
  await assert.rejects(f.engine.command({ type: 'save_edge', projectId: f.projectId, edge: { ...edge, condition: '过期内容' } }), /更新/);
  await f.engine.close();
  const resumed = new WorkflowEngine({ workbenchRoot: f.root, executable: 'fixture' }); await resumed.init(); t.after(() => resumed.close());
  state = (await resumed.command({ type: 'snapshot', projectId: f.projectId })).snapshot.selected!;
  assert.equal(state.edges![0].condition, '检查未通过时'); assert.ok(state.nodes.some(node => node.id === 'child'));
  await resumed.command({ type: 'delete_edge', projectId: f.projectId, edgeId: edge.id }); assert.equal((await resumed.command({ type: 'snapshot' })).snapshot.selected!.edges!.length, 0);
});

test('native request remains pending for UI response and disconnect invalidates every active node', async t => {
  const f = await fixture(); t.after(() => f.engine.close());
  await f.engine.command({ type: 'send_message', projectId: f.projectId, nodeId: 'review', mode: 'codex', input: [{ type: 'text', text: '检查另一个部分' }] });
  await until(async () => f.native.turn === 2);
  const task = (await f.snapshot()).tasks[0];
  const before = Math.floor(Date.now() / 1000);
  f.native.options.onRequest!({ id: 'time-1', method: 'currentTime/read', params: { threadId: task.threadId } });
  assert.equal((await f.snapshot()).requests!.length, 0);
  assert.ok((f.native.responses[0].result as any).currentTimeAt >= before); f.native.responses = [];
  f.native.options.onRequest!({ id: 'approve-1', method: 'item/commandExecution/requestApproval', params: { threadId: task.threadId, turnId: task.turnId, command: 'example' } });
  const request = (await f.snapshot()).requests![0]; assert.equal(request.nodeId, task.nodeId); assert.equal(f.native.responses.length, 0);
  await f.engine.command({ type: 'respond_native', projectId: f.projectId, requestKey: request.key, result: { decision: 'accept' } });
  assert.deepEqual(f.native.responses, [{ id: 'approve-1', result: { decision: 'accept' } }]); assert.equal((await f.snapshot()).requests!.length, 0);
  await assert.rejects(f.engine.command({ type: 'respond_native', projectId: f.projectId, requestKey: request.key, result: {} }), /结束|断开/);
  f.native.options.onDisconnect('fixture disconnected');
  assert.ok((await f.snapshot()).tasks.every(task => task.status === 'needs_reconciliation'));
});

test('duplicate native completion cannot redispatch an accepted handoff', async t => {
  const f = await fixture(); t.after(() => f.engine.close());
  const source = (await f.snapshot()).tasks[0];
  await f.engine.invokeTool('handoff', { to_node_id: 'review', task: '检查', reason: '反馈', result: '自由文本' }, f.context());
  f.native.finish(); await until(async () => f.native.turn === 2);
  f.native.finish('completed', source.threadId!, source.turnId!);
  await new Promise(resolve => setTimeout(resolve, 50));
  const state = await f.snapshot(); assert.equal(f.native.turn, 2); assert.equal(state.tasks[1].status, 'running');
});

test('history includes native tool completion, incoming node identity and paginated items without duplicates', async t => {
  const f = await fixture(); t.after(() => f.engine.close());
  const source = (await f.snapshot()).tasks[0];
  const base = { threadId: source.threadId, turnId: source.turnId };
  f.native.options.onEvent({ method: 'item/started', params: { ...base, item: { id: 'tool-1', type: 'mcpToolCall', server: 'mixcat', tool: 'get_project_context', status: 'inProgress' } } });
  f.native.options.onEvent({ method: 'item/completed', params: { ...base, item: { id: 'tool-1', type: 'mcpToolCall', server: 'mixcat', tool: 'get_project_context', status: 'completed', result: { content: [{ type: 'text', text: 'context' }] } } } });
  f.native.options.onEvent({ method: 'item/completed', params: { ...base, item: { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'native prompt' }] } } });
  await f.engine.invokeTool('handoff', { to_node_id: 'review', task: '帮我看一下', reason: '需要反馈', result: ['自由', '数组'] }, f.context());
  const rpc = f.native.rpc.bind(f.native); let pages = 0;
  f.native.rpc = async (method, params) => {
    if (method !== 'thread/items/list') return rpc(method, params);
    pages++;
    return { data: Array.from({ length: params.cursor ? 101 : 250 }, (_, i) => ({ turnId: source.turnId, item: { id: `history-${i + (params.cursor ? 250 : 0)}`, type: 'agentMessage', text: `message-${i}` }, startedAtMs: 1000 + i, completedAtMs: 2000 + i })), nextCursor: params.cursor ? null : 'page-2' };
  };
  await f.engine.command({ type: 'read_history', projectId: f.projectId, nodeId: 'implement' });
  await f.engine.command({ type: 'read_history', projectId: f.projectId, nodeId: 'implement' });
  const state = await f.snapshot(); assert.equal(pages, 4);
  assert.equal(state.conversation!.filter(entry => entry.itemId?.startsWith('history-')).length, 351);
  assert.equal(state.conversation!.filter(entry => entry.taskId === source.id && entry.direction === 'input').length, 1);
  const incoming = state.conversation!.find(entry => entry.nodeId === 'review' && entry.direction === 'input')!;
  assert.equal(incoming.source!.kind, 'node'); assert.equal(incoming.source!.nodeId, 'implement'); assert.match(incoming.text, /自由/);
  const tool = state.conversation!.find(entry => entry.itemId === 'tool-1')!; assert.equal(tool.status, 'completed'); assert.ok(tool.completedAt); assert.ok((tool.content as any).result);
});

test('history loading cannot overwrite live completion or newer streaming output', async t => {
  const f = await fixture(); t.after(() => f.engine.close());
  const task = (await f.snapshot()).tasks[0], base = { threadId: task.threadId, turnId: task.turnId };
  f.native.options.onEvent({ method: 'item/started', params: { ...base, item: { id: 'racing-tool', type: 'mcpToolCall', tool: 'lookup', status: 'inProgress' } } });
  f.native.options.onEvent({ method: 'item/agentMessage/delta', params: { ...base, itemId: 'racing-message', delta: 'before' } });
  let release!: () => void, entered = false; const gate = new Promise<void>(resolve => release = resolve);
  const rpc = f.native.rpc.bind(f.native);
  f.native.rpc = async (method, params) => {
    if (method !== 'thread/items/list') return rpc(method, params);
    entered = true; await gate;
    return { data: [
      { turnId: task.turnId, item: { id: 'racing-tool', type: 'mcpToolCall', tool: 'lookup', status: 'inProgress' }, startedAtMs: 1000, completedAtMs: null },
      { turnId: task.turnId, item: { id: 'racing-message', type: 'agentMessage', text: 'stale' }, startedAtMs: 1000, completedAtMs: null },
    ], nextCursor: null };
  };
  const reading = f.engine.command({ type: 'read_history', projectId: f.projectId, nodeId: 'implement' });
  await until(async () => entered);
  f.native.options.onEvent({ method: 'item/completed', params: { ...base, item: { id: 'racing-tool', type: 'mcpToolCall', tool: 'lookup', status: 'completed', result: 'fresh-result' } } });
  f.native.options.onEvent({ method: 'item/agentMessage/delta', params: { ...base, itemId: 'racing-message', delta: '-live' } });
  release(); await reading;
  const history = (await f.snapshot()).conversation!;
  const tool = history.find(entry => entry.itemId === 'racing-tool')!;
  assert.equal(tool.status, 'completed'); assert.equal((tool.content as any).result, 'fresh-result');
  assert.equal(history.find(entry => entry.itemId === 'racing-message')!.text, 'before-live');
  await f.engine.command({ type: 'read_history', projectId: f.projectId, nodeId: 'implement' });
  assert.equal((await f.snapshot()).conversation!.find(entry => entry.itemId === 'racing-tool')!.status, 'completed');
});

test('new messages after stop cannot revive the old turn or its delayed handoff', async t => {
  const f = await fixture(); t.after(() => f.engine.close());
  const old = (await f.snapshot()).tasks[0], oldContext = f.context();
  await f.engine.command({ type: 'stop', projectId: f.projectId });
  await f.engine.command({ type: 'send_message', projectId: f.projectId, nodeId: 'review', mode: 'codex', input: [{ type: 'text', text: '这是新的独立消息' }] });
  await until(async () => f.native.turn === 2);
  await assert.rejects(f.engine.invokeTool('handoff', { to_node_id: 'review', task: '过期交接', reason: '旧任务迟到', result: '不应投递' }, oldContext), /停止/);
  const before = f.native.calls.filter(call => call.method === 'turn/interrupt').length;
  f.native.options.onEvent({ method: 'turn/started', params: { threadId: old.threadId, turn: { id: old.turnId, status: 'inProgress' } } });
  assert.equal(f.native.calls.filter(call => call.method === 'turn/interrupt').length, before + 1);
  f.native.finish('completed', old.threadId!, old.turnId!);
  const state = await f.snapshot(); assert.equal(state.handoffs.length, 0); assert.equal(state.tasks[1].status, 'running'); assert.equal(state.project.status, 'running');
});

test('schema v1 migration preserves native threads and original histories once', async t => {
  const f = await fixture(), originalThread = f.native.lastThread;
  f.native.options.onEvent({ method: 'item/completed', params: { threadId: f.native.lastThread, turnId: f.native.lastTurn, item: { id: 'old-answer', type: 'agentMessage', text: '已有回复' } } });
  const payload = { type: 'brief', text: '简短文本', summary: '摘要', requirements: ['不能省略的要求'] };
  await f.engine.invokeTool('handoff', { to_node_id: 'review', task: '保留完整内容检查', reason: '历史保真', result: payload }, f.context());
  f.native.finish(); await until(async () => f.native.turn === 2); f.native.finish();
  const source = (await f.snapshot()).nodes.find(node => node.id === 'implement')!;
  await f.engine.command({ type: 'save_node', projectId: f.projectId, node: { ...source, name: '重命名后的执行节点' } });
  await f.engine.close();
  const database = new DatabaseSync(resolve(f.root, 'project/.mixcat/state/workflow.sqlite'));
  const state = JSON.parse(String(database.prepare('SELECT body FROM project_state').get()!.body));
  delete state.conversation; delete state.edges;
  database.prepare('UPDATE project_state SET schema_version=1, body=?').run(JSON.stringify(state)); database.close();
  const resumed = new WorkflowEngine({ workbenchRoot: f.root, executable: 'fixture' }); await resumed.init(); t.after(() => resumed.close());
  const snapshot = (await resumed.command({ type: 'snapshot', projectId: f.projectId })).snapshot.selected!;
  assert.equal(snapshot.nodes.find(node => node.id === 'implement')!.threadId, originalThread);
  assert.equal(snapshot.conversation!.length, 3); assert.equal(snapshot.conversation!.find(entry => entry.itemId === 'old-answer')!.text, '已有回复'); assert.equal(snapshot.handoffs.length, 1);
  const incoming = snapshot.conversation!.find(entry => entry.nodeId === 'review' && entry.direction === 'input')!;
  assert.equal(incoming.text, `保留完整内容检查\n\n${JSON.stringify(payload, null, 2)}`); assert.equal(incoming.source!.name, f.writer.name);
  const verify = new DatabaseSync(resolve(f.root, 'project/.mixcat/state/workflow.sqlite')); assert.equal(verify.prepare('SELECT schema_version FROM project_state').get()!.schema_version, 2); verify.close();
});
