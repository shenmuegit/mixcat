import { useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { reviewCatalog } from './catalog.js';
import { entryHash, entryNumber, resolveReviewRoute } from './review-routes.js';
import { agentRuntime } from './cases/agent-runtime.js';
import '../theme.css';
import './review.css';

export interface ReviewContext {
  theme: 'light' | 'dark' | 'violet';
  reducedMotion: boolean;
}

export interface ReviewCase {
  entryId: number;
  caseId: string;
  title: string;
  render(context: ReviewContext): ReactNode;
}

const reviewCases: readonly ReviewCase[] = [agentRuntime];
const entriesWithCases = new Set(reviewCases.map(reviewCase => reviewCase.entryId));

function ReviewApp() {
  const [hash, setHash] = useState(location.hash);
  const [query, setQuery] = useState('');
  const [theme, setTheme] = useState<ReviewContext['theme']>('light');
  const [reducedMotion, setReducedMotion] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const route = resolveReviewRoute(hash, reviewCases);
  const selectedHash = route.kind === 'missing' ? undefined : hash;
  const needle = query.trim().toLowerCase();
  const results = reviewCatalog.filter(entry => [entryNumber(entry.id), entry.slug, entry.title]
    .some(value => value.toLowerCase().includes(needle)));

  useEffect(() => {
    function readHash() { setHash(location.hash); }
    window.addEventListener('hashchange', readHash);
    return () => window.removeEventListener('hashchange', readHash);
  }, []);
  useEffect(() => {
    const setting = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(setting.matches);
    setting.addEventListener('change', update);
    return () => setting.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    const catalog = document.getElementById('review-catalog');
    const selected = catalog?.querySelector('[aria-current="page"]');
    if (!catalog || !selected) return;
    const list = catalog.getBoundingClientRect();
    const row = selected.getBoundingClientRect();
    // Scroll the list without moving Chromium's sequential keyboard focus start.
    if (row.top < list.top) catalog.scrollTop += row.top - list.top;
    else if (row.bottom > list.bottom) catalog.scrollTop += row.bottom - list.bottom;
  }, [selectedHash, needle]);

  return (
    <div className="review-app">
      <a className="review-skip" href="#review-content" onClick={event => {
        event.preventDefault();
        document.getElementById('review-content')?.focus();
      }}>跳到评审内容</a>
      <header className="review-bar">
        <img src="./mixcat.ico" alt="" />
        <strong>Mixcat 设计评审</strong>
        <span className="local-label"><span aria-hidden="true" />本地样例</span>
        <label className="theme-choice">
          主题
          <select value={theme} onChange={event => setTheme(event.currentTarget.value as ReviewContext['theme'])}>
            <option value="light">浅色</option>
            <option value="dark">深色</option>
            <option value="violet">紫色</option>
          </select>
        </label>
      </header>

      <div className="review-layout">
        <aside className="review-sidebar">
          <div className="catalog-controls">
            <h2>组件目录</h2>
            <p>{reviewCatalog.length} 项规格 <span aria-hidden="true">·</span> {entriesWithCases.size} 项有样例</p>
            <div className="catalog-search">
              <input id="review-search" value={query} placeholder="编号、英文标识或中文名"
                aria-label="搜索组件目录" onChange={event => setQuery(event.currentTarget.value)} />
              {query && <button type="button" aria-label="清除搜索" onClick={() => {
                setQuery('');
                document.getElementById('review-search')?.focus();
              }}>×</button>}
            </div>
          </div>
          <nav id="review-catalog" aria-label="组件目录">
            <ul>
              {results.map(entry => {
                const href = entryHash(entry);
                const available = entriesWithCases.has(entry.id);
                return (
                  <li key={entry.id}>
                    <a href={href} aria-current={href === selectedHash ? 'page' : undefined}>
                      <span className="catalog-id">{entryNumber(entry.id)}</span>
                      <span className="catalog-name"><strong>{entry.title}</strong><small>{entry.slug}</small></span>
                      <span className="catalog-status" data-review-status={available ? 'available' : 'pending'}>
                        {available ? '已实现' : '待实现'}
                      </span>
                    </a>
                  </li>
                );
              })}
            </ul>
            {results.length === 0 && <p className="catalog-empty" role="status">没有匹配的条目</p>}
          </nav>
        </aside>

        <main id="review-content" className="review-content" tabIndex={-1} aria-labelledby="review-title">
          {route.kind === 'missing' ? (
            <div className="detail-shell">
              <h1 id="review-title">无法定位</h1>
              <p className="review-muted">编号与英文标识需要同时匹配。请从目录选择一个条目。</p>
            </div>
          ) : (
            <div className="detail-shell">
              <header className="detail-heading">
                <div className="detail-index"><span>规格</span> <span>{entryNumber(route.entry.id)}</span></div>
                <h1 id="review-title">{route.entry.title}</h1>
                <div className="detail-metadata">
                  <code>{route.entry.slug}</code>
                  <span className="metadata-tag">{route.entry.disposition}</span>
                  <span className="metadata-tag" data-review-status={route.kind}>
                    {route.kind === 'available' ? '已实现' : '待实现'}
                  </span>
                </div>
              </header>
              {route.kind === 'pending' ? (
                <section className="pending-detail">
                  <h2>待实现</h2>
                  <p>该条目尚未接入可操作的评审样例。</p>
                </section>
              ) : (
                reviewCases.filter(reviewCase => reviewCase.entryId === route.entry.id).map(reviewCase => (
                  <section className="review-case" key={route.entry.id + '/' + reviewCase.caseId}>
                    <header className="case-heading"><h2>{reviewCase.title}</h2></header>
                    {reviewCase.render({ theme, reducedMotion })}
                  </section>
                ))
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Review root element is missing.');
createRoot(root).render(<ReviewApp />);
