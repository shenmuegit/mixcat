import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ProjectStore } from '../src/core/store.js';
import { projectDirectory } from '../src/core/paths.js';
import { createComfyTemplate } from '../src/core/comfy-template.js';
import { claimComfyMaintenance, parseComfyMaintenance } from '../src/core/comfy-maintenance.js';
import { ComfyStore } from '../src/core/comfy-store.js';
import { lifecycleLease } from '../src/core/comfy-runtime.js';
import { ComfyService } from '../src/core/comfy-service.js';

function fixture(template: 'comfyui' | undefined = 'comfyui') {
  const root = mkdtempSync(join(projectDirectory(resolve('.'), '.runtime', 'implementation', 'fixtures'), 'maint-'));
  const store = new ProjectStore(root);
  store.save({ project: { id: 'real-fixture', name: 'Maintenance fixture', root, status: 'idle', mode: 'codex', updatedAt: '2026-10-30T00:00:00.000Z', ...(template ? { template } : {}) }, nodes: createComfyTemplate(), tasks: [], handoffs: [], activities: [], edges: [], groups: [], conversation: [], messages: [], workflowReceipts: [], reviewPolicy: { revision: 0, checkpoints: [] }, humanReviews: [], runId: null, maxSteps: 12 });
  store.close(); return root;
}
const prepare = (root: string) => parseComfyMaintenance([root, 'prepare', resolve('resources/comfy/runtime-manifest.json'), 'v0.43.0', '426f5eea52a7ece1dd599fff4cb6cd1f352ddd24']);
test('operator claims a real existing Comfy project without changing its stored history and refuses a second writer', () => {
  const root = fixture(), before = new ProjectStore(root); const body = before.db.prepare('SELECT body FROM project_state').get()!.body; before.close();
  const owned = claimComfyMaintenance(prepare(root));
  try {
    assert.equal(owned.project.id, 'real-fixture');
    const other = new ProjectStore(root); try { assert.throws(() => other.claim(), /其他 Mixcat/); } finally { other.close(); }
    assert.throws(() => lifecycleLease(root), /另一个宿主/);
    assert.equal(owned.store.db.prepare('SELECT body FROM project_state').get()!.body, body);
  } finally { owned.close(); }
  const reopened = new ProjectStore(root); reopened.claim(); reopened.close();
});
test('operator rejects invalid, non-Comfy, busy and wrong-version requests without creating a project or releasing a live owner', () => {
  const missing = mkdtempSync(join(projectDirectory(resolve('.'), '.runtime', 'implementation', 'fixtures'), 'missing-'));
  assert.throws(() => claimComfyMaintenance(prepare(missing)), /已存在/); assert.equal(existsSync(join(missing, '.mixcat/state/workflow.sqlite')), false);
  assert.throws(() => parseComfyMaintenance([fixture(), 'activate', 'latest']), /完整组合/);
  assert.throws(() => parseComfyMaintenance(['C:\\outside', 'rollback', 'a'.repeat(64)]), /C 盘/);
  assert.throws(() => parseComfyMaintenance([fixture(), 'prepare', resolve('resources/comfy/runtime-manifest.json'), 'v0.43.0', 'a'.repeat(40)]), /tag\/SHA/);
  const ordinary = fixture(undefined); // Explicitly clear the default template for the non-Comfy case.
  const ordinaryStore = new ProjectStore(ordinary), ordinaryState = ordinaryStore.read()!; delete ordinaryState.project.template; ordinaryStore.save(ordinaryState); ordinaryStore.close();
  assert.throws(() => claimComfyMaintenance(prepare(ordinary)), /ComfyUI/);
  const root = fixture(), owner = new ProjectStore(root); owner.claim();
  assert.throws(() => claimComfyMaintenance(prepare(root)), /其他 Mixcat/); owner.close();
  const release = lifecycleLease(root); try { assert.throws(() => claimComfyMaintenance(prepare(root)), /另一个宿主/); } finally { release(); }
  const retry = new ProjectStore(root); retry.claim(); retry.close();
  assert.throws(() => claimComfyMaintenance(parseComfyMaintenance([root, 'activate', 'a'.repeat(64)])), /候选/);
  const store = new ProjectStore(root), state = store.read()!; state.project.status = 'running'; store.save(state); store.close();
  assert.throws(() => claimComfyMaintenance(prepare(root)), /活动/);
});
test('operator refuses retained unknown native acceptance before recovery can change any ledger row', () => {
  const root = fixture(), store = new ComfyStore(root, 'real-fixture');
  store.beginOperation('pending', 'pending'); const run = store.createRun({ requestId: 'pending', observation: { projectId: 'real-fixture', instanceId: 'old', workflowId: 'w', tabId: 't', revision: 'r' } });
  const before = store.runtimeStateHash();
  assert.throws(() => claimComfyMaintenance(prepare(root)), /活动|受理/);
  assert.equal(store.runtimeStateHash(), before); assert.equal(store.getRun(run.id)?.status, 'prepared'); store.close();
});

test('explicit verified edit recovery restores maintenance eligibility after reopening', async () => {
  const root = fixture(), store = new ComfyStore(root, 'real-fixture'); let fail = true;
  let view = { observation: { projectId: 'real-fixture', instanceId: 'i', workflowId: 'w', tabId: 't', revision: 'r' }, workflow: { nodes: [] } as Record<string, unknown>, subgraphPath: [], selectedNodeIds: [] };
  const service = new ComfyService(store, async request => { if (request.type === 'apply_graph') { if (fail) throw Error('native failed'); view = { ...view, workflow: request.workflow }; } return view; });
  await assert.rejects(service.handle('real-fixture', { type: 'apply_graph', requestId: 'failed', expected: view.observation, workflow: { nodes: [1] } }, { kind: 'user' }));
  assert.throws(() => claimComfyMaintenance(prepare(root)), /活动|受理/);
  fail = false; await service.handle('real-fixture', { type: 'restore_graph', requestId: 'restore', recoveryRequestId: 'failed', expected: view.observation, versionId: store.recoverableEdits()[0].beforeVersionId }, { kind: 'user' });
  await service.close(); const claim = claimComfyMaintenance(prepare(root)); assert.equal(claim.project.id, 'real-fixture'); claim.close();
});
