import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensureProjectDirectory, projectDirectory } from '../src/core/paths.js';
import { ProjectStore } from '../src/core/store.js';

test('project and launchers reject intermediate runtime junctions before creating data', () => {
  const base = resolve('.runtime/tests'); mkdirSync(base, { recursive: true }); const fixture = mkdtempSync(resolve(base, 'paths-'));
  const project = resolve(fixture, 'project'), outside = resolve(fixture, 'outside'); mkdirSync(project); mkdirSync(outside); mkdirSync(resolve(project, 'scripts'));
  copyFileSync(resolve('scripts/dev.ps1'), resolve(project, 'scripts/dev.ps1'));
  const link = resolve(project, '.runtime'); symlinkSync(outside, link, 'junction');
  try {
    assert.equal(ensureProjectDirectory(project), project);
    assert.throws(() => projectDirectory(project, '.runtime', 'tmp'), /链接|联接/);
    const launch = spawnSync(process.execPath, [resolve('scripts/start.mjs')], { cwd: project, encoding: 'utf8' });
    assert.notEqual(launch.status, 0); assert.match(launch.stderr, /Directory links/);
    const ps = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve(project, 'scripts/dev.ps1'), 'build'], { cwd: project, env: { ...process.env, MIXCAT_NODE: process.execPath }, encoding: 'utf8' });
    assert.notEqual(ps.status, 0); assert.match(ps.stderr, /Runtime directory link/);
    assert.equal(existsSync(resolve(outside, 'tmp')), false); assert.equal(existsSync(resolve(outside, 'desktop')), false);
  } finally { rmSync(link); }
});

test('project runtime and future login files are ignored by Git without changing the project ignore file', () => {
  const root = mkdtempSync(resolve('.runtime/tests/git-ignore-'));
  const init = spawnSync('git', ['init', '--quiet', root], { encoding: 'utf8' }); assert.equal(init.status, 0, init.stderr);
  const store = new ProjectStore(root); store.close();
  mkdirSync(resolve(root, '.mixcat/codex')); writeFileSync(resolve(root, '.mixcat/codex/auth.json'), '{"fixture":"no-secret"}');
  const ignored = spawnSync('git', ['-C', root, 'check-ignore', '.mixcat/codex/auth.json', '.mixcat/state/workflow.sqlite'], { encoding: 'utf8' });
  assert.equal(ignored.status, 0); assert.match(ignored.stdout, /auth\.json/); assert.match(ignored.stdout, /workflow\.sqlite/); assert.equal(existsSync(resolve(root, '.gitignore')), false);
});
