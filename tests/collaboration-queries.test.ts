import test from 'node:test';
import assert from 'node:assert/strict';
import { edgeToolName } from '../src/core/mcp.js';
import { parseMessageInput } from '../src/core/collaboration.js';
import { nativeItem } from '../src/core/history.js';
import type { ConversationEntry } from '../src/shared/types.js';
import { collaborationFixture } from './collaboration-fixture.js';
import { deferred, until } from './runtime-fixture.js';

async function queries(t: Parameters<typeof collaborationFixture>[0]) {
  const f = await collaborationFixture(t);
  const hostHome = process.env.MIXCAT_HOST_CODEX_HOME;
  process.env.MIXCAT_HOST_CODEX_HOME = f.root;
  t.after(async () => { if (hostHome === undefined) delete process.env.MIXCAT_HOST_CODEX_HOME; else process.env.MIXCAT_HOST_CODEX_HOME = hostHome; });
  for (const node of [...f.state.nodes]) await f.engine.command({ type: 'save_node', projectId: f.projectId, node: { ...node, tools: [...node.tools, 'read_history'] } });
  return f;
}
const message = { request_id: 'first', to_node_id: 'implement', content: { text: ' 原文\n ', values: [false, null, 0] }, reason: 'collaboration' };
function entry(id: string, seq: number, createdAt: string, extra: Partial<ConversationEntry> = {}): ConversationEntry {
  return { id, seq, createdAt, nodeId: 'plan', taskId: null, threadId: null, turnId: null, itemId: null, direction: 'output', source: null, text: id, content: { raw: id }, ...extra };
}

test('default context preserves legacy fields and reads existing facts without connecting', async t => {
  const f = await queries(t);
  const empty = await f.invoke('plan', 'get_project_context', {}, 'empty');
  assert.equal(empty.task, null); assert.equal(empty.remainingSteps, null);
  assert.equal(empty.project.id, f.projectId); assert.equal(empty.project.root, f.root);
  assert.equal(empty.self.id, 'plan'); assert.equal(empty.self.status, 'idle');
  assert.deepEqual(empty.edges, []); assert.equal(empty.incoming_message, null);
  assert.ok(Array.isArray(empty.collaboration_rules)); assert.equal(f.clients.length, 0);
  const source = await f.active('plan');
  const ctx = await f.invoke('plan', 'get_project_context', {}, 'context');
  assert.equal(ctx.project.name, 'fixture'); assert.equal(Object.hasOwn(ctx.project, 'goal'), false); assert.equal(ctx.project.mode, 'codex');
  assert.equal(ctx.task.id, source.id); assert.deepEqual(ctx.task.input, source.input);
  assert.equal(ctx.task.instruction, source.instruction); assert.equal(ctx.task.attempt, 1);
  assert.deepEqual(ctx.task.source, { kind: 'user' }); assert.equal(ctx.remainingSteps, null);
  assert.equal(ctx.nodes[0].revision, f.state.nodes[0].revision); assert.deepEqual(ctx.nodes[0].resultSchema, {});
  assert.deepEqual(ctx.nodes[0].position, f.state.nodes[0].position);
  const receipt = await f.invoke('plan', 'send_message', message, 'send');
  await until(() => !!f.state.tasks.find(task => task.id === receipt.target_task_id)?.turnId);
  const incoming = await f.invoke('implement', 'get_project_context', {}, 'incoming');
  assert.deepEqual(incoming.task.input, message.content);
  assert.equal(incoming.incoming_message.message_id, receipt.message_id);
  assert.deepEqual(incoming.incoming_message.from, { nodeId: 'plan', name: '规划' });
  assert.deepEqual(incoming.incoming_message.attachments, []); assert.equal(incoming.incoming_message.reply_to, null);
});

test('context and history reject forged native ownership and cross-project identities', async t => {
  const f = await queries(t); await f.active('plan');
  for (const name of ['get_project_context', 'read_history']) {
    const result = await f.raw('plan', name, {}, name, { ...f.context('plan', name), threadId: 'forged' });
    assert.equal(result.result.isError, true);
    await assert.rejects(f.engine.invokeTool(name as 'read_history', {}, { ...f.context('plan', name), identity: { ...f.context('plan', name).identity, projectId: 'foreign' } }), /身份/);
  }
  const other = await f.active('review');
  const result = await f.raw('plan', 'read_history', {}, 'other', { ...f.context('plan', 'other'), threadId: other.threadId!, turnId: other.turnId! });
  assert.equal(result.result.structuredContent.error.code, 'PERMISSION_DENIED');
});

