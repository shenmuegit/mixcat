export {};
declare global { interface Window { EXCALIDRAW_ASSET_PATH: string; } }
window.EXCALIDRAW_ASSET_PATH = new URL('./excalidraw/', window.location.href).href;
