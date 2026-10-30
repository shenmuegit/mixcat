import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderProfile, GraphView, RunView } from '../../src/shared/comfy.js';

export async function providerSmoke(entry: any, projectId: string, root: string, profiles: ProviderProfile[], setVideo: (video: Buffer) => void, retain?: () => void) {
  const guest = (code: string) => entry.view.webContents.executeJavaScript(code);
  const read = () => entry.service.handle(projectId, { type: 'read_graph' }, { kind: 'user' }) as Promise<GraphView>;
  const before = await entry.rpc.snapshotWorkspace(projectId);
  const stable = async () => {
    let previous = await read();
    for (let n = 0; n < 30; n++) { await new Promise(done => setTimeout(done, 150)); const current = await read(); if (current.observation.revision === previous.observation.revision) return current; previous = current; }
    throw Error('Native smoke graph did not settle');
  };
  const empty = () => guest(`window.nativeApp=window.comfyAPI.app.app; nativeApp.loadGraphData({nodes:[],links:[],groups:[],config:{},extra:{},version:0.4},false,false,nativeApp.extensionManager.workflow.activeWorkflow).then(()=>true)`);
  const finish = async () => {
    await guest('new Promise(requestAnimationFrame).then(()=>new Promise(requestAnimationFrame)).then(()=>true)');
    const run = await entry.service.handle(projectId, { type: 'queue_graph', requestId: randomUUID(), expected: (await stable()).observation }, { kind: 'user' }) as RunView;
    for (let n = 0; n < 300; n++) {
      const result = await entry.runs.read(run.id) as RunView;
      if (['succeeded', 'failed'].includes(result.status)) { assert.equal(result.status, 'succeeded', JSON.stringify(await (await fetch(entry.origin + '/history/' + run.promptId)).json())); return result; }
      await new Promise(done => setTimeout(done, 100));
    }
    throw Error('Native provider qualification exceeded deadline');
  };
  await empty();
  await guest(`(()=>{const a=LiteGraph.createNode('EmptyImage'),b=LiteGraph.createNode('CreateVideo'),c=LiteGraph.createNode('SaveVideo');for(const n of [a,b,c])nativeApp.rootGraph.add(n);a.connect(0,b,0);b.connect(0,c,0);a.widgets.find(w=>w.name==='width').value=32;a.widgets.find(w=>w.name==='height').value=32;a.widgets.find(w=>w.name==='batch_size').value=2;c.widgets.find(w=>w.name==='filename_prefix').value='task9-fixture';return true;})()`);
  const fixture = await finish(); assert.equal(fixture.assets.length, 1); setVideo(readFileSync(join(root, fixture.assets[0].relativePath)));
  console.log('native CPU VIDEO fixture passed');
  await empty();
  const ids = profiles.map(profile => profile.id + '@' + profile.revision);
  await guest(`(()=>{const a=LiteGraph.createNode('MixcatAPIText'),b=LiteGraph.createNode('MixcatAPIImage'),c=LiteGraph.createNode('MixcatAPIVideo'),d=LiteGraph.createNode('SaveVideo'),r=LiteGraph.createNode('EmptyImage');for(const n of [a,b,c,d,r])nativeApp.rootGraph.add(n);r.widgets.find(w=>w.name==='width').value=32;r.widgets.find(w=>w.name==='height').value=32;r.connect(0,b,b.inputs.findIndex(i=>i.name==='images'));a.connect(0,b,b.inputs.findIndex(i=>i.name==='prompt'));a.connect(0,c,c.inputs.findIndex(i=>i.name==='prompt'));b.connect(0,c,c.inputs.findIndex(i=>i.name==='images'));c.connect(0,d,0);const ids=${JSON.stringify(ids)};[a,b,c].forEach((n,i)=>{n.widgets.find(w=>w.name==='connection').value=ids[i];n.widgets.find(w=>w.name==='parameters').value=i===2?'{"duration":1,"resolution":"540p"}':'{}';n.widgets.find(w=>w.name==='model').value=i===2?'viduq3-turbo':i===1?'fixture-image':'fixture-text';});a.widgets.find(w=>w.name==='prompt').value='three provider qualification';c.widgets.find(w=>w.name==='mode').value='image';d.widgets.find(w=>w.name==='filename_prefix').value='task9-three-providers';return true;})()`);
  const result = await finish(); assert.equal(result.assets.length, 1); assert.match(result.assets[0].mime, /^video\//);
  assert.equal(entry.service.store.providerJobs(result.id).length, 3);
  console.log('native Ark MiniMax Vidu VIDEO chain passed');
  let retained: RunView | undefined;
  if (retain) {
    retain();
    retained = await entry.service.handle(projectId, { type: 'queue_graph', requestId: randomUUID(), expected: (await stable()).observation }, { kind: 'user' }) as RunView;
    for (let n = 0; n < 150 && !entry.service.store.providerJobs(retained.id).some((job: any) => job.remote); n++) await new Promise(done => setTimeout(done, 100));
    assert(entry.service.store.providerJobs(retained.id).some((job: any) => job.remote));
    await entry.runs.stop(retained.id, 'stop_waiting');
    for (let n = 0; n < 100; n++) { const queue = await (await fetch(entry.origin + '/queue')).json() as any; if (!queue.queue_running.length && !queue.queue_pending.length) break; await new Promise(done => setTimeout(done, 100)); }
    retained = await entry.runs.read(retained.id); assert.equal(retained!.waiting, false); assert.equal(entry.service.store.providerJobs(retained!.id).find((job: any) => job.remote).status, 'remote_running');
  }
  await entry.rpc.restoreWorkspace(projectId, before);
  return { fixture, result, ...(retained ? { retained } : {}) };
}
