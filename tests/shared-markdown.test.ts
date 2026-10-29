import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SharedMarkdown } from '../src/renderer/SharedMarkdown';

test('shared document reading renders Markdown tables, unique headings and source links safely', () => {
  const html = renderToStaticMarkup(createElement(SharedMarkdown, {
    content: '# 同名\n\n## 同名\n\n| 列 |\n| --- |\n| **值** |\n\n[笔记](mixcat-note://a) [工作项](mixcat://project/todo/id) [官网](https://example.com)\n\n[危险](javascript:alert%281%29)\n\n<img src=x onerror="alert(1)">',
    headingPrefix: 'source-note-a',
    onOpenLink() {},
  }));
  assert.match(html, /<h1 id="source-note-a-0"/);
  assert.match(html, /<h2 id="source-note-a-1"/);
  assert.match(html, /<table>/);
  assert.match(html, /<strong>值<\/strong>/);
  assert.match(html, /<button[^>]*>笔记<\/button>/);
  assert.match(html, /<button[^>]*>工作项<\/button>/);
  assert.match(html, /href="https:\/\/example.com"/);
  assert.doesNotMatch(html, /href="javascript:|<img|<script/);
});
