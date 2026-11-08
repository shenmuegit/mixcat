import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensureProjectDirectory, projectDirectory } from '../src/core/paths.js';
import { ProjectStore } from '../src/core/store.js';

const base = projectDirectory(resolve('.'), '.runtime', 'implementation', 'fixtures');
test('Windows launcher selects codex.exe ahead of a PATH wrapper and preserves an explicit override', () => {
  const root=mkdtempSync(resolve(base,'codex-launcher-'));
  const scripts=projectDirectory(root,'scripts'), wrappers=projectDirectory(root,'npm'), native=projectDirectory(root,'native');
  copyFileSync(resolve('scripts/dev.ps1'),resolve(scripts,'dev.ps1'));
  writeFileSync(resolve(scripts,'build.mjs'),'');
  writeFileSync(resolve(scripts,'start.mjs'),'console.log(JSON.stringify({codex:process.env.MIXCAT_CODEX}));');
  writeFileSync(resolve(wrappers,'codex.ps1'),'throw "old wrapper must not be selected"');
  const executable=resolve(native,'codex.exe');writeFileSync(executable,'native entry fixture');
  const env:NodeJS.ProcessEnv={...process.env,MIXCAT_NODE:process.execPath,PATH:`${wrappers};${native};${process.env.PATH}`};delete env.MIXCAT_CODEX;
  const run=(override?:string)=>spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',resolve(scripts,'dev.ps1'),'start'],{cwd:root,env:{...env,...(override?{MIXCAT_CODEX:override}:{})},encoding:'utf8',windowsHide:true});
  const automatic=run();assert.equal(automatic.status,0,automatic.stderr);assert.equal(JSON.parse(automatic.stdout.trim()).codex,executable);
  const override=resolve(projectDirectory(root,'override'),'codex.exe');writeFileSync(override,'explicit entry fixture');
  const explicit=run(override);assert.equal(explicit.status,0,explicit.stderr);assert.equal(JSON.parse(explicit.stdout.trim()).codex,override);
});

test('C drive, relative and network roots are rejected before any project data is created', () => {
  for (const root of ['C:\\mixcat-forbidden-fixture', 'c:/mixcat-forbidden-fixture', '.', '\\\\server\\project']) assert.throws(() => ensureProjectDirectory(root), /非 C 盘/);
});
test('both launchers reject runtime junctions before creating profile or cache directories', () => {
  const fixture = mkdtempSync(resolve(base, 'launchers-'));
  const root = resolve(fixture, 'project'), outside = resolve(fixture, 'outside'); mkdirSync(root); mkdirSync(outside);
  mkdirSync(resolve(root, 'scripts')); copyFileSync(resolve('scripts/dev.ps1'), resolve(root, 'scripts/dev.ps1'));
  const link = resolve(root, '.runtime'); symlinkSync(outside, link, 'junction');
  try {
    const start = spawnSync(process.execPath, [resolve('scripts/start.mjs')], { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.notEqual(start.status, 0); assert.match(start.stderr, /Directory links/);
    const dev = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve(root, 'scripts/dev.ps1'), 'build'], { cwd: root, env: { ...process.env, MIXCAT_NODE: process.execPath }, encoding: 'utf8', windowsHide: true });
    assert.notEqual(dev.status, 0); assert.match(dev.stderr, /Runtime directory link/);
    assert.deepEqual(readdirSync(outside), []);
  } finally { rmSync(link); }
});
test('project and data paths reject ancestor junctions before creating any child', () => {
  const fixture = mkdtempSync(resolve(base, 'paths-'));
  const root = resolve(fixture, 'project'), outside = resolve(fixture, 'outside'); mkdirSync(root); mkdirSync(outside);
  const link = resolve(root, '.mixcat'); symlinkSync(outside, link, 'junction');
  try {
    assert.throws(() => new ProjectStore(root), /链接|联接/);
    assert.deepEqual(readdirSync(outside), []);
    assert.throws(() => projectDirectory(root, '..', 'escape'), /内部/);
    assert.equal(existsSync(resolve(fixture, 'escape')), false);
  } finally { rmSync(link); }
});
