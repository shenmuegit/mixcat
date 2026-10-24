import type { ConversationEntry } from '../shared/types.js';
import type { ProjectState, StoredTask } from './model.js';

export function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join('\n');
  if (!value || typeof value !== 'object') return value == null ? '' : String(value);
  const item = value as Record<string, any>;
  if (item.type && typeof item.text === 'string') return item.text;
  if (item.type && item.content) return contentText(item.content);
  if (item.type === 'reasoning' && item.summary) return contentText(item.summary);
  if (item.type === 'mcpToolCall') return `${item.server ?? ''}${item.server ? ' / ' : ''}${item.tool ?? 'MCP 工具'}`;
  if (item.type === 'commandExecution') return String(item.command ?? '执行命令');
  if (item.type === 'fileChange') return (item.changes ?? []).map((change: any) => change.path).join('\n');
  if (item.type === 'image' || item.type === 'localImage') return String(item.path ?? item.url ?? '图片');
  return JSON.stringify(value, null, 2);
}

export function addConversation(state: ProjectState, entry: Omit<ConversationEntry, 'seq'>): ConversationEntry {
  const existing = state.conversation.find(item => item.id === entry.id);
  if (existing) return existing;
  const next = { ...entry, seq: (state.conversation.at(-1)?.seq ?? 0) + 1 };
  state.conversation.push(next); return next;
}

export function recordInput(state: ProjectState, task: StoredTask) {
  const message = state.messages?.find(item => item.message_id === task.incomingMessageId);
  if (message) return addConversation(state, {
    id: `input:${task.id}`, nodeId: task.nodeId, taskId: task.id, threadId: task.threadId, turnId: task.turnId, itemId: null,
    direction: 'input', source: { kind: 'node', nodeId: message.fromNodeId, name: message.fromName }, messageId: message.message_id, replyTo: message.request.reply_to ?? null,
    content: structuredClone(message.request.content), text: typeof message.request.content === 'string' ? message.request.content : JSON.stringify(message.request.content, null, 2), createdAt: task.createdAt, status: task.status,
  });
  const original = task.retryOfTaskId ? state.conversation.find(entry => entry.id === `input:${task.retryOfTaskId}`) : undefined;
  if (original) return addConversation(state, {
    ...structuredClone(original), id: `input:${task.id}`, nodeId: task.nodeId, taskId: task.id, threadId: task.threadId, turnId: task.turnId, itemId: null,
    createdAt: task.createdAt, completedAt: null, status: task.status, rawItem: undefined, nativeRole: undefined,
  });
  const handoff = state.handoffs.find(item => item.id === task.id);
  const content = task.nativeInput ?? [{ type: 'text', text: task.instruction }, ...(handoff ? [{ type: 'handoff', content: task.input }] : [])];
  const sourceName = handoff ? state.tasks.find(source => source.id === handoff.sourceTaskId)?.nodeSnapshot.name ?? state.nodes.find(node => node.id === handoff.fromNodeId)?.name ?? handoff.fromNodeId : undefined;
  const text = !task.nativeInput && handoff ? `${task.instruction}\n\n${typeof task.input === 'string' ? task.input : JSON.stringify(task.input, null, 2)}` : contentText(content);
  return addConversation(state, {
    id: `input:${task.id}`, nodeId: task.nodeId, taskId: task.id, threadId: task.threadId, turnId: task.turnId, itemId: null,
    direction: 'input', source: handoff ? { kind: 'node', nodeId: handoff.fromNodeId, name: sourceName } : { kind: 'user' },
    content: structuredClone(content), text, createdAt: task.createdAt, status: task.status,
  });
}

export function recordContinuation(state: ProjectState, task: StoredTask, content: unknown): ConversationEntry {
  return addConversation(state, {
    id: `continuation:${task.id}:${task.resumeCount}`, nodeId: task.nodeId, taskId: task.id, threadId: task.threadId, turnId: task.turnId, itemId: null,
    direction: 'input', source: { kind: 'system' }, controlActionId: task.resumeActionId, content: structuredClone(content), text: contentText(content), createdAt: new Date().toISOString(), status: task.status,
  });
}

