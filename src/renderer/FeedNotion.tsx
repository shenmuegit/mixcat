import { useEffect, useRef, useState } from 'react';
import type { FeedCollection, FeedNotionPage, FeedNotionStatus } from '../shared/feed';
import type { FeedExecute } from './FeedWorkspace';
import { Dialog } from './Dialog';

export function FeedNotion({ collection, execute, revision, disabled, onSaved, onClose }: { collection: FeedCollection; execute: FeedExecute; revision: string; disabled: boolean; onSaved(): void; onClose(): void }) {
  const [status, setStatus] = useState<FeedNotionStatus>({ connected: false });
  const [error, setError] = useState(''), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [query, setQuery] = useState(''), [pages, setPages] = useState<FeedNotionPage[]>([]), [selected, select] = useState('');
  const port = useRef(execute); port.current = execute;
  const alive = useRef(true), workspace = useRef<string | undefined>(undefined), searchSequence = useRef(0);
  useEffect(() => () => { alive.current = false; searchSequence.current++; }, []);
  function apply(next: FeedNotionStatus) {
    if (workspace.current !== next.workspace?.id) { workspace.current = next.workspace?.id; searchSequence.current++; setPages([]); select(''); setBusy(false); }
    setStatus(next);
  }
  useEffect(() => {
    let cancelled = false; setLoading(true);
    void port.current({ type: 'read_feed_notion', collectionId: collection.id }).then(reply => { if (!cancelled) { apply(reply.notion!); setError(''); } }).catch(caught => { if (!cancelled) setError(String(caught)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [collection.id, revision]);
  async function connect() {
    if (busy || loading) return; setBusy(true); setError('');
    try {
      const next = status.pending && status.authorizationUrl ? status : (await port.current({ type: 'connect_feed_notion', collectionId: collection.id })).notion!;
      if (!alive.current) return;
      apply(next);
      if (!next.authorizationUrl) throw Error('Notion 未返回授权地址。');
      if (!window.mixcat.openExternal) throw Error('当前客户端无法打开授权页。');
      await window.mixcat.openExternal(next.authorizationUrl);
    } catch (caught) { if (alive.current) setError(String(caught)); }
    finally { if (alive.current) setBusy(false); }
  }
  async function search() {
    if (busy || loading || !query.trim() || !workspace.current) return;
    const token = ++searchSequence.current, owner = workspace.current;
    setBusy(true); setError(''); select('');
    try { const next = (await port.current({ type: 'search_feed_notion', collectionId: collection.id, query: query.trim() })).notion!; if (alive.current && token === searchSequence.current && owner === workspace.current) setPages(next.pages ?? []); }
    catch (caught) { if (alive.current && token === searchSequence.current) setError(String(caught)); }
    finally { if (alive.current && token === searchSequence.current) setBusy(false); }
  }
  async function save(pageId: string | null) {
    if (busy || loading || disabled || !status.workspace && pageId !== null) return;
    setBusy(true); setError('');
    try {
      const reply = await port.current({ type: 'set_feed_notion_target', collectionId: collection.id, workspaceId: status.workspace?.id ?? status.target!.workspace.id, pageId, expectedRevision: collection.revision, requestId: crypto.randomUUID() });
      if (alive.current) { apply(reply.notion!); select(''); onSaved(); }
    } catch (caught) { if (alive.current) setError(String(caught)); }
    finally { if (alive.current) setBusy(false); }
  }
  return <Dialog title="Notion 保存位置" onClose={onClose}><div className="feed-notion form-stack">
    <p>当前信息流：{collection.name}</p>
    {loading && <p role="status">正在读取连接…</p>}
    {status.workspace && <p>当前工作区：<strong>{status.workspace.name}</strong></p>}
    {status.target && <p>当前保存位置：<strong>{status.target.title || '未命名页面'}</strong> · {status.target.type === 'database' ? '数据库' : '页面'}</p>}
    {status.pending && <p role="status">请在浏览器中的 Notion 官方页面完成授权。</p>}
    {(error || status.error) && <p className="inline-error" role="alert">{error || status.error}</p>}
    <button type="button" className="button secondary" disabled={loading || busy || disabled} title={disabled ? '执行结束后可配置 Notion' : undefined} onClick={() => void connect()}>{status.pending ? '打开授权页' : status.connected ? '重新连接 Notion' : '连接 Notion'}</button>
    {status.connected && <>
      <form onSubmit={event => { event.preventDefault(); void search(); }}><label>保存到页面或数据库<div className="input-with-button"><input aria-label="搜索 Notion 保存位置" disabled={loading || busy} value={query} onChange={event => setQuery(event.target.value)} placeholder="输入名称搜索" /><button type="submit" className="button secondary" disabled={loading || busy || !query.trim()}>搜索</button></div></label></form>
      <div className="feed-notion-pages" role="group" aria-label="Notion 保存位置">{pages.map(page => <button type="button" className="button secondary" key={page.id} aria-pressed={selected === page.id} onClick={() => select(page.id)}><span>{page.title || '未命名页面'}</span><small>{page.url}</small></button>)}</div>
      <button type="button" className="button primary" disabled={loading || busy || disabled || !selected} onClick={() => void save(selected)}>保存位置</button>
    </>}
    {status.target && <button type="button" className="text-button" disabled={loading || busy || disabled} onClick={() => void save(null)}>清除保存位置</button>}
  </div></Dialog>;
}
