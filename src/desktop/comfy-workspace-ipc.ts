import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { boundedComfy, comfyObject, comfyText, validateComfyRequest } from '../shared/comfy-bridge.js';
import type { ComfyWorkspaceCommand, ComfyWorkspaceReply } from '../shared/comfy-workspace.js';
import type { ComfyHost } from './comfy-host.js';
import type { ProviderSettingsContext } from './provider-settings.js';

export function registerComfyWorkspaceIpc(host: () => ComfyHost | undefined, authorize: (event: IpcMainInvokeEvent) => void, context: () => ProviderSettingsContext) {
  ipcMain.handle('mixcat:comfy-workspace', async (event, command: ComfyWorkspaceCommand): Promise<ComfyWorkspaceReply> => {
    authorize(event); boundedComfy(command); comfyObject(command); comfyText(command.projectId);
    const state = context(), owner = host();
    if (!owner) throw Error('Comfy 宿主尚未就绪。');
    if (command.type === 'layout' && command.bounds === null) { await owner.present(command.projectId, command.generation, null); return null; }
    if (!state.owner || state.settingsReady === false || state.snapshot?.selected?.project.id !== command.projectId || state.snapshot.selected.project.template !== 'comfyui') throw Error('Comfy 工作区已失效，请重新打开项目。');
    const current = () => { authorize(event); const now = context(); if (now.owner !== state.owner || now.epoch !== state.epoch || now.snapshot?.selected?.project.id !== command.projectId || host() !== owner) throw Error('Comfy 工作区已切换。'); };
    let result: ComfyWorkspaceReply;
    switch (command.type) {
      case 'bind': return owner.bind(command.projectId);
      case 'layout': await owner.present(command.projectId, command.generation, command.bounds); return null;
      case 'request':
        validateComfyRequest(command.request);
        if (!['read_graph', 'restore_graph', 'queue_graph', 'read_run', 'stop_run', 'summary', 'inspect_nodes'].includes(command.request.type)) throw Error('Comfy 工作区操作不受支持。');
        result = await owner.request(command.projectId, command.request, { kind: 'user' }, Date.now() + 30000); break;
      case 'runs': result = owner.listRuns(command.projectId, command.cursor, command.selectedRunId); break;
      case 'versions': result = owner.versions(command.projectId); break;
      case 'feedback': result = await owner.feedback(command.projectId, command.runId, command.assetId); break;
      case 'close': case 'retry': await owner.close(command.projectId); current(); return null;
      default: throw Error('Comfy 工作区操作不受支持。');
    }
    current(); boundedComfy(result); return result;
  });
}
