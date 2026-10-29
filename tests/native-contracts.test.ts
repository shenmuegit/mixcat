import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { classifyNativeRequest, nativeApprovalDecisions } from '../src/shared/native-requests.js';
import { validateNativeResponse } from '../src/core/native-responses.js';
import { NativeRequestCard } from '../src/renderer/NativeRequests.js';
import { fixture, until } from './runtime-fixture.js';

const request = (method: string, params: any = {}) => ({ id: 'request', method, params });
test('pure native classification separates user decisions, actual host time and unsupported execution', () => {
  assert.equal(classifyNativeRequest(request('item/tool/call')), 'unsupported');
  assert.equal(classifyNativeRequest(request('currentTime/read')), 'host-time');
  assert.equal(classifyNativeRequest(request('mcpServer/elicitation/request', { mode: 'url' })), 'elicitation-url');
  assert.equal(classifyNativeRequest(request('mcpServer/elicitation/request', { mode: 'openai/form' })), 'elicitation-form');
  assert.equal(classifyNativeRequest(request('mcpServer/elicitation/request', { mode: 'openai/userVerification' })), 'unsupported');
});
test('native approvals use exact supplied decisions including structured values and explicit compatibility', () => {
  const rule = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['git', 'status'] } };
  const approval = request('item/commandExecution/requestApproval', { availableDecisions: ['decline', rule] });
  assert.deepEqual(nativeApprovalDecisions(approval), ['decline', rule]);
  validateNativeResponse(approval, { decision: structuredClone(rule) });
  assert.throws(() => validateNativeResponse(approval, { decision: 'accept' }));
  assert.throws(() => validateNativeResponse(approval, { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['git'] } } }));
  assert.deepEqual(nativeApprovalDecisions(request('item/fileChange/requestApproval', { availableDecisions: [] })), []);
  const current = request('item/commandExecution/requestApproval', { proposedExecpolicyAmendment: ['echo'] });
  assert(nativeApprovalDecisions(current).some(value => typeof value === 'object'));
  validateNativeResponse(current, { decision: 'acceptForSession' });
  assert.throws(() => validateNativeResponse(current, { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['rm'] } } }));
  validateNativeResponse(request('execCommandApproval'), { decision: 'approved' });
  assert.throws(() => validateNativeResponse(request('execCommandApproval'), { decision: 'accept' }));
});
test('native answers use every actual question ID and reject invented IDs and invalid answer shapes', () => {
  const question = request('item/tool/requestUserInput', { questions: [{ id: 'actual' }] });
  validateNativeResponse(question, { answers: { actual: { answers: ['free text'] } } });
  validateNativeResponse(question, { answers: {} }); // Empty response is the protocol cancellation form.
  for (const answers of [{ invented: { answers: ['x'] } }, { actual: { answers: [1] } }, { actual: {} }]) assert.throws(() => validateNativeResponse(question, { answers }));
});
test('native permission grants remain subsets of requested permissions and scope', () => {
  const permissions = { network: { enabled: true }, fileSystem: { write: ['G:/project/a'], read: ['G:/project/b'] } };
  const approval = request('item/permissions/requestApproval', { permissions, scope: 'turn' });
  validateNativeResponse(approval, { permissions: {}, scope: 'turn' });
  validateNativeResponse(approval, { permissions: { fileSystem: { write: ['G:/project/a'] } }, scope: 'turn' });
  for (const result of [{ permissions, scope: 'session' }, { permissions: { fileSystem: { write: ['G:/'] } } }, { permissions: { network: { enabled: true }, surprise: true } }, { permissions: [], scope: 'turn' }]) assert.throws(() => validateNativeResponse(approval, result));
  validateNativeResponse(request('item/permissions/requestApproval', { permissions }), { permissions, scope: 'session' });
  assert.throws(() => validateNativeResponse(request('item/permissions/requestApproval', { permissions: { network: { enabled: 'yes' } } }), { permissions: { network: { enabled: 'yes' } } }));
});
test('MCP forms validate schema and URL, decline and cancel require no content', () => {
  const form = request('mcpServer/elicitation/request', { mode: 'form', requestedSchema: { type: 'object', properties: { age: { type: 'integer', minimum: 18 } }, required: ['age'] } });
  validateNativeResponse(form, { action: 'accept', content: { age: 21 }, _meta: null });
  assert.throws(() => validateNativeResponse(form, { action: 'accept', content: { age: 10 } }));
  for (const action of ['decline','cancel']) { validateNativeResponse(form, { action, content: null, _meta: null }); assert.throws(() => validateNativeResponse(form, { action, content: { age: 21 } })); }
  const url = request('mcpServer/elicitation/request', { mode: 'url' });
  validateNativeResponse(url, { action: 'accept', content: null });
  assert.throws(() => validateNativeResponse(url, { action: 'accept', content: { fake: 'proof' } }));
  assert.throws(() => validateNativeResponse(request('item/tool/call'), { fake: 'host execution' }));
});
test('mixed legacy filesystem grants retain requested deny entries, while an empty response can deny all access', () => {
  const deny = { access: 'deny', path: { type: 'path', path: 'G:/project/private' } };
  const approval = request('item/permissions/requestApproval', { permissions: { fileSystem: { read: ['G:/project'], write: ['G:/project'], entries: [deny] } } });
  for (const access of ['read', 'write']) for (const entries of [undefined, []]) {
    const fileSystem = { [access]: ['G:/project'], ...(entries ? { entries } : {}) };
    assert.throws(() => validateNativeResponse(approval, { permissions: { fileSystem } }), /拒绝规则/);
    validateNativeResponse(approval, { permissions: { fileSystem: { ...fileSystem, entries: [deny] } } });
  }
  for (const permissions of [{}, { fileSystem: {} }, { fileSystem: { read: [], write: [], entries: [] } }]) validateNativeResponse(approval, { permissions });
});
test('serialized MCP form optional null metadata is normalized while actual format constraints are enforced', () => {
  const form = request('mcpServer/elicitation/request', { mode: 'form', requestedSchema: { type: 'object', required: null, properties: { email: { type: 'string', format: 'email', minLength: null, maxLength: null, default: null } } } });
  validateNativeResponse(form, { action: 'accept', content: { email: 'person@example.test' } });
  assert.throws(() => validateNativeResponse(form, { action: 'accept', content: { email: 'not-an-email' } }));
});
test('unsupported host request UI never asks users to fabricate host JSON', () => {
  const html = renderToStaticMarkup(createElement(NativeRequestCard, { request: { ...request('item/tool/call'), key: 'k' }, onRespond: async () => {}, onError() {} }));
  assert.match(html, /尚未接入/); assert.doesNotMatch(html, /textarea|提交响应/);
});
test('invalid native response keeps engine request pending; unknown host request is rejected with visible evidence', async t => {
  const f = await fixture(t); await f.send('plan'); await until(() => f.clients[0]?.calls.some(call => call.method === 'turn/start'));
  const client = f.clients[0], responses: unknown[] = [], errors: any[] = [];
  client.port.respond = (_id, result) => { responses.push(result); };
  client.port.reject = (id, error) => { errors.push({ id, error }); };
  const threadId = client.calls.find(call => call.method === 'turn/start')!.params.threadId;
  client.options.onRequest!({ id: 'approval', method: 'item/commandExecution/requestApproval', params: { threadId, availableDecisions: ['decline'] } });
  const pending = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!.requests![0];
  await assert.rejects(f.engine.command({ type: 'respond_native', projectId: f.projectId, requestKey: pending.key, result: { decision: 'accept' } }));
  assert.equal((await f.engine.command({ type: 'snapshot' })).snapshot.selected!.requests!.length, 1); assert.equal(responses.length, 0);
  await f.engine.command({ type: 'respond_native', projectId: f.projectId, requestKey: pending.key, result: { decision: 'decline' } });
  await assert.rejects(f.engine.command({ type: 'respond_native', projectId: f.projectId, requestKey: pending.key, result: { decision: 'decline' } }));
  client.options.onRequest!({ id: 'host', method: 'item/tool/call', params: { threadId } });
  assert.equal(errors[0].error.code, -32601);
  const snapshot = (await f.engine.command({ type: 'snapshot' })).snapshot.selected!;
  assert.equal(snapshot.requests!.length, 0); assert(snapshot.activities.some(activity => activity.text.includes('item/tool/call')));
});
