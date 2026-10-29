import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { projectDirectory } from '../src/core/paths.js';
import { ProviderVault, type CredentialCrypto } from '../src/desktop/provider-vault.js';
import { ProviderSettingsService, type ProviderSettingsContext } from '../src/desktop/provider-settings.js';
import type { AppSnapshot } from '../src/shared/types.js';

const key = 'FAKE_TASK4_BYOK_DO_NOT_USE_71cbea';
const crypto: CredentialCrypto = {
  isAsyncEncryptionAvailable: async () => true,
  encryptStringAsync: async value => Buffer.from([...Buffer.from(value)].map(byte => byte ^ 0x71)),
  decryptStringAsync: async value => ({ result: Buffer.from([...value].map(byte => byte ^ 0x71)).toString(), shouldReEncrypt: false }),
};
function fixture() { return mkdtempSync(join(projectDirectory(resolve('.'), '.runtime', 'comfy-credentials-tests'), 'project-')); }
const input = () => ({ name: 'Fake Ark', protocol: 'ark' as const, baseUrl: 'https://example.invalid/api/v3', models: { image: 'literal-model-id' }, key });

test('encrypted credential survives reopening while profiles and disk never expose the fake key', async () => {
  const root = fixture(), vault = new ProviderVault(root, crypto);
  const profile = await vault.save(input(), 0);
  assert.equal(profile.revision, 1); assert.equal(profile.credentialRevision, 1); assert.equal(profile.configured, true);
  assert(!JSON.stringify(profile).includes(key)); assert(!JSON.stringify(vault.list()).includes(key));
  assert(!readFileSync(join(root, '.mixcat', 'comfy', 'providers.json'), 'utf8').includes(key));
  const reopened = new ProviderVault(root, crypto);
  assert.deepEqual(reopened.list(), [profile]);
  await reopened.withCredential(profile.id, profile.revision, async credential => { assert.equal(credential.key, key); assert.deepEqual(credential.profile, profile); });
});

test('updates/removal require exact revision and address or protocol changes require a fresh bound key', async () => {
  const vault = new ProviderVault(fixture(), crypto), p = await vault.save(input(), 0);
  await assert.rejects(vault.save({ ...input(), id: p.id }, 0), /修订/);
  await assert.rejects(vault.remove(p.id, 0), /修订/);
  await assert.rejects(vault.save({ ...input(), id: p.id, key: undefined, baseUrl: 'https://other.invalid/prefix' }, 1), /重新填写 Key/);
  await assert.rejects(vault.save({ ...input(), id: p.id, key: undefined, protocol: 'vidu' }, 1), /重新填写 Key/);
  const updated = await vault.save({ ...input(), id: p.id, key: undefined, name: 'Renamed' }, 1);
  assert.equal(updated.revision, 2); assert.equal(updated.credentialRevision, 1);
  await assert.rejects(vault.withCredential(p.id, 1, async () => {}), /修订/);
  const rebound = await vault.save({ ...input(), id: p.id, baseUrl: 'https://other.invalid/prefix' }, 2);
  assert.equal(rebound.credentialRevision, 2); assert.equal(rebound.baseUrl, 'https://other.invalid/prefix');
  await vault.remove(p.id, 3); assert.deepEqual(vault.list(), []);
});

test('crypto unavailable/corrupt failures are explicit and do not expose native error text or replace saved state', async () => {
  const root = fixture(), vault = new ProviderVault(root, crypto), p = await vault.save(input(), 0);
  await assert.rejects(new ProviderVault(root, { ...crypto, isAsyncEncryptionAvailable: async () => false }).save({ ...input(), id: p.id }, 1), /加密不可用/);
  await assert.rejects(new ProviderVault(root, { ...crypto, encryptStringAsync: async () => { throw Error(key); } }).save({ ...input(), id: p.id }, 1), error => String(error).includes('加密失败') && !String(error).includes(key));
  await assert.rejects(new ProviderVault(root, { ...crypto, decryptStringAsync: async () => { throw Error(key); } }).withCredential(p.id, 1, async () => {}), error => String(error).includes('无法解密') && !String(error).includes(key));
  assert.deepEqual(vault.list(), [p]);
  const file = join(root, '.mixcat/comfy/providers.json'), data = JSON.parse(readFileSync(file, 'utf8'));
  data.entries[0].profile.baseUrl = 'https://tampered.invalid/'; writeFileSync(file, JSON.stringify(data));
  await assert.rejects(vault.withCredential(p.id, 1, async () => { assert.fail('tampered binding reached provider'); }), /无法解密/);
});

