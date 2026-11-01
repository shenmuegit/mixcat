import { useEffect, useRef, useState, type MouseEvent, type KeyboardEvent } from 'react';
import type { FeedCollectionSummary } from '../shared/feed';
import { feedTime, feedRunLabel, scheduleLabel } from './FeedCollection';
import { useFeedForm, useFeedPage, type FeedDraftPort } from './FeedForms';
import type { FeedExecute } from './FeedWorkspace';
import { Icon } from './Icon';
import { Dialog } from './Dialog';
export { FeedNewCollection } from './FeedNewCollection';
function FeedDeleteCollection({ item, execute, drafts, onClose, onDone, onRefresh, disabled }: { item: FeedCollectionSummary; execute: FeedExecute; drafts?: FeedDraftPort; onClose(): void; onDone(): void; onRefresh(): void; disabled: boolean }) {
  const form = useFeedForm(`collection:${item.id}:delete`, {}, drafts), cancel = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState('');
  const blocked = !!item.activeRun;
  async function remove() {
    setError('');
    try { if (await form.submit({ type: 'delete_feed_collection', collectionId: item.id, expectedRevision: item.revision, requestId: crypto.randomUUID() }, execute, {})) onDone(); }
    catch (caught) { setError(String(caught)); onRefresh(); }
  }
  return <Dialog title="删除信息流" initialFocus={cancel} onClose={() => { if (!form.busy) onClose(); }}><form className="form-stack" onSubmit={event => { event.preventDefault(); void remove(); }}>
    <p>确认删除「{item.name}」？</p><p className="muted">删除后不再定时执行，排队输入会撤回。已保存的结果与会话记录仍可追溯。</p>
    {blocked && <p role="status">删除前必须先安全停止并核对当前运行。</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {form.value.pending && <p role="status">删除请求尚待确认，重试会核实原操作。</p>}
    <div className="modal-actions"><button ref={cancel} type="button" className="button secondary" disabled={form.busy} onClick={onClose}>取消</button><button className="button primary danger-button" disabled={disabled || blocked || form.busy || !form.ready}>{form.busy ? '删除中…' : form.value.pending ? '重试删除' : '确认删除'}</button></div>
  </form></Dialog>;
}
export function FeedCollectionList({ execute, revision, onOpen, onNew, onError, drafts, disabled = false, active = true }: { execute: FeedExecute; revision: string; onOpen(id: string, button: HTMLButtonElement): void; onNew(button: HTMLButtonElement): void; onError(message: string): void; drafts?: FeedDraftPort; disabled?: boolean; active?: boolean }) {
  const [refresh, setRefresh] = useState(0), [menu, setMenu] = useState<{ item: FeedCollectionSummary; x: number; y: number } | null>(null), [deleting, setDeleting] = useState<FeedCollectionSummary | null>(null);
  const list = useRef<HTMLElement>(null), menuRef = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement | null>(null);
  const page = useFeedPage<FeedCollectionSummary>({ type: 'list_feed_collections' }, 'collectionPage', execute, `${revision}:${refresh}`, onError);
  useEffect(() => { if (!active || disabled) { setMenu(null); setDeleting(null); } }, [active, disabled]);
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    const close = () => setMenu(null);
    const outside = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as HTMLElement)) close(); };
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); trigger.current?.focus({ preventScroll: true }); }
      else if (event.key === 'Tab') { close(); trigger.current?.focus({ preventScroll: true }); }
      else if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) { event.preventDefault(); menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus(); }
    };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', key); document.addEventListener('scroll', close, true); window.addEventListener('resize', close);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key); document.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); };
  }, [menu]);
  function openMenu(event: MouseEvent<HTMLButtonElement> | KeyboardEvent<HTMLButtonElement>, item: FeedCollectionSummary) {
    event.preventDefault(); if (disabled || !active) return;
    trigger.current = event.currentTarget; const rect = event.currentTarget.getBoundingClientRect();
    setMenu({ item, x: 'clientX' in event ? event.clientX : rect.left + 12, y: 'clientY' in event ? event.clientY : rect.bottom });
  }
  function closeDialog() { setDeleting(null); requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true })); }
  return <section ref={list} className="feed-collection-list" aria-label="采集任务" tabIndex={-1}>
    {page.items.length ? <div className="project-grid">{page.items.map(item => <button className="project-card feed-card" type="button" key={item.id} aria-label={item.name} aria-haspopup="menu" onClick={event => onOpen(item.id, event.currentTarget)} onContextMenu={event => openMenu(event, item)} onKeyDown={event => { if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') openMenu(event, item); }}>
      <div className="project-card-top"><span className="project-icon"><Icon name="nodes" size={22} /></span><span className="feed-card-status">{item.requestCount || item.attentionCount ? '需要你处理' : item.queueHeld ? '队列待继续' : item.activeRun ? feedRunLabel(item.activeRun) : scheduleLabel(item.schedule)}</span></div>
      <h2>{item.name}</h2><p className="feed-card-objective">{item.instruction || '待沟通目标'}</p>
      {item.latestResult ? <div className="feed-card-result"><h3>{item.latestResult.title}</h3><p>{item.latestResult.excerpt}</p><time dateTime={item.latestResult.collectedAt}>{feedTime(item.latestResult.collectedAt)}</time></div> : <p className="muted">尚无执行结果</p>}
    </button>)}</div> : <section className="empty-workspace"><Icon name="nodes" size={32} /><h2>从一个采集开始</h2><p>和 Codex 沟通目标，定时收集你关注的信息。</p><button className="button secondary" disabled={disabled} onClick={event => onNew(event.currentTarget)}><Icon name="plus" size={16} />新建采集</button></section>}
    {page.cursor && <button className="button secondary" disabled={page.loading} onClick={() => void page.more()}>加载更多采集</button>}
    {menu && <div ref={menuRef} className="canvas-context-menu project-context-menu" role="menu" aria-label="信息流操作" style={{ left: Math.max(8, Math.min(menu.x, window.innerWidth - 190)), top: Math.max(32, Math.min(menu.y, window.innerHeight - 70)) }}><button type="button" role="menuitem" className="danger-button" onClick={() => { setDeleting(menu.item); setMenu(null); }}>删除信息流</button></div>}
    {deleting && <FeedDeleteCollection key={deleting.id} item={page.items.find(item => item.id === deleting.id) ?? deleting} drafts={drafts} execute={execute} disabled={disabled} onClose={closeDialog} onRefresh={() => setRefresh(n => n + 1)} onDone={() => { setDeleting(null); setRefresh(n => n + 1); requestAnimationFrame(() => list.current?.focus({ preventScroll: true })); }} />}
  </section>;
}
