import assert from 'node:assert/strict';
import test from 'node:test';
import { feedFixture } from './feed-runtime-fixture.js';
import { until } from './runtime-fixture.js';

test('a queued message steers its active native turn once and is not dispatched again', async t => {
  let native: any;
  const f = await feedFixture(t, (method, params, options) => {
    if (method === 'turn/steer') {
      native = params;
      options.onEvent({ method: 'item/completed', params: { threadId: params.threadId, turnId: params.expectedTurnId, item: { id: 'native-steering-item', clientId: params.clientUserMessageId, type: 'userMessage', content: params.input } } });
      return { turnId: params.expectedTurnId };
    }
  });
  const first = (await f.create('steering')).admission!;
  const detail = async () => (await f.engine.command({ type: 'get_feed_collection', collectionId: first.collectionId })).collection!;
  await until(() => f.clients[0]?.calls.some(call => call.method === 'turn/start') === true);
  const active = (await detail()).activeRun!;
  const queued = (await f.engine.command({ type: 'send_feed_message', collectionId: first.collectionId, requestId: 'queue-message', input: { text: '优先说明当前进度' } })).admission!;
  assert.equal((await detail()).queuedCount, 1);
  const command = { type: 'steer_feed_run' as const, runId: queued.runId, activeRunId: active.id, requestId: 'steer-message' };
  const [accepted] = await Promise.all([f.engine.command(command), f.engine.command(command)]);
  assert.equal(accepted.run?.status, 'steered');
  assert.equal(accepted.run?.dispatchState, 'acknowledged');
  assert.deepEqual(native, { threadId: active.threadId, expectedTurnId: active.turnId, clientUserMessageId: queued.runId, input: [{ type: 'text', text: '优先说明当前进度', text_elements: [] }] });
  assert.equal((await detail()).activeRun?.id, active.id);
  assert.equal((await detail()).queuedCount, 0);
  const history = (await f.engine.command({ type: 'read_feed_history', collectionId: first.collectionId })).history!.items;
  assert.equal(history.filter(item => item.text === '优先说明当前进度').length, 1);
  assert.equal(history.find(item => item.itemId === 'native-steering-item')?.runId, active.id);
  await f.engine.command(command);
  assert.equal(f.clients[0].calls.filter(call => call.method === 'turn/steer').length, 1);
  f.clients[0].options.onEvent({ method: 'turn/completed', params: { threadId: active.threadId, turn: { id: active.turnId, status: 'completed', items: [] } } });
  await f.reopen();
  await f.engine.command(command);
  assert.equal((await detail()).activeRun, null);
  assert.equal(f.clients.flatMap(client => client.calls).filter(call => call.method === 'turn/start').length, 1);
});

test('unknown steering is never sent again and native history can confirm it after restart', async t => {
  let item: any, threadId: string, turnId: string;
  const f = await feedFixture(t, (method, params) => {
    if (method === 'turn/steer') {
      threadId = params.threadId; turnId = params.expectedTurnId;
      item = { id: 'unknown-steering-item', type: 'userMessage', clientId: params.clientUserMessageId, content: params.input };
      throw Object.assign(Error('lost native receipt'), { outcome: 'unknown' });
    }
    if (method === 'thread/read') return { thread: { id: threadId, turns: [{ id: turnId, status: 'completed', items: [item] }] } };
  });
  const first = (await f.create('uncertain-steering')).admission!;
  await until(() => f.clients[0]?.calls.some(call => call.method === 'turn/start') === true);
  const queued = (await f.engine.command({ type: 'send_feed_message', collectionId: first.collectionId, requestId: 'uncertain-message', input: { text: '不要重复插队' } })).admission!;
  const command = { type: 'steer_feed_run' as const, runId: queued.runId, activeRunId: first.runId, requestId: 'uncertain-steer' };
  assert.equal((await f.engine.command(command)).run?.dispatchState, 'unknown');
  assert((await f.engine.command({ type: 'get_feed_collection', collectionId: first.collectionId })).collection!.attention.some(run => run.id === queued.runId));
  await f.reopen(); await f.engine.command(command);
  const confirmed = (await f.engine.command({ type: 'reconcile_feed_run', runId: queued.runId, requestId: 'confirm-steering' })).run!;
  assert.equal(confirmed.dispatchState, 'acknowledged');
  assert.equal(f.clients.flatMap(client => client.calls).filter(call => call.method === 'turn/steer').length, 1);
  const history = (await f.engine.command({ type: 'read_feed_history', collectionId: first.collectionId })).history!.items;
  assert.equal(history.filter(entry => entry.text === '不要重复插队').length, 1);
});

test('native rejection retains queued input and stale or foreign targets never receive steering', async t => {
  const f = await feedFixture(t, method => { if (method === 'turn/steer') throw Object.assign(Error('turn already ended'), { code: -32000 }); });
  const first = (await f.create('reject-steering')).admission!;
  await until(() => f.clients[0]?.calls.some(call => call.method === 'turn/start') === true);
  const queued = (await f.engine.command({ type: 'send_feed_message', collectionId: first.collectionId, requestId: 'reject-message', input: { text: '保留输入' } })).admission!;
  const other = (await f.create('other-steering')).admission!;
  await assert.rejects(f.engine.command({ type: 'steer_feed_run', runId: queued.runId, activeRunId: other.runId, requestId: 'foreign-steer' }), /当前回合/);
  const rejected = (await f.engine.command({ type: 'steer_feed_run', runId: queued.runId, activeRunId: first.runId, requestId: 'reject-steer' })).run!;
  assert.equal(rejected.status, 'queued'); assert.equal(rejected.dispatchState, 'not_sent');
  assert.equal(rejected.inputSnapshot.text, '保留输入'); assert.match(rejected.error!, /未发送/);
  await f.engine.command({ type: 'stop_feed_run', runId: first.runId, requestId: 'stop-before-steer' });
  await assert.rejects(f.engine.command({ type: 'steer_feed_run', runId: queued.runId, activeRunId: first.runId, requestId: 'stale-steer' }), /当前回合/);
  assert.equal(f.clients[0].calls.filter(call => call.method === 'turn/steer').length, 1);
});
