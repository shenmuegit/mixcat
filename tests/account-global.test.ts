import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WorkflowEngine } from '../src/core/engine.js';
import { SharedAccount } from '../src/core/account.js';
import { projectDirectory } from '../src/core/paths.js';
import { accountFixture } from './account-fixture.js';
import type { NativeClientOptions } from '../src/shared/types.js';
import { fixture, deferred, until } from './runtime-fixture.js';

for (const staleResult of ['logged-out', 'error'] as const) test(`login notification supersedes an earlier ${staleResult} account lookup`, async t => {
  const root = mkdtempSync(join(projectDirectory(resolve('.'), '.runtime', 'implementation', 'fixtures'), 'login-notification-'));
  const fake = accountFixture(); fake.authenticated = false;
  const entered = deferred(), release = deferred(); let reads = 0;
  const account = new SharedAccount(root, 'fixture', () => {}, options => {
    const client = fake.factory(options), original = client.rpc;
    client.rpc = async (method, params) => {
      if (method === 'account/read' && ++reads === 1) {
        entered.resolve(); await release.promise;
        if (staleResult === 'error') throw new Error('stale account read failed');
        return { account: null };
      }
      return original(method, params);
    }; return client;
  });
  t.after(() => account.close());
  const checking = account.connect().catch(error => error);
  await entered.promise; fake.authenticated = true;
  fake.options.onEvent({ method: 'account/login/completed', params: { success: true, loginId: 'test-login' } });
  release.resolve(); await checking;
  await until(() => account.status.authenticated);
  assert.ok(reads >= 2); assert.equal(account.status.error, null);
});

test('startup restores only this client saved login without running project sessions', async t => {
  const root = mkdtempSync(join(projectDirectory(resolve('.'), '.runtime', 'implementation', 'fixtures'), 'login-restore-'));
  const home = projectDirectory(root, '.runtime', 'client', 'account');
  writeFileSync(join(home, 'auth.json'), JSON.stringify({ tokens: { access_token: 'test-saved', account_id: 'test-account' } }));
  const fake = accountFixture();
  const engine = new WorkflowEngine({ workbenchRoot: root, executable: 'fixture', accountFactory: fake.factory, nativeFactory() { assert.fail('must not start a project session'); } });
  t.after(() => engine.close()); await engine.init();
  await (engine as any).restoreAccount();
  const snapshot = (await engine.command({ type: 'snapshot' })).snapshot;
  assert.equal(snapshot.account!.authenticated, true); assert.equal(snapshot.selected, null);
  assert.equal(fake.calls.some(call => call.method === 'account/login/start' || call.method === 'thread/start' || call.method === 'turn/start'), false);
});

test('startup without a saved login stays idle until the user logs in', async t => {
  const root = mkdtempSync(join(projectDirectory(resolve('.'), '.runtime', 'implementation', 'fixtures'), 'no-login-restore-'));
  const engine = new WorkflowEngine({ workbenchRoot: root, executable: 'fixture', accountFactory() { assert.fail('no background connection without saved auth'); } });
  t.after(() => engine.close()); await engine.init(); await (engine as any).restoreAccount();
  assert.equal((await engine.command({ type: 'snapshot' })).snapshot.account!.authenticated, false);
});

test('settings login works before creating a project and exposes no credentials', async t => {
  const root = mkdtempSync(join(projectDirectory(resolve('.'), '.runtime', 'implementation', 'fixtures'), 'global-account-'));
  const account = accountFixture(); account.authenticated = false;
  const engine = new WorkflowEngine({ workbenchRoot: root, executable: 'unused', accountFactory: account.factory } as any);
  t.after(() => engine.close()); await engine.init();
  const login = await engine.command({ type: 'login' } as any);
  assert.equal(login.snapshot.account!.connected, true);
  assert.equal(login.snapshot.account!.authenticated, false);
  assert.equal(login.authUrl, 'https://auth.openai.com/test-login');
  assert.equal(login.snapshot.selected, null);
  assert.equal(account.options.cwd, root);
  assert.equal(account.options.home, join(root, '.runtime', 'client', 'account'));
  assert.doesNotMatch(JSON.stringify(login.snapshot), /test-access|test-refresh/);
});