test('capability discovery is optional, preserves partial failures and does not lock queries or control', async t => {
  const f = await queries(t); await f.active('plan');
  const gate = deferred(), entered = deferred(); t.after(async () => gate.resolve());
  const port = f.clients[0].port, rpc = port.rpc;
  port.rpc = async (method, args) => {
    if (method === 'model/list') { entered.resolve(); await gate.promise; return { data: [{ model: 'fixture-model', displayName: 'Fixture' }] }; }
    if (method === 'skills/list') throw new Error('fixture skill source failed');
    if (method === 'plugin/installed') return { marketplaces: [{ plugins: [{ id: 'test@local', name: 'test', installed: true, enabled: true }] }] };
    return rpc(method, args);
  };
  const pending = f.invoke('plan', 'get_project_context', { include_capabilities: true }, 'catalog');
  await Promise.race([entered.promise, pending.then(() => { throw new Error('Capability query did not wait for discovery'); })]);
  assert.equal((await f.invoke('plan', 'get_project_context', {}, 'default')).self.id, 'plan');
  const receipt = await f.invoke('plan', 'send_message', message, 'send');
  assert.equal((await f.invoke('plan', 'get_delivery', { message_id: receipt.message_id }, 'delivery')).receipt.message_id, receipt.message_id);
  assert.ok((await f.invoke('plan', 'read_history', {}, 'history')).entries.length > 0);
  await f.engine.command({ type: 'pause_node', projectId: f.projectId, nodeId: 'plan' });
  assert.equal(f.state.nodes[0].status, 'pausing');
  gate.resolve();
  const result = await pending;
  assert.equal(result.self.status, 'pausing'); assert.equal(result.capabilities.models[0].id, 'fixture-model');
  assert.ok(result.capabilities.errors.some((error: string) => error.includes('fixture skill source failed')));
});

test('capability discovery rejects a revoked identity and a replaced runtime after awaiting', async t => {
  for (const change of ['identity', 'runtime', 'close']) {
    const f = await queries(t); await f.active('plan');
    const gate = deferred(), entered = deferred(); t.after(async () => gate.resolve());
    const port = f.clients[0].port, rpc = port.rpc;
    port.rpc = async (method, args) => { if (method === 'model/list') { entered.resolve(); await gate.promise; return { data: [] }; } return rpc(method, args); };
    const ctx = f.context('plan', 'catalog');
    const pending = f.engine.invokeTool('get_project_context', { include_capabilities: true }, ctx);
    const rejected = assert.rejects(pending, /身份|连接|关闭/);
    await Promise.race([entered.promise, pending.then(() => { throw new Error('Capability query did not wait for discovery'); })]);
    if (change === 'identity') (f.engine as any).identities.delete(ctx.identity.token);
    else if (change === 'runtime') (f.engine as any).runtimes.set(f.projectId, { ...(f.engine as any).runtimes.get(f.projectId) });
    else await f.engine.close();
    gate.resolve(); await rejected;
  }
});

