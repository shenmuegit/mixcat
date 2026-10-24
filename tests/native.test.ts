import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { projectDirectory } from '../src/core/paths.js';
import { createCodexClient } from '../src/core/codex.js';
import type { NativeClientOptions, NativeEvent, NativeServerRequest } from '../src/shared/types.js';

const fixtureBase = projectDirectory(process.cwd(), '.runtime', 'implementation', 'native-tests');
mkdirSync(fixtureBase, { recursive: true });
assert(realpathSync(fixtureBase).toLowerCase().startsWith(realpathSync(process.cwd()).toLowerCase() + path.sep));
assert(!/^c:/i.test(realpathSync(fixtureBase)));

function fixture(t: TestContext, onRequest?: NativeClientOptions['onRequest']) {
  const root = mkdtempSync(path.join(fixtureBase, 'case-'));
  writeFileSync(path.join(root, 'app-server'), `
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { lstatSync } from 'node:fs';
const npmPrefixReadyAtStartup = !!lstatSync(process.env.APPDATA + '/npm', { throwIfNoEntry: false })?.isDirectory();
const write = value => process.stdout.write(JSON.stringify(value) + '\\n');
let initialized = false;
const approvals = new Map();
createInterface({input:process.stdin}).on('line', line => {
  const message = JSON.parse(line);
  if (message.id === 'risk-request') {
    write({id:approvals.get('risk-request'),result:message}); return;
  }
  if (message.method === 'initialize') {
    if (!message.params.capabilities.experimentalApi) process.exit(9);
    write({id:message.id,result:{userAgent:'fixture/1',codexHome:process.env.CODEX_HOME}}); return;
  }
  if (message.method === 'initialized') {
    initialized=true; write({method:'thread/started',params:{thread:{id:'fixture-thread'}}}); return;
  }
  if (!initialized) { write({id:message.id,error:{code:-32002,message:'Not initialized'}}); return; }
  if (message.method === 'probe/hang') return;
  if (message.method === 'probe/exit') { process.exit(3); return; }
  if (message.method === 'probe/malformed') { process.stdout.write('not-json\\n'); return; }
  if (message.method === 'probe/error') { write({id:message.id,error:{code:-32602,message:'Invalid request',data:{reason:'fixture'}}}); return; }
  if (message.method === 'probe/hold-pipes') {
    const helper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], { cwd: '..', stdio: ['ignore', 'inherit', 'inherit'], detached: true, windowsHide: true });
    helper.once('spawn', () => write({id:message.id,result:{parentPid:process.pid,helperPid:helper.pid}}));
    return;
  }
  if (message.method === 'probe/approval') {
    approvals.set('risk-request',message.id);
    write({id:'risk-request',method:message.params.method,params:{threadId:'fixture-thread',turnId:'fixture-turn',command:'untrusted'}}); return;
  }
  if (message.method === 'probe/resolve-request') {
    write({method:'serverRequest/resolved',params:{threadId:'fixture-thread',requestId:'risk-request'}});
    write({id:message.id,result:{}}); return;
  }
  if (message.method === 'probe/environment') {
    write({id:message.id,result:{cwd:process.cwd(),argv:process.argv.slice(2),home:process.env.CODEX_HOME,temp:process.env.TEMP,tmp:process.env.TMP,cache:process.env.XDG_CACHE_HOME,profile:process.env.USERPROFILE,appdata:process.env.APPDATA,npmPrefixReadyAtStartup,apiKeyPresent:!!process.env.OPENAI_API_KEY}}); return;
  }
  if (message.method === 'probe/network-environment') {
    write({id:message.id,result:{proxiesMatch:Object.entries(message.params.proxies).every(([key,value]) => process.env[key] === value),bypassPreserved:['NO_PROXY','no_proxy'].every(key => message.params.bypass.every(host => (process.env[key] ?? '').split(',').includes(host))),apiKeyPresent:!!process.env.OPENAI_API_KEY}}); return;
  }
  write({id:message.id,result:{method:message.method,params:message.params}});
});
`);
  const events: NativeEvent[] = [];
  const disconnects: string[] = [];
  const client = createCodexClient({ executable: process.execPath, cwd: root, home: path.join(root, 'native-home'), onEvent: event => events.push(event), onDisconnect: error => disconnects.push(error), onRequest });
  t.after(async () => { await client.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, client, events, disconnects };
}

test('runtime info uses the launched binary, version and initialize reply and returns a defensive copy', async t => {
  const { client, root } = fixture(t);
  assert.deepEqual(client.info!(), { executable: null, version: null, initialize: null });
  await client.connect();
  const info = client.info!();
  assert.equal(info.executable, realpathSync(process.execPath));
  assert.equal(info.version, process.versions.node);
  assert.deepEqual(info.initialize, { userAgent: 'fixture/1', codexHome: path.join(root, 'native-home') });
  info.initialize!.userAgent = 'modified';
  assert.equal(client.info!().initialize!.userAgent, 'fixture/1');
});

test('native process initializes, keeps runtime paths inside its project and passes account RPCs through', async t => {
  const { client, root, events } = fixture(t);
  await client.connect();
  const runtime = await client.rpc('probe/environment', {});
  assert.deepEqual(runtime.argv, ['--listen', 'stdio://', '-c', 'cli_auth_credentials_store="file"']);
  assert.equal(runtime.cwd, root);
  for (const field of ['home', 'temp', 'tmp', 'cache', 'profile']) assert(runtime[field].startsWith(root + path.sep));
  assert.equal(runtime.apiKeyPresent, false);
  assert.deepEqual(await client.rpc('account/read', { refreshToken: false }), { method: 'account/read', params: { refreshToken: false } });
  assert(events.some(event => event.method === 'thread/started'));
});

test('Windows native environment creates npm standard isolated APPDATA prefix before subprocess startup', { skip: process.platform !== 'win32' }, async t => {
  const { client, root } = fixture(t); await client.connect();
  const runtime = await client.rpc('probe/environment', {});
  assert.equal(runtime.appdata, path.join(root, 'native-home', 'appdata'));
  assert.equal(runtime.npmPrefixReadyAtStartup, true);
  assert(statSync(path.join(runtime.appdata, 'npm')).isDirectory());
  for (const field of ['home', 'temp', 'tmp', 'cache', 'profile', 'appdata']) assert(runtime[field].startsWith(root + path.sep));
});

test('native inherits configured proxies while keeping loopback direct and host credentials isolated', async t => {
  const proxyKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'];
  const saved = Object.fromEntries([...proxyKeys, 'OPENAI_API_KEY'].map(key => [key, process.env[key]]));
  try {
    for (const lowercase of [false, true]) {
      for (const key of proxyKeys) delete process.env[key];
      const proxies = Object.fromEntries(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'].map(key => [lowercase ? key.toLowerCase() : key, 'http://mixcat-proxy.invalid:3128']));
      Object.assign(process.env, proxies);
      process.env[lowercase ? 'no_proxy' : 'NO_PROXY'] = 'existing.example.test,other.example.test';
      process.env.OPENAI_API_KEY = 'mixcat-fixture-key';
      const { client } = fixture(t);
      await client.connect();
      assert.deepEqual(await client.rpc('probe/network-environment', { proxies, bypass: ['existing.example.test', 'other.example.test', '127.0.0.1', 'localhost', '::1'] }), { proxiesMatch: true, bypassPreserved: true, apiKeyPresent: false });
      await client.close();
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('native requests distinguish never sent from an uncertain timeout', async t => {
  const { client } = fixture(t);
  await assert.rejects(client.rpc('turn/start', {}), { outcome: 'not-sent' });
  await client.connect();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = client.rpc('probe/hang', {});
  const rejected = assert.rejects(pending, { outcome: 'unknown' });
  t.mock.timers.tick(30_000);
  await rejected;
  t.mock.timers.reset();
});

test('native disconnect drains pending requests and rejects later dispatch as not sent', async t => {
  const { client, disconnects } = fixture(t);
  await client.connect();
  await assert.rejects(client.rpc('probe/exit', {}), { outcome: 'unknown' });
  await assert.rejects(client.rpc('turn/start', {}), { outcome: 'not-sent' });
  assert.equal(disconnects.length, 1);
});

test('native close drains outstanding requests without fabricating a successful result', async t => {
  const { client, disconnects } = fixture(t);
  await client.connect();
  const rejected = assert.rejects(client.rpc('probe/hang', {}), { outcome: 'unknown' });
  await client.close();
  await rejected;
  await assert.rejects(client.rpc('turn/start', {}), { outcome: 'not-sent' });
  assert.deepEqual(disconnects, []);
});

test('native close confirms the direct child exit without waiting for inherited pipes held by descendants', async t => {
  const { client } = fixture(t);
  await client.connect();
  const { parentPid, helperPid } = await client.rpc('probe/hold-pipes', {});
  const closed = client.close();
  try {
    await Promise.race([closed, delay(1500, undefined, { ref: false }).then(() => assert.fail('Native close waited for the descendant-held stdio'))]);
    assert.throws(() => process.kill(parentPid, 0), { code: 'ESRCH' });
    assert.doesNotThrow(() => process.kill(helperPid, 0), 'Closing the client must not claim or kill an unowned descendant');
  } finally {
    try { process.kill(helperPid); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    await closed;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { process.kill(helperPid, 0); } catch { break; }
      await delay(10);
    }
  }
});

test('native server approvals are visible but never automatically approved', async t => {
  const { client, events } = fixture(t);
  await client.connect();
  for (const method of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval']) {
    const response = await client.rpc('probe/approval', { method });
    assert.equal(response.result.decision, 'decline');
    assert(events.some(event => event.method === method));
  }
  const elicitation = await client.rpc('probe/approval', { method: 'mcpServer/elicitation/request' });
  assert.equal(elicitation.result.action, 'cancel');
  const permission = await client.rpc('probe/approval', { method: 'item/permissions/requestApproval' });
  assert.deepEqual(permission.result.permissions, {});
  const unsupported = await client.rpc('probe/approval', { method: 'account/chatgptAuthTokens/refresh' });
  assert.equal(unsupported.error.code, -32601);
});

test('native errors preserve the server rejection and malformed output closes the connection', async t => {
  const { client, disconnects } = fixture(t);
  await client.connect();
  await assert.rejects(client.rpc('probe/error', {}), { message: 'Invalid request', code: -32602 });
  await assert.rejects(client.rpc('probe/malformed', {}), { outcome: 'unknown' });
  assert.equal(disconnects.length, 1);
});

test('native forwards server requests and answers only a real pending request once', { timeout: 5000 }, async t => {
  let receive!: (request: NativeServerRequest) => void;
  const { client } = fixture(t, request => receive(request));
  await client.connect();
  for (const method of ['item/commandExecution/requestApproval', 'item/tool/requestUserInput', 'item/tool/call']) {
    const request = new Promise<NativeServerRequest>(resolve => { receive = resolve; });
    const response = client.rpc('probe/approval', { method });
    const incoming = await request;
    assert.equal(incoming.method, method); assert.equal(incoming.params.threadId, 'fixture-thread');
    assert.throws(() => client.respond!('not-requested', {}), /pending/i);
    assert.throws(() => client.respond!(incoming.id, undefined), /result/i);
    const answer = method.endsWith('requestApproval') ? { decision: 'accept' } : { answers: { choice: { answers: ['Selected'] } } };
    client.respond!(incoming.id, answer);
    assert.deepEqual((await response).result, answer);
    assert.throws(() => client.respond!(incoming.id, answer), /pending/i);
  }
});

test('native rejects late answers after a request is resolved or the connection closes', { timeout: 5000 }, async t => {
  let receive!: (request: NativeServerRequest) => void;
  const { client } = fixture(t, request => receive(request));
  await client.connect();
  let received = new Promise<NativeServerRequest>(resolve => { receive = resolve; });
  const first = client.rpc('probe/approval', { method: 'item/tool/requestUserInput' });
  const firstRejected = assert.rejects(first, { outcome: 'unknown' });
  const firstRequest = await received;
  await client.rpc('probe/resolve-request', {});
  assert.throws(() => client.respond!(firstRequest.id, {}), /pending/i);
  received = new Promise<NativeServerRequest>(resolve => { receive = resolve; });
  const second = client.rpc('probe/approval', { method: 'item/tool/requestUserInput' });
  const secondRejected = assert.rejects(second, { outcome: 'unknown' });
  const secondRequest = await received;
  await client.close();
  assert.throws(() => client.respond!(secondRequest.id, {}), /pending|connected/i);
  await Promise.all([firstRejected, secondRejected]);
});
test('native protocol errors answer a real pending host request once without a fabricated result', async t => {
  let receive!: (request: NativeServerRequest) => void;
  const { client } = fixture(t, request => receive(request)); await client.connect();
  const incoming = new Promise<NativeServerRequest>(resolve => { receive = resolve; });
  const response = client.rpc('probe/approval', { method: 'item/tool/call' });
  const request = await incoming;
  client.reject!(request.id, { code: -32601, message: 'Host adapter unavailable' });
  const answer = await response;
  assert.deepEqual(answer.error, { code: -32601, message: 'Host adapter unavailable' });
  assert.equal('result' in answer, false);
  assert.throws(() => client.reject!(request.id, { code: -32601, message: 'again' }), /pending/);
});

test('native disconnects cleanly when its server request handler fails', async t => {
  const { client, disconnects } = fixture(t, () => { throw new Error('Fixture handler failure'); });
  await client.connect();
  await assert.rejects(client.rpc('probe/approval', { method: 'item/tool/call' }), { outcome: 'unknown' });
  assert.equal(disconnects.length, 1);
  assert.throws(() => client.respond!('risk-request', {}), /pending/i);
});

test('native refuses project-external homes and junctions before creating runtime data', async t => {
  const { root } = fixture(t);
  const options = { executable: process.execPath, cwd: root, home: path.join(fixtureBase, 'outside'), onEvent() {}, onDisconnect() {} };
  await assert.rejects(createCodexClient(options).connect(), /inside.*project/i);
  await assert.rejects(createCodexClient({ ...options, home: 'C:\\forbidden-mixcat-home' }).connect(), /C:|inside.*project/i);
  const target = path.join(root, 'junction-target');
  mkdirSync(target);
  const junction = path.join(root, 'junction');
  symlinkSync(target, junction, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createCodexClient({ ...options, home: path.join(junction, 'home') }).connect(), /link|junction|reparse/i);
  const nestedHome = path.join(root, 'existing-home');
  mkdirSync(nestedHome);
  symlinkSync(target, path.join(nestedHome, '.tmp'), process.platform === 'win32' ? 'junction' : 'dir');
  const nestedClient = createCodexClient({ ...options, home: nestedHome });
  try { await assert.rejects(nestedClient.connect(), /link|junction|reparse/i); }
  finally { await nestedClient.close(); }
});
