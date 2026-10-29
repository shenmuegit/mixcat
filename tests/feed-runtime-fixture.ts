import { mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { projectDirectory } from '../src/core/paths.js';
import { FeedStore } from '../src/core/feed-store.js';
import { FeedEngine } from '../src/core/feed-runtime.js';
import type { SharedAccount } from '../src/core/account.js';
import type { NativeClientOptions } from '../src/shared/types.js';
export async function feedFixture(t: { after(fn: () => Promise<void>): void }, intercept?: (method: string, params: any, options: NativeClientOptions) => any) {
  const root = mkdtempSync(resolve(projectDirectory(process.cwd(), '.runtime', 'tests'), 'feed-native-'));
  const clients: { options: NativeClientOptions; calls: { method: string; params: any }[]; replies: any[] }[] = [];
  let thread = 0, turn = 0;
  const account = { credentials: async () => ({ accessToken: 'fixture', chatgptAccountId: 'fixture', chatgptPlanType: null }) } as SharedAccount;
  const engine = new FeedEngine({ store: new FeedStore(root), account, executable: 'fixture', nativeFactory(options) {
    const calls: { method: string; params: any }[] = [], replies: any[] = []; clients.push({ options, calls, replies });
    return { async connect() { await intercept?.('fixture/connect', {}, options); }, async close() { await intercept?.('fixture/close', {}, options); }, respond(id, result) { replies.push({ id, result }); }, reject(id, error) { replies.push({ id, error }); }, async rpc(method, params) {
      calls.push({ method, params }); const custom = await intercept?.(method, params, options); if (custom !== undefined) return custom;
      if (method === 'account/read') return { account: { email: 'fixture' } };
      if (method === 'model/list') return { data: [{ model: 'fixture-model', displayName: 'Fixture', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '' }] }], nextCursor: null };
      if (method === 'skills/list' || method === 'hooks/list') return { data: [] };
      if (method === 'plugin/installed' || method === 'plugin/list') return { marketplaces: [], marketplaceLoadErrors: [] };
      if (method === 'mcpServerStatus/list') return { data: [], nextCursor: null };
      if (method === 'windowsSandbox/readiness') return { status: 'notConfigured' };
      if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: params.threadId ?? `thread-${++thread}` }, model: 'fixture-model', sandbox: { type: 'workspaceWrite' }, approvalPolicy: 'on-request' };
      if (method === 'turn/start') { const id = `turn-${++turn}`; options.onEvent({ method: 'turn/started', params: { threadId: params.threadId, turn: { id } } }); return { turn: { id } }; }
      if (method === 'thread/items/list') return { data: [], nextCursor: null };
      return {};
    } };
  } });
  await engine.init(); t.after(() => engine.close());
  const create = (name: string) => engine.command({ type: 'create_feed_collection', name, instruction: 'Collect verified text', requestId: `create-${name}`, input: { text: name } });
  return { root, engine, clients, create };
}
