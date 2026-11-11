import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { WorkflowEngine } from '../src/core/engine.js';
import { projectDirectory } from '../src/core/paths.js';
import { feedFixture } from './feed-runtime-fixture.js';
import { until } from './runtime-fixture.js';
import { collectionCommandSchema } from '../src/core/feed-collections.js';

test('new collection uses the native default picker catalog without creating a collection or session', async t => {
  const root=mkdtempSync(join(projectDirectory(process.cwd(),'.runtime','tests'),'feed-models-'));
  const calls:string[]=[];
  const engine=new WorkflowEngine({workbenchRoot:root,executable:'fixture',nativeFactory(){throw Error('No collection runtime expected');},accountFactory:()=>({async connect(){},async close(){},async rpc(method,params){calls.push(method);return {data:[{model:'native-id',displayName:'Native label',isDefault:true,defaultReasoningEffort:'max',supportedReasoningEfforts:[{reasoningEffort:'max',description:'Native option'}]},...(params.includeHidden?[{model:'hidden-native-id',displayName:'Hidden native label',hidden:true}]:[])],nextCursor:null};}})});
  await engine.init();t.after(()=>engine.close());
  const reply=await engine.command({type:'feed_capabilities'});
  assert.deepEqual(reply.feed!.capabilities!.models,[{id:'native-id',name:'Native label',isDefault:true,defaultReasoningEffort:'max',supportedReasoningEfforts:[{reasoningEffort:'max',description:'Native option'}]}]);
  assert.equal((await engine.command({type:'feed_snapshot'})).feed!.snapshot.collections.length,0);
  assert.deepEqual(calls,['model/list']);
});

test('collection model queries avoid unrelated plugin discovery and preserve the active turn', async t => {
  const f = await feedFixture(t, method => {
    if (method === 'plugin/list') throw new Error('Codex emitted an invalid protocol message');
    if (method === 'model/list') return { data: [{ model: 'fixture-model', displayName: 'Native model', isDefault: true, defaultReasoningEffort: 'max', supportedReasoningEfforts: [{ reasoningEffort: 'max', description: 'Native maximum' }] }], nextCursor: null };
  });
  const admission = (await f.create('model-query')).admission!;
  await until(() => f.clients[0]?.calls.some(call => call.method === 'turn/start') === true);
  const before = (await f.engine.command({ type: 'get_feed_collection', collectionId: admission.collectionId })).collection!.activeRun!;
  const query = { type: 'feed_capabilities', collectionId: admission.collectionId, modelsOnly: true } as const;
  assert(collectionCommandSchema.safeParse(query).success);
  const offset = f.clients[0].calls.length;
  const catalog = (await f.engine.command(query)).capabilities!;
  assert.deepEqual(catalog, { models: [{ id: 'fixture-model', name: 'Native model', isDefault: true, defaultReasoningEffort: 'max', supportedReasoningEfforts: [{ reasoningEffort: 'max', description: 'Native maximum' }] }], skills: [], plugins: [], errors: [] });
  assert.deepEqual(f.clients[0].calls.slice(offset).map(call => call.method), ['account/read', 'model/list']);
  const after = (await f.engine.command({ type: 'get_feed_collection', collectionId: admission.collectionId })).collection!.activeRun!;
  assert.equal(after.id, before.id); assert.equal(after.status, 'running'); assert.equal(after.turnId, before.turnId);
  await assert.rejects(f.engine.command({ type: 'feed_capabilities', collectionId: admission.collectionId }), /invalid protocol message/);
});
