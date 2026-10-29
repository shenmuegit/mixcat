import { WorkflowEngine } from './engine.js';
import { CommandDispatcher } from './commands.js';
import type { CommandEnvelope } from '../shared/types.js';
import { ComfyRpc } from './comfy-rpc.js';

const port = (process as any).parentPort;
const [root, executable, accountRoot] = process.argv.slice(2);
const comfyHost = new ComfyRpc(message => port.postMessage(message));
const engine = new WorkflowEngine({ workbenchRoot: root, executable, comfyHost, ...(accountRoot ? { accountRoot } : {}) });
const dispatcher = new CommandDispatcher(engine);
port.on('message', ({ data }: { data: { type?: string; id: string; envelope?: CommandEnvelope; inspectId?: string; shutdown?: boolean } }) => {
  if (data.type === 'comfy_reply') { comfyHost.receive(data); return; }
  void (async () => {
    try {
      if (data.shutdown) { comfyHost.invalidate(); console.info('core shutdown: requested'); await engine.close(); console.info('core shutdown: complete'); port.postMessage({ id: data.id, result: true }); process.exitCode = 0; return; }
      if (data.inspectId !== undefined) { port.postMessage({ id: data.id, result: dispatcher.inspect(data.inspectId) }); return; }
      const result = await dispatcher.dispatch(data.envelope!); port.postMessage({ id: data.id, result });
    } catch (error) { port.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) }); }
  })();
});
engine.subscribe(snapshot => port.postMessage({ type: 'snapshot', snapshot }));
engine.init().then(() => { port.postMessage({ type: 'ready' }); void engine.restoreAccount().catch(() => {}); }).catch(error => port.postMessage({ type: 'fatal', error: error instanceof Error ? error.message : String(error) }));
