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
export interface FeedDiscovery { id: number; actor: FeedActor; collectedAt: string; collection?: { id: string; name: string; deletedAt: string | null } | null; runId?: string | null; historyAvailable?: boolean; }
export interface FeedReferenceSummary { id: string; title: string; deletedAt: string | null; }
export interface FeedAnswerOrigin { collectionId: string; runId: string | null; threadId: string | null; turnId: string | null; conversationEntryId: string; }
export interface FeedEntry {
  answerOrigin?: FeedAnswerOrigin | null;
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
export interface FeedCommandResult { collectionPage?: FeedPage<FeedCollectionSummary>; snapshot: FeedSnapshot; entry?: FeedEntry; entries?: FeedPage<FeedEntrySummary>; draft?: FeedDraft | null; receipt?: FeedReceipt; collection?: FeedCollectionDetail; admission?: FeedAdmission; run?: FeedRun; history?: FeedPage<FeedConversationEntry>; runs?: FeedPage<FeedRun>; results?: FeedPage<FeedRunResult>; failures?: FeedPage<FeedSourceFailure>; nativeHistory?: { nextCursor: string | null }; capabilities?: import('./types.js').CapabilityCatalog; }
export type FeedCommand =
  | { type: 'feed_snapshot' }
  | { type: 'search_feed_entries'; query: FeedQuery }
  | { type: 'get_feed_entry'; entryId: string; discoveryCursor?: string }
  | { type: 'update_feed_entry'; mutation: FeedEntryMutation }
  | { type: 'read_feed_draft'; key: string }
  | { type: 'save_feed_draft'; draft: Pick<FeedDraft, 'key' | 'text'>; expectedRevision: number; requestId: string }
  | FeedCollectionCommand;

export interface FeedCapabilities { model: string | null; reasoningEffort?: string | null; skills: import('./types.js').SkillSelection[]; plugins: import('./types.js').PluginSelection[]; }
export type FeedSchedule = { frequency: 'manual' } | { frequency: 'daily'; enabled: boolean; time: string; timeZone: string } | { frequency: 'weekly'; enabled: boolean; time: string; timeZone: string; weekday: number };
export interface FeedCollection { schedule: FeedSchedule; scheduleRevision: number; scheduleCoverageStart: string | null; nextDueAt: string | null; id: string; name: string; instruction: string; sourcePreferences: string; instructionRevision: number; revision: number; capabilities: FeedCapabilities; threadId: string | null; queueHeld: boolean; deletedAt: string | null; createdAt: string; updatedAt: string; }
export interface FeedInput { text: string; materialEntryIds?: string[]; }
export interface FeedMaterial { entryId: string; revision: number; title: string; body: string; }
export type FeedTrigger = 'collect' | 'message' | 'schedule' | 'catchup' | 'research';
export interface FeedCoverageWindow { start: string; end: string; }
export interface FeedRunInput { trigger: FeedTrigger; text: string; entryIds?: string[]; coverageWindow?: FeedCoverageWindow; scheduleRevision?: number; }
export type FeedRunStatus = 'queued' | 'waiting_account' | 'starting' | 'running' | 'stopping' | 'stopped' | 'completed' | 'failed' | 'needs_reconciliation' | 'cancelled';
export interface FeedRun { goalChecked?: boolean; goalBaselineRequestId?: string | null; id: string; collectionId: string; trigger: FeedTrigger; status: FeedRunStatus; coverageWindow?: FeedCoverageWindow; scheduleRevision?: number; dispatchState?: 'not_sent' | 'unknown' | 'acknowledged'; inputSnapshot: { text: string; materials: FeedMaterial[] }; instructionSnapshot: string | null; sourcePreferencesSnapshot: string | null; instructionRevision: number | null; capabilitiesSnapshot: FeedCapabilities | null; threadId: string | null; turnId: string | null; createdAt: string; startedAt: string | null; completedAt: string | null; error: string | null; counts: { new: number; duplicate: number; suppressed: number; failed: number }; outcome: 'success' | 'partial' | 'zero' | 'failed' | null; }
export interface FeedAdmission { accepted: true; requestId: string; collectionId: string; runId: string; }
export interface FeedConversationEntry { id: string; seq: number; collectionId: string; runId: string | null; threadId: string | null; turnId: string | null; itemId: string | null; source: 'user' | 'assistant' | 'system' | 'unknown'; nativeRole?: 'user' | 'assistant' | 'tool'; text: string; rawItem?: unknown; createdAt: string; completed: boolean; revision: number; }
export interface FeedSourceFailure { id: number; actor: Extract<FeedActor, { kind: 'agent' }>; url: string; reason: string; createdAt: string; }
export interface FeedRunResult { answerOrigin?: FeedAnswerOrigin | null; discoveryId: number; entryId: string; title: string; deletedAt: string | null; actor: FeedActor; collectedAt: string; }
export interface FeedCollectionDetail { collection: FeedCollection; activeRun: FeedRun | null; queuedCount: number; attention: FeedRun[]; requests: { key: string; request: import('./types.js').NativeServerRequest }[]; runtime: import('./types.js').RuntimeStatus | null; }
export type FeedCollectionCommand =
  | { type: 'list_feed_collections'; deleted?: boolean; cursor?: string; limit?: number }
  | { type: 'set_feed_schedule'; collectionId: string; schedule: FeedSchedule; expectedRevision: number; requestId: string }
  | { type: 'pause_feed_schedule' | 'resume_feed_schedule'; collectionId: string; expectedRevision: number; requestId: string }
  | { type: 'create_feed_collection'; requestId: string; name: string; instruction: string; sourcePreferences?: string; input: FeedInput; trigger?: 'collect' | 'research' | 'message'; capabilities?: FeedCapabilities }
  | { type: 'get_feed_collection'; collectionId: string }
  | { type: 'edit_feed_collection'; collectionId: string; expectedRevision: number; requestId: string; changes: { name?: string; instruction?: string; sourcePreferences?: string; capabilities?: FeedCapabilities } }
  | { type: 'run_feed_collection' | 'send_feed_message'; collectionId: string; input: FeedInput; requestId: string }
  | { type: 'stop_feed_run' | 'cancel_feed_run' | 'reconcile_feed_run'; runId: string; requestId: string }
  | { type: 'continue_feed_queue'; collectionId: string; requestId: string }
  | { type: 'delete_feed_collection' | 'restore_feed_collection'; collectionId: string; expectedRevision: number; requestId: string }
  | { type: 'read_feed_history' | 'list_feed_runs' | 'list_feed_results' | 'list_feed_failures'; collectionId: string; runId?: string; cursor?: string; limit?: number }
  | { type: 'load_feed_native_history'; collectionId: string; cursor?: string }
  | { type: 'feed_capabilities'; collectionId: string }
  | { type: 'respond_feed_native'; collectionId: string; requestKey: string; result: unknown };

export interface FeedCollectionSummary extends Pick<FeedCollection, 'id' | 'name' | 'instruction' | 'revision' | 'deletedAt' | 'schedule' | 'nextDueAt' | 'queueHeld'> {
  latestResult?: { entryId: string; title: string; excerpt: string; collectedAt: string } | null;
  queuedCount: number; requestCount: number; attentionCount: number;
  latestRun: Pick<FeedRun, 'id' | 'status' | 'trigger' | 'counts' | 'outcome' | 'error' | 'createdAt' | 'completedAt'> | null;
}
