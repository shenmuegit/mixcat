import { useState } from 'react';
import type { PendingNativeRequest } from '../shared/types';

export function NativeRequestCard({ request, item, onRespond, onError, onOpenUrl }: { request: PendingNativeRequest; item?: unknown; onRespond: (result: unknown) => Promise<void>; onError: (error: string) => void; onOpenUrl?: (url: string) => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [raw, setRaw] = useState('{}');
  const [sending, setSending] = useState(false);
  const params = request.params ?? {};
  async function respond(result: unknown) { setSending(true); try { await onRespond(result); } catch (error) { onError(error instanceof Error ? error.message : String(error)); } finally { setSending(false); } }
  const isApproval = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(request.method);
  const isQuestion = request.method === 'item/tool/requestUserInput';
  const isPermissions = request.method === 'item/permissions/requestApproval';
  const isElicitation = request.method === 'mcpServer/elicitation/request';
  const isUrlElicitation = isElicitation && params.mode === 'url';
  const decisions: unknown[] = Array.isArray(params.availableDecisions) ? params.availableDecisions : ['decline', 'accept'];
  const decisionLabel = (decision: unknown) => decision === 'accept' ? '批准这次操作' : decision === 'acceptForSession' ? '批准本会话' : decision === 'decline' ? '拒绝' : decision === 'cancel' ? '取消' : '确认所列规则';
  return <section className="native-request" aria-label="Codex 等待你的响应"><div className="feed-meta"><strong>{isApproval || isPermissions ? 'Codex 请求批准' : isQuestion ? 'Codex 需要你的回答' : isElicitation ? '插件请求信息' : '原生请求'}</strong></div>
    {params.reason && <p>{params.reason}</p>}{params.command && <pre className="result-json">{typeof params.command === 'string' ? params.command : JSON.stringify(params.command, null, 2)}</pre>}
    {params.cwd && <p className="field-note">工作目录：{params.cwd}</p>}
    {request.method === 'item/fileChange/requestApproval' && <><p className="field-note">{params.grantRoot ? `请求写入目录：${params.grantRoot}` : '请求应用文件变更'}</p><pre className="result-json">{JSON.stringify(item ?? params, null, 2)}</pre></>}
    {isQuestion && <form onSubmit={event => { event.preventDefault(); void respond({ answers: Object.fromEntries((params.questions ?? []).map((q: any) => [q.id, { answers: [answers[q.id] ?? ''] }])) }); }}>
      {(params.questions ?? []).map((question: any) => <label key={question.id}>{question.question}<input required type={question.isSecret ? 'password' : 'text'} value={answers[question.id] ?? ''} list={`options-${request.key}-${question.id}`} onChange={e => setAnswers(current => ({ ...current, [question.id]: e.target.value }))} /><datalist id={`options-${request.key}-${question.id}`}>{question.options?.map((option: any) => <option key={option.label} value={option.label}>{option.description}</option>)}</datalist></label>)}
      <button className="button primary" disabled={sending}>提交回答</button>
    </form>}
    {isApproval && <div className="approval-actions">{decisions.map((decision, index) => <div key={index}>{typeof decision === 'object' && <pre className="result-json">{JSON.stringify(decision, null, 2)}</pre>}<button className={`button ${decision === 'decline' || decision === 'cancel' ? 'secondary' : 'primary'}`} disabled={sending} onClick={() => void respond({ decision })}>{decisionLabel(decision)}</button></div>)}</div>}
    {isPermissions && <><pre className="result-json">{JSON.stringify(params.permissions, null, 2)}</pre><div className="approval-actions"><button className="button secondary" disabled={sending} onClick={() => void respond({ permissions: {}, scope: 'turn' })}>拒绝</button><button className="button primary" disabled={sending} onClick={() => void respond({ permissions: params.permissions, scope: 'turn' })}>批准本轮所列权限</button></div></>}
    {isUrlElicitation && <><p>{params.message}</p><button className="text-button" onClick={() => onOpenUrl?.(params.url)}>打开插件授权页面</button><div className="approval-actions"><button className="button secondary" disabled={sending} onClick={() => void respond({ action: 'cancel', content: null, _meta: null })}>取消</button><button className="button primary" disabled={sending} onClick={() => void respond({ action: 'accept', content: null, _meta: null })}>我已完成授权</button></div></>}
    {!isApproval && !isQuestion && !isPermissions && !isUrlElicitation && <><p>{params.message ?? request.method}</p><details><summary>请求详情</summary><pre className="result-json">{JSON.stringify(params, null, 2)}</pre></details><label>响应内容（JSON）<textarea value={raw} onChange={e => setRaw(e.target.value)} rows={5} spellCheck={false} /></label><div className="approval-actions">{isElicitation && <button className="button secondary" disabled={sending} onClick={() => void respond({ action: 'cancel', content: null, _meta: null })}>取消</button>}<button className="button primary" disabled={sending} onClick={() => { try { const value = JSON.parse(raw); void respond(isElicitation ? { action: 'accept', content: value, _meta: null } : value); } catch { onError('响应必须是有效的 JSON。'); } }}>提交响应</button></div></>}
  </section>;
}
