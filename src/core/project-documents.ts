import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { ProjectState } from './model.js';
import type { DocumentRecovery, ManagementState } from '../shared/project-items.js';
import { emptyManagement } from '../shared/project-items.js';
import { insideProject, projectDirectory } from './paths.js';

export const documentHash = (body: string | Buffer) => createHash('sha256').update(body).digest('hex');
function validateDocumentBody(body: string) { if (Buffer.byteLength(body, 'utf8') > 262144) throw new Error('文档正文不能超过 256 KiB。'); }
export interface DocumentChange { path: string; target: string; before: { body: string; hash: string } | null; body: string; operation: 'write' | 'move' | 'trash' | 'restore'; }
interface PendingWrite { id: string; projectId: string; baseRevision: number; next: ManagementState; itemId: string; change: DocumentChange; }
const pendingPath = (root: string) => insideProject(root, join(root, '.mixcat', 'state', 'document-pending.json'));

export function documentPath(root: string, value: unknown): { absolute: string; path: string } {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.startsWith('\\')) throw new Error('文档必须使用项目内部的相对路径。');
  const parts = value.replace(/\\/g, '/').split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || ['.git', '.mixcat', '.runtime'].includes(part.toLowerCase())
    || /[\x00-\x1f<>:"|?*]/.test(part) || /^(con(?:in|out)?\$?|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part))) throw new Error('文档路径包含保留目录或不安全路径。');
  if (!/\.(md|markdown)$/i.test(value)) throw new Error('文档须为 Markdown 文件。');
  const absolute = insideProject(root, resolve(root, ...parts));
  if (existsSync(absolute)) {
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('文档必须是无链接的普通文件。');
  }
  return { absolute, path: relative(root, absolute).replace(/\\/g, '/') };
}
function readMarkdown(target: string, label: string) {
  if (!existsSync(target)) throw new Error(`文档文件缺失：${label}`);
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('文档必须是无链接的普通文件。');
  if (stat.size > 262144) throw new Error('文档超过 256 KiB，请先拆分后纳入管理。');
  const bytes = readFileSync(target); if (bytes.length > 262144) throw new Error('文档正文不能超过 256 KiB。');
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('文档必须是有效的 UTF-8 文本。'); }
  return { body: bytes.toString('utf8'), hash: documentHash(bytes), modifiedAt: stat.mtime.toISOString() };
}
export function readDocument(root: string, path: string) { return readMarkdown(documentPath(root, path).absolute, path); }
export function documentTrashPath(root: string, itemId: string) {
  if (typeof itemId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(itemId)) throw new Error('文档回收标识不正确。');
  return insideProject(root, join(root, '.mixcat', 'document-trash', `${itemId}.md`));
}
export function readTrashedDocument(root: string, itemId: string) { return readMarkdown(documentTrashPath(root, itemId), '回收站文档'); }
function readIfPresent(path: string) { return existsSync(path) ? readMarkdown(path, path) : null; }
function applyFile(root: string, itemId: string, change: DocumentChange) {
  validateDocumentBody(change.body);
  const source = change.operation === 'restore' ? documentTrashPath(root, itemId) : documentPath(root, change.path).absolute;
  const target = change.operation === 'trash' ? documentTrashPath(root, itemId) : documentPath(root, change.target).absolute;
  const actual = readIfPresent(source);
  const wanted = documentHash(change.body);
  if (change.operation !== 'write') {
    const destination = readIfPresent(target);
    if (!actual && destination?.hash === wanted) return;
    if (actual?.hash !== change.before?.hash || destination) throw new Error('文档移动发生冲突，源文件已变更或目标已存在。');
    if (dirname(target).toLowerCase() !== root.toLowerCase()) projectDirectory(root, relative(root, dirname(target)));
    renameSync(source, target); return;
  }
  if (actual?.hash === wanted) return;
  if ((actual?.hash ?? null) !== (change.before?.hash ?? null)) throw new Error('文档已被外部修改，保存发生冲突。');
  if (dirname(target).toLowerCase() !== root.toLowerCase()) projectDirectory(root, relative(root, dirname(target)));
  const temporary = insideProject(root, join(dirname(target), `.${randomUUID()}.tmp`));
  try {
    writeFileSync(temporary, change.body, { flag: 'wx', flush: true });
    if ((readIfPresent(source)?.hash ?? null) !== (change.before?.hash ?? null)) throw new Error('文档在保存前发生外部修改，未覆盖。');
    renameSync(temporary, target);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
function pending(root: string): PendingWrite | null {
  const path = pendingPath(root); if (!existsSync(path)) return null;
  const value = JSON.parse(readFileSync(path, 'utf8')) as PendingWrite;
  if (!value || typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(value.id) || !Number.isSafeInteger(value.baseRevision)
    || value.next?.revision !== value.baseRevision + 1 || !Array.isArray(value.next.items) || !value.change || typeof value.change.body !== 'string') throw new Error('文档恢复记录格式损坏。');
  const legacy = value.change as DocumentChange & { move?: boolean };
  if (legacy.operation === undefined && typeof legacy.move === 'boolean') legacy.operation = legacy.move ? 'move' : 'write';
  if (!['write', 'move', 'trash', 'restore'].includes(value.change.operation)
    || value.change.operation !== 'write' && (!value.change.before || documentHash(value.change.body) !== value.change.before.hash)) throw new Error('文档恢复记录的操作无效。');
  documentTrashPath(root, value.itemId); documentPath(root, value.change.path); documentPath(root, value.change.target);
  const item = value.next.items.find(item => item?.id === value.itemId);
  if (item?.kind !== 'document' || item.path !== value.change.target) throw new Error('文档恢复记录的对象或路径无效。');
  return value;
}
export function documentRecovery(root: string): DocumentRecovery | undefined {
  try {
    const entry = pending(root);
    return entry ? { id: entry.id, itemId: entry.itemId, path: entry.change.target, draft: entry.change.body,
      message: entry.change.operation === 'write' ? '一项文档保存尚未确认完成。重启可尝试恢复；也可保留磁盘现状并取消这次保存，草稿仍在恢复记录中。'
        : '一项文档移动、删除或恢复尚未确认完成。重启可尝试恢复；取消会在文件未再次变化时撤回文件位置，冲突时保留现场。' } : undefined;
  } catch {
    const bytes = readFileSync(pendingPath(root));
    return { id: `damaged-${documentHash(bytes)}`, itemId: '', path: '', draft: '', message: '文档恢复记录损坏，无法自动恢复。可以取消此次保存；原始恢复记录会保留，磁盘文档不会被覆盖。' };
  }
}
export function commitDocument(root: string, state: ProjectState, next: ManagementState, itemId: string, change: DocumentChange, commit: () => void) {
  validateDocumentBody(change.body);
  if (existsSync(pendingPath(root))) throw new Error('请先处理尚未确认的文档保存。');
  const entry: PendingWrite = { id: randomUUID(), projectId: state.project.id, baseRevision: state.management?.revision ?? 0, next, itemId, change };
  const temporary = insideProject(root, join(root, '.mixcat', 'state', `document-${entry.id}.tmp`));
  try {
    writeFileSync(temporary, JSON.stringify(entry), { flag: 'wx', flush: true });
    renameSync(temporary, pendingPath(root));
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  applyFile(root, itemId, change); commit(); unlinkSync(pendingPath(root));
}
export function recoverDocument(root: string, state: ProjectState, save: (state: ProjectState) => void): void {
  let entry: PendingWrite | null;
  try { entry = pending(root); } catch { (state.management ??= emptyManagement()).recovery = documentRecovery(root); return; }
  if (!entry) return;
  try {
    if (entry.projectId !== state.project.id) throw new Error('文档恢复记录所属项目不同。');
    const current = state.management?.revision ?? 0;
    if (current === entry.next.revision && state.management?.receipts.some(receipt => receipt.key === entry.next.receipts.at(-1)?.key)) { unlinkSync(pendingPath(root)); return; }
    if (current !== entry.baseRevision) throw new Error('文档恢复记录与当前管理版本冲突。');
    applyFile(root, entry.itemId, entry.change);
    const recovered = { ...state, management: entry.next }; save(recovered); state.management = entry.next; unlinkSync(pendingPath(root));
  } catch (error) { (state.management ??= emptyManagement()).recovery = { ...documentRecovery(root)!, message: `恢复暂停：${error instanceof Error ? error.message : String(error)}` }; }
}
export function cancelDocumentWrite(root: string, recoveryId: string, management: ManagementState | undefined) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(recoveryId)) throw new Error('恢复编号不正确。');
  const archived = insideProject(root, join(root, '.mixcat', 'state', `document-cancelled-${recoveryId}.json`));
  const current = documentRecovery(root);
  if (!current && existsSync(archived)) return;
  if (current?.id !== recoveryId) throw new Error('恢复记录已改变，请刷新后处理。');
  let entry: PendingWrite | null = null;
  try { entry = pending(root); } catch { /* A damaged record is retained without guessing its file operation. */ }
  if (entry && entry.change.operation !== 'write' && !(management?.revision === entry.next.revision && management.receipts.some(receipt => receipt.key === entry!.next.receipts.at(-1)?.key))) {
    if ((management?.revision ?? 0) !== entry.baseRevision) throw new Error('文档恢复记录与当前管理版本冲突。');
    const change = entry.change, source = change.operation === 'restore' ? documentTrashPath(root, entry.itemId) : documentPath(root, change.path).absolute;
    const target = change.operation === 'trash' ? documentTrashPath(root, entry.itemId) : documentPath(root, change.target).absolute;
    if (!existsSync(source)) {
      if (readIfPresent(target)?.hash !== documentHash(change.body)) throw new Error('文件在待恢复操作后发生变化，不能自动撤回。');
      applyFile(root, entry.itemId, { path: change.target, target: change.path, before: { body: change.body, hash: documentHash(change.body) }, body: change.body,
        operation: change.operation === 'trash' ? 'restore' : change.operation === 'restore' ? 'trash' : 'move' });
    } else if (existsSync(target)) throw new Error('源位置和目标位置都已有文件，不能自动撤回。');
  }
  renameSync(pendingPath(root), archived);
}
