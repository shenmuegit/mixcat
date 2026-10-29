import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { createNativeRuntime, type NativeRuntimeHandle } from '../src/core/native-runtime.js';
import { SharedAccount } from '../src/core/account.js';
import { projectDirectory } from '../src/core/paths.js';
import type { CodexPort, NativeClientOptions } from '../src/shared/types.js';
import { accountFixture } from './account-fixture.js';
import { deferred, until } from './runtime-fixture.js';

test('native runtime retains one failed close promise instead of replaying client close', async () => {
  let closes = 0;
  const runtime = createNativeRuntime({ executable: 'fixture', cwd: resolve('.'), home: resolve('.runtime'), mode: 'codex',
    account: {} as SharedAccount, isCurrent: () => true, onEvent() {}, onRequest() {}, onDisconnect() {}, onStatus() {},
    nativeFactory: () => ({ async connect() {}, async rpc() { return {}; }, async close() { closes++; throw new Error('close failed'); } }),
  });
  await runtime.connect();
  const first = runtime.close(), second = runtime.close();
  assert.equal(first, second);
  await assert.rejects(first, /close failed/);
  await assert.rejects(runtime.close(), /close failed/);
  assert.equal(closes, 1);
});

function host(t: { after(fn: () => Promise<void>): void }, account: SharedAccount, overrides: Partial<CodexPort> = {}) {
  let options!: NativeClientOptions, current = true;
  const replies: { id: string | number; result: any }[] = [], errors: { id: string | number; error: any }[] = [];
  const events: string[] = [], requests: string[] = [];
  let changes = 0, disconnects = 0;
  const runtime = createNativeRuntime({ executable: 'fixture', cwd: resolve('.'), home: resolve('.runtime'), mode: 'codex', account,
    isCurrent: () => current, onEvent: event => { events.push(event.method); }, onRequest: request => { requests.push(request.method); },
    onDisconnect: () => { disconnects++; }, onStatus: () => { changes++; },
    nativeFactory(value) {
      options = value;
      return { async connect() {}, async rpc() { return { account: { email: 'fixture' } }; }, async close() {},
        respond: (id, result) => { replies.push({ id, result }); }, reject: (id, error) => { errors.push({ id, error }); }, ...overrides };
    },
  });
  t.after(() => runtime.close());
  return { runtime, get options() { return options; }, replies, errors, events, requests,
    get changes() { return changes; }, get disconnects() { return disconnects; }, replace() { current = false; } };
}

test('connect callbacks use the registered owner, host time is real, and unsupported requests are rejected and forwarded', async t => {
  let owner: NativeRuntimeHandle | undefined, options!: NativeClientOptions;
  const replies: any[] = [], errors: any[] = [], requests: string[] = [], events: string[] = [];
  const runtime = createNativeRuntime({ executable: 'fixture', cwd: resolve('.'), home: resolve('.runtime'), mode: 'codex', account: {} as SharedAccount,
    isCurrent: () => owner === runtime, onStatus() {}, onDisconnect() {},
    onEvent: event => { assert.equal(owner, runtime); assert.equal(owner.status.connected, false); events.push(event.method); },
    onRequest: request => { requests.push(request.method); },
    nativeFactory(value) {
      options = value;
      return { async connect() { options.onEvent({ method: 'connected-during-connect', params: {} }); options.onRequest!({ id: 1, method: 'currentTime/read', params: {} }); },
        async rpc() { return {}; }, async close() {}, respond: (_id, result) => { replies.push(result); }, reject: (_id, error) => { errors.push(error); } };
    },
  });
  t.after(() => runtime.close());
  owner = runtime;
  const before = Math.floor(Date.now() / 1000);
  await runtime.connect();
  assert.equal(runtime.status.connected, true);
  assert.deepEqual(events, ['connected-during-connect']);
  assert.equal(replies.length, 1);
  assert.ok(replies[0].currentTimeAt >= before && replies[0].currentTimeAt <= Math.floor(Date.now() / 1000));
  options.onRequest!({ id: 2, method: 'item/tool/call', params: {} });
  options.onRequest!({ id: 3, method: 'item/tool/requestUserInput', params: {} });
  assert.equal(errors[0].code, -32601);
  assert.deepEqual(requests, ['item/tool/call', 'item/tool/requestUserInput']);
});

