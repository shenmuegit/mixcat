import test from 'node:test';
import assert from 'node:assert/strict';
import { openFeedFixture, reloadFeed, createCollection, openCollection, storedForm } from './feed-electron-fixture.mjs';
const input = '[aria-label="采集需求"]';
async function compose(f, text) { await f.click('.feed-workspace button', '新建采集'); await f.fill(input, text); }

test('committed draft lost acknowledgement resolves its immutable request before newer typing and reload', async t => {
  const f = await openFeedFixture(t); await f.click('.feed-workspace button', '新建采集');
  f.rejectCommitted(c => c.type === 'save_feed_draft' && c.draft.key === 'collection:new'); await f.fill(input, '已经提交的 A');
  await f.poll(() => f.evaluate('document.body.textContent.includes("已提交但确认丢失")'));
  await f.fill(input, '确认丢失后新输入 B'); await f.click('.feed-workspace button', '重试保存草稿');
  await f.poll(async () => (await storedForm(f))?.fields.instruction === '确认丢失后新输入 B');
  await reloadFeed(f); await f.click('.feed-workspace button', '新建采集');
  await f.poll(() => f.evaluate('document.querySelector("[aria-label=采集需求]")?.value==="确认丢失后新输入 B"'));
});
test('cleanup acknowledgement cannot erase new edits and same-key remount retains them', async t => {
  const f = await openFeedFixture(t); await compose(f, '已提交目标');
  const held = f.hold(c => c.type === 'save_feed_draft' && c.draft.key === 'collection:new' && JSON.parse(c.draft.text).clean);
  await f.click('.feed-new form button', '发送'); await held.arrived;
  await f.click('.feed-new>button', '返回信息流'); await compose(f, '重开后的新目标'); held.release();
  await f.poll(async () => (await storedForm(f))?.fields.instruction === '重开后的新目标');
  assert.equal(await f.evaluate('document.querySelector("[aria-label=采集需求]").value'), '重开后的新目标');
  await reloadFeed(f); await f.click('.feed-workspace button', '新建采集');
  await f.poll(() => f.evaluate('document.querySelector("[aria-label=采集需求]")?.value==="重开后的新目标"'));
});
for (const phase of ['create', 'cleanup']) test(`late ${phase} cannot replace a newer collection selection`, async t => {
  const f = await openFeedFixture(t); await createCollection(f, '已选择的 B'); await compose(f, '迟到的 A');
  const held = f.hold(c => phase === 'create' ? c.type === 'create_feed_collection' : c.type === 'save_feed_draft' && c.draft.key === 'collection:new' && JSON.parse(c.draft.text).clean);
  await f.click('.feed-new form button', '发送'); await held.arrived;
  await f.click('.feed-new>button', '返回信息流'); await openCollection(f, '已选择的 B'); held.release();
  await f.poll(async () => !(await storedForm(f))?.pending);
  await f.fill('[aria-label="继续沟通目标"]', 'B 的独立输入');
  assert.equal(await f.evaluate('document.querySelector(".feed-collection h2").textContent'), '已选择的 B');
});
test('accepted create after remount keeps newer input and does not navigate', async t => {
  const f = await openFeedFixture(t); await compose(f, '原提交'); const held = f.hold(c => c.type === 'create_feed_collection');
  await f.click('.feed-new form button', '发送'); await held.arrived; await f.click('.feed-new>button', '返回信息流'); await compose(f, '重开的独立目标');
  await f.poll(async () => (await storedForm(f))?.fields.instruction === '重开的独立目标'); held.release();
  await f.poll(async () => !(await storedForm(f))?.pending);
  assert.equal(await f.evaluate('document.querySelector("[aria-label=采集需求]").value'), '重开的独立目标');
});
test('old remount acknowledgement cannot clear a replacement pending submission', async t => {
  const f = await openFeedFixture(t); await compose(f, '第一次提交'); const first = f.hold(c => c.type === 'create_feed_collection');
  await f.click('.feed-new form button', '发送'); await first.arrived;
  await f.click('.feed-new>button', '返回信息流'); await f.click('.feed-workspace button', '新建采集'); await f.click('.feed-new form button', '重试原提交');
  await f.poll(() => f.evaluate('!!document.querySelector(".feed-collection h2")')); await f.click('.feed-collection>header button', '返回信息流');
  await compose(f, '第二次提交'); const second = f.hold(c => c.type === 'create_feed_collection'); await f.click('.feed-new form button', '发送'); await second.arrived;
  const owned = (await storedForm(f)).pending;
  const refresh = f.hold(c => c.type === 'list_feed_collections'); first.release(); await refresh.arrived;
  assert.deepEqual((await storedForm(f)).pending, owned); assert.equal(await f.evaluate('document.querySelector("[aria-label=采集需求]").value'), '第二次提交');
  refresh.release(); second.release(); await f.poll(async () => !(await storedForm(f)).pending);
  assert.equal((await f.engine.command({ type: 'feed_snapshot' })).feed.snapshot.collections.length, 2);
});
test('oversized serialized draft can be shortened and recovered without a poisoned pending identity', async t => {
  const f = await openFeedFixture(t); await compose(f, 'A'.repeat(1000000));
  await f.poll(() => f.evaluate('!!document.querySelector(".feed-workspace [role=alert]")'));
  assert.equal(await storedForm(f), null);
  await f.fill(input, '缩短后的有效目标'); await f.click('.feed-workspace button', '重试保存草稿');
  await f.poll(async () => (await storedForm(f))?.fields.instruction === '缩短后的有效目标');
  await reloadFeed(f); await f.click('.feed-workspace button', '新建采集');
  await f.poll(() => f.evaluate('document.querySelector("[aria-label=采集需求]")?.value==="缩短后的有效目标"'));
  await f.click('.feed-new form button', '发送'); await f.poll(() => f.evaluate('!!document.querySelector(".feed-collection h2")'));
});

