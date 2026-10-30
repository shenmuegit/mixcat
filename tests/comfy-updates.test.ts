import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { projectDirectory } from '../src/core/paths.js';
import { ComfyStore } from '../src/core/comfy-store.js';
import { ComfyUpdates, installCombination, lifecycleLease, type NativeWorkspace, type UpdateDriver } from '../src/core/comfy-updates.js';
import { recoverDeadRuntimeLock, type RuntimeManifest, type PreparationIO } from '../src/core/comfy-runtime.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function environment(selection: import('../src/core/comfy-updates.js').RuntimeSelection) { const { workspace: _workspace, ...environment } = selection; return environment; }
function fixture() {
  const root = mkdtempSync(join(projectDirectory(resolve('.'), '.runtime', 'implementation', 'fixtures'), 'updates-'));
  const store = new ComfyStore(root, 'updates');
  const manifest: RuntimeManifest = { id: 'v1', python: { version: '3.14.10', url: 'https://example.invalid/python.zip', sha256: hash('archive') }, backend: { repository: 'https://github.com/Comfy-Org/ComfyUI.git', tag: 'v0.42.0', version: '0.42.0', commit: '355cd6b14c92c19ac3188fe528e47a3f21ef5178' }, frontendVersion: '1.55.18', packages: [], lockSha256: hash('\n') };
  const assets = projectDirectory(root, 'assets');
  for (const name of ['__init__.py', 'nodes.py', 'web/bridge.js', 'web/queue-projection.js']) { const parts = name.split('/'); const file = parts.pop()!; writeFileSync(join(projectDirectory(root, 'assets', 'mixcat', ...parts), file), name); }
  const io: PreparationIO = { download: async (_url, path) => { writeFileSync(path, 'archive'); }, install: async runtime => { writeFileSync(runtime.python, 'fixture'); writeFileSync(join(runtime.backend, 'main.py'), 'fixture'); writeFileSync(join(runtime.backend, 'LICENSE'), 'fixture'); } };
  const driver: UpdateDriver = { checkpoint: async () => ({ local: {}, session: {}, tabs: [], active: null }), start: async () => {}, stop: async () => {}, qualify: async () => {} };
  const updates = new ComfyUpdates(store, assets, driver, io);
  return { root, store, manifest, assets, driver, updates };
}
test('candidate preparation failure retains the complete selected combination and original data', async t => {
  const f = fixture(); t.after(() => f.store.close());
  const selected = f.updates.initialize(f.manifest);
  writeFileSync(join(f.root, selected.data, 'kept.txt'), 'original');
  f.driver.qualify = async () => { throw Error('frontend mismatch'); };
  await assert.rejects(f.updates.prepareCandidate(f.root, { ...f.manifest, id: 'v2' }), /frontend mismatch/);
  assert.deepEqual(environment(f.updates.selection()), environment(selected));
  assert.equal(f.updates.candidates().length, 0);
});
test('activation commits only after native qualification and rollback restores compatible data while retaining newer work', async t => {
  const f = fixture(); t.after(() => f.store.close());
  const old = f.updates.initialize(f.manifest);
  writeFileSync(join(f.root, old.data, 'workflow.json'), 'old');
  const candidate = await f.updates.prepareCandidate(f.root, { ...f.manifest, id: 'v2' });
  f.driver.qualify = async () => { assert.equal(f.updates.selection().versionId, old.versionId); };
  const next = await f.updates.activateVersion(f.root, candidate.selection.versionId);
  writeFileSync(join(f.root, next.data, 'workflow.json'), 'new');
  f.driver.qualify = async () => { assert.equal(f.updates.selection().versionId, next.versionId); };
  const restored = await f.updates.rollbackVersion(f.root, old.versionId);
  assert.equal(restored.versionId, old.versionId);
  assert.equal(readFileSync(join(f.root, restored.data, 'workflow.json'), 'utf8'), 'old');
  assert.equal(readFileSync(join(f.root, next.data, 'workflow.json'), 'utf8'), 'new');
});
test('active operations, stale qualification and changed extension bytes cannot publish a selection', async t => {
  const f = fixture(); t.after(() => f.store.close()); const old = f.updates.initialize(f.manifest);
  f.driver.checkpoint = async () => { throw Error('active provider submission unknown'); };
  await assert.rejects(f.updates.prepareCandidate(f.root, { ...f.manifest, id: 'v2' }), /active provider/);
  f.driver.checkpoint = async () => ({ local: {}, session: {}, tabs: [], active: null });
  const candidate = await f.updates.prepareCandidate(f.root, { ...f.manifest, id: 'v2' });
  writeFileSync(join(f.root, old.data, 'new.json'), 'new edit');
  await assert.rejects(f.updates.activateVersion(f.root, candidate.selection.versionId), /变更/);
  assert.deepEqual(environment(f.updates.selection()), environment(old));
  const combination = f.updates.combination(candidate.selection.versionId);
  writeFileSync(join(f.root, combination.directory, 'nodes.py'), 'tampered');
  assert.throws(() => f.updates.combination(candidate.selection.versionId), /扩展校验/);
});
test('missing or hash-bad packages and failed installation preserve the selected environment', async t => {
  const f = fixture(); t.after(() => f.store.close()); const old = f.updates.initialize(f.manifest);
  const missing = new ComfyUpdates(f.store, f.assets, f.driver, { download: async () => { throw Error('missing package'); }, install: async () => {} });
  await assert.rejects(missing.prepareCandidate(f.root, { ...f.manifest, id: 'missing' }), /missing package/);
  const corrupt = new ComfyUpdates(f.store, f.assets, f.driver, { download: async (_url, path) => { writeFileSync(path, 'corrupt'); }, install: async () => {} });
  await assert.rejects(corrupt.prepareCandidate(f.root, { ...f.manifest, id: 'corrupt' }), /SHA-256/);
  const failed = new ComfyUpdates(f.store, f.assets, f.driver, { download: async (_url, path) => { writeFileSync(path, 'archive'); }, install: async () => { throw Error('interrupted installer'); } });
  await assert.rejects(failed.prepareCandidate(f.root, { ...f.manifest, id: 'failed' }), /interrupted installer/);
  assert.deepEqual(environment(f.updates.selection()), environment(old));
});
test('failed candidate termination keeps the old selection and a specific recovery intent', async t => {
  const f = fixture(); t.after(() => f.store.close()); const old = f.updates.initialize(f.manifest);
  let stops = 0;
  f.driver.stop = async () => { if (++stops > 1) throw Error('owned process termination unverified'); };
  f.driver.qualify = async () => { throw Error('extension did not load'); };
  await assert.rejects(f.updates.prepareCandidate(f.root, { ...f.manifest, id: 'v2' }), /旧环境恢复失败/);
  assert.deepEqual(environment(f.updates.selection()), environment(old));
  assert.match(JSON.stringify(f.store.runtimeRecord('intent')), /termination unverified/);
});
test('project lifecycle excludes another owner across different runtime versions and is released for retry', t => {
  const f = fixture(); t.after(() => f.store.close());
  const release = lifecycleLease(f.root);
  assert.throws(() => lifecycleLease(f.root), /另一个宿主/);
  release(); lifecycleLease(f.root)();
});
test('a failed initial stop leaves a durable source workspace and intent for crash recovery', async t => {
  const f = fixture(); t.after(() => f.store.close()); const old = f.updates.initialize(f.manifest);
  const workspace: NativeWorkspace = { local: { 'native-draft': 'captured bytes' }, session: { clientId: 'owned' }, tabs: [], active: null };
  f.driver.checkpoint = async () => workspace;
  f.driver.stop = async () => {
    const reopened = new ComfyStore(f.root, 'updates');
    try { assert.deepEqual(reopened.runtimeRecord<any>('selection').workspace, workspace); assert.equal(reopened.runtimeRecord<any>('intent').state, 'preparing'); }
    finally { reopened.close(); }
    throw Error('stop interrupted before candidate launch');
  };
  await assert.rejects(f.updates.prepareCandidate(f.root, { ...f.manifest, id: 'v2' }), /stop interrupted/);
  assert.deepEqual(environment(f.updates.selection()), environment(old));
});
test('changing only the bundled adapter creates a distinct combination and rollback restores its old bytes', async t => {
  const f = fixture(); t.after(() => f.store.close()); const old = f.updates.initialize(f.manifest);
  installCombination(f.root, old, f.updates.combination(old.versionId));
  writeFileSync(join(f.assets, 'mixcat', 'nodes.py'), 'new adapter bytes');
  assert.equal(f.updates.initialize(f.manifest).versionId, old.versionId, 'opening an existing project cannot adopt a new bundled adapter');
  f.driver.start = async (selection, combination) => { installCombination(f.root, selection, combination); };
  const candidate = await f.updates.prepareCandidate(f.root, f.manifest); assert.notEqual(candidate.selection.versionId, old.versionId);
  const next = await f.updates.activateVersion(f.root, candidate.selection.versionId);
  assert.equal(readFileSync(join(f.root, next.data, 'custom_nodes/mixcat/nodes.py'), 'utf8'), 'new adapter bytes');
  const restored = await f.updates.rollbackVersion(f.root, old.versionId);
  assert.equal(readFileSync(join(f.root, restored.data, 'custom_nodes/mixcat/nodes.py'), 'utf8'), 'nodes.py');
});
test('recovery refuses a lock whose owner is live and retains unrecognized lock evidence', async t => {
  const f = fixture(); t.after(() => f.store.close());
  const lock = join(projectDirectory(f.root, '.mixcat', 'comfy'), 'instance.lock');
  const body = JSON.stringify({ ownerPid: process.pid, pid: process.pid, instanceId: '00000000-0000-0000-0000-000000000001', origin: 'http://127.0.0.1:43111' });
  writeFileSync(lock, body); await assert.rejects(recoverDeadRuntimeLock(f.root), /拒绝接管/); assert.equal(readFileSync(lock, 'utf8'), body);
  writeFileSync(lock, 'incomplete lock'); await assert.rejects(recoverDeadRuntimeLock(f.root), /无法识别/); assert.equal(readFileSync(lock, 'utf8'), 'incomplete lock');
});
test('native session rotation with equivalent pointers is operational but unrelated storage edits invalidate qualification', async t => {
  const f = fixture(); t.after(() => f.store.close()); f.updates.initialize(f.manifest);
  let client = 'first', preference = 'original';
  f.driver.checkpoint = async () => ({ local: { preference }, session: { clientId: client, [`Comfy.Workflow.ActivePath:${client}`]: '{"path":"a"}', [`Comfy.Workflow.OpenPaths:${client}`]: '{"paths":["a","b"],"activeIndex":0}' }, tabs: [], active: null });
  const candidate = await f.updates.prepareCandidate(f.root, { ...f.manifest, id: 'v2' }); client = 'second';
  assert.equal((await f.updates.activateVersion(f.root, candidate.selection.versionId)).versionId, candidate.selection.versionId);
  const later = await f.updates.prepareCandidate(f.root, { ...f.manifest, id: 'v3' }); preference = 'changed';
  await assert.rejects(f.updates.activateVersion(f.root, later.selection.versionId), /变更.*browser/);
});
for (const change of ['path', 'order', 'content', 'temporary', 'modified', 'context'] as const) test(`changing native ${change} invalidates a qualified candidate`, async t => {
  const f = fixture(); t.after(() => f.store.close()); f.updates.initialize(f.manifest);
  const workspace: NativeWorkspace = { local: {}, session: {}, tabs: ['a', 'b'].map(path => ({ path, workflow: { nodes: [] }, initialState: { nodes: [] }, temporary: true, modified: true })), active: { path: 'a', subgraphPath: [], selectedNodeIds: [] } };
  f.driver.checkpoint = async () => structuredClone(workspace);
  const candidate = await f.updates.prepareCandidate(f.root, { ...f.manifest, id: 'v2' });
  if (change === 'path') workspace.tabs[0].path = 'renamed';
  if (change === 'order') workspace.tabs.reverse();
  if (change === 'content') workspace.tabs[0].workflow = { nodes: [{ id: 1 }] };
  if (change === 'temporary') workspace.tabs[0].temporary = false;
  if (change === 'modified') workspace.tabs[0].modified = false;
  if (change === 'context') workspace.active!.selectedNodeIds = ['1'];
  await assert.rejects(f.updates.activateVersion(f.root, candidate.selection.versionId), /变更.*workspace/);
});
test('only exact hash-verified retained-artifact transport copies may disappear on native restart', async t => {
  const f = fixture(); t.after(() => f.store.close()); const selected = f.updates.initialize(f.manifest);
  const id = '00000000-0000-0000-0000-000000000001', content = 'retained provider output';
  const artifactPath = join(projectDirectory(f.root, '.mixcat', 'comfy', 'provider-artifacts'), id + '.txt'); writeFileSync(artifactPath, content);
  f.store.beginOperation('artifact', 'artifact'); const run = f.store.createRun({ requestId: 'artifact', observation: { projectId: 'updates', instanceId: 'old', workflowId: 'w', tabId: 't', revision: 'r' } });
  f.store.registerArtifact(run.id, { id, relativePath: '.mixcat/comfy/provider-artifacts/' + id + '.txt', mime: 'text/plain', sha256: hash(content), bytes: Buffer.byteLength(content) });
  const temp = projectDirectory(f.root, selected.data, 'temp'), transport = join(temp, 'mixcat-' + id + '.txt'); writeFileSync(transport, content);
  const candidate = await f.updates.prepareCandidate(f.root, { ...f.manifest, id: 'v2' }); rmSync(transport);
  await f.updates.activateVersion(f.root, candidate.selection.versionId);
  for (const [name, body] of [['unregistered.txt', content], ['mixcat-' + id + '.txt', 'changed bytes'], ['mixcat-' + id + '.mp4', content]]) {
    const next = await f.updates.prepareCandidate(f.root, { ...f.manifest, id: 'v3' });
    const file = join(projectDirectory(f.root, f.updates.selection().data, 'temp'), name); writeFileSync(file, body);
    await assert.rejects(f.updates.activateVersion(f.root, next.selection.versionId), /变更.*files/); rmSync(file);
  }
});
