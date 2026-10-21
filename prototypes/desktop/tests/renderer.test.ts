import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { activityLabel, NodeConfig, parseResultSchema, toWorkflowEdges } from '../src/renderer/App.js';
import type { HandoffView, NodeView, ProjectSnapshot, TaskView } from '../src/shared/types.js';
import { Workbench } from '../src/renderer/Workbench.js';
import { ConversationFeed, entryResources, orderedConversation } from '../src/renderer/Conversation.js';
import { NativeRequestCard } from '../src/renderer/NativeRequests.js';
import type { ConversationEntry, PendingNativeRequest } from '../src/shared/types.js';

test('result schema editor rejects invalid JSON and non-object contracts', () => {
  assert.deepEqual(parseResultSchema('{"type":"object"}'), { type: 'object' });
  for (const value of ['[1]', 'null', '{']) assert.throws(() => parseResultSchema(value));
});
test('feedback uses distinct handles and does not change when nodes move', () => {
  const nodes: NodeView[] = ['a', 'b'].map((id, i) => ({ id, name: id, instructions: id, tools: ['get_project_context'], resultSchema: {}, position: { x: i * 300, y: 100 }, revision: 1, threadId: null, status: 'idle' }));
  const handoffs: HandoffView[] = [['a', 'b'], ['b', 'a'], ['a', 'b']].map(([fromNodeId, toNodeId], i) => ({ id: String(i), sourceTaskId: String(i), fromNodeId, toNodeId, task: 'test', reason: 'test', result: {}, status: 'delivered', createdAt: new Date(i).toISOString() }));
  const edges = toWorkflowEdges(handoffs, nodes); assert.equal(edges.length, 2); assert.equal(edges[0].label, '2 次交接'); assert.equal(edges[1].label, '回流'); assert.equal(edges[1].sourceHandle, 'return-source'); assert.equal(edges[1].targetHandle, 'return-target');
  const moved = toWorkflowEdges(handoffs, nodes.map(n => ({ ...n, position: { x: -n.position.x, y: 400 } })));
  assert.deepEqual(moved, edges);
});
test('internal activity ids are rendered as meaningful labels', () => {
  assert.equal(activityLabel('message:some-internal-id'), 'Agent'); assert.equal(activityLabel('control'), '运行控制'); assert.equal(activityLabel('unrecognized'), '工作流记录');
});

test('node configuration explains pending tasks before saving while keeping drafts editable', () => {
  const node: NodeView = { id: 'a', name: '执行', instructions: '完成任务', tools: ['get_project_context'], resultSchema: {}, position: { x: 0, y: 0 }, revision: 1, threadId: 'thread-a', status: 'blocked' };
  const render = (status: TaskView['status'], nodeId = node.id, busy = false) => {
    const task: TaskView = { id: 'task-a', nodeId, instruction: '任务', status, turnId: 'turn-a', threadId: 'thread-a', attempt: 1, input: {}, result: null, error: null, createdAt: '2026-10-19T00:00:00.000Z', finishedAt: null };
    return renderToStaticMarkup(createElement(NodeConfig, { node, tasks: [task], busy, onSave: async () => node, onError: () => {} }));
  };
  for (const status of ['running', 'paused', 'queued', 'waiting_source', 'needs_reconciliation'] as const) {
    const html = render(status);
    assert.match(html, /<button[^>]*disabled=""[^>]*>保存配置<\/button>/, status);
    assert.match(html, /可继续编辑草稿/, status);
    assert.doesNotMatch(html, /<(?:input|textarea|fieldset)[^>]*disabled=/, status);
    assert.match(html, status === 'needs_reconciliation' ? /会话.*核对/ : /等待.*结束.*停止本轮/, status);
  }
  for (const status of ['failed', 'completed', 'cancelled'] as const) assert.doesNotMatch(render(status), /<button[^>]*disabled=""[^>]*>保存配置<\/button>/, status);
  assert.doesNotMatch(render('running', 'another-node'), /可继续编辑草稿/);
  assert.match(render('completed', node.id, true), /<button[^>]*disabled=""[^>]*>保存中…<\/button>/);
});

