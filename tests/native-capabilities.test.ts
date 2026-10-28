import assert from 'node:assert/strict';
import test from 'node:test';
import { loadRuntimeCapabilities } from '../src/core/catalog.js';
import type { CodexPort } from '../src/shared/types.js';
import { fixture, until } from './runtime-fixture.js';
import { join } from 'node:path';
import { WorkflowEngine } from '../src/core/engine.js';
import { projectDirectory } from '../src/core/paths.js';
import { accountFixture } from './account-fixture.js';

test('configuration discovery after restart does not inspect or resume a saved paused Thread', async t => {
  const f = await fixture(t);
  await f.send('plan');
  await until(() => f.clients[0]?.calls.some(call => call.method === 'turn/start'));
  const task = (await f.engine.command({ type: 'snapshot', projectId: f.projectId })).snapshot.selected!.tasks[0];
  f.clients[0].options.onEvent({ method: 'turn/completed', params: { threadId: task.threadId, turn: { id: task.turnId, status: 'completed', items: [] } } });
  const completed = (await f.engine.command({ type: 'snapshot', projectId: f.projectId })).snapshot.selected!;
  assert.equal(completed.tasks[0].status, 'completed');
  const saved = completed.nodes.find(node => node.id === 'plan')!;
  await f.engine.command({ type: 'save_node', projectId: f.projectId, node: { ...saved, model: 'chosen', skills: [{ name: 'Selected skill', path: 'selected-skill' }], plugins: [{ name: 'Selected plugin', id: 'selected@local' }] } });
  await f.engine.command({ type: 'pause_node', projectId: f.projectId, nodeId: 'plan' });
  await f.engine.close();

  const calls: string[] = [];
  let modelFailure = false;
  const engine = new WorkflowEngine({ workbenchRoot: f.root, executable: 'fixture', accountFactory: accountFixture().factory, nativeFactory: () => ({
    async connect() {}, async close() {}, async rpc(method, params) {
      calls.push(method);
      if (method === 'model/list') { if (modelFailure) throw Error('Model catalog unavailable'); return { data: [{ model: 'chosen', displayName: 'Chosen model' }], nextCursor: null }; }
      if (method === 'skills/list') return { data: [{ skills: [{ name: 'Catalog skill', path: 'catalog-skill', enabled: true }] }] };
      if (method === 'plugin/installed') return { marketplaces: [{ plugins: [{ id: 'catalog@local', name: 'Catalog plugin', installed: true, enabled: true }] }] };
      if (method === 'mcpServerStatus/list') throw Error(`thread not found: ${params.threadId}`);
      throw Error(`Unexpected native RPC: ${method}`);
    },
  }) });
  t.after(() => engine.close()); await engine.init();
  const before = (await engine.command({ type: 'snapshot', projectId: f.projectId })).snapshot.selected!;
  assert.equal(before.nodes.find(node => node.id === 'plan')!.status, 'paused');
  assert.equal(before.nodes.find(node => node.id === 'plan')!.threadId, task.threadId);
  for (const nodeId of ['plan', 'implement', undefined]) {
    calls.length = 0;
    const reply = await engine.command({ type: 'catalog', projectId: f.projectId, ...(nodeId ? { nodeId } : {}) });
    assert.deepEqual(reply.catalog!.errors, []);
    assert.deepEqual(reply.catalog!.models, [{ id: 'chosen', name: 'Chosen model', isDefault: false }]);
    assert.equal(reply.catalog!.skills[0].name, 'Catalog skill');
    assert.equal(reply.catalog!.plugins[0].id, 'catalog@local');
    assert.deepEqual(calls.sort(), ['model/list', 'plugin/installed', 'skills/list']);
  }
  const after = (await engine.command({ type: 'snapshot', projectId: f.projectId })).snapshot.selected!;
  for (const key of ['nodes', 'tasks', 'conversation'] as const) assert.deepEqual(after[key], before[key]);

  calls.length = 0;
  await assert.rejects(engine.command({ type: 'catalog', projectId: f.projectId, nodeId: 'missing-node' }), /节点不存在/);
  assert.deepEqual(calls, []);
  modelFailure = true;
  const partial = (await engine.command({ type: 'catalog', projectId: f.projectId, nodeId: 'plan' })).catalog!;
  assert.deepEqual(partial.models, []);
  assert(partial.errors.includes('model/list: Model catalog unavailable'));
  assert.equal(partial.skills.length, 1); assert(partial.plugins.some(plugin => plugin.id === 'catalog@local'));

  modelFailure = false;
  const web = await engine.command({ type: 'create_project', root: projectDirectory(f.root, 'web'), name: 'Web fixture', goal: 'Catalog discovery', template: 'web-product' });
  const webId = web.snapshot.selected!.project.id;
  for (const nodeId of ['product', undefined]) {
    calls.length = 0;
    const catalog = (await engine.command({ type: 'catalog', projectId: webId, ...(nodeId ? { nodeId } : {}) })).catalog!;
    assert.deepEqual(catalog.errors, []);
    assert.equal(catalog.models[0].id, 'chosen');
    assert.deepEqual(calls.sort(), ['model/list', 'plugin/installed', 'skills/list']);
  }
});

