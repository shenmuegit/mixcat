const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { createServer } = require('node:http');
const { join, resolve, sep } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { app, BrowserWindow, ipcMain } = require('electron');

const fixture = process.argv[3];
const { writeFileSync } = fs;
let window;
let watching = false;
const counts = { ipc: 0, externalReads: 0, externalWrites: 0, nativeProcesses: 0 };
const network = createServer((_, response) => {
  requests++;
  response.end('Outside the review');
});
let requests = 0;

function observeFiles(module, names, counter) {
  for (const name of names) {
    const original = module[name];
    module[name] = function(path, ...args) {
      if (watching && typeof path === 'string' && !resolve(path).startsWith(fixture + sep)) counts[counter]++;
      return original.call(this, path, ...args);
    };
  }
}
observeFiles(fs, ['readFile', 'readFileSync', 'readdir', 'readdirSync', 'open', 'openSync'], 'externalReads');
observeFiles(fs, ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'mkdir', 'mkdirSync', 'renameSync', 'unlinkSync'], 'externalWrites');
observeFiles(fsp, ['readFile', 'readdir', 'open'], 'externalReads');
observeFiles(fsp, ['writeFile', 'appendFile', 'mkdir', 'rename', 'unlink'], 'externalWrites');
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  const original = childProcess[name];
  childProcess[name] = function(...args) {
    if (watching) counts.nativeProcesses++;
    return original.apply(this, args);
  };
}
function observeIpc(ipc) {
  const handle = ipc.handle.bind(ipc);
  ipc.handle = (name, listener) => handle(name, (event, ...args) => {
    if (watching) counts.ipc++;
    return listener(event, ...args);
  });
}
observeIpc(ipcMain);

function evaluate(code) {
  return window.webContents.executeJavaScript(code, true);
}

async function eventually(code, expected) {
  let actual;
  for (let attempt = 0; attempt < 100; attempt++) {
    actual = await evaluate(code);
    if (actual === expected) return;
    await delay(30);
  }
  assert.equal(actual, expected, code);
}

async function route(hash, title) {
  await evaluate('location.hash = ' + JSON.stringify(hash));
  await eventually('document.querySelector("#review-title")?.textContent', title);
}

async function click(name) {
  assert.equal(await evaluate('(() => { const button = [...document.querySelectorAll("button")].find(button => '
    + 'button.textContent.trim() === ' + JSON.stringify(name) + ' && !button.disabled);'
    + 'if (!button) return false; button.click(); return true; })()'), true, name);
}

async function replayMessage(value, finalStatus) {
  await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value }],
  });
  const reduced = value === 'reduce';
  await eventually('matchMedia("(prefers-reduced-motion: reduce)").matches', reduced);
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
  await evaluate('(() => { const status = document.querySelector("[role=status]");'
    + 'window.sawReplayPending = false; window.replayObserver = new MutationObserver(() => {'
    + 'if (status.textContent.includes("回放中")) window.sawReplayPending = true; });'
    + 'window.replayObserver.observe(status, { childList: true, characterData: true, subtree: true }); })()');
  await click('发送消息');
  await eventually('document.querySelector("[role=status]").textContent', finalStatus);
  assert.equal(await evaluate('window.replayObserver.disconnect(); window.sawReplayPending'), !reduced);
}

async function press(key, windowsVirtualKeyCode) {
  const input = { key, code: key, windowsVirtualKeyCode };
  await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { ...input, type: 'keyDown' });
  await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { ...input, type: 'keyUp' });
}

async function search(query, expectedLink) {
  await evaluate('document.querySelector("#review-search").select()');
  await window.webContents.debugger.sendCommand('Input.insertText', { text: query });
  await eventually('document.querySelectorAll("#review-catalog a").length', 1);
  assert.equal(await evaluate('document.querySelector("#review-catalog a").getAttribute("href")'), expectedLink, query);
}

async function screenshot(name) {
  await evaluate('document.activeElement.blur()');
  await window.capturePage();
  await delay(160);
  const image = await window.capturePage();
  assert.equal(image.isEmpty(), false);
  writeFileSync(join(fixture, name), image.toPNG());
}

app.once('browser-window-created', (_event, created) => {
  window = created;
  window.webContents.on('ipc-message', () => { if (watching) counts.ipc++; });
  window.webContents.on('ipc-message-sync', () => { if (watching) counts.ipc++; });
  observeIpc(window.webContents.ipc);
});

