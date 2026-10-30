import test from 'node:test';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { join, resolve, relative, dirname } from 'node:path';
import { chmodSync, cpSync, existsSync, lstatSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { lifecycleLease } from '../src/core/comfy-updates.js';
import { insideProject, projectDirectory } from '../src/core/paths.js';
import { runtimeEnvironment } from '../src/core/comfy-runtime.js';

test('two official complete combinations qualify, activate and roll back native workspace', { timeout: 480000 }, async () => {
  const root = resolve('.'), project = projectDirectory(root, 'u9'), proof = projectDirectory(root, '.runtime', 'task9-native');
  if (existsSync(insideProject(project, join(project, '.mixcat/comfy/instance.lock')))) throw Error('Previous rehearsal still owns a native process.');
  const release = lifecycleLease(project); release();
  const archive = projectDirectory(project, '.attempts', randomUUID().slice(0, 8)), state = projectDirectory(project, '.mixcat', 'comfy');
  for (const name of readdirSync(state)) if (!['runtime', 'downloads', 'lifecycle.sqlite'].includes(name)) renameSync(insideProject(project, join(state, name)), insideProject(project, join(archive, name)));
  // Ordinary copies retain the original interpreter dependency. The original is retained for this rehearsal.
  for (const version of ['comfy042-py31410-cpu1', 'comfy043-py31410-cpu1']) {
    const source = insideProject(root, join(root, '.mixcat/comfy/runtime', version));
    const target = projectDirectory(project, '.mixcat', 'comfy', 'runtime', version);
    if (!existsSync(join(target, 'rehearsal-copy-verified'))) {
      const verify = (directory: string) => { for (const name of readdirSync(directory)) {
        const file = join(directory, name), stat = lstatSync(file);
        if (stat.isSymbolicLink() || stat.isFile() && stat.nlink !== 1) throw Error('Rehearsal source contains links');
        if (stat.isDirectory()) verify(file);
      } };
      const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
      verify(source); verify(target); cpSync(source, target, { recursive: true, dereference: false, filter: (source, destination) => {
        if (lstatSync(source).isDirectory() || !existsSync(destination)) return true;
        if (lstatSync(source).size === lstatSync(destination).size && hash(source) === hash(destination)) return false;
        chmodSync(destination, 0o600); return true;
      } });
      writeFileSync(join(target, 'rehearsal-copy-verified'), 'resumed files SHA256 equal; new ordinary copies completed; original interpreter retained');
    }
  }
  await build({ entryPoints: ['tests/fixtures/comfy-updates-electron.ts'], outfile: join(proof, 'harness.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'] });
  const env = runtimeEnvironment(project); delete env.ELECTRON_RUN_AS_NODE;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(join(root, 'node_modules/electron/dist/electron.exe'), [join(proof, 'harness.cjs'), root, project], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', value => { output += value; writeFileSync(join(proof, 'electron.log'), output); }); child.stderr.on('data', value => { output += value; writeFileSync(join(proof, 'electron.log'), output); });
    child.once('error', reject); child.once('close', code => { writeFileSync(join(proof, 'electron.log'), output); code === 0 ? resolve() : reject(Error(output)); });
  });
});
