import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkflowEngine } from '../src/core/engine.js';
import { ProjectStore } from '../src/core/store.js';
import { projectDirectory } from '../src/core/paths.js';
import type { WorkflowGroup } from '../src/shared/types.js';
import { fixture } from './runtime-fixture.js';
import { collaborationFixture } from './collaboration-fixture.js';

test('saving and editing a workflow group survives reopen without replacing its nodes', async t => {
  const f = await fixture(t);
  const before = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!;
  assert.deepEqual(before.groups, []);
  const group: WorkflowGroup = { id: 'definition', name: '产品定义', nodeIds: ['plan', 'implement'], coordinatorNodeId: 'plan', revision: 0 };
  const saved = (await f.engine.command({ type: 'save_group', projectId: f.projectId, group })).snapshot.selected!;
  assert.deepEqual(saved.groups, [{ ...group, revision: 1 }]);
  const edited = (await f.engine.command({ type: 'save_group', projectId: f.projectId, group: { ...saved.groups![0], name: '需求定义', nodeIds: ['plan', 'review'] } })).snapshot.selected!;
  assert.deepEqual(edited.groups, [{ ...group, name: '需求定义', nodeIds: ['plan', 'review'], revision: 2 }]);
  assert.deepEqual(edited.nodes, before.nodes);
  await f.engine.close();
  const reopened = new WorkflowEngine({ workbenchRoot: f.root, executable: 'unused' });
  t.after(() => reopened.close()); await reopened.init();
  const restored = (await reopened.command({ type: 'snapshot', projectId: f.projectId })).snapshot.selected!;
  assert.deepEqual(restored.groups, edited.groups);
  assert.deepEqual(restored.nodes, before.nodes.map(node => ({ ...node, model: node.model ?? null, skills: node.skills ?? [], plugins: node.plugins ?? [] })));
});

test('member deletion updates membership and coordinator deletion requires reassignment or ungrouping', async t => {
  const f = await fixture(t);
  const group: WorkflowGroup = { id: 'definition', name: '产品定义', nodeIds: ['plan', 'implement'], coordinatorNodeId: 'plan', revision: 0 };
  await f.engine.command({ type: 'save_group', projectId: f.projectId, group });
  await f.engine.command({ type: 'save_edge', projectId: f.projectId, edge: { id: 'delivery', sourceNodeId: 'plan', targetNodeId: 'review', condition: '统一交付', revision: 0 } });
  await assert.rejects(f.engine.command({ type: 'delete_node', projectId: f.projectId, nodeId: 'plan' }), /协调节点/);
  const removed = (await f.engine.command({ type: 'delete_node', projectId: f.projectId, nodeId: 'implement' })).snapshot.selected!;
  assert.deepEqual(removed.groups, [{ ...group, nodeIds: ['plan'], revision: 2 }]);
  assert.equal(removed.archivedNodes!.find(node => node.id === 'implement')!.name, '执行');
  await assert.rejects(f.engine.command({ type: 'delete_group', projectId: f.projectId, groupId: group.id, revision: 1 }), { code: 'REVISION_CONFLICT' });
  const ungrouped = (await f.engine.command({ type: 'delete_group', projectId: f.projectId, groupId: group.id, revision: 2 })).snapshot.selected!;
  assert.deepEqual(ungrouped.groups, []);
  assert.deepEqual(ungrouped.nodes, removed.nodes);
  assert.deepEqual(ungrouped.edges, removed.edges);
  assert.deepEqual(ungrouped.archivedNodes, removed.archivedNodes);
  await f.engine.command({ type: 'delete_node', projectId: f.projectId, nodeId: 'plan' });
});