require(join(fixture, 'app', 'main.cjs'));
app.whenReady().then(async () => {
  await eventually('document.querySelector("#review-title")?.textContent', '文档树');
  assert.equal(window.getTitle(), 'Mixcat 设计评审');
  assert.equal(window.isVisible(), true, 'the loaded native review window is visible');
  assert.equal(BrowserWindow.getAllWindows().length, 1);
  assert.equal(await evaluate('location.hash'), '#/034/tree-view');
  assert.equal(await evaluate('document.querySelectorAll("#review-catalog a").length'), 130);
  assert.equal(await evaluate('document.querySelectorAll("#review-catalog [data-review-status=available]").length'), 1);
  await eventually('document.querySelector("main h2")?.textContent', '待实现');
  window.webContents.debugger.attach('1.3');
  window.webContents.focus();
  await press('Tab', 9);
  await eventually('document.activeElement.textContent.trim()', '跳到评审内容');
  assert.equal(await evaluate('document.activeElement.matches(":focus-visible")'), true);
  await press('Enter', 13);
  await eventually('document.activeElement.id', 'review-content');
  assert.equal(await evaluate('location.hash'), '#/034/tree-view');
  await screenshot('pending-034.png');
  await route('#/034/badge', '无法定位');
  await route('#/129/template-ai-profile', 'Agent 活动档案模板');
  await eventually('document.querySelector("main h2")?.textContent', '待实现');

  await search('059', '#/059/badge');
  await search('badge', '#/059/badge');
  await search('数量标记兼容名', '#/059/badge');
  await evaluate('document.querySelector("#review-catalog a").focus()');
  await press('Enter', 13);
  await eventually('document.querySelector("#review-title")?.textContent', '数量标记兼容名');
  await evaluate('document.querySelector("button[aria-label=清除搜索]").click()');

  await route('#/074/agent-runtime', '聊天示例运行层');
  await evaluate('document.querySelector(".review-skip").focus()');
  await press('Enter', 13);
  await press('Tab', 9);
  await eventually('document.activeElement.id', 'replay-mode');
  await eventually('document.querySelector("#review-catalog a[aria-current=page]").getAttribute("href")', '#/074/agent-runtime');
  assert.equal(await evaluate('typeof window.mixcat + "/" + typeof window.require + "/" + typeof window.process'),
    'undefined/undefined/undefined');
  assert.equal(app.hasSingleInstanceLock(), true, 'one review process owns the profile');
  assert.equal(app.getPath('userData'), join(fixture, 'profile', 'userData'));
  await eventually('document.querySelector("#review-receipts").textContent.trim()', '');
  watching = true;
  for (const [action, receipt] of [
    ['发送消息', '已收到样例消息'],
    ['批准样例请求', '已批准样例权限'],
    ['选择样例附件', '已附加评审清单.md'],
    ['提交样例排期', '已登记 2026-11-25 09:00'],
    ['生成样例图像', '已返回桌面评审封面'],
  ]) {
    await click(action);
    await eventually('document.querySelector("#review-receipts li:last-child")?.textContent.includes('
      + JSON.stringify(receipt) + ')', true);
  }
  await screenshot('sample-074.png');

  const loaded = once(window.webContents, 'did-finish-load');
  window.webContents.reload();
  await loaded;
  await eventually('document.querySelectorAll("#review-receipts li").length', 5);
  await click('重开样例');
  await eventually('document.querySelectorAll("#review-receipts li").length', 5);

  await evaluate('const mode = document.querySelector("#replay-mode"); mode.value = "error";'
    + 'mode.dispatchEvent(new Event("change", { bubbles: true }));');
  await replayMessage('no-preference', '回放失败');
  await eventually('document.querySelector("#review-receipts li:last-child")?.textContent.includes("样例请求失败")', true);
  await click('重置样例');
  await eventually('document.querySelectorAll("#review-receipts li").length', 0);
  await click('重开样例');
  await eventually('document.querySelectorAll("#review-receipts li").length', 0);

  await replayMessage('reduce', '回放完成');
  await eventually('document.querySelector("#review-receipts li:last-child")?.textContent.includes("已收到样例消息")', true);
  await click('重置样例');
  await eventually('document.querySelectorAll("#review-receipts li").length', 0);

  assert.equal(await evaluate('Notification.requestPermission()'), 'denied');
  network.listen(0, '127.0.0.1');
  await once(network, 'listening');
  const url = JSON.stringify('http://127.0.0.1:' + network.address().port);
  assert.equal(await evaluate('fetch(' + url + ').then(() => "allowed", () => "denied")'), 'denied');
  assert.equal(await evaluate('window.open(' + url + ') === null'), true);
  await evaluate('location.assign(' + url + '); true');
  await delay(200);
  assert.equal(requests, 0);
  assert.equal(window.webContents.getURL(), 'boardui-review://local/index.html#/074/agent-runtime');
  assert.equal(BrowserWindow.getAllWindows().length, 1);
  assert.deepEqual(counts, { ipc: 0, externalReads: 0, externalWrites: 0, nativeProcesses: 0 });
  console.log(JSON.stringify({ catalog: 130, available: 1, ...counts, network: requests }));
}).then(() => {
  network.close();
  app.quit();
}, error => {
  console.error(error);
  network.close();
  app.exit(1);
});
