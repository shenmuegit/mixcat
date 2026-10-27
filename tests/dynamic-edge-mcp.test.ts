import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deferred, fixture, until } from './runtime-fixture.js';
import { setTimeout as delay } from 'node:timers/promises';
import { edgeToolName } from '../src/core/mcp.js';

for (const deletedFrontendReturn of [false, true]) test(`Web product routes preserve ${deletedFrontendReturn ? 'the deleted frontend return' : 'the default graph'} and deliver a backend repair cycle through public MCP`, async t => {
  const f = await fixture(t, undefined, 'web-product'), owner = f.engine as any;
  const state = owner.states.get(f.projectId);
  const nodesBefore = structuredClone(state.nodes);
  // This test isolates routing; human-review decisions have their own workflow tests.
  await f.engine.command({ type: 'save_review_policy', projectId: f.projectId, policy: { ...state.reviewPolicy, checkpoints: [] } });
  if (deletedFrontendReturn) await f.engine.command({ type: 'delete_edge', projectId: f.projectId, edgeId: 'test-frontend' });
  const rpc = async (nodeId: string, method: string, params: object = {}) => {
    const identity = f.engine.nodeIdentity(f.projectId, nodeId);
    const response = await fetch(owner.gateway.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${identity.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 'web-routing', method, params }) });
    assert.equal(response.status, 200);
    return await response.json() as any;
  };
  const adjacency = { product: ['requirements', 'architect'], requirements: ['product', 'design'], design: ['requirements', 'design-test', 'product'], frontend: ['architect', 'test'], backend: ['architect', 'frontend'], test: [...(deletedFrontendReturn ? [] : ['frontend']), 'backend', 'product'], architect: ['product', 'backend', 'frontend'], 'design-test': ['design'] };
  for (const [nodeId, targets] of Object.entries(adjacency)) {
    const tools = (await rpc(nodeId, 'tools/list')).result.tools;
    assert.deepEqual(tools.filter((tool: any) => tool.name.startsWith('edge_')).map((tool: any) => tool.title), targets.map(target => `${nodeId} → ${target}`));
    assert.deepEqual(tools.filter((tool: any) => !tool.name.startsWith('edge_')).map((tool: any) => tool.name), ['get_project_context', 'complete_task', 'update_workflow', 'get_delivery', 'read_history', 'request_review', 'get_review', 'search_project_items', 'get_project_item', 'update_project_item']);
  }
  assert.deepEqual(state.nodes, nodesBefore, 'graph setup must preserve all node definitions and capability selections');
  const running = async (taskId: string) => {
    await until(() => state.tasks.some((task: any) => task.id === taskId && task.status === 'running' && task.turnId));
    return state.tasks.find((task: any) => task.id === taskId);
  };
  const call = async (task: any, name: string, args: object) => {
    const body = await rpc(task.nodeId, 'tools/call', { name, arguments: args, _meta: { threadId: task.threadId, callId: `${task.id}-${name}`, 'x-codex-turn-metadata': { turn_id: task.turnId } } });
    assert.equal(body.error, undefined, JSON.stringify(body));
    assert.equal(body.result.isError, undefined, JSON.stringify(body));
    return body.result.structuredContent;
  };
  const send = async (task: any, target: string, requestId: string, content: unknown) => {
    const edge = state.edges.find((edge: any) => edge.sourceNodeId === task.nodeId && edge.targetNodeId === target);
    assert.ok(edge);
    const receipt = await call(task, edgeToolName(edge.id, target), { request_id: requestId, content, reason: edge.condition });
    assert.equal(state.messages.find((message: any) => message.message_id === receipt.message_id).toNodeId, target);
    return receipt;
  };
  const finish = async (task: any) => {
    f.clients[0].options.onEvent({ method: 'turn/completed', params: { threadId: task.threadId, turn: { id: task.turnId, status: 'completed', items: [] } } });
    await until(() => task.status === 'completed');
  };
  await f.send('product');
  await until(() => state.tasks[0]?.turnId);
  const product = state.tasks[0], requirementsInput = { text: 'Keep the exact input', values: [null, false, 0, '  whitespace\n'] };
  const requirementReceipt = await send(product, 'requirements', 'scope', requirementsInput);
  const replay = await send(product, 'requirements', 'scope', requirementsInput);
  assert.equal(replay.message_id, requirementReceipt.message_id);
  await finish(product);
  const requirements = await running(requirementReceipt.target_task_id);
  const designReceipt = await send(requirements, 'design', 'requirements-design', { requirements: requirementsInput });
  await finish(requirements);
  const design = await running(designReceipt.target_task_id);
  const designCheck = await send(design, 'design-test', 'design-check', 'UI v1: check against requirements');
  await finish(design);
  const designTester = await running(designCheck.target_task_id);
  const designReport = await send(designTester, 'design', 'design-report', 'Static design checks passed; interactive behavior unverified');
  await finish(designTester);
  const verifiedDesign = await running(designReport.target_task_id);
  assert.equal(verifiedDesign.threadId, design.threadId);
  const designSummary = await send(verifiedDesign, 'product', 'design-summary', { design: 'UI v1', report: designReport.message_id });
  await finish(verifiedDesign);
  const coordinator = await running(designSummary.target_task_id);
  assert.equal(coordinator.threadId, product.threadId);
  const architectureReceipt = await send(coordinator, 'architect', 'product-architect', { requirements: requirementsInput, design: 'UI v1', originalReport: designReport.message_id });
  await finish(coordinator);
  const architect = await running(architectureReceipt.target_task_id);
  const backendReceipt = await send(architect, 'backend', 'architecture-backend', 'Technical design and contract v1');
  const architectureFrontend = await send(architect, 'frontend', 'architecture-frontend', 'Technical design, contract and UI v1');
  await finish(architect);
  const backend = await running(backendReceipt.target_task_id);
  const backendOutput = await send(backend, 'frontend', 'backend-ready', 'API v1');
  await finish(backend);
  const architectureInput = await running(architectureFrontend.target_task_id);
  await finish(architectureInput);
  const frontend = await running(backendOutput.target_task_id);
  assert.equal(frontend.threadId, architectureInput.threadId);
  const release = await send(frontend, 'test', 'release-v1', 'Integrated build v1');
  await finish(frontend);
  const qa = await running(release.target_task_id);
  const defect = await send(qa, 'backend', 'backend-defect', { problem: 'API trims whitespace', release: release.message_id });
  await finish(qa);
  const repair = await running(defect.target_task_id);
  assert.equal(repair.threadId, backend.threadId);
  const fix = await send(repair, 'frontend', 'backend-fixed', { result: 'API v2 preserves whitespace', defect: defect.message_id });
  await finish(repair);
  const integration = await running(fix.target_task_id);
  assert.equal(integration.threadId, frontend.threadId);
  const retestReceipt = await send(integration, 'test', 'release-v2', { result: 'Integrated build v2', defect: defect.message_id });
  await finish(integration);
  const retest = await running(retestReceipt.target_task_id);
  assert.equal(retest.threadId, qa.threadId);
  const report = await send(retest, 'product', 'test-passed', { passed: true, version: 2 });
  await finish(retest);
  const acceptance = await running(report.target_task_id);
  assert.equal(acceptance.threadId, product.threadId);
  await call(acceptance, 'complete_task', { result: { accepted: true, basedOn: report.message_id } });
  await finish(acceptance);
  assert.equal(state.messages.length, 14);
  assert.ok(state.messages.every((message: any) => adjacency[message.fromNodeId as keyof typeof adjacency].includes(message.toNodeId)));
  assert.deepEqual(state.messages[0].request.content, requirementsInput);
  assert.ok(state.tasks.every((task: any) => task.status === 'completed'));
  assert.equal(new Set(state.nodes.map((node: any) => node.threads.codex)).size, 8);
  assert.deepEqual(state.nodes.map(({ threads, status, ...node }: any) => node), nodesBefore.map(({ threads, status, ...node }: any) => node));
});

