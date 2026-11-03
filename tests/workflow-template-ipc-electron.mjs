import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { projectDirectory, insideProject } from '../src/core/paths.ts';
import { launchFeedProductionFixture } from './feed-production-ipc-fixture.mjs';

const root = resolve('.');
const fixture = mkdtempSync(join(projectDirectory(root, '.runtime', 'implementation', 'builtin-templates-20261103'), 'production-ipc-'));
cpSync(join(root, 'dist/client'), insideProject(fixture, join(fixture, 'dist/client')), { recursive: true });
const projectRoot = projectDirectory(fixture, 'research');
let browser;
try {
  browser = await launchFeedProductionFixture(root, fixture, 1);
  const requestId = 'create-research';
  const command = { type: 'create_project', root: projectRoot, name: 'IPC research', template: 'research-analysis' };
  const created = await browser.evaluate(`window.mixcat.command({id:${JSON.stringify(requestId)},command:${JSON.stringify(command)}})`);
  assert.equal(created.projectCreated, true, 'production command IPC must preserve the creation flag');
  const receipt = await browser.evaluate(`window.mixcat.inspect(${JSON.stringify(requestId)})`);
  assert.equal(receipt.result.projectCreated, true, 'production receipt IPC must preserve the creation flag');
  const node = created.snapshot.selected.nodes[0];
  await browser.evaluate(`window.mixcat.command({id:crypto.randomUUID(),command:${JSON.stringify({ type: 'save_node', projectId: created.snapshot.selected.project.id, node: { ...node, name: 'User coordinator', skills: [], plugins: [] } })}})`);
  const known = await browser.evaluate(`window.mixcat.command({id:crypto.randomUUID(),command:${JSON.stringify(command)}})`);
  assert.equal(known.projectCreated, false);
  assert.equal(known.snapshot.selected.nodes[0].name, 'User coordinator');
  await browser.close(); browser = await launchFeedProductionFixture(root, fixture, 2);
  const restored = await browser.evaluate(`window.mixcat.command({id:crypto.randomUUID(),command:${JSON.stringify(command)}})`);
  assert.equal(restored.projectCreated, false, 'cold project restoration must not look like a fresh creation');
  assert.equal(restored.snapshot.selected.nodes[0].name, 'User coordinator');
  assert.deepEqual(restored.snapshot.selected.nodes[0].skills, []);
  assert.deepEqual(restored.snapshot.selected.tasks, []);
  const report = { passed: true, fixture, commandCreationFlag: true, receiptCreationFlag: true, knownProjectFlag: false, coldRestorationFlag: false, userEditsPersist: true, productionMainPreloadWorker: true };
  writeFileSync(join(fixture, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) { await browser?.cleanupFailure(error); throw error; }
finally { await browser?.close(); }
