import test from 'node:test';
import assert from 'node:assert/strict';
import { openFeedFixture, reloadFeed, createCollection, openCollection, storedForm, saveResult } from './feed-electron-fixture.mjs';
import { accountFixture } from './account-fixture.ts';

test('new draft keeps legacy text and immutable create admission across reload', async t => {
  const f = await openFeedFixture(t);
  const legacy = { fields: { name: '旧暂名', instruction: '旧版未发送目标', sourcePreferences: '保留字段', materials: [] }, version: 4 };
  await f.engine.command({ type: 'save_feed_draft', draft: { key: 'collection:new', text: JSON.stringify(legacy) }, expectedRevision: 0, requestId: 'legacy-draft' });
  await f.click('.feed-workspace button', '新建采集'); await f.poll(() => f.evaluate('document.querySelector("[aria-label=采集需求]")?.value==="旧版未发送目标"'));
  f.rejectCommitted(c => c.type === 'create_feed_collection'); await f.click('.feed-new form button', '发送');
  await f.poll(() => f.evaluate('document.body.textContent.includes("确认丢失")')); const pending = (await storedForm(f)).pending;
  await f.fill('[aria-label="采集需求"]', '下一份独立目标'); await f.poll(async () => (await storedForm(f)).fields.instruction === '下一份独立目标');
  await reloadFeed(f); await f.click('.feed-workspace button', '新建采集'); await f.poll(() => f.evaluate('document.querySelector("[aria-label=采集需求]")?.value==="下一份独立目标"'));
  assert.deepEqual((await storedForm(f)).pending, pending); await f.click('.feed-new form button', '重试原提交'); await f.poll(() => f.evaluate('!!document.querySelector(".feed-collection h2")'));
  assert.equal((await f.engine.command({ type: 'feed_snapshot' })).feed.snapshot.collections.length, 1);
  await f.click('.feed-collection>header button', '返回信息流'); await f.click('.feed-workspace button', '新建采集');
  assert.equal(await f.evaluate('document.querySelector("[aria-label=采集需求]").value'), '下一份独立目标');
});
test('independent message drafts and immutable retry consume only the submitted version', async t => {
  const f = await openFeedFixture(t), a = await createCollection(f, '任务 A'); await createCollection(f, '任务 B');
  await openCollection(f, '任务 A'); await f.fill('[aria-label="继续沟通目标"]', 'A 独立草稿');
  await openCollection(f, '任务 B'); await f.fill('[aria-label="继续沟通目标"]', 'B 独立草稿');
  await openCollection(f, '任务 A'); assert.equal(await f.evaluate('document.querySelector("[aria-label=继续沟通目标]").value'), 'A 独立草稿');
  f.rejectCommitted(c => c.type === 'send_feed_message'); await f.click('.feed-message-form button', '发送'); await f.poll(() => f.evaluate('document.body.textContent.includes("确认丢失")'));
  await f.fill('[aria-label="继续沟通目标"]', 'A 新编辑'); await f.poll(async () => (await storedForm(f, `collection:${a.collectionId}:message`)).fields.text === 'A 新编辑');
  await reloadFeed(f); await openCollection(f, '任务 A'); await f.click('.feed-message-form button', '重试原消息');
  await f.poll(async () => !(await storedForm(f, `collection:${a.collectionId}:message`)).pending);
  assert.equal((await f.engine.command({ type: 'list_feed_runs', collectionId: a.collectionId })).feed.runs.items.filter(run => run.inputSnapshot.text === 'A 独立草稿').length, 1);
  assert.equal(await f.evaluate('document.querySelector("[aria-label=继续沟通目标]").value'), 'A 新编辑');
  await openCollection(f, '任务 B'); assert.equal(await f.evaluate('document.querySelector("[aria-label=继续沟通目标]").value'), 'B 独立草稿');
  await f.click('.feed-queued button', '撤回排队输入');
  await f.poll(() => f.evaluate('!document.querySelector(".feed-queued")'));
});
test('late message acknowledgement after remount preserves newer edits', async t => {
  const f = await openFeedFixture(t), a = await createCollection(f, '重开对话'); await openCollection(f, '重开对话');
  await f.fill('[aria-label="继续沟通目标"]', '已发送'); const held = f.hold(c => c.type === 'send_feed_message'); await f.click('.feed-message-form button', '发送'); await held.arrived;
  await f.click('.feed-collection>header button', '返回信息流'); await openCollection(f, '重开对话'); await f.fill('[aria-label="继续沟通目标"]', '重开的新消息'); held.release();
  await f.poll(async () => !(await storedForm(f, `collection:${a.collectionId}:message`)).pending);
  assert.equal(await f.evaluate('document.querySelector("[aria-label=继续沟通目标]").value'), '重开的新消息');
});
test('result and conversation page depth survive an unrelated draft push during pagination', async t => {
  const f = await openFeedFixture(t), a = await createCollection(f, '分页采集');
  await f.engine.command({ type: 'stop_feed_run', runId: a.runId, requestId: 'hold-pages' });
  const collections = f.engine.feed.collections;
  f.engine.feed.service.store.transaction(() => { for (let i = 0; i < 65; i++) {
    collections.enqueue(a.collectionId, { text: `历史问题 ${i}` }, 'message', `history-${i}`);
    saveResult(f, a, `结果 ${i}`, `完整正文 ${i}`);
  } }); f.engine.feed.changed(); await openCollection(f, '分页采集');
  await f.poll(() => f.evaluate('document.querySelectorAll(".feed-result").length===50'));
  const held = f.hold(c => c.type === 'list_feed_results' && !!c.cursor); await f.click('.feed-results button', '加载更多结果'); await held.arrived;
  const refreshed = f.hold(c => c.type === 'list_feed_results' && !c.cursor);
  await f.engine.command({ type: 'save_feed_draft', draft: { key: 'unrelated', text: 'unrelated durable push' }, expectedRevision: 0, requestId: 'page-push' });
  await refreshed.arrived; refreshed.release(); held.release();
  await f.poll(() => f.evaluate('document.querySelectorAll(".feed-result").length===65'));
  await f.click('.feed-conversation button', '加载更早对话'); await f.poll(() => f.evaluate('document.querySelectorAll(".feed-message").length===66'));
  await f.fill('[aria-label="继续沟通目标"]', '保留分页'); await f.poll(async () => !!await storedForm(f, `collection:${a.collectionId}:message`));
  assert.equal(await f.evaluate('document.querySelectorAll(".feed-result").length'), 65);
  assert.equal(await f.evaluate('document.querySelectorAll(".feed-message").length'), 66);
});
test('late result body response cannot cross collection navigation', async t => {
  const f = await openFeedFixture(t), a = await createCollection(f, '结果 A'), b = await createCollection(f, '结果 B');
  const entry = saveResult(f, a, 'A 独立结果', '只能属于 A'); saveResult(f, b, 'B 独立结果', '只能属于 B'); f.engine.feed.changed();
  const held = f.hold(c => c.type === 'get_feed_entry' && c.entryId === entry.entryId); await openCollection(f, '结果 A'); await held.arrived;
  await openCollection(f, '结果 B'); await f.poll(() => f.evaluate('document.querySelector(".feed-results").textContent.includes("只能属于 B")')); held.release();
  await f.fill('[aria-label="继续沟通目标"]', 'B 新消息'); assert.equal(await f.evaluate('document.querySelector(".feed-results").textContent.includes("只能属于 A")'), false);
});
test('native pushes without durable revision preserve request ownership, conversation separation and detail fencing', async t => {
 const account=accountFixture(),clients=[];let thread=0,turn=0;
 const f=await openFeedFixture(t,{accountFactory:account.factory,nativeFactory(options){const client={options,calls:[],replies:[]};clients.push(client);return {async connect(){},async close(){},respond(id,result){client.replies.push({id,result});},reject(){},async rpc(method,params){client.calls.push({method,params});if(method==='account/read')return {account:{email:'fixture'}};if(method==='model/list')return {data:[{model:'fixture-model',displayName:'Fixture',isDefault:true,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium',description:''}]}],nextCursor:null};if(method==='skills/list'||method==='hooks/list')return {data:[]};if(method==='plugin/installed'||method==='plugin/list')return {marketplaces:[],marketplaceLoadErrors:[]};if(method==='mcpServerStatus/list')return {data:[],nextCursor:null};if(method==='windowsSandbox/readiness')return {status:'notConfigured'};if(method==='thread/start'||method==='thread/resume')return {thread:{id:params.threadId??`thread-${++thread}`},model:'fixture-model',sandbox:{type:'workspaceWrite'},approvalPolicy:'on-request'};if(method==='turn/start'){const id=`turn-${++turn}`;options.onEvent({method:'turn/started',params:{threadId:params.threadId,turn:{id}}});return {turn:{id}};}if(method==='thread/items/list')return {data:[],nextCursor:null};return {};}};}});
 const admissions = [];
 for (const name of ['原生任务 A', '原生任务 B']) {
   await f.click('.feed-workspace button', '新建采集'); await f.fill('[aria-label="采集需求"]', name); await f.click('.feed-new form button', '发送');
   await f.poll(() => f.evaluate(`document.querySelector('.feed-collection h2')?.textContent===${JSON.stringify(name)}`));
   const c = (await f.engine.command({ type: 'feed_snapshot' })).feed.snapshot.collections.find(c => c.name === name);
   const run = (await f.engine.command({ type: 'list_feed_runs', collectionId: c.id })).feed.runs.items[0];
   assert.equal(run.trigger, 'message'); assert.equal(run.inputSnapshot.text, name); admissions.push({ collectionId: c.id, runId: run.id });
   await f.click('.feed-collection>header button', '返回信息流');
 }
 const [a, b] = admissions;
 await f.poll(async () => (await f.engine.command({ type: 'get_feed_collection', collectionId: b.collectionId })).feed.collection.activeRun?.status === 'running', 400);
 await openCollection(f, '原生任务 A');
 const runtime = f.engine.feed.runtimes.get(a.collectionId), run = (await f.engine.command({ type: 'get_feed_collection', collectionId: a.collectionId })).feed.collection.activeRun;
 const stable = f.engine.feed.snapshot(), request = { id: 'fixture-approval', method: 'item/commandExecution/requestApproval', params: { threadId: run.threadId, turnId: run.turnId, command: '读取公开来源' } };
 runtime.requests.set('fixture-key', request); runtime.requestRuns.set(request, run.id); f.engine.feed.changed(); assert.equal(f.engine.feed.snapshot().revision, stable.revision);
 await f.poll(() => f.evaluate('document.querySelector(".native-request")?.textContent.includes("读取公开来源")'));
 const held = f.hold(c => c.type === 'get_feed_collection' && c.collectionId === a.collectionId); f.engine.feed.changed(); await held.arrived;
 await openCollection(f, '原生任务 B'); held.release(); assert.equal(await f.evaluate('document.querySelector(".feed-collection h2").textContent'), '原生任务 B');
 assert.equal(await f.evaluate('!!document.querySelector(".native-request")'), false);
 f.emitFeed({ ...stable, generation: stable.generation - 1, revision: 999999, storageError: 'stale notification must be ignored' }); await openCollection(f, '原生任务 A');
 assert.equal(await f.evaluate('document.body.textContent.includes("stale notification must be ignored")'), false);
 await f.click('.native-request button', '批准这次操作'); await f.poll(() => f.evaluate('!document.querySelector(".native-request")')); assert(clients.some(c => c.replies.some(reply => reply.id === 'fixture-approval')));
 const client = clients.find(c => c.calls.some(call => call.method === 'turn/start' && call.params.threadId === run.threadId));
 client.options.onEvent({ method: 'item/completed', params: { threadId: run.threadId, turnId: run.turnId, item: { id: 'answer', type: 'agentMessage', text: '**普通助手回答**\n[危险](javascript:alert(1))' } } });
 await f.poll(() => f.evaluate('document.querySelector(".feed-conversation")?.textContent.includes("普通助手回答")'));
 assert.equal(await f.evaluate('document.querySelector(".feed-results").textContent.includes("普通助手回答")'), false);
 assert.equal(await f.evaluate('!!document.querySelector(".feed-conversation a[href^=javascript]")'), false);
 assert.equal((await f.engine.command({ type: 'list_feed_results', collectionId: a.collectionId })).feed.results.items.length, 0);
 await f.click('.feed-collection button', '停止本次运行');
 await f.poll(async () => clients.some(c => c.calls.some(call => call.method === 'turn/interrupt')));
});