test('the Web architect receives unified product definition and supplies both implementations through distinct native conversations', async t => {
  const f = await fixture(t, undefined, 'web-product'), owner = f.engine as any;
  const state = owner.states.get(f.projectId);
  await f.engine.command({ type: 'save_review_policy', projectId: f.projectId, policy: { ...state.reviewPolicy, checkpoints: [] } });
  const rpc = async (nodeId: string, method: string, params: object = {}) => {
    const identity = f.engine.nodeIdentity(f.projectId, nodeId);
    const response = await fetch(owner.gateway.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${identity.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 'architecture', method, params }) });
    assert.equal(response.status, 200); return await response.json() as any;
  };
  const tools = async (id: string) => (await rpc(id, 'tools/list')).result.tools as any[];
  assert.deepEqual((await tools('architect')).filter(tool => tool.name.startsWith('edge_')).map(tool => tool.title), ['architect → product', 'architect → backend', 'architect → frontend']);
  for (const node of ['frontend', 'backend']) assert.ok((await tools(node)).some(tool => tool.title === `${node} → architect`));
  const running = async (taskId: string) => { await until(() => state.tasks.some((task: any) => task.id === taskId && task.status === 'running' && task.turnId)); return state.tasks.find((task: any) => task.id === taskId); };
  const send = async (task: any, target: string, requestId: string, content: unknown) => {
    const tool = (await tools(task.nodeId)).find(tool => tool.title === `${task.nodeId} → ${target}`)!;
    const response = await rpc(task.nodeId, 'tools/call', { name: tool.name, arguments: { request_id: requestId, content, reason: '技术方案与实现职责交接' }, _meta: { threadId: task.threadId, callId: requestId, 'x-codex-turn-metadata': { turn_id: task.turnId } } });
    assert.equal(response.error, undefined, JSON.stringify(response)); assert.equal(response.result.isError, undefined, JSON.stringify(response));
    return response.result.structuredContent;
  };
  await f.send('product'); await until(() => !!state.tasks[0]?.turnId);
  const product = state.tasks[0], receipt = await send(product, 'architect', 'definition-ready', { rules: 'Preserve the original text', design: 'UI v1', testReport: 'Static checks passed' });
  const architect = await running(receipt.target_task_id);
  const contract = { version: 'v1', endpoint: '/message', whitespace: 'preserved' };
  const backendReceipt = await send(architect, 'backend', 'backend-design', contract);
  const frontendReceipt = await send(architect, 'frontend', 'frontend-design', contract);
  const backend = await running(backendReceipt.target_task_id), frontend = await running(frontendReceipt.target_task_id);
  assert.equal(new Set([product.threadId, architect.threadId, backend.threadId, frontend.threadId]).size, 4);
  const snapshot = (await f.engine.command({ type: 'snapshot', projectId: f.projectId })).snapshot.selected!;
  for (const receipt of [backendReceipt, frontendReceipt]) assert.deepEqual(snapshot.tasks.find(task => task.id === receipt.target_task_id)!.input, contract);
  const feedback = await send(backend, 'architect', 'contract-question', 'Clarify the error response');
  assert.equal(state.tasks.find((task: any) => task.id === feedback.target_task_id).nodeId, 'architect');
  for (const task of [product, architect, backend, frontend]) f.clients[0].options.onEvent({ method: 'turn/completed', params: { threadId: task.threadId, turn: { id: task.turnId, status: 'completed', items: [] } } });
  const reply = await running(feedback.target_task_id);
  assert.equal(reply.threadId, architect.threadId);
  f.clients[0].options.onEvent({ method: 'turn/completed', params: { threadId: reply.threadId, turn: { id: reply.turnId, status: 'completed', items: [] } } });
});

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
  assert.deepEqual((await tools('plan')).map(tool => tool.name), ['get_project_context', 'update_workflow', 'search_project_items', 'get_project_item', 'update_project_item']);
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
