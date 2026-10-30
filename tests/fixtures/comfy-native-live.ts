import { app, BrowserWindow, utilityProcess } from 'electron';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { projectDirectory } from '../../src/core/paths.js';
import { ComfyHost } from '../../src/desktop/comfy-host.js';
import { boundedComfy, validateRpcRequest } from '../../src/shared/comfy-bridge.js';
import { mergeUpdate } from '../../src/shared/snapshots.js';
import type { AppCommand, AppReply, AppSnapshot } from '../../src/shared/types.js';
import type { GraphView } from '../../src/shared/comfy.js';

const root = process.argv[2], proof = projectDirectory(root, '.runtime', 'comfy-native-live'), projectRoot = projectDirectory(proof, 'project');
for (const name of ['appData', 'userData', 'sessionData', 'temp', 'crashDumps'] as const) app.setPath(name, projectDirectory(proof, name));
app.setAppLogsPath(projectDirectory(proof, 'logs')); app.commandLine.appendSwitch('disk-cache-dir', projectDirectory(proof, 'cache')); app.disableHardwareAcceleration();
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let worker: ReturnType<typeof utilityProcess.fork> | undefined, host: ComfyHost | undefined, window: BrowserWindow | undefined;
const pending = new Map<string, { resolve(value: any): void; reject(error: Error): void }>();
const nativeCalls: { type: string; actor: unknown }[] = [];
function request(data: object) { return new Promise<any>((resolve, reject) => { const id = randomUUID(); pending.set(id, { resolve, reject }); worker!.postMessage({ id, ...data }); }); }
const command = (value: AppCommand): Promise<AppReply> => request({ envelope: { id: randomUUID(), command: value } });
app.whenReady().then(async () => {
  assert(process.env.MIXCAT_CODEX, 'Resolve the actual Codex executable before this proof');
  window = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.loadURL('data:text/html,<title>Real Codex native Comfy proof</title>');
  host = new ComfyHost(window, join(root, 'dist/client/comfy'), join(root, 'dist/client/desktop/comfy-preload.cjs'));
  let snapshot: AppSnapshot | null = null;
  let resolveReady!: () => void, rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  assert(process.env.MIXCAT_ACCOUNT_ROOT, 'Use the existing shared account through the standard account owner');
  worker = utilityProcess.fork(join(root, 'dist/client/core/worker.cjs'), [proof, process.env.MIXCAT_CODEX!, process.env.MIXCAT_ACCOUNT_ROOT!], { cwd: root, stdio: 'pipe', serviceName: 'Mixcat Task7 real model proof' });
  worker.on('message', (message: any) => {
    if (message.type === 'ready') { resolveReady(); return; }
    if (message.type === 'fatal') { rejectReady(Error(message.error)); return; }
    if (message.type === 'snapshot') { snapshot = mergeUpdate(snapshot, message.snapshot).snapshot; if (snapshot) host!.observe(snapshot); return; }
    if (message.type === 'comfy_request') {
      void (async () => {
        try {
          validateRpcRequest(message);
          if (message.request.type === 'native_queue' || message.request.type === 'flush_graph') throw Error('Guest native operation is internal only');
          nativeCalls.push({ type: message.request.type, actor: message.actor });
          const result = message.request.type === 'close_project' ? await host!.close(message.projectId).then(() => true) : await host!.request(message.projectId, message.request, message.actor, message.expiresAt);
          const reply = { type: 'comfy_reply', id: message.id, generation: message.generation, projectId: message.projectId, result }; boundedComfy(reply); worker!.postMessage(reply);
        } catch (error) { worker!.postMessage({ type: 'comfy_reply', id: message.id, generation: message.generation, projectId: message.projectId, error: String(error) }); }
      })(); return;
    }
    const entry = pending.get(message.id); if (entry) { pending.delete(message.id); message.error ? entry.reject(Error(message.error)) : entry.resolve(message.result); }
  });
  worker.on('exit', code => { for (const entry of pending.values()) entry.reject(Error('Worker exited: ' + code)); pending.clear(); });
  await ready;
  const created = await command({ type: 'create_project', root: projectRoot, name: 'Task7 real native proof', template: 'comfyui' });
  host.observe(created.snapshot);
  const projectId = created.snapshot.selected!.project.id;
  assert.equal(created.snapshot.selected!.tasks.filter(task => !['completed', 'failed', 'cancelled'].includes(task.status)).length, 0);
  const account = await command({ type: 'connect_account' });
  assert.equal(account.snapshot.account?.authenticated, true, 'Existing shared account unavailable');
  const read = () => host!.request(projectId, { type: 'read_graph' }) as Promise<GraphView>;
  await read(); await host.present(projectId, 1, { x: 0, y: 0, width: 1400, height: 940 });
  const guest = (host as any).entries.get(projectId).view.webContents;
  guest.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); guest.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await guest.executeJavaScript(`window.nativeApp=window.comfyAPI.app.app; nativeApp.loadGraphData({nodes:[],links:[],groups:[],config:{},extra:{},version:0.4},true,false,nativeApp.extensionManager.workflow.activeWorkflow).then(()=>{const node=LiteGraph.createNode('EmptyLatentImage');node.pos=[400,300];nativeApp.rootGraph.add(node);return true})`);
  const before = await read(), title = 'Real Codex edit ' + randomUUID().slice(0, 8);
  const started = await command({ type: 'send_message', projectId, nodeId: 'comfy-assistant', mode: 'codex', input: [{ type: 'text', text_elements: [], text: `本轮是无付费生成的 Comfy 原生工具验收。只使用当前 Mixcat MCP 工具：读取 get_project_context、inspect_comfy_nodes（EmptyLatentImage）和 get_comfy_workflow；把当前根图唯一 EmptyLatentImage 节点 title 改为 ${JSON.stringify(title)}，其他字段原样传回。用 apply_comfy_workflow、刚读取的 observation 和稳定 request_id ${JSON.stringify('live-' + randomUUID())} 提交；再次 get_comfy_workflow 确认 title。不要运行工作流，不调用 run，不创建其他节点，不访问厂商，不用 shell/browser 绕过 MCP。正常结束并报告实际回读标题。` }] });
  const taskId = started.snapshot.selected!.tasks.at(-1)!.id;
  let final: AppReply | undefined, last = '';
  for (let i = 0; i < 480; i++) {
    final = await command({ type: 'snapshot', projectId, background: true });
    const task = final.snapshot.selected!.tasks.find(task => task.id === taskId)!;
    if (task.status !== last) { console.log('Real native task:', task.status); last = task.status; }
    if (final.snapshot.selected!.requests?.length) throw Error('Native request needs controller attention: ' + final.snapshot.selected!.requests.map(request => request.method).join(','));
    if (task.status === 'completed') break;
    if (['failed', 'cancelled', 'needs_reconciliation'].includes(task.status)) throw Error('Actual model task failed: ' + task.error);
    await delay(1000);
  }
  const task = final!.snapshot.selected!.tasks.find(task => task.id === taskId)!;
  assert.equal(task.status, 'completed');
  const after = await read(); assert.equal((after.workflow.nodes as any[])[0].title, title);
  const changed = nativeCalls.find(call => call.type === 'apply_graph'); assert(changed); assert.equal((changed.actor as any).kind, 'codex');
  assert.equal((changed.actor as any).threadId, task.threadId); assert.equal((changed.actor as any).turnId, task.turnId);
  assert(nativeCalls.filter(call => call.type === 'read_graph').length >= 2); assert.equal(nativeCalls.some(call => call.type === 'queue_graph'), false);
  guest.startPainting(); guest.invalidate(); await delay(700);
  writeFileSync(join(proof, 'native-edited.png'), (await guest.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
  writeFileSync(join(proof, 'evidence.json'), JSON.stringify({ passed: true, realModel: true, officialGuest: true, productionWorker: true, executable: process.env.MIXCAT_CODEX, model: task.provenance?.actualModel, threadId: task.threadId, turnId: task.turnId, before, after, nativeCalls }, null, 2));
  console.log(JSON.stringify({ passed: true, realModel: true, model: task.provenance?.actualModel, title }));
  await request({ shutdown: true }); await host.dispose(); worker.kill(); window.destroy(); app.exit(0);
}).catch(async error => {
  console.error(error); writeFileSync(join(proof, 'failure.txt'), String(error));
  try { await request({ shutdown: true }); } catch {}
  try { await host?.dispose(true); } catch {}
  worker?.kill(); window?.destroy(); app.exit(1);
});
