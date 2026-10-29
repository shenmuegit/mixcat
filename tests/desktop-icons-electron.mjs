import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import electron from 'electron';

test('desktop startup supplies a visible multi-resolution cat icon to the native window and tray', { skip: process.platform !== 'win32', timeout: 45000 }, async () => {
  const root = resolve('.');
  function safe(path) {
    const absolute = resolve(path), part = relative(root, absolute);
    assert(part && !part.startsWith('..') && !isAbsolute(part) && !/^c:/i.test(absolute));
    for (let p = absolute; ; p = dirname(p)) { assert(!existsSync(p) || !lstatSync(p).isSymbolicLink(), `Linked path: ${p}`); if (dirname(p) === p) break; }
    return absolute;
  }
  const evidence = safe(join(root, '.runtime', 'implementation')); mkdirSync(evidence, { recursive: true });
  const fixture = mkdtempSync(safe(join(evidence, 'desktop-icons-')));
  cpSync(join(root, 'dist', 'client'), safe(join(fixture, 'dist', 'client')), { recursive: true });
  for (const name of ['tmp', 'appdata', 'localappdata', 'home', 'cache']) mkdirSync(safe(join(fixture, name)));
  const resultPath = safe(join(fixture, 'result.json'));
  const bootstrap = safe(join(fixture, 'bootstrap.cjs'));
  writeFileSync(bootstrap, String.raw`
const assert = require('node:assert/strict');
const { readFileSync, writeFileSync } = require('node:fs');
const { join, basename } = require('node:path');
const Module = require('node:module');
const electron = require('electron');
const observed = {};
let window, tray, finished = false;
const windowConstructor = new Proxy(electron.BrowserWindow, { construct(Target, args) {
  observed.windowIcon = args[0]?.icon;
  window = Reflect.construct(Target, args);
  window.webContents.once('did-finish-load', () => setTimeout(check, 100));
  return window;
} });
const trayConstructor = new Proxy(electron.Tray, { construct(Target, args) {
  observed.trayIcon = args[0]; tray = Reflect.construct(Target, args);
  const setMenu = tray.setContextMenu.bind(tray);
  tray.setContextMenu = menu => { observed.menu = menu; setMenu(menu); };
  return tray;
} });
const desktopElectron = new Proxy(electron, { get(target, name) {
  if (name === 'BrowserWindow') return windowConstructor;
  if (name === 'Tray') return trayConstructor;
  return Reflect.get(target, name);
} });
const load = Module._load;
Module._load = function(name, ...args) { return name === 'electron' ? desktopElectron : load.call(this, name, ...args); };
function finish(result) {
  if (finished) return; finished = true; clearTimeout(deadline);
  writeFileSync(join(process.env.MIXCAT_ROOT, 'result.json'), JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
  if (result.passed) observed.menu.items.find(item => item.label === '退出 Mixcat').click();
  else electron.app.quit();
}
function check() {
  try {
    assert.equal(typeof observed.windowIcon, 'string', 'the actual native window must receive a custom icon path');
    assert.equal(observed.trayIcon, observed.windowIcon, 'tray and taskbar must use the same cat asset');
    assert.equal(basename(observed.windowIcon), 'mixcat.ico');
    const ico = readFileSync(observed.windowIcon);
    assert.equal(ico.readUInt16LE(0), 0); assert.equal(ico.readUInt16LE(2), 1);
    const sizes = [];
    for (let i = 0; i < ico.readUInt16LE(4); i++) {
      const entry = 6 + i * 16, width = ico[entry] || 256, height = ico[entry + 1] || 256;
      assert.equal(height, width);
      const length = ico.readUInt32LE(entry + 8), offset = ico.readUInt32LE(entry + 12);
      assert(offset >= 6 + ico.readUInt16LE(4) * 16 && offset + length <= ico.length, 'each frame must be inside the ICO');
      const frame = electron.nativeImage.createFromBuffer(ico.subarray(offset, offset + length));
      assert.equal(frame.isEmpty(), false, 'each ICO frame must decode');
      assert.deepEqual(frame.getSize(), { width, height });
      const pixels = frame.toBitmap(), opaque = new Set(); let transparent = 0;
      for (let p = 0; p < pixels.length; p += 4) {
        if (pixels[p + 3] === 0) transparent++;
        else if (pixels[p + 3] === 255) opaque.add(pixels.subarray(p, p + 3).toString('hex'));
      }
      assert(transparent > 0 && opaque.size >= 2, 'cat and light outline must be visible on a transparent background');
      sizes.push(width);
    }
    assert.deepEqual(sizes, [16, 20, 24, 32, 40, 48, 64, 128, 256]);
    assert(window.getNativeWindowHandle().some(byte => byte !== 0), 'a native window was created');
    assert.equal(tray.isDestroyed(), false, 'the real tray object is alive');
    assert.deepEqual(observed.menu.items.map(item => item.label), ['打开工作台', '退出 Mixcat']);
    window.hide(); assert.equal(window.isVisible(), false);
    observed.menu.items.find(item => item.label === '打开工作台').click();
    assert.equal(window.isVisible(), true, 'the tray menu restores the actual window');
    finish({ passed: true, sizes, windowIcon: basename(observed.windowIcon), trayIcon: basename(observed.trayIcon), trayBounds: tray.getBounds(), trayMenu: ['show window', 'quit'] });
  } catch (error) { finish({ passed: false, error: error.stack }); }
}
const deadline = setTimeout(() => finish({ passed: false, error: 'Desktop icon startup timed out' }), 25000);
require(join(process.env.MIXCAT_ROOT, 'dist', 'client', 'desktop', 'main.cjs'));
`);
  const env = { ...process.env, MIXCAT_ROOT: fixture, MIXCAT_CODEX: process.execPath, TEMP: join(fixture, 'tmp'), TMP: join(fixture, 'tmp'), APPDATA: join(fixture, 'appdata'), LOCALAPPDATA: join(fixture, 'localappdata'), HOME: join(fixture, 'home'), XDG_CACHE_HOME: join(fixture, 'cache') };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [bootstrap, `--workbench-root=${fixture}`], { cwd: fixture, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', data => log += data); child.stderr.on('data', data => log += data);
  const exited = once(child, 'exit');
  const timeout = setTimeout(() => child.kill(), 40000);
  try {
    const [code] = await exited;
    writeFileSync(safe(join(fixture, 'electron.log')), log);
    assert(existsSync(resultPath), log || 'Electron exited without icon evidence');
    const result = JSON.parse(readFileSync(resultPath, 'utf8'));
    assert.equal(result.passed, true, result.error);
    assert.equal(code, 0, log);
    console.log(JSON.stringify({ ...result, fixture }));
  } finally { clearTimeout(timeout); if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; } }
});
