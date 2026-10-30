import test from 'node:test';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { join, resolve } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { projectDirectory } from '../src/core/paths.js';
import { runtimeEnvironment } from '../src/core/comfy-runtime.js';

test('real Electron safeStorage and trusted provider settings UI across process reopening', { timeout: 90000 }, async () => {
  const root = resolve('.'), proof = projectDirectory(root, '.runtime', 'comfy-credentials-proof');
  const project = mkdtempSync(join(proof, 'project-'));
  await build({ entryPoints: ['tests/fixtures/comfy-credentials-electron.ts'], outfile: join(proof, 'harness.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'] });
  await build({ entryPoints: ['src/desktop/preload.ts'], outfile: join(proof, 'preload.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'] });
  await build({ entryPoints: ['tests/fixtures/comfy-credentials-renderer.tsx'], outfile: join(proof, 'renderer.js'), bundle: true, platform: 'browser', jsx: 'automatic', target: 'chrome144' });
  writeFileSync(join(proof, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="renderer.css"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>');
  const env = runtimeEnvironment(root); delete env.ELECTRON_RUN_AS_NODE;
  for (const phase of ['save', 'reopen']) await new Promise<void>((resolve, reject) => {
    const child = spawn(join(root, 'node_modules/electron/dist/electron.exe'), [join(proof, 'harness.cjs'), root, project, phase], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; const timer = setTimeout(() => { child.kill(); reject(Error('Credential native proof timed out')); }, 40000);
    child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { output += value; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); writeFileSync(join(proof, `${phase}.log`), output); code === 0 ? resolve() : reject(Error(`Credential native proof failed (${code}): ${output}`)); });
  });
});
