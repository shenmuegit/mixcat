import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { copyFileSync } from 'node:fs';
import { projectDirectory } from '../src/core/paths.ts';
import { accountFixture } from './account-fixture.ts';
import { openFeedFixture, reloadFeed, storedForm } from './feed-electron-fixture.mjs';
const models={data:[{model:'fixture-model',displayName:'First model',isDefault:true,defaultReasoningEffort:'medium',supportedReasoningEfforts:['low','medium','high','xhigh','max','ultra'].map(reasoningEffort=>({reasoningEffort,description:reasoningEffort}))},{model:'second-model',displayName:'Second model',defaultReasoningEffort:'max',supportedReasoningEfforts:[{reasoningEffort:'max',description:'Deep'}]}],nextCursor:null};

async function press(f,...keys) {
  for(const [key,windowsVirtualKeyCode]of keys)for(const type of ['keyDown','keyUp'])await f.rpc('Input.dispatchKeyEvent',{type,key,code:key,windowsVirtualKeyCode,...(type==='keyDown'&&key==='Enter'?{text:'\r'}:{})});
}

async function modelFixture(t,{failModelOnce=false}={}) {
  const catalog=structuredClone(models);
  const directory=projectDirectory(resolve('.'),'.runtime','tests','chosen-feed-ui'),account=accountFixture(),clients=[];let sequence=0;
  const f=await openFeedFixture(t,{chooseDirectory:directory,accountFactory(options){const client=account.factory(options);return{...client,async rpc(method,params){if(method!=='model/list')return client.rpc(method,params);if(failModelOnce){failModelOnce=false;throw Error('fixture model catalog unavailable');}return catalog;}};},nativeFactory(options){const client={options,calls:[]};clients.push(client);return{async connect(){},async close(){},async rpc(method,params){client.calls.push({method,params});if(method==='account/read')return{account:{email:'fixture'}};if(method==='model/list')return catalog;if(['skills/list','hooks/list','mcpServerStatus/list'].includes(method))return{data:[],nextCursor:null};if(['plugin/list','plugin/installed'].includes(method))return{marketplaces:[],marketplaceLoadErrors:[]};if(method==='windowsSandbox/readiness')return{status:'notConfigured'};if(['thread/start','thread/resume'].includes(method))return{thread:{id:params.threadId??`thread-${++sequence}`},model:params.model??'fixture-model',sandbox:{type:'workspaceWrite'},approvalPolicy:'on-request'};if(method==='turn/start'){const id=`turn-${++sequence}`;options.onEvent({method:'turn/started',params:{threadId:params.threadId,turn:{id}}});return{turn:{id}};}return{};}};}});
  return {...f,clients,directory,catalog};
}

