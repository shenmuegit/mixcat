import { contextBridge, ipcRenderer } from 'electron';
import type { CommandEnvelope, AppUpdate, DesktopApi } from '../shared/types.js';
import type { PanelCommand, PanelSnapshot } from '../shared/panels.js';

const api: DesktopApi = {
  comfyWorkspace: command => ipcRenderer.invoke('mixcat:comfy-workspace', command),
  comfyProviders: request => ipcRenderer.invoke('mixcat:comfy-providers', request),
  setFeedUnsaved: dirty => ipcRenderer.invoke('mixcat:feed-unsaved', dirty),
  subscribeFeed(listener) { const handler = (_event: unknown, snapshot: import('../shared/feed.js').FeedSnapshot) => listener(snapshot); ipcRenderer.on('mixcat:feed', handler); return () => ipcRenderer.removeListener('mixcat:feed', handler); },
  documentMedia: command => ipcRenderer.invoke('mixcat:document-media', command),
  setUnsaved: (projectId: string, dirty: boolean) => ipcRenderer.invoke('mixcat:unsaved', projectId, dirty),
  openExternal: (url: string) => ipcRenderer.invoke('mixcat:open-external', url),
  command: (envelope: CommandEnvelope) => ipcRenderer.invoke('mixcat:command', envelope),
  inspect: (id: string) => ipcRenderer.invoke('mixcat:inspect', id),
  chooseDirectory: () => ipcRenderer.invoke('mixcat:directory'),
  chooseAttachments: (projectId: string, nodeId: string) => ipcRenderer.invoke('mixcat:attachments', projectId, nodeId),
  choosePanelFile: (projectId: string, nodeId: string, generation: number) => ipcRenderer.invoke('mixcat:choose-panel-file', projectId, nodeId, generation),
  panel: (command: PanelCommand) => ipcRenderer.invoke('mixcat:panel', command),
  subscribePanels(listener: (snapshot: PanelSnapshot) => void) {
    const handler = (_event: unknown, snapshot: PanelSnapshot) => listener(snapshot);
    ipcRenderer.on('mixcat:panels', handler);
    return () => ipcRenderer.removeListener('mixcat:panels', handler);
  },
  subscribe(listener: (snapshot: AppUpdate) => void) {
    const handler = (_event: unknown, snapshot: AppUpdate) => listener(snapshot);
    ipcRenderer.on('mixcat:snapshot', handler);
    return () => ipcRenderer.removeListener('mixcat:snapshot', handler);
  },
};
contextBridge.exposeInMainWorld('mixcat', api);
