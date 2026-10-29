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

import { orderedConversation } from '../src/shared/conversation-order.js';
import { FeedCollection } from '../src/renderer/FeedCollection.js';
import type { FeedCollectionDetail, FeedConversationEntry } from '../src/shared/feed.js';
test('personal conversation ordering preserves readonly personal entries and unknown timestamps', () => {
  const entries = [{ id: 'unknown', seq: 1, createdAt: '', collectionId: 'a' }, { id: 'known', seq: 2, createdAt: '2026-10-29', collectionId: 'a' }] as const;
  assert.deepEqual(orderedConversation(entries).map(entry => entry.id), ['known', 'unknown']);
  assert.equal(entries[0].id, 'unknown');
});
test('collection workspace names queue and schedule independently and exposes native handling', () => {
  const detail = { collection: { id: 'a', name: '新闻采集', instruction: '每日新闻', sourcePreferences: '', revision: 1, instructionRevision: 1, schedule: { frequency: 'manual' }, queueHeld: true, capabilities: { model: null, skills: [], plugins: [] } }, queuedCount: 1, attention: [], activeRun: null, runtime: null, requests: [{ key: 'request', request: { id: 1, method: 'item/commandExecution/requestApproval', params: { command: 'read' } } }] } as unknown as FeedCollectionDetail;
  const html = renderToStaticMarkup(createElement(FeedCollection, { detail, execute: async () => { throw Error('unused'); }, onBack() {}, onError() {} }));
  for (const text of ['新闻采集', '队列待继续', '手动', 'Codex 请求批准', '对话', '结果', '运行记录']) assert(html.includes(text), text);
});
