import { contextBridge, ipcRenderer } from 'electron';
import type { AppCommand, AppSnapshot, DesktopApi } from '../shared/types.js';
import type { PanelCommand, PanelSnapshot } from '../shared/panels.js';

const api: DesktopApi = {
  command: (command: AppCommand) => ipcRenderer.invoke('mixcat:command', command),
  chooseDirectory: () => ipcRenderer.invoke('mixcat:directory'),
  chooseAttachments: (projectId: string, nodeId: string) => ipcRenderer.invoke('mixcat:attachments', projectId, nodeId),
  panel: (command: PanelCommand) => ipcRenderer.invoke('mixcat:panel', command),
  subscribePanels(listener: (snapshot: PanelSnapshot) => void) {
    const handler = (_event: unknown, snapshot: PanelSnapshot) => listener(snapshot);
    ipcRenderer.on('mixcat:panels', handler);
    return () => ipcRenderer.removeListener('mixcat:panels', handler);
  },
  subscribe(listener: (snapshot: AppSnapshot) => void) {
    const handler = (_event: unknown, snapshot: AppSnapshot) => listener(snapshot);
    ipcRenderer.on('mixcat:snapshot', handler);
    return () => ipcRenderer.removeListener('mixcat:snapshot', handler);
  },
};
contextBridge.exposeInMainWorld('mixcat', api);