test('routes must retain current endpoints and revision; old snapshots survive edits and deletion', async t => {
  const f = await queries(t); await f.active('plan');
  const edge = { id: 'route', sourceNodeId: 'plan', targetNodeId: 'implement', condition: 'if useful', revision: 0 };
  await f.engine.command({ type: 'save_edge', projectId: f.projectId, edge });
  const ctx = await f.invoke('plan', 'get_project_context', {}, 'context');
  assert.deepEqual(ctx.edges, [{ ...edge, revision: 1 }]);
  const receipt = await f.invoke('plan', 'send_message', { ...message, route: { edge_id: 'route', edge_revision: 1 } }, 'send');
  for (const changed of [{ ...edge, condition: 'new condition', revision: 1 }, { ...edge, targetNodeId: 'review', revision: 2 }]) {
    await f.engine.command({ type: 'save_edge', projectId: f.projectId, edge: changed });
    const result = await f.raw('plan', 'send_message', { ...message, request_id: `stale-${changed.revision}`, route: { edge_id: 'route', edge_revision: 1 } }, `stale-${changed.revision}`);
    assert.equal(result.result.structuredContent.error.code, 'ROUTE_CHANGED');
  }
  const wrongEndpoint = await f.raw('plan', 'send_message', { ...message, request_id: 'wrong-end', route: { edge_id: 'route', edge_revision: 3 } }, 'wrong-end');
  assert.equal(wrongEndpoint.result.structuredContent.error.code, 'ROUTE_CHANGED');
  await f.engine.command({ type: 'delete_edge', projectId: f.projectId, edgeId: 'route' });
  const deleted = await f.raw('plan', 'send_message', { ...message, request_id: 'deleted', route: { edge_id: 'route', edge_revision: 3 } }, 'deleted');
  assert.equal(deleted.result.structuredContent.error.code, 'ROUTE_CHANGED');
  assert.deepEqual(f.state.messages.find(item => item.message_id === receipt.message_id)!.edgeSnapshot, { ...edge, revision: 1 });
  assert.equal((await f.invoke('plan', 'send_message', { ...message, request_id: 'direct' }, 'direct')).accepted, true);
});

test('history pages share UI ordering, keep raw unknown times, and exclude new entries during traversal', async t => {
  const f = await queries(t);
  f.state.conversation = [entry('unknown-z', 6, 'invalid'), entry('known-z', 2, '2026-01-01T00:00:00Z'), entry('known-a', 2, '2026-01-01T08:00:00+08:00'), entry('unknown-a', 6, ''), entry('earlier', 1, '2025-01-01')];
  const original = structuredClone(f.state.conversation);
  const first = await f.invoke('plan', 'read_history', { limit: 1 }, 'first');
  assert.deepEqual(first.entries.map((item: ConversationEntry) => item.id), ['earlier']); assert.ok(first.next_cursor);
  assert.equal(first.next_cursor.includes(f.context('plan', 'token').identity.token), false);
  f.state.conversation.push(entry('new-backfill', 7, '2024-01-01'));
  const ids = ['earlier']; let cursor = first.next_cursor;
  while (cursor) {
    const page = await f.invoke('plan', 'read_history', { limit: 2, cursor }, 'next');
    ids.push(...page.entries.map((item: ConversationEntry) => item.id)); cursor = page.next_cursor;
  }
  assert.deepEqual(ids, ['earlier', 'known-a', 'known-z', 'unknown-a', 'unknown-z']);
  assert.deepEqual(f.state.conversation.slice(0, 5), original);
  assert.deepEqual((await f.invoke('plan', 'read_history', {}, 'fresh')).entries.map((item: ConversationEntry) => item.id), ['new-backfill', ...ids]);
});

test('history validates limits and cursor project, filters, shape and position', async t => {
  const f = await queries(t);
  f.state.conversation = Array.from({ length: 202 }, (_, i) => entry(`e-${i}`, i + 1, '', { nodeId: i % 2 ? 'review' : 'plan' }));
  assert.equal((await f.invoke('plan', 'read_history', {}, 'default')).entries.length, 50);
  assert.equal((await f.invoke('plan', 'read_history', { limit: 200 }, 'max')).entries.length, 200);
  const page = await f.invoke('plan', 'read_history', { node_id: 'plan', limit: 1 }, 'first');
  const decode = JSON.parse(Buffer.from(page.next_cursor, 'base64url').toString('utf8'));
  for (const args of [{ limit: 0 }, { limit: -1 }, { limit: 201 }, { limit: 1.5 }, { limit: '1' }, { limit: null }, { node_id: '' }, { cursor: 'broken' }, { cursor: Buffer.from('{}').toString('base64url') },
    { node_id: 'review', cursor: page.next_cursor }, { node_id: 'plan', cursor: Buffer.from(JSON.stringify({ ...decode, projectId: 'foreign' })).toString('base64url') },
    { node_id: 'plan', cursor: Buffer.from(JSON.stringify({ ...decode, position: { seq: 'broken' } })).toString('base64url') }, { include_token: true }]) {
    const result = await f.raw('plan', 'read_history', args, 'invalid');
    assert.equal(result.result.isError, true, JSON.stringify(args)); assert.equal(result.result.structuredContent.error.code, -32602);
  }
  for (const args of [{ include_capabilities: 'yes' }, { extra: true }]) assert.equal((await f.raw('plan', 'get_project_context', args, 'invalid-context')).result.isError, true);
  assert.deepEqual((await f.invoke('plan', 'read_history', { node_id: 'missing', task_id: 'foreign', message_id: 'foreign' }, 'absent')).entries, []);
});

