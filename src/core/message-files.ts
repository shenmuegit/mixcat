import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, promises as fs, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import type { AttachmentSnapshot, HostAttachment, MessageAttachmentInput, NativeInput } from '../shared/types.js';
import type { ProjectState, StoredTask } from './model.js';
import { insideProject, projectDirectory } from './paths.js';

function filePath(root: string, value: string, scope?: 'attachments' | 'messages'): string {
  if (typeof value !== 'string' || !value || /[\x00-\x1f:]/.test(value) || isAbsolute(value) || win32.isAbsolute(value) || value.startsWith('\\')) throw new Error('附件必须引用项目内的相对文件路径。');
  const path = insideProject(root, resolve(root, value));
  const parts = relative(root, path).split(sep).map(part => part.toLowerCase());
  if (scope === 'messages' && (parts.length !== 4 || parts[0] !== '.mixcat' || parts[1] !== 'artifacts' || parts[2] !== 'messages')
    || scope === 'attachments' && (parts.length !== 3 || parts[0] !== '.mixcat' || parts[1] !== 'attachments')
    || !scope && parts.some(part => ['.mixcat', '.git', 'auth.json'].includes(part))) throw new Error('附件不能引用保留控制路径。');
  if (!lstatSync(path).isFile()) throw new Error('附件必须是项目内的普通文件。');
  return path;
}

export function taskAttachments(root: string, task: StoredTask): HostAttachment[] {
  const attachments: HostAttachment[] = [];
  for (const item of task.nativeInput ?? []) {
    const registration = item.mixcatAttachment;
    if (!registration || typeof registration !== 'object' || Object.keys(registration).length !== 3
      || typeof registration.artifact_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(registration.artifact_id)
      || typeof registration.name !== 'string' || !registration.name || /[\x00-\x1f/\\:]/.test(registration.name) || typeof registration.path !== 'string') continue;
    try { attachments.push({ ...registration, path: filePath(root, relative(root, registration.path), 'attachments') }); } catch { /* Missing or invalid host files are not registered resources. */ }
  }
  return attachments;
}

function registeredArtifact(root: string, state: ProjectState, id: string): { path: string; name: string; snapshot?: AttachmentSnapshot } {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('附件编号不正确。');
  const snapshot = state.messages.flatMap(message => message.attachments).find(item => item.artifact_id === id);
  if (snapshot) {
    const path = filePath(root, snapshot.relativePath, 'messages'), bytes = readFileSync(path);
    if (snapshot.size !== bytes.length || snapshot.sha256 !== createHash('sha256').update(bytes).digest('hex')) throw new Error('附件快照字节或摘要已变化。');
    return { path, name: snapshot.name, snapshot };
  }
  const imported = state.tasks.flatMap(task => taskAttachments(root, task)).find(item => item.artifact_id === id);
  if (!imported) throw new Error('找不到本项目已登记的附件编号。');
  return imported;
}

export function resolveMessageArtifact(root: string, state: ProjectState, id: string): string { return registeredArtifact(root, state, id).path; }

export async function prepareMessageAttachments(root: string, state: ProjectState, input: MessageAttachmentInput[]): Promise<AttachmentSnapshot[]> {
  const snapshots: AttachmentSnapshot[] = [];
  for (const item of input) {
    const source = 'path' in item && item.path !== undefined ? { path: filePath(root, item.path), name: basename(item.path) } : registeredArtifact(root, state, item.artifact_id!);
    const bytes = await fs.readFile(source.path);
    if ('snapshot' in source && source.snapshot && (bytes.length !== source.snapshot.size || createHash('sha256').update(bytes).digest('hex') !== source.snapshot.sha256)) throw new Error('附件快照字节或摘要已变化。');
    insideProject(root, source.path);
    if (!lstatSync(source.path).isFile()) throw new Error('附件必须是项目内的普通文件。');
    const artifact_id = randomUUID(), name = source.name;
    const destination = insideProject(root, join(projectDirectory(root, '.mixcat', 'artifacts', 'messages'), `${artifact_id}${extname(name).replace(/[^.A-Za-z0-9_-]/g, '_')}`));
    writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 });
    snapshots.push({ artifact_id, name, relativePath: relative(root, destination), sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length });
  }
  return snapshots;
}

export function messageAttachmentInput(root: string, attachments: AttachmentSnapshot[]): NativeInput[] {
  return attachments.flatMap(attachment => {
    const path = filePath(root, attachment.relativePath, 'messages');
    const reference: NativeInput = { type: 'text', text: `附件：${attachment.name}\nartifact_id：${attachment.artifact_id}\n固定文件快照：${path}\nSHA-256：${attachment.sha256}\n请按实际可用的原生能力读取此文件引用。`, text_elements: [] };
    if (/^\.(png|jpe?g|webp|gif)$/i.test(extname(attachment.name))) return [reference, { type: 'localImage', path }];
    if (/^\.(wav|mp3|m4a|ogg|flac|webm)$/i.test(extname(attachment.name))) return [reference, { type: 'localAudio', path }];
    return [reference];
  });
}
