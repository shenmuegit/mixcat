import { app, BrowserWindow, ipcMain, safeStorage } from 'electron';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { projectDirectory } from '../../src/core/paths.js';
import { ProviderSettingsService, type ProviderSettingsContext } from '../../src/desktop/provider-settings.js';
import { authorizeSettingsFrame, registerProviderSettingsIpc } from '../../src/desktop/provider-settings-ipc.js';
import type { AppSnapshot } from '../../src/shared/types.js';

const [root, projectRoot, phase] = process.argv.slice(2), proof = projectDirectory(root, '.runtime', 'comfy-credentials-proof');
for (const name of ['appData', 'userData', 'sessionData', 'temp', 'crashDumps'] as const) app.setPath(name, projectDirectory(root, '.runtime', 'comfy-credentials-proof', name));
app.setAppLogsPath(projectDirectory(root, '.runtime', 'comfy-credentials-proof', 'logs'));
app.commandLine.appendSwitch('disk-cache-dir', projectDirectory(root, '.runtime', 'comfy-credentials-proof', 'cache'));
app.disableHardwareAcceleration();
const key = 'FAKE_NATIVE_TASK4_BYOK_NEVER_REAL_cf7801', project = { id: 'native-credentials', root: projectRoot, template: 'comfyui' };
let state: ProviderSettingsContext = { owner: {}, epoch: 1, snapshot: { projects: [project], selected: { project } } as AppSnapshot };
let window: BrowserWindow | undefined, blocked = false, genericCalls = 0;
const html = join(proof, 'index.html'), service = new ProviderSettingsService(safeStorage, () => state, () => { if (blocked) throw Error('连接仍被活动任务引用'); });
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = (code: string) => window!.webContents.executeJavaScript(code);
async function poll(code: string) { for (let i = 0; i < 100; i++) { if (await evaluate(code)) return; await delay(50); } throw Error('UI proof condition timed out'); }
async function fill(label: string, value: string) {
  await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(`[aria-label="${label}"]`)});Object.getOwnPropertyDescriptor(e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`);
}
async function click(text: string) {
  const point = await evaluate(`(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.textContent===${JSON.stringify(text)}||e.getAttribute('aria-label')===${JSON.stringify(text)});e.scrollIntoView();const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  window!.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
  window!.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
}
app.whenReady().then(async () => {
  assert.equal(await safeStorage.isAsyncEncryptionAvailable(), true);
  ipcMain.handle('mixcat:command', () => { genericCalls++; throw Error('Generic command forbidden in credential proof'); });
  registerProviderSettingsIpc(service, event => authorizeSettingsFrame(event, window, html), Promise.resolve());
  window = new BrowserWindow({ show: false, width: 1000, height: 1050, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, preload: join(proof, 'preload.cjs') } });
  window.webContents.on('console-message', (event: any) => { if (event.level === 'error') console.log('renderer error:', event.message.replaceAll(key, '[redacted]')); });
  await window.loadFile(html); await poll("!!document.querySelector('button[type=submit]:not(:disabled)')");
  assert.deepEqual(await evaluate(`({ require: typeof require, key: document.querySelector('[aria-label="API Key"]').value })`), { require: 'undefined', key: '' });
  if (phase === 'save') {
    console.log('native: fill settings');
    await fill('连接名称', 'Native fake MiniMax'); await fill('协议', 'minimax-cn');
    await fill('完整 API 基址', 'https://example.invalid/custom/api/');
    await fill('video 模型 ID', 'literal-video-model'); await fill('MiniMax 视频 API', 'v1'); await fill('API Key', key);
    await click('保存连接'); await poll("document.body.textContent.includes('已配置，待实际调用验证')");
    console.log('native: saved settings');
    assert.equal(await evaluate(`document.querySelector('[aria-label="API Key"]').value`), '');
    const profiles = await service.handle({ projectId: project.id, op: 'list' }, () => {});
    assert.equal(profiles.length, 1); assert.equal(profiles[0].videoApi, 'v1'); assert.equal(profiles[0].baseUrl, 'https://example.invalid/custom/api/');
    assert(!JSON.stringify(profiles).includes(key));
    assert(!readFileSync(join(projectRoot, '.mixcat/comfy/providers.json'), 'utf8').includes(key));
    await service.withCredential(project.id, profiles[0].id, 1, async credential => { assert.equal(credential.key, key); });
    await click('关闭弹窗'); await poll("!!document.querySelector('button') && document.querySelector('button').textContent==='打开连接设置'");
    console.log('native: closed settings');
    await click('打开连接设置'); await poll("!!document.querySelector('button[type=submit]:not(:disabled)')");
    await fill('连接', profiles[0].id); await poll("document.body.textContent.includes('已配置，待实际调用验证')");
    assert.equal(await evaluate(`document.querySelector('[aria-label="API Key"]').value`), '');
    blocked = true; await click('移除连接'); await poll("document.querySelector('[role=alert]')?.textContent.includes('活动任务')"); blocked = false;
    const alien = new BrowserWindow({ show: false, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, preload: join(proof, 'preload.cjs') } });
    await alien.loadFile(html);
    await assert.rejects(alien.webContents.executeJavaScript(`window.mixcat.comfyProviders({projectId:${JSON.stringify(project.id)},op:'list'})`), /不受信任/); alien.destroy();
    await evaluate("(()=>{const frame=document.createElement('iframe');frame.srcdoc='<p>Untrusted subframe</p>';document.body.append(frame)})()"); await delay(50);
    const subframe = window.webContents.mainFrame.frames[0]; assert(subframe);
    assert.throws(() => authorizeSettingsFrame({ sender: window!.webContents, senderFrame: subframe } as any, window, html), /不受信任/);
    assert.equal(await subframe.executeJavaScript('typeof window.mixcat'), 'undefined');
    await assert.rejects(evaluate("window.mixcat.comfyProviders({projectId:'foreign',op:'save',input:{},expectedRevision:0})"), /失效/);
    state = { ...state, owner: undefined };
    await assert.rejects(evaluate(`window.mixcat.comfyProviders({projectId:${JSON.stringify(project.id)},op:'list'})`), /失效/);
    state = { ...state, owner: {}, snapshot: { projects: [], selected: null } as unknown as AppSnapshot };
    await assert.rejects(evaluate(`window.mixcat.comfyProviders({projectId:${JSON.stringify(project.id)},op:'list'})`), /失效/);
    state = { ...state, snapshot: { projects: [project], selected: { project } } as AppSnapshot };
  } else {
    const [profile] = await service.handle({ projectId: project.id, op: 'list' }, () => {});
    await service.withCredential(project.id, profile.id, profile.revision, async credential => { assert.equal(credential.key, key); });
    await fill('连接', profile.id); await poll("document.body.textContent.includes('已配置，待实际调用验证')");
    assert.equal(await evaluate(`document.querySelector('[aria-label="API Key"]').value`), '');
  }
  assert.equal(genericCalls, 0); assert(!JSON.stringify(state.snapshot).includes(key));
  await delay(100);
  writeFileSync(join(proof, `${phase}.png`), (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
  await evaluate(`document.querySelector('[aria-label="API Key"]').scrollIntoView({block:'center'})`);
  writeFileSync(join(proof, `${phase}-key-status.png`), (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
  writeFileSync(join(proof, `${phase}-evidence.json`), JSON.stringify({ phase, nativeAsyncEncryptionAvailable: true, genericCalls, profiles: await service.handle({ projectId: project.id, op: 'list' }, () => {}), emptyKeyInput: true }, null, 2));
  console.log(`native credentials ${phase}: encryption, trusted IPC, UI key clearing and redaction passed`);
  window.destroy(); app.exit(0);
}).catch(error => { console.error(error); window?.destroy(); app.exit(1); });
