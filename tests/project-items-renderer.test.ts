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
  assert.doesNotMatch(html, /aria-label="工作项详情"|选择或新建Issue/);
});

test('document workspace offers adjustable panes and a minimal page toolbar', () => {
  const snapshot: any = { project: { id: 'p' }, nodes: [] };
  const html = renderToStaticMarkup(createElement(ProjectManagement, { snapshot, kind: 'document', items: [], selectedId: null, loading: false, execute: async () => null, onSelect() {}, reload: async () => {}, onDirty() {}, onOpen() {}, onLocate() {}, onDispatch() {} }));
  assert.doesNotMatch(html, /<h1>文档<\/h1>|纳入已有文档/);
  assert.equal([...html.matchAll(/role="separator"/g)].length, 2);
  assert.match(html, /aria-label="调整文件树宽度"/);
  assert.match(html, /aria-label="调整大纲宽度"/);
});
