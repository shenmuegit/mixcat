import type { RunView } from '../shared/comfy.js';
import type { ComfyPromptResponse } from '../shared/comfy-bridge.js';

const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const identifier = (value: unknown): string => typeof value === 'string' && /^[\w.:-]{1,64}$/.test(value) && !/(?:sk-|bearer|secret|token|password)/i.test(value) ? value : '';
const validationCauses: Record<string, string> = {
  no_prompt: 'No prompt provided', invalid_prompt_id: 'Invalid prompt identifier',
  prompt_no_outputs: 'Prompt has no output nodes', prompt_outputs_failed_validation: 'Prompt outputs failed validation',
  invalid_prompt: 'Invalid prompt', invalid_node_type: 'Node type is not installed', missing_node_type: 'Node class type is missing',
  required_input_missing: 'Required input is missing', return_type_mismatch: 'Connected output type does not match input',
  bad_linked_input: 'Invalid input link', invalid_input_type: 'Invalid input type', value_not_in_list: 'Value is not an available option',
  value_smaller_than_min: 'Value is below the minimum', value_bigger_than_max: 'Value exceeds the maximum',
  custom_validation_failed: 'Node input validation failed', exception_during_validation: 'Exception during input validation',
  exception_during_inner_validation: 'Exception during linked input validation',
};
export function nativeSubmissionOutcome(response: ComfyPromptResponse | undefined, promptId: string): Pick<RunView, 'status' | 'error'> {
  if (response?.status === 200 && response.body?.prompt_id === promptId) return { status: 'queued' };
  const body = record(response?.body), error = record(body.error);
  // These are the pinned server's prequeue validation and admission emitters. A consumed ID can already be queued.
  if (response?.status === 400 && Object.keys(body).length === 2 && Object.hasOwn(body, 'error') && Object.hasOwn(body, 'node_errors')
    && body.node_errors && typeof body.node_errors === 'object' && !Array.isArray(body.node_errors) && typeof error.message === 'string'
    && ['no_prompt', 'invalid_prompt_id', 'missing_node_type', 'prompt_no_outputs', 'prompt_outputs_failed_validation'].includes(error.type)) {
    return { status: 'failed', error: nativeValidationError(body) };
  }
  if (response?.status === 403 && Object.keys(body).length === 1 && body.error === 'Mixcat admission required') {
    return { status: 'failed', error: { code: 'native_submission_failed', message: 'Native admission refused the request before queueing.' } };
  }
  const http = response && Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? ` (HTTP ${response.status})` : '';
  return { status: 'submission_unknown', error: { code: 'native_submission_unknown', message: `Native submission acceptance is unconfirmed${http}. Query the original prompt; do not resubmit.` } };
}
// Native messages may interpolate entire inputs, credentials or tracebacks. Only known causes and identifiers leave this boundary.
function exceptionCause(value: unknown): string {
  if (typeof value !== 'string') return '';
  const message = value.slice(0, 4096);
  for (const [pattern, cause] of [
    [/division by zero/i, 'division by zero'], [/out of memory/i, 'out of memory'],
    [/no such file or directory|file not found/i, 'file not found'], [/size mismatch|shapes cannot be multiplied/i, 'tensor shape mismatch'],
    [/connection refused/i, 'connection refused'], [/timed? out|timeout/i, 'operation timed out'],
  ] as const) if (pattern.test(message)) return cause;
  return '';
}
export function nativeValidationError(body: unknown): NonNullable<RunView['error']> {
  const source = record(body), lines: string[] = [];
  for (const [nodeId, raw] of Object.entries(record(source.node_errors)).slice(0, 8)) {
    const node = record(raw);
    for (const rawError of (Array.isArray(node.errors) ? node.errors.slice(0, 3) : [])) {
      const error = record(rawError), extra = record(error.extra_info), type = identifier(error.type);
      const input = identifier(extra.input_name) || (type === 'required_input_missing' ? identifier(error.details) : '');
      lines.push([identifier(nodeId), identifier(node.class_type), input, type, Object.hasOwn(validationCauses, type) ? validationCauses[type] : 'Native input validation failed (unrecognized details withheld)', identifier(extra.exception_type), exceptionCause(extra.exception_message)].filter(Boolean).join(' · '));
      if (lines.length === 8) break;
    }
    if (lines.length === 8) break;
  }
  const type = identifier(record(source.error).type);
  return { code: 'native_validation_failed', message: (lines.join('\n') || [type, Object.hasOwn(validationCauses, type) ? validationCauses[type] : 'Native prompt validation failed (unrecognized details withheld)'].filter(Boolean).join(' · ')).slice(0, 960) };
}
export function nativeExecutionError(messages: unknown, promptId: string): NonNullable<RunView['error']> {
  const lines: string[] = [];
  for (const event of (Array.isArray(messages) ? messages.slice(-100) : [])) {
    if (!Array.isArray(event) || !['execution_error', 'execution_interrupted'].includes(event[0])) continue;
    const detail = record(event[1]); if (detail.prompt_id !== promptId) continue;
    lines.push([identifier(detail.node_id), identifier(detail.node_type), identifier(detail.exception_type), exceptionCause(detail.exception_message) || (event[0] === 'execution_interrupted' ? 'Native execution interrupted' : 'Native node execution failed (unrecognized details withheld)')].filter(Boolean).join(' · '));
    if (lines.length === 8) break;
  }
  return { code: 'native_execution_failed', message: (lines.join('\n') || 'Native execution failed; no safe node diagnostic was supplied.').slice(0, 960) };
}
