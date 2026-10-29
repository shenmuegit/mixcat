import { marked } from 'marked';

export type ItemKind = 'todo' | 'issue' | 'document';
export type IssueType = 'task' | 'bug' | 'enhancement' | 'requirement';
export const MANAGEMENT_TOOLS = ['search_project_items', 'get_project_item', 'update_project_item'] as const;
export type ItemStatus = 'todo' | 'doing' | 'blocked' | 'done' | 'canceled' | 'open' | 'closed' | 'active';
export interface ItemActor { kind: 'user' | 'node' | 'external'; nodeId?: string; taskId?: string; threadId?: string; turnId?: string; callId?: string; }
export interface ItemComment { id: string; body: string; author: ItemActor; createdAt: string; }
export interface ProjectItem {
  id: string; kind: ItemKind; number: number; title: string; body: string; acceptance: string;
  status: ItemStatus; priority: 'low' | 'normal' | 'high'; ownerId: string | null;
  parentId: string | null; position: number; issueType: IssueType; legacyTodoType?: IssueType; path: string | null;
  archived: boolean; revision: number; createdAt: string; updatedAt: string; comments: ItemComment[]; fileHash?: string; deletedAt?: string;
}
export type ItemSummary = Omit<ProjectItem, 'body' | 'acceptance' | 'comments'> & { excerpt: string; fileModifiedAt?: string };
export interface ItemReference { projectId: string; kind: ItemKind; id: string; }
export interface WorkContext { primary_issue_id?: string | null; primary_todo_id?: string | null; references: ItemReference[]; }
export interface ItemObservation extends ItemReference { title: string; revision: number; hash?: string; }
export interface ItemMaterial { id: string; kind: ItemKind; title: string; revision: number; body: string; acceptance: string; issueType: IssueType; legacyTodoType?: IssueType; hash: string; commentId?: string; author?: ItemActor; createdAt?: string; }
export function issueTypeOf(item: Pick<ProjectItem, 'kind' | 'issueType' | 'legacyTodoType'>): IssueType {
  return item.kind === 'todo' ? item.legacyTodoType ?? 'task' : item.issueType;
}
export function itemMaterialContent(item: Pick<ProjectItem, 'kind' | 'body' | 'acceptance' | 'issueType' | 'legacyTodoType'>): string {
  return item.kind === 'document' ? item.body : JSON.stringify([item.kind, item.body, item.acceptance, item.kind === 'issue' ? item.issueType : issueTypeOf(item) === 'task' ? null : issueTypeOf(item)]);
}
export function itemMaterialMatches(item: ProjectItem | undefined, material: ItemMaterial): boolean {
  if (item?.deletedAt) return false;
  if (material.commentId) {
    const comment = item?.comments.find(comment => comment.id === material.commentId);
    return !!comment && comment.body === material.body && comment.createdAt === material.createdAt && JSON.stringify(comment.author) === JSON.stringify(material.author);
  }
  return !!item && item.kind === material.kind && (item.kind === 'document' ? item.fileHash === material.hash : itemMaterialContent(item) === itemMaterialContent(material));
}
export interface StoredWorkContext extends WorkContext { observed: ItemObservation[]; }
export interface ItemEvent { id: string; itemId: string; operation: string; actor: ItemActor; at: string; before: Omit<ProjectItem, 'comments'> | null; after: Omit<ProjectItem, 'comments'>; commentId?: string; reason: string; }
export interface ItemReceipt { accepted: true; requestId: string; itemId: string; revision: number; }
export interface ManagementState {
  revision: number; items: ProjectItem[]; events: ItemEvent[];
  receipts: { key: string; input: ItemMutation; receipt: ItemReceipt }[];
  recovery?: DocumentRecovery;
  documentWarnings?: string[];
}
export interface DocumentRecovery { id: string; itemId: string; path: string; draft: string; message: string; }
export interface ItemQuery { text?: string; kind?: ItemKind; status?: ItemStatus; ownerId?: string; archived?: boolean; cursor?: string; limit?: number; }
export interface ItemPage { items: ItemSummary[]; nextCursor: string | null; revision: number; total: number; recovery?: DocumentRecovery; documentWarnings?: string[]; }
export interface ItemBacklink { itemId: string; title: string; kind: ItemKind; commentId?: string; messageId?: string; taskId?: string; }
export interface ItemDetail {
  nextCursor?: string | null;
  focusedComment?: ItemComment;
  item: ProjectItem; hash: string | null; error: string | null; fileModifiedAt?: string; references: ItemReference[];
  backlinks: ItemBacklink[]; events: ItemEvent[]; taskIds: string[]; referenceErrors?: string[];
}
export interface ItemMutation {
  request_id: string; operation: 'create' | 'edit' | 'move' | 'archive' | 'restore' | 'reopen' | 'comment' | 'register' | 'relink' | 'delete';
  id?: string; expected_revision?: number; expected_hash?: string | null; kind?: ItemKind;
  title?: string; body?: string; acceptance?: string; status?: ItemStatus; priority?: ProjectItem['priority'];
  ownerId?: string | null; parentId?: string | null; beforeId?: string | null; issueType?: ProjectItem['issueType']; path?: string; reason?: string;
}
export const emptyManagement = (): ManagementState => ({ revision: 0, items: [], events: [], receipts: [] });
export const itemNumber = (item: Pick<ProjectItem, 'kind' | 'number'>) => `${{ todo: 'T', issue: 'I', document: 'D' }[item.kind]}-${item.number}`;

