import assert from 'node:assert/strict';
import { copyFileSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import electron from 'electron';
import { insideProject, projectDirectory } from '../src/core/paths.ts';
import { launchFeedProductionFixture } from './feed-production-ipc-fixture.mjs';

const root = resolve('.'), fixture = mkdtempSync(join(projectDirectory(root, '.runtime', 'issue-180'), 'production-'));
cpSync(join(root, 'dist/client'), insideProject(fixture, join(fixture, 'dist/client')), { recursive: true });
writeFileSync(join(fixture, 'feed-fixture.json'), '{}');
copyFileSync(join(root, 'tests/feed-production-native-fixture.mjs'), join(fixture, 'app-server'));
let browser;
try {
  browser = await launchFeedProductionFixture(root, fixture, 1);
  const activate = spawn(electron, [join(fixture, 'dist/client/desktop/main.cjs'), `--workbench-root=${fixture}`], { cwd: fixture, env: { ...process.env, MIXCAT_ROOT: fixture, APPDATA: join(fixture, 'appdata'), LOCALAPPDATA: join(fixture, 'localappdata'), TEMP: join(fixture, 'tmp'), TMP: join(fixture, 'tmp') }, windowsHide: true, stdio: 'ignore' });
  await once(activate, 'exit');
  const canvas = await browser.evaluate("window.mixcat.canvases({operation:'create',requestId:'production-create',name:'Desktop canvas'})");
  await browser.evaluate(`window.mixcat.canvases({operation:'save',id:${JSON.stringify(canvas.canvas.id)},expectedRevision:1,requestId:'production-save',scene:{elements:[{id:'desktop-rectangle',type:'rectangle',x:80,y:80,width:180,height:120}],appState:{},files:{}}})`);
  assert.equal((await browser.evaluate("window.mixcat.command({id:crypto.randomUUID(),command:{type:'snapshot'}})")).snapshot.projects.length, 0);
  assert(await browser.evaluate("window.mixcat.canvases({operation:'list',unexpected:true}).then(()=>false,()=>true)"));
  await browser.evaluate("document.querySelector('.icon-rail [aria-label=画布]').click()");
  await browser.poll(() => browser.evaluate('!!document.querySelector(".excalidraw .App-toolbar")'), 'native production canvas');
  await browser.evaluate("document.querySelector('.excalidraw button[aria-label=矩形]').click()");
  await browser.poll(() => browser.evaluate('!!document.querySelector(".App-menu__left .range-input")'), 'native shape properties');
  await browser.evaluate('document.fonts.ready.then(()=>true)');
  const metrics = await browser.evaluate(`(()=>{const root=document.querySelector('.canvas-workspace'),rr=root.getBoundingClientRect();const rect=s=>{const e=root.querySelector(s),r=e.getBoundingClientRect(),c=getComputedStyle(e);return{x:r.x-rr.x,y:r.y-rr.y,width:r.width,height:r.height,radius:c.borderRadius,font:c.fontFamily}};return{viewport:[rr.width,rr.height],dpr:devicePixelRatio,toolbar:rect('.App-toolbar'),properties:rect('.App-menu__left'),slider:rect('.range-input')}})()`);
  assert.equal(metrics.toolbar.width, 542); assert.equal(metrics.toolbar.height, 44); assert.equal(metrics.toolbar.y, 16);
  assert.equal(metrics.toolbar.x, (metrics.viewport[0] - 542) / 2);
  assert.equal(metrics.properties.x, 16); assert.equal(metrics.properties.y, 76); assert.equal(metrics.properties.width, 195); assert.equal(metrics.slider.height, 4);
  await browser.screenshot('native-production-canvas.png');
  await browser.evaluate("document.querySelector('.excalidraw .App-menu_top__left button').click()");
  await browser.poll(() => browser.evaluate("[...document.querySelectorAll('.excalidraw [role=menuitem]')].some(e=>e.textContent.includes('保存到'))"), 'production export menu');
  await browser.evaluate("[...document.querySelectorAll('.excalidraw [role=menuitem]')].find(e=>e.textContent.includes('保存到')).click()");
  await browser.poll(() => browser.evaluate('!!document.querySelector(".excalidraw button[aria-label=保存为文件]")'), 'native save dialog');
  await browser.evaluate("document.querySelector('.excalidraw button[aria-label=保存为文件]').click()");
  const exports = join(fixture, '.mixcat', 'canvases', 'exports');
  const file = await browser.poll(() => {
    if (!existsSync(exports)) return null;
    const name = readdirSync(exports).find(name => name.endsWith('.excalidraw')); if (!name) return null;
    try { const value = JSON.parse(readFileSync(join(exports, name), 'utf8')); return value.type === 'excalidraw' && name; } catch { return null; }
  }, 'production project-local download');
  await browser.poll(() => browser.evaluate(`window.mixcat.canvases({operation:'read',id:${JSON.stringify(canvas.canvas.id)}}).then(r=>r.canvas.revision>=2)`), 'durable production state');
  writeFileSync(join(fixture, 'acceptance.json'), JSON.stringify({ metrics, exportedFile: file, actualPreloadAndMain: true }, null, 2));
  await browser.close(); browser = undefined;
  console.log(JSON.stringify({ fixture, metrics, productionIpcAndDownload: 'passed' }));
} finally { if (browser) await browser.cleanupFailure(Error('Canvas production acceptance failed')); }
