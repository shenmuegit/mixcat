import type { AppSnapshot } from '../shared/types.js';
import type { ProviderSettingsReply, ProviderSettingsRequest } from '../shared/comfy-providers.js';
import { ProviderVault, type CredentialCrypto } from './provider-vault.js';
import type { ProviderProfile } from '../shared/comfy.js';

export interface ProviderSettingsContext { owner: object | undefined; epoch: number; snapshot: AppSnapshot | undefined; settingsReady?: boolean; }
/** Narrow main-only seam: Task 6 supplies durable active provider-job references. */
export type ProviderReferenceGuard = (projectId: string, connectionId: string, revision: number) => void;
export class ProviderSettingsService {
  private vaults = new Map<string, ProviderVault>();
  constructor(private crypto: CredentialCrypto, private context: () => ProviderSettingsContext, private assertMutable: ProviderReferenceGuard) {}
  private project(projectId: string, selected = true) {
    const state = this.context(), project = state.snapshot?.projects.find(p => p.id === projectId);
    if (!state.owner || !project || project.unavailable || project.template !== 'comfyui' || selected && (state.settingsReady === false || state.snapshot?.selected?.project.id !== projectId)) throw Error('供应商设置所属项目已失效，请重新打开项目。');
    return { state, project };
  }
  private vault(projectId: string, root: string) {
    let vault = this.vaults.get(projectId);
    if (!vault) {
      vault = new ProviderVault(root, this.crypto, {
        assertAccess: () => { if (this.project(projectId, false).project.root !== root) throw Error('项目目录已变更。'); },
        assertMutable: (id, revision) => this.assertMutable(projectId, id, revision),
      });
      this.vaults.set(projectId, vault);
    }
    return vault;
  }
  async handle(request: ProviderSettingsRequest, authorize: () => void): Promise<ProviderSettingsReply> {
    authorize();
    if (!request || typeof request.projectId !== 'string' || !['list', 'save', 'remove'].includes(request.op)) throw Error('供应商设置请求格式不正确。');
    const { state, project } = this.project(request.projectId);
    const owner = state.owner, epoch = state.epoch, root = project.root;
    const assertCurrent = () => {
      authorize(); const now = this.project(request.projectId);
      if (now.state.owner !== owner || now.state.epoch !== epoch || now.project.root !== root) throw Error('供应商设置上下文已变更，请重新打开设置。');
    };
    const vault = this.vault(request.projectId, project.root);
    if (request.op === 'save') await vault.save(request.input, request.expectedRevision, assertCurrent);
    else if (request.op === 'remove') await vault.remove(request.id, request.expectedRevision, assertCurrent);
    assertCurrent(); return vault.list();
  }
  /** Internal provider broker only; the callback result must never contain credentials. */
  async withCredential<T>(projectId: string, id: string, revision: number, fn: (credential: { profile: ProviderProfile; key: string }) => Promise<T>): Promise<T> {
    const { state, project } = this.project(projectId, false);
    const owner = state.owner, root = project.root;
    const assertCurrent = () => { const now = this.project(projectId, false); if (now.state.owner !== owner || now.project.root !== root) throw Error('供应商任务所属项目已失效。'); };
    return this.vault(projectId, project.root).withCredential(id, revision, fn, assertCurrent);
  }
}