export function parseItemReference(href: string): ItemReference | null {
  try {
    const url = new URL(href), match = /^\/(todo|issue|document)\/([A-Za-z0-9_-]{1,128})$/.exec(url.pathname);
    if (url.protocol !== 'mixcat:' || !/^[A-Za-z0-9_-]{1,128}$/.test(url.hostname) || url.username || url.password || url.port || url.search || url.hash || !match) return null;
    return { projectId: url.hostname, kind: match[1] as ItemKind, id: match[2] };
  } catch { return null; }
}
export function parseWorkContext(value: unknown): WorkContext {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['primary_issue_id', 'primary_todo_id', 'references'].includes(key))) throw new Error('工作关联格式不正确。');
  const input = value as Record<string, unknown>, references = input.references ?? [];
  for (const key of ['primary_issue_id', 'primary_todo_id']) if (Object.hasOwn(input, key) && input[key] !== null && (typeof input[key] !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input[key] as string))) throw new Error('工作关联标识不正确。');
  if (Object.hasOwn(input, 'primary_issue_id') && Object.hasOwn(input, 'primary_todo_id') && input.primary_issue_id !== input.primary_todo_id) throw new Error('新旧主 Issue 关联发生冲突。');
  if (!Array.isArray(references) || references.length > 50) throw new Error('工作关联数量不正确。');
  const seen = new Set<string>();
  for (const reference of references) {
    if (!reference || typeof reference !== 'object' || Array.isArray(reference) || Object.keys(reference).some(key => !['projectId', 'kind', 'id'].includes(key))
      || typeof reference.projectId !== 'string' || typeof reference.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(reference.projectId) || !/^[A-Za-z0-9_-]{1,128}$/.test(reference.id)
      || !['todo', 'issue', 'document'].includes(reference.kind)) throw new Error('工作引用格式不正确。');
    const key = `${reference.projectId}:${reference.kind}:${reference.id}`;
    if (seen.has(key)) throw new Error('工作引用不能重复。'); seen.add(key);
  }
  return { ...(Object.hasOwn(input, 'primary_issue_id') || !Object.hasOwn(input, 'primary_todo_id')
    ? { primary_issue_id: (input.primary_issue_id ?? null) as string | null } : { primary_todo_id: input.primary_todo_id as string | null }), references: structuredClone(references) };
}
export function referencesIn(markdown: string, projectId: string): ItemReference[] {
  const found = new Map<string, ItemReference>();
  marked.walkTokens(marked.lexer(markdown), token => {
    if (token.type !== 'link') return;
    const reference = parseItemReference(token.href);
    if (reference?.projectId === projectId) found.set(`${reference.kind}:${reference.id}`, reference);
  });
  return [...found.values()];
}
export function itemLink(projectId: string, item: Pick<ProjectItem, 'id' | 'kind' | 'title' | 'number'>): string {
  const label = `@${itemNumber(item)} ${item.title}`.replace(/[\r\n]/g, ' ').replace(/[\\[\]]/g, '\\$&');
  return `[${label}](mixcat://${projectId}/${item.kind}/${item.id})`;
}
export function todoProgress(items: Pick<ProjectItem, 'id' | 'parentId' | 'archived' | 'status' | 'kind'>[], id: string) {
  const active = items.filter(item => item.kind !== 'document' && !item.archived), pending = [id], seen = new Set<string>();
  let completed = 0, total = 0;
  for (let index = 0; index < pending.length; index++) {
    const next = pending[index]; if (seen.has(next)) continue; seen.add(next);
    const item = active.find(item => item.id === next); if (!item) continue;
    const children = active.filter(child => child.parentId === next);
    if (children.length) pending.push(...children.map(child => child.id));
    else if (!['canceled', 'closed'].includes(item.status)) { total++; if (item.status === 'done') completed++; }
  }
  return { completed, total };
}