test('failed draft read remains recoverable without replacing the stored text', async t => {
  const f = await openFeedFixture(t);
  await f.engine.command({ type: 'save_feed_draft', draft: { key: 'collection:new', text: JSON.stringify({ fields: { instruction: '之前保存的输入' }, version: 1 }) }, expectedRevision: 0, requestId: 'read-recovery' });
  f.rejectCommitted(c => c.type === 'read_feed_draft' && c.key === 'collection:new'); await f.click('.feed-workspace button', '新建采集');
  await f.poll(() => f.evaluate('document.body.textContent.includes("已提交但确认丢失")')); await f.click('.feed-workspace button', '重试保存草稿');
  await f.poll(() => f.evaluate('document.querySelector("[aria-label=采集需求]")?.value==="之前保存的输入"'));
  await f.click('.feed-new form button', '发送'); await f.poll(() => f.evaluate('!!document.querySelector(".feed-collection h2")'));
});

test('a legacy pending create replays its original command instead of replacing it with the new chat payload', async t => {
  const f = await openFeedFixture(t);
  const command = { type: 'create_feed_collection', requestId: 'legacy-pending-command', name: '旧采集', instruction: '旧已提交说明', sourcePreferences: '公开来源', input: { text: '旧原文', materialEntryIds: [] }, trigger: 'collect' };
  const admitted = (await f.engine.command(command)).feed.admission;
  const legacy = { fields: { name: '旧采集', instruction: '下一份未提交文本', sourcePreferences: '公开来源', materials: [] }, version: 2, pending: { command, version: 1 } };
  await f.engine.command({ type: 'save_feed_draft', draft: { key: 'collection:new', text: JSON.stringify(legacy) }, expectedRevision: 0, requestId: 'legacy-pending-draft' });
  await f.click('.feed-workspace button', '新建采集'); await f.poll(() => f.evaluate('document.querySelector("[aria-label=采集需求]")?.value==="下一份未提交文本"'));
  await f.click('.feed-new form button', '重试原提交'); await f.poll(() => f.evaluate('document.querySelector(".feed-collection h2")?.textContent==="旧采集"'));
  assert.equal((await f.engine.command({ type: 'feed_snapshot' })).feed.snapshot.collections.length, 1);
  const runs = (await f.engine.command({ type: 'list_feed_runs', collectionId: admitted.collectionId })).feed.runs.items; assert.equal(runs.length, 1); assert.equal(runs[0].trigger, 'collect'); assert.equal(runs[0].inputSnapshot.text, '旧原文');
  assert.equal((await storedForm(f)).fields.instruction, '下一份未提交文本');
});
test('pre-acceptance rejection after remount preserves corrected text and permits a fresh send', async t => {
  const f = await openFeedFixture(t); await compose(f, 'A'.repeat(270000));
  const held = f.hold(c => c.type === 'create_feed_collection'); await f.click('.feed-new form button', '发送');
  assert.match((await held.arrived).error, /文字超过 256 KiB/);
  await f.click('.feed-new>button', '返回信息流'); await compose(f, '纠正后的有效目标');
  await f.poll(async () => (await storedForm(f)).fields.instruction === '纠正后的有效目标'); held.release();
  await f.poll(async () => !(await storedForm(f)).pending);
  assert.equal(await f.evaluate('document.querySelector("[aria-label=采集需求]").value'), '纠正后的有效目标');
  await f.click('.feed-new form button', '发送'); await f.poll(() => f.evaluate('!!document.querySelector(".feed-collection h2")'));
  assert.equal((await f.engine.command({ type: 'feed_snapshot' })).feed.snapshot.collections.length, 1);
});

