import assert from 'node:assert/strict';
import test from 'node:test';
import fs, { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, symlinkSync, unlinkSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { fixture, until } from './runtime-fixture.js';
import { WorkflowEngine } from '../src/core/engine.js';
import { scanProjectDocuments } from '../src/core/document-discovery.js';
import { itemLink, referencesIn, type ItemMutation } from '../src/shared/project-items.js';
import { DatabaseSync } from 'node:sqlite';

test('new editor files use unique names and title saves keep the same document and its contents', async t => {
  const f = await fixture(t);
  const change = async (input: ItemMutation) => (await f.engine.command({ type: 'update_project_item', projectId: f.projectId, input })).projectItem!;
  const create = { request_id: 'unnamed-first', operation: 'create', kind: 'document', nameFromTitle: true, body: '' } as const;
  const first = await change(create);
  const second = await change({ ...create, request_id: 'unnamed-second' });
  assert.equal(first.item.path, 'docs/未命名.md');
  assert.equal(second.item.path, 'docs/未命名 2.md');
  assert.equal(second.item.title, '未命名 2');
  assert.equal(readFileSync(join(f.root, first.item.path!), 'utf8'), '');
  assert.equal((await change(create)).item.id, first.item.id);

  const occupied = join(f.root, 'docs/Release-Notes.md');
  writeFileSync(occupied, '独立文件');
  const edited = await change({ request_id: 'editor-title', operation: 'edit', id: first.item.id, expected_revision: first.item.revision,
    expected_hash: first.hash, nameFromTitle: true, title: 'Release/Notes', body: '最新正文' });
  assert.equal(edited.item.id, first.item.id);
  assert.equal(edited.item.path, 'docs/Release-Notes 2.md');
  assert.equal(edited.item.title, 'Release-Notes 2');
  assert.equal(readFileSync(join(f.root, edited.item.path!), 'utf8'), '最新正文');
  assert.equal(readFileSync(occupied, 'utf8'), '独立文件');
  assert.equal(existsSync(join(f.root, first.item.path!)), false);
  const externalEditor = openSync(join(f.root, edited.item.path!), 'a');
  try {
    const changedCase = await change({ request_id: 'editor-title-case', operation: 'edit', id: edited.item.id, expected_revision: edited.item.revision,
      expected_hash: edited.hash, nameFromTitle: true, title: 'release/notes' });
    assert.equal(changedCase.item.path, 'docs/release-notes 2.md');
    assert(readdirSync(join(f.root, 'docs')).includes('release-notes 2.md'));
    const renamedAgain = await change({ request_id: 'editor-title-again', operation: 'edit', id: changedCase.item.id, expected_revision: changedCase.item.revision,
      expected_hash: changedCase.hash, nameFromTitle: true, title: '阶段报告' });
    assert.equal(renamedAgain.item.path, 'docs/阶段报告.md');
    writeSync(externalEditor, '\n外部编辑器保留的更改');
    assert.equal(readFileSync(join(f.root, renamedAgain.item.path!), 'utf8'), '最新正文\n外部编辑器保留的更改');
    assert.equal(readdirSync(join(f.root, '.mixcat/state')).filter(name => name.endsWith('-original.md')).length, 1);
  } finally { closeSync(externalEditor); }
  const dotfile = await change({ request_id: 'dotfile', operation: 'create', kind: 'document', title: '历史文件', path: 'docs/.markdown' });
  const renamedDotfile = await change({ request_id: 'rename-dotfile', operation: 'edit', id: dotfile.item.id, expected_revision: dotfile.item.revision,
    expected_hash: dotfile.hash, nameFromTitle: true, title: '归档索引' });
  assert.equal(renamedDotfile.item.path, 'docs/归档索引.markdown');
});

test('reopening a project aligns legacy generated names without moving explicit paths or replacing independent files', async t => {
  const f = await fixture(t);
  const create = async (request_id: string, title: string, body: string, path?: string) => (await f.engine.command({ type: 'update_project_item', projectId: f.projectId,
    input: { operation: 'create', request_id, kind: 'document', title, body, ...(path ? { path } : {}) } })).projectItem!;
  const first = await create('legacy-first', '同名资料', '一号正文\r\n');
  const second = await create('legacy-second', '同名资料', '二号正文');
  const explicit = await create('explicit-path', '自选标题', '自选路径正文', 'docs/document-3.md');
  const replaced = await create('external-replacement', '需保留路径', '保存过的版本');
  const bodyOnly = (await f.engine.command({ type: 'update_project_item', projectId: f.projectId, input: { request_id: 'body-only-legacy', operation: 'edit',
    id: first.item.id, expected_revision: first.item.revision, expected_hash: first.hash, title: first.item.title, body: first.item.body, nameFromTitle: true } })).projectItem!;
  assert.equal(bodyOnly.item.path, first.item.path);
  writeFileSync(join(f.root, replaced.item.path!), '外部替换文件');
  const occupied = join(f.root, 'docs/同名资料.md');
  writeFileSync(occupied, '独立文件');
  await f.engine.close();
  const reopened = new WorkflowEngine({ workbenchRoot: f.root, executable: 'unused', nativeFactory() { assert.fail(); } });
  t.after(() => reopened.close());
  await reopened.init();
  const read = async (itemId: string) => (await reopened.command({ type: 'get_project_item', projectId: f.projectId, itemId })).projectItem!;
  for (const [original, title] of [[first, '同名资料 2'], [second, '同名资料 3']] as const) {
    const saved = await read(original.item.id);
    assert.equal(saved.item.title, title);
    assert.equal(saved.item.path, `docs/${title}.md`);
    assert.equal(saved.hash, original.hash);
    assert.deepEqual(referencesIn(itemLink(f.projectId, saved.item), f.projectId), referencesIn(itemLink(f.projectId, original.item), f.projectId));
    assert.equal(readFileSync(join(f.root, saved.item.path), 'utf8'), original.item.body);
    assert.equal(existsSync(join(f.root, original.item.path!)), false);
    await reopened.command({ type: 'snapshot', projectId: f.projectId });
    assert.equal((await read(saved.item.id)).item.revision, saved.item.revision);
  }
  assert.equal(readFileSync(occupied, 'utf8'), '独立文件');
  assert.equal((await read(explicit.item.id)).item.path, 'docs/document-3.md');
  assert.equal((await read(explicit.item.id)).item.title, '自选标题');
  assert.equal((await read(replaced.item.id)).item.path, replaced.item.path);
  assert.equal(readFileSync(join(f.root, replaced.item.path!), 'utf8'), '外部替换文件');
  assert.equal(existsSync(join(f.root, 'docs/需保留路径.md')), false);
});

test('reattaching an existing project through its folder aligns its legacy document names', async t => {
  const f = await fixture(t);
  const saved = (await f.engine.command({ type: 'update_project_item', projectId: f.projectId, input: {
    operation: 'create', request_id: 'legacy-to-reattach', kind: 'document', title: '重新打开', body: '原正文',
  } })).projectItem!;
  await f.engine.close();
  const workbenchRoot = join(f.root, 'second-workbench');
  mkdirSync(workbenchRoot);
  const reopened = new WorkflowEngine({ workbenchRoot, executable: 'unused', nativeFactory() { assert.fail(); } });
  t.after(() => reopened.close());
  await reopened.init();
  const opened = await reopened.command({ type: 'create_project', root: f.root, name: '重新打开项目' });
  assert.equal(opened.projectCreated, false);
  assert.equal(opened.snapshot.selected?.project.id, f.projectId);
  assert.equal(readFileSync(join(f.root, 'docs/重新打开.md'), 'utf8'), saved.item.body);
  assert.equal(existsSync(join(f.root, saved.item.path!)), false);
});

test('choosing a new path syncs the title with the actual case and preserves supported filename stems', async t => {
  const f = await fixture(t);
  const change = async (input: ItemMutation) => (await f.engine.command({ type: 'update_project_item', projectId: f.projectId, input })).projectItem!;
  const file = await change({ request_id: 'explicit-source', operation: 'create', kind: 'document', title: '旧标题', path: 'docs/Report.md', body: '内容' });
  const renamed = await change({ request_id: 'case-only-move', operation: 'move', id: file.item.id, expected_revision: file.item.revision,
    expected_hash: file.hash, path: 'docs/report.md' });
  assert(readdirSync(join(f.root, 'docs')).includes('report.md'));
  assert.equal(renamed.item.title, 'report');
  const chosen = await change({ request_id: 'explicit-filename', operation: 'move', id: file.item.id, expected_revision: renamed.item.revision,
    expected_hash: renamed.hash, path: 'docs/report .markdown' });
  assert.equal(chosen.item.title, 'report ');
  const edited = await change({ request_id: 'body-with-literal-title', operation: 'edit', id: file.item.id, expected_revision: chosen.item.revision,
    expected_hash: chosen.hash, nameFromTitle: true, title: chosen.item.title, body: '编辑正文' });
  assert.equal(edited.item.title, 'report ');
  assert.equal(readFileSync(join(f.root, 'docs/report .markdown'), 'utf8'), '编辑正文');
});

test('title and content autosave recover as a single document operation after metadata commit fails', async t => {
  const f = await fixture(t);
  const doc = (await f.engine.command({ type: 'update_project_item', projectId: f.projectId, input: { request_id: 'rename-source', operation: 'create', kind: 'document', title: '原名', path: 'docs/original.md', body: '原正文' } })).projectItem!;
  const db = new DatabaseSync(join(f.root, '.mixcat/state/workflow.sqlite'));
  db.exec("CREATE TRIGGER reject_library BEFORE UPDATE ON project_state BEGIN SELECT RAISE(FAIL, 'injected rename commit failure'); END");
  const command = { type: 'update_project_item', projectId: f.projectId, input: { request_id: 'rename-with-content', operation: 'edit', id: doc.item.id,
    expected_revision: doc.item.revision, expected_hash: doc.hash, nameFromTitle: true, title: '新名', body: '新正文' } } as const;
  try { await assert.rejects(f.engine.command(command), /injected rename commit failure/); }
  finally { db.exec('DROP TRIGGER reject_library'); db.close(); }
  // Simulate reopening after the original was set aside but before the new name was published.
  const pendingPath = join(f.root, '.mixcat/state/document-pending.json'), entry = JSON.parse(readFileSync(pendingPath, 'utf8'));
  unlinkSync(join(f.root, 'docs/新名.md'));
  delete entry.published;
  writeFileSync(pendingPath, JSON.stringify(entry));
  await f.engine.close();
  const reopened = new WorkflowEngine({ workbenchRoot: f.root, executable: 'unused', nativeFactory() { assert.fail(); } });
  t.after(() => reopened.close()); await reopened.init();
  const recovered = (await reopened.command(command)).projectItem!;
  assert.equal(recovered.item.id, doc.item.id);
  assert.equal(recovered.item.path, 'docs/新名.md');
  assert.equal(recovered.item.body, '新正文');
  assert.equal(existsSync(join(f.root, 'docs/original.md')), false);
  assert.equal(existsSync(join(f.root, '.mixcat/state/document-pending.json')), false);
});

test('cancelling a published title edit restores its original file after metadata commit fails', async t => {
  const f = await fixture(t);
  const change = async (input: ItemMutation) => (await f.engine.command({ type: 'update_project_item', projectId: f.projectId, input })).projectItem!;
  const original = await change({ request_id: 'cancel-rename-source', operation: 'create', kind: 'document', title: '原名', path: 'docs/original.md', body: '原正文' });
  const db = new DatabaseSync(join(f.root, '.mixcat/state/workflow.sqlite'));
  db.exec("CREATE TRIGGER reject_library BEFORE UPDATE ON project_state BEGIN SELECT RAISE(FAIL, 'injected rename commit failure'); END");
  try {
    await assert.rejects(change({ request_id: 'cancel-published-rename', operation: 'edit', id: original.item.id,
      expected_revision: original.item.revision, expected_hash: original.hash, nameFromTitle: true, title: '新名', body: '新正文' }), /injected rename commit failure/);
  } finally { db.exec('DROP TRIGGER reject_library'); db.close(); }
  assert.equal(readFileSync(join(f.root, 'docs/新名.md'), 'utf8'), '新正文');
  const query = { type: 'search_project_items' as const, projectId: f.projectId, query: { kind: 'document' as const } };
  const before = (await f.engine.command(query)).projectItems!;
  assert(before.recovery);
  await f.engine.command({ type: 'cancel_document_write', projectId: f.projectId, recoveryId: before.recovery.id });
  assert.equal(readFileSync(join(f.root, 'docs/original.md'), 'utf8'), '原正文');
  assert.equal(existsSync(join(f.root, 'docs/新名.md')), false);
  const after = (await f.engine.command(query)).projectItems!;
  assert.equal(after.recovery, undefined);
  assert.deepEqual(after.items.map(item => [item.id, item.path]), [[original.item.id, original.item.path]]);
});

test('cancelling a name-only rename restores only the matching file identity', async t => {
  for (const replaced of [false, true]) await t.test(replaced ? 'target replaced during rollback' : 'own content edited at the new path', async testContext => {
    const f = await fixture(testContext);
    const change = async (input: ItemMutation) => (await f.engine.command({ type: 'update_project_item', projectId: f.projectId, input })).projectItem!;
    const original = await change({ request_id: 'cancel-name-only-source', operation: 'create', kind: 'document', title: '原名', path: 'docs/original.md', body: '原正文' });
    const db = new DatabaseSync(join(f.root, '.mixcat/state/workflow.sqlite'));
    db.exec("CREATE TRIGGER reject_library BEFORE UPDATE ON project_state BEGIN SELECT RAISE(FAIL, 'injected rename commit failure'); END");
    try {
      await assert.rejects(change({ request_id: 'cancel-name-only', operation: 'edit', id: original.item.id, expected_revision: original.item.revision,
        expected_hash: original.hash, nameFromTitle: true, title: '新名' }), /injected rename commit failure/);
    } finally { db.exec('DROP TRIGGER reject_library'); db.close(); }
    const target = join(f.root, 'docs/新名.md'), moved = join(f.root, 'docs/moved-by-editor.md');
    const originalPath = join(f.root, 'docs/original.md');
    writeFileSync(target, '外部更改');
    const recovery = (await f.engine.command({ type: 'search_project_items', projectId: f.projectId })).projectItems!.recovery!;
    if (replaced) {
      const rename = fs.renameSync;
      testContext.mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => {
        if (args[0] === target && String(args[1]).endsWith('-withdrawn.md')) {
          rename(target, moved);
          writeFileSync(target, '外部独立文件');
        }
        return rename(...args);
      });
      syncBuiltinESMExports();
    }
    try { await f.engine.command({ type: 'cancel_document_write', projectId: f.projectId, recoveryId: recovery.id }); }
    finally { testContext.mock.restoreAll(); syncBuiltinESMExports(); }
    if (replaced) {
      assert.equal(readFileSync(moved, 'utf8'), '外部更改');
      assert.equal(readFileSync(target, 'utf8'), '外部独立文件');
      assert.equal(existsSync(originalPath), false);
    } else {
      assert.equal(readFileSync(originalPath, 'utf8'), '外部更改');
      assert.equal(existsSync(target), false);
    }
  });
});

