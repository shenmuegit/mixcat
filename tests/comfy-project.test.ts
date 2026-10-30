import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkflowEngine } from '../src/core/engine.js';
import { fixture, until } from './runtime-fixture.js';
import { projectDirectory } from '../src/core/paths.js';
import { ProjectStore } from '../src/core/store.js';
import type { AppCommand } from '../src/shared/types.js';
import { readWorkflowDefinition, resetProjectData } from '../src/core/project-reset.js';

test('ComfyUI projects reopen the same single assistant and native Thread', async t => {
  const f = await fixture(t, async () => {}, 'comfyui');
  const created = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!;
  assert.equal(created.project.template, 'comfyui');
  assert.equal(created.nodes.length, 1);
  const assistant = created.nodes[0];
  assert.deepEqual(created.edges, []);
  await f.send(assistant.id);
  await until(() => f.clients[0]?.calls.some(call => call.method === 'turn/start'));
  const task = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!.tasks[0];
  f.clients[0].options.onEvent({ method: 'turn/completed', params: { threadId: task.threadId, turn: { id: task.turnId, status: 'completed', items: [] } } });
  await f.engine.close();
  const reopened = new WorkflowEngine({ workbenchRoot: f.root, executable: 'unused', nativeFactory() { assert.fail('Reopening does not start native work'); } });
  t.after(() => reopened.close()); await reopened.init();
  const restored = (await reopened.command({ type: 'create_project', root: f.root, name: 'Ignored', template: 'comfyui' })).snapshot.selected!;
  assert.equal(restored.project.id, created.project.id);
  assert.equal(restored.project.template, 'comfyui');
  assert.equal(restored.nodes.length, 1);
  assert.equal(restored.nodes[0].id, assistant.id);
  assert.equal(restored.nodes[0].threadId, task.threadId);
  assert.equal(restored.tasks[0].status, 'completed');
});

test('unknown templates are rejected and ordinary/Web projects have no Comfy grants', async t => {
  const f = await fixture(t);
  await assert.rejects(f.engine.command({ type: 'create_project', root: f.root, name: 'Unknown', template: 'unknown' } as unknown as AppCommand), /模板/);
  const ordinary = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!;
  const web = (await f.engine.command({ type: 'create_project', root: projectDirectory(f.root, 'web'), name: 'Web', template: 'web-product' })).snapshot.selected!;
  for (const project of [ordinary, web]) assert(project.nodes.every(node => node.tools.every(tool => !String(tool).startsWith('comfy_'))));
  await f.engine.close();
  const store = new ProjectStore(f.root); t.after(async () => store.close());
  const state = store.read()!;
  state.project.template = 'unknown' as any;
  assert.throws(() => store.save(state), /摘要格式/);
  assert.equal(store.read()!.project.template, undefined);
});

test('Comfy reset is refused and project removal waits for a successful retained lifecycle check', async t => {
  let blocked = true, checks = 0;
  const f = await fixture(t, async () => {}, 'comfyui', {
    async request() { throw Error('unused'); },
    async closeProject(_id, deleting) { assert.equal(deleting, true); checks++; if (blocked) throw Error('Comfy retained remote job'); },
  });
  await assert.rejects(f.engine.command({ type: 'reset_workflow', projectId: f.projectId, confirmed: true }), /Comfy.*协作图/);
  await assert.rejects(f.engine.command({ type: 'delete_project', projectId: f.projectId }), /retained remote/);
  assert.equal((await f.engine.command({ type: 'snapshot' })).snapshot.selected?.project.id, f.projectId);
  blocked = false;
  await f.engine.command({ type: 'delete_project', projectId: f.projectId });
  assert.equal(checks, 2);
  assert.equal((await f.engine.command({ type: 'snapshot' })).snapshot.projects.length, 0);
  const definition = readWorkflowDefinition(f.root);
  assert.throws(() => resetProjectData(f.root, definition), /Comfy/);
});
