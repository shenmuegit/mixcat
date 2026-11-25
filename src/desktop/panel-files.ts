import { copyFileSync, constants, lstatSync, writeFileSync } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { insideProject, projectDirectory } from '../core/paths.js';
import type { NativeInput } from '../shared/types.js';
import { attachmentPreviewMime, type AttachmentPreview } from '../shared/attachment-preview.js';

const maxPreviewBytes = 16 * 1024 * 1024;
const maxThumbnailBytes = 512 * 1024;

export function panelFilePath(root: string, value: unknown): string {
  if (typeof value !== 'string' || !value || value.includes('\0') || /^[a-z]+:\/\//i.test(value) || value.startsWith('\\\\') || value.replace(/^[a-z]:/i, '').includes(':')) throw new Error('文件路径不正确。');
  const file = insideProject(root, resolve(root, value));
  const parts = relative(root, file).split(sep).map(part => part.toLowerCase());
  if (parts.some(part => part === '.git' || part === 'auth.json') || parts.some((part, index) => part === '.mixcat' && parts[index + 1] === 'codex')) throw new Error('运行凭据和私密配置不能作为面板资源打开。');
  if (!lstatSync(file).isFile()) throw new Error('请选择项目内的文件。');
  return file;
}

export function safeDownloadName(name: string): string { return `${randomUUID()}-${basename(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '') || 'download'}`; }

export function importAttachment(root: string, source: string, nodeId?: string): NativeInput {
  const name = basename(source);
  if (/(?:^|[\\/])(?:auth\.json|\.git)(?:[\\/]|$)/i.test(source) || /[\\/]\.mixcat[\\/]codex(?:[\\/]|$)/i.test(source) || source.replace(/^[a-z]:/i, '').includes(':')) throw new Error('运行登录凭据不能作为附件导入。');
  if (!lstatSync(source).isFile()) throw new Error('附件必须是普通文件。');
  for (let parent = dirname(resolve(source)); ; parent = dirname(parent)) {
    if (lstatSync(parent).isSymbolicLink()) throw new Error('附件不能经过符号链接或目录联接。');
    if (dirname(parent) === parent) break;
  }
  const filename = safeDownloadName(name);
  const artifact_id = filename.slice(0, 36);
  const destination = insideProject(root, join(projectDirectory(root, '.mixcat', 'attachments'), filename));
  copyFileSync(source, destination, constants.COPYFILE_EXCL);
  const mixcatAttachment = { artifact_id, name, path: destination };
  if (nodeId && attachmentPreviewMime(name)) {
    const registration = insideProject(root, join(projectDirectory(root, '.mixcat', 'attachment-previews'), `${artifact_id}.json`));
    writeFileSync(registration, JSON.stringify({ nodeId, filename, size: lstatSync(destination).size }), { flag: 'wx' });
  }
  if (/^\.(png|jpe?g|webp|gif)$/i.test(extname(name))) return { type: 'localImage', path: destination, mixcatAttachment };
  if (/^\.(wav|mp3|m4a|ogg|flac|webm)$/i.test(extname(name))) return { type: 'localAudio', path: destination, mixcatAttachment };
  return { type: 'text', text: `附件：${name}\n项目内文件：${destination}`, text_elements: [], mixcatAttachment };
}

export async function readAttachmentPreview(root: string, nodeId: string, artifactId: unknown, thumbnail: boolean): Promise<AttachmentPreview | null> {
  if (typeof artifactId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(artifactId)) throw Error('附件预览编号不正确。');
  const unavailable = '附件没有可读取的预览，请重新选择文件。';
  let registration: { nodeId: string; filename: string; size: number };
  try {
    const file = insideProject(root, join(root, '.mixcat', 'attachment-previews', `${artifactId}.json`));
    const info = lstatSync(file);
    if (!info.isFile() || info.size > 4096) throw Error(unavailable);
    registration = JSON.parse(await readFile(file, 'utf8'));
  } catch { throw Error(unavailable); }
  if (registration?.nodeId !== nodeId || typeof registration.filename !== 'string'
    || !registration.filename.startsWith(`${artifactId}-`) || /[/\\:\x00-\x1f]/.test(registration.filename)
    || !Number.isSafeInteger(registration.size) || registration.size <= 0) throw Error(unavailable);
  const mime = attachmentPreviewMime(registration.filename);
  if (!mime) throw Error(unavailable);
  if (thumbnail && (!mime.startsWith('image/') || registration.size > maxThumbnailBytes)) return null;
  if (registration.size > maxPreviewBytes) throw Error('文件超过 16 MiB，无法在此处预览。可重新选择其他文件。');
  const path = join(root, '.mixcat', 'attachments', registration.filename);
  try {
    panelFilePath(root, path);
    const file = await open(path, 'r');
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size !== registration.size) throw Error(unavailable);
      const bytes = Buffer.alloc(info.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) throw Error(unavailable);
        offset += bytesRead;
      }
      return { mime, url: `data:${mime};base64,${bytes.toString('base64')}` };
    } finally { await file.close(); }
  } catch { throw Error(unavailable); }
}

export function previewType(file: string): string | null {
  const types: Record<string, string> = { '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.pdf': 'application/pdf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm' };
  return types[extname(file).toLowerCase()] ?? null;
}
