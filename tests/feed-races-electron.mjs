import test from 'node:test';
import assert from 'node:assert/strict';
import { openFeedFixture } from './feed-electron-fixture.mjs';
const title = '[aria-label="文本标题"]', body = '[aria-label="文本内容"]', source = '[aria-label="来源链接"]';
async function compose(f, values) { await f.click('.feed-workspace button', '保存文本'); for (const [selector, value] of [[title, values.title], [body, values.body], [source, values.sourceUrl ?? '']]) await f.fill(selector, value); }
async function values(f) { return f.evaluate(`Object.fromEntries([['title',${JSON.stringify(title)}],['body',${JSON.stringify(body)}],['sourceUrl',${JSON.stringify(source)}]].map(([key,selector])=>[key,document.querySelector(selector)?.value]))`); }
async function reopen(f) { const origin = await f.evaluate('performance.timeOrigin'); await f.rpc('Page.reload'); await f.poll(async () => { try { return await f.evaluate(`performance.timeOrigin !== ${origin} && document.readyState === 'complete' && !!document.querySelector('.workspace-sidebar nav')`); } catch (error) { if (/Execution context|Cannot find context|Inspected target navigated or closed/i.test(String(error))) return false; throw error; } }); await f.click('.workspace-sidebar nav button', '信息流'); await f.click('.feed-workspace button', '保存文本'); }
async function save(f, title, body, sourceUrl) { return (await f.engine.command({ type: 'update_feed_entry', mutation: { operation: 'createText', input: { title, body, coverage: 'full', ...(sourceUrl ? { sourceUrl } : {}) }, requestId: crypto.randomUUID() } })).feed.entry; }

test('tombstone rejection retains all submitted fields across reload', async t => {
  const f = await openFeedFixture(t), url = 'https://example.org/tombstone';
  const original = await save(f, '已删除的来源', '旧正文', url);
  await f.engine.command({ type: 'update_feed_entry', mutation: { operation: 'delete', id: original.id, expectedRevision: original.revision, requestId: 'delete-original' } });
  const input = { title: '尚未接受的新标题', body: '尚未接受的新正文', sourceUrl: url };
  await compose(f, input); await f.click('.feed-compose button', '保存到信息流');
  await f.poll(() => f.evaluate("document.querySelector('.feed-workspace').textContent.includes('该来源已在回收站')"));
  assert.deepEqual(await values(f), input);
  await reopen(f); await f.poll(async () => (await values(f)).body === input.body); assert.deepEqual(await values(f), input);
  assert((await f.engine.command({ type: 'get_feed_entry', entryId: original.id })).feed.entry.deletedAt);
  await f.screenshot('tombstone-retained.png');
});

test('cleanup acknowledgements cannot erase edits made after atomic consumption', async t => {
  const f = await openFeedFixture(t);
  await compose(f, { title: '已接受标题', body: '已接受正文', sourceUrl: 'https://example.org/accepted' });
  const clearing = f.hold(command => command.type === 'save_feed_draft' && command.draft.key === 'manual' && command.draft.text === '');
  await f.click('.feed-compose button', '保存到信息流'); await clearing.arrived;
  await f.fill(title, '下一条的新标题'); await f.fill(source, 'https://example.org/next'); clearing.release();
  await f.poll(async () => (await f.engine.command({ type: 'read_feed_draft', key: 'manual:sourceUrl' })).feed.draft?.text === 'https://example.org/next');
  assert.deepEqual(await values(f), { title: '下一条的新标题', body: '', sourceUrl: 'https://example.org/next' });
  await reopen(f); await f.poll(async () => (await values(f)).title === '下一条的新标题');
  assert.deepEqual(await values(f), { title: '下一条的新标题', body: '', sourceUrl: 'https://example.org/next' });
  await f.screenshot('cleanup-new-edits.png');
});

test('a committed draft with lost acknowledgement resolves its immutable request before newer typing', async t => {
  const f = await openFeedFixture(t);
  await f.click('.feed-workspace button', '保存文本');
  f.rejectCommitted(command => command.type === 'save_feed_draft' && command.draft.key === 'manual');
  await f.fill(body, '已经提交的 A');
  await f.poll(() => f.evaluate("document.querySelector('.feed-workspace').textContent.includes('已提交但确认丢失')"));
  await f.fill(body, '确认丢失后新输入 B'); await f.click('.feed-workspace button', '重试保存草稿');
  await f.poll(async () => (await f.engine.command({ type: 'read_feed_draft', key: 'manual' })).feed.draft?.text === '确认丢失后新输入 B');
  await reopen(f); await f.poll(async () => (await values(f)).body === '确认丢失后新输入 B');
  await f.screenshot('lost-ack-latest-recovered.png');
});

