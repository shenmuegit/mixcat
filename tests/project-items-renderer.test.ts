import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProjectMarkdown, ReferenceNavigation, markdownHeadings } from '../src/renderer/ProjectMarkdown.js';
import { DocumentTree } from '../src/renderer/DocumentTree.js';
import { ProjectWorkspace } from '../src/renderer/ProjectManagement.js';

test('Markdown previews render structure and project references without executing markup or unsafe links', () => {
  const body = '## 验收\n\n- **通过**\n\n[@T-1 测试](mixcat://project/todo/item)\n\n<img src=x onerror=alert(1)>\n\n[危险](javascript:alert%281%29)';
  const html = renderToStaticMarkup(createElement(ReferenceNavigation.Provider, { value: { projectId: 'project', items: [], open() {} } }, createElement(ProjectMarkdown, { text: body })));
  assert.match(html, /<h2>验收<\/h2>/); assert.match(html, /<strong>通过<\/strong>/);
  assert.match(html, /class="item-reference"/); assert.doesNotMatch(html, /<img\b|href="javascript:/);
  assert.match(html, /&lt;img/);
});

test('document outline uses the rendered heading order, including duplicate and nested headings', () => {
  const text = '# Start\n\n> ## Nested\n\n```md\n# Not a heading\n```\n\n## Start\n\nLast\n====';
  assert.deepEqual(markdownHeadings(text, 'doc').map(({ id, depth }) => [id, depth]), [['doc-0', 1], ['doc-1', 2], ['doc-2', 2], ['doc-3', 1]]);
  const html = renderToStaticMarkup(createElement(ProjectMarkdown, { text, headingPrefix: 'doc' }));
  assert.deepEqual([...html.matchAll(/<h\d id="([^"]+)"/g)].map(match => match[1]), ['doc-0', 'doc-1', 'doc-2', 'doc-3']);
});

test('file tree shows registered paths beyond docs and preserves hierarchy', () => {
  const items: any[] = [{ id: 'a', path: 'docs/design/spec.md', title: 'Spec' }, { id: 'b', path: 'notes/summary.markdown', title: 'Summary', deletedAt: '2026-10-27' }];
  const html = renderToStaticMarkup(createElement(DocumentTree, { items, selectedId: 'a', dirtyIds: new Set(['a']), onSelect() {} }));
  assert.match(html, /折叠 docs\/design/); assert.match(html, /折叠 notes/); assert.match(html, /aria-current="page"/); assert.match(html, /Spec · 草稿/); assert.match(html, /Summary · 已删除/);
});

test('saved references identify deleted documents distinctly', () => {
  const html = renderToStaticMarkup(createElement(ReferenceNavigation.Provider, { value: { projectId: 'project', items: [{ id: 'doc', kind: 'document', number: 1, title: 'Deleted', archived: true, deletedAt: '2026-10-27' } as any], open() {} } }, createElement(ProjectMarkdown, { text: '[@D-1](mixcat://project/document/doc)', historical: true })));
  assert.match(html, /已删除/); assert.doesNotMatch(html, /归档/);
});

test('project navigation exposes workflow, tree todo, issue and document views', () => {
  const snapshot: any = { project: { id: 'p', name: '验收', root: 'G:/project', goal: '', status: 'idle', mode: 'demo' }, nodes: [], tasks: [], handoffs: [], activities: [], edges: [], reviewPolicy: { revision: 0, checkpoints: [] }, humanReviews: [] };
  const html = renderToStaticMarkup(createElement(ProjectWorkspace, { snapshot, runtime: null, execute: async () => null, busy: false, error: null, onError() {} }));
  for (const label of ['工作流', '待办', 'Issue', '文档']) assert(html.includes(label));
  assert.match(html, /aria-label="项目视图"/);
});
