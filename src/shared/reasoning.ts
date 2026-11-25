import type { ModelCapability } from './types.js';

export function workflowDefaultReasoningEffort(model?: ModelCapability): string | undefined {
  if (model?.supportedReasoningEfforts?.some(option => option.reasoningEffort === 'max')) return 'max';
  return model?.defaultReasoningEffort ?? undefined;
}
