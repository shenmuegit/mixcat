import { isDeepStrictEqual } from 'node:util';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { ConversationEntry, HistoryPage, HistoryQuery, HostAttachment, HumanReviewView, McpCallContext, MessageReceipt, MessageSummary, SendMessageInput, WorkflowEditInput, WorkflowEditReceipt, WorkflowErrorCode } from '../shared/types.js';
import { compareConversation, orderedConversation } from '../shared/conversation-order.js';
import type { ProjectState, StoredHumanReview, StoredMessage, StoredNativeCall, StoredTask } from './model.js';
import { reviewDependencies } from './reviews.js';
import { itemMaterialMatches, parseWorkContext, type ManagementState } from '../shared/project-items.js';

export function humanReviewView(review: StoredHumanReview, management?: ManagementState): HumanReviewView {
  const { id, projectId, checkpointId, checkpointRevision, version, requestId, nodeId, taskId, threadId, turnId, callId, title, content, attachments, sourceFiles, upstreamDependencies, bundleHash, status, createdAt, decision, supersededBy } = review;
  return structuredClone({ id, projectId, checkpointId, checkpointRevision, version, requestId, nodeId, taskId, threadId, turnId, callId, title, content, attachments, sourceFiles, upstreamDependencies, bundleHash, status, createdAt, decision, supersededBy,
    ...(review.itemMaterials ? { itemMaterials: review.itemMaterials, ...(management ? { materialsCurrent: review.itemMaterials.every(material => itemMaterialMatches(management.items.find(item => item.id === material.id), material)) } : {}) } : {}) });
}

