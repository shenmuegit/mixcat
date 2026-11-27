import assert from 'node:assert/strict';
import test from 'node:test';
import { itemLink, itemNumber } from '../src/shared/project-items.ts';
import { projectDirectory } from '../src/core/paths.ts';
import { openFeedFixture } from './feed-electron-fixture.mjs';
import { openWorkflowCanvasMenu } from './workflow-menu-electron-fixture.mjs';

async function seedHistory(engine, fixture) {
  const project = (await engine.command({ type: 'create_project', root: projectDirectory(fixture, 'history-project'), name: '交接记录验收' })).snapshot.selected.project;
  const createItem = async input => (await engine.command({ type: 'update_project_item', projectId: project.id,
    input: { operation: 'create', request_id: crypto.randomUUID(), ...input } })).projectItem.item;
  const issue = await createItem({ kind: 'issue', title: '校对交接材料' });
  const targetIssue = await createItem({ kind: 'issue', title: '核对第二份材料' });
  await createItem({ kind: 'document', title: '校对说明', path: 'docs/first/校对说明.md', body: '# 第一份说明' });
  const targetDocument = await createItem({ kind: 'document', title: '校对说明', path: 'docs/second/校对说明.md', body: '# 第二份说明' });
  await createItem({ kind: 'document', title: '校对笔记', path: 'docs/校对笔记.md', body: `# 交接提纲\n\n${itemLink(project.id, targetDocument)}\n\n[缺失资料](mixcat://${project.id}/document/missing-record)` });

  const state = engine.states.get(project.id), [source, target, archived] = state.nodes;
  await engine.command({ type: 'delete_node', projectId: project.id, nodeId: archived.id });
  const at = '2026-11-20T08:00:00.000Z', taskId = 'saved-source';
  state.tasks.push({ id: taskId, nodeId: source.id, nodeSnapshot: source, status: 'completed', instruction: '整理校对材料', attempt: 1,
    input: '', result: null, error: null, createdAt: at, finishedAt: at, threadId: null, turnId: null, runId: 'saved-run', terminal: null,
    workContext: { primary_issue_id: issue.id, references: [], observed: [] } });
  function entry(id, nodeId, direction, text, extras = {}) {
    state.conversation.push({ id, seq: state.conversation.length + 1, nodeId, taskId: null, threadId: null, turnId: null, itemId: null,
      source: { kind: 'node', nodeId }, direction, text, content: text, createdAt: at, ...extras });
  }
  entry('request', source.id, 'input', '请准备两份校对材料', { taskId, source: { kind: 'user' } });
  const execution = { taskId, threadId: 'saved-thread', turnId: 'saved-turn' };
  entry('tool', source.id, 'event', '命令已完成', { ...execution, status: 'completed', content: { type: 'commandExecution', command: 'read-article-'.repeat(80), status: 'completed' } });
  for (const [index, messageId] of ['original-first', 'original-second'].entries()) {
    const content = `第 ${index + 1} 份交接 · ${itemLink(project.id, targetDocument)}`;
    state.messages.push({ accepted: true, message_id: messageId, target_task_id: `waiting-${index}`, accepted_at: at, sourceTaskId: taskId,
      fromNodeId: source.id, fromName: source.name, toNodeId: target.id, toName: target.name,
      request: { request_id: messageId, to_node_id: target.id, content, reason: '校对交接' }, threadId: 'saved-thread', turnId: 'saved-turn', callId: messageId, attachments: [], edgeSnapshot: null });
    state.tasks.push({ ...state.tasks[0], id: `waiting-${index}`, nodeId: target.id, nodeSnapshot: target, instruction: '核对交接记录',
      workContext: { primary_issue_id: index ? targetIssue.id : issue.id, references: [], observed: [] } });
    entry(messageId, source.id, 'event', '发送消息', { ...execution, messageId, content: { type: 'messageSent' } });
  }
  entry('receive-second', target.id, 'input', '收到第二份交接', { taskId: 'waiting-1', source: { kind: 'node', nodeId: source.id, name: source.name }, messageId: 'original-second', replyTo: 'original-first' });
  entry('receive-only', target.id, 'input', '保留的接收记录', { source: { kind: 'node', nodeId: archived.id, name: archived.name }, messageId: 'unavailable-origin' });
  entry('archived-reply', archived.id, 'output', '归档节点保留的回复');
  return { project, source, target, targetDocument };
}

