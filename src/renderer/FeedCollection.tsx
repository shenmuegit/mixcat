import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FeedCollectionDetail, FeedCommand, FeedConversationEntry, FeedEntry, FeedRun, FeedRunResult, FeedSchedule } from '../shared/feed';
import { orderedConversation } from '../shared/conversation-order';
import { ProjectMarkdown, ReferenceNavigation } from './ProjectMarkdown';
import { NativeRequestCard } from './NativeRequests';
import { submitFeedOnEnter, useFeedForm, useFeedPage, type FeedDraftPort } from './FeedForms';
import type { FeedExecute } from './FeedWorkspace';
import { Icon } from './Icon';
import { FeedModelPicker } from './FeedModelPicker';
import { FeedNotion } from './FeedNotion';
export const feedRunLabel = (run: Pick<FeedRun, 'status'>) => ({ queued: '已排队', waiting_account: '等待连接', starting: '正在启动', running: '执行中', stopping: '正在停止', stopped: '已停止', completed: '执行完成', failed: '执行失败', needs_reconciliation: '执行结果未知，需核对', cancelled: '已撤回', steered: '已插队' }[run.status]);
export function feedTime(value?: string | null, timeZone?: string) { if (!value || !Number.isFinite(Date.parse(value))) return '时间未确认'; try { return new Date(value).toLocaleString('zh-CN', { hourCycle: 'h23', ...(timeZone ? { timeZone } : {}) }); } catch { return value; } }
export function scheduleLabel(schedule: FeedSchedule) { return schedule.frequency === 'manual' ? '尚未设置定时' : `${schedule.frequency === 'daily' ? '每日' : `每周${['日','一','二','三','四','五','六'][schedule.weekday]}`} ${schedule.time} · ${schedule.timeZone} · ${schedule.enabled ? '定时已启用' : '定时已暂停'}`; }
export function FeedResult({ entry, collectedAt }: { entry: FeedEntry; collectedAt: string }) {
  return <article className="feed-result feed-results" aria-label="执行结果"><p className="feed-result-label">执行结果 · {feedTime(collectedAt)}</p><h3>{entry.title}</h3><ReferenceNavigation.Provider value={null}><ProjectMarkdown text={entry.body} /></ReferenceNavigation.Provider></article>;
}
function FeedResultDrawer({ id, page, execute, revision, error, onRetry, onClose }: { id: string; page: ReturnType<typeof useFeedPage<FeedRunResult>>; execute: FeedExecute; revision: string; error: string; onRetry(): void; onClose(): void }) {
  const results = page.items.filter(result => !result.deletedAt);
  const [selected, select] = useState<FeedRunResult | null>(results[0] ?? null);
  const [entry, setEntry] = useState<FeedEntry | null>(null), [loading, setLoading] = useState(false), [readError, setReadError] = useState(''), [retry, setRetry] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => { heading.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => { if (!selected && results[0]) select(results[0]); }, [page.items, selected]);
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setLoading(true); setReadError(''); setEntry(current => current?.id === selected.entryId ? current : null);
    void execute({ type: 'get_feed_entry', entryId: selected.entryId }).then(reply => { if (!cancelled) setEntry(reply.entry!); }).catch(caught => { if (!cancelled) setReadError(String(caught)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [selected?.entryId, revision, retry]);
  return <aside id={id} className="feed-result-drawer" aria-labelledby={`${id}-heading`} onKeyDown={event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.stopPropagation(); onClose(); } }}>
    <header><h2 id={`${id}-heading`} ref={heading} tabIndex={-1}>执行结果</h2><button type="button" className="icon-button" aria-label="关闭执行结果" onClick={onClose}><Icon name="close" size={18} /></button></header>
    {error && <p className="inline-error" role="alert">{error}<button className="text-button" onClick={onRetry}>重试读取列表</button></p>}
    <nav className="feed-result-list" aria-label="已保存成果">{results.map(result => <button type="button" key={result.discoveryId} data-result-id={result.entryId} aria-pressed={selected?.discoveryId === result.discoveryId} onClick={() => select(result)}><span>{result.title}</span><time dateTime={result.collectedAt}>{feedTime(result.collectedAt)}</time></button>)}{page.cursor && <button type="button" className="text-button" disabled={page.loading} onClick={page.more}>加载更多结果</button>}</nav>
    {!results.length && !selected && <p className="muted" role="status">{page.loading ? '正在读取结果…' : '暂无已保存的执行结果'}</p>}
    <div className="feed-result-drawer-content" aria-label="结果正文" tabIndex={0}>
      {readError && <p className="inline-error" role="alert">{readError}<button type="button" className="text-button" onClick={() => setRetry(value => value + 1)}>重试读取结果</button></p>}
      {loading && entry?.id !== selected?.entryId && <p className="muted" role="status">正在读取结果…</p>}
      {selected && entry?.id === selected.entryId && !entry.deletedAt && <FeedResult entry={entry} collectedAt={selected.collectedAt} />}
      {selected && entry?.id === selected.entryId && entry.deletedAt && <p className="muted" role="status">该结果已删除。</p>}
    </div>
  </aside>;
}
function feedTool(item: FeedConversationEntry) {
  return ['commandExecution', 'mcpToolCall', 'dynamicToolCall', 'fileChange', 'webSearch'].includes((item.rawItem as { type?: string } | undefined)?.type ?? '');
}
function feedRunActive(run?: FeedRun) { return !!run && ['starting', 'running'].includes(run.status); }
function toolSummary(item: FeedConversationEntry, run?: FeedRun) {
  const raw = item.rawItem as Record<string, any>;
  const failed = raw.status === 'failed' || raw.success === false || typeof raw.exitCode === 'number' && raw.exitCode !== 0;
  const status = failed ? '失败' : raw.status === 'declined' ? '已拒绝' : !item.completed ? feedRunActive(run) ? '正在执行' : '尚未完成' : '已完成';
  const labels: Record<string, string> = {
    commandExecution: `运行命令 ${raw.command ?? ''}`,
    mcpToolCall: `使用 ${raw.server ?? 'MCP'} 集成 ${raw.tool ?? ''}`,
    dynamicToolCall: `调用工具 ${raw.tool ?? ''}`,
    fileChange: `编辑文件 ${Array.isArray(raw.changes) ? raw.changes.map(change => change?.path).filter(Boolean).join('、') : ''}`,
    webSearch: `搜索 ${raw.action?.query ?? raw.action?.queries?.join('、') ?? raw.query ?? raw.action?.url ?? ''}`
  };
  return { label: `${status} · ${labels[raw.type]}`, failed, icon: raw.type === 'commandExecution' ? 'terminal' as const : raw.type === 'fileChange' ? 'note' as const : raw.type === 'webSearch' ? 'search' as const : 'nodes' as const };
}
export function FeedMessage({ item, run }: { item: FeedConversationEntry; run?: FeedRun }) {
  const type = (item.rawItem as { type?: string } | undefined)?.type;
  if (['sessionConfiguration', 'runtimeCapabilities'].includes(type ?? '')) return null;
  const source = item.id.startsWith('input:') ? !run ? '会话输入' : run.trigger === 'schedule' ? '定时执行' : run.trigger === 'catchup' ? '补跑' : '你' : { user: '你', assistant: 'Codex', system: '系统 / 工具', unknown: '来源未确认' }[item.source];
  const tool = feedTool(item) ? toolSummary(item, run) : null, thinking = type === 'reasoning', thinkingActive = !item.completed && feedRunActive(run);
  const label = tool?.label ?? `${thinkingActive ? '正在思考' : item.completed ? '思考' : '思考（尚未完成）'}${item.text ? ` · ${item.text.split('\n').find(line => line.trim()) ?? ''}` : ''}`;
  return <article className={`feed-message${source === '你' ? ' feed-message-user' : ''}${tool || thinking ? ' feed-activity' : ''}`} data-feed-item={item.id} aria-label={source === '你' ? '你' : undefined}>
    {!tool && !thinking && source !== '你' && source !== 'Codex' && <p className="feed-message-meta">{source} · {feedTime(item.createdAt)}{!item.completed && ' · 尚未完成'}</p>}
    {tool || thinking ? <details className={tool ? `native-tool${tool.failed ? ' feed-activity-failed' : ''}` : 'native-reasoning'} open={thinking && thinkingActive}><summary><Icon name={tool?.icon ?? 'bolt'} size={16} /><span className="feed-activity-label" title={label}>{label}</span><Icon name="chevron" size={12} /></summary>{tool ? <pre className="native-output">{item.text}</pre> : <ProjectMarkdown text={item.text} />}<details className="feed-activity-record"><summary>详细记录</summary><pre className="native-output">{JSON.stringify(item.rawItem, null, 2)}</pre></details></details>
      : <ProjectMarkdown text={item.text} />}
  </article>;
}
function FeedActivityGroup({ items, run }: { items: FeedConversationEntry[]; run?: FeedRun }) {
  const failed = items.filter(item => toolSummary(item).failed).length, pending = items.filter(item => !item.completed).length;
  const kinds = [...new Set(items.map(item => { const raw = item.rawItem as Record<string, any>; return raw.type === 'commandExecution' ? '运行命令' : raw.type === 'fileChange' ? '编辑文件' : raw.type === 'webSearch' ? '搜索' : raw.type === 'mcpToolCall' ? `${raw.server ?? 'MCP'} 集成` : '调用工具'; }))];
  const label = `${items.length} 项工具操作 · ${kinds.join('、')}${pending ? ` · ${pending} 项${feedRunActive(run) ? '正在执行' : '尚未完成'}` : ''}${failed ? ` · ${failed} 项失败` : ''}`;
  return <details className="feed-activity-group"><summary><Icon name="nodes" size={16} /><span className="feed-activity-label" title={label}>{label}</span><Icon name="chevron" size={12} /></summary><div className="feed-activity-list" role="region" aria-label="工具操作明细" tabIndex={0}>{items.map(item => <FeedMessage key={item.id} item={item} run={run} />)}</div></details>;
}
const emptyMessage = { text: '', model: undefined as string | null | undefined, reasoningEffort: undefined as string | null | undefined };
export function FeedCollection({ detail, execute, onBack, onError, drafts, revision = 0, disabled = false, active = true, onRefresh }: { detail: FeedCollectionDetail; execute: FeedExecute; onBack(): void; onError(message: string): void; drafts?: FeedDraftPort; revision?: number | string; disabled?: boolean; active?: boolean; onRefresh?(): void }) {
  const c = detail.collection;
  const [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
  const [entries, setEntries] = useState<Record<string, FeedEntry>>({});
  const [resultsOpen, setResultsOpen] = useState(false), resultsTrigger = useRef<HTMLButtonElement>(null);
  const [notionOpen, setNotionOpen] = useState(false);
  const notionTrigger = useRef<HTMLButtonElement>(null);
  function closeResults() { setResultsOpen(false); resultsTrigger.current?.focus({ preventScroll: true }); }
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
  const capabilities = { ...c.capabilities, ...(message.value.fields.model !== undefined ? { model: message.value.fields.model } : {}), ...(message.value.fields.reasoningEffort !== undefined ? { reasoningEffort: message.value.fields.reasoningEffort } : {}) };
  const action = useFeedForm(`collection:${c.id}:action`, {}, drafts);
  async function perform(command: FeedCommand) { setError(''); try { await action.submit(command, execute, {}); refreshed(); } catch (caught) { fail(String(caught)); } }
  async function send() {
    setError('');
    try { await message.submit({ type: 'send_feed_message', collectionId: c.id, requestId: crypto.randomUUID(), input: { text: message.value.fields.text, capabilities } }, execute, emptyMessage); refreshed(); }
    catch (caught) { fail(String(caught)); }
  }
  const blocked = disabled || !!c.deletedAt;
  const queued = runs.items.filter(run => ['queued', 'waiting_account'].includes(run.status));
  const transcript = orderedConversation([
    ...history.items.map(item => ({ id: item.id, seq: item.seq, createdAt: item.createdAt, item, result: null as FeedRunResult | null })),
    ...results.items.filter(item => !item.deletedAt).map(result => ({ id: `result:${result.discoveryId}`, seq: result.discoveryId, createdAt: result.collectedAt, item: null as FeedConversationEntry | null, result }))
  ]);
  const groups: (typeof transcript)[] = [];
  for (const entry of transcript) {
    const previous = groups.at(-1)?.at(-1)?.item;
    if (entry.item && previous && feedTool(entry.item) && feedTool(previous) && entry.item.runId && entry.item.runId === previous.runId && entry.item.turnId === previous.turnId) groups.at(-1)!.push(entry);
    else groups.push([entry]);
  }
  useLayoutEffect(() => { if (following.current && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight; }, [history.items, results.items, entries, detail.requests]);
  return <section className="feed-collection" aria-label="采集详情">
    <header><button className="text-button feed-back" onClick={onBack}><Icon name="back" size={16} />返回信息流</button><h2 ref={heading} tabIndex={-1}>{c.name}</h2><details className="feed-plan" aria-label="采集目标与计划"><summary>目标与计划<span>{scheduleLabel(c.schedule)}</span></summary><p>{c.instruction || '待沟通目标'}</p><p className="muted">{c.nextDueAt && `下次 ${feedTime(c.nextDueAt, c.schedule.frequency === 'manual' ? undefined : c.schedule.timeZone)}`}</p>{c.directory && <p className="muted">工作目录：{c.directory}</p>}</details><button ref={notionTrigger} type="button" className="button secondary compact feed-notion-trigger" disabled={disabled || !!detail.activeRun} title={detail.activeRun ? '执行结束后可配置 Notion' : undefined} onClick={() => setNotionOpen(true)}>Notion</button><button ref={resultsTrigger} type="button" className="button secondary compact feed-results-trigger" disabled={disabled} aria-expanded={resultsOpen} aria-controls={`feed-results-${c.id}`} onClick={() => resultsOpen ? closeResults() : setResultsOpen(true)}>执行结果</button></header>
    {notionOpen && <FeedNotion collection={c} execute={execute} revision={version} disabled={blocked || !!detail.activeRun} onSaved={refreshed} onClose={() => { setNotionOpen(false); requestAnimationFrame(() => notionTrigger.current?.focus({ preventScroll: true })); }} />}
    <div className="feed-collection-body">
    <section className="feed-conversation" aria-label="与 Codex 对话">
      <div className="feed-conversation-history" ref={viewport} onScroll={event => { const e = event.currentTarget; following.current = e.scrollHeight - e.scrollTop - e.clientHeight < 48; }}>
      <div className="feed-transcript">
    {detail.activeRun && <p role="status">{feedRunLabel(detail.activeRun)}</p>}
    {queued.some(run => run.status === 'waiting_account') && <p role="status">正在重新连接 Codex；已排队输入会保留。</p>}
    {detail.runtime?.error && <p className="inline-error" role="status">{detail.runtime.error}</p>}
    {detail.attention.filter(run => run.status === 'failed').map(run => <p className="inline-error" role="status" key={run.id}>{run.error || '执行失败，请在对话中重试。'}</p>)}
    {error && <p className="inline-error" role="alert">{error}<button className="text-button" onClick={refreshed}>重试读取</button></p>}
    <div className="feed-actions">
      {action.value.pending && !action.busy && <button className="button secondary" disabled={disabled} onClick={() => void perform(action.value.pending!.command)}>重试原操作</button>}
      {detail.activeRun && <button className="button secondary" disabled={disabled || action.busy} onClick={() => void perform({ type: detail.activeRun!.status === 'needs_reconciliation' ? 'reconcile_feed_run' : 'stop_feed_run', runId: detail.activeRun!.id, requestId: crypto.randomUUID() })}>{detail.activeRun.status === 'needs_reconciliation' ? '核对原生执行' : '停止本次运行'}</button>}
      {c.queueHeld && <button className="button secondary" disabled={blocked || action.busy} onClick={() => void perform({ type: 'continue_feed_queue', collectionId: c.id, requestId: crypto.randomUUID() })}>继续队列</button>}
    </div>
    {c.queueHeld && <p role="status">队列待继续</p>}
    {detail.attention.filter(run => run.status === 'steered').map(run => <p className="inline-error" role="status" key={run.id}>{run.error || '插队结果待核对。'}<button className="text-button" disabled={blocked || action.busy} onClick={() => void perform({ type: 'reconcile_feed_run', runId: run.id, requestId: crypto.randomUUID() })}>核对插队</button></p>)}
    {queued.map(run => <div className="feed-queued" key={run.id}><span>{feedRunLabel(run)}：{run.inputSnapshot.text || '定时采集'}{run.error && <small role="status">{run.error}</small>}</span>{run.trigger === 'message' && detail.activeRun?.status === 'running' && !c.queueHeld && <button className="text-button" disabled={blocked || action.busy} onClick={() => void perform({ type: 'steer_feed_run', runId: run.id, activeRunId: detail.activeRun!.id, requestId: crypto.randomUUID() })}>插队</button>}<button className="text-button" disabled={blocked || action.busy} onClick={() => void perform({ type: 'cancel_feed_run', runId: run.id, requestId: crypto.randomUUID() })}>撤回排队输入</button></div>)}
    {detail.queuedCount > queued.length && runs.cursor && <button className="text-button" disabled={runs.loading} onClick={() => void runs.more()}>更多排队输入</button>}
        {detail.requests.map(({ key, request }) => <NativeRequestCard key={key} request={{ ...request, key }} onRespond={async result => { await execute({ type: 'respond_feed_native', collectionId: c.id, requestKey: key, result }); refreshed(); }} onError={fail} onOpenUrl={url => void window.mixcat.openExternal?.(url).catch(caught => fail(String(caught)))} />)}
        {history.cursor && <button className="button secondary" disabled={history.loading} onClick={() => void history.more()}>加载更早对话</button>}
        {results.cursor && <button className="button secondary" disabled={results.loading} onClick={() => void results.more()}>加载更多结果</button>}
        <ReferenceNavigation.Provider value={null}>{groups.map(group => {
          const { id, item, result } = group[0];
          const run = item ? runs.items.find(run => run.id === item.runId) : undefined;
          return group.length > 1 ? <FeedActivityGroup key={id} items={group.map(entry => entry.item!)} run={run} /> : item ? <FeedMessage key={id} item={item} run={run} /> : <div key={id} data-feed-item={id}>{result && entries[result.entryId] && !entries[result.entryId].deletedAt ? <FeedResult entry={entries[result.entryId]} collectedAt={result.collectedAt} /> : <p role="status">正在读取结果…</p>}</div>;
        })}</ReferenceNavigation.Provider>
        {!transcript.length && <p className="muted">和 Codex 沟通你想持续关注的内容。</p>}
        </div>
        </div>
        <form className="feed-message-form" onSubmit={event => { event.preventDefault(); void send(); }}><textarea id={`feed-composer-${c.id}`} aria-label="继续沟通目标" placeholder="向 Codex 发送消息" readOnly={!message.ready} value={message.value.fields.text} onChange={event => message.change({ ...message.value.fields, text: event.target.value })} onKeyDown={event => submitFeedOnEnter(event, text => message.change({ ...message.value.fields, text }))} rows={3} />
          <div className="feed-composer-footer"><div>{!message.ready && <p className="field-note">草稿读取成功后可编辑。</p>}{message.value.pending && <p role="status">原消息尚待确认，新编辑的文字会保留。</p>}</div><div className="feed-composer-controls"><FeedModelPicker value={capabilities} execute={execute} collectionId={c.id} disabled={blocked || message.busy || !message.ready} onChange={patch => message.change({ ...message.value.fields, ...patch })} /><button type="submit" className="feed-send" aria-label={message.value.pending ? '重试原消息' : '发送'} title={message.value.pending ? '重试原消息' : '发送'} disabled={blocked || message.busy || !message.ready || !message.value.pending && !message.value.fields.text.trim()}><span className="feed-visually-hidden" aria-hidden="true">{message.value.pending ? '重试原消息' : '发送'}</span><Icon name="arrow" size={20} /></button></div>
        </div></form>
      </section>
      {resultsOpen && <FeedResultDrawer id={`feed-results-${c.id}`} page={results} execute={execute} revision={version} error={error} onRetry={refreshed} onClose={closeResults} />}
    </div>
  </section>;
}
