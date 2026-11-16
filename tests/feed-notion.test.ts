import test from 'node:test';
import assert from 'node:assert/strict';
import { feedFixture } from './feed-runtime-fixture.js';
import { until } from './runtime-fixture.js';

for (const connectedAfterTimeout of [false, true]) test(`Notion OAuth timeout resolves to actual ${connectedAfterTimeout ? 'connected' : 'disconnected'} state`, async t => {
  let server = '', authorized = false, logins = 0;
  const f = await feedFixture(t, (method, params) => {
    if (method === 'config/batchWrite') { server = params.edits[0].keyPath.slice('mcp_servers.'.length); return {}; }
    if (method === 'mcpServerStatus/list') return { data: server ? [{ name: server, authStatus: authorized ? 'oAuth' : 'notLoggedIn', tools: {} }] : [] };
    if (method === 'mcpServer/oauth/login') return { authorizationUrl: `https://mcp.notion.com/authorize?attempt=${++logins}`, loginId: `login-${logins}` };
    if (method === 'mcpServer/tool/call') return { structuredContent: { workspace: { id: 'workspace', name: 'Team' } } };
  });
  const id = (await f.create(`timeout-${connectedAfterTimeout}`)).admission!.collectionId;
  await until(() => f.clients[0]?.calls.some(call => call.method === 'turn/start') === true);
  const client = f.clients[0], run = (await f.engine.command({ type: 'get_feed_collection', collectionId: id })).collection!.activeRun!;
  client.options.onEvent({ method: 'turn/completed', params: { threadId: run.threadId, turn: { id: run.turnId, status: 'completed', items: [] } } });
  const first = (await f.engine.command({ type: 'connect_feed_notion', collectionId: id })).notion!;
  authorized = connectedAfterTimeout;
  client.options.onEvent({ method: 'mcpServer/oauthLogin/completed', params: { name: server, loginId: first.loginId, success: false, error: 'timed out waiting for OAuth callback' } });
  const settled = (await f.engine.command({ type: 'read_feed_notion', collectionId: id })).notion!;
  assert.equal(settled.connected, connectedAfterTimeout);
  assert.equal(settled.pending, false);
  assert.equal(settled.error, undefined, 'A completed OAuth timeout must not remain the connection state');
  assert.equal(settled.authorizationUrl, undefined);
  if (!connectedAfterTimeout) {
    const second = (await f.engine.command({ type: 'connect_feed_notion', collectionId: id })).notion!;
    assert.notEqual(second.loginId, first.loginId); assert.notEqual(second.authorizationUrl, first.authorizationUrl);
    client.options.onEvent({ method: 'mcpServer/oauthLogin/completed', params: { name: server, loginId: first.loginId, success: false, error: 'timed out waiting for OAuth callback' } });
    const pending = (await f.engine.command({ type: 'read_feed_notion', collectionId: id })).notion!;
    assert.equal(pending.pending, true); assert.equal(pending.loginId, second.loginId); assert.equal(pending.error, undefined);
    authorized = true;
    assert.equal((await f.engine.command({ type: 'read_feed_notion', collectionId: id })).notion!.connected, true, 'Native authorization may finish before its callback notification');
  }
  const before = client.calls.length, count = logins;
  const connected = (await f.engine.command({ type: 'connect_feed_notion', collectionId: id })).notion!;
  assert.equal(connected.connected, true); assert.equal(connected.pending, false); assert.equal(connected.authorizationUrl, undefined); assert.equal(logins, count);
  assert(!client.calls.slice(before).some(call => ['config/batchWrite', 'config/mcpServer/reload', 'mcpServer/oauth/login'].includes(call.method)), 'An existing connection needs no new configuration or OAuth');
});

