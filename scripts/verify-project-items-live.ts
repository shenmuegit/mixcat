import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkflowEngine } from '../src/core/engine.js';
import { ensureProjectDirectory, insideProject, projectDirectory } from '../src/core/paths.js';
import { edgeToolName } from '../src/core/mcp.js';
import { itemLink } from '../src/shared/project-items.js';

const root = ensureProjectDirectory(resolve('.'));
const executable = process.env.MIXCAT_CODEX;
if (!executable) throw new Error('Set MIXCAT_CODEX to the actual Codex executable for this live verification.');
const evidence = projectDirectory(root, '.runtime', 'implementation', 'project-items-live');
const engine = new WorkflowEngine({ workbenchRoot: root, executable, accountRoot: process.env.MIXCAT_ACCOUNT_ROOT ?? root });
const run = randomUUID().slice(0, 8);
try {
  await engine.init();
  const projects = (await engine.command({ type: 'snapshot' })).snapshot.projects;
  const project = projects.find(project => project.root.toLowerCase() === root.toLowerCase());
  if (!project) throw new Error('Initialize the retained node graph in the current project/worktree before live verification.');
  const original = (await engine.command({ type: 'snapshot', projectId: project.id })).snapshot.selected!;
  const edge = original.edges?.find(edge => edge.sourceNodeId === 'product' && edge.targetNodeId === 'requirements') ?? original.edges?.[0];
  if (!edge) throw new Error('Live verification requires one existing conditional edge.');
  assert.equal(original.tasks.filter(task => !['completed', 'failed', 'cancelled'].includes(task.status)).length, 0, 'existing work must finish before this acceptance run');
  await engine.restoreAccount();
  if (!(await engine.command({ type: 'snapshot' })).snapshot.account?.authenticated) throw new Error('Live verification requires the existing shared sign-in to be available.');
  const parent = (await engine.command({ type: 'update_project_item', projectId: project.id, input: { request_id: `${run}-parent`, operation: 'create', kind: 'todo', title: `真实节点协作验收 ${run}`, acceptance: '来源节点创建关联资料；接收节点查询、评论并完成子项。' } })).projectItem!.item;
  const child = (await engine.command({ type: 'update_project_item', projectId: project.id, input: { request_id: `${run}-child`, operation: 'create', kind: 'todo', parentId: parent.id, title: `验证共享管理工具 ${run}`, body: `父项：${itemLink(project.id, parent)}`, acceptance: '接收节点在关联 Issue 发表评论 LIVE_RECEIVER_OK，并通过管理工具明确完成本项。' } })).projectItem!.item;
  const prompt = `本轮是 Mixcat 项目管理工具的真实验收（编号 ${run}），不开发业务应用。仅维护本轮工作项和 .acceptance/ 下的一份 Markdown；不要修改现有源码、节点或条件边，不需要 GitHub、浏览器或安装操作。\n\n当前工作项 ${itemLink(project.id, child)}。请读取 get_project_context 和工作项当前版本，然后：\n1. 用 update_project_item 新建文档，标题“协作验收资料 ${run}”，path 为“.acceptance/shared-${run}.md”，正文引用当前 Todo。\n2. 新建内部 Issue，标题“协作验收记录 ${run}”，正文使用标准 Markdown 的 mixcat:// 引用刚建的文档和当前 Todo，并追加一条包含 LIVE_SOURCE_OK 的评论。\n3. 将当前子 Todo 明确更新为 doing。\n4. 调用当前已有的条件边工具 ${edgeToolName(edge.id, edge.targetNodeId)}，向接收节点发出下述具体验收要求，并显式设置 work_context：primary_todo_id 为 ${child.id}，references 包含刚建的 Issue 和文档（projectId 为 ${project.id}）。\n接收节点任务：用 get_project_context/get_project_item 查询关联对象；在这个 Issue 追加包含 LIVE_RECEIVER_OK 的评论，说明确实读取了文档；随后将子 Todo ${child.id} 更新为 done，reason 写明实际读取和评论结果。不要完成父项，不需回复来源或再派发第三个节点；正常结束本轮即可。\n发送受理后，你也正常结束本轮，不自行冒充接收节点完成其操作。所有变更使用管理 MCP 工具，并在编辑时使用当前 expected_revision；请在最终回复简短报告实际受理结果。`;
  const start = await engine.command({ type: 'send_message', projectId: project.id, nodeId: edge.sourceNodeId, mode: 'codex', input: [{ type: 'text', text: prompt, text_elements: [] }], work_context: { primary_todo_id: child.id, references: [{ projectId: project.id, kind: 'todo', id: parent.id }] } });
  const sourceTaskId = start.snapshot.selected!.tasks.at(-1)!.id;
  let last = '', finished = false;
  for (let attempt = 0; attempt < 720; attempt++) {
    const snapshot = (await engine.command({ type: 'snapshot', projectId: project.id, background: true })).snapshot.selected!;
    if (snapshot.requests?.length) throw new Error(`A native confirmation/input request needs user attention (${snapshot.requests.map(request => request.method).join(', ')}).`);
    const tasks = snapshot.tasks.filter(task => task.id === sourceTaskId || task.workContext?.primary_todo_id === child.id);
    const summary = JSON.stringify({ stage: 'live-native', tasks: tasks.map(task => ({ node: task.nodeId, status: task.status })) });
    if (summary !== last) { console.log(summary); last = summary; }
    if (tasks.some(task => ['failed', 'needs_reconciliation', 'cancelled'].includes(task.status))) throw new Error('A live native task failed or needs reconciliation; inspect the retained task in the client.');
    if (tasks.length >= 2 && tasks.every(task => task.status === 'completed')) { finished = true; break; }
    await delay(1000);
  }
  assert(finished, 'live node verification did not finish within the bounded run');
  const snapshot = (await engine.command({ type: 'snapshot', projectId: project.id })).snapshot.selected!;
  const childDetail = (await engine.command({ type: 'get_project_item', projectId: project.id, itemId: child.id })).projectItem!;
  const issuePage = (await engine.command({ type: 'search_project_items', projectId: project.id, query: { kind: 'issue', text: `协作验收记录 ${run}` } })).projectItems!;
  assert.equal(issuePage.total, 1, 'retries must not duplicate the issue');
  assert.equal((await engine.command({ type: 'search_project_items', projectId: project.id, query: { kind: 'document', text: `协作验收资料 ${run}` } })).projectItems!.total, 1, 'retries must not duplicate the document');
  const issue = issuePage.items[0];
  assert(issue, 'source node must create the internal issue');
  const issueDetail = (await engine.command({ type: 'get_project_item', projectId: project.id, itemId: issue.id })).projectItem!;
  assert(issueDetail.item.comments.some(comment => comment.author.nodeId === edge.sourceNodeId && comment.body.includes('LIVE_SOURCE_OK')));
  assert(issueDetail.item.comments.some(comment => comment.author.nodeId === edge.targetNodeId && comment.body.includes('LIVE_RECEIVER_OK')));
  assert.equal(childDetail.item.status, 'done');
  assert(childDetail.events.some(event => event.actor.nodeId === edge.targetNodeId && event.after.status === 'done'));
  assert.equal((await engine.command({ type: 'get_project_item', projectId: project.id, itemId: parent.id })).projectItem!.item.status, 'todo');
  assert.deepEqual(snapshot.edges, original.edges); assert.deepEqual(snapshot.edgeLayouts, original.edgeLayouts);
  assert.deepEqual(snapshot.nodes.map(({ threadId, status, ...node }) => node), original.nodes.map(({ threadId, status, ...node }) => node));
  const tasks = snapshot.tasks.filter(task => childDetail.taskIds.includes(task.id));
  assert(tasks.some(task => task.nodeId === edge.targetNodeId && task.workContext?.references.some(reference => reference.id === issue.id)));
  const nativeCalls = (snapshot.conversation ?? []).filter(entry => childDetail.taskIds.includes(entry.taskId ?? '') && entry.rawItem?.type === 'mcpToolCall').map(entry => ({ nodeId: entry.nodeId, tool: (entry.rawItem as any).tool ?? (entry.rawItem as any).name, status: (entry.rawItem as any).status }));
  const report = { passed: true, run, source: 'actual Codex app-server and existing shared account; no native fixture', edge: { source: edge.sourceNodeId, target: edge.targetNodeId },
    tasks: tasks.map(task => ({ node: task.nodeId, status: task.status, model: task.provenance?.actualModel ?? null })), nodeWrites: childDetail.events.filter(event => event.actor.kind === 'node').map(event => ({ node: event.actor.nodeId, operation: event.operation, reason: event.reason })), comments: issueDetail.item.comments.map(comment => ({ node: comment.author.nodeId, body: comment.body })), nativeCalls };
  const reportPath = insideProject(root, join(evidence, `live-${run}.json`)); writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, reportPath, taskCount: tasks.length, nativeCallCount: nativeCalls.length }));
} finally { await engine.close(); }
