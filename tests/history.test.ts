import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeItem, recordContinuation, migrateHistory } from '../src/core/history.js';
import { fixture, until } from './runtime-fixture.js';
import { readConversationPage, projectContext } from '../src/core/collaboration.js';
import { orderedConversation } from '../src/shared/conversation-order.js';

test('unassociated native protocol input retains unknown author and original item', async t => {
  const f = await fixture(t);
  const state = (f.engine as any).states.get(f.projectId);
  const item = { id: 'old', type: 'userMessage', content: [{ type: 'text', text: 'raw' }] };
  const entry = nativeItem(state, 'plan', 'old-thread', 'old-turn', item, undefined, true, '');
  assert.equal(entry.source?.kind, 'unknown');
  assert.equal(entry.nativeRole, 'user');
  assert.deepEqual(entry.rawItem, item);
  assert.equal(entry.createdAt, '');
});
test('native augmented prompt does not overwrite original input; author name survives rename and migration', async t => {
  const f = await fixture(t); await f.send('plan');
  const state = (f.engine as any).states.get(f.projectId);
  await until(() => !!state.tasks[0].turnId);
  const task = state.tasks[0], raw = { id: 'input', type: 'userMessage', content: [{ type: 'text', text: 'extra private context hello' }] };
  const entry = nativeItem(state, task.nodeId, task.threadId, task.turnId, raw, task, true, '');
  assert.equal(entry.text, 'hello'); assert.deepEqual(entry.rawItem, raw); assert.equal(entry.source?.kind, 'user');
  const output = nativeItem(state, task.nodeId, task.threadId, task.turnId, { id: 'output', type: 'agentMessage', text: 'response' }, task, true, '');
  const name = output.source!.name;
  state.nodes[0].name = 'renamed'; migrateHistory(state);
  assert.equal(output.source!.name, name);
  assert.equal(entry.text, 'hello');
  nativeItem(state, task.nodeId, task.threadId, task.turnId, { id: 'output', type: 'agentMessage', text: 'late' }, task, false, '');
  assert.equal(output.text, 'response');
  nativeItem(state, task.nodeId, task.threadId, task.turnId, { id: 'output', type: 'agentMessage', text: 'stale backfill', status: 'inProgress' }, task, true, '');
  assert.equal(output.text, 'response');
});
test('continuation is system authored and references its control action', async t => {
  const f = await fixture(t); await f.send('plan');
  await until(() => !!(f.engine as any).states.get(f.projectId).tasks[0].turnId);
  const state = (f.engine as any).states.get(f.projectId);
  const task = state.tasks[0]; task.resumeCount = 1; task.resumeActionId = 'resume-action';
  const entry = recordContinuation(state, task, [{ type: 'text', text: 'continue' }]);
  assert.equal(entry.source?.kind, 'system');
  assert.equal(entry.controlActionId, 'resume-action');
});
test('first activities-only migration preserves original author without inventing native items', async t => {
  const f = await fixture(t); await f.send('plan');
  const state = (f.engine as any).states.get(f.projectId); await until(() => !!state.tasks[0].turnId);
  state.conversation = []; state.nodes[0].name = 'renamed';
  state.activities.push({ id: 999, nodeId: 'plan', taskId: state.tasks[0].id, kind: 'message:legacy', text: 'legacy original', createdAt: '' });
  migrateHistory(state);
  const entry = state.conversation.find((e: any) => e.itemId === 'legacy');
  assert.equal(entry.source.name, state.tasks[0].nodeSnapshot.name);
  assert.equal(entry.rawItem, undefined); assert.equal(entry.createdAt, '');
  const before = structuredClone(entry); migrateHistory(state); assert.deepEqual(entry, before);
  const raw = { type: 'userMessage', id: 'retained', content: [] };
  state.conversation.push({ ...entry, id: 'native:retained', direction: 'input', content: raw, source: null });
  migrateHistory(state);
  const retained = state.conversation.at(-1);
  assert.deepEqual(retained.rawItem, raw); assert.equal(retained.nativeRole, 'user'); assert.equal(retained.source.kind, 'unknown');
});

test('history queries preserve original native payload and return detached entries in shared order', async t => {
  const f = await fixture(t); await f.send('plan');
  const state = (f.engine as any).states.get(f.projectId); await until(() => !!state.tasks[0].turnId);
  const task = state.tasks[0];
  const item = { id: 'raw-output', type: 'agentMessage', text: ' original\n ', extra: { values: [false, 0, null, ''] } };
  const output = nativeItem(state, 'plan', task.threadId, task.turnId, item, task, true, '');
  const page = readConversationPage(state, { node_id: 'plan' });
  assert.deepEqual(page.entries.map(entry => entry.id), orderedConversation(state.conversation).map(entry => entry.id));
  const returned = page.entries.find(entry => entry.id === output.id)!;
  assert.equal(returned.createdAt, ''); assert.deepEqual(returned.rawItem, item); assert.equal(returned.source?.name, task.nodeSnapshot.name);
  (returned.rawItem as any).extra.values.push('changed'); assert.deepEqual(output.rawItem, item);
  const context = projectContext(state, 'plan', task) as any;
  context.self.name = 'changed'; context.nodes[0].tools.length = 0;
  assert.equal(state.nodes[0].name, '规划'); assert.ok(state.nodes[0].tools.length > 0);
  delete task.nativeInput; state.maxSteps = 20;
  assert.equal((projectContext(state, 'plan', task) as any).remainingSteps, 19);
});
