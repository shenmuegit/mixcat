import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectStore } from '../src/core/store.js';
import { WorkflowEngine } from '../src/core/engine.js';
import { collaborationFixture } from './collaboration-fixture.js';
import { deferred } from './runtime-fixture.js';

async function editingFixture(t: Parameters<typeof collaborationFixture>[0]) {
  const f = await collaborationFixture(t);
  await f.active('plan');
  const rpc = f.clients[0].port.rpc.bind(f.clients[0].port);
  f.clients[0].port.rpc = async (method, params) => {
    if (method === 'model/list') return { data: [{ model: 'fixture-model', displayName: 'Fixture' }], nextCursor: null };
    if (method === 'skills/list') return { data: [{ cwd: f.root, errors: [], skills: [{ name: 'fixture', path: `${f.root}/SKILL.md`, enabled: true }] }] };
    if (method === 'plugin/installed') return { marketplaces: [{ plugins: [{ id: 'test@local', name: 'Fixture plugin', installed: true, enabled: true }] }] };
    return rpc(method, params);
  };
  const node = { ...f.state.nodes.find(n => n.id === 'implement')!, id: 'new-node', revision: 0 };
  const request = { operation: 'save_node', request_id: 'edit-one', node, related_to: 'plan', condition: '需要协作时' };
  return { ...f, request };
}

test('versioned workflow node, initial edge and receipt commit together and replay durably', async t => {
  const f = await editingFixture(t);
  const before = structuredClone(f.state), restore = f.rejectSave();
  try {
    await assert.rejects(f.invoke('plan', 'update_workflow', f.request, 'edit-call'), /fixture SQLite rejection/);
    assert.deepEqual(f.state, before);
    const disk = new ProjectStore(f.root);
    try { const saved = disk.read()!; assert.deepEqual(saved.nodes, before.nodes); assert.deepEqual(saved.edges, before.edges); assert.deepEqual(saved.workflowReceipts, []); } finally { disk.close(); }
  } finally { restore(); }
  const receipt = await f.invoke('plan', 'update_workflow', f.request, 'edit-call');
  assert.equal(receipt.accepted, true); assert.equal(receipt.node.id, f.request.node.id); assert.equal(receipt.node.revision, 1);
  assert.equal(receipt.node.threads, undefined); assert.equal(f.state.edges.length, 1); assert.equal(f.state.workflowReceipts.length, 1);
  const original = f.context('plan', 'original', f.state.tasks[0]);
  f.finish(f.state.tasks[0]);
  assert.deepEqual(await f.invoke('plan', 'update_workflow', f.request, 'replayed', f.context('plan', 'replayed', f.state.tasks[0])), receipt);
  await f.active('plan');
  assert.deepEqual(await f.invoke('plan', 'update_workflow', f.request, 'continued'), receipt);
  const disk = new ProjectStore(f.root);
  try { assert.deepEqual(disk.read()!.workflowReceipts[0].receipt, receipt); } finally { disk.close(); }
  assert.equal(f.state.nodes.filter(n => n.id === f.request.node.id).length, 1); assert.equal(f.state.edges.length, 1);
  for (const [request, call] of [[{ ...f.request, node: { ...f.request.node, name: 'Changed' } }, 'changed'], [{ ...f.request, request_id: 'replacement' }, 'edit-call']] as const) {
    const body = await f.raw('plan', 'update_workflow', request, call, call === 'edit-call' ? f.context('plan', call, f.state.tasks[0]) : undefined);
    assert.equal(body.result.structuredContent.error.code, 'REQUEST_CONFLICT');
  }
  await f.engine.close();
  const restored = new WorkflowEngine({ workbenchRoot: f.root, executable: 'unused', nativeFactory() { assert.fail('replay must not connect'); } });
  try {
    await restored.init();
    const context = { ...original, identity: restored.nodeIdentity(f.projectId, 'plan') };
    assert.deepEqual(await restored.invokeTool('update_workflow', f.request, context), receipt);
    await assert.rejects(restored.invokeTool('update_workflow', f.request, { ...context, turnId: 'forged' }), /身份|执行/);
  } finally { await restored.close(); }
});

