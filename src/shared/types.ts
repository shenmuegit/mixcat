import type { PanelCommand, PanelSnapshot } from './panels.js';
export const WORKFLOW_TOOLS = ['get_project_context', 'handoff', 'complete_task', 'update_workflow', 'send_message', 'get_delivery', 'read_history', 'request_review', 'get_review'] as const;
export type WorkflowTool = typeof WORKFLOW_TOOLS[number];
export type RunMode = 'codex' | 'demo';
export type ProjectStatus = 'idle' | 'running' | 'pausing' | 'paused' | 'blocked' | 'completed';
export type NodeStatus = 'idle' | 'starting' | 'running' | 'pausing' | 'resuming' | 'paused' | 'queued' | 'blocked' | 'completed';
export type TaskStatus = 'queued' | 'running' | 'paused' | 'waiting_source' | 'waiting_review' | 'completed' | 'failed' | 'cancelled' | 'needs_reconciliation';
export type JsonObject = Record<string, unknown>;
export interface SkillSelection { name: string; path: string; }
export interface PluginSelection { id: string; name: string; }
export interface CapabilityCatalog {
  models: { id: string; name: string; isDefault?: boolean }[];
  skills: (SkillSelection & { description?: string })[];
  plugins: (PluginSelection & { description?: string; installed?: boolean })[];
  errors: string[];
  hooks?: { eventName: string; enabled: boolean; trustStatus: string; sourcePath: string; key: string; currentHash: string | null; command?: string; matcher?: string | null }[];
  mcpServers?: { name: string; toolCount: number; status: string }[];
}
export interface HostAttachment { artifact_id: string; name: string; path: string; }
export type NativeInput = { type: string; mixcatAttachment?: HostAttachment; [key: string]: unknown };
export interface WorkflowEdge { id: string; sourceNodeId: string; targetNodeId: string; condition: string; revision: number; }
export interface EdgePoint { x: number; y: number; }
export interface EdgeAnchor { side: 'top' | 'right' | 'bottom' | 'left'; offset: number; }
export interface EdgeLayout { revision: number; source?: EdgeAnchor; target?: EdgeAnchor; controlOffset?: EdgePoint; bends?: EdgePoint[]; }
export type MessageAttachmentInput = { path: string; artifact_id?: never } | { artifact_id: string; path?: never };
export interface AttachmentSnapshot { artifact_id: string; name: string; relativePath: string; sha256: string; size: number; }
export interface ReviewCheckpoint { id: string; name: string; ownerNodeId: string; requiredForNodeIds: string[]; dependsOn: string[]; revision: number; }
export interface HumanReviewPolicy { revision: number; checkpoints: ReviewCheckpoint[]; }
export interface ReviewDependency { checkpointId: string; checkpointRevision: number; reviewId: string | null; version: number | null; }
export interface RequestReviewInput { request_id: string; checkpoint_id: string; title: string; content: unknown; attachments?: MessageAttachmentInput[]; }
export interface ReviewReceipt { accepted: true; review_id: string; checkpoint_id: string; version: number; accepted_at: string; }
export type HumanReviewStatus = 'pending' | 'approved' | 'changes_requested' | 'withdrawn' | 'superseded';
export interface ReviewDecision {
  commandId: string; reviewId: string; version: number; bundleHash: string; decision: 'approved' | 'changes_requested'; comment: string; createdAt: string; continuationTaskId: string;
}
export interface ReviewSourceFile { path: string; sha256: string; size: number; }
export interface HumanReviewView {
  id: string; projectId: string; checkpointId: string; checkpointRevision: number; version: number; requestId: string;
  nodeId: string; taskId: string; threadId: string; turnId: string; callId: string;
  title: string; content: unknown; attachments: AttachmentSnapshot[]; sourceFiles: ReviewSourceFile[]; upstreamDependencies: ReviewDependency[];
  bundleHash: string; status: HumanReviewStatus; createdAt: string; decision: ReviewDecision | null; supersededBy: string | null;
}
export interface SendMessageInput {
  request_id: string; to_node_id: string; content: unknown; reason: string;
  attachments?: MessageAttachmentInput[]; reply_to?: string | null; route?: { edge_id: string; edge_revision: number } | null;
}
export interface MessageReceipt { accepted: true; message_id: string; target_task_id: string; accepted_at: string; }
export interface MessageSummary extends Omit<MessageReceipt, 'accepted'> { sourceTaskId: string; fromNodeId: string; fromName: string; toNodeId: string; toName: string; replyTo: string | null; }
export type WorkflowEditInput = { operation: 'save_node'; request_id: string; node: NodeDefinition; related_to?: string; condition?: string }
  | { operation: 'save_edge'; request_id: string; edge: WorkflowEdge };
