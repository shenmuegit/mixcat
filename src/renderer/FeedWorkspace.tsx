import { FeedCollection, type FeedMaterialLabel } from './FeedCollection';
import { FeedCollectionList, FeedProposal, emptyProposal } from './FeedCollectionList';
import type { FeedDraftPort, FormDraft } from './FeedForms';
import type { FeedCollectionDetail } from '../shared/feed';
import { useEffect, useRef, useState } from 'react';
import type { FeedCommand, FeedCommandResult, FeedEntry, FeedEntryMutation, FeedEntrySummary, FeedQuery, FeedSnapshot } from '../shared/feed';
import { FeedReader, type ReaderEdit } from './FeedReader';
import { COMMAND_JSON_LIMIT } from '../shared/commands';
import './feed.css';
export type FeedExecute = (command: FeedCommand) => Promise<FeedCommandResult>;
type DraftState = { text: string; saved: string; revision: number; version: number; loaded: boolean; error: string | null };
export function FeedWorkspace({ snapshot, execute, onError, active = true, runtimeRevision = 0 }: { snapshot: FeedSnapshot | null; execute: FeedExecute; onError(message: string): void; active?: boolean; runtimeRevision?: number }) {
  const [view, setView] = useState<FeedQuery['view']>('all'), [query, setQuery] = useState(''), [source, setSource] = useState('');
  const [items, setItems] = useState<FeedEntrySummary[]>([]), [cursor, setCursor] = useState<string | null>(null), [refresh, setRefresh] = useState(0);
  const [entry, setEntry] = useState<FeedEntry | null>(null), [composing, setComposing] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [undo, setUndo] = useState<{ id: string; until: number } | null>(null), [, renderDrafts] = useState(0);
  const drafts = useRef(new Map<string, DraftState>()), timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const draftLoads = useRef(new Map<string, Promise<void>>());
  const draftRequests = useRef(new Map<string, { text: string; revision: number; requestId: string }>());
  const createRequest = useRef<{ fingerprint: string; requestId: string } | null>(null);
  const serial = useRef(Promise.resolve()), querySequence = useRef(0), readerSequence = useRef(0), selected = useRef<string | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const loadedPages = useRef(1), loadedScope = useRef('');
  const disabled = !!snapshot?.storageError || !snapshot;
  const activeNow = useRef(active); activeNow.current = active;
  const [rootView, setRootView] = useState<'content' | 'collections'>('content'), [proposal, setProposal] = useState(false);
  const [collectionId, setCollectionId] = useState<string | null>(null), [collectionDetails, setCollectionDetails] = useState<Record<string, FeedCollectionDetail>>({});
  const [materials, setMaterials] = useState<FeedMaterialLabel[]>([]), [sources, setSources] = useState<{id: string; name: string}[]>([]), [sourceLimit,setSourceLimit] = useState(20), [followMaterial,setFollowMaterial] = useState<FeedMaterialLabel | null>(null);
  const [composeIntent, setComposeIntent] = useState<{id: string; version: number} | null>(null);
  const collectionSequence = useRef(0), chosenCollection = useRef<string | null>(null), collectionTrigger = useRef<HTMLButtonElement | null>(null), returnToCollection = useRef(false);
  const draftPort: FeedDraftPort = { text: key => draft(key).text, loaded: key => draft(key).loaded, load: loadDraft, edit: editDraft, save: saveDraft };
  useEffect(() => { readerSequence.current++; }, [active]);
  useEffect(() => {
    if (!collectionId || rootView !== 'collections') return; const id = collectionId, token = ++collectionSequence.current;
    void execute({ type: 'get_feed_collection', collectionId: id }).then(reply => { if (token === collectionSequence.current && chosenCollection.current === id) setCollectionDetails(values => !values[id] || reply.collection!.collection.revision >= values[id].collection.revision ? { ...values, [id]: reply.collection! } : values); }).catch(caught => { if (token === collectionSequence.current) fail(caught); });
    return () => { collectionSequence.current++; };
  }, [collectionId, rootView, snapshot?.generation, snapshot?.revision, refresh, runtimeRevision]);
  function navigateRoot(next: typeof rootView) { setError(''); returnToCollection.current = false; readerSequence.current++; collectionSequence.current++; setRootView(next); setProposal(false); }
  function openCollection(id: string, button?: HTMLButtonElement, keepSources = false) { if (!keepSources) { setSources([]); setFollowMaterial(null); } setError(''); readerSequence.current++; chosenCollection.current = id; setCollectionId(id); setRootView('collections'); setProposal(false); if (button) collectionTrigger.current = button; }
  function backCollections() { readerSequence.current++; collectionSequence.current++; chosenCollection.current = null; setCollectionId(null); setSources([]); setFollowMaterial(null); requestAnimationFrame(() => collectionTrigger.current?.focus()); }
  async function propose(selectedMaterials?: FeedMaterialLabel[], button?: HTMLButtonElement) {
    const epoch = ++readerSequence.current; if (button) collectionTrigger.current = button;
    try { await loadDraft('collection:new'); if (epoch !== readerSequence.current) return;
      if (selectedMaterials) { const existing: FormDraft<typeof emptyProposal> = draft('collection:new').text ? JSON.parse(draft('collection:new').text) : { fields: emptyProposal, version: 0 }; editDraft('collection:new', JSON.stringify({ ...existing, clean: false, version: existing.version + 1, fields: { ...existing.fields, materials: selectedMaterials, name: existing.fields.name || (selectedMaterials.length === 1 ? `关于${selectedMaterials[0].title}` : '多来源调研') } })); }
      setProposal(true); setComposing(false);
    } catch(caught) { if (epoch === readerSequence.current) fail(caught); }
  }
  async function attachAndOpen(id: string, material: FeedMaterialLabel) {
    const epoch = ++readerSequence.current, key = `collection:${id}:message`;
    await loadDraft(key); if (epoch !== readerSequence.current) return;
    const previous: FormDraft<{text: string; materials: FeedMaterialLabel[]}> = draft(key).text ? JSON.parse(draft(key).text) : { fields: { text: '', materials: [] }, version: 0 };
    if (!previous.fields.materials.some(value => value.id === material.id)) { if (previous.fields.materials.length >= 50) throw Error('最多引用 50 条资料。'); editDraft(key, JSON.stringify({ ...previous, clean: false, version: previous.version + 1, fields: { ...previous.fields, materials: [...previous.fields.materials,material] } })); }
    openCollection(id, undefined, true); setComposeIntent(previous => ({ id, version: (previous?.version ?? 0) + 1 }));
  }
  async function followUp(current: FeedEntry, button: HTMLButtonElement) {
    const epoch = ++readerSequence.current; collectionTrigger.current = button; setSources([]); setSourceLimit(20);
    const material = { id: current.id, title: current.title, deletedAt: current.deletedAt };
    try {
      const options: {id: string; name: string}[] = []; const latest = (await execute({type:'get_feed_entry',entryId:current.id})).entry!; if (epoch !== readerSequence.current) return; if (latest.deletedAt) throw Error('这条资料已删除，请先恢复再追问。'); let discoveries = latest.discoveries;
      while (true) { for (const discovery of discoveries.items) { const c = discovery.collection; if (c && !c.deletedAt && !options.some(value => value.id === c.id)) options.push({ id: c.id, name: c.name }); } if (!discoveries.nextCursor) break; discoveries = (await execute({ type:'get_feed_entry',entryId:current.id,discoveryCursor:discoveries.nextCursor })).entry!.discoveries; if (epoch !== readerSequence.current) return; }
      if (epoch !== readerSequence.current) return;
      setSources(options); setFollowMaterial(material);
      if (options.length) await attachAndOpen(options[0].id, material); else await propose([material],button);
    } catch(caught) { if (epoch === readerSequence.current) fail(caught); }
  }
  function toggleMaterial(item: FeedEntrySummary) { setMaterials(values => { if (values.some(value => value.id === item.id)) return values.filter(value => value.id !== item.id); if (values.length >= 50) { setError('最多选择 50 条资料。'); return values; } return [...values,{id:item.id,title:item.title,deletedAt:item.deletedAt}]; }); }

  function fail(caught: unknown) { const message = caught instanceof Error ? caught.message : String(caught); setError(message); onError(message); }
  function dirty() { void window.mixcat?.setFeedUnsaved?.([...drafts.current.values()].some(value => value.text !== value.saved)).catch(fail); }
  function draft(key: string): DraftState {
    let value = drafts.current.get(key);
    if (!value) { value = { text: '', saved: '', revision: 0, version: 0, loaded: false, error: null }; drafts.current.set(key, value); }
    return value;
  }
  async function loadDraft(key: string, fallback = '') {
    const value = draft(key); if (value.loaded) return;
    if (draftLoads.current.has(key)) return draftLoads.current.get(key);
    const version = value.version;
    const loading = (async () => {
    try {
      const reply = await execute({ type: 'read_feed_draft', key });
      value.revision = reply.draft?.revision ?? 0; value.saved = reply.draft?.text ?? fallback; value.loaded = true;
      if (value.version === version) value.text = value.saved;
      renderDrafts(n => n + 1); dirty();
    } catch (caught) { fail(caught); }
    })();
    draftLoads.current.set(key, loading);
    try { await loading; } finally { draftLoads.current.delete(key); }
  }
  function enqueue(operation: () => Promise<void>) { const next = serial.current.then(operation); serial.current = next.catch(() => {}); return next; }
  function saveDraft(key: string) {
    clearTimeout(timers.current.get(key));
    return enqueue(async () => {
      const value = draft(key); if (!value.loaded) await loadDraft(key);
      if (!value.loaded) throw Error('草稿尚未读取，请重试。');
      try {
        while (draftRequests.current.has(key) || value.text !== value.saved) {
          let request = draftRequests.current.get(key);
          if (!request) {
            if (new TextEncoder().encode(value.text).length > 1024 * 1024) throw Error('草稿超过 1 MiB，请缩短当前输入后重试。');
            request = { text: value.text, revision: value.revision, requestId: crypto.randomUUID() };
            const command: FeedCommand = { type: 'save_feed_draft', draft: { key, text: request.text }, expectedRevision: request.revision, requestId: request.requestId };
            // App wraps this command in another UUID of the same serialized length.
            if (JSON.stringify({ id: request.requestId, command }).length > COMMAND_JSON_LIMIT) throw Error('草稿请求超过传输上限，请缩短当前输入后重试。');
            draftRequests.current.set(key, request);
          }
          const reply = await execute({ type: 'save_feed_draft', draft: { key, text: request.text }, expectedRevision: request.revision, requestId: request.requestId });
          value.revision = reply.draft!.revision; value.saved = request.text; value.error = null;
          draftRequests.current.delete(key);
        }
      } catch (caught) { value.error = String(caught); throw caught; }
      finally { dirty(); renderDrafts(n => n + 1); }
    });
  }
  function editDraft(key: string, text: string) {
    const value = draft(key); value.text = text; value.version++; renderDrafts(n => n + 1); dirty();
    clearTimeout(timers.current.get(key)); timers.current.set(key, setTimeout(() => { void saveDraft(key).then(() => key.startsWith('note:') ? saveNote(key.slice(5)) : undefined).catch(fail); }, 400));
  }
  function setCurrent(next: FeedEntry) { setEntry(current => selected.current === next.id && (!current || next.revision >= current.revision) ? next : current); }
  async function saveNote(id: string) {
    try { await enqueue(async () => {
      const value = draft(`note:${id}`), note = value.text;
      const current = (await execute({ type: 'get_feed_entry', entryId: id })).entry!;
      if (current.note === note) { value.error = null; return; }
      const reply = await execute({ type: 'update_feed_entry', mutation: { operation: 'saveNote', id, note, expectedRevision: current.revision, requestId: crypto.randomUUID() } });
      value.error = null; setCurrent(reply.entry!); setRefresh(n => n + 1);
    }); } catch (caught) { draft(`note:${id}`).error = String(caught); renderDrafts(n => n + 1); throw caught; }
  }
  const scope = JSON.stringify({ view, text: query, collectionId: source || undefined });
  useEffect(() => {
    const sequence = ++querySequence.current;
    if (loadedScope.current !== scope) { loadedScope.current = scope; loadedPages.current = 1; }
    void (async () => {
      const refreshed: FeedEntrySummary[] = []; let nextCursor: string | undefined;
      for (let page = 0; page < loadedPages.current; page++) {
        const reply = await execute({ type: 'search_feed_entries', query: { ...JSON.parse(scope), ...(nextCursor ? { cursor: nextCursor } : {}) } });
        if (sequence !== querySequence.current) return;
        refreshed.push(...reply.entries!.items); nextCursor = reply.entries!.nextCursor ?? undefined;
        if (!nextCursor) break;
      }
      setItems(refreshed); setCursor(nextCursor ?? null);
    })().catch(caught => { if (sequence === querySequence.current) fail(caught); });
    return () => { querySequence.current++; };
  }, [scope, refresh, snapshot?.generation, snapshot?.revision]);
  useEffect(() => { if (!disabled) for (const key of ['manual', 'manual:title', 'manual:sourceUrl']) void loadDraft(key); }, [disabled]);
  useEffect(() => { if (!undo) return; const timer = setTimeout(() => setUndo(null), Math.max(0, undo.until - Date.now())); return () => clearTimeout(timer); }, [undo]);
  useEffect(() => () => { for (const timer of timers.current.values()) clearTimeout(timer); }, []);
  async function open(id: string, button: HTMLButtonElement, fromCollection = false) {
    returnToCollection.current = fromCollection;
    trigger.current = button; selected.current = id; const sequence = ++readerSequence.current; setEntry(null); setComposing(false);
    try {
      const reply = await execute({ type: 'get_feed_entry', entryId: id });
      if (sequence !== readerSequence.current) return;
      const next = reply.entry!; setEntry(next); await loadDraft(`note:${id}`, next.note);
      if (sequence !== readerSequence.current) return;
      if (!next.readAt && !next.deletedAt) await mutate(id, { operation: 'setRead', read: true });
    } catch (caught) { fail(caught); }
  }
  async function mutate(id: string, edit: ReaderEdit) {
    setBusy(true); setError('');
    try { await enqueue(async () => {
      const current = (await execute({ type: 'get_feed_entry', entryId: id })).entry!;
      const mutation = { ...edit, id, expectedRevision: current.revision, requestId: crypto.randomUUID() } as FeedEntryMutation;
      const result = await execute({ type: 'update_feed_entry', mutation }); setCurrent(result.entry!);
      if (edit.operation === 'delete') setUndo({ id, until: Date.now() + 8000 });
      if (edit.operation === 'restore') { setUndo(null); if (view === 'trash') closeReader(); }
      setRefresh(n => n + 1);
    }); } catch (caught) { fail(caught); } finally { setBusy(false); }
  }
  async function createText() {
    const navigation = readerSequence.current;
    setBusy(true); setError('');
    try {
      const keys = ['manual', 'manual:title', 'manual:sourceUrl'];
      for (const key of keys) await saveDraft(key);
      const value = draft('manual'), versions = keys.map(key => draft(key).version);
      const input = { title: draft('manual:title').text, body: value.text, sourceUrl: draft('manual:sourceUrl').text };
      const fingerprint = JSON.stringify(input);
      if (createRequest.current?.fingerprint !== fingerprint) createRequest.current = { fingerprint, requestId: crypto.randomUUID() };
      const reply = await execute({ type: 'update_feed_entry', mutation: { operation: 'createText', input: { title: input.title || input.body?.slice(0, 36), body: input.body || '', ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}), coverage: 'full' }, requestId: createRequest.current.requestId } });
      createRequest.current = null;
      if (reply.receipt?.outcome === 'suppressed_deleted' || reply.receipt?.outcome === 'duplicate' && (reply.entry?.body !== input.body || reply.entry.title !== (input.title || input.body.slice(0, 36)))) {
        setError(reply.receipt.outcome === 'suppressed_deleted' ? '该来源已在回收站，请在回收站恢复。当前输入已保留。' : '该来源已有不同内容，新输入尚未保存，当前草稿已保留。');
        setRefresh(n => n + 1); return;
      }
      if (keys.every((key, index) => draft(key).version === versions[index])) {
        for (const key of keys) editDraft(key, '');
        const consumedVersions = keys.map(key => draft(key).version);
        for (const key of keys) await saveDraft(key);
        if (readerSequence.current === navigation && keys.every((key, index) => draft(key).version === consumedVersions[index])) setComposing(false);
      }
      if (readerSequence.current === navigation) { selected.current = reply.entry!.id; readerSequence.current++; setEntry(reply.entry!); await loadDraft(`note:${reply.entry!.id}`, reply.entry!.note); await mutate(reply.entry!.id, { operation: 'setRead', read: true }); }
      setRefresh(n => n + 1);
    } catch (caught) { fail(caught); } finally { setBusy(false); }
  }
  const manual = { title: draft('manual:title').text, body: draft('manual').text, sourceUrl: draft('manual:sourceUrl').text };
  function manualField(field: string, text: string) { editDraft(field === 'body' ? 'manual' : `manual:${field}`, text); }
  function closeReader() { readerSequence.current++; selected.current = null; setEntry(null); if (returnToCollection.current) { returnToCollection.current = false; setRootView('collections'); } requestAnimationFrame(() => trigger.current?.focus()); }
  async function more() {
    const sequence = querySequence.current; if (!cursor) return;
    try { const reply = await execute({ type: 'search_feed_entries', query: { ...JSON.parse(scope), cursor } }); if (sequence === querySequence.current) { loadedPages.current++; setItems(current => [...current, ...reply.entries!.items.filter(item => !current.some(previous => previous.id === item.id))]); setCursor(reply.entries!.nextCursor); } } catch (caught) { fail(caught); }
  }
  return <main className="feed-workspace"><header className="page-heading"><div><h1>信息流</h1><p className="muted">按收集时间排列 · 个人资料</p></div><div className="feed-actions"><button className="button primary" disabled={disabled} onClick={event => void propose(undefined,event.currentTarget)}>新建采集</button><button className="button secondary" disabled={disabled} onClick={() => { readerSequence.current++; setProposal(false); setRootView('content'); setComposing(true); }}>保存文本</button></div></header>{(snapshot?.storageError || error) && <p className="inline-error" role="alert">{snapshot?.storageError || error}</p>}{[...drafts.current.values()].some(value => value.error) && <button className="button secondary" onClick={() => { for (const [key, value] of drafts.current) if (value.text !== value.saved || value.error) void saveDraft(key).then(() => key.startsWith('note:') ? saveNote(key.slice(5)) : undefined).catch(fail); }}>重试保存草稿</button>}<nav className="feed-views" aria-label="个人工作区"><button className="button secondary" aria-pressed={rootView === 'content' && !proposal} onClick={() => navigateRoot('content')}>内容</button><button className="button secondary" aria-pressed={rootView === 'collections' && !proposal} onClick={() => navigateRoot('collections')}>采集任务</button></nav>
    {proposal && <FeedProposal drafts={draftPort} execute={execute} disabled={disabled} navigation={() => readerSequence.current} onClose={() => { readerSequence.current++; setProposal(false); requestAnimationFrame(() => collectionTrigger.current?.focus()); }} onAccepted={(id,epoch) => { if (activeNow.current && epoch === readerSequence.current) openCollection(id); setRefresh(n=>n+1); }} onError={fail} />}
    <div hidden={rootView !== 'collections' || proposal} className="feed-collection-host">
      <div hidden={!!collectionId}><FeedCollectionList execute={execute} revision={`${snapshot?.generation}:${snapshot?.revision}:${refresh}:${runtimeRevision}`} onOpen={openCollection} onError={fail} /></div>
      {sources.length > 1 && followMaterial && <section aria-label="来源采集任务"><p>追问资料：{followMaterial.title} · 选择来源对话</p><div className="feed-actions">{sources.slice(0,sourceLimit).map(c=><button className="button secondary" aria-pressed={collectionId===c.id} key={c.id} onClick={()=>void attachAndOpen(c.id,followMaterial).catch(fail)}>{c.name}</button>)}{sources.length>sourceLimit&&<button className="button secondary" onClick={()=>setSourceLimit(n=>n+20)}>更多来源任务</button>}</div></section>}
      {collectionId && !collectionDetails[collectionId] && <p role="status">正在读取采集对话…</p>}
      {Object.values(collectionDetails).map(detail=><div key={detail.collection.id} hidden={detail.collection.id!==collectionId}><FeedCollection composeRequest={composeIntent?.id === detail.collection.id ? composeIntent.version : 0} detail={detail} execute={execute} drafts={draftPort} revision={`${snapshot?.generation}:${snapshot?.revision}:${refresh}:${runtimeRevision}`} disabled={disabled} active={active && rootView==='collections' && detail.collection.id===collectionId} onBack={backCollections} onRefresh={()=>setRefresh(n=>n+1)} onError={fail} onNavigate={()=>{readerSequence.current++;}} onRead={(id,button)=>{setRootView('content');void open(id,button,true);}} /></div>)}
    </div>
    <div hidden={rootView !== 'content' || proposal} className="feed-content-host"><nav className="feed-views" aria-label="信息流视图">{Object.entries({ all: '全部内容', unread: '未读', saved: '收藏', trash: '回收站' }).map(([key, label]) => <button className="button secondary" key={key} aria-pressed={view === key} onClick={() => { closeReader(); setView(key as FeedQuery['view']); }}>{label}{key === 'unread' ? ` ${snapshot?.unreadCount ?? 0}` : ''}</button>)}</nav>{undo && <p role="status">已移到回收站 <button className="button secondary compact" onClick={() => void mutate(undo.id, { operation: 'restore' })}>撤销删除</button></p>}<div className="feed-actions"><button className="button secondary" disabled={disabled || !materials.length} onClick={event=>void propose(materials,event.currentTarget)}>继续调研（{materials.length}）</button>{!!materials.length && <button className="text-button" onClick={()=>setMaterials([])}>清除选择</button>}</div><div className="feed-tools"><label>搜索内容<input aria-label="搜索信息流" value={query} onChange={event => setQuery(event.target.value)} placeholder="标题、正文、摘要或备注" /></label><label>内容来源<select aria-label="内容来源" value={source} onChange={event => setSource(event.target.value)}><option value="">所有内容</option><option value="manual">手动保存</option>{snapshot?.collections.map(collection => <option value={collection.id} key={collection.id}>{collection.name}</option>)}</select></label></div>{composing ? <section className="feed-compose form-stack"><h2>保存文本</h2><label>标题<input aria-label="文本标题" maxLength={512} value={manual.title ?? ''} onChange={event => manualField('title', event.target.value)} /></label><label>文本内容<textarea aria-label="文本内容" rows={10} value={manual.body ?? ''} onChange={event => manualField('body', event.target.value)} /></label><label>来源链接（可选）<input aria-label="来源链接" value={manual.sourceUrl ?? ''} onChange={event => manualField('sourceUrl', event.target.value)} /></label><div className="feed-actions"><button className="button primary" disabled={busy || disabled || !manual.body?.trim()} onClick={() => void createText()}>保存到信息流</button><button className="button secondary" onClick={() => { readerSequence.current++; setComposing(false); }}>返回信息流</button></div></section> : null}<div hidden={composing} className={`feed-body${entry ? ' has-reader' : ''}`}><div className="feed-list" aria-label="内容列表">{items.map(item => <article className="feed-row" key={item.id}><label className="feed-select"><input type="checkbox" aria-label={`选择资料 ${item.title}`} checked={materials.some(value=>value.id===item.id)} onChange={()=>toggleMaterial(item)} />选择用于调研</label><button className="feed-title" aria-current={entry?.id === item.id ? 'true' : undefined} onClick={event => void open(item.id, event.currentTarget)}>{item.title}</button><p className="muted">{item.readAt ? '已读' : '未读'} · {item.starred ? '已收藏 · ' : ''}<time dateTime={item.firstCollectedAt}>{new Date(item.firstCollectedAt).toLocaleString('zh-CN', { hourCycle: 'h23' })}</time></p><p>{item.aiSummary || item.excerpt}</p></article>)}{!items.length && <p className="muted">没有符合条件的内容</p>}{cursor && <button className="button secondary" onClick={() => void more()}>加载更多</button>}</div>{entry && <FeedReader entry={entry} note={draft(`note:${entry.id}`).text} busy={busy || disabled} onNote={text => editDraft(`note:${entry.id}`, text)} onMutation={edit => mutate(entry.id, edit)} onClose={closeReader} onFollowUp={button=>void followUp(entry,button)} />}</div></div></main>;
}
