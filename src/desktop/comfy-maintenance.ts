import { app, BrowserWindow, safeStorage } from 'electron';
import { appendFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { claimComfyMaintenance, parseComfyMaintenance } from '../core/comfy-maintenance.js';
import { ensureProjectDirectory, insideProject, projectDirectory } from '../core/paths.js';
import { ComfyHost } from './comfy-host.js';
import { ProviderSettingsService } from './provider-settings.js';
import { extensionFiles, type RuntimeCandidate, type RuntimeSelection } from '../core/comfy-updates.js';

const root = ensureProjectDirectory(process.env.MIXCAT_COMFY_MAINTENANCE_ROOT ?? '');
for (const name of ['HOME', 'USERPROFILE', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA']) insideProject(root, process.env[name] ?? '');
for (const name of ['appData', 'userData', 'sessionData', 'temp', 'crashDumps'] as const) app.setPath(name, projectDirectory(root, '.mixcat', 'comfy', 'maintenance', 'electron', name));
app.setAppLogsPath(projectDirectory(root, '.mixcat', 'comfy', 'maintenance', 'logs'));
app.commandLine.appendSwitch('disk-cache-dir', projectDirectory(root, '.mixcat', 'comfy', 'maintenance', 'cache')); app.disableHardwareAcceleration();

let owned: ReturnType<typeof claimComfyMaintenance> | undefined, host: ComfyHost | undefined, window: BrowserWindow | undefined;
let cleaning = false, failure = false, result: Record<string, unknown> | undefined;
const log = (value: unknown) => { try { appendFileSync(insideProject(root, join(projectDirectory(root, '.mixcat', 'comfy', 'maintenance', 'logs'), 'operations.jsonl')), JSON.stringify(value) + '\n'); } catch (error) { console.error('维护日志写入失败：', (error as Error).message); } };
async function cleanup() {
  if (cleaning) return; cleaning = true;
  try {
    await host?.dispose();
  } catch (error) {
    failure = true; cleaning = false;
    console.error('安全清理失败；维护宿主继续持有项目所有权。修复后输入 retry 重试，不能终止陌生或未核实的进程。', (error as Error).message);
    return;
  }
  try { owned?.close(); owned = undefined; window?.destroy(); }
  catch (error) { failure = true; console.error('原生宿主已安全关闭；维护结束失败：', (error as Error).message); }
  if (result && !failure) { log(result); console.log(JSON.stringify(result)); }
  app.exit(failure ? 1 : 0);
}
process.stdin.on('data', value => { if (String(value).trim() === 'retry') void cleanup(); });
app.on('window-all-closed', () => {});
app.on('before-quit', event => { event.preventDefault(); void cleanup(); });
app.whenReady().then(async () => {
  const request = parseComfyMaintenance(process.argv.slice(2)); if (request.root !== root) throw Error('维护启动项目身份不匹配。');
  owned = claimComfyMaintenance(request);
  const assets = join(__dirname, '../comfy');
  if (request.operation === 'activate' && extensionFiles.some(file => createHash('sha256').update(readFileSync(join(assets, 'mixcat', file))).digest('hex') !== owned!.target!.extensions[file])) throw Error('请求的完整组合与当前构建的适配层不同；请使用匹配的构建，或先 prepare 并审查新的完整组合。');
  const owner = {}, snapshot = { projects: [owned.project], selected: { project: owned.project } };
  const providers = new ProviderSettingsService(safeStorage, () => ({ owner, epoch: 0, snapshot }), () => { throw Error('维护宿主不修改供应商连接。'); });
  window = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.loadURL('data:text/html,<title>Mixcat ComfyUI maintenance</title>');
  host = new ComfyHost(window, assets, join(__dirname, 'comfy-preload.cjs'), providers, { root, releaseRuntime: owned.releaseRuntime }); host.observe(snapshot);
  let value: RuntimeCandidate | RuntimeSelection;
  if (request.operation === 'prepare') value = await host.prepareCandidate(root, request.manifest);
  else if (request.operation === 'activate') {
    const refreshed = await host.prepareCandidate(root, owned.target!.manifest);
    if (refreshed.selection.versionId !== request.versionId) throw Error('重新验证产生的完整组合与请求 ID 不同；请重新 prepare 并审查，尚未激活。');
    value = await host.activateVersion(root, request.versionId);
  } else value = await host.rollbackVersion(root, request.versionId);
  const selection = 'selection' in value ? value.selection : value;
  result = { operation: request.operation, projectId: owned.project.id, versionId: selection.versionId, generationId: selection.generationId, data: selection.data, ...(request.operation === 'activate' ? { requalified: true } : {}), ...('qualifiedAt' in value ? { qualifiedAt: value.qualifiedAt, sourceVersionId: value.source.versionId } : {}) };
  await cleanup();
}).catch(async error => { failure = true; console.error((error as Error).message); log({ error: (error as Error).message }); await cleanup(); });
