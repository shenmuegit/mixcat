import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { createCodexClient } from '../src/core/codex.js';
import { WorkflowEngine } from '../src/core/engine.js';
import { projectDirectory } from '../src/core/paths.js';
import { mergeUpdate } from '../src/shared/snapshots.js';
import type { CodexPort } from '../src/shared/types.js';
import { accountFixture } from './account-fixture.js';
import { until } from './runtime-fixture.js';

test('entering a project after its native process is killed refreshes reconciliation without replaying work', async t => {
  const root = mkdtempSync(join(projectDirectory(process.cwd(), '.runtime', 'implementation', 'project-refresh'), 'case-'));
  writeFileSync(join(root, 'app-server'), `
import { createInterface } from 'node:readline';
createInterface({input:process.stdin}).on('line', line => {
  const {id,method}=JSON.parse(line); if(id===undefined)return;
  const result=method==='initialize'?{userAgent:'fixture/1'}
    :method==='account/read'?{account:{email:'fixture'}}
    :method==='windowsSandbox/readiness'?{status:'configured'}
    :method==='thread/start'?{thread:{id:'thread'}}
    :method==='turn/start'?{turn:{id:'turn'}}
    :method==='probe/pid'?{pid:process.pid}:{};
  process.stdout.write(JSON.stringify({id,result})+'\\n');
});`);
  const clients: CodexPort[] = [];
  const engine = new WorkflowEngine({ workbenchRoot: root, executable: process.execPath, accountFactory: accountFixture().factory,
    nativeFactory(options) { const client = createCodexClient(options); clients.push(client); return client; },
  });
  t.after(() => engine.close());
  await engine.init();
  const created = await engine.command({ type: 'create_project', root, name: 'Process exit', goal: 'Refresh state' });
  const projectId = created.snapshot.selected!.project.id;
  let observed = created.snapshot;
  engine.subscribe(update => { observed = mergeUpdate(observed, update).snapshot ?? observed; });
  await engine.command({ type: 'send_message', projectId, nodeId: 'plan', mode: 'codex', input: [{ type: 'text', text: 'Pending work', text_elements: [] }] });
  await until(() => observed.selected?.tasks[0]?.turnId === 'turn');
  const running = observed.selected!.tasks[0];
  assert.equal(running.status, 'running');
  const { pid } = await clients[0].rpc('probe/pid', {});
  assert(Number.isInteger(pid) && pid > 0 && pid !== process.pid);
  process.kill(pid, 'SIGKILL');
  await until(() => observed.runtime?.connected === false);

  for (let entry = 0; entry < 2; entry++) {
    const { snapshot } = await engine.command({ type: 'snapshot', projectId });
    assert.equal(snapshot.selected!.project.status, 'blocked');
    assert.equal(snapshot.selected!.nodes.find(node => node.id === 'plan')!.status, 'blocked');
    assert.equal(snapshot.selected!.tasks.length, 1);
    const task = snapshot.selected!.tasks[0];
    assert.equal(task.id, running.id);
    assert.equal(task.threadId, running.threadId);
    assert.equal(task.turnId, running.turnId);
    assert.equal(task.status, 'needs_reconciliation');
    assert.match(task.error!, /disconnected/i);
    assert.equal(snapshot.runtime!.connected, false);
    assert.equal(clients.length, 1, 'Entering the project must not reconnect or replay work');
  }
});
