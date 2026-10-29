import { build as bundle } from 'esbuild';
import { build as viteBuild } from 'vite';
import { copyFileSync } from 'node:fs';

if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Use Node 24+: powershell -File scripts/dev.ps1 build');
const { projectDirectory, insideProject } = await import('../src/core/paths.ts');
for (const parts of [['dist', 'client', 'renderer'], ['dist', 'client', 'desktop'], ['dist', 'client', 'core'], ['.runtime', 'client', 'vite-cache']]) projectDirectory(process.cwd(), ...parts);
await viteBuild();
await bundle({ entryPoints: { 'desktop/main': 'src/desktop/main.ts', 'desktop/preload': 'src/desktop/preload.ts', 'core/worker': 'src/core/worker.ts' }, outdir: 'dist/client', outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'], sourcemap: true, logLevel: 'info' });
copyFileSync(insideProject(process.cwd(), 'src/desktop/mixcat.ico'), insideProject(process.cwd(), 'dist/client/desktop/mixcat.ico'));
const comfyOutput = projectDirectory(process.cwd(), 'dist', 'client', 'comfy');
for (const name of ['runtime-manifest.json', 'requirements-win-x64.lock', 'README.md']) copyFileSync(insideProject(process.cwd(), `resources/comfy/${name}`), insideProject(process.cwd(), `${comfyOutput}/${name}`));
