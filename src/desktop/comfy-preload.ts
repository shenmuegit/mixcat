import { contextBridge, ipcRenderer } from 'electron';
import { boundedComfy, validateRpcRequest, validateComfyRequest, validateNativeQueue, validateObservation, validatePrompt, comfyText } from '../shared/comfy-bridge.js';

let connected = false, listening = false;
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
