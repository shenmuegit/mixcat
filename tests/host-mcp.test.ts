import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeHostMcpServer } from '../src/core/host-mcp.js';

test('selected host stdio MCP preserves explicit transport settings but runs in the project and does not invent tool rights', () => {
  const value = normalizeHostMcpServer({ enabled: true, transport: { type: 'stdio', command: 'node', args: ['gitnexus', 'mcp'], env: { FIXTURE_VALUE: 'fixture' }, env_vars: ['FIXTURE_INHERITED'], cwd: 'C:/old-location' }, enabled_tools: ['query'], startup_timeout_sec: 20 }, 'G:/project');
  assert.deepEqual(value, { command: 'node', args: ['gitnexus', 'mcp'], env: { FIXTURE_VALUE: 'fixture' }, env_vars: ['FIXTURE_INHERITED'], cwd: 'G:/project', enabled: true, enabled_tools: ['query'], startup_timeout_sec: 20 });
  assert(!Object.hasOwn(value, 'required'));
  assert(!Object.hasOwn(value, 'tools'));
});

test('missing, disabled and malformed host MCP profiles cannot be reported as enabled', () => {
  for (const profile of [null, {}, { enabled: false }, { enabled: true, transport: { type: 'stdio', command: '' } }, { enabled: true, transport: { type: 'stdio', command: 'node', args: [17] } }]) {
    assert.throws(() => normalizeHostMcpServer(profile, 'G:/project'), /MCP/);
  }
});
