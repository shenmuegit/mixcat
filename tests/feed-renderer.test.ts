import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FeedReader } from '../src/renderer/FeedReader.js';
import type { FeedEntry } from '../src/shared/feed.js';

test('personal reader renders hostile Markdown as inert text and separates summary and notes', () => {
  const entry = { id: 'entry', title: '资料', body: '<script>window.pwned=true</script>\n\n[bad](javascript:alert(1))\n\n**安全文本**', aiSummary: '摘要', sourceUrl: null, publishedAt: null, coverage: 'excerpt', firstCollectedAt: '2026-10-29', note: '个人备注', references: [], discoveries: { items: [], nextCursor: null, revision: 1 } } as unknown as FeedEntry;
  const html = renderToStaticMarkup(createElement(FeedReader, { entry, note: entry.note, busy: false, onNote() {}, onMutation: async () => {}, onClose() {} }));
  assert(!html.includes('<script>')); assert(!html.includes('href="javascript:')); assert(html.includes('<strong>安全文本</strong>')); assert(html.includes('AI 摘要')); assert(html.includes('个人备注')); assert(html.includes('发布时间：未确认'));
});