for (const kind of ['new', 'message']) test(`failed first draft load blocks early edits and preserves pending identity in ${kind} composer`, async t => {
  const f = await openFeedFixture(t);
  const collection = kind === 'message' ? await createCollection(f, '读取恢复对话') : null;
  const key = collection ? `collection:${collection.collectionId}:message` : 'collection:new';
  const selector = collection ? '[aria-label="继续沟通目标"]' : input;
  const command = collection
    ? { type: 'send_feed_message', collectionId: collection.collectionId, input: { text: '持久原文 A' }, requestId: 'recovered-original-message' }
    : { type: 'create_feed_collection', name: '读取恢复采集', instruction: '', input: { text: '持久原文 A' }, trigger: 'message', requestId: 'recovered-original-create' };
  const saved = { fields: collection ? { text: '持久原文 A' } : { instruction: '持久原文 A' }, version: 1, pending: { command, version: 1 } };
  await f.engine.command({ type: 'save_feed_draft', draft: { key, text: JSON.stringify(saved) }, expectedRevision: 0, requestId: `seed-read-failure-${kind}` });
  f.rejectCommitted(c => c.type === 'read_feed_draft' && c.key === key);
  if (collection) await openCollection(f, '读取恢复对话'); else await f.click('.feed-workspace button', '新建采集');
  await f.poll(() => f.evaluate('document.body.textContent.includes("已提交但确认丢失")'));
  await f.fill(selector, '读取失败期间尝试输入 B');
  const earlyText = await f.evaluate(`document.querySelector(${JSON.stringify(selector)}).value`);
  await f.click('.feed-workspace button', '重试保存草稿');
  await f.poll(() => f.evaluate(`document.querySelector(${JSON.stringify(selector)})?.value==='持久原文 A'`));
  assert.equal(earlyText, '', 'An unread persisted draft must not accept text that the recovery read can overwrite');
  assert.deepEqual(await storedForm(f, key), saved);
  await f.fill(selector, '恢复后可编辑的新文本 B');
  await f.poll(async () => (await storedForm(f, key))?.fields[collection ? 'text' : 'instruction'] === '恢复后可编辑的新文本 B');
  assert.deepEqual((await storedForm(f, key)).pending, saved.pending);
  await f.click(collection ? '.feed-message-form button' : '.feed-new form button', collection ? '重试原消息' : '重试原提交');
  await f.poll(async () => !(await storedForm(f, key)).pending);
  assert.equal((await storedForm(f, key)).fields[collection ? 'text' : 'instruction'], '恢复后可编辑的新文本 B');
  const id = collection?.collectionId ?? (await f.engine.command({ type: 'feed_snapshot' })).feed.snapshot.collections[0].id;
  const runs = (await f.engine.command({ type: 'list_feed_runs', collectionId: id })).feed.runs.items;
  assert.equal(runs.filter(run => run.inputSnapshot.text === '持久原文 A').length, 1);
});