export interface WorkflowEditReceipt { accepted: true; request_id: string; operation: WorkflowEditInput['operation']; node?: NodeDefinition; edge?: WorkflowEdge; }
export type WorkflowErrorCode = 'REQUEST_CONFLICT' | 'TARGET_UNAVAILABLE' | 'INVALID_REPLY' | 'ROUTE_CHANGED' | 'REVISION_CONFLICT' | 'SOURCE_NOT_ACTIVE' | 'PERMISSION_DENIED' | 'STORAGE_UNAVAILABLE';
export interface ConversationEntry {
  id: string; seq: number; nodeId: string; taskId: string | null; threadId: string | null; turnId: string | null; itemId: string | null;
  direction: 'input' | 'output' | 'event'; source: { kind: 'user' | 'node' | 'system' | 'unknown'; nodeId?: string; name?: string } | null;
  nativeRole?: 'user' | 'assistant' | 'tool'; rawItem?: unknown; controlActionId?: string; messageId?: string; replyTo?: string | null;
  attachments?: AttachmentSnapshot[];
  sentMessage?: { content: unknown };
  text: string; content: unknown; createdAt: string; completedAt?: string | null; status?: string;
}
export interface HistoryQuery { node_id?: string; task_id?: string; message_id?: string; reply_to?: string; limit?: number; cursor?: string; }
export interface HistoryPage { entries: ConversationEntry[]; next_cursor: string | null; }
export interface NativeServerRequest { id: number | string; method: string; params: any; }
export interface PendingNativeRequest extends NativeServerRequest { key: string; projectId: string; nodeId: string | null; }
export interface NodeDefinition {
  id: string; name: string; instructions: string; tools: WorkflowTool[];
  resultSchema: JsonObject; position: { x: number; y: number }; revision: number;
  model?: string | null; skills?: SkillSelection[]; plugins?: PluginSelection[]; planId?: string;
}
export interface NodeView extends NodeDefinition { threadId: string | null; status: NodeStatus; }
export interface ProjectSummary { id: string; name: string; root: string; goal: string; status: ProjectStatus; mode: RunMode; updatedAt: string; template?: 'web-product'; }
export interface TaskView {
  id: string; nodeId: string; instruction: string; status: TaskStatus; turnId: string | null;
  threadId: string | null; attempt: number; input: unknown; result: unknown; error: string | null;
  createdAt: string; finishedAt: string | null;
  provenance?: ExecutionProvenance;
  reviewDependencies?: ReviewDependency[];
}
export interface ExecutionProvenance {
  requestedModel: string | null; actualModel: string | null; native: NativeRuntimeInfo;
  skills: { name: string; path: string; contentSha256: string | null }[];
  plugins: { id: string; source: string | null; originalSource: string | null; manifestPath: string | null; manifestVersion: string | null; manifestSha256: string | null }[];
}
export interface HandoffView { id: string; sourceTaskId: string; fromNodeId: string; toNodeId: string; task: string; reason: string; result: unknown; status: string; createdAt: string; }
export interface Activity { id: number; nodeId: string | null; taskId: string | null; kind: string; text: string; createdAt: string; }
export interface ProjectSnapshot { project: ProjectSummary; nodes: NodeView[]; archivedNodes?: NodeView[]; tasks: TaskView[]; handoffs: HandoffView[]; activities: Activity[]; edges?: WorkflowEdge[]; edgeLayouts?: Record<string, EdgeLayout>; conversation?: ConversationEntry[]; requests?: PendingNativeRequest[]; resumeNodeIds?: string[]; messages?: MessageSummary[]; reviewPolicy?: HumanReviewPolicy; humanReviews?: HumanReviewView[]; }
export interface NativeRuntimeInfo { executable: string | null; version: string | null; initialize: Record<string, unknown> | null; }
export interface RuntimeStatus { connected: boolean; authenticated: boolean; accountLabel: string | null; error: string | null; version?: string; native?: NativeRuntimeInfo; mode?: RunMode; }
export interface AppSnapshot { generation?: number; revision?: number; projects: ProjectSummary[]; selected: ProjectSnapshot | null; runtime: RuntimeStatus | null; account?: RuntimeStatus | null; }
export type AppUpdate = { kind: 'full'; snapshot: AppSnapshot } | {
  kind: 'delta'; generation: number; revision: number; baseRevision: number; projectId: string;
  projects: ProjectSummary[]; runtime: RuntimeStatus | null; account?: RuntimeStatus | null;
  selected: Omit<ProjectSnapshot, 'conversation'>; entries: ConversationEntry[];
};
export type AppCommand =
  | { type: 'snapshot'; projectId?: string; background?: boolean }
  | { type: 'create_project'; name: string; root: string; goal: string; template?: 'web-product' }
  | { type: 'configure_template'; projectId: string }
  | { type: 'save_review_policy'; projectId: string; policy: HumanReviewPolicy }
  | { type: 'decide_review'; projectId: string; reviewId: string; version: number; bundleHash: string; decision: ReviewDecision['decision']; comment: string }
  | { type: 'withdraw_review'; projectId: string; reviewId: string; version: number; bundleHash: string }
  | { type: 'cancel_review_task'; projectId: string; taskId: string }
  | { type: 'trust_hooks'; projectId: string; hooks: { key: string; currentHash: string }[] }
  | { type: 'save_node'; projectId: string; node: Omit<NodeDefinition, 'revision'> & { revision?: number }; relatedTo?: string; condition?: string }
  | { type: 'move_node'; projectId: string; nodeId: string; position: NodeDefinition['position'] }
  | { type: 'move_nodes'; projectId: string; positions: { nodeId: string; position: NodeDefinition['position'] }[] }
  | { type: 'delete_node'; projectId: string; nodeId: string }
  | { type: 'save_edge'; projectId: string; edge: WorkflowEdge }
  | { type: 'save_edge_layout'; projectId: string; edgeId: string; layout: EdgeLayout }
  | { type: 'delete_edge'; projectId: string; edgeId: string }
  | { type: 'catalog'; projectId: string; nodeId?: string }
  | { type: 'send_message'; projectId: string; nodeId: string; input: NativeInput[]; mode: RunMode }
  | { type: 'read_history'; projectId: string; nodeId: string }
  | { type: 'respond_native'; projectId: string; requestKey: string; result: unknown }
  | { type: 'start'; projectId: string; nodeId: string; instruction: string; mode: RunMode }
  | { type: 'pause'; projectId: string }
  | { type: 'resume'; projectId: string }
  | { type: 'pause_node'; projectId: string; nodeId: string }
  | { type: 'resume_node'; projectId: string; nodeId: string }
  | { type: 'stop'; projectId: string }
  | { type: 'connect'; projectId: string }
  | { type: 'connect_account' }
  | { type: 'login' }
  | { type: 'retry_task'; projectId: string; taskId: string; confirmed: boolean }
  | { type: 'create_demo' };
