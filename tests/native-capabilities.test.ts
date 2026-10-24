import assert from 'node:assert/strict';
import test from 'node:test';
import { loadRuntimeCapabilities } from '../src/core/catalog.js';
import type { CodexPort } from '../src/shared/types.js';
import { fixture, until } from './runtime-fixture.js';
import { join } from 'node:path';

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
