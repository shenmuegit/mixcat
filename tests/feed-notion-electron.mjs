import test from 'node:test';
import assert from 'node:assert/strict';
import { accountFixture } from './account-fixture.ts';
import { openFeedFixture, createCollection, openCollection } from './feed-electron-fixture.mjs';

test('feed Notion dialog opens native authorization and keeps workspace targets separate', async t => {
  const account = accountFixture(), clients = [], profiles = new Map(), createdPages = []; let sequence = 0, holdIdentity = false, releaseIdentity, identityEntered, finishTurns = true, failDirectory = false, failCreate = false;
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
        if (params.tool === 'notion-create-pages') {
          if (failCreate) { failCreate = false; return { isError: true, content: [{ type: 'text', text: '没有编辑权限，请检查父页面权限。' }] }; }
          const id = `33333333-3333-4333-8333-${String(createdPages.length + 1).padStart(12, '0')}`, page = { id, url: `https://www.notion.so/${id.replaceAll('-', '')}`, title: params.arguments.pages[0].properties.title, workspace: client.workspace };
          createdPages.push(page); return { structuredContent: { pages: [{ id: page.id, url: page.url }] } };
        }
        if (holdIdentity && params.tool === 'notion-get-self') { identityEntered(); await identityGate; }
        if (params.tool === 'notion-list-private-pages') {
          if (failDirectory) { failDirectory = false; throw Error('受控目录读取失败。'.repeat(100)); }
          return { structuredContent: { results: [{ type: 'page', title: `${client.label}${params.arguments.cursor ? '补充目录' : '目录'}`, url: `https://www.notion.so/root-${client.workspace}${params.arguments.cursor ? '-extra' : ''}` }], ...(!params.arguments.cursor && client.workspace.endsWith('1') ? { nextCursor: 'more' } : {}) } };
        }
        if (params.tool === 'notion-list-shared-pages') return { structuredContent: { results: [] } };
        if (params.tool === 'notion-fetch') {
          const created = createdPages.find(page => page.url === params.arguments.id || page.id === params.arguments.id);
          if (created) return { structuredContent: { ...created, metadata: { type: 'page' }, text: '<content/>' } };
          const root = params.arguments.id.includes('/root-'), type = root || client.workspace.endsWith('0') ? 'page' : 'database';
          return { structuredContent: { id: root ? '11111111-1111-4111-8111-111111111111' : params.arguments.id, title: `${client.label}${root ? '目录' : '成果'}`, url: params.arguments.id, metadata: { type }, text: `<page>\n<content>\n${root ? `<${client.workspace.endsWith('0') ? 'page' : 'database'} url="https://www.notion.so/target-${client.workspace}">${client.label}成果</${client.workspace.endsWith('0') ? 'page' : 'database'}>` : ''}\n</content>\n</page>` } };
        }
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
  async function watchCard() {
    return f.evaluate(`(()=>{const card=document.querySelector('dialog[aria-label="Notion 保存位置"]'),content=document.querySelector('.feed-notion');window.notionFrames=[];const measure=()=>{const r=card.getBoundingClientRect();const frame={same:card.isConnected&&document.querySelector('.feed-notion')===content,x:r.x,y:r.y,width:r.width,height:r.height};window.notionFrames.push(frame);return frame;};window.notionObserver=new MutationObserver(measure);window.notionObserver.observe(card,{subtree:true,childList:true,attributes:true});return measure();})()`);
  }
  async function stableCard(before, finish = false) {
    const frames = await f.evaluate(`${finish ? 'window.notionObserver.disconnect();' : ''}window.notionFrames`);
    assert(frames.every(frame => frame.same && ['x', 'y', 'width', 'height'].every(key => Math.abs(frame[key] - before[key]) < 1)), 'Notion updates must stay inside the same stable card');
  }
  const ready = () => f.poll(() => f.evaluate('!!document.querySelector(".feed-notion-pages[aria-busy=false]")&&document.querySelector(".feed-notion-content").getAttribute("aria-busy")==="false"'));
  async function expire(client) {
    client.authorized = false; await f.click('.feed-notion button', '刷新目录');
    await f.poll(() => f.evaluate('document.querySelector(".feed-notion-content>button.button").textContent==="未链接"&&!document.querySelector(".feed-notion-content>button.button").disabled'));
  }
  const a = await createCollection(f, '甲的信息流'), b = await createCollection(f, '乙的信息流');
  for (const [name, index] of [['甲的信息流', 0], ['乙的信息流', 1]]) {
    await openCollection(f, name); await f.click('.feed-notion-trigger');
    await f.poll(() => f.evaluate('document.querySelector(".feed-notion-content").getAttribute("aria-busy")==="false"'));
    const frame = await watchCard();
    await f.click('.feed-notion button', '未链接');
    try { await f.poll(() => f.openedUrls.length === index + 1); }
    catch (error) { console.log(JSON.stringify({ index, opened: f.openedUrls, dialog: await f.evaluate('document.querySelector(".feed-notion")?.innerText') })); throw error; }
    assert.equal(f.openedUrls[index], `https://mcp.notion.com/authorize?workspace=workspace-${index}`);
    await f.poll(() => f.evaluate('document.querySelector(".feed-notion-content>button.button").textContent==="等待授权"'));
    await stableCard(frame);
    const client = clients[index]; client.authorized = true;
    client.options.onEvent({ method: 'mcpServer/oauthLogin/completed', params: { name: client.name, loginId: `${client.workspace}-${client.login}`, success: true } });
    await f.poll(() => f.evaluate(`document.querySelector('.feed-notion').innerText.includes(${JSON.stringify(client.label)})`));
    await ready();
    assert(await f.evaluate('document.querySelector(".feed-notion-connected")?.disabled'), 'an established connection is a disabled status');
    await f.evaluate('document.querySelector(".feed-notion-connected").click()'); assert.equal(f.openedUrls.length, index + 1);
    assert.equal(await f.evaluate(`!!document.querySelector('[aria-label="搜索 Notion 保存位置"]')`), false);
    assert(await f.evaluate('document.querySelector(".feed-notion-new-page")?.disabled'), 'root directory needs a parent page before creation');
    if (index) { await f.click('.feed-notion button', '加载更多'); await ready(); }
    await f.click('.feed-notion-enter'); await ready();
    if (index) {
      await f.evaluate('document.querySelector(".feed-notion-choice").focus()');
      for (const type of ['keyDown', 'keyUp']) await f.rpc('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) });
    } else {
      await f.click('.feed-notion-enter'); await ready(); assert(await f.evaluate('document.querySelector(".feed-notion-pages").innerText.includes("没有子页面")'));
      await f.click('.feed-notion-path button', '团队 A目录'); await ready();
      await f.click('.feed-notion-new-page');
      for (const type of ['keyDown', 'keyUp']) await f.rpc('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await f.poll(() => f.evaluate('!document.querySelector(".feed-notion-create")&&document.activeElement.matches(".feed-notion-new-page")'));
      await f.click('.feed-notion-new-page'); await f.fill('input[name="notion-page-title"]', '   ');
      assert(await f.evaluate('document.querySelector(".feed-notion-create button[type=submit]").disabled'));
      assert(await f.evaluate('document.querySelector(".feed-notion-actions .primary").disabled'), 'the unfinished new page cannot accidentally save its parent instead');
      await f.fill('input[name="notion-page-title"]', '新建调研目录'); failCreate = true;
      for (const type of ['keyDown', 'keyUp']) await f.rpc('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) });
      await f.poll(() => f.evaluate('document.querySelector(".feed-notion-create").innerText.includes("没有编辑权限")'));
      assert.equal(await f.evaluate('document.querySelector("input[name=notion-page-title]").value'), '新建调研目录');
      await f.click('.feed-notion-create button', '取消'); await f.click('.feed-notion button', '刷新目录'); await ready();
      await f.click('.feed-notion-new-page'); await f.fill('input[name="notion-page-title"]', '新建调研目录');
      const creating = f.hold(command => command.type === 'create_feed_notion_page');
      await f.click('.feed-notion-create button[type=submit]'); await creating.arrived;
      assert(await f.evaluate('document.querySelector(".feed-notion-create button[type=submit]").disabled'));
      await f.evaluate('document.querySelector(".feed-notion-create button[type=submit]").click()');
      assert.equal(createdPages.length, 1); creating.release();
      await f.poll(() => f.evaluate('document.querySelector(".feed-notion-choice[aria-pressed=true]")?.textContent.includes("新建调研目录")'));
      assert.equal((await f.engine.command({type:'get_feed_collection',collectionId:a.collectionId})).feed.collection.collection.notion?.target, undefined);
    }
    await f.click('.feed-notion button', '保存位置');
    await f.poll(() => f.evaluate(`document.querySelector('.feed-notion').innerText.includes('当前保存位置')`));
    await stableCard(frame, true);
    await f.screenshot(`notion-${index}.png`);
    await f.click('[aria-label="关闭弹窗"]');
    await f.poll(() => f.evaluate('document.activeElement.matches(".feed-notion-trigger")'));
  }
  const ac = (await f.engine.command({ type: 'get_feed_collection', collectionId: a.collectionId })).feed.collection.collection;
  const bc = (await f.engine.command({ type: 'get_feed_collection', collectionId: b.collectionId })).feed.collection.collection;
  assert.equal(ac.notion.target.workspace.id, 'workspace-0'); assert.equal(bc.notion.target.workspace.id, 'workspace-1'); assert.equal(bc.notion.target.type, 'database');
  assert.equal(ac.notion.target.title, '新建调研目录'); assert.equal(ac.notion.target.url, createdPages[0].url);
  await openCollection(f, '甲的信息流'); await f.click('.feed-notion-trigger'); await ready(); await f.click('.feed-notion-enter'); await ready();
  await f.click('.feed-notion-new-page'); await f.fill('input[name="notion-page-title"]', '迟到的新页面');
  const lateCreate = f.hold(command => command.type === 'create_feed_notion_page');
  await f.click('.feed-notion-create button[type=submit]'); await lateCreate.arrived;
  await f.click('[aria-label="关闭弹窗"]'); await openCollection(f, '乙的信息流'); await f.click('.feed-notion-trigger'); lateCreate.release(); await ready();
  assert(!await f.evaluate('document.querySelector(".feed-notion").innerText.includes("迟到的新页面")'));
  assert.equal((await f.engine.command({type:'get_feed_collection',collectionId:b.collectionId})).feed.collection.collection.notion.target.url, bc.notion.target.url);
  await f.click('[aria-label="关闭弹窗"]');
  await openCollection(f, '甲的信息流'); await f.fill('[aria-label="继续沟通目标"]', '授权与选择位置后保留草稿'); await f.click('.feed-notion-trigger');
  await f.poll(() => f.evaluate('document.querySelector(".feed-notion").innerText.includes("团队 A")'));
  await ready();
  const gate = f.hold(command => command.type === 'list_feed_notion_children');
  await f.click('.feed-notion-enter'); await gate.arrived;
  await f.click('[aria-label="关闭弹窗"]'); await openCollection(f, '乙的信息流'); await f.click('.feed-notion-trigger'); gate.release();
  await f.poll(() => f.evaluate('document.querySelector(".feed-notion").innerText.includes("团队 B")'));
  await ready();
  assert.equal(await f.evaluate('document.querySelector(".feed-notion").innerText.includes("团队 A")'), false);
  await f.click('[aria-label="页面区域"] button', '共享页面'); await ready();
  assert(await f.evaluate('document.querySelector(".feed-notion-pages").innerText.includes("暂无可访问")'));
  await f.click('[aria-label="页面区域"] button', '私人页面'); await ready();
  await f.click('.feed-notion-enter'); await ready();
  await f.click('.feed-notion-path button', '私人页面'); await ready();
  const directoryFrame = await watchCard();
  failDirectory = true; await f.click('.feed-notion button', '刷新目录');
  await f.poll(() => f.evaluate('document.querySelector(".feed-notion-pages").innerText.includes("受控目录读取失败")'));
  await stableCard(directoryFrame);
  assert(await f.evaluate('document.querySelector(".feed-notion-content").scrollHeight>document.querySelector(".feed-notion-content").clientHeight'));
  await f.evaluate('document.querySelector(".feed-notion-content").focus()');
  for (const type of ['keyDown', 'keyUp']) await f.rpc('Input.dispatchKeyEvent', { type, key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 });
  await f.poll(() => f.evaluate('document.querySelector(".feed-notion-content").scrollTop>0'));
  assert(await f.evaluate('(()=>{const b=document.querySelector("dialog .modal-heading button"),r=b.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()'));
  await f.click('.feed-notion button', '重试读取目录'); await ready();
  await stableCard(directoryFrame, true);
  await f.click('.feed-notion-enter'); await ready(); await f.click('.feed-notion-new-page');
  await f.fill('input[name="notion-page-title"]', '页面名称与目录控件在不同主题和窗口尺寸下保持可用');
  for (const theme of ['light', 'dark', 'violet']) for (const [width, height] of [[1460, 850], [850, 720]]) {
    await f.evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
    await f.rpc('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    assert.equal(await f.evaluate('document.documentElement.scrollWidth>innerWidth'), false);
    assert(await f.evaluate('(()=>{const b=document.querySelector(".feed-notion-create button[type=submit]"),r=b.getBoundingClientRect();return r.width>0&&r.top>=0&&r.bottom<=innerHeight;})()'));
    assert(await f.evaluate('(()=>{const b=document.querySelector(".feed-notion-actions .primary"),r=b.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()'));
    await f.screenshot(`notion-${theme}-${width}-${height}.png`);
  }
  await f.click('.feed-notion-create button', '取消');
  await f.click('[aria-label="关闭弹窗"]'); holdIdentity = true;
  await f.click('.feed-notion-trigger'); await readingIdentity;
  f.emitFeed((await f.engine.command({ type: 'feed_snapshot' })).feed.snapshot);
  await f.evaluate('new Promise(done=>setTimeout(done,100))');
  assert(await f.evaluate('document.querySelector(".feed-notion-content").getAttribute("aria-busy")==="true"'), 'unrelated snapshots must not replace an in-flight identity read');
  holdIdentity = false; releaseIdentity();
  await ready(); await expire(clients[1]);
  const errorFrame = await watchCard();
  await f.click('.feed-notion button', '未链接');
  await f.poll(() => f.openedUrls.length === 3);
  const client = clients[1];
  client.options.onEvent({ method: 'mcpServer/oauthLogin/completed', params: { name: client.name, loginId: 'stale-attempt', success: true } });
  await f.poll(() => f.evaluate('document.querySelector(".feed-notion-content>button.button").textContent==="等待授权"'));
  client.options.onEvent({ method: 'mcpServer/oauthLogin/completed', params: { name: client.name, loginId: `${client.workspace}-${client.login}`, success: false, error: '授权超时，请重新连接。'.repeat(100) } });
  await f.poll(() => f.evaluate('document.querySelector(".feed-notion-content>button.button").textContent==="未链接"&&!document.querySelector(".feed-notion-content>button.button").disabled'));
  await stableCard(errorFrame);
  assert(!await f.evaluate('document.querySelector(".feed-notion").innerText.includes("授权超时")'));
  assert(await f.evaluate('(()=>{const b=document.querySelector("dialog .modal-heading button"),r=b.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()'));
  await f.click('.feed-notion button', '未链接');
  await f.poll(() => f.openedUrls.length === 4);
  client.authorized = true;
  client.options.onEvent({ method: 'mcpServer/oauthLogin/completed', params: { name: client.name, loginId: `${client.workspace}-${client.login}`, success: true } });
  await f.poll(() => f.evaluate('document.querySelector(".feed-notion").innerText.includes("团队 B")&&!document.querySelector(".feed-notion").innerText.includes("授权超时")'));
  await stableCard(errorFrame, true);
  await f.click('[aria-label="关闭弹窗"]');
  client.options.onDisconnect('Fixture native connection closed');
  let coldReadEntered;
  identityGate = new Promise(done => releaseIdentity = done);
  const coldRead = new Promise(done => coldReadEntered = done);
  holdIdentity = true; identityEntered = coldReadEntered;
  await f.click('.feed-notion-trigger'); await coldRead;
  f.emitFeed((await f.engine.command({ type: 'feed_snapshot' })).feed.snapshot);
  await f.evaluate('new Promise(done=>setTimeout(done,100))');
  assert(await f.evaluate('document.querySelector(".feed-notion-content").getAttribute("aria-busy")==="true"'), 'runtime replacement must preserve the in-flight identity read');
  holdIdentity = false; releaseIdentity();
  await ready(); await expire(client);
  await f.click('.feed-notion button', '未链接');
  await f.poll(() => f.openedUrls.length === 5);
  const disconnected = client.options, disconnectedAttempt = client.login;
  disconnected.onDisconnect('Fixture connection lost during OAuth');
  await f.poll(() => client.options !== disconnected);
  await f.poll(() => f.evaluate('document.querySelector(".feed-notion-content").getAttribute("aria-busy")==="false"&&document.querySelector(".feed-notion-content>button.button").textContent==="未链接"&&!document.querySelector(".feed-notion-content>button.button").disabled'));
  await f.click('.feed-notion button', '未链接');
  await f.poll(() => f.openedUrls.length === 6);
  assert.equal(client.login, disconnectedAttempt + 1, 'reconnect must start a new native login rather than reopen the expired URL');
  disconnected.onEvent({ method: 'mcpServer/oauthLogin/completed', params: { name: client.name, loginId: `${client.workspace}-${disconnectedAttempt}`, success: true } });
  await f.poll(() => f.evaluate('document.querySelector(".feed-notion-content>button.button").textContent==="等待授权"'));
  client.authorized = true;
  client.options.onEvent({ method: 'mcpServer/oauthLogin/completed', params: { name: client.name, loginId: `${client.workspace}-${client.login}`, success: true } });
  await f.poll(() => f.evaluate('document.querySelector(".feed-notion").innerText.includes("团队 B")&&!document.querySelector(".feed-notion").innerText.includes("授权连接已断开")'));
  await f.click('[aria-label="关闭弹窗"]'); finishTurns = false;
  await f.engine.command({ type: 'run_feed_collection', collectionId: a.collectionId, requestId: 'view-active-run', input: { text: '执行中查看 Notion' } });
  await f.poll(async () => (await f.engine.command({ type: 'get_feed_collection', collectionId: a.collectionId })).feed.collection.activeRun?.status === 'running');
  await openCollection(f, '甲的信息流'); await f.click('.feed-notion-trigger');
  await ready();
  assert.equal(await f.evaluate('document.querySelector(".feed-notion-connected")?.textContent'), '已链接');
  assert.equal(await f.evaluate('document.querySelector(".feed-notion [role=alert]")'), null);
  assert(await f.evaluate('document.querySelector(".feed-notion-executing")?.textContent.includes("可查看连接和目录")'));
  const activeFrame = await watchCard();
  await f.click('.feed-notion-enter'); await ready(); await f.click('.feed-notion-choice', '团队 A成果');
  const activeChoice = await f.evaluate('document.querySelector(".feed-notion-actions p").textContent');
  assert(await f.evaluate('document.querySelector(".feed-notion-actions .primary").disabled'));
  assert(await f.evaluate('[...document.querySelectorAll(".feed-notion-actions button")].find(e=>e.textContent==="清除保存位置").disabled'));
  await f.screenshot('notion-active-read.png');
  const active = (await f.engine.command({ type: 'get_feed_collection', collectionId: a.collectionId })).feed.collection.activeRun;
  clients[0].options.onEvent({ method: 'turn/completed', params: { threadId: active.threadId, turn: { id: active.turnId, status: 'completed', items: [] } } });
  await f.poll(() => f.evaluate('!document.querySelector(".feed-notion-executing")&&!document.querySelector(".feed-notion-actions .primary").disabled'));
  assert.equal(await f.evaluate('document.querySelector(".feed-notion-actions p").textContent'), activeChoice);
  await stableCard(activeFrame, true); await f.click('[aria-label="关闭弹窗"]');
  const running = (await f.engine.command({ type: 'run_feed_collection', collectionId: a.collectionId, requestId: 'unresolved-run', input: { text: '保留待核对运行' } })).feed.admission;
  await f.poll(async () => (await f.engine.command({ type: 'get_feed_collection', collectionId: a.collectionId })).feed.collection.activeRun?.status === 'running');
  await f.engine.command({ type: 'send_feed_message', collectionId: a.collectionId, requestId: 'unresolved-queue', input: { text: '保留排队输入' } });
  const draft = (await f.engine.command({ type: 'read_feed_draft', key: `collection:${a.collectionId}:message` })).feed.draft;
  await openCollection(f, '甲的信息流');
  assert.equal(await f.evaluate('document.querySelector(".feed-notion-trigger").disabled'), false, 'the configuration entry must remain openable');
  await f.click('.feed-notion-trigger');
  await ready();
  assert(await f.evaluate('document.querySelector(".feed-notion-connected").disabled'));
  assert.equal(await f.evaluate('document.querySelector(".feed-notion [role=alert]")'), null);
  await f.click('[aria-label="关闭弹窗"]');
  const first = clients[0]; first.options.onDisconnect('Controlled process exit during collection');
  await f.poll(async () => (await f.engine.command({ type: 'get_feed_collection', collectionId: a.collectionId })).feed.collection.activeRun?.status === 'needs_reconciliation');
  await f.click('.feed-notion-trigger');
  await ready(); await f.click('.feed-notion-enter'); await ready();
  await f.click('.feed-notion-choice', '团队 A成果'); await f.click('.feed-notion button', '保存位置');
  await f.poll(() => f.evaluate('document.querySelector(".feed-notion").innerText.includes("当前保存位置")'));
  const preserved = (await f.engine.command({ type: 'get_feed_collection', collectionId: a.collectionId })).feed.collection;
  assert.equal(preserved.activeRun.id, running.runId); assert.equal(preserved.activeRun.status, 'needs_reconciliation'); assert.equal(preserved.queuedCount, 1);
  assert.deepEqual((await f.engine.command({ type: 'read_feed_draft', key: `collection:${a.collectionId}:message` })).feed.draft, draft);
  await f.screenshot('notion-unreconciled.png');
  console.log(JSON.stringify({ fixture: f.fixture, browserAuthorization: true, independentWorkspaces: true, pageAndDatabase: true, lateResponseIsolated: true, configureWhileDisconnected: true }));
});
