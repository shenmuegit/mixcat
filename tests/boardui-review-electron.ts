import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import type { Metafile } from 'esbuild';

const electron: string = createRequire(import.meta.url)('electron');

const runtime = resolve('.runtime/boardui-review');
const packageDirectory = join(runtime, 'app');

test('reviewWindowDoesNotInvokeProductBridges', { timeout: 45000 }, t => {
  const manifest = JSON.parse(readFileSync(join(packageDirectory, 'dependency-manifest.json'), 'utf8')) as Record<'main' | 'renderer', Metafile>;
  assert.deepEqual(Object.keys(manifest), ['main', 'renderer']);
  assert.deepEqual(Object.keys(manifest.main.inputs), ['src/desktop/boardui-review.ts']);
  assert.deepEqual(Object.values(manifest.main.inputs)[0].imports.map(({ path }) => path).sort(),
    ['electron', 'node:fs', 'node:fs/promises', 'node:path'].sort());
  for (const [input, info] of Object.entries(manifest.renderer.inputs)) {
    assert.match(input, /^src\/renderer\/(?:theme\.css$|boardui-review\/)|(?:^|\/)node_modules\/(?:react|react-dom|scheduler)\//);
    assert.equal(info.imports.some(item => item.external), false);
  }

  const fixture = mkdtempSync(join(runtime, 'electron-'));
  cpSync(packageDirectory, join(fixture, 'app'), { recursive: true });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const name of ['TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'XDG_CACHE_HOME']) {
    env[name] = join(fixture, name);
    mkdirSync(env[name], { recursive: true });
  }
  const result = spawnSync(electron, [
    resolve('tests/fixtures/boardui-review-electron.cjs'), '#/034/tree-view', fixture,
  ], { cwd: fixture, env, timeout: 40000, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  t.diagnostic(result.stdout.trim());
  t.diagnostic('Electron evidence: ' + fixture);
});

test('review launcher rejects missing assets before starting Electron', { timeout: 12000 }, () => {
  mkdirSync(runtime, { recursive: true });
  const fixture = mkdtempSync(join(runtime, 'launcher-'));
  mkdirSync(join(fixture, 'scripts'));
  mkdirSync(join(fixture, 'src', 'core'), { recursive: true });
  cpSync('scripts/boardui-review.mjs', join(fixture, 'scripts', 'boardui-review.mjs'));
  cpSync('src/core/paths.ts', join(fixture, 'src', 'core', 'paths.ts'));
  const output = join(fixture, '.runtime', 'boardui-review', 'app');
  mkdirSync(output, { recursive: true });
  for (const name of ['index.html', 'review.js', 'mixcat.ico', 'dependency-manifest.json']) {
    writeFileSync(join(output, name), '');
  }
  writeFileSync(join(output, 'main.cjs'), 'console.log("launcher fixture started"); process.exit(0);');

  const result = spawnSync(process.execPath, ['scripts/boardui-review.mjs', '--start'], {
    cwd: fixture, timeout: 10000, encoding: 'utf8',
  });
  assert.ifError(result.error);
  assert.match(result.stderr, /missing: review\.css/);
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /launcher fixture started/);
});
