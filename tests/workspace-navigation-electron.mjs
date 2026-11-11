import test from 'node:test';
import assert from 'node:assert/strict';
import { openFeedFixture, createCollection, openCollection, reloadFeed, storedForm } from './feed-electron-fixture.mjs';

test('feed sidebar plus opens the existing creation form from empty and detail views without losing drafts', async t => {
  const f=await openFeedFixture(t),add='.workspace-sidebar [aria-label="新建信息流"]';
  assert(await f.evaluate(`!!document.querySelector('${add}')`),'the feed sidebar needs an add button');
  assert.equal(await f.evaluate('document.querySelector(".sidebar-feed-list>header h2")?.textContent'),'信息流');
  await f.click(add);
  await f.poll(()=>f.evaluate('!!document.querySelector("[aria-label=采集需求]")&&!document.querySelector("[aria-label=采集需求]").readOnly'));
  assert.equal((await f.engine.command({type:'feed_snapshot'})).feed.snapshot.collections.length,0);
  await f.fill('[aria-label=采集名称]','侧栏新信息流');await f.fill('[aria-label=采集需求]','新增目标草稿');
  await f.poll(async()=>(await storedForm(f))?.fields.instruction==='新增目标草稿');
  await f.click('.feed-new>button','返回信息流');
  await f.poll(()=>f.evaluate(`document.activeElement===document.querySelector('${add}')`));
  const old=await createCollection(f,'已有信息流');await openCollection(f,'已有信息流');
  await f.click(add);
  await f.poll(()=>f.evaluate('document.querySelector("[aria-label=采集需求]")?.value==="新增目标草稿"'));
  assert.equal(await f.evaluate('document.querySelector("[aria-label=采集名称]").value'),'侧栏新信息流');
  await f.click('.feed-new .feed-send');
  await f.poll(()=>f.evaluate('document.querySelector(".feed-collection>header h2")?.textContent==="侧栏新信息流"'));
  await f.poll(()=>f.evaluate('document.querySelectorAll(".sidebar-feed-item").length===2'));
  assert.equal((await f.engine.command({type:'get_feed_collection',collectionId:old.collectionId})).feed.collection.collection.name,'已有信息流');
  await f.evaluate(`document.querySelector('${add}').focus()`);
  for(const type of ['keyDown','keyUp'])await f.rpc('Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13,...(type==='keyDown'?{text:'\r'}:{})});
  await f.poll(()=>f.evaluate('!!document.querySelector(".feed-new")'));
  assert.equal((await f.engine.command({type:'feed_snapshot'})).feed.snapshot.collections.length,2);
  const bounds=await f.evaluate(`(()=>{const s=document.querySelector('.workspace-sidebar').getBoundingClientRect(),r=document.querySelector('${add}').getBoundingClientRect();return {visible:r.left>=s.left&&r.right<=s.right&&r.top>=s.top&&r.bottom<=s.bottom,width:r.width,height:r.height}})()`);
  assert(bounds.visible);assert.equal(bounds.width,28);assert.equal(bounds.height,28);
  await f.screenshot('feed-sidebar-add.png');
  const snapshot=(await f.engine.command({type:'feed_snapshot'})).feed.snapshot;
  f.emitFeed({...snapshot,storageError:'fixture storage unavailable'});
  await f.poll(()=>f.evaluate(`document.querySelector('${add}').disabled`));
});

test('rail navigation exposes module lists and independent persistent note canvases', async t => {
  const f = await openFeedFixture(t);
  for (const name of ['项目', '信息流', '笔记', '画布', '知识库']) {
    assert.equal(await f.evaluate(`!!document.querySelector('.icon-rail button[aria-label="${name}"]')`), true, `${name} belongs in the rail`);
  }
  assert.equal(await f.evaluate('document.querySelectorAll(".icon-rail>span").length'), 0);
  for (const label of ['项目', '信息流', '笔记', '画布', '知识库', '设置']) {
    await f.click(`.icon-rail button[aria-label="${label}"]`);
    await f.poll(() => f.evaluate(`document.querySelector('.icon-rail button[aria-current=page]')?.getAttribute('aria-label')===${JSON.stringify(label)}`));
    const headed=['信息流','画布'].includes(label);
    if(headed)await f.poll(()=>f.evaluate(`document.querySelector('.workspace-sidebar h2')?.textContent===${JSON.stringify(label)}`));
    const sidebar = await f.evaluate('(()=>{const s=document.querySelector(".workspace-sidebar"),n=s.querySelector("nav"),r=s.getBoundingClientRect();return {brands:s.querySelectorAll(".brand").length,headings:s.querySelectorAll("h2,.sidebar-heading").length,gap:n.getBoundingClientRect().top-r.top-parseFloat(getComputedStyle(s).paddingTop)}})()');
    assert.equal(sidebar.brands, 0); assert.equal(sidebar.headings, headed ? 1 : 0); assert(Math.abs(sidebar.gap) <= 1);
    const backgrounds = await f.evaluate('[".workspace-sidebar", ".icon-rail", ".app-content"].map(selector => getComputedStyle(document.querySelector(selector)).backgroundColor)');
    assert.deepEqual(backgrounds, ['rgb(249, 249, 249)', 'rgb(249, 249, 249)', 'rgb(255, 255, 255)'], `${label} uses a gray navigation area and white content`);
    if (label === '笔记') assert.equal(await f.evaluate('document.querySelector(".workspace-sidebar nav")?.firstElementChild?.textContent'), '新建笔记');
  }
  await f.click('.icon-rail button', '项目');
  assert.equal(await f.evaluate('!!document.querySelector(".workspace-sidebar [aria-label=项目列表]")'), true);
  await createCollection(f, '左侧采集甲'); await createCollection(f, '左侧采集乙');
  await f.click('.icon-rail button', '信息流');
  await f.poll(() => f.evaluate('document.querySelectorAll(".workspace-sidebar .sidebar-feed-item").length===2'));
  await f.click('.workspace-sidebar .sidebar-feed-item', '左侧采集乙');
  await f.poll(() => f.evaluate('document.querySelector(".feed-collection h2")?.textContent==="左侧采集乙"'));
  await f.click('.workspace-sidebar .sidebar-feed-item', '左侧采集甲');
  await f.poll(() => f.evaluate('document.querySelector(".feed-collection h2")?.textContent==="左侧采集甲"'));
  await f.click('.workspace-sidebar .sidebar-feed-item', '左侧采集甲');
  assert.equal(await f.evaluate('document.querySelector(".feed-collection h2")?.textContent'), '左侧采集甲');

  const create = async (title, parentId = null, body = '') => {
    const book = (await f.engine.command({ type: 'get_notes' })).notes;
    return (await f.engine.command({ type: 'update_note', input: { operation: 'create', title, body, parentId, expected_revision: book.revision, request_id: crypto.randomUUID() } })).noteId;
  };
  const b = await create('画布乙'), bChild = await create('乙的子笔记', b);
  const a = await create('画布甲', null, `[另一画布](mixcat-note://${bChild})`), aChild = await create('甲的子笔记', a);
  await f.click('.icon-rail button', '笔记');
  await f.click('.sidebar-note-list button', '画布甲');
  const ids = () => f.evaluate('[...document.querySelectorAll(".note-topic")].map(node=>node.dataset.noteId).sort()');
  await f.poll(async () => JSON.stringify(await ids()) === JSON.stringify([a, aChild].sort()));
  await f.poll(() => f.evaluate(`!!localStorage.getItem('mixcat.notes.canvas.v1:${a}')`));
  const bounds = await f.evaluate('(()=>{const r=document.querySelector(".notes-map-pane").getBoundingClientRect();return {x:r.left+40,y:r.top+200}})()');
  const before = await f.evaluate('document.querySelector(".notes-workspace .react-flow__viewport").style.transform');
  await f.rpc('Input.dispatchMouseEvent', { type: 'mouseWheel', ...bounds, deltaX: 0, deltaY: -150 });
  await f.poll(() => f.evaluate(`document.querySelector('.notes-workspace .react-flow__viewport').style.transform!==${JSON.stringify(before)}`));
  await f.poll(() => f.evaluate(`!!JSON.parse(localStorage.getItem('mixcat.notes.canvas.v1:${a}')).viewport`));
  // Wait for React Flow's wheel gesture to finish before switching canvases.
  await new Promise(done => setTimeout(done, 300));
  const viewA = await f.evaluate('document.querySelector(".notes-workspace .react-flow__viewport").style.transform');
  await f.click('.sidebar-note-list button', '画布乙');
  await f.poll(async () => JSON.stringify(await ids()) === JSON.stringify([b, bChild].sort()));
  await f.click('.sidebar-note-list button', '画布甲');
  await f.poll(() => f.evaluate(`document.querySelector('.notes-workspace .react-flow__viewport').style.transform===${JSON.stringify(viewA)}`));
  await f.screenshot('independent-note-canvas.png');
  await reloadFeed(f); await f.click('.icon-rail button', '笔记');
  await f.poll(async () => JSON.stringify(await ids()) === JSON.stringify([a, aChild].sort()));
  await f.poll(() => f.evaluate(`document.querySelector('.notes-workspace .react-flow__viewport').style.transform===${JSON.stringify(viewA)}`));

  const point = await f.evaluate(`(()=>{const r=document.querySelector('.note-topic[data-note-id="${a}"]').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
  for (const type of ['mousePressed', 'mouseReleased']) await f.rpc('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 2 });
  await f.click('.notes-document-pane .item-reference', '另一画布');
  await f.poll(async () => JSON.stringify(await ids()) === JSON.stringify([b, bChild].sort()));
  await f.poll(() => f.evaluate(`!!document.querySelector('[data-content-identity="note:${bChild}"]')`));
  await f.click('.notes-document-toolbar button', '脑图');
  await f.click(`.note-topic[data-note-id="${b}"] .note-topic-fold:not(:disabled)`);
  await f.poll(async () => (await ids()).length === 1);
  await f.click('.sidebar-note-list button', '画布甲');
  await f.fill('[aria-label=搜索笔记]', '乙的子笔记');
  await f.click('.notes-search-results button', '乙的子笔记');
  await f.poll(async () => JSON.stringify(await ids()) === JSON.stringify([b, bChild].sort()));
  await f.poll(() => f.evaluate(`!!document.querySelector('[data-content-identity="note:${bChild}"]')`));
  await f.click('.workspace-sidebar [aria-label="新建笔记"]');
  await f.fill('[aria-label=笔记标题]', '侧栏新笔记');
  await f.poll(async () => (await f.engine.command({ type: 'get_notes' })).notes.notes.some(note => note.title === '侧栏新笔记' && note.parentId === null));
  await f.poll(async () => (await ids()).length === 1);
  await f.click('.icon-rail button', '知识库');
  assert.match(await f.evaluate('document.querySelector(".pending-page").textContent'), /待设计/);
  await f.screenshot('knowledge-pending.png');
});
