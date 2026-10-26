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
    const html = renderToStaticMarkup(createElement(Workbench, { snapshot: { project: { id: 'p', name: 'p', root: 'G:/fixture', goal: 'g', status: status === 'resuming' ? 'running' : status, mode: 'codex', updatedAt: '' }, nodes: [{ ...node, status }], tasks: [], handoffs: [], activities: [], resumeNodeIds: ['source'] }, runtime: null, execute: async () => null, busy: true, error: null, onError() {} }));
    assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>停止本轮/);
    if (!['paused', 'pausing'].includes(status)) assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>暂停节点/);
    if (['paused', 'pausing'].includes(status)) assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>启用节点/);
  }
});
test('creation exposes actual name, model, skills, plugins, instructions and natural condition controls', () => {
  const html = renderToStaticMarkup(createElement(NewNodeForm, { position: node.position, relatedName: node.name, catalog: { models: [{ id: 'model', name: 'Chosen model' }], skills: [{ path: 'G:/fixture/skill', name: 'Skill' }], plugins: [{ id: 'plugin@fixture', name: 'Plugin' }], errors: [] }, loading: false, busy: false, onReload() {}, async onSave() {} }));
  for (const label of ['节点名称', '职责与指令', 'Chosen model', 'Skill', 'Plugin', '关联条件', '创建关联节点']) assert(html.includes(label));
});
test('model choices preserve native default, saved models and unavailable discovery', () => {
  const catalog = { models: [{ id: 'other', name: 'Other model' }, { id: 'default-id', name: 'Actual default', isDefault: true }], skills: [], plugins: [], errors: [] };
  const html = renderToStaticMarkup(createElement(CapabilityFields, { node: { ...node, model: null }, catalog, onChange() {} }));
  assert.match(html, /<option value="" selected="">原生默认<\/option>/);
  assert.match(html, /<option value="default-id">Actual default · 默认<\/option>/);
  const saved = renderToStaticMarkup(createElement(CapabilityFields, { node: { ...node, model: 'saved-id' }, catalog, onChange() {} }));
  assert.match(saved, /<option value="saved-id" selected="">saved-id<\/option>/);
  const offline = renderToStaticMarkup(createElement(CapabilityFields, { node: { ...node, model: null }, catalog: null, onChange() {} }));
  assert.doesNotMatch(offline, /<select[^>]*disabled=""/);
  assert.match(offline, /原生默认/);
  assert.match(offline, /未获取到可用模型/);
});

test('node capability status distinguishes native availability, untrusted hooks and discovery gaps', () => {
  const html = renderToStaticMarkup(createElement(CapabilityFields, { node, catalog: {
    models: [], skills: [], plugins: [], errors: ['GitNexus 尚未发现'],
    mcpServers: [{ name: 'browser', status: 'connected', toolCount: 3 }, { name: 'gitnexus', status: 'failed', toolCount: 0 }],
    hooks: [{ eventName: 'Stop', enabled: true, trustStatus: 'untrusted', key: 'hook', sourcePath: 'G:/internal/hooks.json', currentHash: 'hash' }],
  }, onChange() {} }));
  for (const text of ['GitNexus 尚未发现', 'browser', '已连接', '3 个工具', 'gitnexus', '失败', '本轮结束', '待信任']) assert(html.includes(text));
  assert.doesNotMatch(html, /G:\/internal\/hooks.json|hash/);
  const config = renderToStaticMarkup(createElement(NodeConfig, { node: { ...node, planId: 'mvp-001' }, tasks: [], busy: false, onSave: async () => node, onError() {} }));
  assert.match(config, /aria-label="计划 ID"[^>]*value="mvp-001"/);
  assert.match(config, /slug/);
  assert(config.includes('aria-label="计划 ID" pattern="[A-Za-z0-9_][A-Za-z0-9._\\-]{0,99}" maxLength="100"'));
});

test('hook trust requires a visible review and preserves source, command and displayed hash', () => {
  const hooks = [
    { key: 'review', eventName: 'Stop', enabled: true, trustStatus: 'modified', sourcePath: 'G:/project/.mixcat/hooks.json', command: 'node ./review-hook.cjs', matcher: '*', currentHash: 'review-hash' },
    { key: 'trusted', eventName: 'PreToolUse', enabled: true, trustStatus: 'trusted', sourcePath: 'G:/project/trusted.json', command: 'already-trusted', currentHash: 'trusted-hash' },
    { key: 'missing-hash', eventName: 'SessionStart', enabled: true, trustStatus: 'untrusted', sourcePath: 'G:/project/unknown.json', currentHash: null },
  ];
  const html = renderToStaticMarkup(createElement(CapabilityFields, { node, catalog: { models: [], skills: [], plugins: [], errors: [], hooks }, projectRoot: 'G:/project', onChange() {}, async onTrust() {} }));
  assert.match(html, /<details[^>]*><summary>审核项目 hooks/);
  assert.doesNotMatch(html, /<details[^>]*open/);
  for (const text of ['G:/project/.mixcat/hooks.json', 'node ./review-hook.cjs', 'review-hash', '信任当前显示的项目 hooks']) assert(html.includes(text));
  assert.doesNotMatch(html, /trusted-hash|already-trusted/);
  const unavailable = renderToStaticMarkup(createElement(CapabilityFields, { node, catalog: { models: [], skills: [], plugins: [], errors: [], hooks: [{ ...hooks[0], command: undefined }] }, projectRoot: 'G:/project', onChange() {}, async onTrust() {} }));
  assert.match(unavailable, /宿主未提供可审核命令，尚不能在此信任/);
  assert.match(unavailable, /<button[^>]*disabled=""[^>]*>信任当前显示的项目 hooks/);
});

test('pending and reconciliation tasks keep editable config draft but disable saving', () => {
  for (const status of ['running', 'paused', 'queued', 'waiting_source', 'needs_reconciliation'] as const) {
    const html = renderToStaticMarkup(createElement(NodeConfig, { node, tasks: [{ nodeId: node.id, status } as TaskView], busy: false, onSave: async () => node, onError() {} }));
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
