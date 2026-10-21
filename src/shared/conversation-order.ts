import type { ConversationEntry } from './types.js';

export function compareConversation(a: Pick<ConversationEntry, 'createdAt' | 'seq' | 'id'>, b: Pick<ConversationEntry, 'createdAt' | 'seq' | 'id'>): number {
  // Unknown times follow known times; sequence and ID keep every subset consistent.
  const timestamp = (entry: Pick<ConversationEntry, 'createdAt'>) => { const value = Date.parse(entry.createdAt); return Number.isFinite(value) ? value : Infinity; };
  return timestamp(a) - timestamp(b) || a.seq - b.seq || a.id.localeCompare(b.id);
}
export function orderedConversation(entries: ConversationEntry[]): ConversationEntry[] {
  return [...entries].sort(compareConversation);
}