test('page two stays loaded through read and note mutations and restores narrow reader focus', async t => {
  const f = await openFeedFixture(t);
  for (let index = 0; index < 65; index++) await save(f, `分页资料 ${String(index).padStart(2, '0')}`, '分页正文');
  await f.fill('[aria-label="搜索信息流"]', '分页资料');
  await f.poll(() => f.evaluate("document.querySelectorAll('.feed-title').length===50"));
  await f.click('.feed-list button', '加载更多');
  await f.poll(() => f.evaluate("document.querySelectorAll('.feed-title').length===65"));
  await f.rpc('Emulation.setDeviceMetricsOverride', { width: 1100, height: 850, deviceScaleFactor: 1, mobile: false });
  await f.evaluate("[...document.querySelectorAll('.feed-title')].find(button=>button.textContent==='分页资料 00').scrollIntoView({block:'nearest'})");
  const position = await f.evaluate("document.querySelector('.feed-list').scrollTop"); assert(position > 0);
  await f.click('.feed-title', '分页资料 00');
  await f.poll(() => f.evaluate("document.querySelector('.feed-reader')?.textContent.includes('标为未读')"));
  assert.equal(await f.evaluate("document.querySelectorAll('.feed-title').length"), 65);
  await f.fill('[aria-label="个人备注"]', '第二页的备注');
  await f.poll(async () => (await f.engine.command({ type: 'search_feed_entries', query: { text: '第二页的备注' } })).feed.entries.items.length === 1);
  await f.click('.feed-reader button', '返回列表');
  await f.poll(() => f.evaluate("document.activeElement?.textContent==='分页资料 00'"));
  assert.equal(await f.evaluate("document.querySelectorAll('.feed-title').length"), 65);
  assert.equal(await f.evaluate("document.querySelector('.feed-list').scrollTop"), position);
  await f.screenshot('pagination-return.png');
});

for (const phase of ['create', 'cleanup']) test(`late ${phase} response cannot replace newer reader navigation`, async t => {
  const f = await openFeedFixture(t), other = await save(f, '已选择的另一条 B', 'B 正文');
  await f.fill('[aria-label="搜索信息流"]', '另一条'); await f.poll(() => f.evaluate("document.querySelectorAll('.feed-title').length===1"));
  await compose(f, { title: '迟到的创建结果', body: '新正文' });
  const held = f.hold(command => phase === 'create' ? command.type === 'update_feed_entry' && command.mutation.operation === 'createText' : command.type === 'save_feed_draft' && command.draft.key === 'manual' && command.draft.text === '');
  await f.click('.feed-compose button', '保存到信息流'); await held.arrived;
  await f.click('.feed-compose button', '返回信息流'); await f.click('.feed-title', '已选择的另一条 B');
  await f.poll(() => f.evaluate("document.querySelector('.feed-reader h2')?.textContent==='已选择的另一条 B'"));
  held.release();
  await f.poll(async () => (await f.engine.command({ type: 'read_feed_draft', key: 'manual:title' })).feed.draft?.text === '');
  await f.click('.feed-reader button', '收藏');
  await f.poll(async () => (await f.engine.command({ type: 'get_feed_entry', entryId: other.id })).feed.entry.starred);
  assert.equal(await f.evaluate("document.querySelector('.feed-reader h2')?.textContent"), '已选择的另一条 B');
  await f.screenshot(`late-${phase}-navigation.png`);
});

test('duplicate source with different text retains the unaccepted title body and source', async t => {
  const f = await openFeedFixture(t), url = 'https://example.org/duplicate';
  const original = await save(f, '已有标题', '已有正文', url);
  const input = { title: '不同的新标题', body: '不同的新正文', sourceUrl: url };
  await compose(f, input); await f.click('.feed-compose button', '保存到信息流');
  await f.poll(() => f.evaluate("document.querySelector('.feed-workspace').textContent.includes('该来源已有不同内容')"));
  assert.deepEqual(await values(f), input);
  await reopen(f); await f.poll(async () => (await values(f)).body === input.body); assert.deepEqual(await values(f), input);
  assert.equal((await f.engine.command({ type: 'get_feed_entry', entryId: original.id })).feed.entry.body, '已有正文');
  await f.screenshot('duplicate-retained.png');
});

test('oversized serialized draft can be shortened retried and recovered through CommandDispatcher', async t => {
  const f = await openFeedFixture(t);
  await f.click('.feed-workspace button', '保存文本');
  await f.fill(body, 'A'.repeat(1000000));
  await f.poll(() => f.evaluate("!!document.querySelector('.feed-workspace [role=alert]')"));
  assert.equal((await f.engine.command({ type: 'read_feed_draft', key: 'manual' })).feed.draft, null);
  await f.fill(body, '缩短后的有效 B'); await f.click('.feed-workspace button', '重试保存草稿');
  await f.poll(async () => (await f.engine.command({ type: 'read_feed_draft', key: 'manual' })).feed.draft?.text === '缩短后的有效 B');
  await reopen(f); await f.poll(async () => (await values(f)).body === '缩短后的有效 B');
  await f.screenshot('transport-rejected-shortened-recovered.png');
});
