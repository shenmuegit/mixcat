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

test('native plan progress uses observed step states and preserves unrecognized history', () => {
  const plan = { type: 'plan', explanation: '按阶段处理', plan: [{ step: '整理素材', status: 'completed' }, { step: '撰写正文', status: 'inProgress' }] };
  const event = { ...input, direction: 'event' as const, status: 'inProgress', threadId: 'thread', turnId: 'turn', content: plan, messageId: undefined, replyTo: undefined };
  const task = { id: input.taskId, status: 'running', turnId: 'turn', threadId: 'thread', nodeId: target.id } as TaskView;
  const render = (entry: ConversationEntry, projectTimeline = false) => renderToStaticMarkup(createElement(ConversationFeed, {
    entries: [entry], nodes: [target], tasks: [task], projectTimeline, onOpen() {},
  }));
  const live = render(event);
  assert.match(live, /aria-label="执行计划"/);
  assert.match(live, /data-live=""/);
  assert.match(live, /已完成 1\/2/);
  assert.match(live, /整理素材.*撰写正文.*进行中/);
  assert.doesNotMatch(render(event, true), /data-live=/);
  assert.doesNotMatch(render({ ...event, threadId: 'other-thread' }), /data-live=/);
  assert.doesNotMatch(render({ ...event, resumeActionId: 'other-resume' }), /data-live=/);
  const unknown = render({ ...event, status: 'completed', content: { ...plan, plan: [
    ...plan.plan, { step: '上传文件', status: 'failed', error: '目标暂时不可写' }, { step: '无法确认的阶段', status: 'unknown' }
  ] } }, true);
  assert.match(unknown, /aria-label="执行计划"/);
  assert.match(unknown, /已完成 1\/4/);
  assert.match(unknown, /上传文件.*失败.*目标暂时不可写.*无法确认的阶段.*状态未知/);
  assert.doesNotMatch(unknown, /data-live=|data-record-enter=/);
  const recoveredInput = { ...input, taskId: null, threadId: 'imported', turnId: 'turn', fromHistory: true as const };
  const recoveredPlan = { ...event, id: 'plan-from-history', taskId: null, threadId: 'imported', fromHistory: true as const };
  const recovered = renderToStaticMarkup(createElement(ConversationFeed, {
    entries: [recoveredInput, recoveredPlan], nodes: [target], projectTimeline: true, onOpen() {},
  }));
  assert.match(recovered, /定位原消息/);
});

