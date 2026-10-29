import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, until } from './runtime-fixture.js';
import { writeFileSync, linkSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ComfyStore } from '../src/core/comfy-store.js';
import { ComfyService } from '../src/core/comfy-service.js';
import type { ComfyActor, GraphView } from '../src/shared/comfy.js';
import { mergeUpdate } from '../src/shared/snapshots.js';

const names = ['get_comfy_workflow', 'apply_comfy_workflow', 'restore_comfy_workflow', 'inspect_comfy_nodes', 'run_comfy_workflow', 'get_comfy_run', 'stop_comfy_run'];
async function rpc(f: Awaited<ReturnType<typeof fixture>>, nodeId: string, method: string, params: object = {}, token = f.engine.nodeIdentity(f.projectId, nodeId).token) {
  const response = await fetch((f.engine as any).gateway.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 'comfy', method, params }) });
  return { status: response.status, body: await response.json() as any };
}
test('Comfy tools are advertised only to granted assistants of trusted Comfy projects', async t => {
  const comfy = await fixture(t, undefined, 'comfyui'), ordinary = await fixture(t, undefined, 'web-product');
  const listed = (await rpc(comfy, 'comfy-assistant', 'tools/list')).body.result.tools.map((tool: any) => tool.name);
  assert.deepEqual(listed.filter((name: string) => names.includes(name)), names);
  const web = (await rpc(ordinary, 'product', 'tools/list')).body.result.tools.map((tool: any) => tool.name);
  assert.equal(web.some((name: string) => names.includes(name)), false);
  assert.equal(ordinary.engine.nodeIdentity(ordinary.projectId, 'product').tools.some(name => names.includes(name)), false);
  const identity = ordinary.engine.nodeIdentity(ordinary.projectId, 'product');
  await assert.rejects(ordinary.engine.invokeTool('get_comfy_workflow', {}, { identity: { ...identity, projectId: comfy.projectId, comfy: true, tools: ['get_comfy_workflow'] }, threadId: '', turnId: '', callId: '' }), /身份/);
  const node = (await ordinary.engine.command({ type: 'snapshot' })).snapshot.selected!.nodes[0];
  await assert.rejects(ordinary.engine.command({ type: 'save_node', projectId: ordinary.projectId, node: { ...node, tools: [...node.tools, 'get_comfy_workflow'] } }), /Comfy/);
});

test('Comfy grants delegate only owned tools and refresh the same native thread after revocation', async t => {
  const f = await fixture(t, undefined, 'comfyui');
  const first = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!.nodes[0];
  await f.engine.command({ type: 'save_node', projectId: f.projectId, node: { ...first, tools: ['get_project_context', 'update_workflow', 'get_comfy_workflow'] } });
  await f.send(first.id);
  await until(() => f.clients[0]?.calls.some(call => call.method === 'turn/start'));
  const task = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!.tasks[0];
  const meta = { threadId: task.threadId, callId: 'delegation-call', 'x-codex-turn-metadata': { turn_id: task.turnId } };
  const node = { id: 'helper', name: 'Helper', instructions: '', tools: ['get_comfy_workflow'], revision: 0, position: { x: 10, y: 10 }, resultSchema: {} };
  const save = async (args: object) => (await rpc(f, first.id, 'tools/call', { name: 'update_workflow', arguments: args, _meta: meta })).body;
  assert.equal((await save({ operation: 'save_node', request_id: 'delegate-read', node })).result.isError, undefined);
  assert((await rpc(f, node.id, 'tools/list')).body.result.tools.some((tool: any) => tool.name === 'get_comfy_workflow'));
  const denied = await save({ operation: 'save_node', request_id: 'delegate-write', node: { ...node, id: 'writer', tools: ['apply_comfy_workflow'] } });
  assert.equal(denied.result.isError, true);
  assert.equal((await save({ node: { ...node, id: 'legacy' } })).result.isError, true);
  f.clients[0].options.onEvent({ method: 'turn/completed', params: { threadId: task.threadId, turn: { id: task.turnId, status: 'completed', items: [] } } });
  await until(() => !(f.engine as any).states.get(f.projectId).tasks.some((task: any) => task.status === 'running'));
  const current = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!.nodes[0];
  await f.engine.command({ type: 'save_node', projectId: f.projectId, node: { ...current, tools: ['get_project_context', 'update_workflow'] } });
  await f.send(first.id);
  await until(() => f.clients[0].calls.filter(call => call.method === 'turn/start').length === 2);
  const resumed = f.clients[0].calls.find(call => call.method === 'thread/resume');
  assert.equal(resumed?.params.threadId, task.threadId); assert.equal(resumed?.params.excludeTurns, true);
  assert(f.clients[0].calls.some(call => call.method === 'thread/unsubscribe'));
  assert.match(resumed?.params.developerInstructions, /原生 ComfyUI/);
  const last = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!.tasks.at(-1)!;
  f.clients[0].options.onEvent({ method: 'turn/completed', params: { threadId: last.threadId, turn: { id: last.turnId, status: 'completed', items: [] } } });
});

