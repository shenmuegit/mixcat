import test from 'node:test';
import assert from 'node:assert/strict';
import { feedFixture } from './feed-runtime-fixture.js';
import { until } from './runtime-fixture.js';

const parent = 'https://www.notion.so/11111111111111111111111111111111';
const child = { id: '22222222-2222-2222-2222-222222222222', url: 'https://www.notion.so/22222222222222222222222222222222' };

async function connectedFixture(t: Parameters<typeof feedFixture>[0], create?: () => unknown) {
  let server = '';
  const state = { authorized: true, workspace: 'workspace-a', parentType: 'page', beforeFetch: undefined as (() => Promise<void>) | undefined };
  const writes: any[] = [];
  const f = await feedFixture(t, async (method, params) => {
    if (method === 'config/batchWrite') { server = params.edits[0].keyPath.slice('mcp_servers.'.length); return {}; }
    if (method === 'mcpServer/oauth/login') return { authorizationUrl: 'https://mcp.notion.com/authorize', loginId: 'create-login' };
    if (method === 'mcpServerStatus/list') return { data: [{ name: server, authStatus: state.authorized ? 'oAuth' : 'notLoggedIn', tools: {} }] };
    if (method === 'mcpServer/tool/call') {
      if (params.tool === 'notion-get-self') return { structuredContent: { workspace: { id: state.workspace, name: 'A' } } };
      if (params.tool === 'notion-fetch') { await state.beforeFetch?.(); return { structuredContent: { id: params.arguments.id, title: '父页面', url: params.arguments.id, metadata: { type: state.parentType } } }; }
      if (params.tool === 'notion-create-pages') { writes.push(params); return create?.() ?? { structuredContent: { pages: [child] } }; }
    }
  });
  const id = (await f.create('create-page')).admission!.collectionId;
  await until(() => f.clients[0]?.calls.some(c => c.method === 'turn/start') === true);
  const run = (await f.engine.command({ type: 'get_feed_collection', collectionId: id })).collection!.activeRun!;
  f.clients[0].options.onEvent({ method: 'turn/completed', params: { threadId: run.threadId, turn: { id: run.turnId, status: 'completed', items: [] } } });
  assert.equal((await f.engine.command({ type: 'get_feed_collection', collectionId: id })).collection!.activeRun, null);
  await f.engine.command({ type: 'connect_feed_notion', collectionId: id });
  const collection = (await f.engine.command({ type: 'get_feed_collection', collectionId: id })).collection!.collection;
  const command = { type: 'create_feed_notion_page' as const, collectionId: id, workspaceId: 'workspace-a', parentPageId: parent, title: '调研资料', expectedRevision: collection.revision, requestId: 'new-page' };
  return { ...f, get engine() { return f.engine; }, reopen: f.reopen, writes, collection, command, state };
}

test('a Notion child page is created once and only changes the destination after save', async t => {
  const f = await connectedFixture(t);
  const result = (await f.engine.command(f.command)).notion!;
  assert.deepEqual(result.createdPage, { ...child, title: '调研资料', type: 'page' });
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.writes[0].arguments, { parent: { page_id: '11111111-1111-1111-1111-111111111111' }, pages: [{ properties: { title: '调研资料' } }] });
  assert.equal((await f.engine.command({ type: 'get_feed_collection', collectionId: f.collection.id })).collection!.collection.notion?.target, undefined);
  assert.deepEqual((await f.engine.command(f.command)).notion!.createdPage, result.createdPage);
  await f.reopen();
  assert.deepEqual((await f.engine.command(f.command)).notion!.createdPage, result.createdPage);
  assert.equal(f.writes.length, 1);
  await f.engine.command({ type: 'set_feed_notion_target', collectionId: f.collection.id, workspaceId: 'workspace-a', pageId: child.url, expectedRevision: f.collection.revision, requestId: 'save-created-page' });
  assert.equal((await f.engine.command({ type: 'get_feed_collection', collectionId: f.collection.id })).collection!.collection.notion?.target?.url, child.url);
});

