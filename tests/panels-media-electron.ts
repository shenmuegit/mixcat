import test from 'node:test';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { appendFileSync, copyFileSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { projectDirectory } from '../src/core/paths.js';
import { runtimeEnvironment } from '../src/core/comfy-runtime.js';

test('guarded project video opens as an actual Electron player and plays decoded frames', { timeout: 45000 }, async () => {
  const root = resolve('.'), fixture = mkdtempSync(join(projectDirectory(root, '.runtime'), 'pm-'));
  copyFileSync(join(root, 'tests/fixtures/comfy-preview.mp4'), join(fixture, 'preview.mp4'));
  await build({ entryPoints: ['tests/fixtures/panels-media-electron.ts'], outfile: join(fixture, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'] });
  const env = { ...process.env, ...runtimeEnvironment(fixture) }; delete env.ELECTRON_RUN_AS_NODE;
  console.log(`Panel media proof: ${fixture}`);
  await new Promise<void>((resolve, reject) => { const child = spawn(join(root, 'node_modules/electron/dist/electron.exe'), [join(fixture, 'main.cjs'), fixture], { cwd: fixture, env, windowsHide: false, stdio: ['ignore','pipe','pipe'] }); const log = join(fixture,'electron.log'); child.stdout.on('data',v=>appendFileSync(log,v)); child.stderr.on('data',v=>appendFileSync(log,v)); child.once('error',reject); child.once('close',code=>code===0?resolve():reject(Error(`Native media proof failed (${code}); ${log}`))); });
});
