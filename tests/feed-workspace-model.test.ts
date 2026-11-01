import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, writeFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { feedFixture } from './feed-runtime-fixture.js';
import { until } from './runtime-fixture.js';
import { projectDirectory } from '../src/core/paths.js';

test('collection binds selected name and cwd while isolating control files in a shared directory', async t => {
  const f=await feedFixture(t), directory=projectDirectory(f.root,'chosen');
  writeFileSync(join(directory,'goal.json'),'existing user file');
  const a=(await f.engine.command({type:'create_feed_collection',name:'明确名称',directory,instruction:'',input:{text:'持续关注公开资料'},requestId:'chosen-a'})).admission!;
  await until(()=>f.clients[0]?.calls.some(call=>call.method==='turn/start')===true);
  const detail=(await f.engine.command({type:'get_feed_collection',collectionId:a.collectionId})).collection!;
  assert.equal(detail.collection.name,'明确名称');assert.equal(detail.collection.directory,directory);
  assert.equal(f.clients[0].options.cwd,directory);
  assert.equal(f.clients[0].calls.find(call=>call.method==='thread/start')!.params.cwd,directory);
  assert.equal(f.clients[0].options.home,join(directory,'.mixcat','feed',a.collectionId,'.codex'));
  assert.equal(readFileSync(join(directory,'.mixcat','feed',a.collectionId,'.gitignore'),'utf8'),'*\n');
  const input=f.clients[0].calls.find(call=>call.method==='turn/start')!.params.input;
  assert(input.some((block:{text?:string})=>block.text?.includes(join(directory,'.mixcat','feed',a.collectionId,'goal.json'))));
  await f.engine.command({type:'create_feed_collection',name:'第二个名称',directory,instruction:'',input:{text:'另一个目标'},requestId:'chosen-b'});
  await until(()=>f.clients.length===2&&f.clients[1].calls.some(call=>call.method==='turn/start'));
  assert.notEqual(f.clients[0].options.home,f.clients[1].options.home);
  assert.equal(readFileSync(join(directory,'goal.json'),'utf8'),'existing user file');
  writeFileSync(join(directory,'.mixcat','feed',a.collectionId,'goal.json'),JSON.stringify({requestId:'goal-in-selected-dir',name:'明确名称',objective:'接受的新目标',schedule:{frequency:'manual'},expectedRevision:detail.collection.revision}));
  const active=(await f.engine.command({type:'get_feed_collection',collectionId:a.collectionId})).collection!.activeRun!;
  f.clients[0].options.onEvent({method:'turn/completed',params:{threadId:active.threadId,turn:{id:active.turnId,status:'completed',items:[]}}});
  assert.equal((await f.engine.command({type:'get_feed_collection',collectionId:a.collectionId})).collection!.collection.instruction,'接受的新目标');
  await assert.rejects(f.engine.command({type:'create_feed_collection',name:'bad',directory:'C:\\forbidden',instruction:'',input:{text:'目标'},requestId:'bad-dir'}),/采集工作目录无效/);
  const link=join(f.root,'linked-directory');symlinkSync(directory,link,'junction');
  try{await assert.rejects(f.engine.command({type:'create_feed_collection',name:'bad-link',directory:link,instruction:'',input:{text:'目标'},requestId:'bad-link'}),/采集工作目录无效/);}finally{unlinkSync(link);}
});

test('queued messages keep their selected model and effort while later choices update only the default', async t => {
  const f=await feedFixture(t,method=>method==='model/list'?{data:[{model:'fixture-model',displayName:'First',isDefault:true,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium',description:'Default'}]},{model:'second-model',displayName:'Second',defaultReasoningEffort:'max',supportedReasoningEfforts:[{reasoningEffort:'max',description:'Deep'}]}],nextCursor:null}:undefined);
  const first={model:'fixture-model',reasoningEffort:'medium',skills:[],plugins:[]},second={...first,model:'second-model',reasoningEffort:'max'};
  const a=(await f.engine.command({type:'create_feed_collection',name:'模型选择',instruction:'',capabilities:first,input:{text:'first'},requestId:'model-first'})).admission!;
  await until(()=>f.clients[0]?.calls.some(call=>call.method==='turn/start')===true);
  const b=(await f.engine.command({type:'send_feed_message',collectionId:a.collectionId,input:{text:'second',capabilities:second},requestId:'model-second'})).admission!;
  await f.engine.command({type:'send_feed_message',collectionId:a.collectionId,input:{text:'third',capabilities:first},requestId:'model-third'});
  assert.deepEqual((await f.engine.command({type:'get_feed_collection',collectionId:a.collectionId})).collection!.collection.capabilities,first);
  assert.deepEqual((await f.engine.command({type:'list_feed_runs',collectionId:a.collectionId})).runs!.items.find(run=>run.id===b.runId)!.inputSnapshot.capabilities,second);
  for(let i=0;i<2;i++){
    const active=(await f.engine.command({type:'get_feed_collection',collectionId:a.collectionId})).collection!.activeRun!;
    f.clients[0].options.onEvent({method:'turn/completed',params:{threadId:active.threadId,turn:{id:active.turnId,status:'completed',items:[]}}});
    await until(()=>f.clients[0].calls.filter(call=>call.method==='turn/start').length===i+2);
  }
  const turns=f.clients[0].calls.filter(call=>call.method==='turn/start');
  assert.deepEqual(turns.map(call=>[call.params.model,call.params.effort]),[['fixture-model','medium'],['second-model','max'],['fixture-model','medium']]);
});

test('chosen directory and queued explicit effort survive reopening and resume the original thread', async t => {
  const f=await feedFixture(t),directory=projectDirectory(f.root,'persistent-directory');
  const capabilities={model:'fixture-model',reasoningEffort:'medium',skills:[],plugins:[]};
  const a=(await f.engine.command({type:'create_feed_collection',name:'持久配置',directory,instruction:'',input:{text:'first'},requestId:'restart-first'})).admission!;
  await until(()=>f.clients[0]?.calls.some(call=>call.method==='turn/start')===true);
  const b=(await f.engine.command({type:'send_feed_message',collectionId:a.collectionId,input:{text:'second',capabilities},requestId:'restart-second'})).admission!;
  const active=(await f.engine.command({type:'get_feed_collection',collectionId:a.collectionId})).collection!.activeRun!;
  await f.engine.command({type:'stop_feed_run',runId:a.runId,requestId:'restart-stop'});
  f.clients[0].options.onEvent({method:'turn/completed',params:{threadId:active.threadId,turn:{id:active.turnId,status:'interrupted',items:[]}}});
  const engine=await f.reopen();
  assert.equal((await engine.command({type:'get_feed_collection',collectionId:a.collectionId})).collection!.collection.directory,directory);
  assert.deepEqual((await engine.command({type:'list_feed_runs',collectionId:a.collectionId})).runs!.items.find(run=>run.id===b.runId)!.inputSnapshot.capabilities,capabilities);
  await engine.command({type:'continue_feed_queue',collectionId:a.collectionId,requestId:'restart-continue'});
  await until(()=>f.clients[1]?.calls.some(call=>call.method==='turn/start')===true);
  const resume=f.clients[1].calls.find(call=>call.method==='thread/resume')!.params;
  assert.equal(resume.threadId,active.threadId);assert.equal(resume.cwd,directory);
  assert.equal(f.clients[1].calls.find(call=>call.method==='turn/start')!.params.effort,'medium');
});
