import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { insideProject, projectDirectory } from '../src/core/paths.js';
import { runtimeEnvironment } from '../src/core/comfy-runtime.js';

test('actual production workspace preserves native drafts, session feedback, visibility and safe quit', { timeout: 600000 }, async () => {
  const root = resolve('.'), proof = projectDirectory(root, '.runtime');
  const fixture = insideProject(root, process.env.MIXCAT_COMFY_UI_FIXTURE ?? mkdtempSync(join(proof, 'cw-'))), project = projectDirectory(fixture, 'project');
  console.log(`Workspace proof: ${fixture}`);
  cpSync(join(root, 'dist/client'), insideProject(fixture, join(projectDirectory(fixture, 'dist'), 'client')), { recursive: true });
  const version = 'comfy043-py31410-cpu1', source = insideProject(root, join(root, '.mixcat/comfy/runtime', version)), destination = projectDirectory(project, '.mixcat', 'comfy', 'runtime', version);
  if (!existsSync(join(destination, 'ready.json'))) {
    const copy = spawnSync('robocopy.exe', [source, destination, '/E', '/MT:16', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/XD', 'backend-failed-clone'], { windowsHide: true, encoding: 'utf8' });
    writeFileSync(join(fixture, 'runtime-copy.log'), copy.stdout + copy.stderr); assert(copy.status !== null && copy.status < 8, 'contained runtime copy');
  }
  await build({ entryPoints: ['tests/fixtures/comfy-workspace-electron.ts'], outfile: join(fixture, 'harness.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'] });
  const env: NodeJS.ProcessEnv = { ...runtimeEnvironment(fixture), MIXCAT_ACCOUNT_ROOT: fixture, MIXCAT_HOST_CODEX_HOME: projectDirectory(fixture, 'host-codex') }; delete env.ELECTRON_RUN_AS_NODE;
  if (process.env.MIXCAT_COMFY_UI_PHASE === 'interactive') rmSync(insideProject(fixture, join(fixture, 'finish-interaction')), { force: true });
  await new Promise<void>((resolve, reject) => {
    const child = spawn(join(root, 'node_modules/electron/dist/electron.exe'), [join(fixture, 'harness.cjs'), fixture, process.execPath, `--workbench-root=${fixture}`, `--codex=${process.execPath}`, ...(process.env.MIXCAT_COMFY_UI_PHASE === 'media' ? ['--media'] : process.env.MIXCAT_COMFY_UI_PHASE === 'interactive' ? ['--interactive'] : process.env.MIXCAT_COMFY_UI_PHASE === 'quit' ? ['--quit'] : process.env.MIXCAT_COMFY_UI_PHASE === 'feedback' ? ['--feedback'] : process.env.MIXCAT_COMFY_UI_PHASE === 'keyboard' ? ['--keyboard'] : [])], { cwd: fixture, env, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const log = join(fixture, 'electron.log'); child.stdout.on('data', value => appendFileSync(log, value)); child.stderr.on('data', value => appendFileSync(log, value));
    child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(Error(`Workspace proof failed (${code}); ${log}`)));
  });
});