test('projects share central account access only and refresh through its native owner', async t => {
  const root = mkdtempSync(join(projectDirectory(resolve('.'), '.runtime', 'implementation', 'fixtures'), 'shared-account-'));
  const account = accountFixture();
  const projects: { options: NativeClientOptions; calls: { method: string; params: any }[]; responses: any[] }[] = [];
  const engine = new WorkflowEngine({ workbenchRoot: root, executable: 'unused', accountFactory: account.factory,
    nativeFactory(options: NativeClientOptions) {
      const calls: any[] = [], responses: any[] = []; projects.push({ options, calls, responses });
      return { async connect() {}, async close() {}, respond(id: string | number, result: unknown) { responses.push({ id, result }); }, reject() {}, async rpc(method: string, params: any) {
        calls.push({ method, params });
        if (method === 'account/read') return { account: { email: 'shared@example.invalid' } };
        return {};
      } };
    } } as any);
  t.after(() => engine.close()); await engine.init();
  for (const name of ['first', 'second']) {
    const projectRoot = projectDirectory(root, name);
    const id = (await engine.command({ type: 'create_project', root: projectRoot, name, goal: 'isolation' })).snapshot.selected!.project.id;
    await engine.command({ type: 'connect', projectId: id });
    assert.equal(projects.at(-1)!.options.cwd, projectRoot);
    assert.equal(projects.at(-1)!.options.home, join(projectRoot, '.mixcat', 'codex'));
  }
  assert.equal(account.calls.filter(call => call.method === 'account/read').length, 2);
  for (const project of projects) {
    assert.deepEqual(project.calls.find(call => call.method === 'account/login/start')?.params, { type: 'chatgptAuthTokens', accessToken: 'test-access-0', chatgptAccountId: 'test-account', chatgptPlanType: 'plus' });
    assert.doesNotMatch(JSON.stringify(project.calls), /test-refresh-never-forwarded/);
  }
  projects[0].options.onRequest!({ id: 'refresh', method: 'account/chatgptAuthTokens/refresh', params: { reason: 'unauthorized', previousAccountId: 'test-account' } });
  for (let i = 0; i < 100 && !projects[0].responses.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(projects[0].responses[0], { id: 'refresh', result: { accessToken: 'test-access-1', chatgptAccountId: 'test-account', chatgptPlanType: 'plus' } });
  const snapshot = (await engine.command({ type: 'snapshot' })).snapshot;
  assert.doesNotMatch(JSON.stringify(snapshot), /test-access|test-refresh/);
});

test('malformed central credential errors never quote credential content', async t => {
  const root = mkdtempSync(join(projectDirectory(resolve('.'), '.runtime', 'implementation', 'fixtures'), 'bad-account-'));
  const account = accountFixture();
  const engine = new WorkflowEngine({ workbenchRoot: root, executable: 'unused', accountFactory: account.factory } as any);
  t.after(() => engine.close()); await engine.init(); await engine.command({ type: 'connect_account' } as any);
  const file = join(account.options.home, 'auth.json');
  assert.ok(readFileSync(file, 'utf8').includes('test-access'));
  writeFileSync(file, '{test-secret-malformed');
  await assert.rejects(engine.command({ type: 'connect_account' }), error => !String(error).includes('test-secret-malformed') && /凭据/.test(String(error)));
});

test('paused turn rebinds the current shared account before resuming', async t => {
  const f = await fixture(t); await f.send('plan');
  const state = (f.engine as any).states.get(f.projectId), client = f.clients[0];
  await until(() => !!state.tasks[0].turnId); const task = state.tasks[0];
  await f.engine.command({ type: 'pause_node', projectId: f.projectId, nodeId: 'plan' });
  client.options.onEvent({ method: 'turn/completed', params: { threadId: task.threadId, turn: { id: task.turnId, status: 'interrupted' } } });
  writeFileSync(join(f.root, '.runtime/client/account/auth.json'), JSON.stringify({ tokens: { access_token: 'test-replacement', account_id: 'test-current-account' } }));
  await f.engine.command({ type: 'connect_account' });
  await f.engine.command({ type: 'resume_node', projectId: f.projectId, nodeId: 'plan' });
  await until(() => client.calls.filter(call => call.method === 'turn/start').length === 2);
  assert.equal(client.calls.filter(call => call.method === 'account/login/start').at(-1)!.params.chatgptAccountId, 'test-current-account');
});

test('withdrawn native refresh request cannot respond late or mark shared auth invalid', async t => {
  const f = await fixture(t); await f.engine.command({ type: 'connect', projectId: f.projectId });
  const owner = f.engine as any, client = f.clients[0], entered = deferred(), gate = deferred();
  owner.account.credentials = async () => { entered.resolve(); await gate.promise; return { accessToken: 'test-refresh', chatgptAccountId: 'test-account', chatgptPlanType: 'plus' }; };
  let deliveries = 0;
  client.port.respond = client.port.reject = () => { deliveries++; throw Error('This Codex server request is no longer pending'); };
  client.options.onRequest!({ id: 'withdrawn-refresh', method: 'account/chatgptAuthTokens/refresh', params: { reason: 'unauthorized', previousAccountId: 'test-account' } });
  await entered.promise;
  client.options.onEvent({ method: 'serverRequest/resolved', params: { requestId: 'withdrawn-refresh' } });
  gate.resolve(); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(deliveries, 0);
  assert.equal((await f.engine.command({ type: 'snapshot' })).snapshot.runtime!.error, null);
});
