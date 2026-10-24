import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewFixture } from './human-review-fixture.js';
import { collaborationFixture } from './collaboration-fixture.js';
import { until } from './runtime-fixture.js';
import { projectContext } from '../src/core/collaboration.js';

test('delivery exposes waiting review while retaining the accepted message and source', async t => {
  const f = await reviewFixture(t); await f.policy(); const source = await f.active('plan');
  const receipt = await f.invoke('plan', 'send_message', { request_id: 'gated', to_node_id: 'implement', content: ' original\n ', reason: 'review' }, 'gated');
  const delivery = await f.invoke('plan', 'get_delivery', { message_id: receipt.message_id }, 'delivery');
  assert.equal(delivery.attempts[0].status, 'waiting_review'); assert.equal(delivery.attempts[0].turnId, null);
  assert.equal(f.state.messages[0].request.content, ' original\n '); assert.equal(f.state.messages[0].sourceTaskId, source.id);
});

const request = { request_id: 'original', to_node_id: 'implement', content: ' 原样请求\n ', reason: '协作' };
async function sendFromA(f: Awaited<ReturnType<typeof collaborationFixture>>) {
  const source = await f.active('plan');
  const receipt = await f.invoke('plan', 'send_message', request, 'send-original');
  await until(() => f.state.tasks.some(task => task.incomingMessageId === receipt.message_id && !!task.turnId));
  return { source, receipt, target: f.state.tasks.find(task => task.id === receipt.target_task_id)! };
}

test('explicit replies queue behind user input and continue in the original Thread without blocking the sender', async t => {
  const f = await collaborationFixture(t), { source, receipt, target } = await sendFromA(f);
  await f.send('plan'); const user = f.state.tasks.at(-1)!;
  const reply = await f.invoke('implement', 'send_message', { request_id: 'reply-1', to_node_id: 'plan', reply_to: receipt.message_id, content: ' 原样答复 ', reason: '回复原请求' }, 'reply-call');
  assert.equal(f.state.tasks.filter(task => task.nodeId === 'plan' && task.status === 'running').length, 1);
  assert.equal(target.status, 'running'); assert.equal(target.terminal, null);
  f.finish(source);
  await until(() => !!user.turnId); assert.equal(user.threadId, source.threadId);
  const incoming = f.state.tasks.find(task => task.id === reply.target_task_id)!;
  assert.equal(incoming.status, 'queued');
  f.finish(user); await until(() => !!incoming.turnId);
  assert.equal(incoming.threadId, source.threadId);
  f.finish(source); assert.equal(incoming.status, 'running', 'late old completion cannot finish the new reply turn');
  const context = await f.invoke('plan', 'get_project_context', {}, 'read-reply');
  assert.equal(context.incoming_message.reply_to, receipt.message_id);
  assert.deepEqual(context.task.source, { kind: 'node', nodeId: 'implement', name: '执行' });
  f.finish(target); f.finish(incoming);
  assert.equal(f.state.messages.length, 2, 'ordinary completion never generates a message');
  assert.equal(incoming.status, 'completed');
  const rules = context.collaboration_rules.join('\n');
  assert.match(rules, /end.*Turn|finish.*Turn/i); assert.match(rules, /original.*Thread|same.*Thread/i);
  assert.match(rules, /project.*goal|goal.*accept/i);
  const instructions = f.clients[0].calls.find(call => call.method === 'thread/start')!.params.developerInstructions;
  assert.match(instructions, /send_message/); assert.match(instructions, /reply_to/);
});

test('reply relationships reject third parties and archived original senders without rewriting output', async t => {
  const f = await collaborationFixture(t), { source, receipt } = await sendFromA(f);
  const thirdParty = await f.raw('implement', 'send_message', { request_id: 'bad-reply', to_node_id: 'review', reply_to: receipt.message_id, content: 'no', reason: 'invalid' }, 'bad-reply');
  assert.equal(thirdParty.result.structuredContent.error.code, 'INVALID_REPLY');
  f.finish(source); await f.engine.command({ type: 'delete_node', projectId: f.projectId, nodeId: 'plan' });
  const archived = await f.raw('implement', 'send_message', { request_id: 'archived-reply', to_node_id: 'plan', reply_to: receipt.message_id, content: 'keep', reason: 'reply' }, 'archived-reply');
  assert.equal(archived.result.structuredContent.error.code, 'TARGET_UNAVAILABLE');
  assert.equal(f.state.messages.length, 1); assert.equal(f.state.archivedNodes!.length, 1);
});

