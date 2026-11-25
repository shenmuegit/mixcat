import { contextBridge, ipcRenderer } from 'electron';
import { boundedComfy, validateRpcRequest, validateComfyRequest, validateNativeQueue, validateObservation, validatePrompt, comfyText } from '../shared/comfy-bridge.js';
import { isWorkflowStorageKey, WORKFLOW_STORAGE_PATH } from '../shared/comfy-workflow-storage.js';

let connected = false, listening = false;
// The host verifies local storage on a same-origin JSON document before opening the native frontend.
if (location.protocol === 'http:' && location.hostname === '127.0.0.1' && location.pathname === WORKFLOW_STORAGE_PATH) {
  const collect = (storage: Storage) => Object.fromEntries(Object.keys(storage).sort().filter(isWorkflowStorageKey).map(key => [key, storage.getItem(key)]));
  const workspace = ipcRenderer.sendSync('mixcat:comfy-storage', localStorage.getItem('Mixcat.GenerationImported'), { local: collect(localStorage), session: collect(sessionStorage) });
  if (workspace) {
    if (workspace.error) throw Error(workspace.error);
    boundedComfy(workspace);
    for (const [storage, entries] of [[localStorage, workspace.local], [sessionStorage, workspace.session]] as const) {
      for (const [key, value] of Object.entries(entries)) if (!isWorkflowStorageKey(key)) storage.setItem(key, value as string);
    }
    localStorage.setItem('Mixcat.GenerationImported', workspace.generationId);
  }
}
contextBridge.exposeInMainWorld('mixcatComfy', Object.freeze({
  connect: async (instanceId: string) => {
    if (connected) throw new Error('Comfy 握手只能执行一次。');
    connected = true;
    return ipcRenderer.invoke('mixcat:comfy-connect', instanceId);
  },
  listen: (callback: (message: unknown) => void) => {
    if (!connected || listening || typeof callback !== 'function') throw new Error('Comfy 桥状态不正确。');
    listening = true;
    ipcRenderer.on('mixcat:comfy-request', (_event, message) => { try { validateRpcRequest(message); callback(message); } catch {} });
  },
  reply: (message: unknown) => { if (!connected) throw new Error('Comfy 尚未握手。'); boundedComfy(message); ipcRenderer.send('mixcat:comfy-reply', message); },
  queue: (request: unknown, queue: unknown) => { if (!connected || !listening) throw new Error('Comfy 尚未握手。'); validateComfyRequest(request); if (request.type !== 'queue_graph') throw new Error('Comfy 队列请求不正确。'); validateNativeQueue(queue); return ipcRenderer.invoke('mixcat:comfy-queue', request, queue); },
  admit: (sessionId: unknown, source: unknown, payload: unknown) => { if (!connected || !listening) throw new Error('Comfy 尚未握手。'); comfyText(sessionId); validateObservation(source); validatePrompt(payload); return ipcRenderer.invoke('mixcat:comfy-admit', sessionId, source, payload); },
  ready: () => { if (connected && listening) ipcRenderer.send('mixcat:comfy-ready'); }
}));
