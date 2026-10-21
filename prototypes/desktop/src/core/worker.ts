import { WorkflowEngine } from './engine.js';
import type { AppCommand } from '../shared/types.js';

const port = (process as any).parentPort;
const [root, executable] = process.argv.slice(2);
const engine = new WorkflowEngine({ workbenchRoot: root, executable });
let queue = Promise.resolve();
port.on('message', ({ data }: { data: { id: string; command?: AppCommand; shutdown?: boolean } }) => {
  // Native approvals must remain answerable while another command awaits its RPC.
  if (data.command?.type === 'respond_native') {
    void engine.command(data.command).then(result => port.postMessage({ id: data.id, result }), error => port.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) }));
    return;
  }
  queue = queue.then(async () => {
    try {
      if (data.shutdown) { console.info('core shutdown: requested'); await engine.close(); console.info('core shutdown: complete'); port.postMessage({ id: data.id, result: true }); process.exitCode = 0; return; }
      const result = await engine.command(data.command!); port.postMessage({ id: data.id, result });
    } catch (error) { port.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) }); }
  });
});
engine.subscribe(snapshot => port.postMessage({ type: 'snapshot', snapshot }));
engine.init().then(() => port.postMessage({ type: 'ready' })).catch(error => port.postMessage({ type: 'fatal', error: error instanceof Error ? error.message : String(error) }));
