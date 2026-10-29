import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, until, deferred } from './runtime-fixture.js';

test('fresh thread history waits for its first turn without failing or replaying the task', async t => {
  const f = await fixture(t);
  await f.engine.command({ type: 'catalog', projectId: f.projectId });
  const client = f.clients[0], rpc = client.port.rpc.bind(client.port), gate = deferred();
  let ready = false, reads = 0, starts = 0;
  client.port.rpc = async (method, params) => {
    if (method === 'turn/start') { starts++; await gate.promise; }
    if (method === 'thread/items/list') throw Object.assign(new Error('unsupported'), { code: -32601 });
    if (method === 'thread/read') {
      reads++;
      if (!ready) throw new Error('failed to read session metadata: rollout is empty');
      return { thread: { turns: [{ id: 'stored-turn', items: [{ id: 'backfill', type: 'agentMessage', text: 'original history' }] }] } };
    }
    return rpc(method, params);
  };
  t.after(() => gate.resolve());
  await f.send('plan');
  const state = (f.engine as any).states.get(f.projectId);
  await until(() => !!state.tasks[0].threadId);
  const read = () => f.engine.command({ type: 'read_history', projectId: f.projectId, nodeId: 'plan' });
  assert.equal((await read()).historyPending, true);
  assert.equal((await f.engine.command({ type: 'snapshot' })).snapshot.selected!.nodes[0].historyPending, true);
  assert.equal(reads, 0);
  gate.resolve(); await until(() => !!state.tasks[0].turnId);
  assert.equal((await read()).historyPending, true, 'turn acknowledgement alone does not prove durable history');
  ready = true;
  client.options.onEvent({ method: 'turn/completed', params: { threadId: state.tasks[0].threadId, turn: { id: state.tasks[0].turnId, status: 'completed' } } });
  const reply = await read();
  assert.equal(reply.historyPending, false);
  assert.equal(!!reply.snapshot.selected!.nodes[0].historyPending, false);
  assert.equal(reply.snapshot.selected!.tasks[0].status, 'completed');
  assert.equal(reply.snapshot.selected!.tasks[0].error, null);
  assert.ok(reply.snapshot.selected!.conversation!.some(item => item.text === 'original history'));
  assert.equal(starts, 1);
});

test('existing unreadable history remains an error and stale reads cannot write after disconnect', async t => {
  const f = await fixture(t);
  await f.engine.command({ type: 'catalog', projectId: f.projectId });
  const state = (f.engine as any).states.get(f.projectId), client = f.clients[0];
  state.nodes[0].threads.codex = 'existing';
  client.port.rpc = async () => { throw new Error('rollout is empty'); };
  await assert.rejects(f.engine.command({ type: 'read_history', projectId: f.projectId, nodeId: 'plan' }), /rollout is empty/);
  const gate = deferred(); t.after(() => gate.resolve());
  client.port.rpc = async () => { await gate.promise; return { data: [{ turnId: 'old', item: { id: 'stale', type: 'agentMessage', text: 'late history' } }] }; };
  const reading = f.engine.command({ type: 'read_history', projectId: f.projectId, nodeId: 'plan' });
  client.options.onDisconnect('disconnected'); gate.resolve(); await reading;
  assert.equal(state.conversation.some((item: any) => item.text === 'late history'), false);
});

test('failed startup releases history deferral for reconciliation', async t => {
  const f = await fixture(t);
  await f.engine.command({ type: 'catalog', projectId: f.projectId });
  const client = f.clients[0], rpc = client.port.rpc.bind(client.port);
  client.port.rpc = async (method, params) => {
    if (method === 'turn/start') throw new Error('startup rejected');
    if (method === 'thread/items/list') throw new Error('permanent history error');
    return rpc(method, params);
  };
  await f.send('plan'); const state = (f.engine as any).states.get(f.projectId);
  await until(() => state.tasks[0].status === 'failed');
  assert.equal(!!(await f.engine.command({ type: 'snapshot' })).snapshot.selected!.nodes[0].historyPending, false);
  await assert.rejects(f.engine.command({ type: 'read_history', projectId: f.projectId, nodeId: 'plan' }), /permanent history error/);
});
