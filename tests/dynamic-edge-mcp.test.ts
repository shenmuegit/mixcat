import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deferred, fixture, until } from './runtime-fixture.js';
import { setTimeout as delay } from 'node:timers/promises';

test('each node discovers only its own outgoing edge tools, updated from the saved graph', async t => {
  const f = await fixture(t), owner = f.engine as any;
  const reader = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!.nodes.find(node => node.id === 'review')!;
  await f.engine.command({ type: 'save_node', projectId: f.projectId, node: { ...reader, tools: ['get_project_context'] } });
  const rpc = async (nodeId: string, method: string, params: object = {}) => {
    const identity = f.engine.nodeIdentity(f.projectId, nodeId);
    const response = await fetch(owner.gateway.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${identity.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 'discovery', method, params }) });
    return await response.json() as any;
  };
  const tools = async (nodeId: string) => (await rpc(nodeId, 'tools/list')).result.tools as any[];
  assert.deepEqual((await tools('plan')).map(tool => tool.name), ['get_project_context', 'update_workflow']);
  const edges = [
    { id: 'first', sourceNodeId: 'plan', targetNodeId: 'implement', condition: '方案已明确', revision: 0 },
    { id: 'second', sourceNodeId: 'plan', targetNodeId: 'implement', condition: '需要补充实现', revision: 0 },
    { id: 'back', sourceNodeId: 'review', targetNodeId: 'plan', condition: '需要回流修改', revision: 0 },
  ];
  for (const edge of edges) await f.engine.command({ type: 'save_edge', projectId: f.projectId, edge });
  const plan = (await tools('plan')).filter(tool => tool.name.startsWith('edge_'));
  assert.equal(plan.length, 2); assert.notEqual(plan[0].name, plan[1].name);
  assert.match(plan[0].description, /方案已明确/);
  assert.equal(plan[0].inputSchema.properties.to_node_id, undefined);
  assert.equal(plan[0].inputSchema.properties.route, undefined);
  assert.deepEqual(plan[0].inputSchema.properties.content, {});
  assert.equal((await tools('implement')).filter(tool => tool.name.startsWith('edge_')).length, 0);
  assert.equal((await tools('review')).filter(tool => tool.name.startsWith('edge_')).length, 1);
  await f.engine.command({ type: 'save_edge', projectId: f.projectId, edge: { ...edges[0], revision: 1, condition: '新的条件描述' } });
  const updated = (await tools('plan')).find(tool => tool.name === plan[0].name);
  assert.match(updated.description, /新的条件描述/);
  await f.engine.command({ type: 'delete_edge', projectId: f.projectId, edgeId: 'second' });
  assert.equal((await tools('plan')).filter(tool => tool.name.startsWith('edge_')).length, 1);
  assert.ok(!(await tools('plan')).some(tool => ['send_message', 'handoff'].includes(tool.name)));
});

test('the deterministic demo follows its configured edge tools through review and return', async t => {
  const f = await fixture(t);
  const created = (await f.engine.command({ type: 'create_demo' })).snapshot.selected!;
  const projectId = created.project.id;
  assert.equal(created.edges!.length, 3);
  await f.engine.command({ type: 'send_message', projectId, nodeId: 'plan', mode: 'demo', input: [{ type: 'text', text: 'release checklist' }] });
  let snapshot = (await f.engine.command({ type: 'snapshot', projectId })).snapshot.selected!;
  for (let i = 0; i < 250; i++) {
    snapshot = (await f.engine.command({ type: 'snapshot', projectId })).snapshot.selected!;
    if (snapshot.tasks.length === 5 && snapshot.tasks.every(task => task.status === 'completed')) break;
    assert.ok(!snapshot.tasks.some(task => task.status === 'failed'), JSON.stringify(snapshot.tasks));
    await delay(40);
  }
  assert.deepEqual(snapshot.tasks.map(task => task.nodeId), ['plan', 'implement', 'review', 'implement', 'review']);
  assert.equal(snapshot.messages!.length, 4); assert.equal(snapshot.handoffs.length, 0);
  assert.equal((snapshot.tasks.at(-1)!.result as any).verdict, 'approved');
});

