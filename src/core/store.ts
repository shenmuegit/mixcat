import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProjectState } from './model.js';
import { migrateHistory } from './history.js';
import { ensureProjectDirectory, insideProject, projectDirectory } from './paths.js';

export class ProjectStore {
  readonly root: string;
  readonly db: DatabaseSync;
  constructor(root: string) {
    this.root = ensureProjectDirectory(root);
    const dataRoot = projectDirectory(this.root, '.mixcat');
    const ignorePath = insideProject(this.root, join(dataRoot, '.gitignore'));
    const previousIgnore = existsSync(ignorePath) ? readFileSync(ignorePath, 'utf8') : '';
    if (previousIgnore.trimEnd().split('\n').at(-1)?.trim() !== '*') writeFileSync(ignorePath, `${previousIgnore}${previousIgnore && !previousIgnore.endsWith('\n') ? '\n' : ''}*\n`, { mode: 0o600 });
    const stateDir = projectDirectory(this.root, '.mixcat', 'state');
    const file = insideProject(this.root, join(stateDir, 'workflow.sqlite'));
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS project_state (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL, body TEXT NOT NULL);');
  }
  read(): ProjectState | null {
    const row = this.db.prepare('SELECT schema_version, body FROM project_state WHERE id=1').get();
    if (!row) return null;
    if (row.schema_version !== 1 && row.schema_version !== 2) throw new Error('项目数据版本不受当前应用支持。');
    const state = JSON.parse(String(row.body));
    if (typeof state.project?.root !== 'string' || resolve(state.project.root).toLowerCase() !== this.root.toLowerCase()) throw new Error('该项目数据记录了不同的原始目录。MVP 暂不支持复制或搬迁会话数据，请使用原目录或全新的项目目录。');
    migrateHistory(state);
    if (row.schema_version === 1) this.save(state);
    return state;
  }
  save(state: ProjectState) {
    const tasks = new Map(state.tasks.map(task => [task.id, task]));
    for (const entry of state.conversation) {
      const task = entry.direction === 'input' && entry.taskId ? tasks.get(entry.taskId) : undefined;
      if (task) {
        const currentInput = task.resumeCount ? `continuation:${task.id}:${task.resumeCount}` : `input:${task.id}`;
        if (entry.id === currentInput && (!entry.turnId || entry.turnId === task.turnId)) {
          entry.status = task.status; entry.threadId ??= task.threadId; entry.turnId ??= task.turnId;
          if (task.status !== 'paused') entry.completedAt = task.finishedAt;
        }
      }
    }
    const body = JSON.stringify(state);
    this.db.exec('BEGIN IMMEDIATE');
    try { this.db.prepare('INSERT INTO project_state VALUES(1,2,?) ON CONFLICT(id) DO UPDATE SET schema_version=excluded.schema_version, body=excluded.body').run(body); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  artifact(taskId: string, value: unknown) {
    if (!/^[a-zA-Z0-9-]+$/.test(taskId)) throw new Error('无效成果标识。');
    const directory = projectDirectory(this.root, '.mixcat', 'artifacts');
    const destination = insideProject(this.root, join(directory, `${taskId}.json`));
    const body = JSON.stringify(value, null, 2);
    if (existsSync(destination)) { if (readFileSync(destination, 'utf8') !== body) throw new Error('已交付的成果不能被覆盖。'); return; }
    const temporary = insideProject(this.root, join(directory, `${taskId}.${randomUUID()}.tmp`));
    writeFileSync(temporary, body, { flag: 'wx', mode: 0o600 }); renameSync(temporary, destination);
  }
  close() { this.db.close(); }
}
