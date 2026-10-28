import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CapabilityFields, NewNodeForm, NodeConfig } from '../src/renderer/NodeSettings.js';
import { panelAddress } from '../src/renderer/NodePanels.js';
import { Workbench, relatedNodePosition, toWorkflowEdges } from '../src/renderer/Workbench.js';
import type { NodeView, TaskView, WorkflowEdge } from '../src/shared/types.js';

const node: NodeView = { id: 'source', name: 'Source', instructions: '自由职责', tools: ['handoff'], resultSchema: {}, position: { x: 0, y: 0 }, revision: 1, threadId: 'thread', status: 'running' };
test('panel addresses support local previews without rewriting explicit unsupported schemes', () => {
  assert.equal(panelAddress(' localhost:5173/settings '), 'http://localhost:5173/settings');
  assert.equal(panelAddress('127.0.0.1:3000'), 'http://127.0.0.1:3000');
  assert.equal(panelAddress('[::1]:8080/a'), 'http://[::1]:8080/a');
  assert.equal(panelAddress('example.com/page'), 'https://example.com/page');
  assert.equal(panelAddress('http://example.com'), 'http://example.com');
  for (const value of ['file:///G:/test', 'javascript:alert(1)', 'data:text/plain,hello']) assert.equal(panelAddress(value), value);
});

test('associated initial placement avoids occupied bounds and leaves free candidates unchanged', () => {
  const candidate = { x: 360, y: 160 };
  const occupied = [{ position: { x: 380, y: 160 }, measured: { width: 215, height: 190 } }];
  assert.deepEqual(relatedNodePosition(candidate, occupied), { x: 360, y: 390 });
  assert.deepEqual(relatedNodePosition({ x: 1000, y: 160 }, occupied), { x: 1000, y: 160 });
  assert.deepEqual(occupied, [{ position: { x: 380, y: 160 }, measured: { width: 215, height: 190 } }]);
});

test('query busy does not disable node or project controls, including stop during pending send', () => {
  for (const status of ['running', 'pausing', 'resuming', 'paused', 'idle'] as const) {
    const html = renderToStaticMarkup(createElement(Workbench, { snapshot: { project: { id: 'p', name: 'p', root: 'G:/fixture', goal: 'g', status: status === 'resuming' ? 'running' : status, mode: 'codex', updatedAt: '' }, nodes: [{ ...node, status }], tasks: [], handoffs: [], activities: [], resumeNodeIds: ['source'] }, runtime: null, execute: async () => null, busy: true, pendingExecution: status === 'idle', error: null, onError() {} }));
    assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>停止本轮/);
    if (!['paused', 'pausing'].includes(status)) assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>暂停节点/);
    if (['paused', 'pausing'].includes(status)) assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>启用节点/);
  }
});

test('read busy does not enable Stop for inactive projects', () => {
  for (const status of ['idle', 'completed'] as const) for (const busy of [false, true]) {
    const html = renderToStaticMarkup(createElement(Workbench, { snapshot: { project: { id: 'p', name: 'p', root: 'G:/fixture', goal: 'g', status, mode: 'codex', template: 'web-product', updatedAt: '' }, nodes: [{ ...node, status }], tasks: [], handoffs: [], activities: [] }, runtime: null, execute: async () => null, busy, pendingExecution: false, error: null, onError() {} }));
    assert.match(html, /<button[^>]*disabled=""[^>]*>停止本轮/);
  }
});

test('web workflow toolbar omits the recommendation configuration action', () => {
  const html = renderToStaticMarkup(createElement(Workbench, { snapshot: { project: { id: 'p', name: 'p', root: 'G:/fixture', goal: 'g', status: 'idle', mode: 'codex', template: 'web-product', updatedAt: '' }, nodes: [], tasks: [], handoffs: [], activities: [] }, runtime: null, execute: async () => null, busy: false, error: null, onError() {} }));
  assert.doesNotMatch(html, /配置推荐能力/);
});
test('creation exposes actual name, model, skills, plugins, instructions and natural condition controls', () => {
  const html = renderToStaticMarkup(createElement(NewNodeForm, { position: node.position, relatedName: node.name, catalog: { models: [{ id: 'model', name: 'Chosen model' }], skills: [{ path: 'G:/fixture/skill', name: 'Skill' }], plugins: [{ id: 'plugin@fixture', name: 'Plugin' }], errors: [] }, loading: false, busy: false, onReload() {}, async onSave() {} }));
  for (const label of ['节点名称', '职责与指令', 'Chosen model', 'Skill', 'Plugin', '关联条件', '创建关联节点']) assert(html.includes(label));
});
test('model choices require a concrete catalog or saved model and show discovery gaps', () => {
  const catalog = { models: [{ id: 'other', name: 'Other model' }, { id: 'default-id', name: 'Actual default', isDefault: true }], skills: [], plugins: [], errors: [] };
  const html = renderToStaticMarkup(createElement(CapabilityFields, { node: { ...node, model: null }, catalog, onChange() {} }));
  assert.doesNotMatch(html, /原生默认/);
  assert.match(html, /<select[^>]*required=""/);
  assert.match(html, /<option value="" disabled="" hidden="" selected="">选择模型<\/option>/);
  assert.match(html, /<option value="default-id">Actual default · 默认<\/option>/);
  const saved = renderToStaticMarkup(createElement(CapabilityFields, { node: { ...node, model: 'saved-id' }, catalog, onChange() {} }));
  assert.match(saved, /<option value="saved-id" selected="">saved-id<\/option>/);
  const offline = renderToStaticMarkup(createElement(CapabilityFields, { node: { ...node, model: null }, catalog: null, onChange() {} }));
  assert.doesNotMatch(offline, /<select[^>]*disabled=""/);
  assert.doesNotMatch(offline, /原生默认/);
  assert.match(offline, /未获取到可用模型/);
  const loading = renderToStaticMarkup(createElement(CapabilityFields, { node: { ...node, model: null }, catalog: null, loading: true, onChange() {} }));
  assert.match(loading, /正在读取模型/);
});

