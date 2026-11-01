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
  return <article className="feed-result feed-results" aria-label="执行结果"><p className="feed-result-label">执行结果 · {feedTime(collectedAt)}</p><h3>{entry.title}</h3><ReferenceNavigation.Provider value={null}><ProjectMarkdown text={entry.body} /></ReferenceNavigation.Provider></article>;
}
export function FeedMessage({ item, run }: { item: FeedConversationEntry; run?: FeedRun }) {
  const type = (item.rawItem as { type?: string } | undefined)?.type;
  if (['sessionConfiguration', 'runtimeCapabilities'].includes(type ?? '')) return null;
  const source = item.id.startsWith('input:') ? !run ? '会话输入' : run.trigger === 'schedule' ? '定时执行' : run.trigger === 'catchup' ? '补跑' : '你' : { user: '你', assistant: 'Codex', system: '系统 / 工具', unknown: '来源未确认' }[item.source];
  const tool = ['commandExecution', 'mcpToolCall', 'dynamicToolCall', 'fileChange', 'webSearch'].includes(type ?? '');
  return <article className={`feed-message${source === '你' ? ' feed-message-user' : ''}`}><p className="feed-message-meta">{source} · {feedTime(item.createdAt)}{!item.completed && ' · 尚未完成'}</p>
    {type === 'reasoning' || tool ? <details className={tool ? 'native-tool' : 'native-reasoning'} open={!item.completed}><summary>{tool ? '工具活动' : item.completed ? '思考' : '正在思考'}</summary><ProjectMarkdown text={item.text} /></details> : <ProjectMarkdown text={item.text} />}
  </article>;
}
const emptyMessage = { text: '' };
export function FeedCollection({ detail, execute, onBack, onError, drafts, revision = 0, disabled = false, active = true, onRefresh }: { detail: FeedCollectionDetail; execute: FeedExecute; onBack(): void; onError(message: string): void; drafts?: FeedDraftPort; revision?: number | string; disabled?: boolean; active?: boolean; onRefresh?(): void }) {
  const c = detail.collection;
  const [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
  const [entries, setEntries] = useState<Record<string, FeedEntry>>({});
  const viewport = useRef<HTMLDivElement>(null), following = useRef(true);
  const heading = useRef<HTMLHeadingElement>(null), alive = useRef(true), activeRef = useRef(active); activeRef.current = active;
  useLayoutEffect(() => { heading.current?.focus(); return () => { alive.current = false; }; }, []);
  function fail(message: string) { if (alive.current) { setError(message); if (activeRef.current) onError(message); } }
  function refreshed() { setError(''); setRefresh(n => n + 1); onRefresh?.(); }
  const version = `${revision}:${refresh}`;
  const history = useFeedPage<FeedConversationEntry>({ type: 'read_feed_history', collectionId: c.id }, 'history', execute, version, fail);
  const results = useFeedPage<FeedRunResult>({ type: 'list_feed_results', collectionId: c.id }, 'results', execute, version, fail);
  const runs = useFeedPage<FeedRun>({ type: 'list_feed_runs', collectionId: c.id }, 'runs', execute, version, fail);
  useEffect(() => {
    if (!error && runs.cursor && !runs.loading && history.items.some(item => item.id.startsWith('input:') && item.runId && !runs.items.some(run => run.id === item.runId))) runs.more();
  }, [error, history.items, runs.items, runs.cursor, runs.loading]);
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
  const transcript = orderedConversation([
    ...history.items.map(item => ({ id: item.id, seq: item.seq, createdAt: item.createdAt, content: <FeedMessage item={item} run={runs.items.find(run => run.id === item.runId)} /> })),
    ...results.items.filter(item => !item.deletedAt).map(item => ({ id: `result:${item.discoveryId}`, seq: item.discoveryId, createdAt: item.collectedAt, content: entries[item.entryId] && !entries[item.entryId].deletedAt ? <FeedResult entry={entries[item.entryId]} collectedAt={item.collectedAt} /> : <p role="status">正在读取结果…</p> }))
  ]);
  useLayoutEffect(() => { if (following.current && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight; }, [history.items, results.items, entries, detail.requests]);
  return <section className="feed-collection" aria-label="采集详情">
    <header><button className="text-button feed-back" onClick={onBack}><Icon name="back" size={16} />返回信息流</button><h2 ref={heading} tabIndex={-1}>{c.name}</h2><details className="feed-plan" aria-label="采集目标与计划"><summary>目标与计划<span>{scheduleLabel(c.schedule)}</span></summary><p>{c.instruction || '待沟通目标'}</p><p className="muted">{c.nextDueAt && `下次 ${feedTime(c.nextDueAt, c.schedule.frequency === 'manual' ? undefined : c.schedule.timeZone)}`}</p></details></header>
    <section className="feed-conversation" aria-label="与 Codex 对话">
      <div className="feed-conversation-history" ref={viewport} onScroll={event => { const e = event.currentTarget; following.current = e.scrollHeight - e.scrollTop - e.clientHeight < 48; }}>
      <div className="feed-transcript">
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
        {detail.requests.map(({ key, request }) => <NativeRequestCard key={key} request={{ ...request, key }} onRespond={async result => { await execute({ type: 'respond_feed_native', collectionId: c.id, requestKey: key, result }); refreshed(); }} onError={fail} onOpenUrl={url => void window.mixcat.openExternal?.(url).catch(caught => fail(String(caught)))} />)}
        {history.cursor && <button className="button secondary" disabled={history.loading} onClick={() => void history.more()}>加载更早对话</button>}
        {results.cursor && <button className="button secondary" disabled={results.loading} onClick={() => void results.more()}>加载更多结果</button>}
        <ReferenceNavigation.Provider value={null}>{transcript.map(item => <div key={item.id} data-feed-item={item.id}>{item.content}</div>)}</ReferenceNavigation.Provider>
        {!transcript.length && <p className="muted">和 Codex 沟通你想持续关注的内容。</p>}
        </div>
        </div>
        <form className="feed-message-form" onSubmit={event => { event.preventDefault(); void send(); }}><textarea id={`feed-composer-${c.id}`} aria-label="继续沟通目标" placeholder="向 Codex 发送消息" readOnly={!message.ready} value={message.value.fields.text} onChange={event => message.change({ ...message.value.fields, text: event.target.value })} rows={3} />
          <div className="feed-composer-footer"><div>{!message.ready && <p className="field-note">草稿读取成功后可编辑。</p>}{(detail.activeRun || c.queueHeld) && <p className="field-note">发送后排队。{c.queueHeld && '继续队列后开始执行。'}</p>}{message.value.pending && <p role="status">原消息尚待确认，新编辑的文字会保留。</p>}</div><button className="feed-send" aria-label={message.value.pending ? '重试原消息' : '发送'} title={message.value.pending ? '重试原消息' : '发送'} disabled={blocked || message.busy || !message.ready || !message.value.pending && !message.value.fields.text.trim()}><span className="feed-visually-hidden" aria-hidden="true">{message.value.pending ? '重试原消息' : '发送'}</span><Icon name="arrow" size={20} /></button></div>
        </form>
      </section>
  </section>;
}
