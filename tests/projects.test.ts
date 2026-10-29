import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WorkflowEngine } from '../src/core/engine.js';
import { projectDirectory } from '../src/core/paths.js';

const base = projectDirectory(resolve('.'), '.runtime', 'implementation', 'fixtures');
test('formal index restores name, goal and root without loading prototype index or changing root ignore', async () => {
  const workbenchRoot = mkdtempSync(resolve(base, 'projects-'));
  const root = resolve(workbenchRoot, 'project'); mkdirSync(root);
  writeFileSync(resolve(root, '.gitignore'), '# user-owned\n');
  const archived = resolve(workbenchRoot, '.runtime/workbench'); mkdirSync(archived, { recursive: true });
  writeFileSync(resolve(archived, 'projects.json'), JSON.stringify(['C:\\invalid-old-index']));
  let engine = new WorkflowEngine({ workbenchRoot, executable: 'unused-codex' });
  let id: string;
  try {
    await engine.init();
    assert.equal((await engine.command({ type: 'snapshot' })).snapshot.projects.length, 0);
    const first = await engine.command({ type: 'create_project', name: '正式项目', goal: '保持真实目标', root });
    id = first.snapshot.selected!.project.id;
    const duplicate = await engine.command({ type: 'create_project', name: 'different', goal: 'different', root });
    assert.equal(duplicate.snapshot.projects.length, 1);
    assert.equal(duplicate.snapshot.selected!.project.id, id);
    assert.equal(existsSync(resolve(workbenchRoot, '.runtime/client/projects.json')), true);
  } finally { await engine.close(); }
  engine = new WorkflowEngine({ workbenchRoot, executable: 'unused-codex' });
  try {
    await engine.init();
    const result = await engine.command({ type: 'snapshot', projectId: id! });
    assert.deepEqual(result.snapshot.projects.map(({ id, name, root }) => ({ id, name, root })), [{ id: id!, name: '正式项目', root }]);
    assert(result.snapshot.projects.every(project => !Object.hasOwn(project, 'goal')));
    assert.equal(readFileSync(resolve(root, '.gitignore'), 'utf8'), '# user-owned\n');
  } finally { await engine.close(); }
});

test('invalid project metadata is rejected before creating project data', async () => {
  const workbenchRoot = mkdtempSync(resolve(base, 'invalid-'));
  const root = resolve(workbenchRoot, 'project'); mkdirSync(root);
  const engine = new WorkflowEngine({ workbenchRoot, executable: 'unused-codex' });
  try {
    await engine.init();
    await assert.rejects(engine.command({ type: 'create_project', name: '', goal: 'goal', root }), /项目名称/);
    assert.equal(existsSync(resolve(root, '.mixcat')), false);
  } finally { await engine.close(); }
});

test('failed index commit never registers a project or acknowledges same-root retry', async () => {
  const workbenchRoot = mkdtempSync(resolve(base, 'index-commit-'));
  const root = projectDirectory(workbenchRoot, 'project');
  let engine = new WorkflowEngine({ workbenchRoot, executable: 'unused-codex' });
  const command = { type: 'create_project' as const, name: '注册重试', goal: '索引必须提交后才能成功', root };
  try {
    await engine.init();
    const obstacle = projectDirectory(workbenchRoot, '.runtime', 'client', 'projects.json.tmp');
    await assert.rejects(engine.command(command));
    const afterFailure = (await engine.command({ type: 'snapshot' })).snapshot;
    assert.equal(afterFailure.projects.length, 0);
    assert.equal(afterFailure.selected, null);
    assert.equal(existsSync(resolve(workbenchRoot, '.runtime/client/projects.json')), false);
    await assert.rejects(engine.command(command));
    rmdirSync(obstacle);
    const registered = (await engine.command(command)).snapshot;
    assert.equal(registered.projects.length, 1);
    assert.equal(registered.selected!.project.root, root);
    assert.equal((await engine.command(command)).snapshot.projects.length, 1);
  } finally { await engine.close(); }
  engine = new WorkflowEngine({ workbenchRoot, executable: 'unused-codex' });
  try {
    await engine.init();
    assert.deepEqual((await engine.command({ type: 'snapshot' })).snapshot.projects.map(project => project.root), [root]);
  } finally { await engine.close(); }
});

test('index temporary symlink is refused without changing target, registered projects or selection', async () => {
  const workbenchRoot = mkdtempSync(resolve(base, 'index-link-'));
  const first = projectDirectory(workbenchRoot, 'first'), second = projectDirectory(workbenchRoot, 'second');
  const external = mkdtempSync(resolve(base, 'index-protected-'));
  const target = resolve(external, 'protected.json'); writeFileSync(target, 'keep target unchanged');
  const engine = new WorkflowEngine({ workbenchRoot, executable: 'unused-codex' });
  const temporary = resolve(workbenchRoot, '.runtime/client/projects.json.tmp');
  try {
    await engine.init();
    const initial = (await engine.command({ type: 'create_project', name: '已有项目', goal: '保持选择', root: first })).snapshot;
    symlinkSync(target, temporary, 'file');
    await assert.rejects(engine.command({ type: 'create_project', name: '新项目', goal: '拒绝临时路径逃逸', root: second }), /链接|联接/);
    const current = (await engine.command({ type: 'snapshot' })).snapshot;
    assert.deepEqual(current.projects, initial.projects);
    assert.equal(current.selected!.project.id, initial.selected!.project.id);
    assert.equal(readFileSync(target, 'utf8'), 'keep target unchanged');
    assert.deepEqual(JSON.parse(readFileSync(resolve(workbenchRoot, '.runtime/client/projects.json'), 'utf8')), [first]);
  } finally { if (existsSync(temporary)) rmSync(temporary); await engine.close(); }
});