test('changed catalogs refresh the same native Thread before its next Turn, with no arbitrary-target allowlist', async t => {
  const f = await fixture(t), owner = f.engine as any;
  await f.send('plan');
  const state = owner.states.get(f.projectId);
  await until(() => !!state.tasks[0].turnId);
  const original = state.tasks[0];
  const finish = (task: any) => f.clients[0].options.onEvent({ method: 'turn/completed', params: { threadId: task.threadId, turn: { id: task.turnId, status: 'completed', items: [] } } });
  const server = f.clients[0].calls.find(call => call.method === 'thread/start')!.params.config.mcp_servers.mixcat;
  assert.equal(server.enabled_tools, undefined); assert.equal(server.default_tools_approval_mode, 'approve');
  finish(original);
  await f.engine.command({ type: 'save_edge', projectId: f.projectId, edge: { id: 'added', sourceNodeId: 'plan', targetNodeId: 'implement', condition: '新增条件', revision: 0 } });
  await f.send('plan'); await until(() => !!state.tasks[1].turnId);
  assert.equal(state.tasks[1].threadId, original.threadId);
  assert.equal(f.clients[0].calls.filter(call => call.method === 'thread/start').length, 1);
  assert.deepEqual(f.clients[0].calls.filter(call => call.method === 'thread/unsubscribe').map(call => call.params.threadId), [original.threadId]);
  finish(state.tasks[1]);
  await f.send('plan'); await until(() => !!state.tasks[2].turnId);
  assert.equal(f.clients[0].calls.filter(call => call.method === 'thread/unsubscribe').length, 1, 'unchanged tools do not reset native connections');
});

test('bound edge calls preserve content, pause queues, receipt replay and the captured edge without route rechecking', async t => {
  const f = await fixture(t), owner = f.engine as any;
  const node = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!.nodes[0];
  await f.engine.command({ type: 'save_node', projectId: f.projectId, node: { ...node, tools: ['get_project_context', 'get_delivery'] } });
  const edge = { id: 'edge-route', sourceNodeId: 'plan', targetNodeId: 'implement', condition: '交付原文', revision: 0 };
  await f.engine.command({ type: 'save_edge', projectId: f.projectId, edge });
  await f.engine.command({ type: 'pause_node', projectId: f.projectId, nodeId: 'implement' });
  await f.send('plan');
  const state = owner.states.get(f.projectId);
  await until(() => !!state.tasks[0].turnId);
  const source = state.tasks[0], identity = f.engine.nodeIdentity(f.projectId, 'plan');
  const rpc = async (method: string, params: object) => {
    const response = await fetch(owner.gateway.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${identity.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 'bound', method, params }) });
    return await response.json() as any;
  };
  const name = (await rpc('tools/list', {})).result.tools.find((tool: any) => tool.name.startsWith('edge_')).name;
  writeFileSync(join(f.root, 'bound.txt'), 'fixed attachment');
  const args = { request_id: 'bound-message', content: { text: '  原文\n', arbitrary: [null, false, 0, ''] }, reason: '选择这条条件边', attachments: [{ path: 'bound.txt' }] };
  const call = (input = args, toolName = name) => rpc('tools/call', { name: toolName, arguments: input, _meta: { threadId: source.threadId, callId: 'bound-call', 'x-codex-turn-metadata': { turn_id: source.turnId } } });
  const reading = deferred(), release = deferred(), read = fs.readFile; let firstRead = true;
  t.mock.method(fs, 'readFile', async (...params: Parameters<typeof read>) => {
    if (String(params[0]) === join(f.root, 'bound.txt') && firstRead) { firstRead = false; reading.resolve(); await release.promise; }
    return (read as any)(...params);
  });
  const pending = call();
  await Promise.race([reading.promise, pending.then(result => assert.fail(JSON.stringify(result)))]);
  try { await f.engine.command({ type: 'save_edge', projectId: f.projectId, edge: { ...edge, revision: 1, targetNodeId: 'review', condition: '修改后的条件' } }); }
  finally { release.resolve(); }
  const first = await pending;
  assert.equal(first.result.isError, undefined, first.result.content?.[0]?.text);
  const receipt = first.result.structuredContent;
  assert.deepEqual(state.messages[0].request.content, args.content);
  assert.equal(state.messages[0].toNodeId, 'implement');
  assert.equal(state.messages[0].edgeSnapshot.condition, edge.condition);
  assert.equal(state.tasks.find((task: any) => task.id === receipt.target_task_id).turnId, null);
  assert.equal(source.terminal, null); assert.equal(source.status, 'running');
  const changedName = (await rpc('tools/list', {})).result.tools.find((tool: any) => tool.name.startsWith('edge_')).name;
  assert.notEqual(changedName, name, 'a changed target replaces the binding instead of silently redirecting an old tool');
  const stale = await call({ ...args, request_id: 'stale-new-message' });
  assert.equal(stale.result.isError, true); assert.equal(state.messages.length, 1);
  assert.deepEqual((await call(args, changedName)).result.structuredContent, receipt, 'a committed replay retains its original target and condition');
  const invalid = await call({ ...args, to_node_id: 'review' } as typeof args, changedName);
  assert.equal(invalid.result.isError, true);
  const freeSend = await call({ ...args, to_node_id: 'review' } as typeof args, 'send_message');
  assert.ok(freeSend.error || freeSend.result.isError);
  assert.equal(state.messages.length, 1);
});
