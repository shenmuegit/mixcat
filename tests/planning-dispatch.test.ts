import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkflowEngine } from '../src/core/engine.js';
import { projectDirectory } from '../src/core/paths.js';
import { ProjectStore } from '../src/core/store.js';
import { accountFixture } from './account-fixture.js';
import type { NativeClientOptions, ProjectSnapshot } from '../src/shared/types.js';

test('dispatch binds the current plan before resume and clears missing or deselected plans while native turns continue', async t => {
  const root = mkdtempSync(join(projectDirectory(resolve('.'), '.runtime', 'implementation', 'web-product-team-20261022', 'tmp'), 'planning-dispatch-'));
  writeFileSync(join(projectDirectory(root, '.mixcat', 'planning'), 'adapter.py'), '# Dispatch boundary fixture; no model or hook execution.');
  for (const name of ['one', 'two']) writeFileSync(join(projectDirectory(root, '.planning', name), 'task_plan.md'), `# ${name}`);
  const bindings = join(root, '.mixcat', 'planning', 'threads.json');
  const mapped = () => existsSync(bindings) ? JSON.parse(readFileSync(bindings, 'utf8')).threads['native-thread'] ?? null : null;
  const boundaries: { method: string; plan: string | null }[] = [];
  let options!: NativeClientOptions, sequence = 0;
  const engine = new WorkflowEngine({ workbenchRoot: root, executable: 'fixture', accountFactory: accountFixture().factory,
    nativeFactory(value) {
      options = value;
      return { async connect() {}, async close() {}, async rpc(method, params) {
        if (method === 'account/read') return { account: { email: 'fixture' } };
        if (method === 'windowsSandbox/readiness') return { status: 'configured' };
        if (['thread/start', 'thread/resume', 'turn/start'].includes(method)) boundaries.push({ method, plan: mapped() });
        if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'native-thread' } };
        if (method === 'turn/start') return { turn: { id: `turn-${++sequence}` } };
        return {};
      } };
    } });
  t.after(() => engine.close()); await engine.init();
  const created = await engine.command({ type: 'create_project', root, name: 'Planning dispatch', goal: 'Keep current plan per native Thread' });
  const projectId = created.snapshot.selected!.project.id;
  const snapshot = async () => (await engine.command({ type: 'snapshot', projectId })).snapshot.selected!;
  const disk = new ProjectStore(root); t.after(() => disk.close());
  async function assertPlanShape(planId: string | undefined) {
    const live = (await snapshot()).nodes.find(node => node.id === 'plan')!;
    const stored = disk.read()!.nodes.find(node => node.id === 'plan')!;
    assert.equal(live.planId, planId);
    assert.equal(Object.hasOwn(live, 'planId'), planId !== undefined);
    assert.equal(Object.hasOwn(stored, 'planId'), planId !== undefined);
    const { threadId, ...liveDefinition } = live;
    const { threads, ...storedDefinition } = stored;
    assert.deepEqual(liveDefinition, storedDefinition);
  }
  assert.equal(Object.hasOwn(created.snapshot.selected!.nodes.find(node => node.id === 'plan')!, 'planId'), false);
  assert.equal(Object.hasOwn(disk.read()!.nodes.find(node => node.id === 'plan')!, 'planId'), false);
  async function waitFor(predicate: (value: ProjectSnapshot) => boolean) {
    for (let i = 0; i < 150; i++) { const value = await snapshot(); if (predicate(value)) return value; await delay(10); }
    assert.fail('dispatch fixture did not reach its boundary');
  }
  async function sendWithPlan(planId: string | undefined) {
    const current = await snapshot(), node = current.nodes.find(node => node.id === 'plan')!;
    await engine.command({ type: 'save_node', projectId, node: { ...node, planId } });
    await assertPlanShape(planId);
    const count = current.tasks.length;
    await engine.command({ type: 'send_message', projectId, nodeId: 'plan', mode: 'codex', input: [{ type: 'text', text: 'continue', text_elements: [] }] });
    const running = await waitFor(value => value.tasks.length > count && !!value.tasks.at(-1)?.turnId), task = running.tasks.at(-1)!;
    options.onEvent({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { id: task.turnId, status: 'completed', items: [] } } });
    await waitFor(value => value.tasks.at(-1)?.status === 'completed');
  }
  await sendWithPlan('one');
  assert.deepEqual(boundaries.splice(0), [{ method: 'thread/start', plan: null }, { method: 'turn/start', plan: 'one' }]);
  for (const [selection, expected] of [['two', 'two'], ['missing', null], ['one', 'one'], [undefined, null]] as const) {
    await sendWithPlan(selection);
    assert.deepEqual(boundaries.splice(0), [{ method: 'thread/resume', plan: expected }, { method: 'turn/start', plan: expected }], `selection ${selection}`);
  }
  const result = await snapshot();
  assert(result.tasks.every(task => task.status === 'completed'));
  assert(result.activities.some(activity => activity.kind === 'capability' && /已有/.test(activity.text)));
  assert(result.activities.some(activity => activity.kind === 'capability' && /未选择计划/.test(activity.text)));
  await t.test('readable Windows read-only stale map prevents replacement and clear before any resume or turn', { skip: process.platform !== 'win32' }, async () => {
    await sendWithPlan('one'); boundaries.splice(0);
    const previous = readFileSync(bindings, 'utf8');
    chmodSync(bindings, 0o444);
    try {
      assert.equal(statSync(bindings).mode & 0o200, 0);
      for (const planId of ['two', undefined]) {
        const current = await snapshot(), node = current.nodes.find(node => node.id === 'plan')!;
        await engine.command({ type: 'save_node', projectId, node: { ...node, planId } });
        await engine.command({ type: 'send_message', projectId, nodeId: 'plan', mode: 'codex', input: [{ type: 'text', text: 'continue with current selection', text_elements: [] }] });
        const stopped = await waitFor(value => value.tasks.length > current.tasks.length && (value.tasks.at(-1)!.status === 'failed' || !!value.tasks.at(-1)!.turnId));
        const task = stopped.tasks.at(-1)!;
        assert.equal(readFileSync(bindings, 'utf8'), previous, 'old mapping remains readable and unchanged');
        assert.equal(mapped(), 'one');
        assert.equal(task.status, 'failed');
        assert.match(task.error!, /无法确认计划绑定安全/);
        assert.deepEqual(boundaries, [], 'no native resume or turn may consume the stale map');
        assert(stopped.activities.some(activity => activity.taskId === task.id && activity.kind === 'error' && /无法确认计划绑定安全/.test(activity.text)));
        assert(!stopped.activities.some(activity => activity.taskId === task.id && /计划上下文已跳过/.test(activity.text)));
      }
    } finally { chmodSync(bindings, 0o666); }
  });
});
