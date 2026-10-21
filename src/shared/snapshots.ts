import type { AppSnapshot, AppUpdate } from './types.js';

export function mergeUpdate(previous: AppSnapshot | null, update: AppUpdate): { snapshot: AppSnapshot | null; resyncProjectId: string | null } {
  const version = update.kind === 'full' ? update.snapshot : update;
  const older = previous && ((version.generation ?? 0) < (previous.generation ?? 0) ||
    (version.generation ?? 0) === (previous.generation ?? 0) && (version.revision ?? 0) < (previous.revision ?? 0));
  if (older) return { snapshot: previous, resyncProjectId: null };
  if (update.kind === 'full') return { snapshot: update.snapshot, resyncProjectId: null };
  if (!previous?.selected || previous.selected.project.id !== update.projectId || previous.generation !== update.generation || (previous.revision ?? 0) < update.baseRevision)
    return { snapshot: previous, resyncProjectId: update.projectId };
  const entries = new Map((previous.selected.conversation ?? []).map(entry => [entry.id, entry]));
  for (const entry of update.entries) entries.set(entry.id, entry);
  return { snapshot: { generation: update.generation, revision: update.revision, projects: update.projects, runtime: update.runtime, account: update.account,
    selected: { ...update.selected, conversation: [...entries.values()].sort((a, b) => a.seq - b.seq) } }, resyncProjectId: null };
}

// Network compensation stays outside React state updaters and expires on navigation.
export class SnapshotReceiver {
  snapshot: AppSnapshot | null = null;
  private projectId: string | null = null;
  private epoch = 0;
  private creating = false;
  private pending: { id: string; epoch: number } | null = null;
  private waiting: Extract<AppUpdate, { kind: 'delta' }>[] = [];
  constructor(private read: (id: string) => Promise<AppSnapshot>, private publish: (snapshot: AppSnapshot) => void, private error: (error: unknown) => void = () => {}) {}
  navigate(id: string | null) { this.projectId = id; this.creating = id === null; this.epoch++; this.pending = null; this.waiting = []; return this.epoch; }
  cancelNavigation(token: number) { if (token === this.epoch) { this.creating = false; this.navigate(this.snapshot?.selected?.project.id ?? null); this.creating = false; } }
  accept(update: AppUpdate, creationToken?: number) {
    const id = update.kind === 'full' ? update.snapshot.selected?.project.id : update.projectId;
    if (creationToken !== undefined && creationToken !== this.epoch) return;
    if (this.creating) {
      if (creationToken !== this.epoch || update.kind !== 'full') return;
      this.creating = false; this.projectId = id ?? null;
    }
    if (this.projectId && id && id !== this.projectId) return;
    if (!this.projectId && id) this.projectId = id;
    const merged = mergeUpdate(this.snapshot, update);
    if (merged.snapshot !== this.snapshot && merged.snapshot) { this.snapshot = merged.snapshot; this.publish(merged.snapshot); }
    if (!merged.resyncProjectId) return;
    if (update.kind === 'delta' && !this.waiting.some(item => item.generation === update.generation && item.revision === update.revision)) this.waiting.push(update);
    if (this.pending) return;
    this.compensate(merged.resyncProjectId);
  }
  private compensate(id: string, attempt = 0) {
    const request = { id, epoch: this.epoch };
    this.pending = request;
    void this.read(request.id).then(snapshot => {
      if (this.epoch === request.epoch) {
        this.accept({ kind: 'full', snapshot });
        const waiting = this.waiting; this.waiting = [];
        for (const update of waiting.sort((a, b) => a.generation - b.generation || a.revision - b.revision)) this.accept(update);
      }
    }).catch(error => { if (this.epoch === request.epoch) { this.waiting = []; this.error(error); } })
      .finally(() => {
        if (this.pending !== request) return;
        this.pending = null;
        if (!this.waiting.length) return;
        if (attempt === 0) this.compensate(id, 1);
        else { this.waiting = []; this.error(new Error('项目历史版本仍有缺口，请重新打开项目以读取完整历史。')); }
      });
  }
}
