import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { constants, copyFileSync, existsSync, linkSync, lstatSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync, type BigIntStats } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import type { ProjectState } from './model.js';
import type { ManagementState } from '../shared/project-items.js';
import { documentDeleteCleanupMessage } from '../shared/project-items.js';
import { insideProject, projectDirectory } from './paths.js';

export const documentHash = (body: string | Buffer) => createHash('sha256').update(body).digest('hex');
function validateDocumentBody(body: string) { if (Buffer.byteLength(body, 'utf8') > 262144) throw new Error('文档正文不能超过 256 KiB。'); }
export interface DocumentChange { path: string; target: string; before: { hash: string } | null; body: string; operation: 'create_empty' | 'write' | 'move' | 'edit_move' | 'delete'; }
type LegacyChange = Omit<DocumentChange, 'before' | 'operation'> & {
  before: { body: string; hash: string } | null;
  operation: Exclude<DocumentChange['operation'], 'delete'> | 'trash' | 'restore';
};
interface FileIdentity { device: string; inode: string; }
interface PendingWrite {
  id: string; projectId: string; baseRevision: number; next: ManagementState; itemId: string; change: LegacyChange;
  published?: FileIdentity;
}
interface DocumentTransaction {
  id: string; projectId: string; itemId: string; receiptKey: string; source: string; target: string;
  beforeHash: string | null; afterHash: string | null; published?: FileIdentity;
}
const transactionPath = (root: string) => insideProject(root, join(root, '.mixcat', 'state', 'document-transaction.json'));
const transactionUpdatePath = (root: string) => insideProject(root, join(root, '.mixcat', 'state', 'document-transaction.tmp'));
const transactionFile = (root: string, id: string, role: 'original' | 'staged') => insideProject(root, join(root, '.mixcat', 'state', `document-transaction-${id}-${role}.md`));
const pendingPath = (root: string) => insideProject(root, join(root, '.mixcat', 'state', 'document-pending.json'));
const originalPath = (root: string, id: string) => insideProject(root, join(root, '.mixcat', 'state', `document-${id}-original.md`));
const stagingPath = (root: string, id: string) => insideProject(root, join(root, '.mixcat', 'state', `document-${id}-staged.md`));
const withdrawnPath = (root: string, id: string) => insideProject(root, join(root, '.mixcat', 'state', `document-${id}-withdrawn.md`));
const legacyRollbackPath = (root: string, id: string, role: 'staged' | 'withdrawn') => insideProject(root, join(root, '.mixcat', 'state', `document-legacy-${id}-${role}.md`));
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
    const suffix = number === 1 ? '' : ` ${number}`;
    const prefix = stem.slice(0, 200 - suffix.length).replace(/[\uD800-\uDBFF.\s]+$/g, '');
    const candidate = prefix + suffix;
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
function legacyTrashPath(root: string, itemId: string) {
  if (typeof itemId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(itemId)) throw new Error('文档回收标识不正确。');
  return insideProject(root, join(root, '.mixcat', 'document-trash', `${itemId}.md`));
}
function readIfPresent(path: string) { return existsSync(path) ? readMarkdown(path, path) : null; }
export function sameCaseInsensitiveEntry(source: string, target: string) {
  return source !== target && source.toLowerCase() === target.toLowerCase() && existsSync(source) && existsSync(target)
    && realpathSync.native(source) === realpathSync.native(target);
}
function legacyPaths(root: string, itemId: string, change: LegacyChange) {
  return {
    source: change.operation === 'restore' ? legacyTrashPath(root, itemId) : resolveDocumentPath(root, change.path).absolute,
    target: change.operation === 'trash' ? legacyTrashPath(root, itemId) : resolveDocumentPath(root, change.target).absolute,
  };
}
function writeTransaction(root: string, entry: DocumentTransaction) {
  const temporary = transactionUpdatePath(root);
  writeFileSync(temporary, JSON.stringify(entry), { flag: 'wx', flush: true });
  try {
    renameSync(temporary, transactionPath(root));
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
function fileIdentity(stat: BigIntStats) { return { device: String(stat.dev), inode: String(stat.ino) }; }
function matchesIdentity(stat: BigIntStats | undefined, identity: FileIdentity | undefined) {
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
function finishStagingLink(staged: string, target: string, identity: FileIdentity | undefined) {
  const original = lstatSync(staged, { bigint: true, throwIfNoEntry: false }), destination = lstatSync(target, { bigint: true, throwIfNoEntry: false });
  if (matchesIdentity(original, identity) && matchesIdentity(destination, identity) && original?.nlink === 2n && destination?.nlink === 2n) unlinkSync(staged);
}
function publishedIdentityMatches(target: string, identity: FileIdentity | undefined) {
  const stat = lstatSync(target, { bigint: true, throwIfNoEntry: false });
  return matchesIdentity(stat, identity) && stat?.nlink === 1n;
}
function fileContentMatches(target: string, hash: string) {
  try { return readIfPresent(target)?.hash === hash; }
  catch { return false; }
}
function publishedContentMatches(target: string, identity: FileIdentity | undefined, hash: string) {
  return publishedIdentityMatches(target, identity) && fileContentMatches(target, hash);
}
function isTitleOnlyRename(change: LegacyChange) {
  return change.operation === 'edit_move' && change.before?.hash === documentHash(change.body);
}
function documentStage(root: string, entry: PendingWrite) {
  return (isTitleOnlyRename(entry.change) ? originalPath : stagingPath)(root, entry.id);
}
function legacyPending(root: string): PendingWrite | null {
  const path = pendingPath(root); if (!existsSync(path)) return null;
  const value = JSON.parse(readFileSync(path, 'utf8')) as PendingWrite;
  if (!value || typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.id) || !Number.isSafeInteger(value.baseRevision)
    || value.next?.revision !== value.baseRevision + 1 || !Array.isArray(value.next.items) || !Array.isArray(value.next.receipts)
    || !value.change || typeof value.change.body !== 'string') throw new Error('文档恢复记录格式损坏。');
  const legacy = value.change as LegacyChange & { move?: boolean };
  if (legacy.operation === undefined && typeof legacy.move === 'boolean') legacy.operation = legacy.move ? 'move' : 'write';
  if (!['create_empty', 'write', 'move', 'edit_move', 'trash', 'restore'].includes(value.change.operation)
    || value.change.operation === 'create_empty' && (value.change.before !== null || value.change.body !== '' || value.change.path !== value.change.target)
    || value.change.operation === 'write' && (value.change.path !== value.change.target || value.change.before !== null
      && (typeof value.change.before?.body !== 'string' || documentHash(value.change.before.body) !== value.change.before.hash))
    || !['create_empty', 'write'].includes(value.change.operation) && (!value.change.before
      || (value.change.operation === 'edit_move' ? typeof value.change.before.body !== 'string' || documentHash(value.change.before.body) !== value.change.before.hash
        : documentHash(value.change.body) !== value.change.before.hash))) throw new Error('文档恢复记录的操作无效。');
  if (value.change.operation === 'edit_move' && (value.change.path === value.change.target || posix.dirname(value.change.path) !== posix.dirname(value.change.target))) throw new Error('文档改名恢复记录的路径无效。');
  if (value.published && (!['create_empty', 'edit_move'].includes(value.change.operation)
    || !/^-?\d+$/.test(value.published.device) || !/^\d+$/.test(value.published.inode))) throw new Error('文档写入凭据无效。');
  legacyTrashPath(root, value.itemId); resolveDocumentPath(root, value.change.path); resolveDocumentPath(root, value.change.target);
  const item = value.next.items.find(item => item?.id === value.itemId);
  const receipt = value.next.receipts.at(-1);
  if (item?.kind !== 'document' || item.path !== value.change.target || receipt?.receipt?.itemId !== item.id || typeof receipt.key !== 'string') throw new Error('文档恢复记录的对象或路径无效。');
  return value;
}
function withdrawDocument(root: string, entry: PendingWrite, target: string) {
  const staged = documentStage(root, entry), withdrawn = withdrawnPath(root, entry.id);
  const matches = (path: string) => isTitleOnlyRename(entry.change) ? publishedIdentityMatches(path, entry.published)
    : publishedContentMatches(path, entry.published, documentHash(entry.change.body));
  finishStagingLink(staged, target, entry.published);
  if (!existsSync(withdrawn) && matches(target)) renameSync(target, withdrawn);
  if (existsSync(withdrawn) && !matches(withdrawn) && !existsSync(target)) {
    try { copyFileSync(withdrawn, target, constants.COPYFILE_EXCL); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
}
function cancelTitleChange(root: string, entry: PendingWrite, source: string, target: string) {
  withdrawDocument(root, entry, target);
  const original = originalPath(root, entry.id), withdrawn = withdrawnPath(root, entry.id);
  const backup = isTitleOnlyRename(entry.change) && !existsSync(original) && publishedIdentityMatches(withdrawn, entry.published) ? withdrawn : original;
  if (!existsSync(backup) || existsSync(source)) return;
  const stat = lstatSync(backup);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('改名前的文档不是普通文件，无法恢复。');
  try { copyFileSync(backup, source, constants.COPYFILE_EXCL); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return; throw error; }
}
function rollbackLegacyContent(root: string, entry: PendingWrite, source: string) {
  const before = entry.change.before, pendingHash = documentHash(entry.change.body);
  if (before === null) {
    if (fileContentMatches(source, pendingHash)) console.warn('旧版未提交的新文档缺少文件身份凭据，原路径保留', entry.change.path);
    return;
  }
  if (pendingHash === before.hash) return;
  const staged = legacyRollbackPath(root, entry.id, 'staged'), withdrawn = legacyRollbackPath(root, entry.id, 'withdrawn');
  const stagedStat = statFile(staged);
  if (stagedStat) finishStagingLink(staged, source, fileIdentity(stagedStat));
  const current = statFile(source), hasWithdrawn = existsSync(withdrawn);
  if (current ? hasWithdrawn || !fileContentMatches(source, pendingHash) : !hasWithdrawn) {
    removeFile(staged);
    return;
  }
  if (current) renameSync(source, withdrawn);
  if (!fileContentMatches(withdrawn, pendingHash)) {
    if (!statFile(withdrawn)?.isFile()) throw new Error('旧版操作中的原文件已变化，请核对项目存储。');
    moveExclusive(withdrawn, source);
    removeFile(staged);
    return;
  }
  if (!fileContentMatches(staged, before.hash)) {
    removeFile(staged);
    writeFileSync(staged, before.body, { flag: 'wx', flush: true });
  }
  try { moveExclusive(staged, source); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    removeFile(staged);
  }
  if (fileContentMatches(withdrawn, pendingHash)) removeFile(withdrawn);
}
function reconcileLegacyWrite(root: string, state: ProjectState) {
  let entry: PendingWrite | null = null;
  try { entry = legacyPending(root); } catch { /* Keep unreadable legacy bytes without guessing their file operation. */ }
  const management = state.management, receiptKey = entry?.next.receipts.at(-1)?.key;
  if (entry && entry.projectId === state.project.id && !management?.receipts.some(receipt => receipt.key === receiptKey && receipt.receipt.itemId === entry!.itemId)) {
    if ((management?.revision ?? 0) !== entry.baseRevision) throw new Error('旧版文档操作与当前管理版本冲突。');
    const change = entry.change, { source, target } = legacyPaths(root, entry.itemId, change);
    const current = management?.items.find(item => item.id === entry!.itemId);
    if (change.before !== null && (current?.kind !== 'document' || current.path !== change.path || !!current.deletedAt !== (change.operation === 'restore'))) throw new Error('旧版文档操作与当前文档不符。');
    if (change.operation === 'write') {
      rollbackLegacyContent(root, entry, source);
    } else if (change.operation === 'create_empty') {
      withdrawDocument(root, entry, target);
    } else if (change.operation === 'edit_move') {
      cancelTitleChange(root, entry, source, target);
    } else if (!existsSync(source)) {
      if (readIfPresent(target)?.hash !== change.before?.hash) throw new Error('文件在旧版操作后发生变化，不能自动撤回。');
      moveExclusive(target, source);
    }
  }
  const archived = insideProject(root, join(root, '.mixcat', 'state', `document-legacy-${randomUUID()}.json`));
  renameSync(pendingPath(root), archived);
}

function statFile(path: string) { return lstatSync(path, { bigint: true, throwIfNoEntry: false }); }
function storageHash(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function removeFile(path: string) {
  const stat = statFile(path);
  if (!stat) return;
  if (!stat.isFile() || stat.nlink !== 1n) throw new Error('文档事务文件不是独立的普通文件。');
  unlinkSync(path);
}
function moveExclusive(source: string, target: string) {
  if (!linkOrMoveExclusive(source, target)) unlinkSync(source);
}
function transactionPaths(root: string, transaction: DocumentTransaction) {
  return {
    source: resolveDocumentPath(root, transaction.source).absolute,
    target: resolveDocumentPath(root, transaction.target).absolute,
    original: transactionFile(root, transaction.id, 'original'),
    staged: transactionFile(root, transaction.id, 'staged'),
  };
}
function carriesOriginal(transaction: DocumentTransaction) {
  return transaction.afterHash !== null && transaction.beforeHash === transaction.afterHash;
}
function readTransaction(root: string, state: ProjectState) {
  const entry = JSON.parse(readFileSync(transactionPath(root), 'utf8')) as DocumentTransaction;
  if (!entry || !/^[a-f0-9-]{36}$/.test(entry.id) || entry.projectId !== state.project.id || typeof entry.receiptKey !== 'string'
    || !/^[A-Za-z0-9_-]{1,128}$/.test(entry.itemId) || entry.beforeHash !== null && !storageHash(entry.beforeHash)
    || entry.afterHash !== null && !storageHash(entry.afterHash) || entry.beforeHash === null && entry.afterHash === null
    || entry.published && (!/^-?\d+$/.test(entry.published.device) || !/^\d+$/.test(entry.published.inode))) throw new Error('文档事务记录无效。');
  const item = state.management?.items.find(item => item.id === entry.itemId);
  const committed = transactionCommitted(state, entry);
  if ((committed || entry.beforeHash !== null) && (item?.kind !== 'document' || item.path !== (committed ? entry.target : entry.source)
    || !!item.deletedAt !== (committed && entry.afterHash === null))) throw new Error('文档事务与当前管理对象不符。');
  if (committed && entry.afterHash !== null && item?.fileHash !== entry.afterHash) throw new Error('文档事务与提交的文件版本不符。');
  return entry;
}
function transactionCommitted(state: ProjectState, transaction: DocumentTransaction) {
  return !!state.management?.receipts.some(receipt => receipt.key === transaction.receiptKey && receipt.receipt.itemId === transaction.itemId);
}
function canConfirmCommittedTransaction(root: string, transaction: DocumentTransaction) {
  const { target, original, staged } = transactionPaths(root, transaction);
  if (transaction.afterHash === null) return !statFile(original) && !statFile(staged);
  return fileContentMatches(target, transaction.afterHash);
}
function committedCleanupError(transaction: DocumentTransaction, cause?: unknown) {
  return new Error(transaction.afterHash === null ? documentDeleteCleanupMessage : '保存记录已提交，文档文件仍需核对。请检查文件后重试。', { cause });
}
function cleanupTransaction(root: string, transaction: DocumentTransaction, committed: boolean) {
  const { target, original, staged } = transactionPaths(root, transaction);
  if (committed) {
    if (carriesOriginal(transaction)) finishStagingLink(original, target, transaction.published);
    if (existsSync(original) && readMarkdown(original, original).hash !== transaction.beforeHash) throw new Error('原文件在操作期间被外部修改。');
    removeFile(original);
  }
  removeFile(staged);
  removeFile(transactionPath(root));
}
function rollbackTransaction(root: string, transaction: DocumentTransaction) {
  const { source, target, original, staged } = transactionPaths(root, transaction);
  if (carriesOriginal(transaction) && matchesIdentity(statFile(target), transaction.published)) {
    if (matchesIdentity(statFile(original), transaction.published)) {
      finishStagingLink(target, original, transaction.published);
    } else if (!existsSync(original) && publishedIdentityMatches(target, transaction.published)) {
      renameSync(target, original);
    }
  } else if (transaction.afterHash !== null) {
    finishStagingLink(staged, target, transaction.published);
    if (publishedContentMatches(target, transaction.published, transaction.afterHash)) unlinkSync(target);
  }
  const backup = statFile(original);
  if (backup && !backup.isFile()) throw new Error('原文件已变化，请核对项目存储。');
  if (backup?.isFile()) {
    finishStagingLink(original, source, fileIdentity(backup));
    if (existsSync(original)) moveExclusive(original, source);
  }
  cleanupTransaction(root, transaction, false);
}
function applyTransaction(root: string, transaction: DocumentTransaction, body: string) {
  const { source, target, original, staged } = transactionPaths(root, transaction);
  const { beforeHash, afterHash } = transaction;
  if (afterHash !== null && !carriesOriginal(transaction)) writeFileSync(staged, body, { flag: 'wx', flush: true });
  if ((readIfPresent(source)?.hash ?? null) !== beforeHash) throw new Error('文档已被外部修改，本次操作发生冲突。');
  if (afterHash !== null && source !== target && existsSync(target) && !sameCaseInsensitiveEntry(source, target)) throw new Error('目标文档文件已存在，不能覆盖。');
  if (beforeHash !== null) {
    renameSync(source, original);
    if (readMarkdown(original, source).hash !== beforeHash) throw new Error('文档在操作期间被外部修改。');
  }
  if (afterHash === null) return;
  const publishFrom = carriesOriginal(transaction) ? original : staged;
  if (readMarkdown(publishFrom, target).hash !== afterHash) throw new Error('暂存正文不完整，无法发布。');
  transaction.published = fileIdentity(statFile(publishFrom)!);
  writeTransaction(root, transaction);
  if (dirname(target).toLowerCase() !== root.toLowerCase()) projectDirectory(root, relative(root, dirname(target)));
  if (linkOrMoveExclusive(publishFrom, target)) {
    transaction.published = fileIdentity(statFile(target)!);
    writeTransaction(root, transaction);
  } else if (!carriesOriginal(transaction)) finishStagingLink(staged, target, transaction.published);
  const stat = statFile(target);
  if (!stat?.isFile() || !matchesIdentity(stat, transaction.published) && transaction.published.inode !== '0'
    || documentHash(readFileSync(target)) !== afterHash) throw new Error('文档目标已变化，无法确认此次保存。');
}

export function hasPendingDocumentChange(root: string) {
  return existsSync(transactionPath(root)) || existsSync(transactionUpdatePath(root)) || existsSync(pendingPath(root));
}
export function requireSettledDocumentChange(root: string, state: ProjectState, receiptKey: string) {
  if (!hasPendingDocumentChange(root)) return;
  recoverDocument(root, state);
  if (!hasPendingDocumentChange(root)) return;
  if (existsSync(transactionPath(root))) {
    let transaction: DocumentTransaction | undefined;
    try { transaction = readTransaction(root, state); } catch { /* Recovery reported the malformed record. */ }
    if (transaction?.receiptKey === receiptKey && transactionCommitted(state, transaction)) {
      if (canConfirmCommittedTransaction(root, transaction)) return;
      throw committedCleanupError(transaction);
    }
  }
  throw new Error('文档存储操作尚未结束，请核对项目文件和存储权限后重试。');
}
export function commitDocument(root: string, state: ProjectState, next: ManagementState, itemId: string, change: DocumentChange, commit: () => void) {
  validateDocumentBody(change.body);
  if (hasPendingDocumentChange(root)) throw new Error('文档存储操作尚未结束，请核对存储后重试。');
  const transaction: DocumentTransaction = { id: randomUUID(), projectId: state.project.id, itemId, receiptKey: next.receipts.at(-1)!.key,
    source: change.path, target: change.target, beforeHash: change.before?.hash ?? null, afterHash: change.operation === 'delete' ? null : documentHash(change.body) };
  if (change.path === change.target && carriesOriginal(transaction)) {
    if (readDocument(root, change.path).hash !== transaction.beforeHash) throw new Error('文档已被外部修改，保存发生冲突。');
    commit(); return;
  }
  writeTransaction(root, transaction);
  try {
    applyTransaction(root, transaction, change.body);
    commit();
  } catch (error) {
    if (!transactionCommitted(state, transaction)) {
      try { rollbackTransaction(root, transaction); }
      catch (rollbackError) { throw new Error(`${String(error)}。无法撤回文档操作：${String(rollbackError)}`, { cause: error }); }
    }
    throw error;
  }
  try { cleanupTransaction(root, transaction, true); }
  catch (error) {
    if (!transactionCommitted(state, transaction) || !canConfirmCommittedTransaction(root, transaction)) throw committedCleanupError(transaction, error);
    console.warn('文档已提交，事务清理尚未完成', error instanceof Error ? error.message : String(error));
  }
}
export function recoverDocument(root: string, state: ProjectState): void {
  try {
    removeFile(transactionUpdatePath(root));
    if (existsSync(transactionPath(root))) {
      const transaction = readTransaction(root, state);
      if (transactionCommitted(state, transaction)) cleanupTransaction(root, transaction, true);
      else rollbackTransaction(root, transaction);
    }
    if (existsSync(pendingPath(root))) reconcileLegacyWrite(root, state);
  } catch (error) {
    console.warn('文档存储操作未能自动结束', error instanceof Error ? error.message : String(error));
  }
}
