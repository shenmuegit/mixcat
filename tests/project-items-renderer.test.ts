import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { marked } from 'marked';
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

test('LF and CRLF documents share rendered paragraphs and heading identities', () => {
  const lf = '# A\n\nFirst\n\n## A\n\nLast';
  const crlf = lf.replaceAll('\n', '\r\n');
  assert.equal(renderToStaticMarkup(createElement(ProjectMarkdown, { text: crlf, headingPrefix: 'doc' })), renderToStaticMarkup(createElement(ProjectMarkdown, { text: lf, headingPrefix: 'doc' })));
  assert.deepEqual(markdownHeadings(crlf, 'doc'), [{ id: 'doc-0', text: 'A', depth: 1 }, { id: 'doc-1', text: 'A', depth: 2 }]);
});

test('live blocks preserve whole-document link definitions and heading identities with the safe renderer', () => {
  const tokens = marked.lexer('# Start\n\n## Second\n\n[Official][site]\n\n[site]: https://example.com\n\n<img src=x onerror=alert(1)>');
  const html = tokens.map((token, index) => renderToStaticMarkup(createElement(ProjectMarkdown, { text: '', tokens: [token], headingPrefix: 'doc', headingOffset: index === 0 ? 0 : 1 }))).join('');
  assert.match(html, /id="doc-0"/); assert.match(html, /id="doc-1"/);
  assert.match(html, /href="https:\/\/example.com" target="_blank" rel="noreferrer"/);
  assert.doesNotMatch(html, /<img\b/); assert.match(html, /&lt;img/);
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

test('document files sort newest first within their folder and show document names above filenames', () => {
  const items: any[] = [
    { id: 'old', path: 'docs/a-old.md', title: '旧文档', fileModifiedAt: '2024-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    { id: 'recent', path: 'docs/z-recent.md', title: '最近文档', fileModifiedAt: '2025-02-01T00:00:00Z' },
    { id: 'tie', path: 'docs/b-tie.md', title: '同时间文档', fileModifiedAt: '2025-02-01T00:00:00Z' },
    { id: 'fallback', path: 'docs/c-missing.md', title: '缺失回退', updatedAt: '2025-01-01T00:00:00Z' },
  ];
  const html = renderToStaticMarkup(createElement(DocumentTree, { items, selectedId: null, dirtyIds: new Set<string>(), onSelect() {} }));
  const rows = [...html.matchAll(/class="document-file[^"]*"[^>]*><span>(.*?)<\/span><small>(.*?)<\/small>/g)].map(match => [match[1], match[2]]);
  assert.deepEqual(rows, [['同时间文档', 'b-tie.md'], ['最近文档', 'z-recent.md'], ['缺失回退', 'c-missing.md'], ['旧文档', 'a-old.md']]);
});

test('project navigation exposes workflow, unified Issue and document views', () => {
  const snapshot: any = { project: { id: 'p', name: '验收', root: 'G:/project', goal: '', status: 'idle', mode: 'demo' }, nodes: [], tasks: [], handoffs: [], activities: [], edges: [], reviewPolicy: { revision: 0, checkpoints: [] }, humanReviews: [] };
  const html = renderToStaticMarkup(createElement(ProjectWorkspace, { snapshot, runtime: null, execute: async () => null, busy: false, error: null, onError() {} }));
  for (const label of ['工作流', 'Issue', '文档']) assert(html.includes(label));
  assert.doesNotMatch(html.match(/<nav[^>]*aria-label="项目视图"[\s\S]*?<\/nav>/)?.[0] ?? '', />待办</);
  assert.match(html, /aria-label="项目视图"/);
});

test('the Issue tree combines legacy todos and Issues with shared types and progress', () => {
  const snapshot: any = { project: { id: 'p' }, nodes: [] };
  const common = { status: 'open', priority: 'normal', archived: false, ownerId: null, updatedAt: '2026-10-29T08:00:00Z' };
  const items: any[] = [
    { ...common, kind: 'todo', id: 'legacy', number: 1, title: '原任务', issueType: 'bug', parentId: null, position: 0, status: 'todo' },
    { ...common, kind: 'issue', id: 'bug', number: 1, title: '子缺陷', issueType: 'bug', parentId: 'legacy', position: 0, status: 'done' },
    { ...common, kind: 'issue', id: 'task', number: 2, title: '普通任务', issueType: 'task', parentId: null, position: 1 },
  ];
  const html = renderToStaticMarkup(createElement(ProjectManagement, { snapshot, kind: 'issue', items, selectedId: null, loading: false, execute: async () => null, onSelect() {}, reload: async () => {}, onDirty() {}, onOpen() {}, onLocate() {}, onDispatch() {} }));
  for (const label of ['标题', '状态', '类型', '进度', '优先级', '负责人', '更新时间']) assert.match(html, new RegExp(`<th[^>]*scope="col"[^>]*>${label}</th>`));
  assert.deepEqual([...html.matchAll(/data-issue-id="([^"]+)"/g)].map(match => match[1]), ['legacy', 'bug', 'task']);
  assert.match(html, /aria-label="I-1 子缺陷，第2级，父 Issue T-1 原任务"/);
  assert.match(html.match(/<tr[^>]*data-issue-row="legacy"[\s\S]*?<\/tr>/)?.[0] ?? '', />普通任务<.*>1\/1</);
  assert.match(html, /新建Issue/);
});

test('Issues expose comparable metadata in a table without an unselected detail pane', () => {
  const snapshot: any = { project: { id: 'p' }, nodes: [{ id: 'n', name: '实现节点' }], archivedNodes: [{ id: 'old', name: '历史节点' }] };
  const issue = { kind: 'issue', title: '修复引用定位', status: 'open', priority: 'high', issueType: 'bug', archived: false, updatedAt: '2026-10-27T08:00:00Z' };
  const items: any[] = [{ ...issue, id: 'a', number: 1, ownerId: 'n' }, { ...issue, id: 'b', number: 2, ownerId: null, issueType: 'requirement' }, { ...issue, id: 'c', number: 3, ownerId: 'old', issueType: 'enhancement' }];
  const html = renderToStaticMarkup(createElement(ProjectManagement, { snapshot, kind: 'issue', items, selectedId: null, loading: false, execute: async () => null, onSelect() {}, reload: async () => {}, onDirty() {}, onOpen() {}, onLocate() {}, onDispatch() {} }));
  assert.match(html, /<table\b[^>]*aria-label="Issue 列表"/);
  for (const label of ['标题', '状态', '类型', '优先级', '负责人', '更新时间']) assert.match(html, new RegExp(`<th[^>]*scope="col"[^>]*>${label}</th>`));
  for (const value of ['I-1', '修复引用定位', '待处理', '缺陷', '需求', '功能改进', '实现节点', '未分配', '历史节点（已归档）']) assert(html.includes(value));
  assert.doesNotMatch(html, /aria-label="工作项详情"|选择或新建Issue|<h1>Issue<\/h1>|记录问题、讨论和解决依据|\d+ 个 Issue|type="checkbox"|class="management-heading"/);
});

test('Issues show time to the second and preserve manual sibling order across update times', () => {
  const snapshot: any = { project: { id: 'p' }, nodes: [] };
  const issue = { kind: 'issue', title: '排序验收', status: 'open', priority: 'normal', issueType: 'bug', archived: false, ownerId: null };
  const items: any[] = [
    { ...issue, id: 'old', number: 1, position: 2, updatedAt: new Date(2026, 9, 26, 23, 59, 59).toISOString() },
    { ...issue, id: 'middle', number: 2, position: 0, updatedAt: new Date(2026, 9, 27, 15, 4, 4).toISOString() },
    { ...issue, id: 'new', number: 3, position: 1, updatedAt: new Date(2026, 9, 27, 15, 4, 5).toISOString() },
    { ...issue, id: 'tie', number: 4, position: 1, updatedAt: new Date(2026, 9, 27, 15, 4, 5).toISOString() },
  ];
  const html = renderToStaticMarkup(createElement(ProjectManagement, { snapshot, kind: 'issue', items, selectedId: null, loading: false, execute: async () => null, onSelect() {}, reload: async () => {}, onDirty() {}, onOpen() {}, onLocate() {}, onDispatch() {} }));
  assert.deepEqual([...html.matchAll(/data-issue-id="([^"]+)"/g)].map(match => match[1]), ['middle', 'new', 'tie', 'old']);
  assert.match(html, />[^<]*15:04:05<\/time>/);
  assert.deepEqual(items.map(item => item.id), ['old', 'middle', 'new', 'tie']);
});

test('legacy tasks nest in the Issue tree with sibling order and effective leaf progress', () => {
  const snapshot: any = { project: { id: 'p' }, nodes: [] };
  const todo = { kind: 'todo', status: 'todo', priority: 'normal', archived: false, ownerId: null, updatedAt: '2026-10-27T08:00:00Z' };
  const items: any[] = [
    { ...todo, id: 'root', number: 1, title: '父项', parentId: null, position: 20 },
    { ...todo, id: 'child', number: 2, title: '第一子项', parentId: 'root', position: 20 },
    { ...todo, id: 'grand', number: 3, title: '完成孙项', parentId: 'child', position: 0, status: 'done' },
    { ...todo, id: 'sibling', number: 4, title: '前置子项', parentId: 'root', position: 10 },
    { ...todo, id: 'other', number: 5, title: '前置根项', parentId: null, position: 10 },
  ];
  const html = renderToStaticMarkup(createElement(ProjectManagement, { snapshot, kind: 'issue', items, selectedId: null, loading: false, execute: async () => null, onSelect() {}, reload: async () => {}, onDirty() {}, onOpen() {}, onLocate() {}, onDispatch() {} }));
  assert.match(html, /<table\b[^>]*aria-label="Issue 列表"/);
  for (const label of ['标题', '状态', '类型', '进度', '优先级', '负责人', '更新时间']) assert.match(html, new RegExp(`<th[^>]*scope="col"[^>]*>${label}</th>`));
  assert.deepEqual([...html.matchAll(/data-todo-id="([^"]+)"/g)].map(match => match[1]), ['other', 'root', 'sibling', 'child', 'grand']);
  assert.match(html, /aria-label="T-3 完成孙项，第3级，父 Issue T-2 第一子项"/);
  assert.match(html.match(/<tr[^>]*data-todo-id="root"[\s\S]*?<\/tr>/)?.[0] ?? '', />1\/2</);
  assert.match(html.match(/<tr[^>]*data-todo-id="grand"[\s\S]*?<\/tr>/)?.[0] ?? '', />—</);
  assert.doesNotMatch(html, /aria-label="工作项详情"|class="management-heading"|type="checkbox"/);
  assert.deepEqual(items.map(item => item.id), ['root', 'child', 'grand', 'sibling', 'other']);
});

test('document workspace offers adjustable panes and a minimal page toolbar', () => {
  const snapshot: any = { project: { id: 'p' }, nodes: [] };
  const items: any[] = [{ id: 'legacy', kind: 'document', path: 'docs/legacy.md', title: 'Legacy', archived: true }];
  const html = renderToStaticMarkup(createElement(ProjectManagement, { snapshot, kind: 'document', items, selectedId: null, loading: false, execute: async () => null, onSelect() {}, reload: async () => {}, onDirty() {}, onOpen() {}, onLocate() {}, onDispatch() {} }));
  assert.doesNotMatch(html, /已归档/);
  assert.doesNotMatch(html, /<h1>文档<\/h1>|纳入已有文档|class="management-heading"/);
  assert.match(html, /class="management-filters"><input[^>]*\/><div class="management-actions">.*?刷新.*?新建文档<\/button><\/div><\/div>/);
  assert.equal([...html.matchAll(/role="separator"/g)].length, 2);
  assert.match(html, /aria-label="调整文件树宽度"/);
  assert.match(html, /aria-label="调整大纲宽度"/);
});
