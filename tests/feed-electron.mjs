import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { projectDirectory } from '../src/core/paths.ts';
import { openFeedFixture, openCollection, createCollection, storedForm, saveResult } from './feed-electron-fixture.mjs';

test('cards, first conversation, full result and continued goal conversation work with keyboard and narrow layout', async t => {
  const f = await openFeedFixture(t), evidence = projectDirectory(resolve('.'), '.runtime', 'implementation', 'feed', 'task11');
  await f.click('.feed-workspace button', '新建采集');
  await f.poll(() => f.evaluate('document.activeElement?.getAttribute("aria-label")==="采集需求"'));
  await f.fill('[aria-label="采集需求"]', '每天关注公开技术动态');
  await f.click('.feed-new>button', '返回信息流');
  await f.poll(() => f.evaluate('document.activeElement?.textContent==="新建采集"'));
  assert.equal((await f.engine.command({ type: 'feed_snapshot' })).feed.snapshot.collections.length, 0);
  await f.click('.feed-workspace button', '新建采集');
  assert.equal(await f.evaluate('document.querySelector("[aria-label=采集需求]").value'), '每天关注公开技术动态');
  await f.click('[aria-label="采集需求"]');
  await f.rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await f.rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await f.poll(() => f.evaluate('document.activeElement?.textContent==="发送"'));
  await f.rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await f.rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await f.poll(() => f.evaluate('!!document.querySelector(".feed-collection h2")'));
  const first = (await f.engine.command({ type: 'feed_snapshot' })).feed.snapshot.collections[0];
  const run = (await f.engine.command({ type: 'list_feed_runs', collectionId: first.id })).feed.runs.items[0];
  assert.equal(run.trigger, 'message'); assert.equal(run.inputSnapshot.text, '每天关注公开技术动态');
  assert.equal((await f.engine.command({ type: 'get_feed_collection', collectionId: first.id })).feed.collection.collection.instruction, '');
  await createCollection(f, '开源项目周报');
  const body = '## 本次公开资料整理\n\n**完整正文**\n\n<script>window.pwned=true</script>\n\n[危险](javascript:alert(1))\n\n| 来源 | 说明 |\n| --- | --- |\n| example.org | 公开示例 |\n\n```text\n' + 'long_line_'.repeat(60) + '\n```\n\n' + '这段是合成的公开验收资料。'.repeat(100) + '\n\n最终完整段落';
  saveResult(f, { collectionId: first.id, runId: run.id }, '今日技术动态', body); f.engine.feed.changed();
  await f.poll(() => f.evaluate('document.querySelector(".feed-results")?.textContent.includes("最终完整段落")'));
  assert.equal(await f.evaluate('window.pwned'), undefined); assert.equal(await f.evaluate('!!document.querySelector(".feed-results a[href^=javascript]")'), false);
  assert.equal(await f.evaluate('document.querySelector(".feed-results").textContent.includes("每天关注公开技术动态")'), false);
  await f.fill('[aria-label="继续沟通目标"]', '改为每周整理一次'); await f.click('.feed-message-form button', '发送');
  await f.poll(async () => (await f.engine.command({ type: 'list_feed_runs', collectionId: first.id })).feed.runs.items.length === 2);
  assert.equal((await f.engine.command({ type: 'feed_snapshot' })).feed.snapshot.collections.length, 2);
  await f.poll(() => f.evaluate('document.querySelector(".feed-conversation")?.textContent.includes("改为每周整理一次")'));
  assert.equal(await f.evaluate('document.querySelector(".feed-results").textContent.includes("改为每周整理一次")'), false);
  await f.evaluate('document.querySelector(".feed-workspace").scrollTop=0');
  await f.screenshot('detail-wide.png'); copyFileSync(join(f.fixture, 'detail-wide.png'), join(evidence, 'detail-wide.png'));
  for (const width of [1100, 850]) {
    await f.rpc('Emulation.setDeviceMetricsOverride', { width, height: 850, deviceScaleFactor: 1, mobile: false });
    await f.fill('[aria-label="继续沟通目标"]', `宽度 ${width} 可继续输入`);
    assert(await f.evaluate('document.documentElement.scrollWidth<=innerWidth+1'));
    assert(await f.evaluate('(()=>{const e=document.querySelector(".feed-collection");return e.scrollWidth<=e.clientWidth+1})()'));
    assert.equal(await f.evaluate('getComputedStyle(document.querySelector(".feed-detail-columns")).gridTemplateColumns.split(" ").length'), 1);
    await f.screenshot(`detail-${width}.png`); copyFileSync(join(f.fixture, `detail-${width}.png`), join(evidence, `detail-${width}.png`));
  }
  await f.rpc('Emulation.clearDeviceMetricsOverride');
  await f.click('.feed-collection>header button', '返回信息流');
  await f.poll(() => f.evaluate('document.querySelectorAll(".feed-card").length===2'));
  await f.poll(() => f.evaluate('[...document.querySelectorAll(".feed-card")].every(card=>Number(getComputedStyle(card).opacity)===1)'));
  await f.screenshot('home-wide.png'); copyFileSync(join(f.fixture, 'home-wide.png'), join(evidence, 'home-wide.png'));
  await openCollection(f, first.name); await f.click('.feed-collection>header button', '返回信息流');
  await f.poll(() => f.evaluate(`document.activeElement?.getAttribute('aria-label')===${JSON.stringify(first.name)}`));
  for (const removed of ['保存文本', '继续调研', '回收站', '搜索信息流', '运行记录', '能力设置']) assert.equal(await f.evaluate(`document.querySelector('.feed-workspace').textContent.includes(${JSON.stringify(removed)})`), false);
  console.log(JSON.stringify({ evidence }));
});