export class WorkflowError extends Error {
  constructor(readonly code: WorkflowErrorCode, message: string) { super(message); }
}
function invalid(message: string): never { throw new McpError(ErrorCode.InvalidParams, message); }
function identifier(value: unknown, limit = 100): value is string { return typeof value === 'string' && value.length <= limit && /^[a-zA-Z0-9_-]+$/.test(value); }
function normalizeZero(value: unknown): unknown {
  if (typeof value === 'number') return Object.is(value, -0) ? 0 : value;
  if (Array.isArray(value)) return value.map(normalizeZero);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const key of Object.keys(value)) (value as Record<string, unknown>)[key] = normalizeZero((value as Record<string, unknown>)[key]);
  }
  return value;
}
export function parseMessageInput(value: Record<string, unknown>): SendMessageInput {
  const request = structuredClone(value);
  if (Object.keys(request).some(key => !['request_id', 'to_node_id', 'content', 'reason', 'attachments', 'reply_to', 'route', 'work_context'].includes(key))) invalid('消息包含不支持的信封字段。');
  if (!identifier(request.request_id, 128) || !identifier(request.to_node_id)) invalid('请求编号或目标节点标识不正确。');
  if (typeof request.reason !== 'string' || !request.reason.trim() || request.reason.length > 4000 || request.reason.includes('\0')) invalid('发送理由不能为空，且不能超过 4000 个字符。');
  try {
    const serialized = JSON.parse(JSON.stringify(request.content));
    request.content = normalizeZero(request.content);
    if (!Object.hasOwn(request, 'content') || !isDeepStrictEqual(request.content, serialized)) invalid('content 必须是 JSON 值。');
  }
  catch { invalid('content 必须是 JSON 值。'); }
  const attachments = request.attachments === undefined ? [] : request.attachments;
  if (!Array.isArray(attachments) || attachments.some(item => !item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== 1 || !['path', 'artifact_id'].some(key => typeof item[key] === 'string' && item[key].trim()))) invalid('附件必须只包含 path 或 artifact_id。');
  const reply = request.reply_to ?? null, route = request.route ?? null;
  if (reply !== null && !identifier(reply, 128)) invalid('reply_to 必须是消息编号。');
  if (route !== null && (typeof route !== 'object' || Array.isArray(route) || Object.keys(route).length !== 2 || !identifier((route as any).edge_id) || !Number.isInteger((route as any).edge_revision) || (route as any).edge_revision < 1)) invalid('route 必须包含边编号和正整数版本。');
  return { request_id: request.request_id, to_node_id: request.to_node_id, content: request.content, reason: request.reason, attachments, reply_to: reply, route: route as SendMessageInput['route'], ...(request.work_context !== undefined ? { work_context: parseWorkContext(request.work_context) } : {}) };
}
export function messageReceipt(message: StoredMessage): MessageReceipt {
  return { accepted: true, message_id: message.message_id, target_task_id: message.target_task_id, accepted_at: message.accepted_at };
}
export function messageSummary(message: StoredMessage): MessageSummary {
  return { message_id: message.message_id, target_task_id: message.target_task_id, accepted_at: message.accepted_at, sourceTaskId: message.sourceTaskId,
    fromNodeId: message.fromNodeId, fromName: message.fromName, toNodeId: message.toNodeId, toName: message.toName, replyTo: message.request.reply_to ?? null };
}
export function hasReceiptCall(stored: StoredNativeCall & { replayCalls?: StoredNativeCall[] }, context: StoredNativeCall): boolean {
  const matches = (call: StoredNativeCall) => call.threadId === context.threadId && call.turnId === context.turnId && call.callId === context.callId;
  return matches(stored) || !!stored.replayCalls?.some(matches);
}
export function findMessageReceipt(state: ProjectState, nodeId: string, input: SendMessageInput, context: McpCallContext): MessageReceipt | null {
  const messages = state.messages.filter(message => message.fromNodeId === nodeId);
  if (messages.some(message => hasReceiptCall(message, context) && message.request.request_id !== input.request_id)) throw new WorkflowError('REQUEST_CONFLICT', '同一次原生调用不能更换请求编号。');
  const message = messages.find(message => message.request.request_id === input.request_id);
  if (!message) return null;
  if (!isDeepStrictEqual(message.request, input)) throw new WorkflowError('REQUEST_CONFLICT', '请求编号已经用于不同消息。');
  return messageReceipt(message);
}
export function parseWorkflowEdit(value: Record<string, unknown>): WorkflowEditInput {
  const request = structuredClone(value);
  if (!identifier(request.request_id, 128)) invalid('工作流请求编号不正确。');
  const keys = request.operation === 'save_node' ? ['operation', 'request_id', 'node', 'related_to', 'condition']
    : request.operation === 'save_edge' ? ['operation', 'request_id', 'edge'] : [];
  if (!keys.length || Object.keys(request).some(key => !keys.includes(key))) invalid('工作流操作或字段不正确。');
  const item = request.operation === 'save_node' ? request.node : request.edge;
  if (!item || typeof item !== 'object' || Array.isArray(item) || !Number.isSafeInteger((item as any).revision) || (item as any).revision < 0) invalid('请提供节点或边及非负整数 revision。');
  if (request.related_to !== undefined && !identifier(request.related_to)) invalid('关联来源节点标识不正确。');
  if (request.condition !== undefined && (typeof request.condition !== 'string' || request.condition.includes('\0'))) invalid('关联条件必须是文本。');
  return request as unknown as WorkflowEditInput;
}
export function findWorkflowReceipt(state: ProjectState, nodeId: string, input: WorkflowEditInput, context: McpCallContext): WorkflowEditReceipt | null {
  const receipts = state.workflowReceipts.filter(item => item.nodeId === nodeId);
  if (receipts.some(item => hasReceiptCall(item, context) && item.request.request_id !== input.request_id)) throw new WorkflowError('REQUEST_CONFLICT', '同一次原生调用不能更换请求编号。');
  const stored = receipts.find(item => item.request.request_id === input.request_id);
  if (!stored) return null;
  if (!isDeepStrictEqual(stored.request, input)) throw new WorkflowError('REQUEST_CONFLICT', '请求编号已经用于不同工作流变更。');
  return structuredClone(stored.receipt);
}
export function deliveryView(state: ProjectState, nodeId: string, args: { message_id?: string; request_id?: string }): object {
  if (Object.keys(args).some(key => !['message_id', 'request_id'].includes(key)) || (args.message_id !== undefined) === (args.request_id !== undefined)
    || (args.message_id !== undefined && !identifier(args.message_id, 128)) || (args.request_id !== undefined && !identifier(args.request_id, 128))) invalid('请提供 message_id 或 request_id，两者只能选一个。');
  const message = state.messages.find(message => args.message_id ? message.message_id === args.message_id : message.fromNodeId === nodeId && message.request.request_id === args.request_id);
  if (!message) throw new WorkflowError('TARGET_UNAVAILABLE', '找不到本项目中的消息。');
  return { receipt: messageReceipt(message), attempts: state.tasks.filter(task => task.incomingMessageId === message.message_id).map(task => ({
    task_id: task.id, status: task.status, attempt: task.attempt, threadId: task.threadId, turnId: task.turnId, error: task.error, retryOfTaskId: task.retryOfTaskId ?? null,
    outputs: state.conversation.filter(entry => entry.taskId === task.id && entry.direction === 'output').map(entry => ({ id: entry.id, itemId: entry.itemId })),
  })), replies: state.messages.filter(reply => reply.request.reply_to === message.message_id).map(messageSummary) };
}

