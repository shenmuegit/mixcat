export type FeedActor = { kind: 'user' } | { kind: 'agent'; collectionId: string; runId: string; threadId: string; turnId: string; callId: string };
export interface FeedEntryInput {
  title: string; body: string; aiSummary?: string; sourceUrl?: string; publishedAt?: string;
  coverage: 'full' | 'partial' | 'excerpt'; referenceEntryIds?: string[];
}
export interface FeedReceipt {
  accepted: true; requestId: string; entryId: string; outcome: 'new' | 'duplicate' | 'suppressed_deleted'; revision: number;
}
export interface FeedQuery { text?: string; view?: 'all' | 'unread' | 'saved' | 'trash'; collectionId?: string | 'manual'; cursor?: string; limit?: number; }
export interface FeedPage<T> { items: T[]; nextCursor: string | null; revision: number; }
export interface FeedDiscovery { id: number; actor: FeedActor; collectedAt: string; }
export interface FeedReferenceSummary { id: string; title: string; deletedAt: string | null; }
export interface FeedEntry {
  id: string; title: string; body: string; aiSummary: string | null; sourceUrl: string | null; publishedAt: string | null;
  coverage: FeedEntryInput['coverage']; referenceEntryIds: string[]; firstCollectedAt: string; updatedAt: string;
  readAt: string | null; starred: boolean; note: string; revision: number; deletedAt: string | null;
  discoveries: FeedPage<FeedDiscovery>; references: FeedReferenceSummary[];
}
export type FeedEntrySummary = Omit<FeedEntry, 'body' | 'note' | 'discoveries' | 'references'> & { excerpt: string };
export interface FeedDraft { key: string; text: string; revision: number; updatedAt: string; }
type EntryEdit = { id: string; expectedRevision: number; requestId: string };
export type FeedEntryMutation =
  | { operation: 'createText'; input: FeedEntryInput; requestId: string }
  | (EntryEdit & { operation: 'setRead'; read: boolean })
  | (EntryEdit & { operation: 'setStarred'; starred: boolean })
  | (EntryEdit & { operation: 'saveNote'; note: string })
  | (EntryEdit & { operation: 'delete' | 'restore' })
  | { operation: 'saveAnswer'; collectionId: string; conversationEntryId: string; title: string; requestId: string };
