import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureFeedPlugins } from '../src/core/feed-plugins.js';
import type { CodexPort } from '../src/shared/types.js';

test('fresh collection installs only native-resolved canonical marketplace coordinates', async () => {
  const calls: { method: string; params: any }[] = []; let installed = false;
  const plugin = () => ({ id: 'canonical@official', name: 'canonical', interface: { displayName: 'Display' }, installed, enabled: true });
  const client: CodexPort = { async connect() {}, async close() {}, async rpc(method: string, params: any) { calls.push({ method, params }); if (method === 'plugin/installed' || method === 'plugin/list') return { marketplaces: [{ name: 'official', path: null, plugins: [plugin()] }], marketplaceLoadErrors: [] }; if (method === 'plugin/read') return { plugin: { marketplaceName: 'official', marketplacePath: null, summary: plugin() } }; if (method === 'plugin/install') { installed = true; return { appsNeedingAuth: [] }; } return {}; } };
  await ensureFeedPlugins(client, process.cwd(), [{ id: 'canonical@official', name: 'Display' }], 'fixture');
  assert.deepEqual(calls.find(c => c.method === 'plugin/install')!.params, { remoteMarketplaceName: 'official', pluginName: 'canonical' });
  assert.equal(calls.some(c => c.method === 'marketplace/add'), false);
  await assert.rejects(ensureFeedPlugins(client, process.cwd(), [{ id: 'forged@mixcat-import-official', name: 'Display' }], 'fixture'), /官方|不可用/);
});

test('official host CLI JSON supplies discovery roots while native metadata supplies the actual install path and name', async () => {
  const calls: { method: string; params: any }[] = [], cli: string[][] = []; let installed = false;
  const root = 'C:/official/marketplace', manifest = root + '/.claude-plugin/marketplace.json';
  const plugin = () => ({ id: 'canonical@mattpocock', name: 'canonical', interface: { displayName: 'Display' }, installed, enabled: installed });
  const client: CodexPort = { async connect() {}, async close() {}, async rpc(method: string, params: any) {
    calls.push({ method, params });
    if (method === 'plugin/list') return { marketplaces: params.cwds.includes(root) ? [{ name: 'mattpocock', path: manifest, plugins: [plugin()] }] : [] };
    if (method === 'plugin/installed') return { marketplaces: installed ? [{ name: 'mattpocock', path: manifest, plugins: [plugin()] }] : [] };
    if (method === 'plugin/read') return { plugin: { marketplaceName: 'mattpocock', marketplacePath: manifest, summary: plugin() } };
    if (method === 'plugin/install') { installed = true; return {}; } return {};
  } };
  await ensureFeedPlugins(client, process.cwd(), [{ id: 'canonical@mattpocock', name: 'Display' }], 'fixture', async args => {
    cli.push(args);
    return args[0] === 'marketplace' ? { marketplaces: [{ name: 'mattpocock', root }] } : { installed: [{ pluginId: 'canonical@mattpocock', name: 'canonical', marketplaceName: 'mattpocock', marketplaceSource: { sourceType: 'git', source: 'https://github.com/author/marketplace.git' } }], available: [] };
  });
  assert.deepEqual(cli, [['marketplace', 'list'], ['list', '--marketplace', 'mattpocock']]);
  assert.deepEqual(calls.find(c => c.method === 'plugin/install')!.params, { marketplacePath: manifest, pluginName: 'canonical' });
  assert.equal(calls.some(c => c.method === 'marketplace/add'), false);
});

test('native auth and failed enabled-state receipts prevent preparation from claiming readiness', async () => {
  let needsAuth = true;
  const plugin = { id: 'plugin@market', name: 'plugin', installed: false, enabled: false };
  const client: CodexPort = { async connect() {}, async close() {}, async rpc(method: string) {
    if (method === 'plugin/list' || method === 'plugin/installed') return { marketplaces: [{ name: 'market', path: 'G:/author/.claude-plugin/marketplace.json', plugins: [plugin] }] };
    if (method === 'plugin/read') return { plugin: { marketplaceName: 'market', summary: plugin } };
    if (method === 'plugin/install') return { appsNeedingAuth: needsAuth ? ['account'] : [] };
    return {};
  } };
  await assert.rejects(ensureFeedPlugins(client, process.cwd(), [{ id: plugin.id, name: 'Plugin' }], 'fixture'), /授权/);
  needsAuth = false;
  await assert.rejects(ensureFeedPlugins(client, process.cwd(), [{ id: plugin.id, name: 'Plugin' }], 'fixture'), /未确认/);
});
