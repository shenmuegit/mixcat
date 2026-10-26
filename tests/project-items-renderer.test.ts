import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProjectMarkdown, ReferenceNavigation } from '../src/renderer/ProjectMarkdown.js';
import { ProjectWorkspace } from '../src/renderer/ProjectManagement.js';

test('Markdown previews render structure and project references without executing markup or unsafe links', () => {
  const body = '## 验收\n\n- **通过**\n\n[@T-1 测试](mixcat://project/todo/item)\n\n<img src=x onerror=alert(1)>\n\n[危险](javascript:alert%281%29)';
  const html = renderToStaticMarkup(createElement(ReferenceNavigation.Provider, { value: { projectId: 'project', items: [], open() {} } }, createElement(ProjectMarkdown, { text: body })));
  assert.match(html, /<h2>验收<\/h2>/); assert.match(html, /<strong>通过<\/strong>/);
  assert.match(html, /class="item-reference"/); assert.doesNotMatch(html, /<img\b|href="javascript:/);
  assert.match(html, /&lt;img/);
});

test('project navigation exposes workflow, tree todo, issue and document views', () => {
  const snapshot: any = { project: { id: 'p', name: '验收', root: 'G:/project', goal: '', status: 'idle', mode: 'demo' }, nodes: [], tasks: [], handoffs: [], activities: [], edges: [], reviewPolicy: { revision: 0, checkpoints: [] }, humanReviews: [] };
  const html = renderToStaticMarkup(createElement(ProjectWorkspace, { snapshot, runtime: null, execute: async () => null, busy: false, error: null, onError() {} }));
  for (const label of ['工作流', '待办', 'Issue', '文档']) assert(html.includes(label));
  assert.match(html, /aria-label="项目视图"/);
});