test('Comfy MCP binds writes to current native task, rejects forged identities and captures bounded project files', async t => {
  let service: ComfyService, view: GraphView;
  const actors: ComfyActor[] = [];
  const f = await fixture(t, undefined, 'comfyui', { async closeProject() {}, async request(projectId, request, actor) { actors.push(actor); return service.handle(projectId, request, actor); } });
  const store = new ComfyStore(f.root, f.projectId);
  view = { observation: { projectId: f.projectId, instanceId: 'instance-1', tabId: 'tab-1', workflowId: 'graph-1', revision: 'revision-1' }, workflow: { nodes: [{ id: 1, title: 'before' }], links: [] }, selectedNodeIds: ['1'], subgraphPath: [] };
  service = new ComfyService(store, async request => {
    if (request.type === 'apply_graph') view = { ...view, workflow: request.workflow, observation: { ...view.observation, revision: 'revision-' + Date.now() } };
    return structuredClone(view);
  });
  t.after(() => service.close());
  let latest = (await f.engine.command({ type: 'snapshot', projectId: f.projectId })).snapshot;
  f.engine.subscribe(update => { latest = mergeUpdate(latest, update).snapshot ?? latest; });
  const nodeId = 'comfy-assistant';
  const call = async (name: string, args: object = {}, meta?: object) => (await rpc(f, nodeId, 'tools/call', { name, arguments: args, ...(meta ? { _meta: meta } : {}) })).body;
  const failed = (reply: any) => assert.ok(reply.error || reply.result?.isError, JSON.stringify(reply));
  const read = await call('get_comfy_workflow'); assert.deepEqual(read.result.structuredContent, view);
  const args = { observation: view.observation, request_id: 'edit-1', workflow: { ...view.workflow, nodes: [{ id: 1, title: 'after' }] } };
  failed(await call('apply_comfy_workflow', args));
  await f.send(nodeId);
  await until(() => latest.selected!.tasks[0]?.turnId != null);
  const task = latest.selected!.tasks[0];
  const meta = { threadId: task.threadId, callId: 'native-call-1', 'x-codex-turn-metadata': { turn_id: task.turnId } };
  for (const bad of [{ ...meta, threadId: 'another-thread' }, { ...meta, 'x-codex-turn-metadata': { turn_id: 'another-turn' } }, ...['', ' ', 'bad\ncall', 'bad\0call', 'x'.repeat(1001)].map(callId => ({ ...meta, callId }))]) failed(await call('apply_comfy_workflow', args, bad));
  for (const identityField of ['projectId', 'nodeId', 'actor', 'threadId', 'callId']) failed(await call('apply_comfy_workflow', { ...args, [identityField]: 'forged' }, meta));
  failed(await call('apply_comfy_workflow', { ...args, observation: { ...args.observation, projectId: 'foreign' } }, meta));
  failed(await call('apply_comfy_workflow', { ...args, observation: { ...args.observation, instanceId: 'old' }, request_id: 'old-instance' }, meta));
  assert.equal((view.workflow.nodes as any[])[0].title, 'before');
  const receipt = await call('apply_comfy_workflow', args, meta); assert.equal(receipt.result.isError, undefined, JSON.stringify(receipt));
  assert.deepEqual(actors.at(-1), { kind: 'codex', nodeId, threadId: task.threadId, turnId: task.turnId, callId: meta.callId });
  assert.equal((await call('get_comfy_workflow', {}, meta)).result.structuredContent.workflow.nodes[0].title, 'after');
  assert.deepEqual((await call('apply_comfy_workflow', args, meta)).result.structuredContent, receipt.result.structuredContent);
  const bytes = Buffer.from(JSON.stringify({ nodes: [{ id: 1, title: 'captured' }], links: [], extra: 'x'.repeat(1024 * 1024) }));
  writeFileSync(join(f.root, 'workflow.json'), bytes);
  const fileArgs = { observation: view.observation, request_id: 'file-1', workflow_path: 'workflow.json' };
  const captured = await call('apply_comfy_workflow', fileArgs, meta);
  assert.equal(captured.result.isError, undefined, JSON.stringify(captured));
  assert.deepEqual(captured.result.structuredContent.capture, { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  writeFileSync(join(f.root, 'bad.json'), '{'); writeFileSync(join(f.root, 'big.json'), Buffer.alloc(8 * 1024 * 1024 + 1));
  linkSync(join(f.root, 'workflow.json'), join(f.root, 'hardlink.json'));
  symlinkSync(f.root, join(f.root, 'linked'), 'junction');
  for (const workflow_path of ['../outside.json', 'C:/Windows/win.ini', 'bad.json', 'big.json', 'hardlink.json', 'linked/workflow.json']) failed(await call('apply_comfy_workflow', { ...fileArgs, request_id: 'bad-file', workflow_path }, meta));
  assert.equal((view.workflow.nodes as any[])[0].title, 'captured');
  failed(await call('get_comfy_workflow', {}, { ...meta, threadId: 'foreign' }));
  f.clients[0].options.onEvent({ method: 'turn/completed', params: { threadId: task.threadId, turn: { id: task.turnId, status: 'completed', items: [] } } });
  await until(() => latest.selected!.tasks[0].status === 'completed');
  failed(await call('apply_comfy_workflow', { ...args, request_id: 'ended' }, meta));
  const old = f.engine.nodeIdentity(f.projectId, nodeId), node = latest.selected!.nodes[0];
  await f.engine.command({ type: 'save_node', projectId: f.projectId, node: { ...node, tools: node.tools.filter(tool => !names.includes(tool)) } });
  assert.equal((await rpc(f, nodeId, 'tools/list', {}, old.token)).status, 401);
  assert.equal((await rpc(f, nodeId, 'tools/list')).body.result.tools.some((tool: any) => names.includes(tool.name)), false);
  failed(await call('get_comfy_workflow'));
});

test('pausing during asynchronous workflow capture rejects the write before host effect', async t => {
  let effects = 0;
  const f = await fixture(t, undefined, 'comfyui', { async closeProject() {}, async request() { effects++; throw Error('Unexpected host effect'); } });
  await f.send('comfy-assistant'); await until(() => f.clients[0]?.calls.some(call => call.method === 'turn/start'));
  const task = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!.tasks[0];
  writeFileSync(join(f.root, 'workflow.json'), JSON.stringify({ nodes: [], extra: 'x'.repeat(4 * 1024 * 1024) }));
  const pending = f.engine.invokeTool('apply_comfy_workflow', { observation: { projectId: f.projectId, instanceId: 'i', tabId: 't', workflowId: 'w', revision: 'r' }, request_id: 'capturing', workflow_path: 'workflow.json' }, { identity: f.engine.nodeIdentity(f.projectId, 'comfy-assistant'), threadId: task.threadId!, turnId: task.turnId!, callId: 'capture-call' });
  const rejected = assert.rejects(pending, /暂停|停止|结束/);
  await f.engine.command({ type: 'pause_node', projectId: f.projectId, nodeId: 'comfy-assistant' });
  await rejected; assert.equal(effects, 0);
});

test('run, query, stop and restore map only declared arguments to the independent host channel', async t => {
  const received: { request: any; actor: ComfyActor }[] = [];
  const f = await fixture(t, undefined, 'comfyui', { async closeProject() {}, async request(_project, request, actor) { received.push({ request, actor }); return { runtime: { status: 'unprepared' }, providers: [], recentRuns: [] }; } });
  await f.send('comfy-assistant'); await until(() => f.clients[0]?.calls.some(call => call.method === 'turn/start'));
  const task = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!.tasks[0];
  const observation = { projectId: f.projectId, instanceId: 'instance', tabId: 'tab', workflowId: 'workflow', revision: 'revision' };
  const meta = { threadId: task.threadId, callId: 'run-call', 'x-codex-turn-metadata': { turn_id: task.turnId } };
  for (const [name, args, expected] of [
    ['run_comfy_workflow', { request_id: 'run', observation }, { type: 'queue_graph', requestId: 'run', expected: observation }],
    ['get_comfy_run', { run_id: 'run-id' }, { type: 'read_run', runId: 'run-id' }],
    ['stop_comfy_run', { run_id: 'run-id', action: 'stop_waiting' }, { type: 'stop_run', runId: 'run-id', action: 'stop_waiting' }],
    ['restore_comfy_workflow', { request_id: 'restore', observation, version_id: 'version' }, { type: 'restore_graph', requestId: 'restore', expected: observation, versionId: 'version' }],
  ] as const) {
    const reply = (await rpc(f, 'comfy-assistant', 'tools/call', { name, arguments: args, _meta: meta })).body;
    assert.equal(reply.result.isError, undefined, JSON.stringify(reply)); assert.deepEqual(received.at(-1)!.request, expected);
    assert.equal(received.at(-1)!.actor.kind, name === 'get_comfy_run' ? 'user' : 'codex');
  }
  const context = (await rpc(f, 'comfy-assistant', 'tools/call', { name: 'get_project_context', arguments: {}, _meta: meta })).body.result.structuredContent;
  assert.equal(context.comfy.runtime.status, 'unprepared'); assert.ok(context.management_tools);
  f.clients[0].options.onEvent({ method: 'turn/completed', params: { threadId: task.threadId, turn: { id: task.turnId, status: 'completed', items: [] } } });
});
