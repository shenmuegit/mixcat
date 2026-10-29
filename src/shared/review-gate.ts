import type { HumanReviewPolicy, HumanReviewView, ReviewCheckpoint, ReviewDependency } from './types.js';
import { itemMaterialMatches, type ManagementState } from './project-items.js';

type ReviewState = { reviewPolicy: HumanReviewPolicy; humanReviews: HumanReviewView[]; management?: ManagementState };

function latestReview(state: ReviewState, checkpointId: string): HumanReviewView | undefined {
  return state.humanReviews.filter(item => item.checkpointId === checkpointId).reduce<HumanReviewView | undefined>((latest, item) => !latest || item.version > latest.version ? item : latest, undefined);
}
export function reviewDependencies(state: ReviewState, nodeId: string): ReviewDependency[] {
  const ids = new Set<string>();
  function include(point: ReviewCheckpoint) {
    if (ids.has(point.id)) return;
    ids.add(point.id);
    for (const id of point.dependsOn) { const upstream = state.reviewPolicy.checkpoints.find(item => item.id === id); if (upstream) include(upstream); }
  }
  for (const point of state.reviewPolicy.checkpoints) if (point.requiredForNodeIds.includes(nodeId)) include(point);
  const dependencies = state.reviewPolicy.checkpoints.filter(point => ids.has(point.id)).map(point => {
    const latest = latestReview(state, point.id), current = latest?.checkpointRevision === point.revision ? latest : undefined;
    return { checkpointId: point.id, checkpointRevision: point.revision, reviewId: current?.id ?? null, version: current?.version ?? null };
  });
  for (const question of state.humanReviews.filter(item => item.kind === 'question' && item.nodeId === nodeId && item.status === 'pending'))
    dependencies.push({ checkpointId: question.checkpointId, checkpointRevision: question.checkpointRevision, reviewId: question.id, version: question.version });
  return dependencies;
}

export function reviewGate(state: ReviewState, dependencies: ReviewDependency[]): { state: 'ready' | 'waiting' | 'stale'; checkpointIds: string[] } {
  const waiting = new Set<string>(), stale = new Set<string>();
  function check(dependency: ReviewDependency, path: Set<string>) {
    const { checkpointId, checkpointRevision, reviewId, version } = dependency;
    const item = state.humanReviews.find(item => item.id === reviewId), current = latestReview(state, checkpointId);
    const point = state.reviewPolicy.checkpoints.find(item => item.id === checkpointId);
    if ((item?.kind !== 'question' && (!point || point.revision !== checkpointRevision)) || path.has(checkpointId)) { stale.add(checkpointId); return; }
    if (reviewId === null && version === null) { waiting.add(checkpointId); return; }
    if (!item || item.checkpointId !== checkpointId || item.checkpointRevision !== checkpointRevision || item.version !== version || item.supersededBy || item.status === 'superseded' || current?.id !== item.id) { stale.add(checkpointId); return; }
    if (item.itemMaterials?.length && !(state.management ? item.itemMaterials.every(material => itemMaterialMatches(state.management!.items.find(entry => entry.id === material.id), material)) : item.materialsCurrent === true)) { stale.add(checkpointId); return; }
    const decision = item.decision;
    if (item.status !== 'approved' || !decision || decision.decision !== 'approved' || decision.reviewId !== item.id || decision.version !== item.version || decision.bundleHash !== item.bundleHash) waiting.add(checkpointId);
    const nextPath = new Set(path).add(checkpointId);
    for (const upstream of item.upstreamDependencies) check(upstream, nextPath);
    for (const id of point?.dependsOn ?? []) if (!item.upstreamDependencies.some(upstream => upstream.checkpointId === id)) stale.add(id);
  }
  for (const dependency of dependencies) check(dependency, new Set());
  return { state: stale.size ? 'stale' : waiting.size ? 'waiting' : 'ready', checkpointIds: [...new Set([...stale, ...waiting])] };
}
