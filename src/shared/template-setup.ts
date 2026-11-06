import type { BuiltinTemplateId } from './templates.js';

export type TemplateCapabilityId = 'ecc' | 'superpowers' | 'planning-with-files' | 'ponytail' | 'gitnexus' | 'impeccable';
export type TemplateCapabilityState = 'missing' | 'existing' | 'installing' | 'installed' | 'skipped' | 'failed' | 'unknown' | 'needs_auth';
export interface ExistingTemplateCapability { scope: 'project' | 'codex'; name: string; version?: string; fingerprint: string; }
export interface TemplateCapabilityItem {
  id: TemplateCapabilityId; name: string; kind: 'plugin' | 'skill'; skills: string[];
  existing: ExistingTemplateCapability[]; state: TemplateCapabilityState; message?: string;
}
export interface TemplateSetupProgress { status: 'pending' | 'ready' | 'partial'; items: TemplateCapabilityItem[]; }
export interface TemplateSetupReport extends TemplateSetupProgress {
  projectId: string; template: BuiltinTemplateId; target: string; observation: string; needsChoices: boolean; blocked?: boolean; message?: string;
}
export interface TemplateSetupDecision { observation: string; choices: Partial<Record<TemplateCapabilityId, 'overwrite' | 'skip'>>; }
