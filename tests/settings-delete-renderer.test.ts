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
  return renderToStaticMarkup(createElement(Workbench, { snapshot, runtime: null, execute: async () => null, busy: false, error: null, onError() {} }));
}

test('settings navigation is available before any project is opened', () => {
  const html = renderToStaticMarkup(createElement(App));
  assert.match(html.match(/<nav class="icon-rail"[^>]*>.*?<\/nav>/)?.[0] ?? '', /<button[^>]*aria-label="设置"/);
  assert.doesNotMatch(html.match(/<aside class="workspace-sidebar"[^>]*>.*?<\/aside>/)?.[0] ?? '', /aria-label="设置"/);
});

test('project sidebar shows its list without a heading or creation row', () => {
  const html = renderToStaticMarkup(createElement(App));
  const sidebar = html.match(/<aside class="workspace-sidebar"[^>]*>.*?<\/aside>/)?.[0] ?? '';
  assert.match(sidebar, /<ul[^>]*aria-label="项目列表"/);
  assert.doesNotMatch(sidebar, /<h2>项目<\/h2>|aria-label="新建项目"/);
});

test('workspace sidebar has no global brand block', () => {
  const html = renderToStaticMarkup(createElement(App));
  const sidebar = html.match(/<aside class="workspace-sidebar"[^>]*>.*?<\/aside>/)?.[0] ?? '';
  assert.match(sidebar, /aria-label="当前模块"/);
  assert.doesNotMatch(sidebar, /class="brand"|<strong>mixcat<\/strong>/);
});

test('workspace modules use distinct font-independent SVG icons at the same size', () => {
  const html = renderToStaticMarkup(createElement(App));
  const rail = html.match(/<nav class="icon-rail"[^>]*>.*?<\/nav>/)?.[0] ?? '';
  const paths = new Set<string>();
  for (const label of ['项目', '信息流', '笔记', '知识库']) {
    const button = rail.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>(.*?)</button>`))?.[1] ?? '';
    assert.match(button, /<svg width="20" height="20" viewBox="0 0 24 24"/, `${label} uses the shared 20px SVG`);
    assert.match(button, /aria-hidden="true"/);
    assert.doesNotMatch(button, /[▥▤◫]/);
    paths.add(button.match(/<path d="([^"]+)"/)?.[1] ?? '');
  }
  assert.equal(paths.size, 4, 'each module has a distinct shape');
});
test('selected idle node exposes run controls without a delete or login button in the drawer', () => {
  const html = workbench(project);
  assert.match(html, /<button[^>]*>暂停节点<\/button>/);
  assert.match(html, /<button[^>]*>启用节点<\/button>/);
  assert.doesNotMatch(html, /<button[^>]*>(?:删除节点|登录)<\/button>/);
});
test('task and approval states keep deletion actions and their explanations out of the drawer', () => {
  for (const status of ['running', 'paused', 'queued', 'waiting_source', 'needs_reconciliation'] as const) {
    const html = workbench({ ...project, tasks: [{ id: status, nodeId: node.id, status } as TaskView] });
    assert.doesNotMatch(html, /删除节点|节点仍有未完成任务/, status);
  }
  const awaitingApproval = workbench({ ...project, requests: [{ key: 'approval', nodeId: node.id } as any] });
  assert.doesNotMatch(awaitingApproval, /删除节点|节点仍有原生请求待回应/);
  assert.match(awaitingApproval, /<header class="project-header">.*?1 个请求待回应.*?<\/header>/);
  assert.doesNotMatch(workbench({ ...project, tasks: [{ nodeId: node.id, status: 'completed' } as TaskView] }), /删除节点/);
});
test('empty workflow keeps canvas operations available without adding toolbar buttons', () => {
  const html = workbench({ ...project, nodes: [] });
  const header = html.match(/<header class="project-header">.*?<\/header>/)?.[0] ?? '';
  assert.doesNotMatch(header, /添加节点|项目会话历史/);
  assert.match(header, /停止本轮<\/button>(?:<\/div>)?<button[^>]*>重置工作流<\/button>/);
  assert.match(html, /工作流画布，Shift\+F10 打开画布菜单/);
  assert.match(html, /添加一个会话节点/);
  assert.doesNotMatch(html, /删除节点/);
});
test('project history identifies archived nodes even when native output includes an author name', () => {
  const html = renderToStaticMarkup(createElement(ConversationFeed, { entries: [{ id: 'entry', seq: 1, nodeId: node.id, taskId: null, threadId: 'thread', turnId: null, itemId: null, direction: 'output', source: { kind: 'node', name: 'Native author' }, text: 'Saved original', content: null, createdAt: '' }], nodes: [{ ...node, name: 'First（已移除）' }], projectTimeline: true, onOpen() {} }));
  assert.match(html, /First（已移除）/);
  assert.match(html, /Native author/);
});
