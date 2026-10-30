import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import electron from 'electron';
import { parseComfyMaintenance } from '../core/comfy-maintenance.js';
import { insideProject } from '../core/paths.js';
import { runtimeEnvironment } from '../core/comfy-runtime.js';

try {
  if (process.versions.electron) throw Error('Launch maintenance with Node, not Electron directly.');
  const args = process.argv.slice(2), request = parseComfyMaintenance(args), root = request.root;
  if (!existsSync(insideProject(root, join(root, '.mixcat/state/workflow.sqlite')))) throw Error('维护命令只接受已存在的 Mixcat 项目。');
  const env = { ...runtimeEnvironment(root, '.mixcat/comfy/maintenance'), NODE_DISABLE_COMPILE_CACHE: '1', MIXCAT_COMFY_MAINTENANCE_ROOT: root };
  const child = spawn(electron as unknown as string, [join(__dirname, 'comfy-maintenance.cjs'), ...args], { cwd: process.cwd(), env, windowsHide: true, stdio: 'inherit' });
  child.once('error', error => { console.error(error.message); process.exitCode = 1; });
  child.once('exit', code => { process.exitCode = code ?? 1; });
} catch (error) { console.error((error as Error).message); process.exitCode = 1; }
