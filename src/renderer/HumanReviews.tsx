import { useEffect, useId, useRef, useState } from 'react';
import type { AppCommand, AppReply, HumanReviewPolicy, HumanReviewView, NodeView, ProjectSummary, TaskView } from '../shared/types';
import { reviewDependencies, reviewGate } from '../shared/review-gate';

const reviewLabels = { pending: '待人工核对', approved: '已通过', changes_requested: '已提出修改', withdrawn: '已撤回', superseded: '已被替代' };
export type ReviewAction = { id: string; command: AppCommand; state: 'sending' | 'unknown' | 'failed'; error?: string };
export function HumanReviews({ project, policy, reviews, tasks, nodes, execute, onOpen, onError, nodeId, actionStore, answerDrafts, onAnswerChange }: {
  project: ProjectSummary; policy: HumanReviewPolicy; reviews: HumanReviewView[]; tasks: TaskView[]; nodes: NodeView[];
  execute: (command: AppCommand, actionId?: string) => Promise<AppReply | null>;
  onOpen: (nodeId: string, resource: { path?: string; url?: string }) => void; onError: (error: string) => void; nodeId?: string; actionStore?: Map<string, ReviewAction>;
  answerDrafts?: Record<string, string>; onAnswerChange?: (reviewId: string, answer: string) => void;
}) {
  const localActions = useRef(new Map<string, ReviewAction>());
  const actions = actionStore ?? localActions.current;
  const [, refresh] = useState(0);
  const actionKey = (key: string) => JSON.stringify([project.id, key]);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function send(key: string, command: AppCommand) {
    key = actionKey(key);
    const previous = actions.get(key);
    if (previous?.state === 'sending') return;
    const action = previous && previous.state !== 'failed' ? previous : { id: crypto.randomUUID(), command, state: 'sending' as const };
    actions.set(key, { ...action, state: 'sending' }); refresh(value => value + 1);
    let reply: AppReply | null = null;
    try { reply = await execute(action.command, action.id); }
    catch (error) { if (alive.current) onError(error instanceof Error ? error.message : String(error)); }
    let failure: string | undefined;
    if (!reply) {
      try {
        const receipt = await window.mixcat.inspect(action.id);
        if (receipt.id === action.id && (receipt.status === 'failed' || receipt.status === 'cancelled')) failure = receipt.error || '操作已失败或取消。';
      } catch { /* A missing receipt keeps the original command unresolved. */ }
    }
    actions.set(key, { ...action, state: failure ? 'failed' : 'unknown', ...(failure ? { error: failure } : {}) });
    if (alive.current) refresh(value => value + 1);
  }
  const checkpoints = [...new Set([...policy.checkpoints.map(point => point.id), ...reviews.map(review => review.checkpointId)])];
  return <section className="human-reviews" aria-label="人工核对事项">
    {tasks.filter(task => task.status === 'running' && (!nodeId || task.nodeId === nodeId)).map(task => <RunningReviewWarning key={task.id} task={task} policy={policy} reviews={reviews} />)}
    {checkpoints.map(checkpointId => {
      const versions = reviews.filter(review => review.checkpointId === checkpointId).sort((a, b) => b.version - a.version);
      const current = versions[0];
      if (!current || nodeId && !versions.some(review => review.nodeId === nodeId)) return null;
      const older = versions.slice(1).filter(review => !nodeId || review.nodeId === nodeId);
      const card = (review: HumanReviewView, latest: boolean) => <ReviewCard key={`${project.id}:${review.id}:${review.version}:${review.bundleHash}`} review={review} latest={latest} project={project} nodes={nodes} policy={policy} action={actions.get(actionKey(review.id))} onSend={command => void send(review.id, command)} onOpen={onOpen} answerDraft={answerDrafts?.[review.id]} onAnswerChange={onAnswerChange ? answer => onAnswerChange(review.id, answer) : undefined} />;
      return <div key={checkpointId}>
        {(!nodeId || current.nodeId === nodeId) && card(current, true)}
        {older.length > 0 && <details className="review-history"><summary>版本历史 · {older.length} 个旧版本</summary>{older.map(review => card(review, false))}</details>}
      </div>;
    })}
    {tasks.filter(task => task.status === 'waiting_review' && (!nodeId || task.nodeId === nodeId)).map(task => <WaitingReviewTask key={task.id} task={task} action={actions.get(actionKey(task.id))} onSend={() => void send(task.id, { type: 'cancel_review_task', projectId: project.id, taskId: task.id })} />)}
  </section>;
}

