import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GroupEditor } from '../src/renderer/WorkflowGroups.js';
import type { NodeView, WorkflowGroup } from '../src/shared/types.js';

test('group editor exposes membership and a member-only coordinator without claiming nodes in another group', () => {
  const nodes: NodeView[] = ['product', 'requirements', 'design', 'architect'].map(id => ({ id, name: id, instructions: '', tools: [], resultSchema: {}, revision: 1, position: { x: 0, y: 0 }, threadId: null, status: 'idle' }));
  const group: WorkflowGroup = { id: 'definition', name: '产品定义', nodeIds: ['product', 'requirements'], coordinatorNodeId: 'product', revision: 1 };
  const other: WorkflowGroup = { id: 'other', name: '技术组', nodeIds: ['architect'], coordinatorNodeId: 'architect', revision: 1 };
  const html = renderToStaticMarkup(createElement(GroupEditor, { value: group, nodes, groups: [group, other], busy: false, onChange() {}, async onSave() {}, async onDelete() {} }));
  assert.match(html, /aria-label="分组名称"/);
  assert.match(html, /<input[^>]*aria-label="成员 architect"[^>]*disabled/);
  const select = html.match(/<select[\s\S]*?<\/select>/)?.[0] ?? '';
  assert.match(select, /value="product"/); assert.match(select, /value="requirements"/);
  assert.doesNotMatch(select, /value="design"|value="architect"/);
  assert.match(html, /解除分组/);
});
