// Copied as the configured Node executable's app-server script into each isolated cwd.
import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { request as httpRequest } from 'node:http';

let root = process.cwd();
while (!existsSync(join(root, 'feed-fixture.json'))) { const parent = dirname(root); assert.notEqual(parent, root, 'Missing isolated fixture marker'); root = parent; }
const collectionId = process.cwd() === root ? 'account' : basename(dirname(process.cwd()));
const statePath = join(root, `native-${collectionId}.json`);
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { threadId: `thread_${collectionId}`, turns: [] };
let config, savedGoal, sequence = 0, active, approval;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const log = (event, details = {}) => appendFileSync(join(root, 'protocol.jsonl'), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, collectionId, event, ...details }) + '\n');
const persist = () => writeFileSync(statePath, JSON.stringify(state));
const notify = (method, params) => send({ method, params });
const wait = async predicate => { for (let n = 0; n < 6000; n++) { if (await predicate()) return; await new Promise(done => setTimeout(done, 50)); } throw Error('Native fixture gate timed out'); };
function finish(turn, status) { if (turn.status !== 'inProgress') return; turn.status = status; persist(); notify('turn/completed', { threadId: state.threadId, turn }); log('turn/completed', { threadId: state.threadId, turnId: turn.id, status }); }
async function call(name, args, turn, discard = false) {
  const payload = JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method: 'tools/call', params: { name, arguments: args, _meta: { threadId: state.threadId, callId: `fixture_call_${sequence}`, 'x-codex-turn-metadata': { turn_id: turn.id } } } });
  return new Promise((resolve, reject) => {
    const request = httpRequest(config.url, { method: 'POST', agent: false, headers: { ...config.http_headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' } }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(Error(`MCP HTTP ${response.statusCode}`)); return; }
      if (discard) { response.destroy(); log('save_reply_discarded', { requestId: args.requestId, turnId: turn.id }); resolve(); return; }
      let body = ''; response.on('data', data => body += data); response.on('error', reject);
      response.on('end', () => { try { const reply = JSON.parse(body); assert.ok(!reply.error && !reply.result?.isError, body); resolve(JSON.parse(reply.result.content[0].text)); } catch (error) { reject(error); } });
    });
    request.on('error', reject); request.setTimeout(10000, () => request.destroy(Error('MCP timeout'))); request.end(payload);
  });
}
async function execute(turn) {
  log('turn_ready', { threadId: state.threadId, turnId: turn.id });
  await wait(() => turn.status !== 'inProgress' || existsSync(join(root, `release-${collectionId}-${state.turns.indexOf(turn) + 1}`)));
  if (turn.status !== 'inProgress') return;
  const setup = JSON.parse(readFileSync(join(root, 'feed-fixture.json'), 'utf8'));
  const index = state.turns.indexOf(turn);
  if (setup.primary === collectionId && [0, 2, 3].includes(index)) {
    const due = new Date(Date.now() + 120000);
    const goal = { name: savedGoal.name, objective: index === 3 ? '关注公开技术动态，当前暂停' : '每天关注公开技术动态', expectedRevision: savedGoal.expectedRevision - (index === 2 ? 1 : 0), requestId: `fixture-goal-${turn.id}`, schedule: index === 3 ? { ...savedGoal.schedule, enabled: false } : { frequency: 'daily', enabled: true, time: due.toISOString().slice(11, 16), timeZone: 'UTC' } };
    writeFileSync(join(process.cwd(), 'goal.json'), JSON.stringify(goal)); log('goal_written', { turnId: turn.id, goal });
  }
  if (setup.primary === collectionId && index === 1) {
    const args = { requestId: 'ipc-save-1', title: 'Controlled IPC result', body: 'Controlled public text sample.\n\n**定时结果完整正文**\n\n只属于执行结果区的最后一段。', coverage: 'full', sourceUrl: 'https://example.com/fixture' };
    await call('save_feed_result', args, turn, true);
    const receipt = await call('save_feed_result', args, turn);
    assert.equal(receipt.accepted, true); assert.equal(receipt.outcome, 'new'); log('save_receipt', { threadId: state.threadId, turnId: turn.id, receipt });
    const item = { id: `item_${turn.id}`, type: 'agentMessage', text: 'Controlled result saved with an accepted receipt.' };
    turn.items.push(item); persist(); notify('item/started', { threadId: state.threadId, turnId: turn.id, item }); notify('item/completed', { threadId: state.threadId, turnId: turn.id, item });
  }
  if (setup.secondary === collectionId && state.turns.indexOf(turn) === 0) {
    const requestId = `approval_${turn.id}`;
    approval = { requestId, turnId: turn.id, responded: false };
    send({ id: requestId, method: 'item/commandExecution/requestApproval', params: { threadId: state.threadId, turnId: turn.id, itemId: `command_${turn.id}`, command: 'echo controlled-fixture', reason: 'Controlled native request integration' } });
    log('approval_requested', { threadId: state.threadId, turnId: turn.id, requestId });
    await wait(() => approval.responded || turn.status !== 'inProgress');
    return; // Held until the real stop command supplies turn/interrupt.
  }
  finish(turn, 'completed');
}
async function handle(request) {
  if (request.method === undefined && request.id === approval?.requestId) {
    assert.deepEqual(request.result, { decision: 'accept' }); approval.responded = true;
    log('approval_response', { requestId: request.id, result: request.result }); notify('serverRequest/resolved', { threadId: state.threadId, requestId: request.id }); return;
  }
  if (request.id === undefined) return;
  let result = {};
  switch (request.method) {
    case 'initialize': result = { userAgent: 'mixcat-feed-ipc-fixture', codexHome: process.env.CODEX_HOME }; break;
    case 'account/read':
      if (collectionId === 'account') writeFileSync(join(process.env.CODEX_HOME, 'auth.json'), JSON.stringify({ tokens: { access_token: 'fixture-access', account_id: 'fixture-account', refresh_token: 'fixture-refresh' } }));
      result = { account: { type: 'chatgpt', email: 'fixture@example.invalid', planType: 'plus' } }; break;
    case 'account/login/start': result = { type: 'chatgptAuthTokens' }; break;
    case 'model/list': result = { data: [{ model: 'fixture-model', displayName: 'Fixture', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '' }] }], nextCursor: null }; break;
    case 'skills/list': case 'hooks/list': result = { data: [] }; break;
    case 'plugin/installed': case 'plugin/list': result = { marketplaces: [], marketplaceLoadErrors: [] }; break;
    case 'mcpServerStatus/list': result = { data: [{ name: 'mixcat_feed', tools: { save_feed_result: {} }, runtimeStatus: 'ready' }], nextCursor: null }; break;
    case 'windowsSandbox/readiness': result = { status: 'notConfigured' }; break;
    case 'thread/start': case 'thread/resume':
      if (request.method === 'thread/resume') assert.equal(request.params.threadId, state.threadId);
      config = request.params.config.mcp_servers.mixcat_feed;
      result = { thread: { id: state.threadId }, model: 'fixture-model', sandbox: { type: 'workspaceWrite' }, approvalPolicy: 'on-request' };
      log(request.method, { threadId: state.threadId }); break;
    case 'turn/start':
      const context = request.params.input.find(item => item.type === 'text' && item.text.includes('<mixcat_current_goal>'));
      savedGoal = JSON.parse(context.text.match(/<mixcat_current_goal>([\s\S]*?)<\/mixcat_current_goal>/)[1]);
      assert.equal(typeof savedGoal.expectedRevision, 'number');
      active = { id: `turn_${collectionId}_${state.turns.length + 1}`, status: 'inProgress', items: [] }; state.turns.push(active); persist();
      log('turn/start', { threadId: state.threadId, turnId: active.id, input: request.params.input }); send({ id: request.id, result: { turn: { id: active.id } } });
      notify('turn/started', { threadId: state.threadId, turn: { id: active.id } }); void execute(active).catch(fail); return;
    case 'turn/interrupt': send({ id: request.id, result: {} }); finish(active, 'interrupted'); return;
    case 'thread/read': result = { thread: { id: state.threadId, turns: state.turns } }; break;
    case 'thread/items/list': result = { data: state.turns.flatMap(turn => turn.items.map(item => ({ turnId: turn.id, item, startedAtMs: 1, completedAtMs: 2 }))), nextCursor: null }; break;
    case 'thread/unsubscribe': break;
    default: throw Error(`Unsupported fixture method ${request.method}`);
  }
  send({ id: request.id, result });
}
function fail(error) { log('fixture_error', { message: String(error), stack: error.stack }); process.exitCode = 1; process.stdin.destroy(); }
log('process_started');
createInterface({ input: process.stdin }).on('line', line => { try { void handle(JSON.parse(line)).catch(fail); } catch (error) { fail(error); } });
