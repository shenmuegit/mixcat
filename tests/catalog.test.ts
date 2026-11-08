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

test('catalog includes hidden native models on later pages and lists enabled skills and installed plugins', async () => {
  const calls: { method: string; params: any }[] = [];
  const result = await loadCapabilityCatalog(client(async (method, params) => {
    calls.push({ method, params });
    if (method === 'model/list') return params.cursor
      ? { data: params.includeHidden ? [{ id: 'catalog-b', model: 'model-b', displayName: 'Model B', isDefault: false, hidden: true }] : [], nextCursor: null }
      : { data: [{ id: 'catalog-a', model: 'model-a', displayName: 'Model A', isDefault: true }], nextCursor: params.includeHidden ? 'page-2' : null };
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
  plugins: [{ id: 'plugin@market', name: 'Plugin', description: 'Selected capability' }, { id: 'disabled@market', name: 'disabled', enabled: false }], errors: [] });
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

test('model catalog keeps per-model reasoning choices, descriptions and future effort identifiers', async () => {
  const catalog = await loadCapabilityCatalog(client(async (method, params) => {
    if (method === 'model/list') return params.cursor
      ? { data: [{ model: 'fast-model', displayName: 'Fast model', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Fast responses' }], defaultReasoningEffort: 'low' }], nextCursor: null }
      : { data: [{ model: 'deep-model', displayName: 'Deep model', supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'More deliberation' }, { reasoningEffort: 'future-effort', description: 'Native future option' }], defaultReasoningEffort: 'future-effort' }], nextCursor: 'next' };
    if (method === 'skills/list') return { data: [] };
    return { marketplaces: [], marketplaceLoadErrors: [] };
  }), 'G:\\project');
  assert.deepEqual(catalog.models, [
    { id: 'deep-model', name: 'Deep model', isDefault: false, supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'More deliberation' }, { reasoningEffort: 'future-effort', description: 'Native future option' }], defaultReasoningEffort: 'future-effort' },
    { id: 'fast-model', name: 'Fast model', isDefault: false, supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Fast responses' }], defaultReasoningEffort: 'low' },
  ]);
});

test('host plugin discovery keeps real namespaces and versions; selection cannot silently import cached plugins', async t => {
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
    if (method === 'plugin/installed') return { marketplaces: [{ plugins: installed ? [{ id: 'selected@fixture', name: 'selected', installed: true, enabled: true }] : [] }], marketplaceLoadErrors: [] };
    if (method === 'model/list') return { data: [], nextCursor: null };
    if (method === 'skills/list') return { data: [] };
    throw new Error('Unexpected method');
  });
  const catalog = await loadCapabilityCatalog(native, project);
  assert(catalog.plugins.some(p => p.id === 'selected@fixture' && p.installed === false));
  assert.equal(catalog.plugins.find(p => p.name === 'versioned')?.description, '1.0.0');
  assert(!existsSync(join(project, '.mixcat')), 'Discovery must not import anything');
  assert.equal(catalog.plugins.find(p => p.name === 'versioned')?.version, '1.0.0');
  const selection = [{ id: 'selected@fixture', name: 'selected' }];
  await assert.rejects(ensureSelectedPlugins(native, project, selection), /尚未.*原生安装/);
  installed = true;
  await ensureSelectedPlugins(native, project, selection);
  await ensureSelectedPlugins(native, project, selection);
  assert.equal(calls.filter(c => ['plugin/install', 'marketplace/add'].includes(c.method)).length, 0);
  assert(!existsSync(join(project, '.mixcat')), 'Selection must not manufacture an import marketplace');
  assert.equal(readFileSync(join(source, 'auth.json'), 'utf8'), 'must not copy');
  await assert.rejects(ensureSelectedPlugins(native, project, [{ id: '../bad@fixture', name: 'bad' }]), /尚未.*原生安装/);
});

test('an unavailable cached plugin is rejected without following its package links or starting an installation', async t => {
  const source = projectDirectory(base, 'host', 'plugins', 'cache', 'fixture', 'linked', '1.0');
  const manifestRoot = projectDirectory(source, '.claude-plugin');
  writeFileSync(join(manifestRoot, 'plugin.json'), JSON.stringify({ name: 'linked', version: '1.0' }));
  const target = projectDirectory(base, 'link-target');
  symlinkSync(target, join(source, 'linked-data'), process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => rmSync(join(base, 'host'), { recursive: true, force: true }));
  let mutations = 0;
  const native = client(async method => { if (method === 'plugin/installed') return { marketplaces: [] }; mutations++; return {}; });
  await assert.rejects(ensureSelectedPlugins(native, projectDirectory(base, 'linked-project'), [{ id: 'linked@fixture', name: 'linked' }]), /尚未.*原生安装/);
  assert.equal(mutations, 0);
});
