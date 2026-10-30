import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProjectState } from './model.js';
import { migrateHistory } from './history.js';
import { ensureProjectDirectory, insideProject, projectDirectory } from './paths.js';
import { recoverDocument } from './project-documents.js';

function requireReviewState(state: ProjectState) {
  if (!state.reviewPolicy || typeof state.reviewPolicy !== 'object' || Array.isArray(state.reviewPolicy)
    || !Number.isSafeInteger(state.reviewPolicy.revision) || state.reviewPolicy.revision < 0
    || !Array.isArray(state.reviewPolicy.checkpoints) || !Array.isArray(state.humanReviews)) throw new Error('项目核对数据缺失或格式不正确，无法读取或保存。');
}
function requireProjectSummary(state: ProjectState) {
  const project = state.project;
  if (!project || ['id', 'name', 'root', 'updatedAt'].some(key => typeof (project as any)[key] !== 'string')
    || !['idle', 'running', 'pausing', 'paused', 'blocked', 'completed'].includes(project.status)
    || !['codex', 'demo'].includes(project.mode) || project.template !== undefined && !['web-product', 'comfyui'].includes(project.template)) throw new Error('项目摘要格式不正确，无法读取或保存。');
}

export class ProjectStore {
  readonly root: string;
  readonly db: DatabaseSync;
  private ownership?: DatabaseSync;
  private previous?: { body: string; schemaVersion: number };
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
  claim() {
    if (this.ownership) return;
    // SQLite releases this writer lock when the owning process exits.
    const guard = new DatabaseSync(insideProject(this.root, join(this.root, '.mixcat', 'state', 'writer.sqlite')));
    try { guard.exec('BEGIN EXCLUSIVE'); }
    catch (error) {
      guard.close();
      if ([5, 6].includes((error as any).errcode)) throw new Error('项目已由其他 Mixcat 工作台打开，请先关闭该工作台后重试。');
      throw error;
    }
    this.ownership = guard;
  }
  read(options: { recover?: boolean } = {}): ProjectState | null {
    const row = this.db.prepare('SELECT schema_version, body FROM project_state WHERE id=1').get();
    this.previous = row ? { body: String(row.body), schemaVersion: Number(row.schema_version) } : undefined;
    if (!row) return null;
    if (row.schema_version !== 1 && row.schema_version !== 2 && row.schema_version !== 3 && row.schema_version !== 4) throw new Error('项目数据版本不受当前应用支持。');
    const state = JSON.parse(String(row.body));
    requireProjectSummary(state);
    if (typeof state.project?.root !== 'string' || resolve(state.project.root).toLowerCase() !== this.root.toLowerCase()) throw new Error('该项目数据记录了不同的原始目录。MVP 暂不支持复制或搬迁会话数据，请使用原目录或全新的项目目录。');
    if (row.schema_version !== 4) { state.reviewPolicy ??= { revision: 0, checkpoints: [] }; state.humanReviews ??= []; }
    requireReviewState(state);
    state.groups ??= [];
    if (options.recover !== false) {
      recoverDocument(this.root, state, recovered => this.save(recovered));
      migrateHistory(state);
      if (row.schema_version !== 4) this.save(state);
    }
    return state;
  }
  save(state: ProjectState) {
    requireProjectSummary(state);
    requireReviewState(state);
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
    if (body === this.previous?.body && this.previous.schemaVersion === 4) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare('INSERT INTO project_state VALUES(1,4,?) ON CONFLICT(id) DO UPDATE SET schema_version=excluded.schema_version, body=excluded.body WHERE project_state.body=?').run(body, this.previous?.body ?? null);
      if (result.changes !== 1) throw new Error('项目已被其他工作台修改，存储版本已变化。请关闭其他工作台后重启客户端。');
      this.db.exec('COMMIT'); this.previous = { body, schemaVersion: 4 };
    }
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
  close() { try { this.db.close(); } finally { this.ownership?.close(); this.ownership = undefined; } }
}
