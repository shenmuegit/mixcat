import test from 'node:test';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { join, resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { projectDirectory } from '../src/core/paths.js';
import { runtimeEnvironment } from '../src/core/comfy-runtime.js';

test('maintenance constructor and drained-source persistence failures preserve retryable host ownership', { timeout: 90000 }, async () => {
  const root = resolve('.'), proof = projectDirectory(root, '.runtime', 'task9-host-failure');
  await build({ entryPoints: ['tests/fixtures/comfy-maintenance-host-electron.ts'], outfile: join(proof, 'fixture.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'] });
  await new Promise<void>((resolve, reject) => {
    const child = spawn(join(root, 'node_modules/electron/dist/electron.exe'), [join(proof, 'fixture.cjs'), root], { cwd: root, env: runtimeEnvironment(root, '.runtime/task9-host-failure/environment'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { output += value; });
    child.once('error', reject); child.once('close', code => { writeFileSync(join(proof, 'result.log'), output); code === 0 ? resolve() : reject(Error(output)); });
  });
});