function renderControls(states: NodeView['status'][], projectStatus: ProjectSnapshot['project']['status'], resumeNodeIds: string[] = [], busy = false, tasks: TaskView[] = []) {
  const nodes: NodeView[] = states.map((status, index) => ({ id: `node-${index}`, name: `会话 ${index + 1}`, instructions: '', tools: ['get_project_context'], resultSchema: {}, position: { x: 0, y: 0 }, revision: 1, threadId: null, status }));
  const snapshot: ProjectSnapshot = { project: { id: 'project', name: '暂停测试', root: 'G:/project', goal: '状态真实可见', status: projectStatus, mode: 'demo', updatedAt: '2026-10-19T00:00:00.000Z' }, nodes, tasks, handoffs: [], activities: [], resumeNodeIds };
  return renderToStaticMarkup(createElement(Workbench, { snapshot, runtime: null, execute: async () => null, busy, error: null, onBack: () => {}, onError: () => {} }));
}

function controlDisabled(html: string, label: string) {
  const attributes = html.match(new RegExp(`<button([^>]*)>${label}</button>`))?.[1];
  assert.notEqual(attributes, undefined, `Missing ${label}`);
  return /\bdisabled=""/.test(attributes!);
}

test('project and node controls stay visible and report actual node states independently', () => {
  const states: NodeView['status'][] = ['running', 'queued', 'queued', 'starting', 'pausing', 'resuming', 'paused', 'blocked', 'idle', 'completed'];
  const html = renderControls(states, 'running', ['node-4', 'node-6', 'node-8']);
  for (const label of ['全部暂停', '全部开启', '暂停节点', '启用节点']) assert.ok(html.includes(`>${label}</button>`));
  for (const [status, count] of [['running', 1], ['queued', 2], ['starting', 1], ['pausing', 1], ['resuming', 1], ['paused', 1], ['blocked', 1], ['idle', 1], ['completed', 1]]) {
    assert.match(html, new RegExp(`data-node-status="${status}"[^>]*>[^<]*<strong>${count}</strong>`));
  }
  assert.match(html, /全部开启可恢复运行 2 个节点/);
  assert.equal(controlDisabled(html, '全部暂停'), false);
  assert.equal(controlDisabled(html, '全部开启'), false);
  assert.equal(controlDisabled(html, '暂停节点'), false);
  assert.equal(controlDisabled(html, '启用节点'), true);
});

test('node controls override project pause and in-flight opposite requests without waking idle nodes', () => {
  const globallyPaused = renderControls(['paused', 'paused'], 'paused', ['node-0']);
  assert.equal(controlDisabled(globallyPaused, '全部暂停'), true);
  assert.equal(controlDisabled(globallyPaused, '全部开启'), false);
  assert.equal(controlDisabled(globallyPaused, '启用节点'), false);
  assert.match(globallyPaused, /消息将排队，启用节点后处理/);
  const pausedTask: TaskView = { id: 'paused-task', nodeId: 'node-0', instruction: '待续接', status: 'paused', turnId: 'turn', threadId: 'thread', attempt: 1, input: {}, result: null, error: null, createdAt: '2026-10-19T00:00:00.000Z', finishedAt: null };
  const individuallyPaused = renderControls(['paused', 'running'], 'running', [], false, [pausedTask]);
  assert.equal(controlDisabled(individuallyPaused, '全部开启'), true);
  assert.equal(controlDisabled(individuallyPaused, '启用节点'), false);
  const pausing = renderControls(['pausing'], 'pausing', ['node-0']);
  assert.equal(controlDisabled(pausing, '启用节点'), false);
  assert.equal(controlDisabled(pausing, '暂停节点'), true);
  assert.match(pausing, /正在等待原生轮次停止/);
  assert.match(pausing, /data-node-status="running"[^>]*>运行中 <strong>0<\/strong>/);
  assert.equal(controlDisabled(pausing, '连接 Codex'), true);
  const resuming = renderControls(['resuming'], 'running');
  assert.equal(controlDisabled(resuming, '暂停节点'), false);
  assert.equal(controlDisabled(resuming, '启用节点'), true);
  assert.match(resuming, /已请求启用，等待原生轮次停止后续接/);
  assert.equal(controlDisabled(renderControls(['idle'], 'idle', ['node-0']), '全部开启'), true);
  assert.equal(controlDisabled(renderControls(['running'], 'paused'), '暂停节点'), false);
});

