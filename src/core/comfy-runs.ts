import { createHash, randomUUID } from 'node:crypto';
import type { ArtifactRef, MediaKind, ProviderProfile, RunView, RunStatus, ComfyActor, ComfyObservation } from '../shared/comfy.js';
import type { ComfyPromptPayload } from '../shared/comfy-bridge.js';
import { registerArtifact } from './comfy-artifacts.js';
import { insideProject } from './paths.js';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ComfyStore } from './comfy-store.js';
import { ComfyProviders, ProviderError, type AuthorizedConnection, type MediaSource, type ProviderFailure, type RemoteTask, type CancelOutcome, type VideoInput } from './comfy-providers.js';

export interface ProviderJobInput {
  instanceId: string; promptId: string; nodeId: string; sequence: number;
  connectionId: string; connectionRevision: number; kind: MediaKind; model: string;
  mode: 'text' | 'image' | 'reference'; prompt: string; references?: ArtifactRef[]; parameters: Record<string, unknown>;
}
export type JobStatus = 'submitting' | 'submission_unknown' | 'remote_running' | 'downloading' | 'succeeded' | 'failed' | 'cancel_requested' | 'cancelled' | 'needs_reconciliation';
/** Private persistent data. Sources and the actual input never cross the public run boundary. */
export interface ProviderJob {
  id: string; runId: string; fingerprint: string; input: ProviderJobInput; credentialRevision: number;
  status: JobStatus; createdAt: number; updatedAt: number; waiting: boolean;
  text?: string; assets: ArtifactRef[]; sources?: MediaSource[]; remote?: RemoteTask;
  failure?: ProviderFailure; rawStatus?: string; nextPollAt?: number; cancelOutcome?: CancelOutcome['outcome']; cancelRequestedAt?: number; submissionUncertain?: boolean;
}
export interface ProviderJobView { jobId: string; status: JobStatus; waiting: boolean; text?: string; assets: ArtifactRef[]; failure?: ProviderFailure; rawStatus?: string; cancelOutcome?: CancelOutcome['outcome']; }
export interface RunCredentials {
  list(): ProviderProfile[];
  withCredential<T>(id: string, revision: number, fn: (connection: AuthorizedConnection) => Promise<T>): Promise<T>;
}
const terminal = new Set<JobStatus>(['succeeded', 'failed', 'cancelled']);
class PersistenceError extends Error { constructor() { super('Comfy 已受理状态尚未持久保存，请修复存储后重试关闭。'); } }
export interface NativeRunPort {
  data?: string;
  queue(expected: ComfyObservation, requestId: string, actor: ComfyActor): Promise<RunView>;
  inspect(promptId: string): Promise<{ status?: RunStatus; outputs?: Record<string, unknown>; error?: RunView['error'] }>;
  stop(promptId: string): Promise<void | { promptId: string; instanceId: string; removed: boolean; interrupted: boolean }>;
}
export class ComfyRuns {
  private active = new Map<string, Promise<void>>();
  private cancellations = new Map<string, Promise<void>>();
  private controls = new Set<Promise<unknown>>();
  private closed = false;
  private closing?: Promise<void>;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private native?: NativeRunPort;
  private reads = new Map<string, Promise<RunView>>();
  private nativeReads = new Map<string, Promise<RunView>>();
  private refreshOffset = 0;
  private pendingJobs = new Map<string, Partial<ProviderJob>>();
  private pendingNative = new Map<string, { status: RunStatus; paths: string[]; assets: ArtifactRef[]; error?: RunView['error']; nativeStop?: 'removed' }>();
  constructor(readonly store: ComfyStore, private credentials: RunCredentials, private providers = new ComfyProviders(store.root)) {
    // A crashed create cannot be retried: the vendor may have accepted it.
    for (const job of store.providerJobs()) if (job.status === 'submitting') this.save(job, { status: 'submission_unknown' });
  }
  connections() { return this.credentials.list().map(({ id, name, revision, models, protocol }) => ({ id, name, revision, models, protocol })); }
  recent() { return this.store.listRuns(undefined, 10).runs.map(run => this.view(run.id)); }
  list(cursor?: string, selectedRunId?: string) {
    if (!this.closed && this.native) {
      const active = this.store.activeRuns().filter(run => run.waiting !== false && run.promptId);
      const offset = this.refreshOffset % Math.max(1, active.length); this.refreshOffset = offset + 4;
      const ordered = [...active.filter(run => run.id === selectedRunId), ...active.slice(offset), ...active.slice(0, offset)];
      for (const run of ordered) {
        if (this.nativeReads.has(run.id)) continue;
        if (this.nativeReads.size >= 4) break;
        void this.readNative(run.id).catch(() => {});
      }
    }
    const page = this.store.listRuns(cursor);
    return { ...page, runs: page.runs.map(run => this.view(run.id)), ...(selectedRunId ? { selectedRun: this.view(selectedRunId) } : {}) };
  }
  attachNative(native: NativeRunPort) { this.native = native; }
  queue(expected: ComfyObservation, requestId: string, actor: ComfyActor): Promise<RunView> { if (!this.native) throw Error('Native queue unavailable.'); return this.native.queue(expected, requestId, actor); }
  validatePrompt(payload: ComfyPromptPayload) {
    const profiles = this.credentials.list();
    for (const node of Object.values(payload.prompt) as { class_type?: string; inputs?: Record<string, unknown> }[]) {
      if (!/^MixcatAPI(Text|Image|Video)$/.test(node.class_type ?? '')) continue;
      if (!profiles.some(profile => node.inputs?.connection === `${profile.id}@${profile.revision}`)) throw Error('Provider connection revision unavailable.');
    }
  }
  assertMutable(id: string, revision: number) {
    if (this.store.providerJobs().some(job => job.input.connectionId === id && job.input.connectionRevision === revision && !terminal.has(job.status))) throw Error('供应商连接仍被持久任务引用，不能修改或移除。');
    for (const run of this.store.activeRuns()) {
      if (run.waiting === false) continue;
      const prompt = this.store.submission(run.requestId)?.payload.prompt;
      if (prompt && Object.values(prompt).some(node => { const value = node as { class_type?: string; inputs?: Record<string, unknown> }; return /^MixcatAPI(Text|Image|Video)$/.test(value.class_type ?? '') && value.inputs?.connection === `${id}@${revision}`; })) throw Error('供应商连接仍被已受理运行引用，不能修改或移除。');
    }
  }
  async submit(input: ProviderJobInput): Promise<{ jobId: string; status: JobStatus }> {
    if (this.closed) throw Error('Provider jobs closed.');
    this.validate(input);
    const run = this.store.runForPrompt(input.promptId);
    if (!run || run.observation.instanceId !== input.instanceId) throw Error('Provider run identity conflict.');
    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const previous = this.store.providerJobs(run.id).find(job => job.input.nodeId === input.nodeId && job.input.sequence === input.sequence);
    if (previous) { if (previous.fingerprint !== fingerprint) throw Error('Provider job input conflict.'); return { jobId: previous.id, status: previous.status }; }
    if (run.waiting === false || !['submitting', 'submission_unknown', 'queued', 'running'].includes(run.status)) throw Error('Provider run is no longer accepting nodes.');
    const node = this.store.submission(run.requestId)?.payload.prompt[input.nodeId] as { class_type?: string; inputs?: Record<string, unknown> } | undefined;
    if (node?.class_type !== `MixcatAPI${input.kind[0].toUpperCase()}${input.kind.slice(1)}` || node.inputs?.connection !== `${input.connectionId}@${input.connectionRevision}`) throw Error('Provider node identity conflict.');
    for (const key of ['model', 'prompt'] as const) if (!Array.isArray(node.inputs[key]) && node.inputs[key] !== input[key]) throw Error('Provider node input conflict.');
    if (input.kind === 'video' && !Array.isArray(node.inputs.mode) && node.inputs.mode !== input.mode) throw Error('Provider node mode conflict.');
    if (typeof node.inputs.parameters === 'string' && !isDeepStrictEqual(JSON.parse(node.inputs.parameters), input.parameters)) throw Error('Provider node parameters conflict.');
    const profile = this.credentials.list().find(profile => profile.id === input.connectionId && profile.revision === input.connectionRevision);
    if (!profile) throw Error('Provider connection revision unavailable.');
    const model = input.model || profile.models[input.kind]; if (!model?.trim()) throw Error('Provider model is required.');
    for (const reference of input.references ?? []) if (!isDeepStrictEqual(this.store.artifact(run.id, reference.id), reference)) throw Error('Reference artifact identity conflict.');
    const job: ProviderJob = { id: randomUUID(), runId: run.id, fingerprint, input: { ...structuredClone(input), model }, credentialRevision: profile.credentialRevision, status: 'submitting', createdAt: Date.now(), updatedAt: Date.now(), waiting: true, assets: [] };
    this.store.insertProviderJob(job);
    this.launch(job, true);
    return { jobId: job.id, status: job.status };
  }
  job(id: string): ProviderJobView {
    const job = this.get(id);
    return { jobId: job.id, status: job.status, waiting: job.waiting, assets: job.assets, ...(job.text !== undefined ? { text: job.text } : {}), ...(job.failure ? { failure: job.failure } : {}), ...(job.rawStatus ? { rawStatus: job.rawStatus } : {}), ...(job.cancelOutcome ? { cancelOutcome: job.cancelOutcome } : {}) };
  }
  private get(id: string) { const job = this.store.providerJob(id); if (!job) throw Error('Provider job not found.'); return { ...job, ...structuredClone(this.pendingJobs.get(id) ?? {}) }; }
  private save(job: ProviderJob, patch: Partial<ProviderJob>) {
    this.pendingJobs.set(job.id, { ...this.pendingJobs.get(job.id), ...structuredClone(patch), updatedAt: Date.now() });
    const next = this.persistJob(job.id);
    for (const key of Object.keys(job) as (keyof ProviderJob)[]) if (!(key in next)) delete job[key]; Object.assign(job, next);
  }
  private persistJob(id: string) {
    try {
      const next = this.get(id);
      for (const key of Object.keys(next) as (keyof ProviderJob)[]) if (next[key] === undefined) delete next[key];
      if (next.failure) next.failure = Object.fromEntries(Object.entries(next.failure).filter(([, value]) => value !== undefined)) as unknown as ProviderFailure;
      for (const asset of next.assets) this.store.registerArtifact(next.runId, asset);
      this.store.saveProviderJob(next); this.pendingJobs.delete(id); return next;
    } catch { throw new PersistenceError(); }
  }
  private persistJobs() {
    let failed = false;
    for (const id of this.pendingJobs.keys()) { try { this.persistJob(id); } catch { failed = true; } }
    if (failed) throw new PersistenceError();
  }
  private validate(input: ProviderJobInput) {
    if (!input || Object.keys(input).some(key => !['instanceId', 'promptId', 'nodeId', 'sequence', 'connectionId', 'connectionRevision', 'kind', 'model', 'mode', 'prompt', 'references', 'parameters'].includes(key))
      || ['instanceId', 'promptId', 'nodeId', 'connectionId'].some(key => typeof input[key as keyof ProviderJobInput] !== 'string' || !(input[key as keyof ProviderJobInput] as string).trim())
      || !Number.isSafeInteger(input.sequence) || input.sequence < 0 || !Number.isSafeInteger(input.connectionRevision) || input.connectionRevision < 1
      || !['text', 'image', 'video'].includes(input.kind) || !['text', 'image', 'reference'].includes(input.mode) || typeof input.prompt !== 'string' || typeof input.model !== 'string' || input.model !== '' && !input.model.trim()
      || !input.parameters || typeof input.parameters !== 'object' || Array.isArray(input.parameters)) throw Error('Invalid provider job input.');
    if (input.references !== undefined && (!Array.isArray(input.references) || input.references.length > 30)) throw Error('Invalid provider references.');
    if (input.kind === 'text' && (input.mode !== 'text' || input.references?.length) || input.mode === 'text' && input.references?.length || input.mode === 'image' && input.references?.length !== 1 || input.mode === 'reference' && !input.references?.length) throw Error('Invalid provider reference mode.');
    const allowed = input.kind === 'text' ? ['temperature', 'maxTokens'] : input.kind === 'image' ? ['size', 'aspectRatio', 'n', 'seed'] : ['duration', 'resolution', 'aspectRatio', 'seed'];
    if (Object.keys(input.parameters).some(key => !allowed.includes(key))) throw Error('Invalid provider parameters.');
  }
  private launch(job: ProviderJob, create = false) {
    if (this.active.has(job.id) || this.closed || this.pendingJobs.has(job.id)) return;
    clearTimeout(this.timers.get(job.id)); this.timers.delete(job.id);
    const work = this.execute(job, create).finally(() => {
      this.active.delete(job.id);
      const current = this.get(job.id);
      if (!this.closed && !this.pendingJobs.has(job.id) && current.waiting && current.remote && current.status === 'remote_running') {
        const timer = setTimeout(() => this.launch(this.get(job.id)), Math.max(0, (current.nextPollAt ?? Date.now() + 5000) - Date.now())); timer.unref(); this.timers.set(job.id, timer);
      }
    }); this.active.set(job.id, work); void work.catch(() => {});
  }
  private async execute(job: ProviderJob, create: boolean) {
    try {
      if (!create && (job.nextPollAt ?? 0) > Date.now()) return;
      if (create && job.input.kind === 'text') {
        const response = await this.credentials.withCredential(job.input.connectionId, job.input.connectionRevision, connection => this.providers.generateText(connection, { ...job.input.parameters, model: job.input.model, messages: [{ role: 'user', content: job.input.prompt }] }));
        this.save(job, { status: 'succeeded', text: response });
      }
      if (create && job.input.kind === 'image') {
        const response = await this.credentials.withCredential(job.input.connectionId, job.input.connectionRevision, connection => this.providers.generateImage(connection, { ...job.input.parameters, model: job.input.model, prompt: job.input.prompt, references: job.input.references }));
        const uncertain = response.failures.some(f => f.outcome === 'submission_unknown');
        this.save(job, { sources: response.sources, failure: response.failures.find(f => f.outcome === 'submission_unknown') ?? response.failures[0], submissionUncertain: uncertain, status: response.sources.length ? 'downloading' : uncertain ? 'submission_unknown' : 'failed' });
      }
      if (create && job.input.kind === 'video') {
        const input = { ...job.input.parameters, model: job.input.model, prompt: job.input.prompt, mode: job.input.mode, ...(job.input.mode !== 'text' ? { images: job.input.references ?? [] } : {}) } as VideoInput;
        const remote = await this.credentials.withCredential(job.input.connectionId, job.input.connectionRevision, connection => this.providers.submitVideo(connection, input));
        this.save(job, { remote, status: 'remote_running', nextPollAt: Date.now() + 5000 }); return;
      }
      if (!create && job.remote && (!job.sources?.length || job.failure?.outcome === 'output_source_retained')) {
        if ((job.nextPollAt ?? 0) > Date.now()) return;
        if (Date.now() - job.createdAt >= 24 * 60 * 60 * 1000 && job.status !== 'needs_reconciliation') { this.save(job, { status: 'needs_reconciliation' }); return; }
        const state = await this.credentials.withCredential(job.input.connectionId, job.input.connectionRevision, connection => this.providers.queryVideo(connection, job.remote!));
        this.save(job, { rawStatus: state.rawStatus, failure: state.error, nextPollAt: Date.now() + 5000,
          status: state.status === 'succeeded' ? 'downloading' : state.status === 'failed' || state.status === 'expired' ? 'failed' : state.status === 'cancelled' ? 'cancelled' : state.status === 'unknown' ? 'needs_reconciliation' : 'remote_running',
          ...(state.sources ? { sources: state.sources } : {}) });
        if (state.status === 'succeeded' && !state.sources?.length) this.save(job, { status: 'needs_reconciliation' });
      }
      if (job.sources?.length) {
        for (const source of job.sources.slice(job.assets.length)) {
          if (this.closed) return;
          const asset = await this.credentials.withCredential(job.input.connectionId, job.input.connectionRevision, connection => this.providers.materialize(connection, source));
          this.save(job, { assets: [...job.assets, asset] });
        }
        this.save(job, { status: job.submissionUncertain ? 'submission_unknown' : 'succeeded', ...(job.failure?.outcome === 'output_source_retained' ? { failure: undefined } : {}) });
      }
    } catch (error) {
      if (error instanceof PersistenceError) throw error;
      const failure: ProviderFailure = error instanceof ProviderError ? error.detail : { code: 'network_error', outcome: create ? 'submission_unknown' : 'remote_task_retained', message: 'Provider operation could not be completed.' };
      const retryQuery = !!job.remote && !job.sources?.length && Date.now() - job.createdAt < 24 * 60 * 60 * 1000;
      this.save(job, { failure, ...(retryQuery || job.sources?.length ? { nextPollAt: Date.now() + Math.min(60, Math.max(5, failure.retryAfterSeconds ?? 5)) * 1000 } : {}),
        status: retryQuery ? 'remote_running' : job.sources?.length || job.remote ? 'needs_reconciliation' : failure.outcome === 'submission_unknown' ? 'submission_unknown' : failure.outcome === 'rejected' || failure.outcome === 'not_submitted' ? 'failed' : 'needs_reconciliation' });
    }
  }
  private view(runId: string): RunView {
    const run = this.store.getRun(runId); if (!run) throw Error('Comfy run not found.');
    const jobs = this.store.providerJobs(runId).map(job => ({ ...job, ...structuredClone(this.pendingJobs.get(job.id) ?? {}) }));
    return { ...run, providerJobs: jobs.map(job => ({ jobId: job.id, nodeId: job.input.nodeId, status: job.status, waiting: job.waiting, ...(job.rawStatus ? { rawStatus: job.rawStatus } : {}), ...(job.cancelOutcome ? { cancelOutcome: job.cancelOutcome } : {}), ...(job.failure ? { failure: job.failure } : {}) })), recoveredAssets: run.status === 'succeeded' ? [] : jobs.flatMap(job => job.assets) };
  }
  read(runId: string): Promise<RunView> {
    const existing = this.reads.get(runId); if (existing) return existing;
    const work = this.readOnce(runId).finally(() => this.reads.delete(runId)); this.reads.set(runId, work); return work;
  }
  private async readOnce(runId: string): Promise<RunView> {
    this.persistJobs();
    const run = this.store.getRun(runId); if (!run) throw Error('Comfy run not found.');
    const jobs = this.store.providerJobs(runId).filter(job => !terminal.has(job.status) && job.cancelOutcome !== 'record_deleted' && (job.remote || job.sources?.length) && (job.nextPollAt ?? 0) <= Date.now());
    for (const job of jobs) if (!this.cancellations.has(job.id)) this.launch(job);
    await Promise.all(jobs.map(job => this.active.get(job.id)));
    return this.readNative(runId);
  }
  private readNative(runId: string): Promise<RunView> {
    const existing = this.nativeReads.get(runId); if (existing) return existing;
    const work = this.inspectRun(runId).finally(() => this.nativeReads.delete(runId)); this.nativeReads.set(runId, work); return work;
  }
  private async inspectRun(runId: string): Promise<RunView> {
    const run = this.store.getRun(runId); if (!run) throw Error('Comfy run not found.');
    const retained = this.pendingNative.get(runId);
    if (retained) { await this.persistNative(runId, retained); return this.view(runId); }
    if (this.closed) return this.view(runId);
    if (this.native && run.promptId && !['succeeded', 'failed', 'cancelled'].includes(run.status)) {
      const result = await this.native.inspect(run.promptId);
      if (this.closed) return this.view(runId);
      if (this.pendingNative.get(runId)?.nativeStop || this.store.getRun(runId)?.nativeStop) return this.view(runId);
      if (result.status) {
        const paths: string[] = [];
        for (const output of Object.values(result.outputs ?? {}) as Record<string, unknown>[]) {
          for (const kind of ['images', 'gifs', 'videos', 'files']) {
            if (!Array.isArray(output[kind])) continue;
            for (const item of output[kind] as { filename: string; subfolder: string; type: string }[]) {
              if (!item || !['output', 'temp'].includes(item.type) || typeof item.filename !== 'string' || typeof item.subfolder !== 'string') throw Error('Invalid native output descriptor.');
              const directory = insideProject(this.store.root, join(this.store.root, this.store.runtimeRecord<string>('instance-data:' + run.observation.instanceId) ?? this.native.data ?? '.mixcat/comfy/data', item.type));
              const path = insideProject(directory, resolve(directory, item.subfolder, item.filename));
              paths.push(path);
            }
          }
        }
        const known = { status: result.status, paths, assets: [] as ArtifactRef[], ...(result.error ? { error: result.error } : {}) };
        this.pendingNative.set(runId, known); await this.persistNative(runId, known);
      }
    }
    return this.view(runId);
  }
  private async persistNative(runId: string, known: { status: RunStatus; paths: string[]; assets: ArtifactRef[]; error?: RunView['error']; nativeStop?: 'removed' }) {
    try {
      for (const path of known.paths.slice(known.assets.length)) known.assets.push(await registerArtifact(this.store.root, path, true));
      if (this.pendingNative.get(runId) !== known) return;
      for (const asset of known.assets) this.store.registerArtifact(runId, asset);
      let status = known.status;
      if (this.closed && !['succeeded', 'failed', 'cancelled'].includes(status)) status = ['submitting', 'submission_unknown'].includes(status) ? 'submission_unknown' : 'needs_reconciliation';
      this.store.updateRun(runId, { status, ...(known.nativeStop ? { nativeStop: known.nativeStop, waiting: false } : {}), ...(known.error ? { error: known.error } : {}), ...(known.assets.length ? { assets: known.assets } : {}) });
      if (known.status === 'failed') for (const job of this.store.providerJobs(runId)) if (!terminal.has(job.status)) { this.save(job, { waiting: false }); clearTimeout(this.timers.get(job.id)); this.timers.delete(job.id); }
      this.pendingNative.delete(runId);
    } catch { throw new PersistenceError(); }
  }
  private control<T>(action: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(Error('Provider jobs closed.'));
    const work = Promise.resolve().then(action); this.controls.add(work);
    void work.finally(() => this.controls.delete(work)).catch(() => {}); return work;
  }
  stop(runId: string, action: 'stop_waiting' | 'cancel_remote'): Promise<RunView> { return this.control(() => this.performStop(runId, action)); }
  private async performStop(runId: string, action: 'stop_waiting' | 'cancel_remote'): Promise<RunView> {
    const run = this.store.getRun(runId); if (!run) throw Error('Comfy run not found.');
    if (!['stop_waiting', 'cancel_remote'].includes(action)) throw Error('Invalid stop action.');
    const retained = this.pendingNative.get(runId);
    if (retained?.nativeStop) await this.persistNative(runId, retained);
    this.store.updateRun(runId, { waiting: false });
    for (const job of this.store.providerJobs(runId)) { this.save(job, { waiting: false }); clearTimeout(this.timers.get(job.id)); this.timers.delete(job.id); }
    if (run.promptId && !retained?.nativeStop && !terminal.has(run.status as JobStatus)) {
      const result = await this.native?.stop(run.promptId);
      if (result) {
        if (result.promptId !== run.promptId || result.instanceId !== run.observation.instanceId || typeof result.removed !== 'boolean' || typeof result.interrupted !== 'boolean' || result.removed && result.interrupted) throw Error('Native stop identity or outcome conflict.');
        if (result.removed) {
          const known = { status: 'cancelled' as const, nativeStop: 'removed' as const, paths: [], assets: [] };
          this.pendingNative.set(runId, known); await this.persistNative(runId, known);
        }
      }
    }
    if (action === 'cancel_remote') for (const job of this.store.providerJobs(runId)) await this.cancel(job);
    return this.view(runId);
  }
  private async cancel(job: ProviderJob) {
    const existing = this.cancellations.get(job.id); if (existing) return existing;
    const work = this.performCancel(job).finally(() => this.cancellations.delete(job.id)); this.cancellations.set(job.id, work); return work;
  }
  private async performCancel(job: ProviderJob) {
    if (terminal.has(job.status)) return;
    this.save(job, { status: 'cancel_requested', cancelRequestedAt: Date.now() });
    await this.active.get(job.id);
    job = this.get(job.id);
    if (!job.remote || terminal.has(job.status)) { if (!terminal.has(job.status)) this.save(job, { status: 'submission_unknown', cancelOutcome: 'unknown' }); return; }
    this.save(job, { status: 'cancel_requested' });
    try {
      const result = await this.credentials.withCredential(job.input.connectionId, job.input.connectionRevision, connection => this.providers.cancelVideo(connection, job.remote!));
      this.save(job, { cancelOutcome: result.outcome, ...(result.state ? { rawStatus: result.state.rawStatus, ...(result.state.sources ? { sources: result.state.sources } : {}) } : {}), failure: result.error,
        status: result.outcome === 'cancelled' ? 'cancelled' : result.outcome !== 'not_cancellable' ? 'needs_reconciliation' : result.state?.status === 'failed' || result.state?.status === 'expired' ? 'failed' : result.state?.status === 'succeeded' ? 'downloading' : 'remote_running' });
    } catch (error) { if (error instanceof PersistenceError) throw error; this.save(job, { status: 'needs_reconciliation', cancelOutcome: 'unknown', ...(error instanceof ProviderError ? { failure: error.detail } : {}) }); }
  }
  stopJob(id: string, action: 'stop_waiting' | 'cancel_remote') { return this.control(() => this.performStopJob(id, action)); }
  private async performStopJob(id: string, action: 'stop_waiting' | 'cancel_remote') {
    if (!['stop_waiting', 'cancel_remote'].includes(action)) throw Error('Invalid stop action.');
    const job = this.get(id); await this.performStop(job.runId, 'stop_waiting');
    if (action === 'cancel_remote') await this.cancel(job);
    return this.job(id);
  }
  reconcile(runId: string) { return this.read(runId); }
  recover() {
    for (const run of this.store.activeRuns()) this.store.updateRun(run.id, { waiting: false, status: ['submitting', 'submission_unknown'].includes(run.status) ? 'submission_unknown' : 'needs_reconciliation' });
    for (const job of this.store.providerJobs()) {
      if (terminal.has(job.status) || job.cancelOutcome === 'record_deleted' || !job.remote && !job.sources?.length) continue;
      this.save(job, { waiting: false });
      const timer = setTimeout(() => this.launch(this.get(job.id)), Math.max(0, (job.nextPollAt ?? 0) - Date.now())); timer.unref(); this.timers.set(job.id, timer);
    }
  }
  activeOperations(instanceId?: string) {
    return { inFlight: this.active.size + this.controls.size,
      runs: this.store.activeRuns().filter(run => run.waiting !== false && (instanceId === undefined || run.observation.instanceId === instanceId)).map(run => this.view(run.id)),
      retainedJobs: this.store.providerJobs().filter(job => !terminal.has(job.status)).map(job => ({ runId: job.runId, jobId: job.id, nodeId: job.input.nodeId, status: job.status, waiting: job.waiting, ...(job.cancelOutcome ? { cancelOutcome: job.cancelOutcome } : {}) })) };
  }
  canClose(instanceId?: string) { const active = this.activeOperations(instanceId); return active.inFlight === 0 && active.runs.length === 0; }
  suspend() {
    this.closed = true; let failed = false;
    try { for (const run of this.store.activeRuns()) { try { this.store.updateRun(run.id, { waiting: false, status: ['submitting', 'submission_unknown'].includes(run.status) ? 'submission_unknown' : 'needs_reconciliation' }); } catch { failed = true; } } } catch { failed = true; }
    try { for (const job of this.store.providerJobs()) if (!terminal.has(job.status)) { try { this.save(job, { waiting: false }); } catch { failed = true; } } } catch { failed = true; }
    if (failed) throw new PersistenceError();
  }
  async drain() {
    const consequential = [...this.active.values(), ...this.cancellations.values(), ...this.controls];
    const results = await Promise.allSettled([...consequential, ...this.reads.values(), ...this.nativeReads.values()]);
    let failed = false;
    for (const [id, known] of this.pendingNative) { try { await this.persistNative(id, known); } catch { failed = true; } }
    try { this.persistJobs(); } catch { failed = true; }
    if (failed || results.some((result, index) => result.status === 'rejected' && (index < consequential.length || result.reason instanceof PersistenceError))) throw new PersistenceError();
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear();
    const work = this.drain(); this.closing = work;
    void work.finally(() => { if (this.closing === work) this.closing = undefined; }).catch(() => {}); return work;
  }
}
