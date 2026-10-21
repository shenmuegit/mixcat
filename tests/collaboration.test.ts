import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkflowEngine } from '../src/core/engine.js';
import { collaborationFixture } from './collaboration-fixture.js';
import { deferred, until } from './runtime-fixture.js';

const message = { request_id: 'first', to_node_id: 'implement', content: { custom: [false, null, 0, ''], text: ' 原文\n ' }, reason: '协作' };
async function failure(f: Awaited<ReturnType<typeof collaborationFixture>>, args: Record<string, unknown>, code: string, call = 'invalid', node = 'plan') {
  const response = await f.raw(node, 'send_message', args, call);
  assert.equal(response.result?.isError, true, JSON.stringify(response));
  assert.equal(response.result.structuredContent?.error?.code, code, response.result.content[0]?.text);
}

test('ordinary HTTP send delivers before source ends and preserves raw JSON and node provenance', async t => {
  const f = await collaborationFixture(t), a = await f.active('plan');
  f.state.maxSteps = 1;
  const receipt = await f.invoke('plan', 'send_message', message, 'call-1');
  await until(() => f.state.tasks.some(x => x.id === receipt.target_task_id && !!x.turnId));
  assert.equal(a.status, 'running'); assert.equal(a.terminal, null); assert.equal(a.result, null);
  assert.deepEqual(Object.keys(receipt).sort(), ['accepted', 'accepted_at', 'message_id', 'target_task_id']);
  const target = f.state.tasks.find(x => x.id === receipt.target_task_id)!;
  assert.equal(target.incomingMessageId, receipt.message_id); assert.deepEqual(target.input, message.content);
  const entry = f.state.conversation.find(x => x.messageId === receipt.message_id && x.direction === 'input')!;
  assert.deepEqual(entry.source, { kind: 'node', nodeId: 'plan', name: '规划' }); assert.deepEqual(entry.content, message.content);
  assert.equal(f.state.handoffs.length, 0);
  assert.deepEqual(f.store.read()!.messages[0].request.content, message.content);
  const summary = (await f.engine.command({ type: 'snapshot', projectId: f.projectId })).snapshot.selected!.messages![0];
  assert.equal(summary.fromName, '规划'); assert.equal('request' in summary, false); assert.equal('content' in summary, false);
  const prompt = f.clients[0].calls.filter(call => call.method === 'turn/start').at(-1)!.params.input;
  assert.match(prompt[0].text, /规划/); assert.match(prompt[0].text, /原文/);
  const nativeInput = { id: 'received-input', type: 'userMessage', content: prompt };
  f.clients[0].options.onEvent({ method: 'item/completed', params: { threadId: target.threadId, turnId: target.turnId, item: nativeInput } });
  assert.deepEqual(f.state.conversation.find(x => x.id === entry.id)!.content, message.content);
  assert.deepEqual(f.state.conversation.find(x => x.id === entry.id)!.rawItem, nativeInput);
  f.finish(a, 'failed'); assert.equal(f.state.tasks.find(x => x.id === target.id)!.status, 'running'); assert.equal(f.state.messages.length, 1);
});

test('parallel replay uses durable request key and exact JSON semantics instead of key order', async t => {
  const f = await collaborationFixture(t); await f.active('plan');
  await f.engine.command({ type: 'pause_node', projectId: f.projectId, nodeId: 'implement' });
  const receipts = await Promise.all(Array.from({ length: 6 }, (_, i) => f.invoke('plan', 'send_message', message, `parallel-${i}`)));
  for (const receipt of receipts) assert.deepEqual(receipt, receipts[0]);
  assert.equal(f.state.messages.length, 1); assert.equal(f.state.tasks.length, 2);
  assert.deepEqual(await f.invoke('plan', 'send_message', { ...message, content: { text: ' 原文\n ', custom: [false, null, 0, ''] }, attachments: [], route: null, reply_to: null }, 'reordered'), receipts[0]);
  for (const content of [{ custom: [null, false, 0, ''], text: ' 原文\n ' }, { ...message.content, text: '原文' }]) await failure(f, { ...message, content }, 'REQUEST_CONFLICT');
  await failure(f, { ...message, request_id: 'changed-id' }, 'REQUEST_CONFLICT', f.state.messages[0].callId);
  await f.invoke('plan', 'send_message', { ...message, request_id: 'second' }, 'new-call');
  assert.equal(f.state.messages.length, 2); assert.equal(f.state.tasks.filter(task => task.nodeId === 'implement').length, 2);
});

