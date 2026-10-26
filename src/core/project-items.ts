import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ProjectState } from './model.js';
import { emptyManagement, itemNumber, referencesIn, type ItemActor, type ItemBacklink, type ItemDetail, type ItemMutation, type ItemPage, type ItemQuery, type ProjectItem } from '../shared/project-items.js';

function text(value: unknown, name: string, max = 131072): string {
  if (typeof value !== 'string' || value.includes('\0') || value.length > max) throw new Error(`${name}格式或长度不正确。`);
  return value;
}
function descendants(items: ProjectItem[], id: string): ProjectItem[] {
  const result: ProjectItem[] = [], seen = new Set([id]);
  for (const parent of seen) for (const item of items) if (item.parentId === parent) {
    if (seen.has(item.id)) throw new Error('待办存在循环父子关系。');
    seen.add(item.id); result.push(item);
  }
  return result;
}
function ancestors(items: ProjectItem[], item: ProjectItem): ProjectItem[] {
  const result: ProjectItem[] = [], seen = new Set([item.id]);
  while (item.parentId) {
    if (seen.has(item.parentId)) throw new Error('待办不能移入自身或后代，父子关系不能循环。');
    seen.add(item.parentId);
    const parent = items.find(candidate => candidate.id === item.parentId && candidate.kind === 'todo');
    if (!parent) throw new Error('父待办不存在。');
    result.push(parent); item = parent;
  }
  return result;
}
export function queryProjectItems(state: ProjectState, query: ItemQuery = {}): ItemPage {
  if (!query || typeof query !== 'object' || Array.isArray(query) || Object.keys(query).some(key => !['text', 'kind', 'status', 'ownerId', 'archived', 'cursor', 'limit'].includes(key))) throw new Error('查询参数不正确。');
  const limit = query.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200 || query.kind !== undefined && !['todo', 'issue', 'document'].includes(query.kind)
    || query.archived !== undefined && typeof query.archived !== 'boolean' || query.cursor !== undefined && (typeof query.cursor !== 'string' || !/^\d+$/.test(query.cursor) || !Number.isSafeInteger(Number(query.cursor)))
    || query.status !== undefined && !['todo', 'doing', 'blocked', 'done', 'open', 'closed', 'active'].includes(query.status)
    || query.ownerId !== undefined && typeof query.ownerId !== 'string') throw new Error('查询范围不正确。');
  const search = text(query.text ?? '', '关键词', 200).trim().toLowerCase(), data = state.management ?? emptyManagement();
  const items = data.items.filter(item => (!query.kind || item.kind === query.kind) && (!query.status || item.status === query.status)
    && (query.ownerId === undefined || item.ownerId === query.ownerId) && item.archived === (query.archived ?? false)
    && (!search || `${itemNumber(item)} ${item.title} ${item.body} ${item.acceptance} ${item.comments.map(comment => comment.body).join(' ')}`.toLowerCase().includes(search))).sort((a, b) => a.position - b.position || a.number - b.number);
  const offset = Number(query.cursor ?? 0);
  return { items: items.slice(offset, offset + limit).map(({ body, acceptance, comments, ...item }) => ({ ...item, excerpt: body.slice(0, 180) })), total: items.length,
    nextCursor: offset + limit < items.length ? String(offset + limit) : null, revision: data.revision };
}
export function readProjectItem(state: ProjectState, id: string): ItemDetail {
  const item = state.management?.items.find(item => item.id === id);
  if (!item) throw new Error('找不到本项目中的工作项。');
  const backlinks: ItemBacklink[] = [];
  for (const source of state.management?.items ?? []) {
    const hasTarget = (body: string) => referencesIn(body, state.project.id).some(reference => reference.id === id && reference.kind === item.kind);
    if (hasTarget(`${source.body}\n\n${source.acceptance}`)) backlinks.push({ itemId: source.id, title: source.title, kind: source.kind });
    for (const comment of source.comments) if (hasTarget(comment.body)) backlinks.push({ itemId: source.id, title: source.title, kind: source.kind, commentId: comment.id });
  }
  return { item: structuredClone(item), hash: null, error: null, references: referencesIn([item.body, item.acceptance, ...item.comments.map(comment => comment.body)].join('\n\n'), state.project.id), backlinks,
    events: (state.management?.events ?? []).filter(event => event.itemId === id), taskIds: [] };
}
export function applyItemMutation(state: ProjectState, input: ItemMutation, actor: ItemActor) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.request_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.request_id)) throw new Error('管理请求编号不正确。');
  const key = `${actor.kind}:${actor.nodeId ?? ''}:${input.request_id}`, management = structuredClone(state.management ?? emptyManagement());
  const replay = management.receipts.find(receipt => receipt.key === key);
  if (replay) {
    if (!isDeepStrictEqual(replay.input, input)) throw new Error('请求编号已用于不同内容，发生冲突。');
    return { management, receipt: replay.receipt, replay: true };
  }
  const fields: Record<string, string[]> = {
    create: ['kind', 'title', 'body', 'acceptance', 'issueType', 'parentId', 'priority', 'ownerId'],
    edit: ['title', 'body', 'acceptance', 'issueType', 'priority', 'ownerId', 'status'],
    move: ['parentId', 'beforeId'], archive: [], restore: [], reopen: [], comment: ['body'],
  };
  if (!Object.hasOwn(fields, input.operation) || Object.keys(input).some(key => !['request_id', 'operation', 'id', 'expected_revision', 'reason', ...fields[input.operation]].includes(key))) throw new Error('不支持的管理操作或字段。');
  const reason = text(input.reason ?? '', '变更说明', 4000).trim();
  const before = new Map(management.items.map(item => [item.id, structuredClone(item)]));
  const at = new Date().toISOString();
  let item: ProjectItem;
  if (input.operation === 'create') {
    if (!['todo', 'issue'].includes(input.kind ?? '') || input.id !== undefined || input.expected_revision !== undefined) throw new Error('新工作项类型或标识不正确。');
    item = { id: randomUUID(), kind: input.kind!, number: Math.max(0, ...management.items.filter(item => item.kind === input.kind).map(item => item.number)) + 1,
      title: '', body: '', acceptance: '', status: input.kind === 'todo' ? 'todo' : 'open', priority: 'normal', ownerId: null,
      parentId: input.parentId ?? null, position: management.items.filter(other => other.parentId === (input.parentId ?? null)).length,
      issueType: 'bug', path: null, archived: false, revision: 0, createdAt: at, updatedAt: at, comments: [] };
    management.items.push(item);
  } else {
    const found = management.items.find(item => item.id === input.id);
    if (!found) throw new Error('找不到本项目中的工作项。');
    item = found;
    if (!Number.isSafeInteger(input.expected_revision) || input.expected_revision !== item.revision) throw new Error('工作项已更新，版本冲突；请重新读取后保存。');
    if (item.archived && input.operation !== 'restore') throw new Error('请先恢复已归档的工作项。');
  }
  if (input.operation === 'create' || input.operation === 'edit') {
    for (const key of ['title', 'body', 'acceptance'] as const) if (input[key] !== undefined) item[key] = text(input[key], key === 'title' ? '标题' : '正文', key === 'title' ? 200 : 131072);
    item.title = item.title.trim(); if (!item.title) throw new Error('标题不能为空。');
    if (input.priority !== undefined) { if (!['low', 'normal', 'high'].includes(input.priority)) throw new Error('优先级不正确。'); item.priority = input.priority; }
    if (input.ownerId !== undefined) {
      if (input.ownerId !== null && input.ownerId !== 'user' && !state.nodes.some(node => node.id === input.ownerId)) throw new Error('负责人必须是当前用户或本项目节点。');
      item.ownerId = input.ownerId;
    }
    if (input.issueType !== undefined) { if (item.kind !== 'issue' || !['bug', 'enhancement'].includes(input.issueType)) throw new Error('Issue 类型不正确。'); item.issueType = input.issueType; }
    if (input.status !== undefined) {
      const allowed = item.kind === 'todo' ? ['todo', 'doing', 'blocked', 'done'] : ['open', 'doing', 'closed'];
      if (!allowed.includes(input.status)) throw new Error('工作项状态不正确。');
      if (['done', 'closed'].includes(input.status) && input.status !== item.status && !reason) throw new Error('完成或关闭需要填写处理说明。');
      item.status = input.status;
    }
  } else if (input.operation === 'move') {
    if (item.kind !== 'todo' || input.parentId !== null && typeof input.parentId !== 'string') throw new Error('请选择有效父待办或移至根级。');
    item.parentId = input.parentId;
    const siblings = management.items.filter(other => other.id !== item.id && !other.archived && other.kind === 'todo' && other.parentId === item.parentId).sort((a, b) => a.position - b.position);
    const index = input.beforeId ? siblings.findIndex(other => other.id === input.beforeId) : siblings.length;
    if (index < 0) throw new Error('排序目标必须是同级有效待办。');
    siblings.splice(index, 0, item); siblings.forEach((sibling, index) => { sibling.position = index; });
  } else if (input.operation === 'comment') {
    if (item.kind !== 'issue') throw new Error('评论属于 Issue。');
    const body = text(input.body, '评论').trim(); if (!body) throw new Error('评论不能为空。');
    item.comments.push({ id: randomUUID(), body, author: structuredClone(actor), createdAt: at });
  } else if (input.operation === 'reopen') {
    if (!reason) throw new Error('重开需要填写说明。');
    item.status = item.kind === 'todo' ? 'todo' : 'open';
    for (const parent of ancestors(management.items, item)) if (parent.status === 'done') parent.status = 'todo';
  } else {
    const branch = [item, ...(item.kind === 'todo' ? descendants(management.items, item.id) : [])];
    for (const member of branch) member.archived = input.operation === 'archive';
    if (input.operation === 'restore') for (const parent of ancestors(management.items, item)) parent.archived = false;
  }
  if (item.parentId !== null && item.kind !== 'todo') throw new Error('只有 Todo 支持父子结构。');
  for (const candidate of management.items.filter(candidate => candidate.kind === 'todo' && !candidate.archived)) {
    const parents = ancestors(management.items, candidate);
    if (parents.some(parent => parent.archived)) throw new Error('父待办已归档，请先恢复。');
    if (candidate.status !== 'done' && parents.some(parent => parent.status === 'done')) {
      if (input.status === 'done') throw new Error('仍有未完成子项，不能完成父待办。');
      throw new Error('请先重开已完成的父待办，再增加或恢复未完成工作。');
    }
  }
  for (const changed of management.items) {
    const previous = before.get(changed.id) ?? null;
    if (!isDeepStrictEqual(previous, changed)) {
      changed.revision++; changed.updatedAt = at;
      management.events.push({ id: randomUUID(), itemId: changed.id, operation: input.operation, actor: structuredClone(actor), at, before: previous, after: structuredClone(changed), reason });
    }
  }
  management.revision++;
  const receipt = { accepted: true as const, requestId: input.request_id, itemId: item.id, revision: item.revision };
  management.receipts.push({ key, input: structuredClone(input), receipt });
  return { management, receipt, replay: false };
}