test('Notion directories use native sidebar pages, opaque pagination and real child blocks', async t => {
  let server = '', truncated = false, authorized = true;
  const codeExamples = [
    '<callout icon="💡">\n```xml\n<page url="https://www.notion.so/callout-example">Example</page>\n```\n</callout>',
    '<callout icon="💡">\n\t```xml\n\t<page url="https://www.notion.so/indented-example">Example</page>\n\t```\n</callout>',
    '<details>\n<summary>Example</summary>\n\t~~~xml\n\t<page url="https://www.notion.so/details-example">Example</page>\n\t~~~\n</details>',
    '- Example\n\t```xml\n\t<page url="https://www.notion.so/list-example">Example</page>\n\t```',
    '````xml\n```\n<page url="https://www.notion.so/nested-example">Example</page>\n```\n````',
    '`First line\n<page url="https://www.notion.so/inline-example">Example</page>\nLast line`',
    '``First ` line\n<database url="https://www.notion.so/inline-database">Example</database>\nLast line``',
    '<mention url="https://www.notion.so/mention">First ` line\n<page url="https://www.notion.so/mention-example">Example</page>\nLast line</mention>',
    '`Example\n<page>\nEnd`',
    '<mention url="https://www.notion.so/mention">Example\n<page>\nEnd</mention>',
    '<mention url="https://www.notion.so/self-closing" />',
    '`<mention url="https://www.notion.so/inline-mention">`',
    '<callout>\n\t<page url="https://www.notion.so/nested-real">Real `title`</page>\n</callout>',
  ].join('\n');
  const f = await feedFixture(t, (method, p) => {
    if (method === 'config/batchWrite') { server = p.edits[0].keyPath.slice('mcp_servers.'.length); return {}; }
    if (method === 'mcpServer/oauth/login') return { authorizationUrl: 'https://mcp.notion.com/authorize', loginId: 'browse' };
    if (method === 'mcpServerStatus/list') return { data: [{ name: server, authStatus: authorized ? 'oAuth' : 'notLoggedIn', tools: {} }] };
    if (method === 'mcpServer/tool/call') {
      const args = p.arguments;
      if (p.tool === 'notion-get-self') return { structuredContent: { workspace: { id: 'workspace', name: 'Team' } } };
      if (p.tool === 'notion-list-private-pages') return { structuredContent: args.cursor ? { results: [{ type: 'page', title: 'Root', url: 'https://www.notion.so/root' }] } : { results: [], nextCursor: 'opaque-page-2' } };
      if (p.tool === 'notion-list-shared-pages') return { structuredContent: { results: [{ type: 'database', url: 'https://www.notion.so/database' }] } };
      if (p.tool === 'notion-fetch') return { structuredContent: { id: args.id, title: 'Root', url: args.id, metadata: { type: 'page' }, truncated,
        text: '<page url="https://www.notion.so/root">\n<ancestor-path><page url="https://www.notion.so/ancestor">Ancestor</page></ancestor-path>\n<properties>{"title":"literal <content>"}</properties>\n<content>\n<page url="https://www.notion.so/child">Child &amp; notes</page>\n<database inline="true" url="https://www.notion.so/child-db">Data</database>\n\n```xml\n<page url="https://www.notion.so/example">Example</page>\n</content>\n```\n' + codeExamples + '\n<mention url="https://www.notion.so/mention">Mention</mention>\n<page url="https://www.notion.so/last">Last</page>\n</content>\n</page>' } };
    }
  });
  const admission = (await f.create('directory')).admission!;
  await until(() => f.clients[0]?.calls.some(call => call.method === 'turn/start') === true);
  const before = (await f.engine.command({ type: 'get_feed_collection', collectionId: admission.collectionId })).collection!;
  f.clients[0].options.onEvent({ method: 'turn/completed', params: { threadId: before.activeRun!.threadId, turn: { id: before.activeRun!.turnId, status: 'completed', items: [] } } });
  await f.engine.command({ type: 'connect_feed_notion', collectionId: admission.collectionId });
  f.clients[0].options.onEvent({ method: 'mcpServer/oauthLogin/completed', params: { name: server, loginId: 'browse', success: true } });
  const first = (await f.engine.command({ type: 'list_feed_notion_pages', collectionId: admission.collectionId, section: 'private' })).notion!;
  assert.deepEqual(first.pages, []); assert.equal(first.nextCursor, 'opaque-page-2');
  const next = (await f.engine.command({ type: 'list_feed_notion_pages', collectionId: admission.collectionId, section: 'private', cursor: first.nextCursor })).notion!;
  assert.equal(next.pages![0].id, 'https://www.notion.so/root');
  assert.equal(f.clients[0].calls.filter(call => call.method === 'mcpServer/tool/call' && call.params.tool === 'notion-list-private-pages').at(-1)!.params.arguments.cursor, 'opaque-page-2');
  const shared = (await f.engine.command({ type: 'list_feed_notion_pages', collectionId: admission.collectionId, section: 'shared' })).notion!;
  assert.equal(shared.pages![0].type, 'database');
  const children = (await f.engine.command({ type: 'list_feed_notion_children', collectionId: admission.collectionId, pageId: next.pages![0].id })).notion!;
  assert.deepEqual(children.pages?.map(page => [page.id, page.title, page.type]), [['https://www.notion.so/child', 'Child & notes', 'page'], ['https://www.notion.so/child-db', 'Data', 'database'], ['https://www.notion.so/nested-real', 'Real `title`', 'page'], ['https://www.notion.so/last', 'Last', 'page']]);
  truncated = true;
  await assert.rejects(f.engine.command({ type: 'list_feed_notion_children', collectionId: admission.collectionId, pageId: next.pages![0].id }), /完整/);
  authorized = false;
  const expired = (await f.engine.command({ type: 'list_feed_notion_pages', collectionId: admission.collectionId, section: 'private' })).notion!;
  assert.equal(expired.connected, false); assert.match(expired.error!, /重新连接/);
  assert.equal((await f.engine.command({ type: 'get_feed_collection', collectionId: admission.collectionId })).collection!.collection.threadId, before.collection.threadId);
});

