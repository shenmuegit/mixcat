import { createHash } from 'node:crypto';
import { ComfyStore } from './comfy-store.js';
import { boundedComfy, sameObservation, validateComfyRequest, validateGraph } from '../shared/comfy-bridge.js';
import type { ComfyActor, ComfyReply, ComfyRequest, GraphView } from '../shared/comfy.js';

export type GraphTransport = (request: Extract<ComfyRequest, { type: 'read_graph' | 'apply_graph' }>) => Promise<GraphView>;
export class ComfyService {
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(readonly store: ComfyStore, private graph: GraphTransport) {}
  handle(projectId: string, request: ComfyRequest, _actor: ComfyActor): Promise<ComfyReply> {
    const work = this.tail.then(() => this.perform(projectId, request)); this.tail = work.catch(() => {}); return work;
  }
  private async perform(projectId: string, request: ComfyRequest): Promise<ComfyReply> {
    validateComfyRequest(request); this.check(projectId);
    if (request.type === 'read_graph') { const view = await this.graph(request); this.check(projectId); validateGraph(view, projectId); return view; }
    if (request.type !== 'apply_graph' && request.type !== 'restore_graph') throw new Error(`Comfy 操作尚未实现：${request.type}`);
    if (request.expected.projectId !== projectId) throw new Error('Comfy 画布身份冲突。');
    const fingerprint = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const operation = this.store.beginOperation(request.requestId, fingerprint);
    if (operation.status === 'committed') return operation.result!;
    if (this.store.recoverableEdits().some(edit => edit.requestId === request.requestId)) throw new Error('Comfy 编辑结果需核对恢复记录，不能重复执行。');
    const workflow = request.type === 'restore_graph' ? this.store.readVersion(request.versionId) : request.workflow;
    const apply = { type: 'apply_graph' as const, requestId: request.requestId, expected: request.expected, workflow }; boundedComfy(apply);
    const before = await this.graph({ type: 'read_graph' }); this.check(projectId); validateGraph(before, projectId);
    if (!sameObservation(before.observation, request.expected)) throw new Error('Comfy 画布已变更，请重新读取后显式重试。');
    this.store.stageEdit(request.requestId, before, workflow);
    const after = await this.graph(apply); this.check(projectId); validateGraph(after, projectId, before.observation.instanceId);
    return this.store.finishEdit(request.requestId, after);
  }
  private check(projectId: string) { if (this.closed || projectId !== this.store.projectId) throw new Error('Comfy 项目已关闭或身份冲突。'); }
  async close() { this.closed = true; await this.tail; this.store.close(); }
}
