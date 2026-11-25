import test from 'node:test';
import assert from 'node:assert/strict';
import { openFeedFixture, createCollection, openCollection } from './feed-electron-fixture.mjs';

const input = '[aria-label="采集需求"]';
const value = f => f.evaluate('document.querySelector("[aria-label=采集需求]").value');
const sendLabel = f => f.evaluate('document.querySelector(".feed-new .feed-send")?.getAttribute("aria-label")');
async function compose(f, text) {
  await f.click('.feed-workspace button', '新建采集');
  await f.fill(input, text);
}

test('a lost create acknowledgement retries the accepted input once and preserves newer text', async t => {
  const f = await openFeedFixture(t);
  await compose(f, '已经提交的 A');
  f.rejectCommitted(command => command.type === 'create_feed_collection');
  await f.click('.feed-new form button', '发送');
  await f.poll(() => f.evaluate('document.querySelector(".feed-new [role=alert]")?.textContent.includes("确认丢失")'));
  await f.fill(input, '确认丢失后新输入 B');
  assert.equal(await value(f), '确认丢失后新输入 B');
  await f.click('.feed-new form button', '重试原提交');
  await f.poll(() => f.evaluate('document.querySelector(".feed-collection h2")?.textContent==="已经提交的 A"'));
  assert.equal((await f.engine.command({ type: 'feed_snapshot' })).feed.snapshot.collections.length, 1);
  await f.click('.feed-collection>header button', '返回信息流');
  await f.click('.feed-workspace button', '新建采集');
  assert.equal(await value(f), '确认丢失后新输入 B');
});

test('a late create acknowledgement cannot replace a newer collection selection', async t => {
  const f = await openFeedFixture(t);
  await createCollection(f, '已选择的 B');
  await compose(f, '迟到的 A');
  const held = f.hold(command => command.type === 'create_feed_collection');
  await f.click('.feed-new form button', '发送');
  await held.arrived;
  await openCollection(f, '已选择的 B');
  const refreshed = f.hold(command => command.type === 'list_feed_collections');
  held.release();
  await refreshed.arrived;
  refreshed.release();
  await f.fill('[aria-label="继续沟通目标"]', 'B 的独立输入');
  assert.equal(await f.evaluate('document.querySelector(".feed-collection h2").textContent'), '已选择的 B');
});

test('accepted create after remount keeps newer input and does not navigate', async t => {
  const f = await openFeedFixture(t);
  await compose(f, '原提交');
  const held = f.hold(command => command.type === 'create_feed_collection');
  await f.click('.feed-new form button', '发送');
  await held.arrived;
  await f.click('.feed-new>button', '返回信息流');
  await compose(f, '重开的独立目标');
  held.release();
  await f.poll(async () => await sendLabel(f) === '发送');
  assert.equal(await value(f), '重开的独立目标');
});

test('old remount acknowledgement cannot clear a replacement pending submission', async t => {
  const f = await openFeedFixture(t);
  await compose(f, '第一次提交');
  const first = f.hold(command => command.type === 'create_feed_collection');
  await f.click('.feed-new form button', '发送');
  await first.arrived;
  await f.click('.feed-new>button', '返回信息流');
  await f.click('.feed-workspace button', '新建采集');
  await f.click('.feed-new form button', '重试原提交');
  await f.poll(() => f.evaluate('!!document.querySelector(".feed-collection h2")'));
  await f.click('.feed-collection>header button', '返回信息流');
  await compose(f, '第二次提交');
  const second = f.hold(command => command.type === 'create_feed_collection');
  await f.click('.feed-new form button', '发送');
  await second.arrived;
  const refresh = f.hold(command => command.type === 'list_feed_collections');
  first.release();
  await refresh.arrived;
  assert.equal(await sendLabel(f), '重试原提交');
  assert.equal(await value(f), '第二次提交');
  refresh.release();
  second.release();
  await f.poll(() => f.evaluate('document.querySelector(".feed-collection h2")?.textContent==="第二次提交"'));
  assert.equal((await f.engine.command({ type: 'feed_snapshot' })).feed.snapshot.collections.length, 2);
});

test('a rejected oversized input can be shortened after remount and submitted once', async t => {
  const f = await openFeedFixture(t);
  await compose(f, 'A'.repeat(270000));
  const held = f.hold(command => command.type === 'create_feed_collection');
  await f.click('.feed-new form button', '发送');
  assert.match((await held.arrived).error, /文字超过 256 KiB/);
  await f.click('.feed-new>button', '返回信息流');
  await compose(f, '纠正后的有效目标');
  held.release();
  await f.poll(async () => await sendLabel(f) === '发送');
  assert.equal(await value(f), '纠正后的有效目标');
  await f.click('.feed-new form button', '发送');
  await f.poll(() => f.evaluate('document.querySelector(".feed-collection h2")?.textContent==="纠正后的有效目标"'));
  assert.equal((await f.engine.command({ type: 'feed_snapshot' })).feed.snapshot.collections.length, 1);
});