test('failed SQLite acceptance publishes no message, task, history or successful receipt', async t => {
  const f = await collaborationFixture(t); await f.active('plan');
  const before = structuredClone(f.state), disk = f.store.db.prepare('SELECT body FROM project_state').get()!.body, release = f.rejectSave();
  try {
    for (let i = 0; i < 2; i++) {
      await failure(f, message, 'STORAGE_UNAVAILABLE', 'write');
      assert.deepEqual(f.state, before); assert.equal(f.store.db.prepare('SELECT body FROM project_state').get()!.body, disk);
    }
  } finally { release(); }
  const receipt = await f.invoke('plan', 'send_message', message, 'write');
  assert.equal(receipt.accepted, true); assert.equal(f.state.messages.length, 1);
});

test('lost receipt replays after target changes and restart, but forged associations fail', async t => {
  const f = await collaborationFixture(t), source = await f.active('plan'), original = f.context('plan', 'send', source);
  await f.engine.command({ type: 'pause_node', projectId: f.projectId, nodeId: 'implement' });
  const receipt = await f.invoke('plan', 'send_message', message, 'send');
  f.finish(source); await f.engine.command({ type: 'send_message', projectId: f.projectId, nodeId: 'plan', mode: 'codex', input: [{ type: 'text', text: 'continue' }] });
  await until(() => f.state.tasks.some(task => task.nodeId === 'plan' && task.status === 'running' && task.id !== source.id && !!task.turnId));
  assert.deepEqual(await f.invoke('plan', 'send_message', message, 'continuation'), receipt);
  await f.engine.close();
  const restored = new WorkflowEngine({ workbenchRoot: f.root, executable: 'unused', nativeFactory() { assert.fail('replay must not reconnect'); } });
  try {
    await restored.init(); const context = { ...original, identity: restored.nodeIdentity(f.projectId, 'plan') };
    assert.deepEqual(await restored.invokeTool('send_message', message, context), receipt);
    await assert.rejects(restored.invokeTool('send_message', message, { ...context, turnId: 'forged' }), /执行|身份/);
    assert.deepEqual(await restored.invokeTool('get_delivery', { request_id: 'first' }, { ...context, threadId: '', turnId: '', callId: '' }), await restored.invokeTool('get_delivery', { message_id: receipt.message_id }, { ...context, threadId: '', turnId: '', callId: '' }));
  } finally { await restored.close(); }
});

test('new sends reject paused, terminal, forged or unprivileged sources without changing accepted facts', async t => {
  const f = await collaborationFixture(t), source = await f.active('plan'), ctx = f.context('plan', 'forged');
  const forged = await f.raw('plan', 'send_message', message, 'forged', { ...ctx, threadId: 'elsewhere' });
  assert.equal(forged.result.structuredContent.error.code, 'PERMISSION_DENIED');
  await f.engine.command({ type: 'pause_node', projectId: f.projectId, nodeId: 'plan' });
  await failure(f, message, 'SOURCE_NOT_ACTIVE');
  assert.equal(f.state.messages.length, 0); f.finish(source, 'interrupted');
  const reader = f.engine.nodeIdentity(f.projectId, 'review');
  await assert.rejects(f.engine.invokeTool('send_message', message, { ...ctx, identity: { ...reader, nodeId: 'plan' } }), /身份/);
});

