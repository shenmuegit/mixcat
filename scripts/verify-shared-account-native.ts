import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createCodexClient } from '../src/core/codex.js';
import { insideProject, projectDirectory } from '../src/core/paths.js';

const root = resolve('.');
const base = projectDirectory(root, '.runtime', 'implementation');
const directory = mkdtempSync(insideProject(root, join(base, 'shared-account-native-')));
const home = projectDirectory(directory, 'codex');
const executable = process.env.MIXCAT_CODEX ?? JSON.parse(readFileSync(join(base, 'task-7-protocol', 'metadata.json'), 'utf8')).executable;
const client = createCodexClient({ executable, cwd: directory, home, onEvent() {}, onDisconnect() {}, onRequest(request) { client.reject?.(request.id, { code: -32601, message: 'No project execution in this synthetic authentication probe.' }); } });
const jwt = (claims: object) => [Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url'), Buffer.from(JSON.stringify(claims)).toString('base64url'), 'fixture-not-a-signature'].join('.');
try {
  await client.connect();
  const response = await client.rpc('account/login/start', { type: 'chatgptAuthTokens', chatgptAccountId: 'mixcat-synthetic-account', chatgptPlanType: 'plus', accessToken: jwt({ exp: Math.floor(Date.now() / 1000) + 600, email: 'synthetic@example.invalid', scope: 'openid profile email offline_access', 'https://api.openai.com/auth': { chatgpt_account_id: 'mixcat-synthetic-account', chatgpt_plan_type: 'plus' } }) });
  assert.equal(response.type, 'chatgptAuthTokens');
  assert.equal(existsSync(join(home, 'auth.json')), false, 'external access tokens must not create a project credential file');
  const evidence = { native: client.info?.(), externalLoginAccepted: true, projectCredentialFileCreated: false, syntheticCredentialsOnly: true, modelOrBackendExecution: false };
  writeFileSync(insideProject(root, join(directory, 'result.json')), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ directory, ...evidence }, null, 2));
} finally { await client.close(); }
