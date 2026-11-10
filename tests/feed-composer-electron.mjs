import test from 'node:test';
import assert from 'node:assert/strict';
import { accountFixture } from './account-fixture.ts';
import { openFeedFixture } from './feed-electron-fixture.mjs';

async function enter(f, modifiers = 0) {
  for (const type of ['keyDown', 'keyUp']) await f.rpc('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers, ...(type === 'keyDown' ? { text: '\r' } : {}) });
}

test('feed Enter sends, IME does not send, and a queued message can steer the native turn', async t => {
  const account = accountFixture(), calls = []; let sequence = 0;
  const f = await openFeedFixture(t, { accountFactory: account.factory, nativeFactory(options) {
    return { async connect() {}, async close() {}, async rpc(method, params) {
      calls.push({ method, params });
      if (method === 'account/read') return { account: { email: 'fixture' } };
      if (method === 'model/list') return { data: [{ model: 'fixture-model', displayName: 'Fixture', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '' }], defaultReasoningEffort: 'medium' }], nextCursor: null };
      if (['skills/list', 'hooks/list', 'mcpServerStatus/list'].includes(method)) return { data: [], nextCursor: null };
      if (['plugin/list', 'plugin/installed'].includes(method)) return { marketplaces: [], marketplaceLoadErrors: [] };
      if (method === 'windowsSandbox/readiness') return { status: 'notConfigured' };
      if (['thread/start', 'thread/resume'].includes(method)) return { thread: { id: params.threadId ?? 'composer-thread' }, model: 'fixture-model', sandbox: { type: 'workspaceWrite' }, approvalPolicy: 'on-request' };
      if (method === 'turn/start') { const id = `composer-turn-${++sequence}`; options.onEvent({ method: 'turn/started', params: { threadId: params.threadId, turn: { id } } }); return { turn: { id } }; }
      if (method === 'turn/steer') { options.onEvent({ method: 'item/completed', params: { threadId: params.threadId, turnId: params.expectedTurnId, item: { type: 'userMessage', id: 'steered-native-item', clientId: params.clientUserMessageId, content: params.input } } }); return { turnId: params.expectedTurnId }; }
      return {};
    } };
  } });
  await f.click('.feed-workspace button', '新建采集');
  await f.fill('[aria-label="采集名称"]', '输入与插队');
  await f.fill('[aria-label="采集需求"]', '原始目标');
  await enter(f);
  await f.poll(() => f.evaluate('!!document.querySelector(".feed-collection")'));
  const collection = (await f.engine.command({ type: 'list_feed_collections' })).feed.collectionPage.items[0];
  await f.poll(async () => { const detail = (await f.engine.command({ type: 'get_feed_collection', collectionId: collection.id })).feed.collection; if (detail.attention.length) throw Error(JSON.stringify(detail.attention.map(run => ({ status: run.status, error: run.error })))); return detail.activeRun?.status === 'running'; });
  assert.equal(await f.evaluate('document.querySelector(".feed-message-form").innerText.includes("发送后排队")'), false);
  const selector = '[aria-label="继续沟通目标"]';
  await f.fill(selector, '第一行'); await enter(f, 2);
  await f.rpc('Input.insertText', { text: '第二行' });
  assert.equal(await f.evaluate(`document.querySelector('${selector}').value`), '第一行\n第二行');
  const before = (await f.engine.command({ type: 'list_feed_runs', collectionId: collection.id })).feed.runs.items.length;
  for (const keyCode of [13, 229]) await f.evaluate(`document.querySelector('${selector}').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:${keyCode},isComposing:${keyCode === 13},bubbles:true,cancelable:true}))`);
  assert.equal((await f.engine.command({ type: 'list_feed_runs', collectionId: collection.id })).feed.runs.items.length, before);
  await enter(f);
  await f.poll(() => f.evaluate('document.querySelectorAll(".feed-queued").length===1'));
  assert.equal(calls.filter(call => call.method === 'turn/start').length, 1);
  await f.click('.feed-queued button', '插队');
  await f.poll(() => f.evaluate('document.querySelectorAll(".feed-queued").length===0'));
  assert.equal(calls.filter(call => call.method === 'turn/steer').length, 1);
  assert.equal(calls.find(call => call.method === 'turn/steer').params.input[0].text, '第一行\n第二行');
  assert.equal(calls.filter(call => call.method === 'turn/start').length, 1);
  assert.equal(calls.filter(call => call.method === 'turn/interrupt').length, 0);
  assert.equal(await f.evaluate('document.querySelectorAll("[data-feed-item=\\"steered-native-item\\"]").length'), 0, 'native item is merged into the existing input');
  const gate = f.hold(command => command.type === 'send_feed_message');
  f.rejectCommitted(command => command.type === 'send_feed_message');
  await f.fill(selector, '确认丢失的消息'); await enter(f); await gate.arrived;
  await f.fill(selector, '发送期间的新草稿'); await enter(f);
  assert.equal((await f.engine.command({ type: 'list_feed_runs', collectionId: collection.id })).feed.runs.items.length, 3, 'busy Enter does not submit the newer draft');
  gate.release();
  await f.poll(() => f.evaluate('document.querySelector(".feed-send").getAttribute("aria-label")==="重试原消息"&&!document.querySelector(".feed-send").disabled'));
  await enter(f);
  await f.poll(() => f.evaluate('document.querySelector(".feed-send").getAttribute("aria-label")==="发送"'));
  assert.equal((await f.engine.command({ type: 'list_feed_runs', collectionId: collection.id })).feed.runs.items.length, 3);
  assert.equal(await f.evaluate(`document.querySelector('${selector}').value`), '发送期间的新草稿');
  await f.fill(selector, ''); await enter(f);
  assert.equal((await f.engine.command({ type: 'list_feed_runs', collectionId: collection.id })).feed.runs.items.length, 3, 'empty Enter does not send');
  await f.fill(selector, '保留草稿');
  for (const [width, height] of [[1460, 850], [850, 720]]) {
    await f.rpc('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    assert.equal(await f.evaluate('document.documentElement.scrollWidth>innerWidth'), false);
    await f.screenshot(`composer-${width}-${height}.png`);
  }
  console.log(JSON.stringify({ fixture: f.fixture, enter: 'passed', ime: 'passed', queue: 'passed', nativeSteering: 'passed' }));
});
