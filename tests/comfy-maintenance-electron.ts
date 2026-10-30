import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ComfyStore } from '../src/core/comfy-store.js';
import { ProjectStore } from '../src/core/store.js';
import { createComfyTemplate } from '../src/core/comfy-template.js';
import { projectDirectory } from '../src/core/paths.js';
import { runtimeEnvironment } from '../src/core/comfy-runtime.js';
import type { RuntimeSelection } from '../src/core/comfy-updates.js';
import { build } from 'esbuild';
import { randomUUID } from 'node:crypto';

test('the actual maintainer CLI prepares, activates and rolls back an existing persistent Comfy project', { timeout: 360000 }, async () => {
  const repository = resolve('.'), root = projectDirectory(repository, 'u9'), proof = projectDirectory(root, '.mixcat', 'comfy', 'maintenance', 'test-proof');
  assert(existsSync(join(root, '.mixcat/comfy/runtime/comfy042-py31410-cpu1/rehearsal-copy-verified')), 'Run the prepared two-version rehearsal first.');
  const projectId = 'task9-native', project = new ProjectStore(root); project.claim();
  if (!project.read({ recover: false })) {
    const nodes = createComfyTemplate(); nodes[0].threads.codex = 'retained-existing-thread';
    project.save({ project: { id: projectId, name: 'Task9 maintained Comfy project', root, template: 'comfyui', status: 'idle', mode: 'codex', updatedAt: '2026-10-30T00:00:00.000Z' }, nodes, tasks: [], handoffs: [], activities: [], edges: [], groups: [], conversation: [], messages: [], workflowReceipts: [], reviewPolicy: { revision: 0, checkpoints: [] }, humanReviews: [], runId: null, maxSteps: 12 });
  }
  assert.equal(project.read({ recover: false })!.project.id, projectId);
  const history = project.db.prepare('SELECT body FROM project_state').get()!.body; project.close();
  const credentials = readFileSync(join(root, '.mixcat/comfy/providers.json'));
  const state = () => { const store = new ComfyStore(root, projectId); try { return { selection: store.runtimeRecord<RuntimeSelection>('selection')!, ledger: store.runtimeStateHash() }; } finally { store.close(); } };
  const before = state();
  const run = (args: string[]) => new Promise<Record<string, any>>((resolve, reject) => {
    const child = spawn(process.execPath, [join(repository, 'scripts/comfy-maintain.mjs'), root, ...args], { cwd: repository, env: runtimeEnvironment(root, '.mixcat/comfy/maintenance'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.once('error', reject); child.once('close', code => { writeFileSync(join(proof, args[0] + '.log'), stdout + stderr); if (code !== 0) { reject(Error(`operator ${args[0]} failed (${code}): ${stdout}${stderr}`)); return; } try { resolve(JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!)); } catch (error) { reject(error); } });
  });
  const candidate = await run(['prepare', join(repository, 'resources/comfy/runtime-manifest.json'), 'v0.43.0', '426f5eea52a7ece1dd599fff4cb6cd1f352ddd24']);
  assert.equal(candidate.projectId, projectId); assert.equal(state().selection.versionId, before.selection.versionId);
  const marker = 'Intervening native edit ' + randomUUID();
  await build({ entryPoints: ['tests/fixtures/comfy-maintenance-user-edit.ts'], outfile: join(proof, 'edit.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'] });
  await new Promise<void>((resolve, reject) => {
    const child = spawn(join(repository, 'node_modules/electron/dist/electron.exe'), [join(proof, 'edit.cjs'), repository, root, marker], { cwd: repository, env: runtimeEnvironment(root, '.mixcat/comfy/maintenance'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; }); child.once('error', reject);
    child.once('close', code => { writeFileSync(join(proof, 'ordinary-edit.log'), output); code === 0 ? resolve() : reject(Error(output)); });
  });
  const hasEdit = (selection: RuntimeSelection) => selection.workspace!.tabs.some(tab => (tab.workflow.nodes as any[]).some(node => node.title === marker));
  const active = await run(['activate', candidate.versionId]); assert.equal(active.requalified, true); assert.equal(state().selection.versionId, candidate.versionId);
  assert(hasEdit(state().selection)); assert.equal(readFileSync(join(root, state().selection.data, 'user', 'between-commands.txt'), 'utf8'), marker);
  const newerData = state().selection.data; writeFileSync(join(root, newerData, 'user', 'after-activation.txt'), 'newer retained work');
  const restored = await run(['rollback', candidate.sourceVersionId]); assert.equal(state().selection.versionId, before.selection.versionId);
  assert(hasEdit(state().selection)); assert.equal(readFileSync(join(root, state().selection.data, 'user', 'between-commands.txt'), 'utf8'), marker);
  assert.equal(readFileSync(join(root, newerData, 'user', 'after-activation.txt'), 'utf8'), 'newer retained work'); assert.equal(existsSync(join(root, state().selection.data, 'user', 'after-activation.txt')), false);
  const after = new ProjectStore(root); after.claim(); assert.equal(after.db.prepare('SELECT body FROM project_state').get()!.body, history); after.close();
  assert.deepEqual(readFileSync(join(root, '.mixcat/comfy/providers.json')), credentials); assert.equal(state().ledger, before.ledger);
  assert.equal(existsSync(join(root, '.mixcat/comfy/instance.lock')), false);
  writeFileSync(join(proof, 'evidence.json'), JSON.stringify({ passed: true, projectId, candidate, active, restored, interveningEditPreserved: true, interveningUserFilePreserved: true, newerDataRetained: newerData, historyUnchanged: true, credentialsUnchanged: true, ledgerUnchanged: true, safeClosed: true }, null, 2));
});
