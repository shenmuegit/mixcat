import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { insideProject, projectDirectory } from '../core/paths.js';

export function disableNativeWorkflowDrafts(root: string, data: string) {
  const directory = projectDirectory(root, data, 'user', 'default');
  const settingsPath = insideProject(root, join(directory, 'comfy.settings.json'));
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    const stat = lstatSync(settingsPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw Error('Comfy 设置必须是项目内无链接的普通文件。');
    settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw Error('Comfy 设置文件格式不正确。');
  }
  if (settings['Comfy.Workflow.Persist'] === false) return;
  settings['Comfy.Workflow.Persist'] = false;
  const temporary = insideProject(root, join(directory, `.mixcat-settings-${randomUUID()}.tmp`));
  try {
    writeFileSync(temporary, JSON.stringify(settings, null, 2), { flag: 'wx', mode: 0o600, flush: true });
    renameSync(temporary, settingsPath);
  } finally { rmSync(temporary, { force: true }); }
}
