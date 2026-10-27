import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProjectMarkdown, ReferenceNavigation, markdownHeadings } from '../src/renderer/ProjectMarkdown.js';
import { DocumentTree } from '../src/renderer/DocumentTree.js';
import { ProjectManagement, ProjectWorkspace } from '../src/renderer/ProjectManagement.js';

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

test('Issues expose comparable metadata in a table without an unselected detail pane', () => {
  const snapshot: any = { project: { id: 'p' }, nodes: [{ id: 'n', name: '实现节点' }], archivedNodes: [{ id: 'old', name: '历史节点' }] };
  const issue = { kind: 'issue', title: '修复引用定位', status: 'open', priority: 'high', issueType: 'bug', archived: false, updatedAt: '2026-10-27T08:00:00Z' };
  const items: any[] = [{ ...issue, id: 'a', number: 1, ownerId: 'n' }, { ...issue, id: 'b', number: 2, ownerId: null, issueType: 'requirement' }, { ...issue, id: 'c', number: 3, ownerId: 'old', issueType: 'enhancement' }];
  const html = renderToStaticMarkup(createElement(ProjectManagement, { snapshot, kind: 'issue', items, selectedId: null, loading: false, execute: async () => null, onSelect() {}, reload: async () => {}, onDirty() {}, onOpen() {}, onLocate() {}, onDispatch() {} }));
  assert.match(html, /<table\b[^>]*aria-label="Issue 列表"/);
  for (const label of ['标题', '状态', '类型', '优先级', '负责人', '更新时间']) assert.match(html, new RegExp(`<th[^>]*scope="col"[^>]*>${label}</th>`));
  for (const value of ['I-1', '修复引用定位', '待处理', '缺陷', '需求', '功能改进', '实现节点', '未分配', '历史节点（已归档）']) assert(html.includes(value));
  assert.doesNotMatch(html, /aria-label="工作项详情"|选择或新建Issue|<h1>Issue<\/h1>|记录问题、讨论和解决依据|\d+ 个 Issue|type="checkbox"/);
});

test('Issues show time to the second and order newest updates first with stable ties', () => {
  const snapshot: any = { project: { id: 'p' }, nodes: [] };
  const issue = { kind: 'issue', title: '排序验收', status: 'open', priority: 'normal', issueType: 'bug', archived: false, ownerId: null };
  const items: any[] = [
    { ...issue, id: 'old', number: 1, updatedAt: new Date(2026, 9, 26, 23, 59, 59).toISOString() },
    { ...issue, id: 'middle', number: 2, updatedAt: new Date(2026, 9, 27, 15, 4, 4).toISOString() },
    { ...issue, id: 'new', number: 3, updatedAt: new Date(2026, 9, 27, 15, 4, 5).toISOString() },
    { ...issue, id: 'tie', number: 4, updatedAt: new Date(2026, 9, 27, 15, 4, 5).toISOString() },
  ];
  const html = renderToStaticMarkup(createElement(ProjectManagement, { snapshot, kind: 'issue', items, selectedId: null, loading: false, execute: async () => null, onSelect() {}, reload: async () => {}, onDirty() {}, onOpen() {}, onLocate() {}, onDispatch() {} }));
  assert.deepEqual([...html.matchAll(/data-issue-id="([^"]+)"/g)].map(match => match[1]), ['tie', 'new', 'middle', 'old']);
  assert.match(html, />[^<]*15:04:05<\/time>/);
  assert.deepEqual(items.map(item => item.id), ['old', 'middle', 'new', 'tie']);
});