test('group MCP edits replay durably and context identifies the coordinator without changing native sessions', async t => {
  const f = await collaborationFixture(t);
  const source = await f.active('plan');
  const before = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!;
  const identity = f.engine.nodeIdentity(f.projectId, 'plan');
  const group: WorkflowGroup = { id: 'definition', name: '产品定义', nodeIds: ['plan', 'implement'], coordinatorNodeId: 'plan', revision: 0 };
  const request = { operation: 'save_group', request_id: 'group-save', group };
  const original = f.context('plan', 'save', source);
  const restore = f.rejectSave();
  try {
    const failed = await f.raw('plan', 'update_workflow', request, 'save');
    assert.equal(failed.result.structuredContent.error.code, 'STORAGE_UNAVAILABLE');
    assert.deepEqual((await f.engine.command({ type: 'snapshot' })).snapshot.selected!, before);
  } finally { restore(); }
  const receipt = await f.invoke('plan', 'update_workflow', request, 'save');
  assert.deepEqual(receipt, { accepted: true, operation: 'save_group', request_id: 'group-save', group: { ...group, revision: 1 } });
  assert.deepEqual(await f.invoke('plan', 'update_workflow', request, 'replay'), receipt);
  const context = await f.invoke('plan', 'get_project_context', {}, 'context');
  assert.deepEqual(context.groups, [receipt.group]);
  assert.deepEqual(context.self_group, { ...receipt.group, coordinator: { id: 'plan', name: '规划' }, isCoordinator: true });
  const memberContext = await f.invoke('implement', 'get_project_context', {}, 'member-context');
  assert.deepEqual(memberContext.self_group, { ...receipt.group, coordinator: { id: 'plan', name: '规划' }, isCoordinator: false });
  assert.equal((await f.invoke('review', 'get_project_context', {}, 'outside-context')).self_group, null);
  const denied = await f.raw('review', 'update_workflow', request, 'denied');
  assert.equal(denied.result.structuredContent.error.code, 'PERMISSION_DENIED');
  assert.equal(f.engine.nodeIdentity(f.projectId, 'plan'), identity);
  const after = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!;
  assert.deepEqual(after.nodes, before.nodes);
  assert.deepEqual(after.tasks, before.tasks);
  assert.deepEqual(after.conversation, before.conversation);
  const stale = await f.raw('plan', 'update_workflow', { ...request, request_id: 'group-stale' }, 'stale');
  assert.equal(stale.result.structuredContent.error.code, 'REVISION_CONFLICT');
  const conflict = await f.raw('plan', 'update_workflow', { ...request, group: { ...group, name: 'Changed' } }, 'conflict');
  assert.equal(conflict.result.structuredContent.error.code, 'REQUEST_CONFLICT');
  const deletion = { operation: 'delete_group', request_id: 'group-delete', groupId: group.id, revision: 1 };
  const invalid = await f.raw('plan', 'update_workflow', { ...deletion, revision: 0 }, 'invalid-delete');
  assert.equal(invalid.result.structuredContent.error.code, -32602);
  const deleted = await f.invoke('plan', 'update_workflow', deletion, 'delete');
  assert.deepEqual(deleted, { accepted: true, operation: 'delete_group', request_id: 'group-delete', groupId: group.id, revision: 1 });
  assert.deepEqual(await f.invoke('plan', 'update_workflow', deletion, 'delete-replay'), deleted);
  assert.deepEqual(await f.invoke('plan', 'update_workflow', request, 'save-after-delete'), receipt);
  assert.deepEqual((await f.engine.command({ type: 'snapshot' })).snapshot.selected!.groups, []);
  f.finish(source);
  const inactive = await f.raw('plan', 'update_workflow', { ...request, request_id: 'inactive' }, 'inactive', f.context('plan', 'inactive', source));
  assert.equal(inactive.result.structuredContent.error.code, 'SOURCE_NOT_ACTIVE');
  await f.engine.close();
  const reopened = new WorkflowEngine({ workbenchRoot: f.root, executable: 'unused', nativeFactory() { assert.fail('receipt replay must not connect'); } });
  t.after(() => reopened.close()); await reopened.init();
  assert.deepEqual(await reopened.invokeTool('update_workflow', request, { ...original, identity: reopened.nodeIdentity(f.projectId, 'plan') }), receipt);
  assert.deepEqual((await reopened.command({ type: 'snapshot', projectId: f.projectId })).snapshot.selected!.groups, []);
});

test('new Web projects persist the template group without rebuilding existing workflows on retry', async t => {
  const f = await fixture(t, undefined, 'web-product');
  const before = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!;
  assert.deepEqual(before.groups, [{ id: 'product-definition', name: '产品定义', nodeIds: ['product', 'requirements', 'design', 'design-test'], coordinatorNodeId: 'product', revision: 1 }]);
  await f.engine.command({ type: 'delete_group', projectId: f.projectId, groupId: 'product-definition', revision: 1 });
  const retried = (await f.engine.command({ type: 'create_project', root: f.root, name: 'Retry', goal: 'Retry', template: 'web-product' })).snapshot.selected!;
  assert.deepEqual(retried.groups, []);
  assert.deepEqual(retried.nodes, before.nodes);
  assert.deepEqual(retried.edges, before.edges);
});

