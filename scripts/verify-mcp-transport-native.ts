import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createCodexClient } from '../src/core/codex.js';
import { startMcpGateway } from '../src/core/mcp.js';
import { insideProject, projectDirectory } from '../src/core/paths.js';
import type { McpIdentity, NativeEvent } from '../src/shared/types.js';

const executable = process.env.MIXCAT_CODEX, catalogPath = process.env.MIXCAT_MODEL_CATALOG;
if (!executable || !catalogPath) throw new Error('Set MIXCAT_CODEX and MIXCAT_MODEL_CATALOG (an existing native model catalog with Code Mode metadata).');
const model = JSON.parse(readFileSync(catalogPath, 'utf8')).models?.find((model: any) => model.tool_mode === 'code_mode_only');
if (!model) throw new Error('The supplied catalog has no Code Mode model.');
const root = mkdtempSync(join(projectDirectory(resolve('.'), '.runtime', 'implementation', 'mcp-transport'), 'native-check-'));
const home = projectDirectory(root, 'native-home'), catalog = insideProject(root, join(root, 'model-catalog.json'));
writeFileSync(catalog, JSON.stringify({ models: [{ ...model, slug: 'transport-fixture', display_name: 'Local transport fixture', use_responses_lite: false }] }));
writeFileSync(insideProject(root, join(home, 'config.toml')), `model_catalog_json = ${JSON.stringify(catalog)}\n`);

const identity: McpIdentity = { token: 'isolated-transport-fixture', projectId: 'probe', nodeId: 'probe', tools: ['get_project_item', 'update_project_item'], resultSchema: {} };
const invocations: { tool: string; requestId: unknown; hasNativeIdentity: boolean }[] = [], events: NativeEvent[] = [];
let lastCallAt = 0, requestIndex = 0, providerError: string | undefined;
const scripts = Array.from({ length: 17 }, (_, index) => index % 2
  ? `text(await tools.mcp__mixcat__update_project_item({request_id:'probe-${index}',operation:'create',kind:'todo',title:'Transport fixture ${index}'}));`
  : `text(await tools.mcp__mixcat__get_project_item({id:'probe-item'}));`);
scripts.push("const results = await Promise.all([tools.mcp__mixcat__get_project_item({id:'parallel-a'}), tools.mcp__mixcat__get_project_item({id:'parallel-b'})]); results.forEach(text);");
const gateway = await startMcpGateway({ resolveIdentity: token => token === identity.token ? identity : undefined, invoke: async (tool, args, context) => {
  lastCallAt = performance.now();
  invocations.push({ tool, requestId: args.request_id ?? null, hasNativeIdentity: !!(context.threadId && context.turnId && context.callId) });
  return { accepted: true, invocation: invocations.length };
} });
const provider = createServer(async (request, response) => {
  if (request.method !== 'POST' || !request.url?.endsWith('/responses')) { response.writeHead(404); response.end(); return; }
  try {
    for await (const _chunk of request) { /* Drain the local model request without retaining prompts. */ }
    const index = requestIndex++, code = scripts[index];
    if (index > 0 && index < 17) await delay(Math.max(0, 5990 - (performance.now() - lastCallAt)));
    const id = `response-${index}`, item = code === undefined
      ? { id: `message-${index}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'Transport verification complete.', annotations: [] }] }
      : { id: `call-${index}`, type: 'custom_tool_call', call_id: `transport-${index}`, name: 'exec', input: code, status: 'completed' };
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const emit = (type: string, fields: object) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
    emit('response.created', { response: { id, object: 'response', status: 'in_progress', output: [] } });
    emit('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress' } });
    emit('response.output_item.done', { output_index: 0, item });
    emit('response.completed', { response: { id, object: 'response', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
    response.end();
  } catch (error) { providerError = String(error); if (!response.headersSent) response.writeHead(500); response.end(); }
});
const client = createCodexClient({ executable, cwd: root, home, onEvent(event) { events.push(event); }, onDisconnect() {},
  onRequest(request) { client.reject?.(request.id, { code: -32601, message: 'Controlled local transport verification only' }); } });
try {
  await new Promise<void>((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve); });
  await client.connect();
  const thread = await client.rpc('thread/start', { cwd: root, sandbox: 'read-only', approvalPolicy: 'never', model: 'transport-fixture', config: {
    model_provider: 'fixture', model_providers: { fixture: { name: 'Local controlled Responses SSE', base_url: `http://127.0.0.1:${(provider.address() as { port: number }).port}`, wire_api: 'responses', requires_openai_auth: false } },
    mcp_servers: { mixcat: { url: gateway.url, http_headers: { Authorization: `Bearer ${identity.token}` }, required: true, default_tools_approval_mode: 'approve' } },
  } });
  const turn = await client.rpc('turn/start', { threadId: thread.thread.id, input: [{ type: 'text', text: 'Run the controlled local transport check.', text_elements: [] }] });
  let done: NativeEvent | undefined;
  for (let attempt = 0; attempt < 3600; attempt++) {
    done = events.find(event => event.method === 'turn/completed' && event.params.turn.id === turn.turn.id);
    if (done) break; await delay(50);
  }
  const calls = events.filter(event => event.method === 'item/completed' && event.params.item?.type === 'mcpToolCall').map(event => event.params.item);
  const failures = calls.filter(item => item.status !== 'completed' || item.error);
  const report = { native: client.info?.(), actualNative: true, realModel: false, modelProvider: 'local controlled Responses SSE', idleBoundaryMs: 5990,
    invocations, failures: failures.map(item => ({ tool: item.tool, status: item.status, error: item.error })), turnStatus: done?.params.turn.status, providerError };
  writeFileSync(insideProject(root, join(root, 'result.json')), JSON.stringify(report, null, 2));
  assert.equal(providerError, undefined); assert.equal(report.turnStatus, 'completed'); assert.equal(calls.length, 19); assert.equal(invocations.length, 19);
  assert.equal(failures.length, 0); assert.equal(invocations.filter(call => call.tool === 'update_project_item').length, 8);
  assert(invocations.filter(call => call.tool === 'update_project_item').every(call => call.hasNativeIdentity));
  assert.equal(new Set(invocations.filter(call => call.requestId).map(call => call.requestId)).size, 8);
  console.log(JSON.stringify({ passed: true, root, nativeVersion: client.info?.().version, calls: calls.length, writes: 8, failures: 0, realModel: false }));
} finally { await client.close(); await gateway.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); }