test('reply and route validation fix endpoints and snapshots while rejecting unavailable attachments', async t => {
  const f = await collaborationFixture(t), source = await f.active('plan');
  await f.engine.command({ type: 'save_edge', projectId: f.projectId, edge: { id: 'route', sourceNodeId: 'plan', targetNodeId: 'implement', condition: 'when useful', revision: 0 } });
  await failure(f, { ...message, route: { edge_id: 'route', edge_revision: 2 } }, 'ROUTE_CHANGED');
  await failure(f, { ...message, reply_to: 'missing' }, 'INVALID_REPLY');
  await failure(f, { ...message, to_node_id: 'plan' }, 'TARGET_UNAVAILABLE');
  await failure(f, { ...message, to_node_id: 'foreign-node' }, 'TARGET_UNAVAILABLE');
  const attachment = await f.raw('plan', 'send_message', { ...message, attachments: [{ path: 'file.txt' }] }, 'attachment');
  assert.equal(attachment.result.isError, true); assert.match(attachment.result.content[0].text, /附件/);
  assert.equal(attachment.result.structuredContent.error.code, -32602);
  const receipt = await f.invoke('plan', 'send_message', { ...message, route: { edge_id: 'route', edge_revision: 1 } }, 'send');
  await until(() => !!f.state.tasks.find(task => task.id === receipt.target_task_id)?.turnId);
  await f.engine.command({ type: 'delete_edge', projectId: f.projectId, edgeId: 'route' });
  assert.deepEqual(f.state.messages[0].edgeSnapshot, { id: 'route', sourceNodeId: 'plan', targetNodeId: 'implement', condition: 'when useful', revision: 1 });
  assert.deepEqual(await f.invoke('plan', 'send_message', { ...message, route: { edge_id: 'route', edge_revision: 1 } }, 'lost'), receipt);
  const reply = { request_id: 'reply', to_node_id: 'plan', content: false, reason: 'answer', reply_to: receipt.message_id };
  await failure(f, { ...reply, to_node_id: 'review' }, 'INVALID_REPLY', 'bad-reply', 'implement');
  const replyReceipt = await f.invoke('implement', 'send_message', reply, 'reply');
  const waiting = f.state.tasks.find(task => task.id === replyReceipt.target_task_id)!;
  assert.equal(waiting.status, 'queued'); assert.equal(waiting.input, false); assert.equal(waiting.nativeInput?.length, 1);
  assert.equal(f.state.conversation.find(entry => entry.taskId === waiting.id)?.replyTo, receipt.message_id);
  const delivery = await f.invoke('plan', 'get_delivery', { request_id: 'first' }, 'delivery');
  assert.equal(delivery.receipt.message_id, receipt.message_id); assert.equal(delivery.attempts[0].status, 'running'); assert.equal(delivery.replies[0].message_id, replyReceipt.message_id);
  f.finish(source); await until(() => !!waiting.turnId); assert.equal(waiting.threadId, source.threadId);
});

test('content snapshot happens before asynchronous caller mutation and scalars remain raw', async t => {
  const f = await collaborationFixture(t), source = await f.active('plan');
  await f.engine.command({ type: 'pause_node', projectId: f.projectId, nodeId: 'implement' });
  const input = structuredClone(message), pending = f.engine.invokeTool('send_message', input, f.context('plan', 'clone', source));
  input.content.custom.push('mutated'); await pending;
  assert.deepEqual(f.state.messages[0].request.content, message.content);
  for (const [i, content] of [null, false, 0, '', ['b', 'a']].entries()) {
    const receipt = await f.invoke('plan', 'send_message', { ...message, request_id: `scalar-${i}`, content }, `scalar-${i}`);
    assert.deepEqual(f.state.tasks.find(task => task.id === receipt.target_task_id)!.input, content);
    assert.deepEqual(f.state.conversation.find(entry => entry.messageId === receipt.message_id && entry.direction === 'input')!.content, content);
  }
});

test('new ordinary writes after a terminal action fail while the original receipt remains replayable', async t => {
  const f = await collaborationFixture(t); await f.active('plan');
  const receipt = await f.invoke('plan', 'send_message', message, 'send');
  await f.invoke('plan', 'handoff', { to_node_id: 'review', task: 'legacy', reason: 'legacy', result: 0 }, 'terminal');
  await failure(f, { ...message, request_id: 'after-terminal' }, 'SOURCE_NOT_ACTIVE');
  assert.deepEqual(await f.invoke('plan', 'send_message', message, 'again'), receipt);
  assert.equal(f.state.tasks.find(task => task.id === f.state.handoffs[0].id)!.status, 'waiting_source');
});

test('a new replay call binds without reading missing attachments again', async t => {
  const f = await collaborationFixture(t); await f.active('plan');
  await f.engine.command({ type: 'pause_node', projectId: f.projectId, nodeId: 'implement' });
  const path = join(f.root, 'report.txt'); writeFileSync(path, 'v1');
  const args = { ...message, attachments: [{ path: 'report.txt' }] };
  const receipt = await f.invoke('plan', 'send_message', args, 'A'); rmSync(path);
  let reads = 0;
  const mock = t.mock.method(fs, 'readFile', async () => { reads++; throw Error('must not read accepted attachments'); });
  try {
    assert.deepEqual(await f.invoke('plan', 'send_message', args, 'B'), receipt);
    assert.equal(reads, 0);
    await failure(f, { ...args, request_id: 'changed' }, 'REQUEST_CONFLICT', 'B');
  } finally { mock.mock.restore(); }
});