test('history filters include ordinary outputs through task incoming message and explicit reply linkage', async t => {
  const f = await queries(t); await f.active('plan');
  const receipt = await f.invoke('plan', 'send_message', message, 'send');
  await until(() => !!f.state.tasks.find(task => task.id === receipt.target_task_id)?.turnId);
  const target = f.state.tasks.find(task => task.id === receipt.target_task_id)!;
  const output = nativeItem(f.state, 'implement', target.threadId!, target.turnId!, { id: 'answer', type: 'agentMessage', text: ' free answer ' }, target, true, '');
  assert.equal(output.messageId, undefined);
  const reply = await f.invoke('implement', 'send_message', { request_id: 'reply', to_node_id: 'plan', content: false, reason: 'answer', reply_to: receipt.message_id }, 'reply');
  const byMessage = await f.invoke('plan', 'read_history', { message_id: receipt.message_id, node_id: 'implement' }, 'message');
  assert.deepEqual(byMessage.entries.filter((item: ConversationEntry) => item.direction !== 'event').map((item: ConversationEntry) => item.id).sort(), [`input:${target.id}`, output.id].sort());
  assert.ok(byMessage.entries.every((item: ConversationEntry) => item.taskId === target.id));
  const byTask = await f.invoke('plan', 'read_history', { task_id: target.id }, 'task');
  assert.ok(byTask.entries.some((item: ConversationEntry) => item.id === output.id));
  const byReply = await f.invoke('plan', 'read_history', { reply_to: receipt.message_id }, 'replies');
  assert.ok(byReply.entries.length >= 2); assert.ok(byReply.entries.every((item: ConversationEntry) => item.messageId === reply.message_id));
});

test('valid negative zero JSON normalizes consistently for parsing without admitting non-JSON values', () => {
  const content = { nested: [-0, { zero: -0 }], text: ' -0 ', order: ['b', 'a'] };
  assert.deepEqual(parseMessageInput({ ...message, content }).content, { nested: [0, { zero: 0 }], text: ' -0 ', order: ['b', 'a'] });
  for (const invalid of [undefined, NaN, Infinity, { invalid: undefined }, [undefined], new Map(), new Date()]) assert.throws(() => parseMessageInput({ ...message, content: invalid }));
});

test('valid negative zero JSON survives HTTP acceptance, persistence and direct replay', async t => {
  const content = { nested: [-0, { zero: -0 }], text: ' -0 ', order: ['b', 'a'] };
  const f = await queries(t); await f.active('plan');
  await f.engine.command({ type: 'save_edge', projectId: f.projectId, edge: { id: 'zero', sourceNodeId: 'plan', targetNodeId: 'implement', condition: 'Preserve JSON numbers', revision: 0 } });
  const ctx = f.context('plan', 'zero');
  const { to_node_id, ...edgeInput } = message;
  const body = JSON.stringify({ jsonrpc: '2.0', id: 'zero', method: 'tools/call', params: { name: edgeToolName('zero', 'implement'), arguments: { ...edgeInput, content: 'NEGATIVE_ZERO' }, _meta: { threadId: ctx.threadId, callId: ctx.callId, 'x-codex-turn-metadata': { turn_id: ctx.turnId } } } }).replace('"NEGATIVE_ZERO"', '{"nested":[-0,{"zero":-0}],"text":" -0 ","order":["b","a"]}');
  const response = await fetch((f.engine as any).gateway.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${ctx.identity.token}` }, body });
  const result = await response.json(); assert.equal(result.result.isError, undefined);
  const receipt = result.result.structuredContent;
  assert.deepEqual(f.state.messages[0].request.content, { nested: [0, { zero: 0 }], text: ' -0 ', order: ['b', 'a'] });
  assert.deepEqual(await f.engine.invokeTool('send_message', { ...message, content, route: { edge_id: 'zero', edge_revision: 1 } }, ctx), receipt);
  assert.deepEqual(f.store.read()!.messages[0].request.content, f.state.messages[0].request.content);
});