test('runtime capability inspection keeps native hook trust and thread MCP state distinct from installation', async () => {
  const calls: any[] = [];
  const client: CodexPort = { async connect() {}, async close() {}, async rpc(method, params) {
    calls.push({ method, params });
    if (method === 'hooks/list') return { data: [{ hooks: [{ eventName: 'userPromptSubmit', enabled: true, trustStatus: 'untrusted', sourcePath: 'G:/project/.codex/hooks.json', key: 'actual-hook-key', currentHash: 'actual-hash' }], errors: [], warnings: [] }] };
    return params.cursor ? { data: [{ name: 'browser', runtimeStatus: 'failed', tools: {}, toolsError: 'fixture failure' }], nextCursor: null } : { data: [{ name: 'gitnexus', runtimeStatus: 'connected', tools: { query: {} } }], nextCursor: 'page-2' };
  } };
  const result = await loadRuntimeCapabilities(client, 'G:/project', 'thread-frontend');
  assert.equal(result.hooks[0].trustStatus, 'untrusted');
  assert.deepEqual(result.mcpServers, [{ name: 'gitnexus', status: 'connected', toolCount: 1 }, { name: 'browser', status: 'failed', toolCount: 0 }]);
  assert(calls.filter(call => call.method === 'mcpServerStatus/list').every(call => call.params.threadId === 'thread-frontend'));
  assert(result.errors.some(error => error.includes('browser')));
});

test('unknown native APIs preserve successful sources and never convert unknown connection into ready', async () => {
  const client: CodexPort = { async connect() {}, async close() {}, async rpc(method) {
    if (method === 'hooks/list') throw new Error('Unsupported native API');
    return { data: [{ name: 'not-started', tools: { remembered: {} } }], nextCursor: null };
  } };
  const result = await loadRuntimeCapabilities(client, 'G:/project');
  assert.deepEqual(result.hooks, []);
  assert.equal(result.mcpServers[0].status, 'unknown');
  assert(result.errors.some(error => error.includes('hooks/list')));
});

test('explicit user hook review uses the native trust RPC and verifies its path and current hash', async t => {
  const f = await fixture(t);
  await f.engine.command({ type: 'connect', projectId: f.projectId });
  const client = f.clients[0].port, original = client.rpc.bind(client);
  let trusted = false, writes = 0;
  client.rpc = async (method, params) => {
    if (method === 'hooks/list') return { data: [{ cwd: f.root, hooks: [{ eventName: 'userPromptSubmit', enabled: true, key: 'reviewed-key', currentHash: 'reviewed-hash', trustStatus: trusted ? 'trusted' : 'untrusted', sourcePath: join(f.root, '.codex', 'hooks.json'), command: 'fixture-reviewed-command' }], errors: [], warnings: [] }] };
    if (method === 'config/batchWrite') {
      assert.deepEqual(JSON.parse(JSON.stringify(params)), { edits: [{ keyPath: 'hooks.state', value: { 'reviewed-key': { trusted_hash: 'reviewed-hash' } }, mergeStrategy: 'upsert' }], filePath: null, expectedVersion: null, reloadUserConfig: true });
      writes++; trusted = true; return { filePath: join(f.root, '.mixcat', 'codex', 'config.toml'), status: 'ok', version: 'fixture-version' };
    }
    return original(method, params);
  };
  await assert.rejects(f.engine.command({ type: 'trust_hooks', projectId: f.projectId, hooks: [{ key: 'reviewed-key', currentHash: 'stale-hash' }] }), /变化/);
  assert.equal(writes, 0);
  const result = await f.engine.command({ type: 'trust_hooks', projectId: f.projectId, hooks: [{ key: 'reviewed-key', currentHash: 'reviewed-hash' }] });
  assert.equal(writes, 1);
  assert.equal(result.catalog!.hooks![0].trustStatus, 'trusted');
});

test('native hook lifecycle observations are persisted in the owning node history instead of inferred from text', async t => {
  const f = await fixture(t);
  await f.send('plan');
  await until(() => f.clients[0]?.calls.some(call => call.method === 'turn/start'));
  const client = f.clients[0];
  const call = client.calls.find(call => call.method === 'turn/start')!;
  const threadId = call.params.threadId;
  client.options.onEvent({ method: 'hook/started', params: { threadId, turnId: null, run: { id: 'hook-run-1', eventName: 'userPromptSubmit', status: 'running', entries: [] } } });
  client.options.onEvent({ method: 'hook/completed', params: { threadId, turnId: null, run: { id: 'hook-run-1', eventName: 'userPromptSubmit', status: 'completed', entries: [{ kind: 'context', text: 'Actual hook context' }] } } });
  const snapshot = (await f.engine.command({ type: 'snapshot', projectId: f.projectId })).snapshot.selected!;
  const entry = snapshot.conversation!.find(entry => entry.itemId === 'hook:hook-run-1')!;
  assert.equal(entry.nodeId, 'plan');
  assert.equal((entry.content as any).run.status, 'completed');
  assert.equal((entry.content as any).run.entries[0].text, 'Actual hook context');
  assert.equal(snapshot.activities.filter(activity => activity.kind === 'hook:hook-run-1').length, 1);
});
