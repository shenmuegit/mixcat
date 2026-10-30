import test from 'node:test';
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdtempSync, copyFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { projectDirectory } from '../src/core/paths.js';

test('stock Electron visible child delivers a key and advances a local video', { timeout: 30000 }, async () => {
  const root=resolve('.'), fixture=mkdtempSync(join(projectDirectory(root,'.runtime'),'stock-'));
  copyFileSync(join(root,'tests/fixtures/comfy-preview.mp4'),join(fixture,'clip.mp4'));
  await build({entryPoints:['tests/fixtures/stock-webcontents-electron.ts'],outfile:join(fixture,'main.cjs'),bundle:true,platform:'node',format:'cjs',external:['electron']});
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  for(const name of ['TEMP','TMP','TMPDIR','APPDATA','LOCALAPPDATA','HOME','USERPROFILE','XDG_CACHE_HOME','XDG_CONFIG_HOME','XDG_DATA_HOME'])env[name]=projectDirectory(fixture,name);
  console.log(`Stock child proof: ${fixture}`);
  await new Promise<void>((resolve,reject)=>{const child=spawn(join(root,'node_modules/electron/dist/electron.exe'),[join(fixture,'main.cjs'),fixture],{cwd:fixture,env,windowsHide:false,stdio:['ignore','pipe','pipe']});const log=join(fixture,'electron.log');child.stdout.on('data',v=>appendFileSync(log,v));child.stderr.on('data',v=>appendFileSync(log,v));child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error(`Stock child visibility/input/playback failed (${code}); ${fixture}`)));});
});
