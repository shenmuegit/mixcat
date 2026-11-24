import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { constants, copyFileSync, existsSync, linkSync, lstatSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync, type BigIntStats } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import type { ProjectState } from './model.js';
import type { DocumentRecovery, ManagementState } from '../shared/project-items.js';
import { emptyManagement } from '../shared/project-items.js';
import { insideProject, projectDirectory } from './paths.js';

export const documentHash = (body: string | Buffer) => createHash('sha256').update(body).digest('hex');
function validateDocumentBody(body: string) { if (Buffer.byteLength(body, 'utf8') > 262144) throw new Error('文档正文不能超过 256 KiB。'); }
export interface DocumentChange { path: string; target: string; before: { body: string; hash: string } | null; body: string; operation: 'create_empty' | 'write' | 'move' | 'edit_move' | 'trash' | 'restore'; }
interface PendingWrite {
  id: string; projectId: string; baseRevision: number; next: ManagementState; itemId: string; change: DocumentChange;
  published?: { device: string; inode: string };
}
const pendingPath = (root: string) => insideProject(root, join(root, '.mixcat', 'state', 'document-pending.json'));
const originalPath = (root: string, id: string) => insideProject(root, join(root, '.mixcat', 'state', `document-${id}-original.md`));
const stagingPath = (root: string, id: string) => insideProject(root, join(root, '.mixcat', 'state', `document-${id}-staged.md`));
const withdrawnPath = (root: string, id: string) => insideProject(root, join(root, '.mixcat', 'state', `document-${id}-withdrawn.md`));
const reservedName = /^(con(?:in|out)?\$?|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i;
export const untitledDocument = '未命名';

function resolveDocumentPath(root: string, value: unknown): { absolute: string; path: string } {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.startsWith('\\')) throw new Error('文档必须使用项目内部的相对路径。');
  const parts = value.replace(/\\/g, '/').split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || ['.git', '.mixcat', '.runtime'].includes(part.toLowerCase())
    || /[\x00-\x1f<>:"|?*]/.test(part) || reservedName.test(part))) throw new Error('文档路径包含保留目录或不安全路径。');
  if (!/\.(md|markdown)$/i.test(value)) throw new Error('文档须为 Markdown 文件。');
  const absolute = insideProject(root, resolve(root, ...parts));
  return { absolute, path: relative(root, absolute).replace(/\\/g, '/') };
}
export function documentPath(root: string, value: unknown) {
  const path = resolveDocumentPath(root, value);
  if (existsSync(path.absolute)) {
    const stat = lstatSync(path.absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('文档必须是无链接的普通文件。');
  }
  return path;
}
export function availableDocumentPath(root: string, title: string, claimedPaths: string[], currentPath?: string) {
  const directory = currentPath ? posix.dirname(currentPath) : 'docs';
  const extension = currentPath?.match(/\.(?:md|markdown)$/i)?.[0] ?? '.md';
  const parent = directory === '.' ? root : insideProject(root, join(root, directory));
  const current = currentPath && documentPath(root, currentPath).absolute;
  const currentName = current && existsSync(current) ? basename(realpathSync.native(current)) : undefined;
  const occupied = new Set((existsSync(parent) ? readdirSync(parent) : []).filter(name => name !== currentName).map(name => name.toLowerCase()));
  for (const path of claimedPaths) {
    if (posix.dirname(path).toLowerCase() === directory.toLowerCase()) occupied.add(posix.basename(path).toLowerCase());
  }
  const markdownNames = new Set([...occupied].filter(name => /\.(?:md|markdown)$/.test(name)).map(name => name.replace(/\.(?:md|markdown)$/, '')));
  const clean = title.normalize('NFC').trim().replace(/[\x00-\x1f<>:"/\\|?*]+/g, '-').replace(/^\.+|[. ]+$/g, '').trim();
  let stem = '', bytes = 0;
  for (const character of clean) {
    bytes += Buffer.byteLength(character, 'utf8');
    if (bytes > 220) break; // Leave room for the extension and a numeric suffix.
    stem += character;
  }
  stem = stem.replace(/[. ]+$/g, '') || untitledDocument;
  if (reservedName.test(stem)) stem = `_${stem}`;
  for (let number = 1; ; number++) {
    const candidate = number === 1 ? stem : `${stem} ${number}`;
    const name = candidate + extension, absolute = join(parent, name);
    // An occupied short filename on Windows may not appear in the directory listing.
    if (markdownNames.has(candidate.toLowerCase()) || occupied.has(name.toLowerCase())
      || existsSync(absolute) && absolute !== current && !(current && sameCaseInsensitiveEntry(current, absolute))) continue;
    return documentPath(root, posix.join(directory, name));
  }
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
function sameCaseInsensitiveEntry(source: string, target: string) {
  return source !== target && source.toLowerCase() === target.toLowerCase() && existsSync(source) && existsSync(target)
    && realpathSync.native(source) === realpathSync.native(target);
}
function changePaths(root: string, itemId: string, change: DocumentChange) {
  const resolvePath = change.operation === 'create_empty' || change.operation === 'edit_move' ? resolveDocumentPath : documentPath;
  return {
    source: change.operation === 'restore' ? documentTrashPath(root, itemId) : resolvePath(root, change.path).absolute,
    target: change.operation === 'trash' ? documentTrashPath(root, itemId) : resolvePath(root, change.target).absolute,
  };
}
function writePending(root: string, entry: PendingWrite) {
  const temporary = insideProject(root, join(root, '.mixcat', 'state', `document-${randomUUID()}.tmp`));
  try {
    writeFileSync(temporary, JSON.stringify(entry), { flag: 'wx', flush: true });
    renameSync(temporary, pendingPath(root));
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
function fileIdentity(stat: BigIntStats) { return { device: String(stat.dev), inode: String(stat.ino) }; }
function matchesIdentity(stat: BigIntStats | undefined, identity: PendingWrite['published']) {
  return !!stat?.isFile() && !!identity && identity.inode !== '0' && String(stat.dev) === identity.device && String(stat.ino) === identity.inode;
}
function linkOrMoveExclusive(source: string, target: string) {
  try {
    linkSync(source, target);
  } catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS', 'EINVAL'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    // FAT volumes have no hard links, but Windows can move a file without replacing its destination.
    const move = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference='Stop'; [IO.File]::Move($env:MIXCAT_DOCUMENT_MOVE_SOURCE,$env:MIXCAT_DOCUMENT_MOVE_TARGET)"], {
      env: { ...process.env, MIXCAT_DOCUMENT_MOVE_SOURCE: source, MIXCAT_DOCUMENT_MOVE_TARGET: target },
      windowsHide: true, timeout: 10000, stdio: 'ignore',
    });
    if (move.status !== 0) {
      if (existsSync(target)) throw Object.assign(new Error('文档目标已存在，不能覆盖。'), { code: 'EEXIST' });
      throw new Error('无法将暂存文档发布到目标位置。');
    }
    return true;
  }
  return false;
}
function finishStagingLink(staged: string, target: string, entry: PendingWrite) {
  const original = lstatSync(staged, { bigint: true, throwIfNoEntry: false }), destination = lstatSync(target, { bigint: true, throwIfNoEntry: false });
  if (matchesIdentity(original, entry.published) && matchesIdentity(destination, entry.published) && original?.nlink === 2n && destination?.nlink === 2n) unlinkSync(staged);
}
function publishedIdentityMatches(target: string, entry: PendingWrite) {
  const stat = lstatSync(target, { bigint: true, throwIfNoEntry: false });
  return matchesIdentity(stat, entry.published) && stat?.nlink === 1n;
}
function publishedContentMatches(target: string, entry: PendingWrite) {
  if (!publishedIdentityMatches(target, entry)) return false;
  try { return readIfPresent(target)?.hash === documentHash(entry.change.body); }
  catch { return false; }
}
function isTitleOnlyRename(change: DocumentChange) {
  return change.operation === 'edit_move' && change.before?.hash === documentHash(change.body);
}
function documentStage(root: string, entry: PendingWrite) {
  return (isTitleOnlyRename(entry.change) ? originalPath : stagingPath)(root, entry.id);
}
function publishDocument(root: string, target: string, entry: PendingWrite) {
  const staged = documentStage(root, entry), wanted = documentHash(entry.change.body);
  if (!entry.published) {
    if (!existsSync(staged) && !isTitleOnlyRename(entry.change)) writeFileSync(staged, entry.change.body, { flag: 'wx', flush: true });
    if (readMarkdown(staged, entry.change.target).hash !== wanted) throw new Error('暂存正文不完整，无法发布。');
    entry.published = fileIdentity(lstatSync(staged, { bigint: true }));
    writePending(root, entry);
  }
  finishStagingLink(staged, target, entry);
  if (existsSync(staged)) {
    const identity = fileIdentity(lstatSync(staged, { bigint: true }));
    if (identity.device !== entry.published.device || identity.inode !== entry.published.inode
      || readMarkdown(staged, entry.change.target).hash !== wanted) throw new Error('暂存正文已变化，无法发布。');
    if (dirname(target).toLowerCase() !== root.toLowerCase()) projectDirectory(root, relative(root, dirname(target)));
    if (linkOrMoveExclusive(staged, target)) {
      entry.published = fileIdentity(lstatSync(target, { bigint: true }));
      writePending(root, entry);
      // Only the successful move can establish ownership on volumes that report no file index.
      if (entry.published.inode === '0' && readIfPresent(target)?.hash === wanted) return;
    } else finishStagingLink(staged, target, entry);
  }
  if (!publishedContentMatches(target, entry)) throw new Error('文档目标已变化，无法确认此次保存。');
}
function applyDocumentChange(root: string, entry: PendingWrite) {
  const { itemId, change } = entry;
  if (change.operation !== 'create_empty' && change.operation !== 'edit_move') { applyFile(root, itemId, change); return; }
  const { source, target } = changePaths(root, itemId, change);
  if (change.operation === 'create_empty') { publishDocument(root, target, entry); return; }
  const backup = originalPath(root, entry.id), expected = change.before!.hash;
  if (!existsSync(backup) && !entry.published) {
    if (readIfPresent(source)?.hash !== expected) throw new Error('文档改名发生冲突，源文件已变更。');
    if (existsSync(target) && !sameCaseInsensitiveEntry(source, target)) throw new Error('文档改名的目标已存在，不能覆盖。');
    renameSync(source, backup);
  }
  // A name-only edit carries the existing file to the new path, including any open handles.
  if (!isTitleOnlyRename(change) && readIfPresent(backup)?.hash !== expected) throw new Error('文档在改名时被外部修改，原始文件已保留。');
  publishDocument(root, target, entry);
}
function applyFile(root: string, itemId: string, change: DocumentChange) {
  validateDocumentBody(change.body);
  const { source, target } = changePaths(root, itemId, change);
  const wanted = documentHash(change.body);
  const actual = readIfPresent(source);
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
  if (!['create_empty', 'write', 'move', 'edit_move', 'trash', 'restore'].includes(value.change.operation)
    || value.change.operation === 'create_empty' && (value.change.before !== null || value.change.body !== '' || value.change.path !== value.change.target)
    || !['create_empty', 'write'].includes(value.change.operation) && (!value.change.before
      || (value.change.operation === 'edit_move' ? typeof value.change.before.body !== 'string' || documentHash(value.change.before.body) !== value.change.before.hash
        : documentHash(value.change.body) !== value.change.before.hash))) throw new Error('文档恢复记录的操作无效。');
  if (value.change.operation === 'edit_move' && (value.change.path === value.change.target || posix.dirname(value.change.path) !== posix.dirname(value.change.target))) throw new Error('文档改名恢复记录的路径无效。');
  if (value.published && (!['create_empty', 'edit_move'].includes(value.change.operation)
    || !/^-?\d+$/.test(value.published.device) || !/^\d+$/.test(value.published.inode))) throw new Error('文档写入凭据无效。');
  const validatePath = value.change.operation === 'create_empty' || value.change.operation === 'edit_move' ? resolveDocumentPath : documentPath;
  documentTrashPath(root, value.itemId); validatePath(root, value.change.path); validatePath(root, value.change.target);
  const item = value.next.items.find(item => item?.id === value.itemId);
  if (item?.kind !== 'document' || item.path !== value.change.target) throw new Error('文档恢复记录的对象或路径无效。');
  return value;
}
export function documentRecovery(root: string): DocumentRecovery | undefined {
  try {
    const entry = pending(root);
    return entry ? { id: entry.id, itemId: entry.itemId, path: entry.change.target, draft: entry.change.body,
      message: entry.change.operation === 'edit_move' && existsSync(originalPath(root, entry.id))
        ? `文档改名尚未完成。原文件保存在 .mixcat/state/document-${entry.id}-original.md。取消时会尝试恢复原路径，保留冲突文件。`
        : entry.change.operation === 'write' || entry.change.operation === 'create_empty' ? '一项文档保存尚未确认完成。重启可尝试恢复；也可保留磁盘现状并取消这次保存，草稿仍在恢复记录中。'
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
  writePending(root, entry);
  applyDocumentChange(root, entry);
  commit(); unlinkSync(pendingPath(root));
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
    applyDocumentChange(root, entry);
    const recovered = { ...state, management: entry.next }; save(recovered); state.management = entry.next; unlinkSync(pendingPath(root));
  } catch (error) { (state.management ??= emptyManagement()).recovery = { ...documentRecovery(root)!, message: `恢复暂停：${error instanceof Error ? error.message : String(error)}` }; }
}
function withdrawDocument(root: string, entry: PendingWrite, target: string) {
  const staged = documentStage(root, entry), withdrawn = withdrawnPath(root, entry.id);
  const matches = isTitleOnlyRename(entry.change) ? publishedIdentityMatches : publishedContentMatches;
  finishStagingLink(staged, target, entry);
  if (!existsSync(withdrawn) && matches(target, entry)) renameSync(target, withdrawn);
  if (existsSync(withdrawn) && !matches(withdrawn, entry) && !existsSync(target)) {
    try { copyFileSync(withdrawn, target, constants.COPYFILE_EXCL); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
}
function cancelTitleChange(root: string, entry: PendingWrite, source: string, target: string) {
  withdrawDocument(root, entry, target);
  const original = originalPath(root, entry.id), withdrawn = withdrawnPath(root, entry.id);
  const backup = isTitleOnlyRename(entry.change) && !existsSync(original) && publishedIdentityMatches(withdrawn, entry) ? withdrawn : original;
  if (!existsSync(backup) || existsSync(source)) return;
  const stat = lstatSync(backup);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('改名前的文档不是普通文件，无法恢复。');
  try { copyFileSync(backup, source, constants.COPYFILE_EXCL); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return; throw error; }
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
    const change = entry.change, { source, target } = changePaths(root, entry.itemId, change);
    if (change.operation === 'create_empty') {
      withdrawDocument(root, entry, target);
    } else if (change.operation === 'edit_move') {
      cancelTitleChange(root, entry, source, target);
    } else if (!existsSync(source)) {
      const file = readIfPresent(target);
      if (!file || file.hash !== documentHash(change.body)) throw new Error('文件在待恢复操作后发生变化，不能自动撤回。');
      applyFile(root, entry.itemId, { path: change.target, target: change.path, before: file, body: file.body,
        operation: change.operation === 'trash' ? 'restore' : change.operation === 'restore' ? 'trash' : 'move' });
    } else if (existsSync(target)) throw new Error('源位置和目标位置都已有文件，不能自动撤回。');
  }
  renameSync(pendingPath(root), archived);
}
