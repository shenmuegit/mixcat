import assert from 'node:assert/strict';
import test from 'node:test';
import { linkSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, until } from './runtime-fixture.js';
import { WorkflowEngine } from '../src/core/engine.js';
import { scanProjectDocuments } from '../src/core/document-discovery.js';

test('project Markdown materials appear without registration and keep their identity across scans and restart', async t => {
  const f = await fixture(t);
  mkdirSync(join(f.root, 'docs/design'), { recursive: true });
  writeFileSync(join(f.root, 'docs/design/需求.md'), '# 需求\n\n节点直接写出的资料。');
  writeFileSync(join(f.root, 'docs/进展.markdown'), '# 进展');
  writeFileSync(join(f.root, 'README.md'), 'not a workflow material directory');
  const query = { type: 'search_project_items' as const, projectId: f.projectId, query: { kind: 'document' as const } };
  const first = (await f.engine.command(query)).projectItems!;
  assert.deepEqual(first.items.map(item => item.path).sort(), ['docs/design/需求.md', 'docs/进展.markdown']);
  const repeated = (await f.engine.command(query)).projectItems!;
  assert.deepEqual(repeated.items.map(item => item.id), first.items.map(item => item.id));
  assert.equal(repeated.revision, first.revision);
  const detail = (await f.engine.command({ type: 'get_project_item', projectId: f.projectId, itemId: first.items[0].id })).projectItem!;
  assert.equal(detail.events[0].actor.kind, 'external');
  await f.engine.close();
  const reopened = new WorkflowEngine({ workbenchRoot: f.root, executable: 'unused', nativeFactory() { assert.fail(); } });
  t.after(() => reopened.close()); await reopened.init();
  assert.deepEqual((await reopened.command(query)).projectItems!.items.map(item => item.id), first.items.map(item => item.id));
});

test('document discovery reports unreadable materials and refuses links and dependency directories', async t => {
  const f = await fixture(t);
  mkdirSync(join(f.root, 'docs/node_modules'), { recursive: true }); mkdirSync(join(f.root, 'private'));
  writeFileSync(join(f.root, 'docs/good.md'), '# 正常资料');
  writeFileSync(join(f.root, 'docs/bad.md'), Buffer.from([0xff]));
  writeFileSync(join(f.root, 'docs/large.md'), 'x'.repeat(262145));
  writeFileSync(join(f.root, 'docs/node_modules/package.md'), 'not project material');
  writeFileSync(join(f.root, 'private/internal.md'), 'linked content must not be read');
  linkSync(join(f.root, 'private/internal.md'), join(f.root, 'docs/hard.md'));
  symlinkSync(join(f.root, 'private'), join(f.root, 'docs/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const page = (await f.engine.command({ type: 'search_project_items', projectId: f.projectId, query: { kind: 'document' } })).projectItems!;
  assert.deepEqual(page.items.map(item => item.path), ['docs/good.md']);
  for (const name of ['bad.md', 'large.md', 'hard.md', 'linked']) assert(page.documentWarnings?.some(message => message.includes(name)), name);
  const stable = (await f.engine.command({ type: 'search_project_items', projectId: f.projectId })).projectItems!;
  assert.equal(stable.revision, page.revision);
});

test('document scanning reports its file bound instead of claiming complete discovery', async t => {
  const f = await fixture(t); mkdirSync(join(f.root, 'docs'));
  for (let index = 0; index < 1001; index++) writeFileSync(join(f.root, 'docs', `${index}.md`), 'bounded scan');
  const scan = scanProjectDocuments(f.root);
  assert.equal(scan.paths.length, 1000); assert(scan.warnings.some(message => message.includes('未完整扫描')));
});

test('finishing a native turn publishes newly generated document metadata without a management read', async t => {
  const f = await fixture(t); await f.send('plan');
  let snapshot = (await f.engine.command({ type: 'snapshot', projectId: f.projectId })).snapshot.selected!;
  await until(() => f.clients[0].calls.some(call => call.method === 'turn/start'));
  snapshot = (await f.engine.command({ type: 'snapshot', projectId: f.projectId })).snapshot.selected!;
  const task = snapshot.tasks[0]; mkdirSync(join(f.root, 'docs')); writeFileSync(join(f.root, 'docs/result.md'), '# 节点成果');
  f.clients[0].options.onEvent({ method: 'turn/completed', params: { threadId: task.threadId, turn: { id: task.turnId, status: 'completed', items: [] } } });
  const after = (await f.engine.command({ type: 'snapshot', projectId: f.projectId })).snapshot.selected!;
  assert.equal(after.tasks[0].status, 'completed'); assert((after.managementRevision ?? 0) > (snapshot.managementRevision ?? 0));
});

test('discovery leaves matching moved files available for explicit stable-identity relinking', async t => {
  const f = await fixture(t);
  const doc = (await f.engine.command({ type: 'update_project_item', projectId: f.projectId, input: { request_id: 'source', operation: 'create', kind: 'document', title: '需求', path: 'docs/original.md', body: '# 同一份资料' } })).projectItem!.item;
  renameSync(join(f.root, 'docs/original.md'), join(f.root, 'docs/moved.md'));
  for (let i = 0; i < 2; i++) {
    const page = (await f.engine.command({ type: 'search_project_items', projectId: f.projectId, query: { kind: 'document' } })).projectItems!;
    assert.equal(page.total, 1); assert(page.documentWarnings?.some(message => message.includes('moved.md') && message.includes('重新关联')));
  }
  const latest = (await f.engine.command({ type: 'get_project_item', projectId: f.projectId, itemId: doc.id })).projectItem!;
  const restored = (await f.engine.command({ type: 'update_project_item', projectId: f.projectId, input: { request_id: 'relink', operation: 'relink', id: doc.id, expected_revision: latest.item.revision, path: 'docs/moved.md' } })).projectItem!;
  assert.equal(restored.item.id, doc.id); assert.equal(restored.item.body, '# 同一份资料');
  assert.equal((await f.engine.command({ type: 'search_project_items', projectId: f.projectId })).projectItems!.documentWarnings?.length ?? 0, 0);
});
