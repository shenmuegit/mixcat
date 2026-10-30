import { createHash, randomUUID } from 'node:crypto';
import { ComfyStore } from './comfy-store.js';
import { boundedComfy, sameObservation, validateComfyRequest, validateGraph, validateNativeQueue, validateObservation, validatePrompt, type NativeQueueOptions, type NativeQueueRequest, type ComfyPromptPayload, type ComfyPromptResponse } from '../shared/comfy-bridge.js';
import type { ComfyActor, ComfyObservation, ComfyReply, ComfyRequest, GraphView, RunStatus, RunView } from '../shared/comfy.js';
import type { ComfyRuns } from './comfy-runs.js';

export type GraphTransport = (request: Extract<ComfyRequest, { type: 'read_graph' | 'apply_graph' }>) => Promise<GraphView>;
export interface QueueTransport {
  prepare(request: NativeQueueRequest): Promise<{ ok: boolean }>;
  submit(payload: ComfyPromptPayload): Promise<ComfyPromptResponse>;
  reconcile(promptId: string): Promise<RunStatus | undefined>;
  validate?(payload: ComfyPromptPayload): void;
}
const defaultQueue: NativeQueueOptions = { number: 0, batchCount: 1, options: {} };
export class ComfyService {
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private queueSession?: { id: string; expiresAt: number; request: Extract<ComfyRequest, { type: 'queue_graph' }>; actor: ComfyActor; queue: NativeQueueOptions; index: number; busy: boolean; failed: boolean; run?: RunView };
  private admissions = new Set<Promise<ComfyPromptResponse>>();
  private controls = new Set<Promise<ComfyReply>>();
  private mutations = 0;
  get pendingMutations() { return this.mutations; }
  constructor(readonly store: ComfyStore, private graph: GraphTransport, private queue?: QueueTransport, private runs?: ComfyRuns) {}
  handle(projectId: string, request: ComfyRequest, actor: ComfyActor, expiresAt = Date.now() + 30000): Promise<ComfyReply> {
    if (request?.type === 'stop_run') {
      // Recovery/downloads must not hold up a user's already-accepted run control.
      const work = Promise.resolve().then(() => { this.deadline(expiresAt); return this.perform(projectId, request, actor, expiresAt); });
      this.controls.add(work); void work.finally(() => this.controls.delete(work)).catch(() => {}); return work;
    }
    const mutation = ['apply_graph', 'restore_graph', 'queue_graph'].includes(request?.type);
    if (mutation) this.mutations++;
    const work = this.tail.then(() => { this.deadline(expiresAt); return this.perform(projectId, request, actor, expiresAt); }).finally(() => { if (mutation) this.mutations--; }); this.tail = work.catch(() => {}); return work;
  }
  nativeQueue(projectId: string, request: Extract<ComfyRequest, { type: 'queue_graph' }>, queue: NativeQueueOptions): Promise<{ ok: boolean; run?: RunView }> {
    const expiresAt = Date.now() + 30000;
    this.mutations++;
    const work = this.tail.then(() => this.runQueue(projectId, request, { kind: 'user' }, queue, expiresAt)).finally(() => { this.mutations--; }); this.tail = work.catch(() => {}); return work;
  }
  private async perform(projectId: string, request: ComfyRequest, actor: ComfyActor, expiresAt: number): Promise<ComfyReply> {
    validateComfyRequest(request); this.check(projectId);
    if (request.type === 'read_graph') {
      const view = await this.graph(request); this.check(projectId); validateGraph(view, projectId);
      const { recovery: _guestRecovery, ...graph } = view;
      const recovery = this.store.recoverableEdits().map(({ requestId, beforeVersionId, recoveryRequestId }) => ({ requestId, beforeVersionId, ...(recoveryRequestId ? { recoveryRequestId } : {}) }));
      const reply = { ...graph, ...(recovery.length ? { recovery } : {}) }; boundedComfy(reply); return reply;
    }
    if (request.type === 'queue_graph') { const result = await this.runQueue(projectId, request, actor, defaultQueue, expiresAt); if (!result.run) throw new Error('Comfy 原生队列未提交。'); return result.run; }
    if (request.type === 'read_run') { if (this.runs) return this.runs.read(request.runId); const run = this.store.getRun(request.runId); if (!run) throw new Error('Comfy 运行不存在。'); return this.reconcile(run); }
    if (request.type === 'stop_run' && this.runs) return this.runs.stop(request.runId, request.action);
    if (request.type !== 'apply_graph' && request.type !== 'restore_graph') throw new Error(`Comfy 操作尚未实现：${request.type}`);
    if (request.expected.projectId !== projectId) throw new Error('Comfy 画布身份冲突。');
    const fingerprint = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const operation = this.store.beginOperation(request.requestId, fingerprint);
    if (operation.status === 'committed') return operation.result!;
    if (operation.status === 'recovered') throw Error('Comfy 原编辑已显式恢复，不能重复执行。');
    if (this.store.recoverableEdits().some(edit => edit.requestId === request.requestId)) throw new Error('Comfy 编辑结果需核对恢复记录，不能重复执行。');
    const workflow = request.type === 'restore_graph' ? this.store.readVersion(request.versionId) : request.workflow;
    const apply = { type: 'apply_graph' as const, requestId: request.requestId, expected: request.expected, workflow }; boundedComfy(apply);
    const before = await this.graph({ type: 'read_graph' }); this.check(projectId); validateGraph(before, projectId);
    if (!sameObservation(before.observation, request.expected)) throw new Error('Comfy 画布已变更，请重新读取后显式重试。');
    this.store.stageEdit(request.requestId, before, workflow, request.type === 'restore_graph' ? request.recoveryRequestId : undefined);
    const after = await this.graph(apply); this.check(projectId); validateGraph(after, projectId, before.observation.instanceId);
    return this.store.finishEdit(request.requestId, after);
  }
  private async runQueue(projectId: string, request: Extract<ComfyRequest, { type: 'queue_graph' }>, actor: ComfyActor, queue: NativeQueueOptions, expiresAt: number) {
    validateComfyRequest(request); validateNativeQueue(queue); this.check(projectId); this.deadline(expiresAt);
    if (!this.queue) throw new Error('Comfy 操作尚未实现：queue_graph');
    if (request.expected.projectId !== projectId) throw new Error('Comfy 画布身份冲突。');
    const fingerprint = createHash('sha256').update(JSON.stringify({ request, queue })).digest('hex');
    const operation = this.store.beginOperation(request.requestId, fingerprint);
    if (operation.status === 'committed') { const run = operation.result as RunView; return { ok: !['failed', 'submission_unknown'].includes(run.status), run }; }
    if (this.store.submission(request.requestId)) return { ok: false, run: this.store.finishSubmission(request.requestId) };
    const before = await this.graph({ type: 'read_graph' }); this.check(projectId); this.deadline(expiresAt); validateGraph(before, projectId);
    if (!sameObservation(before.observation, request.expected)) throw new Error('Comfy 画布已变更，请重新读取后显式重试。');
    const session: NonNullable<ComfyService['queueSession']> = { id: randomUUID(), expiresAt, request, actor, queue, index: 0, busy: false, failed: false };
    this.queueSession = session;
    try {
      const result = await this.queue.prepare({ type: 'native_queue', sessionId: session.id, expiresAt, requestId: request.requestId, expected: request.expected, queue });
      this.check(projectId);
      return { ok: result.ok && !session.failed, run: session.run };
    } finally { session.failed = true; if (this.queueSession === session) this.queueSession = undefined; await Promise.allSettled([...this.admissions]); }
  }
  // Only the captured guest's active queue session may enter while prepare awaits native serialization.
  admit(sessionId: string, source: ComfyObservation, payload: ComfyPromptPayload): Promise<ComfyPromptResponse> {
    const work = this.accept(sessionId, source, payload); this.admissions.add(work);
    void work.finally(() => this.admissions.delete(work)).catch(() => {}); return work;
  }
  private async accept(sessionId: string, source: ComfyObservation, payload: ComfyPromptPayload): Promise<ComfyPromptResponse> {
    validateObservation(source); validatePrompt(payload); this.check(source.projectId);
    const session = this.queueSession;
    if (!session || session.id !== sessionId || session.busy || session.failed || session.index >= session.queue.batchCount || !sameObservation(source, session.request.expected)) throw new Error('Comfy 提交会话已失效或身份冲突。');
    this.deadline(session.expiresAt);
    session.busy = true;
    const index = session.index++, requestId = index ? `${session.request.requestId}:item:${index}` : session.request.requestId;
    let staged = false;
    try {
      if (index) this.store.beginOperation(requestId, createHash('sha256').update(JSON.stringify({ request: session.request, queue: session.queue, index })).digest('hex'));
      this.queue!.validate?.(payload);
      const submission = this.store.stageRun(requestId, source, structuredClone(payload), session.actor); staged = true;
      this.deadline(session.expiresAt);
      const response = await this.queue!.submit(submission.payload);
      boundedComfy(response);
      const run = this.store.finishSubmission(requestId, response); session.run ??= run;
      if (response.status === 200 && response.body.prompt_id !== submission.run.promptId) throw new Error('Comfy 后端受理身份冲突。');
      if (response.status !== 200 || run.status === 'submission_unknown') session.failed = true;
      return response;
    } catch (error) {
      session.failed = true;
      if (staged) { const run = this.store.finishSubmission(requestId); session.run ??= run; }
      throw error;
    } finally { session.busy = false; }
  }
  private async reconcile(run: RunView): Promise<RunView> {
    if (!this.queue || !run.promptId || !['submitting', 'submission_unknown', 'queued', 'running'].includes(run.status)) return run;
    const status = await this.queue.reconcile(run.promptId); this.check(run.observation.projectId);
    if (!status || status === 'queued' && run.status === 'running') return run;
    return this.store.updateRun(run.id, { status });
  }
  private check(projectId: string) { if (this.closed || projectId !== this.store.projectId) throw new Error('Comfy 项目已关闭或身份冲突。'); }
  private deadline(expiresAt: number) { if (Date.now() >= expiresAt) throw new Error('Comfy 请求已超时，未受理的提交不会继续。'); }
  async close() { this.closed = true; await this.tail; await Promise.allSettled([...this.admissions, ...this.controls]); await this.runs?.close(); this.store.close(); }
}
