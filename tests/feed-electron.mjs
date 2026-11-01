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
    assert.equal(await f.evaluate('document.querySelectorAll(".feed-detail-columns").length'), 0);
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

test('single Codex transcript contains long results and history while the composer stays fixed', async t => {
  const f = await openFeedFixture(t), evidence = projectDirectory(resolve('.'), '.runtime', 'feed-codex-layout');
  const a = await createCollection(f, '单列会话验收');
  await f.engine.command({ type: 'stop_feed_run', runId: a.runId, requestId: 'scroll-stop' });
  await f.engine.command({ type: 'continue_feed_queue', collectionId: a.collectionId, requestId: 'scroll-idle' });
  const idle = (await f.engine.command({ type: 'get_feed_collection', collectionId: a.collectionId })).feed.collection.collection;
  await f.engine.command({ type: 'edit_feed_collection', collectionId: a.collectionId, expectedRevision: idle.revision, requestId: 'scroll-goal', changes: { instruction: '每天关注公开技术动态。\n保留完整资料与来源。' } });
  f.engine.feed.service.store.transaction(() => {
    for (let i = 0; i < 60; i++) f.engine.feed.collections.historySave({ id: `scroll-history-${i}`, seq: 0, collectionId: a.collectionId, runId: a.runId, threadId: null, turnId: null, itemId: null, source: 'assistant', text: `历史消息 ${i}\n\n` + '用于滚动验收的公开合成会话。\n\n'.repeat(6), createdAt: new Date(1793260800000 + i).toISOString(), completed: true, revision: 1 });
    for (let i = 0; i < 50; i++) saveResult(f, a, `历史结果 ${i}`);
    saveResult(f, a, '较长完整结果', Array.from({ length: 70 }, (_, i) => `第 ${i} 段公开合成结果。` + '完整内容可以继续阅读。'.repeat(8)).join('\n\n'));
  });
  f.engine.feed.changed(); await openCollection(f, '单列会话验收');
  await f.poll(() => f.evaluate('document.querySelectorAll(".feed-message").length>=50&&document.querySelectorAll(".feed-result").length===50'));
  const state = () => f.evaluate(`(() => {
    const shape = selector => { const e=document.querySelector(selector),r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,scrollTop:e.scrollTop,clientHeight:e.clientHeight,scrollHeight:e.scrollHeight,visible:r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth,hittable:e.contains(document.elementFromPoint(x,y))}; };
    return {outer:[scrollY,document.documentElement.scrollTop,document.body.scrollTop,...['.app-content','.feed-workspace','.feed-collection','.feed-conversation'].map(s=>document.querySelector(s).scrollTop)],history:shape('.feed-conversation-history'),form:shape('.feed-message-form'),textarea:shape('.feed-message-form textarea'),send:shape('.feed-send')};
  })()`);
  const usable = value => { for (const name of ['textarea','send']) { assert(value[name].visible, `${name} outside viewport`); assert(value[name].hittable, `${name} clipped or covered`); } assert(value.history.clientHeight>=200,'transcript is too short'); assert.deepEqual(value.outer,[0,0,0,0,0,0,0]); };
  const wheel = async deltaY => { const point=await f.evaluate('(()=>{const r=document.querySelector(".feed-conversation-history").getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()');await f.rpc('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaX:0,deltaY});await f.evaluate('new Promise(done=>setTimeout(done,150))'); };
  for (const [width,height] of [[1460,850],[1100,850],[850,850],[1100,720],[850,720]]) {
    await f.rpc('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    const before = await state(); usable(before);
    assert.equal(await f.evaluate('document.querySelectorAll(".feed-detail-columns,.feed-composer-link").length'),0);
    assert.equal(await f.evaluate('[...document.querySelectorAll(".feed-collection button,.feed-collection label,.feed-collection a")].some(e=>/继续沟通目标|同步原生历史/.test(e.textContent))'),false);
    await f.evaluate('document.querySelector(".feed-conversation-history").scrollTop=0');
    const top=await state(); await wheel(180);const moved=await state();usable(moved);
    assert(moved.history.scrollTop>top.history.scrollTop,'transcript did not scroll'); assert.equal(moved.form.top,top.form.top);
    for (const edge of ['top','bottom']) {
      await f.evaluate(`(()=>{const e=document.querySelector('.feed-conversation-history');e.scrollTop=${edge==='top'?'0':'e.scrollHeight'};})()`);
      const boundary=await state();await wheel(edge==='top'?-560:560);const after=await state();usable(after);
      assert(Math.abs(after.history.scrollTop-boundary.history.scrollTop)<=1,`${edge} wheel escaped transcript`);assert.equal(after.form.top,boundary.form.top);
    }
    await f.fill('[aria-label="继续沟通目标"]',`${width}×${height} 的草稿可编辑`);
    await f.screenshot(`codex-${width}-${height}.png`);copyFileSync(join(f.fixture,`codex-${width}-${height}.png`),join(evidence,`codex-${width}-${height}.png`));
    writeFileSync(join(evidence,`codex-${width}-${height}.json`),JSON.stringify(await state(),null,2));
  }
  await f.click('.feed-conversation-history button','加载更早对话');await f.poll(()=>f.evaluate('document.querySelectorAll(".feed-message").length>=60'));
  await f.click('.feed-conversation-history button','加载更多结果');await f.poll(()=>f.evaluate('document.querySelectorAll(".feed-result").length===51'));
  await f.click('.feed-plan summary');assert.equal(await f.evaluate('document.querySelector(".feed-plan").open'),true);usable(await state());
  const c=(await f.engine.command({type:'get_feed_collection',collectionId:a.collectionId})).feed.collection.collection;
  await f.engine.command({type:'edit_feed_collection',collectionId:a.collectionId,expectedRevision:c.revision,requestId:'long-goal',changes:{instruction:'公开合成的较长目标。\n'.repeat(60)}});
  for(let i=0;i<12;i++)await f.engine.command({type:'send_feed_message',collectionId:a.collectionId,requestId:`queue-${i}`,input:{text:'较长待执行输入。'.repeat(50)}});
  await f.poll(()=>f.evaluate('document.querySelectorAll(".feed-queued").length===12'));usable(await state());
  await f.click('.feed-plan summary');await f.fill('[aria-label="继续沟通目标"]','用户右侧消息');await f.click('.feed-send');
  await f.poll(()=>f.evaluate('[...document.querySelectorAll(".feed-message-user")].some(e=>e.textContent.includes("用户右侧消息"))'));
  assert(await f.evaluate('(()=>{const e=[...document.querySelectorAll(".feed-message-user")].find(e=>e.textContent.includes("用户右侧消息")),r=e.getBoundingClientRect(),p=e.parentElement.getBoundingClientRect();return r.left>p.left&&Math.abs(r.right-p.right)<2})()'));
  await f.rpc('Emulation.clearDeviceMetricsOverride');await f.screenshot('codex-single-column.png');copyFileSync(join(f.fixture,'codex-single-column.png'),join(evidence,'codex-single-column.png'));
  await f.click('.feed-back','返回信息流');
  for(let i=0;i<14;i++)await createCollection(f,`首页卡片 ${i}`);
  await f.poll(()=>f.evaluate('document.querySelectorAll(".feed-card").length===15'));
  await f.click('.feed-workspace button','新建采集');await f.fill('[aria-label="采集需求"]','新建仍可输入');await f.click('.feed-new form button','发送');
  await f.poll(()=>f.evaluate('document.querySelector(".feed-collection h2")?.textContent==="新建仍可输入"'));usable(await state());
});

test('older input pages retain user alignment and distinguish scheduled inputs beyond fifty runs', async t => {
  const f=await openFeedFixture(t),a=await createCollection(f,'历史发送方验收');
  const collections=f.engine.feed.collections;
  collections.enqueueRun(a.collectionId,{trigger:'schedule',text:'早期定时执行'},'older-schedule');
  for(let i=0;i<60;i++)collections.enqueue(a.collectionId,{text:`手动消息 ${i}`},'message',`older-user-${i}`);
  for(const run of collections.runs(a.collectionId)){run.status='completed';run.completedAt=new Date().toISOString();collections.saveRun(run);}
  f.engine.feed.changed();await openCollection(f,'历史发送方验收');
  await f.click('.feed-conversation-history button','加载更早对话');
  await f.poll(()=>f.evaluate('[...document.querySelectorAll(".feed-message-user")].some(e=>e.textContent.includes("手动消息 0"))'));
  assert(await f.evaluate('[...document.querySelectorAll(".feed-message-user")].some(e=>e.textContent.includes("沟通 历史发送方验收"))'));
  await f.poll(()=>f.evaluate('[...document.querySelectorAll(".feed-message")].some(e=>e.textContent.includes("早期定时执行")&&e.textContent.includes("定时执行")&&!e.classList.contains("feed-message-user"))'));
  assert.equal(await f.evaluate('[...document.querySelectorAll(".feed-message-user")].some(e=>e.textContent.includes("早期定时执行"))'),false);
});
