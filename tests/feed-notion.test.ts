import test from 'node:test';
import assert from 'node:assert/strict';
import { feedFixture } from './feed-runtime-fixture.js';
import { until } from './runtime-fixture.js';

test('each feed connects its own native Notion workspace and retains its selected destination', async t => {
  const connections = new Map<string, { name: string; authorized: boolean; workspace: string }>();
  const f = await feedFixture(t, (method, params, options) => {
    let connection = connections.get(options.home);
    if (!connection) { connection = { name: '', authorized: false, workspace: `workspace-${connections.size + 1}` }; connections.set(options.home, connection); }
    if (method === 'config/batchWrite') { connection.name = params.edits.find((edit: any) => edit.keyPath.startsWith('mcp_servers.')).keyPath.slice('mcp_servers.'.length); return {}; }
    if (method === 'mcpServerStatus/list') return { data: connection.name ? [{ name: connection.name, authStatus: connection.authorized ? 'oAuth' : 'notLoggedIn', tools: {} }] : [], nextCursor: null };
    if (method === 'mcpServer/oauth/login') return { authorizationUrl: `https://mcp.notion.com/authorize?login=${connection.workspace}`, loginId: connection.workspace };
    if (method === 'mcpServer/tool/call') {
      assert.equal(params.server, connection.name);
      const value = params.tool === 'notion-get-self' ? { workspace: { id: connection.workspace, name: connection.workspace }, user: { type: 'person' } }
        : params.tool === 'notion-search' ? { results: [{ id: `page-${connection.workspace}`, title: '成果', url: `https://www.notion.so/page-${connection.workspace}` }] }
        : { id: params.arguments.id, title: '成果', url: `https://www.notion.so/${params.arguments.id}`, metadata: { type: 'page' } };
      return { content: [{ type: 'text', text: JSON.stringify(value) }] };
    }
  });
  const first = (await f.create('notion-a')).admission!, second = (await f.create('notion-b')).admission!;
  await until(() => f.clients.length === 2 && f.clients.every(client => client.calls.some(call => call.method === 'turn/start')));
  for (const admission of [first, second]) {
    const run = (await f.engine.command({ type: 'get_feed_collection', collectionId: admission.collectionId })).collection!.activeRun!;
    const client = f.clients.find(client => client.calls.some(call => call.method === 'turn/start' && call.params.threadId === run.threadId))!;
    await assert.rejects(f.engine.command({ type: 'connect_feed_notion', collectionId: admission.collectionId }), /执行结束/);
    client.options.onEvent({ method: 'turn/completed', params: { threadId: run.threadId, turn: { id: run.turnId, status: 'completed', items: [] } } });
    const login = (await f.engine.command({ type: 'connect_feed_notion', collectionId: admission.collectionId })).notion!;
    assert(login.authorizationUrl?.startsWith('https://mcp.notion.com/authorize'));
    assert.equal(login.connected, false);
    const connection = connections.get(client.options.home)!;
    client.options.onEvent({ method: 'mcpServer/oauthLogin/completed', params: { name: connection.name, loginId: 'stale-login', success: true } });
    assert.equal((await f.engine.command({ type: 'read_feed_notion', collectionId: admission.collectionId })).notion!.pending, true);
    connection.authorized = true;
    client.options.onEvent({ method: 'mcpServer/oauthLogin/completed', params: { name: connection.name, loginId: connection.workspace, success: true } });
    const connected = (await f.engine.command({ type: 'read_feed_notion', collectionId: admission.collectionId })).notion!;
    assert.equal(connected.connected, true); assert.equal(connected.workspace?.id, connection.workspace);
    const choices = (await f.engine.command({ type: 'search_feed_notion', collectionId: admission.collectionId, query: '成果' })).notion!.pages!;
    const collection = (await f.engine.command({ type: 'get_feed_collection', collectionId: admission.collectionId })).collection!.collection;
    await assert.rejects(f.engine.command({ type: 'set_feed_notion_target', collectionId: admission.collectionId, workspaceId: 'foreign-workspace', pageId: choices[0].id, expectedRevision: collection.revision, requestId: `foreign-${admission.collectionId}` }), /工作区已变化/);
    const save = { type: 'set_feed_notion_target' as const, collectionId: admission.collectionId, workspaceId: connection.workspace, pageId: choices[0].id, expectedRevision: collection.revision, requestId: `target-${admission.collectionId}` };
    const selected = (await f.engine.command(save)).notion!.target;
    const calls = client.calls.length;
    assert.deepEqual((await f.engine.command(save)).notion!.target, selected);
    assert.equal(client.calls.length, calls, 'accepted target replay uses its existing receipt');
  }
  const a = (await f.engine.command({ type: 'get_feed_collection', collectionId: first.collectionId })).collection!.collection;
  const b = (await f.engine.command({ type: 'get_feed_collection', collectionId: second.collectionId })).collection!.collection;
  assert.notEqual(a.notion?.target?.workspace.id, b.notion?.target?.workspace.id);
  assert.notEqual([...connections.values()][0].name, [...connections.values()][1].name);
  assert.equal(f.clients.flatMap(client => client.calls).filter(call => call.method === 'turn/start').length, 2);
  for (const [collection, index] of [[a, 0], [b, 1]] as const) {
    await f.engine.command({ type: 'run_feed_collection', collectionId: collection.id, requestId: `publish-${index}`, input: { text: '保存成果' } });
    await until(() => f.clients[index].calls.filter(call => call.method === 'turn/start').length === 2);
    const input = f.clients[index].calls.filter(call => call.method === 'turn/start').at(-1)!.params.input.map((item: any) => item.text ?? '').join('\n');
    assert(input.includes(collection.notion!.target!.workspace.id));
    assert(input.includes(collection.notion!.target!.url));
    assert(input.includes([...connections.values()][index].name));
    const nativeConfig = f.clients[index].calls.filter(call => call.method === 'thread/resume').at(-1)!.params.config.mcp_servers[[...connections.values()][index].name];
    assert.equal(nativeConfig.default_tools_approval_mode, 'approve');
    assert.deepEqual(nativeConfig.enabled_tools, ['notion-get-self', 'notion-search', 'notion-fetch', 'notion-create-pages']);
    const run = (await f.engine.command({ type: 'get_feed_collection', collectionId: collection.id })).collection!.activeRun!;
    f.clients[index].options.onEvent({ method: 'turn/completed', params: { threadId: run.threadId, turn: { id: run.turnId, status: 'completed', items: [] } } });
  }
  await f.reopen();
  assert.deepEqual((await f.engine.command({ type: 'get_feed_collection', collectionId: first.collectionId })).collection!.collection.notion, a.notion);
  assert.deepEqual((await f.engine.command({ type: 'get_feed_collection', collectionId: second.collectionId })).collection!.collection.notion, b.notion);
  const current = (await f.engine.command({ type: 'get_feed_collection', collectionId: first.collectionId })).collection!.collection;
  await f.engine.command({ type: 'set_feed_notion_target', collectionId: first.collectionId, workspaceId: a.notion!.target!.workspace.id, pageId: null, expectedRevision: current.revision, requestId: 'clear-notion-target' });
  await f.engine.command({ type: 'run_feed_collection', collectionId: first.collectionId, requestId: 'after-clear-target', input: { text: '只保存本地' } });
  const last = f.clients.at(-1)!;
  await until(() => last.calls.some(call => call.method === 'turn/start'));
  assert.equal(last.calls.find(call => call.method === 'thread/resume')!.params.config.mcp_servers[[...connections.values()][0].name].enabled, false);
  assert.equal(last.calls.find(call => call.method === 'turn/start')!.params.input.some((item: any) => item.text?.includes(a.notion!.target!.url)), false);
});

