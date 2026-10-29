import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { insideProject } from './paths.js';
import { feedId } from './feed-collections.js';
import { feedScheduleSchema } from './feed-scheduler.js';

export const feedGoalSchema = z.strictObject({ requestId: feedId, name: z.string().trim().min(1).max(512), objective: z.string().trim().min(1).max(256 * 1024), schedule: feedScheduleSchema, expectedRevision: z.number().int().positive() });
export function readFeedGoal(workspace: string) {
  const path = insideProject(workspace, join(workspace, 'goal.json'));
  let before;
  try { before = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const limit = 512 * 1024;
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit) throw new Error('goal.json 必须是至多 512 KiB 的普通文件，不能使用链接。');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > limit) throw new Error('goal.json 文件身份已变化。');
    const buffer = Buffer.alloc(limit + 1); let size = 0, read = 0;
    while (size < buffer.length && (read = readSync(fd, buffer, size, buffer.length - size, null))) size += read;
    const after = fstatSync(fd); insideProject(workspace, path); const current = lstatSync(path);
    if (size > limit || after.nlink !== 1 || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || current.ino !== stat.ino || current.dev !== stat.dev || current.isSymbolicLink()) throw new Error('goal.json 过大或读取期间发生变化。');
    return feedGoalSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size))));
  } finally { closeSync(fd); }
}
