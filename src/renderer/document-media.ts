import type { DocumentSource } from '../shared/document-media';

const mimeByExtension: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', mp4: 'video/mp4', webm: 'video/webm' };
const escapeLabel = (name: string) => name.replace(/[\\[\]\r\n]/g, '_');

export function createDocumentMedia(source: DocumentSource) {
  async function importFile(file: File) {
    if (file.size > 20 * 1024 * 1024) throw new Error('媒体文件不能超过 20 MiB。');
    const mime = mimeByExtension[file.name.split('.').at(-1)?.toLowerCase() ?? ''] ?? file.type;
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('无法读取媒体文件。'));
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.readAsDataURL(file);
    });
    if (!window.mixcat?.documentMedia) throw new Error('当前客户端不支持媒体保存，请重新启动最新版本。');
    const result = await window.mixcat.documentMedia({ operation: 'import', source, name: file.name, mime, base64 });
    if (!result.href) throw new Error('媒体未返回保存位置。');
    return result.href;
  }
  return {
    importImages: (files: File[]) => Promise.all(files.map(importFile)),
    async importMedia(files: File[], address: string) {
      if (files.length) return (await Promise.all(files.map(async file => `![${escapeLabel(file.name)}](${await importFile(file)})`))).join('\n\n');
      const href = address.trim();
      if (!/^https?:\/\//i.test(href) || /[\s()<>]/.test(href)) throw new Error('媒体地址须为有效的 HTTP 或 HTTPS 链接。');
      return `![媒体](${href})`;
    },
    async resolveResource(href: string) {
      if (/^https?:\/\//i.test(href) || /^data:(?:image\/(?:png|jpeg|gif|webp)|audio\/(?:mpeg|wav|ogg|mp4)|video\/(?:mp4|webm));base64,[A-Za-z0-9+/]+=*$/i.test(href)) return href;
      if (!window.mixcat?.documentMedia) throw new Error('当前客户端不支持媒体读取。');
      const result = await window.mixcat.documentMedia({ operation: 'read', source, href });
      if (!result.url) throw new Error('媒体文件未返回内容。');
      return result.url;
    },
  };
}
