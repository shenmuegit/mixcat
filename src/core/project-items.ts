import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import type { ProjectState } from './model.js';
import { emptyManagement, itemNumber, referencesIn, type ItemActor, type ItemBacklink, type ItemDetail, type ItemMutation, type ItemPage, type ItemQuery, type ProjectItem } from '../shared/project-items.js';
import { documentHash, documentPath, documentRecovery, documentTrashPath, readDocument, readTrashedDocument, type DocumentChange } from './project-documents.js';
import { itemMaterialContent, parseWorkContext, type ItemMaterial, type StoredWorkContext } from '../shared/project-items.js';
import { scanProjectDocuments } from './document-discovery.js';

function documentView(state: ProjectState, item: ProjectItem): Pick<ItemDetail, 'item' | 'hash' | 'error' | 'fileModifiedAt'> {
  if (item.kind !== 'document') return { item: structuredClone(item), hash: null, error: null };
  try { const file = item.deletedAt ? readTrashedDocument(state.project.root, item.id) : readDocument(state.project.root, item.path!); return { item: { ...structuredClone(item), body: file.body }, hash: file.hash, error: null, fileModifiedAt: file.modifiedAt }; }
  catch (error) { return { item: structuredClone(item), hash: null, error: error instanceof Error ? error.message : String(error) }; }
}
export function captureWorkContext(state: ProjectState, value: unknown, inherited = false): StoredWorkContext {
  const context = parseWorkContext(value), refs = [...context.references];
  if (context.primary_todo_id && !refs.some(ref => ref.kind === 'todo' && ref.id === context.primary_todo_id)) refs.unshift({ projectId: state.project.id, kind: 'todo', id: context.primary_todo_id });
  const observed = refs.map(reference => {
    const item = state.management?.items.find(item => reference.projectId === state.project.id && item.id === reference.id && item.kind === reference.kind);
    if (!item) throw new Error('工作关联必须指向本项目中存在的对象。');
    if (item.deletedAt && !inherited) throw new Error('已删除的文档不能作为新的工作关联。');
    const view = documentView(state, item);
    return { ...reference, title: item.title, revision: item.revision, ...(view.hash && !item.deletedAt ? { hash: view.hash } : {}) };
  });
  return { ...context, observed };
}
export function captureItemMaterials(state: ProjectState, ids: string[], commentIds: string[] = []): ItemMaterial[] {
  const materials = ids.map(id => {
    const item = state.management?.items.find(item => item.id === id);
    if (!item || item.deletedAt) throw new Error('核对工作项不属于当前项目、不存在或已删除。');
    const view = documentView(state, item); if (view.error) throw new Error(view.error);
    return { id, kind: item.kind, title: item.title, revision: item.revision, body: view.item.body, acceptance: item.acceptance, issueType: item.issueType, hash: documentHash(itemMaterialContent(view.item)) };
  });
  return [...materials, ...commentIds.map(commentId => {
    const item = state.management?.items.find(item => item.comments.some(comment => comment.id === commentId));
    if (!item) throw new Error('核对评论不属于当前项目或不存在。');
    const comment = item.comments.find(comment => comment.id === commentId)!;
    return { id: item.id, kind: item.kind, title: item.title, revision: item.revision, body: comment.body, acceptance: '', issueType: item.issueType,
      commentId, author: structuredClone(comment.author), createdAt: comment.createdAt, hash: documentHash(JSON.stringify([item.id, comment])) };
  })];
}
export function assertItemMaterials(state: ProjectState, materials: ItemMaterial[]) {
  for (const material of materials) {
    const current = captureItemMaterials(state, material.commentId ? [] : [material.id], material.commentId ? [material.commentId] : [])[0];
    if (current.hash !== material.hash) throw new Error(`工作项「${material.title}」的核对材料已变化，请提交新版本。`);
  }
}
function eventItem({ comments, ...item }: Omit<ProjectItem, 'comments'> & { comments?: ProjectItem['comments'] }) { return structuredClone(item); }
export function observeDocumentChanges(state: ProjectState) {
  if (documentRecovery(state.project.root)) return null;
  const original = state.management ?? emptyManagement(), scan = scanProjectDocuments(state.project.root), at = new Date().toISOString();
  let management = structuredClone(original);
  const missing = management.items.filter(item => {
    if (item.kind !== 'document' || item.deletedAt || !item.path) return false;
    try { return !existsSync(documentPath(state.project.root, item.path).absolute); } catch { return false; }
  }).map(item => {
    const last = management.events.findLast(event => event.itemId === item.id && (event.after.fileHash || event.before?.fileHash));
    return { item, hash: item.fileHash ?? last?.after.fileHash ?? last?.before?.fileHash };
  });
  for (const path of scan.paths) {
    if (management.items.some(item => item.kind === 'document' && !item.deletedAt && item.path?.toLowerCase() === path.toLowerCase())) continue;
    try {
      const file = readDocument(state.project.root, path), previous = missing.find(candidate => candidate.hash === file.hash);
      if (previous) { if (scan.warnings.length < 100) scan.warnings.push(`${path}：内容与缺失文档「${previous.item.title}」相同，请打开原文档重新关联；若它是独立资料，可显式注册。`); continue; }
      management = applyItemMutation({ ...state, management }, { request_id: `discover-${randomUUID()}`, operation: 'register', path, title: basename(path).replace(/\.(md|markdown)$/i, '') }, { kind: 'external' }).management;
    } catch (error) { if (scan.warnings.length < 100) scan.warnings.push(`${path}：${error instanceof Error ? error.message : String(error)}`); }
  }
  let changed = false;
  for (const item of management.items.filter(item => item.kind === 'document' && !item.deletedAt)) {
    const view = documentView(state, item), hash = view.hash ?? undefined;
    if (item.fileHash === hash) continue;
    const before = structuredClone(item); item.fileHash = hash; item.revision++; item.updatedAt = at; changed = true;
    management.events.push({ id: randomUUID(), itemId: item.id, operation: 'external_edit', actor: { kind: 'external' }, at, before: eventItem(before), after: eventItem(item), reason: view.error ?? '检测到外部文件修改' });
  }
  if (!isDeepStrictEqual(original.documentWarnings ?? [], scan.warnings)) { management.documentWarnings = scan.warnings; changed = true; }
  if (changed) management.revision++;
  return changed || management.revision !== original.revision ? management : null;
}

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
  const items = data.items.map(item => documentView(state, item)).map(view => ({ ...view.item, body: view.error ?? view.item.body, fileModifiedAt: view.fileModifiedAt })).filter(item => (!query.kind || item.kind === query.kind) && (!query.status || item.status === query.status)
    && (query.ownerId === undefined || item.ownerId === query.ownerId) && item.archived === (query.archived ?? false)
    && (!search || `${itemNumber(item)} ${item.title} ${item.body} ${item.acceptance} ${item.comments.map(comment => comment.body).join(' ')}`.toLowerCase().includes(search)))
    .sort((a, b) => Number(itemNumber(b).toLowerCase().startsWith(search)) - Number(itemNumber(a).toLowerCase().startsWith(search)) || a.position - b.position || a.number - b.number);
  const offset = Number(query.cursor ?? 0);
  return { items: items.slice(offset, offset + limit).map(({ body, acceptance, comments, ...item }) => ({ ...item, excerpt: body.slice(0, 180) })), total: items.length,
    nextCursor: offset + limit < items.length ? String(offset + limit) : null, revision: data.revision, recovery: documentRecovery(state.project.root) ?? data.recovery, documentWarnings: data.documentWarnings };
}
export function readProjectItem(state: ProjectState, id: string, options: { cursor?: string; limit?: number; commentId?: string } = {}): ItemDetail {
  const item = state.management?.items.find(item => item.id === id);
  if (!item) throw new Error('找不到本项目中的工作项。');
  if (options.cursor !== undefined && typeof options.cursor !== 'string') throw new Error('分页游标格式不正确。');
  const limit = options.limit ?? 100, stamp = `${id}:${state.management!.revision}:${state.messages.length}:${state.tasks.length}`;
  const offsetText = options.cursor?.slice(stamp.length + 1) ?? '0', offset = Number(offsetText);
  if (options.cursor !== undefined && (typeof options.cursor !== 'string' || !options.cursor.startsWith(`${stamp}:`) || !/^\d+$/.test(offsetText) || !Number.isSafeInteger(offset))) throw new Error('分页依据已变化或格式不正确，请刷新工作项。');
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('分页数量必须为 1 到 200。');
  const focusedComment = options.commentId === undefined ? undefined : item.comments.find(comment => comment.id === options.commentId);
  if (options.commentId !== undefined && !focusedComment) throw new Error('指定评论不存在或不属于当前工作项。');
  const backlinks: ItemBacklink[] = [], referenceErrors: string[] = [];
  const view = documentView(state, item);
  for (const stored of state.management?.items ?? []) {
    if (stored.deletedAt) continue;
    const sourceView = documentView(state, stored), source = sourceView.item;
    if (sourceView.error) referenceErrors.push(`${source.title}：${sourceView.error}`);
    const hasTarget = (body: string) => referencesIn(body, state.project.id).some(reference => reference.id === id && reference.kind === item.kind);
    if (hasTarget(`${source.body}\n\n${source.acceptance}`)) backlinks.push({ itemId: source.id, title: source.title, kind: source.kind });
    for (const comment of source.comments) if (hasTarget(comment.body)) backlinks.push({ itemId: source.id, title: source.title, kind: source.kind, commentId: comment.id });
  }
  const contains = (context?: StoredWorkContext) => context?.primary_todo_id === id || context?.references.some(reference => reference.id === id && reference.kind === item.kind);
  for (const message of state.messages) if (contains(message.workContext) || referencesIn(typeof message.request.content === 'string' ? message.request.content : JSON.stringify(message.request.content), state.project.id).some(reference => reference.id === id && reference.kind === item.kind)) {
    backlinks.push({ itemId: '', kind: item.kind, title: `${message.fromName} → ${message.toName}`, messageId: message.message_id, taskId: message.sourceTaskId });
  }
  const references = referencesIn([view.item.body, item.acceptance, ...item.comments.map(comment => comment.body)].join('\n\n'), state.project.id);
  const events = (state.management?.events ?? []).filter(event => event.itemId === id), taskIds = state.tasks.filter(task => contains(task.workContext)).map(task => task.id);
  const total = Math.max(item.comments.length, references.length, backlinks.length, events.length, taskIds.length, referenceErrors.length);
  const page = <T>(values: T[]) => values.slice(Math.max(0, values.length - offset - limit), Math.max(0, values.length - offset));
  return { ...view, focusedComment: structuredClone(focusedComment), item: { ...view.item, comments: page(item.comments) }, references: page(references), backlinks: page(backlinks), referenceErrors: page(referenceErrors),
    events: page(events).map(event => ({ ...event, before: event.before && eventItem(event.before), after: eventItem(event.after) })), taskIds: page(taskIds),
    nextCursor: offset + limit < total ? `${stamp}:${offset + limit}` : null };
}
export function applyItemMutation(state: ProjectState, input: ItemMutation, actor: ItemActor) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.request_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.request_id)) throw new Error('管理请求编号不正确。');
  const key = `${actor.kind}:${actor.nodeId ?? ''}:${input.request_id}`, management = structuredClone(state.management ?? emptyManagement());
  const replay = management.receipts.find(receipt => receipt.key === key);
  if (replay) {
    if (!isDeepStrictEqual(replay.input, input)) throw new Error('请求编号已用于不同内容，发生冲突。');
    return { management, receipt: replay.receipt, replay: true, documentChange: undefined as DocumentChange | undefined };
  }
  const fields: Record<string, string[]> = {
    create: ['kind', 'title', 'body', 'acceptance', 'issueType', 'parentId', 'priority', 'ownerId', 'path'],
    edit: ['title', 'body', 'acceptance', 'issueType', 'priority', 'ownerId', 'status'],
    move: ['parentId', 'beforeId', 'path'], archive: [], restore: ['path'], delete: [], reopen: [], comment: ['body'], register: ['kind', 'path', 'title'], relink: ['path'],
  };
  if (!Object.hasOwn(fields, input.operation) || Object.keys(input).some(key => !['request_id', 'operation', 'id', 'expected_revision', 'expected_hash', 'reason', ...fields[input.operation]].includes(key))) throw new Error('不支持的管理操作或字段。');
  const reason = text(input.reason ?? '', '变更说明', 4000).trim();
  const before = new Map(management.items.map(item => [item.id, structuredClone(item)]));
  const at = new Date().toISOString();
  let item: ProjectItem;
  let documentChange: DocumentChange | undefined;
  if (input.operation === 'register') {
    if (input.kind !== undefined && input.kind !== 'document') throw new Error('只可注册文档。');
    const path = documentPath(state.project.root, input.path).path;
    const known = management.items.find(item => item.kind === 'document' && !item.deletedAt && item.path?.toLowerCase() === path.toLowerCase());
    if (known) {
      const receipt = { accepted: true as const, requestId: input.request_id, itemId: known.id, revision: known.revision };
      management.revision++; management.receipts.push({ key, input: structuredClone(input), receipt });
      return { management, receipt, replay: false, documentChange };
    }
  }
  if (input.operation === 'create' || input.operation === 'register') {
    const kind = input.operation === 'register' ? 'document' : input.kind;
    if (!['todo', 'issue', 'document'].includes(kind ?? '') || input.id !== undefined || input.expected_revision !== undefined) throw new Error('新工作项类型或标识不正确。');
    item = { id: randomUUID(), kind: kind!, number: Math.max(0, ...management.items.filter(item => item.kind === kind).map(item => item.number)) + 1,
      title: '', body: '', acceptance: '', status: kind === 'todo' ? 'todo' : kind === 'issue' ? 'open' : 'active', priority: 'normal', ownerId: null,
      parentId: input.parentId ?? null, position: management.items.filter(other => other.parentId === (input.parentId ?? null)).length,
      issueType: 'bug', path: null, archived: false, revision: 0, createdAt: at, updatedAt: at, comments: [] };
    management.items.push(item);
    if (item.kind === 'document') {
      const path = documentPath(state.project.root, input.path ?? `docs/document-${item.number}.md`);
      if (management.items.some(other => other.id !== item.id && !other.deletedAt && other.path?.toLowerCase() === path.path.toLowerCase())) throw new Error('该文档路径已有管理对象。');
      item.path = path.path;
      if (input.operation === 'register') { const file = readDocument(state.project.root, path.path); item.fileHash = file.hash; item.title = text(input.title ?? basename(path.path), '标题', 200).trim(); }
      else {
        if (existsSync(path.absolute)) throw new Error('文档文件已存在，请使用纳入已有文档。');
        const body = text(input.body ?? '', '正文');
        documentChange = { path: path.path, target: path.path, before: null, body, operation: 'write' }; item.fileHash = documentHash(body);
      }
    } else if (input.path !== undefined) throw new Error('仅文档接受文件路径。');
  } else {
    const found = management.items.find(item => item.id === input.id);
    if (!found) throw new Error('找不到本项目中的工作项。');
    item = found;
    if (!Number.isSafeInteger(input.expected_revision) || input.expected_revision !== item.revision) throw new Error('工作项已更新，版本冲突；请重新读取后保存。');
    if (item.archived && input.operation !== 'restore') throw new Error('请先恢复已归档的工作项。');
  }
  if (input.operation === 'create' || input.operation === 'edit') {
    for (const key of ['title', 'body', 'acceptance'] as const) if (input[key] !== undefined) {
      if (item.kind === 'document' && key === 'body') {
        const body = text(input.body, '正文');
        if (input.operation === 'edit') {
          const file = readDocument(state.project.root, item.path!);
          if (input.expected_hash !== file.hash) throw new Error('文档已被外部修改，保存发生冲突。');
          documentChange = { path: item.path!, target: item.path!, before: file, body, operation: 'write' }; item.fileHash = documentHash(body);
        }
      } else item[key] = text(input[key], key === 'title' ? '标题' : '正文', key === 'title' ? 200 : 131072);
    }
    item.title = item.title.trim(); if (!item.title) throw new Error('标题不能为空。');
    if (input.priority !== undefined) { if (!['low', 'normal', 'high'].includes(input.priority)) throw new Error('优先级不正确。'); item.priority = input.priority; }
    if (input.ownerId !== undefined) {
      if (input.ownerId !== null && input.ownerId !== 'user' && !state.nodes.some(node => node.id === input.ownerId)
        && !(input.ownerId === item.ownerId && state.archivedNodes?.some(node => node.id === input.ownerId))) throw new Error('负责人必须是当前用户或本项目节点。');
      item.ownerId = input.ownerId;
    }
    if (input.issueType !== undefined) { if (item.kind !== 'issue' || !['bug', 'enhancement', 'requirement'].includes(input.issueType)) throw new Error('Issue 类型不正确。'); item.issueType = input.issueType; }
    if (input.status !== undefined) {
      const allowed = item.kind === 'todo' ? ['todo', 'doing', 'blocked', 'done'] : item.kind === 'issue' ? ['open', 'doing', 'closed'] : ['active'];
      if (!allowed.includes(input.status)) throw new Error('工作项状态不正确。');
      if (['done', 'closed'].includes(input.status) && input.status !== item.status && !reason) throw new Error('完成或关闭需要填写处理说明。');
      item.status = input.status;
    }
  } else if (item.kind === 'document' && (input.operation === 'move' || input.operation === 'relink')) {
    const destination = documentPath(state.project.root, input.path);
    if (management.items.some(other => other.id !== item.id && !other.deletedAt && other.path?.toLowerCase() === destination.path.toLowerCase())) throw new Error('目标路径已经注册为其他文档。');
    if (input.operation === 'move') {
      const file = readDocument(state.project.root, item.path!);
      if (input.expected_hash !== file.hash) throw new Error('文档已被外部修改，移动发生冲突。');
      if (destination.path.toLowerCase() !== item.path!.toLowerCase()) {
        if (existsSync(destination.absolute)) throw new Error('目标文档文件已存在，不能覆盖。');
        documentChange = { path: item.path!, target: destination.path, before: file, body: file.body, operation: 'move' };
      }
      item.fileHash = file.hash;
    } else item.fileHash = readDocument(state.project.root, destination.path).hash;
    item.path = destination.path;
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
    if (item.kind === 'document') throw new Error('文档不使用重开状态。');
    if (!reason) throw new Error('重开需要填写说明。');
    item.status = item.kind === 'todo' ? 'todo' : 'open';
    for (const parent of ancestors(management.items, item)) if (parent.status === 'done') parent.status = 'todo';
  } else if (input.operation === 'delete') {
    if (item.kind !== 'document') throw new Error('只有文档支持删除，待办和 Issue 请使用归档。');
    const file = readDocument(state.project.root, item.path!);
    if (input.expected_hash !== file.hash) throw new Error('文档已被外部修改，删除发生冲突。');
    if (existsSync(documentTrashPath(state.project.root, item.id))) throw new Error('回收区已有该文档的文件，请先处理恢复记录。');
    documentChange = { path: item.path!, target: item.path!, before: file, body: file.body, operation: 'trash' };
    item.deletedAt = at; item.archived = true; item.fileHash = file.hash;
  } else if (input.operation === 'restore' && item.deletedAt) {
    if (item.kind !== 'document') throw new Error('删除标识只适用于文档。');
    const file = readTrashedDocument(state.project.root, item.id), destination = documentPath(state.project.root, input.path ?? item.path);
    if (input.expected_hash !== file.hash) throw new Error('回收文件已变更，恢复发生冲突。');
    if (existsSync(destination.absolute) || management.items.some(other => other.id !== item.id && !other.deletedAt && other.path?.toLowerCase() === destination.path.toLowerCase())) throw new Error('恢复目标已存在或已被其他文档占用，不能覆盖。');
    documentChange = { path: item.path!, target: destination.path, before: file, body: file.body, operation: 'restore' };
    item.path = destination.path; item.fileHash = file.hash; item.archived = false; delete item.deletedAt;
  } else if (input.operation === 'archive' || input.operation === 'restore') {
    if (input.path !== undefined) throw new Error('只有回收站文档恢复时接受目标路径。');
    const branch = [item, ...(item.kind === 'todo' ? descendants(management.items, item.id) : [])];
    for (const member of branch) member.archived = input.operation === 'archive';
    if (input.operation === 'restore') for (const parent of ancestors(management.items, item)) parent.archived = false;
  } else if (input.operation !== 'register') throw new Error('此工作项不支持该操作。');
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
      management.events.push({ id: randomUUID(), itemId: changed.id, operation: input.operation, actor: structuredClone(actor), at, before: previous && eventItem(previous), after: eventItem(changed),
        ...(input.operation === 'comment' ? { commentId: changed.comments.at(-1)!.id } : {}), reason });
    }
  }
  management.revision++;
  const receipt = { accepted: true as const, requestId: input.request_id, itemId: item.id, revision: item.revision };
  management.receipts.push({ key, input: structuredClone(input), receipt });
  return { management, receipt, replay: false, documentChange };
}
