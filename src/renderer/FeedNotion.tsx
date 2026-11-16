import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { FeedCollection, FeedCollectionDetail, FeedCommand, FeedNotionPage, FeedNotionStatus } from '../shared/feed';
import type { FeedExecute } from './FeedWorkspace';
import { Dialog } from './Dialog';
import { Icon } from './Icon';

// Keep browser handoff progress across panel mounts for the same native login.
type Authorization = { loginId: string | null; url?: string; phase: 'opening' | 'waiting' };
const authorizations = new Map<string, Authorization>(), authorizationListeners = new Set<() => void>();
function subscribeAuthorization(listener: () => void) { authorizationListeners.add(listener); return () => { authorizationListeners.delete(listener); }; }
function updateAuthorization(id: string, attempt?: Authorization) {
  if (attempt) authorizations.set(id, attempt); else authorizations.delete(id);
  for (const listener of authorizationListeners) listener();
}

export function FeedNotion({ collection, execute, revision, login, disabled, executing, onSaved, onClose }: { collection: FeedCollection; execute: FeedExecute; revision: string; login?: FeedCollectionDetail['notionLogin']; disabled: boolean; executing: boolean; onSaved(): void; onClose(): void }) {
  const [status, setStatus] = useState<FeedNotionStatus>({ connected: false });
  const linking = useSyncExternalStore(subscribeAuthorization, () => authorizations.get(collection.id)?.phase ?? null, () => null);
  const [error, setError] = useState(''), [loading, setLoading] = useState(true), [actionBusy, setActionBusy] = useState(false);
  const busy = actionBusy || linking === 'opening';
  const [pages, setPages] = useState<FeedNotionPage[]>([]), [selected, select] = useState<FeedNotionPage | null>(null);
  const [section, setSection] = useState<'private' | 'shared'>('private'), [path, setPath] = useState<FeedNotionPage[]>([]);
  const [cursor, setCursor] = useState<string>(), [browsing, setBrowsing] = useState(false), [directoryError, setDirectoryError] = useState(''), [directoryRetry, setDirectoryRetry] = useState(0);
  const [retry, setRetry] = useState(0);
  const [showCreate, setShowCreate] = useState(false), [pageTitle, setPageTitle] = useState('');
  const createRequest = useRef<Extract<FeedCommand, { type: 'create_feed_notion_page' }> | undefined>(undefined), createTrigger = useRef<HTMLButtonElement>(null);
  const collectionOwner = useRef(collection.id); collectionOwner.current = collection.id;
  const port = useRef(execute); port.current = execute;
  const alive = useRef(true), workspace = useRef<string | undefined>(undefined), searchSequence = useRef(0);
  const directory = useRef<HTMLDivElement>(null), parent = path.at(-1);
  useEffect(() => () => { alive.current = false; searchSequence.current++; }, []);
  useEffect(() => { searchSequence.current++; setShowCreate(false); setPageTitle(''); createRequest.current = undefined; setActionBusy(false); setError(''); }, [collection.id]);
  function apply(next: FeedNotionStatus) {
    const attempt = authorizations.get(collection.id);
    if (attempt && (next.connected || next.pending === false && attempt.url !== undefined || next.pending && attempt.phase === 'waiting' && (attempt.loginId !== (next.loginId ?? null) || attempt.url !== next.authorizationUrl))) updateAuthorization(collection.id);
    if (workspace.current !== next.workspace?.id) { workspace.current = next.workspace?.id; searchSequence.current++; setPages([]); setPath([]); setCursor(undefined); select(null); setBrowsing(!!next.connected && !!next.workspace); setDirectoryError(''); setActionBusy(false); setShowCreate(false); setPageTitle(''); createRequest.current = undefined; }
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
    if (busy || loading) return; setActionBusy(true); setError('');
    const previous = authorizations.get(collection.id), attempt: Authorization = { loginId: null, phase: 'opening' };
    updateAuthorization(collection.id, attempt);
    try {
      const next = (await port.current({ type: 'connect_feed_notion', collectionId: collection.id })).notion!;
      if (!alive.current) { if (authorizations.get(collection.id) === attempt) updateAuthorization(collection.id); return; }
      apply(next);
      if (next.connected) return;
      if (!next.authorizationUrl) throw Error('Notion 未返回授权地址。');
      if (!window.mixcat.openExternal) throw Error('当前客户端无法打开授权页。');
      attempt.loginId = next.loginId ?? null; attempt.url = next.authorizationUrl;
      await window.mixcat.openExternal(next.authorizationUrl);
      if (authorizations.get(collection.id) === attempt) {
        attempt.phase = 'waiting'; updateAuthorization(collection.id, attempt);
      }
    } catch {
      if (authorizations.get(collection.id) === attempt) updateAuthorization(collection.id, previous?.phase === 'waiting' && previous.loginId === attempt.loginId && previous.url === attempt.url ? previous : undefined);
      if (alive.current) setRetry(value => value + 1);
    }
    finally { if (alive.current) setActionBusy(false); }
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
    searchSequence.current++; setSection(nextSection); setPath(nextPath); setPages([]); setCursor(undefined); select(nextPath.at(-1) ?? null); setDirectoryError(''); setShowCreate(false); setPageTitle(''); createRequest.current = undefined; setError('');
    setBrowsing(true);
    setDirectoryRetry(value => value + 1);
    requestAnimationFrame(() => directory.current?.focus({ preventScroll: true }));
  }
  function cancelCreate() {
    setShowCreate(false); setPageTitle(''); setError(''); createRequest.current = undefined;
    requestAnimationFrame(() => createTrigger.current?.focus({ preventScroll: true }));
  }
  async function createPage() {
    const title = pageTitle.trim(), owner = workspace.current;
    if (busy || loading || browsing || disabled || !parent || !owner || !title) return;
    const token = ++searchSequence.current;
    setActionBusy(true); setError('');
    let command = createRequest.current;
    if (!command || command.collectionId !== collection.id || command.workspaceId !== owner || command.parentPageId !== parent.id || command.title !== title || command.expectedRevision !== collection.revision) {
      command = { type: 'create_feed_notion_page', collectionId: collection.id, workspaceId: owner, parentPageId: parent.id, title, expectedRevision: collection.revision, requestId: crypto.randomUUID() };
      createRequest.current = command;
    }
    try {
      const next = (await port.current(command)).notion!;
      if (alive.current && collectionOwner.current === collection.id && token === searchSequence.current && workspace.current === owner) {
        if (!next.createdPage || next.workspace?.id !== owner) throw Error('未能确认新建页面，请刷新目录核对。');
        const page = next.createdPage;
        setPages(current => [...current.filter(item => item.id !== page.id && item.url !== page.url), page]); select(page);
        setShowCreate(false); setPageTitle(''); createRequest.current = undefined;
        requestAnimationFrame(() => { const button = directory.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]'); button?.focus(); button?.scrollIntoView({ block: 'nearest' }); });
      }
    } catch (caught) { if (alive.current && collectionOwner.current === collection.id && token === searchSequence.current) setError(String(caught)); }
    finally { if (alive.current && collectionOwner.current === collection.id && token === searchSequence.current) setActionBusy(false); }
  }
  async function save(pageId: string | null) {
    if (busy || loading || disabled || !status.workspace && pageId !== null) return;
    setActionBusy(true); setError('');
    try {
      const reply = await port.current({ type: 'set_feed_notion_target', collectionId: collection.id, workspaceId: status.workspace?.id ?? status.target!.workspace.id, pageId, expectedRevision: collection.revision, requestId: crypto.randomUUID() });
      if (alive.current) { apply(reply.notion!); select(null); onSaved(); }
    } catch (caught) { if (alive.current) setError(String(caught)); }
    finally { if (alive.current) setActionBusy(false); }
  }
  return <Dialog title="Notion 保存位置" onClose={onClose}><div className="feed-notion form-stack"><div className="feed-notion-content" role="region" aria-label="Notion 保存位置内容" aria-busy={loading || busy} tabIndex={0}>
    <p>当前信息流：{collection.name}</p>
    {executing && <p className="muted feed-notion-executing" role="status">信息流正在执行，可查看连接和目录；执行结束后可修改配置。</p>}
    {status.workspace && <p>当前工作区：<strong>{status.workspace.name}</strong></p>}
    {status.target && <p>当前保存位置：<strong>{status.target.title || '未命名页面'}</strong> · {status.target.type === 'database' ? '数据库' : '页面'}</p>}
    {(!showCreate && error || status.error) && <p className="inline-error" role="alert">{error || status.error}</p>}
    <button type="button" className={`button secondary${status.connected ? ' feed-notion-connected' : ''}`} disabled={status.connected || loading || busy || disabled} title={disabled ? '执行结束后可配置 Notion' : status.connected ? undefined : linking === 'waiting' ? '重新打开授权链接' : '点击链接 Notion'} onClick={() => void connect()}>{status.connected && <Icon name="check" size={16} />}<span aria-live="polite">{status.connected ? '已链接' : linking === 'opening' ? '正在打开链接' : linking === 'waiting' && status.pending ? '等待授权' : '未链接'}</span></button>
    {status.connected && <>
      <div className="feed-notion-sections" role="group" aria-label="页面区域">{(['private', 'shared'] as const).map(value => <button type="button" key={value} className="button secondary compact" aria-pressed={section === value} disabled={loading || busy || browsing} onClick={() => navigate(value, [])}>{value === 'private' ? '私人页面' : '共享页面'}</button>)}<button type="button" className="text-button" disabled={loading || busy || browsing} onClick={() => setDirectoryRetry(value => value + 1)}>刷新目录</button></div>
      {!!path.length && <nav className="feed-notion-path" aria-label="页面路径"><button type="button" className="text-button" disabled={loading || busy || browsing} onClick={() => navigate(section, [])}>{section === 'private' ? '私人页面' : '共享页面'}</button>{path.map((page, index) => <span key={page.id}><Icon name="chevron" size={12} />{index === path.length - 1 ? page.title || '未命名页面' : <button type="button" className="text-button" disabled={loading || busy || browsing} onClick={() => navigate(section, path.slice(0, index + 1))}>{page.title || '未命名页面'}</button>}</span>)}</nav>}
      {parent && <button type="button" className="text-button" aria-pressed={selected?.id === parent.id} disabled={loading || busy || browsing} onClick={() => select(parent)}>选择当前页面：{parent.title || '未命名页面'}</button>}
      {!showCreate ? <div className="feed-notion-create-entry"><button ref={createTrigger} type="button" className="button secondary compact feed-notion-new-page" disabled={loading || busy || browsing || disabled || !parent} onClick={() => { setShowCreate(true); setError(''); }}>新建页面</button>{!parent && <span className="muted">进入父页面后可新建子页面。</span>}</div> : <form className="form-stack feed-notion-create" aria-label="新建子页面" onSubmit={event => { event.preventDefault(); void createPage(); }} onKeyDown={event => { if (event.key === 'Escape' && !busy) { event.preventDefault(); event.stopPropagation(); cancelCreate(); } if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault(); }}>
        <label>页面名称<input autoFocus name="notion-page-title" value={pageTitle} maxLength={200} required disabled={busy || disabled} onChange={event => setPageTitle(event.target.value)} placeholder="例如：调研资料" aria-describedby={error ? 'feed-notion-create-error' : undefined} /></label>
        {error && <p id="feed-notion-create-error" className="inline-error" role="alert">{error}</p>}
        <div className="feed-notion-create-entry"><button type="submit" className="button primary compact" disabled={loading || busy || browsing || disabled || !pageTitle.trim()}>{busy ? '正在新建…' : '创建页面'}</button><button type="button" className="button secondary compact" disabled={busy} onClick={cancelCreate}>取消</button></div>
      </form>}
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
