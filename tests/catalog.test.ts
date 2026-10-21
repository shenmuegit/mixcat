import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureSelectedPlugins, loadCapabilityCatalog } from '../src/core/catalog.js';
import { projectDirectory } from '../src/core/paths.js';
import type { CodexPort } from '../src/shared/types.js';

function client(rpc: CodexPort['rpc']): CodexPort { return { rpc, async connect() {}, async close() {} }; }
const base = projectDirectory(process.cwd(), '.runtime', 'implementation', 'catalog-tests', randomUUID());
const previousHost = process.env.MIXCAT_HOST_CODEX_HOME;
process.env.MIXCAT_HOST_CODEX_HOME = join(base, 'host');
after(() => { if (previousHost === undefined) delete process.env.MIXCAT_HOST_CODEX_HOME; else process.env.MIXCAT_HOST_CODEX_HOME = previousHost; rmSync(base, { recursive: true, force: true }); });

test('catalog pages real models and lists enabled skills and installed plugins for the project', async () => {
  const calls: { method: string; params: any }[] = [];
  const result = await loadCapabilityCatalog(client(async (method, params) => {
    calls.push({ method, params });
    if (method === 'model/list') return params.cursor
      ? { data: [{ id: 'catalog-b', model: 'model-b', displayName: 'Model B', isDefault: false }], nextCursor: null }
      : { data: [{ id: 'catalog-a', model: 'model-a', displayName: 'Model A', isDefault: true }], nextCursor: 'page-2' };
    if (method === 'skills/list') return { data: [{ cwd: 'G:\\project', errors: [], skills: [
      { name: 'writing', path: 'G:\\skills\\writing\\SKILL.md', description: 'Write clearly', enabled: true },
      { name: 'off', path: 'G:\\skills\\off\\SKILL.md', enabled: false },
    ] }] };
    if (method === 'plugin/installed') return { marketplaces: [{ plugins: [
      { id: 'plugin@market', name: 'plugin', installed: true, enabled: true, interface: { displayName: 'Plugin', shortDescription: 'Selected capability' } },
      { id: 'uninstalled@market', name: 'uninstalled', installed: false, enabled: true },
      { id: 'disabled@market', name: 'disabled', installed: true, enabled: false },
    ] }], marketplaceLoadErrors: [] };
    throw new Error('Unexpected method');
  }), 'G:\\project');
  assert.deepEqual(result, { models: [
    { id: 'model-a', name: 'Model A', isDefault: true }, { id: 'model-b', name: 'Model B', isDefault: false },
  ], skills: [{ name: 'writing', path: 'G:\\skills\\writing\\SKILL.md', description: 'Write clearly' }],
  plugins: [{ id: 'plugin@market', name: 'Plugin', description: 'Selected capability' }], errors: [] });
  assert.deepEqual(calls.filter(x => x.method !== 'model/list').map(x => x.params.cwds), [['G:\\project'], ['G:\\project']]);
  assert.equal(calls.filter(x => x.method === 'model/list').length, 2);
});

test('catalog keeps successful sources and reports rejected, malformed and partial native discovery', async () => {
  const result = await loadCapabilityCatalog(client(async method => {
    if (method === 'model/list') throw new Error('Catalog unavailable');
    if (method === 'skills/list') return { data: [{ skills: [{ name: 'valid', path: 'G:\\valid\\SKILL.md', enabled: true }], errors: [{ message: 'Broken skill' }] }] };
    return { marketplaces: [{ plugins: [{ id: 5, name: 'bad', enabled: true, installed: true }] }], marketplaceLoadErrors: [] };
  }), 'G:\\project');
  assert.deepEqual(result.models, []); assert.deepEqual(result.plugins, []);
  assert.deepEqual(result.skills, [{ name: 'valid', path: 'G:\\valid\\SKILL.md' }]);
  assert(result.errors.some(x => x.includes('model/list') && x.includes('Catalog unavailable')));
  assert(result.errors.some(x => x.includes('skills/list') && x.includes('Broken skill')));
  assert(result.errors.some(x => x.includes('plugin/installed')));
});

test('catalog stops on a repeated pagination cursor and surfaces marketplace errors', async () => {
  let pages = 0;
  const result = await loadCapabilityCatalog(client(async method => {
    if (method === 'model/list') { pages++; return { data: [], nextCursor: 'same' }; }
    if (method === 'skills/list') return { data: [] };
    return { marketplaces: [], marketplaceLoadErrors: [{ message: 'Offline marketplace' }] };
  }), 'G:\\project');
  assert.equal(pages, 2);
  assert(result.errors.some(x => x.includes('model/list') && /cursor/i.test(x)));
  assert(result.errors.some(x => x.includes('plugin/installed') && x.includes('Offline marketplace')));
});

