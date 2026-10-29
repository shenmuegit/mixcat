import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ensureProjectDirectory, insideProject, projectDirectory } from './paths.js';
import type { ArtifactRef, ComfyObservation, ComfyOperationReceipt, EditReceipt, GraphView, RunView } from '../shared/comfy.js';

export interface CreateComfyRun { requestId: string; observation: ComfyObservation; id?: string; }
export type ComfyRunPatch = Partial<Pick<RunView, 'status' | 'promptId' | 'assets'>> & { error?: RunView['error'] | null };
export interface ComfyRunPage { runs: RunView[]; nextCursor?: string; }

function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 1000 || value.includes('\0')) throw new Error('Comfy 标识或指纹格式不正确。');
  return value;
}
function json(value: unknown): string {
  const body = JSON.stringify(value);
  if (!body || !isDeepStrictEqual(JSON.parse(body), value)) throw new Error('Comfy 数据必须是有效 JSON。');
  return body;
}
function hash(body: string) { return createHash('sha256').update(body).digest('hex'); }
function object(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Comfy 数据结构不正确。');
}

export class ComfyStore {
  readonly root: string;
  private db: DatabaseSync;
  constructor(root: string, readonly projectId: string) {
    text(projectId);
    this.root = ensureProjectDirectory(root);
    const directory = projectDirectory(this.root, '.mixcat', 'comfy');
    this.db = new DatabaseSync(insideProject(this.root, join(directory, 'state.sqlite')));
    try {
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;
        CREATE TABLE IF NOT EXISTS metadata (id INTEGER PRIMARY KEY CHECK(id=1), project_id TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS operations (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, body TEXT NOT NULL, kind TEXT, input_hash TEXT);
        CREATE TABLE IF NOT EXISTS versions (id TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS runs (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, body TEXT NOT NULL);`);
      this.db.prepare('INSERT INTO metadata VALUES (1,?) ON CONFLICT(id) DO NOTHING').run(projectId);
      if (this.db.prepare('SELECT project_id FROM metadata WHERE id=1').get()!.project_id !== projectId) throw new Error('Comfy 存储属于其他项目。');
    } catch (error) { this.db.close(); throw error; }
  }
  beginOperation(requestId: string, fingerprint: string): ComfyOperationReceipt {
    text(requestId); text(fingerprint);
    const receipt: ComfyOperationReceipt = { requestId, fingerprint, status: 'pending' };
    this.db.prepare('INSERT INTO operations(request_id,fingerprint,body) VALUES (?,?,?) ON CONFLICT(request_id) DO NOTHING').run(requestId, fingerprint, JSON.stringify(receipt));
    const operation = this.operation(requestId);
    if (operation.receipt.fingerprint !== fingerprint) throw new Error('Comfy 请求标识冲突。');
    return operation.receipt;
  }
  private observation(value: ComfyObservation): ComfyObservation {
    object(value);
    for (const key of ['projectId', 'instanceId', 'workflowId', 'tabId', 'revision'] as const) text(value[key]);
    if (value.projectId !== this.projectId) throw new Error('Comfy 数据属于其他项目。');
    return { projectId: value.projectId, instanceId: value.instanceId, workflowId: value.workflowId, tabId: value.tabId, revision: value.revision };
  }
  private graph(value: GraphView): GraphView {
    object(value); object(value.workflow); json(value.workflow);
    for (const key of ['subgraphPath', 'selectedNodeIds'] as const) {
      if (!Array.isArray(value[key])) throw new Error('Comfy 图上下文格式不正确。');
      value[key].forEach(text);
    }
    return { observation: this.observation(value.observation), workflow: value.workflow, subgraphPath: value.subgraphPath, selectedNodeIds: value.selectedNodeIds };
  }
  private operation(requestId: string) {
    text(requestId);
    const row = this.db.prepare('SELECT * FROM operations WHERE request_id=?').get(requestId);
    if (!row) throw new Error('Comfy 请求尚未预留。');
    const stored = JSON.parse(String(row.body)); object(stored);
    if (stored.requestId !== requestId || stored.fingerprint !== row.fingerprint || !['pending', 'committed'].includes(stored.status as string)
      || stored.status === 'pending' && stored.result !== undefined
      || !(row.kind === null && row.input_hash === null || ['edit', 'run'].includes(row.kind as string) && typeof row.input_hash === 'string' && /^[a-f0-9]{64}$/.test(row.input_hash))) throw new Error('Comfy 回执数据格式不正确。');
    text(stored.fingerprint);
    const receipt: ComfyOperationReceipt = { requestId, fingerprint: stored.fingerprint as string, status: stored.status as ComfyOperationReceipt['status'] };
    if (receipt.status === 'committed') {
      if (row.kind === 'run') receipt.result = this.run(stored.result as RunView);
      else if (row.kind === 'edit') {
        const result = stored.result as EditReceipt; object(result);
        if (!/^[a-f0-9]{64}$/.test(result.beforeVersionId) || !/^[a-f0-9]{64}$/.test(result.afterVersionId)) throw new Error('Comfy 编辑回执数据格式不正确。');
        receipt.result = { requestId: result.requestId, beforeVersionId: result.beforeVersionId, afterVersionId: result.afterVersionId, observation: this.observation(result.observation) };
      } else throw new Error('Comfy 回执数据格式不正确。');
      if (receipt.result.requestId !== requestId || typeof row.input_hash !== 'string' || !/^[a-f0-9]{64}$/.test(row.input_hash)) throw new Error('Comfy 回执数据格式不正确。');
    }
    return { receipt, kind: row.kind, inputHash: row.input_hash };
  }
  private bindOperation(requestId: string, kind: 'edit' | 'run', inputHash: string) {
    this.operation(requestId);
    // Persist the attempted input before filesystem work so a failed edit cannot become a different operation.
    this.db.prepare('UPDATE operations SET kind=?,input_hash=? WHERE request_id=? AND kind IS NULL AND input_hash IS NULL').run(kind, inputHash, requestId);
    const operation = this.operation(requestId);
    if (operation.kind !== kind || operation.inputHash !== inputHash) throw new Error('Comfy 请求标识冲突。');
  }
  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private saveVersion(workflow: Record<string, unknown>): string {
    const body = json(workflow), id = hash(body), directory = projectDirectory(this.root, '.mixcat', 'comfy', 'workflows');
    const destination = insideProject(this.root, join(directory, `${id}.json`));
    if (existsSync(destination)) {
      if (hash(readFileSync(destination, 'utf8')) !== id) throw new Error('Comfy 工作流快照哈希不匹配。');
      return id;
    }
    const temporary = insideProject(this.root, join(projectDirectory(this.root, '.mixcat', 'comfy', 'tmp'), `${randomUUID()}.json`));
    try {
      const file = openSync(temporary, 'wx', 0o600);
      try { writeFileSync(file, body); fsyncSync(file); } finally { closeSync(file); }
      if (hash(readFileSync(temporary, 'utf8')) !== id) throw new Error('Comfy 工作流快照哈希不匹配。');
      renameSync(temporary, destination);
    } finally { rmSync(temporary, { force: true }); }
    return id;
  }
  commitEdit(requestId: string, before: GraphView, after: GraphView): EditReceipt {
    before = this.graph(before); after = this.graph(after);
    if (['projectId', 'instanceId', 'workflowId', 'tabId'].some(key => before.observation[key as keyof ComfyObservation] !== after.observation[key as keyof ComfyObservation])) throw new Error('Comfy 编辑前后的画布身份冲突。');
    const inputHash = hash(json({ before, after }));
    this.bindOperation(requestId, 'edit', inputHash);
    return this.transaction(() => {
      const operation = this.operation(requestId);
      if (operation.receipt.status === 'committed') {
        if (operation.kind !== 'edit' || operation.inputHash !== inputHash) throw new Error('Comfy 请求标识冲突。');
        return operation.receipt.result as EditReceipt;
      }
      const beforeVersionId = this.saveVersion(before.workflow), afterVersionId = this.saveVersion(after.workflow);
      const receipt: EditReceipt = { requestId, beforeVersionId, afterVersionId, observation: after.observation };
      for (const id of [beforeVersionId, afterVersionId]) this.db.prepare('INSERT INTO versions VALUES (?) ON CONFLICT(id) DO NOTHING').run(id);
      this.db.prepare('UPDATE operations SET body=?,kind=?,input_hash=? WHERE request_id=?').run(json({ ...operation.receipt, status: 'committed', result: receipt }), 'edit', inputHash, requestId);
      return receipt;
    });
  }
  readVersion(versionId: string): Record<string, unknown> {
    if (typeof versionId !== 'string' || !/^[a-f0-9]{64}$/.test(versionId)) throw new Error('Comfy 工作流版本标识不正确。');
    if (!this.db.prepare('SELECT id FROM versions WHERE id=?').get(versionId)) throw new Error('Comfy 工作流版本不存在。');
    const body = readFileSync(insideProject(this.root, join(this.root, '.mixcat', 'comfy', 'workflows', `${versionId}.json`)), 'utf8');
    if (hash(body) !== versionId) throw new Error('Comfy 工作流快照哈希不匹配。');
    const workflow: unknown = JSON.parse(body); object(workflow); return workflow;
  }
  createRun(input: CreateComfyRun): RunView {
    object(input); text(input.requestId);
    const observation = this.observation(input.observation);
    if (input.id !== undefined) text(input.id);
    const inputHash = hash(json({ requestId: input.requestId, observation, ...(input.id !== undefined ? { id: input.id } : {}) }));
    this.bindOperation(input.requestId, 'run', inputHash);
    return this.transaction(() => {
      const operation = this.operation(input.requestId);
      if (operation.receipt.status === 'committed') {
        if (operation.kind !== 'run' || operation.inputHash !== inputHash) throw new Error('Comfy 请求标识冲突。');
        return operation.receipt.result as RunView;
      }
      const run: RunView = { id: input.id ?? randomUUID(), requestId: input.requestId, observation, status: 'prepared', assets: [] };
      this.db.prepare('INSERT INTO runs(id,body) VALUES (?,?)').run(run.id, json(run));
      this.db.prepare('UPDATE operations SET body=?,kind=?,input_hash=? WHERE request_id=?').run(json({ ...operation.receipt, status: 'committed', result: run }), 'run', inputHash, input.requestId);
      return run;
    });
  }
  private asset(value: ArtifactRef): ArtifactRef {
    object(value); text(value.id); text(value.relativePath); text(value.mime);
    if (isAbsolute(value.relativePath) || /^[a-z]:/i.test(value.relativePath)) throw new Error('Comfy 成果路径必须在项目内。');
    insideProject(this.root, resolve(this.root, value.relativePath));
    if (!/^[a-f0-9]{64}$/.test(value.sha256) || !Number.isSafeInteger(value.bytes) || value.bytes < 0) throw new Error('Comfy 成果格式不正确。');
    return { id: value.id, relativePath: value.relativePath, mime: value.mime, sha256: value.sha256, bytes: value.bytes };
  }
  private run(value: RunView): RunView {
    object(value); text(value.id); text(value.requestId);
    if (!['prepared', 'submitting', 'submission_unknown', 'queued', 'running', 'downloading', 'succeeded', 'failed', 'cancel_requested', 'cancelled', 'needs_reconciliation'].includes(value.status) || !Array.isArray(value.assets)) throw new Error('Comfy 运行格式不正确。');
    if (value.promptId !== undefined) text(value.promptId);
    if (value.error !== undefined) { object(value.error); text(value.error.code); text(value.error.message); }
    return { id: value.id, observation: this.observation(value.observation), requestId: value.requestId, status: value.status, assets: value.assets.map(asset => this.asset(asset)), ...(value.promptId !== undefined ? { promptId: value.promptId } : {}), ...(value.error !== undefined ? { error: { code: value.error.code, message: value.error.message } } : {}) };
  }
  getRun(id: string): RunView | undefined {
    text(id);
    const row = this.db.prepare('SELECT body FROM runs WHERE id=?').get(id);
    if (!row) return undefined;
    const run = this.run(JSON.parse(String(row.body)));
    if (run.id !== id) throw new Error('Comfy 运行标识与存储记录不匹配。');
    return run;
  }
  updateRun(id: string, patch: ComfyRunPatch): RunView {
    object(patch);
    if (Object.keys(patch).some(key => !['status', 'promptId', 'assets', 'error'].includes(key))) throw new Error('Comfy 运行更新字段不正确。');
    json(patch);
    return this.transaction(() => {
      const existing = this.getRun(id);
      if (!existing) throw new Error('Comfy 运行不存在。');
      const next = { ...existing, ...patch }; if (next.error === null) delete next.error;
      const run = this.run(next as RunView);
      this.db.prepare('UPDATE runs SET body=? WHERE id=?').run(json(run), id); return run;
    });
  }
  listRuns(cursor?: string, limit = 25): ComfyRunPage {
    if (cursor !== undefined && (!/^[1-9][0-9]*$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))) throw new Error('Comfy 运行分页游标不正确。');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Comfy 运行分页大小必须为 1 到 100。');
    const rows = this.db.prepare('SELECT seq,body FROM runs WHERE seq < ? ORDER BY seq DESC LIMIT ?').all(cursor === undefined ? Number.MAX_SAFE_INTEGER : Number(cursor), limit + 1);
    const page = rows.slice(0, limit);
    return { runs: page.map(row => this.run(JSON.parse(String(row.body)))), ...(rows.length > limit ? { nextCursor: String(page.at(-1)!.seq) } : {}) };
  }
  close() { this.db.close(); }
}
