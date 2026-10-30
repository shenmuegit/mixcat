import type { ComfyReply, ComfyRequest, RunView } from './comfy.js';
import type { NativeInput } from './types.js';
import type { PanelBounds } from './panels.js';

export type ComfyWorkspaceCommand = { projectId: string } & (
  | { type: 'bind' }
  | { type: 'layout'; generation: number; bounds: PanelBounds | null }
  | { type: 'request'; request: Exclude<ComfyRequest, { type: 'apply_graph' }> }
  | { type: 'runs'; cursor?: string; selectedRunId?: string }
  | { type: 'versions' }
  | { type: 'feedback'; runId: string; assetId: string }
  | { type: 'retry' | 'close' }
);
export interface ComfyRunPage { runs: RunView[]; nextCursor?: string; selectedRun?: RunView; }
export interface ComfyVersions { versions: string[]; recovery: { requestId: string; beforeVersionId: string }[]; }
export interface ComfyFeedback { text: string; attachments: NativeInput[]; path: string; }
export type ComfyWorkspaceReply = ComfyReply | ComfyRunPage | ComfyVersions | ComfyFeedback | { generation: number } | null;
