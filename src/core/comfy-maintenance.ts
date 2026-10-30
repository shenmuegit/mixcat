import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ProjectStore } from './store.js';
import { ComfyStore } from './comfy-store.js';
import { ensureProjectDirectory, insideProject } from './paths.js';
import { lifecycleLease, validateManifest, type RuntimeManifest } from './comfy-runtime.js';
import { verifyCombination, type RuntimeCandidate, type RuntimeCombination, type RuntimeSelection } from './comfy-updates.js';

export type ComfyMaintenanceRequest = { root: string } & ({ operation: 'prepare'; manifest: RuntimeManifest } | { operation: 'activate' | 'rollback'; versionId: string });
export function parseComfyMaintenance(args: string[]): ComfyMaintenanceRequest {
  const [directory, operation, target, tag, sha] = args;
  if (!directory || !target || !['prepare', 'activate', 'rollback'].includes(operation)) throw Error('Usage: comfy-maintain PROJECT prepare MANIFEST TAG SHA | PROJECT activate|rollback COMBINATION_ID');
  const root = ensureProjectDirectory(resolve(directory));
  if (operation === 'prepare') {
    if (args.length !== 5) throw Error('准备候选必须指定已审查清单、明确 tag 和完整 SHA。');
    const manifest = JSON.parse(readFileSync(resolve(target), 'utf8')) as RuntimeManifest; validateManifest(manifest);
    if (!/^v\d+\.\d+\.\d+$/.test(tag) || !/^[a-f0-9]{40}$/.test(sha) || manifest.backend.tag !== tag || manifest.backend.commit !== sha || tag !== 'v' + manifest.backend.version) throw Error('已审查清单与明确 tag/SHA 不匹配。');
    return { root, operation, manifest };
  }
  if (args.length !== 3 || !/^[a-f0-9]{64}$/.test(target)) throw Error('激活或回退必须提供精确的完整组合 SHA-256 标识。');
  return { root, operation: operation as 'activate' | 'rollback', versionId: target };
}
export function claimComfyMaintenance(request: ComfyMaintenanceRequest) {
  const root = ensureProjectDirectory(request.root);
  if (!existsSync(insideProject(root, join(root, '.mixcat/state/workflow.sqlite')))) throw Error('维护命令只接受已存在的 Mixcat 项目。');
  const store = new ProjectStore(root); let release: (() => void) | undefined;
  const releaseRuntime = () => { const owned = release; if (owned) { release = undefined; owned(); } };
  try {
    store.claim(); const state = store.read({ recover: false });
    if (!state || state.project.template !== 'comfyui') throw Error('维护命令只接受已存在的 ComfyUI 项目。');
    if (state.project.unavailable || !['idle', 'paused', 'completed'].includes(state.project.status) || state.tasks.some(task => !['completed', 'failed', 'cancelled', 'paused'].includes(task.status))) throw Error('项目有活动或待核对的工作，请先在 Mixcat 中安全暂停或完成。');
    release = lifecycleLease(root);
    const comfy = new ComfyStore(root, state.project.id); let target: RuntimeCombination | undefined;
    try {
      if (comfy.recoverableEdits().length || comfy.activeRuns().some(run => run.waiting !== false || ['submitting', 'submission_unknown'].includes(run.status)) || comfy.providerJobs().some(job => !['succeeded', 'failed', 'cancelled'].includes(job.status) && (job.waiting || job.submissionUncertain || ['submitting', 'submission_unknown', 'cancel_requested', 'needs_reconciliation'].includes(job.status)))) throw Error('Comfy 有活动或受理不明的任务，维护未开始。');
      if (request.operation !== 'prepare') {
        const versionId = request.versionId;
        if (request.operation === 'activate' && !comfy.runtimeRecord<RuntimeCandidate[]>('candidates')?.some(candidate => candidate.selection.versionId === versionId && candidate.qualifiedAt)) throw Error('指定完整组合没有已验证的候选。');
        if (request.operation === 'rollback' && !comfy.runtimeRecord<RuntimeSelection>('checkpoint:' + versionId)?.workspace) throw Error('指定完整组合没有兼容回退检查点。');
        target = comfy.runtimeRecord<RuntimeCombination>('combination:' + versionId); if (!target) throw Error('完整组合记录不存在。'); verifyCombination(root, target);
      }
    } finally { comfy.close(); }
    let closed = false;
    return { store, project: { ...state.project, root }, target, releaseRuntime, close() { if (!closed) { closed = true; releaseRuntime(); store.close(); } } };
  } catch (error) { releaseRuntime(); store.close(); throw error; }
}