test('group validation rejects stale, overlapping, duplicate and foreign members atomically', async t => {
  const f = await fixture(t);
  const group: WorkflowGroup = { id: 'definition', name: '产品定义', nodeIds: ['plan', 'implement'], coordinatorNodeId: 'plan', revision: 0 };
  await f.engine.command({ type: 'save_group', projectId: f.projectId, group });
  const foreign = (await f.engine.command({ type: 'create_project', root: projectDirectory(f.root, 'foreign'), name: 'Foreign', goal: 'Other project' })).snapshot.selected!;
  await f.engine.command({ type: 'save_node', projectId: foreign.project.id, node: { ...foreign.nodes[0], id: 'foreign-only', revision: 0 } });
  const before = (await f.engine.command({ type: 'snapshot', projectId: f.projectId })).snapshot.selected!;
  for (const invalid of [
    group,
    { ...group, id: 'new', revision: 1 },
    { ...group, revision: -1 },
    { ...group, revision: 1.5 },
    { ...group, revision: 1, nodeIds: [] },
    { ...group, revision: 1, nodeIds: ['plan', 'plan'] },
    { ...group, revision: 1, nodeIds: ['plan', 'foreign-only'] },
    { ...group, revision: 1, coordinatorNodeId: 'review' },
    { ...group, revision: 1, name: ' ' },
    { ...group, id: 'overlap', nodeIds: ['implement', 'review'], coordinatorNodeId: 'review' },
  ]) {
    await assert.rejects(f.engine.command({ type: 'save_group', projectId: f.projectId, group: invalid }));
    assert.deepEqual((await f.engine.command({ type: 'snapshot', projectId: f.projectId })).snapshot.selected!, before);
  }
  await f.engine.command({ type: 'save_group', projectId: f.projectId, group: { ...group, coordinatorNodeId: 'implement', revision: 1 } });
  const removed = (await f.engine.command({ type: 'delete_node', projectId: f.projectId, nodeId: 'plan' })).snapshot.selected!;
  assert.deepEqual(removed.groups, [{ ...group, nodeIds: ['implement'], coordinatorNodeId: 'implement', revision: 3 }]);
  await assert.rejects(f.engine.command({ type: 'save_group', projectId: f.projectId, group: { ...group, revision: 3 } }), /有效节点/);
});

test('failed group saves, removals and member deletions publish no partial changes', async t => {
  const f = await fixture(t);
  const group: WorkflowGroup = { id: 'definition', name: '产品定义', nodeIds: ['plan', 'implement'], coordinatorNodeId: 'plan', revision: 0 };
  await f.engine.command({ type: 'save_group', projectId: f.projectId, group });
  const before = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!;
  const failure = t.mock.method(ProjectStore.prototype, 'save', () => { throw new Error('fixture group commit failure'); });
  try {
    await assert.rejects(f.engine.command({ type: 'save_group', projectId: f.projectId, group: { ...group, name: 'Changed', revision: 1 } }), /fixture group commit failure/);
    await assert.rejects(f.engine.command({ type: 'delete_group', projectId: f.projectId, groupId: group.id, revision: 1 }), /fixture group commit failure/);
    await assert.rejects(f.engine.command({ type: 'delete_node', projectId: f.projectId, nodeId: 'implement' }), /fixture group commit failure/);
    assert.deepEqual((await f.engine.command({ type: 'snapshot' })).snapshot.selected!, before);
  } finally { failure.mock.restore(); }
  await f.engine.command({ type: 'delete_node', projectId: f.projectId, nodeId: 'implement' });
  await f.engine.close();
  const reopened = new WorkflowEngine({ workbenchRoot: f.root, executable: 'unused' });
  t.after(() => reopened.close()); await reopened.init();
  const restored = (await reopened.command({ type: 'snapshot', projectId: f.projectId })).snapshot.selected!;
  assert.deepEqual(restored.groups, [{ ...group, nodeIds: ['plan'], revision: 2 }]);
  assert.equal(restored.nodes.some(node => node.id === 'implement'), false);
});

test('deleting a finished group member retains its native thread, task and conversation history', async t => {
  const f = await collaborationFixture(t);
  const task = await f.active('implement'); f.finish(task);
  const group: WorkflowGroup = { id: 'definition', name: '产品定义', nodeIds: ['plan', 'implement'], coordinatorNodeId: 'plan', revision: 0 };
  await f.engine.command({ type: 'save_group', projectId: f.projectId, group });
  const before = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!;
  const deleted = (await f.engine.command({ type: 'delete_node', projectId: f.projectId, nodeId: 'implement' })).snapshot.selected!;
  assert.equal(deleted.archivedNodes!.find(node => node.id === 'implement')!.threadId, task.threadId);
  assert.deepEqual(deleted.tasks, before.tasks);
  assert.deepEqual(deleted.conversation, before.conversation);
  assert.deepEqual(deleted.groups, [{ ...group, nodeIds: ['plan'], revision: 2 }]);
});

test('legacy Web projects missing groups reopen with an empty group list', async t => {
  const f = await fixture(t, undefined, 'web-product');
  const before = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!;
  await f.engine.close();
  const store = new ProjectStore(f.root);
  try { const legacy = store.read()!; delete legacy.groups; store.save(legacy); } finally { store.close(); }
  const reopened = new WorkflowEngine({ workbenchRoot: f.root, executable: 'unused' });
  t.after(() => reopened.close()); await reopened.init();
  const restored = (await reopened.command({ type: 'snapshot', projectId: f.projectId })).snapshot.selected!;
  assert.deepEqual(restored.groups, []);
  assert.deepEqual(restored.nodes, before.nodes.map(node => ({ ...node, skills: node.skills ?? [], plugins: node.plugins ?? [] })));
  assert.deepEqual(restored.edges, before.edges);
});
