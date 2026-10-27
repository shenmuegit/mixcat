import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { insideProject } from './paths.js';

export function scanProjectDocuments(root: string): { paths: string[]; warnings: string[] } {
  const paths: string[] = [], warnings: string[] = [];
  const excluded = new Set(['.git', '.mixcat', '.runtime', 'node_modules', 'vendor', 'dist', 'build', 'coverage', '.next', '.nuxt', '.cache']);
  let entries = 0, stopped = false;
  const warn = (message: string) => { if (warnings.length < 100) warnings.push(message); };
  function visit(path: string, depth: number) {
    if (stopped) return;
    if (depth > 16) { warn(`${path}：目录超过 16 层，未完整扫描。`); return; }
    if (++entries > 5000) { warn('目录项超过 5,000，未完整扫描。'); stopped = true; return; }
    try {
      const absolute = join(root, path), stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) { warn(`${path}：跳过目录联接或符号链接。`); return; }
      insideProject(root, absolute);
      if (stat.isDirectory()) {
        for (const entry of readdirSync(absolute).sort()) if (!excluded.has(entry.toLowerCase())) visit(`${path}/${entry}`, depth + 1);
      } else if (stat.isFile() && /\.(md|markdown)$/i.test(path)) {
        if (stat.nlink !== 1) { warn(`${path}：跳过硬链接。`); return; }
        if (paths.length >= 1000) { warn('Markdown 文件超过 1,000，未完整扫描。'); stopped = true; return; }
        paths.push(path);
      }
    } catch (error) { if (path !== 'docs' || (error as NodeJS.ErrnoException).code !== 'ENOENT') warn(`${path}：无法扫描（${error instanceof Error ? error.message : String(error)}）。`); }
  }
  visit('docs', 0);
  return { paths, warnings };
}
