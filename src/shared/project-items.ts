import { marked } from 'marked';

export type ItemKind = 'todo' | 'issue' | 'document';
export type ItemStatus = 'todo' | 'doing' | 'blocked' | 'done' | 'open' | 'closed' | 'active';
export interface ItemActor { kind: 'user' | 'node' | 'external'; nodeId?: string; taskId?: string; threadId?: string; turnId?: string; }
export interface ItemComment { id: string; body: string; author: ItemActor; createdAt: string; }
export interface ProjectItem {
  id: string; kind: ItemKind; number: number; title: string; body: string; acceptance: string;
  status: ItemStatus; priority: 'low' | 'normal' | 'high'; ownerId: string | null;
  parentId: string | null; position: number; issueType: 'bug' | 'enhancement'; path: string | null;
  archived: boolean; revision: number; createdAt: string; updatedAt: string; comments: ItemComment[];
}
export type ItemSummary = Omit<ProjectItem, 'body' | 'acceptance' | 'comments'> & { excerpt: string };
export interface ItemReference { projectId: string; kind: ItemKind; id: string; }
export interface WorkContext { primary_todo_id: string | null; references: ItemReference[]; }
export interface ItemObservation extends ItemReference { title: string; revision: number; hash?: string; }
export interface StoredWorkContext extends WorkContext { observed: ItemObservation[]; }
export interface ItemEvent { id: string; itemId: string; operation: string; actor: ItemActor; at: string; before: ProjectItem | null; after: ProjectItem; reason: string; }
export interface ItemReceipt { accepted: true; requestId: string; itemId: string; revision: number; }
export interface ManagementState {
  revision: number; items: ProjectItem[]; events: ItemEvent[];
  receipts: { key: string; input: ItemMutation; receipt: ItemReceipt }[];
}
export interface ItemQuery { text?: string; kind?: ItemKind; status?: ItemStatus; ownerId?: string; archived?: boolean; cursor?: string; limit?: number; }
export interface ItemPage { items: ItemSummary[]; nextCursor: string | null; revision: number; total: number; }
export interface ItemBacklink { itemId: string; title: string; kind: ItemKind; commentId?: string; messageId?: string; taskId?: string; }
export interface ItemDetail {
  item: ProjectItem; hash: string | null; error: string | null; references: ItemReference[];
  backlinks: ItemBacklink[]; events: ItemEvent[]; taskIds: string[];
}
export interface ItemMutation {
  request_id: string; operation: 'create' | 'edit' | 'move' | 'archive' | 'restore' | 'reopen' | 'comment' | 'register';
  id?: string; expected_revision?: number; expected_hash?: string | null; kind?: ItemKind;
  title?: string; body?: string; acceptance?: string; status?: ItemStatus; priority?: ProjectItem['priority'];
  ownerId?: string | null; parentId?: string | null; beforeId?: string | null; issueType?: 'bug' | 'enhancement'; path?: string; reason?: string;
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
  const active = items.filter(item => item.kind === 'todo' && !item.archived), pending = [id], seen = new Set<string>();
  let completed = 0, total = 0;
  for (let index = 0; index < pending.length; index++) {
    const next = pending[index]; if (seen.has(next)) continue; seen.add(next);
    const item = active.find(item => item.id === next); if (!item) continue;
    const children = active.filter(child => child.parentId === next);
    if (children.length) pending.push(...children.map(child => child.id));
    else { total++; if (item.status === 'done') completed++; }
  }
  return { completed, total };
}
