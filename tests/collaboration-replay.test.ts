import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowEngine } from '../src/core/engine.js';
import { ProjectStore } from '../src/core/store.js';
import { collaborationFixture } from './collaboration-fixture.js';
import type { McpCallContext } from '../src/shared/types.js';

for (const tool of ['send_message', 'update_workflow'] as const) {
  const request = (id: string): Record<string, unknown> => tool === 'send_message'
    ? { request_id: id, to_node_id: 'implement', content: { exact: [null, false, 0, ''] }, reason: 'binding' }
    : { operation: 'save_edge', request_id: id, edge: { id: `edge-${id}`, sourceNodeId: 'plan', targetNodeId: 'implement', condition: 'binding', revision: 0 } };
  const facts = (f: Awaited<ReturnType<typeof collaborationFixture>>) => ({ tasks: f.state.tasks.length, messages: f.state.messages.length, edges: f.state.edges.length, receipts: f.state.workflowReceipts.length });

  test(`${tool}: every concurrent replay call is bound before success, even to another existing request`, async t => {
    const f = await collaborationFixture(t); await f.active('plan');
    await f.engine.command({ type: 'pause_node', projectId: f.projectId, nodeId: 'implement' });
    const receipt = await f.invoke('plan', tool, request('R'), 'A');
    await f.invoke('plan', tool, request('S'), 'S');
    const before = facts(f), originalState = structuredClone(f.state);
    for (const replay of await Promise.all(['B', 'C', 'D', 'B'].map(call => f.invoke('plan', tool, request('R'), call)))) assert.deepEqual(replay, receipt);
    for (const key of ['tasks', 'nodes', 'conversation', 'edges', 'runId', 'stopRequested'] as const) assert.deepEqual(f.state[key], originalState[key]);
    const stored = tool === 'send_message' ? f.state.messages[0] : f.state.workflowReceipts[0];
    assert.equal(stored.replayCalls?.length, 3, 'concurrent duplicate replay binds once');
    for (const call of ['B', 'C', 'D']) for (const id of ['new', 'S']) {
      const response = await f.raw('plan', tool, request(id), call);
      assert.equal(response.result.structuredContent.error?.code, 'REQUEST_CONFLICT');
    }
    assert.deepEqual(facts(f), before);
    const release = f.rejectSave();
    try { assert.deepEqual(await f.invoke('plan', tool, request('R'), 'B'), receipt, 'already bound replay needs no further write'); } finally { release(); }
    await f.invoke('plan', tool, request('intentional'), 'intentional');
    assert.equal(tool === 'send_message' ? f.state.messages.length : f.state.workflowReceipts.length, 3);
  });

  test(`${tool}: failed binding save changes neither accepted facts nor call ownership`, async t => {
    const f = await collaborationFixture(t); await f.active('plan');
    await f.engine.command({ type: 'pause_node', projectId: f.projectId, nodeId: 'implement' });
    const receipt = await f.invoke('plan', tool, request('R'), 'A');
    const before = structuredClone(f.state), disk = f.store.db.prepare('SELECT body FROM project_state').get()!.body;
    const release = f.rejectSave();
    try {
      const response = await f.raw('plan', tool, request('R'), 'B');
      assert.equal(response.result.structuredContent.error?.code, 'STORAGE_UNAVAILABLE');
      assert.deepEqual(f.state, before); assert.equal(f.store.db.prepare('SELECT body FROM project_state').get()!.body, disk);
      assert.deepEqual(await f.invoke('plan', tool, request('R'), 'A'), receipt);
    } finally { release(); }
    await f.invoke('plan', tool, request('S'), 'B');
    assert.deepEqual(await f.invoke('plan', tool, request('R'), 'C'), receipt);
    assert.equal((await f.raw('plan', tool, request('S'), 'C')).result.structuredContent.error?.code, 'REQUEST_CONFLICT');
    const persisted = new ProjectStore(f.root);
    try { assert.deepEqual(tool === 'send_message' ? persisted.read()!.messages : persisted.read()!.workflowReceipts, tool === 'send_message' ? f.state.messages : f.state.workflowReceipts); } finally { persisted.close(); }
  });

  test(`${tool}: paused, completed and same-node continuation replay bindings survive engine restart`, async t => {
    const f = await collaborationFixture(t), source = await f.active('plan');
    await f.engine.command({ type: 'pause_node', projectId: f.projectId, nodeId: 'implement' });
    const receipt = await f.invoke('plan', tool, request('R'), 'A');
    const contexts: McpCallContext[] = [];
    await f.engine.command({ type: 'pause_node', projectId: f.projectId, nodeId: 'plan' });
    f.finish(source, 'interrupted');
    contexts.push(f.context('plan', 'paused', source));
    assert.deepEqual(await f.invoke('plan', tool, request('R'), 'paused', contexts.at(-1)), receipt);
    await f.engine.command({ type: 'resume_node', projectId: f.projectId, nodeId: 'plan' });
    const { until } = await import('./runtime-fixture.js');
    await until(() => source.status === 'running' && !!source.turnId && source.turnId !== contexts[0].turnId);
    contexts.push(f.context('plan', 'continued', source));
    assert.deepEqual(await f.invoke('plan', tool, request('R'), 'continued', contexts.at(-1)), receipt);
    f.finish(source); contexts.push(f.context('plan', 'completed', source));
    assert.deepEqual(await f.invoke('plan', tool, request('R'), 'completed', contexts.at(-1)), receipt);
    await f.engine.close();
    const restored = new WorkflowEngine({ workbenchRoot: f.root, executable: 'unused', nativeFactory() { assert.fail('receipt recovery must not start native execution'); } });
    try {
      await restored.init();
      for (const saved of contexts) {
        const context = { ...saved, identity: restored.nodeIdentity(f.projectId, 'plan') };
        assert.deepEqual(await restored.invokeTool(tool, request('R'), context), receipt);
        await assert.rejects(restored.invokeTool(tool, request('new'), context), error => (error as any).code === 'REQUEST_CONFLICT');
      }
      const context = { ...contexts[0], callId: 'after-restart', identity: restored.nodeIdentity(f.projectId, 'plan') };
      assert.deepEqual(await restored.invokeTool(tool, request('R'), context), receipt);
      await assert.rejects(restored.invokeTool(tool, request('new'), context), error => (error as any).code === 'REQUEST_CONFLICT');
    } finally { await restored.close(); }
  });

  test(`${tool}: receipt recovery requires native association and current authorization`, async t => {
    const f = await collaborationFixture(t), source = await f.active('plan');
    await f.engine.command({ type: 'pause_node', projectId: f.projectId, nodeId: 'implement' });
    await f.invoke('plan', tool, request('R'), 'A');
    const original = f.context('plan', 'B', source), before = structuredClone(f.state);
    for (const context of [{ ...original, threadId: '', turnId: '' }, { ...original, turnId: 'forged' }, { ...original, callId: '' }, { ...original, identity: f.engine.nodeIdentity(f.projectId, 'review') }]) {
      await assert.rejects(f.engine.invokeTool(tool, request('R'), context), error => (error as any).code === 'PERMISSION_DENIED');
    }
    (f.engine as any).revoke(f.projectId, 'plan');
    await assert.rejects(f.engine.invokeTool(tool, request('R'), original), error => (error as any).code === 'PERMISSION_DENIED');
    assert.deepEqual(f.state, before);
  });
}

