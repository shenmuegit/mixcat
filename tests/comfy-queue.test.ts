import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { projectDirectory } from '../src/core/paths.js';
import { ComfyStore } from '../src/core/comfy-store.js';
import { ComfyService } from '../src/core/comfy-service.js';
import type { GraphView } from '../src/shared/comfy.js';

const view: GraphView = { observation: { projectId: 'p', instanceId: 'i', workflowId: 'w', tabId: 't', revision: 'r' }, workflow: { nodes: [] }, subgraphPath: [], selectedNodeIds: [] };
const payload = { client_id: 'native-client', prompt: { '1': { class_type: 'EmptyImage', inputs: { width: 16, height: 16 } } }, extra_data: { comfy_usage_source: 'comfyui-frontend' as const, extra_pnginfo: { workflow: { nodes: [{ id: 1, seed: 73 }] } } } };
const fixture = () => new ComfyStore(mkdtempSync(join(projectDirectory(resolve('.'), '.runtime', 'implementation', 'fixtures'), 'comfy-queue-')), 'p');

for (const status of [503, 408, 409]) test(`JSON HTTP ${status} preserves uncertainty, original receipt and reconciliation without resubmission`, async () => {
  let store = fixture(); const root = store.root; let posts = 0;
  const response = { status, body: { error: status === 409 ? 'Prompt admission already consumed' : 'PRIVATE_NATIVE_BODY' } };
  let service = new ComfyService(store, async () => view, {
    prepare: async request => { await service.admit(request.sessionId, view.observation, payload); return { ok: false }; },
    submit: async () => { posts++; return response; }, reconcile: async () => undefined
  });
  const request = { type: 'queue_graph' as const, requestId: 'uncertain', expected: view.observation };
  const initial = await service.handle('p', request, { kind: 'user' }); assert('status' in initial);
  assert.equal(initial.status, 'submission_unknown'); assert.equal(initial.error?.code, 'native_submission_unknown');
  assert.doesNotMatch(initial.error!.message, /rejected|PRIVATE_NATIVE_BODY/);
  assert.deepEqual(store.submission(request.requestId)!.response, response);
  await service.close(); store = new ComfyStore(root, 'p'); let observed: 'queued' | 'succeeded' = 'queued';
  service = new ComfyService(store, async () => { throw Error('no preparation'); }, { prepare: async () => { throw Error('no preparation'); }, submit: async () => { posts++; throw Error('no resubmit'); }, reconcile: async promptId => { assert.equal(promptId, initial.promptId); return observed; } });
  try {
    assert.deepEqual(await service.handle('p', request, { kind: 'user' }), initial);
    const queued = await service.handle('p', { type: 'read_run', runId: initial.id }, { kind: 'user' }); assert('status' in queued); assert.equal(queued.status, 'queued'); assert.equal(queued.error, undefined);
    observed = 'succeeded'; const complete = await service.handle('p', { type: 'read_run', runId: initial.id }, { kind: 'user' }); assert('status' in complete); assert.equal(complete.status, 'succeeded'); assert.equal(complete.error, undefined);
    assert.deepEqual(await service.handle('p', request, { kind: 'user' }), initial); assert.equal(posts, 1);
  } finally { await service.close(); }
});

