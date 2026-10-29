import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DocumentMediaStore } from '../src/core/document-media.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
function fixture() {
  const parent = resolve('.runtime/tests/document-media'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'media-')), project = join(root, 'project'); mkdirSync(project);
  return { root, project, store: new DocumentMediaStore(root, id => { if (id !== 'project') throw Error('Unknown project'); return project; }) };
}
test('note and project media round trip through their own source roots and survive a new store', () => {
  const f = fixture(), source = { kind: 'project' as const, projectId: 'project', path: 'docs/spec.md' };
  const note = f.store.command({ operation: 'import', source: { kind: 'notes' }, name: '图片.png', mime: 'image/png', base64: png });
  assert.match(note.href!, /^assets\/[a-f0-9]{64}\.png$/);
  assert.throws(() => f.store.command({ operation: 'read', source, href: note.href! }), /不存在|缺失/);
  const doc = f.store.command({ operation: 'import', source, name: '../../bad.png', mime: 'image/png', base64: png });
  assert.equal(doc.href, note.href);
  const reopened = new DocumentMediaStore(f.root, () => f.project);
  assert.equal(reopened.command({ operation: 'read', source, href: doc.href! }).url, `data:image/png;base64,${png}`);
  assert.equal(reopened.command({ operation: 'read', source: { kind: 'notes' }, href: note.href! }).url, `data:image/png;base64,${png}`);
});
test('project media resolves legitimate relative image paths while rejecting paths outside its source', () => {
  const f = fixture(), source = { kind: 'project' as const, projectId: 'project', path: 'docs/spec.md' };
  mkdirSync(join(f.project, 'images')); writeFileSync(join(f.project, 'images', '图.png'), Buffer.from(png, 'base64'));
  mkdirSync(join(f.project, '.mixcat', 'state'), { recursive: true }); writeFileSync(join(f.project, '.mixcat', 'state', 'a.png'), Buffer.from(png, 'base64'));
  assert.equal(f.store.command({ operation: 'read', source, href: '../images/%E5%9B%BE.png' }).url, `data:image/png;base64,${png}`);
  for (const href of ['../../outside.png', '/absolute.png', 'C:/secret.png', '//server/a.png', '../.mixcat/state/a.png', '../.mixcat./state/a.png', '../.git/a.png', 'file:///G:/outside.png', 'https://example.com/a.png']) {
    assert.throws(() => f.store.command({ operation: 'read', source, href }), Error, href);
  }
});
test('media rejects oversized files without reading their full content', async () => {
  const { openSync, closeSync, ftruncateSync } = await import('node:fs');
  const f = fixture(), source = { kind: 'project' as const, projectId: 'project', path: 'docs/spec.md' };
  mkdirSync(join(f.project, 'docs'));
  const fd = openSync(join(f.project, 'docs', 'large.png'), 'w');
  try { ftruncateSync(fd, 20 * 1024 * 1024 + 1); } finally { closeSync(fd); }
  assert.throws(() => f.store.command({ operation: 'read', source, href: 'large.png' }), /20 MiB/);
});
test('media import rejects active formats, invalid payloads, MIME mismatches and linked files', () => {
  const f = fixture(), source = { kind: 'notes' as const };
  for (const input of [{ mime: 'image/svg+xml', base64: Buffer.from('<svg/>').toString('base64') }, { mime: 'image/png', base64: 'broken!' }, { mime: 'image/png', base64: Buffer.from('<script>alert(1)</script>').toString('base64') }]) {
    assert.throws(() => f.store.command({ operation: 'import', source, name: 'file.png', ...input }));
  }
  const imported = f.store.command({ operation: 'import', source, name: 'a.png', mime: 'image/png', base64: png });
  const assets = join(f.root, '.mixcat', 'notes', 'assets'), actual = join(f.root, '.mixcat', 'notes', imported.href!);
  linkSync(actual, join(assets, 'hard.png'));
  assert.throws(() => f.store.command({ operation: 'read', source, href: 'assets/hard.png' }), /链接/);
  symlinkSync(f.project, join(assets, 'linked'), 'junction');
  assert.throws(() => f.store.command({ operation: 'read', source, href: 'assets/linked/a.png' }), /链接|联接/);
});