test('adjacent native execution logs use the full execution scope, not the tool name', () => {
  const first: ConversationEntry = { ...input, id: 'command-1', direction: 'event', threadId: 'thread-a', turnId: 'turn', messageId: undefined, replyTo: undefined,
    status: 'completed', content: { type: 'commandExecution', command: '同名工具' } };
  const entries = [
    first, { ...first, id: 'command-2', seq: 2 },
    { ...first, id: 'other-thread', seq: 3, threadId: 'thread-b' },
    { ...first, id: 'resumed', seq: 4, threadId: 'thread-b', resumeActionId: 'resume' },
    { ...first, id: 'history-1', seq: 5, taskId: null, threadId: 'unmatched-thread' },
    { ...first, id: 'history-2', seq: 6, taskId: null, threadId: 'unmatched-thread' }
  ];
  const html = renderToStaticMarkup(createElement(ConversationFeed, { entries, nodes: [target], onOpen() {} }));
  const groups = html.split('class="execution-log"').slice(1).map(group => [...group.matchAll(/data-entry-id="([^"]+)"/g)].map(match => match[1]));
  assert.deepEqual(groups, [['command-1', 'command-2'], ['other-thread'], ['resumed'], ['history-1', 'history-2']]);
});

test('native web search labels only observed queries and HTTP origins', () => {
  const event: ConversationEntry = { ...input, id: 'search', direction: 'event', threadId: 'thread', turnId: 'turn', messageId: undefined, replyTo: undefined, text: '', status: 'completed',
    content: { type: 'webSearch', action: { type: 'search', query: '公开索引', queries: ['公开索引', '使用说明'] } } };
  const entries = [event,
    { ...event, id: 'page', seq: 2, content: { type: 'webSearch', action: { type: 'openPage', url: 'https://example.com/archive' } } },
    { ...event, id: 'find', seq: 3, status: 'failed', content: { type: 'webSearch', action: { type: 'find_in_page', pattern: '版本号', url: 'javascript:alert(1)' }, error: '没有匹配文字' } },
    { ...event, id: 'undetailed', seq: 4, content: { type: 'webSearch', action: { type: 'open_page', url: null } } }
  ];
  const html = renderToStaticMarkup(createElement(ConversationFeed, { entries, nodes: [target], onOpen() {} }));
  assert.match(html, /检索记录.*公开索引.*使用说明.*打开页面.*打开来源.*example\.com.*页内查找.*版本号.*没有匹配文字/s);
  assert.match(html, /data-entry-id="undetailed".*检索记录 · 打开页面/s);
  assert.equal((html.match(/>打开来源</g) ?? []).length, 1);
});

test('existing nodes expose explicit collaboration choices without granting unchecked tools or hiding native choices', () => {
  const html = renderToStaticMarkup(createElement(CapabilityFields, { node: source, catalog: { models: [{ id: 'model', name: '可用模型' }], skills: [{ name: '技能', path: 'skill' }], plugins: [{ id: 'plugin', name: '插件能力' }], errors: [] }, onChange() {} }));
  assert.match(html, /<legend>节点协作工具<\/legend>/);
  assert.doesNotMatch(html, /aria-label="(?:send_message|handoff)"/);
  assert.doesNotMatch(html, /节点间传递工具由条件边自动提供/);
  assert.equal((html.match(/checked=""/g) ?? []).length, 0);
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

test('a resumed turn highlights its own native activity and preserves the earlier step as unconfirmed', () => {
  const earlier: ConversationEntry = {
    ...input, id: 'earlier-tool', direction: 'event', turnId: 'first-turn', threadId: 'thread',
    messageId: undefined, replyTo: undefined, status: 'inProgress', text: '',
    content: { type: 'commandExecution', command: 'previous step' },
  };
  const current: ConversationEntry = {
    ...earlier, id: 'current-tool', seq: 2, turnId: 'resumed-turn',
    content: { type: 'commandExecution', command: 'current step' },
  };
  const task: TaskView = {
    id: 'receiving', nodeId: target.id, instruction: '', status: 'running', turnId: 'resumed-turn',
    threadId: 'thread', attempt: 2, input: null, result: null, error: null, createdAt: '', finishedAt: null,
  };
  const html = renderToStaticMarkup(createElement(ConversationFeed, { entries: [earlier, current], nodes: [target], tasks: [task], onOpen() {} }));
  assert.match(html, /previous step<span class="native-status">结果未确认/);
  assert.match(html, /current step<span class="native-status">运行中/);
  assert.equal((html.match(/data-tool-state="active"/g) ?? []).length, 1);
});

test('thread-scoped hooks show their running status only after the current task input', () => {
  const task: TaskView = { id: 'receiving', nodeId: target.id, instruction: '', status: 'running', turnId: 'resumed-turn', threadId: 'thread', attempt: 1, input: null, result: null, error: null, createdAt: '', finishedAt: null };
  const currentInput = { ...input, seq: 2, threadId: task.threadId, turnId: task.turnId };
  const previousHook: ConversationEntry = {
    ...currentInput, id: 'previous-hook', seq: 1, direction: 'event', turnId: '', status: 'inProgress',
    content: { type: 'hookExecution', run: { id: 'previous', status: 'running' } }, messageId: undefined, text: '',
  };
  const currentHook = { ...previousHook, id: 'current-hook', seq: 3, content: { type: 'hookExecution', run: { id: 'current', status: 'running' } } };
  const html = renderToStaticMarkup(createElement(ConversationFeed, { entries: [previousHook, currentInput, currentHook], nodes: [target], tasks: [task], onOpen() {} }));
  const statusFor = (id: string) => html.split(`data-entry-id="${id}"`)[1].split('</article>')[0].match(/class="native-status">([^<]+)/)?.[1];
  assert.equal(statusFor('current-hook'), '运行中');
  assert.equal(statusFor('previous-hook'), '结果未确认');
});

test('saved capabilities with the same name identify which skill or plugin will be removed without a catalog', () => {
  const node = { ...target, skills: [{ name: 'lint', path: 'team-a/lint' }, { name: 'lint', path: 'team-b/lint' }],
    plugins: [{ name: 'review', id: 'review@team-a' }, { name: 'review', id: 'review@team-b' }] };
  const html = renderToStaticMarkup(createElement(CapabilityFields, { node, onChange() {} }));
  for (const [noun, name, id] of [['技能', 'lint', 'team-a/lint'], ['技能', 'lint', 'team-b/lint'], ['插件', 'review', 'review@team-a'], ['插件', 'review', 'review@team-b']]) {
    const label = `${name}（${id}）`;
    assert.ok(html.includes(`aria-label="移除${noun} ${label}"`), `Missing removal action for ${id}`);
    assert.ok(html.includes(`<span class="capability-chip-label">${label}</span>`), `The visible button must identify ${id}`);
  }
});

test('registered message and native imported attachments use existing resource actions', () => {
  const attached = { ...input, attachments: [{ artifact_id: 'a', name: '报告.txt', relativePath: '.mixcat/artifacts/messages/a.txt', size: 3, sha256: 'hash' }] };
  assert.deepEqual(entryResources(attached, 'G:/project'), [{ label: '打开附件：报告.txt', path: 'G:/project/.mixcat/artifacts/messages/a.txt' }]);
  assert.deepEqual(entryResources({ ...input, messageId: undefined, content: [{ type: 'text', text: '附件', mixcatAttachment: { artifact_id: 'host', name: '原稿.txt', path: 'G:/project/.mixcat/attachments/input.txt' } }] }), [{ label: '打开附件：原稿.txt', path: 'G:/project/.mixcat/attachments/input.txt' }]);
  const html = renderToStaticMarkup(createElement(ConversationFeed, { entries: [attached], nodes: [source, target], projectRoot: 'G:/project', onOpen() {} }));
  assert.match(html, /打开附件：报告.txt/);
});

test('free message JSON stays opaque in node and project feeds, with registered attachments', () => {
  const bodies = [{ changes: { filename: 'report.md' } }, { result: { content: 3 } }, { changes: [null] },
    { input: [null, { type: 'resource_link', name: { business: true }, uri: 'https://example.test/business' }] },
    { changes: null, result: null }, { changes: 'business', result: { content: [null] } },
    { type: 'localImage', path: 'G:/business.png', mixcatAttachment: { name: 'business', path: 'G:/business.txt' } }];
  for (const content of bodies) for (const projectTimeline of [false, true]) for (const registered of [false, true]) {
    const entry = { ...input, content, text: JSON.stringify(content, null, 2), attachments: registered ? [{ artifact_id: 'a', name: 'registered.txt', relativePath: '.mixcat/artifacts/messages/a.txt', size: 3, sha256: 'hash' }] : [] };
    const before = structuredClone(entry);
    const html = renderToStaticMarkup(createElement(ConversationFeed, { entries: [entry], nodes: [source, target], projectTimeline, projectRoot: 'G:/project', onOpen() {} }));
    const text = renderToStaticMarkup(createElement('p', null, entry.text));
    assert.ok(html.includes(text)); assert.deepEqual(entry, before);
    assert.deepEqual(entryResources(entry, 'G:/project'), registered ? [{ label: '打开附件：registered.txt', path: 'G:/project/.mixcat/artifacts/messages/a.txt' }] : []);
    assert.equal((html.match(/class="resource-actions"/g) ?? []).length, Number(registered));
    if (projectTimeline) assert.match(html, /aria-label="项目会话历史"/);
  }
});

test('native resource extraction validates nested arrays, elements and labels', () => {
  for (const content of [{ changes: {} }, { changes: [null, false, { path: 'G:/native.txt' }] }, { result: { content: 3 } },
    { result: { content: [null, { type: 'resource_link', name: {}, uri: 'https://example.test/native' }] } }]) {
    const entry = { ...input, messageId: undefined, direction: 'event' as const, content };
    assert.doesNotThrow(() => renderToStaticMarkup(createElement(ConversationFeed, { entries: [entry], nodes: [source, target], onOpen() {} })));
  }
  assert.deepEqual(entryResources({ ...input, messageId: undefined, content: { changes: [null, { path: 'G:/native.txt' }], result: { content: [null, { type: 'resource_link', name: 'native', uri: 'https://example.test/native' }] } } }), [
    { label: '查看文件', path: 'G:/native.txt' }, { label: 'native', url: 'https://example.test/native' },
  ]);
});

test('sender body is distinguished from its original receipt event even for empty and falsy content', () => {
  for (const [content, markup] of [[null, '<p>null</p>'], [false, '<p>false</p>'], [0, '<p>0</p>'], ['', '<p></p>'], [' 原文\n ', '<p> 原文\n </p>'], [{ free: false }, '&quot;free&quot;: false']] as const) {
    const entry = { ...input, nodeId: source.id, direction: 'event' as const, text: '原始发送事件', content: { type: 'messageSent', reason: '原始原因' }, sentMessage: { content } };
    const html = renderToStaticMarkup(createElement(ConversationFeed, { entries: [entry], nodes: [source, target], messages: [message], onOpen() {} }));
    assert.match(html, /发送正文/); assert.match(html, /原始发送事件/); assert.match(html, /原始记录/);
    assert.ok(html.includes(markup), html);
  }
});

test('legacy message and handoff routes do not create canvas lines or rewrite saved history', () => {
  const snapshot = { nodes: [source, target], edges: [{ id: 'configured', sourceNodeId: source.id, targetNodeId: target.id, condition: '已配置条件', revision: 1 }],
    handoffs: [{ id: 'legacy', fromNodeId: target.id, toNodeId: source.id }], messages: [message, { ...message, message_id: 'off-route', fromNodeId: target.id, toNodeId: source.id }], conversation: [input] };
  const original = structuredClone(snapshot);
  const edges = toWorkflowEdges(snapshot.edges, snapshot.nodes, () => {});
  assert.deepEqual(edges.map(edge => [edge.id, edge.source, edge.target]), [['definition:configured', source.id, target.id]]);
  assert.deepEqual(toWorkflowEdges([], snapshot.nodes, () => {}), []);
  assert.deepEqual(snapshot, original);
});
