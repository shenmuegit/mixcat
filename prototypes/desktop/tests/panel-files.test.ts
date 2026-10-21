import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { importAttachment, panelFilePath, previewType, safeDownloadName } from '../src/desktop/panel-files.js';
import { projectDirectory } from '../src/core/paths.js';

const testsRoot = projectDirectory(process.cwd(), '.runtime', 'panel-tests');

test('panel files and imported attachments stay under their owning project', () => {
  const root = mkdtempSync(join(testsRoot, 'scope-')), elsewhere = mkdtempSync(join(testsRoot, 'source-'));
  const file = join(root, 'design.html'); writeFileSync(file, '<h1>Design</h1>');
  assert.equal(panelFilePath(root, file), file); assert.equal(panelFilePath(root, 'design.html'), file);
  const source = join(elsewhere, 'diagram.png'); writeFileSync(source, 'fixture-image');
  assert.throws(() => panelFilePath(root, source)); assert.throws(() => panelFilePath(root, '../private.txt'));
  const image = importAttachment(root, source); assert.equal(image.type, 'localImage'); assert.equal(readFileSync(image.path as string, 'utf8'), 'fixture-image');
  assert.ok((image.path as string).startsWith(join(root, '.mixcat', 'attachments')));
  const text = join(elsewhere, 'brief.md'); writeFileSync(text, 'A brief');
  const attachment = importAttachment(root, text); assert.equal(attachment.type, 'text'); assert.match(String(attachment.text), /brief\.md/);
  assert.equal(previewType(file), 'text/html'); assert.equal(previewType(text), null);
});

test('file preview rejects private runtime paths and linked files', () => {
  const root = mkdtempSync(join(testsRoot, 'private-'));
  mkdirSync(join(root, '.mixcat', 'codex'), { recursive: true }); writeFileSync(join(root, '.mixcat', 'codex', 'auth.json'), 'fixture');
  writeFileSync(join(root, '.env'), 'fixture');
  assert.throws(() => panelFilePath(root, '.mixcat/codex/auth.json'));
  assert.equal(panelFilePath(root, '.env'), join(root, '.env'));
  assert.equal(importAttachment(root, join(root, '.env')).type, 'text');
  mkdirSync(join(root, 'target')); writeFileSync(join(root, 'target', 'file.txt'), 'fixture');
  symlinkSync(join(root, 'target'), join(root, 'linked'), 'junction');
  assert.throws(() => panelFilePath(root, 'linked/file.txt'));
});

test('download names cannot become device paths, streams or parent traversal', () => {
  for (const filename of ['../../private', 'CON', 'file:stream', 'a?b*.png', '..']) assert.match(safeDownloadName(filename), /^[\w-]+(?:[\w. -]*)$/);
});
