import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fixture, until } from './runtime-fixture.js';

test('native execution retains project cwd and project-owned control home without disabling native tools', async t => {
  const f = await fixture(t); await f.send('plan');
  await until(() => f.clients[0].calls.some(call => call.method === 'turn/start'));
  assert.equal(f.clients[0].options.cwd, f.root);
  assert.equal(f.clients[0].options.home, join(f.root, '.mixcat', 'codex'));
  const session = f.clients[0].calls.find(call => call.method === 'thread/start')!.params;
  assert.equal(session.cwd, f.root); assert.equal(session.sandbox, 'workspace-write');
  assert.equal(session.approvalPolicy, 'on-request');
  assert.deepEqual(Object.keys(session.config), ['mcp_servers']);
  assert.deepEqual(Object.keys(session.config.mcp_servers), ['mixcat']);
  assert.equal(session.config.mcp_servers.mixcat.enabled, true);
  // Host preview guards do not imply OS isolation from a project-owned control home.
  assert.equal('allowedTools' in session, false); assert.equal('disabledTools' in session, false);
});