function RunningReviewWarning({ task, policy, reviews }: { task: TaskView; policy: HumanReviewPolicy; reviews: HumanReviewView[] }) {
  const state = { reviewPolicy: policy, humanReviews: reviews }, captured = [...(task.reviewDependencies ?? [])];
  const visited = new Set<string>();
  for (let index = 0; index < captured.length; index++) {
    const dependency = captured[index];
    if (!dependency.reviewId || visited.has(dependency.reviewId)) continue;
    visited.add(dependency.reviewId);
    const review = reviews.find(item => item.id === dependency.reviewId && item.version === dependency.version);
    if (review) captured.push(...review.upstreamDependencies);
  }
  const gate = reviewGate(state, task.reviewDependencies ?? []);
  const added = reviewDependencies(state, task.nodeId).filter(dependency => !reviews.some(review => review.id === dependency.reviewId && review.kind === 'question') && !captured.some(item => item.checkpointId === dependency.checkpointId));
  if (gate.state !== 'stale' && !added.length) return null;
  const ids = [...new Set([...(gate.state === 'stale' ? gate.checkpointIds : []), ...added.map(item => item.checkpointId)])];
  return <div className="inline-warning" role="status">运行中任务的核对依据已过期（{task.id}）。实际执行仍在继续；可使用现有暂停或停止控制，重新核对后再安排新任务。
    {ids.map(id => { const dependency = captured.find(item => item.checkpointId === id), point = policy.checkpoints.find(item => item.id === id); return <p key={id}>{point?.name ?? id}：{dependency ? `已捕获版本 ${dependency.version ?? '未提交'}，规则修订 ${dependency.checkpointRevision}` : '新增适用核对规则，任务尚未捕获'}；{point ? `当前规则修订 ${point.revision}` : '规则已移除'}。</p>; })}
  </div>;
}

