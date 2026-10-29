import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { join, resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { projectDirectory } from '../src/core/paths.js';
import { runtimeEnvironment } from '../src/core/comfy-runtime.js';

const root = resolve('.'), proof = projectDirectory(root, '.runtime', 'comfy-native-live');
if (!process.env.MIXCAT_CODEX) throw Error('Set MIXCAT_CODEX to the current official executable.');
await build({ entryPoints: ['tests/fixtures/comfy-native-live.ts'], outfile: join(proof, 'harness.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'] });
const env = runtimeEnvironment(root); delete env.ELECTRON_RUN_AS_NODE;
env.MIXCAT_CODEX = process.env.MIXCAT_CODEX; env.MIXCAT_ACCOUNT_ROOT = process.env.MIXCAT_ACCOUNT_ROOT;
await new Promise<void>((resolve, reject) => {
  const child = spawn(join(root, 'node_modules/electron/dist/electron.exe'), [join(proof, 'harness.cjs'), root], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', value => { output += value; process.stdout.write(value); }); child.stderr.on('data', value => { output += value; });
  child.once('error', reject); child.once('close', code => { writeFileSync(join(proof, 'electron.log'), output); code === 0 ? resolve() : reject(Error(`Real native proof failed (${code}); inspect project-local electron.log.`)); });
});
