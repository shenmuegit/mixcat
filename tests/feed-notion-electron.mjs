import test from 'node:test';
import assert from 'node:assert/strict';
import { accountFixture } from './account-fixture.ts';
import { openFeedFixture, createCollection, openCollection } from './feed-electron-fixture.mjs';

test('feed Notion dialog opens native authorization and keeps workspace targets separate', async t => {
  const account = accountFixture(), clients = [], profiles = new Map(); let sequence = 0, holdIdentity = false, releaseIdentity, identityEntered, finishTurns = true;
  let identityGate = new Promise(done => releaseIdentity = done);
  const readingIdentity = new Promise(done => identityEntered = done);
  t.after(() => releaseIdentity());
  const f = await openFeedFixture(t, { accountFactory: account.factory, nativeFactory(options) {
    const client = profiles.get(options.home) ?? { name: '', authorized: false, workspace: `workspace-${profiles.size}`, label: `团队 ${profiles.size ? 'B' : 'A'}`, login: 0 };
    client.options = options; profiles.set(options.home, client); clients.push(client);
    return { async connect() {}, async close() {}, async rpc(method, params) {
      if (method === 'account/read') return { account: { email: 'fixture' } };
      if (method === 'model/list') return { data: [{ model: 'fixture-model', displayName: 'Fixture', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '' }] }], nextCursor: null };
      if (['skills/list', 'hooks/list'].includes(method)) return { data: [] };
      if (['plugin/list', 'plugin/installed'].includes(method)) return { marketplaces: [], marketplaceLoadErrors: [] };
      if (method === 'windowsSandbox/readiness') return { status: 'notConfigured' };
      if (method === 'config/batchWrite') { client.name = params.edits[0].keyPath.slice('mcp_servers.'.length); return {}; }
      if (method === 'mcpServerStatus/list') return { data: client.name ? [{ name: client.name, authStatus: client.authorized ? 'oAuth' : 'notLoggedIn', tools: {} }] : [], nextCursor: null };
      if (method === 'mcpServer/oauth/login') { client.login++; return { loginId: `${client.workspace}-${client.login}`, authorizationUrl: `https://mcp.notion.com/authorize?workspace=${client.workspace}` }; }
      if (method === 'mcpServer/tool/call') {
        if (holdIdentity && params.tool === 'notion-get-self') { identityEntered(); await identityGate; }
        const result = params.tool === 'notion-get-self' ? { workspace: { id: client.workspace, name: client.label } }
          : params.tool === 'notion-search' ? { results: [{ id: `target-${client.workspace}`, title: `${client.label}成果`, url: `https://www.notion.so/target-${client.workspace}` }] }
          : { id: params.arguments.id, title: `${client.label}成果`, url: `https://www.notion.so/${params.arguments.id}`, metadata: { type: client.workspace.endsWith('0') ? 'page' : 'database' } };
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      if (['thread/start', 'thread/resume'].includes(method)) return { thread: { id: params.threadId ?? `notion-thread-${++sequence}` }, model: 'fixture-model', sandbox: { type: 'workspaceWrite' }, approvalPolicy: 'on-request' };
      if (method === 'turn/start') { const id = `notion-turn-${++sequence}`; options.onEvent({ method: 'turn/started', params: { threadId: params.threadId, turn: { id } } }); if (finishTurns) queueMicrotask(() => options.onEvent({ method: 'turn/completed', params: { threadId: params.threadId, turn: { id, status: 'completed', items: [] } } })); return { turn: { id } }; }
      return {};
    } };
  } });
  const a = await createCollection(f, '甲的信息流'), b = await createCollection(f, '乙的信息流');
  for (const [name, index] of [['甲的信息流', 0], ['乙的信息流', 1]]) {
    await openCollection(f, name); await f.click('.feed-notion-trigger');
    await f.click('.feed-notion button', '连接 Notion');
    try { await f.poll(() => f.openedUrls.length === index + 1); }
    catch (error) { console.log(JSON.stringify({ index, opened: f.openedUrls, dialog: await f.evaluate('document.querySelector(".feed-notion")?.innerText') })); throw error; }
    assert.equal(f.openedUrls[index], `https://mcp.notion.com/authorize?workspace=workspace-${index}`);
    assert(await f.evaluate('document.querySelector(".feed-notion").innerText.includes("完成授权")'));
    const client = clients[index]; client.authorized = true;
    client.options.onEvent({ method: 'mcpServer/oauthLogin/completed', params: { name: client.name, loginId: `${client.workspace}-${client.login}`, success: true } });
    await f.poll(() => f.evaluate(`document.querySelector('.feed-notion').innerText.includes(${JSON.stringify(client.label)})`));
    await f.fill('[aria-label="搜索 Notion 保存位置"]', '成果'); await f.click('.feed-notion button', '搜索');
    if (index) {
      await f.poll(() => f.evaluate('!!document.querySelector(".feed-notion-pages button")'));
      await f.evaluate('document.querySelector(".feed-notion-pages button").focus()');
      for (const type of ['keyDown', 'keyUp']) await f.rpc('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) });
    } else await f.click('.feed-notion-pages button', `${client.label}成果`);
    await f.click('.feed-notion button', '保存位置');
    await f.poll(() => f.evaluate(`document.querySelector('.feed-notion').innerText.includes('当前保存位置')`));
    await f.screenshot(`notion-${index}.png`);
    await f.click('[aria-label="关闭弹窗"]');
    await f.poll(() => f.evaluate('document.activeElement.matches(".feed-notion-trigger")'));
  }
  const ac = (await f.engine.command({ type: 'get_feed_collection', collectionId: a.collectionId })).feed.collection.collection;
  const bc = (await f.engine.command({ type: 'get_feed_collection', collectionId: b.collectionId })).feed.collection.collection;
  assert.equal(ac.notion.target.workspace.id, 'workspace-0'); assert.equal(bc.notion.target.workspace.id, 'workspace-1'); assert.equal(bc.notion.target.type, 'database');
  await openCollection(f, '甲的信息流'); await f.fill('[aria-label="继续沟通目标"]', '授权与选择位置后保留草稿'); await f.click('.feed-notion-trigger');
  await f.poll(() => f.evaluate('document.querySelector(".feed-notion").innerText.includes("团队 A")'));
  const gate = f.hold(command => command.type === 'search_feed_notion');
  await f.fill('[aria-label="搜索 Notion 保存位置"]', '迟到'); await f.click('.feed-notion button', '搜索'); await gate.arrived;
  await f.click('[aria-label="关闭弹窗"]'); await openCollection(f, '乙的信息流'); await f.click('.feed-notion-trigger'); gate.release();
  await f.poll(() => f.evaluate('document.querySelector(".feed-notion").innerText.includes("团队 B")'));
  await f.poll(() => f.evaluate('!document.querySelector(".feed-notion input").disabled'));
  assert.equal(await f.evaluate('document.querySelector(".feed-notion").innerText.includes("团队 A")'), false);
  for (const [width, height] of [[1460, 850], [850, 720]]) {
    await f.rpc('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    assert.equal(await f.evaluate('document.documentElement.scrollWidth>innerWidth'), false);
    await f.screenshot(`notion-${width}-${height}.png`);
  }
  await f.click('[aria-label="关闭弹窗"]'); holdIdentity = true;
  await f.click('.feed-notion-trigger'); await readingIdentity;
  f.emitFeed((await f.engine.command({ type: 'feed_snapshot' })).feed.snapshot);
  await f.evaluate('new Promise(done=>setTimeout(done,100))');
  assert(await f.evaluate('document.querySelector(".feed-notion").innerText.includes("正在读取连接")'), 'unrelated snapshots must not replace an in-flight identity read');
  holdIdentity = false; releaseIdentity();
  await f.poll(() => f.evaluate('document.querySelector(".feed-notion").innerText.includes("团队 B")&&!document.querySelector(".feed-notion input").disabled'));
  await f.click('.feed-notion button', '重新连接 Notion');
  await f.poll(() => f.openedUrls.length === 3);
  const client = clients[1];
  client.options.onEvent({ method: 'mcpServer/oauthLogin/completed', params: { name: client.name, loginId: 'stale-attempt', success: true } });
  assert(await f.evaluate('document.querySelector(".feed-notion").innerText.includes("完成授权")'));
  client.options.onEvent({ method: 'mcpServer/oauthLogin/completed', params: { name: client.name, loginId: `${client.workspace}-${client.login}`, success: false, error: '授权超时，请重新连接' } });
  await f.poll(() => f.evaluate('document.querySelector(".feed-notion").innerText.includes("授权超时")'));
  await f.click('.feed-notion button', '重新连接 Notion');
  await f.poll(() => f.openedUrls.length === 4);
  client.options.onEvent({ method: 'mcpServer/oauthLogin/completed', params: { name: client.name, loginId: `${client.workspace}-${client.login}`, success: true } });
  await f.poll(() => f.evaluate('document.querySelector(".feed-notion").innerText.includes("团队 B")&&!document.querySelector(".feed-notion").innerText.includes("授权超时")'));
  await f.click('[aria-label="关闭弹窗"]');
  client.options.onDisconnect('Fixture native connection closed');
  let coldReadEntered;
  identityGate = new Promise(done => releaseIdentity = done);
  const coldRead = new Promise(done => coldReadEntered = done);
  holdIdentity = true; identityEntered = coldReadEntered;
  await f.click('.feed-notion-trigger'); await coldRead;
  f.emitFeed((await f.engine.command({ type: 'feed_snapshot' })).feed.snapshot);
  await f.evaluate('new Promise(done=>setTimeout(done,100))');
  assert(await f.evaluate('document.querySelector(".feed-notion").innerText.includes("正在读取连接")'), 'runtime replacement must preserve the in-flight identity read');
  holdIdentity = false; releaseIdentity();
  await f.poll(() => f.evaluate('document.querySelector(".feed-notion").innerText.includes("团队 B")&&!document.querySelector(".feed-notion input").disabled'));
  await f.click('.feed-notion button', '重新连接 Notion');
  await f.poll(() => f.openedUrls.length === 5);
  const disconnected = client.options, disconnectedAttempt = client.login;
  disconnected.onDisconnect('Fixture connection lost during OAuth');
  await f.poll(() => f.evaluate('document.querySelector(".feed-notion").innerText.includes("授权连接已断开")&&!document.querySelector(".feed-notion").innerText.includes("完成授权")'));
  await f.click('.feed-notion button', '重新连接 Notion');
  await f.poll(() => f.openedUrls.length === 6);
  assert.equal(client.login, disconnectedAttempt + 1, 'reconnect must start a new native login rather than reopen the expired URL');
  disconnected.onEvent({ method: 'mcpServer/oauthLogin/completed', params: { name: client.name, loginId: `${client.workspace}-${disconnectedAttempt}`, success: true } });
  assert(await f.evaluate('document.querySelector(".feed-notion").innerText.includes("完成授权")'));
  client.options.onEvent({ method: 'mcpServer/oauthLogin/completed', params: { name: client.name, loginId: `${client.workspace}-${client.login}`, success: true } });
  await f.poll(() => f.evaluate('document.querySelector(".feed-notion").innerText.includes("团队 B")&&!document.querySelector(".feed-notion").innerText.includes("授权连接已断开")'));
  await f.click('[aria-label="关闭弹窗"]'); finishTurns = false;
  const running = (await f.engine.command({ type: 'run_feed_collection', collectionId: a.collectionId, requestId: 'unresolved-run', input: { text: '保留待核对运行' } })).feed.admission;
  await f.poll(async () => (await f.engine.command({ type: 'get_feed_collection', collectionId: a.collectionId })).feed.collection.activeRun?.status === 'running');
  await f.engine.command({ type: 'send_feed_message', collectionId: a.collectionId, requestId: 'unresolved-queue', input: { text: '保留排队输入' } });
  const draft = (await f.engine.command({ type: 'read_feed_draft', key: `collection:${a.collectionId}:message` })).feed.draft;
  await openCollection(f, '甲的信息流');
  assert.equal(await f.evaluate('document.querySelector(".feed-notion-trigger").disabled'), false, 'the configuration entry must remain openable');
  await f.click('.feed-notion-trigger');
  await f.poll(() => f.evaluate('document.querySelector(".feed-notion").innerText.includes("执行结束")'));
  assert(await f.evaluate('[...document.querySelectorAll(".feed-notion button")].find(button=>button.textContent.includes("连接 Notion")).disabled'));
  await f.click('[aria-label="关闭弹窗"]');
  const first = clients[0]; first.options.onDisconnect('Controlled process exit during collection');
  await f.poll(async () => (await f.engine.command({ type: 'get_feed_collection', collectionId: a.collectionId })).feed.collection.activeRun?.status === 'needs_reconciliation');
  await f.click('.feed-notion-trigger');
  await f.poll(() => f.evaluate('document.querySelector(".feed-notion").innerText.includes("团队 A")&&!document.querySelector(".feed-notion input").disabled'));
  await f.click('.feed-notion button', '重新连接 Notion'); await f.poll(() => f.openedUrls.length === 7);
  first.options.onEvent({ method: 'mcpServer/oauthLogin/completed', params: { name: first.name, loginId: `${first.workspace}-${first.login}`, success: true } });
  await f.poll(() => f.evaluate('!!document.querySelector(".feed-notion input")&&!document.querySelector(".feed-notion input").disabled'));
  await f.fill('[aria-label="搜索 Notion 保存位置"]', '成果'); await f.click('.feed-notion button', '搜索');
  await f.click('.feed-notion-pages button', '团队 A成果'); await f.click('.feed-notion button', '保存位置');
  await f.poll(() => f.evaluate('document.querySelector(".feed-notion").innerText.includes("当前保存位置")&&!document.querySelector(".feed-notion input").disabled'));
  const preserved = (await f.engine.command({ type: 'get_feed_collection', collectionId: a.collectionId })).feed.collection;
  assert.equal(preserved.activeRun.id, running.runId); assert.equal(preserved.activeRun.status, 'needs_reconciliation'); assert.equal(preserved.queuedCount, 1);
  assert.deepEqual((await f.engine.command({ type: 'read_feed_draft', key: `collection:${a.collectionId}:message` })).feed.draft, draft);
  await f.screenshot('notion-unreconciled.png');
  console.log(JSON.stringify({ fixture: f.fixture, browserAuthorization: true, independentWorkspaces: true, pageAndDatabase: true, lateResponseIsolated: true, configureWhileDisconnected: true }));
});
