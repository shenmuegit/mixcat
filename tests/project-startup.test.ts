import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkflowEngine } from '../src/core/engine.js';
import { insideProject, projectDirectory } from '../src/core/paths.js';
import { ProjectStore } from '../src/core/store.js';
import { fixture } from './runtime-fixture.js';

for (const action of ['remove', 'retry'] as const) test(`missing projects stay visible, preserve the catalog and support ${action}`, async t => {
  const f = await fixture(t), missing = projectDirectory(f.root, 'missing');
  const original = (await f.engine.command({ type: 'create_project', root: missing, name: 'Offline project', goal: 'Original goal' })).snapshot.selected!;
  await f.engine.close();
  const moved = insideProject(f.root, join(f.root, 'moved'));
  renameSync(insideProject(f.root, missing), moved);
  const reopened = new WorkflowEngine({ workbenchRoot: f.root, executable: 'unused', nativeFactory() { assert.fail('Startup must not run native work'); } });
  t.after(() => reopened.close()); await reopened.init();
  const snapshot = (await reopened.command({ type: 'snapshot' })).snapshot;
  const unavailable = snapshot.projects.find(project => project.root === missing)!;
  assert(unavailable.unavailable); assert.equal(snapshot.projects.length, 2);
  assert((await reopened.command({ type: 'snapshot', projectId: f.projectId })).snapshot.selected);
  const added = projectDirectory(f.root, 'added');
  await reopened.command({ type: 'create_project', root: added, name: 'Added', goal: 'Healthy' });
  assert(JSON.parse(readFileSync(join(f.root, '.runtime/client/projects.json'), 'utf8')).includes(missing));
  if (action === 'remove') {
    const reply = await reopened.command({ type: 'delete_project', projectId: unavailable.id });
    assert(!reply.snapshot.projects.some(project => project.id === unavailable.id));
    assert(existsSync(moved));
  } else {
    renameSync(insideProject(f.root, moved), insideProject(f.root, missing));
    const restored = (await reopened.command({ type: 'create_project', root: missing, name: 'Ignored', goal: 'Ignored' })).snapshot;
    assert.equal(restored.selected!.project.id, original.project.id);
    assert.equal(restored.selected!.project.goal, 'Original goal');
    assert.deepEqual(restored.selected!.nodes, original.nodes.map(node => ({ ...node, model: node.model ?? null, skills: node.skills ?? [], plugins: node.plugins ?? [] })));
    assert(!restored.projects.some(project => project.unavailable));
  }
});

test('an already owned project remains retryable without preventing workbench startup', async t => {
  const f = await fixture(t), root = projectDirectory(f.root, 'second-workbench');
  writeFileSync(join(projectDirectory(root, '.runtime', 'client'), 'projects.json'), JSON.stringify([f.root]));
  const other = new WorkflowEngine({ workbenchRoot: root, executable: 'unused' });
  t.after(() => other.close()); await other.init();
  const blocked = (await other.command({ type: 'snapshot' })).snapshot.projects[0];
  assert.match(blocked.unavailable!, /其他.*工作台/);
  await f.engine.close();
  const opened = (await other.command({ type: 'create_project', root: f.root, name: 'Ignored', goal: 'Ignored' })).snapshot;
  assert.equal(opened.selected!.project.id, f.projectId);
  assert(!opened.projects.some(project => project.unavailable));
});

test('a damaged project does not prevent healthy projects from opening', async t => {
  const f = await fixture(t), damaged = projectDirectory(f.root, 'damaged');
  await f.engine.command({ type: 'create_project', root: damaged, name: 'Damaged', goal: 'Original' });
  await f.engine.close();
  const store = new ProjectStore(damaged);
  store.db.prepare('UPDATE project_state SET body=?').run('{damaged'); store.close();
  const reopened = new WorkflowEngine({ workbenchRoot: f.root, executable: 'unused' });
  t.after(() => reopened.close()); await reopened.init();
  const snapshot = (await reopened.command({ type: 'snapshot', projectId: f.projectId })).snapshot;
  assert.equal(snapshot.selected!.project.id, f.projectId);
  assert(snapshot.projects.find(project => project.root === damaged)!.unavailable);
  const inspect = new ProjectStore(damaged);
  assert.equal(inspect.db.prepare('SELECT body FROM project_state').get()!.body, '{damaged'); inspect.close();
});
