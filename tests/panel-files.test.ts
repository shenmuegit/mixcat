import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { projectDirectory } from '../src/core/paths.js';
import { importAttachment, panelFilePath, safeDownloadName, previewType } from '../src/desktop/panel-files.js';

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
  assert.throws(() => panelFilePath(root, join(linked, 'file.txt')));
  const attachment = importAttachment(root, text); assert.equal(attachment.type, 'text'); assert(String(attachment.text).includes('.mixcat'));
  assert.doesNotMatch(safeDownloadName('../../CON.:secret'), /[:/\\]/);
});