test('native shouldReEncrypt rotates ciphertext atomically without changing credential/profile identity', async () => {
  const root = fixture(), vault = new ProviderVault(root, crypto), p = await vault.save(input(), 0);
  const file = join(root, '.mixcat/comfy/providers.json'), before = readFileSync(file, 'utf8');
  const rotatedCrypto: CredentialCrypto = { ...crypto,
    decryptStringAsync: async value => ({ ...(await crypto.decryptStringAsync(value[0] === 0xa5 ? value.subarray(1) : value)), shouldReEncrypt: value[0] !== 0xa5 }),
    encryptStringAsync: async value => Buffer.concat([Buffer.from([0xa5]), await crypto.encryptStringAsync(value)]),
  };
  const rotated = new ProviderVault(root, rotatedCrypto);
  await rotated.withCredential(p.id, 1, async c => assert.equal(c.key, key));
  assert.notEqual(readFileSync(file, 'utf8'), before); assert.deepEqual(rotated.list(), [p]);
  await new ProviderVault(root, rotatedCrypto).withCredential(p.id, 1, async c => assert.equal(c.key, key));
});

test('URL validation preserves explicit prefixes, requires HTTP choice and excludes URL credentials', async () => {
  const vault = new ProviderVault(fixture(), crypto);
  for (const baseUrl of ['file:///tmp/key', 'https://user:secret@example.invalid/api', 'https://example.invalid/api?api_key=fake', 'https://example.invalid/api#token', 'http://localhost:1234/v1']) await assert.rejects(vault.save({ ...input(), baseUrl }, 0), /基址|HTTP/);
  const p = await vault.save({ ...input(), baseUrl: 'http://localhost:1234/custom/v1/', allowInsecureHttp: true }, 0);
  assert.equal(p.baseUrl, 'http://localhost:1234/custom/v1/');
  const mm = await vault.save({ ...input(), protocol: 'minimax-cn', videoApi: 'v2', models: { video: 'MiniMax-Hailuo-2.3' } }, 0);
  assert.equal(mm.videoApi, 'v2'); assert.equal(mm.models.video, 'MiniMax-Hailuo-2.3');
});

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
test('concurrent saves compare revision after async crypto, and active credential callbacks reject mutation', async () => {
  const entered = deferred(), release = deferred(), root = fixture();
  let hold = false;
  const vault = new ProviderVault(root, { ...crypto, encryptStringAsync: async value => { if (hold) { entered.resolve(); await release.promise; } return crypto.encryptStringAsync(value); } });
  const p = await vault.save(input(), 0); hold = true;
  const first = vault.save({ ...input(), id: p.id, name: 'First' }, 1); await entered.promise;
  const second = vault.save({ ...input(), id: p.id, name: 'Second' }, 1); release.resolve();
  await first; await assert.rejects(second, /修订/); assert.equal(vault.list()[0].name, 'First');
  const using = deferred(), done = deferred();
  const call = vault.withCredential(p.id, 2, async () => { using.resolve(); await done.promise; }); await using.promise;
  await assert.rejects(vault.remove(p.id, 2), /活动任务/);
  await assert.rejects(vault.save({ ...input(), id: p.id }, 2), /活动任务/);
  done.resolve(); await call; await vault.remove(p.id, 2);
});

test('trusted settings rejects alien frames, foreign/deleted projects and invalidated async ownership without writing', async () => {
  const root = fixture(), project = { id: 'comfy-test', root, template: 'comfyui' }, entered = deferred(), release = deferred();
  let state: ProviderSettingsContext = { owner: {}, epoch: 1, snapshot: { projects: [project], selected: { project } } as AppSnapshot };
  let blocked = false;
  const service = new ProviderSettingsService({ ...crypto, encryptStringAsync: async value => { entered.resolve(); await release.promise; return crypto.encryptStringAsync(value); } }, () => state, () => { if (blocked) throw Error('活动任务引用'); });
  const save = { projectId: project.id, op: 'save' as const, input: input(), expectedRevision: 0 };
  await assert.rejects(service.handle(save, () => { throw Error('非可信 frame'); }), /非可信/);
  await assert.rejects(service.handle({ ...save, projectId: 'foreign' }, () => {}), /失效/);
  const pending = service.handle(save, () => {}); await entered.promise;
  state = { ...state, epoch: 2 }; release.resolve(); await assert.rejects(pending, /上下文/);
  assert.deepEqual(await service.handle({ projectId: project.id, op: 'list' }, () => {}), []);
  const [p] = await service.handle(save, () => {}); blocked = true;
  await assert.rejects(service.handle({ projectId: project.id, op: 'remove', id: p.id, expectedRevision: 1 }, () => {}), /活动任务/);
  await assert.rejects(service.handle({ ...save, input: { ...input(), id: p.id }, expectedRevision: 1 }, () => {}), /活动任务/);
  blocked = false; state = { ...state, owner: undefined };
  await assert.rejects(service.handle(save, () => {}), /失效/);
  state = { ...state, owner: {}, snapshot: { projects: [], selected: null } as unknown as AppSnapshot };
  await assert.rejects(service.handle(save, () => {}), /失效/);
  assert(!JSON.stringify(state.snapshot).includes(key));
});