test('Notion remains readable during execution while authorization and destination changes stay blocked', async t => {
  let server = '';
  const f = await feedFixture(t, (method, p) => {
    if (method === 'config/batchWrite') { server = p.edits[0].keyPath.slice('mcp_servers.'.length); return {}; }
    if (method === 'mcpServer/oauth/login') return { authorizationUrl: 'https://mcp.notion.com/authorize', loginId: 'active' };
    if (method === 'mcpServerStatus/list') return { data: [{ name: server, authStatus: 'oAuth', tools: {} }] };
    if (method === 'mcpServer/tool/call') return { structuredContent: p.tool === 'notion-get-self' ? { workspace: { id: 'workspace', name: 'Team' } }
      : p.tool === 'notion-list-private-pages' || p.tool === 'notion-list-shared-pages' ? { results: [{ type: 'page', title: 'Root', url: 'https://www.notion.so/root' }] }
      : p.tool === 'notion-search' ? { results: [{ id: 'child', title: 'Child', url: 'https://www.notion.so/child' }] }
      : { id: p.arguments.id, title: 'Root', url: p.arguments.id, metadata: { type: 'page' }, text: '<page>\n<content>\n<page url="https://www.notion.so/child">Child</page>\n</content>\n</page>' } };
  });
  const id = (await f.create('read-active')).admission!.collectionId;
  await until(() => f.clients[0]?.calls.some(c => c.method === 'turn/start') === true);
  const initial = (await f.engine.command({ type: 'get_feed_collection', collectionId: id })).collection!.activeRun!;
  f.clients[0].options.onEvent({ method: 'turn/completed', params: { threadId: initial.threadId, turn: { id: initial.turnId, status: 'completed', items: [] } } });
  await f.engine.command({ type: 'connect_feed_notion', collectionId: id });
  f.clients[0].options.onEvent({ method: 'mcpServer/oauthLogin/completed', params: { name: server, loginId: 'active', success: true } });
  const collection = (await f.engine.command({ type: 'get_feed_collection', collectionId: id })).collection!.collection;
  await f.engine.command({ type: 'set_feed_notion_target', collectionId: id, workspaceId: 'workspace', pageId: 'https://www.notion.so/root', expectedRevision: collection.revision, requestId: 'target-active' });
  await f.reopen();
  await f.engine.command({ type: 'run_feed_collection', collectionId: id, input: { text: 'Collect' }, requestId: 'run-active' });
  await until(() => f.clients[1]?.calls.some(c => c.method === 'turn/start') === true);
  const before = (await f.engine.command({ type: 'get_feed_collection', collectionId: id })).collection!;
  assert.equal(before.notionBusy, true);
  const client = f.clients[1], calls = client.calls.length;
  assert.equal((await f.engine.command({ type: 'read_feed_notion', collectionId: id })).notion!.connected, true);
  assert.equal((await f.engine.command({ type: 'list_feed_notion_pages', collectionId: id, section: 'private' })).notion!.pages![0].title, 'Root');
  assert.equal((await f.engine.command({ type: 'list_feed_notion_pages', collectionId: id, section: 'shared' })).notion!.pages![0].title, 'Root');
  assert.equal((await f.engine.command({ type: 'list_feed_notion_children', collectionId: id, pageId: 'https://www.notion.so/root' })).notion!.pages![0].title, 'Child');
  assert.equal((await f.engine.command({ type: 'search_feed_notion', collectionId: id, query: 'Child' })).notion!.pages![0].title, 'Child');
  assert(!client.calls.slice(calls).some(c => ['config/batchWrite', 'config/mcpServer/reload', 'thread/resume', 'turn/start'].includes(c.method)));
  assert(client.calls.slice(calls).filter(c => c.method === 'mcpServer/tool/call').every(c => c.params.threadId !== before.activeRun!.threadId));
  await assert.rejects(f.engine.command({ type: 'connect_feed_notion', collectionId: id }), /执行结束/);
  for (const pageId of ['https://www.notion.so/root', null]) await assert.rejects(f.engine.command({ type: 'set_feed_notion_target', collectionId: id, workspaceId: 'workspace', pageId, expectedRevision: before.collection.revision, requestId: pageId ? 'blocked-save' : 'blocked-clear' }), /执行结束/);
  const after = (await f.engine.command({ type: 'get_feed_collection', collectionId: id })).collection!;
  assert.deepEqual(after.collection, before.collection); assert.deepEqual(after.activeRun, before.activeRun);
  client.options.onEvent({ method: 'turn/completed', params: { threadId: before.activeRun!.threadId, turn: { id: before.activeRun!.turnId, status: 'completed', items: [] } } });
  assert.equal((await f.engine.command({ type: 'get_feed_collection', collectionId: id })).collection!.activeRun, null);
  assert.equal((await f.engine.command({ type: 'get_feed_collection', collectionId: id })).collection!.notionBusy, false);
});

