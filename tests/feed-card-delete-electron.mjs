import test from 'node:test';
import assert from 'node:assert/strict';
import { openFeedFixture, createCollection, openCollection, saveResult, reloadFeed } from './feed-electron-fixture.mjs';

test('feed card mouse and keyboard menu supports cancellation and permanent delete retry', async t => {
  const f = await openFeedFixture(t), a = await createCollection(f, '卡片删除验收');
  const saved = saveResult(f, a, '本次执行结果', '本次执行的完整结果。');
  const c = (await f.engine.command({ type: 'get_feed_collection', collectionId: a.collectionId })).feed.collection.collection;
  await f.engine.command({ type: 'set_feed_schedule', collectionId: c.id, expectedRevision: c.revision, requestId: 'card-schedule', schedule: { frequency: 'daily', time: '09:00', timeZone: 'Asia/Shanghai', enabled: true } });
  await f.poll(() => f.evaluate('!!document.querySelector(".feed-card")'));
  const key = async (key, modifiers = 0) => { for (const type of ['keyDown', 'keyUp']) await f.rpc('Input.dispatchKeyEvent', { type, key, code: key, modifiers, windowsVirtualKeyCode: { ContextMenu: 93, Escape: 27, F10: 121, Enter: 13 }[key] }); };
  const rightClick = async () => {
    const point = await f.evaluate('(()=>{const r=document.querySelector(".feed-card").getBoundingClientRect();return{x:r.right-8,y:r.bottom-8}})()');
    for (const type of ['mousePressed', 'mouseReleased']) await f.rpc('Input.dispatchMouseEvent', { type, ...point, button: 'right', clickCount: 1 });
    await f.poll(() => f.evaluate('!!document.querySelector("[aria-label=信息流操作]")'));
  };
  await rightClick();
  assert.equal(await f.evaluate('document.activeElement?.textContent'), '编辑信息流');
  assert(await f.evaluate('(()=>{const r=document.querySelector("[role=menu]").getBoundingClientRect();return r.right<=innerWidth&&r.bottom<=innerHeight&&r.left>=0&&r.top>=0})()'));
  await key('Escape'); assert.equal(await f.evaluate('document.activeElement?.classList.contains("feed-card")'), true);
  await key('F10', 8); await f.click('[role=menuitem]', '删除信息流');
  await f.poll(() => f.evaluate('!!document.querySelector("dialog[open]")'));
  assert.equal(await f.evaluate('document.activeElement?.textContent'), '取消');
  await f.click('dialog button', '取消');
  await f.poll(() => f.evaluate('document.activeElement?.classList.contains("feed-card")'));
  assert.equal((await f.engine.command({ type: 'get_feed_collection', collectionId: c.id })).feed.collection.collection.id, c.id);
  await openCollection(f, '卡片删除验收');
  await f.evaluate('document.querySelector(".sidebar-feed-item").focus()');
  await key('ContextMenu'); await f.click('[role=menuitem]', '删除信息流');
  f.rejectCommitted(command => command.type === 'delete_feed_collection'); await f.click('dialog button', '永久删除');
  await f.poll(() => f.evaluate('document.querySelector("dialog")?.textContent.includes("确认丢失")'));
  await f.click('dialog button', '重试删除');
  await f.poll(() => f.evaluate('!document.querySelector("dialog[open]")&&!document.querySelector(".feed-card")'));
  await assert.rejects(f.engine.command({ type: 'get_feed_collection', collectionId: c.id }), /不存在/);
  await assert.rejects(f.engine.command({ type: 'get_feed_entry', entryId: saved.entryId }), /不存在/);
  await reloadFeed(f); assert.equal(await f.evaluate('document.querySelectorAll(".feed-card").length'), 0);
  await f.screenshot('feed-card-deleted.png');
});

