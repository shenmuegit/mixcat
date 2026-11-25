import { randomUUID } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ProjectSummary } from '../shared/types.js';
import { ensureProjectDirectory, insideProject, projectDirectory } from './paths.js';

export interface ProjectDeletion {
  key: string;
  project: Pick<ProjectSummary, 'id' | 'name' | 'root'>;
  device: string;
  inode: string;
}

const deletionKey = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const within = (directory: string, target: string) => {
  const part = relative(directory, target);
  return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
};
const samePath = (left: string, right: string) => relative(left, right) === '';

function protectProjectRoot(workbench: string, root: string, accountRoot = workbench) {
  if (!isAbsolute(root) || resolve(root) !== root || /^c:[\\/]/i.test(root) || root.startsWith('\\\\') || dirname(root) === root) {
    throw new Error('无法确认待删除的项目目录。');
  }
  const privateRoots = [join(workbench, '.runtime', 'client'), join(workbench, '.mixcat'), join(workbench, '.git')];
  if (within(root, workbench) || within(root, accountRoot) || privateRoots.some(path => within(path, root) || within(root, path))) {
    throw new Error('项目目录与 Mixcat 工作台或账号目录重叠。请选择独立的项目目录。');
  }
}

const deletionDirectory = (workbench: string) => projectDirectory(workbench, '.runtime', 'client', 'project-deletions');
const deletionFile = (workbench: string, key: string) => {
  if (!deletionKey.test(key)) throw new Error('项目删除记录标识无效。');
  return insideProject(workbench, join(deletionDirectory(workbench), `${key}.json`));
};
const stagedPath = (record: ProjectDeletion) => join(dirname(record.project.root), `.mixcat-deleting-${record.key}`);

function matchingDirectory(path: string, record: ProjectDeletion) {
  const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (!stat) return false;
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(ensureProjectDirectory(path), path)
    || stat.dev.toString() !== record.device || stat.ino.toString() !== record.inode) {
    throw new Error('项目目录在删除期间发生变化，请核对磁盘位置。');
  }
  return true;
}

export function prepareProjectDeletion(workbench: string, project: ProjectDeletion['project'], otherRoots: string[], accountRoot?: string, registered?: Pick<ProjectDeletion, 'device' | 'inode'>) {
  const actual = ensureProjectDirectory(project.root);
  protectProjectRoot(workbench, actual, accountRoot);
  if (!samePath(actual, project.root)) throw new Error('项目真实目录与确认目录不一致。');
  if (otherRoots.some(path => !samePath(path, actual) && within(actual, path))) throw new Error('该目录内还有其他已登记或正在创建的项目，请先分别处理这些项目。');
  const identity = lstatSync(actual, { bigint: true });
  const record: ProjectDeletion = { key: randomUUID(), project, device: identity.dev.toString(), inode: identity.ino.toString() };
  if (registered && (record.device !== registered.device || record.inode !== registered.inode)) throw new Error('项目目录已被替换，请重新打开并核对。');
  const file = deletionFile(workbench, record.key);
  const temporary = insideProject(workbench, `${file}.tmp`);
  writeFileSync(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600, flush: true });
  try { renameSync(temporary, file); }
  catch (error) { unlinkSync(temporary); throw error; }
  return record;
}

export function stageProjectDeletion(record: ProjectDeletion) {
  const target = stagedPath(record);
  if (!matchingDirectory(record.project.root, record) || lstatSync(target, { throwIfNoEntry: false })) {
    throw new Error('项目目录已改变或临时删除位置已存在。');
  }
  renameSync(record.project.root, target);
}

export function rollBackProjectDeletion(workbench: string, record: ProjectDeletion) {
  const root = record.project.root;
  const target = stagedPath(record);
  if (matchingDirectory(target, record)) {
    if (lstatSync(root, { throwIfNoEntry: false })) throw new Error('项目原目录已被占用，请先核对目录。');
    renameSync(target, root);
  }
  if (!matchingDirectory(root, record)) throw new Error('无法核对项目原目录。');
  unlinkSync(deletionFile(workbench, record.key));
}

export function completeProjectDeletion(workbench: string, record: ProjectDeletion) {
  const stage = stagedPath(record);
  if (matchingDirectory(stage, record)) rmSync(stage, { recursive: true, maxRetries: 2, retryDelay: 80 });
  else {
    const original = lstatSync(record.project.root, { bigint: true, throwIfNoEntry: false });
    if (original?.dev.toString() === record.device && original.ino.toString() === record.inode) throw new Error('待删除的项目目录仍在原位置，请核对后重试。');
  }
  if (lstatSync(stage, { throwIfNoEntry: false })) throw new Error('项目目录的删除尚未完成。');
  unlinkSync(deletionFile(workbench, record.key));
}

export function readProjectDeletions(workbench: string, accountRoot?: string): ProjectDeletion[] {
  return readdirSync(deletionDirectory(workbench)).filter(name => name.endsWith('.json') && deletionKey.test(name.slice(0, -5))).map(name => {
    const key = name.slice(0, -5);
    const file = deletionFile(workbench, key);
    const record: ProjectDeletion = JSON.parse(readFileSync(file, 'utf8'));
    if (record?.key !== key || !record.project || typeof record.project.id !== 'string' || typeof record.project.name !== 'string'
      || typeof record.project.root !== 'string' || !/^\d+$/.test(record.device) || !/^\d+$/.test(record.inode)) {
      throw new Error('项目删除事务记录格式不正确。');
    }
    protectProjectRoot(workbench, record.project.root, accountRoot);
    return record;
  });
}
