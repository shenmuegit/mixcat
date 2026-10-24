import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createCodexClient } from '../src/core/codex.js';
import { edgeToolName, startMcpGateway } from '../src/core/mcp.js';
import { projectDirectory } from '../src/core/paths.js';
import type { McpIdentity, NativeEvent } from '../src/shared/types.js';

const executable = process.env.MIXCAT_CODEX ?? process.env.CODEX_APP_RUNTIME_CLI_PATH;
if (!executable) throw new Error('Set MIXCAT_CODEX to the native Codex executable.');
const root = mkdtempSync(join(projectDirectory(resolve('.'), '.runtime', 'implementation'), 'dynamic-edge-native-'));
const identities: McpIdentity[] = ['a', 'b'].map(nodeId => ({ token: `isolated-fixture-${nodeId}`, projectId: 'probe', nodeId, tools: ['get_project_context'], resultSchema: {}, edges: [] }));
identities[1].edges = [{ id: 'b-a', sourceNodeId: 'b', targetNodeId: 'a', condition: 'B 独有的条件', revision: 1 }];
const requests: any[] = [], events: NativeEvent[] = [];
const provider = createServer(async (req, res) => {
  if (req.method !== 'POST' || !req.url?.endsWith('/responses')) { res.writeHead(404); res.end(); return; }
  try {
    let text = ''; for await (const chunk of req) text += chunk;
    requests.push(JSON.parse(text));
    const id = `response-${requests.length}`, item = { id: `message-${requests.length}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'Discovery probe complete.', annotations: [] }] };
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const emit = (type: string, fields: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
    emit('response.created', { response: { id, object: 'response', status: 'in_progress', output: [] } });
    emit('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
    emit('response.content_part.added', { output_index: 0, content_index: 0, item_id: item.id, part: { type: 'output_text', text: '', annotations: [] } });
    emit('response.output_text.delta', { output_index: 0, content_index: 0, item_id: item.id, delta: 'Discovery probe complete.' });
    emit('response.output_item.done', { output_index: 0, item });
    emit('response.completed', { response: { id, object: 'response', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
    res.end();
  } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
});
await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
const port = (provider.address() as { port: number }).port;
const gateway = await startMcpGateway({ resolveIdentity: token => identities.find(identity => identity.token === token), invoke: async () => ({}) });
const client = createCodexClient({ executable, cwd: root, home: projectDirectory(root, 'native-home'), onEvent(event) { events.push(event); }, onDisconnect() {}, onRequest(request) { client.reject?.(request.id, { code: -32601, message: 'Discovery probe only' }); } });
const session = (identity: McpIdentity) => ({ cwd: root, sandbox: 'read-only', approvalPolicy: 'never', model: 'fixture', config: {
  model_provider: 'fixture', model_providers: { fixture: { name: 'Local discovery fixture', base_url: `http://127.0.0.1:${port}`, wire_api: 'responses', requires_openai_auth: false } },
  mcp_servers: { mixcat: { url: gateway.url, http_headers: { Authorization: `Bearer ${identity.token}` }, required: true, default_tools_approval_mode: 'approve' } },
} });
const captures: { threadId: string; tools: string[]; nativeTools: string[]; priorAssistant: boolean }[] = [];
try {
  await client.connect();
  const threads: string[] = [];
  for (const identity of identities) threads.push((await client.rpc('thread/start', session(identity))).thread.id);
  const run = async (index: number) => {
    const threadId = threads[index], count = requests.length;
    const response = await client.rpc('turn/start', { threadId, input: [{ type: 'text', text: 'Return one short sentence.', text_elements: [] }] });
    let finished = false;
    for (let i = 0; i < 200; i++) {
      const done = events.find(event => event.method === 'turn/completed' && event.params.turn.id === response.turn.id);
      if (done) { assert.equal(done.params.turn.status, 'completed', JSON.stringify(done)); finished = true; break; }
      await delay(50);
    }
    assert(finished, 'Native Turn must finish'); assert.equal(requests.length, count + 1);
    const request = requests.at(-1), tools = request.tools as any[];
    captures.push({ threadId, tools: tools.find(tool => tool.name === 'mcp__mixcat')?.tools.map((tool: any) => tool.name).sort() ?? [],
      nativeTools: tools.filter(tool => tool.name !== 'mcp__mixcat').map(tool => tool.name ?? tool.type).sort(), priorAssistant: JSON.stringify(request.input).includes('Discovery probe complete.') });
  };
  await run(0); await run(1);
  identities[0].edges = [{ id: 'a-b', sourceNodeId: 'a', targetNodeId: 'b', condition: '新加入的条件', revision: 1 }];
  await client.rpc('thread/unsubscribe', { threadId: threads[0] });
  await client.rpc('thread/resume', { threadId: threads[0], excludeTurns: true, ...session(identities[0]) });
  await run(0);
  identities[0].edges = [];
  await client.rpc('thread/unsubscribe', { threadId: threads[0] });
  await client.rpc('thread/resume', { threadId: threads[0], excludeTurns: true, ...session(identities[0]) });
  await run(0); await run(1);
  assert.deepEqual(captures.map(capture => capture.tools), [
    ['get_project_context'], [edgeToolName('b-a', 'a'), 'get_project_context'].sort(),
    [edgeToolName('a-b', 'b'), 'get_project_context'].sort(), ['get_project_context'], [edgeToolName('b-a', 'a'), 'get_project_context'].sort(),
  ]);
  assert(captures[2].priorAssistant && captures[3].priorAssistant, 'Refreshing tools must retain the original Thread history');
  assert(captures[0].nativeTools.includes('exec_command'));
  for (const capture of captures) assert.deepEqual(capture.nativeTools, captures[0].nativeTools, 'Native capabilities must be preserved');
  writeFileSync(join(root, 'result.json'), JSON.stringify({ passed: true, native: client.info?.(), captures, actualNative: true, realModel: false, modelProvider: 'local controlled Responses SSE' }, null, 2));
  console.log(JSON.stringify({ passed: true, root, version: client.info?.().version, threadCount: threads.length, requestCount: requests.length, realModel: false }));
} finally { await client.close(); await gateway.close(); await new Promise<void>(resolve => provider.close(() => resolve())); }
