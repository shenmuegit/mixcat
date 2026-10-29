import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { insideProject, projectDirectory } from '../core/paths.js';
import type { ProviderProfile } from '../shared/comfy.js';
import type { ProviderInput } from '../shared/comfy-providers.js';

export interface CredentialCrypto {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(value: string): Promise<Buffer>;
  decryptStringAsync(value: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
}
type Entry = { profile: ProviderProfile; ciphertext: string };
export interface ProviderVaultGuard {
  assertAccess(): void;
  assertMutable(id: string, revision: number): void;
}
const protocols = ['ark', 'minimax-cn', 'minimax-global', 'vidu'];
const text = (value: unknown, max = 2048): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
function profileInput(input: ProviderInput): Omit<ProviderProfile, 'id' | 'revision' | 'credentialRevision' | 'configured'> {
  if (!input || !text(input.name, 100) || !protocols.includes(input.protocol) || !text(input.baseUrl, 8192)) throw Error('连接配置格式不正确。');
  let url: URL; try { url = new URL(input.baseUrl); } catch { throw Error('API 基址格式不正确。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('API 基址只能是无凭据、查询或片段的 HTTP(S) 地址。');
  if (url.protocol === 'http:' && input.allowInsecureHttp !== true) throw Error('使用 HTTP 连接需要明确确认。');
  if (!input.models || typeof input.models !== 'object' || Array.isArray(input.models) || Object.entries(input.models).some(([kind, id]) => !['text', 'image', 'video'].includes(kind) || !text(id, 512))) throw Error('模型 ID 格式不正确。');
  if (input.videoApi !== undefined && (!['minimax-cn', 'minimax-global'].includes(input.protocol) || !['v1', 'v2'].includes(input.videoApi))) throw Error('MiniMax 视频版本格式不正确。');
  return { name: input.name, protocol: input.protocol, baseUrl: url.href, models: { ...input.models }, ...(input.videoApi ? { videoApi: input.videoApi } : {}) };
}

/** Main-process only. Never pass credentials or this object through generic commands. */
export class ProviderVault {
  private tail: Promise<unknown> = Promise.resolve();
  private active = new Map<string, number>();
  constructor(private root: string, private crypto: CredentialCrypto, private guard: ProviderVaultGuard) { insideProject(root, join(root, '.mixcat', 'comfy', 'providers.json')); }
  private file() { return insideProject(this.root, join(this.root, '.mixcat', 'comfy', 'providers.json')); }
  private read(): Entry[] {
    this.guard.assertAccess();
    if (!existsSync(this.file())) return [];
    try {
      const data = JSON.parse(readFileSync(this.file(), 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.entries) || data.entries.length > 1000) throw Error();
      const seen = new Set<string>();
      return data.entries.map((entry: Entry) => {
        const p = entry.profile;
        if (!p || !text(p.id, 128) || seen.has(p.id) || !Number.isSafeInteger(p.revision) || p.revision < 1 || !Number.isSafeInteger(p.credentialRevision) || p.credentialRevision < 1 || typeof entry.ciphertext !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(entry.ciphertext)) throw Error();
        seen.add(p.id);
        return { profile: { ...profileInput({ ...p, allowInsecureHttp: true }), id: p.id, revision: p.revision, credentialRevision: p.credentialRevision, configured: true }, ciphertext: entry.ciphertext };
      });
    } catch { throw Error('供应商凭据文件损坏，无法读取。'); }
  }
  list(): ProviderProfile[] { return this.read().map(entry => entry.profile); }
  private serial<T>(action: () => Promise<T>): Promise<T> { const result = this.tail.then(action); this.tail = result.catch(() => {}); return result; }
  private mutable(profile: ProviderProfile) {
    this.guard.assertAccess();
    if (this.active.has(profile.id)) throw Error('连接仍被活动任务引用，暂不能修改或移除。');
    this.guard.assertMutable(profile.id, profile.revision);
  }
  private write(entries: Entry[]) {
    this.guard.assertAccess();
    const directory = projectDirectory(this.root, '.mixcat', 'comfy'), temp = insideProject(this.root, join(directory, `providers-${randomUUID()}.tmp`));
    try {
      const fd = openSync(temp, 'wx', 0o600);
      try { writeFileSync(fd, JSON.stringify({ version: 1, entries })); fsyncSync(fd); } finally { closeSync(fd); }
      this.guard.assertAccess(); renameSync(temp, this.file());
    } catch { throw Error('供应商凭据未保存，请核对项目状态后重试。'); }
    finally { if (existsSync(temp)) unlinkSync(temp); }
  }
  private async available() { try { if (await this.crypto.isAsyncEncryptionAvailable()) return; } catch {} throw Error('系统凭据加密不可用。'); }
  save(input: ProviderInput, expectedRevision: number, assertCurrent = () => {}): Promise<ProviderProfile> {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['id', 'name', 'protocol', 'baseUrl', 'models', 'videoApi', 'key', 'allowInsecureHttp'].includes(key)) || input.id !== undefined && !text(input.id, 128)) return Promise.reject(Error('连接配置格式不正确。'));
    // Copy at entry so a caller cannot change the address/key while native crypto awaits.
    const frozen = structuredClone(input);
    return this.serial(async () => {
      assertCurrent();
      const fields = profileInput(frozen);
      const entries = this.read(), old = entries.find(entry => entry.profile.id === frozen.id);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || (old ? old.profile.revision !== expectedRevision : expectedRevision !== 0 || frozen.id !== undefined)) throw Error('连接修订已变更，请重新载入。');
      if (old) this.mutable(old.profile);
      const hasKey = frozen.key !== undefined && frozen.key !== '';
      if (hasKey && !text(frozen.key, 16384)) throw Error('API Key 格式不正确。');
      if (!old && !hasKey) throw Error('请填写 API Key。');
      if (old && !hasKey && (old.profile.baseUrl !== fields.baseUrl || old.profile.protocol !== fields.protocol)) throw Error('更换 API 基址或协议后必须重新填写 Key。');
      const profile: ProviderProfile = { ...fields, id: old?.profile.id ?? randomUUID(), revision: (old?.profile.revision ?? 0) + 1, credentialRevision: (old?.profile.credentialRevision ?? 0) + (hasKey ? 1 : 0), configured: true };
      let ciphertext = old?.ciphertext ?? '';
      await this.available();
      if (hasKey) {
        try { ciphertext = (await this.crypto.encryptStringAsync(JSON.stringify({ id: profile.id, protocol: profile.protocol, baseUrl: profile.baseUrl, credentialRevision: profile.credentialRevision, key: frozen.key }))).toString('base64'); }
        catch { throw Error('系统凭据加密失败。'); }
      } else if (old) { ciphertext = (await this.decrypt(old)).ciphertext; }
      assertCurrent(); this.guard.assertAccess(); if (old) this.mutable(old.profile);
      const current = this.read();
      if (old && current.find(entry => entry.profile.id === old.profile.id)?.profile.revision !== expectedRevision) throw Error('连接修订已变更，请重新载入。');
      this.write([...current.filter(entry => entry.profile.id !== profile.id), { profile, ciphertext }]);
      return structuredClone(profile);
    });
  }
  remove(id: string, expectedRevision: number, assertCurrent = () => {}): Promise<void> {
    return this.serial(async () => {
      assertCurrent();
      const entries = this.read(), old = entries.find(entry => entry.profile.id === id);
      if (!old || old.profile.revision !== expectedRevision) throw Error('连接修订已变更，请重新载入。');
      this.mutable(old.profile); this.write(entries.filter(entry => entry !== old));
    });
  }
  private async decrypt(entry: Entry): Promise<{ key: string; ciphertext: string }> {
    await this.available();
    try {
      const decrypted = await this.crypto.decryptStringAsync(Buffer.from(entry.ciphertext, 'base64')), value = JSON.parse(decrypted.result), p = entry.profile;
      if (value.id !== p.id || value.protocol !== p.protocol || value.baseUrl !== p.baseUrl || value.credentialRevision !== p.credentialRevision || !text(value.key, 16384)) throw Error();
      const ciphertext = decrypted.shouldReEncrypt ? (await this.crypto.encryptStringAsync(decrypted.result)).toString('base64') : entry.ciphertext;
      return { key: value.key, ciphertext };
    } catch { throw Error('系统凭据无法解密，请在设置中重新绑定 Key。'); }
  }
  async withCredential<T>(id: string, revision: number, fn: (credential: { profile: ProviderProfile; key: string }) => Promise<T>, assertCurrent = () => {}): Promise<T> {
    assertCurrent(); this.guard.assertAccess();
    const entry = this.read().find(entry => entry.profile.id === id);
    if (!entry || entry.profile.revision !== revision) throw Error('连接修订已变更，请重新载入。');
    this.active.set(id, (this.active.get(id) ?? 0) + 1);
    try {
      const decrypted = await this.decrypt(entry); assertCurrent(); this.guard.assertAccess();
      if (decrypted.ciphertext !== entry.ciphertext) this.write(this.read().map(current => current.profile.id === id ? { profile: current.profile, ciphertext: decrypted.ciphertext } : current));
      return await fn({ profile: entry.profile, key: decrypted.key });
    } finally { const remaining = this.active.get(id)! - 1; remaining ? this.active.set(id, remaining) : this.active.delete(id); }
  }
}
