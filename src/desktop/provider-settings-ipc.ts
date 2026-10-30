import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { pathToFileURL } from 'node:url';
import type { ProviderSettingsRequest } from '../shared/comfy-providers.js';
import type { ProviderSettingsService } from './provider-settings.js';

export function authorizeSettingsFrame(event: IpcMainInvokeEvent, window: BrowserWindow | undefined, htmlPath: string) {
  if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== pathToFileURL(htmlPath).href) throw Error('不受信任的界面请求。');
}
export function registerProviderSettingsIpc(service: ProviderSettingsService, authorize: (event: IpcMainInvokeEvent) => void, ready: Promise<void>) {
  ipcMain.handle('mixcat:comfy-providers', async (event, request: ProviderSettingsRequest) => { authorize(event); await ready; return service.handle(request, () => authorize(event)); });
}