test('Notion creation rejects invalid names, changed workspaces, databases, stale edits and live execution before writing', async t => {
  const f = await connectedFixture(t);
  await assert.rejects(f.engine.command({ ...f.command, title: '   ', requestId: 'blank' }));
  await assert.rejects(f.engine.command({ ...f.command, title: '长'.repeat(201), requestId: 'long' }));
  await assert.rejects(f.engine.command({ ...f.command, expectedRevision: f.collection.revision + 1, requestId: 'stale' }), /版本冲突/);
  f.state.workspace = 'workspace-b';
  await assert.rejects(f.engine.command({ ...f.command, requestId: 'workspace' }), /工作区已变化/);
  f.state.workspace = 'workspace-a'; f.state.parentType = 'database';
  await assert.rejects(f.engine.command({ ...f.command, requestId: 'database' }), /普通页面/);
  f.state.parentType = 'page'; f.state.authorized = false;
  await assert.rejects(f.engine.command({ ...f.command, requestId: 'unauthorized' }), /连接|授权/);
  f.state.authorized = true;
  await f.engine.command({ type: 'run_feed_collection', collectionId: f.collection.id, input: { text: '执行保护' }, requestId: 'active' });
  await until(() => f.clients[0].calls.filter(c => c.method === 'turn/start').length === 2);
  await assert.rejects(f.engine.command({ ...f.command, requestId: 'during-run' }), /执行结束/);
  assert.equal(f.writes.length, 0);
});

test('a Notion tool error retains its message and never silently resends the same remote intent', async t => {
  let rejected = true;
  const f = await connectedFixture(t, () => rejected ? { isError: true, content: [{ type: 'text', text: '父页面没有编辑权限' }] } : { structuredContent: { pages: [child] } });
  await assert.rejects(f.engine.command(f.command), /编辑权限/);
  await assert.rejects(f.engine.command(f.command), /结果尚未确认/);
  assert.equal(f.writes.length, 1);
  rejected = false;
  const confirmedNewIntent = { ...f.command, requestId: 'new-after-check' };
  assert.equal((await f.engine.command(confirmedNewIntent)).notion!.createdPage?.title, '调研资料');
  await f.engine.command(confirmedNewIntent);
  assert.equal(f.writes.length, 2);
});

for (const failure of ['transport', 'malformed']) test(`an unknown Notion ${failure} result is never resent, including after reopening`, async t => {
  const f = await connectedFixture(t, () => { if (failure === 'transport') throw Error('Remote response lost'); return { structuredContent: { pages: [] } }; });
  await assert.rejects(f.engine.command(f.command), /结果尚未确认/);
  await assert.rejects(f.engine.command(f.command), /结果尚未确认/);
  await f.reopen();
  await assert.rejects(f.engine.command(f.command), /结果尚未确认/);
  assert.equal(f.writes.length, 1);
});

test('a parent read finishing after a collection edit cannot dispatch a stale remote creation', async t => {
  const f = await connectedFixture(t);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(done => release = done), reading = new Promise<void>(done => entered = done);
  t.after(() => release());
  f.state.beforeFetch = async () => { entered(); await gate; };
  const creation = f.engine.command(f.command); await reading;
  await f.engine.command({ type: 'edit_feed_collection', collectionId: f.collection.id, expectedRevision: f.collection.revision, changes: { name: '更新后的信息流' }, requestId: 'edit-during-create' });
  release(); await assert.rejects(creation, /版本冲突/);
  assert.equal(f.writes.length, 0);
  const collection = (await f.engine.command({ type: 'get_feed_collection', collectionId: f.collection.id })).collection!.collection;
  assert.equal(collection.name, '更新后的信息流'); assert.equal(collection.notion?.target, undefined);
});
