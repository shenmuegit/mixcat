import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { WorkflowEngine } from '../src/core/engine.js';
import { projectDirectory } from '../src/core/paths.js';

test('new collection model discovery uses the account catalog without creating a collection or session', async t => {
  const root=mkdtempSync(join(projectDirectory(process.cwd(),'.runtime','tests'),'feed-models-'));
  const calls:string[]=[];
  const engine=new WorkflowEngine({workbenchRoot:root,executable:'fixture',nativeFactory(){throw Error('No collection runtime expected');},accountFactory:()=>({async connect(){},async close(){},async rpc(method){calls.push(method);return {data:[{model:'native-id',displayName:'Native label',isDefault:true,defaultReasoningEffort:'max',supportedReasoningEfforts:[{reasoningEffort:'max',description:'Native option'}]}],nextCursor:null};}})});
  await engine.init();t.after(()=>engine.close());
  const reply=await engine.command({type:'feed_capabilities'});
  assert.deepEqual(reply.feed!.capabilities!.models,[{id:'native-id',name:'Native label',isDefault:true,defaultReasoningEffort:'max',supportedReasoningEfforts:[{reasoningEffort:'max',description:'Native option'}]}]);
  assert.equal((await engine.command({type:'feed_snapshot'})).feed!.snapshot.collections.length,0);
  assert.deepEqual(calls,['model/list']);
});
