import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { insideProject, projectDirectory } from './paths.js';
import { runtimeEnvironment } from './codex.js';
import { standaloneSkillDirectories } from './template-setup.js';

function npxCli() {
  for (const directory of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    const shim = join(directory, process.platform === 'win32' ? 'npx.cmd' : 'npx');
    if (!existsSync(shim)) continue;
    const resolved = realpathSync(shim);
    for (const path of [resolved.endsWith('npx-cli.js') ? resolved : '', join(dirname(resolved), 'node_modules', 'npm', 'bin', 'npx-cli.js')]) if (path && existsSync(path)) return path;
  }
  throw new Error('Impeccable 需要官方 npm/npx 运行环境，请安装 Node.js/npm 后重试此项。');
}

export async function installTemplateSkill(root: string, overwrite: boolean): Promise<void> {
  const roots = ['.agents', '.codex'].map(provider => insideProject(root, join(root, provider, 'skills')));
  for (let directory = root; ; directory = dirname(directory)) {
    if (existsSync(join(directory, '.git'))) {
      if (directory !== root) throw new Error('Impeccable 官方安装器会定位到上层 Git 仓库，超出当前项目；请以仓库根目录创建项目，或跳过此项。');
      break;
    }
    if (dirname(directory) === directory) break;
  }
  const pending = roots.flatMap(path => [insideProject(root, join(path, 'impeccable')), ...standaloneSkillDirectories(path, ['impeccable'])]);
  while (pending.length) {
    const path = pending.pop()!;
    if (!existsSync(path)) continue;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error('已有 Impeccable 目录含目录联接或链接，请先核对安装目标。');
    if (stat.isDirectory()) pending.push(...readdirSync(path).map(name => join(path, name)));
  }
  const home = projectDirectory(root, '.mixcat', 'codex');
  const env = { ...runtimeEnvironment(root, home), ELECTRON_RUN_AS_NODE: '1', npm_config_cache: projectDirectory(root, '.mixcat', 'capability-setup', 'npm-cache') };
  const args = [npxCli(), '--yes', '--package=impeccable', 'impeccable', 'install', '--providers=codex', '--project', '--no-hooks', '--yes', ...(overwrite ? ['--force'] : [])];
  await new Promise<void>((resolve, reject) => execFile(process.execPath, args, { cwd: root, env, windowsHide: true, timeout: 180000, maxBuffer: 1024 * 1024 }, error => {
    if (error) reject(Object.assign(new Error('Impeccable 官方安装未完成，请检查网络和 npm 运行环境后重新检查此项。'), { outcome: error.killed ? 'unknown' : 'failed' }));
    else resolve();
  }));
}
