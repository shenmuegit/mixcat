import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { cpSync, existsSync, mkdtempSync, unlinkSync } from 'node:fs';
import { WorkflowEngine } from '../src/core/engine.js';
import { ProjectStore } from '../src/core/store.js';
import { projectDirectory } from '../src/core/paths.js';
import { deferred, fixture, until } from './runtime-fixture.js';
import { collaborationFixture } from './collaboration-fixture.js';
import { accountFixture } from './account-fixture.js';

async function savedMessage(t: Parameters<typeof fixture>[0]) {
  const f = await collaborationFixture(t); await f.engine.command({ type: 'pause_node', projectId: f.projectId, nodeId: 'implement' });
  const source = await f.active('plan'), context = f.context('plan', 'lost-receipt');
  const request = { request_id: 'lost-receipt', to_node_id: 'implement', content: [' 原样 ', null, false, 0], reason: '重启后继续' };
  const receipt = await f.invoke('plan', 'send_message', request, 'lost-receipt'); f.finish(source);
  // Simulate exit after durable acceptance but before the allowed target is dispatched.
  f.state.nodes.find(node => node.id === 'implement')!.status = 'queued'; f.store.save(f.state);
  await f.engine.close();
  return { ...f, context, request, receipt };
}

test('account loss before native dispatch keeps an accepted message queued instead of recording execution failure', async t => {
  const f = await savedMessage(t), account = accountFixture(); let projectReads = 0, starts = 0;
  const restored = new WorkflowEngine({ workbenchRoot: f.root, executable: 'fixture', accountFactory: account.factory, nativeFactory: () => ({
    async connect() {}, async close() {}, async rpc(method) {
      if (method === 'account/read') { projectReads++; return { account: null }; }
      if (method === 'thread/start' || method === 'turn/start') starts++;
      return {};
    },
  }) });
  t.after(() => restored.close()); await restored.init(); await restored.restoreAccount();
  await until(() => projectReads > 0);
  const state = (restored as any).states.get(f.projectId);
  await until(() => state.tasks.at(-1).status !== 'running');
  assert.equal(state.tasks.at(-1).status, 'queued'); assert.equal(state.tasks.at(-1).error, null); assert.equal(starts, 0);
});

test('a queued record with a previous native Turn is reconciled instead of automatically replayed', async t => {
  const f = await savedMessage(t), store = new ProjectStore(f.root);
  try {
    const state = store.read()!, task = state.tasks.at(-1)!;
    task.threadId = 'uncertain-thread'; task.turnId = 'uncertain-turn'; store.save(state);
  } finally { store.close(); }
  const restored = new WorkflowEngine({ workbenchRoot: f.root, executable: 'fixture', accountFactory: accountFixture().factory, nativeFactory() { assert.fail('unknown Turn must never replay'); } });
  t.after(() => restored.close()); await restored.init(); await restored.restoreAccount();
  const snapshot = (await restored.command({ type: 'snapshot', projectId: f.projectId })).snapshot.selected!;
  assert.equal(snapshot.tasks.at(-1)!.status, 'needs_reconciliation');
  assert.equal(snapshot.nodes.find(node => node.id === 'implement')!.status, 'blocked');
});

