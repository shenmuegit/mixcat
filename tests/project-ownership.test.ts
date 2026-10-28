import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowEngine } from '../src/core/engine.js';
import { projectDirectory } from '../src/core/paths.js';
import { fixture } from './runtime-fixture.js';
import { ProjectStore } from '../src/core/store.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

test('a second workbench cannot acquire a project until its writer closes', async t => {
  const f = await fixture(t);
  const other = new WorkflowEngine({ workbenchRoot: projectDirectory(f.root, 'other-workbench'), executable: 'unused' });
  t.after(() => other.close()); await other.init();
  await f.engine.command({ type: 'rename_project', projectId: f.projectId, name: 'Saved by the owner' });
  await assert.rejects(other.command({ type: 'create_project', root: f.root, name: 'Ignored', goal: 'Ignored' }), /其他.*工作台|另一个.*工作台/);
  await f.engine.close();
  const reopened = (await other.command({ type: 'create_project', root: f.root, name: 'Ignored', goal: 'Ignored' })).snapshot.selected!;
  assert.equal(reopened.project.name, 'Saved by the owner');
  assert.equal(reopened.project.id, f.projectId);
});

test('stale direct stores reject writes without replacing a newer saved project', async t => {
  const f = await fixture(t), staleStore = new ProjectStore(f.root);
  t.after(async () => staleStore.close());
  const stale = staleStore.read()!;
  await f.engine.command({ type: 'rename_project', projectId: f.projectId, name: 'New saved name' });
  stale.nodes[0].name = 'Stale node edit';
  assert.throws(() => staleStore.save(stale), /其他.*工作台|存储版本/);
  const disk = staleStore.read()!;
  assert.equal(disk.project.name, 'New saved name');
  assert.notEqual(disk.nodes[0].name, 'Stale node edit');
});

test('the OS releases project ownership after an owning process exits', async t => {
  const f = await fixture(t); await f.engine.close();
  const source = `import {ProjectStore} from ${JSON.stringify(pathToFileURL(resolve('src/core/store.ts')).href)};const store=new ProjectStore(process.argv[1]);store.claim();process.send('ready');setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source, f.root], { cwd: process.cwd(), env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const store = new ProjectStore(f.root); let output = '';
  child.stderr!.on('data', data => output += data);
  try {
    const [message] = await Promise.race([once(child, 'message', { signal: AbortSignal.timeout(10000) }), once(child, 'exit').then(() => { throw Error(output || 'Owner exited before acquiring the lock'); })]);
    assert.equal(message, 'ready');
    assert.throws(() => store.claim(), /其他.*工作台/);
    child.kill(); await once(child, 'exit');
    store.claim();
    assert.equal(store.read()!.project.id, f.projectId);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
    store.close();
  }
});

test('retrying a crashed owner reconciles its existing task instead of leaving a phantom execution', async t => {
  const f = await fixture(t), root = projectDirectory(f.root, 'recovery-workbench');
  const source = `import {fixture,until} from ${JSON.stringify(pathToFileURL(resolve('tests/runtime-fixture.ts')).href)};const f=await fixture({after(){}});await f.send('plan');await until(()=>f.clients[0]?.calls.some(c=>c.method==='turn/start'));process.send({root:f.root,id:f.projectId});setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { cwd: process.cwd(), env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = '', other: WorkflowEngine | undefined; child.stderr!.on('data', data => output += data);
  try {
    const [info] = await Promise.race([once(child, 'message', { signal: AbortSignal.timeout(20000) }), once(child, 'exit').then(() => { throw Error(output || 'Owner exited before task startup'); })]);
    writeFileSync(join(projectDirectory(root, '.runtime', 'client'), 'projects.json'), JSON.stringify([info.root]));
    other = new WorkflowEngine({ workbenchRoot: root, executable: 'unused', nativeFactory() { assert.fail('Recovery must not start native execution'); } });
    await other.init(); assert((await other.command({ type: 'snapshot' })).snapshot.projects[0].unavailable);
    child.kill(); await once(child, 'exit');
    const restored = (await other.command({ type: 'create_project', root: info.root, name: 'Ignored', goal: 'Ignored' })).snapshot.selected!;
    assert.equal(restored.project.id, info.id);
    assert.equal(restored.tasks[0].status, 'needs_reconciliation');
    assert.equal(restored.nodes.find(node => node.id === 'plan')!.status, 'blocked');
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
    await other?.close();
  }
});

test('a failed main database close still releases writer ownership', async t => {
  const f = await fixture(t); await f.engine.close();
  const store = new ProjectStore(f.root); store.claim();
  const close = store.db.close.bind(store.db);
  store.db.close = () => { throw Error('Injected database close failure'); };
  try {
    assert.throws(() => store.close(), /Injected database close failure/);
    const next = new ProjectStore(f.root);
    try { next.claim(); assert.equal(next.read()!.project.id, f.projectId); } finally { next.close(); }
  } finally { close(); }
});