test('card context menu stays inside the viewport at its right edge and dismisses outside', async t => {
  const f=await openFeedFixture(t);
  for(let i=0;i<3;i++)await createCollection(f,`边缘卡片 ${i}`);
  await f.poll(()=>f.evaluate('document.querySelectorAll(".feed-card").length===3'));
  const point=await f.evaluate('(()=>{const cards=[...document.querySelectorAll(".feed-card")],e=cards.sort((a,b)=>b.getBoundingClientRect().right-a.getBoundingClientRect().right)[0],r=e.getBoundingClientRect();return{x:r.right-3,y:r.top+r.height/2}})()');
  for(const type of ['mousePressed','mouseReleased'])await f.rpc('Input.dispatchMouseEvent',{type,...point,button:'right',clickCount:1});
  await f.poll(()=>f.evaluate('!!document.querySelector("[aria-label=信息流操作]")'));
  assert(await f.evaluate('(()=>{const r=document.querySelector("[role=menu]").getBoundingClientRect();return r.right<=innerWidth&&r.bottom<=innerHeight&&r.left>=0&&r.top>=0})()'),'edge menu escaped viewport');
  await f.screenshot('feed-menu-edge.png');
  await f.click('.feed-workspace>.page-heading h1');await f.poll(()=>f.evaluate('!document.querySelector("[role=menu]")'));
});

test('card deletion rejects a stale revision and blocks unresolved execution until it is stopped', async t => {
  const f = await openFeedFixture(t), a = await createCollection(f, '版本与执行保护');
  await f.poll(() => f.evaluate('!!document.querySelector(".feed-card")'));
  const menu = async () => {
    await f.evaluate('document.querySelector(".feed-card").focus()');
    for (const type of ['keyDown','keyUp']) await f.rpc('Input.dispatchKeyEvent',{type,key:'ContextMenu',code:'ContextMenu',windowsVirtualKeyCode:93});
    await f.click('[role=menuitem]','删除信息流');await f.poll(()=>f.evaluate('!!document.querySelector("dialog[open]")'));
  };
  await menu();
  const held=f.hold(command=>command.type==='delete_feed_collection'&&command.collectionId===a.collectionId,{before:true});
  await f.click('dialog button','永久删除');await held.arrived;
  const c=(await f.engine.command({type:'get_feed_collection',collectionId:a.collectionId})).feed.collection.collection;
  await f.engine.command({type:'edit_feed_collection',collectionId:c.id,expectedRevision:c.revision,requestId:'changed-before-delete',changes:{instruction:'删除期间修改的目标'}});
  held.release();await f.poll(()=>f.evaluate('document.querySelector("dialog")?.textContent.includes("版本冲突")'));
  assert.equal((await f.engine.command({type:'get_feed_collection',collectionId:c.id})).feed.collection.collection.id,c.id);
  const run=f.engine.feed.collections.run(a.runId);run.status='needs_reconciliation';f.engine.feed.collections.saveRun(run);f.engine.feed.changed();
  await f.poll(()=>f.evaluate('document.querySelector("dialog")?.textContent.includes("安全停止并核对")'));
  assert.equal(await f.evaluate('document.querySelector("dialog .danger-button").disabled'),true);
  await f.click('dialog button','取消');await menu();
  assert.equal(await f.evaluate('document.querySelector("dialog .danger-button").disabled'),true);
  assert.equal((await f.engine.command({type:'get_feed_collection',collectionId:c.id})).feed.collection.collection.id,c.id);
  run.status='stopped';f.engine.feed.collections.saveRun(run);f.engine.feed.changed();
  await f.poll(()=>f.evaluate('!document.querySelector("dialog .danger-button").disabled'));
  await f.click('dialog button','永久删除');await f.poll(()=>f.evaluate('!document.querySelector(".feed-card")&&!document.querySelector("dialog[open]")'));
  await assert.rejects(f.engine.command({type:'get_feed_collection',collectionId:c.id}),/不存在/);
});
