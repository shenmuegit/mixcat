import { randomUUID } from 'node:crypto';
import type { ComfyActor, ComfyReply, ComfyRequest, ComfyHostPort } from '../shared/comfy.js';
import { boundedComfy, comfyObject, validateComfyRequest, type ComfyBridgeRequest, type ComfyRpcMessage } from '../shared/comfy-bridge.js';

export class ComfyRpc implements ComfyHostPort {
  private generation = randomUUID();
  private pending = new Map<string, { projectId: string; resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private send: (message: ComfyRpcMessage) => void, private timeoutMs = 30000) {}
  async request(projectId: string, request: ComfyRequest, actor: ComfyActor = { kind: 'user' }): Promise<ComfyReply> { return this.call(projectId, request, actor); }
  async closeProject(projectId: string): Promise<void> { this.invalidateProject(projectId); await this.call(projectId, { type: 'close_project' }, { kind: 'user' }); }
  private async call(projectId: string, request: ComfyBridgeRequest, actor: ComfyActor): Promise<any> {
    validateComfyRequest(request);
    const message: ComfyRpcMessage = { type: 'comfy_request', id: randomUUID(), generation: this.generation, projectId, request, actor };
    boundedComfy(message);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(message.id); reject(new Error('Comfy 请求超时；编辑结果需核对恢复记录。')); }, this.timeoutMs);
      this.pending.set(message.id, { projectId, resolve, reject, timer });
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
      value.error !== undefined ? pending.reject(new Error(value.error as string)) : pending.resolve(value.result); return true;
    } catch { return false; }
  }
  invalidateProject(projectId: string) {
    for (const [id, entry] of this.pending) if (entry.projectId === projectId) { clearTimeout(entry.timer); entry.reject(new Error('Comfy 项目或世代已失效。')); this.pending.delete(id); }
  }
  invalidate() { for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Comfy 项目或世代已失效。')); } this.pending.clear(); this.generation = randomUUID(); }
}
