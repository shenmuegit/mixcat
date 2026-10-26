import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { HumanReviewPolicy, RequestReviewInput, ReviewCheckpoint, ReviewReceipt } from '../shared/types.js';
import type { ProjectState, StoredHumanReview, StoredNativeCall } from './model.js';
import { hasReceiptCall, WorkflowError } from './collaboration.js';
import { reviewDependencies, reviewGate } from '../shared/review-gate.js';
export { reviewDependencies, reviewGate } from '../shared/review-gate.js';

function invalid(message: string): never { throw new McpError(ErrorCode.InvalidParams, message); }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function identifier(value: unknown, limit = 100): value is string { return typeof value === 'string' && value.length <= limit && /^[a-zA-Z0-9_-]+$/.test(value); }
function revision(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function identifiers(value: unknown): value is string[] { return Array.isArray(value) && value.every(item => identifier(item)) && new Set(value).size === value.length; }

export function parseReviewSubmission(value: unknown): RequestReviewInput {
  if (!object(value) || Object.keys(value).some(key => !['request_id', 'checkpoint_id', 'title', 'content', 'attachments', 'item_ids'].includes(key))) invalid('核对提交包含不支持的信封字段。');
  if (!identifier(value.request_id, 128) || !identifier(value.checkpoint_id)) invalid('核对请求编号或核对点标识不正确。');
  if (typeof value.title !== 'string' || !value.title.trim() || value.title.length > 80 || value.title.includes('\0')) invalid('核对标题不能为空，且不能超过 80 个字符。');
  try {
    if (!Object.hasOwn(value, 'content') || !isDeepStrictEqual(value.content, JSON.parse(JSON.stringify(value.content)))) invalid('content 必须是 JSON 值。');
  } catch { invalid('content 必须是 JSON 值。'); }
  const attachments = value.attachments === undefined ? [] : value.attachments;
  if (!Array.isArray(attachments) || attachments.some(item => !object(item) || Object.keys(item).length !== 1 || !['path', 'artifact_id'].some(key => typeof item[key] === 'string' && item[key].trim()))) invalid('附件必须只包含 path 或 artifact_id。');
  if (value.item_ids !== undefined && (!identifiers(value.item_ids) || value.item_ids.length > 50)) invalid('核对工作项编号不正确或超过 50 项。');
  return structuredClone({ request_id: value.request_id, checkpoint_id: value.checkpoint_id, title: value.title, content: value.content, attachments, ...(value.item_ids !== undefined ? { item_ids: value.item_ids as string[] } : {}) });
}

export function validateReviewPolicy(value: unknown, state: ProjectState): HumanReviewPolicy {
  if (!object(value) || Object.keys(value).some(key => !['revision', 'checkpoints'].includes(key)) || !revision(value.revision) || !Array.isArray(value.checkpoints)) invalid('请提供核对策略、checkpoints 和非负整数 revision。');
  if (value.revision !== state.reviewPolicy.revision) throw new WorkflowError('REVISION_CONFLICT', '核对规则已经变更，请刷新后再保存。');
  const nodes = new Set(state.nodes.map(node => node.id)), ids = new Set<string>();
  const checkpoints = value.checkpoints.map((point: unknown): ReviewCheckpoint => {
    if (!object(point) || Object.keys(point).some(key => !['id', 'name', 'ownerNodeId', 'requiredForNodeIds', 'dependsOn', 'revision'].includes(key))
      || !identifier(point.id) || typeof point.name !== 'string' || !point.name.trim() || point.name.length > 80 || point.name.includes('\0')
      || !identifier(point.ownerNodeId) || !nodes.has(point.ownerNodeId) || !identifiers(point.requiredForNodeIds) || point.requiredForNodeIds.some(id => !nodes.has(id))
      || !identifiers(point.dependsOn) || !revision(point.revision) || ids.has(point.id)) invalid('核对点、节点引用、唯一标识或修订号不正确。');
    ids.add(point.id);
    const stored = state.reviewPolicy.checkpoints.find(item => item.id === point.id);
    if (!stored && (state.humanReviews.some(item => item.checkpointId === point.id) || state.tasks.some(task => task.reviewDependencies?.some(item => item.checkpointId === point.id)))) throw new WorkflowError('REVISION_CONFLICT', '该核对点标识已删除但仍有历史引用，请使用新标识。');
    if (point.revision !== (stored?.revision ?? 1)) throw new WorkflowError('REVISION_CONFLICT', '核对点已经变更，请刷新后再保存。');
    const next = structuredClone(point) as unknown as ReviewCheckpoint;
    if (stored && !isDeepStrictEqual(stored, next)) next.revision++;
    return next;
  });
  for (const point of checkpoints) if (point.dependsOn.some(id => !ids.has(id))) invalid('核对点依赖不存在。');
  const visiting = new Set<string>(), visited = new Set<string>();
  function visit(point: ReviewCheckpoint) {
    if (visiting.has(point.id)) invalid('核对依赖不能循环或阻断其提交责任节点。');
    if (visited.has(point.id)) return;
    visiting.add(point.id);
    const prerequisites = checkpoints.filter(other => point.dependsOn.includes(other.id) || other.requiredForNodeIds.includes(point.ownerNodeId));
    for (const prerequisite of prerequisites) visit(prerequisite);
    visiting.delete(point.id); visited.add(point.id);
  }
  for (const point of checkpoints) visit(point);
  return { revision: value.revision + 1, checkpoints };
}

export function hashReviewBundle(bundle: string): string { return createHash('sha256').update(bundle).digest('hex'); }
export function reviewReceipt(item: StoredHumanReview): ReviewReceipt {
  return { accepted: true, review_id: item.id, checkpoint_id: item.checkpointId, version: item.version, accepted_at: item.createdAt };
}
export function findReviewReceipt(state: ProjectState, nodeId: string, input: RequestReviewInput, context: StoredNativeCall): ReviewReceipt | null {
  const reviews = state.humanReviews.filter(item => item.nodeId === nodeId);
  if (reviews.some(item => hasReceiptCall(item, context) && item.request.request_id !== input.request_id)) throw new WorkflowError('REQUEST_CONFLICT', '同一次原生调用不能更换核对请求编号。');
  const stored = reviews.find(item => item.request.request_id === input.request_id);
  if (!stored) return null;
  if (!isDeepStrictEqual(stored.request, input)) throw new WorkflowError('REQUEST_CONFLICT', '请求编号已经用于不同核对提交。');
  return reviewReceipt(stored);
}

export function reconcileReviewTasks(state: ProjectState): void {
  for (const task of state.tasks) {
    if (!['queued', 'waiting_review'].includes(task.status) || task.turnId || task.previousTurnIds?.length) continue;
    const current = reviewDependencies(state, task.nodeId), dependencies = task.reviewDependencies ?? [];
    for (const dependency of current) if (!dependencies.some(item => item.checkpointId === dependency.checkpointId)) dependencies.push(dependency);
    for (const dependency of dependencies) {
      if (dependency.reviewId !== null || dependency.version !== null) continue;
      const point = state.reviewPolicy.checkpoints.find(item => item.id === dependency.checkpointId);
      if (point?.revision !== dependency.checkpointRevision) continue;
      const first = state.humanReviews.filter(item => item.checkpointId === dependency.checkpointId && item.checkpointRevision === dependency.checkpointRevision).sort((a, b) => a.version - b.version)[0];
      if (first) { dependency.reviewId = first.id; dependency.version = first.version; }
    }
    task.reviewDependencies = dependencies;
    task.status = reviewGate(state, dependencies).state === 'ready' ? 'queued' : 'waiting_review';
  }
}
