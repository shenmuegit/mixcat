import type { NativeServerRequest } from './types.js';

export type NativeRequestKind = 'approval' | 'question' | 'permissions' | 'elicitation-form' | 'elicitation-url' | 'host-time' | 'unsupported';
export function classifyNativeRequest(request: NativeServerRequest): NativeRequestKind {
  switch (request.method) {
    case 'item/commandExecution/requestApproval': case 'item/fileChange/requestApproval':
    case 'execCommandApproval': case 'applyPatchApproval': return 'approval';
    case 'item/tool/requestUserInput': return 'question';
    case 'item/permissions/requestApproval': return 'permissions';
    case 'currentTime/read': return 'host-time';
    case 'mcpServer/elicitation/request':
      return request.params?.mode === 'url' ? 'elicitation-url' : ['form', 'openai/form', 'openaiForm'].includes(request.params?.mode) ? 'elicitation-form' : 'unsupported';
    default: return 'unsupported';
  }
}

export function nativeApprovalDecisions(request: NativeServerRequest): unknown[] {
  const p = request.params ?? {};
  if (Array.isArray(p.availableDecisions)) return p.availableDecisions;
  // Codex 0.163.0-alpha.10.2 omits availableDecisions; v1 uses ReviewDecision.
  if (['execCommandApproval', 'applyPatchApproval'].includes(request.method)) return ['approved', 'approved_for_session', { denied: { rejection: '用户拒绝此操作' } }, 'abort'];
  const decisions: unknown[] = ['accept', 'acceptForSession', 'decline', 'cancel'];
  if (request.method === 'item/commandExecution/requestApproval') {
    if (Array.isArray(p.proposedExecpolicyAmendment)) decisions.push({ acceptWithExecpolicyAmendment: { execpolicy_amendment: p.proposedExecpolicyAmendment } });
    for (const amendment of Array.isArray(p.proposedNetworkPolicyAmendments) ? p.proposedNetworkPolicyAmendments : []) decisions.push({ applyNetworkPolicyAmendment: { network_policy_amendment: amendment } });
  }
  return decisions;
}