function ActionStatus({ action, onRetry }: { action: ReviewAction; onRetry: () => void }) {
  return action.state === 'sending' ? <p role="status">正在确认结果…</p> : <div className="inline-warning" role="status">结果尚未确认。重试将查询或提交同一决定，不会自动通过。<button type="button" className="text-button" onClick={onRetry}>重试原操作</button></div>;
}
function ReviewCard({ review, latest, project, nodes, policy, action, onSend, onOpen, answerDraft, onAnswerChange }: {
  review: HumanReviewView; latest: boolean; project: ProjectSummary; nodes: NodeView[]; policy: HumanReviewPolicy; action?: ReviewAction;
  onSend: (command: AppCommand) => void; onOpen: (nodeId: string, resource: { path?: string; url?: string }) => void;
  answerDraft?: string; onAnswerChange?: (answer: string) => void;
}) {
  const [choice, setChoice] = useState<'approved' | 'changes_requested' | 'withdraw' | null>(() => action?.state === 'failed' && action.command.type === 'decide_review' ? action.command.decision : null);
  const [comment, setComment] = useState(() => action?.command.type === 'decide_review' ? action.command.comment : '');
  const question = review.kind === 'question', answer = answerDraft ?? comment;
  const commentError = comment.length > 20000 ? `意见不能超过 20000 个字符（当前 ${comment.length} 个），请修改后再提交。` : null;
  const commentErrorId = useId();
  const button = useRef<HTMLButtonElement>(null);
  const pending = latest && review.status === 'pending';
  const resolved = action && (review.decision?.commandId === action.id || action.command.type === 'withdraw_review' && review.status === 'withdrawn');
  return <article className="review-card" data-review-id={review.id} aria-label={`${review.title} · 版本 ${review.version}`}>
    <div className="feed-meta"><strong>{question ? 'Codex 向你提问' : `${policy.checkpoints.find(point => point.id === review.checkpointId)?.name ?? review.checkpointId} · 版本 ${review.version}`}</strong><span>{question && review.status === 'approved' ? '已回答' : question && review.status === 'pending' ? '待回答' : reviewLabels[review.status]}</span></div>
    <h3 tabIndex={-1}>{review.title}</h3>
    <p className="field-note">来源：{nodes.find(node => node.id === review.nodeId)?.name ?? review.nodeId} · <time dateTime={review.createdAt}>{review.createdAt}</time></p>
    <pre className="review-body">{typeof review.content === 'string' ? review.content : JSON.stringify(review.content, null, 2)}</pre>
    {!!review.itemMaterials?.length && <section className="review-materials"><strong>关联工作项（提交时版本）</strong>{review.itemMaterials.map(item => <details key={`${item.id}:${item.commentId ?? "body"}`}><summary>{item.title}{item.commentId ? ` · 评论 · ${item.createdAt}` : ` · 版本 ${item.revision}`}</summary>{item.commentId && <small>评论 {item.commentId} · {item.author?.kind === "user" ? "我" : item.author?.nodeId ?? "节点"}</small>}<pre className="review-body">{item.body}</pre>{item.acceptance && <><strong>验收说明</strong><pre className="review-body">{item.acceptance}</pre></>}</details>)}{review.materialsCurrent === false && <p className="inline-error">关联工作项的材料已更新，需要提交新版本。</p>}</section>}
    {!!review.attachments.length && <div className="review-materials"><strong>固定材料</strong>{review.attachments.map(attachment => <div key={attachment.artifact_id}><button type="button" className="text-button" onClick={() => onOpen(review.nodeId, { path: `${project.root.replace(/[\\/]+$/, '')}/${attachment.relativePath}` })}>打开附件：{attachment.name}</button><small>SHA256 {attachment.sha256} · {attachment.size} 字节</small></div>)}</div>}
    {!question && <details><summary>来源、包哈希与上游依据</summary><dl className="review-evidence"><dt>bundleHash</dt><dd>{review.bundleHash}</dd><dt>提交来源</dt><dd>节点 {review.nodeId} · 任务 {review.taskId} · Thread {review.threadId} · Turn {review.turnId} · Call {review.callId} · 请求 {review.requestId}</dd><dt>源文件</dt><dd>{review.sourceFiles.length ? review.sourceFiles.map(file => <p key={file.path}>{file.path} · SHA256 {file.sha256} · {file.size} 字节</p>) : '无源文件引用'}</dd><dt>上游依据</dt><dd>{review.upstreamDependencies.length ? review.upstreamDependencies.map(dependency => <p key={dependency.checkpointId}>{policy.checkpoints.find(point => point.id === dependency.checkpointId)?.name ?? dependency.checkpointId} · 修订 {dependency.checkpointRevision} · {dependency.reviewId === null ? '等待首次提交' : `${dependency.reviewId} · 版本 ${dependency.version}`}</p>) : '无上游核对'}</dd></dl></details>}
    {review.decision && <div className="review-decision"><strong>{question ? '你的回答' : `用户决定：${reviewLabels[review.decision.decision]}`}</strong><time>{review.decision.createdAt}</time><pre className="review-body">{review.decision.comment}</pre>{!question && <small>决定 {review.decision.commandId} · 续接任务 {review.decision.continuationTaskId}</small>}</div>}
    {review.supersededBy && <p className="field-note">替代事项：{review.supersededBy}。旧版本决定保留，不适用于新版本。</p>}
    {action?.state === 'failed' && !resolved && <pre className="inline-error review-failure review-body" role="alert">{action.error}{'\n'}可修正问题后重新提交，或返回并撤回未决事项。</pre>}
    {action && action.state !== 'failed' && !resolved ? <ActionStatus action={action} onRetry={() => onSend(action.command)} /> : pending && (question ? <form className="form-stack question-answer" onSubmit={event => {
      event.preventDefault();
      if (answer.trim() && answer.length <= 20000) onSend({ type: 'decide_review', projectId: project.id, reviewId: review.id, version: review.version, bundleHash: review.bundleHash, decision: 'approved', comment: answer });
    }}><label>你的回答<textarea required aria-label="你的回答" value={answer} onChange={event => (onAnswerChange ?? setComment)(event.target.value)} rows={3} /></label>{answer.length > 20000 && <p className="inline-error" role="alert">回答不能超过 20000 个字符。</p>}<p className="field-note">提交后将回到提问节点的原会话；节点暂停时，回答会排队等待启用。</p><button className="button primary" disabled={!answer.trim() || answer.length > 20000}>提交回答</button></form> : <>
      {!choice ? <div className="review-actions"><button type="button" ref={button} className="button primary" onClick={() => setChoice('approved')}>通过</button><button type="button" className="button secondary" onClick={() => setChoice('changes_requested')}>提出修改</button><button type="button" className="text-button" onClick={() => setChoice('withdraw')}>撤回未决事项</button></div> : <form className="form-stack review-confirm" onSubmit={event => {
        event.preventDefault();
        if (choice !== 'withdraw' && (commentError || choice === 'changes_requested' && !comment.trim())) return;
        const identity = { projectId: project.id, reviewId: review.id, version: review.version, bundleHash: review.bundleHash };
        onSend(choice === 'withdraw' ? { type: 'withdraw_review', ...identity } : { type: 'decide_review', ...identity, decision: choice, comment });
      }}>
        <p>确认{choice === 'approved' ? '通过' : choice === 'withdraw' ? '撤回' : '提出修改'}版本 {review.version}？仅对当前固定包生效。</p>
        {choice !== 'withdraw' && <><label>原始用户意见{choice === 'changes_requested' ? '（必填）' : '（可选）'}<textarea autoFocus aria-label="原始用户意见" aria-invalid={!!commentError} aria-describedby={commentError ? commentErrorId : undefined} required={choice === 'changes_requested'} value={comment} onChange={event => setComment(event.target.value)} rows={3} /></label>{commentError && <p id={commentErrorId} className="inline-error" role="alert">{commentError}</p>}</>}
        <div className="review-actions"><button type="button" className="button secondary" onClick={() => { setChoice(null); requestAnimationFrame(() => button.current?.focus()); }}>保留未决，返回</button><button autoFocus={choice === 'withdraw'} className="button primary" disabled={choice !== 'withdraw' && (!!commentError || choice === 'changes_requested' && !comment.trim())}>确认{choice === 'approved' ? '通过' : choice === 'withdraw' ? '撤回' : '提出修改'}版本 {review.version}</button></div>
      </form>}
    </>)}
  </article>;
}
function WaitingReviewTask({ task, action, onSend }: { task: TaskView; action?: ReviewAction; onSend: () => void }) {
  const [confirm, setConfirm] = useState(false);
  return <div className="review-wait"><p>等待任务 {task.id}</p><pre className="review-body">{task.instruction}</pre>{action?.state === 'failed' && <p className="inline-error" role="alert">{action.error}</p>}{action && action.state !== 'failed' ? <ActionStatus action={action} onRetry={onSend} /> : confirm ? <div className="review-actions"><button type="button" className="button secondary" onClick={() => setConfirm(false)}>保留等待任务</button><button type="button" className="button secondary" onClick={onSend}>确认取消等待任务</button></div> : <button type="button" className="text-button" onClick={() => setConfirm(true)}>取消等待任务</button>}</div>;
}