test('only pinned validation and prequeue admission response shapes prove nonacceptance', async () => {
  const store = fixture(); let response: any, posts = 0;
  const service = new ComfyService(store, async () => view, { prepare: async request => { await service.admit(request.sessionId, view.observation, payload).catch(() => {}); return { ok: false }; }, submit: async () => { posts++; return response; }, reconcile: async () => undefined });
  const validation = { error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation', extra_info: { authorization: 'Bearer SECRET_INPUT' } }, node_errors: { '1': { class_type: 'PreviewImage', errors: [{ type: 'required_input_missing', details: 'images', raw: 'SECRET_INPUT' }] } } };
  const cases = [
    [{ status: 400, body: validation }, 'failed', 'native_validation_failed'],
    [{ status: 403, body: { error: 'Mixcat admission required' } }, 'failed', 'native_submission_failed'],
    [{ status: 400, body: { error: { type: 'prompt_outputs_failed_validation', message: 'missing native shape' } } }, 'submission_unknown', 'native_submission_unknown'],
    [{ status: 400, body: { error: { type: 'unknown', message: 'SECRET_INPUT' }, node_errors: {} } }, 'submission_unknown', 'native_submission_unknown'],
    [{ status: 403, body: { error: 'unrecognized refusal' } }, 'submission_unknown', 'native_submission_unknown'],
    [{ status: 403, body: { error: 'Mixcat admission required', prompt_id: 'possibly-accepted' } }, 'submission_unknown', 'native_submission_unknown'],
    [{ status: 500, body: validation }, 'submission_unknown', 'native_submission_unknown'],
    [{ status: 200, body: { prompt_id: 'other-prompt' } }, 'submission_unknown', 'native_submission_unknown'],
  ] as const;
  try {
    for (const [index, [value, status, code]] of cases.entries()) {
      response = value; const request = { type: 'queue_graph' as const, requestId: 'shape-' + index, expected: view.observation };
      const result = await service.handle('p', request, { kind: 'user' }); assert('status' in result); assert.equal(result.status, status); assert.equal(result.error?.code, code);
      if (index === 0) assert.match(result.error!.message, /PreviewImage.*images.*required_input_missing/);
      assert.doesNotMatch(JSON.stringify(result), /SECRET_INPUT|Bearer|possibly-accepted|other-prompt/);
      assert.deepEqual(store.submission(request.requestId)!.response, value);
      assert.deepEqual(await service.handle('p', request, { kind: 'user' }), result); assert.equal(posts, index + 1);
    }
  } finally { await service.close(); }
});

test('native preparation admits a frozen durable run once and replays the original receipt', async () => {
  const store = fixture(); let posts = 0, preparations = 0;
  const service = new ComfyService(store, async () => view, {
    prepare: async request => {
      preparations++;
      await assert.rejects(service.admit('expired-session', view.observation, payload), /会话/);
      await assert.rejects(service.admit(request.sessionId, { ...view.observation, instanceId: 'other-instance' }, payload), /身份/);
      const result = await service.admit(request.sessionId, view.observation, payload);
      assert.equal(result.status, 200);
      return { ok: true };
    },
    submit: async body => {
      posts++;
      const saved = store.submission('queue')!;
      assert.equal(saved.payload.prompt_id, body.prompt_id);
      assert.deepEqual(saved.payload.prompt, payload.prompt);
      assert.equal(saved.run.status, 'submitting');
      return { status: 200, body: { prompt_id: body.prompt_id, number: 7, node_errors: {} } };
    },
    reconcile: async () => undefined
  });
  try {
    const request = { type: 'queue_graph' as const, requestId: 'queue', expected: view.observation };
    const first = await service.handle('p', request, { kind: 'codex', nodeId: 'n', threadId: 't', turnId: 'u', callId: 'c' });
    assert.equal('status' in first && first.status, 'queued');
    assert.deepEqual(await service.handle('p', request, { kind: 'user' }), first);
    assert.equal(posts, 1); assert.equal(preparations, 1);
    assert.deepEqual(store.recoverableEdits(), []);
    await assert.rejects(service.handle('p', { ...request, expected: { ...view.observation, revision: 'changed' } }, { kind: 'user' }), /冲突/);
  } finally { await service.close(); }
});

test('lost acceptance becomes uncertain across reopen and cannot POST again', async () => {
  let store = fixture(); const root = store.root; let posts = 0;
  let service = new ComfyService(store, async () => view, {
    prepare: async request => { await service.admit(request.sessionId, view.observation, payload).catch(() => {}); return { ok: false }; },
    submit: async () => { posts++; throw Error('acceptance response lost'); },
    reconcile: async () => 'succeeded'
  });
  const request = { type: 'queue_graph' as const, requestId: 'lost', expected: view.observation };
  const first = await service.handle('p', request, { kind: 'user' });
  assert.equal('status' in first && first.status, 'submission_unknown');
  await service.close(); store = new ComfyStore(root, 'p');
  service = new ComfyService(store, async () => { throw Error('must not prepare again'); }, {
    prepare: async () => { throw Error('must not prepare again'); }, submit: async () => { posts++; throw Error('duplicate'); }, reconcile: async () => 'succeeded'
  });
  try {
    assert.deepEqual(await service.handle('p', request, { kind: 'user' }), first);
    assert.equal(posts, 1);
    assert('id' in first);
    const reconciled = await service.handle('p', { type: 'read_run', runId: first.id }, { kind: 'user' });
    assert.equal('status' in reconciled && reconciled.status, 'succeeded');
    assert.deepEqual(await service.handle('p', request, { kind: 'user' }), first, 'initial uncertain receipt remains stable');
  } finally { await service.close(); }
});

test('persistence failure prevents POST; batches freeze separate actual inputs and late ACK cannot regress state', async () => {
  const store = fixture(); let posts = 0, current = view;
  const service = new ComfyService(store, async () => current, {
    prepare: async request => {
      for (let i = 0; i < request.queue.batchCount; i++) {
        const body = structuredClone(payload); body.extra_data.extra_pnginfo.workflow = { nodes: [{ id: 1, seed: i + 10 }] };
        await service.admit(request.sessionId, view.observation, body);
      }
      return { ok: true };
    },
    submit: async body => {
      posts++;
      const saved = store.listRuns().runs.find(run => run.promptId === body.prompt_id)!;
      store.updateRun(saved.id, { status: 'succeeded' });
      return { status: 200, body: { prompt_id: body.prompt_id, number: posts, node_errors: {} } };
    }, reconcile: async () => undefined
  });
  try {
    const { writeFileSync, renameSync } = await import('node:fs');
    const path = join(store.root, '.mixcat/comfy/workflows'); writeFileSync(path, 'blocked');
    const request = { type: 'queue_graph' as const, requestId: 'batch', expected: view.observation };
    await assert.rejects(service.nativeQueue('p', request, { number: -1, batchCount: 2, options: {} }));
    assert.equal(posts, 0);
    renameSync(path, path + '-blocked');
    const result = await service.nativeQueue('p', request, { number: -1, batchCount: 2, options: {} });
    assert.equal(result.run?.status, 'succeeded'); assert.equal(posts, 2);
    const a = store.submission('batch')!, b = store.submission('batch:item:1')!;
    assert.notEqual(a.run.id, b.run.id); assert.notEqual(a.run.promptId, b.run.promptId);
    assert.deepEqual(a.payload.extra_data.extra_pnginfo.workflow, { nodes: [{ id: 1, seed: 10 }] });
    assert.deepEqual(b.payload.extra_data.extra_pnginfo.workflow, { nodes: [{ id: 1, seed: 11 }] });
    current = { ...view, observation: { ...view.observation, revision: 'manual-edit' } };
    await assert.rejects(service.nativeQueue('p', { ...request, requestId: 'stale' }, { number: 0, batchCount: 1, options: {} }), /变更/);
    assert.equal(posts, 2);
  } finally { await service.close(); }
});

test('restart with a staged submission returns uncertainty without native preparation or POST', async () => {
  let store=fixture();const root=store.root;
  const request={type:'queue_graph' as const,requestId:'crash',expected:view.observation};
  const {createHash}=await import('node:crypto');
  const fingerprint=createHash('sha256').update(JSON.stringify({request,queue:{number:0,batchCount:1,options:{}}})).digest('hex');
  store.beginOperation(request.requestId,fingerprint);
  const staged=store.stageRun(request.requestId,view.observation,payload,{kind:'user'});store.close();
  store=new ComfyStore(root,'p');
  const service=new ComfyService(store,async()=>{throw Error('unexpected preparation')},{prepare:async()=>{throw Error('unexpected prepare')},submit:async()=>{throw Error('unexpected POST')},reconcile:async()=>undefined});
  try{
    const run=await service.handle('p',request,{kind:'user'});assert('status' in run);assert.equal(run.status,'submission_unknown');assert.equal(run.id,staged.run.id);
    assert.deepEqual(store.recoverableEdits(),[]);
  }finally{await service.close();}
});

test('lost renderer drains in-flight admission before closing the durable ledger', async () => {
  const store=fixture();let started!:()=>void,release!:()=>void;
  const entered=new Promise<void>(r=>started=r),gate=new Promise<void>(r=>release=r);
  let admitted:Promise<unknown>|undefined;
  const service=new ComfyService(store,async()=>view,{
    prepare:async request=>{admitted=service.admit(request.sessionId,view.observation,payload);await entered;throw Error('renderer lost');},
    submit:async body=>{started();await gate;return {status:200,body:{prompt_id:body.prompt_id,number:1,node_errors:{}}};},reconcile:async()=>undefined
  });
  const request=service.handle('p',{type:'queue_graph',requestId:'closing',expected:view.observation},{kind:'user'});
  const rejected=assert.rejects(request,/renderer lost/);await entered;
  let closed=false;const closing=service.close().then(()=>{closed=true;});
  await new Promise(r=>setTimeout(r,20));assert.equal(closed,false);release();
  await rejected;await admitted;await closing;
  const reopened=new ComfyStore(store.root,'p');try{assert.equal(reopened.submission('closing')!.run.status,'queued');}finally{reopened.close();}
});

test('an expired outer RPC cannot submit after waiting behind another operation or runtime setup', async () => {
  const store=fixture();let release!:()=>void,entered!:()=>void,posts=0;
  const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);let reads=0;
  const service=new ComfyService(store,async()=>{if(!reads++){entered();await gate;}return view;},{prepare:async()=>{throw Error('expired request reached native preparation')},submit:async()=>{posts++;throw Error('expired POST')},reconcile:async()=>undefined});
  const first=service.handle('p',{type:'read_graph'},{kind:'user'});await started;
  const queued=service.handle('p',{type:'queue_graph',requestId:'expired',expected:view.observation},{kind:'user'},Date.now()+10);
  const rejected=assert.rejects(queued,/超时|过期/);await new Promise(r=>setTimeout(r,30));release();
  try{await first;await rejected;assert.equal(posts,0);assert.equal(store.listRuns().runs.length,0);}finally{await service.close();}
});

test('a queue that expires during runtime setup never prepares or submits', async () => {
  const store=fixture();let release!:()=>void,entered!:()=>void,posts=0;
  const started=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
  const service=new ComfyService(store,async()=>{entered();await gate;return view;},{prepare:async()=>{throw Error('expired setup reached prepare')},submit:async()=>{posts++;throw Error('unexpected POST')},reconcile:async()=>undefined});
  const request=service.handle('p',{type:'queue_graph',requestId:'setup',expected:view.observation},{kind:'user'},Date.now()+20);
  const rejected=assert.rejects(request,/超时/);await started;await new Promise(r=>setTimeout(r,30));release();
  try{await rejected;assert.equal(posts,0);assert.equal(store.listRuns().runs.length,0);}finally{await service.close();}
});