test('two native runtimes share one account refresh and only receive access credentials', async t => {
  const root = mkdtempSync(resolve(projectDirectory(resolve('.'), '.runtime', 'implementation', 'fixtures'), 'native-host-'));
  const fake = accountFixture(), gate = deferred(), entered = deferred();
  let forcedReads = 0;
  const account = new SharedAccount(root, 'fixture', () => {}, options => {
    const port = fake.factory(options), rpc = port.rpc;
    port.rpc = async (method, params) => { if (method === 'account/read' && params.refreshToken) { forcedReads++; entered.resolve(); await gate.promise; } return rpc(method, params); };
    return port;
  });
  t.after(() => account.close());
  const first = host(t, account), second = host(t, account);
  await Promise.all([first.runtime.connect(), second.runtime.connect()]);
  first.options.onRequest!({ id: 'first', method: 'account/chatgptAuthTokens/refresh', params: { previousAccountId: 'test-account' } });
  await entered.promise;
  second.options.onRequest!({ id: 'second', method: 'account/chatgptAuthTokens/refresh', params: {} });
  gate.resolve();
  await until(() => first.replies.length === 1 && second.replies.length === 1);
  assert.equal(forcedReads, 1);
  assert.deepEqual(first.replies[0].result, { accessToken: 'test-access-1', chatgptAccountId: 'test-account', chatgptPlanType: 'plus' });
  assert.deepEqual(second.replies[0].result, first.replies[0].result);
});

for (const fence of ['resolved', 'replaced', 'disconnected', 'closed'] as const) for (const failure of [false, true]) {
  test(`${fence} native refresh ignores late ${failure ? 'failure' : 'success'}`, async t => {
    const release = deferred();
    const account = { async credentials() { await release.promise; if (failure) throw new Error('late error'); return { accessToken: 'access', chatgptAccountId: 'account', chatgptPlanType: null }; } } as SharedAccount;
    const h = host(t, account);
    await h.runtime.connect();
    h.runtime.status.authenticated = true;
    h.options.onRequest!({ id: 'refresh', method: 'account/chatgptAuthTokens/refresh', params: {} });
    if (fence === 'resolved') h.options.onEvent({ method: 'serverRequest/resolved', params: { requestId: 'refresh' } });
    if (fence === 'replaced') h.replace();
    if (fence === 'disconnected') { h.options.onDisconnect('disconnect'); h.options.onDisconnect('duplicate'); assert.equal(h.disconnects, 1); }
    if (fence === 'closed') await h.runtime.close();
    const changes = h.changes;
    release.resolve(); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(h.replies, []); assert.deepEqual(h.errors, []);
    assert.equal(h.changes, changes); assert.equal(h.runtime.status.authenticated, true);
    if (fence === 'resolved') assert.deepEqual(h.events, ['serverRequest/resolved']);
  });
}

test('refresh rejects a changed account but an expired reply does not invalidate authentication', async t => {
  const account = { async credentials() { return { accessToken: 'access', chatgptAccountId: 'current', chatgptPlanType: null }; } } as SharedAccount;
  const h = host(t, account);
  await h.runtime.connect();
  h.options.onRequest!({ id: 'refresh', method: 'account/chatgptAuthTokens/refresh', params: { previousAccountId: 'previous' } });
  await until(() => h.errors.length === 1);
  assert.equal(h.errors[0].error.code, -32000);
  assert.equal(h.runtime.status.authenticated, false);
  const expired = host(t, account, { respond() { throw new Error('request expired'); } });
  await expired.runtime.connect(); expired.runtime.status.authenticated = true;
  expired.options.onRequest!({ id: 'expired', method: 'account/chatgptAuthTokens/refresh', params: {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(expired.runtime.status.authenticated, true); assert.equal(expired.runtime.status.error, null);
  assert.deepEqual(expired.errors, []);
});
