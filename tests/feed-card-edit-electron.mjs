import test from 'node:test';
import assert from 'node:assert/strict';
import { openFeedFixture, createCollection, openCollection, reloadFeed, storedForm } from './feed-electron-fixture.mjs';

const key = async (f, key, modifiers = 0) => { for (const type of ['keyDown', 'keyUp']) await f.rpc('Input.dispatchKeyEvent', { type, key, code: key, modifiers, windowsVirtualKeyCode: { ContextMenu: 93, F10: 121, Escape: 27, ArrowDown: 40, ArrowUp: 38, Home: 36, End: 35 }[key] }); };
async function edit(f, selector = '.feed-card') {
  await f.evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
  await key(f, 'ContextMenu');
  await f.click('[role=menuitem]', '编辑信息流');
  await f.poll(() => f.evaluate('!!document.querySelector("dialog[aria-label=编辑信息流]")'));
}

test('card and sidebar editing persist name and goal, preserve drafts and retry the original request', async t => {
  const f = await openFeedFixture(t), a = await createCollection(f, '编辑前名称');
  await f.poll(() => f.evaluate('!!document.querySelector(".feed-card")'));
  await edit(f);
  assert.equal(await f.evaluate('document.querySelector("dialog input").value'), '编辑前名称');
  await f.fill('dialog input', '编辑后名称'); await f.fill('dialog textarea', '每天收集官方文章并翻译，保留原文');
  await f.click('dialog button', '取消');
  assert.equal((await f.engine.command({ type: 'get_feed_collection', collectionId: a.collectionId })).feed.collection.collection.name, '编辑前名称');
  await edit(f); assert.equal(await f.evaluate('document.querySelector("dialog input").value'), '编辑后名称');
  f.rejectCommitted(command => command.type === 'edit_feed_collection'); await f.click('dialog button', '保存');
  await f.poll(() => f.evaluate('document.querySelector("dialog")?.textContent.includes("确认丢失")'));
  const pending = (await storedForm(f, `collection:${a.collectionId}:edit`)).pending;
  await reloadFeed(f); await edit(f);
  assert.deepEqual((await storedForm(f, `collection:${a.collectionId}:edit`)).pending, pending);
  await f.click('dialog button', '重试保存');
  await f.poll(() => f.evaluate('!document.querySelector("dialog[open]")&&document.querySelector(".feed-card h2")?.textContent==="编辑后名称"'));
  await openCollection(f, '编辑后名称');
  assert.match(await f.evaluate('document.querySelector(".feed-plan").textContent'), /每天收集官方文章并翻译，保留原文/);
  await edit(f, '.sidebar-feed-item'); await f.fill('dialog input', '侧栏编辑名称'); await f.click('dialog button', '保存');
  await f.poll(() => f.evaluate('document.querySelector(".feed-collection h2")?.textContent==="侧栏编辑名称"'));
  assert.equal((await f.engine.command({ type: 'list_feed_runs', collectionId: a.collectionId })).feed.runs.items.length, 1);
  await reloadFeed(f);
  await f.poll(() => f.evaluate('document.querySelector(".feed-card h2")?.textContent==="侧栏编辑名称"'));
  await f.screenshot('feed-card-edited.png');
});

test('edit menu is keyboard navigable and conflicting saves retain input for a fresh retry', async t => {
  const f = await openFeedFixture(t), a = await createCollection(f, '版本冲突编辑');
  await f.poll(() => f.evaluate('!!document.querySelector(".feed-card")'));
  const point = await f.evaluate('(()=>{const r=document.querySelector(".feed-card").getBoundingClientRect();return{x:r.right-2,y:r.bottom-2}})()');
  for (const type of ['mousePressed', 'mouseReleased']) await f.rpc('Input.dispatchMouseEvent', { type, ...point, button: 'right', clickCount: 1 });
  await f.poll(() => f.evaluate('document.activeElement?.textContent==="编辑信息流"'));
  await key(f, 'ArrowDown'); assert.equal(await f.evaluate('document.activeElement.textContent'), '删除信息流');
  await key(f, 'ArrowUp'); assert.equal(await f.evaluate('document.activeElement.textContent'), '编辑信息流');
  assert(await f.evaluate('(()=>{const r=document.querySelector("[role=menu]").getBoundingClientRect();return r.bottom<=innerHeight&&r.right<=innerWidth})()'));
  await key(f, 'Escape'); assert(await f.evaluate('document.activeElement.classList.contains("feed-card")'));
  await key(f, 'F10', 8); await f.click('[role=menuitem]', '编辑信息流');
  await f.fill('dialog input', '   '); assert.equal(await f.evaluate('document.querySelector("dialog button[type=submit]").disabled'), true);
  await f.fill('dialog input', '冲突后保留名称');
  const c = (await f.engine.command({ type: 'get_feed_collection', collectionId: a.collectionId })).feed.collection.collection;
  await f.engine.command({ type: 'edit_feed_collection', collectionId: c.id, expectedRevision: c.revision, requestId: 'concurrent-edit', changes: { instruction: '另一处已保存的目标' } });
  await f.click('dialog button', '保存');
  await f.poll(() => f.evaluate('document.querySelector("dialog")?.textContent.includes("版本冲突")'));
  assert.equal(await f.evaluate('document.querySelector("dialog input").value'), '冲突后保留名称');
  await f.click('dialog button', '保存');
  await f.poll(() => f.evaluate('!document.querySelector("dialog[open]")'));
  assert.equal((await f.engine.command({ type: 'get_feed_collection', collectionId: c.id })).feed.collection.collection.instruction, '另一处已保存的目标');
  await edit(f); await f.screenshot('feed-edit-dialog.png'); await key(f, 'Escape');
  await f.poll(() => f.evaluate('document.activeElement.classList.contains("feed-card")'));
});