for (const login of ['saved', 'notification', 'connect'] as const) test(`undispatched accepted messages recover only after ${login} account readiness, preserving replay and unknown-task barriers`, async t => {
  const f = await savedMessage(t), account = accountFixture();
  if (login !== 'saved') unlinkSync(join(f.root, '.runtime/client/account/auth.json'));
  const calls: { method: string; params: any }[] = []; let sequence = 0;
  const restored = new WorkflowEngine({ workbenchRoot: f.root, executable: 'fixture', accountFactory: account.factory, nativeFactory: options => ({
    async connect() {}, async close() {}, async rpc(method, params) {
      calls.push({ method, params });
      if (method === 'account/read') return { account: { email: 'fixture' } };
      if (method === 'thread/start') return { thread: { id: 'restored-thread' } };
      if (method === 'turn/start') return { turn: { id: `restored-turn-${++sequence}` } };
      return {};
    },
  }) });
  t.after(() => restored.close()); await restored.init();
  const state = (restored as any).states.get(f.projectId);
  assert.equal(state.nodes.find((node: any) => node.id === 'implement').status, 'queued');
  assert.equal(state.tasks.find((task: any) => task.id === f.receipt.target_task_id).status, 'queued');
  assert.equal(calls.length, 0);
  if (login === 'saved') await restored.restoreAccount();
  else {
    await restored.restoreAccount(); assert.equal(calls.length, 0); assert.equal(account.calls.length, 0);
    await (restored as any).pump(f.projectId);
    assert.equal(calls.length, 0); assert.equal(state.tasks.at(-1).status, 'queued');
    if (login === 'notification') {
      account.authenticated = false; await restored.command({ type: 'login' });
      assert.equal(calls.length, 0); account.authenticated = true;
      account.options.onEvent({ method: 'account/login/completed', params: { success: true } });
    } else await restored.command({ type: 'connect_account' });
  }
  await until(() => calls.some(call => call.method === 'turn/start'));
  assert.equal(state.tasks.at(-1).incomingMessageId, f.receipt.message_id);
  assert.equal(account.calls.filter(call => call.method === 'account/login/start').length, login === 'notification' ? 1 : 0);
  const identity = restored.nodeIdentity(f.projectId, 'plan');
  const replay = await restored.invokeTool('send_message', f.request, { ...f.context, identity });
  assert.deepEqual(replay, f.receipt); assert.equal(state.tasks.length, 2);
  const original = state.tasks.at(-1); original.status = 'needs_reconciliation';
  state.tasks.push({ ...structuredClone(original), id: 'later', status: 'queued', turnId: null, threadId: null });
  await (restored as any).pump(f.projectId);
  assert.equal(calls.filter(call => call.method === 'turn/start').length, 1, 'unknown execution prevents replay and blocks the same-node FIFO');
});

