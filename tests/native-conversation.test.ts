import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, until } from './runtime-fixture.js';
import { WorkflowEngine } from '../src/core/engine.js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConversationFeed } from '../src/renderer/Conversation.js';
import type { ConversationEntry } from '../src/shared/types.js';

test('native reasoning streams indexed sections and retains the authoritative completed summary', async t => {
  const f = await fixture(t);
  await f.send('plan');
  const snapshot = async () => (await f.engine.command({ type: 'snapshot' })).snapshot.selected!;
  await until(() => f.clients[0]?.calls.some(call => call.method === 'turn/start'));
  const task = (await snapshot()).tasks[0];
  const emit = (method: string, params: object) => f.clients[0].options.onEvent({ method, params: { threadId: task.threadId, turnId: task.turnId, ...params } });
  const item = { id: 'thinking', type: 'reasoning', summary: [], content: [] };
  emit('item/started', { item });
  emit('item/reasoning/summaryTextDelta', { itemId: item.id, summaryIndex: 0, delta: '**Inspect' });
  emit('item/reasoning/summaryTextDelta', { itemId: item.id, summaryIndex: 0, delta: ' sources**' });
  emit('item/reasoning/summaryPartAdded', { itemId: item.id, summaryIndex: 1 });
  emit('item/reasoning/summaryTextDelta', { itemId: item.id, summaryIndex: 1, delta: 'Check the result.' });
  emit('item/reasoning/textDelta', { itemId: item.id, contentIndex: 0, delta: 'Native content.' });
  let entries = (await snapshot()).conversation!.filter(entry => entry.itemId === item.id);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].rawItem, { ...item, summary: ['**Inspect sources**', 'Check the result.'], content: ['Native content.'] });
  assert.equal(entries[0].text, '**Inspect sources**\n\nCheck the result.');
  const completed = { ...item, summary: ['Authoritative summary.'], content: [] };
  emit('item/completed', { item: completed });
  emit('item/reasoning/summaryTextDelta', { itemId: item.id, summaryIndex: 0, delta: 'stale' });
  emit('item/reasoning/summaryPartAdded', { itemId: item.id, summaryIndex: 2 });
  entries = (await snapshot()).conversation!.filter(entry => entry.itemId === item.id);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, 'Authoritative summary.');
  assert.deepEqual(entries[0].rawItem, completed);
  assert.equal(entries[0].status, 'completed');
});

test('native reply, plan and command output keep identity through completion, replay and reopen', async t => {
  const f = await fixture(t);
  await f.send('plan');
  const snapshot = async () => (await f.engine.command({ type: 'snapshot' })).snapshot.selected!;
  await until(() => f.clients[0]?.calls.some(call => call.method === 'turn/start'));
  const task = (await snapshot()).tasks[0], client = f.clients[0];
  const emit = (method: string, params: object) => client.options.onEvent({ method, params: { threadId: task.threadId, turnId: task.turnId, ...params } });
  const command = { id: 'shell', type: 'commandExecution', command: 'echo hello', status: 'inProgress', aggregatedOutput: '' };
  emit('item/started', { item: command });
  emit('item/commandExecution/outputDelta', { itemId: command.id, delta: 'hello\n' });
  assert.equal((await snapshot()).conversation!.find(entry => entry.itemId === command.id)!.text, 'echo hello\nhello\n');
  const completed = { ...command, status: 'completed', aggregatedOutput: 'hello\n', exitCode: 0 };
  emit('item/completed', { item: completed });
  assert.equal((await snapshot()).conversation!.find(entry => entry.itemId === command.id)!.text, 'echo hello\nhello\n');
  const plan = { id: 'plan-text', type: 'plan', text: '' };
  emit('item/started', { item: plan });
  emit('item/plan/delta', { itemId: plan.id, delta: 'Proposed plan' });
  assert.equal((await snapshot()).conversation!.find(entry => entry.itemId === plan.id)!.text, 'Proposed plan');
  const answer = { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: '' };
  emit('item/started', { item: answer });
  emit('item/agentMessage/delta', { itemId: answer.id, delta: '**Hello**' });
  assert.deepEqual((await snapshot()).conversation!.find(entry => entry.itemId === answer.id)!.rawItem, { ...answer, text: '**Hello**' });
  const finalItems = [completed, { ...plan, text: 'Authoritative plan' }, { ...answer, text: '**Hello world**' }];
  emit('turn/completed', { turn: { id: task.turnId, status: 'completed', items: finalItems } });
  emit('item/agentMessage/delta', { itemId: answer.id, delta: 'late' });
  client.port.rpc = async () => ({ data: finalItems.map(item => ({ turnId: task.turnId, item })), nextCursor: null });
  const replay = (await f.engine.command({ type: 'read_history', projectId: f.projectId, nodeId: 'plan' })).snapshot.selected!;
  for (const item of finalItems) {
    const entries = replay.conversation!.filter(entry => entry.itemId === item.id);
    assert.equal(entries.length, 1); assert.deepEqual(entries[0].rawItem, item);
  }
  await f.engine.close();
  const reopened = new WorkflowEngine({ workbenchRoot: f.root, executable: 'unused', nativeFactory() { assert.fail('completed history must reopen without starting a model'); } });
  t.after(() => reopened.close()); await reopened.init();
  const restored = (await reopened.command({ type: 'snapshot', projectId: f.projectId })).snapshot.selected!;
  for (const item of finalItems) assert.deepEqual(restored.conversation!.filter(entry => entry.itemId === item.id), replay.conversation!.filter(entry => entry.itemId === item.id));
});