export function projectContext(state: ProjectState, nodeId: string, task: StoredTask | null, attachments: HostAttachment[] = []): object {
  const nodeView = (node: ProjectState['nodes'][number]) => {
    const { threads, ...definition } = node;
    return { ...definition, resultSchema: {}, status: node.status ?? 'idle' };
  };
  const incoming = task?.incomingMessageId ? state.messages.find(message => message.message_id === task.incomingMessageId) : undefined;
  const source = task ? state.conversation.find(entry => entry.taskId === task.id && entry.direction === 'input')?.source ?? { kind: 'unknown' } : null;
  return structuredClone({
    project: state.project, self: nodeView(state.nodes.find(node => node.id === nodeId)!),
    task: task ? { id: task.id, nodeId: task.nodeId, instruction: task.instruction, input: task.input, attempt: task.attempt, source, attachments: incoming?.attachments ?? attachments } : null,
    nodes: state.nodes.map(nodeView), edges: state.edges,
    review_policy: state.reviewPolicy, review_dependencies: task?.reviewDependencies ?? reviewDependencies(state, nodeId),
    human_reviews: state.humanReviews.map(review => ({ id: review.id, checkpointId: review.checkpointId, checkpointRevision: review.checkpointRevision, version: review.version, title: review.title, status: review.status, bundleHash: review.bundleHash, nodeId: review.nodeId, supersededBy: review.supersededBy })),
    incoming_message: incoming ? { message_id: incoming.message_id, from: { nodeId: incoming.fromNodeId, name: incoming.fromName }, reply_to: incoming.request.reply_to ?? null, attachments: incoming.attachments } : null,
    remainingSteps: !task || task.nativeInput ? null : state.maxSteps - state.tasks.filter(item => item.runId === task.runId && item.threadId).length,
    collaboration_rules: [
      'Business todos, internal issues and Markdown documents are shared with the user. Use the available search_project_items/get_project_item/update_project_item tools; read current revisions before editing. Completion is an explicit business update with evidence, not a consequence of ending your Turn.',
      'Current work_context associates the business work and its resources. Edge messages inherit it unless explicitly replaced or cleared; replies inherit the original message context. Ordinary references are not scheduling dependencies. Use item_ids to freeze selected work items in a human-review submission.',
      'Each outgoing workflow edge generates an edge_ tool for this node. Choose a tool using its condition and description; its target is already bound. There is no arbitrary-target send tool.',
      'Natural language conditions are evaluated by the agent. Calling an edge tool saves and queues its content directly without a second routing decision.',
      'Sending a message does not end your Turn. Acceptance queues delivery and does not mean the recipient has started or succeeded.',
      'Replies are explicit and ordinary output is not broadcast. Each send has one target; there is no automatic join. Configured human-review dependencies must be approved before dispatch; acceptance does not bypass them.',
      'To wait for a reply, finish the current Turn normally. Incoming messages and replies use the node FIFO and open a new Turn in the original Thread; no blocking wait or pause is required.',
      'An incoming reply is not a new request to reply again. Normal completion finishes only the current execution, not acceptance of the project goal.',
      'Node capabilities describe configuration choices and do not guarantee plugin authentication or execution success.',
    ],
  });
}

