import test from 'node:test';
import assert from 'node:assert/strict';
import { openFeedFixture } from './feed-electron-fixture.mjs';
async function reload(f) { const origin = await f.evaluate('performance.timeOrigin'); await f.rpc('Page.reload'); await f.poll(async () => { try { return await f.evaluate(`performance.timeOrigin!==${origin}&&document.readyState==='complete'&&!!document.querySelector('.workspace-sidebar nav')`); } catch(error) { if (/Execution context|Cannot find context|Inspected target navigated or closed/i.test(String(error))) return false; throw error; } }); await f.click('.workspace-sidebar nav button', '信息流'); }
test('collection proposal cancels without creating and lost acknowledgement replays original after reload', async t => {
 const f=await openFeedFixture(t);
 await f.click('.feed-workspace button','新建采集');
 await f.fill('[aria-label="采集需求"]','每天了解文本工具');
 await f.click('.feed-proposal button','取消');
 assert.equal((await f.engine.command({type:'feed_snapshot'})).feed.snapshot.collections.length,0);
 await f.click('.feed-workspace button','新建采集');
 assert.equal(await f.evaluate('document.querySelector("[aria-label=采集需求]").value'),'每天了解文本工具');
 f.rejectCommitted(c=>c.type==='create_feed_collection');
 await f.click('.feed-proposal button','发送并开始');
 await f.poll(()=>f.evaluate('document.body.textContent.includes("确认丢失")'));
 await f.fill('[aria-label="采集需求"]','下一份尚未发送的研究');
 await f.poll(async()=>JSON.parse((await f.engine.command({type:'read_feed_draft',key:'collection:new'})).feed.draft.text).fields.instruction==='下一份尚未发送的研究');
 await reload(f); await f.click('.feed-workspace button','新建采集');
 await f.poll(()=>f.evaluate('document.querySelector("[aria-label=采集需求]")?.value==="下一份尚未发送的研究"'));
 await f.click('.feed-proposal button','重试原提交');
 await f.poll(()=>f.evaluate('!!document.querySelector(".feed-collection h2")'));
 assert.equal((await f.engine.command({type:'feed_snapshot'})).feed.snapshot.collections.length,1);
 await f.click('.feed-workspace button','新建采集');
 assert.equal(await f.evaluate('document.querySelector("[aria-label=采集需求]").value'),'下一份尚未发送的研究');
 await f.screenshot('collection-replayed.png');
});
async function create(f,name) { return (await f.engine.command({type:'create_feed_collection',requestId:crypto.randomUUID(),name,instruction:`长期 ${name}`,input:{text:`启动 ${name}`}})).feed.admission; }
async function openTask(f,name) { await f.click('[aria-label="个人工作区"] button','采集任务'); const back=await f.evaluate('!![...document.querySelectorAll(".feed-collection:not([hidden]) button")].find(e=>e.textContent==="返回采集任务"&&e.getBoundingClientRect().width)'); if(back) await f.click('.feed-collection-host > div:not([hidden]) .feed-collection button','返回采集任务'); await f.click('.feed-collection-list .feed-title',name); await f.poll(()=>f.evaluate(`!![...document.querySelectorAll('.feed-collection h2')].find(e=>e.textContent===${JSON.stringify(name)}&&e.getBoundingClientRect().width)`)); }
const visibleTask='.feed-collection-host > div:not([hidden]) .feed-collection';
test('collection message drafts, immutable send replay, schedule and queue controls through rendered inputs',async t=>{
 const f=await openFeedFixture(t),a=await create(f,'任务 A'),b=await create(f,'任务 B');
 await openTask(f,'任务 A'); await f.fill(`${visibleTask} [aria-label="临时追问"]`,'A 独立草稿');
 await openTask(f,'任务 B'); await f.fill(`${visibleTask} [aria-label="临时追问"]`,'B 独立草稿');
 await openTask(f,'任务 A'); assert.equal(await f.evaluate(`document.querySelector('${visibleTask} [aria-label="临时追问"]').value`),'A 独立草稿');
 f.rejectCommitted(c=>c.type==='send_feed_message'); await f.click(`${visibleTask} .feed-message-form button`,'发送追问'); await f.poll(()=>f.evaluate('document.body.textContent.includes("确认丢失")'));
 await f.fill(`${visibleTask} [aria-label="临时追问"]`,'A 新编辑');
 await f.poll(async()=>JSON.parse((await f.engine.command({type:'read_feed_draft',key:`collection:${a.collectionId}:message`})).feed.draft.text).fields.text==='A 新编辑');
 await reload(f); await openTask(f,'任务 A'); await f.click(`${visibleTask} .feed-message-form button`,'重试原消息');
 await f.poll(()=>f.evaluate(`!document.querySelector('${visibleTask} .feed-message-form').textContent.includes('重试原消息')`));
 assert.equal((await f.engine.command({type:'list_feed_runs',collectionId:a.collectionId})).feed.runs.items.filter(r=>r.trigger==='message').length,1);
 assert.equal((await f.engine.command({type:'get_feed_collection',collectionId:a.collectionId})).feed.collection.collection.instructionRevision,1);
 assert.equal(await f.evaluate(`document.querySelector('${visibleTask} [aria-label="临时追问"]').value`),'A 新编辑');
 await f.click(`${visibleTask} button`,'运行安排'); await f.click('[aria-label="运行频率"]'); await f.rpc('Input.dispatchKeyEvent',{type:'keyDown',key:'d',code:'KeyD',windowsVirtualKeyCode:68}); await f.rpc('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40}); await f.rpc('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
 await f.poll(()=>f.evaluate('!!document.querySelector("[aria-label=运行时区]")'));
 await f.fill('[aria-label="运行时区"]','Asia/Shanghai'); await f.click('.feed-editor button','保存设置');
 await f.poll(async()=> (await f.engine.command({type:'get_feed_collection',collectionId:a.collectionId})).feed.collection.collection.schedule.frequency!=='manual');
 await f.poll(()=>f.evaluate('!document.querySelector(".feed-editor")'));
 assert.equal(await f.evaluate('document.activeElement.textContent'),'运行安排');
 await f.click(`${visibleTask} button`,'暂停定时'); await f.poll(async()=>!(await f.engine.command({type:'get_feed_collection',collectionId:a.collectionId})).feed.collection.collection.schedule.enabled);
 await f.click(`${visibleTask} [aria-label="采集任务页签"] button`,'运行记录'); await f.click(`${visibleTask} .feed-runs button`,'撤回排队输入');
 await f.poll(async()=>(await f.engine.command({type:'list_feed_runs',collectionId:a.collectionId})).feed.runs.items.some(r=>r.status==='cancelled'));
 await f.screenshot('collection-wide.png');
 await f.rpc('Emulation.setDeviceMetricsOverride',{width:1100,height:850,deviceScaleFactor:1,mobile:false});
 assert(await f.evaluate(`(()=>{const e=document.querySelector('${visibleTask}');return e.scrollWidth<=e.clientWidth+1&&[...e.querySelectorAll('button')].filter(b=>b.getBoundingClientRect().width).every(b=>{const r=b.getBoundingClientRect();return r.width>10&&r.left>=0&&r.right<=innerWidth+1;});})()`));
 await f.screenshot('collection-narrow.png');
 console.log(JSON.stringify({viewport:await f.evaluate('({width:innerWidth,height:innerHeight})')}));
});
test('research selection cancels cleanly; older live source after deleted discovery pages receives unsent material',async t=>{
 const f=await openFeedFixture(t),a=await create(f,'有效来源'),b=await create(f,'已删除来源');
 const actor=(id,runId)=>({kind:'agent',collectionId:id,runId,threadId:'seed-thread',turnId:'seed-turn',callId:crypto.randomUUID()});
 const input={title:'多次发现的资料',body:'原始资料正文',sourceUrl:'https://example.org/material',coverage:'full'};
 const entry=f.engine.feed.service.saveResult('original-source',input,actor(a.collectionId,a.runId));
 for(let i=0;i<55;i++)f.engine.feed.service.saveResult(`repeat-${i}`,input,actor(b.collectionId,b.runId));
 await f.poll(async()=>!(await f.engine.command({type:'get_feed_collection',collectionId:b.collectionId})).feed.collection.activeRun,400);
 const deleted=(await f.engine.command({type:'get_feed_collection',collectionId:b.collectionId})).feed.collection.collection;
 await f.engine.command({type:'delete_feed_collection',collectionId:b.collectionId,expectedRevision:deleted.revision,requestId:'delete-b'});
 await f.click('.feed-title','多次发现的资料'); await f.click('.feed-reader button','追问这条资料');
 await f.poll(()=>f.evaluate(`document.querySelector('${visibleTask} h2')?.textContent==='有效来源'`));
 assert(await f.evaluate(`document.querySelector('${visibleTask} [aria-label="引用资料"]').textContent.includes('多次发现的资料')`));
 assert.equal((await f.engine.command({type:'list_feed_runs',collectionId:a.collectionId})).feed.runs.items.length,1);
 await f.fill(`${visibleTask} [aria-label="临时追问"]`,'解释资料'); await f.click(`${visibleTask} .feed-message-form button`,'发送追问');
 await f.poll(async()=>(await f.engine.command({type:'list_feed_runs',collectionId:a.collectionId})).feed.runs.items.length===2);
 const sent=(await f.engine.command({type:'list_feed_runs',collectionId:a.collectionId})).feed.runs.items[0]; assert.equal(sent.inputSnapshot.materials[0].entryId,entry.entryId);
 await f.engine.command({type:'update_feed_entry',mutation:{operation:'createText',input:{title:'第二份手动资料',body:'第二份正文',coverage:'full'},requestId:'manual-research'}});
 await f.click('[aria-label="个人工作区"] button','内容'); await f.click('.feed-reader button','返回列表').catch(async error=>{await f.screenshot('research-reader-failure.png');console.log(await f.evaluate(`({buttons:[...document.querySelectorAll('.feed-reader button')].map(e=>({text:e.textContent,rect:e.getBoundingClientRect().toJSON()})),reader:document.querySelector('.feed-reader')?.getBoundingClientRect().toJSON(),root:document.querySelector('.feed-workspace')?.getBoundingClientRect().toJSON(),content:document.querySelector('.feed-content-host')?.getBoundingClientRect().toJSON()})`));throw error;});
 await f.click('[aria-label="选择资料 多次发现的资料"]'); await f.click('[aria-label="选择资料 第二份手动资料"]');
 await f.click('.feed-content-host button','继续调研'); await f.fill('[aria-label="采集需求"]','比较两份资料'); await f.click('.feed-proposal button','取消');
 assert.equal((await f.engine.command({type:'feed_snapshot'})).feed.snapshot.collections.length,1);
 await f.click('.feed-content-host button','继续调研'); await f.click('.feed-proposal button','发送并开始');
 await f.poll(async()=>(await f.engine.command({type:'feed_snapshot'})).feed.snapshot.collections.length===2);
 const fresh=(await f.engine.command({type:'feed_snapshot'})).feed.snapshot.collections.find(c=>c.id!==a.collectionId);
 const run=(await f.engine.command({type:'list_feed_runs',collectionId:fresh.id})).feed.runs.items[0]; assert.equal(run.trigger,'research'); assert.equal(run.inputSnapshot.materials.length,2);
 assert.equal((await f.engine.command({type:'get_feed_collection',collectionId:a.collectionId})).feed.collection.collection.instructionRevision,1);
 await f.screenshot('research-materials.png');
});
import { accountFixture } from './account-fixture.ts';
test('native request push without revision change preserves task ownership and saves completed answers',async t=>{
 const account=accountFixture(),clients=[];let thread=0,turn=0;
 const f=await openFeedFixture(t,{accountFactory:account.factory,nativeFactory(options){const client={options,calls:[],replies:[]};clients.push(client);return {async connect(){},async close(){},respond(id,result){client.replies.push({id,result});},reject(){},async rpc(method,params){client.calls.push({method,params});if(method==='account/read')return {account:{email:'fixture'}};if(method==='model/list')return {data:[{model:'fixture-model',displayName:'Fixture',isDefault:true,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium',description:''}]}],nextCursor:null};if(method==='skills/list'||method==='hooks/list')return {data:[]};if(method==='plugin/installed'||method==='plugin/list')return {marketplaces:[],marketplaceLoadErrors:[]};if(method==='mcpServerStatus/list')return {data:[],nextCursor:null};if(method==='windowsSandbox/readiness')return {status:'notConfigured'};if(method==='thread/start'||method==='thread/resume')return {thread:{id:params.threadId??`thread-${++thread}`},model:'fixture-model',sandbox:{type:'workspaceWrite'},approvalPolicy:'on-request'};if(method==='turn/start'){const id=`turn-${++turn}`;options.onEvent({method:'turn/started',params:{threadId:params.threadId,turn:{id}}});return {turn:{id}};}if(method==='thread/items/list')return {data:[],nextCursor:null};return {};}};}});
 const a=await create(f,'原生任务 A'),b=await create(f,'原生任务 B');
 await f.poll(async()=>(await f.engine.command({type:'get_feed_collection',collectionId:b.collectionId})).feed.collection.activeRun?.status==='running',400);
 await openTask(f,'原生任务 A');
 const runtime=f.engine.feed.runtimes.get(a.collectionId),run=(await f.engine.command({type:'get_feed_collection',collectionId:a.collectionId})).feed.collection.activeRun;
 const stable=f.engine.feed.snapshot(),request={id:'fixture-approval',method:'item/commandExecution/requestApproval',params:{threadId:run.threadId,turnId:run.turnId,command:'读取公开来源'}};
 // Seed the ephemeral request boundary without a storage write, then exercise the real push/dispatcher contract.
 runtime.requests.set('fixture-key',request);runtime.requestRuns.set(request,run.id);f.engine.feed.changed();
 assert.equal(f.engine.feed.snapshot().revision,stable.revision);
 await f.poll(()=>f.evaluate(`document.querySelector('${visibleTask}')?.textContent.includes('读取公开来源')`));await f.screenshot('native-approval-conversation.png');
 const held=f.hold(c=>c.type==='get_feed_collection'&&c.collectionId===a.collectionId);f.engine.feed.changed();await held.arrived;
 await openTask(f,'原生任务 B');held.release();
 assert.equal(await f.evaluate(`document.querySelector('${visibleTask} h2').textContent`),'原生任务 B');assert.equal(await f.evaluate(`!!document.querySelector('${visibleTask} .native-request')`),false);
 f.emitFeed({...stable,generation:stable.generation-1,revision:999999,storageError:'stale notification must be ignored'});
 await openTask(f,'原生任务 A'); assert.equal(await f.evaluate('document.body.textContent.includes("stale notification must be ignored")'),false);
 await f.click(`${visibleTask} .native-request button`,'批准这次操作');await f.poll(()=>f.evaluate(`!document.querySelector('${visibleTask} .native-request')`));assert.equal(runtime.handle.client===undefined,false);assert(clients.some(c=>c.replies.some(reply=>reply.id==='fixture-approval')));
 const client=clients.find(c=>c.calls.some(call=>call.method==='turn/start'&&call.params.threadId===run.threadId));
 client.options.onEvent({method:'item/completed',params:{threadId:run.threadId,turnId:run.turnId,item:{id:'answer',type:'agentMessage',text:'**已完成回答**\n[危险](javascript:alert(1))'}}});
 await f.poll(()=>f.evaluate(`document.querySelector('${visibleTask}')?.textContent.includes('已完成回答')`));
 await f.click(`${visibleTask} .feed-message button`,'保存回答到信息流');await f.poll(async()=>(await f.engine.command({type:'search_feed_entries',query:{text:'已完成回答'}})).feed.entries.items.length===1);
 await f.click(`${visibleTask} .feed-message button`,'打开已保存回答');await f.poll(()=>f.evaluate('!!document.querySelector(".feed-reader strong")'));assert.equal(await f.evaluate('!!document.querySelector(".feed-reader a[href^=javascript]")'),false);
 await f.click('.feed-reader button','返回列表');await f.poll(()=>f.evaluate('document.activeElement.textContent==="打开已保存回答"'));assert.equal(await f.evaluate('document.activeElement.textContent'),'打开已保存回答');
 await f.click(`${visibleTask} [aria-label="采集任务页签"] button`,'结果');await f.poll(()=>f.evaluate(`document.querySelector('${visibleTask} .feed-results')?.textContent.includes('用户保存回答')`));
 await f.click(`${visibleTask} .feed-results .feed-title`,'已完成回答');await f.click('.feed-reader button','追问这条资料');await f.poll(()=>f.evaluate(`document.querySelector('${visibleTask} h2')?.textContent==='原生任务 A'`));await f.poll(()=>f.evaluate('document.activeElement.getAttribute("aria-label")==="临时追问"'));assert(await f.evaluate(`document.querySelector('${visibleTask} [aria-label="引用资料"]').textContent.includes('已完成回答')`));
 await f.screenshot('native-result-return.png');
});

test('collection page windows survive draft notifications and scoped run navigation',async t=>{
 const f=await openFeedFixture(t),a=await create(f,'分页任务');
 await f.engine.command({type:'stop_feed_run',runId:a.runId,requestId:'hold-pages'});
 const service=f.engine.feed.service,collections=f.engine.feed.collections;
 service.store.transaction(()=>{for(let index=0;index<65;index++){
  const admitted=collections.enqueue(a.collectionId,{text:`历史问题 ${index}`},'message',`page-run-${index}`);
  const actor={kind:'agent',collectionId:a.collectionId,runId:admitted.runId,threadId:'fixture-thread',turnId:`fixture-turn-${index}`,callId:`fixture-call-${index}`};
  service.saveResult(`page-result-${index}`,{title:`资料 ${index}`,body:`正文 ${index}`,coverage:'full'},actor);
  service.store.db.prepare('INSERT INTO feed_source_failures(run_id,body) VALUES(?,?)').run(admitted.runId,JSON.stringify({actor,url:`https://example.org/failure/${index}`,reason:`失败原因 ${index}`,createdAt:'2026-10-29T01:00:00Z'}));
 }});f.engine.feed.changed();
 await openTask(f,'分页任务');
 await f.click(`${visibleTask} .feed-conversation button`,'加载更早对话');await f.poll(()=>f.evaluate(`document.querySelectorAll('${visibleTask} .feed-message').length===66`));
 await f.fill(`${visibleTask} [aria-label="临时追问"]`,'分页保留草稿');
 await f.poll(async()=>!!(await f.engine.command({type:'read_feed_draft',key:`collection:${a.collectionId}:message`})).feed.draft);
 assert.equal(await f.evaluate(`document.querySelectorAll('${visibleTask} .feed-message').length`),66);
 await f.click(`${visibleTask} [aria-label="采集任务页签"] button`,'结果');await f.click(`${visibleTask} .feed-results button`,'加载更多结果');
 // Result expansion moves the following source rows; wait before measuring the next pointer target.
 await f.poll(()=>f.evaluate(`document.querySelectorAll('${visibleTask} .feed-results .feed-title').length===65`));
 await f.click(`${visibleTask} .feed-results button`,'加载更多失败来源');await f.poll(()=>f.evaluate(`document.querySelector('${visibleTask} .feed-results').textContent.includes('失败原因 0')`));
 await f.click(`${visibleTask} [aria-label="采集任务页签"] button`,'运行记录');await f.click(`${visibleTask} .feed-runs button`,'加载更多运行');await f.poll(()=>f.evaluate(`document.querySelectorAll('${visibleTask} .feed-runs article').length===66`));
 await f.click(`${visibleTask} .feed-runs button`,'查看本次结果');await f.poll(()=>f.evaluate(`document.querySelectorAll('${visibleTask} .feed-results .feed-title').length===1`));
 await f.click(`${visibleTask} button`,'查看全部运行内容');await f.poll(()=>f.evaluate(`document.querySelectorAll('${visibleTask} .feed-results .feed-title').length===65`));
 await f.screenshot('collection-pages-retained.png');
});
test('pending next failure page survives an unrelated durable draft push', async t => {
 const f = await openFeedFixture(t), a = await create(f, '在途分页');
 await f.engine.command({ type: 'stop_feed_run', runId: a.runId, requestId: 'hold-inflight-pages' });
 const service = f.engine.feed.service;
 service.store.transaction(() => { for (let index = 0; index < 65; index++) service.store.db.prepare('INSERT INTO feed_source_failures(run_id,body) VALUES(?,?)').run(a.runId, JSON.stringify({ actor: { kind: 'agent', collectionId: a.collectionId, runId: a.runId, threadId: 'thread', turnId: 'turn', callId: `failure-${index}` }, url: `https://example.org/${index}`, reason: `失败原因 ${index}`, createdAt: '2026-10-29T01:00:00Z' })); });
 f.engine.feed.changed(); await openTask(f, '在途分页');
 await f.click(`${visibleTask} [aria-label="采集任务页签"] button`, '结果');
 const next = f.hold(command => command.type === 'list_feed_failures' && !!command.cursor);
 await f.click(`${visibleTask} .feed-results button`, '加载更多失败来源'); await next.arrived;
 const refreshed = f.hold(command => command.type === 'list_feed_failures' && !command.cursor);
 await f.engine.command({ type: 'save_feed_draft', draft: { key: 'manual', text: 'unrelated persisted draft' }, expectedRevision: 0, requestId: 'inflight-draft' });
 await refreshed.arrived; refreshed.release(); next.release();
 await f.poll(() => f.evaluate(`document.querySelector('${visibleTask} .feed-results').textContent.includes('失败原因 0')`));
 await f.screenshot('failure-page-after-draft-push.png');
});
test('late collection creation cannot replace a newer reader and consumes only submitted draft version',async t=>{
 const f=await openFeedFixture(t);
 await f.engine.command({type:'update_feed_entry',mutation:{operation:'createText',input:{title:'正在阅读的资料',body:'现有资料',coverage:'full'},requestId:'navigation-entry'}});
 await f.click('.feed-workspace button','新建采集');await f.fill('[aria-label="采集需求"]','已发送要求');
 const pending=f.hold(c=>c.type==='create_feed_collection');await f.click('.feed-proposal button','发送并开始');await pending.arrived;
 await f.fill('[aria-label="采集需求"]','较新的独立要求');await f.click('[aria-label="个人工作区"] button','内容');await f.click('.feed-title','正在阅读的资料');
 pending.release();await f.poll(async()=>JSON.parse((await f.engine.command({type:'read_feed_draft',key:'collection:new'})).feed.draft.text).pending===undefined);
 assert.equal(await f.evaluate('document.querySelector(".feed-reader h2").textContent'),'正在阅读的资料');
 await f.click('.feed-workspace button','新建采集');assert.equal(await f.evaluate('document.querySelector("[aria-label=采集需求]").value'),'较新的独立要求');
 assert.equal((await f.engine.command({type:'feed_snapshot'})).feed.snapshot.collections.length,1);
 await f.screenshot('collection-late-navigation.png');
});

test('late config acknowledgement cannot close a newer editor or consume its fields',async t=>{
 const f=await openFeedFixture(t);await create(f,'配置任务');await openTask(f,'配置任务');
 await f.click(`${visibleTask} button`,'重命名');await f.fill('[aria-label="任务名称"]','新名称');
 const pending=f.hold(c=>c.type==='edit_feed_collection');await f.click('.feed-editor button','保存设置');await pending.arrived;
 await f.click(`${visibleTask} button`,'编辑采集说明');await f.fill('[aria-label="长期采集说明"]','新的长期草稿');pending.release();
 await f.poll(()=>f.evaluate(`document.querySelector('${visibleTask} h2')?.textContent==='新名称'`));
 assert.equal(await f.evaluate('document.querySelector(".feed-editor h3").textContent'),'编辑采集说明');assert.equal(await f.evaluate('document.querySelector("[aria-label=长期采集说明]").value'),'新的长期草稿');
 await f.screenshot('collection-late-config.png');
});
async function storedForm(f,key) { return JSON.parse((await f.engine.command({type:'read_feed_draft',key})).feed.draft.text); }
test('proposal remount retains newer shared draft after original accepted acknowledgement',async t=>{
 const f=await openFeedFixture(t);await f.click('.feed-workspace button','新建采集');await f.fill('[aria-label="采集需求"]','原提交');
 const pending=f.hold(c=>c.type==='create_feed_collection');await f.click('.feed-proposal button','发送并开始');await pending.arrived;
 await f.click('.feed-proposal button','取消');await f.poll(()=>f.evaluate('!document.querySelector(".feed-proposal")'));await f.click('.feed-workspace button','新建采集');await f.fill('[aria-label="采集需求"]','重新打开后的新文本');
 await f.poll(async()=>(await storedForm(f,'collection:new')).fields.instruction==='重新打开后的新文本');pending.release();
 await f.poll(async()=>!(await storedForm(f,'collection:new')).pending);
 assert.equal(await f.evaluate('document.querySelector("[aria-label=采集需求]").value'),'重新打开后的新文本');assert.equal((await storedForm(f,'collection:new')).fields.instruction,'重新打开后的新文本');
 assert.equal((await f.engine.command({type:'feed_snapshot'})).feed.snapshot.collections.length,1);await f.screenshot('proposal-remount-accepted.png');
});
test('same editor remount retains newer shared fields after accepted rename acknowledgement',async t=>{
 const f=await openFeedFixture(t),a=await create(f,'重开配置任务');await openTask(f,'重开配置任务');await f.click(`${visibleTask} button`,'重命名');await f.fill('[aria-label="任务名称"]','已提交名称');
 const pending=f.hold(c=>c.type==='edit_feed_collection');await f.click('.feed-editor button','保存设置');await pending.arrived;await f.poll(()=>f.evaluate(`document.querySelector('${visibleTask} h2')?.textContent==='已提交名称'`));
 await f.click('.feed-editor button','关闭编辑');await f.poll(()=>f.evaluate('!document.querySelector(".feed-editor")'));await f.click(`${visibleTask} button`,'重命名');await f.fill('[aria-label="任务名称"]','重开后的新名称');
 const key=`collection:${a.collectionId}:edit:name`;await f.poll(async()=>(await storedForm(f,key)).fields.name==='重开后的新名称');pending.release();await f.poll(async()=>!(await storedForm(f,key)).pending);
 assert.equal(await f.evaluate('document.querySelector("[aria-label=任务名称]").value'),'重开后的新名称');assert.equal((await storedForm(f,key)).fields.name,'重开后的新名称');await f.screenshot('editor-remount-accepted.png');
});
test('proposal remount retains corrected materials and text after pre-acceptance rejection',async t=>{
 const f=await openFeedFixture(t),entry=(await f.engine.command({type:'update_feed_entry',mutation:{operation:'createText',input:{title:'将删除的材料',body:'材料正文',coverage:'full'},requestId:'rejection-material'}})).feed.entry;
 await f.click('[aria-label="选择资料 将删除的材料"]');await f.click('.feed-content-host button','继续调研');await f.fill('[aria-label="采集需求"]','原调研要求');
 await f.engine.command({type:'update_feed_entry',mutation:{operation:'delete',id:entry.id,expectedRevision:entry.revision,requestId:'delete-remount-material'}});
 const pending=f.hold(c=>c.type==='create_feed_collection');await f.click('.feed-proposal button','发送并开始');assert.match((await pending.arrived).error,/素材已删除/);
 await f.click('.feed-proposal button','取消');await f.poll(()=>f.evaluate('!document.querySelector(".feed-proposal")'));await f.click('.feed-workspace button','新建采集');await f.fill('[aria-label="采集需求"]','重开后的有效要求');await f.click('[aria-label="移除引用 将删除的材料"]');
 await f.poll(async()=>{const form=await storedForm(f,'collection:new');return form.fields.instruction==='重开后的有效要求'&&form.fields.materials.length===0;});pending.release();await f.poll(async()=>!(await storedForm(f,'collection:new')).pending);
 assert.equal(await f.evaluate('document.querySelector("[aria-label=采集需求]").value'),'重开后的有效要求');assert.equal((await storedForm(f,'collection:new')).fields.materials.length,0);
 await f.click('.feed-proposal button','发送并开始');await f.poll(async()=>(await f.engine.command({type:'feed_snapshot'})).feed.snapshot.collections.length===1);await f.screenshot('proposal-remount-rejected.png');
});
test('old remount acknowledgement cannot clear a replacement pending submission',async t=>{
 const f=await openFeedFixture(t);await f.click('.feed-workspace button','新建采集');await f.fill('[aria-label="采集需求"]','第一次提交');
 const first=f.hold(c=>c.type==='create_feed_collection');await f.click('.feed-proposal button','发送并开始');await first.arrived;
 await f.click('.feed-proposal button','取消');await f.poll(()=>f.evaluate('!document.querySelector(".feed-proposal")'));await f.click('.feed-workspace button','新建采集');await f.click('.feed-proposal button','重试原提交');await f.poll(()=>f.evaluate('!document.querySelector(".feed-proposal")&&!!document.querySelector(".feed-collection h2")'));
 await f.click('.feed-workspace button','新建采集');await f.fill('[aria-label="采集需求"]','第二次提交');
 const second=f.hold(c=>c.type==='create_feed_collection');await f.click('.feed-proposal button','发送并开始');await second.arrived;
 const owned=(await storedForm(f,'collection:new')).pending;const refresh=f.hold(c=>c.type==='search_feed_entries');first.release();await refresh.arrived;
 assert.deepEqual((await storedForm(f,'collection:new')).pending,owned);assert.equal(await f.evaluate('document.querySelector("[aria-label=采集需求]").value'),'第二次提交');refresh.release();second.release();
 await f.poll(async()=>!(await storedForm(f,'collection:new')).pending);assert.equal((await f.engine.command({type:'feed_snapshot'})).feed.snapshot.collections.length,2);await f.screenshot('remount-replacement-pending.png');
});
