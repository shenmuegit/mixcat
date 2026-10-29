import type { ProviderProfile } from './comfy.js';

export interface ProviderInput {
  id?: string; name: string; protocol: ProviderProfile['protocol']; baseUrl: string;
  models: ProviderProfile['models']; videoApi?: 'v1' | 'v2'; key?: string; allowInsecureHttp?: boolean;
}
export type ProviderSettingsRequest = { projectId: string } & (
  | { op: 'list' }
  | { op: 'save'; input: ProviderInput; expectedRevision: number }
  | { op: 'remove'; id: string; expectedRevision: number }
);
export type ProviderSettingsReply = ProviderProfile[];
