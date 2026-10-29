import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FeedCollectionDetail, FeedCommand, FeedConversationEntry, FeedEntry, FeedRun, FeedRunResult, FeedSchedule } from '../shared/feed';
import { orderedConversation } from '../shared/conversation-order';
import { ProjectMarkdown, ReferenceNavigation } from './ProjectMarkdown';
import { NativeRequestCard } from './NativeRequests';
import { useFeedForm, useFeedPage, type FeedDraftPort } from './FeedForms';
import type { FeedExecute } from './FeedWorkspace';
import { Icon } from './Icon';
export const feedRunLabel = (run: Pick<FeedRun, 'status'>) => ({ queued: '已排队', waiting_account: '需要登录', starting: '正在启动', running: '执行中', stopping: '正在停止', stopped: '已停止', completed: '执行完成', failed: '执行失败', needs_reconciliation: '执行结果未知，需核对', cancelled: '已撤回' }[run.status]);
export function feedTime(value?: string | null, timeZone?: string) { if (!value || !Number.isFinite(Date.parse(value))) return '时间未确认'; try { return new Date(value).toLocaleString('zh-CN', { hourCycle: 'h23', ...(timeZone ? { timeZone } : {}) }); } catch { return value; } }
export function scheduleLabel(schedule: FeedSchedule) { return schedule.frequency === 'manual' ? '尚未设置定时' : `${schedule.frequency === 'daily' ? '每日' : `每周${['日','一','二','三','四','五','六'][schedule.weekday]}`} ${schedule.time} · ${schedule.timeZone} · ${schedule.enabled ? '定时已启用' : '定时已暂停'}`; }
export function FeedResult({ entry, collectedAt }: { entry: FeedEntry; collectedAt: string }) {
  return <article className="feed-result"><h3>{entry.title}</h3><time dateTime={collectedAt}>{feedTime(collectedAt)}</time><ReferenceNavigation.Provider value={null}><ProjectMarkdown text={entry.body} /></ReferenceNavigation.Provider></article>;
}
export function FeedMessage({ item, run }: { item: FeedConversationEntry; run?: FeedRun }) {
  if (['sessionConfiguration', 'runtimeCapabilities'].includes((item.rawItem as { type?: string } | undefined)?.type ?? '')) return null;
  const source = item.id.startsWith('input:') ? !run ? '会话输入' : run.trigger === 'schedule' ? '定时执行' : run.trigger === 'catchup' ? '补跑' : '你' : { user: '你', assistant: 'Codex', system: '系统 / 工具', unknown: '来源未确认' }[item.source];
  return <article className="feed-message"><p className="muted">{source} · {feedTime(item.createdAt)}{!item.completed && ' · 尚未完成'}</p><ProjectMarkdown text={item.text} /></article>;
}
const emptyMessage = { text: '' };
export function FeedCollection({ detail, execute, onBack, onError, drafts, revision = 0, disabled = false, active = true, onRefresh }: { detail: FeedCollectionDetail; execute: FeedExecute; onBack(): void; onError(message: string): void; drafts?: FeedDraftPort; revision?: number | string; disabled?: boolean; active?: boolean; onRefresh?(): void }) {
  const c = detail.collection;
  const [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
  const [entries, setEntries] = useState<Record<string, FeedEntry>>({});
  const [nativeCursor, setNativeCursor] = useState<string | null | undefined>();
  const heading = useRef<HTMLHeadingElement>(null), alive = useRef(true), activeRef = useRef(active); activeRef.current = active;
  useLayoutEffect(() => { heading.current?.focus(); return () => { alive.current = false; }; }, []);
  function fail(message: string) { if (alive.current) { setError(message); if (activeRef.current) onError(message); } }
  function refreshed() { setRefresh(n => n + 1); onRefresh?.(); }
  const version = `${revision}:${refresh}`;
  const history = useFeedPage<FeedConversationEntry>({ type: 'read_feed_history', collectionId: c.id }, 'history', execute, version, fail);
  const results = useFeedPage<FeedRunResult>({ type: 'list_feed_results', collectionId: c.id }, 'results', execute, version, fail);
  const runs = useFeedPage<FeedRun>({ type: 'list_feed_runs', collectionId: c.id }, 'runs', execute, version, fail);
  const resultIds = JSON.stringify(results.items.filter(item => !item.deletedAt).map(item => item.entryId));
  useEffect(() => {
    let cancelled = false;
    void Promise.all((JSON.parse(resultIds) as string[]).map(async entryId => (await execute({ type: 'get_feed_entry', entryId })).entry!)).then(values => {
      if (!cancelled) setEntries(Object.fromEntries(values.map(entry => [entry.id, entry])));
    }).catch(caught => { if (!cancelled) fail(String(caught)); });
    return () => { cancelled = true; };
  }, [c.id, resultIds, version]);
  const message = useFeedForm(`collection:${c.id}:message`, emptyMessage, drafts);
  const action = useFeedForm(`collection:${c.id}:action`, {}, drafts);
  async function perform(command: FeedCommand) { setError(''); try { await action.submit(command, execute, {}); refreshed(); } catch (caught) { fail(String(caught)); } }
  async function send() {
    setError('');
    try { await message.submit({ type: 'send_feed_message', collectionId: c.id, requestId: crypto.randomUUID(), input: { text: message.value.fields.text } }, execute, emptyMessage); refreshed(); }
    catch (caught) { fail(String(caught)); }
  }
  const blocked = disabled || !!c.deletedAt;
  const queued = runs.items.filter(run => ['queued', 'waiting_account'].includes(run.status));
  return <section className="feed-collection" aria-label="采集详情">
    <header><button className="button secondary" onClick={onBack}><Icon name="back" size={16} />返回信息流</button><h2 ref={heading} tabIndex={-1}>{c.name}</h2><div className="feed-plan" aria-label="采集目标与计划"><p>{c.instruction || '待沟通目标'}</p><p className="muted">{scheduleLabel(c.schedule)}{c.nextDueAt && ` · 下次 ${feedTime(c.nextDueAt, c.schedule.frequency === 'manual' ? undefined : c.schedule.timeZone)}`}</p></div></header>
    {detail.activeRun && <p role="status">{feedRunLabel(detail.activeRun)}</p>}
    {queued.some(run => run.status === 'waiting_account') && <p role="status">需要登录 Codex，请打开应用设置完成登录；已排队输入会保留。</p>}
    {detail.runtime?.error && <p className="inline-error" role="status">{detail.runtime.error}</p>}
    {detail.attention.filter(run => run.status === 'failed').map(run => <p className="inline-error" role="status" key={run.id}>{run.error || '执行失败，请在对话中重试。'}</p>)}
    {error && <p className="inline-error" role="alert">{error}<button className="text-button" onClick={refreshed}>重试读取</button></p>}
    <div className="feed-actions">
      {action.value.pending && !action.busy && <button className="button secondary" disabled={disabled} onClick={() => void perform(action.value.pending!.command)}>重试原操作</button>}
      {detail.activeRun && <button className="button secondary" disabled={disabled || action.busy} onClick={() => void perform({ type: detail.activeRun!.status === 'needs_reconciliation' ? 'reconcile_feed_run' : 'stop_feed_run', runId: detail.activeRun!.id, requestId: crypto.randomUUID() })}>{detail.activeRun.status === 'needs_reconciliation' ? '核对原生执行' : '停止本次运行'}</button>}
      {c.queueHeld && <button className="button secondary" disabled={blocked || action.busy} onClick={() => void perform({ type: 'continue_feed_queue', collectionId: c.id, requestId: crypto.randomUUID() })}>继续队列</button>}
    </div>
    {c.queueHeld && <p role="status">队列待继续</p>}
    {queued.map(run => <div className="feed-queued" key={run.id}><span>{feedRunLabel(run)}：{run.inputSnapshot.text || '定时采集'}</span><button className="text-button" disabled={blocked || action.busy} onClick={() => void perform({ type: 'cancel_feed_run', runId: run.id, requestId: crypto.randomUUID() })}>撤回排队输入</button></div>)}
    {detail.queuedCount > queued.length && runs.cursor && <button className="text-button" disabled={runs.loading} onClick={() => void runs.more()}>更多排队输入</button>}
    <div className="feed-detail-columns">
      <section className="feed-results" aria-label="执行结果"><h3>执行结果</h3>{results.items.filter(item => !item.deletedAt).map(item => entries[item.entryId] && !entries[item.entryId].deletedAt ? <FeedResult key={item.discoveryId} entry={entries[item.entryId]} collectedAt={item.collectedAt} /> : <p role="status" key={item.discoveryId}>正在读取结果…</p>)}{!results.items.length && <p className="muted">尚无执行结果，先和 Codex 沟通采集目标。</p>}{results.cursor && <button className="button secondary" disabled={results.loading} onClick={() => void results.more()}>加载更多结果</button>}</section>
      <section className="feed-conversation" aria-label="与 Codex 对话"><h3>与 Codex 对话</h3><a className="text-button feed-composer-link" href={`#feed-composer-${c.id}`}>继续沟通目标</a>
        {detail.requests.map(({ key, request }) => <NativeRequestCard key={key} request={{ ...request, key }} onRespond={async result => { await execute({ type: 'respond_feed_native', collectionId: c.id, requestKey: key, result }); refreshed(); }} onError={fail} onOpenUrl={url => void window.mixcat.openExternal?.(url).catch(caught => fail(String(caught)))} />)}
        {history.cursor && <button className="button secondary" disabled={history.loading} onClick={() => void history.more()}>加载更早对话</button>}
        <ReferenceNavigation.Provider value={null}>{orderedConversation(history.items).map(item => <FeedMessage key={item.id} item={item} run={runs.items.find(run => run.id === item.runId)} />)}</ReferenceNavigation.Provider>
        {c.threadId && nativeCursor !== null && <button className="text-button" onClick={() => { void execute({ type: 'load_feed_native_history', collectionId: c.id, ...(nativeCursor ? { cursor: nativeCursor } : {}) }).then(reply => { setNativeCursor(reply.nativeHistory!.nextCursor); refreshed(); }).catch(caught => fail(String(caught))); }}>{nativeCursor ? '加载更多原生历史' : '同步原生历史'}</button>}
        <form className="form-stack feed-message-form" onSubmit={event => { event.preventDefault(); void send(); }}><label>继续沟通目标<textarea id={`feed-composer-${c.id}`} aria-label="继续沟通目标" readOnly={!message.ready} value={message.value.fields.text} onChange={event => message.change({ ...message.value.fields, text: event.target.value })} rows={4} /></label>{!message.ready && <p className="field-note">草稿读取成功后可编辑。</p>}{(detail.activeRun || c.queueHeld) && <p className="field-note">发送后排队。{c.queueHeld && '继续队列后开始执行。'}</p>}{message.value.pending && <p role="status">原消息尚待确认，新编辑的文字会保留。</p>}<button className="button primary" disabled={blocked || message.busy || !message.ready || !message.value.pending && !message.value.fields.text.trim()}>{message.value.pending ? '重试原消息' : '发送'}</button></form>
      </section>
    </div>
  </section>;
}
