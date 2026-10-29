import { WorkflowEngine } from './engine.js';
import { CommandDispatcher } from './commands.js';
import type { CoreWorkerRequest } from '../shared/worker.js';
import { ComfyRpc } from './comfy-rpc.js';

const port = (process as any).parentPort;
const [root, executable, accountRoot] = process.argv.slice(2);
const comfyHost = new ComfyRpc(message => port.postMessage(message));
const engine = new WorkflowEngine({ workbenchRoot: root, executable, comfyHost, ...(accountRoot ? { accountRoot } : {}) });
const dispatcher = new CommandDispatcher(engine);
port.on('message', ({ data }: { data: CoreWorkerRequest | { type: 'comfy_reply' } }) => {
  if ('type' in data) { comfyHost.receive(data); return; }
  void (async () => {
    try {
      await initialized;
      if (data.shutdown) { comfyHost.invalidate(); console.info('core shutdown: requested'); await engine.close(); console.info('core shutdown: complete'); port.postMessage({ id: data.id, result: true }); process.exitCode = 0; return; }
      if (data.inspectId !== undefined) { port.postMessage({ id: data.id, result: dispatcher.inspect(data.inspectId) }); return; }
      if (data.systemEvent === 'power-resume') { engine.reconcileFeedSchedules(); port.postMessage({ id: data.id, result: true }); return; }
      const result = await dispatcher.dispatch(data.envelope!); port.postMessage({ id: data.id, result });
    } catch (error) { port.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) }); }
  })();
});
engine.subscribe(snapshot => port.postMessage({ type: 'snapshot', snapshot }));
const initialized = engine.init();
initialized.then(() => { port.postMessage({ type: 'ready' }); void engine.restoreAccount().catch(() => {}); }).catch(error => port.postMessage({ type: 'fatal', error: error instanceof Error ? error.message : String(error) }));

engine.subscribeFeed(snapshot => port.postMessage({ type: 'feed_snapshot', snapshot }));
