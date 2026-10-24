import { collaborationFixture } from './collaboration-fixture.js';

export async function reviewFixture(t: Parameters<typeof collaborationFixture>[0]) {
  const f = await collaborationFixture(t);
  for (const node of [...f.state.nodes]) await f.engine.command({ type: 'save_node', projectId: f.projectId, node: { ...node, tools: [...node.tools, 'request_review', 'get_review'] } });
  const policy = () => f.engine.command({ type: 'save_review_policy', projectId: f.projectId, policy: { revision: f.state.reviewPolicy.revision, checkpoints: [{ id: 'direction', name: '方向', ownerNodeId: 'plan', requiredForNodeIds: ['implement'], dependsOn: [], revision: 1 }] } });
  const submit = (id = 'r1', attachments: any[] = []) => f.invoke('plan', 'request_review', { request_id: id, checkpoint_id: 'direction', title: '方向', content: { body: id }, attachments }, id);
  const approve = (index = 0) => { const r = f.state.humanReviews[index]; return f.engine.command({ type: 'decide_review', projectId: f.projectId, reviewId: r.id, version: r.version, bundleHash: r.bundleHash, decision: 'approved', comment: ' original ' }, `approve-${r.id}`); };
  const turns = () => f.clients.flatMap(c => c.calls).filter(c => c.method === 'turn/start');
  return { ...f, policy, submit, approve, turns };
}
