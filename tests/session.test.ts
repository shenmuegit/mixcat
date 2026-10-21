import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, until } from './runtime-fixture.js';

test('node_queue_reuses_thread_and_project_cwd with free replies and native input unchanged', async t => {
  const f = await fixture(t);
  const before = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!;
  const node = before.nodes.find(n => n.id === 'plan')!;
  await f.engine.command({ type: 'save_node', projectId: f.projectId, node: { ...node, name: 'Writer', instructions: 'Write freely', model: 'chosen-model', skills: [{ name: 'writing', path: 'G:\\skills\\writing\\SKILL.md' }], plugins: [{ name: 'Test', id: 'test@local' }] } });
  const input = [
    { type: 'text', text: 'hello', text_elements: [{ arbitrary: true }] },
    { type: 'localImage', path: `${f.root}\\image.png` },
    { type: 'localAudio', path: `${f.root}\\voice.wav` },
    { type: 'audio', data: 'fixture-audio', format: 'wav' },
    { type: 'mention', name: 'file.txt', path: `${f.root}\\file.txt` },
  ];
  await f.engine.command({ type: 'send_message', projectId: f.projectId, nodeId: 'plan', input, mode: 'codex' });
  await until(() => f.clients[0].calls.filter(c => c.method === 'turn/start').length === 1);
  await Promise.all([f.send('plan'), f.send('implement')]);
  await until(() => f.clients[0].calls.filter(c => c.method === 'turn/start').length === 2);
  const calls = f.clients[0].calls; const turns = () => calls.filter(c => c.method === 'turn/start');
  assert.equal(calls.filter(c => c.method === 'thread/start').length, 2);
  assert.equal(turns().filter(c => c.params.threadId === turns()[0].params.threadId).length, 1, 'same node waits while another node runs');
  for (const call of calls.filter(c => c.method === 'thread/start')) {
    assert.equal(call.params.cwd, f.root); assert.equal(call.params.sandbox, 'workspace-write'); assert.equal(call.params.approvalPolicy, 'on-request');
    assert.equal('disabled_tools' in call.params.config, false);
  }
  const first = turns()[0];
  assert.equal(first.params.model, 'chosen-model');
  assert.deepEqual(first.params.input, [...input, { type: 'skill', name: 'writing', path: 'G:\\skills\\writing\\SKILL.md' }, { type: 'mention', name: 'Test', path: 'plugin://test@local' }]);
  assert.match(calls.find(c => c.method === 'thread/start')!.params.developerInstructions, /Write freely/);
  f.clients[0].options.onEvent({ method: 'turn/completed', params: { threadId: first.params.threadId, turn: { id: (await f.engine.command({ type: 'snapshot' })).snapshot.selected!.tasks[0].turnId, status: 'completed', items: [{ id: 'reply', type: 'agentMessage', text: 'A free response without MCP' }] } } });
  await until(() => turns().length === 3);
  const resume = calls.find(c => c.method === 'thread/resume')!;
  assert.equal(resume.params.cwd, f.root); assert.equal(resume.params.threadId, first.params.threadId);
  assert.equal(turns()[2].params.threadId, first.params.threadId);
  const snapshot = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!;
  assert.equal(snapshot.tasks[0].status, 'completed'); assert.equal(snapshot.tasks[0].result, 'A free response without MCP');
  assert.deepEqual(snapshot.conversation!.find(e => e.id === `input:${snapshot.tasks[0].id}`)!.content, input);
});