test('selection catalog keeps exact native identifiers and labels when an unrelated source is offline', async () => {
  const result = await loadCapabilityCatalog(client(async method => {
    if (method === 'model/list') return { data: [{ model: 'model-native-id', displayName: 'Model label', isDefault: true }], nextCursor: null };
    if (method === 'skills/list') return { data: [{ skills: [{ name: 'Skill label', path: 'G:\\project\\SKILL.md', enabled: true }], errors: [] }] };
    throw new Error('Plugin catalog offline');
  }), 'G:\\project');
  assert.deepEqual(result.models, [{ id: 'model-native-id', name: 'Model label', isDefault: true }]);
  assert.deepEqual(result.skills, [{ name: 'Skill label', path: 'G:\\project\\SKILL.md' }]);
  assert(result.errors.some(error => error === 'plugin/installed: Plugin catalog offline'));
  assert.equal(result.models.some(model => model.id === 'default'), false);
});

test('selected host plugin is imported locally through native install without copying credentials or unselected packages', async t => {
  const host = process.env.MIXCAT_HOST_CODEX_HOME!;
  const source = projectDirectory(base, 'host', 'plugins', 'cache', 'fixture', 'selected', '1.0');
  const manifestRoot = projectDirectory(source, '.claude-plugin');
  writeFileSync(join(manifestRoot, 'plugin.json'), JSON.stringify({ name: 'selected', version: '1.0', description: 'A selected skill plugin' }));
  writeFileSync(join(source, 'SKILL.md'), 'Selected plugin instructions');
  writeFileSync(join(source, 'auth.json'), 'must not copy');
  writeFileSync(join(source, '.env'), 'must not copy');
  for (const version of ['0.9.9', '1.0.0-beta.2', '1.0.0-beta.10', '1.0.0']) {
    const directory = projectDirectory(base, 'host', 'plugins', 'cache', 'fixture', 'versioned', version, '.claude-plugin');
    writeFileSync(join(directory, 'plugin.json'), JSON.stringify({ name: 'versioned', version, description: version }));
  }
  const unused = projectDirectory(base, 'host', 'plugins', 'cache', 'fixture', 'unused', '1.0', '.claude-plugin');
  writeFileSync(join(unused, 'plugin.json'), JSON.stringify({ name: 'unused', version: '1.0' }));
  const project = projectDirectory(base, 'project');
  t.after(() => rmSync(host, { recursive: true, force: true }));
  const calls: { method: string; params: any }[] = [];
  let installed = false;
  const native = client(async (method, params) => {
    calls.push({ method, params });
    if (method === 'plugin/installed') return { marketplaces: [{ plugins: installed ? [{ id: 'selected@mixcat-import-fixture', name: 'selected', installed: true, enabled: true }] : [] }], marketplaceLoadErrors: [] };
    if (method === 'model/list') return { data: [], nextCursor: null };
    if (method === 'skills/list') return { data: [] };
    if (method === 'marketplace/add') return {};
    if (method === 'plugin/install') {
      const market = JSON.parse(readFileSync(params.marketplacePath as string, 'utf8'));
      assert.equal(market.name, 'mixcat-import-fixture'); assert.equal(market.plugins.length, 1);
      const copied = join(project, '.mixcat', 'plugin-imports', 'mixcat-import-fixture', market.plugins[0].source);
      assert(existsSync(join(copied, 'SKILL.md'))); assert(!existsSync(join(copied, 'auth.json'))); assert(!existsSync(join(copied, '.env')));
      installed = true; return { appsNeedingAuth: [] };
    }
    throw new Error('Unexpected method');
  });
  const catalog = await loadCapabilityCatalog(native, project);
  assert(catalog.plugins.some(p => p.id === 'selected@mixcat-import-fixture' && p.installed === false));
  assert.equal(catalog.plugins.find(p => p.name === 'versioned')?.description, '1.0.0');
  assert(!existsSync(join(project, '.mixcat')), 'Discovery must not import anything');
  const selection = [{ id: 'selected@mixcat-import-fixture', name: 'selected' }];
  await ensureSelectedPlugins(native, project, selection);
  await ensureSelectedPlugins(native, project, selection);
  assert.equal(calls.filter(c => c.method === 'plugin/install').length, 1);
  assert.equal(readFileSync(join(source, 'auth.json'), 'utf8'), 'must not copy');
  await assert.rejects(ensureSelectedPlugins(native, project, [{ id: '../bad@fixture', name: 'bad' }]), /不可用/);
});

test('host plugin import refuses a linked package before any native installation', async t => {
  const source = projectDirectory(base, 'host', 'plugins', 'cache', 'fixture', 'linked', '1.0');
  const manifestRoot = projectDirectory(source, '.claude-plugin');
  writeFileSync(join(manifestRoot, 'plugin.json'), JSON.stringify({ name: 'linked', version: '1.0' }));
  const target = projectDirectory(base, 'link-target');
  symlinkSync(target, join(source, 'linked-data'), process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => rmSync(join(base, 'host'), { recursive: true, force: true }));
  let mutations = 0;
  const native = client(async method => { if (method === 'plugin/installed') return { marketplaces: [] }; mutations++; return {}; });
  await assert.rejects(ensureSelectedPlugins(native, projectDirectory(base, 'linked-project'), [{ id: 'linked@mixcat-import-fixture', name: 'linked' }]), /链接|联接/);
  assert.equal(mutations, 0);
});
