import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionPane } from '../src/renderer/SessionPane.js';
import { ComfyWorkspace, selectedComfyReference } from '../src/renderer/ComfyWorkspace.js';
import { ProjectWorkspace } from '../src/renderer/ProjectManagement.js';
import type { ProjectSnapshot } from '../src/shared/types.js';

const snapshot: ProjectSnapshot = { project: { id: 'p', root: 'G:/fixture', name: 'Comfy', template: 'comfyui', mode: 'codex', status: 'idle', updatedAt: '' }, nodes: [{ id: 'comfy-assistant', name: 'Saved assistant', instructions: '', tools: [], resultSchema: {}, position: { x: 0, y: 0 }, revision: 4, threadId: 'existing-thread', status: 'paused' }], tasks: [], handoffs: [], activities: [] };
test('the shared session renders the saved assistant with ordinary pause and composer semantics', () => {
  const html = renderToStaticMarkup(createElement(SessionPane, { snapshot, nodeId: 'comfy-assistant', runtime: null, execute: async () => null, busy: false, error: null, onError() {}, onClose() {} }));
  assert.match(html, /Saved assistant/);
  assert.match(html, /消息将排队，启用节点后处理/);
  assert.match(html, /节点消息/);
  assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>启用节点/);
});
test('a removed primary assistant is explicit and never falls back to another session', () => {
  const html = renderToStaticMarkup(createElement(SessionPane, { snapshot, nodeId: 'missing-primary', runtime: null, execute: async () => null, busy: false, error: null, onError() {}, onClose() {} }));
  assert.match(html, /会话节点已移除/);
  assert.doesNotMatch(html, /task-composer/);
});
test('an unreadable persistent assistant draft is reported instead of silently treated as an empty saved draft', t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => '{broken' } });
  t.after(() => { if (original) Object.defineProperty(globalThis, 'localStorage', original); else delete (globalThis as any).localStorage; });
  const html = renderToStaticMarkup(createElement(SessionPane, { snapshot, nodeId: 'comfy-assistant', runtime: null, execute: async () => null, busy: false, error: null, onError() {}, onClose() {}, persistDrafts: true }));
  assert.match(html, /原草稿未被覆盖/);
});
test('saved template routes to a full native slot and selected node references retain tab and subgraph identity', () => {
  const html = renderToStaticMarkup(createElement(ProjectWorkspace, { snapshot, runtime: null, execute: async () => null, busy: false, error: null, onError() {} }));
  assert.match(html, /ComfyUI 原生画布/); assert.doesNotMatch(html, /react-flow__renderer/);
  assert.match(html, /正在准备官方 ComfyUI/); assert.match(html, /供应商/);
  const observation = { projectId: 'p', instanceId: 'instance', workflowId: 'root-doc', tabId: 'tabs/one', revision: 'revision' };
  const view = { observation, workflow: {}, subgraphPath: ['outer','inner'], selectedNodeIds: ['1'] };
  const text = selectedComfyReference(view);
  for (const part of ['root-doc', 'tabs/one', 'outer', 'inner', 'revision']) assert(text.includes(part));
  assert.throws(() => selectedComfyReference({ ...view, selectedNodeIds: [] }), /选中/);
});
