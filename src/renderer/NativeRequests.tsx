import { useState } from 'react';
import type { NativeServerRequest } from '../shared/types';
import { classifyNativeRequest, nativeApprovalDecisions } from '../shared/native-requests';

export function NativeRequestCard({ request, item, onRespond, onError, onOpenUrl }: { request: NativeServerRequest & { key: string }; item?: unknown; onRespond: (result: unknown) => Promise<void>; onError: (error: string) => void; onOpenUrl?: (url: string) => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [raw, setRaw] = useState('{}');
  const [sending, setSending] = useState(false);
  const params = request.params ?? {};
  async function respond(result: unknown) { setSending(true); try { await onRespond(result); } catch (error) { onError(error instanceof Error ? error.message : String(error)); } finally { setSending(false); } }
  const kind = classifyNativeRequest(request);
  const isApproval = kind === 'approval', isQuestion = kind === 'question', isPermissions = kind === 'permissions';
  const isElicitation = kind === 'elicitation-form' || kind === 'elicitation-url';
  const isUrlElicitation = kind === 'elicitation-url';
  const decisions = nativeApprovalDecisions(request);
  const decisionLabel = (decision: unknown) => ['accept', 'approved'].includes(String(decision)) ? '批准这次操作' : ['acceptForSession', 'approved_for_session'].includes(String(decision)) ? '批准本会话' : decision === 'decline' || (decision && typeof decision === 'object' && 'denied' in decision) ? '拒绝' : ['cancel', 'abort'].includes(String(decision)) ? '取消' : '确认所列规则';
  return <section className="native-request" aria-label="Codex 等待你的响应"><div className="feed-meta"><strong>{isApproval || isPermissions ? 'Codex 请求批准' : isQuestion ? 'Codex 需要你的回答' : isElicitation ? '插件请求信息' : '原生请求'}</strong></div>
    {params.reason && <p>{params.reason}</p>}{params.command && <pre className="result-json">{typeof params.command === 'string' ? params.command : JSON.stringify(params.command, null, 2)}</pre>}
    {params.cwd && <p className="field-note">工作目录：{params.cwd}</p>}
    {request.method === 'item/fileChange/requestApproval' && <><p className="field-note">{params.grantRoot ? `请求写入目录：${params.grantRoot}` : '请求应用文件变更'}</p><pre className="result-json">{JSON.stringify(item ?? params, null, 2)}</pre></>}
    {isQuestion && <form onSubmit={event => { event.preventDefault(); void respond({ answers: Object.fromEntries((params.questions ?? []).map((q: any) => [q.id, { answers: [answers[q.id] ?? ''] }])) }); }}>
      {(params.questions ?? []).map((question: any) => <label key={question.id}>{question.question}<input required type={question.isSecret ? 'password' : 'text'} value={answers[question.id] ?? ''} list={`options-${request.key}-${question.id}`} onChange={e => setAnswers(current => ({ ...current, [question.id]: e.target.value }))} /><datalist id={`options-${request.key}-${question.id}`}>{question.options?.map((option: any) => <option key={option.label} value={option.label}>{option.description}</option>)}</datalist></label>)}
      <button className="button primary" disabled={sending}>提交回答</button><button type="button" className="button secondary" disabled={sending} onClick={() => void respond({ answers: {} })}>取消回答</button>
    </form>}
    {isApproval && <div className="approval-actions">{decisions.map((decision, index) => <div key={index}>{typeof decision === 'object' && <pre className="result-json">{JSON.stringify(decision, null, 2)}</pre>}<button className={`button ${decision === 'decline' || decision === 'cancel' ? 'secondary' : 'primary'}`} disabled={sending} onClick={() => void respond({ decision })}>{decisionLabel(decision)}</button></div>)}</div>}
    {isPermissions && <><pre className="result-json">{JSON.stringify(params.permissions, null, 2)}</pre><div className="approval-actions"><button className="button secondary" disabled={sending} onClick={() => void respond({ permissions: {}, scope: 'turn' })}>拒绝</button><button className="button primary" disabled={sending} onClick={() => void respond({ permissions: params.permissions, scope: 'turn' })}>批准本轮所列权限</button></div></>}
    {isUrlElicitation && <><p>{params.message}</p><button className="text-button" onClick={() => onOpenUrl?.(params.url)}>打开插件授权页面</button><div className="approval-actions"><button className="button secondary" disabled={sending} onClick={() => void respond({ action: 'cancel', content: null, _meta: null })}>取消</button><button className="button primary" disabled={sending} onClick={() => void respond({ action: 'accept', content: null, _meta: null })}>我已完成授权</button></div></>}
    {kind === 'elicitation-form' && <><p>{params.message}</p><details><summary>请求表单 Schema</summary><pre className="result-json">{JSON.stringify(params.requestedSchema, null, 2)}</pre></details><label>表单内容（JSON，将按请求 Schema 校验）<textarea value={raw} onChange={e => setRaw(e.target.value)} rows={5} spellCheck={false} /></label><div className="approval-actions"><button className="button secondary" disabled={sending} onClick={() => void respond({ action: 'cancel', content: null, _meta: null })}>取消</button><button className="button secondary" disabled={sending} onClick={() => void respond({ action: 'decline', content: null, _meta: null })}>拒绝提供</button><button className="button primary" disabled={sending} onClick={() => { try { void respond({ action: 'accept', content: JSON.parse(raw), _meta: null }); } catch { onError('表单内容必须是有效的 JSON。'); } }}>提交表单</button></div></>}
    {(kind === 'unsupported' || kind === 'host-time') && <p role="status">宿主能力尚未接入人工响应：{request.method}。该请求由宿主处理或返回不支持。</p>}
  </section>;
}
