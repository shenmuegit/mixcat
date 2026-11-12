import { useEffect, useRef, useState, type MouseEvent, type KeyboardEvent } from 'react';
import type { FeedCollectionSummary } from '../shared/feed';
import { feedTime, feedRunLabel, scheduleLabel } from './FeedCollection';
import { useFeedForm, useFeedPage, type FeedDraftPort } from './FeedForms';
import type { FeedExecute } from './FeedWorkspace';
import { Icon } from './Icon';
import { Dialog } from './Dialog';
import ReactMarkdown from 'react-markdown';
export { FeedNewCollection } from './FeedNewCollection';
function FeedEditCollection({ item, execute, drafts, onClose, onDone, disabled }: { item: FeedCollectionSummary; execute: FeedExecute; drafts?: FeedDraftPort; onClose(): void; onDone(): void; disabled: boolean }) {
  const initial = { name: item.name, instruction: item.instruction, base: { name: item.name, instruction: item.instruction, revision: item.revision } };
  const form = useFeedForm(`collection:${item.id}:edit`, initial, drafts), name = useRef<HTMLInputElement>(null);
  const [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const fields = form.value.fields, blocked = disabled || saving || !form.ready || !!form.value.pending;
  async function save() {
    setError(''); setSaving(true);
    try {
      const changes = { ...(fields.name !== fields.base.name ? { name: fields.name.trim() } : {}), ...(fields.instruction !== fields.base.instruction ? { instruction: fields.instruction } : {}) };
      if (await form.submit({ type: 'edit_feed_collection', collectionId: item.id, expectedRevision: fields.base.revision, requestId: crypto.randomUUID(), changes }, execute, initial)) onDone();
    } catch (caught) {
      setError(String(caught));
      if (String(caught).includes('采集任务版本冲突')) {
        try {
          const current = (await execute({ type: 'get_feed_collection', collectionId: item.id })).collection!.collection;
          form.change({ name: fields.name === fields.base.name ? current.name : fields.name, instruction: fields.instruction === fields.base.instruction ? current.instruction : fields.instruction, base: { name: current.name, instruction: current.instruction, revision: current.revision } });
        } catch (refreshError) { setError(`${String(caught)} ${String(refreshError)}`); }
      }
    } finally { setSaving(false); }
  }
  return <Dialog title="编辑信息流" initialFocus={name} onClose={() => { if (!saving) onClose(); }}><form className="form-stack" onSubmit={event => { event.preventDefault(); void save(); }}>
    <label>名称<input ref={name} required maxLength={512} value={fields.name} disabled={blocked} onChange={event => form.change({ ...fields, name: event.target.value })} /></label>
    <label>采集目标<textarea rows={5} value={fields.instruction} disabled={blocked} onChange={event => form.change({ ...fields, instruction: event.target.value })} /></label>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {form.value.pending && <p role="status">保存请求尚待确认，重试会核实原操作。</p>}
    <div className="modal-actions"><button type="button" className="button secondary" disabled={saving} onClick={onClose}>取消</button><button type="submit" className="button primary" disabled={disabled || saving || !form.ready || !fields.name.trim()}>{saving ? '保存中…' : form.value.pending ? '重试保存' : '保存'}</button></div>
  </form></Dialog>;
}
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
export function FeedCollectionList({ execute, revision, onOpen, onNew, onError, drafts, disabled = false, active = true, compact = false, selectedId, onDeleted }: { execute: FeedExecute; revision: string; onOpen(id: string, button: HTMLButtonElement): void; onNew(button: HTMLButtonElement): void; onError(message: string): void; drafts?: FeedDraftPort; disabled?: boolean; active?: boolean; compact?: boolean; selectedId?: string; onDeleted?(id: string): void }) {
  const [refresh, setRefresh] = useState(0), [menu, setMenu] = useState<{ item: FeedCollectionSummary; x: number; y: number } | null>(null), [deleting, setDeleting] = useState<FeedCollectionSummary | null>(null), [editing, setEditing] = useState<FeedCollectionSummary | null>(null);
  const list = useRef<HTMLElement>(null), menuRef = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement | null>(null);
  const page = useFeedPage<FeedCollectionSummary>({ type: 'list_feed_collections' }, 'collectionPage', execute, `${revision}:${refresh}`, onError);
  useEffect(() => { if (!active || disabled) { setMenu(null); setDeleting(null); setEditing(null); } }, [active, disabled]);
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    const close = () => setMenu(null);
    const outside = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as HTMLElement)) close(); };
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); trigger.current?.focus({ preventScroll: true }); }
      else if (event.key === 'Tab') { close(); trigger.current?.focus({ preventScroll: true }); }
      else if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])], current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
        buttons[index]?.focus();
      }
    };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', key); document.addEventListener('scroll', close, true); window.addEventListener('resize', close);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key); document.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); };
  }, [menu]);
  function openMenu(event: MouseEvent<HTMLButtonElement> | KeyboardEvent<HTMLButtonElement>, item: FeedCollectionSummary) {
    event.preventDefault(); if (disabled || !active) return;
    trigger.current = event.currentTarget; const rect = event.currentTarget.getBoundingClientRect();
    setMenu({ item, x: 'clientX' in event ? event.clientX : rect.left + 12, y: 'clientY' in event ? event.clientY : rect.bottom });
  }
  function closeDialog() { setDeleting(null); setEditing(null); requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true })); }
  return <section ref={list} className={`feed-collection-list${compact ? ' sidebar-feed-list' : ''}`} aria-label={compact ? '信息流列表' : '采集任务'} tabIndex={-1}>
    {compact && <header><h2>信息流</h2><button type="button" className="icon-button" aria-label="新建信息流" title="新建信息流" disabled={disabled} onClick={event => onNew(event.currentTarget)}><Icon name="plus" size={16} /></button></header>}
    {page.items.length ? <div className={compact ? 'workspace-list' : 'project-grid'}>{page.items.map(item => <button className={compact ? `sidebar-feed-item${selectedId === item.id ? ' active' : ''}` : 'project-card feed-card'} type="button" key={item.id} aria-label={item.name} aria-current={compact && selectedId === item.id ? 'page' : undefined} aria-haspopup="menu" onClick={event => onOpen(item.id, event.currentTarget)} onContextMenu={event => openMenu(event, item)} onKeyDown={event => { if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') openMenu(event, item); }}>
      {compact ? <><Icon name="nodes" size={14} /><span className="sidebar-item-copy"><span>{item.name}</span><small>{item.requestCount || item.attentionCount ? '需要你处理' : item.queueHeld ? '队列待继续' : item.activeRun ? feedRunLabel(item.activeRun) : scheduleLabel(item.schedule)}</small></span></> : <>
      <div className="project-card-top"><span className="project-icon"><Icon name="nodes" size={22} /></span><span className="feed-card-status">{item.requestCount || item.attentionCount ? '需要你处理' : item.queueHeld ? '队列待继续' : item.activeRun ? feedRunLabel(item.activeRun) : scheduleLabel(item.schedule)}</span></div>
      <h2>{item.name}</h2><p className="feed-card-objective">{item.instruction || '待沟通目标'}</p>
      {item.latestResult ? <div className="feed-card-result"><h3>{item.latestResult.title}</h3><p><ReactMarkdown allowedElements={[]} unwrapDisallowed skipHtml>{item.latestResult.excerpt}</ReactMarkdown></p><time dateTime={item.latestResult.collectedAt}>{feedTime(item.latestResult.collectedAt)}</time></div> : <p className="muted">尚无执行结果</p>}
      </>}
    </button>)}</div> : compact ? <p className="sidebar-empty">暂无信息流</p> : <section className="empty-workspace"><Icon name="nodes" size={32} /><h2>从一个采集开始</h2><p>和 Codex 沟通目标，定时收集你关注的信息。</p><button className="button secondary" disabled={disabled} onClick={event => onNew(event.currentTarget)}><Icon name="plus" size={16} />新建采集</button></section>}
    {page.cursor && <button className="button secondary" disabled={page.loading} onClick={() => void page.more()}>加载更多采集</button>}
    {menu && <div ref={menuRef} className="canvas-context-menu project-context-menu" role="menu" aria-label="信息流操作" style={{ left: Math.max(8, Math.min(menu.x, window.innerWidth - 190)), top: Math.max(32, Math.min(menu.y, window.innerHeight - 110)) }}><button type="button" role="menuitem" onClick={() => { setEditing(menu.item); setMenu(null); }}>编辑信息流</button><button type="button" role="menuitem" className="danger-button" onClick={() => { setDeleting(menu.item); setMenu(null); }}>删除信息流</button></div>}
    {editing && <FeedEditCollection key={editing.id} item={editing} drafts={drafts} execute={execute} disabled={disabled} onClose={closeDialog} onDone={() => { closeDialog(); setRefresh(n => n + 1); }} />}
    {deleting && <FeedDeleteCollection key={deleting.id} item={page.items.find(item => item.id === deleting.id) ?? deleting} drafts={drafts} execute={execute} disabled={disabled} onClose={closeDialog} onRefresh={() => setRefresh(n => n + 1)} onDone={() => { onDeleted?.(deleting.id); setDeleting(null); setRefresh(n => n + 1); requestAnimationFrame(() => list.current?.focus({ preventScroll: true })); }} />}
  </section>;
}
