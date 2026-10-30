import test from 'node:test';
import assert from 'node:assert/strict';
import { checkComfyConfiguration } from '../scripts/verify-comfy-live.js';
import { fixture } from './runtime-fixture.js';
import { ProviderSettingsService } from '../src/desktop/provider-settings.js';

test('live check defaults to metadata only and refuses generation or unknown selections', async t => {
  const f = await fixture(t, undefined, 'comfyui');
  const snapshot = (await f.engine.command({ type: 'snapshot' })).snapshot;
  const project = snapshot.selected!.project, crypto = { isAsyncEncryptionAvailable: async () => true, encryptStringAsync: async (value: string) => Buffer.from(value), decryptStringAsync: async () => { throw Error('Must not decrypt'); } };
  const owner = {}; const settings = new ProviderSettingsService(crypto, () => ({ owner, epoch: 0, snapshot }), () => {});
  const profiles = await settings.handle({ projectId: project.id, op: 'save', expectedRevision: 0, input: { name: 'Fixture', protocol: 'ark', baseUrl: 'https://private.invalid/secret-path', key: 'fake-only-secret', models: { image: 'test-model' } } }, () => {});
  const result = checkComfyConfiguration(['--project', project.root, '--provider', profiles[0].id]);
  assert.equal(result.status, 'configured_only'); assert.equal(result.liveValidated, false);
  assert.deepEqual(result.models, { image: 'test-model' });
  assert(!JSON.stringify(result).includes('secret')); assert(!JSON.stringify(result).includes('private.invalid'));
  assert.throws(() => checkComfyConfiguration(['--project', project.root, '--provider', 'missing']), /连接/);
  assert.throws(() => checkComfyConfiguration(['--project', project.root, '--provider', profiles[0].id, '--accept-live']), /只读/);
});
