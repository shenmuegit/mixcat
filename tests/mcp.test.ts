import assert from 'node:assert/strict';
import { Agent, request } from 'node:http';
import { after, before, test } from 'node:test';
import { edgeToolName, startMcpGateway, toolsFor } from '../src/core/mcp.js';
import type { McpCallContext, McpGateway, McpIdentity, WorkflowTool } from '../src/shared/types.js';
import { fixture, until } from './runtime-fixture.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { Ajv } from 'ajv';

const resultSchema = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false };
const identities: McpIdentity[] = [
  { token: 'test-author-token', projectId: 'project-a', nodeId: 'author', tools: ['get_project_context', 'handoff', 'complete_task', 'update_workflow'], resultSchema, edges: [{ id: 'author-reader', sourceNodeId: 'author', targetNodeId: 'reader', condition: 'Ready for the next node', revision: 1 }] },
  { token: 'test-reader-token', projectId: 'project-b', nodeId: 'reader', tools: ['get_project_context'], resultSchema: { type: 'string' } },
];
const calls: { name: WorkflowTool; args: Record<string, unknown>; context: McpCallContext }[] = [];
let gateway: McpGateway;

before(async () => {
  gateway = await startMcpGateway({
    resolveIdentity: token => identities.find(identity => identity.token === token),
    invoke: async (name, args, context) => {
      if (context.turnId === 'expired-turn') throw new Error('Task no longer active.');
      if (context.turnId === 'sdk-error-turn') throw new McpError(ErrorCode.InvalidParams, 'Legacy workflow validation failed.');
      calls.push({ name, args, context });
      return { accepted: true, nodeId: context.identity.nodeId };
    },
  });
});
after(async () => { await gateway?.close(); });

async function send(body: unknown, options: { token?: string | null; headers?: Record<string, string>; method?: string; path?: string; chunks?: string[]; agent?: Agent } = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  return await new Promise<{ status: number; body: string; json: any; connection: string | undefined; reusedSocket: boolean }>((resolve, reject) => {
    const req = request(new URL(options.path ?? '/mcp', gateway.url), {
      method: options.method ?? 'POST',
      agent: options.agent,
      headers: {
        'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
        ...(options.token !== null ? { Authorization: `Bearer ${options.token ?? identities[0].token}` } : {}),
        ...options.headers,
      },
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: unknown;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode ?? 0, body: text, json, connection: res.headers.connection, reusedSocket: req.reusedSocket });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (options.chunks) for (const chunk of options.chunks) req.write(chunk);
    else if (options.method !== 'GET') req.write(payload);
    req.end();
  });
}

const list = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
const meta = { threadId: 'thread-a', callId: 'call-a', 'x-codex-turn-metadata': { turn_id: 'turn-a' } };
const call = (name: string, args: Record<string, unknown> = {}, metadata: unknown = meta) => ({
  jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args, ...(metadata === undefined ? {} : { _meta: metadata }) },
});