test('a late Notion destination lookup cannot overwrite a newer feed edit', async t => {
  let server = '', release!: () => void, entered!: () => void;
  const gate = new Promise<void>(done => release = done), reading = new Promise<void>(done => entered = done);
  const f = await feedFixture(t, async (method, params) => {
    if (method === 'config/batchWrite') { server = params.edits[0].keyPath.slice('mcp_servers.'.length); return {}; }
    if (method === 'mcpServer/oauth/login') return { authorizationUrl: 'https://mcp.notion.com/authorize', loginId: 'lookup-login' };
    if (method === 'mcpServerStatus/list') return { data: [{ name: server, authStatus: 'oAuth', tools: {} }] };
    if (method === 'mcpServer/tool/call') {
      if (params.tool === 'notion-get-self') return { content: [{ type: 'text', text: JSON.stringify({ workspace: { id: 'workspace-a', name: 'A' } }) }] };
      entered(); await gate;
      return { content: [{ type: 'text', text: JSON.stringify({ id: 'page-a', title: 'A', url: 'https://www.notion.so/page-a', metadata: { type: 'page' } }) }] };
    }
  });
  const admission = (await f.create('late-target')).admission!;
  await until(() => f.clients[0]?.calls.some(call => call.method === 'turn/start') === true);
  const before = (await f.engine.command({ type: 'get_feed_collection', collectionId: admission.collectionId })).collection!;
  f.clients[0].options.onEvent({ method: 'turn/completed', params: { threadId: before.activeRun!.threadId, turn: { id: before.activeRun!.turnId, status: 'completed', items: [] } } });
  await f.engine.command({ type: 'connect_feed_notion', collectionId: admission.collectionId });
  f.clients[0].options.onEvent({ method: 'mcpServer/oauthLogin/completed', params: { name: server, loginId: 'lookup-login', success: true } });
  const collection = (await f.engine.command({ type: 'get_feed_collection', collectionId: admission.collectionId })).collection!.collection;
  const pending = f.engine.command({ type: 'set_feed_notion_target', collectionId: collection.id, workspaceId: 'workspace-a', pageId: 'page-a', expectedRevision: collection.revision, requestId: 'late-lookup' });
  await reading;
  await f.engine.command({ type: 'edit_feed_collection', collectionId: collection.id, expectedRevision: collection.revision, requestId: 'rename-during-lookup', changes: { name: '保留最新名称' } });
  release(); await assert.rejects(pending, /版本冲突/);
  const latest = (await f.engine.command({ type: 'get_feed_collection', collectionId: collection.id })).collection!.collection;
  assert.equal(latest.name, '保留最新名称'); assert.equal(latest.notion?.target, undefined);
});

