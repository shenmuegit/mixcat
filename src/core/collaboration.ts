import { isDeepStrictEqual } from 'node:util';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { McpCallContext, MessageReceipt, MessageSummary, SendMessageInput, WorkflowErrorCode } from '../shared/types.js';
import type { ProjectState, StoredMessage } from './model.js';

export class WorkflowError extends Error {
  constructor(readonly code: WorkflowErrorCode, message: string) { super(message); }
}
function invalid(message: string): never { throw new McpError(ErrorCode.InvalidParams, message); }
function identifier(value: unknown, limit = 100): value is string { return typeof value === 'string' && value.length <= limit && /^[a-zA-Z0-9_-]+$/.test(value); }
export function parseMessageInput(value: Record<string, unknown>): SendMessageInput {
  const request = structuredClone(value);
  if (Object.keys(request).some(key => !['request_id', 'to_node_id', 'content', 'reason', 'attachments', 'reply_to', 'route'].includes(key))) invalid('消息包含不支持的信封字段。');
  if (!identifier(request.request_id, 128) || !identifier(request.to_node_id)) invalid('请求编号或目标节点标识不正确。');
  if (typeof request.reason !== 'string' || !request.reason.trim() || request.reason.length > 4000 || request.reason.includes('\0')) invalid('发送理由不能为空，且不能超过 4000 个字符。');
  try { if (!Object.hasOwn(request, 'content') || !isDeepStrictEqual(request.content, JSON.parse(JSON.stringify(request.content)))) invalid('content 必须是 JSON 值。'); }
  catch { invalid('content 必须是 JSON 值。'); }
  const attachments = request.attachments === undefined ? [] : request.attachments;
  if (!Array.isArray(attachments) || attachments.some(item => !item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== 1 || !['path', 'artifact_id'].some(key => typeof item[key] === 'string' && item[key].trim()))) invalid('附件必须只包含 path 或 artifact_id。');
  const reply = request.reply_to ?? null, route = request.route ?? null;
  if (reply !== null && !identifier(reply, 128)) invalid('reply_to 必须是消息编号。');
  if (route !== null && (typeof route !== 'object' || Array.isArray(route) || Object.keys(route).length !== 2 || !identifier((route as any).edge_id) || !Number.isInteger((route as any).edge_revision) || (route as any).edge_revision < 1)) invalid('route 必须包含边编号和正整数版本。');
  return { request_id: request.request_id, to_node_id: request.to_node_id, content: request.content, reason: request.reason, attachments, reply_to: reply, route: route as SendMessageInput['route'] };
}
export function messageReceipt(message: StoredMessage): MessageReceipt {
  return { accepted: true, message_id: message.message_id, target_task_id: message.target_task_id, accepted_at: message.accepted_at };
}
export function messageSummary(message: StoredMessage): MessageSummary {
  return { message_id: message.message_id, target_task_id: message.target_task_id, accepted_at: message.accepted_at, sourceTaskId: message.sourceTaskId,
    fromNodeId: message.fromNodeId, fromName: message.fromName, toNodeId: message.toNodeId, toName: message.toName, replyTo: message.request.reply_to ?? null };
}
export function findMessageReceipt(state: ProjectState, nodeId: string, input: SendMessageInput, context: McpCallContext): MessageReceipt | null {
  const messages = state.messages.filter(message => message.fromNodeId === nodeId);
  if (messages.some(message => message.threadId === context.threadId && message.turnId === context.turnId && message.callId === context.callId && message.request.request_id !== input.request_id)) throw new WorkflowError('REQUEST_CONFLICT', '同一次原生调用不能更换请求编号。');
  const message = messages.find(message => message.request.request_id === input.request_id);
  if (!message) return null;
  if (!isDeepStrictEqual(message.request, input)) throw new WorkflowError('REQUEST_CONFLICT', '请求编号已经用于不同消息。');
  return messageReceipt(message);
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
