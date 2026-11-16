import { useEffect, useRef, useState } from 'react';
import type { FeedCollection, FeedCollectionDetail, FeedNotionPage, FeedNotionStatus } from '../shared/feed';
import type { FeedExecute } from './FeedWorkspace';
import { Dialog } from './Dialog';
import { Icon } from './Icon';

// Keep browser handoff progress across panel mounts for the same native login.
const authorizations = new Map<string, { loginId: string | null; url: string; opened: boolean }>();

export function FeedNotion({ collection, execute, revision, login, disabled, executing, onSaved, onClose }: { collection: FeedCollection; execute: FeedExecute; revision: string; login?: FeedCollectionDetail['notionLogin']; disabled: boolean; executing: boolean; onSaved(): void; onClose(): void }) {
  const [status, setStatus] = useState<FeedNotionStatus>({ connected: false });
  const [linking, setLinking] = useState<'opening' | 'waiting' | null>(null);
  const [error, setError] = useState(''), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [pages, setPages] = useState<FeedNotionPage[]>([]), [selected, select] = useState<FeedNotionPage | null>(null);
  const [section, setSection] = useState<'private' | 'shared'>('private'), [path, setPath] = useState<FeedNotionPage[]>([]);
  const [cursor, setCursor] = useState<string>(), [browsing, setBrowsing] = useState(false), [directoryError, setDirectoryError] = useState(''), [directoryRetry, setDirectoryRetry] = useState(0);
  const [retry, setRetry] = useState(0);
  const port = useRef(execute); port.current = execute;
  const alive = useRef(true), workspace = useRef<string | undefined>(undefined), searchSequence = useRef(0);
  const directory = useRef<HTMLDivElement>(null), parent = path.at(-1);
  useEffect(() => () => { alive.current = false; searchSequence.current++; }, []);
  function apply(next: FeedNotionStatus) {
    if (next.connected || next.pending === false) authorizations.delete(collection.id);
    setLinking(current => {
      if (next.connected || !next.pending) return null;
      if (current === 'opening') return current;
      const attempt = authorizations.get(collection.id);
      return attempt?.opened && attempt.loginId === (next.loginId ?? null) && attempt.url === next.authorizationUrl ? 'waiting' : null;
    });
    if (workspace.current !== next.workspace?.id) { workspace.current = next.workspace?.id; searchSequence.current++; setPages([]); setPath([]); setCursor(undefined); select(null); setBrowsing(!!next.connected && !!next.workspace); setDirectoryError(''); setBusy(false); }
    setStatus(next.connected ? next : { ...next, error: undefined });
  }
  useEffect(() => {
    let cancelled = false; setLoading(true);
    void port.current({ type: 'read_feed_notion', collectionId: collection.id }).then(reply => { if (!cancelled) { apply(reply.notion!); setError(''); } }).catch(() => { if (!cancelled) apply({ connected: false, target: collection.notion?.target }); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [collection.id, revision, retry, executing]);
  useEffect(() => {
    if (status.pending && login?.pending === false && status.loginId === login.id) {
      setRetry(value => value + 1);
    }
  }, [status.pending, status.loginId, login?.id, login?.pending, login?.error]);
  useEffect(() => {
    if (status.connected && status.workspace) void browse();
  }, [status.connected, status.workspace?.id, section, parent?.id, directoryRetry]);
  async function connect() {
    if (busy || loading) return; setBusy(true); setError(''); setLinking('opening');
    try {
      const next = (await port.current({ type: 'connect_feed_notion', collectionId: collection.id })).notion!;
      if (!alive.current) return;
      apply(next);
      if (next.connected) return;
      if (!next.authorizationUrl) throw Error('Notion 未返回授权地址。');
      if (!window.mixcat.openExternal) throw Error('当前客户端无法打开授权页。');
      const previous = authorizations.get(collection.id);
      const attempt = previous?.loginId === (next.loginId ?? null) && previous.url === next.authorizationUrl ? previous : { loginId: next.loginId ?? null, url: next.authorizationUrl, opened: false };
      authorizations.set(collection.id, attempt);
      await window.mixcat.openExternal(next.authorizationUrl);
      if (authorizations.get(collection.id) === attempt) {
        attempt.opened = true;
        if (alive.current) setLinking(current => current === 'opening' ? 'waiting' : current);
      }
    } catch { if (alive.current) { setLinking(null); setRetry(value => value + 1); } }
    finally { if (alive.current) setBusy(false); }
  }
  async function browse(nextCursor?: string) {
    if (!workspace.current) return;
    const token = ++searchSequence.current, owner = workspace.current;
    setBrowsing(true); setDirectoryError('');
    try {
      const next = (await port.current(parent ? { type: 'list_feed_notion_children', collectionId: collection.id, pageId: parent.id } : { type: 'list_feed_notion_pages', collectionId: collection.id, section, ...(nextCursor ? { cursor: nextCursor } : {}) })).notion!;
      if (alive.current && token === searchSequence.current && owner === workspace.current) {
        if (next.workspace?.id !== owner) { apply(next); return; }
        setPages(current => nextCursor ? [...current, ...(next.pages ?? [])] : next.pages ?? []); setCursor(next.nextCursor);
      }
    } catch (caught) { if (alive.current && token === searchSequence.current) setDirectoryError(String(caught)); }
    finally { if (alive.current && token === searchSequence.current) setBrowsing(false); }
  }
  function navigate(nextSection: 'private' | 'shared', nextPath: FeedNotionPage[]) {
    if (loading || busy || browsing) return;
    searchSequence.current++; setSection(nextSection); setPath(nextPath); setPages([]); setCursor(undefined); select(nextPath.at(-1) ?? null); setDirectoryError('');
    setBrowsing(true);
    setDirectoryRetry(value => value + 1);
    requestAnimationFrame(() => directory.current?.focus({ preventScroll: true }));
  }
  async function save(pageId: string | null) {
    if (busy || loading || disabled || !status.workspace && pageId !== null) return;
    setBusy(true); setError('');
    try {
      const reply = await port.current({ type: 'set_feed_notion_target', collectionId: collection.id, workspaceId: status.workspace?.id ?? status.target!.workspace.id, pageId, expectedRevision: collection.revision, requestId: crypto.randomUUID() });
      if (alive.current) { apply(reply.notion!); select(null); onSaved(); }
    } catch (caught) { if (alive.current) setError(String(caught)); }
    finally { if (alive.current) setBusy(false); }
  }
  return <Dialog title="Notion 保存位置" onClose={onClose}><div className="feed-notion form-stack"><div className="feed-notion-content" role="region" aria-label="Notion 保存位置内容" aria-busy={loading || busy} tabIndex={0}>
    <p>当前信息流：{collection.name}</p>
    {executing && <p className="muted feed-notion-executing" role="status">信息流正在执行，可查看连接和目录；执行结束后可修改配置。</p>}
    {status.workspace && <p>当前工作区：<strong>{status.workspace.name}</strong></p>}
    {status.target && <p>当前保存位置：<strong>{status.target.title || '未命名页面'}</strong> · {status.target.type === 'database' ? '数据库' : '页面'}</p>}
    {(error || status.error) && <p className="inline-error" role="alert">{error || status.error}</p>}
    <button type="button" className={`button secondary${status.connected ? ' feed-notion-connected' : ''}`} disabled={status.connected || loading || busy || disabled} title={disabled ? '执行结束后可配置 Notion' : status.connected ? undefined : linking === 'waiting' ? '重新打开授权链接' : '点击链接 Notion'} onClick={() => void connect()}>{status.connected && <Icon name="check" size={16} />}<span aria-live="polite">{status.connected ? '已链接' : linking === 'opening' ? '正在打开链接' : linking === 'waiting' && status.pending ? '等待授权' : '未链接'}</span></button>
    {status.connected && <>
      <div className="feed-notion-sections" role="group" aria-label="页面区域">{(['private', 'shared'] as const).map(value => <button type="button" key={value} className="button secondary compact" aria-pressed={section === value} disabled={loading || busy || browsing} onClick={() => navigate(value, [])}>{value === 'private' ? '私人页面' : '共享页面'}</button>)}<button type="button" className="text-button" disabled={loading || busy || browsing} onClick={() => setDirectoryRetry(value => value + 1)}>刷新目录</button></div>
      {!!path.length && <nav className="feed-notion-path" aria-label="页面路径"><button type="button" className="text-button" disabled={loading || busy || browsing} onClick={() => navigate(section, [])}>{section === 'private' ? '私人页面' : '共享页面'}</button>{path.map((page, index) => <span key={page.id}><Icon name="chevron" size={12} />{index === path.length - 1 ? page.title || '未命名页面' : <button type="button" className="text-button" disabled={loading || busy || browsing} onClick={() => navigate(section, path.slice(0, index + 1))}>{page.title || '未命名页面'}</button>}</span>)}</nav>}
      {parent && <button type="button" className="text-button" aria-pressed={selected?.id === parent.id} disabled={loading || busy || browsing} onClick={() => select(parent)}>选择当前页面：{parent.title || '未命名页面'}</button>}
      <div ref={directory} className="feed-notion-pages" role="group" aria-label="Notion 保存位置" aria-busy={browsing} tabIndex={-1}>
        {browsing && <p role="status">正在读取目录…</p>}
        {directoryError && <p className="inline-error" role="alert">{directoryError}<button type="button" className="text-button" disabled={browsing || busy} onClick={() => setDirectoryRetry(value => value + 1)}>重试读取目录</button></p>}
        {!browsing && !directoryError && !pages.length && <p className="muted">{parent ? '此页面没有子页面，可直接保存到当前页面。' : cursor ? '本页暂无条目，可继续加载。' : '暂无可访问的页面。'}</p>}
        {pages.map(page => <div className="feed-notion-page" key={page.id}><button type="button" className="button secondary feed-notion-choice" aria-pressed={selected?.id === page.id} disabled={loading || busy || browsing} onClick={() => select(page)}><span><Icon name={page.type === 'database' ? 'book' : 'folder'} size={16} />{page.title || '未命名页面'}</span><small>{page.type === 'database' ? '数据库' : '页面'}</small></button>{page.type !== 'database' && <button type="button" className="button secondary feed-notion-enter" aria-label={`展开 ${page.title || '未命名页面'}`} disabled={loading || busy || browsing} onClick={() => navigate(section, [...path, page])}><Icon name="chevron" size={16} /></button>}</div>)}
        {cursor && <button type="button" className="text-button" disabled={loading || busy || browsing} onClick={() => { directory.current?.focus(); void browse(cursor); }}>加载更多</button>}
      </div>
    </>}
    </div><div className="feed-notion-actions" hidden={!status.connected && !status.target}>
      {status.connected && <>{selected && <p>本次选择：<strong>{selected.title || '未命名页面'}</strong></p>}<button type="button" className="button primary" disabled={loading || busy || browsing || disabled || !selected} onClick={() => void save(selected!.id)}>保存位置</button></>}
      {status.target && <button type="button" className="text-button" disabled={loading || busy || disabled} onClick={() => void save(null)}>清除保存位置</button>}
    </div>
  </div></Dialog>;
}