test('delegation compares added tools, preserves prior workflow grants and keeps legacy behavior', async t => {
  const f = await collaborationFixture(t);
  const target = f.state.nodes.find(node => node.id === 'review')!;
  await f.engine.command({ type: 'save_node', projectId: f.projectId, node: { ...target, tools: [...target.tools, 'update_workflow', 'read_history'] } });
  await f.active('plan');
  const granted = f.state.nodes.find(node => node.id === 'review')!;
  const retained = await f.invoke('plan', 'update_workflow', { operation: 'save_node', request_id: 'retained', node: { ...granted, name: 'Retained grants' } }, 'retained');
  assert.deepEqual(retained.node.tools, granted.tools);
  const fresh = { ...f.state.nodes.find(node => node.id === 'implement')!, id: 'fresh', revision: 0, tools: ['get_project_context'] };
  for (const tools of [['update_workflow'], ['read_history']]) {
    const body = await f.raw('plan', 'update_workflow', { operation: 'save_node', request_id: `deny-${tools[0]}`, node: { ...fresh, tools } }, `deny-${tools[0]}`);
    assert.equal(body.result.structuredContent.error.code, 'PERMISSION_DENIED');
  }
  const existing = f.state.nodes.find(node => node.id === 'implement')!;
  const expanded = await f.raw('plan', 'update_workflow', { operation: 'save_node', request_id: 'expanded', node: { ...existing, tools: [...existing.tools, 'read_history'] } }, 'expanded');
  assert.equal(expanded.result.structuredContent.error.code, 'PERMISSION_DENIED');
  const own = await f.raw('plan', 'update_workflow', { operation: 'save_node', request_id: 'self', node: { ...f.state.nodes[0], tools: [...f.state.nodes[0].tools, 'read_history'] } }, 'self');
  assert.equal(own.result.isError, true);
  const delegated = await f.invoke('plan', 'update_workflow', { operation: 'save_node', request_id: 'delegated', node: { ...fresh, tools: ['send_message', 'get_delivery'] } }, 'delegated');
  assert.deepEqual(delegated.node.tools, ['send_message', 'get_delivery']);
  const legacy = await f.invoke('plan', 'update_workflow', { node: { ...fresh, id: 'legacy', tools: ['get_project_context', 'handoff', 'complete_task'] } }, 'legacy');
  assert.deepEqual(legacy, { nodeId: 'legacy', revision: 1 });
  for (const tools of [['update_workflow'], ['send_message'], ['get_delivery'], ['read_history']]) {
    const body = await f.raw('plan', 'update_workflow', { node: { ...fresh, id: `legacy-${tools[0]}`, tools } }, `legacy-${tools[0]}`);
    assert.equal(body.result.isError, true); assert.equal(body.result.structuredContent, undefined);
  }
  const oldRetain = await f.raw('plan', 'update_workflow', { node: { ...f.state.nodes.find(node => node.id === 'review')!, tools: ['update_workflow'] } }, 'old-retain');
  assert.equal(oldRetain.result.isError, true);
});

test('real capability selections are checked per source and parallel requests replay after discovery', async t => {
  const f = await editingFixture(t);
  const node = { ...f.request.node, model: 'fixture-model', skills: [{ name: 'fixture', path: `${f.root}/SKILL.md` }], plugins: [{ name: 'Fixture plugin', id: 'test@local' }] };
  const request = { ...f.request, node };
  const receipts = await Promise.all(Array.from({ length: 5 }, (_, i) => f.invoke('plan', 'update_workflow', request, `parallel-${i}`)));
  for (const receipt of receipts) assert.deepEqual(receipt, receipts[0]);
  assert.equal(f.state.workflowReceipts.length, 1); assert.equal(f.state.edges.length, 1);
  for (const [key, value] of [['model', 'invented'], ['skills', [{ name: 'forged', path: `${f.root}/invented/SKILL.md` }]], ['plugins', [{ name: 'forged', id: 'invented@local' }]]] as const) {
    const before = structuredClone(f.state);
    const body = await f.raw('plan', 'update_workflow', { ...request, request_id: `invalid-${key}`, node: { ...node, id: `invalid-${key}`, [key]: value } }, `invalid-${key}`);
    assert.equal(body.result.isError, true); assert.match(body.result.content[0].text, /真实能力目录/);
    assert.deepEqual(f.state, before);
  }
  const rpc = f.clients[0].port.rpc.bind(f.clients[0].port);
  f.clients[0].port.rpc = async (method, params) => { if (method === 'plugin/installed') throw new Error('fixture plugin catalog offline'); return rpc(method, params); };
  const partial = await f.invoke('plan', 'update_workflow', { ...f.request, request_id: 'partial', node: { ...f.request.node, id: 'partial', model: 'fixture-model' } }, 'partial');
  assert.equal(partial.node.model, 'fixture-model');
  const unavailable = await f.raw('plan', 'update_workflow', { ...f.request, request_id: 'offline', node: { ...f.request.node, id: 'offline', plugins: node.plugins } }, 'offline');
  assert.match(unavailable.result.content[0].text, /fixture plugin catalog offline/);
  f.clients[0].port.rpc = async () => { throw new Error('discovery not needed'); };
  const defaults = await f.invoke('plan', 'update_workflow', { ...f.request, request_id: 'default', node: { ...f.request.node, id: 'default', model: null, skills: [], plugins: [] } }, 'default');
  assert.equal(defaults.node.model, null);
});

