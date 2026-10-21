import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';

if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Use scripts/dev.ps1 start with Node 24+.');
const root = resolve(process.cwd());
if (/^c:/i.test(root)) throw new Error('Mixcat workspace must be on a non-C drive.');
let ancestor = root;
for (;;) { if (lstatSync(ancestor).isSymbolicLink()) throw new Error('Workspace cannot use directory links.'); const parent = dirname(ancestor); if (parent === ancestor) break; ancestor = parent; }
const profile = join(root, '.runtime', 'client', 'desktop');
function safeDirectory(path) {
  let current = path;
  for (;;) { if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`Directory links are not allowed: ${current}`); const parent = dirname(current); if (parent === current) break; current = parent; }
  mkdirSync(path, { recursive: true });
  const actual = relative(root, realpathSync(path)); if (!actual || actual.startsWith('..') || isAbsolute(actual)) throw new Error('Runtime directory escaped workspace.');
  return path;
}
for (const name of ['tmp', 'appdata', 'localappdata', 'home', 'cache']) safeDirectory(join(profile, name));
process.env.TEMP = join(profile, 'tmp'); process.env.TMP = process.env.TEMP;
process.env.electron_config_cache = safeDirectory(join(root, '.runtime', 'client', 'electron-cache'));
process.env.ELECTRON_CACHE = process.env.electron_config_cache;
const { default: electron } = await import('electron');
if (!existsSync(join(root, 'dist', 'client', 'desktop', 'main.cjs'))) throw new Error('Run the build first.');
const env = { ...process.env, MIXCAT_ROOT: root, TEMP: join(profile, 'tmp'), TMP: join(profile, 'tmp'), APPDATA: join(profile, 'appdata'), LOCALAPPDATA: join(profile, 'localappdata'), HOME: join(profile, 'home'), XDG_CACHE_HOME: join(profile, 'cache'), ELECTRON_CACHE: join(root, '.runtime', 'client', 'electron-cache') };
delete env.ELECTRON_RUN_AS_NODE;
const args = [root, `--workbench-root=${root}`];
if (process.env.MIXCAT_CODEX) args.push(`--codex=${process.env.MIXCAT_CODEX}`);
if (process.env.MIXCAT_DEBUG_PORT) args.push(`--remote-debugging-port=${process.env.MIXCAT_DEBUG_PORT}`);
const child = spawn(electron, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
