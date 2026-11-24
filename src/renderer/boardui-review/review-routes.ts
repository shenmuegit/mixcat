import { reviewCatalog, type ReviewEntry } from './catalog.js';

export function entryNumber(id: number) {
  return String(id).padStart(3, '0');
}

export function entryHash(entry: ReviewEntry) {
  return '#/' + entryNumber(entry.id) + '/' + entry.slug;
}

export type ReviewRoute =
  | { kind: 'missing' }
  | { kind: 'available' | 'pending'; entry: ReviewEntry };

export function resolveReviewRoute(hash: string, cases: readonly { entryId: number }[]): ReviewRoute {
  const entry = reviewCatalog.find(candidate => entryHash(candidate) === hash);
  if (!entry) return { kind: 'missing' };
  return { kind: cases.some(reviewCase => reviewCase.entryId === entry.id) ? 'available' : 'pending', entry };
}
