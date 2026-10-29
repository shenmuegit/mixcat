import assert from 'node:assert/strict';
import test from 'node:test';
import { ComfyStore } from '../src/core/comfy-store.js';
import type { GraphView } from '../src/shared/comfy.js';
import { mkdtempSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { projectDirectory } from '../src/core/paths.js';

function fixture() {
  return { root: mkdtempSync(join(projectDirectory(resolve('.'), '.runtime', 'implementation', 'fixtures'), 'comfy-store-')), projectId: 'project-1' };
}

function graph(projectId: string, revision: string, workflow: Record<string, unknown>): GraphView {
  return { observation: { projectId, instanceId: 'instance-1', workflowId: 'workflow-1', tabId: 'tab-1', revision }, workflow, subgraphPath: [], selectedNodeIds: [] };
}

test('operation reservations deduplicate durably and conflicting fingerprints fail', async t => {
  const f = fixture(), store = new ComfyStore(f.root, f.projectId);
  const receipt = store.beginOperation('request-1', 'graph-input-1');
  assert.equal(receipt.status, 'pending');
  assert.deepEqual(store.beginOperation('request-1', 'graph-input-1'), receipt);
  assert.throws(() => store.beginOperation('request-1', 'graph-input-2'), /冲突/);
  store.close();
  const reopened = new ComfyStore(f.root, f.projectId); t.after(async () => reopened.close());
  assert.deepEqual(reopened.beginOperation('request-1', 'graph-input-1'), receipt);
  assert.throws(() => reopened.beginOperation('request-1', 'graph-input-2'), /冲突/);
});

test('committed edits retain recoverable snapshots and the same receipt across reopening', async t => {
  const f = fixture(), store = new ComfyStore(f.root, f.projectId);
  const before = graph(f.projectId, 'r1', { nodes: [] }), after = graph(f.projectId, 'r2', { nodes: [{ id: 1, type: 'PreviewImage' }] });
  store.beginOperation('edit-1', 'edit-fingerprint');
  const receipt = store.commitEdit('edit-1', before, after);
  assert.deepEqual(store.readVersion(receipt.beforeVersionId), { nodes: [] });
  assert.deepEqual(store.readVersion(receipt.afterVersionId), { nodes: [{ id: 1, type: 'PreviewImage' }] });
  assert.deepEqual(store.beginOperation('edit-1', 'edit-fingerprint').result, receipt);
  store.close();
  const reopened = new ComfyStore(f.root, f.projectId); t.after(async () => reopened.close());
  assert.deepEqual(reopened.commitEdit('edit-1', before, after), receipt);
  assert.deepEqual(reopened.readVersion(receipt.afterVersionId), after.workflow);
  assert.throws(() => reopened.commitEdit('edit-1', before, graph(f.projectId, 'r3', { nodes: [] })), /冲突/);
  const read = reopened.readVersion(receipt.afterVersionId); read.nodes = [];
  assert.deepEqual(reopened.readVersion(receipt.afterVersionId), after.workflow);
});

test('runs are durable, deduplicated and paginated independently of project snapshots', async t => {
  const f = fixture(), store = new ComfyStore(f.root, f.projectId);
  const observation = graph(f.projectId, 'r1', {}).observation;
  store.beginOperation('run-1', 'run-fingerprint');
  const first = store.createRun({ requestId: 'run-1', observation });
  assert.equal(first.status, 'prepared');
  assert.deepEqual(store.createRun({ requestId: 'run-1', observation }), first);
  assert.throws(() => store.createRun({ requestId: 'run-1', observation: { ...observation, revision: 'r2' } }), /冲突/);
  assert.throws(() => store.commitEdit('run-1', graph(f.projectId, 'r1', {}), graph(f.projectId, 'r2', {})), /冲突/);
  const updated = store.updateRun(first.id, { status: 'queued', promptId: 'prompt-1' });
  assert.equal(updated.promptId, 'prompt-1');
  for (const requestId of ['run-2', 'run-3']) { store.beginOperation(requestId, requestId); store.createRun({ requestId, observation }); }
  const page = store.listRuns(undefined, 2);
  assert.deepEqual(page.runs.map(run => run.requestId), ['run-3', 'run-2']);
  assert(page.nextCursor);
  assert.deepEqual(store.listRuns(page.nextCursor, 2).runs, [updated]);
  assert.equal(store.listRuns(page.nextCursor, 2).nextCursor, undefined);
  assert.equal(store.getRun('missing'), undefined);
  store.close();
  const reopened = new ComfyStore(f.root, f.projectId); t.after(async () => reopened.close());
  assert.deepEqual(reopened.getRun(first.id), updated);
  const read = reopened.getRun(first.id)!; read.status = 'failed';
  assert.equal(reopened.getRun(first.id)!.status, 'queued');
  assert.deepEqual(reopened.beginOperation('run-1', 'run-fingerprint').result, first);
});

test('Comfy storage rejects foreign project identities, malformed data and unsafe paths', async t => {
  const f = fixture(), store = new ComfyStore(f.root, f.projectId); t.after(async () => store.close());
  assert.throws(() => new ComfyStore(f.root, 'other-project'), /其他项目/);
  const before = graph(f.projectId, 'r1', {}), after = graph(f.projectId, 'r2', {});
  store.beginOperation('edit', 'edit');
  for (const key of ['projectId', 'instanceId', 'workflowId', 'tabId'] as const) {
    assert.throws(() => store.commitEdit('edit', before, { ...after, observation: { ...after.observation, [key]: 'other' } }), /其他项目|身份冲突/);
  }
  assert.throws(() => store.commitEdit('edit', before, { ...after, workflow: { invalid: undefined } }), /JSON/);
  assert.throws(() => store.createRun({ requestId: 'edit', observation: { ...before.observation, projectId: 'other' } }), /其他项目/);
  store.beginOperation('run', 'run');
  const run = store.createRun({ requestId: 'run', observation: before.observation });
  for (const relativePath of ['../outside.png', 'C:/private.png', f.root]) {
    assert.throws(() => store.updateRun(run.id, { assets: [{ id: 'asset', relativePath, mime: 'image/png', sha256: 'a'.repeat(64), bytes: 12 }] }), /项目|路径/);
  }
  assert.throws(() => store.updateRun(run.id, { status: 'invented' as any }), /运行格式/);
  assert.throws(() => store.updateRun(run.id, { requestId: 'other' } as any), /字段/);
  assert.throws(() => store.listRuns('../escape'), /游标/);
  assert.throws(() => store.listRuns(undefined, 101), /分页大小/);
  assert.throws(() => store.readVersion('../escape'), /版本标识/);
  assert.equal(store.getRun(run.id)!.status, 'prepared');
});

test('filesystem and SQLite failures leave old snapshots readable and new receipts pending', async t => {
  const f = fixture(); let store = new ComfyStore(f.root, f.projectId); t.after(async () => store.close());
  const before = graph(f.projectId, 'r1', { nodes: [] }), after = graph(f.projectId, 'r2', { nodes: [{ id: 1 }] });
  store.beginOperation('saved', 'saved');
  const saved = store.commitEdit('saved', before, after);
  store.beginOperation('filesystem-failure', 'filesystem-failure');
  const directory = join(f.root, '.mixcat/comfy/workflows'), parked = join(f.root, '.mixcat/comfy/parked-workflows');
  renameSync(directory, parked); writeFileSync(directory, 'blocked');
  assert.throws(() => store.commitEdit('filesystem-failure', after, graph(f.projectId, 'r3', { nodes: [{ id: 2 }] })));
  renameSync(directory, `${directory}.blocked`); renameSync(parked, directory);
  assert.equal(store.beginOperation('filesystem-failure', 'filesystem-failure').status, 'pending');
  assert.deepEqual(store.readVersion(saved.afterVersionId), after.workflow);
  assert.throws(() => store.createRun({ requestId: 'filesystem-failure', observation: after.observation }), /冲突/);

  store.beginOperation('sqlite-failure', 'sqlite-failure');
  store.beginOperation('run-failure', 'run-failure');
  store.beginOperation('saved-run', 'saved-run');
  const savedRun = store.createRun({ requestId: 'saved-run', observation: after.observation });
  const original = DatabaseSync.prototype.exec;
  const fault = t.mock.method(DatabaseSync.prototype, 'exec', function(this: DatabaseSync, sql: string) {
    if (sql === 'COMMIT') throw new Error('injected SQLite commit failure');
    return original.call(this, sql);
  });
  try {
    assert.throws(() => store.commitEdit('sqlite-failure', after, graph(f.projectId, 'r4', { nodes: [{ id: 3 }] })), /SQLite commit failure/);
    assert.throws(() => store.createRun({ requestId: 'run-failure', observation: after.observation, id: 'failed-run' }), /SQLite commit failure/);
    assert.throws(() => store.updateRun(savedRun.id, { status: 'queued' }), /SQLite commit failure/);
  }
  finally { fault.mock.restore(); }
  assert.equal(store.beginOperation('sqlite-failure', 'sqlite-failure').status, 'pending');
  assert.deepEqual(store.readVersion(saved.beforeVersionId), before.workflow);
  assert.deepEqual(store.readVersion(saved.afterVersionId), after.workflow);
  assert.equal(store.getRun('failed-run'), undefined);
  assert.deepEqual(store.getRun(savedRun.id), savedRun);
  store.close(); store = new ComfyStore(f.root, f.projectId);
  assert.equal(store.beginOperation('sqlite-failure', 'sqlite-failure').status, 'pending');
  assert.equal(store.beginOperation('run-failure', 'run-failure').status, 'pending');
  assert.throws(() => store.createRun({ requestId: 'filesystem-failure', observation: after.observation }), /冲突/);
  assert.deepEqual(store.readVersion(saved.afterVersionId), after.workflow);
});

test('snapshot corruption and directory links fail clearly at the public read boundary', async t => {
  const f = fixture(), store = new ComfyStore(f.root, f.projectId); t.after(async () => store.close());
  store.beginOperation('edit', 'edit');
  const receipt = store.commitEdit('edit', graph(f.projectId, 'r1', {}), graph(f.projectId, 'r2', { nodes: [] }));
  writeFileSync(join(f.root, '.mixcat/comfy/workflows', `${receipt.afterVersionId}.json`), '{"nodes":[1]}');
  assert.throws(() => store.readVersion(receipt.afterVersionId), /哈希不匹配/);
  assert.deepEqual(store.readVersion(receipt.beforeVersionId), {});
  const directory = join(f.root, '.mixcat/comfy/workflows'), parked = join(f.root, '.mixcat/comfy/linked-workflows');
  renameSync(directory, parked); symlinkSync(parked, directory, 'junction');
  try { assert.throws(() => store.readVersion(receipt.beforeVersionId), /符号链接|目录联接/); }
  finally { unlinkSync(directory); renameSync(parked, directory); }
});

test('corrupt operation receipts are rejected instead of trusted on retry', async t => {
  const f = fixture(), store = new ComfyStore(f.root, f.projectId); t.after(async () => store.close());
  store.beginOperation('request', 'fingerprint');
  const external = new DatabaseSync(join(f.root, '.mixcat/comfy/state.sqlite'));
  try { external.prepare('UPDATE operations SET body=? WHERE request_id=?').run(JSON.stringify({ requestId: 'request', fingerprint: 'fingerprint', status: 'invented' }), 'request'); }
  finally { external.close(); }
  assert.throws(() => store.beginOperation('request', 'fingerprint'), /回执.*格式/);
});