test('complete model catalog can be scrolled, selected with keyboard and mouse, and restored from the draft',async t=>{
  const f=await modelFixture(t);
  f.catalog.data.push(...Array.from({length:18},(_,i)=>({...models.data[1],model:`extra-model-${i+1}`,displayName:`Additional model ${i+1}`})));
  await f.click('.feed-workspace button','新建采集');await f.click('[aria-label="选择模型与思考强度"]');await f.click('[aria-label="选择模型"]');
  assert.equal(await f.evaluate('document.querySelectorAll(".feed-model-list button").length'),20);
  for(const [width,height]of[[1460,850],[850,720],[850,400]]){
    await f.rpc('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    await press(f,['Home',36]);
    assert.equal(await f.evaluate('document.activeElement.textContent'),'First model');
    const point=await f.evaluate('(()=>{const r=document.querySelector(".feed-model-list").getBoundingClientRect();return{x:r.left+r.width/2,y:Math.min(r.bottom,innerHeight)-10};})()');
    await f.rpc('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaX:0,deltaY:1200});
    await f.poll(()=>f.evaluate('document.querySelector(".feed-model-list").scrollTop>0'));
    await press(f,['End',35]);
    assert(await f.evaluate('(()=>{const e=document.activeElement,r=e.getBoundingClientRect();return e.textContent==="Additional model 18"&&r.top>=0&&r.bottom<=innerHeight&&e.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));})()'));
    await f.screenshot(`all-models-${width}-${height}.png`);
  }
  await press(f,['Home',36],['ArrowDown',40]);
  assert.equal(await f.evaluate('document.activeElement.textContent'),'Second model');
  await press(f,['End',35],['Enter',13]);
  await f.poll(async()=>(await storedForm(f))?.fields.model==='extra-model-18');
  await f.click('.feed-new>button','返回信息流');await f.click('.feed-workspace button','新建采集');
  await f.poll(()=>f.evaluate('document.querySelector(".feed-model-trigger").textContent.includes("Additional model 18")'));
  await f.click('[aria-label="选择模型与思考强度"]');await f.click('[aria-label="选择模型"]');await f.click('[role="menuitemradio"]','First model');
  await f.poll(async()=>(await storedForm(f))?.fields.model==='fixture-model');
});

test('Codex design exposes native effort stops, reset and a model menu',async t=>{
  const f=await modelFixture(t);
  await f.click('.feed-workspace button','新建采集');await f.fill('[aria-label="采集需求"]','按截图选择推理强度');
  await f.click('[aria-label="选择模型与思考强度"]');
  await f.poll(()=>f.evaluate('document.querySelectorAll("[aria-label=模型] option").length===3||!!document.querySelector("[aria-label=推理强度]")'));
  assert(await f.evaluate('!!document.querySelector("input[type=range][aria-label=推理强度]")'),'Codex-style picker must expose a discrete effort slider instead of a dropdown');
  assert.deepEqual(await f.evaluate('(()=>{const e=document.querySelector("[aria-label=推理强度]");return[e.min,e.max,e.step,e.value,e.getAttribute("aria-valuetext")]})()'),['0','5','1','1','Medium']);
  await f.click('[aria-label="推理强度"]');
  await press(f,['End',35],['ArrowLeft',37]);
  assert.equal(await f.evaluate('document.querySelector("[aria-label=推理强度]").getAttribute("aria-valuetext")'),'Max');
  await f.click('[aria-label="重置为模型默认推理强度"]');
  assert.equal(await f.evaluate('document.querySelector("[aria-label=推理强度]").value'),'1');
  await f.click('[aria-label="推理强度"]');
  await press(f,['Home',36]);
  await f.click('[aria-label="选择模型"]');
  await f.poll(()=>f.evaluate('document.activeElement?.getAttribute("role")==="menuitemradio"'));
  await press(f,['End',35],['Enter',13]);
  await f.poll(()=>f.evaluate('!!document.querySelector("[aria-label=推理强度]")&&document.querySelector(".feed-model-choice").textContent==="Second model"'));
  assert.deepEqual(await f.evaluate('(()=>{const e=document.querySelector("[aria-label=推理强度]");return[e.max,e.getAttribute("aria-valuetext"),e.disabled]})()'),['0','Max',true]);
  assert(await f.evaluate('document.querySelector(".feed-model-controls").textContent.includes("新模型不支持")'));
  await f.click('[aria-label="选择模型"]');await f.click('[role="menuitemradio"]','First model');
  await f.click('[aria-label="推理强度"]');
  await press(f,['End',35],['ArrowLeft',37]);
  for(const [width,height]of[[1460,850],[850,720]]){await f.rpc('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});assert(await f.evaluate('(()=>{const e=document.querySelector(".feed-model-controls"),r=e.getBoundingClientRect();return r.width>=250&&r.width<=270&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&e.contains(document.elementFromPoint(r.left+20,r.top+20))})()'));}
  await f.rpc('Emulation.clearDeviceMetricsOverride');await f.click('.feed-effort-title');await f.screenshot('codex-model-popover.png');
  copyFileSync(join(f.fixture,'codex-model-popover.png'),join(projectDirectory(resolve('.'),'.runtime','evidence'),'codex-model-popover.png'));
  await f.click('[aria-label="推理强度"]');
  await press(f,['End',35],['ArrowLeft',37],['Escape',27]);
  assert(await f.evaluate('!document.querySelector(".feed-model-controls").matches(":popover-open")&&document.activeElement?.classList.contains("feed-model-trigger")'));
  await f.click('.feed-new form button','发送');await f.poll(()=>f.clients[0]?.calls.some(call=>call.method==='turn/start'),400);
  const turn=f.clients[0].calls.find(call=>call.method==='turn/start').params;assert.equal(turn.model,'fixture-model');assert.equal(turn.effort,'max');
});

test('catalog retry and unavailable saved effort are recoverable without losing the draft',async t=>{
  const f=await modelFixture(t,{failModelOnce:true});
  await f.click('.feed-workspace button','新建采集');await f.fill('[aria-label="采集需求"]','目录失败后保留这份目标');await f.click('[aria-label="选择模型与思考强度"]');
  await f.poll(()=>f.evaluate('document.querySelector(".feed-model-controls").textContent.includes("fixture model catalog unavailable")'));
  await f.click('.feed-model-controls button','重新读取模型');await f.poll(()=>f.evaluate('!!document.querySelector("[aria-label=推理强度]")'));
  await f.click('[aria-label="推理强度"]');
  await press(f,['End',35],['ArrowLeft',37]);
  await f.poll(async()=>(await storedForm(f))?.fields.reasoningEffort==='max');await f.click('.feed-new h2');
  assert(await f.evaluate('!document.querySelector(".feed-model-controls").matches(":popover-open")'));
  f.catalog.data[0].supportedReasoningEfforts=f.catalog.data[0].supportedReasoningEfforts.filter(option=>option.reasoningEffort!=='max');
  await reloadFeed(f);await f.click('.feed-workspace button','新建采集');await f.click('[aria-label="选择模型与思考强度"]');
  await f.poll(()=>f.evaluate('document.querySelector(".feed-model-controls").textContent.includes("暂不可用")'));
  assert.equal((await storedForm(f)).fields.reasoningEffort,'max');assert.equal(await f.evaluate('document.querySelector("[aria-label=采集需求]").value'),'目录失败后保留这份目标');
  for(let i=0;i<5&&!await f.evaluate('document.activeElement?.getAttribute("aria-label")==="推理强度"');i++)await press(f,['Tab',9]);
  assert(await f.evaluate('document.activeElement?.getAttribute("aria-label")==="推理强度"'));await press(f,['Home',36]);
  assert.equal(await f.evaluate('document.querySelector("[aria-label=推理强度]").getAttribute("aria-valuetext")'),'Low');
  await f.click('[aria-label="重置为模型默认推理强度"]');assert.equal(await f.evaluate('document.querySelector("[aria-label=推理强度]").getAttribute("aria-valuetext")'),'Medium');
  await f.click('[aria-label="选择模型与思考强度"]');const gate=f.hold(command=>command.type==='create_feed_collection');await f.click('.feed-new form button','发送');await gate.arrived;
  assert(await f.evaluate('document.querySelector(".feed-model-trigger").disabled'));gate.release();await f.poll(()=>f.evaluate('!!document.querySelector(".feed-collection")'));
});

test('a saved model temporarily absent from the catalog can be reloaded without changing the draft',async t=>{
  const f=await modelFixture(t);
  await f.click('.feed-workspace button','新建采集');await f.fill('[aria-label="采集需求"]','保存模型目录恢复目标');await f.click('[aria-label="选择模型与思考强度"]');
  await f.poll(()=>f.evaluate('!!document.querySelector("[aria-label=推理强度]")'));await f.click('[aria-label="推理强度"]');await press(f,['End',35],['ArrowLeft',37]);
  await f.poll(async()=>(await storedForm(f))?.fields.model==='fixture-model');const saved=f.catalog.data.shift();
  await reloadFeed(f);await f.click('.feed-workspace button','新建采集');await f.click('[aria-label="选择模型与思考强度"]');
  await f.poll(()=>f.evaluate('document.querySelector(".feed-model-controls").textContent.includes("无法验证已保存的模型")'));
  assert(await f.evaluate('[...document.querySelectorAll(".feed-model-controls button")].some(button=>button.textContent.includes("重新读取模型"))'),'An unavailable saved model must have a retry action even when other models were loaded');
  f.catalog.data.unshift(saved);await f.click('.feed-model-controls button','重新读取模型');await f.poll(()=>f.evaluate('document.querySelector(".feed-model-choice").textContent==="First model"'));
  assert.equal(await f.evaluate('document.querySelector("[aria-label=推理强度]").getAttribute("aria-valuetext")'),'Max');assert.equal((await storedForm(f)).fields.model,'fixture-model');
});

test('new name directory and composer model selection persist and configure the real command boundary',async t=>{
  const f=await modelFixture(t),{clients,directory}=f;
  const select=async name=>{await f.click('[aria-label="选择模型"]');await f.click('[role="menuitemradio"]',name);};
  await f.click('.feed-workspace button','新建采集');await f.fill('[aria-label="采集名称"]','用户指定名称');await f.click('.feed-new button','选择目录');
  await f.poll(()=>f.evaluate(`document.querySelector('[aria-label="工作目录"]').value===${JSON.stringify(directory)}`));
  await f.fill('[aria-label="采集需求"]','关注公开动态');await f.click('[aria-label="选择模型与思考强度"]');
  await f.poll(()=>f.evaluate('!!document.querySelector("[aria-label=推理强度]")'));
  await f.click('[aria-label="推理强度"]');await press(f,['End',35],['ArrowLeft',37]);await select('Second model');
  assert.equal(await f.evaluate('document.querySelector(".feed-model-choice").textContent'),'Second model');
  assert.equal(await f.evaluate('document.querySelector("[aria-label=推理强度]").getAttribute("aria-valuetext")'),'Max');
  await f.click('[aria-label="选择模型与思考强度"]');
  await f.click('.feed-new>button','返回信息流');await f.click('.feed-workspace button','新建采集');
  assert.equal(await f.evaluate('document.querySelector("[aria-label=采集名称]").value'),'用户指定名称');assert.equal(await f.evaluate('document.querySelector("[aria-label=工作目录]").value'),directory);
  assert(await f.evaluate('document.querySelector(".feed-model-trigger").textContent.includes("Max")'));
  await f.click('.feed-new form button','发送');await f.poll(()=>f.evaluate('document.querySelector(".feed-collection h2")?.textContent==="用户指定名称"'));
  await f.poll(()=>clients[0]?.calls.some(call=>call.method==='turn/start'));
  const turn=clients[0].calls.find(call=>call.method==='turn/start').params;
  assert.equal(turn.model,'second-model');assert.equal(turn.effort,'max');assert.equal(clients[0].options.cwd,directory);
  const collection=(await f.engine.command({type:'feed_snapshot'})).feed.snapshot.collections[0];
  assert.equal((await f.engine.command({type:'get_feed_collection',collectionId:collection.id})).feed.collection.collection.directory,directory);
  await f.click('[aria-label="选择模型与思考强度"]');await f.poll(()=>f.evaluate('!!document.querySelector("[aria-label=推理强度]")'));await select('First model');await f.click('[aria-label="选择模型与思考强度"]');
  await f.fill('[aria-label="继续沟通目标"]','下一条使用第一模型');await f.click('.feed-send');
  const queued=await f.poll(async()=>(await f.engine.command({type:'list_feed_runs',collectionId:collection.id})).feed.runs.items.find(run=>run.inputSnapshot.text==='下一条使用第一模型'),400);
  assert.equal(queued.inputSnapshot.capabilities.model,'fixture-model');assert.equal(queued.inputSnapshot.capabilities.reasoningEffort,'max');
  assert.equal(turn.model,'second-model');
  for(const [width,height]of[[1460,850],[850,720]]){await f.rpc('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await f.click('[aria-label="选择模型与思考强度"]');assert(await f.evaluate('(()=>{const e=document.querySelector(".feed-model-controls"),r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&e.contains(document.elementFromPoint(r.left+20,r.top+20))})()'));await f.click('[aria-label="选择模型与思考强度"]');}
  await f.rpc('Emulation.clearDeviceMetricsOverride');await f.screenshot('model-directory-detail.png');copyFileSync(join(f.fixture,'model-directory-detail.png'),join(projectDirectory(resolve('.'),'.runtime','evidence'),'model-directory-detail.png'));
});

test('choosing effort alone binds the displayed native default model before sending',async t=>{
  const f=await modelFixture(t);
  await f.click('.feed-workspace button','新建采集');await f.fill('[aria-label="采集需求"]','只选择思考强度');await f.click('[aria-label="选择模型与思考强度"]');
  await f.poll(()=>f.evaluate('!!document.querySelector("[aria-label=推理强度]")'));
  await f.click('[aria-label="推理强度"]');
  await press(f,['Home',36],['ArrowRight',39]);
  await f.click('[aria-label="选择模型与思考强度"]');await f.click('.feed-new form button','发送');
  await f.poll(()=>f.clients[0]?.calls.some(call=>call.method==='turn/start'),400);
  const turn=f.clients[0].calls.find(call=>call.method==='turn/start').params;assert.equal(turn.model,'fixture-model');assert.equal(turn.effort,'medium');
});
