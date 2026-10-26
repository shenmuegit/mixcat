import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { preparePlanningRuntime, bindPlanningThread } from '../src/core/planning.js';
import { projectDirectory } from '../src/core/paths.js';

const base = projectDirectory(resolve('.'), '.runtime', 'implementation', 'web-product-team-20261022', 'tmp');
const pluginRoot = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'plugins', 'cache', 'planning-with-files', 'planning-with-files');
const installedSkills = existsSync(pluginRoot) ? readdirSync(pluginRoot).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  .map(version => join(pluginRoot, version, '.agents', 'skills', 'planning-with-files')) : [];
const skill = process.env.MIXCAT_PLANNING_SKILL ?? installedSkills.find(path => existsSync(join(path, 'SKILL.md')))
  ?? join(homedir(), '.agents', 'skills', 'planning-with-files');
const fixture = () => mkdtempSync(join(base, 'planning project '));
function plan(root: string, id: string, text: string) {
  const path = projectDirectory(root, '.planning', id);
  writeFileSync(join(path, 'task_plan.md'), `# ${text}\n### Phase 1\n**Status:** in_progress\n`);
  writeFileSync(join(path, 'progress.md'), `${text} progress\n`);
}

test('plan replacement, invalid replacement and cleared selection never retain the previous thread mapping', () => {
  const root = fixture(); plan(root, 'one', 'FIRST'); plan(root, 'two', 'SECOND');
  const bindings = join(root, '.mixcat', 'planning', 'threads.json');
  const threads = () => JSON.parse(readFileSync(bindings, 'utf8')).threads;
  bindPlanningThread(root, 'current', 'one'); bindPlanningThread(root, 'other', 'one');
  bindPlanningThread(root, 'current', 'two');
  assert.deepEqual(threads(), { current: 'two', other: 'one' });
  assert.throws(() => bindPlanningThread(root, 'current', 'missing'), /已有/);
  assert.deepEqual(threads(), { other: 'one' });
  bindPlanningThread(root, 'current', 'one');
  bindPlanningThread(root, 'current', undefined);
  assert.deepEqual(threads(), { other: 'one' });
  bindPlanningThread(root, 'current', 'one');
  assert.throws(() => bindPlanningThread(root, 'current', '../two'), /标识/);
  assert.deepEqual(threads(), { other: 'one' });
});