test('close shares one pending result, fences admission, late history and MCP', async t => {
  const f = await fixture(t); await f.send('plan');
  const owner = f.engine as any, state = owner.states.get(f.projectId);
  await until(() => !!state.tasks[0].turnId);
  const gate = deferred(), history = deferred(), original = f.clients[0].port.rpc;
  f.clients[0].port.rpc = async (method, params) => {
    if (method === 'thread/items/list') { await history.promise; return { data: [{ turnId: state.tasks[0].turnId, item: { id: 'late', type: 'agentMessage', text: 'must not import' } }] }; }
    return original(method, params);
  };
  const read = f.engine.command({ type: 'read_history', projectId: f.projectId, nodeId: 'plan' });
  await new Promise(r => setImmediate(r));
  let closes = 0; f.clients[0].port.close = async () => { closes++; await gate.promise; };
  const identity = f.engine.nodeIdentity(f.projectId, 'plan'), task = state.tasks[0];
  const first = f.engine.close(), second = f.engine.close();
  const identical = first === second;
  try {
    await assert.rejects(f.send('implement'), /关闭|取消|不可用/);
    await assert.rejects(owner.invokeTool('get_project_context', {}, { identity, threadId: task.threadId, turnId: task.turnId, callId: 'late' }), /关闭/);
    const response = await fetch(owner.gateway.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${identity.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_project_context', arguments: {}, _meta: { threadId: task.threadId, callId: 'late-http', 'x-codex-turn-metadata': { turn_id: task.turnId } } } }) });
    const reply = await response.json() as any;
    assert.equal(reply.result.isError, true); assert.match(JSON.stringify(reply.result.content), /关闭/);
    history.resolve(); await read;
    f.clients[0].options.onEvent({ method: 'item/agentMessage/delta', params: { threadId: task.threadId, turnId: task.turnId, itemId: 'late-event', delta: 'late' } });
    assert.equal(state.conversation.some((e: any) => e.itemId?.startsWith('late')), false);
    assert.equal(identical, true, 'concurrent close must return the same promise');
  } finally { history.resolve(); gate.resolve(); await Promise.all([first, second, read]); }
  assert.equal(closes, 1); assert.equal(f.engine.close(), first);
});

for (const type of ['read_history', 'catalog', 'login'] as const) test(`${type} cannot issue a fresh native RPC after close wins the runtime await`, async t => {
  const f = await fixture(t); await f.send('plan');
  const owner = f.engine as any, state = owner.states.get(f.projectId);
  await until(() => !!state.tasks[0].turnId);
  const task = state.tasks[0];
  f.clients[0].options.onEvent({ method: 'turn/completed', params: { threadId: task.threadId, turn: { id: task.turnId, status: 'completed' } } });
  const before = f.clients[0].calls.length;
  const operation = f.engine.command({ type, projectId: f.projectId, nodeId: 'plan' } as any).catch(() => {});
  await f.engine.close(); await operation;
  assert.equal(f.clients[0].calls.length, before, 'no RPC may start after the closed latch');
});

test('close attempts every save and owned resource and retains combined failure for repeated calls', async () => {
  const f = await fixture({ after() {} }); await f.send('plan');
  const owner = f.engine as any;
  await until(() => !!owner.states.get(f.projectId).tasks[0].turnId);
  const secondRoot = mkdtempSync(join(projectDirectory(f.root, 'other-projects'), 'second-'));
  const second = await f.engine.command({ type: 'create_project', root: secondRoot, name: 'second', goal: 'cleanup' });
  const secondId = second.snapshot.selected!.project.id;
  await f.engine.command({ type: 'connect', projectId: secondId });
  const attempts: string[] = [];
  const cleanup: (() => void)[] = [];
  for (const [id, store] of owner.stores) {
    const close = store.close.bind(store);
    cleanup.push(() => { try { close(); } catch {} });
    store.save = () => { attempts.push('save:' + id); throw Error('save:' + id); };
    store.close = () => { attempts.push('store:' + id); close(); throw Error('store:' + id); };
  }
  f.clients.forEach((client, i) => { client.port.close = async () => { attempts.push('client:' + i); throw Error('client:' + i); }; });
  const closeGateway = owner.gateway.close.bind(owner.gateway);
  owner.gateway.close = async () => { attempts.push('gateway'); await closeGateway(); throw Error('gateway'); };
  const first = f.engine.close(); let failure: any;
  try { await first; } catch (error) { failure = error; }
  // A RED early-abort implementation still needs its test-owned handles released.
  await closeGateway().catch(() => {}); for (const close of cleanup) close();
  assert.ok(failure instanceof AggregateError, String(failure));
  assert.equal(failure.errors.length, 7);
  for (const name of ['save:' + f.projectId, 'save:' + secondId, 'store:' + f.projectId, 'store:' + secondId, 'client:0', 'client:1', 'gateway']) assert.ok(attempts.includes(name), name);
  assert.equal(owner.identities.size, 0); assert.equal(owner.listeners.size, 0);
  assert.equal(f.engine.close(), first);
  await assert.rejects(f.engine.close(), error => error === failure);
  assert.equal(attempts.length, 7);
});

test('close fences an unfinished native connection without creating another runtime', async t => {
  const gate = deferred(), f = await fixture(t, () => gate.promise);
  const send = f.send('plan'); await until(() => f.clients.length === 1);
  let closes = 0; f.clients[0].port.close = async () => { closes++; };
  const closed = f.engine.close(); gate.resolve();
  await assert.rejects(send, /关闭|更换|取消/); await closed;
  await assert.rejects(f.send('review'), /关闭|取消/);
  assert.equal(closes, 1); assert.equal(f.clients.length, 1);
});

for (const scenario of ['replacement', 'failed-initialization'] as const) for (const fails of [false, true]) test(`shutdown owns ${scenario} retirement until its ${fails ? 'rejection' : 'success'}`, async () => {
  const f = await fixture({ after() {} }, async () => { if (scenario === 'failed-initialization') throw Error('initialization failed'); });
  const owner = f.engine as any, entered = deferred();
  let release!: () => void, reject!: (error: Error) => void;
  const gate = new Promise<void>((resolve, fail) => { release = resolve; reject = fail; });
  const retirementError = Error('retiring native client close failed');
  let closes = 0, gatewayCloses = 0, storeCloses = 0;
  if (scenario === 'replacement') await f.engine.command({ type: 'connect', projectId: f.projectId });
  let replacement: Promise<unknown>;
  if (scenario === 'replacement') {
    f.clients[0].port.close = async () => { closes++; entered.resolve(); await gate; };
    f.clients[0].options.onDisconnect('retire old connection');
    replacement = f.engine.command({ type: 'connect', projectId: f.projectId }).catch(error => error);
  } else {
    replacement = f.engine.command({ type: 'connect', projectId: f.projectId }).catch(error => error);
    f.clients[0].port.close = async () => { closes++; entered.resolve(); await gate; };
  }
  await entered.promise;
  const gatewayClose = owner.gateway.close.bind(owner.gateway), store = owner.stores.get(f.projectId), storeClose = store.close.bind(store);
  owner.gateway.close = async () => { gatewayCloses++; await gatewayClose(); };
  store.close = () => { storeCloses++; storeClose(); };
  const shutdown = f.engine.close();
  let settled = false;
  const result = shutdown.then(() => { settled = true; return null; }, error => { settled = true; return error; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'shutdown cannot finish while an owned client retirement is pending');
    assert.equal(closes, 1, 'shutdown must share the existing retirement promise');
  } finally {
    if (fails) reject(retirementError); else release();
    await replacement; await result;
  }
  const failure = await result;
  if (fails) { assert.ok(failure instanceof AggregateError); assert.ok(failure.errors.includes(retirementError)); }
  else assert.equal(failure, null);
  assert.equal(gatewayCloses, 1); assert.equal(storeCloses, 1);
  assert.throws(() => store.read(), /closed|not open/i);
  assert.equal(f.clients.length, 1, 'replacement cannot create another client after shutdown');
  assert.equal(closes, 1); assert.equal(f.engine.close(), shutdown);
  if (fails) await assert.rejects(f.engine.close(), error => error === failure);
});

test('shutdown retains a retirement failure that settled before shutdown began', async () => {
  const f = await fixture({ after() {} });
  await f.engine.command({ type: 'connect', projectId: f.projectId });
  const failure = Error('previous retirement failed'); let closes = 0;
  f.clients[0].port.close = async () => { closes++; throw failure; };
  f.clients[0].options.onDisconnect('replace');
  await assert.rejects(f.engine.command({ type: 'connect', projectId: f.projectId }), error => error === failure);
  const closed = f.engine.close();
  await assert.rejects(closed, error => error instanceof AggregateError && error.errors.includes(failure));
  assert.equal(f.engine.close(), closed); assert.equal(closes, 1); assert.equal(f.clients.length, 1);
  assert.throws(() => (f.engine as any).stores.get(f.projectId).read(), /closed|not open/i);
});

test('latched storage fault skips poisoned dirty state while close releases resources once', async () => {
  const f = await fixture({ after() {} }); await f.send('plan');
  const owner = f.engine as any, state = owner.states.get(f.projectId), store = owner.stores.get(f.projectId);
  await until(() => !!state.tasks[0].turnId);
  const persisted = store.db.prepare('SELECT body FROM project_state').get().body;
  owner.storageErrors.set(f.projectId, 'latched storage failure');
  state.conversation.push({ id: 'poisoned', text: 'uncommitted data' });
  let clientClosed = 0; f.clients[0].port.close = async () => { clientClosed++; };
  const closed = f.engine.close(); await closed;
  assert.equal(f.engine.close(), closed); assert.equal(clientClosed, 1);
  assert.throws(() => store.read(), /closed|not open/i);
  const reopened = new ProjectStore(f.root);
  try { assert.equal(reopened.db.prepare('SELECT body FROM project_state').get()!.body, persisted); }
  finally { reopened.close(); }
});

for (const version of [1, 2]) test(`v${version} recovery retains raw input, thread and committed result without replay`, async t => {
  const f = await fixture(t); await f.send('plan');
  const owner = f.engine as any, state = owner.states.get(f.projectId);
  await until(() => !!state.tasks[0].turnId);
  const task = state.tasks[0];
  const result = { arbitrary: ['retained', { detail: 8 }] };
  task.status = 'completed'; task.result = result; task.terminal = { kind: 'complete', result, fingerprint: 'durable' }; task.finishedAt = '2026-10-20T00:00:00.000Z';
  state.nodes[0].status = 'completed';
  const expectedInput = structuredClone(task.nativeInput), threadId = task.threadId;
  await f.engine.close();
  const raw = new ProjectStore(f.root);
  const legacy = raw.read()!; delete (legacy as any).messages; delete (legacy as any).workflowReceipts;
  if (version === 1) delete (legacy as any).conversation;
  raw.db.prepare('UPDATE project_state SET schema_version=?,body=?').run(version, JSON.stringify(legacy));
  raw.close();
  let clients = 0;
  const restored = new WorkflowEngine({ workbenchRoot: f.root, executable: 'unused', nativeFactory() { clients++; throw Error('must not reconnect'); } });
  try {
    await restored.init(); const selected = (await restored.command({ type: 'snapshot', projectId: f.projectId })).snapshot.selected!;
    assert.deepEqual(selected.tasks[0].result, result); assert.equal(selected.tasks[0].threadId, threadId);
    const store = new ProjectStore(f.root);
    try {
      const migrated = store.read()!;
      assert.deepEqual(migrated.tasks[0].nativeInput, expectedInput); assert.deepEqual(migrated.tasks[0].terminal, legacy.tasks[0].terminal);
      assert.deepEqual(migrated.messages, []); assert.deepEqual(migrated.workflowReceipts, []);
      assert.deepEqual(migrated.nodes[0].tools, ['get_project_context', 'handoff', 'update_workflow']);
      assert.equal(store.db.prepare('SELECT schema_version FROM project_state').get()!.schema_version, 3);
    }
    finally { store.close(); }
    assert.equal(clients, 0); assert.equal(existsSync(join(f.root, '.git')), false);
  } finally { await restored.close(); }
});

for (const version of [1, 2]) test(`v${version} migration retains unknown authors and unrecognized legacy fields`, async t => {
  const f = await fixture(t); await f.engine.close();
  const store = new ProjectStore(f.root);
  try {
    const legacy: any = store.read()!;
    delete legacy.messages; delete legacy.workflowReceipts;
    legacy.retained = { custom: [false, null, 0, ''] };
    legacy.nodes[0].threads.codex = 'old-thread'; legacy.nodes[0].retained = 'node extension';
    legacy.conversation.push({ id: 'unknown-native', seq: 1, nodeId: 'plan', taskId: null, threadId: 'old-thread', turnId: 'old-turn', itemId: 'old-input', direction: 'input', source: { kind: 'unknown' }, text: ' 原文\n ', content: { arbitrary: [false, 0] }, createdAt: '', retained: { native: true } });
    store.db.prepare('UPDATE project_state SET schema_version=?,body=?').run(version, JSON.stringify(legacy));
    const migrated: any = store.read()!;
    assert.deepEqual(migrated.retained, legacy.retained); assert.deepEqual(migrated.nodes, legacy.nodes);
    const persisted = JSON.parse(String(store.db.prepare('SELECT body FROM project_state').get()!.body));
    assert.deepEqual(persisted.conversation, legacy.conversation); assert.deepEqual(migrated.handoffs, legacy.handoffs);
    assert.equal(migrated.conversation[0].source.kind, 'unknown');
    assert.deepEqual(migrated.messages, []); assert.deepEqual(migrated.workflowReceipts, []);
    assert.equal(store.db.prepare('SELECT schema_version FROM project_state').get()!.schema_version, 3);
  } finally { store.close(); }
});

test('confirmed pause survives restart while active exit requires reconciliation with healthy stream tail', async t => {
  const f = await fixture(t); await f.send('plan'); await f.send('implement');
  const owner = f.engine as any, state = owner.states.get(f.projectId);
  await until(() => state.tasks.every((task: any) => !!task.turnId));
  const paused = state.tasks.find((task: any) => task.nodeId === 'plan');
  await f.engine.command({ type: 'pause_node', projectId: f.projectId, nodeId: 'plan' });
  f.clients[0].options.onEvent({ method: 'turn/completed', params: { threadId: paused.threadId, turn: { id: paused.turnId, status: 'interrupted' } } });
  assert.equal(paused.status, 'paused');
  const active = state.tasks.find((task: any) => task.nodeId === 'implement');
  f.clients[0].options.onEvent({ method: 'item/agentMessage/delta', params: { threadId: active.threadId, turnId: active.turnId, itemId: 'tail', delta: 'last healthy tail' } });
  await f.engine.close();
  const restored = new WorkflowEngine({ workbenchRoot: f.root, executable: 'unused', nativeFactory() { throw Error('no automatic replay'); } });
  try {
    await restored.init(); const selected = (await restored.command({ type: 'snapshot', projectId: f.projectId })).snapshot.selected!;
    assert.equal(selected.tasks.find(task => task.id === paused.id)!.status, 'paused');
    assert.equal(selected.nodes.find(node => node.id === 'plan')!.status, 'paused');
    assert.equal(selected.tasks.find(task => task.id === active.id)!.status, 'needs_reconciliation');
    assert.equal(selected.nodes.find(node => node.id === 'implement')!.status, 'blocked');
    assert.equal(selected.conversation!.find(entry => entry.itemId === 'tail')!.text, 'last healthy tail');
  } finally { await restored.close(); }
});

test('a copied state cannot bind to a different project root', async t => {
  const f = await fixture(t); await f.engine.close();
  const copy = mkdtempSync(join(projectDirectory(f.root, 'copies'), 'copy-'));
  cpSync(join(f.root, '.mixcat'), join(copy, '.mixcat'), { recursive: true });
  const store = new ProjectStore(copy);
  try { assert.throws(() => store.read(), /原始目录/); } finally { store.close(); }
});