test('catalog waits recheck source control, identity, target revision and selected endpoints', async t => {
  for (const mutation of ['revision', 'pause', 'deleted-target', 'deleted-related', 'revoked-identity'] as const) await t.test(mutation, async t => {
    const f = await editingFixture(t), gate = deferred(), entered = deferred();
    const target = f.state.nodes.find(node => node.id === 'implement')!;
    const node = mutation === 'deleted-related' ? { ...f.request.node, model: 'fixture-model' } : { ...target, model: 'fixture-model' };
    const request = { operation: 'save_node', request_id: 'waiting', node, ...(mutation === 'deleted-related' ? { related_to: 'review' } : {}) };
    const rpc = f.clients[0].port.rpc.bind(f.clients[0].port);
    f.clients[0].port.rpc = async (method, params) => { if (method === 'model/list') { entered.resolve(); await gate.promise; } return rpc(method, params); };
    const pending = f.raw('plan', 'update_workflow', request, 'waiting');
    await entered.promise;
    if (mutation === 'revision') await f.engine.command({ type: 'save_node', projectId: f.projectId, node: { ...target, name: 'User edit' } });
    if (mutation === 'pause') await f.engine.command({ type: 'pause_node', projectId: f.projectId, nodeId: 'plan' });
    if (mutation === 'deleted-target' || mutation === 'deleted-related') await f.engine.command({ type: 'delete_node', projectId: f.projectId, nodeId: mutation === 'deleted-target' ? 'implement' : 'review' });
    if (mutation === 'revoked-identity') (f.engine as any).revoke(f.projectId, 'plan');
    const before = structuredClone(f.state); gate.resolve();
    const body = await pending;
    assert.equal(body.result.isError, true);
    if (mutation === 'revision') assert.equal(body.result.structuredContent.error.code, 'REVISION_CONFLICT');
    if (mutation === 'pause') assert.equal(body.result.structuredContent.error.code, 'SOURCE_NOT_ACTIVE');
    if (mutation === 'deleted-target' || mutation === 'deleted-related') assert.equal(body.result.structuredContent.error.code, 'TARGET_UNAVAILABLE');
    if (mutation === 'revoked-identity') assert.equal(body.result.structuredContent.error.code, 'PERMISSION_DENIED');
    assert.deepEqual(f.state, before); assert.equal(f.state.workflowReceipts.length, 0);
  });
});

test('busy and queued recipients keep their accepted configuration snapshots', async t => {
  const f = await editingFixture(t);
  await f.engine.command({ type: 'pause_node', projectId: f.projectId, nodeId: 'implement' });
  const receipt = await f.invoke('plan', 'send_message', { request_id: 'message', to_node_id: 'implement', content: false, reason: 'preserve config' }, 'message');
  const task = f.state.tasks.find(task => task.id === receipt.target_task_id)!;
  const accepted = structuredClone(task.nodeSnapshot);
  for (const status of ['queued', 'needs_reconciliation', 'running', 'paused', 'waiting_source'] as const) {
    task.status = status;
    const body = await f.raw('plan', 'update_workflow', { operation: 'save_node', request_id: `busy-${status}`, node: { ...f.state.nodes.find(node => node.id === 'implement')!, name: 'Changed' } }, `busy-${status}`);
    assert.equal(body.result.structuredContent.error.code, 'TARGET_UNAVAILABLE');
    assert.deepEqual(task.nodeSnapshot, accepted);
  }
  task.status = 'queued';
  await f.invoke('plan', 'update_workflow', { ...f.request, request_id: 'unrelated' }, 'unrelated');
  assert.deepEqual(f.state.tasks.find(task => task.id === receipt.target_task_id)!.nodeSnapshot, accepted);
});

test('versioned edge edits return actual revisions, reject stale writes and have separate message keys', async t => {
  const f = await editingFixture(t);
  const edge = { id: 'edge-one', sourceNodeId: 'plan', targetNodeId: 'review', condition: '自然语言\n条件', revision: 0 };
  const request = { operation: 'save_edge', request_id: 'shared-key', edge };
  const receipt = await f.invoke('plan', 'update_workflow', request, 'edge-call');
  assert.deepEqual(receipt.edge, { ...edge, revision: 1 });
  assert.deepEqual(await f.invoke('plan', 'update_workflow', request, 'edge-replay'), receipt);
  const stale = await f.raw('plan', 'update_workflow', { ...request, request_id: 'stale' }, 'stale-call');
  assert.equal(stale.result.structuredContent.error.code, 'REVISION_CONFLICT');
  await f.invoke('plan', 'send_message', { request_id: 'shared-key', to_node_id: 'review', content: null, reason: 'check' }, 'message-call');
  assert.equal(f.state.messages.length, 1); assert.equal(f.state.workflowReceipts.length, 1);
});