test('project history and document references preserve the original targets', async t => {
  let saved;
  const app = await openFeedFixture(t, { nativeFactory() { assert.fail('Opening saved history must not start Codex'); },
    async prepare(engine, fixture) { saved = await seedHistory(engine, fixture); } });
  const { project, source, target, targetDocument } = saved;
  const { click, fill, evaluate, poll, rpc, screenshot } = app;
  await click('button[aria-label="项目"]'); await click('#sidebar-project-list button', project.name);
  await poll(() => evaluate('!!document.querySelector(".flow-wrap")'));
  const choose = title => click('.project-view-nav button', title);
  const key = async (key, windowsVirtualKeyCode) => {
    for (const type of ['keyDown', 'keyUp']) await rpc('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode, ...(key === 'Enter' && type === 'keyDown' ? { text: '\r' } : {}) });
  };
  const openHistory = async () => {
    await openWorkflowCanvasMenu({ evaluate, poll, rpc }); await click('[role=menuitem]', '项目会话历史');
    await poll(() => evaluate('!!document.querySelector("dialog[open] .project-timeline")'));
  };
  await choose('Issue'); await click('.issue-title', '校对交接材料');
  await click('.item-links button', `${source.name} · completed`);
  await poll(() => evaluate(`document.activeElement?.dataset.entryId==='request'`));
  await click(`.react-flow__node[data-id="${target.id}"] h3`);
  await fill('#task-instruction', '仍在编辑的补充内容');
  await openHistory();
  const initialLayout = await evaluate(`(() => {
    const dialog=document.querySelector('dialog[open]'), timeline=dialog.querySelector('.project-timeline');
    const identity=timeline.querySelector('.timeline-identity'), rows=[...timeline.querySelectorAll('.chat-entry')];
    const origins=rows.map(row=>row.querySelector('.chat-bubble').getBoundingClientRect().x);
    const body=getComputedStyle(timeline.querySelector('.sent-message-body .project-markdown p'));
    return {fits:timeline.getBoundingClientRect().width<=720,identity:identity?.getBoundingClientRect().width??0,aligned:Math.max(...origins)-Math.min(...origins)<1,enter:getComputedStyle(dialog).animationDuration,body:body.fontSize+'/'+body.lineHeight};
  })()`);
  assert.deepEqual(initialLayout, { fits: true, identity: 24, aligned: true, enter: '0.16s', body: '14px/22px' });
  assert(await evaluate(`document.querySelector('dialog[open] [data-entry-id="archived-reply"]').innerText.includes('已移除') && !document.querySelector('dialog[open] [data-entry-id="archived-reply"] .timeline-actions')`));
  assert(await evaluate(`(() => {const e=document.querySelector('dialog[open] [data-entry-id="tool"] .native-tool-title');return e.scrollHeight>e.clientHeight;})()`));
  await evaluate(`document.documentElement.dataset.theme='dark'`);
  await poll(() => evaluate(`document.querySelector('dialog[open]').getAnimations().every(animation=>animation.playState!=='running')`));
  await screenshot('history-timeline.png');
  await key('Escape', 27);
  await poll(() => evaluate(`!document.querySelector('dialog[open]') && !!document.activeElement?.closest('.flow-wrap')`));
  await openHistory();
  await rpc('Emulation.setDeviceMetricsOverride', { width: 900, height: 680, deviceScaleFactor: 1.25, mobile: false });
  await rpc('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  assert(await evaluate(`(() => {const d=document.querySelector('dialog[open]'), r=d.getBoundingClientRect();return getComputedStyle(d).animationName==='none' && r.left>=0 && r.right<=innerWidth;})()`));

  assert(await evaluate(`!!document.querySelector('dialog[open] [data-entry-id="receive-second"] [data-reply-to="original-first"]')`));
  await evaluate(`document.querySelector('dialog[open] [data-entry-id="receive-second"] [data-reply-to="original-second"]').focus()`);
  await key('Enter', 13);
  await poll(() => evaluate(`!document.querySelector('dialog[open]') && document.activeElement?.dataset.entryId==='original-second'`));
  await openHistory();
  await click('dialog[open] [data-entry-id="receive-only"] button', '定位原消息');
  await poll(() => evaluate(`document.querySelector('dialog[open] [role=status]')?.textContent.includes('已定位保留的接收记录') && document.activeElement?.dataset.entryId==='receive-only'`));
  assert.equal(await evaluate(`getComputedStyle(document.activeElement).animationName`), 'none');
  await click('dialog[open] [data-entry-id="receive-only"] button', '回到节点会话');
  await poll(() => evaluate(`!document.querySelector('dialog[open]') && document.activeElement?.id==='task-instruction' && document.querySelector('#task-instruction').value==='仍在编辑的补充内容'`));
  await openHistory();
  await click('dialog[open] [data-entry-id="original-second"] button', '打开工作项');
  await poll(() => evaluate(`!document.querySelector('dialog[open]') && document.querySelector('[aria-label="工作项标题"]')?.value==='核对第二份材料'`));

  await rpc('Emulation.clearDeviceMetricsOverride');
  await choose('文档'); await click('.document-file', '校对笔记');
  const reference = '.document-sidebar .item-links .link-action';
  await poll(() => evaluate(`document.querySelector(${JSON.stringify(reference)})?.textContent.includes(${JSON.stringify(itemNumber(targetDocument))})`));
  await evaluate(`document.querySelector('.document-sidebar nav button').focus()`); await key('Enter', 13);
  assert(await evaluate(`document.activeElement?.tagName==='H1' && document.activeElement?.textContent==='交接提纲'`));
  assert(await evaluate(`(() => {const e=document.querySelector(${JSON.stringify(reference)});return e.getBoundingClientRect().height>=32 && getComputedStyle(e).transitionDuration==='0s';})()`));
  await screenshot('document-reference-actions.png');
  await evaluate(`document.querySelector(${JSON.stringify(reference)}).focus()`);
  assert(await evaluate(`document.activeElement?.matches(${JSON.stringify(reference)})`));
  await key('Enter', 13);
  const selectedDocument = `[data-document-path="${targetDocument.path}"] [aria-current=page]`;
  await poll(() => evaluate(`!!document.querySelector(${JSON.stringify(selectedDocument)}) && document.querySelector('.document-reading')?.innerText.includes('第二份说明')`));
  await click('.document-file', '校对笔记');
  await click('.document-sidebar .item-links .link-action', '查看引用记录');
  await poll(() => evaluate(`/找不到|读取文档失败/.test(document.querySelector('.management-detail [role=alert]')?.textContent ?? '') && !document.querySelector('.document-reading')`));
});
