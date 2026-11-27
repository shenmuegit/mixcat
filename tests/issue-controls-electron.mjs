import assert from 'node:assert/strict';
import test from 'node:test';
import { projectDirectory } from '../src/core/paths.ts';
import { openFeedFixture } from './feed-electron-fixture.mjs';

test('Issue filters and node status keep their layout, keyboard controls and original identities', async t => {
  let saved;
  const app = await openFeedFixture(t, {
    nativeFactory() { assert.fail('Opening and filtering a project must not start Codex'); },
    async prepare(engine, fixture) {
      const { project, nodes } = (await engine.command({ type: 'create_project', root: projectDirectory(fixture, 'issue-project'), name: '工作项筛选验收' })).snapshot.selected;
      const [paused, failed, review] = nodes;
      const state = engine.states.get(project.id);
      state.nodes[0].status = 'paused';
      state.nodes[1].status = 'blocked';
      const time = '2026-11-20T08:00:00.000Z';
      state.tasks.push({ id: 'saved-failure', nodeId: failed.id, nodeSnapshot: state.nodes[1], status: 'failed',
        instruction: '校验确认的失败状态', attempt: 1, input: '', result: null, error: '未能完成执行',
        createdAt: time, finishedAt: time, threadId: null, turnId: null, runId: 'saved-run', terminal: null });
      state.tasks.push({ ...state.tasks[0], id: 'accepted-steering', status: 'completed', steering: 'accepted',
        instruction: '补充验证要求', error: null });
      state.conversation.push({ id: 'failed-input', seq: 1, nodeId: failed.id, taskId: 'saved-failure',
        direction: 'input', text: '核对资料', content: '核对资料', createdAt: time, source: { kind: 'user' } });
      state.humanReviews.push({ id: 'pending-review', nodeId: review.id, kind: 'question', status: 'pending',
        title: '需要确认原始资料', createdAt: time, options: [] });
      const update = input => engine.command({ type: 'update_project_item', projectId: project.id,
        input: { request_id: crypto.randomUUID(), ...input } });
      await update({ operation: 'create', kind: 'issue', title: '未分配的待处理工作' });
      await update({ operation: 'create', kind: 'issue', title: '已分配的待处理工作', ownerId: paused.id });
      const { item: blocked } = (await update({ operation: 'create', kind: 'issue', title: '未分配的阻塞工作' })).projectItem;
      await update({ operation: 'edit', id: blocked.id, expected_revision: blocked.revision, status: 'blocked' });
      saved = { project, paused, failed, review };
    },
  });
  const { click, evaluate, poll, rpc, screenshot } = app;
  const { project, paused, failed, review } = saved;
  const key = async (key, windowsVirtualKeyCode) => {
    for (const type of ['keyDown', 'keyUp']) {
      await rpc('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode,
        ...(key === 'Enter' && type === 'keyDown' ? { text: '\r' } : {}) });
    }
  };
  const status = 'select[aria-label="筛选 Issue 状态"]';
  const owner = 'select[aria-label="筛选 Issue 负责人"]';
  const select = async (selector, value) => {
    const index = await evaluate(`[...document.querySelector(${JSON.stringify(selector)}).options].findIndex(option=>option.value===${JSON.stringify(value)})`);
    assert(index >= 0);
    await click(selector);
    await key('Home', 36);
    for (let step = 0; step < index; step++) await key('ArrowDown', 40);
    await key('Enter', 13);
    await poll(() => evaluate(`document.querySelector(${JSON.stringify(selector)}).value===${JSON.stringify(value)}`));
  };

  await click('.icon-rail button', '项目');
  await click('#sidebar-project-list button', project.name);
  const tab = label => click('.project-view-nav button', label);
  await tab('Issue');
  await poll(() => evaluate("document.querySelectorAll('.issue-table [data-issue-row]').length===3"));
  await screenshot('issue-controls.png');
  const toolbar = await evaluate(`(() => {
    const search = document.querySelector('.issue-search').getBoundingClientRect();
    const filters = [...document.querySelectorAll('.issue-filter-controls select')];
    return { below: filters[0].getBoundingClientRect().top >= search.bottom + 7,
      sameRow: filters[0].getBoundingClientRect().top === filters[1].getBoundingClientRect().top,
      sizes: filters.map(field=>[field.getBoundingClientRect().height, getComputedStyle(field).borderRadius]) };
  })()`);
  assert.deepEqual(toolbar, { below: true, sameRow: true, sizes: [[36, '8px'], [36, '8px']] });
  assert(await evaluate("(() => { const e=[...document.querySelectorAll('.issue-status')].find(e=>e.textContent==='阻塞');const s=getComputedStyle(e);return e.tabIndex===-1&&s.borderRadius==='6px'&&s.backgroundColor!=='rgba(0, 0, 0, 0)'; })()"));
  const rows = () => evaluate("[...document.querySelectorAll('.issue-title strong')].map(title=>title.textContent)");
  await select(status, 'open');
  await select(owner, ':unassigned');
  assert.deepEqual(await rows(), ['未分配的待处理工作']);
  await select(status, '');
  assert.deepEqual(new Set(await rows()), new Set(['未分配的待处理工作', '未分配的阻塞工作']));
  await select(status, 'open');
  await evaluate("document.querySelector('[aria-label=清除负责人筛选]').focus()");
  await key('Enter', 13);
  await poll(() => evaluate(`document.activeElement.matches(${JSON.stringify(owner)}) && document.querySelector(${JSON.stringify(status)}).value==='open'`));
  assert.deepEqual(new Set(await rows()), new Set(['未分配的待处理工作', '已分配的待处理工作']));
  await click('.issue-title', '已分配的待处理工作');
  await poll(() => evaluate("document.querySelector('.management-detail [aria-label=工作项标题]')?.value==='已分配的待处理工作'"));
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.item-fields select[aria-label=工作项状态],.item-fields select[aria-label=负责人]')].map(field=>[field.getBoundingClientRect().height,getComputedStyle(field).borderRadius])"),
    [[36, '8px'], [36, '8px']]);
  await click('[aria-label="关闭 Issue 详情"]');
  await rpc('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  assert.equal(await evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(status)})).transitionDuration`), '0s');
  await rpc('Emulation.setEmulatedMedia', { features: [] });
  await rpc('Emulation.setDeviceMetricsOverride', { width: 880, height: 720, deviceScaleFactor: 1.25, mobile: false });
  assert(await evaluate(`document.querySelector(${JSON.stringify(owner)}).getBoundingClientRect().right <= innerWidth`));
  await evaluate("document.querySelector('.issue-workspace .management-list').style.inlineSize='360px'");
  await poll(() => evaluate(`(() => {
    const a=document.querySelector(${JSON.stringify(status)}).getBoundingClientRect();
    const b=document.querySelector(${JSON.stringify(owner)}).getBoundingClientRect();
    return b.top>=a.bottom+7&&b.right<=document.querySelector('.issue-filter-bar').getBoundingClientRect().right;
  })()`));
  await evaluate("document.querySelector('.issue-workspace .management-list').style.removeProperty('inline-size')");
  await rpc('Emulation.clearDeviceMetricsOverride');

  await tab('工作流');
  await poll(() => evaluate(`!!document.querySelector('.react-flow__node[data-id="${review.id}"] .node-review-marker')`));
  for (const [node, text] of [[paused, '已暂停'], [failed, '需处理']]) {
    await click(`.react-flow__node[data-id="${node.id}"] h3`);
    await poll(() => evaluate(`document.querySelector('.session-node-title h2')?.textContent===${JSON.stringify(node.name)}`));
    const badge = await evaluate(`(() => {
      const title=document.querySelector('.session-node-title h2'), badge=document.querySelector('.session-node-status');
      const style=getComputedStyle(badge);
      return { text: badge.textContent, radius: style.borderRadius, gap: badge.getBoundingClientRect().left-title.getBoundingClientRect().right };
    })()`);
    assert.deepEqual(badge, { text, radius: '6px', gap: 8 });
  }
  await poll(() => evaluate(`(() => {
    const receipt = document.querySelector('.inline-warning .status-chip[data-status=failed]');
    return receipt?.textContent==='失败' && getComputedStyle(receipt).borderRadius==='6px'
      && receipt.closest('.inline-warning').textContent.includes('未能完成执行');
  })()`));
  await screenshot('node-status-labels.png');
});
