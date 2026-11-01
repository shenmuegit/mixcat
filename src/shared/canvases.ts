export interface CanvasScene { elements: Record<string, unknown>[]; appState: Record<string, unknown>; files: Record<string, unknown>; }
export interface CanvasSummary { id: string; name: string; revision: number; createdAt: string; updatedAt: string; }
export interface CanvasDocument extends CanvasSummary { scene: CanvasScene; }
export interface CanvasLibrary { revision: number; items: unknown[]; }
type Mutation = { requestId: string };
export type CanvasCommand =
  | { operation: 'list' }
  | { operation: 'read'; id: string }
  | ({ operation: 'create'; name?: string } & Mutation)
  | ({ operation: 'save'; id: string; expectedRevision: number; scene: CanvasScene } & Mutation)
  | ({ operation: 'rename'; id: string; expectedRevision: number; name: string } & Mutation)
  | ({ operation: 'delete'; id: string; expectedRevision: number } & Mutation)
  | { operation: 'get_library' }
  | ({ operation: 'save_library'; expectedRevision: number; items: readonly unknown[] } & Mutation);
export interface CanvasReply { canvases?: CanvasSummary[]; canvas?: CanvasDocument; saved?: CanvasSummary; deletedId?: string; library?: CanvasLibrary; libraryRevision?: number; }
export const CANVAS_SCENE_LIMIT = 64 * 1024 * 1024;
export const CANVAS_LIBRARY_LIMIT = 8 * 1024 * 1024;