test('global enable restores idle readiness without counting it as resumed execution', () => {
  const html = renderControls(['paused'], 'paused');
  assert.equal(controlDisabled(html, '全部开启'), false);
  assert.match(html, /全部开启可恢复运行 0 个节点/);
  assert.match(html, /data-node-status="running"[^>]*>运行中 <strong>0<\/strong>/);
  for (const status of ['queued', 'waiting_source', 'paused', 'running', 'needs_reconciliation'] as const) {
    const task: TaskView = { id: 'pending-task', nodeId: 'node-0', instruction: '尚未处理', status, turnId: null, threadId: null, attempt: 1, input: {}, result: null, error: null, createdAt: '2026-10-19T00:00:00.000Z', finishedAt: null };
    assert.equal(controlDisabled(renderControls(['paused'], 'paused', [], false, [task]), '全部开启'), true, status);
  }
});

test('conversation distinguishes input provenance from output and orders project history stably', () => {
  const nodes: NodeView[] = ['plan', 'implement'].map(id => ({ id, name: id === 'plan' ? '规划' : '执行', instructions: '', tools: ['get_project_context'], resultSchema: {}, position: { x: 0, y: 0 }, revision: 1, threadId: id, status: 'idle' }));
  const base = { nodeId: 'implement', taskId: 'task', threadId: 'implement', turnId: 'turn', itemId: null, createdAt: '2026-10-19T10:00:00.000Z' };
  const entries: ConversationEntry[] = [
    { ...base, id: 'out', seq: 2, direction: 'output', source: null, text: '完整输出', content: { type: 'agentMessage', text: '完整输出' } },
    { ...base, id: 'in', seq: 1, direction: 'input', source: { kind: 'node', nodeId: 'plan', name: '规划' }, text: '原始要求', content: [] },
  ];
  assert.deepEqual(orderedConversation(entries).map(e => e.id), ['in', 'out']);
  const html = renderToStaticMarkup(createElement(ConversationFeed, { entries, nodes, projectTimeline: true, onOpen: () => {} }));
  assert.match(html, /chat-input/); assert.match(html, /chat-output/); assert.match(html, /规划 → 执行/);
  assert.ok(html.indexOf('原始要求') < html.indexOf('完整输出'));
  assert.deepEqual(entryResources({ ...entries[1], content: { input: [{ type: 'localImage', path: 'G:/project/art.png' }], native: { type: 'userMessage' } } }), [{ label: '打开附件', path: 'G:/project/art.png' }]);
});

test('native approvals expose only the decisions actually offered by the server', () => {
  const request: PendingNativeRequest = { id: 4, key: 'request-4', projectId: 'project', nodeId: 'node', method: 'item/commandExecution/requestApproval', params: { command: 'example command', availableDecisions: ['decline'] } };
  const html = renderToStaticMarkup(createElement(NativeRequestCard, { request, onRespond: async () => {}, onError: () => {} }));
  assert.match(html, /拒绝/); assert.doesNotMatch(html, /批准这次操作|批准本会话/);
  const withAccept = renderToStaticMarkup(createElement(NativeRequestCard, { request: { ...request, params: { ...request.params, availableDecisions: ['accept', 'decline'] } }, onRespond: async () => {}, onError: () => {} }));
  assert.match(withAccept, /批准这次操作/);
});
