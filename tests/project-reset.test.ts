import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, until } from './runtime-fixture.js';
import { WorkflowEngine } from '../src/core/engine.js';
import { readWorkflowDefinition, resetProjectData } from '../src/core/project-reset.js';

test('one-time reset retains the complete node graph and clears runtime/business state without deleting source', async t => {
  const f = await fixture(t);
  await f.engine.command({ type: 'save_edge', projectId: f.projectId, edge: { id: 'plan-implement', sourceNodeId: 'plan', targetNodeId: 'implement', condition: '工作已明确', revision: 0 } });
  await f.engine.command({ type: 'update_project_item', projectId: f.projectId, input: { request_id: 'old', operation: 'create', kind: 'todo', title: '待清理测试数据' } });
  await f.send('plan'); await until(() => !!f.clients[0]?.calls.some(call => call.method === 'turn/start'));
  await f.engine.close();
  writeFileSync(join(f.root, 'source.ts'), 'source must survive');
  const graph = readWorkflowDefinition(f.root);
  const result = resetProjectData(f.root, graph);
  assert.equal(readFileSync(join(f.root, 'source.ts'), 'utf8'), 'source must survive');
  assert.deepEqual(JSON.parse(readFileSync(result.definitionPath, 'utf8')).nodes, graph.nodes);
  const reopened = new WorkflowEngine({ workbenchRoot: f.root, executable: 'unused', nativeFactory() { assert.fail('Reset must not start native work'); } });
  t.after(() => reopened.close()); await reopened.init();
  const snapshot = (await reopened.command({ type: 'snapshot', projectId: f.projectId })).snapshot.selected!;
  assert.deepEqual(snapshot.nodes.map(({ threadId, status, ...node }) => node), graph.nodes);
  assert.deepEqual(snapshot.edges, graph.edges);
  assert(snapshot.nodes.every(node => node.threadId === null && node.status === 'idle'));
  assert.equal(snapshot.tasks.length, 0); assert.equal(snapshot.conversation!.length, 0);
  assert.equal((await reopened.command({ type: 'search_project_items', projectId: f.projectId })).projectItems!.total, 0);
});
