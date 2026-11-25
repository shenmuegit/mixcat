import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, renameSync, unlinkSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { projectDirectory } from '../src/core/paths.js';
import { importAttachment, panelFilePath, readAttachmentPreview, safeDownloadName, previewType } from '../src/desktop/panel-files.js';

test('panel files and attachments reject private runtime paths, junctions and Windows alternate streams', () => {
  const root = mkdtempSync(join(projectDirectory(process.cwd(), '.runtime', 'implementation', 'fixtures'), 'panel-files-'));
  const text = join(root, 'readme.txt'); writeFileSync(text, 'project text');
  assert.equal(panelFilePath(root, text), text); assert.equal(previewType('design.pdf'), 'application/pdf');
  const secret = join(projectDirectory(root, '.mixcat', 'codex'), 'config.toml'); writeFileSync(secret, 'private config');
  for (const value of [secret, '../outside', 'readme.txt:private', '\\\\?\\G:\\secret']) assert.throws(() => panelFilePath(root, value));
  assert.throws(() => importAttachment(root, secret));
  const env = join(root, '.env.example'); writeFileSync(env, 'EXAMPLE_MODE=development');
  assert.equal(panelFilePath(root, env), env);
  assert.equal(importAttachment(root, env).type, 'text');
  const linked = join(root, 'linked'); symlinkSync(projectDirectory(root, 'other'), linked, 'junction');
  writeFileSync(join(root, 'other', 'file.txt'), 'linked file');
  assert.throws(() => panelFilePath(root, join(linked, 'file.txt')));
  assert.throws(() => importAttachment(root, join(linked, 'file.txt')), /链接|联接/);
  const attachment = importAttachment(root, text); assert.equal(attachment.type, 'text'); assert(String(attachment.text).includes('.mixcat'));
  assert.equal(attachment.mixcatAttachment?.name, 'readme.txt');
  assert.equal(panelFilePath(root, attachment.mixcatAttachment?.path), attachment.mixcatAttachment?.path);
  assert.doesNotMatch(safeDownloadName('../../CON.:secret'), /[:/\\]/);
});

test('draft previews return only registered media for the importing node', async () => {
  const root = mkdtempSync(join(projectDirectory(process.cwd(), '.runtime', 'implementation', 'fixtures'), 'attachment-preview-'));
  const source = join(root, 'same-name.png');
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/acsAAAAASUVORK5CYII=', 'base64');
  writeFileSync(source, bytes);
  const first = importAttachment(root, source, 'origin').mixcatAttachment!;
  const second = importAttachment(root, source, 'origin').mixcatAttachment!;
  assert.notEqual(first.artifact_id, second.artifact_id);
  assert.deepEqual(await readAttachmentPreview(root, 'origin', first.artifact_id, true), { mime: 'image/png', url: `data:image/png;base64,${bytes.toString('base64')}` });
  await assert.rejects(readAttachmentPreview(root, 'different-node', first.artifact_id, false), /预览/);
  await assert.rejects(readAttachmentPreview(root, 'origin', source, false), /预览/);
  await assert.rejects(readAttachmentPreview(root, 'origin', importAttachment(root, source).mixcatAttachment!.artifact_id, false), /预览/);
  renameSync(first.path, join(root, '.mixcat', 'attachments', 'retired-preview.png'));
  writeFileSync(first.path, bytes);
  await assert.rejects(readAttachmentPreview(root, 'origin', first.artifact_id, false), /预览/, 'a same-size replacement cannot inherit the original registration');
  unlinkSync(first.path);
  await assert.rejects(readAttachmentPreview(root, 'origin', first.artifact_id, false), /预览/);
  assert.equal((await readAttachmentPreview(root, 'origin', second.artifact_id, false))?.mime, 'image/png');
  writeFileSync(join(root, '.mixcat', 'attachment-previews', `${second.artifact_id}.json`), ' '.repeat(4097));
  await assert.rejects(readAttachmentPreview(root, 'origin', second.artifact_id, false), /预览/, 'registration reads are bounded');
});
