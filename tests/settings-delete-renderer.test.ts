import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import App from '../src/renderer/App.js';
import { Workbench } from '../src/renderer/Workbench.js';
import { ConversationFeed } from '../src/renderer/Conversation.js';
import type { NodeView, ProjectSnapshot, TaskView } from '../src/shared/types.js';

const node: NodeView = { id: 'one', name: 'First', instructions: '', tools: [], resultSchema: {}, position: { x: 0, y: 0 }, revision: 1, threadId: null, status: 'idle' };
const project: ProjectSnapshot = { project: { id: 'p', name: 'Project', root: 'G:/fixture', goal: 'Goal', status: 'idle', mode: 'codex', updatedAt: '' }, nodes: [node], tasks: [], handoffs: [], activities: [] };
function workbench(snapshot: ProjectSnapshot) {
  return renderToStaticMarkup(createElement(Workbench, { snapshot, runtime: null, execute: async () => null, busy: false, error: null, onBack() {}, onError() {} }));
}

test('settings navigation is available before any project is opened', () => {
  const html = renderToStaticMarkup(createElement(App));
  assert.match(html, /<aside class="icon-rail"[^>]*>.*?<button[^>]*aria-label="设置"/);
  assert.doesNotMatch(html, /<nav[^>]*>.*?设置.*?<\/nav>/);
});
test('selected idle node exposes deletion without a project login action', () => {
  const html = workbench(project);
  assert.match(html, /<button[^>]*>删除节点<\/button>/);
  assert.doesNotMatch(html, /<button[^>]*>登录<\/button>/);
});
test('unfinished task and native approval prevent node deletion, while finished tasks allow it', () => {
  for (const status of ['running', 'paused', 'queued', 'waiting_source', 'needs_reconciliation'] as const) {
    const html = workbench({ ...project, tasks: [{ id: status, nodeId: node.id, status } as TaskView] });
    assert.match(html, /<button[^>]*disabled=""[^>]*>删除节点<\/button>/, status);
    assert.match(html, /停止本轮|核对/);
  }
  assert.match(workbench({ ...project, requests: [{ key: 'approval', nodeId: node.id } as any] }), /<button[^>]*disabled=""[^>]*>删除节点<\/button>/);
  assert.doesNotMatch(workbench({ ...project, tasks: [{ nodeId: node.id, status: 'completed' } as TaskView] }), /<button[^>]*disabled=""[^>]*>删除节点<\/button>/);
});
test('zero active nodes keeps project history and add controls accessible', () => {
  const html = workbench({ ...project, nodes: [] });
  assert.match(html, /项目会话历史/);
  assert.match(html, /添加节点/);
  assert.match(html, /添加一个会话节点/);
  assert.doesNotMatch(html, /删除节点/);
});
test('project history identifies archived nodes even when native output includes an author name', () => {
  const html = renderToStaticMarkup(createElement(ConversationFeed, { entries: [{ id: 'entry', seq: 1, nodeId: node.id, taskId: null, threadId: 'thread', turnId: null, itemId: null, direction: 'output', source: { kind: 'node', name: 'Native author' }, text: 'Saved original', content: null, createdAt: '' }], nodes: [{ ...node, name: 'First（已移除）' }], projectTimeline: true, onOpen() {} }));
  assert.match(html, /First（已移除）/);
  assert.match(html, /Native author/);
});