test('restart finishes publishing an empty document after linking the staged file', async t => {
  const f = await fixture(t);
  const link = fs.linkSync;
  t.mock.method(fs, 'linkSync', (...args: Parameters<typeof fs.linkSync>) => {
    link(...args);
    if (args[1] === join(f.root, 'docs/未命名.md')) throw Error('interrupted after publication');
  });
  syncBuiltinESMExports();
  const command = { type: 'update_project_item', projectId: f.projectId,
    input: { request_id: 'interrupted-after-link', operation: 'create', kind: 'document', nameFromTitle: true } } as const;
  try { await assert.rejects(f.engine.command(command), /interrupted after publication/); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  await f.engine.close();
  const reopened = new WorkflowEngine({ workbenchRoot: f.root, executable: 'unused', nativeFactory() { assert.fail(); } });
  t.after(() => reopened.close()); await reopened.init();
  const result = (await reopened.command(command)).projectItem!;
  assert.equal(result.item.path, 'docs/未命名.md');
  assert.equal(result.item.body, '');
  assert.equal(existsSync(join(f.root, '.mixcat/state/document-pending.json')), false);
});

test('a destination created just before publishing survives both new file creation and title rename', async t => {
  const f = await fixture(t);
  const change = async (input: ItemMutation) => (await f.engine.command({ type: 'update_project_item', projectId: f.projectId, input })).projectItem!;
  let racingPath = join(f.root, 'docs/未命名.md'), raced = false;
  const write = fs.writeFileSync, rename = fs.renameSync, link = fs.linkSync;
  const createRacingFile = (path: unknown) => {
    if (path !== racingPath || raced) return;
    raced = true;
    write(racingPath, '外部同时创建的文件', { flag: 'wx' });
  };
  t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => { createRacingFile(args[0]); return write(...args); });
  t.mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => { createRacingFile(args[1]); return rename(...args); });
  t.mock.method(fs, 'linkSync', (...args: Parameters<typeof fs.linkSync>) => { createRacingFile(args[1]); return link(...args); });
  syncBuiltinESMExports();
  try {
    const create = { request_id: 'racing-create', operation: 'create', kind: 'document', nameFromTitle: true } as const;
    await assert.rejects(change(create), /EEXIST/);
    assert(raced);
    assert.equal(readFileSync(racingPath, 'utf8'), '外部同时创建的文件');
    const emptyRecovery = (await f.engine.command({ type: 'search_project_items', projectId: f.projectId })).projectItems!.recovery!;
    await f.engine.command({ type: 'cancel_document_write', projectId: f.projectId, recoveryId: emptyRecovery.id });
    const created = await change(create);
    assert.equal(created.item.path, 'docs/未命名 2.md');
    racingPath = join(f.root, 'docs/讨论纪要.md'); raced = false;
    await assert.rejects(change({ request_id: 'racing-rename', operation: 'edit', id: created.item.id, expected_revision: created.item.revision,
      expected_hash: created.hash, nameFromTitle: true, title: '讨论纪要', body: '我的编辑' }), /EEXIST/);
    assert(raced);
    const page = (await f.engine.command({ type: 'search_project_items', projectId: f.projectId })).projectItems!;
    assert(page.recovery);
    await f.engine.command({ type: 'cancel_document_write', projectId: f.projectId, recoveryId: page.recovery.id });
    assert.equal(readFileSync(racingPath, 'utf8'), '外部同时创建的文件');
    assert.equal(readFileSync(join(f.root, created.item.path!), 'utf8'), '');
    assert(!existsSync(join(f.root, '.mixcat/state/document-pending.json')));
    assert.equal((await change({ ...create, request_id: 'after-cancellation' })).item.path, 'docs/未命名 3.md');
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('cancelling a rename after a last-moment source replacement restores the externally edited file', async t => {
  const f = await fixture(t);
  const created = (await f.engine.command({ type: 'update_project_item', projectId: f.projectId,
    input: { request_id: 'rename-original', operation: 'create', kind: 'document', title: '旧名', path: 'docs/original.md', body: '旧内容' } })).projectItem!;
  const original = join(f.root, 'docs/original.md'), replace = fs.renameSync, externalBody = 'x'.repeat(263000);
  t.mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => {
    if (args[0] === original && String(args[1]).endsWith('-original.md')) {
      const external = join(f.root, 'docs/.external-edit.tmp');
      writeFileSync(external, externalBody);
      replace(external, original);
    }
    return replace(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(f.engine.command({ type: 'update_project_item', projectId: f.projectId, input: {
      request_id: 'rename-external-conflict', operation: 'edit', id: created.item.id, expected_revision: created.item.revision,
      expected_hash: created.hash, title: '新名', body: '本次草稿', nameFromTitle: true,
    } }), /外部修改|超过 256 KiB/);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  const recovery = (await f.engine.command({ type: 'search_project_items', projectId: f.projectId })).projectItems!.recovery!;
  await f.engine.command({ type: 'cancel_document_write', projectId: f.projectId, recoveryId: recovery.id });
  assert.equal(readFileSync(original, 'utf8'), externalBody);
  assert.equal(existsSync(join(f.root, 'docs/新名.md')), false);
});

test('restart does not adopt a same-name empty file created by another process before publication', async t => {
  const f = await fixture(t);
  const destination = join(f.root, 'docs/未命名.md'), link = fs.linkSync;
  t.mock.method(fs, 'linkSync', (...args: Parameters<typeof fs.linkSync>) => {
    if (args[1] === destination) throw Error('interrupted before publication');
    return link(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(f.engine.command({ type: 'update_project_item', projectId: f.projectId,
      input: { request_id: 'interrupted-create', operation: 'create', kind: 'document', nameFromTitle: true } }), /interrupted before publication/);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  const journal = JSON.parse(readFileSync(join(f.root, '.mixcat/state/document-pending.json'), 'utf8'));
  writeFileSync(destination, '', { flag: 'wx' });
  await f.engine.close();
  const reopened = new WorkflowEngine({ workbenchRoot: f.root, executable: 'unused', nativeFactory() { assert.fail(); } });
  t.after(() => reopened.close()); await reopened.init();
  const page = (await reopened.command({ type: 'search_project_items', projectId: f.projectId })).projectItems!;
  assert(page.recovery);
  assert(page.items.every(item => item.id !== journal.itemId));
  await reopened.command({ type: 'cancel_document_write', projectId: f.projectId, recoveryId: page.recovery.id });
  assert.equal(readFileSync(destination, 'utf8'), '');
});

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

test('document summaries expose file modification time without turning metadata reads into edits', async t => {
  const f = await fixture(t); mkdirSync(join(f.root, 'docs'));
  const file = join(f.root, 'docs/time.md'), original = new Date('2024-01-02T03:04:05Z');
  writeFileSync(file, '# 原有资料'); utimesSync(file, original, original);
  const query = { type: 'search_project_items' as const, projectId: f.projectId, query: { kind: 'document' as const } };
  const first = (await f.engine.command(query)).projectItems!;
  assert.equal(first.items[0].fileModifiedAt, original.toISOString());
  const later = new Date('2025-05-06T07:08:09Z'); utimesSync(file, later, later);
  const next = (await f.engine.command(query)).projectItems!;
  assert.equal(next.items[0].fileModifiedAt, later.toISOString());
  assert.equal(next.revision, first.revision); assert.equal(next.items[0].revision, first.items[0].revision);
});

test('interrupted deletion recovers once and cancelling an already committed journal does not restore the file', async t => {
  const f = await fixture(t);
  const doc = (await f.engine.command({ type: 'update_project_item', projectId: f.projectId, input: { request_id: 'recovery-doc', operation: 'create', kind: 'document', title: '恢复删除', path: 'docs/recover-delete.md', body: '# 可恢复正文' } })).projectItem!;
  const db = new DatabaseSync(join(f.root, '.mixcat/state/workflow.sqlite'));
  db.exec("CREATE TRIGGER reject_library BEFORE UPDATE ON project_state BEGIN SELECT RAISE(FAIL, 'injected delete commit failure'); END");
  const command = { type: 'update_project_item' as const, projectId: f.projectId, input: { request_id: 'recover-delete', operation: 'delete' as const, id: doc.item.id, expected_revision: doc.item.revision, expected_hash: doc.hash } };
  await assert.rejects(f.engine.command(command), /injected delete commit failure/);
  const journal = readFileSync(join(f.root, '.mixcat/state/document-pending.json'), 'utf8');
  assert.equal(existsSync(join(f.root, 'docs/recover-delete.md')), false);
  db.exec('DROP TRIGGER reject_library'); db.close(); await f.engine.close();
  const reopened = new WorkflowEngine({ workbenchRoot: f.root, executable: 'unused', nativeFactory() { assert.fail(); } });
  t.after(() => reopened.close()); await reopened.init();
  const replay = (await reopened.command(command)).projectItem!;
  assert(replay.item.deletedAt); assert.equal(replay.item.body, '# 可恢复正文');
  writeFileSync(join(f.root, '.mixcat/state/document-pending.json'), journal);
  await reopened.command({ type: 'cancel_document_write', projectId: f.projectId, recoveryId: JSON.parse(journal).id });
  assert.equal(existsSync(join(f.root, 'docs/recover-delete.md')), false);
  assert((await reopened.command({ type: 'get_project_item', projectId: f.projectId, itemId: doc.item.id })).projectItem!.item.deletedAt);
});

test('cancelling an interrupted restore returns the file to the recycle area without losing its body', async t => {
  const f = await fixture(t);
  const change = async (input: any) => (await f.engine.command({ type: 'update_project_item', projectId: f.projectId, input })).projectItem!;
  const doc = await change({ request_id: 'cancel-doc', operation: 'create', kind: 'document', title: '取消恢复', path: 'docs/cancel.md', body: '# 回收正文' });
  writeFileSync(join(f.root, 'docs/cancel.md'), '# 外部新内容');
  await assert.rejects(change({ request_id: 'stale-delete', operation: 'delete', id: doc.item.id, expected_revision: doc.item.revision, expected_hash: doc.hash }), /冲突/);
  const fresh = (await f.engine.command({ type: 'get_project_item', projectId: f.projectId, itemId: doc.item.id })).projectItem!;
  const deleted = await change({ request_id: 'cancel-delete', operation: 'delete', id: doc.item.id, expected_revision: fresh.item.revision, expected_hash: fresh.hash });
  const db = new DatabaseSync(join(f.root, '.mixcat/state/workflow.sqlite'));
  db.exec("CREATE TRIGGER reject_library BEFORE UPDATE ON project_state BEGIN SELECT RAISE(FAIL, 'injected restore commit failure'); END");
  await assert.rejects(change({ request_id: 'cancel-restore', operation: 'restore', id: doc.item.id, expected_revision: deleted.item.revision, expected_hash: deleted.hash, path: 'docs/returned.md' }), /injected restore commit failure/);
  db.exec('DROP TRIGGER reject_library'); db.close();
  const recovery = (await f.engine.command({ type: 'search_project_items', projectId: f.projectId })).projectItems!.recovery!;
  await f.engine.command({ type: 'cancel_document_write', projectId: f.projectId, recoveryId: recovery.id });
  assert.equal(existsSync(join(f.root, 'docs/returned.md')), false);
  const result = (await f.engine.command({ type: 'get_project_item', projectId: f.projectId, itemId: doc.item.id })).projectItem!;
  assert(result.item.deletedAt); assert.equal(result.item.body, '# 外部新内容');
});

test('recovery rejects journals with missing or inconsistent document identities before moving files', async t => {
  for (const { name, corrupt } of [
    { name: 'missing item ID', corrupt: (entry: any) => { delete entry.itemId; } },
    { name: 'unknown item ID', corrupt: (entry: any) => { entry.itemId = 'unrelated-document'; } },
    { name: 'different document path', corrupt: (entry: any) => { entry.next.items.find((item: any) => item.id === entry.itemId).path = 'docs/other.md'; } },
  ]) await t.test(name, async t => {
    const f = await fixture(t);
    const doc = (await f.engine.command({ type: 'update_project_item', projectId: f.projectId, input: { request_id: 'journal-doc', operation: 'create', kind: 'document', title: '恢复边界', path: 'docs/journal.md', body: '# 原始资料' } })).projectItem!;
    const db = new DatabaseSync(join(f.root, '.mixcat/state/workflow.sqlite'));
    db.exec("CREATE TRIGGER reject_library BEFORE UPDATE ON project_state BEGIN SELECT RAISE(FAIL, 'injected journal commit failure'); END");
    await assert.rejects(f.engine.command({ type: 'update_project_item', projectId: f.projectId, input: { request_id: 'journal-delete', operation: 'delete', id: doc.item.id, expected_revision: doc.item.revision, expected_hash: doc.hash } }), /injected journal commit failure/);
    db.exec('DROP TRIGGER reject_library'); db.close(); await f.engine.close();
    // Model interruption before the file move, then corrupt the published journal.
    renameSync(join(f.root, '.mixcat/document-trash', `${doc.item.id}.md`), join(f.root, 'docs/journal.md'));
    const journalPath = join(f.root, '.mixcat/state/document-pending.json'), entry = JSON.parse(readFileSync(journalPath, 'utf8'));
    corrupt(entry); const bytes = JSON.stringify(entry); writeFileSync(journalPath, bytes);
    const reopened = new WorkflowEngine({ workbenchRoot: f.root, executable: 'unused', nativeFactory() { assert.fail(); } });
    t.after(() => reopened.close()); await reopened.init();
    const page = (await reopened.command({ type: 'search_project_items', projectId: f.projectId })).projectItems!;
    assert.match(page.recovery?.message ?? '', /损坏|无效/);
    assert.equal(readFileSync(join(f.root, 'docs/journal.md'), 'utf8'), '# 原始资料');
    await reopened.command({ type: 'cancel_document_write', projectId: f.projectId, recoveryId: page.recovery!.id });
    assert.equal(readFileSync(join(f.root, '.mixcat/state', `document-cancelled-${page.recovery!.id}.json`), 'utf8'), bytes);
    assert.equal(readFileSync(join(f.root, 'docs/journal.md'), 'utf8'), '# 原始资料');
  });
});

test('document deletion moves the file to a project recycle area and restores its identity without overwriting', async t => {
  const f = await fixture(t);
  const change = async (input: any) => (await f.engine.command({ type: 'update_project_item', projectId: f.projectId, input })).projectItem!;
  const doc = await change({ request_id: 'doc', operation: 'create', kind: 'document', title: '可删除资料', path: 'docs/removable.md', body: '# 保留这份正文' });
  const todo = await change({ request_id: 'todo-ref', operation: 'create', kind: 'todo', title: '引用资料', body: itemLink(f.projectId, doc.item) });
  const input = { request_id: 'delete-doc', operation: 'delete', id: doc.item.id, expected_revision: doc.item.revision, expected_hash: doc.hash };
  const deleted = await change(input);
  assert(deleted.item.deletedAt); assert(deleted.item.archived); assert.equal(deleted.item.body, '# 保留这份正文');
  assert.equal(existsSync(join(f.root, 'docs/removable.md')), false);
  assert(deleted.backlinks.some(link => link.itemId === todo.item.id));
  assert.equal((await change(input)).item.revision, deleted.item.revision);
  assert.equal((await f.engine.command({ type: 'search_project_items', projectId: f.projectId, query: { kind: 'document' } })).projectItems!.total, 0);
  writeFileSync(join(f.root, 'docs/removable.md'), '后来产生的另一份文件');
  await assert.rejects(change({ request_id: 'restore-occupied', operation: 'restore', id: deleted.item.id, expected_revision: deleted.item.revision, expected_hash: deleted.hash }), /存在|占用|覆盖/);
  const restored = await change({ request_id: 'restore-elsewhere', operation: 'restore', id: deleted.item.id, expected_revision: deleted.item.revision, expected_hash: deleted.hash, path: 'docs/restored.md' });
  assert.equal(restored.item.id, doc.item.id); assert.equal(restored.item.deletedAt, undefined); assert.equal(restored.item.archived, false);
  assert.equal(readFileSync(join(f.root, 'docs/removable.md'), 'utf8'), '后来产生的另一份文件');
  assert.equal(readFileSync(join(f.root, 'docs/restored.md'), 'utf8'), '# 保留这份正文');
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