test('long results and Codex history scroll independently while the composer stays visible', async t => {
  const f = await openFeedFixture(t), evidence = projectDirectory(resolve('.'), '.runtime', 'scroll-fix');
  const a = await createCollection(f, '独立滚动验收');
  await f.engine.command({ type: 'stop_feed_run', runId: a.runId, requestId: 'scroll-stop' });
  await f.engine.command({ type: 'continue_feed_queue', collectionId: a.collectionId, requestId: 'scroll-idle' });
  const idle = (await f.engine.command({ type: 'get_feed_collection', collectionId: a.collectionId })).feed.collection.collection;
  await f.engine.command({ type: 'edit_feed_collection', collectionId: a.collectionId, expectedRevision: idle.revision, requestId: 'scroll-ordinary-goal', changes: { instruction: '每天关注公开技术动态。\n保留完整资料与来源。' } });
  f.engine.feed.service.store.transaction(() => {
    for (let i = 0; i < 60; i++) f.engine.feed.collections.historySave({ id: `scroll-history-${i}`, seq: 0, collectionId: a.collectionId, runId: a.runId, threadId: null, turnId: null, itemId: null, source: 'assistant', text: `历史消息 ${i}\n\n` + '用于独立滚动验收的公开合成会话。\n\n'.repeat(6), createdAt: new Date(1793260800000 + i).toISOString(), completed: true, revision: 1 });
    for (let i = 0; i < 50; i++) saveResult(f, a, `历史结果 ${i}`);
    saveResult(f, a, '较长完整结果', Array.from({ length: 70 }, (_, i) => `第 ${i} 段公开合成结果。` + '本段必须能够独立继续阅读。'.repeat(8)).join('\n\n'));
  });
  f.engine.feed.changed(); await openCollection(f, '独立滚动验收');
  await f.poll(() => f.evaluate('document.querySelectorAll(".feed-message").length>=50&&document.querySelectorAll(".feed-result").length===50'));
  const history = '.feed-conversation-history', results = '.feed-results';
  const state = () => f.evaluate(`(() => {
    const shape = selector => { const e=document.querySelector(selector)??(selector==='${history}'?document.querySelector('.feed-conversation'):null), r=e.getBoundingClientRect(), x=r.left+r.width/2, y=r.top+r.height/2; return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,scrollTop:e.scrollTop,clientHeight:e.clientHeight,scrollHeight:e.scrollHeight,visible:r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth,hittable:e.contains(document.elementFromPoint(x,y))}; };
    return {viewport:{width:innerWidth,height:innerHeight},outer:[scrollY,document.documentElement.scrollTop,document.body.scrollTop,...['.app-content','.feed-workspace','.feed-collection','.feed-detail-columns'].map(s=>document.querySelector(s).scrollTop)],header:shape('.feed-collection>header'),history:shape('${history}'),results:shape('${results}'),textarea:shape('.feed-message-form textarea'),send:shape('.feed-message-form button')};
  })()`);
  const assertUsableDetail = value => { for (const control of ['textarea', 'send']) { assert(value[control].visible, `${control} is outside the viewport`); assert(value[control].hittable, `${control} is clipped or covered`); } assert(value.history.clientHeight >= 90, 'conversation history is too short to read'); assert(value.results.clientHeight >= 100, 'results are too short to read'); };
  const wheel = async (selector, deltaY) => {
    const point = await f.evaluate(`(() => {const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),x=r.left+r.width/2,y=(Math.max(0,r.top)+Math.min(innerHeight,r.bottom))/2;return e.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`);
    assert(point, `${selector} cannot receive wheel input`);
    await f.rpc('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY });
    await f.evaluate('new Promise(done=>setTimeout(done,150))');
  };
  for (const [width, height] of [[1460, 850], [1100, 850], [850, 850], [1100, 720], [850, 720]]) {
    const size = `${width}-${height}`;
    await f.rpc('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    // Check before click/fill helpers can scroll an offscreen composer into view.
    const before = await state();
    writeFileSync(join(evidence, `scroll-${size}-before.json`), JSON.stringify(before, null, 2));
    await f.screenshot(`scroll-${size}-before.png`); copyFileSync(join(f.fixture, `scroll-${size}-before.png`), join(evidence, `scroll-${size}-before.png`));
    assertUsableDetail(before); assert(before.header.scrollHeight <= before.header.clientHeight, 'ordinary goal and plan are unnecessarily clipped');
    for (const [selector, target, opposite] of [[history, 'history', 'results'], [results, 'results', 'history']]) {
      await f.evaluate(`document.querySelector('${selector}').scrollTop=0`);
      const start = await state(); assert(start[target].scrollHeight > start[target].clientHeight);
      await wheel(selector, 180); const moved = await state();
      assert(moved[target].scrollTop > start[target].scrollTop, `${target} did not scroll`);
      assert.deepEqual(moved.outer, start.outer, `${target} wheel moved the outer workspace`);
      assert.deepEqual(moved[opposite], start[opposite], `${target} wheel moved the opposite pane`); assertUsableDetail(moved);
      for (const edge of ['top', 'bottom']) {
        await f.evaluate(`(()=>{const e=document.querySelector('${selector}');e.scrollTop=${edge === 'top' ? '0' : 'e.scrollHeight'};})()`);
        const boundary = await state(); await wheel(selector, edge === 'top' ? -560 : 560); const after = await state();
        assert.deepEqual(after.outer, boundary.outer, `${target} chained at its ${edge} boundary`);
        assert.deepEqual(after[opposite], boundary[opposite]); assert(Math.abs(after[target].scrollTop - boundary[target].scrollTop) <= 1, `${target} moved away from its ${edge} boundary`); assertUsableDetail(after);
      }
    }
    await f.fill('[aria-label="继续沟通目标"]', `${width}×${height} 的草稿仍可输入`);
    await f.click('.feed-composer-link'); assert.equal(await f.evaluate('document.activeElement?.tagName'), 'TEXTAREA');
    writeFileSync(join(evidence, `scroll-${size}-after.json`), JSON.stringify(await state(), null, 2));
    await f.screenshot(`scroll-${size}.png`); copyFileSync(join(f.fixture, `scroll-${size}.png`), join(evidence, `scroll-${size}.png`));
  }
  await f.click(`${history} button`, '加载更早对话');
  await f.poll(() => f.evaluate('document.querySelectorAll(".feed-message").length>=60'));
  await f.click(`${results} button`, '加载更多结果');
  await f.poll(() => f.evaluate('document.querySelectorAll(".feed-result").length===51'));
  assertUsableDetail(await state());
  const c = (await f.engine.command({ type: 'get_feed_collection', collectionId: a.collectionId })).feed.collection.collection;
  await f.engine.command({ type: 'edit_feed_collection', collectionId: a.collectionId, expectedRevision: c.revision, requestId: 'scroll-long-goal', changes: { instruction: '公开合成的较长采集目标。\n'.repeat(60) } });
  for (let i = 0; i < 12; i++) await f.engine.command({ type: 'send_feed_message', collectionId: a.collectionId, requestId: `scroll-queue-${i}`, input: { text: '较长的待执行输入。'.repeat(50) } });
  await f.poll(() => f.evaluate('document.querySelectorAll(".feed-queued").length===12'));
  await f.evaluate('document.querySelector(".feed-message-form textarea").style.height="800px"');
  assertUsableDetail(await state());
  writeFileSync(join(evidence, 'scroll-long-goal.json'), JSON.stringify(await state(), null, 2));
  await f.screenshot('scroll-long-goal.png'); copyFileSync(join(f.fixture, 'scroll-long-goal.png'), join(evidence, 'scroll-long-goal.png'));
  await f.rpc('Emulation.clearDeviceMetricsOverride');
  await f.click('.feed-collection>header button', '返回信息流');
  for (let i = 0; i < 14; i++) await createCollection(f, `首页滚动卡片 ${i}`);
  await f.poll(() => f.evaluate('document.querySelectorAll(".feed-card").length===15'));
  const homeBefore = await f.evaluate('document.querySelector(".feed-home").scrollTop'); await wheel('.feed-home', 560);
  assert(await f.evaluate(`document.querySelector('.feed-home').scrollTop>${homeBefore}`));
  assert.deepEqual(await f.evaluate('[scrollY,document.documentElement.scrollTop,document.body.scrollTop,document.querySelector(".feed-workspace").scrollTop]'), [0, 0, 0, 0]);
  await f.click('.feed-workspace button', '新建采集'); await f.fill('[aria-label="采集需求"]', '新建页面仍可输入');
  await f.evaluate('document.querySelector(".feed-new textarea").style.height="900px"');
  await f.click('.feed-new form button', '发送'); await f.poll(() => f.evaluate('document.querySelector(".feed-collection h2")?.textContent==="新建页面仍可输入"'));
  assertUsableDetail(await state());
  console.log(JSON.stringify({ evidence }));
});