test('planning runtime uses native home hooks and migrates only generated legacy root hooks without duplicates', () => {
  const root = fixture();
  projectDirectory(root, '.codex');
  projectDirectory(root, '.mixcat', 'codex');
  const existing = { custom: 'preserved', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo existing' }] }] } };
  writeFileSync(join(root, '.codex', 'hooks.json'), JSON.stringify(existing));
  const nativeExisting = { custom: 'native-preserved', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo native existing' }] }] } };
  writeFileSync(join(root, '.mixcat', 'codex', 'hooks.json'), JSON.stringify(nativeExisting));
  const prepared = preparePlanningRuntime(root, skill);
  assert.equal(prepared.hookConfigPath, join(root, '.mixcat', 'codex', 'hooks.json'));
  assert.equal(prepared.initialSessionBinding, 'unbound');
  assert.equal(prepared.trust, 'host-required');
  assert.equal(prepared.officialFiles.length, 17);
  for (const file of prepared.officialFiles) assert.deepEqual(readFileSync(file.target), readFileSync(file.source));
  const first = readFileSync(prepared.hookConfigPath, 'utf8');
  assert.deepEqual(JSON.parse(first).hooks.PreToolUse[0], nativeExisting.hooks.PreToolUse[0]);
  assert.equal(JSON.parse(first).custom, 'native-preserved');
  assert.equal(Object.keys(JSON.parse(first).hooks).length, 7);
  assert.equal(readFileSync(join(root, '.codex', 'hooks.json'), 'utf8'), JSON.stringify(existing));
  const generated = JSON.parse(first).hooks;
  const legacyNeighbour = { type: 'command', command: 'echo legacy neighbour' };
  const legacy = { ...existing, hooks: { ...generated, PreToolUse: [...existing.hooks.PreToolUse, ...generated.PreToolUse.slice(1)], UserPromptSubmit: [{ hooks: [...generated.UserPromptSubmit[0].hooks, legacyNeighbour] }] } };
  writeFileSync(join(root, '.codex', 'hooks.json'), JSON.stringify(legacy));
  preparePlanningRuntime(root, skill);
  assert.equal(readFileSync(prepared.hookConfigPath, 'utf8'), first);
  const migrated = JSON.parse(readFileSync(join(root, '.codex', 'hooks.json'), 'utf8'));
  assert.equal(migrated.custom, existing.custom);
  assert.deepEqual(migrated.hooks.PreToolUse, existing.hooks.PreToolUse);
  assert.deepEqual(migrated.hooks.UserPromptSubmit, [{ hooks: [legacyNeighbour] }]);
  for (const event of ['SessionStart', 'PermissionRequest', 'PostToolUse', 'PreCompact', 'Stop']) assert.deepEqual(migrated.hooks[event], []);
  const migratedRaw = readFileSync(join(root, '.codex', 'hooks.json'), 'utf8');
  preparePlanningRuntime(root, skill);
  assert.equal(readFileSync(join(root, '.codex', 'hooks.json'), 'utf8'), migratedRaw);
  assert.equal(readFileSync(prepared.hookConfigPath, 'utf8'), first);
  assert.equal(existsSync(join(root, '.codex', 'config.toml')), false);
});

test('real official hooks isolate two threads, safely skip unbound or invalid pins, and persist resume bindings', () => {
  const root = fixture();
  plan(root, 'one', 'ALPHA_ONLY'); plan(root, 'two', 'BETA_ONLY');
  const prepared = preparePlanningRuntime(root, join(skill, 'SKILL.md'));
  const invoke = (event: string, session: string, env: NodeJS.ProcessEnv = {}, payload: Record<string, unknown> = {}) => {
    const result = spawnSync(prepared.pythonExecutable, ['-I', '-B', prepared.adapterPath, event], {
      cwd: root, input: JSON.stringify({ session_id: session, cwd: root, ...payload }),
      env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true, timeout: 30000,
    });
    assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
    return { ...result, output: result.stdout.trim() ? JSON.parse(result.stdout) : {} };
  };
  assert.match(invoke('SessionStart', 'early').stderr, /unbound/);
  projectDirectory(root, '.planning', 'sessions');
  bindPlanningThread(root, 'thread-a', 'one'); bindPlanningThread(root, 'thread-b', 'two');
  const alpha = invoke('UserPromptSubmit', 'thread-a'), beta = invoke('UserPromptSubmit', 'thread-b');
  assert.match(alpha.stdout, /ALPHA_ONLY/); assert.doesNotMatch(alpha.stdout, /BETA_ONLY/);
  assert.match(beta.stdout, /BETA_ONLY/); assert.doesNotMatch(beta.stdout, /ALPHA_ONLY/);
  assert.equal(invoke('UserPromptSubmit', 'unknown', { PLAN_ID: 'two', PWF_SESSION_ID: 'thread-a' }).stdout, '');
  assert.match(invoke('SessionStart', 'thread-a', {}, { cwd: '.' }).stderr, /cwd/);
  assert.match(invoke('SessionStart', 'thread-a', { PWF_PLAN_ROOT: dirname(root) }).stderr, /project pin/);
  assert.match(invoke('SessionStart', 'thread-a', {}, { cwd: dirname(root) }).stderr, /cwd/);
  for (const event of ['SessionStart', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'PreCompact', 'Stop']) {
    const result = invoke(event, 'thread-a', {}, { tool_name: 'Write' });
    assert.doesNotMatch(result.stderr, /Traceback|skipped|hook\]/);
    assert.notEqual(result.output.decision, 'block');
    if (event === 'SessionStart' || event === 'PreToolUse') assert.match(result.stdout, /ALPHA_ONLY/);
    if (event === 'PermissionRequest') assert.match(result.stdout, /Active plan/);
    if (event === 'PostToolUse') assert.match(result.stdout, /update|plan|changes/i);
    if (event === 'PreCompact') assert.match(result.stdout, /PreCompact/);
    if (event === 'Stop') assert.match(result.stdout, /Task in progress/);
  }
  const saved = readFileSync(prepared.bindingsPath, 'utf8');
  preparePlanningRuntime(root, skill);
  assert.equal(readFileSync(prepared.bindingsPath, 'utf8'), saved);
  const resumed = invoke('SessionStart', 'thread-b');
  assert.match(resumed.stdout, /BETA_ONLY/); assert.doesNotMatch(resumed.stdout, /ALPHA_ONLY/);
  const mapped = JSON.parse(saved); mapped.threads['thread-a'] = 'absent';
  writeFileSync(prepared.bindingsPath, JSON.stringify(mapped));
  assert.equal(invoke('UserPromptSubmit', 'thread-a').stdout, '');
  const corrupted = JSON.parse(saved); corrupted.root = dirname(root);
  writeFileSync(prepared.bindingsPath, JSON.stringify(corrupted));
  assert.match(invoke('SessionStart', 'thread-a').stderr, /binding root/);
  assert.throws(() => bindPlanningThread(root, 'thread-a', 'one'), /root/);
});

test('Windows manifest command works in a project path containing spaces', { skip: process.platform !== 'win32' }, () => {
  const root = projectDirectory(fixture(), 'project & 50% plan'); plan(root, 'one', 'WINDOWS_PATH');
  const prepared = preparePlanningRuntime(root, skill); bindPlanningThread(root, 'thread-windows', 'one');
  const config = JSON.parse(readFileSync(prepared.hookConfigPath, 'utf8'));
  const command = config.hooks.UserPromptSubmit[0].hooks[0].commandWindows;
  const result = spawnSync('cmd.exe', ['/d', '/s', '/c', command], {
    cwd: root, input: JSON.stringify({ session_id: 'thread-windows', cwd: root }), encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /WINDOWS_PATH/);
  const unsupported = projectDirectory(fixture(), "user's project");
  assert.throws(() => preparePlanningRuntime(unsupported, skill), /单引号/);
  assert.equal(existsSync(join(unsupported, '.mixcat')), false);
});

test('planning paths and malformed existing configuration fail before creating runtime files', () => {
  for (const root of ['C:/forbidden-planning', '.', '\\\\server\\share']) assert.throws(() => preparePlanningRuntime(root, skill));
  const root = fixture(); projectDirectory(root, '.codex');
  writeFileSync(join(root, '.codex', 'hooks.json'), '{broken');
  assert.throws(() => preparePlanningRuntime(root, skill));
  assert.equal(existsSync(join(root, '.mixcat')), false);
  writeFileSync(join(root, '.codex', 'hooks.json'), JSON.stringify({ hooks: { Stop: {} } }));
  assert.throws(() => preparePlanningRuntime(root, skill));
  assert.equal(existsSync(join(root, '.mixcat')), false);
  writeFileSync(join(root, '.codex', 'hooks.json'), '{}');
  preparePlanningRuntime(root, skill); plan(root, 'one', 'SAFE');
  const invalidNative = fixture(); projectDirectory(invalidNative, '.mixcat', 'codex');
  writeFileSync(join(invalidNative, '.mixcat', 'codex', 'hooks.json'), '{broken native config');
  assert.throws(() => preparePlanningRuntime(invalidNative, skill));
  assert.equal(existsSync(join(invalidNative, '.mixcat', 'planning')), false);
  assert.equal(readFileSync(join(invalidNative, '.mixcat', 'codex', 'hooks.json'), 'utf8'), '{broken native config');
  for (const id of ['../one', '', '.hidden', 'one/two']) assert.throws(() => bindPlanningThread(root, 'thread', id));
  assert.throws(() => bindPlanningThread(root, '', 'one'));
  assert.throws(() => bindPlanningThread(root, 'thread', 'absent'));
  const outside = fixture(), linked = join(root, '.planning', 'linked');
  symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  try { assert.throws(() => bindPlanningThread(root, 'thread', 'linked'), /链接|联接/); assert.deepEqual(readdirSync(outside), []); }
  finally { unlinkSync(linked); }
  const linkedRoot = fixture(); symlinkSync(outside, join(linkedRoot, '.mixcat'), process.platform === 'win32' ? 'junction' : 'dir');
  try { assert.throws(() => preparePlanningRuntime(linkedRoot, skill), /链接|联接/); }
  finally { unlinkSync(join(linkedRoot, '.mixcat')); }
  const source = fixture(); mkdirSync(join(source, 'scripts')); symlinkSync(join(skill, 'SKILL.md'), join(source, 'SKILL.md'));
  assert.throws(() => preparePlanningRuntime(fixture(), source), /链接|联接/);
});
