import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CapabilityFields, NewNodeForm } from '../src/renderer/NodeSettings.js';
import { ConversationFeed, entryResources } from '../src/renderer/Conversation.js';
import { toWorkflowEdges } from '../src/renderer/Workbench.js';
import type { ConversationEntry, MessageSummary, NodeView, TaskView } from '../src/shared/types.js';

const source: NodeView = { id: 'source', name: '来源已改名', instructions: '', tools: ['handoff'], resultSchema: {}, position: { x: 0, y: 0 }, revision: 1, threadId: null, status: 'idle' };
const target: NodeView = { ...source, id: 'target', name: '接收已改名', tools: [] };
const message: MessageSummary = { message_id: 'm1', target_task_id: 'receiving', sourceTaskId: 'sending', fromNodeId: source.id, fromName: '来源节点', toNodeId: target.id, toName: '接收节点', replyTo: null, accepted_at: '' };
const input: ConversationEntry = { id: 'input', seq: 1, nodeId: target.id, taskId: 'receiving', threadId: null, turnId: null, itemId: null, direction: 'input', source: { kind: 'node', nodeId: source.id, name: '来源节点' }, messageId: 'm1', replyTo: 'original', text: ' 原始正文\n ', content: { free: [null, false, 0, ''] }, createdAt: '', status: 'queued' };

test('existing nodes expose explicit collaboration choices without granting unchecked tools or hiding native choices', () => {
  const html = renderToStaticMarkup(createElement(CapabilityFields, { node: source, catalog: { models: [{ id: 'model', name: '可用模型' }], skills: [{ name: '技能', path: 'skill' }], plugins: [{ id: 'plugin', name: '插件能力' }], errors: [] }, onChange() {} }));
  assert.match(html, /节点协作工具/);
  assert.match(html, /aria-label="send_message"[^>]*type="checkbox"|type="checkbox"[^>]*aria-label="send_message"/);
  assert.doesNotMatch(html, /aria-label="send_message"[^>]*checked|checked[^>]*aria-label="send_message"/);
  assert.equal((html.match(/checked=""/g) ?? []).length, 1);
  assert.match(html, /可用模型/); assert.match(html, /技能/); assert.match(html, /插件能力/);
  const fresh = renderToStaticMarkup(createElement(NewNodeForm, { position: { x: 0, y: 0 }, catalog: null, loading: false, busy: false, onReload() {}, async onSave() {} }));
  assert.doesNotMatch(fresh, /aria-label="(?:send_message|get_delivery|read_history)"[^>]*checked/);
});

test('collaboration feed uses accepted names, actionable reply links and live task status while retaining body and unknown time', () => {
  const html = renderToStaticMarkup(createElement(ConversationFeed, { entries: [input, { ...input, id: 'output', direction: 'output', messageId: undefined, replyTo: undefined, text: '模型输出' }], nodes: [source, target], messages: [message], tasks: [{ id: 'receiving', nodeId: target.id, status: 'running' } as TaskView], onOpen() {}, onLocateMessage() {} }));
  assert.match(html, /来源节点 → 接收节点/);
  assert.match(html, /查看原消息/); assert.match(html, /data-reply-to="original"/);
  assert.match(html, /投递 · 运行中/); assert.doesNotMatch(html, /投递 · 排队中/);
  assert.match(html, / 原始正文\n /); assert.match(html, /原生历史未提供时间/);
  assert.match(html, /chat-input/); assert.match(html, /chat-output/);
  assert.match(html, /data-message-id="m1"/);
});

test('registered message and native imported attachments use existing resource actions', () => {
  const attached = { ...input, attachments: [{ artifact_id: 'a', name: '报告.txt', relativePath: '.mixcat/artifacts/messages/a.txt', size: 3, sha256: 'hash' }] };
  assert.deepEqual(entryResources(attached, 'G:/project'), [{ label: '打开附件：报告.txt', path: 'G:/project/.mixcat/artifacts/messages/a.txt' }]);
  assert.deepEqual(entryResources({ ...input, content: [{ type: 'text', text: '附件', mixcatAttachment: { artifact_id: 'host', name: '原稿.txt', path: 'G:/project/.mixcat/attachments/input.txt' } }] }), [{ label: '打开附件：原稿.txt', path: 'G:/project/.mixcat/attachments/input.txt' }]);
  const html = renderToStaticMarkup(createElement(ConversationFeed, { entries: [attached], nodes: [source, target], projectRoot: 'G:/project', onOpen() {} }));
  assert.match(html, /打开附件：报告.txt/);
});

test('sender body is distinguished from its original receipt event even for empty and falsy content', () => {
  for (const [content, markup] of [[null, '<p>null</p>'], [false, '<p>false</p>'], [0, '<p>0</p>'], ['', '<p></p>'], [' 原文\n ', '<p> 原文\n </p>'], [{ free: false }, '&quot;free&quot;: false']] as const) {
    const entry = { ...input, nodeId: source.id, direction: 'event' as const, text: '原始发送事件', content: { type: 'messageSent', reason: '原始原因' }, sentMessage: { content } };
    const html = renderToStaticMarkup(createElement(ConversationFeed, { entries: [entry], nodes: [source, target], messages: [message], onOpen() {} }));
    assert.match(html, /发送正文/); assert.match(html, /原始发送事件/); assert.match(html, /原始记录/);
    assert.ok(html.includes(markup), html);
  }
});

test('workflow facts count ordinary messages separately from legacy handoffs and omit missing nodes', () => {
  assert.equal(toWorkflowEdges([], [source, target], []).length, 0);
  const edges = toWorkflowEdges([{ id: 'h', fromNodeId: source.id, toNodeId: target.id } as any], [source, target], [message, { ...message, message_id: 'm2' }, { ...message, message_id: 'reply', fromNodeId: target.id, toNodeId: source.id, replyTo: 'm1' }, { ...message, message_id: 'missing', toNodeId: 'missing' }]);
  assert.equal(edges.length, 2);
  assert.equal(edges[0].sourceHandle, 'return-source');
  assert.equal((edges[0] as any).pathOptions.offset, 24);
  assert.equal((edges[1] as any).pathOptions.offset, 48);
  assert.match(String(edges[0].label), /2 条消息/); assert.match(String(edges[0].label), /1 次交接/);
  assert.match(String(edges[1].label), /1 条消息/); assert.equal(edges[1].sourceHandle, 'return-source');
  assert.deepEqual(toWorkflowEdges([], [source, target]), []);
  const legacy = toWorkflowEdges([{ id: 'old-first', fromNodeId: source.id, toNodeId: target.id }, { id: 'old-last', fromNodeId: source.id, toNodeId: target.id }] as any, [source, target]);
  assert.equal(legacy[0].id, 'old-last'); assert.equal(legacy[0].label, '2 次交接');
});
