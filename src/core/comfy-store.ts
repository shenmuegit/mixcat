import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ensureProjectDirectory, insideProject, projectDirectory } from './paths.js';
import type { ArtifactRef, ComfyActor, ComfyObservation, ComfyOperationReceipt, EditReceipt, GraphView, RunView } from '../shared/comfy.js';
import { validatePrompt, type ComfyPromptPayload, type ComfyPromptResponse } from '../shared/comfy-bridge.js';

export interface CreateComfyRun { requestId: string; observation: ComfyObservation; id?: string; }
export type ComfyRunPatch = Partial<Pick<RunView, 'status' | 'promptId' | 'assets'>> & { error?: RunView['error'] | null };
export interface ComfyRunPage { runs: RunView[]; nextCursor?: string; }
export interface ComfyEditRecovery { requestId: string; beforeVersionId: string; observation: ComfyObservation; state: 'recovery_required'; }
export interface ComfySubmission { run: RunView; payload: ComfyPromptPayload; actor: ComfyActor; workflowVersionId: string; response?: ComfyPromptResponse; }

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
      if (!this.db.prepare('PRAGMA table_info(operations)').all().some(column => column.name === 'intent')) this.db.exec('ALTER TABLE operations ADD COLUMN intent TEXT');
      if (!this.db.prepare('PRAGMA table_info(metadata)').all().some(column => column.name === 'runtime_port')) this.db.exec('ALTER TABLE metadata ADD COLUMN runtime_port INTEGER');
      if (!this.db.prepare('PRAGMA table_info(metadata)').all().some(column => column.name === 'graph_initialized')) this.db.exec('ALTER TABLE metadata ADD COLUMN graph_initialized INTEGER NOT NULL DEFAULT 0');
      this.db.prepare('INSERT INTO metadata(id,project_id) VALUES (1,?) ON CONFLICT(id) DO NOTHING').run(projectId);
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
  getRuntimePort(): number | undefined {
    const value = this.db.prepare('SELECT runtime_port FROM metadata WHERE id=1').get()!.runtime_port;
    if (value === null) return undefined;
    if (!Number.isInteger(value) || Number(value) < 1024 || Number(value) > 65535) throw new Error('Comfy 持久端口格式不正确。');
    return Number(value);
  }
  graphInitialized(): boolean { return this.db.prepare('SELECT graph_initialized FROM metadata WHERE id=1').get()!.graph_initialized === 1; }
  markGraphInitialized() { this.db.prepare('UPDATE metadata SET graph_initialized=1 WHERE id=1').run(); }
  setRuntimePort(port: number): number {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Comfy 持久端口格式不正确。');
    this.db.prepare('UPDATE metadata SET runtime_port=? WHERE id=1 AND runtime_port IS NULL').run(port);
    return this.getRuntimePort()!;
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
  stageEdit(requestId: string, before: GraphView, workflow: Record<string, unknown>): ComfyEditRecovery {
    before = this.graph(before); object(workflow);
    this.bindOperation(requestId, 'edit', hash(json({ before, workflow })));
    return this.transaction(() => {
      const row = this.db.prepare('SELECT intent FROM operations WHERE request_id=?').get(requestId)!;
      if (row.intent !== null || this.operation(requestId).receipt.status === 'committed') throw new Error('Comfy 编辑需要显式恢复，不能重复执行。');
      const intent: ComfyEditRecovery = { requestId, beforeVersionId: this.saveVersion(before.workflow), observation: before.observation, state: 'recovery_required' };
      this.db.prepare('INSERT INTO versions VALUES (?) ON CONFLICT(id) DO NOTHING').run(intent.beforeVersionId);
      this.db.prepare('UPDATE operations SET intent=? WHERE request_id=?').run(json(intent), requestId);
      return intent;
    });
  }
  private editIntent(requestId: string): ComfyEditRecovery {
    const row = this.db.prepare('SELECT intent FROM operations WHERE request_id=?').get(text(requestId));
    if (!row?.intent) throw new Error('Comfy 编辑尚未保存恢复点。');
    const intent = JSON.parse(String(row.intent)); object(intent);
    if (intent.requestId !== requestId || intent.state !== 'recovery_required') throw new Error('Comfy 恢复数据格式不正确。');
    this.readVersion(intent.beforeVersionId as string);
    return { requestId, beforeVersionId: intent.beforeVersionId as string, observation: this.observation(intent.observation as ComfyObservation), state: 'recovery_required' };
  }
  recoverableEdits(): ComfyEditRecovery[] {
    return this.db.prepare("SELECT request_id FROM operations WHERE kind='edit' AND intent IS NOT NULL AND json_extract(body,'$.status')='pending'").all().map(row => this.editIntent(String(row.request_id)));
  }
  stageRun(requestId: string, observation: ComfyObservation, payload: ComfyPromptPayload, actor: ComfyActor): ComfySubmission {
    observation = this.observation(observation); validatePrompt(payload);
    if (payload.prompt_id !== undefined) throw new Error('Comfy prompt_id 必须由持久受理分配。');
    this.bindOperation(requestId, 'run', hash(json({ observation, payload, actor })));
    return this.transaction(() => {
      if (this.submission(requestId) || this.operation(requestId).receipt.status === 'committed') throw new Error('Comfy 提交已受理，不能重复发送。');
      const run: RunView = { id: randomUUID(), requestId, observation, status: 'submitting', promptId: randomUUID(), assets: [] };
      const workflowVersionId = this.saveVersion(payload.extra_data.extra_pnginfo.workflow);
      const intent = { runId: run.id, payload: { ...payload, prompt_id: run.promptId }, actor, workflowVersionId };
      this.db.prepare('INSERT INTO versions VALUES (?) ON CONFLICT(id) DO NOTHING').run(workflowVersionId);
      this.db.prepare('INSERT INTO runs(id,body) VALUES (?,?)').run(run.id, json(run));
      this.db.prepare('UPDATE operations SET intent=? WHERE request_id=?').run(json(intent), requestId);
      return { run, ...intent };
    });
  }
  submission(requestId: string): ComfySubmission | undefined {
    const row = this.db.prepare("SELECT intent FROM operations WHERE request_id=? AND kind='run'").get(text(requestId));
    if (!row?.intent) return undefined;
    const intent = JSON.parse(String(row.intent)); validatePrompt(intent.payload);
    const run = this.getRun(intent.runId); if (!run || run.requestId !== requestId || run.promptId !== intent.payload.prompt_id) throw new Error('Comfy 提交记录不正确。');
    return { run, payload: intent.payload, actor: intent.actor, workflowVersionId: intent.workflowVersionId, ...(intent.response ? { response: intent.response } : {}) };
  }
  finishSubmission(requestId: string, response?: ComfyPromptResponse): RunView {
    return this.transaction(() => {
      const submission = this.submission(requestId); if (!submission) throw new Error('Comfy 提交尚未持久受理。');
      const operation = this.operation(requestId);
      if (operation.receipt.status === 'committed') return operation.receipt.result as RunView;
      const run = submission.run;
      if (['submitting', 'submission_unknown'].includes(run.status)) run.status = response ? response.status === 200 ? 'queued' : 'failed' : 'submission_unknown';
      this.db.prepare('UPDATE runs SET body=? WHERE id=?').run(json(run), run.id);
      if (response) {
        const row = this.db.prepare('SELECT intent FROM operations WHERE request_id=?').get(requestId)!;
        this.db.prepare('UPDATE operations SET intent=? WHERE request_id=?').run(json({ ...JSON.parse(String(row.intent)), response }), requestId);
      }
      this.db.prepare('UPDATE operations SET body=? WHERE request_id=?').run(json({ ...operation.receipt, status: 'committed', result: run }), requestId);
      return run;
    });
  }
  finishEdit(requestId: string, after: GraphView): EditReceipt {
    after = this.graph(after);
    return this.transaction(() => {
      const operation = this.operation(requestId), intent = this.editIntent(requestId);
      if (['projectId', 'instanceId', 'workflowId', 'tabId'].some(key => intent.observation[key as keyof ComfyObservation] !== after.observation[key as keyof ComfyObservation])) throw new Error('Comfy 编辑前后的画布身份冲突。');
      if (operation.receipt.status === 'committed') return operation.receipt.result as EditReceipt;
      const afterVersionId = this.saveVersion(after.workflow);
      this.db.prepare('INSERT INTO versions VALUES (?) ON CONFLICT(id) DO NOTHING').run(afterVersionId);
      const receipt: EditReceipt = { requestId, beforeVersionId: intent.beforeVersionId, afterVersionId, observation: after.observation };
      this.db.prepare('UPDATE operations SET body=? WHERE request_id=?').run(json({ ...operation.receipt, status: 'committed', result: receipt }), requestId);
      return receipt;
    });
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
