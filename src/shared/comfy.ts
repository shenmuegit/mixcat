export type ProviderProtocol = 'ark' | 'minimax-cn' | 'minimax-global' | 'vidu';
export type MediaKind = 'text' | 'image' | 'video';
export type ComfyActor = { kind: 'user' } | { kind: 'codex'; nodeId: string; threadId: string; turnId: string; callId: string };
export interface ProviderProfile {
  id: string; name: string; protocol: ProviderProtocol; baseUrl: string;
  revision: number; credentialRevision: number; configured: boolean;
  models: Partial<Record<MediaKind, string>>; videoApi?: 'v1' | 'v2';
}
export interface ComfyObservation { projectId: string; instanceId: string; workflowId: string; tabId: string; revision: string; }
export interface GraphView { observation: ComfyObservation; workflow: Record<string, unknown>; subgraphPath: string[]; selectedNodeIds: string[]; }
export type RunStatus = 'prepared' | 'submitting' | 'submission_unknown' | 'queued' | 'running' | 'downloading' | 'succeeded' | 'failed' | 'cancel_requested' | 'cancelled' | 'needs_reconciliation';
export interface ArtifactRef { id: string; relativePath: string; mime: string; sha256: string; bytes: number; }
export interface RunView { id: string; observation: ComfyObservation; requestId: string; status: RunStatus; promptId?: string; assets: ArtifactRef[]; error?: { code: string; message: string }; }
export interface EditReceipt { requestId: string; beforeVersionId: string; afterVersionId: string; observation: ComfyObservation; }
export interface NodeCatalog { nodes: { classType: string; inputs: Record<string, unknown>; outputs: string[] }[]; missing: string[]; }
export interface ComfySummary { runtime: { status: string; instanceId?: string; versionId?: string }; providers: ProviderProfile[]; recentRuns: RunView[]; }
export type ComfyReply = GraphView | EditReceipt | NodeCatalog | RunView | ComfySummary;
export type ComfyRequest =
  | { type: 'read_graph' }
  | { type: 'apply_graph'; requestId: string; expected: ComfyObservation; workflow: Record<string, unknown> }
  | { type: 'restore_graph'; requestId: string; expected: ComfyObservation; versionId: string }
  | { type: 'inspect_nodes'; nodeTypes: string[] }
  | { type: 'queue_graph'; requestId: string; expected: ComfyObservation }
  | { type: 'read_run'; runId: string }
  | { type: 'stop_run'; runId: string; action: 'stop_waiting' | 'cancel_remote' }
  | { type: 'summary' };
export interface ComfyHostPort {
  request(projectId: string, request: ComfyRequest, actor: ComfyActor): Promise<ComfyReply>;
  closeProject(projectId: string): Promise<void>;
}
export interface ComfyOperationReceipt { requestId: string; fingerprint: string; status: 'pending' | 'committed'; result?: EditReceipt | RunView; }
