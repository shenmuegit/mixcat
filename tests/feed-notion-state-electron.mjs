import test from 'node:test';
import assert from 'node:assert/strict';
import { accountFixture } from './account-fixture.ts';
import { openFeedFixture, createCollection, openCollection } from './feed-electron-fixture.mjs';

async function notionStateFixture(t,{openExternal}={}) {
  const account=accountFixture(), state={server:'',authorized:false,logins:0,reads:0,failRead:false,options:null};let sequence=0;
  const f=await openFeedFixture(t,{openExternal,accountFactory:account.factory,nativeFactory(options){
    state.options=options;
    return{async connect(){},async close(){},async rpc(method,params){
      if(method==='account/read')return{account:{email:'fixture'}};
      if(method==='model/list')return{data:[{model:'fixture-model',displayName:'Fixture',isDefault:true,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium',description:''}]}],nextCursor:null};
      if(['skills/list','hooks/list'].includes(method))return{data:[]};
      if(['plugin/list','plugin/installed'].includes(method))return{marketplaces:[],marketplaceLoadErrors:[]};
      if(method==='windowsSandbox/readiness')return{status:'notConfigured'};
      if(method==='config/batchWrite'){state.server=params.edits[0].keyPath.slice('mcp_servers.'.length);return{};}
      if(method==='mcpServer/oauth/login')return{authorizationUrl:`https://mcp.notion.com/authorize?attempt=${++state.logins}`,loginId:`login-${state.logins}`};
      if(method==='mcpServerStatus/list'){state.reads++;if(state.failRead)throw Error('fixture connection read failed');return{data:state.server?[{name:state.server,authStatus:state.authorized?'oAuth':'notLoggedIn',tools:{}}]:[]};}
      if(method==='mcpServer/tool/call')return{structuredContent:params.tool==='notion-get-self'?{workspace:{id:'workspace',name:'Fixture workspace'}}:{results:[]}};
      if(['thread/start','thread/resume'].includes(method))return{thread:{id:params.threadId??`thread-${++sequence}`},model:'fixture-model',sandbox:{type:'workspaceWrite'},approvalPolicy:'on-request'};
      if(method==='turn/start'){const id=`turn-${++sequence}`;options.onEvent({method:'turn/started',params:{threadId:params.threadId,turn:{id}}});queueMicrotask(()=>options.onEvent({method:'turn/completed',params:{threadId:params.threadId,turn:{id,status:'completed',items:[]}}}));return{turn:{id}};}
      return{};
    }};
  }});
  await createCollection(f,'Notion connection state');await openCollection(f,'Notion connection state');await f.click('.feed-notion-trigger');
  await f.poll(()=>f.evaluate('!!document.querySelector(".feed-notion-content>button.button:not(:disabled)")'));
  return{...f,state};
}
const connection='.feed-notion-content>button.button';

for(const connected of [false,true])test(`Notion shows opening and waiting before settling to ${connected?'linked':'unlinked'}`,async t=>{
  const f=await notionStateFixture(t);
  assert.equal(await f.evaluate(`document.querySelector('${connection}').textContent`),'未链接');
  const gate=f.hold(command=>command?.type==='connect_feed_notion');
  await f.click(connection);await gate.arrived;
  assert.equal(await f.evaluate(`document.querySelector('${connection}').textContent`),'正在打开链接');
  assert(await f.evaluate(`document.querySelector('${connection}').disabled`));assert.equal(f.openedUrls.length,0);
  gate.release();await f.poll(()=>f.openedUrls.length===1);
  await f.poll(()=>f.evaluate(`document.querySelector('${connection}').textContent==='等待授权'&&!document.querySelector('${connection}').disabled`));
  await f.click(connection);await f.poll(()=>f.openedUrls.length===2);
  assert.equal(f.openedUrls[0],f.openedUrls[1]);assert.equal(f.state.logins,1);
  await f.poll(()=>f.evaluate(`document.querySelector('${connection}').textContent==='等待授权'`));
  const reads=f.state.reads;f.state.authorized=connected;
  f.state.options.onEvent({method:'mcpServer/oauthLogin/completed',params:{name:f.state.server,loginId:'login-1',success:false,error:'timed out waiting for OAuth callback'}});
  await f.poll(()=>f.state.reads>reads);
  await f.poll(()=>f.evaluate(`document.querySelector('${connection}').textContent===${JSON.stringify(connected?'已链接':'未链接')}&&document.querySelector('${connection}').disabled===${connected}`));
  const text=await f.evaluate('document.querySelector(".feed-notion").innerText');
  for(const removed of ['timed out waiting for OAuth callback','重试读取','打开授权页','完成授权','正在读取连接'])assert(!text.includes(removed),removed);
  if(!connected){await f.click(connection);await f.poll(()=>f.openedUrls.length===3);assert.notEqual(f.openedUrls[1],f.openedUrls[2]);assert.equal(f.state.logins,2);}
  else{assert.equal(f.state.logins,1);await f.evaluate(`document.querySelector('${connection}').click()`);assert.equal(f.openedUrls.length,2);}
  await f.screenshot(`notion-${connected?'linked':'unlinked'}.png`);
});

test('a failed browser open returns to unlinked and can reopen the valid authorization URL',async t=>{
  let fail=true,attempts=0;
  const f=await notionStateFixture(t,{openExternal:async()=>{attempts++;if(fail)throw Error('fixture browser open failed');}});
  await f.click(connection);await f.poll(()=>attempts===1);
  await f.poll(()=>f.evaluate(`document.querySelector('${connection}').textContent==='未链接'&&!document.querySelector('${connection}').disabled`));
  assert.equal(f.openedUrls.length,0);
  fail=false;await f.click(connection);await f.poll(()=>f.openedUrls.length===1);
  await f.poll(()=>f.evaluate(`document.querySelector('${connection}').textContent==='等待授权'`));
  assert.equal(f.state.logins,1);
});

test('a failed connection read is unlinked and can retry through the connection action',async t=>{
  const f=await notionStateFixture(t);await f.click(connection);await f.poll(()=>f.openedUrls.length===1);
  f.state.options.onEvent({method:'mcpServer/oauthLogin/completed',params:{name:f.state.server,loginId:'login-1',success:false,error:'timed out waiting for OAuth callback'}});
  await f.click('[aria-label="关闭弹窗"]');f.state.failRead=true;await f.click('.feed-notion-trigger');
  await f.poll(()=>f.evaluate(`document.querySelector('${connection}')?.disabled===false`));
  assert.equal(await f.evaluate(`document.querySelector('${connection}').textContent`),'未链接');
  assert(!await f.evaluate('document.querySelector(".feed-notion").innerText.includes("fixture connection read failed")'));
  await f.click(connection);await f.poll(()=>f.openedUrls.length===2);
});
