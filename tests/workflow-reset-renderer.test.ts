import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Workbench } from '../src/renderer/Workbench.js';
import type { NodeView, ProjectSnapshot, TaskView } from '../src/shared/types.js';

const node: NodeView = { id: 'one', name: 'First', instructions: '', tools: [], resultSchema: {}, position: { x: 0, y: 0 }, revision: 1, threadId: null, status: 'idle' };
const project: ProjectSnapshot = { project: { id: 'p', name: 'Project', root: 'G:/fixture', goal: 'Goal', status: 'idle', mode: 'codex', updatedAt: '' }, nodes: [node], tasks: [], handoffs: [], activities: [] };
function render(snapshot = project, busy = false, pendingExecution = false) {
  return renderToStaticMarkup(createElement(Workbench, { snapshot, runtime: null, execute: async () => null, busy, pendingExecution, error: null, onError() {} }));
}

test('workflow reset is available for idle and finished sessions including an empty graph', () => {
  for (const tasks of [[], ...(['completed', 'failed', 'cancelled'] as const).map(status => [{ id: status, nodeId: node.id, status } as TaskView])]) {
    const html = render({ ...project, tasks });
    assert.match(html, /<button[^>]*>重置工作流<\/button>/);
    assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>重置工作流<\/button>/);
  }
  assert.match(render({ ...project, nodes: [] }), /<button[^>]*>重置工作流<\/button>/);
});

test('workflow reset explains and blocks unfinished tasks, transitions, native requests and pending submissions', () => {
  const unfinished = (['running', 'paused', 'queued', 'waiting_source', 'waiting_review', 'needs_reconciliation'] as const).map(status => ({ ...project, tasks: [{ id: status, nodeId: node.id, status } as TaskView] }));
  const transitions = (['starting', 'running', 'pausing', 'resuming'] as const).map(status => ({ ...project, nodes: [{ ...node, status }] }));
  const requesting = { ...project, requests: [{ key: 'approval', nodeId: null } as any] };
  for (const snapshot of [...unfinished, ...transitions, requesting]) {
    const html = render(snapshot);
    assert.match(html, /<button[^>]*disabled=""[^>]*title="[^"]*(?:停止|处理|核对)[^"]*"[^>]*>重置工作流<\/button>/);
  }
  assert.match(render(project, true), /<button[^>]*disabled=""[^>]*>重置工作流<\/button>/);
  assert.match(render(project, false, true), /<button[^>]*disabled=""[^>]*>重置工作流<\/button>/);
});
