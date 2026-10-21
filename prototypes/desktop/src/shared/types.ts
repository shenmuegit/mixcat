import type { PanelCommand, PanelSnapshot } from './panels.js';
export const WORKFLOW_TOOLS = ['get_project_context', 'handoff', 'complete_task', 'update_workflow'] as const;
export type WorkflowTool = typeof WORKFLOW_TOOLS[number];
export type RunMode = 'codex' | 'demo';
export type ProjectStatus = 'idle' | 'running' | 'pausing' | 'paused' | 'blocked' | 'completed';
export type NodeStatus = 'idle' | 'starting' | 'running' | 'pausing' | 'resuming' | 'paused' | 'queued' | 'blocked' | 'completed';
export type TaskStatus = 'queued' | 'running' | 'paused' | 'waiting_source' | 'completed' | 'failed' | 'cancelled' | 'needs_reconciliation';
export type JsonObject = Record<string, unknown>;
export interface SkillSelection { name: string; path: string; }
export interface PluginSelection { id: string; name: string; }
export interface CapabilityCatalog {
  models: { id: string; name: string; isDefault?: boolean }[];
  skills: (SkillSelection & { description?: string })[];
  plugins: (PluginSelection & { description?: string; installed?: boolean })[];
  errors: string[];
}
export type NativeInput = { type: string; [key: string]: unknown };
export interface WorkflowEdge { id: string; sourceNodeId: string; targetNodeId: string; condition: string; revision: number; }
export interface ConversationEntry {
  id: string; seq: number; nodeId: string; taskId: string | null; threadId: string | null; turnId: string | null; itemId: string | null;
  direction: 'input' | 'output' | 'event'; source: { kind: 'user' | 'node'; nodeId?: string; name?: string } | null;
  text: string; content: unknown; createdAt: string; completedAt?: string | null; status?: string;
}
export interface NativeServerRequest { id: number | string; method: string; params: any; }
export interface PendingNativeRequest extends NativeServerRequest { key: string; projectId: string; nodeId: string | null; }
export interface NodeDefinition {
  id: string; name: string; instructions: string; tools: WorkflowTool[];
  resultSchema: JsonObject; position: { x: number; y: number }; revision: number;
  model?: string | null; skills?: SkillSelection[]; plugins?: PluginSelection[];
}
export interface NodeView extends NodeDefinition { threadId: string | null; status: NodeStatus; }
export interface ProjectSummary { id: string; name: string; root: string; goal: string; status: ProjectStatus; mode: RunMode; updatedAt: string; }
export interface TaskView {
  id: string; nodeId: string; instruction: string; status: TaskStatus; turnId: string | null;
  threadId: string | null; attempt: number; input: unknown; result: unknown; error: string | null;
  createdAt: string; finishedAt: string | null;
}
export interface HandoffView { id: string; sourceTaskId: string; fromNodeId: string; toNodeId: string; task: string; reason: string; result: unknown; status: string; createdAt: string; }
export interface Activity { id: number; nodeId: string | null; taskId: string | null; kind: string; text: string; createdAt: string; }
export interface ProjectSnapshot { project: ProjectSummary; nodes: NodeView[]; tasks: TaskView[]; handoffs: HandoffView[]; activities: Activity[]; edges?: WorkflowEdge[]; conversation?: ConversationEntry[]; requests?: PendingNativeRequest[]; resumeNodeIds?: string[]; }
export interface RuntimeStatus { connected: boolean; authenticated: boolean; accountLabel: string | null; error: string | null; version?: string; mode?: RunMode; }
export interface AppSnapshot { projects: ProjectSummary[]; selected: ProjectSnapshot | null; runtime: RuntimeStatus | null; }
export type AppCommand =
  | { type: 'snapshot'; projectId?: string }
  | { type: 'create_project'; name: string; root: string; goal: string }
  | { type: 'save_node'; projectId: string; node: Omit<NodeDefinition, 'revision'> & { revision?: number }; relatedTo?: string; condition?: string }
  | { type: 'move_node'; projectId: string; nodeId: string; position: NodeDefinition['position'] }
  | { type: 'save_edge'; projectId: string; edge: WorkflowEdge }
  | { type: 'delete_edge'; projectId: string; edgeId: string }
  | { type: 'catalog'; projectId: string }
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
  | { type: 'login'; projectId: string }
  | { type: 'retry_task'; projectId: string; taskId: string; confirmed: boolean }
  | { type: 'create_demo' };
export interface AppReply { snapshot: AppSnapshot; authUrl?: string; catalog?: CapabilityCatalog; }
export interface DesktopApi {
  command(command: AppCommand): Promise<AppReply>;
  chooseDirectory(): Promise<string | null>;
  subscribe(listener: (snapshot: AppSnapshot) => void): () => void;
  panel(command: PanelCommand): Promise<PanelSnapshot>;
  subscribePanels(listener: (snapshot: PanelSnapshot) => void): () => void;
  chooseAttachments(projectId: string, nodeId: string): Promise<NativeInput[]>;
}
export interface NativeEvent { method: string; params: any; }
export interface NativeClientOptions { executable: string; home: string; cwd: string; onEvent(event: NativeEvent): void; onDisconnect(error: string): void; onRequest?(request: NativeServerRequest): void; }
export interface CodexPort {
  connect(): Promise<void>;
  rpc(method: string, params: Record<string, unknown>): Promise<any>;
  respond?(id: number | string, result: unknown): void;
  close(): Promise<void>;
}
export interface McpIdentity { token: string; projectId: string; nodeId: string; tools: WorkflowTool[]; resultSchema: JsonObject; }
export interface McpCallContext { identity: McpIdentity; threadId: string; turnId: string; callId: string; }
export interface McpGatewayOptions {
  resolveIdentity(token: string): McpIdentity | undefined;
  invoke(name: WorkflowTool, args: Record<string, unknown>, context: McpCallContext): Promise<unknown>;
}
export interface McpGateway { url: string; close(): Promise<void>; }
declare global { interface Window { mixcat: DesktopApi; } }