test('confirmed retry preserves message, source, original content and attachment snapshots and can reply once', async t => {
  const f = await collaborationFixture(t), { receipt, target } = await sendFromA(f);
  const message = f.state.messages[0];
  // Attachment creation is Task 5; use an already persisted snapshot to test lifecycle identity here.
  message.attachments.push({ artifact_id: 'fixture-artifact', name: 'evidence.txt', relativePath: '.mixcat/artifacts/evidence.txt', sha256: 'a'.repeat(64), size: 7 });
  const originalInput = structuredClone(target.nativeInput), originalInstruction = target.instruction, snapshots = structuredClone(message.attachments);
  f.state.maxSteps = 1;
  f.finish(target, 'failed');
  await assert.rejects(f.engine.command({ type: 'retry_task', projectId: f.projectId, taskId: target.id, confirmed: false }));
  await f.engine.command({ type: 'retry_task', projectId: f.projectId, taskId: target.id, confirmed: true }, 'retry-control');
  const retry = f.state.tasks.at(-1)!; await until(() => !!retry.turnId);
  assert.equal(retry.retryOfTaskId, target.id); assert.equal(retry.incomingMessageId, receipt.message_id);
  assert.equal(retry.instruction, originalInstruction); assert.deepEqual(retry.nativeInput!.slice(0, originalInput!.length), originalInput);
  assert.equal(retry.threadId, target.threadId); assert.deepEqual(message.attachments, snapshots);
  const context = await f.invoke('implement', 'get_project_context', {}, 'retry-context');
  assert.equal(context.remainingSteps, null, 'free message retries keep their original budget classification');
  assert.match(f.clients[0].calls.filter(call => call.method === 'turn/start').at(-1)!.params.input.at(-1).text, /避免重复外部操作/);
  assert.equal(context.incoming_message.message_id, receipt.message_id); assert.deepEqual(context.incoming_message.attachments, snapshots);
  assert.deepEqual(context.task.source, { kind: 'node', nodeId: 'plan', name: '规划' });
  const original = f.state.conversation.find(entry => entry.id === `input:${retry.id}`)!;
  assert.equal(original.text, request.content); assert.equal(original.source!.kind, 'node');
  const note = f.state.conversation.find(entry => entry.taskId === retry.id && entry.controlActionId === 'retry-control')!;
  assert.equal(note.source!.kind, 'system'); assert.match(note.text, /核对/);
  f.finish(target); assert.equal(retry.status, 'running');
  await f.invoke('implement', 'send_message', { request_id: 'retry-reply', to_node_id: 'plan', reply_to: receipt.message_id, content: false, reason: '回复原请求' }, 'retry-reply');
  const delivery = await f.invoke('plan', 'get_delivery', { message_id: receipt.message_id }, 'delivery');
  assert.deepEqual(delivery.receipt, receipt); assert.deepEqual(delivery.attempts.map((attempt: any) => attempt.task_id), [target.id, retry.id]);
  assert.equal(delivery.attempts[1].retryOfTaskId, target.id); assert.equal(delivery.replies.length, 1);
});

test('retry of an incoming reply keeps reply_to and never automatically re-sends an earlier reply', async t => {
  const f = await collaborationFixture(t), { source, receipt, target } = await sendFromA(f);
  const reply = await f.invoke('implement', 'send_message', { request_id: 'before-failure', to_node_id: 'plan', reply_to: receipt.message_id, content: null, reason: '答复' }, 'before-failure');
  f.finish(source); await until(() => !!f.state.tasks.find(task => task.id === reply.target_task_id)!.turnId);
  const incoming = f.state.tasks.find(task => task.id === reply.target_task_id)!; f.finish(incoming, 'failed');
  await f.engine.command({ type: 'retry_task', projectId: f.projectId, taskId: incoming.id, confirmed: true });
  const retry = f.state.tasks.at(-1)!; await until(() => !!retry.turnId);
  const context = await f.invoke('plan', 'get_project_context', {}, 'incoming-retry');
  assert.equal(context.incoming_message.reply_to, receipt.message_id); assert.equal(context.task.input, null);
  assert.deepEqual(context.task.source, { kind: 'node', nodeId: 'implement', name: '执行' });
  f.finish(target); f.finish(retry); assert.equal(f.state.messages.length, 2);
});

test('rejected retry commit leaves the failed attempt, original receipt and queue unchanged', async t => {
  const f = await collaborationFixture(t), { receipt, target } = await sendFromA(f); f.finish(target, 'failed');
  const before = structuredClone(f.state), durable = f.store.read(), release = f.rejectSave();
  try { await assert.rejects(f.engine.command({ type: 'retry_task', projectId: f.projectId, taskId: target.id, confirmed: true }), /fixture SQLite rejection/); }
  finally { release(); }
  assert.deepEqual(f.state, before); assert.deepEqual(f.store.read(), durable);
  assert.equal(f.state.messages[0].target_task_id, receipt.target_task_id);
});

