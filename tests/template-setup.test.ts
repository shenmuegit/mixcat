import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WorkflowEngine } from '../src/core/engine.js';
import { projectDirectory } from '../src/core/paths.js';
import { accountFixture } from './account-fixture.js';
import type { AppCommand, CodexPort } from '../src/shared/types.js';
import { inspectTemplateSetup } from '../src/core/template-setup.js';
import { createWebProductTemplate } from '../src/core/web-product.js';

const providerSkills: Record<string, string[]> = {
  ecc: ['research-ops', 'deep-research', 'article-writing', 'content-engine', 'coding-standards', 'verification-loop', 'product-lens', 'product-capability', 'frontend-patterns', 'backend-patterns', 'e2e-testing', 'architecture-decision-records'],
  superpowers: ['systematic-debugging'], 'planning-with-files': ['planning-with-files'], ponytail: ['ponytail'], gitnexus: ['gitnexus-exploring', 'gitnexus-debugging', 'gitnexus-impact-analysis'],
};

async function setupFixture(t: { after(fn: () => unknown): void }, existing: string[] = []) {
  const root = mkdtempSync(join(projectDirectory(resolve('.'), '.runtime', 'implementation', 'template-capabilities-193'), 'setup-'));
  const previous = process.env.MIXCAT_HOST_CODEX_HOME;
  process.env.MIXCAT_HOST_CODEX_HOME = projectDirectory(root, 'host');
  t.after(() => { if (previous === undefined) delete process.env.MIXCAT_HOST_CODEX_HOME; else process.env.MIXCAT_HOST_CODEX_HOME = previous; });
  const installed = new Map(existing.map(id => [id, '1.0.0']));
  const pluginId = (id: string) => id.includes('@') ? id : `${id}@${id}`;
  const calls: { method: string; params: any }[] = [];
  let fail = '', outcome = 'failed', discoveryFailure = false, auth = '', onMarket: (() => void) | undefined, hold: Promise<void> | undefined;
  const nativeFactory = (): CodexPort => ({ async connect() {}, async close() {}, async rpc(method, params) {
    calls.push({ method, params });
    if (method === 'plugin/installed') return { marketplaces: [{ path: join(root, 'project', 'legacy-market', 'marketplace.json'), plugins: [...installed].map(([id, version]) => ({ id: pluginId(id), name: id.split('@')[0], installed: true, enabled: true, version })) }], marketplaceLoadErrors: [] };
    if (method === 'skills/list') { if (discoveryFailure) throw Error('Fixture discovery unavailable'); return { data: [{ skills: [...installed.keys()].flatMap(key => { const id = key.split('@')[0]; return providerSkills[id].map(name => ({ name: `${id}:${name}`, path: join(root, 'native-skills', key, name, 'SKILL.md'), enabled: true })); }), errors: [] }] }; }
    if (method === 'model/list') return { data: [], nextCursor: null };
    if (method === 'hooks/list') return { data: [{ hooks: [], errors: [] }] };
    if (method === 'mcpServerStatus/list') return { data: [], nextCursor: null };
    if (method === 'account/read') return { account: null };
    if (method === 'marketplace/add') {
      onMarket?.(); onMarket = undefined;
      assert(typeof params.source === 'string');
      const id = params.source.includes('superpowers') ? 'superpowers' : params.source.includes('ECC') ? 'ecc' : params.source.split('/').at(-1)!.toLowerCase();
      return { marketplaceName: id, installedRoot: projectDirectory(root, 'project', '.mixcat', 'codex', 'marketplaces', id), alreadyAdded: false };
    }
    if (method === 'plugin/list') return { marketplaces: Object.keys(providerSkills).map(id => ({ name: id, path: join(root, 'project', '.mixcat', 'codex', 'marketplaces', id, '.claude-plugin', 'marketplace.json'), plugins: [{ id: `${id}@${id}`, name: id }] })) };
    if (method === 'plugin/install') { assert(typeof params.pluginName === 'string'); await hold; if (params.pluginName === fail) throw Object.assign(Error('Fixture network failure'), { outcome }); installed.set(params.pluginName, '2.0.0'); return { appsNeedingAuth: params.pluginName === auth ? [{ id: 'fixture-app' }] : [], authPolicy: 'ON_INSTALL' }; }
    if (method === 'plugin/uninstall') { assert(typeof params.pluginId === 'string'); installed.delete(params.pluginId); return {}; }
    assert.fail(`Unexpected native method: ${method}`);
  } });
  const options = { workbenchRoot: root, executable: 'fixture', nativeFactory, accountFactory: accountFixture().factory };
  const engine = new WorkflowEngine(options);
  t.after(() => engine.close()); await engine.init();
  const created = (await engine.command({ type: 'create_project', root: projectDirectory(root, 'project'), name: 'Research', template: 'research-analysis' })).snapshot.selected!;
  const inspect = async () => (await engine.command({ type: 'template_setup', projectId: created.project.id, phase: 'inspect' })).templateSetup!;
  const install = (decision?: any) => engine.command({ type: 'template_setup', projectId: created.project.id, phase: 'install', decision });
  return { engine, options, root, projectId: created.project.id, calls, installed, inspect, install, fail(value: string, result = 'failed') { fail = value; outcome = result; }, discoveryFailure(value: boolean) { discoveryFailure = value; }, hold(value: Promise<void> | undefined) { hold = value; }, auth(value: string) { auth = value; }, onMarket(callback: () => void) { onMarket = callback; } };
}

