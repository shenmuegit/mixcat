import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, promises as fs, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import type { AttachmentSnapshot, HostAttachment, HumanReviewView, MessageAttachmentInput, NativeInput } from '../shared/types.js';
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
  const snapshot = [...state.messages.flatMap(message => message.attachments), ...state.humanReviews.flatMap(review => review.attachments)].find(item => item.artifact_id === id);
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

export function resolveAttachmentSource(root: string, state: ProjectState, input: MessageAttachmentInput): { path: string; name: string; snapshot?: AttachmentSnapshot } {
  return 'path' in input && input.path !== undefined ? { path: filePath(root, input.path), name: basename(input.path) } : registeredArtifact(root, state, input.artifact_id!);
}

function textDifference(name: string, saved: Buffer, current: Buffer): string {
  if (!/\.(txt|md|markdown|json|csv|html?|css|[cm]?[jt]sx?|ya?ml|xml|svg|py|rs|go|java|sql|sh|ps1|toml|ini)$/i.test(name)) return '二进制或不支持的文件类型，无法提供文本比较。';
  if (Math.max(saved.length, current.length) > 64 * 1024) return '文本超过 64 KiB，无法提供有界文本比较；请查看固定材料和当前文件。';
  let before: string, after: string;
  try { const decoder = new TextDecoder('utf-8', { fatal: true }); before = decoder.decode(saved); after = decoder.decode(current); }
  catch { return '非 UTF-8 或二进制内容，无法提供文本比较。'; }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(before + after)) return '二进制内容，无法提供文本比较。';
  const left = before.split('\n'), right = after.split('\n'); let line = 0;
  while (line < Math.min(left.length, right.length) && left[line] === right[line]) line++;
  // shortcut: show the first changed region, use a full diff viewer if larger comparisons are requested.
  const excerpt = (lines: string[], sign: string) => lines.slice(line, line + 5).map(value => `${sign} ${value.slice(0, 240)}${value.length > 240 ? '…' : ''}`).join('\n') || `${sign} [文件结束]`;
  return `文本差异从第 ${line + 1} 行起（最多各 5 行，每行 240 字符；- 保存 / + 当前）：\n${excerpt(left, '-')}\n${excerpt(right, '+')}`;
}

export async function validateReviewOwnMaterials(root: string, state: ProjectState, review: HumanReviewView, relation = '本事项'): Promise<void> {
  async function check(saved: { sha256: string; size: number }, label: string, resolvePath: () => string, snapshot?: AttachmentSnapshot, name?: string) {
    let bytes: Buffer | undefined, unavailable: string | undefined;
    try { bytes = await fs.readFile(resolvePath()); resolvePath(); }
    catch (error) { const code = (error as NodeJS.ErrnoException).code; unavailable = code === 'ENOENT' ? '文件缺失（ENOENT）' : `文件不可读或路径不安全（${code ?? (error instanceof Error ? error.message : String(error))}）`; }
    const digest = bytes && createHash('sha256').update(bytes).digest('hex');
    if (!unavailable && bytes && saved.size === bytes.length && saved.sha256 === digest) return;
    let difference = '原始字节未单独保留，无法提供文本比较；请依据保存的摘要核对并提交新版本。';
    if (unavailable) difference = `${unavailable}，无法提供文本比较。`;
    else if (snapshot && bytes) {
      try {
        const path = filePath(root, snapshot.relativePath, 'messages'), original = await fs.readFile(path);
        filePath(root, snapshot.relativePath, 'messages');
        if (original.length !== saved.size || createHash('sha256').update(original).digest('hex') !== saved.sha256) difference = '保存的固定快照也已变化，无法提供可信文本比较。';
        else difference = textDifference(name!, original, bytes);
      } catch { difference = '保存的固定快照缺失、不可读或路径不安全，无法提供文本比较。'; }
    }
    throw new Error(`${relation} ${review.checkpointId} · 版本 ${review.version} · ${review.id}\n${label}\n核对材料已变化，请提交新版本。\n保存 SHA-256 ${saved.sha256} · ${saved.size} 字节\n当前 ${unavailable ? `${unavailable} · SHA-256 和字节数不可用` : `SHA-256 ${digest} · ${bytes!.length} 字节`}\n${difference}`);
  }
  for (const source of review.sourceFiles) {
    const snapshot = review.attachments.find(item => item.sha256 === source.sha256 && item.size === source.size);
    await check(source, `源文件 ${source.path}${snapshot ? ` · artifact_id ${snapshot.artifact_id}` : ''}`, () => resolveAttachmentSource(root, state, { path: source.path }).path, snapshot, source.path);
  }
  for (const snapshot of review.attachments) {
    await check(snapshot, `固定附件 ${snapshot.relativePath} · artifact_id ${snapshot.artifact_id}`, () => filePath(root, snapshot.relativePath, 'messages'));
  }
}

export async function validateReviewMaterials(root: string, state: ProjectState, review: HumanReviewView): Promise<void> {
  const visited = new Set<string>();
  async function visit(current: HumanReviewView): Promise<void> {
    if (visited.has(current.id)) return;
    visited.add(current.id);
    await validateReviewOwnMaterials(root, state, current, current.id === review.id ? '本事项' : '上游事项');
    for (const dependency of current.upstreamDependencies) {
      if (dependency.reviewId === null || dependency.version === null) continue;
      const upstream = state.humanReviews.find(item => item.id === dependency.reviewId && item.version === dependency.version);
      if (upstream) await visit(upstream);
    }
  }
  await visit(review);
}

export async function prepareMessageAttachments(root: string, state: ProjectState, input: MessageAttachmentInput[]): Promise<AttachmentSnapshot[]> {
  const snapshots: AttachmentSnapshot[] = [];
  for (const item of input) {
    const source = resolveAttachmentSource(root, state, item);
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