test('invalid message work references report invalid parameters without creating a target task', async t => {
  const f = await fixture(t);
  await f.engine.command({ type: 'save_edge', projectId: f.projectId, edge: { id: 'work-reference', sourceNodeId: 'plan', targetNodeId: 'implement', condition: 'Ready', revision: 0 } });
  await f.send('plan'); await until(() => f.clients[0]?.calls.some(c => c.method === 'turn/start'));
  const start = f.clients[0].calls.find(c => c.method === 'thread/start')!, turn = f.clients[0].calls.find(c => c.method === 'turn/start')!;
  const server = start.params.config.mcp_servers.mixcat;
  const before = (await f.engine.command({ type: 'snapshot', projectId: f.projectId })).snapshot.selected!;
  const response = await fetch(server.url, { method: 'POST', headers: { ...server.http_headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify(call(edgeToolName('work-reference', 'implement'), {
    request_id: 'missing-reference', content: 'Please implement', reason: 'Ready', work_context: { primary_todo_id: 'missing-todo' },
  }, { threadId: turn.params.threadId, callId: 'reference-call', 'x-codex-turn-metadata': { turn_id: before.tasks[0].turnId } })) });
  assert.equal(response.status, 200);
  const body = await response.json();
  const error = body.result.structuredContent.error;
  assert.equal(error.code, ErrorCode.InvalidParams); assert.match(error.message, /工作关联/);
  const after = (await f.engine.command({ type: 'snapshot', projectId: f.projectId })).snapshot.selected!;
  assert.equal(after.tasks.length, before.tasks.length); assert.equal(after.messages?.length, before.messages?.length);
});

test('stateless MCP returns complete responses without offering expiring connections for reuse', async () => {
  const agent = new Agent({ keepAlive: true });
  try {
    const responses = [];
    for (const identity of [identities[0], identities[1], identities[0]]) {
      const response = await send(call('get_project_context'), { agent, token: identity.token });
      assert.equal(response.status, 200);
      assert.equal(response.json.result.structuredContent.nodeId, identity.nodeId);
      responses.push(response);
    }
    const denied = await send(list, { agent, token: 'unknown-token' });
    assert.equal(denied.status, 401); responses.push(denied);
    for (const response of responses) {
      assert.equal(response.connection, 'close', 'the peer must know this response ends the connection');
      assert.equal(response.reusedSocket, false, 'later calls must not reuse a socket at its idle expiry');
    }
  } finally { agent.destroy(); }
});

test('gateway binds a random IPv4 loopback port and requires a registered bearer token', async () => {
  const url = new URL(gateway.url);
  assert.equal(url.hostname, '127.0.0.1');
  assert.ok(Number(url.port) > 0);
  for (const token of [null, 'unknown-token']) {
    const response = await send(list, { token });
    assert.equal(response.status, 401);
  }
  assert.equal((await send(list, { headers: { Authorization: 'Basic invalid' } })).status, 401);
});

test('stateless tool discovery isolates tokens and accepts user-defined result content', async () => {
  const initialized = await send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  assert.equal(initialized.status, 200);
  for (const identity of [identities[0], identities[1], identities[0]]) {
    const response = await send(list, { token: identity.token });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json.result.tools.map((tool: any) => tool.name), toolsFor(identity).map(tool => tool.name));
    for (const tool of response.json.result.tools) {
      if (tool.name === 'handoff' || tool.name === 'complete_task') assert.deepEqual(tool.inputSchema.properties.result, {});
    }
  }
  const concurrent = await Promise.all(identities.map(identity => send(list, { token: identity.token, headers: { 'Mcp-Session-Id': 'shared-client-session' } })));
  assert.deepEqual(concurrent.map(response => response.json.result.tools.map((tool: any) => tool.name)), [
    ['get_project_context', 'complete_task', 'update_workflow', edgeToolName('author-reader', 'reader')], ['get_project_context'],
  ]);
  const response = await send(list);
  const schema = response.json.result.tools.find((tool: any) => tool.name === 'update_workflow').inputSchema.properties.node;
  assert.deepEqual(schema.required, ['id', 'name', 'instructions', 'revision', 'tools', 'resultSchema', 'position']);
  assert.equal(schema.properties.revision.minimum, 0);
  assert.deepEqual(schema.properties.tools.items.enum, ['get_project_context', 'handoff', 'complete_task', 'update_workflow', 'send_message', 'get_delivery', 'read_history', 'request_review', 'get_review', 'search_project_items', 'get_project_item', 'update_project_item']);
  const edit = response.json.result.tools.find((tool: any) => tool.name === 'update_workflow').inputSchema;
  assert.deepEqual(edit.oneOf[0].required, ['node']);
  assert.deepEqual(edit.oneOf[0].properties.node.properties.tools.items.enum, ['get_project_context', 'handoff', 'complete_task']);
  assert.deepEqual(edit.oneOf[1].required, ['operation', 'request_id', 'node']);
  assert.deepEqual(edit.oneOf[2].required, ['operation', 'request_id', 'edge']);
  assert.equal(edit.oneOf[1].properties.operation.const, 'save_node'); assert.equal(edit.oneOf[2].properties.operation.const, 'save_edge');
  assert.deepEqual(edit.properties.node.properties.model.type, ['string', 'null']);
  assert.deepEqual(edit.properties.node.properties.skills.items.required, ['name', 'path']);
  assert.deepEqual(edit.properties.node.properties.plugins.items.required, ['name', 'id']);
});

