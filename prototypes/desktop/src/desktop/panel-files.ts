import { copyFileSync, constants, lstatSync } from 'node:fs';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { insideProject, projectDirectory } from '../core/paths.js';
import type { NativeInput } from '../shared/types.js';

export function panelFilePath(root: string, value: unknown): string {
  if (typeof value !== 'string' || !value || value.includes('\0') || /^[a-z]+:\/\//i.test(value)) throw new Error('文件路径不正确。');
  const file = insideProject(root, resolve(root, value));
  const parts = relative(root, file).split(sep).map(part => part.toLowerCase());
  if (parts.some(part => part === '.git' || part === 'auth.json') || parts.some((part, index) => part === '.mixcat' && parts[index + 1] === 'codex')) throw new Error('运行凭据和私密配置不能作为面板资源打开。');
  if (!lstatSync(file).isFile()) throw new Error('请选择项目内的文件。');
  return file;
}

export function safeDownloadName(name: string): string { return `${randomUUID()}-${basename(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '') || 'download'}`; }

export function importAttachment(root: string, source: string): NativeInput {
  const name = basename(source);
  if (/^auth\.json$/i.test(name)) throw new Error('运行登录凭据不能作为附件导入。');
  if (!lstatSync(source).isFile()) throw new Error('附件必须是普通文件。');
  const destination = insideProject(root, join(projectDirectory(root, '.mixcat', 'attachments'), safeDownloadName(name)));
  copyFileSync(source, destination, constants.COPYFILE_EXCL);
  if (/^\.(png|jpe?g|webp|gif)$/i.test(extname(name))) return { type: 'localImage', path: destination };
  if (/^\.(wav|mp3|m4a|ogg|flac|webm)$/i.test(extname(name))) return { type: 'localAudio', path: destination };
  return { type: 'text', text: `附件：${name}\n项目内文件：${destination}`, text_elements: [] };
}

export function previewType(file: string): string | null {
  const types: Record<string, string> = { '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.pdf': 'application/pdf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm' };
  return types[extname(file).toLowerCase()] ?? null;
}
