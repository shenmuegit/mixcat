import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkflowEngine } from '../src/core/engine.js';
import { fixture, until } from './runtime-fixture.js';
import { projectDirectory } from '../src/core/paths.js';
import { ProjectStore } from '../src/core/store.js';
import type { AppCommand } from '../src/shared/types.js';

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
