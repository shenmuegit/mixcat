import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { resolveReviewRoute } from '../src/renderer/boardui-review/review-routes.js';
import { reviewCatalog } from '../src/renderer/boardui-review/catalog.js';

test('catalogMatchesFrozenSpec', () => {
  const spec = readFileSync(new URL('../docs/design/2026-11-24-boardui-mixcat-design.md', import.meta.url), 'utf8');
  const headings = [...spec.matchAll(
    /^#### (\d{3}) ([\w-]+)\r?\n\r?\n\*\*([^*\r\n]+)\*\* · (接入|条件|参考|维持) · /gm,
  )];
  assert.deepEqual(reviewCatalog.map(entry => [entry.id, entry.slug, entry.title, entry.disposition]),
    headings.map(([, id, slug, title, disposition]) => [Number(id), slug, title, disposition]));

  const ids = reviewCatalog.map(entry => entry.id);
  assert.deepEqual(ids, Array.from({ length: 130 }, (_, index) => index + 1));
  assert.equal(new Set(ids).size, 130);
  assert.equal(reviewCatalog.find(entry => entry.slug === 'counter')?.id, 58);
  assert.equal(reviewCatalog.find(entry => entry.slug === 'badge')?.id, 59);
});

test('unavailableCaseIsNotPassed', () => {
  const cases = [{ entryId: 74 }];
  assert.deepEqual(resolveReviewRoute('#/034/tree-view', cases),
    { kind: 'pending', entry: reviewCatalog[33] });
  assert.deepEqual(resolveReviewRoute('#/129/template-ai-profile', cases),
    { kind: 'pending', entry: reviewCatalog[128] });
  assert.deepEqual(resolveReviewRoute('#/074/agent-runtime', cases),
    { kind: 'available', entry: reviewCatalog[73] });
  assert.deepEqual(resolveReviewRoute('#/059/badge', cases),
    { kind: 'pending', entry: reviewCatalog[58] });
  assert.deepEqual(resolveReviewRoute('#/034/badge', cases), { kind: 'missing' });
  assert.deepEqual(resolveReviewRoute('#/34/tree-view', cases), { kind: 'missing' });
});