const historyFilters = ['node_id', 'task_id', 'message_id', 'reply_to'] as const;
type HistoryFilters = Record<typeof historyFilters[number], string | null>;
interface HistoryCursor { version: 1; projectId: string; filters: HistoryFilters; upperSeq: number; position: Pick<ConversationEntry, 'createdAt' | 'seq' | 'id'>; }
function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
}
export function readConversationPage(state: ProjectState, query: HistoryQuery): HistoryPage {
  if (Object.keys(query).some(key => ![...historyFilters, 'limit', 'cursor'].includes(key))) invalid('历史查询包含不支持的字段。');
  for (const key of historyFilters) if (query[key] !== undefined && !identifier(query[key], key === 'node_id' ? 100 : 128)) invalid('历史过滤编号不正确。');
  const limit = query.limit === undefined ? 50 : query.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) invalid('limit 必须是 1–200 的整数。');
  const filters = Object.fromEntries(historyFilters.map(key => [key, query[key] ?? null])) as HistoryFilters;
  let upperSeq = state.conversation.reduce((maximum, entry) => Math.max(maximum, entry.seq), 0), cursor: HistoryCursor | undefined;
  if (query.cursor !== undefined) {
    try {
      if (typeof query.cursor !== 'string' || query.cursor.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(query.cursor)) invalid('历史游标格式不正确。');
      const parsed = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
      if (!exactKeys(parsed, ['version', 'projectId', 'filters', 'upperSeq', 'position']) || parsed.version !== 1 || parsed.projectId !== state.project.id
        || !exactKeys(parsed.filters, historyFilters) || !isDeepStrictEqual(parsed.filters, filters)
        || !Number.isSafeInteger(parsed.upperSeq) || (parsed.upperSeq as number) < 0 || (parsed.upperSeq as number) > upperSeq
        || !exactKeys(parsed.position, ['id', 'seq', 'createdAt']) || typeof parsed.position.id !== 'string' || !parsed.position.id || typeof parsed.position.createdAt !== 'string'
        || !Number.isSafeInteger(parsed.position.seq) || (parsed.position.seq as number) < 0 || (parsed.position.seq as number) > (parsed.upperSeq as number)) invalid('历史游标与项目、过滤条件或排序位置不匹配。');
      cursor = parsed as unknown as HistoryCursor; upperSeq = cursor.upperSeq;
    } catch { invalid('历史游标格式或查询条件不正确。'); }
  }
  const tasks = new Map(state.tasks.map(task => [task.id, task]));
  const messages = new Map(state.messages.map(message => [message.message_id, message]));
  const entries = orderedConversation(state.conversation.filter(entry => {
    const task = entry.taskId ? tasks.get(entry.taskId) : undefined;
    const messageId = entry.messageId ?? task?.incomingMessageId;
    const replyTo = entry.replyTo ?? (messageId ? messages.get(messageId)?.request.reply_to : null);
    return entry.seq <= upperSeq && (!filters.node_id || entry.nodeId === filters.node_id) && (!filters.task_id || entry.taskId === filters.task_id)
      && (!filters.message_id || messageId === filters.message_id) && (!filters.reply_to || replyTo === filters.reply_to)
      && (!cursor || compareConversation(entry, cursor.position) > 0);
  }));
  const page = entries.slice(0, limit), last = page.at(-1);
  return { entries: structuredClone(page), next_cursor: entries.length > limit && last ? Buffer.from(JSON.stringify({ version: 1, projectId: state.project.id, filters, upperSeq,
    position: { id: last.id, seq: last.seq, createdAt: last.createdAt } } satisfies HistoryCursor)).toString('base64url') : null };
}
