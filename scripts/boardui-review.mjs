import { spawn } from 'node:child_process';
import { copyFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { insideProject, projectDirectory } from '../src/core/paths.ts';

if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Use Node 24+.');
const [action, hash, ...extra] = process.argv.slice(2);
if (extra.length || (action === '--build' && hash !== undefined)
    || (action === '--start' && hash !== undefined && !hash.startsWith('#/'))
    || (action !== '--build' && action !== '--start')) {
  throw new Error('Usage: node scripts/boardui-review.mjs --build | --start [#/074/agent-runtime]');
}

const root = fileURLToPath(new URL('..', import.meta.url));
const runtime = projectDirectory(root, '.runtime', 'boardui-review');
const output = projectDirectory(runtime, 'app');
const mainEntry = 'src/desktop/boardui-review.ts';
const renderer = 'src/renderer/boardui-review';
const mainFile = insideProject(output, join(output, 'main.cjs'));

if (action === '--build') {
  const options = { absWorkingDir: root, bundle: true, metafile: true, write: false, logLevel: 'info' };
  const [mainBuild, rendererBuild] = await Promise.all([
    build({ ...options, entryPoints: [mainEntry], outfile: mainFile, platform: 'node', format: 'cjs',
      target: 'node24', external: ['electron'] }),
    build({ ...options, entryPoints: [renderer + '/main.tsx'], outdir: output, platform: 'browser',
      entryNames: 'review', target: 'es2023', jsx: 'automatic', minify: true,
      define: { 'process.env.NODE_ENV': '"production"' } }),
  ]);
  const mainExternals = new Set(['electron', 'node:fs', 'node:fs/promises', 'node:path']);
  for (const [name, input] of Object.entries(mainBuild.metafile.inputs)) {
    if (name !== mainEntry || input.imports.some(item => !item.external || !mainExternals.has(item.path))) {
      throw new Error('Unexpected review main dependency: ' + name + ' ' + JSON.stringify(input.imports));
    }
  }
  for (const [name, input] of Object.entries(rendererBuild.metafile.inputs)) {
    const allowed = name.startsWith(renderer + '/') || name === 'src/renderer/theme.css'
      || /(?:^|\/)node_modules\/(?:react|react-dom|scheduler)\//.test(name);
    if (!allowed || input.imports.some(item => item.external)) throw new Error('Unexpected review renderer dependency: ' + name);
  }
  for (const file of [...mainBuild.outputFiles, ...rendererBuild.outputFiles]) {
    const path = insideProject(output, file.path);
    writeFileSync(path, file.contents);
  }
  for (const [source, name] of [[renderer + '/index.html', 'index.html'], ['src/desktop/mixcat.ico', 'mixcat.ico']]) {
    copyFileSync(join(root, source), insideProject(output, join(output, name)));
  }
  writeFileSync(insideProject(output, join(output, 'dependency-manifest.json')),
    JSON.stringify({ main: mainBuild.metafile, renderer: rendererBuild.metafile }, null, 2));
  console.log('BoardUI review built: ' + output);
} else {
  const required = ['main.cjs', 'index.html', 'review.js', 'review.css', 'mixcat.ico', 'dependency-manifest.json'];
  const missing = required.filter(name =>
    !statSync(insideProject(output, join(output, name)), { throwIfNoEntry: false })?.isFile());
  if (missing.length) {
    throw new Error('Incomplete BoardUI review build (missing: ' + missing.join(', ')
      + '). Run node scripts/boardui-review.mjs --build first.');
  }
  const profile = projectDirectory(runtime, 'profile');
  for (const name of ['userData', 'sessionData', 'logs', 'crashDumps']) projectDirectory(profile, name);
  const temp = projectDirectory(profile, 'temp');
  const appData = projectDirectory(profile, 'appData');
  const { default: electron } = await import('electron');
  const env = { ...process.env, TEMP: temp, TMP: temp, APPDATA: appData, LOCALAPPDATA: appData,
    XDG_CACHE_HOME: projectDirectory(profile, 'cache') };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, hash === undefined ? [mainFile] : [mainFile, hash],
    { cwd: runtime, env, stdio: 'inherit' });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
}