test('message envelope rejects invalid IDs, undeclared identity fields and ambiguous references', async t => {
  const f = await collaborationFixture(t); await f.active('plan');
  for (const args of [
    { ...message, request_id: '' }, { ...message, request_id: 'a'.repeat(129) }, { ...message, request_id: 'has space' },
    { ...message, nodeId: 'review' }, { ...message, reason: '' }, { ...message, attachments: null },
    { ...message, attachments: [{ path: 'a', artifact_id: 'b' }] }, { ...message, route: { edge_id: 'route', edge_revision: '1' } },
  ]) {
    const response = await f.raw('plan', 'send_message', args, 'invalid-envelope');
    assert.equal(response.result.isError, true); assert.equal(response.result.structuredContent.error.code, -32602);
  }
  for (const args of [{}, { message_id: 'm', request_id: 'r' }, { request_id: '' }]) {
    const response = await f.raw('plan', 'get_delivery', args, 'invalid-lookup');
    assert.equal(response.result.isError, true);
  }
  assert.equal(f.state.messages.length, 0);
});

test('attachment preparation rechecks control, identity, target and route after file IO', async t => {
  for (const action of ['pause', 'stop', 'delete', 'route', 'revoke', 'finish'] as const) {
    await t.test(action, async t => {
      const f = await collaborationFixture(t), source = await f.active('plan');
      const path = join(f.root, 'report.txt'); writeFileSync(path, 'fixed');
      await f.engine.command({ type: 'save_edge', projectId: f.projectId, edge: { id: 'route', sourceNodeId: 'plan', targetNodeId: 'implement', condition: 'old', revision: 0 } });
      const reading = deferred(), release = deferred(), originalRead = fs.readFile;
      const mock = t.mock.method(fs, 'readFile', async (...args: any[]) => {
        if (args[0] === path) { reading.resolve(); await release.promise; }
        return (originalRead as any)(...args);
      });
      const pending = f.raw('plan', 'send_message', { ...message, attachments: [{ path: 'report.txt' }], route: { edge_id: 'route', edge_revision: 1 } }, `race-${action}`);
      try {
        await Promise.race([reading.promise, pending.then(response => assert.fail(JSON.stringify(response)))]);
        if (action === 'pause') await f.engine.command({ type: 'pause_node', projectId: f.projectId, nodeId: 'plan' });
        if (action === 'stop') await f.engine.command({ type: 'stop', projectId: f.projectId });
        if (action === 'delete') await f.engine.command({ type: 'delete_node', projectId: f.projectId, nodeId: 'implement' });
        if (action === 'route') await f.engine.command({ type: 'save_edge', projectId: f.projectId, edge: { ...f.state.edges[0], condition: 'new' } });
        if (action === 'revoke') (f.engine as any).revoke(f.projectId, 'plan');
        if (action === 'finish') f.finish(source);
        release.resolve(); const response = await pending;
        assert.equal(response.result.structuredContent.error.code, action === 'delete' ? 'TARGET_UNAVAILABLE' : action === 'route' ? 'ROUTE_CHANGED' : action === 'revoke' ? 'PERMISSION_DENIED' : 'SOURCE_NOT_ACTIVE');
        assert.equal(f.state.messages.length, 0); assert.equal(f.state.tasks.length, 1); assert.equal(f.store.read()!.messages.length, 0);
      } finally { release.resolve(); mock.mock.restore(); }
    });
  }
});