test('discovered workflow schema accepts optional native reasoning efforts including future identifiers', async () => {
  const discovered = await send(list);
  const schema = discovered.json.result.tools.find((tool: any) => tool.name === 'update_workflow').inputSchema;
  const validate = new Ajv({ strict: false }).compile(schema);
  const node = { id: 'new-node', name: 'New node', instructions: '', revision: 0, tools: ['get_project_context'], resultSchema: {}, position: { x: 0, y: 0 }, model: 'native-model' };
  for (const selection of [{ reasoningEffort: 'future-effort' }, { reasoningEffort: null }, {}]) {
    const request = { operation: 'save_node', request_id: 'reasoning-config', node: { ...node, ...selection } };
    assert.equal(validate(request), true, JSON.stringify(validate.errors));
    const response = await send(call('update_workflow', request));
    assert.equal(response.json.result.structuredContent.accepted, true);
  }
});

test('versioned workflow writes expose structured permission errors while legacy calls keep their shape', async () => {
  const request = { operation: 'save_edge', request_id: 'edge-request', edge: { id: 'edge', sourceNodeId: 'author', targetNodeId: 'reader', condition: '', revision: 0 } };
  for (const options of [{ metadata: {}, token: identities[0].token }, { metadata: meta, token: identities[1].token }]) {
    const response = await send(call('update_workflow', request, options.metadata), { token: options.token });
    assert.equal(response.json.result.isError, true); assert.equal(response.json.result.structuredContent.error.code, 'PERMISSION_DENIED');
  }
});

test('collaboration catalog exposes free JSON and optional read metadata only when authorized', async () => {
  const identity: McpIdentity = { token: 'collaboration-reader', projectId: 'project-a', nodeId: 'author', tools: ['send_message', 'get_delivery'], resultSchema: {}, edges: [{ id: 'choice', sourceNodeId: 'author', targetNodeId: 'reader', condition: 'Provide evidence', revision: 1 }] };
  identities.push(identity);
  try {
    const response = await send(list, { token: identity.token });
    assert.deepEqual(response.json.result.tools.map((tool: any) => tool.name), ['get_delivery', edgeToolName('choice', 'reader')]);
    const schema = response.json.result.tools[1].inputSchema;
    assert.deepEqual(schema.required, ['request_id', 'content', 'reason']); assert.deepEqual(schema.properties.content, {});
    const read = await send(call('get_delivery' as WorkflowTool, { request_id: 'accepted' }, {}), { token: identity.token });
    assert.equal(read.json.result.isError, undefined); assert.equal(calls.at(-1)?.context.turnId, '');
  } finally { identities.splice(identities.indexOf(identity), 1); }
});

test('tool calls cannot use a hidden tool or caller-supplied node identity', async () => {
  const count = calls.length;
  const response = await send(call('complete_task', { result: { summary: 'done' }, nodeId: 'author' }), { token: identities[1].token });
  assert.ok(response.json.error || response.json.result.isError);
  assert.equal(calls.length, count);
  const readable = await send(call('get_project_context', {}, {}), { token: identities[1].token });
  assert.deepEqual(readable.json.result.structuredContent, { accepted: true, nodeId: 'reader' });
  assert.equal(calls.at(-1)?.context.identity.projectId, 'project-b');
  assert.deepEqual([calls.at(-1)?.context.threadId, calls.at(-1)?.context.turnId, calls.at(-1)?.context.callId], ['', '', '']);
});

