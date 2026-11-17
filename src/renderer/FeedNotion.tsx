import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
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

type Section = 'private' | 'shared';
type Directory = { pages: FeedNotionPage[]; nextCursor?: string; readAt?: number; error?: string };
export type FeedNotionDirectory = { workspaceId?: string; roots: Partial<Record<Section, Directory>>; children: Record<string, Directory> };
const recent = (directory?: Directory) => !!directory?.readAt && !directory.error && Date.now() - directory.readAt < 60_000;
const hasSnapshot = (directory?: Directory) => !!directory?.readAt && !directory.error;

export function FeedNotion({ collection, execute, revision, login, disabled, executing, cache, open = true, onSaved, onClose }: { collection: FeedCollection; execute: FeedExecute; revision: string; login?: FeedCollectionDetail['notionLogin']; disabled: boolean; executing: boolean; cache: FeedNotionDirectory; open?: boolean; onSaved(): void; onClose(): void }) {
  const [status, setStatus] = useState<FeedNotionStatus>({ connected: false });
  const linking = useSyncExternalStore(subscribeAuthorization, () => authorizations.get(collection.id)?.phase ?? null, () => null);
  const [error, setError] = useState(''), [loading, setLoading] = useState(true), [actionBusy, setActionBusy] = useState(false);
  const busy = actionBusy || linking === 'opening';
  const [roots, setRoots] = useState(cache.roots), [selected, select] = useState<FeedNotionPage | null>(null);
  const [section, setSection] = useState<Section>('private');
  const [children, setChildren] = useState(cache.children), [expanded, setExpanded] = useState(new Set<string>());
  const pages = roots[section]?.pages ?? [], cursor = roots[section]?.nextCursor;
  const [browsing, setBrowsing] = useState(false), [reading, setReading] = useState<string | null>(null), [directoryError, setDirectoryError] = useState('');
  const [retry, setRetry] = useState(0);
  const [showCreate, setShowCreate] = useState(false), [pageTitle, setPageTitle] = useState('');
  const createRequest = useRef<Extract<FeedCommand, { type: 'create_feed_notion_page' }> | undefined>(undefined), createTrigger = useRef<HTMLButtonElement>(null);
  const restoreCreateFocus = useRef(false);
  const collectionOwner = useRef(collection.id); collectionOwner.current = collection.id;
  const port = useRef(execute); port.current = execute;
  const alive = useRef(true), workspace = useRef(cache.workspaceId), searchSequence = useRef(0);
  const directory = useRef<HTMLElement>(null), parent = selected && selected.type !== 'database' ? selected : undefined;
  const selectedPath = useRef<string[]>([]);
  const deferredBranches = useRef<{ page: FeedNotionPage; ancestors: string[] }[]>([]);
  useEffect(() => () => { alive.current = false; searchSequence.current++; }, []);
  useEffect(() => { searchSequence.current++; deferredBranches.current = []; workspace.current = cache.workspaceId; restoreCreateFocus.current = false; setStatus({ connected: false }); setRoots(cache.roots); setChildren(cache.children); setExpanded(new Set()); select(null); setBrowsing(false); setReading(null); setDirectoryError(''); setShowCreate(false); setPageTitle(''); createRequest.current = undefined; setActionBusy(false); setError(''); }, [collection.id]);
  useEffect(() => { cache.roots = roots; cache.children = children; }, [roots, children]);
  useLayoutEffect(() => {
    if (open) { if (!loading) { setLoading(true); setRetry(value => value + 1); } }
    else { deferredBranches.current = []; setShowCreate(false); setPageTitle(''); setError(''); select(null); setExpanded(new Set()); createRequest.current = undefined; }
  }, [open]);
  useLayoutEffect(() => {
    if (!open || loading || browsing || !status.connected) return;
    while (deferredBranches.current.length) {
      const next = deferredBranches.current.shift()!;
      const siblings = next.ancestors.length ? children[next.ancestors.at(-1)!]?.pages : pages;
      if (siblings?.some(page => page.url === next.page.url) && expanded.has(next.page.url) && !children[next.page.url]?.error && !recent(children[next.page.url])) { void browse(next.page, undefined, next.ancestors); break; }
    }
  }, [open, loading, browsing, expanded, status.connected]);
  function collapseExpired(keep: string[] = []) {
    setExpanded(current => new Set([...current].filter(url => keep.includes(url) || recent(children[url]))));
  }
  useEffect(() => {
    if (restoreCreateFocus.current && !showCreate && !browsing && !loading && !busy) { restoreCreateFocus.current = false; createTrigger.current?.focus({ preventScroll: true }); }
  }, [showCreate, browsing, loading, busy]);
  function apply(next: FeedNotionStatus) {
    const attempt = authorizations.get(collection.id);
    if (attempt && (next.connected || next.pending === false && attempt.url !== undefined || next.pending && attempt.phase === 'waiting' && (attempt.loginId !== (next.loginId ?? null) || attempt.url !== next.authorizationUrl))) updateAuthorization(collection.id);
    if (workspace.current !== next.workspace?.id) { workspace.current = cache.workspaceId = next.workspace?.id; searchSequence.current++; deferredBranches.current = []; cache.roots = {}; cache.children = {}; setRoots(cache.roots); setChildren(cache.children); setExpanded(new Set()); select(null); setBrowsing(!!next.connected && !!next.workspace); setReading(null); setDirectoryError(''); setActionBusy(false); setShowCreate(false); setPageTitle(''); createRequest.current = undefined; }
    setStatus(next.connected ? next : { ...next, error: undefined });
  }
  useEffect(() => {
    let cancelled = false; setLoading(true);
    const readDirectory = !!collection.notion && !login?.pending && !recent(roots[section]);
    if (readDirectory) { setBrowsing(true); setReading(null); collapseExpired(); select(null); }
    void (async () => {
      try {
        const next = (await port.current(readDirectory ? { type: 'list_feed_notion_pages', collectionId: collection.id, section } : { type: 'read_feed_notion', collectionId: collection.id })).notion!;
        if (cancelled) return;
        apply(next); setError('');
        if (readDirectory && next.connected && next.workspace) { setRoots(current => ({ ...current, [section]: { pages: next.pages ?? [], nextCursor: next.nextCursor, readAt: Date.now() } })); setBrowsing(false); setDirectoryError(''); }
      } catch (caught) {
        if (cancelled) return;
        if (!readDirectory) { apply({ connected: false, target: collection.notion?.target }); return; }
        // A directory failure is not evidence of an expired authorization.
        try { const next = (await port.current({ type: 'read_feed_notion', collectionId: collection.id })).notion!; if (!cancelled) { apply(next); if (next.connected) { deferredBranches.current = []; setRoots(current => ({ ...current, [section]: undefined })); select(null); setDirectoryError(String(caught)); setBrowsing(false); } } }
        catch { if (!cancelled) apply({ connected: false, target: collection.notion?.target }); }
      } finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [collection.id, revision, retry, executing]);
  useEffect(() => {
    if (status.pending && login?.pending === false && status.loginId === login.id) {
      setRetry(value => value + 1);
    }
  }, [status.pending, status.loginId, login?.id, login?.pending, login?.error]);
  useEffect(() => {
    if (!loading && status.connected && status.workspace && !recent(roots[section]) && !directoryError) void browse();
  }, [status.connected, status.workspace?.id, section, loading]);
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
  async function browse(page?: FeedNotionPage, nextCursor?: string, ancestors: string[] = []) {
    if (!workspace.current) return;
    const token = ++searchSequence.current, owner = workspace.current;
    setBrowsing(true); setReading(page?.url ?? null);
    collapseExpired(page ? [...ancestors, page.url] : []);
    if (page) setChildren(current => ({ ...current, [page.url]: { ...current[page.url], pages: current[page.url]?.pages ?? [], error: undefined } }));
    else { setDirectoryError(''); if (!nextCursor) select(null); }
    try {
      const next = (await port.current(page ? { type: 'list_feed_notion_children', collectionId: collection.id, pageId: page.id } : { type: 'list_feed_notion_pages', collectionId: collection.id, section, ...(nextCursor ? { cursor: nextCursor } : {}) })).notion!;
      if (alive.current && token === searchSequence.current && owner === workspace.current) {
        if (next.workspace?.id !== owner) { apply(next); return; }
        if (page) {
          setChildren(current => ({ ...current, [page.url]: { pages: next.pages ?? [], readAt: Date.now() } }));
          const path = selectedPath.current, index = path.indexOf(page.url);
          select(current => index < 0 || next.pages?.some(item => item.url === (path[index + 1] ?? current?.url)) ? current : null);
        }
        else setRoots(current => ({ ...current, [section]: { pages: [...new Map((nextCursor ? [...(current[section]?.pages ?? []), ...(next.pages ?? [])] : next.pages ?? []).map(item => [item.url, item])).values()], nextCursor: next.nextCursor, readAt: nextCursor ? current[section]?.readAt : Date.now() } }));
      }
    } catch (caught) { if (alive.current && token === searchSequence.current) { if (page) { setChildren(current => ({ ...current, [page.url]: { pages: [], error: String(caught) } })); if (selectedPath.current.includes(page.url)) select(null); } else { deferredBranches.current = []; setRoots(current => ({ ...current, [section]: undefined })); select(null); setDirectoryError(String(caught)); } } }
    finally { if (alive.current && token === searchSequence.current) { setBrowsing(false); setReading(null); } }
  }
  function changeSection(nextSection: Section) {
    if (loading || busy || browsing) return;
    if (section === nextSection) return;
    searchSequence.current++; setSection(nextSection); select(null); setDirectoryError(''); setShowCreate(false); setPageTitle(''); createRequest.current = undefined; setError('');
    collapseExpired();
    setBrowsing(!recent(roots[nextSection]));
    requestAnimationFrame(() => directory.current?.focus({ preventScroll: true }));
  }
  function toggle(page: FeedNotionPage, ancestors: string[]) {
    const open = expanded.has(page.url);
    if (busy || (loading || browsing) && !open && !hasSnapshot(children[page.url])) return;
    setExpanded(current => { const next = new Set(current); open ? next.delete(page.url) : next.add(page.url); return next; });
    deferredBranches.current = deferredBranches.current.filter(item => item.page.url !== page.url);
    if (!open && !recent(children[page.url])) {
      if (loading || browsing) deferredBranches.current.push({ page, ancestors });
      else void browse(page, undefined, ancestors);
    }
  }
  function beginCreate() {
    if (!parent || loading || busy || browsing || disabled) return;
    restoreCreateFocus.current = false; setShowCreate(true); setError(''); setExpanded(current => new Set(current).add(parent.url));
    if (!recent(children[parent.url])) void browse(parent, undefined, selectedPath.current);
  }
  function cancelCreate() {
    restoreCreateFocus.current = true;
    setShowCreate(false); setPageTitle(''); setError(''); createRequest.current = undefined;
  }
  async function createPage() {
    const title = pageTitle.trim(), owner = workspace.current;
    if (busy || loading || browsing || disabled || !parent || !owner || !title) return;
    const token = ++searchSequence.current;
    setActionBusy(true); setError('');
    // An unconfirmed or late write must force the next expansion to read Notion.
    cache.children = { ...children, [parent.url]: { pages: children[parent.url]?.pages ?? [] } }; setChildren(cache.children);
    let command = createRequest.current;
    if (!command || command.collectionId !== collection.id || command.workspaceId !== owner || command.parentPageId !== parent.id || command.title !== title || command.expectedRevision !== collection.revision) {
      command = { type: 'create_feed_notion_page', collectionId: collection.id, workspaceId: owner, parentPageId: parent.id, title, expectedRevision: collection.revision, requestId: crypto.randomUUID() };
      createRequest.current = command;
    }
    try {
      const next = (await port.current(command)).notion!;
      if (alive.current && collectionOwner.current === collection.id && token === searchSequence.current && workspace.current === owner) {
        if (!next.createdPage || next.workspace?.id !== owner) throw Error('未能确认新建页面，请重新展开父页面核对。');
        const page = next.createdPage;
        selectedPath.current = [...selectedPath.current, parent.url];
        setChildren(current => ({ ...current, [parent.url]: { pages: [...(current[parent.url]?.pages ?? []).filter(item => item.url !== page.url), page], readAt: Date.now() } })); select(page);
        setExpanded(current => new Set(current).add(parent.url));
        setShowCreate(false); setPageTitle(''); createRequest.current = undefined;
        requestAnimationFrame(() => { const button = directory.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]'); button?.focus(); button?.scrollIntoView({ block: 'nearest' }); });
      }
    } catch (caught) { if (alive.current && collectionOwner.current === collection.id && token === searchSequence.current) setError(String(caught)); }
    finally { if (alive.current && collectionOwner.current === collection.id && token === searchSequence.current) setActionBusy(false); }
  }
  async function save(pageId: string | null) {
    if (busy || loading || disabled || showCreate || !status.workspace && pageId !== null) return;
    setActionBusy(true); setError('');
    try {
      const reply = await port.current({ type: 'set_feed_notion_target', collectionId: collection.id, workspaceId: status.workspace?.id ?? status.target!.workspace.id, pageId, expectedRevision: collection.revision, requestId: crypto.randomUUID() });
      if (alive.current) { apply(reply.notion!); select(null); onSaved(); }
    } catch (caught) { if (alive.current) setError(String(caught)); }
    finally { if (alive.current) setActionBusy(false); }
  }
  function rows(items: FeedNotionPage[], ancestors: string[] = []): ReactNode {
    return <ul>{items.filter(page => !ancestors.includes(page.url)).map(page => {
      const branch = children[page.url], open = expanded.has(page.url), pending = browsing && reading === page.url;
      return <li key={page.url}>
        <div className={`feed-notion-node${selected?.url === page.url ? ' is-selected' : ''}`}>
          {page.type !== 'database' ? <button type="button" className="icon-button feed-notion-expand" aria-label={`${open ? '折叠' : '展开'} ${page.title || '未命名页面'}`} aria-expanded={open} disabled={busy || (loading || browsing) && !open && !hasSnapshot(branch)} onClick={() => toggle(page, ancestors)}><Icon name="chevron" size={14} /></button> : <span className="feed-notion-toggle-space" />}
          <button type="button" className="feed-notion-choice" aria-pressed={selected?.url === page.url} disabled={busy || showCreate} onClick={() => { selectedPath.current = ancestors; select(page); }}><Icon name={page.type === 'database' ? 'book' : 'folder'} size={16} /><span>{page.title || '未命名页面'}</span>{page.type === 'database' && <small>数据库</small>}</button>
        </div>
        {open && <div className="feed-notion-children">
          {branch?.error && <p className="inline-error" role="alert">{branch.error}<button type="button" className="text-button" aria-label={`重试读取 ${page.title || '未命名页面'} 的子页面`} disabled={loading || busy || browsing} onClick={() => void browse(page, undefined, ancestors)}>重试读取</button></p>}
          {!pending && branch && !branch.error && !branch.pages.length && <p className="muted">此页面没有子页面，可保存到此页面。</p>}
          {branch && rows(branch.pages, [...ancestors, page.url])}
        </div>}
      </li>;
    })}</ul>;
  }
  if (!open) return null;
  const connectionLabel = linking === 'opening' ? '正在打开链接' : loading ? '检查授权状态' : status.connected ? '已链接' : linking === 'waiting' && status.pending ? '等待授权' : '未链接';
  return <Dialog title="Notion 保存位置" onClose={onClose}><div className="feed-notion form-stack"><div className="feed-notion-content" role="region" aria-label="Notion 保存位置内容" aria-busy={loading || busy} tabIndex={0}>
    <p>当前信息流：{collection.name}</p>
    {executing && <p className="muted feed-notion-executing" role="status">信息流正在执行，可查看连接和目录；执行结束后可修改配置。</p>}
    {status.workspace && <p>当前工作区：<strong>{status.workspace.name}</strong></p>}
    {status.target && <p>当前保存位置：<strong>{status.target.title || '未命名页面'}</strong> · {status.target.type === 'database' ? '数据库' : '页面'}</p>}
    {(!showCreate && error || status.error) && <p className="inline-error" role="alert">{error || status.error}</p>}
    <button type="button" className={`button secondary${status.connected ? ' feed-notion-connected' : ''}`} disabled={status.connected || loading || busy || disabled} title={disabled ? '执行结束后可配置 Notion' : status.connected ? undefined : linking === 'waiting' ? '重新打开授权链接' : '点击链接 Notion'} onClick={() => void connect()}>{status.connected && !loading && <Icon name="check" size={16} />}<span aria-live="polite">{connectionLabel}</span></button>
    {(status.connected || loading && !!cache.workspaceId && !!roots[section]) && <>
      <div className="feed-notion-sections" role="group" aria-label="页面区域">{(['private', 'shared'] as const).map(value => <button type="button" key={value} className="button secondary compact" aria-pressed={section === value} disabled={loading || busy || browsing || showCreate} onClick={() => changeSection(value)}>{value === 'private' ? '私人页面' : '共享页面'}</button>)}</div>
      {!showCreate ? <div className="feed-notion-create-entry"><button ref={createTrigger} type="button" className="button secondary compact feed-notion-new-page" disabled={loading || busy || browsing || disabled || !parent} onClick={beginCreate}>新建页面</button></div> : <form className="form-stack feed-notion-create" aria-label="新建子页面" onSubmit={event => { event.preventDefault(); void createPage(); }} onKeyDown={event => { if (event.key === 'Escape' && !busy) { event.preventDefault(); event.stopPropagation(); cancelCreate(); } if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault(); }}>
        <p className="muted">父页面：{parent?.title || '未命名页面'}</p>
        <label>页面名称<input autoFocus name="notion-page-title" value={pageTitle} maxLength={200} required disabled={busy || disabled} onChange={event => setPageTitle(event.target.value)} placeholder="例如：调研资料" aria-describedby={error ? 'feed-notion-create-error' : undefined} /></label>
        {error && <p id="feed-notion-create-error" className="inline-error" role="alert">{error}</p>}
        <div className="feed-notion-create-entry"><button type="submit" className="button primary compact" disabled={loading || busy || browsing || disabled || !pageTitle.trim()}>{busy ? '正在新建…' : '创建页面'}</button><button type="button" className="button secondary compact" disabled={busy} onClick={cancelCreate}>取消</button></div>
      </form>}
      <nav ref={directory} className="feed-notion-pages" aria-label="Notion 页面树" aria-busy={browsing} tabIndex={-1}>
        {browsing && !reading && <p className="muted" role="status">正在读取目录…</p>}
        {directoryError && <p className="inline-error" role="alert">{directoryError}<button type="button" className="text-button" disabled={loading || browsing || busy} onClick={() => void browse()}>重试读取目录</button></p>}
        {!browsing && !directoryError && !pages.length && <p className="muted">{cursor ? '本页暂无条目，可继续加载。' : '暂无可访问的页面。'}</p>}
        {rows(pages)}
        {cursor && <button type="button" className="text-button" disabled={loading || busy || browsing} onClick={() => { directory.current?.focus(); void browse(undefined, cursor); }}>加载更多</button>}
      </nav>
    </>}
    </div><div className="feed-notion-actions" hidden={!status.connected && !status.target}>
      {status.connected && <>{selected && <p>本次选择：<strong>{selected.title || '未命名页面'}</strong></p>}<button type="button" className="button primary" disabled={loading || busy || browsing || disabled || showCreate || !selected} onClick={() => void save(selected!.id)}>保存位置</button></>}
      {status.target && <button type="button" className="text-button" disabled={loading || busy || disabled || showCreate} onClick={() => void save(null)}>清除保存位置</button>}
    </div>
  </div></Dialog>;
}