export interface AppReply { snapshot: AppSnapshot; authUrl?: string; catalog?: CapabilityCatalog; }
export interface CommandEnvelope { id: string; command: AppCommand; }
export interface CommandReceipt {
  id: string; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  result?: AppReply; error?: string;
}
export interface DesktopApi {
  command(envelope: CommandEnvelope): Promise<AppReply>;
  inspect(id: string): Promise<CommandReceipt>;
  chooseDirectory(): Promise<string | null>;
  subscribe(listener: (update: AppUpdate) => void): () => void;
  panel(command: PanelCommand): Promise<PanelSnapshot>;
  subscribePanels(listener: (snapshot: PanelSnapshot) => void): () => void;
  chooseAttachments(projectId: string, nodeId: string): Promise<NativeInput[]>;
  choosePanelFile(projectId: string, nodeId: string, generation: number): Promise<string | null>;
}
export interface NativeEvent { method: string; params: any; }
export interface NativeClientOptions { executable: string; home: string; cwd: string; onEvent(event: NativeEvent): void; onDisconnect(error: string): void; onRequest?(request: NativeServerRequest): void; }
export interface CodexPort {
  info?(): NativeRuntimeInfo;
  connect(): Promise<void>;
  rpc(method: string, params: Record<string, unknown>): Promise<any>;
  respond?(id: number | string, result: unknown): void;
  reject?(id: number | string, error: { code: number; message: string }): void;
  close(): Promise<void>;
}
export interface McpIdentity { token: string; projectId: string; nodeId: string; tools: WorkflowTool[]; resultSchema: JsonObject; edges?: WorkflowEdge[]; }
export interface McpCallContext { identity: McpIdentity; threadId: string; turnId: string; callId: string; edge?: WorkflowEdge; }
export interface McpGatewayOptions {
  resolveIdentity(token: string): McpIdentity | undefined;
  invoke(name: WorkflowTool, args: Record<string, unknown>, context: McpCallContext): Promise<unknown>;
}
export interface McpGateway { url: string; close(): Promise<void>; }
declare global { interface Window { mixcat: DesktopApi; } }
