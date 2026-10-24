import type { Activity, AttachmentSnapshot, ConversationEntry, HandoffView, HumanReviewPolicy, HumanReviewView, MessageReceipt, NativeInput, NodeDefinition, NodeStatus, ProjectSummary, RequestReviewInput, RunMode, SendMessageInput, TaskView, WorkflowEdge, WorkflowEditInput, WorkflowEditReceipt } from '../shared/types.js';
export interface StoredNode extends NodeDefinition { threads: { codex?: string; demo?: string }; status?: NodeStatus; }
export interface TerminalAction { kind: 'handoff' | 'complete' | 'blocked'; result: unknown; fingerprint: string; handoffId?: string; reason?: string; turnId?: string; callId?: string; }
export interface StoredTask extends TaskView { runId: string; nodeSnapshot: NodeDefinition; terminal: TerminalAction | null; nativeInput?: NativeInput[]; mode?: RunMode; stopRequested?: boolean; pauseRequested?: boolean; resumeCount?: number; resumeActionId?: string; previousTurnIds?: string[]; incomingMessageId?: string; retryOfTaskId?: string; }
export interface StoredMessage extends MessageReceipt {
  request: SendMessageInput; fromNodeId: string; fromName: string; toNodeId: string; toName: string; sourceTaskId: string;
  threadId: string; turnId: string; callId: string; replayCalls?: StoredNativeCall[]; attachments: AttachmentSnapshot[]; edgeSnapshot: WorkflowEdge | null;
}
export interface StoredNativeCall { threadId: string; turnId: string; callId: string; }
export interface StoredHumanReview extends HumanReviewView { request: RequestReviewInput; replayCalls?: StoredNativeCall[]; bundle: string; }
export interface StoredWorkflowEditReceipt { receipt: WorkflowEditReceipt; nodeId: string; request: WorkflowEditInput; threadId: string; turnId: string; callId: string; replayCalls?: StoredNativeCall[]; }
export interface ProjectState {
  project: ProjectSummary; nodes: StoredNode[]; archivedNodes?: StoredNode[]; tasks: StoredTask[]; handoffs: HandoffView[];
  activities: Activity[]; edges: WorkflowEdge[]; conversation: ConversationEntry[]; messages: StoredMessage[]; workflowReceipts: StoredWorkflowEditReceipt[]; runId: string | null; maxSteps: number; stopRequested?: boolean;
  pauseSnapshot?: string[];
  reviewPolicy: HumanReviewPolicy; humanReviews: StoredHumanReview[];
}