test('write calls require actual Thread, Turn and call metadata without inventing identifiers', async () => {
  const invalid = [
    {}, { ...meta, threadId: undefined }, { ...meta, callId: undefined },
    { ...meta, 'x-codex-turn-metadata': undefined }, { ...meta, threadId: '' },
    { ...meta, callId: 12 }, { ...meta, 'x-codex-turn-metadata': '{broken' },
    { ...meta, 'x-codex-turn-metadata': { turn_id: '' } },
    { ...meta, 'x-codex-turn-metadata': { turnId: 'invented' } },
  ];
  const count = calls.length;
  for (const name of [edgeToolName('author-reader', 'reader'), 'complete_task', 'update_workflow']) {
    for (const metadata of invalid) {
      const response = await send(call(name, { result: { summary: 'done' } }, metadata));
      assert.ok(response.json.error || response.json.result.isError, `${name} accepted incomplete metadata`);
    }
  }
  assert.equal(calls.length, count);
});

test('object and JSON-string native Turn metadata reach the callback unchanged', async () => {
  for (const turnMetadata of [{ turn_id: 'turn-a', parent_turn_id: 'parent' }, '{"turn_id":"turn-a"}']) {
    const response = await send(call(edgeToolName('author-reader', 'reader'), { request_id: 'bound', reason: 'ready', content: { summary: 'draft' } }, { ...meta, 'x-codex-turn-metadata': turnMetadata }));
    assert.equal(response.status, 200);
    assert.deepEqual(response.json.result.structuredContent, { accepted: true, nodeId: 'author' });
    assert.deepEqual(calls.at(-1)?.context, { identity: identities[0], threadId: 'thread-a', turnId: 'turn-a', callId: 'call-a', edge: identities[0].edges![0] });
    assert.equal(calls.at(-1)?.args.to_node_id, 'reader');
  }
});

test('authority callback rejection is an MCP tool error and cannot become a successful receipt', async () => {
  const count = calls.length;
  const response = await send(call('complete_task', { result: { summary: 'done' } }, { ...meta, 'x-codex-turn-metadata': { turn_id: 'expired-turn' } }));
  assert.equal(response.json.result.isError, true);
  assert.match(response.json.result.content[0].text, /Task no longer active/);
  assert.equal(response.json.result.structuredContent, undefined);
  assert.equal(calls.length, count);
  assert.equal((await send(list)).status, 200);
});

test('legacy invocation SDK errors retain the existing tool error response', async () => {
  const response = await send(call('complete_task', { result: 0 }, { ...meta, 'x-codex-turn-metadata': { turn_id: 'sdk-error-turn' } }));
  assert.equal(response.json.error, undefined);
  assert.equal(response.json.result.isError, true); assert.equal(response.json.result.structuredContent, undefined);
  assert.match(response.json.result.content[0].text, /Legacy workflow validation failed/);
});

