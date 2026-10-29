import test from 'node:test';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { runtimeEnvironment } from '../src/core/comfy-runtime.js';

test('thin Python nodes use installed native types and execution identity', { timeout: 120000 }, async () => {
  const root = resolve('.');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(join(root, '.mixcat/comfy/runtime/comfy043-py31410-cpu1/venv/Scripts/python.exe'), [join(root, 'tests/comfy-python/test_nodes.py'), root], { cwd: root, env: runtimeEnvironment(root), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { output += value; });
    child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(Error(output)));
  });
});