test('Notion reads wait for native business startup and serialize concurrent control reads', async t => {
  let server = '', holdBusiness = false, holdIdentity = false, control = 0, releaseBusiness!: () => void, releaseIdentity!: () => void, enterBusiness!: () => void, enterIdentity!: () => void;
  const businessGate = new Promise<void>(done => releaseBusiness = done), identityGate = new Promise<void>(done => releaseIdentity = done);
  const businessEntered = new Promise<void>(done => enterBusiness = done), identityEntered = new Promise<void>(done => enterIdentity = done);
  t.after(() => { releaseBusiness(); releaseIdentity(); });
  const f = await feedFixture(t, async (method, p, options) => {
    if (method === 'config/batchWrite') { server = p.edits[0].keyPath.slice('mcp_servers.'.length); return {}; }
    if (method === 'mcpServer/oauth/login') return { authorizationUrl: 'https://mcp.notion.com/authorize', loginId: 'startup' };
    if (method === 'mcpServerStatus/list') return { data: [{ name: server, authStatus: 'oAuth', tools: {} }] };
    if (method === 'thread/start' || method === 'thread/resume') {
      const business = !!p.config?.mcp_servers?.mixcat_feed, id = business ? p.threadId ?? 'business' : `control-${++control}`;
      if (business && holdBusiness) { enterBusiness(); await businessGate; }
      options.onEvent({ method: 'thread/started', params: { thread: { id } } });
      return { thread: { id }, model: 'fixture-model', sandbox: { type: 'workspaceWrite' }, approvalPolicy: 'on-request' };
    }
    if (method === 'mcpServer/tool/call') {
      if (p.tool === 'notion-get-self') { if (holdIdentity) { enterIdentity(); await identityGate; } return { structuredContent: { workspace: { id: 'workspace', name: 'Team' } } }; }
      return { structuredContent: { results: [{ type: 'page', title: 'Root', url: 'https://www.notion.so/root' }] } };
    }
  });
  const id = (await f.create('startup-read')).admission!.collectionId;
  await until(() => f.clients[0]?.calls.some(c => c.method === 'turn/start') === true);
  const initial = (await f.engine.command({ type: 'get_feed_collection', collectionId: id })).collection!.activeRun!;
  f.clients[0].options.onEvent({ method: 'turn/completed', params: { threadId: initial.threadId, turn: { id: initial.turnId, status: 'completed', items: [] } } });
  await f.engine.command({ type: 'connect_feed_notion', collectionId: id });
  f.clients[0].options.onEvent({ method: 'mcpServer/oauthLogin/completed', params: { name: server, loginId: 'startup', success: true } });
  await f.reopen(); holdBusiness = true; holdIdentity = true;
  await f.engine.command({ type: 'run_feed_collection', collectionId: id, input: { text: 'Collect' }, requestId: 'startup-run' });
  await businessEntered;
  const first = f.engine.command({ type: 'read_feed_notion', collectionId: id }); void first.catch(() => {});
  const second = f.engine.command({ type: 'list_feed_notion_pages', collectionId: id, section: 'private' }); void second.catch(() => {});
  await new Promise<void>(done => setImmediate(done));
  assert.equal(control, 0, 'control startup must wait for the native business thread response');
  holdBusiness = false; releaseBusiness(); await identityEntered;
  assert.equal(control, 1, 'the second read must wait for the first control operation');
  releaseIdentity();
  assert.equal((await first).notion!.connected, true); assert.equal((await second).notion!.pages![0].title, 'Root');
  const after = (await f.engine.command({ type: 'get_feed_collection', collectionId: id })).collection!;
  assert.equal(after.activeRun!.status, 'running'); assert.equal(after.activeRun!.threadId, 'business');
  assert.equal(after.collection.threadId, 'business'); assert.equal(after.notionBusy, true);
  assert.equal(f.clients[1].calls.filter(c => c.method === 'turn/start').length, 1);
});

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
    assert.deepEqual(nativeConfig.enabled_tools, ['notion-get-self', 'notion-search', 'notion-fetch', 'notion-list-private-pages', 'notion-list-shared-pages', 'notion-create-pages']);
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
  let server = '', authorized = false, nativeTurn = '';
  const f = await feedFixture(t, (method, params) => {
    if (method === 'turn/interrupt') throw Error('Controlled interruption result is unknown');
    if (method === 'thread/read') return { thread: { id: params.threadId, turns: [{ id: nativeTurn, status: 'inProgress', items: [] }] } };
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
  nativeTurn = original.activeRun!.turnId!;
  await f.engine.command({ type: 'send_feed_message', collectionId: id, requestId: 'queued-unknown', input: { text: '保留排队输入' } });
  await f.engine.command({ type: 'stop_feed_run', runId: admission.runId, requestId: 'stop-unknown' });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal((await f.engine.command({ type: 'get_feed_collection', collectionId: id })).collection!.activeRun?.status, 'needs_reconciliation');
  assert.equal((await f.engine.command({ type: 'get_feed_collection', collectionId: id })).collection!.notionBusy, true);
  await assert.rejects(f.engine.command({ type: 'connect_feed_notion', collectionId: id }), /执行结束/);
  await f.engine.command({ type: 'reconcile_feed_run', runId: admission.runId, requestId: 'read-live-unknown' });
  await assert.rejects(f.engine.command({ type: 'connect_feed_notion', collectionId: id }), /执行结束/, 'reading history cannot unlock a possibly running turn');
  let snapshots = 0; t.after(f.engine.subscribe(() => snapshots++));
  const beforeDisconnect = snapshots;
  f.clients[0].options.onDisconnect('Controlled native process exit');
  assert(snapshots > beforeDisconnect, 'an already uncertain run disconnecting must notify open configuration views');
  assert.equal((await f.engine.command({ type: 'get_feed_collection', collectionId: id })).collection!.notionBusy, false);
  const login = (await f.engine.command({ type: 'connect_feed_notion', collectionId: id })).notion!;
  assert.equal(login.pending, true);
  await f.engine.command({ type: 'reconcile_feed_run', runId: admission.runId, requestId: 'read-disconnected-unknown' });
  assert.equal((await f.engine.command({ type: 'connect_feed_notion', collectionId: id })).notion!.pending, true, 'reading old history must not relock configuration');
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