test('settings reauthorize native frame and live worker after asynchronous encryption/decryption', async () => {
  for (const change of ['frame', 'worker', 'deleted', 'navigation'] as const) {
    const root = fixture(), project = { id: 'comfy-test', root, template: 'comfyui' }, entered = deferred(), release = deferred();
    let state: ProviderSettingsContext = { owner: {}, epoch: 1, snapshot: { projects: [project], selected: { project } } as AppSnapshot }, trusted = true;
    const service = new ProviderSettingsService({ ...crypto, encryptStringAsync: async value => { entered.resolve(); await release.promise; return crypto.encryptStringAsync(value); } }, () => state, () => {});
    const pending = service.handle({ projectId: project.id, op: 'save', input: input(), expectedRevision: 0 }, () => { if (!trusted) throw Error('非可信 frame'); });
    await entered.promise;
    if (change === 'frame') trusted = false;
    if (change === 'worker') state = { ...state, owner: {} };
    if (change === 'deleted') state = { ...state, snapshot: { projects: [], selected: null } as unknown as AppSnapshot };
    if (change === 'navigation') state = { ...state, settingsReady: false };
    release.resolve(); await assert.rejects(pending, /非可信|上下文|失效/);
    assert.deepEqual(new ProviderVault(root, crypto).list(), []);
  }
  const root = fixture(), project = { id: 'comfy-test', root, template: 'comfyui' }, entered = deferred(), release = deferred();
  let state: ProviderSettingsContext = { owner: {}, epoch: 1, snapshot: { projects: [project], selected: { project } } as AppSnapshot };
  const p = await new ProviderVault(root, crypto).save(input(), 0);
  const service = new ProviderSettingsService({ ...crypto, decryptStringAsync: async value => { entered.resolve(); await release.promise; return crypto.decryptStringAsync(value); } }, () => state, () => {});
  const call = service.withCredential(project.id, p.id, 1, async () => assert.fail('stale owner reached provider'));
  await entered.promise; state = { ...state, owner: undefined }; release.resolve(); await assert.rejects(call, /失效/);
});

test('persistent guard blocks active revisions and allows mutation only after references are released', async () => {
  const root = fixture(), project = { id: 'comfy-test', root, template: 'comfyui' };
  const state: ProviderSettingsContext = { owner: {}, epoch: 1, snapshot: { projects: [project], selected: { project } } as AppSnapshot };
  let reference: { id: string; revision: number } | undefined;
  const service = new ProviderSettingsService(crypto, () => state, (projectId, id, revision) => {
    assert.equal(projectId, project.id);
    if (reference?.id === id && reference.revision === revision) throw Error('活动任务引用');
  });
  const [p] = await service.handle({ projectId: project.id, op: 'save', input: input(), expectedRevision: 0 }, () => {});
  reference = { id: p.id, revision: 1 };
  await assert.rejects(service.handle({ projectId: project.id, op: 'save', input: { ...input(), id: p.id }, expectedRevision: 1 }, () => {}), /活动任务/);
  await assert.rejects(service.handle({ projectId: project.id, op: 'remove', id: p.id, expectedRevision: 1 }, () => {}), /活动任务/);
  reference = undefined;
  const [updated] = await service.handle({ projectId: project.id, op: 'save', input: { ...input(), id: p.id, key: undefined, name: 'Free' }, expectedRevision: 1 }, () => {});
  assert.equal(updated.revision, 2);
  assert.deepEqual(await service.handle({ projectId: project.id, op: 'remove', id: p.id, expectedRevision: 2 }, () => {}), []);
});

test('a reference acquired during encryption prevents publication, while unrelated credential use can continue', async () => {
  const entered = deferred(), release = deferred(), root = fixture(); let hold = false, referenced = false;
  const vault = new ProviderVault(root, { ...crypto, encryptStringAsync: async value => { if (hold) { entered.resolve(); await release.promise; } return crypto.encryptStringAsync(value); } }, { assertAccess() {}, assertMutable() { if (referenced) throw Error('活动任务引用'); } });
  const first = await vault.save(input(), 0), second = await vault.save({ ...input(), name: 'Other' }, 0);
  hold = true;
  const saving = vault.save({ ...input(), id: first.id, name: 'Must not publish' }, 1); await entered.promise;
  await vault.withCredential(second.id, 1, async c => assert.equal(c.key, key));
  referenced = true; release.resolve(); await assert.rejects(saving, /活动任务/);
  assert.equal(vault.list().find(p => p.id === first.id)?.name, 'Fake Ark');
});
