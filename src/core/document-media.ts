import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { DocumentMediaCommand, DocumentMediaReply, DocumentSource } from '../shared/document-media.js';
import { documentPath } from './project-documents.js';
import { ensureProjectDirectory, insideProject, projectDirectory } from './paths.js';

const maximumBytes = 20 * 1024 * 1024;
const formats: Record<string, { extension: string; matches(bytes: Buffer): boolean }> = {
  'image/png': { extension: 'png', matches: bytes => bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
  'image/jpeg': { extension: 'jpg', matches: bytes => bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 },
  'image/gif': { extension: 'gif', matches: bytes => /^GIF8[79]a/.test(bytes.toString('ascii', 0, 6)) },
  'image/webp': { extension: 'webp', matches: bytes => bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' },
  'audio/mpeg': { extension: 'mp3', matches: bytes => bytes.toString('ascii', 0, 3) === 'ID3' || bytes[0] === 255 && (bytes[1] & 224) === 224 },
  'audio/wav': { extension: 'wav', matches: bytes => bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE' },
  'audio/ogg': { extension: 'ogg', matches: bytes => bytes.toString('ascii', 0, 4) === 'OggS' },
  'audio/mp4': { extension: 'm4a', matches: bytes => bytes.toString('ascii', 4, 8) === 'ftyp' },
  'video/mp4': { extension: 'mp4', matches: bytes => bytes.toString('ascii', 4, 8) === 'ftyp' },
  'video/webm': { extension: 'webm', matches: bytes => bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163])) },
};

export class DocumentMediaStore {
  constructor(private root: string, private projectRoot: (id: string) => string) { ensureProjectDirectory(root); }
  private scope(source: DocumentSource) {
    if (!source || typeof source !== 'object') throw new Error('媒体内容来源不正确。');
    if (source.kind === 'notes') {
      const root = projectDirectory(this.root, '.mixcat', 'notes');
      return { root, directory: root };
    }
    if (source.kind !== 'project' || typeof source.projectId !== 'string' || !/^[\w-]{1,128}$/.test(source.projectId)) throw new Error('媒体必须属于笔记或已打开的项目文档。');
    const root = ensureProjectDirectory(this.projectRoot(source.projectId));
    return { root, directory: dirname(documentPath(root, source.path).absolute) };
  }
  command(input: DocumentMediaCommand): DocumentMediaReply {
    if (!input || !['import', 'read'].includes(input.operation)) throw new Error('媒体操作不正确。');
    const scope = this.scope(input.source);
    if (input.operation === 'import') {
      const format = formats[input.mime];
      if (!format) throw new Error('支持 PNG、JPEG、GIF、WebP 图片及 MP3、WAV、OGG、M4A、MP4、WebM 媒体。');
      if (typeof input.base64 !== 'string' || input.base64.length > Math.ceil(maximumBytes / 3) * 4 || input.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.base64)) throw new Error('媒体数据无效或超过 20 MiB。');
      const bytes = Buffer.from(input.base64, 'base64');
      if (!bytes.length || bytes.length > maximumBytes || !format.matches(bytes)) throw new Error('媒体内容与声明的文件类型不一致，或超过 20 MiB。');
      const name = `${createHash('sha256').update(bytes).digest('hex')}.${format.extension}`;
      const directory = projectDirectory(scope.root, relative(scope.root, scope.directory), 'assets');
      const target = insideProject(scope.root, join(directory, name));
      if (existsSync(target)) {
        const stat = lstatSync(target);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !readFileSync(target).equals(bytes)) throw new Error('媒体目标已存在且内容冲突或是链接。');
      } else writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
      return { href: `assets/${name}` };
    }
    if (typeof input.href !== 'string' || input.href.length > 4096 || /[\0?#]/.test(input.href)) throw new Error('媒体路径不正确。');
    let href: string;
    try { href = decodeURIComponent(input.href).replace(/\\/g, '/'); } catch { throw new Error('媒体路径编码不正确。'); }
    if (!href || isAbsolute(href) || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href.split('/').some(part => ['.git', '.mixcat', '.runtime', 'node_modules'].includes(part.toLowerCase()) || /[\0-\x1f<>:"|?*]/.test(part) || !['.', '..'].includes(part) && /[. ]$/.test(part))) throw new Error('媒体路径必须在内容所属目录内。');
    const target = insideProject(scope.root, resolve(scope.directory, href));
    if (!existsSync(target)) throw new Error('媒体文件不存在。');
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('媒体文件不能是目录或链接。');
    if (stat.size > maximumBytes) throw new Error('媒体文件超过 20 MiB。');
    const extension = extname(target).slice(1).toLowerCase().replace(/^jpeg$/, 'jpg');
    const pair = Object.entries(formats).find(([, format]) => format.extension === extension);
    if (!pair) throw new Error('该资源不是支持的图片或媒体文件。');
    const bytes = readFileSync(target);
    if (bytes.length > maximumBytes || !pair[1].matches(bytes)) throw new Error('媒体内容与文件类型不一致。');
    return { url: `data:${pair[0]};base64,${bytes.toString('base64')}` };
  }
}
