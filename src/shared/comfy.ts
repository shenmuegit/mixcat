export const COMFY_TOOLS = ['get_comfy_workflow', 'apply_comfy_workflow', 'restore_comfy_workflow', 'inspect_comfy_nodes', 'run_comfy_workflow', 'get_comfy_run', 'stop_comfy_run'] as const;
export const COMFY_READ_TOOLS: readonly string[] = ['get_comfy_workflow', 'inspect_comfy_nodes', 'get_comfy_run'];
export type ComfyTool = typeof COMFY_TOOLS[number];
export type ProviderProtocol = 'ark' | 'minimax-cn' | 'minimax-global' | 'vidu';
export type MediaKind = 'text' | 'image' | 'video';
export type ComfyActor = { kind: 'user' } | { kind: 'codex'; nodeId: string; threadId: string; turnId: string; callId: string };
export interface ProviderProfile {
  id: string; name: string; protocol: ProviderProtocol; baseUrl: string;
  revision: number; credentialRevision: number; configured: boolean;
  models: Partial<Record<MediaKind, string>>; videoApi?: 'v1' | 'v2';
}
export interface ComfyObservation { projectId: string; instanceId: string; workflowId: string; tabId: string; revision: string; }
export interface GraphView { observation: ComfyObservation; workflow: Record<string, unknown>; subgraphPath: string[]; selectedNodeIds: string[]; recovery?: { requestId: string; beforeVersionId: string; recoveryRequestId?: string }[]; }
export type RunStatus = 'prepared' | 'submitting' | 'submission_unknown' | 'queued' | 'running' | 'downloading' | 'succeeded' | 'failed' | 'cancel_requested' | 'cancelled' | 'needs_reconciliation';
export interface ArtifactRef { id: string; relativePath: string; mime: string; sha256: string; bytes: number; }
export interface RunView { id: string; observation: ComfyObservation; requestId: string; status: RunStatus; promptId?: string; assets: ArtifactRef[]; waiting?: boolean; nativeStop?: 'removed'; recoveredAssets?: ArtifactRef[]; providerJobs?: { jobId: string; nodeId: string; status: string; waiting: boolean; rawStatus?: string; cancelOutcome?: string; failure?: { code: string; message: string; outcome: string; httpStatus?: number; vendorCode?: string } }[]; error?: { code: string; message: string }; }
export interface EditReceipt { requestId: string; beforeVersionId: string; afterVersionId: string; observation: ComfyObservation; recoveryRequestId?: string; }
export interface NodeCatalog { nodes: { classType: string; inputs: Record<string, unknown>; outputs: string[] }[]; missing: string[]; }
export interface ComfySummary { runtime: { status: string; instanceId?: string; versionId?: string }; providers: ProviderProfile[]; recentRuns: RunView[]; }
export type ComfyReply = GraphView | EditReceipt | NodeCatalog | RunView | ComfySummary;
export type ComfyRequest =
  | { type: 'read_graph' }
  | { type: 'apply_graph'; requestId: string; expected: ComfyObservation; workflow: Record<string, unknown> }
  | { type: 'restore_graph'; requestId: string; expected: ComfyObservation; versionId: string; recoveryRequestId?: string }
  | { type: 'inspect_nodes'; nodeTypes: string[] }
  | { type: 'queue_graph'; requestId: string; expected: ComfyObservation }
  | { type: 'read_run'; runId: string }
  | { type: 'stop_run'; runId: string; action: 'stop_waiting' | 'cancel_remote' }
  | { type: 'summary' };
export interface ComfyHostPort {
  request(projectId: string, request: ComfyRequest, actor: ComfyActor): Promise<ComfyReply>;
  closeProject(projectId: string, deleting?: boolean): Promise<void>;
}
export interface ComfyOperationReceipt { requestId: string; fingerprint: string; status: 'pending' | 'committed' | 'recovered'; recoveredBy?: string; result?: EditReceipt | RunView; }
