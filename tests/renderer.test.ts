import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NewNodeForm, NodeConfig } from '../src/renderer/NodeSettings.js';
import { Workbench, relatedNodePosition, toWorkflowEdges } from '../src/renderer/Workbench.js';
import type { HandoffView, NodeView, TaskView } from '../src/shared/types.js';

const node: NodeView = { id: 'source', name: 'Source', instructions: '自由职责', tools: ['handoff'], resultSchema: {}, position: { x: 0, y: 0 }, revision: 1, threadId: 'thread', status: 'running' };
test('associated initial placement avoids occupied bounds and leaves free candidates unchanged', () => {
  const candidate = { x: 360, y: 160 };
  const occupied = [{ position: { x: 380, y: 160 }, measured: { width: 215, height: 190 } }];
  assert.deepEqual(relatedNodePosition(candidate, occupied), { x: 360, y: 390 });
  assert.deepEqual(relatedNodePosition({ x: 1000, y: 160 }, occupied), { x: 1000, y: 160 });
  assert.deepEqual(occupied, [{ position: { x: 380, y: 160 }, measured: { width: 215, height: 190 } }]);
});

test('query busy does not disable node or project controls, including stop during pending send', () => {
  for (const status of ['running', 'pausing', 'resuming', 'paused', 'idle'] as const) {
    const html = renderToStaticMarkup(createElement(Workbench, { snapshot: { project: { id: 'p', name: 'p', root: 'G:/fixture', goal: 'g', status: status === 'resuming' ? 'running' : status, mode: 'codex', updatedAt: '' }, nodes: [{ ...node, status }], tasks: [], handoffs: [], activities: [], resumeNodeIds: ['source'] }, runtime: null, execute: async () => null, busy: true, error: null, onBack() {}, onError() {} }));
    assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>停止本轮/);
    if (!['paused', 'pausing'].includes(status)) assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>暂停节点/);
    if (['paused', 'pausing'].includes(status)) assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>启用节点/);
  }
});
test('creation exposes actual name, model, skills, plugins, instructions and natural condition controls', () => {
  const html = renderToStaticMarkup(createElement(NewNodeForm, { position: node.position, relatedName: node.name, catalog: { models: [{ id: 'model', name: 'Chosen model' }], skills: [{ path: 'G:/fixture/skill', name: 'Skill' }], plugins: [{ id: 'plugin@fixture', name: 'Plugin' }], errors: [] }, loading: false, busy: false, onReload() {}, async onSave() {} }));
  for (const label of ['节点名称', '职责与指令', 'Chosen model', 'Skill', 'Plugin', '关联条件', '创建关联节点']) assert(html.includes(label));
});
test('pending and reconciliation tasks keep editable config draft but disable saving', () => {
  for (const status of ['running', 'paused', 'queued', 'waiting_source', 'needs_reconciliation'] as const) {
    const html = renderToStaticMarkup(createElement(NodeConfig, { node, tasks: [{ nodeId: node.id, status } as TaskView], busy: false, onSave: async () => node, onError() {} }));
    assert.match(html, /<button class="button primary" disabled="">保存配置/);
    assert.match(html, /<input required="" maxLength="80" value="Source"/);
    assert.match(html, /可继续编辑草稿/);
  }
});
test('actual handoff lines come only from history, preserve return and repeated route meaning', () => {
  const nodes = [node, { ...node, id: 'target' }];
  const handoff = (id: string, fromNodeId: string, toNodeId: string) => ({ id, fromNodeId, toNodeId } as HandoffView);
  assert.deepEqual(toWorkflowEdges([], nodes), []);
  const edges = toWorkflowEdges([handoff('1', 'source', 'target'), handoff('2', 'source', 'target'), handoff('3', 'target', 'source'), handoff('4', 'missing', 'source')], nodes);
  assert.deepEqual(edges.map(edge => edge.label), ['2 次交接', '回流']);
  assert.equal(edges[1].sourceHandle, 'return-source');
});
