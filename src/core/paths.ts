import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

function checkAncestors(path: string) {
  let current = resolve(path);
  for (;;) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`目录不能经过符号链接或目录联接：${current}`);
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
}
export function ensureProjectDirectory(path: string): string {
  if (typeof path !== 'string' || !isAbsolute(path) || /^c:[\\/]/i.test(path) || path.startsWith('\\\\')) throw new Error('请选择非 C 盘的本地项目绝对路径。');
  checkAncestors(path);
  const actual = realpathSync.native(path);
  if (/^c:[\\/]/i.test(actual) || !statSync(actual).isDirectory()) throw new Error('项目目录不可用。');
  return actual;
}
export function insideProject(root: string, target: string): string {
  const actualRoot = ensureProjectDirectory(root), absolute = resolve(target);
  const part = relative(actualRoot, absolute);
  if (part === '' || part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)) throw new Error('工作数据必须放在所属项目内部。');
  checkAncestors(absolute);
  return absolute;
}
export function projectDirectory(root: string, ...parts: string[]): string {
  const path = insideProject(root, join(root, ...parts));
  mkdirSync(path, { recursive: true });
  const actual = realpathSync.native(path); insideProject(root, actual); return actual;
}
export function projectDataRoot(root: string): string { return projectDirectory(root, '.mixcat'); }
