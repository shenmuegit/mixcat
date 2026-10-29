import type { ComfyActor, ComfyObservation, ComfyRequest, GraphView } from './comfy.js';

export const COMFY_GRAPH_MAX_BYTES = 8 * 1024 * 1024;
export interface NativeQueueOptions { number: number; batchCount: number; options: { queueNodeIds?: string[]; intent?: { trigger_source?: string; subscribe_to_run?: boolean } }; }
export interface ComfyPromptPayload {
  client_id: string; prompt: Record<string, unknown>; prompt_id?: string; number?: number; front?: boolean;
  partial_execution_targets?: string[];
  extra_data: { comfy_usage_source: 'comfyui-frontend'; extra_pnginfo: { workflow: Record<string, unknown> }; preview_method?: string };
}
export interface ComfyPromptResponse { status: number; body: Record<string, unknown>; }
export type NativeQueueRequest = { type: 'native_queue'; requestId: string; expected: ComfyObservation; sessionId: string; expiresAt: number; queue: NativeQueueOptions };
export type ComfyBridgeRequest = ComfyRequest | NativeQueueRequest | { type: 'close_project' };
export interface ComfyRpcMessage { type: 'comfy_request'; id: string; generation: string; projectId: string; expiresAt: number; request: ComfyBridgeRequest; actor: ComfyActor; }
export function boundedComfy(value: unknown): void {
  const body = JSON.stringify(value);
  if (!body || new TextEncoder().encode(body).byteLength > COMFY_GRAPH_MAX_BYTES) throw new Error('Comfy 消息大小超过 8 MiB 或格式不正确。');
}
export function comfyObject(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Comfy 消息格式不正确。');
}
export function comfyText(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 1000 || value.includes('\0')) throw new Error('Comfy 标识格式不正确。');
}
export function validateObservation(value: unknown): asserts value is ComfyObservation {
  comfyObject(value);
  for (const key of ['projectId', 'instanceId', 'workflowId', 'tabId', 'revision']) comfyText(value[key]);
}
export function validateGraph(value: unknown, projectId: string, instanceId?: string): asserts value is GraphView {
  boundedComfy(value); comfyObject(value); comfyObject(value.workflow); validateObservation(value.observation);
  if (value.observation.projectId !== projectId || instanceId !== undefined && value.observation.instanceId !== instanceId) throw new Error('Comfy 画布身份冲突。');
  for (const key of ['subgraphPath', 'selectedNodeIds']) { if (!Array.isArray(value[key])) throw new Error('Comfy 上下文格式不正确。'); value[key].forEach(comfyText); }
}
export function validateComfyRequest(value: unknown): asserts value is ComfyBridgeRequest {
  boundedComfy(value); comfyObject(value);
  switch (value.type) {
    case 'read_graph': case 'summary': case 'close_project': return;
    case 'apply_graph': comfyObject(value.workflow); break;
    case 'restore_graph': comfyText(value.versionId); break;
    case 'queue_graph': break;
    case 'native_queue': comfyText(value.sessionId); validateDeadline(value.expiresAt); validateNativeQueue(value.queue); break;
    case 'inspect_nodes': if (!Array.isArray(value.nodeTypes)) throw new Error('Comfy 节点类型格式不正确。'); value.nodeTypes.forEach(comfyText); return;
    case 'read_run': comfyText(value.runId); return;
    case 'stop_run': comfyText(value.runId); if (!['stop_waiting', 'cancel_remote'].includes(value.action as string)) throw new Error('Comfy 停止操作不正确。'); return;
    default: throw new Error('Comfy 操作不受支持。');
  }
  comfyText(value.requestId); validateObservation(value.expected);
}
export function validateNativeQueue(value: unknown): asserts value is NativeQueueOptions {
  boundedComfy(value); comfyObject(value);
  if (typeof value.number !== 'number' || !Number.isFinite(value.number) || !Number.isSafeInteger(value.batchCount) || Number(value.batchCount) < 1) throw new Error('Comfy 原生队列参数不正确。');
  comfyObject(value.options);
  if (Object.keys(value.options).some(key => !['queueNodeIds', 'intent'].includes(key))) throw new Error('Comfy 原生队列选项不受支持。');
  if (value.options.queueNodeIds !== undefined) { if (!Array.isArray(value.options.queueNodeIds)) throw new Error('Comfy 部分执行目标不正确。'); value.options.queueNodeIds.forEach(comfyText); }
  if (value.options.intent !== undefined) { comfyObject(value.options.intent); if (Object.keys(value.options.intent).some(key => !['trigger_source', 'subscribe_to_run'].includes(key)) || value.options.intent.subscribe_to_run !== undefined && typeof value.options.intent.subscribe_to_run !== 'boolean') throw new Error('Comfy 队列意图不正确。'); if (value.options.intent.trigger_source !== undefined) comfyText(value.options.intent.trigger_source); }
}
export function validateDeadline(value: unknown): asserts value is number { if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error('Comfy 请求期限不正确。'); }
export function validatePrompt(value: unknown): asserts value is ComfyPromptPayload {
  boundedComfy(value); comfyObject(value); comfyObject(value.prompt); comfyObject(value.extra_data); comfyObject(value.extra_data.extra_pnginfo); comfyObject(value.extra_data.extra_pnginfo.workflow);
  if (Object.keys(value).some(key => !['client_id', 'prompt', 'prompt_id', 'number', 'front', 'partial_execution_targets', 'extra_data'].includes(key))
    || Object.keys(value.extra_data).some(key => !['comfy_usage_source', 'extra_pnginfo', 'preview_method'].includes(key))
    || Object.keys(value.extra_data.extra_pnginfo).some(key => key !== 'workflow') || value.extra_data.comfy_usage_source !== 'comfyui-frontend'
    || typeof value.client_id !== 'string' || value.client_id.length > 1000
    || value.number !== undefined && (typeof value.number !== 'number' || !Number.isFinite(value.number))
    || value.front !== undefined && typeof value.front !== 'boolean') throw new Error('Comfy 提交数据不正确。');
  if (value.prompt_id !== undefined && (typeof value.prompt_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.prompt_id))) throw new Error('Comfy prompt_id 不正确。');
  if (value.partial_execution_targets !== undefined) { if (!Array.isArray(value.partial_execution_targets)) throw new Error('Comfy 部分执行目标不正确。'); value.partial_execution_targets.forEach(comfyText); }
  if (value.extra_data.preview_method !== undefined) comfyText(value.extra_data.preview_method);
}
export function validateRpcRequest(value: unknown): asserts value is ComfyRpcMessage {
  boundedComfy(value); comfyObject(value);
  if (value.type !== 'comfy_request') throw new Error('Comfy 消息类型不正确。');
  comfyText(value.id); comfyText(value.generation); comfyText(value.projectId); validateDeadline(value.expiresAt); validateComfyRequest(value.request); comfyObject(value.actor);
  if (value.actor.kind === 'codex') for (const key of ['nodeId', 'threadId', 'turnId', 'callId']) comfyText(value.actor[key]);
  else if (value.actor.kind !== 'user') throw new Error('Comfy 调用者格式不正确。');
}
export function sameObservation(a: ComfyObservation, b: ComfyObservation): boolean {
  return (['projectId', 'instanceId', 'workflowId', 'tabId', 'revision'] as const).every(key => a[key] === b[key]);
}
