import test from 'node:test';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { join, resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { projectDirectory } from '../src/core/paths.js';
import { runtimeEnvironment } from '../src/core/comfy-runtime.js';

test('native close retains input ownership across earlier reads and a failed flush', { timeout: 240000 }, async () => {
  const root=resolve('.'),proof=projectDirectory(root,'.runtime','comfy-close-proof');
  await build({entryPoints:['tests/fixtures/comfy-close-electron.ts'],outfile:join(proof,'harness.cjs'),bundle:true,platform:'node',format:'cjs',target:'node24',external:['electron']});
  const env=runtimeEnvironment(root);delete env.ELECTRON_RUN_AS_NODE;
  await new Promise<void>((done,fail)=>{const child=spawn(join(root,'node_modules/electron/dist/electron.exe'),[join(proof,'harness.cjs'),root],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',v=>output+=v);child.stderr.on('data',v=>output+=v);child.once('error',fail);child.once('exit',code=>{writeFileSync(join(proof,'electron.log'),output);code===0?done():fail(Error(`Close ownership failed (${code}): ${output}`));});});
});