test('node configuration omits plan and runtime status while exposing capability choices and errors', () => {
  const html = renderToStaticMarkup(createElement(CapabilityFields, { node, catalog: {
    models: [], skills: [], plugins: [], errors: ['GitNexus 尚未发现'],
    mcpServers: [{ name: 'browser', status: 'connected', toolCount: 3 }, { name: 'gitnexus', status: 'failed', toolCount: 0 }],
    hooks: [{ eventName: 'Stop', enabled: true, trustStatus: 'untrusted', key: 'hook', sourcePath: 'G:/internal/hooks.json', currentHash: 'hash' }],
  }, onChange() {}, onReload() {} }));
  for (const text of ['GitNexus 尚未发现', 'Skills', '插件', '节点协作工具', '刷新可用能力']) assert(html.includes(text));
  assert.doesNotMatch(html, /计划 ID|节点使用的技能与插件|MCP 与 hooks 状态|browser|本轮结束|待信任|G:\/internal\/hooks.json|hash/);
  const config = renderToStaticMarkup(createElement(NodeConfig, { node: { ...node, planId: 'mvp-001' }, tasks: [], busy: false, onSave: async () => node, onError() {}, onDraftChange() {}, onSaved() {} }));
  assert.doesNotMatch(config, /计划 ID|mvp-001|MCP 与 hooks 状态/);
  const creation = renderToStaticMarkup(createElement(NewNodeForm, { position: node.position, catalog: null, loading: false, busy: false, onReload() {}, async onSave() {} }));
  assert.doesNotMatch(creation, /原生默认|计划 ID|节点使用的技能与插件|MCP 与 hooks 状态/);
});

test('pending and reconciliation tasks keep editable config draft but disable saving', () => {
  for (const status of ['running', 'paused', 'queued', 'waiting_source', 'needs_reconciliation'] as const) {
    const html = renderToStaticMarkup(createElement(NodeConfig, { node, tasks: [{ nodeId: node.id, status } as TaskView], busy: false, onSave: async () => node, onError() {}, onDraftChange() {}, onSaved() {} }));
    assert.match(html, /<button class="button primary" disabled="">保存配置/);
    assert.match(html, /<input required="" maxLength="80" value="Source"/);
    assert.match(html, /可继续编辑草稿/);
  }
});
test('canvas edges come only from saved conditions and preserve independent routes and editing', () => {
  const nodes = [node, { ...node, id: 'target' }];
  const definition = (id: string, sourceNodeId: string, targetNodeId: string): WorkflowEdge => ({ id, sourceNodeId, targetNodeId, condition: id, revision: 1 });
  const definitions = [definition('forward', 'source', 'target'), definition('alternate', 'source', 'target'), definition('return', 'target', 'source'), definition('missing', 'missing', 'source')];
  let edited: WorkflowEdge | undefined;
  const onEdit = (edge: WorkflowEdge) => { edited = edge; };
  assert.deepEqual(toWorkflowEdges([], nodes, onEdit), []);
  const edges = toWorkflowEdges(definitions, nodes, onEdit);
  assert.deepEqual(edges.map(edge => edge.id), ['definition:forward', 'definition:alternate', 'definition:return']);
  assert.ok(edges.every(edge => edge.type === 'condition'));
  assert.deepEqual(edges[2].data!.definition, definitions[2]);
  (edges[2].data!.onEdit as typeof onEdit)(definitions[2]);
  assert.equal(edited, definitions[2]);
});

test('selecting a node colors incoming and outgoing edges without fading others or changing the saved graph', () => {
  const nodes = [node, { ...node, id: 'target' }, { ...node, id: 'other' }];
  const definitions: WorkflowEdge[] = [
    { id: 'out', sourceNodeId: 'source', targetNodeId: 'target', condition: 'forward', revision: 1 },
    { id: 'in', sourceNodeId: 'other', targetNodeId: 'source', condition: 'return', revision: 1 },
    { id: 'unrelated', sourceNodeId: 'target', targetNodeId: 'other', condition: 'other work', revision: 1 },
  ];
  const before = structuredClone(definitions);
  const selected = toWorkflowEdges(definitions, nodes, () => {}, 'source');
  assert.deepEqual(selected.map(edge => edge.data!.highlighted), [true, true, false]);
  assert.deepEqual(selected.map(edge => edge.style!.opacity), [1, 1, 1]);
  assert.deepEqual(selected.map(edge => edge.style!.stroke), ['#2563eb', '#2563eb', '#888888']);
  assert.deepEqual(selected[2].style, toWorkflowEdges(definitions, nodes, () => {})[2].style);
  assert.deepEqual(selected[2].markerEnd, toWorkflowEdges(definitions, nodes, () => {})[2].markerEnd);
  assert(selected[0].style!.strokeWidth! > selected[2].style!.strokeWidth!);
  const switched = toWorkflowEdges(definitions, nodes, () => {}, 'target');
  assert.deepEqual(switched.map(edge => edge.data!.highlighted), [true, false, true]);
  assert.deepEqual(switched.map(edge => edge.style!.opacity), [1, 1, 1]);
  assert.equal(switched[1].style!.stroke, '#888888');
  assert.deepEqual(definitions, before);
});
