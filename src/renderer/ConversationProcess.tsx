import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';

const planLabels = { pending: '待处理', inProgress: '进行中', completed: '已完成', failed: '失败', unknown: '状态未知' };
type PlanStep = { step: string; status: keyof typeof planLabels; reason?: string };
type SearchSource = { url: string; address: string };
type WebSearch = { action: string; queries: string[]; sources: SearchSource[] };

function fields(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function recordError(value: unknown) {
  const text = typeof value === 'string' ? value : fields(value)?.message;
  return typeof text === 'string' && text.trim() ? text.trim() : undefined;
}

export function readPlanSteps(value: unknown): PlanStep[] | null {
  if (!Array.isArray(value)) return null;
  const steps = value.flatMap((item: unknown): PlanStep[] => {
    const row = fields(item);
    if (!row || typeof row.step !== 'string' || !row.step.trim()) return [];
    const status = row.status === 'error' ? 'failed' : typeof row.status === 'string' && Object.hasOwn(planLabels, row.status)
      ? row.status as PlanStep['status'] : 'unknown';
    return [{ step: row.step, status, reason: status === 'failed' ? recordError(row.error ?? row.reason) : undefined }];
  });
  return steps.length ? steps : null;
}

export function readWebSearch(value: unknown, links: readonly { url?: string }[]): WebSearch | null {
  const item = fields(value);
  if (item?.type !== 'webSearch') return null;
  const action = fields(item.action);
  const open = action?.type === 'openPage' || action?.type === 'open_page';
  const find = action?.type === 'findInPage' || action?.type === 'find_in_page';
  const queries = [...new Set((find ? [action?.pattern] : open ? [] : [
    action?.query, ...(Array.isArray(action?.queries) ? action.queries : []), item.query
  ]).flatMap(value => typeof value === 'string' && value.trim() ? [value.trim()] : []))];
  const sources = new Map<string, SearchSource>();
  for (const value of [open || find ? action?.url : undefined, ...links.map(link => link.url)]) {
    if (typeof value !== 'string') continue;
    try {
      const url = new URL(value);
      if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) {
        sources.set(url.href, { url: url.href, address: url.host + (url.pathname === '/' ? '' : url.pathname) });
      }
    } catch { /* An invalid address remains available only in the raw record. */ }
  }
  return open || find || action?.type === 'search' || queries.length || sources.size
    ? { action: find ? '页内查找' : open ? '打开页面' : '搜索', queries, sources: [...sources.values()] } : null;
}

export function WebSearchDetails({ search, onOpen }: { search: WebSearch; onOpen(url: string): void }) {
  return <div className="web-search-record">
    {search.queries.length > 0 && <ul aria-label={search.action}>{search.queries.map(query => <li key={query}>{query}</li>)}</ul>}
    {search.sources.length > 0 && <ul aria-label="检索来源">{search.sources.map(source =>
      <li key={source.url}><button type="button" className="text-button" title={source.url} onClick={() => onOpen(source.url)}>
        <span>打开来源</span><span>{source.address}</span>
      </button></li>
    )}</ul>}
  </div>;
}

export function useArrivingRecords(ids: string[], scope: string | undefined, live: boolean) {
  const previous = useRef<{ scope?: string; ids: Set<string> } | null>(null);
  const old = previous.current;
  useLayoutEffect(() => { previous.current = { scope, ids: new Set(ids) }; });
  return new Set(live && old && old.scope === scope ? ids.filter(id => !old.ids.has(id)) : []);
}

export function ExecutionRecordGroup({ count, state, title, children }: { count: number; state?: 'active' | 'failed'; title?: string; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  const single = count === 1;
  return <details className="execution-log" data-single={single ? '' : undefined} open={single || open}
    onToggle={event => { if (!single && event.target === event.currentTarget) setOpen(event.currentTarget.open); }}>
    <summary hidden={single} aria-label={single ? undefined : open ? '收起执行记录' : '展开执行记录'}>
      {!single && <>
        <Icon name="chevron" size={14} /><strong>执行记录</strong>
        {title && <span className="execution-log-title" title={title}>{title}</span>}
        <span>{count} 条</span>
        {state && <span className="execution-log-status" data-state={state}>{state === 'active' ? '运行中' : '含失败记录'}</span>}
      </>}
    </summary>
    <div className="execution-log-rows">{children}</div>
  </details>;
}

export function ConversationPlan({ steps, explanation, raw, live, animate, onLocate, locateLabel }: {
  steps: PlanStep[]; explanation: unknown; raw: unknown; live: boolean; animate: boolean; onLocate?: () => void; locateLabel: string;
}) {
  const [expanded, setExpanded] = useState(true);
  const stepsId = useId();
  const completed = steps.filter(step => step.status === 'completed').length;
  const occurrences = new Map<string, number>();
  const keys = steps.map(({ step }) => {
    const count = occurrences.get(step) ?? 0;
    occurrences.set(step, count + 1);
    return JSON.stringify([step, count]);
  });
  const arrivals = useArrivingRecords(keys, stepsId, live && animate);
  return <section className="progress-steps native-plan" data-live={live ? '' : undefined} aria-label="执行计划">
    <div className="progress-steps-heading">
      <div><strong>执行计划</strong><span className="native-plan-count" aria-live={live ? 'polite' : undefined}>已完成 {completed}/{steps.length}</span></div>
      <button type="button" className="text-button" aria-expanded={expanded} aria-controls={stepsId} onClick={() => setExpanded(value => !value)}>
        {expanded ? '收起步骤' : '展开步骤'}<Icon name="chevron" size={14} />
      </button>
    </div>
    <div id={stepsId} className="progress-steps-body" hidden={!expanded}>
      {typeof explanation === 'string' && explanation && <p className="field-note native-plan-explanation">{explanation}</p>}
      <ol className="progress-step-list">{steps.map(({ step, status, reason }, index) =>
        <li key={keys[index]} className="progress-step" data-state={status} data-record-enter={arrivals.has(keys[index]) ? '' : undefined}>
          <div className="progress-step-icon" aria-hidden="true">{status === 'completed' ? <Icon name="check" size={16} /> : status === 'failed' ? <Icon name="alert" size={16} /> : <span />}</div>
          <div><div className="progress-step-heading"><strong>{step}</strong><span className="progress-step-status">{planLabels[status]}</span></div>
            {reason && <p className="execution-record-error">{reason}</p>}
          </div>
        </li>
      )}</ol>
      {onLocate && <button type="button" className="text-button native-plan-locate" onClick={onLocate}>{locateLabel}</button>}
      <details className="native-plan-record"><summary>原始记录</summary><pre className="result-json">{JSON.stringify(raw, null, 2)}</pre></details>
    </div>
  </section>;
}
