import test from 'node:test';
import assert from 'node:assert/strict';
import { collaborationFixture } from './collaboration-fixture.js';
import { edgeToolName } from '../src/core/mcp.js';
import { toWorkflowEdges } from '../src/renderer/Workbench.js';
import type { MessageSummary, NodeView, TaskView, WorkflowEdge } from '../src/shared/types.js';

const nodes: NodeView[] = ['plan', 'implement', 'review'].map((id, i) => ({ id, name: id, instructions: '', tools: [], resultSchema: {}, position: { x: i * 300, y: 0 }, revision: 1, threadId: null, status: id === 'implement' ? 'running' : 'idle' }));
const edge: WorkflowEdge = { id: 'route', sourceNodeId: 'plan', targetNodeId: 'implement', condition: 'Ready', revision: 1 };
const message: MessageSummary = { message_id: 'message', target_task_id: 'original', accepted_at: '', sourceTaskId: 'sender', fromNodeId: 'plan', fromName: 'plan', toNodeId: 'implement', toName: 'implement', replyTo: null, edgeSnapshot: edge };
const task = (id: string, status: TaskView['status'], incomingMessageId?: string): TaskView => ({ id, nodeId: 'implement', instruction: '', status, threadId: null, turnId: null, attempt: 1, input: null, result: null, error: null, createdAt: '', finishedAt: null, incomingMessageId });

test('public message summaries expose the accepted condition snapshot without rewriting it on edge edits', async t => {
  const f = await collaborationFixture(t);
  const edge = { id: 'working-route', sourceNodeId: 'plan', targetNodeId: 'implement', condition: 'Build the accepted plan', revision: 0 };
  const saved = (await f.engine.command({ type: 'save_edge', projectId: f.projectId, edge })).snapshot.selected!.edges!.find(item => item.id === edge.id)!;
  await f.engine.command({ type: 'pause_node', projectId: f.projectId, nodeId: 'implement' });
  await f.active('plan');
  const receipt = await f.invoke('plan', edgeToolName(saved.id, saved.targetNodeId), { request_id: 'canvas-delivery', content: 'Build it', reason: 'Ready' }, 'canvas-delivery');
  const snapshot = async () => (await f.engine.command({ type: 'snapshot' })).snapshot.selected!;
  const accepted = (await snapshot()).messages!.find(message => message.message_id === receipt.message_id)!;
  assert.deepEqual(accepted.edgeSnapshot, saved);
  assert.equal((await snapshot()).tasks.find(task => task.id === receipt.target_task_id)!.incomingMessageId, receipt.message_id);
  await f.engine.command({ type: 'save_edge', projectId: f.projectId, edge: { ...saved, condition: 'Different condition' } });
  assert.deepEqual((await snapshot()).messages!.find(message => message.message_id === receipt.message_id)!.edgeSnapshot, saved);
  accepted.edgeSnapshot!.condition = 'mutated outside';
  assert.deepEqual((await snapshot()).messages!.find(message => message.message_id === receipt.message_id)!.edgeSnapshot, saved);
});

test('canvas work follows accepted routes and retry tasks without guessing from adjacent running nodes', () => {
  const definitions = [edge, { ...edge, id: 'alternate' }, { ...edge, id: 'reverse', sourceNodeId: 'implement', targetNodeId: 'plan' }];
  const execution = { tasks: [task('original', 'failed'), task('retry', 'running', message.message_id), task('later', 'queued', 'later-message')], messages: [message, { ...message, message_id: 'later-message', target_task_id: 'later' }] };
  const before = structuredClone({ definitions, nodes, execution });
  const rendered = toWorkflowEdges(definitions, nodes, () => {}, 'review', execution);
  assert.equal(rendered[0].animated, true);
  assert.deepEqual(rendered[0].data!.activity, { status: 'running', label: '运行中', working: true });
  assert.equal(rendered[0].style!.stroke, '#0f766e');
  assert(rendered[0].zIndex! > rendered[1].zIndex!, 'Working paths stay visible above overlapping inactive routes');
  assert.equal((rendered[0].markerEnd as any).color, '#0f766e');
  assert.equal(rendered[1].data!.activity, undefined); assert.equal(rendered[2].data!.activity, undefined);
  assert.equal(toWorkflowEdges(definitions, nodes, () => {}, 'plan', { tasks: execution.tasks, messages: [] })[0].data!.activity, undefined);
  for (const changed of [{ ...edge, revision: 2 }, { ...edge, sourceNodeId: 'review' }, { ...edge, targetNodeId: 'review' }]) {
    assert.equal(toWorkflowEdges([changed], nodes, () => {}, undefined, execution)[0].data!.activity, undefined);
  }
  assert.deepEqual({ definitions, nodes, execution }, before);
});

test('canvas delivery states stop movement for waiting and terminal tasks and follow native control transitions', () => {
  for (const [status, label] of [['queued', '排队中'], ['waiting_source', '等待来源'], ['waiting_review', '等待核对'], ['paused', '已暂停'], ['needs_reconciliation', '状态待核对']] as const) {
    const rendered = toWorkflowEdges([edge], nodes, () => {}, undefined, { tasks: [task('original', status)], messages: [message] })[0];
    assert.equal(rendered.animated, false); assert.deepEqual(rendered.data!.activity, { status, label, working: false });
    assert.equal(rendered.style!.stroke, '#a16207');
  }
  const paused = nodes.map(node => node.id === 'implement' ? { ...node, status: 'paused' as const } : node);
  assert.deepEqual(toWorkflowEdges([edge], paused, () => {}, undefined, { tasks: [task('original', 'queued')], messages: [message] })[0].data!.activity, { status: 'paused', label: '已暂停', working: false });
  for (const status of ['starting', 'running', 'pausing', 'resuming'] as const) {
    const current = nodes.map(node => node.id === 'implement' ? { ...node, status } : node);
    const rendered = toWorkflowEdges([edge], current, () => {}, 'review', { tasks: [task('original', 'running')], messages: [message] })[0];
    assert.equal(rendered.animated, true); assert.equal((rendered.data!.activity as any).status, status);
  }
  for (const status of ['completed', 'failed', 'cancelled'] as const) {
    const rendered = toWorkflowEdges([edge], nodes, () => {}, undefined, { tasks: [task('original', status), task('unrelated', 'running', 'other-message')], messages: [message] })[0];
    assert.equal(rendered.animated, false); assert.equal(rendered.data!.activity, undefined);
  }
  assert.equal(toWorkflowEdges([edge], nodes, () => {}, undefined, { tasks: [task('original', 'running')], messages: [{ ...message, edgeSnapshot: null }] })[0].data!.activity, undefined);
});
