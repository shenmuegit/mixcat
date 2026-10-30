import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { projectDirectory } from '../../src/core/paths.js';
import { ProjectStore } from '../../src/core/store.js';
import { ComfyHost } from '../../src/desktop/comfy-host.js';
import type { GraphView } from '../../src/shared/comfy.js';

const repository = process.argv[2], root = process.argv[3], marker = process.argv[4];
for (const name of ['appData', 'userData', 'sessionData', 'temp', 'crashDumps'] as const) app.setPath(name, projectDirectory(root, '.mixcat', 'comfy', 'maintenance', 'edit-proof', name));
app.setAppLogsPath(projectDirectory(root, '.mixcat', 'comfy', 'maintenance', 'edit-proof', 'logs')); app.commandLine.appendSwitch('disk-cache-dir', projectDirectory(root, '.mixcat', 'comfy', 'maintenance', 'edit-proof', 'cache')); app.disableHardwareAcceleration();
let host: ComfyHost | undefined, owner: ProjectStore | undefined, window: BrowserWindow | undefined;
app.whenReady().then(async () => {
  owner = new ProjectStore(root); owner.claim(); const project = owner.read({ recover: false })!.project;
  window = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: { offscreen: true, sandbox: true } });
  await window.loadURL('data:text/html,<title>Ordinary native edit between maintenance commands</title>');
  host = new ComfyHost(window, join(repository, 'dist/client/comfy'), join(repository, 'dist/client/desktop/comfy-preload.cjs')); host.observe({ projects: [project], selected: { project } });
  await host.request(project.id, { type: 'read_graph' });
  const entry = (host as any).entries.get(project.id);
  await entry.view.webContents.executeJavaScript(`window.comfyAPI.app.app.rootGraph.nodes[0].title=${JSON.stringify(marker)};true`);
  const changed = await host.request(project.id, { type: 'read_graph' }) as GraphView;
  assert((changed.workflow.nodes as any[]).some(node => node.title === marker));
  writeFileSync(join(projectDirectory(root, entry.selection.data, 'user'), 'between-commands.txt'), marker);
  await host.close(project.id); await host.dispose(); owner.close(); window.destroy(); app.exit(0);
}).catch(async error => { console.error(error); try { await host?.dispose(); owner?.close(); window?.destroy(); } catch (cleanup) { console.error(cleanup); } app.exit(1); });
