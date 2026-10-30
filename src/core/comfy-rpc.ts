import { randomUUID } from 'node:crypto';
import type { ComfyActor, ComfyReply, ComfyRequest, ComfyHostPort } from '../shared/comfy.js';
import { boundedComfy, comfyObject, validateComfyRequest, type ComfyBridgeRequest, type ComfyRpcMessage } from '../shared/comfy-bridge.js';

export class ComfyRpc implements ComfyHostPort {
  private generation = randomUUID();
  private pending = new Map<string, { projectId: string; expiresAt: number; resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private send: (message: ComfyRpcMessage) => void, private timeoutMs = 30000) {}
  async request(projectId: string, request: ComfyRequest, actor: ComfyActor = { kind: 'user' }): Promise<ComfyReply> { return this.call(projectId, request, actor); }
  async prepareQueue(projectId: string, request: import('../shared/comfy-bridge.js').NativeQueueRequest): Promise<{ ok: boolean }> { return this.call(projectId, request, { kind: 'user' }); }
  async flushGraph(projectId: string): Promise<import('../shared/comfy.js').GraphView> { return this.call(projectId, { type: 'flush_graph' }, { kind: 'user' }); }
  async snapshotWorkspace(projectId: string): Promise<import('./comfy-updates.js').NativeWorkspace> { return this.call(projectId, { type: 'snapshot_workspace' }, { kind: 'user' }); }
  async restoreContext(projectId: string, context: NonNullable<import('./comfy-updates.js').NativeWorkspace['active']>): Promise<unknown> { return this.call(projectId, { type: 'restore_context', context }, { kind: 'user' }); }
  async restoreWorkspace(projectId: string, workspace: import('./comfy-updates.js').NativeWorkspace): Promise<unknown> { if (!workspace.active) throw Error('Comfy 快照缺少活动标签页。'); return this.call(projectId, { type: 'restore_workspace', tabs: workspace.tabs, context: workspace.active }, { kind: 'user' }); }
  async closeProject(projectId: string, deleting = false): Promise<void> { this.invalidateProject(projectId); await this.call(projectId, { type: 'close_project', deleting }, { kind: 'user' }); }
  private async call(projectId: string, request: ComfyBridgeRequest, actor: ComfyActor): Promise<any> {
    validateComfyRequest(request);
    const expiresAt = Math.min(Date.now() + this.timeoutMs, request.type === 'native_queue' ? request.expiresAt : Number.MAX_SAFE_INTEGER);
    if (expiresAt <= Date.now()) throw new Error('Comfy 请求超时；尚未受理的操作不会继续提交。');
    const message: ComfyRpcMessage = { type: 'comfy_request', id: randomUUID(), generation: this.generation, projectId, expiresAt, request, actor };
    boundedComfy(message);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(message.id); reject(new Error('Comfy 请求超时；已受理操作需核对持久记录。')); }, Math.max(1, expiresAt - Date.now()));
      this.pending.set(message.id, { projectId, expiresAt, resolve, reject, timer });
      try { this.send(message); } catch (error) { clearTimeout(timer); this.pending.delete(message.id); reject(error); }
    });
  }
  receive(value: unknown): boolean {
    try {
      boundedComfy(value); comfyObject(value);
      if (value.type !== 'comfy_reply' || value.generation !== this.generation || typeof value.id !== 'string') return false;
      const pending = this.pending.get(value.id);
      if (!pending || pending.projectId !== value.projectId || (value.error === undefined) === (value.result === undefined) || value.error !== undefined && typeof value.error !== 'string') return false;
      this.pending.delete(value.id); clearTimeout(pending.timer);
      if (Date.now() >= pending.expiresAt) { pending.reject(new Error('Comfy 请求超时；已受理操作需核对持久记录。')); return false; }
      value.error !== undefined ? pending.reject(new Error(value.error as string)) : pending.resolve(value.result); return true;
    } catch { return false; }
  }
  invalidateProject(projectId: string) {
    for (const [id, entry] of this.pending) if (entry.projectId === projectId) { clearTimeout(entry.timer); entry.reject(new Error('Comfy 项目或世代已失效。')); this.pending.delete(id); }
  }
  invalidate() { for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Comfy 项目或世代已失效。')); } this.pending.clear(); this.generation = randomUUID(); }
}
