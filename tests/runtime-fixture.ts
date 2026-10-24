import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkflowEngine } from '../src/core/engine.js';
import { projectDirectory } from '../src/core/paths.js';
import type { CodexPort, NativeClientOptions } from '../src/shared/types.js';
import { accountFixture } from './account-fixture.js';

export function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => resolve = r); return { promise, resolve }; }
export async function until(predicate: () => boolean) { for (let i = 0; i < 150; i++) { if (predicate()) return; await delay(10); } assert.fail('fixture did not reach expected state'); }
export async function fixture(t: { after(fn: () => Promise<void>): void }, connect = async () => {}, template?: 'web-product') {
  const base = projectDirectory(resolve('.'), '.runtime', 'implementation', 'fixtures');
  const root = mkdtempSync(resolve(base, 'session-'));
  const clients: { options: NativeClientOptions; calls: { method: string; params: any }[]; port: CodexPort }[] = [];
  let sequence = 0;
  const engine = new WorkflowEngine({ workbenchRoot: root, executable: 'fixture', accountFactory: accountFixture().factory, nativeFactory(options) {
    const calls: { method: string; params: any }[] = [];
    const port: CodexPort = { connect, async close() {}, async rpc(method, params) {
      calls.push({ method, params });
      if (method === 'account/read') return { account: { email: 'fixture' } };
      if (method === 'windowsSandbox/readiness') return { status: 'configured' };
      if (method === 'plugin/installed') return { marketplaces: [{ plugins: [{ id: 'test@local', installed: true, enabled: true }] }] };
      if (method === 'thread/start') return { thread: { id: `thread-${++sequence}` } };
      if (method === 'thread/resume') return { thread: { id: params.threadId } };
      if (method === 'turn/start') return { turn: { id: `turn-${++sequence}` } };
      return {};
    } };
    clients.push({ options, calls, port }); return port;
  } });
  t.after(() => engine.close()); await engine.init();
  const result = await engine.command({ type: 'create_project', root, name: 'fixture', goal: 'free conversation', ...(template ? { template } : {}) });
  const projectId = result.snapshot.selected!.project.id;
  const send = (nodeId: string) => engine.command({ type: 'send_message', projectId, nodeId, mode: 'codex', input: [{ type: 'text', text: 'hello', text_elements: [] }] });
  return { engine, root, projectId, clients, send };
}
