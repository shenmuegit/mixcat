export {};
declare global { interface Window { EXCALIDRAW_ASSET_PATH: string; } }
window.EXCALIDRAW_ASSET_PATH = new URL('./excalidraw/', window.location.href).href;
// Use upstream's input/download fallback so desktop exports stay in the workspace.
for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) {
  Reflect.deleteProperty(window, name);
  if (name in window) throw Error('当前客户端无法使用工作空间内的文件导入导出。');
}