export function nativeItem(state: ProjectState, nodeId: string, threadId: string, turnId: string, item: any, task: StoredTask | undefined, completed: boolean, createdAt: string): ConversationEntry {
  const id = `native:${threadId}:${turnId}:${item.id}`;
  let entry = state.conversation.find(entry => entry.id === id || (entry.threadId === threadId && entry.turnId === turnId && entry.itemId === item.id));
  if (!entry && item.type === 'userMessage' && task) {
    entry = state.conversation.find(entry => entry.taskId === task.id && entry.direction === 'input' && entry.turnId === turnId && entry.itemId === null);
    if (!entry && (!task.turnId || task.turnId === turnId) && !task.previousTurnIds?.includes(turnId)) entry = state.conversation.find(entry => entry.id === (task.resumeCount ? `continuation:${task.id}:${task.resumeCount}` : `input:${task.id}`) && entry.itemId === null);
  }
  if (entry && (entry.completedAt || entry.status === 'completed') && ((!completed && item.status !== 'completed') || ['inProgress', 'running', 'started'].includes(item.status))) return entry;
  if (!entry) entry = addConversation(state, {
    id, nodeId, taskId: task?.id ?? null, threadId, turnId, itemId: item.id,
    direction: item.type === 'userMessage' ? 'input' : ['agentMessage', 'reasoning'].includes(item.type) ? 'output' : 'event',
    source: item.type === 'userMessage' ? { kind: 'unknown' } : { kind: 'node', nodeId, name: task?.nodeSnapshot.name ?? [...state.nodes, ...(state.archivedNodes ?? [])].find(node => node.id === nodeId)?.name },
    text: '', content: null, createdAt,
  });
  // Preserve the human-facing incoming payload when the native prompt contains extra project context.
  const input = entry.direction === 'input' && (entry.id.startsWith('input:') || entry.id.startsWith('continuation:'));
  entry.threadId = threadId; entry.turnId = turnId; entry.itemId = item.id;
  entry.nativeRole = item.type === 'userMessage' ? 'user' : ['agentMessage', 'reasoning'].includes(item.type) ? 'assistant' : 'tool';
  entry.rawItem = structuredClone(item);
  if (input) { if (!entry.messageId && (entry.content as any)?.type !== 'reviewDecision') entry.content = { input: Array.isArray(entry.content) ? entry.content : (entry.content as any)?.input, native: structuredClone(item) }; }
  else { entry.content = structuredClone(item); entry.text = contentText(item); }
  entry.status = String(item.status ?? (completed ? 'completed' : 'inProgress'));
  if (completed) entry.completedAt ??= createdAt;
  return entry;
}

export function migrateHistory(state: ProjectState) {
  state.edges ??= []; state.conversation ??= []; state.messages ??= []; state.workflowReceipts ??= [];
  for (const node of state.nodes) {
    node.model ??= null; node.skills ??= []; node.plugins ??= [];
    if (!node.status) {
      const tasks = state.tasks.filter(task => task.nodeId === node.id);
      node.status = tasks.some(task => task.status === 'running') ? 'running' : tasks.some(task => task.status === 'needs_reconciliation') ? 'blocked'
        : state.project.status === 'paused' ? 'paused' : tasks.some(task => ['queued', 'waiting_source'].includes(task.status)) ? 'queued'
        : tasks.at(-1)?.status === 'completed' ? 'completed' : tasks.at(-1)?.status === 'failed' ? 'blocked' : 'idle';
    }
  }
  state.pauseSnapshot ??= state.nodes.filter(node => node.status === 'running').map(node => node.id);
  if (!state.conversation.length) {
  const entries: Omit<ConversationEntry, 'seq'>[] = [];
  for (const task of state.tasks) {
    const entry = recordInput(state, task); const { seq, ...stored } = entry; entries.push(stored);
  }
  state.conversation = [];
  for (const activity of state.activities.filter(activity => activity.kind.startsWith('message:') && activity.nodeId)) {
    const task = state.tasks.find(task => task.id === activity.taskId);
    entries.push({ id: task?.threadId && task?.turnId ? `native:${task.threadId}:${task.turnId}:${activity.kind.slice(8)}` : `legacy:${activity.id}`, nodeId: activity.nodeId!, taskId: activity.taskId, threadId: task?.threadId ?? null, turnId: task?.turnId ?? null, itemId: activity.kind.slice(8), direction: 'output', source: null, text: activity.text, content: { type: 'legacyMessage', text: activity.text }, createdAt: activity.createdAt, status: task?.status === 'completed' ? 'completed' : undefined });
  }
  entries.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  for (const entry of entries) addConversation(state, entry);
  }
  for (const entry of state.conversation) {
    const task = state.tasks.find(task => task.id === entry.taskId);
    if (entry.id.startsWith('continuation:') && task) entry.source = { kind: 'system' };
    else if (entry.direction === 'input' && !entry.id.startsWith('input:')) entry.source = { kind: 'unknown' };
    else if (entry.direction !== 'input' && !entry.source) entry.source = task ? { kind: 'node', nodeId: task.nodeId, name: task.nodeSnapshot.name } : { kind: 'unknown' };
    if (entry.direction === 'input' && entry.messageId) continue;
    const content = entry.content as any;
    entry.rawItem ??= content?.native ?? (content?.type && content.type !== 'legacyMessage' ? structuredClone(content) : undefined);
    const type = (entry.rawItem as any)?.type;
    entry.nativeRole ??= type === 'userMessage' ? 'user' : ['agentMessage', 'reasoning'].includes(type) ? 'assistant'
      : ['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch', 'imageView'].includes(type) ? 'tool' : undefined;
  }
}
