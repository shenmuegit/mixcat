import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { copyFileSync } from 'node:fs';
import { projectDirectory } from '../src/core/paths.ts';
import { accountFixture } from './account-fixture.ts';
import { openFeedFixture, reloadFeed, openCollection } from './feed-electron-fixture.mjs';
const models={data:[{model:'fixture-model',displayName:'First model',isDefault:true,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium',description:'Default'}]},{model:'second-model',displayName:'Second model',defaultReasoningEffort:'max',supportedReasoningEfforts:[{reasoningEffort:'max',description:'Deep'}]}],nextCursor:null};

async function modelFixture(t) {
  const directory=projectDirectory(resolve('.'),'.runtime','tests','chosen-feed-ui'),account=accountFixture(),clients=[];let sequence=0;
  const f=await openFeedFixture(t,{chooseDirectory:directory,accountFactory(options){const client=account.factory(options);return{...client,async rpc(method,params){return method==='model/list'?models:client.rpc(method,params);}};},nativeFactory(options){const client={options,calls:[]};clients.push(client);return{async connect(){},async close(){},async rpc(method,params){client.calls.push({method,params});if(method==='account/read')return{account:{email:'fixture'}};if(method==='model/list')return models;if(['skills/list','hooks/list','mcpServerStatus/list'].includes(method))return{data:[],nextCursor:null};if(['plugin/list','plugin/installed'].includes(method))return{marketplaces:[],marketplaceLoadErrors:[]};if(method==='windowsSandbox/readiness')return{status:'notConfigured'};if(['thread/start','thread/resume'].includes(method))return{thread:{id:params.threadId??`thread-${++sequence}`},model:params.model??'fixture-model',sandbox:{type:'workspaceWrite'},approvalPolicy:'on-request'};if(method==='turn/start'){const id=`turn-${++sequence}`;options.onEvent({method:'turn/started',params:{threadId:params.threadId,turn:{id}}});return{turn:{id}};}return{};}};}});
  return {...f,clients,directory};
}

test('new name directory and composer model selection persist and configure the real command boundary',async t=>{
  const f=await modelFixture(t),{clients,directory}=f;
  const key=async(key,code=key,vk)=>{for(const type of ['keyDown','keyUp'])await f.rpc('Input.dispatchKeyEvent',{type,key,code,windowsVirtualKeyCode:vk});};
  const select=async(label,steps)=>{await f.click(`[aria-label="${label}"]`);await key('Home','Home',36);for(let i=0;i<steps;i++)await key('ArrowDown','ArrowDown',40);await key('Enter','Enter',13);};
  await f.click('.feed-workspace button','新建采集');await f.fill('[aria-label="采集名称"]','用户指定名称');await f.click('.feed-new button','选择目录');
  await f.poll(()=>f.evaluate(`document.querySelector('[aria-label="工作目录"]').value===${JSON.stringify(directory)}`));
  await f.fill('[aria-label="采集需求"]','关注公开动态');await f.click('.feed-model-picker summary');
  await f.poll(()=>f.evaluate('document.querySelectorAll("[aria-label=模型] option").length===3'));
  await select('模型',1);await select('思考强度',1);
  assert.equal(await f.evaluate('document.querySelector("[aria-label=模型]").value'),'second-model');
  assert.equal(await f.evaluate('document.querySelector("[aria-label=思考强度]").value'),'max');
  await f.click('.feed-model-picker summary');
  await f.click('.feed-new>button','返回信息流');await f.click('.feed-workspace button','新建采集');
  assert.equal(await f.evaluate('document.querySelector("[aria-label=采集名称]").value'),'用户指定名称');assert.equal(await f.evaluate('document.querySelector("[aria-label=工作目录]").value'),directory);
  assert(await f.evaluate('document.querySelector(".feed-model-picker summary").textContent.includes("max")'));
  await f.click('.feed-new form button','发送');await f.poll(()=>f.evaluate('document.querySelector(".feed-collection h2")?.textContent==="用户指定名称"'));
  await f.poll(()=>clients[0]?.calls.some(call=>call.method==='turn/start'));
  const turn=clients[0].calls.find(call=>call.method==='turn/start').params;
  assert.equal(turn.model,'second-model');assert.equal(turn.effort,'max');assert.equal(clients[0].options.cwd,directory);
  const collection=(await f.engine.command({type:'feed_snapshot'})).feed.snapshot.collections[0];
  assert.equal((await f.engine.command({type:'get_feed_collection',collectionId:collection.id})).feed.collection.collection.directory,directory);
  await f.click('.feed-model-picker summary');await f.poll(()=>f.evaluate('document.querySelectorAll("[aria-label=模型] option").length===3'));await select('模型',0);await f.click('.feed-model-picker summary');
  await f.fill('[aria-label="继续沟通目标"]','下一条使用第一模型');await f.click('.feed-send');
  const queued=await f.poll(async()=>(await f.engine.command({type:'list_feed_runs',collectionId:collection.id})).feed.runs.items.find(run=>run.inputSnapshot.text==='下一条使用第一模型'),400);
  assert.equal(queued.inputSnapshot.capabilities.model,'fixture-model');assert.equal(queued.inputSnapshot.capabilities.reasoningEffort,null);
  assert.equal(turn.model,'second-model');
  for(const [width,height]of[[1460,850],[850,720]]){await f.rpc('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await f.click('.feed-model-picker summary');assert(await f.evaluate('(()=>{const e=document.querySelector(".feed-model-controls"),r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&e.contains(document.elementFromPoint(r.left+20,r.top+20))})()'));await f.click('.feed-model-picker summary');}
  await f.rpc('Emulation.clearDeviceMetricsOverride');await f.screenshot('model-directory-detail.png');copyFileSync(join(f.fixture,'model-directory-detail.png'),join(projectDirectory(resolve('.'),'.runtime','evidence'),'model-directory-detail.png'));
});

test('choosing effort alone binds the displayed native default model before sending',async t=>{
  const f=await modelFixture(t);
  await f.click('.feed-workspace button','新建采集');await f.fill('[aria-label="采集需求"]','只选择思考强度');await f.click('.feed-model-picker summary');
  await f.poll(()=>f.evaluate('document.querySelectorAll("[aria-label=模型] option").length===3'));
  await f.click('[aria-label="思考强度"]');
  for(const [key,vk]of[['Home',36],['ArrowDown',40],['Enter',13]])for(const type of ['keyDown','keyUp'])await f.rpc('Input.dispatchKeyEvent',{type,key,code:key,windowsVirtualKeyCode:vk});
  await f.click('.feed-model-picker summary');await f.click('.feed-new form button','发送');
  await f.poll(()=>f.clients[0]?.calls.some(call=>call.method==='turn/start'),400);
  const turn=f.clients[0].calls.find(call=>call.method==='turn/start').params;assert.equal(turn.model,'fixture-model');assert.equal(turn.effort,'medium');
});