test('research setup inspects only its three install units without mutating native capabilities', async t => {
  const root = mkdtempSync(join(projectDirectory(resolve('.'), '.runtime', 'implementation', 'template-capabilities-193'), 'inspect-'));
  const previous = process.env.MIXCAT_HOST_CODEX_HOME;
  process.env.MIXCAT_HOST_CODEX_HOME = projectDirectory(root, 'host');
  t.after(() => { if (previous === undefined) delete process.env.MIXCAT_HOST_CODEX_HOME; else process.env.MIXCAT_HOST_CODEX_HOME = previous; });
  const calls: string[] = [];
  const nativeFactory = (): CodexPort => ({ async connect() {}, async close() {}, async rpc(method) {
    calls.push(method);
    if (method === 'plugin/installed') return { marketplaces: [], marketplaceLoadErrors: [] };
    if (method === 'skills/list') return { data: [{ skills: [], errors: [] }] };
    if (method === 'model/list') return { data: [], nextCursor: null };
    if (method === 'hooks/list') return { data: [{ hooks: [], errors: [] }] };
    if (method === 'mcpServerStatus/list') return { data: [], nextCursor: null };
    if (method === 'account/read') return { account: null };
    return {};
  } });
  const engine = new WorkflowEngine({ workbenchRoot: root, executable: 'fixture', nativeFactory, accountFactory: accountFixture().factory });
  t.after(() => engine.close()); await engine.init();
  const created = (await engine.command({ type: 'create_project', root: projectDirectory(root, 'project'), name: 'Research', template: 'research-analysis' })).snapshot.selected!;
  const reply = await engine.command({ type: 'template_setup', projectId: created.project.id, phase: 'inspect' } as unknown as AppCommand);
  const setup = (reply as any).templateSetup;
  assert.deepEqual(setup?.items.map((item: any) => item.id), ['ecc', 'superpowers', 'planning-with-files']);
  assert(setup.items.every((item: any) => item.state === 'missing'));
  assert.equal(typeof setup.observation, 'string');
  assert(calls.every(method => !['marketplace/add', 'marketplace/upgrade', 'plugin/install', 'plugin/uninstall', 'thread/start', 'turn/start'].includes(method)));
});

test('overwriting a project plugin with an old namespace removes its duplicate through the native manager', async t => {
  const f = await setupFixture(t, ['ecc@legacy', 'superpowers', 'planning-with-files']);
  const plan = await f.inspect();
  const result = await f.install({ observation: plan.observation, choices: { ecc: 'overwrite', superpowers: 'skip', 'planning-with-files': 'skip' } });
  assert.equal(result.templateSetup!.status, 'ready');
  assert.equal(f.installed.has('ecc@legacy'), false);
  assert.deepEqual(f.calls.filter(call => call.method === 'plugin/uninstall').map(call => call.params.pluginId), ['ecc@legacy']);
  assert(f.calls.findIndex(call => call.method === 'plugin/install') < f.calls.findIndex(call => call.method === 'plugin/uninstall'));
});