test('Notion configuration preserves disconnected unreconciled work and still blocks a live uncertain turn', async t => {
  let server = '', authorized = false;
  const f = await feedFixture(t, (method, params) => {
    if (method === 'turn/interrupt') throw Error('Controlled interruption result is unknown');
    if (method === 'config/batchWrite') { server = params.edits[0].keyPath.slice('mcp_servers.'.length); return {}; }
    if (method === 'mcpServer/oauth/login') return { authorizationUrl: 'https://mcp.notion.com/authorize', loginId: 'configure-unknown' };
    if (method === 'mcpServerStatus/list') return { data: [{ name: server, authStatus: authorized ? 'oAuth' : 'notLoggedIn', tools: {} }] };
    if (method === 'mcpServer/tool/call') return { structuredContent: params.tool === 'notion-get-self' ? { workspace: { id: 'workspace-a', name: 'Team A' } }
      : params.tool === 'notion-search' ? { results: [{ id: 'page-a', title: '成果', url: 'https://www.notion.so/page-a' }] }
      : { id: 'page-a', title: '成果', url: 'https://www.notion.so/page-a', metadata: { type: 'page' } } };
  });
  const admission = (await f.create('configure-unknown')).admission!;
  await until(() => f.clients[0]?.calls.some(call => call.method === 'turn/start') === true);
  const id = admission.collectionId, original = (await f.engine.command({ type: 'get_feed_collection', collectionId: id })).collection!;
  await f.engine.command({ type: 'send_feed_message', collectionId: id, requestId: 'queued-unknown', input: { text: '保留排队输入' } });
  await f.engine.command({ type: 'stop_feed_run', runId: admission.runId, requestId: 'stop-unknown' });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal((await f.engine.command({ type: 'get_feed_collection', collectionId: id })).collection!.activeRun?.status, 'needs_reconciliation');
  await assert.rejects(f.engine.command({ type: 'connect_feed_notion', collectionId: id }), /执行结束/);
  f.clients[0].options.onDisconnect('Controlled native process exit');
  const login = (await f.engine.command({ type: 'connect_feed_notion', collectionId: id })).notion!;
  assert.equal(login.pending, true);
  authorized = true;
  f.clients.at(-1)!.options.onEvent({ method: 'mcpServer/oauthLogin/completed', params: { name: server, loginId: 'configure-unknown', success: true } });
  const connected = (await f.engine.command({ type: 'read_feed_notion', collectionId: id })).notion!;
  assert.equal(connected.workspace?.id, 'workspace-a');
  const pages = (await f.engine.command({ type: 'search_feed_notion', collectionId: id, query: '成果' })).notion!.pages!;
  const current = (await f.engine.command({ type: 'get_feed_collection', collectionId: id })).collection!;
  await f.engine.command({ type: 'set_feed_notion_target', collectionId: id, workspaceId: 'workspace-a', pageId: pages[0].id, expectedRevision: current.collection.revision, requestId: 'target-unknown' });
  assert.equal(f.clients.at(-1)!.calls.some(call => call.method === 'thread/resume'), false, 'configuration must not resume the unresolved business thread');
  assert.equal(f.clients.at(-1)!.calls.some(call => call.method === 'turn/start'), false, 'configuration must not dispatch a business turn');
  await f.reopen();
  assert.equal((await f.engine.command({ type: 'read_feed_notion', collectionId: id })).notion!.workspace?.id, 'workspace-a');
  const after = (await f.engine.command({ type: 'get_feed_collection', collectionId: id })).collection!;
  assert.equal(after.collection.threadId, original.collection.threadId);
  assert.deepEqual(after.activeRun?.inputSnapshot, original.activeRun!.inputSnapshot);
  assert.equal(after.activeRun?.id, admission.runId); assert.equal(after.activeRun?.status, 'needs_reconciliation'); assert.equal(after.queuedCount, 1);
  await f.engine.command({ type: 'set_feed_notion_target', collectionId: id, workspaceId: 'workspace-a', pageId: null, expectedRevision: after.collection.revision, requestId: 'clear-unknown' });
  assert.equal((await f.engine.command({ type: 'get_feed_collection', collectionId: id })).collection!.collection.notion?.target, undefined);
});
