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
export interface FeedSnapshot { generation: number; revision: number; unreadCount: number; collections: { id: string; name: string }[]; runsNeedingAttention: { id: string }[]; storageError: string | null; }
export interface FeedCommandResult { snapshot: FeedSnapshot; entry?: FeedEntry; entries?: FeedPage<FeedEntrySummary>; draft?: FeedDraft | null; receipt?: FeedReceipt; }
export type FeedCommand =
  | { type: 'feed_snapshot' }
  | { type: 'search_feed_entries'; query: FeedQuery }
  | { type: 'get_feed_entry'; entryId: string; discoveryCursor?: string }
  | { type: 'update_feed_entry'; mutation: FeedEntryMutation }
  | { type: 'read_feed_draft'; key: string }
  | { type: 'save_feed_draft'; draft: Pick<FeedDraft, 'key' | 'text'>; expectedRevision: number; requestId: string };