test('send and workflow replay call namespaces remain independent', async t => {
  const f = await collaborationFixture(t); await f.active('plan');
  await f.engine.command({ type: 'pause_node', projectId: f.projectId, nodeId: 'implement' });
  const send = { request_id: 'message', to_node_id: 'implement', content: null, reason: 'namespace' };
  const edit = { operation: 'save_edge', request_id: 'edge', edge: { id: 'edge', sourceNodeId: 'plan', targetNodeId: 'implement', condition: '', revision: 0 } };
  const a = await f.invoke('plan', 'send_message', send, 'A'), b = await f.invoke('plan', 'update_workflow', edit, 'A');
  assert.deepEqual(await f.invoke('plan', 'send_message', send, 'B'), a);
  assert.deepEqual(await f.invoke('plan', 'update_workflow', edit, 'B'), b);
  assert.equal(f.state.messages.length, 1); assert.equal(f.state.workflowReceipts.length, 1);
});

test('receipt bindings stay inside their source node and project', async t => {
  for (const f of [await collaborationFixture(t), await collaborationFixture(t)]) {
    const reviewer = f.state.nodes.find(node => node.id === 'review')!;
    await f.engine.command({ type: 'save_node', projectId: f.projectId, node: { ...reviewer, tools: [...reviewer.tools, 'update_workflow'] } });
    await f.engine.command({ type: 'pause_node', projectId: f.projectId, nodeId: 'implement' });
    for (const nodeId of ['plan', 'review']) {
      await f.active(nodeId);
      const send = { request_id: 'same-request', to_node_id: 'implement', content: nodeId, reason: 'scoped binding' };
      const edit = { operation: 'save_edge', request_id: 'same-request', edge: { id: nodeId, sourceNodeId: nodeId, targetNodeId: 'implement', condition: '', revision: 0 } };
      for (const [tool, input] of [['send_message', send], ['update_workflow', edit]] as const) {
        const receipt = await f.invoke(nodeId, tool, input, 'A');
        assert.deepEqual(await f.invoke(nodeId, tool, input, 'B'), receipt);
        assert.equal((await f.raw(nodeId, tool, { ...input, request_id: 'different' }, 'B')).result.structuredContent.error?.code, 'REQUEST_CONFLICT');
      }
    }
    assert.equal(f.state.messages.length, 2); assert.equal(f.state.workflowReceipts.length, 2);
  }
});
