import assert from 'node:assert/strict';
import { request } from 'node:http';
import { after, before, test } from 'node:test';
import { startMcpGateway } from '../src/core/mcp.js';
import type { McpCallContext, McpGateway, McpIdentity, WorkflowTool } from '../src/shared/types.js';

const resultSchema = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false };
const identities: McpIdentity[] = [
  { token: 'test-author-token', projectId: 'project-a', nodeId: 'author', tools: ['get_project_context', 'handoff', 'complete_task', 'update_workflow'], resultSchema },
  { token: 'test-reader-token', projectId: 'project-b', nodeId: 'reader', tools: ['get_project_context'], resultSchema: { type: 'string' } },
];
const calls: { name: WorkflowTool; args: Record<string, unknown>; context: McpCallContext }[] = [];
let gateway: McpGateway;

before(async () => {
  gateway = await startMcpGateway({
    resolveIdentity: token => identities.find(identity => identity.token === token),
    invoke: async (name, args, context) => {
      if (context.turnId === 'expired-turn') throw new Error('Task no longer active.');
      calls.push({ name, args, context });
      return { accepted: true, nodeId: context.identity.nodeId };
    },
  });
});
after(async () => { await gateway?.close(); });

async function send(body: unknown, options: { token?: string | null; headers?: Record<string, string>; method?: string; path?: string; chunks?: string[] } = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  return await new Promise<{ status: number; body: string; json: any }>((resolve, reject) => {
    const req = request(new URL(options.path ?? '/mcp', gateway.url), {
      method: options.method ?? 'POST',
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
        resolve({ status: res.statusCode ?? 0, body: text, json });
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
const call = (name: WorkflowTool, args: Record<string, unknown> = {}, metadata: unknown = meta) => ({
  jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args, ...(metadata === undefined ? {} : { _meta: metadata }) },
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
    assert.deepEqual(response.json.result.tools.map((tool: any) => tool.name), identity.tools);
    for (const tool of response.json.result.tools) {
      if (tool.name === 'handoff' || tool.name === 'complete_task') assert.deepEqual(tool.inputSchema.properties.result, {});
    }
  }
  const concurrent = await Promise.all(identities.map(identity => send(list, { token: identity.token, headers: { 'Mcp-Session-Id': 'shared-client-session' } })));
  assert.deepEqual(concurrent.map(response => response.json.result.tools.map((tool: any) => tool.name)), [
    ['get_project_context', 'handoff', 'complete_task', 'update_workflow'], ['get_project_context'],
  ]);
  const response = await send(list);
  const schema = response.json.result.tools.find((tool: any) => tool.name === 'update_workflow').inputSchema.properties.node;
  assert.deepEqual(schema.required, ['id', 'name', 'instructions', 'revision', 'tools', 'resultSchema', 'position']);
  assert.equal(schema.properties.revision.minimum, 0);
  assert.deepEqual(schema.properties.tools.items.enum, ['get_project_context', 'handoff', 'complete_task', 'update_workflow']);
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
  for (const name of ['handoff', 'complete_task', 'update_workflow'] as const) {
    for (const metadata of invalid) {
      const response = await send(call(name, { result: { summary: 'done' } }, metadata));
      assert.ok(response.json.error || response.json.result.isError, `${name} accepted incomplete metadata`);
    }
  }
  assert.equal(calls.length, count);
});

test('object and JSON-string native Turn metadata reach the callback unchanged', async () => {
  for (const turnMetadata of [{ turn_id: 'turn-a', parent_turn_id: 'parent' }, '{"turn_id":"turn-a"}']) {
    const response = await send(call('handoff', { to_node_id: 'reviewer', task: 'review', reason: 'ready', result: { summary: 'draft' } }, { ...meta, 'x-codex-turn-metadata': turnMetadata }));
    assert.equal(response.status, 200);
    assert.deepEqual(response.json.result.structuredContent, { accepted: true, nodeId: 'author' });
    assert.deepEqual(calls.at(-1)?.context, { identity: identities[0], threadId: 'thread-a', turnId: 'turn-a', callId: 'call-a' });
    assert.equal(calls.at(-1)?.args.to_node_id, 'reviewer');
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
