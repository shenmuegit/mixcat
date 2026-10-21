import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CapabilityFields, NodeConfig } from '../src/renderer/NodeSettings.js';
import { ConversationFeed, orderedConversation } from '../src/renderer/Conversation.js';
import type { NodeView, ConversationEntry } from '../src/shared/types.js';

const node: NodeView = { id: 'writer', name: 'Writer', instructions: 'Write freely', model: 'chosen', tools: ['get_project_context'], resultSchema: {}, skills: [{ name: 'Writing', path: 'G:/skills/writing' }], plugins: [{ name: 'Test', id: 'test@local' }], position: { x: 0, y: 0 }, revision: 1, threadId: null, status: 'idle' };
test('node configuration retains selected native parameters and shows independent catalog failures', () => {
  const html = renderToStaticMarkup(createElement(CapabilityFields, { node, catalog: { models: [], skills: [], plugins: [], errors: ['model/list: unavailable'] }, onChange() {} }));
  assert.match(html, /value="chosen" selected=""/);
  assert.match(html, /model\/list: unavailable/);
  assert.match(html, /Writing/); assert.match(html, /Test/);
  assert.equal((html.match(/checked=""/g) ?? []).length, 2);
  const config = renderToStaticMarkup(createElement(NodeConfig, { node, tasks: [], busy: false, onSave: async () => node, onError() {} }));
  assert.match(config, /value="Writer"/); assert.match(config, /Write freely/);
});
test('free messages render author, direction and original text with native attachment references', () => {
  const entries: ConversationEntry[] = [
    { id: 'input', seq: 1, nodeId: node.id, taskId: null, threadId: 'thread', turnId: 'turn', itemId: null, direction: 'input', source: { kind: 'user' }, text: 'User text', content: [{ type: 'localImage', path: 'G:/project/image.png' }], createdAt: '' },
    { id: 'output', seq: 2, nodeId: node.id, taskId: null, threadId: 'thread', turnId: 'turn', itemId: 'reply', direction: 'output', source: null, text: 'Free reply', content: { type: 'agentMessage', text: 'Free reply' }, createdAt: '' },
  ];
  const html = renderToStaticMarkup(createElement(ConversationFeed, { entries, nodes: [node], onOpen() {} }));
  assert.match(html, /chat-input/); assert.match(html, /chat-output/); assert.match(html, /User text/); assert.match(html, /Free reply/); assert.match(html, /打开附件/);
});
test('system and unknown source labels and unknown time are shared by both timelines', () => {
  const entries: ConversationEntry[] = ['system', 'unknown'].map((kind, seq) => ({
    id: kind, seq, nodeId: node.id, taskId: null, threadId: null, turnId: null, itemId: null,
    direction: 'input', source: { kind: kind as 'system' | 'unknown' }, text: `${kind} original`, content: null, createdAt: '',
  }));
  for (const projectTimeline of [false, true]) {
    const html = renderToStaticMarkup(createElement(ConversationFeed, { entries, nodes: [node], projectTimeline, onOpen() {} }));
    assert.match(html, /系统续接/); assert.match(html, /原生输入（来源未知）/);
    assert.match(html, /原生历史未提供时间/); assert.match(html, /system original/);
  }
});
test('mixed timestamp ordering is a total order shared by node and project subsets', () => {
  const entries = [
    { id: 'A', seq: 1, nodeId: 'a', createdAt: '2026-01-03' },
    { id: 'B', seq: 2, nodeId: 'b', createdAt: '' },
    { id: 'C', seq: 3, nodeId: 'a', createdAt: '2026-01-01' },
  ] as ConversationEntry[];
  const project = orderedConversation(entries).filter(e => e.nodeId === 'a').map(e => e.id);
  assert.deepEqual(orderedConversation(entries).map(e => e.id), ['C', 'A', 'B']);
  assert.deepEqual(orderedConversation(entries.filter(e => e.nodeId === 'a')).map(e => e.id), project);
  for (const permutation of [entries, [...entries].reverse(), [entries[1], entries[2], entries[0]]])
    assert.deepEqual(orderedConversation(permutation).map(e => e.id), orderedConversation(entries).map(e => e.id));
});
test('equivalent known times and unknown times have stable sequence and ID tie breakers', () => {
  const entries = [
    { id: 'unknown-z', seq: 6, createdAt: 'invalid' },
    { id: 'known-z', seq: 2, createdAt: '2026-01-01T00:00:00Z' },
    { id: 'known-a', seq: 2, createdAt: '2026-01-01T08:00:00+08:00' },
    { id: 'unknown-a', seq: 6, createdAt: '' },
    { id: 'unknown-first', seq: 1, createdAt: '' },
  ] as ConversationEntry[];
  assert.deepEqual(orderedConversation(entries).map(e => e.id), ['known-a', 'known-z', 'unknown-first', 'unknown-a', 'unknown-z']);
  assert.equal(entries[0].createdAt, 'invalid');
  assert.equal(entries[3].createdAt, '');
});