test('gateway rejects foreign Host or Origin, unsupported content types, methods and routes', async () => {
  const invalidHeaders: Record<string, string>[] = [{ Host: 'attacker.invalid' }, { Host: 'localhost:1234' }, { Origin: 'https://attacker.invalid' }, { Origin: 'null' }];
  for (const headers of invalidHeaders) {
    assert.equal((await send(list, { headers })).status, 403);
  }
  assert.equal((await send(list, { headers: { Origin: new URL(gateway.url).origin } })).status, 200);
  assert.equal((await send(list, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await send(list, { headers: { 'Content-Type': 'application/json; charset=utf-8' } })).status, 200);
  assert.equal((await send(list, { method: 'GET' })).status, 405);
  assert.equal((await send(list, { path: '/other' })).status, 404);
  assert.equal((await send('{invalid')).status, 400);
});

test('one megabyte limit rejects both declared and streamed oversized bodies before invocation', async () => {
  const count = calls.length;
  const oversized = ' '.repeat(1024 * 1024 + 1);
  assert.equal((await send(oversized, { headers: { 'Content-Length': String(Buffer.byteLength(oversized)) } })).status, 413);
  assert.equal((await send('', { chunks: [' '.repeat(1024 * 1024), ' '] })).status, 413);
  const encoded = JSON.stringify(list);
  assert.equal((await send(encoded + ' '.repeat(1024 * 1024 - Buffer.byteLength(encoded)))).status, 200);
  assert.equal(calls.length, count);
});

test('real local MCP HTTP preserves arbitrary business content through planning, execution, review, return and re-review', async t => {
  const f = await fixture(t);
  for (const [from, to] of [['plan', 'implement'], ['implement', 'review'], ['review', 'implement']]) await f.engine.command({ type: 'save_edge', projectId: f.projectId, edge: { id: `${from}-${to}`, sourceNodeId: from, targetNodeId: to, condition: 'Agent chooses from the configured conditions', revision: 0 } });
  await f.send('plan');
  await until(() => f.clients[0]?.calls.some(call => call.method === 'turn/start') ?? false);
  const endpoint = f.clients[0].calls.find(call => call.method === 'thread/start')!.params.config.mcp_servers.mixcat.url;
  const snapshot = async () => (await f.engine.command({ type: 'snapshot', projectId: f.projectId })).snapshot.selected!;
  async function invoke(nodeId: string, name: string, args: Record<string, unknown>, source: { threadId: string | null; turnId: string | null }, callId: string, discardReceipt = false) {
    const identity = f.engine.nodeIdentity(f.projectId, nodeId);
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${identity.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: callId, method: 'tools/call', params: { name, arguments: args, _meta: { threadId: source.threadId, callId, 'x-codex-turn-metadata': { turn_id: source.turnId } } } }) });
    assert.equal(response.status, 200);
    if (discardReceipt) { await response.body?.cancel(); return; }
    const body = await response.json();
    assert.equal(body.error, undefined); assert.equal(body.result.isError, undefined, body.result.content[0]?.text);
    return body.result.structuredContent;
  }
  const route = ['plan', 'implement', 'review', 'implement', 'review'];
  const results = [{ userField: '任意业务字段', nested: [null, true, { evidence: 7 }] }, '正文\n保留全部原文', ['反馈', { repair: false, unknownField: 12 }], { revision: 2, checks: ['复核'], custom: null }];
  for (let step = 0; step < route.length; step++) {
    await until(() => f.clients[0].calls.filter(call => call.method === 'turn/start').length === step + 1);
    const state = await snapshot(), source = state.tasks.findLast(task => task.nodeId === route[step] && task.status === 'running')!;
    assert(source.turnId); const context = await invoke(source.nodeId, 'get_project_context', {}, source, `context-${step}`);
    if (step > 0) assert.deepEqual(context.task.input, results[step - 1]);
    const args = step < 4 ? { request_id: `message-${step}`, reason: 'fixture selects an available edge', content: results[step] } : { result: false };
    const tool = step < 4 ? edgeToolName(`${source.nodeId}-${route[step + 1]}`, route[step + 1]) : 'complete_task';
    await invoke(source.nodeId, tool, args, source, `write-${step}`, true);
    const receipt = await invoke(source.nodeId, tool, args, source, `write-${step}`);
    assert.equal(receipt.accepted, true);
    assert.deepEqual(await invoke(source.nodeId, tool, args, source, `write-${step}`), receipt, 'duplicate / lost ACK returns the committed receipt');
    f.clients[0].options.onEvent({ method: 'turn/completed', params: { threadId: source.threadId, turn: { id: source.turnId, status: 'completed', items: [] } } });
    assert.deepEqual(await invoke(source.nodeId, tool, args, source, `write-${step}`), receipt, 'late HTTP replay cannot create another receiver');
  }
  const final = await snapshot();
  assert.equal(final.project.status, 'completed'); assert.equal(final.tasks.length, 5); assert.equal(final.handoffs.length, 0);
  assert.deepEqual(final.tasks.map(task => task.nodeId), route);
  const state = (f.engine as any).states.get(f.projectId);
  assert.deepEqual(state.messages.map((message: any) => message.request.content), results);
  assert.deepEqual(final.tasks.slice(1).map(task => task.input), results);
  assert.equal(final.tasks.at(-1)!.result, false);
  assert.equal(f.clients[0].calls.filter(call => call.method === 'turn/start').length, 5);
});
