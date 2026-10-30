import { app, BrowserWindow, WebContentsView } from 'electron';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { projectDirectory } from '../../src/core/paths.js';
import { ProjectStore } from '../../src/core/store.js';
import { createComfyTemplate } from '../../src/core/comfy-template.js';
import { ComfyHost } from '../../src/desktop/comfy-host.js';
import { ComfyUpdates, lifecycleLease } from '../../src/core/comfy-updates.js';

const repository = process.argv[2], proof = projectDirectory(repository, '.runtime', 'task9-host-failure');
for (const name of ['appData', 'userData', 'sessionData', 'temp', 'crashDumps'] as const) app.setPath(name, projectDirectory(proof, name));
app.setAppLogsPath(projectDirectory(proof, 'logs')); app.commandLine.appendSwitch('disk-cache-dir', projectDirectory(proof, 'cache')); app.disableHardwareAcceleration();
let host: ComfyHost | undefined, window: BrowserWindow | undefined, owner: ProjectStore | undefined;
app.whenReady().then(async () => {
  for (const boundary of ['constructor', 'drained-save']) {
    const root = mkdtempSync(join(proof, 'p-')), projectId = 'host-failure';
    owner = new ProjectStore(root); owner.claim();
    owner.save({ project: { id: projectId, name: boundary, root, template: 'comfyui', status: 'idle', mode: 'codex', updatedAt: '2026-10-30T00:00:00.000Z' }, nodes: createComfyTemplate(), tasks: [], handoffs: [], activities: [], edges: [], conversation: [], messages: [], workflowReceipts: [], reviewPolicy: { revision: 0, checkpoints: [] }, humanReviews: [], runId: null, maxSteps: 12 });
    const project = owner.read({ recover: false })!.project;
    window = new BrowserWindow({ show: false, webPreferences: { offscreen: true, sandbox: true } });
    host = new ComfyHost(window, join(repository, 'resources/comfy'), join(repository, 'dist/client/desktop/comfy-preload.cjs')); host.observe({ projects: [project], selected: { project } });
    const entry = (host as any).entry(projectId), manifest = JSON.parse(readFileSync(join(repository, 'resources/comfy/runtime-manifest.json'), 'utf8'));
    entry.selection = new ComfyUpdates(entry.service.store, join(repository, 'resources/comfy'), {} as any).initialize(manifest);
    entry.start = Promise.resolve(); entry.handshaken = true;
    entry.rpc = { snapshotWorkspace: async () => ({ local: {}, session: {}, tabs: [], active: null }), flushGraph: async () => ({}), invalidate() {} };
    entry.view = new WebContentsView({ webPreferences: { offscreen: true, sandbox: true } }); window.contentView.addChildView(entry.view);
    const runtime = projectDirectory(root, '.mixcat', 'comfy', 'runtime', manifest.id);
    writeFileSync(join(projectDirectory(root, '.mixcat', 'comfy', 'runtime', manifest.id, 'venv', 'Scripts'), 'python.exe'), 'unused fault-injection executable');
    const backend = projectDirectory(root, '.mixcat', 'comfy', 'runtime', manifest.id, 'backend'); writeFileSync(join(backend, 'main.py'), 'unused'); writeFileSync(join(backend, 'LICENSE'), 'fixture');
    writeFileSync(join(runtime, 'ready.json'), JSON.stringify({ manifestHash: createHash('sha256').update(JSON.stringify(manifest)).digest('hex') }));
    const fault = new DatabaseSync(join(root, '.mixcat/comfy/state.sqlite'));
    if (boundary === 'constructor') {
      fault.prepare('UPDATE metadata SET project_id=?').run('wrong-project');
      await assert.rejects(host.prepareCandidate(root, manifest), /其他项目/);
      assert.equal((host as any).maintenance.has(projectId), false); assert.equal(entry.closed, false);
      fault.prepare('UPDATE metadata SET project_id=?').run(projectId);
    } else {
      fault.exec("CREATE TRIGGER fail_selection BEFORE UPDATE OF body ON runtime_records WHEN OLD.id='selection' BEGIN SELECT RAISE(ABORT,'source snapshot save failed'); END");
      await assert.rejects(host.prepareCandidate(root, manifest), /source snapshot save failed/);
      assert.equal(entry.maintenanceDrained, true); assert.equal(entry.closed, true);
      await assert.rejects(host.request(projectId, { type: 'summary' }), /关闭/);
      assert(entry.service.store.runtimeRecord('selection')); assert.throws(() => lifecycleLease(root), /另一个宿主/);
      fault.exec('DROP TRIGGER fail_selection');
    }
    fault.close(); await host.close(projectId); lifecycleLease(root)(); await host.dispose(); host = undefined; window.destroy(); window = undefined; owner.close(); owner = undefined;
    console.log(boundary + ': ownership and safe retry passed');
  }
  app.exit(0);
}).catch(async error => { console.error(error); try { await host?.dispose(); owner?.close(); window?.destroy(); } catch (cleanup) { console.error(cleanup); } app.exit(1); });
