import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SharedAccount } from '../src/core/account.js';
import { projectDirectory } from '../src/core/paths.js';

function fixture(t: TestContext, nativeAccount: object | null = null) {
  const root = mkdtempSync(join(projectDirectory(resolve('.'), '.runtime', 'tests'), 'host-account-'));
  const host = projectDirectory(root, 'host'), file = join(host, 'auth.json'), own = join(root, '.runtime/client/account/auth.json');
  const previous = process.env.MIXCAT_HOST_CODEX_HOME; process.env.MIXCAT_HOST_CODEX_HOME = host;
  t.after(() => { if (previous === undefined) delete process.env.MIXCAT_HOST_CODEX_HOME; else process.env.MIXCAT_HOST_CODEX_HOME = previous; });
  const methods: string[] = [];
  const account = new SharedAccount(root, 'fixture', () => {}, () => ({ async connect() {}, async close() {}, async rpc(method) { methods.push(method); return { account: nativeAccount }; } }));
  t.after(() => account.close());
  return { root, file, own, methods, account };
}

test('existing host Codex login restores and supplies only current access credentials without a new login', async t => {
  const { account, methods, file, own } = fixture(t);
  const original = JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'host-access', account_id: 'host-account', refresh_token: 'host-refresh-secret' } });
  writeFileSync(file, original);
  await account.restore();
  assert.equal(account.status.authenticated, true);
  assert.deepEqual(await account.credentials(), { accessToken: 'host-access', chatgptAccountId: 'host-account', chatgptPlanType: null });
  assert.equal(methods.includes('account/login/start'), false);
  assert.equal(existsSync(own), false); assert.equal(readFileSync(file, 'utf8'), original);
  assert(!JSON.stringify(account.status).includes('host-access'));
  writeFileSync(file, JSON.stringify({ tokens: { access_token: 'updated-access', account_id: 'host-account', refresh_token: 'updated-refresh-secret' } }));
  assert.deepEqual(await account.credentials(true), { accessToken: 'updated-access', chatgptAccountId: 'host-account', chatgptPlanType: null });
  rmSync(file);
  assert.equal(await account.credentials(true), null); assert.equal(account.status.authenticated, false);
});

test('saved Mixcat account stays authoritative when the host has a different account', async t => {
  const { root, account, file, own } = fixture(t, { email: 'own@example.invalid', planType: 'plus' });
  writeFileSync(file, JSON.stringify({ tokens: { access_token: 'other-access', account_id: 'other-account' } }));
  projectDirectory(root, '.runtime', 'client', 'account');
  writeFileSync(own, JSON.stringify({ tokens: { access_token: 'own-access', account_id: 'own-account', refresh_token: 'own-refresh-secret' } }));
  assert.deepEqual(await account.credentials(), { accessToken: 'own-access', chatgptAccountId: 'own-account', chatgptPlanType: 'plus' });
  writeFileSync(own, '{private-broken-own-token');
  await assert.rejects(account.credentials(true), error => /凭据/.test(String(error)) && !String(error).includes('private-broken-own-token'));
  assert.equal(account.status.authenticated, false);
});

test('without either login, restore stays idle and explicit reads return no credentials', async t => {
  const { account, methods, own } = fixture(t);
  await account.restore(); assert.deepEqual(methods, []);
  assert.equal(await account.credentials(), null); assert.equal(account.status.authenticated, false); assert.equal(existsSync(own), false);
});

for (const content of ['{host-private-secret', JSON.stringify({ tokens: { access_token: 'host-private-secret' } })]) test('invalid host credentials fail without exposing their content or claiming login', async t => {
  const { account, file, own } = fixture(t); writeFileSync(file, content);
  await assert.rejects(account.credentials(), error => /凭据/.test(String(error)) && !String(error).includes('host-private-secret'));
  assert.equal(account.status.authenticated, false); assert.equal(existsSync(own), false);
});
