import test from 'node:test';
import assert from 'node:assert/strict';
import { openFeedFixture, createCollection, saveResult, reloadFeed } from './feed-electron-fixture.mjs';

test('feed card previews read as text and still open the original result', { timeout: 120000 }, async t => {
  const f = await openFeedFixture(t), admission = await createCollection(f, '资料阅读');
  const body = '# 项目资料\n\n阅读 [使用说明](https://example.com/guide?q=' + 'a'.repeat(350) + ') 与 **更新记录**。';
  const result = saveResult(f, admission, '资料更新', body);
  f.engine.feed.changed();
  await f.poll(() => f.evaluate('!!document.querySelector(".feed-card-result")'));
  const preview = await f.evaluate('document.querySelector(".feed-card-result").textContent');
  assert(preview.includes('项目资料') && preview.includes('使用说明') && preview.includes('更新记录'));
  assert(!preview.includes('# ') && !preview.includes('](') && !preview.includes('**'), 'preview exposes raw Markdown syntax');
  assert.equal(await f.evaluate('document.querySelectorAll(".feed-card a,.feed-card button,.feed-card img").length'), 0);
  await f.click('.feed-card-result');
  await f.poll(() => f.evaluate('document.querySelector(".feed-collection h2")?.textContent === "资料阅读"'));
  await f.click('.feed-results-trigger');
  await f.poll(() => f.evaluate('document.querySelector(".feed-result-drawer-content strong")?.textContent === "更新记录"'));
  const stored = await f.engine.command({ type: 'get_feed_entry', entryId: result.entryId });
  assert.equal(stored.feed.entry.body, body);
});

for (const routed of [false, true]) test(`a wide workflow opens readably and keeps manual zoom and stored layout (routes: ${routed})`, { timeout: 120000 }, async t => {
  const f = await openFeedFixture(t);
  const { snapshot } = await f.engine.command({ type: 'create_project', root: f.fixture, name: '宽工作流', template: 'web-product' });
  const projectId = snapshot.selected.project.id;
  const positions = snapshot.selected.nodes.map((node, index) => ({ nodeId: node.id, position: { x: index * 1600, y: 100 } }));
  await f.engine.command({ type: 'move_nodes', projectId, positions });
  if (routed) await f.engine.command({ type: 'save_edge_layout', projectId, edgeId: snapshot.selected.edges[0].id, layout: { revision: 0, source: { side: 'right', offset: .5 }, target: { side: 'left', offset: .5 }, route: { points: [{ x: 0, y: 0 }, { x: 0, y: 1200 }, { x: 1600, y: 1200 }, { x: 1600, y: 0 }], label: { x: 800, y: 1200 } } } });
  const before = (await f.engine.command({ type: 'snapshot', projectId })).snapshot.selected;
  await reloadFeed(f);
  await f.click('.icon-rail [aria-label="项目"]');
  await f.click('.project-card');
  await f.poll(() => f.evaluate('!!document.querySelector(".conversation-node h3")'));
  await f.evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');
  const metrics = await f.evaluate(`(()=>{
    const viewport=document.querySelector('.react-flow__viewport'), scale=new DOMMatrix(getComputedStyle(viewport).transform).a;
    const canvas=document.querySelector('.flow-wrap').getBoundingClientRect();
    return { scale, readable:[...document.querySelectorAll('.conversation-node h3')].some(e=>{
      const r=e.getBoundingClientRect();return parseFloat(getComputedStyle(e).fontSize)*scale>=12 && r.left>=canvas.left && r.right<=canvas.right && r.top>=canvas.top && r.bottom<=canvas.bottom;
    }), point:{x:canvas.left+20,y:canvas.top+20} };
  })()`);
  assert(metrics.readable, 'initial view has no readable visible node title');
  await f.rpc('Input.dispatchMouseEvent', { type: 'mouseWheel', ...metrics.point, deltaX: 0, deltaY: 180 });
  await f.poll(() => f.evaluate(`new DOMMatrix(getComputedStyle(document.querySelector('.react-flow__viewport')).transform).a < ${metrics.scale}`));
  const after = (await f.engine.command({ type: 'snapshot', projectId })).snapshot.selected;
  assert.deepEqual(after.nodes.map(node => ({ nodeId: node.id, position: node.position })), positions);
  assert.deepEqual(after.edgeLayouts, before.edgeLayouts);
});
