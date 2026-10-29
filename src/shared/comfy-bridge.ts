import type { ComfyActor, ComfyObservation, ComfyRequest, GraphView } from './comfy.js';

export const COMFY_GRAPH_MAX_BYTES = 8 * 1024 * 1024;
export type ComfyBridgeRequest = ComfyRequest | { type: 'close_project' };
export interface ComfyRpcMessage { type: 'comfy_request'; id: string; generation: string; projectId: string; request: ComfyBridgeRequest; actor: ComfyActor; }
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
    case 'inspect_nodes': if (!Array.isArray(value.nodeTypes)) throw new Error('Comfy 节点类型格式不正确。'); value.nodeTypes.forEach(comfyText); return;
    case 'read_run': comfyText(value.runId); return;
    case 'stop_run': comfyText(value.runId); if (!['stop_waiting', 'cancel_remote'].includes(value.action as string)) throw new Error('Comfy 停止操作不正确。'); return;
    default: throw new Error('Comfy 操作不受支持。');
  }
  comfyText(value.requestId); validateObservation(value.expected);
}
export function validateRpcRequest(value: unknown): asserts value is ComfyRpcMessage {
  boundedComfy(value); comfyObject(value);
  if (value.type !== 'comfy_request') throw new Error('Comfy 消息类型不正确。');
  comfyText(value.id); comfyText(value.generation); comfyText(value.projectId); validateComfyRequest(value.request); comfyObject(value.actor);
  if (value.actor.kind === 'codex') for (const key of ['nodeId', 'threadId', 'turnId', 'callId']) comfyText(value.actor[key]);
  else if (value.actor.kind !== 'user') throw new Error('Comfy 调用者格式不正确。');
}
export function sameObservation(a: ComfyObservation, b: ComfyObservation): boolean {
  return (['projectId', 'instanceId', 'workflowId', 'tabId', 'revision'] as const).every(key => a[key] === b[key]);
}
