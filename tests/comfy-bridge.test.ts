import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { projectDirectory } from '../src/core/paths.js';
import { ComfyStore } from '../src/core/comfy-store.js';
import type { GraphView } from '../src/shared/comfy.js';
import { ComfyRpc } from '../src/core/comfy-rpc.js';
import { ComfyService } from '../src/core/comfy-service.js';
import { validateRpcRequest } from '../src/shared/comfy-bridge.js';
import { authorizeComfyGuest, authorizeComfyHandshake } from '../src/desktop/comfy-policy.js';

const before: GraphView = { observation: { projectId: 'p', instanceId: 'i', workflowId: 'w', tabId: 't', revision: '1' }, workflow: { nodes: [] }, subgraphPath: [], selectedNodeIds: [] };
test('staged graph edits survive restart with an explicit recoverable before version', () => {
  const root = mkdtempSync(join(projectDirectory(resolve('.'), '.runtime', 'implementation', 'fixtures'), 'comfy-bridge-'));
  let store = new ComfyStore(root, 'p');
  store.beginOperation('edit', 'fingerprint');
  const staged = store.stageEdit('edit', before, { nodes: [{ id: 1 }] });
  assert.deepEqual(store.readVersion(staged.beforeVersionId), { nodes: [] });
  store.close(); store = new ComfyStore(root, 'p');
  try {
    assert.deepEqual(store.recoverableEdits(), [staged]);
    assert.throws(() => store.stageEdit('edit', before, { nodes: [{ id: 1 }] }), /恢复|recovery/i);
    const receipt = store.finishEdit('edit', { ...before, observation: { ...before.observation, revision: '2' }, workflow: { nodes: [{ id: 1, normalized: true }] } });
    assert.equal(receipt.beforeVersionId, staged.beforeVersionId);
    assert.deepEqual(store.readVersion(receipt.afterVersionId), { nodes: [{ id: 1, normalized: true }] });
    assert.deepEqual(store.recoverableEdits(), []);
  } finally { store.close(); }
});

test('reverse RPC rejects wrong project, late responses, replacement and oversize messages', async () => {
  const sent: any[] = [], rpc = new ComfyRpc(message => sent.push(message), 20);
  const first = rpc.request('p', { type: 'read_graph' });
  assert.equal(rpc.receive({ ...sent[0], type: 'comfy_reply', projectId: 'other', result: before }), false);
  await assert.rejects(first, /超时/);
  const second = rpc.request('p', { type: 'read_graph' });
  assert.equal(rpc.receive({ ...sent[0], type: 'comfy_reply', result: before }), false);
  rpc.invalidate(); await assert.rejects(second, /失效/);
  assert.equal(rpc.receive({ ...sent[1], type: 'comfy_reply', result: before }), false);
  await assert.rejects(rpc.request('p', { type: 'apply_graph', requestId: 'large', expected: before.observation, workflow: { text: 'x'.repeat(8 * 1024 * 1024) } }), /大小/);
  const third = rpc.request('p', { type: 'read_graph' });
  assert.equal(rpc.receive({ ...sent[2], type: 'comfy_reply', result: before, error: 'ambiguous' }), false);
  assert.equal(rpc.receive({ ...sent[2], type: 'comfy_reply', result: { text: 'x'.repeat(8 * 1024 * 1024) } }), false);
  assert.equal(rpc.receive({ ...sent[2], type: 'comfy_reply', result: before }), true);
  assert.deepEqual(await third, before);
});

test('service stages before visible mutation, commits normalized readback and explicitly restores', async () => {
  const root = mkdtempSync(join(projectDirectory(resolve('.'), '.runtime', 'implementation', 'fixtures'), 'comfy-service-'));
  const store = new ComfyStore(root, 'p'); let current = structuredClone(before), mutations = 0;
  const service = new ComfyService(store, async request => {
    if (request.type === 'apply_graph') {
      assert(store.recoverableEdits().some(edit => edit.requestId === request.requestId));
      mutations++;
      current = { ...current, observation: { ...current.observation, revision: String(mutations + 1) }, workflow: { ...request.workflow, nativeNormalized: true } };
    }
    return structuredClone(current);
  });
  try {
    const request = { type: 'apply_graph' as const, requestId: 'one', expected: before.observation, workflow: { nodes: [{ id: 1 }] } };
    await assert.rejects(service.handle('p', { ...request, workflow: { text: 'x'.repeat(8 * 1024 * 1024) } }, { kind: 'user' }), /大小/); assert.equal(mutations, 0);
    const receipt = await service.handle('p', request, { kind: 'user' }); assert('beforeVersionId' in receipt);
    assert.deepEqual(store.readVersion(receipt.afterVersionId), { nodes: [{ id: 1 }], nativeNormalized: true });
    assert.deepEqual(await service.handle('p', request, { kind: 'user' }), receipt); assert.equal(mutations, 1);
    await assert.rejects(service.handle('p', { ...request, requestId: 'stale' }, { kind: 'user' }), /变更/); assert.equal(mutations, 1);
    await service.handle('p', { type: 'restore_graph', requestId: 'restore', expected: current.observation, versionId: receipt.beforeVersionId }, { kind: 'user' });
    assert.deepEqual(current.workflow.nodes, []); assert.equal(mutations, 2);
    await assert.rejects(service.handle('p', { type: 'queue_graph', requestId: 'queue', expected: current.observation }, { kind: 'user' }), /尚未实现/);
  } finally { await service.close(); }
});

