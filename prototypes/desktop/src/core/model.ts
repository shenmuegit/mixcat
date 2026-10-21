import type { Activity, ConversationEntry, HandoffView, NativeInput, NodeDefinition, NodeStatus, ProjectSummary, RunMode, TaskView, WorkflowEdge } from '../shared/types.js';
export interface StoredNode extends NodeDefinition { threads: { codex?: string; demo?: string }; status?: NodeStatus; }
export interface TerminalAction { kind: 'handoff' | 'complete' | 'blocked'; result: unknown; fingerprint: string; handoffId?: string; reason?: string; }
export interface StoredTask extends TaskView { runId: string; nodeSnapshot: NodeDefinition; terminal: TerminalAction | null; nativeInput?: NativeInput[]; mode?: RunMode; stopRequested?: boolean; pauseRequested?: boolean; resumeCount?: number; previousTurnIds?: string[]; }
export interface ProjectState {
  project: ProjectSummary; nodes: StoredNode[]; tasks: StoredTask[]; handoffs: HandoffView[];
  activities: Activity[]; edges: WorkflowEdge[]; conversation: ConversationEntry[]; runId: string | null; maxSteps: number; stopRequested?: boolean;
  pauseSnapshot?: string[];
}
