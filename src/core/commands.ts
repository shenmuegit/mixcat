import { isDeepStrictEqual } from 'node:util';
import type { AppCommand, AppReply, CommandEnvelope, CommandReceipt } from '../shared/types.js';

// Receipts live only in this worker; after restart reconcile durable tasks and native threads.
export class CommandDispatcher {
  private entries = new Map<string, { command: AppCommand; receipt: CommandReceipt; promise: Promise<AppReply>; completedAt?: number }>();
  constructor(private engine: { command(command: AppCommand, actionId?: string): Promise<AppReply> }) {}
  private prune() {
    const completed = [...this.entries].filter(([, entry]) => entry.completedAt !== undefined).sort((a, b) => a[1].completedAt! - b[1].completedAt!);
    for (let i = 0; i < completed.length; i++) if (i < completed.length - 32 || Date.now() - completed[i][1].completedAt! > 120000) this.entries.delete(completed[i][0]);
  }
  async dispatch(envelope: CommandEnvelope): Promise<AppReply> {
    if (!envelope || typeof envelope.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(envelope.id) || !envelope.command || typeof envelope.command !== 'object' || JSON.stringify(envelope.command).length > 1000000) throw new Error('命令编号或内容不正确。');
    this.prune();
    const existing = this.entries.get(envelope.id);
    if (existing) {
      if (!isDeepStrictEqual(existing.command, envelope.command)) throw new Error('同一命令编号不能用于不同内容。');
      return existing.promise;
    }
    const command = structuredClone(envelope.command);
    const receipt: CommandReceipt = { id: envelope.id, status: 'queued' };
    const promise = Promise.resolve().then(async () => {
      receipt.status = 'running';
      try { const result = await this.engine.command(command, envelope.id); receipt.status = 'succeeded'; receipt.result = structuredClone(result); return result; }
      catch (error) {
        receipt.status = (error as any)?.outcome === 'unknown' ? 'unknown' : (error as any)?.code === 'COMMAND_CANCELLED' ? 'cancelled' : 'failed';
        receipt.error = error instanceof Error ? error.message : String(error); throw error;
      }
    });
    this.entries.set(envelope.id, { command, receipt, promise });
    void promise.finally(() => {
      const entry = this.entries.get(envelope.id);
      if (entry && receipt.status !== 'unknown') { entry.completedAt = Date.now(); this.prune(); }
    }).catch(() => {});
    return promise;
  }
  inspect(id: string): CommandReceipt { this.prune(); return structuredClone(this.entries.get(id)?.receipt ?? { id, status: 'unknown' }); }
}