test('retry cancels only old handoffs and keeps already accepted ordinary replies', async t => {
  const f = await collaborationFixture(t), { receipt, target } = await sendFromA(f);
  const reply = await f.invoke('implement', 'send_message', { request_id: 'already-replied', to_node_id: 'plan', reply_to: receipt.message_id, content: 'kept', reason: '答复' }, 'already-replied');
  await f.invoke('implement', 'handoff', { to_node_id: 'review', task: '旧交接', result: '待核对', reason: '旧流程' }, 'old-handoff');
  f.finish(target, 'failed'); assert.equal(target.status, 'needs_reconciliation');
  await f.engine.command({ type: 'retry_task', projectId: f.projectId, taskId: target.id, confirmed: true });
  const retry = f.state.tasks.at(-1)!; await until(() => !!retry.turnId);
  assert.equal(f.state.handoffs[0].status, 'cancelled');
  assert.equal(f.state.tasks.find(task => task.id === reply.target_task_id)!.status, 'queued');
  assert.equal(f.state.messages.length, 2); assert.equal(retry.incomingMessageId, receipt.message_id);
  const delivery = await f.invoke('plan', 'get_delivery', { message_id: receipt.message_id }, 'kept-delivery');
  assert.equal(delivery.replies.length, 1); assert.equal(delivery.replies[0].message_id, reply.message_id);
});

test('legacy handoff retry preserves exhausted chain budget and appends system caution only when dispatched', async t => {
  const f = await collaborationFixture(t); f.state.maxSteps = 2;
  await f.engine.command({ type: 'start', projectId: f.projectId, nodeId: 'plan', mode: 'codex', instruction: 'legacy root' });
  const source = f.state.tasks[0]; await until(() => !!source.turnId);
  await f.invoke('plan', 'handoff', { to_node_id: 'implement', task: 'legacy receiving instruction', result: { original: [' raw ', false, null] }, reason: 'old chain' }, 'legacy-handoff');
  f.finish(source); const target = f.state.tasks.at(-1)!; await until(() => !!target.turnId);
  assert.equal(target.nativeInput, undefined); f.finish(target, 'failed');
  const original = f.state.conversation.find(entry => entry.id === `input:${target.id}`)!;
  await f.engine.command({ type: 'retry_task', projectId: f.projectId, taskId: target.id, confirmed: true }, 'legacy-retry-control');
  const retry = f.state.tasks.at(-1)!;
  assert.equal(retry.status, 'queued', 'exhausted legacy retries must stay queued');
  assert.equal(retry.nativeInput, undefined, 'retry must preserve legacy classification');
  assert.equal(f.state.nodes.find(node => node.id === 'implement')!.status, 'blocked');
  assert.equal(f.clients[0].calls.filter(call => call.method === 'turn/start').length, 2);
  assert.equal((projectContext(f.state, 'implement', retry) as any).remainingSteps, 0);
  assert.equal(retry.instruction, target.instruction); assert.deepEqual(retry.input, target.input);
  const retriedInput = f.state.conversation.find(entry => entry.id === `input:${retry.id}`)!;
  assert.deepEqual(retriedInput.source, original.source); assert.deepEqual(retriedInput.content, original.content); assert.equal(retriedInput.text, original.text);
  const note = f.state.conversation.find(entry => entry.taskId === retry.id && entry.controlActionId === 'legacy-retry-control')!;
  assert.equal(note.source!.kind, 'system'); assert.match(note.text, /避免重复外部操作/);
  assert.ok(f.state.activities.some(activity => activity.taskId === retry.id && activity.kind === 'limit'));
  f.state.maxSteps = 3;
  await f.engine.command({ type: 'resume_node', projectId: f.projectId, nodeId: 'implement' }); await until(() => !!retry.turnId);
  assert.equal(retry.threadId, target.threadId); assert.equal(retry.nativeInput, undefined);
  const input = f.clients[0].calls.filter(call => call.method === 'turn/start').at(-1)!.params.input;
  assert.equal(input[0].text, `${target.instruction}\n\n输入交接内容：\n${JSON.stringify(target.input, null, 2)}`);
  assert.equal(input[1].text, note.text);
  assert.equal((await f.invoke('implement', 'get_project_context', {}, 'legacy-retry-context')).remainingSteps, 0);
});