test('shared conversation renders native thoughts and Markdown without host audit cards or empty replies', () => {
  const native = (id: string, direction: ConversationEntry['direction'], item: any, text: string): ConversationEntry => ({ id, seq: 1, nodeId: 'plan', taskId: null, threadId: 'thread', turnId: 'turn', itemId: id, direction, source: { kind: 'node', nodeId: 'plan' }, content: item, rawItem: item, text, createdAt: '', status: 'completed' });
  const entries = [
    native('audit', 'event', { type: 'executionProvenance' }, '执行来源：host audit'),
    native('permissions', 'event', { type: 'sessionConfiguration' }, '原生会话权限：workspaceWrite'),
    native('thought', 'output', { type: 'reasoning', summary: ['**Inspect sources**'], content: [] }, ''),
    native('answer', 'output', { type: 'agentMessage', text: '## Result\n\n**Ready**\n\n- One\n- Two', phase: 'final_answer' }, '## Result\n\n**Ready**\n\n- One\n- Two'),
    native('empty', 'output', { type: 'agentMessage', text: '' }, ''),
    native('shell', 'event', { type: 'commandExecution', command: 'echo hello', aggregatedOutput: 'hello\n', status: 'completed' }, 'echo hello\nhello\n'),
  ];
  const before = structuredClone(entries);
  for (const projectTimeline of [false, true]) {
    const html = renderToStaticMarkup(createElement(ConversationFeed, { entries, nodes: [], projectTimeline, onOpen() {} }));
    assert.doesNotMatch(html, /执行来源|原生会话权限|执行记录|原生会话记录|data-entry-id="empty"/);
    assert.match(html, /<details class="native-reasoning"/);
    assert.match(html, /<strong>Inspect sources<\/strong>/);
    assert.match(html, /<h2>Result<\/h2>/); assert.match(html, /<strong>Ready<\/strong>/); assert.match(html, /<li>One<\/li>/);
    assert.match(html, /data-native-phase="final_answer"/);
    assert.match(html, /<details class="native-tool"/); assert.match(html, /hello/); assert.match(html, /completed/);
  }
  assert.deepEqual(entries, before);
});

test('partial native thinking survives disconnect with an accurate task warning and no invented deltas', async t => {
  const f = await fixture(t); await f.send('plan');
  await until(() => f.clients[0]?.calls.some(call => call.method === 'turn/start'));
  const task = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!.tasks[0], client = f.clients[0];
  const params = { threadId: task.threadId, turnId: task.turnId, itemId: 'partial' };
  client.options.onEvent({ method: 'item/started', params: { ...params, item: { id: 'partial', type: 'reasoning', summary: [], content: [] } } });
  client.options.onEvent({ method: 'item/reasoning/textDelta', params: { ...params, contentIndex: 0, delta: 'Native partial text.' } });
  client.options.onEvent({ method: 'item/reasoning/textDelta', params: { ...params, contentIndex: 1, delta: 'Next native block.' } });
  client.options.onEvent({ method: 'item/unknown/delta', params: { ...params, itemId: 'unsupported', delta: 'invented output' } });
  client.options.onDisconnect('Native connection lost');
  const snapshot = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!;
  assert.equal(snapshot.conversation!.find(entry => entry.itemId === 'partial')!.text, 'Native partial text.\n\nNext native block.');
  assert.equal(snapshot.conversation!.some(entry => entry.itemId === 'unsupported'), false);
  assert.equal(snapshot.tasks[0].status, 'needs_reconciliation');
  const html = renderToStaticMarkup(createElement(ConversationFeed, { entries: snapshot.conversation!, nodes: snapshot.nodes, tasks: snapshot.tasks, onOpen() {} }));
  assert.match(html, /Native partial text/); assert.match(html, /状态待核对/); assert.doesNotMatch(html, /正在思考/);
});