test('research installation uses only its official plugin markets and re-reads qualified skills before configuring nodes', async t => {
  const f = await setupFixture(t);
  const plan = await f.inspect();
  const result = await f.install({ observation: plan.observation, choices: {} });
  assert.deepEqual(f.calls.filter(call => call.method === 'plugin/install').map(call => call.params.pluginName), ['ecc', 'superpowers', 'planning-with-files']);
  assert(f.calls.filter(call => call.method === 'marketplace/add').every(call => /^https:\/\/github\.com\//.test(call.params.source)));
  assert.equal(result.templateSetup!.status, 'ready');
  assert(result.templateSetup!.items.every(item => item.state === 'installed'));
  assert(result.snapshot.selected!.nodes.every(node => node.skills!.some(skill => skill.name === 'planning-with-files:planning-with-files')));
  assert.deepEqual(result.snapshot.selected!.tasks, []);
});

test('existing capabilities require a choice, default to skip and can be explicitly overwritten', async t => {
  const f = await setupFixture(t, ['ecc', 'superpowers', 'planning-with-files']);
  const plan = await f.inspect();
  assert.equal(plan.needsChoices, true);
  assert.equal(plan.items[0].existing.find(item => item.name === 'ecc')!.version, '1.0.0');
  const prompt = await f.install();
  assert.equal(prompt.templateSetup!.needsChoices, true);
  assert.equal(f.calls.filter(call => call.method === 'plugin/install').length, 0);
  const result = await f.install({ observation: plan.observation, choices: { ecc: 'overwrite', superpowers: 'skip', 'planning-with-files': 'skip' } });
  assert.deepEqual(f.calls.filter(call => call.method === 'plugin/install').map(call => call.params.pluginName), ['ecc']);
  assert.equal(f.installed.get('superpowers'), '1.0.0');
  assert.equal(result.templateSetup!.items.find(item => item.id === 'superpowers')!.state, 'skipped');
});

test('a changed native installation invalidates an old overwrite decision without modifying capabilities', async t => {
  const f = await setupFixture(t, ['ecc', 'superpowers', 'planning-with-files']);
  const plan = await f.inspect();
  f.installed.set('ecc', '1.1.0');
  const result = await f.install({ observation: plan.observation, choices: { ecc: 'overwrite', superpowers: 'skip', 'planning-with-files': 'skip' } });
  assert.equal(result.templateSetup!.needsChoices, true);
  assert.notEqual(result.templateSetup!.observation, plan.observation);
  assert.equal(f.calls.filter(call => call.method === 'plugin/install').length, 0);
});

test('partial installation failures retain the project and retry only unfinished install units', async t => {
  const f = await setupFixture(t); f.fail('superpowers');
  const first = await f.inspect();
  const partial = await f.install({ observation: first.observation, choices: {} });
  assert.equal(partial.templateSetup!.status, 'partial');
  assert.equal(partial.templateSetup!.items.find(item => item.id === 'superpowers')!.state, 'failed');
  assert(partial.snapshot.projects.some(project => project.id === f.projectId));
  f.fail('');
  const next = await f.inspect();
  assert.equal(next.items.find(item => item.id === 'ecc')!.state, 'installed');
  const done = await f.install({ observation: next.observation, choices: {} });
  assert.equal(done.templateSetup!.status, 'ready');
  assert.equal(f.calls.filter(call => call.method === 'plugin/install' && call.params.pluginName === 'ecc').length, 1);
});

test('an incomplete existing standalone skill directory requires a choice before an authored installer can replace it', async t => {
  const f = await setupFixture(t);
  const project = join(f.root, 'project');
  const folder = projectDirectory(project, '.agents', 'skills', 'impeccable');
  const catalog = { models: [], skills: [], plugins: [], errors: [] };
  const first = inspectTemplateSetup(f.projectId, 'web-product', project, createWebProductTemplate().nodes, catalog);
  assert.equal(first.items.find(item => item.id === 'impeccable')!.state, 'existing');
  assert.equal(first.needsChoices, true);
  writeFileSync(join(folder, 'SKILL.md'), '---\nname: impeccable\n---\nUser installation');
  const changed = inspectTemplateSetup(f.projectId, 'web-product', project, createWebProductTemplate().nodes, catalog);
  assert.notEqual(changed.observation, first.observation);
});

test('explicit overwrite replaces a node reference while skip retains its current capability selection', async t => {
  const f = await setupFixture(t, ['ecc', 'superpowers', 'planning-with-files']);
  const state = (await f.engine.command({ type: 'snapshot', projectId: f.projectId })).snapshot.selected!;
  const oldSkill = { name: 'ecc:research-ops', path: join(f.root, 'old-ecc', 'SKILL.md') };
  const skippedSkill = { name: 'planning-with-files', path: join(f.root, 'user-planning', 'SKILL.md') };
  await f.engine.command({ type: 'save_node', projectId: f.projectId, node: { ...state.nodes[0], skills: [oldSkill, skippedSkill] } });
  const plan = await f.inspect();
  const result = await f.install({ observation: plan.observation, choices: { ecc: 'overwrite', superpowers: 'skip', 'planning-with-files': 'skip' } });
  const selected = result.snapshot.selected!.nodes[0].skills!;
  assert.equal(selected.filter(skill => skill.name === 'ecc:research-ops').length, 1);
  assert(!selected.some(skill => skill.path === oldSkill.path));
  assert.deepEqual(selected.filter(skill => skill.name.includes('planning-with-files')), [skippedSkill]);
});

test('an unavailable capability catalog blocks installation and an unknown result requires a new choice', async t => {
  const f = await setupFixture(t);
  f.discoveryFailure(true);
  const blocked = await f.install();
  assert.equal(blocked.templateSetup!.blocked, true);
  assert.equal(f.calls.filter(call => call.method === 'marketplace/add').length, 0);
  f.discoveryFailure(false); f.fail('superpowers', 'unknown');
  await f.install();
  f.fail('');
  const prompt = await f.install();
  assert.equal(prompt.templateSetup!.items.find(item => item.id === 'superpowers')!.state, 'unknown');
  assert.equal(prompt.templateSetup!.needsChoices, true);
  assert.equal(f.calls.filter(call => call.method === 'plugin/install' && call.params.pluginName === 'superpowers').length, 1);
});

test('preparation serializes project mutations and shutdown waits for its native operation before restoring pending state', async t => {
  const f = await setupFixture(t);
  let release!: () => void;
  f.hold(new Promise<void>(resolve => { release = resolve; }));
  const pending = f.install();
  const rejected = assert.rejects(pending, /原生连接已结束/);
  while (!f.calls.some(call => call.method === 'plugin/install')) await new Promise(resolve => setTimeout(resolve, 5));
  await assert.rejects(f.install(), /正在准备/);
  await assert.rejects(f.engine.command({ type: 'configure_template', projectId: f.projectId }), /正在准备/);
  await assert.rejects(f.engine.command({ type: 'start', projectId: f.projectId, nodeId: 'research-lead', instruction: 'Work', mode: 'codex' }), /正在准备/);
  let closed = false;
  const closing = f.engine.close().then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(closed, false);
  release(); await rejected; await closing;
  const installs = f.calls.filter(call => call.method === 'plugin/install').length;
  const reopened = new WorkflowEngine(f.options); t.after(() => reopened.close()); await reopened.init();
  assert.equal(f.calls.filter(call => call.method === 'plugin/install').length, installs);
  const restored = await reopened.command({ type: 'create_project', root: join(f.root, 'project'), name: 'Restore', template: 'research-analysis' });
  assert.equal(restored.projectCreated, false);
  assert.equal(restored.snapshot.selected!.templateSetup!.items[0].state, 'unknown');
});

test('a host-only capability is offered for skipping without installation into the new project', async t => {
  const f = await setupFixture(t);
  const cache = projectDirectory(f.root, 'host', 'plugins', 'cache', 'official', 'ecc', '1.0.0', '.codex-plugin');
  writeFileSync(join(cache, 'plugin.json'), JSON.stringify({ name: 'ecc', version: '1.0.0' }));
  const plan = await f.inspect();
  assert.equal(plan.items[0].existing[0].scope, 'codex');
  const result = await f.install({ observation: plan.observation, choices: { ecc: 'skip' } });
  assert.equal(result.templateSetup!.status, 'partial');
  assert.equal(result.templateSetup!.items[0].state, 'skipped');
  assert(!f.calls.some(call => call.method === 'plugin/install' && call.params.pluginName === 'ecc'));
});

test('same-version hook edits invalidate an overwrite decision', async t => {
  const f = await setupFixture(t, ['ecc', 'superpowers', 'planning-with-files']);
  const packageRoot = projectDirectory(f.root, 'project', '.mixcat', 'codex', 'plugins', 'cache', 'ecc', 'ecc', '1.0.0');
  writeFileSync(join(projectDirectory(packageRoot, '.codex-plugin'), 'plugin.json'), JSON.stringify({ name: 'ecc', version: '1.0.0' }));
  const newer = projectDirectory(f.root, 'project', '.mixcat', 'codex', 'plugins', 'cache', 'ecc', 'ecc', '2.0.0', '.codex-plugin');
  writeFileSync(join(newer, 'plugin.json'), JSON.stringify({ name: 'ecc', version: '2.0.0' }));
  const hook = join(packageRoot, 'user-hook.js'); writeFileSync(hook, 'original hook');
  const plan = await f.inspect(); writeFileSync(hook, 'user edited hook at the same version');
  const reply = await f.install({ observation: plan.observation, choices: { ecc: 'overwrite', superpowers: 'skip', 'planning-with-files': 'skip' } });
  assert.equal(reply.templateSetup!.needsChoices, true);
  assert.equal(f.calls.filter(call => call.method === 'plugin/install').length, 0);
});

test('a capability appearing while its marketplace downloads requires a fresh choice before installation', async t => {
  const f = await setupFixture(t);
  f.onMarket(() => f.installed.set('ecc', '1.0.0'));
  const reply = await f.install();
  assert.equal(reply.templateSetup!.needsChoices, true);
  assert.equal(f.calls.filter(call => call.method === 'plugin/install').length, 0);
});

test('skipping an authorization-dependent item keeps it pending until a native install confirms authorization', async t => {
  const f = await setupFixture(t); f.auth('ecc');
  const first = await f.install();
  assert.equal(first.templateSetup!.items[0].state, 'needs_auth');
  const plan = await f.inspect();
  assert.equal(plan.items[0].state, 'needs_auth');
  const skipped = await f.install({ observation: plan.observation, choices: { ecc: 'skip' } });
  assert.equal(skipped.templateSetup!.status, 'partial');
  assert.equal(skipped.templateSetup!.items[0].state, 'needs_auth');
  f.fail('ecc');
  const failedPlan = await f.inspect();
  const failedRetry = await f.install({ observation: failedPlan.observation, choices: { ecc: 'overwrite' } });
  assert.equal(failedRetry.templateSetup!.items[0].state, 'needs_auth');
  f.fail(''); f.onMarket(() => f.installed.set('ecc', '3.0.0'));
  const racePlan = await f.inspect();
  const changed = await f.install({ observation: racePlan.observation, choices: { ecc: 'overwrite' } });
  assert.equal(changed.templateSetup!.needsChoices, true);
  assert.equal(changed.templateSetup!.items[0].state, 'needs_auth');
  const stillPending = await f.install({ observation: changed.templateSetup!.observation, choices: { ecc: 'skip' } });
  assert.equal(stillPending.templateSetup!.status, 'partial');
  f.auth(''); f.fail('');
  const again = await f.inspect();
  const ready = await f.install({ observation: again.observation, choices: { ecc: 'overwrite' } });
  assert.equal(ready.templateSetup!.status, 'ready');
});
