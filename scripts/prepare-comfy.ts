import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { prepareRuntime, type RuntimeManifest } from '../src/core/comfy-runtime.js';

const manifest = JSON.parse(readFileSync(new URL('../resources/comfy/runtime-manifest.json', import.meta.url), 'utf8')) as RuntimeManifest;
if (createHash('sha256').update(readFileSync(new URL('../resources/comfy/requirements-win-x64.lock', import.meta.url))).digest('hex') !== manifest.lockSha256) throw new Error('Comfy 发行依赖锁校验失败。');
const prepared = await prepareRuntime(resolve(process.argv[2] ?? '.'), manifest);
console.log(JSON.stringify({ version: prepared.version, directory: prepared.directory, python: prepared.python, backend: prepared.backend, data: prepared.data }, null, 2));