test('concurrent attachment sends retain the first committed snapshot and reject a changed same-call request', async t => {
  const f = await collaborationFixture(t); await f.active('plan');
  await f.engine.command({ type: 'pause_node', projectId: f.projectId, nodeId: 'implement' });
  const path = join(f.root, 'report.txt'); writeFileSync(path, 'v1');
  const reading = deferred(), release = deferred(), originalRead = fs.readFile; let first = true;
  const mock = t.mock.method(fs, 'readFile', async (...args: any[]) => {
    if (args[0] === path && first) { first = false; reading.resolve(); await release.promise; }
    return (originalRead as any)(...args);
  });
  const args = { ...message, attachments: [{ path: 'report.txt' }] };
  const pending = f.invoke('plan', 'send_message', args, 'slow-file');
  try {
    await Promise.race([reading.promise, pending.then(() => assert.fail('send completed before reading'))]);
    const fast = await f.invoke('plan', 'send_message', args, 'fast-file');
    const original = structuredClone(f.state.messages[0].attachments);
    writeFileSync(path, 'v2'); release.resolve();
    assert.deepEqual(await pending, fast); assert.equal(f.state.messages.length, 1); assert.deepEqual(f.state.messages[0].attachments, original);
    const { resolveMessageArtifact } = await import('../src/core/message-files.js');
    assert.equal(readFileSync(resolveMessageArtifact(f.root, f.state, original[0].artifact_id), 'utf8'), 'v1');
    assert.equal(readdirSync(join(f.root, '.mixcat', 'artifacts', 'messages')).length, 2, 'unregistered prepared file remains an orphan');
    await failure(f, { ...args, request_id: 'other-id' }, 'REQUEST_CONFLICT', 'fast-file');
    await failure(f, { ...args, request_id: 'slow-changed' }, 'REQUEST_CONFLICT', 'slow-file');
  } finally { release.resolve(); mock.mock.restore(); }
});

test('retrying delivery keeps attachment bytes, raw input, provenance and original receipt', async t => {
  const f = await collaborationFixture(t); await f.active('plan'); writeFileSync(join(f.root, 'report.txt'), 'v1');
  const args = { ...message, attachments: [{ path: 'report.txt' }] };
  const receipt = await f.invoke('plan', 'send_message', args, 'send-file');
  await until(() => !!f.state.tasks.find(task => task.id === receipt.target_task_id)?.turnId);
  const target = f.state.tasks.find(task => task.id === receipt.target_task_id)!, native = structuredClone(target.nativeInput), snapshot = structuredClone(f.state.messages[0].attachments);
  f.finish(target, 'failed'); writeFileSync(join(f.root, 'report.txt'), 'v2');
  await f.engine.command({ type: 'retry_task', projectId: f.projectId, taskId: target.id, confirmed: true });
  const retried = f.state.tasks.find(task => task.retryOfTaskId === target.id)!;
  assert.deepEqual(retried.nativeInput, native); assert.deepEqual(retried.input, message.content);
  const entry = f.state.conversation.find(entry => entry.id === `input:${retried.id}`)!;
  assert.deepEqual(entry.attachments, snapshot); assert.deepEqual(entry.source, { kind: 'node', nodeId: 'plan', name: '规划' });
  assert.deepEqual(await f.invoke('plan', 'send_message', args, 'lost-file'), receipt); assert.equal(f.state.messages.length, 1);
});

test('a concurrent committed receipt wins over later preparation failure and same-call ID changes still conflict', async t => {
  for (const conflict of [false, true]) await t.test(conflict ? 'changed call request' : 'missing source after acceptance', async t => {
    const f = await collaborationFixture(t); await f.active('plan');
    await f.engine.command({ type: 'pause_node', projectId: f.projectId, nodeId: 'implement' });
    const path = join(f.root, 'report.txt'); writeFileSync(path, 'v1');
    const reading = deferred(), release = deferred(), originalRead = fs.readFile; let first = true;
    const mock = t.mock.method(fs, 'readFile', async (...args: any[]) => {
      if (args[0] === path && first) { first = false; reading.resolve(); await release.promise; }
      return (originalRead as any)(...args);
    });
    const args = { ...message, attachments: [{ path: 'report.txt' }] };
    const pending = f.raw('plan', 'send_message', args, 'slow');
    try {
      await Promise.race([reading.promise, pending.then(response => assert.fail(JSON.stringify(response)))]);
      const accepted = await f.invoke('plan', 'send_message', conflict ? { ...args, request_id: 'changed' } : args, conflict ? 'slow' : 'fast');
      if (!conflict) rmSync(path);
      release.resolve(); const response = await pending;
      if (conflict) assert.equal(response.result.structuredContent.error.code, 'REQUEST_CONFLICT');
      else {
        assert.equal(response.result.isError, undefined, response.result.content[0]?.text); assert.deepEqual(response.result.structuredContent, accepted);
        await failure(f, { ...args, request_id: 'slow-changed' }, 'REQUEST_CONFLICT', 'slow');
      }
      assert.equal(f.state.messages.length, 1); assert.equal(f.state.tasks.length, 2);
    } finally { release.resolve(); mock.mock.restore(); }
  });
});