test('storage failure before editing prevents mutation; ambiguous mutation stays recoverable across restart', async () => {
  const root = mkdtempSync(join(projectDirectory(resolve('.'), '.runtime', 'implementation', 'fixtures'), 'comfy-failure-'));
  let store = new ComfyStore(root, 'p'); let mutations = 0;
  let service = new ComfyService(store, async request => {
    if (request.type === 'apply_graph') { mutations++; throw Error('renderer disconnected after mutation'); }
    return before;
  });
  const snapshots = join(root, '.mixcat/comfy/workflows'); writeFileSync(snapshots, 'blocked');
  const request = { type: 'apply_graph' as const, requestId: 'fail', expected: before.observation, workflow: { nodes: [{ id: 1 }] } };
  await assert.rejects(service.handle('p', request, { kind: 'user' })); assert.equal(mutations, 0);
  renameSync(snapshots, snapshots + '-blocked');
  await assert.rejects(service.handle('p', request, { kind: 'user' }), /disconnected/); assert.equal(mutations, 1);
  const recovery = store.recoverableEdits(); assert.equal(recovery.length, 1);
  await service.close(); store = new ComfyStore(root, 'p');
  service = new ComfyService(store, async () => { mutations++; return before; });
  try {
    await assert.rejects(service.handle('p', request, { kind: 'user' }), /恢复/); assert.equal(mutations, 1);
    assert.deepEqual(store.readVersion(recovery[0].beforeVersionId), { nodes: [] });
  } finally { await service.close(); }
});

test('native origin port persists once and malformed protocol values fail at public boundary', () => {
  const root = mkdtempSync(join(projectDirectory(resolve('.'), '.runtime', 'implementation', 'fixtures'), 'comfy-port-'));
  let store = new ComfyStore(root, 'p'); assert.equal(store.getRuntimePort(), undefined);
  assert.equal(store.setRuntimePort(49876), 49876); assert.equal(store.setRuntimePort(49877), 49876);
  assert.throws(() => store.setRuntimePort(0), /端口/); store.close(); store = new ComfyStore(root, 'p');
  assert.equal(store.getRuntimePort(), 49876); store.close();
  for (const value of [null, { type: 'comfy_request' }, { type: 'comfy_request', id: 'x', generation: 'g', projectId: 'p', actor: { kind: 'user' }, request: { type: 'execute_js', code: '1' } }]) assert.throws(() => validateRpcRequest(value));
});

test('guest admission rejects another contents, subframe, origin, instance and repeated handshake', () => {
  const contents = {}, mainFrame = {}, other = {}, origin = 'http://127.0.0.1:43210';
  authorizeComfyGuest(contents, mainFrame, contents, mainFrame, origin + '/', origin);
  for (const [sender, frame, url] of [[other, mainFrame, origin], [contents, other, origin], [contents, mainFrame, 'http://localhost:43210'], [contents, mainFrame, 'http://127.0.0.1:43211']]) {
    assert.throws(() => authorizeComfyGuest(sender, frame, contents, mainFrame, url as string, origin), /来源/);
  }
  authorizeComfyHandshake('instance', 'instance', false);
  assert.throws(() => authorizeComfyHandshake('old-instance', 'instance', false), /握手/);
  assert.throws(() => authorizeComfyHandshake('instance', 'instance', true), /握手/);
});

test('closing a service while graph read is pending cannot stage or revive an edit', async () => {
  const root = mkdtempSync(join(projectDirectory(resolve('.'), '.runtime', 'implementation', 'fixtures'), 'comfy-close-'));
  const store = new ComfyStore(root, 'p'); let complete!: (graph: GraphView) => void;
  const service = new ComfyService(store, () => new Promise(resolve => { complete = resolve; }));
  const edit = service.handle('p', { type: 'apply_graph', requestId: 'closed', expected: before.observation, workflow: { nodes: [] } }, { kind: 'user' });
  await new Promise(resolve => setImmediate(resolve));
  const closed = service.close(); complete(before); await assert.rejects(edit, /关闭/); await closed;
  const reopened = new ComfyStore(root, 'p'); try { assert.deepEqual(reopened.recoverableEdits(), []); } finally { reopened.close(); }
});

test('failed after-snapshot persistence never returns an edit receipt and keeps its before snapshot', async () => {
  const root = mkdtempSync(join(projectDirectory(resolve('.'), '.runtime', 'implementation', 'fixtures'), 'comfy-after-fault-'));
  const store = new ComfyStore(root, 'p'), directory = join(root, '.mixcat/comfy/workflows');
  const service = new ComfyService(store, async request => {
    if (request.type === 'read_graph') return before;
    renameSync(directory, directory + '-saved'); writeFileSync(directory, 'blocked');
    return { ...before, observation: { ...before.observation, revision: '2' }, workflow: { nodes: [{ id: 1 }] } };
  });
  const request = { type: 'apply_graph' as const, requestId: 'after-fault', expected: before.observation, workflow: { nodes: [{ id: 1 }] } };
  try {
    await assert.rejects(service.handle('p', request, { kind: 'user' }));
    renameSync(directory, directory + '-blocked'); renameSync(directory + '-saved', directory);
    const recovery = store.recoverableEdits(); assert.equal(recovery.length, 1); assert.deepEqual(store.readVersion(recovery[0].beforeVersionId), { nodes: [] });
    await assert.rejects(service.handle('p', request, { kind: 'user' }), /恢复/);
  } finally { await service.close(); }
});
