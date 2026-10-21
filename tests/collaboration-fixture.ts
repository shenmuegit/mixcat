import assert from 'node:assert/strict';
import type { ProjectState, StoredTask } from '../src/core/model.js';
import type { ProjectStore } from '../src/core/store.js';
import type { McpCallContext, WorkflowTool } from '../src/shared/types.js';
import { fixture, until } from './runtime-fixture.js';

export async function collaborationFixture(t: Parameters<typeof fixture>[0]) {
  const f = await fixture(t);
  const owner = f.engine as any;
  const state = owner.states.get(f.projectId) as ProjectState, store = owner.stores.get(f.projectId) as ProjectStore;
  for (const node of [...state.nodes]) await f.engine.command({ type: 'save_node', projectId: f.projectId, node: { ...node, tools: [...node.tools, 'send_message', 'get_delivery'] as WorkflowTool[] } });
  const active = async (nodeId: string) => {
    await f.send(nodeId);
    await until(() => state.tasks.some(task => task.nodeId === nodeId && task.status === 'running' && !!task.turnId));
    return state.tasks.findLast(task => task.nodeId === nodeId && task.status === 'running')!;
  };
  const context = (nodeId: string, callId: string, task = state.tasks.findLast(task => task.nodeId === nodeId && task.status === 'running')): McpCallContext => ({
    identity: f.engine.nodeIdentity(f.projectId, nodeId), threadId: task?.threadId ?? '', turnId: task?.turnId ?? '', callId,
  });
  const raw = async (nodeId: string, name: string, args: Record<string, unknown>, callId: string, source?: McpCallContext) => {
    const ctx = source ?? context(nodeId, callId);
    const response = await fetch(owner.gateway.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${ctx.identity.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: callId, method: 'tools/call', params: { name, arguments: args, _meta: { threadId: ctx.threadId, callId: ctx.callId, 'x-codex-turn-metadata': { turn_id: ctx.turnId } } } }) });
    assert.equal(response.status, 200);
    return await response.json();
  };
  const invoke = async (nodeId: string, name: string, args: Record<string, unknown>, callId: string, source?: McpCallContext): Promise<any> => {
    const body = await raw(nodeId, name, args, callId, source);
    assert.equal(body.error, undefined, JSON.stringify(body.error));
    assert.equal(body.result.isError, undefined, body.result.content?.[0]?.text);
    return body.result.structuredContent;
  };
  const finish = (task: StoredTask, status = 'completed') => f.clients[0].options.onEvent({ method: 'turn/completed', params: { threadId: task.threadId, turn: { id: task.turnId, status, items: [] } } });
  const rejectSave = () => { store.db.exec("CREATE TEMP TRIGGER reject_save BEFORE INSERT ON project_state BEGIN SELECT RAISE(ABORT, 'fixture SQLite rejection'); END"); return () => store.db.exec('DROP TRIGGER reject_save'); };
  return { ...f, state, store, active, context, raw, invoke, finish, rejectSave };
}
