import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { feedFixture } from './feed-runtime-fixture.js';
import { until } from './runtime-fixture.js';

test('an authenticated directory read does not wait for full MCP status enumeration',async t=>{
  let server='',blocked=false,release!:()=>void,identities=0,contents=0,catalogs=0,authorized=true,validIdentity=true,catalogAvailable=true,workspace='workspace';
  const gate=new Promise<void>(done=>release=done);
  const f=await feedFixture(t,async(method,params)=>{
    if(method==='config/batchWrite'){server=params.edits[0].keyPath.slice('mcp_servers.'.length);return{};}
    if(method==='mcpServer/oauth/login')return{authorizationUrl:'https://mcp.notion.com/authorize',loginId:'latency-login'};
    if(method==='mcpServerStatus/list'){catalogs++;if(blocked)await gate;if(!catalogAvailable)throw Error('catalog unavailable');return{data:[{name:server,authStatus:authorized?'oAuth':'notLoggedIn',tools:{}}]};}
    if(method==='mcpServer/tool/call'){
      if(params.tool==='notion-get-self'){identities++;if(!authorized)throw Error('Notion OAuth required');return{structuredContent:{workspace:{id:validIdentity?workspace:'',name:'Workspace'}}};}
      if(params.tool==='notion-fetch'){contents++;return{structuredContent:{text:'<content/>'}};}
      if(params.tool==='notion-list-private-pages'){contents++;return{structuredContent:{results:[]}};}
    }
  });
  const id=(await f.create('latency')).admission!.collectionId;
  await until(()=>f.clients[0]?.calls.some(c=>c.method==='turn/start')===true);
  const run=(await f.engine.command({type:'get_feed_collection',collectionId:id})).collection!.activeRun!;
  f.clients[0].options.onEvent({method:'turn/completed',params:{threadId:run.threadId,turn:{id:run.turnId,status:'completed',items:[]}}});
  await f.engine.command({type:'connect_feed_notion',collectionId:id});
  await f.engine.command({type:'read_feed_notion',collectionId:id});
  const enumerations=catalogs;blocked=true;
  for(const command of [{type:'list_feed_notion_children' as const,collectionId:id,pageId:'https://www.notion.so/parent'},{type:'list_feed_notion_pages' as const,collectionId:id,section:'private' as const},{type:'read_feed_notion' as const,collectionId:id}]) {
    const before=identities;workspace+='-next';let finished=false;
    const pending=f.engine.command(command);void pending.then(()=>finished=true,()=>finished=true);
    try {
      await setImmediate();
      assert(finished,'directory is waiting for MCP status enumeration before its real workspace check');
      assert.equal(identities,before+1,'each read still validates its real workspace');
      assert.equal((await pending).notion!.workspace?.id,workspace,'no stale workspace identity is cached');
    } finally {if(!finished)release();await pending;}
  }
  assert.equal(catalogs,enumerations,'successful identity reads do not start redundant background enumeration');
  blocked=false;release();
  const reads=contents;validIdentity=false;
  await assert.rejects(f.engine.command({type:'list_feed_notion_children',collectionId:id,pageId:'https://www.notion.so/parent'}));
  assert.equal(contents,reads,'invalid identity cannot read directory contents');
  authorized=false;
  assert.equal((await f.engine.command({type:'read_feed_notion',collectionId:id})).notion!.connected,false);
  authorized=true;catalogAvailable=false;
  await assert.rejects(f.engine.command({type:'read_feed_notion',collectionId:id}),/catalog unavailable/);
  validIdentity=true;
  assert.equal((await f.engine.command({type:'read_feed_notion',collectionId:id})).notion!.connected,true);
  assert.equal(catalogs,enumerations+3,'failed identity reads retain full status fallback');
});
