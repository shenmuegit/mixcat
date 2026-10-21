import { build as bundle } from 'esbuild';
import { build as viteBuild } from 'vite';

if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Use Node 24+: powershell -File scripts/dev.ps1 build');
await viteBuild();
await bundle({ entryPoints: { 'desktop/main': 'src/desktop/main.ts', 'desktop/preload': 'src/desktop/preload.ts', 'core/worker': 'src/core/worker.ts' }, outdir: 'dist', outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'], sourcemap: true, logLevel: 'info' });
