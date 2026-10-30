import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

if (Number(process.versions.node.split('.')[0]) < 24) throw Error('Use Node 24+ and build Mixcat first.');
process.env.NODE_DISABLE_COMPILE_CACHE = '1';
const launcher = new URL('../dist/client/desktop/comfy-maintenance-launch.cjs', import.meta.url);
if (!existsSync(fileURLToPath(launcher))) throw Error('Run ./scripts/dev.ps1 build before maintenance.');
await import(launcher.href);
