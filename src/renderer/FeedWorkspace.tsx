import { useEffect, useRef, useState } from 'react';
import { FeedCollection } from './FeedCollection';
import { FeedCollectionList, FeedNewCollection } from './FeedCollectionList';
import type { FeedDraftPort } from './FeedForms';
import type { FeedCollectionDetail, FeedCommand, FeedCommandResult, FeedSnapshot } from '../shared/feed';
import { COMMAND_JSON_LIMIT } from '../shared/commands';
import { Icon } from './Icon';
export type FeedExecute = (command: FeedCommand) => Promise<FeedCommandResult>;
type DraftState = { text: string; saved: string; revision: number; version: number; loaded: boolean; error: string | null };
export function FeedWorkspace({ snapshot, execute, onError, active = true, runtimeRevision = 0 }: { snapshot: FeedSnapshot | null; execute: FeedExecute; onError(message: string): void; active?: boolean; runtimeRevision?: number }) {
  const [page, setPage] = useState<'home' | 'new' | string>('home');
  const [detail, setDetail] = useState<FeedCollectionDetail | null>(null), [refresh, setRefresh] = useState(0), [error, setError] = useState('');
  const [, renderDrafts] = useState(0);
  const drafts = useRef(new Map<string, DraftState>()), timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const draftLoads = useRef(new Map<string, Promise<void>>());
  const draftRequests = useRef(new Map<string, { text: string; revision: number; requestId: string }>());
  const serial = useRef(Promise.resolve()), navigation = useRef(0), collectionSequence = useRef(0);
  const trigger = useRef<HTMLButtonElement | null>(null), homeButton = useRef<HTMLButtonElement | null>(null);
  const activeNow = useRef(active); activeNow.current = active;
  const disabled = !!snapshot?.storageError || !snapshot;
  const revision = `${snapshot?.generation}:${snapshot?.revision}:${refresh}:${runtimeRevision}`;
  const draftPort: FeedDraftPort = { text: key => draft(key).text, loaded: key => draft(key).loaded, load: loadDraft, edit: editDraft, update: (key, transform) => { const text = transform(draft(key).text); if (text !== undefined) editDraft(key, text); }, save: saveDraft };
  useEffect(() => { navigation.current++; }, [active]);
  useEffect(() => {
    if (page === 'home' || page === 'new') return;
    const token = ++collectionSequence.current;
    void execute({ type: 'get_feed_collection', collectionId: page }).then(reply => {
      if (token === collectionSequence.current) setDetail(current => current?.collection.id === page && current.collection.revision > reply.collection!.collection.revision ? current : reply.collection!);
    }).catch(caught => { if (token === collectionSequence.current) fail(caught); });
    return () => { collectionSequence.current++; };
  }, [page, revision]);
  useEffect(() => () => { for (const timer of timers.current.values()) clearTimeout(timer); }, []);
  function navigate(next: string, button?: HTMLButtonElement) {
    navigation.current++; collectionSequence.current++; setError(''); setDetail(null); setPage(next);
    if (button) trigger.current = button;
  }
  function back() { navigate('home'); requestAnimationFrame(() => { if (trigger.current?.isConnected) trigger.current.focus(); else homeButton.current?.focus(); }); }
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
      value.revision = reply.draft?.revision ?? 0; value.saved = reply.draft?.text ?? fallback; value.loaded = true; value.error = null;
      if (value.version === version) value.text = value.saved;
      renderDrafts(n => n + 1); dirty();
    } catch (caught) { value.error = String(caught); renderDrafts(n => n + 1); fail(caught); }
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
    clearTimeout(timers.current.get(key)); timers.current.set(key, setTimeout(() => { void saveDraft(key).catch(fail); }, 400));
  }
  return <main className="projects-page feed-workspace">
    <header className="page-heading"><h1>信息流</h1>{page === 'home' && <button ref={homeButton} className="button secondary" disabled={disabled} onClick={event => navigate('new', event.currentTarget)}><Icon name="plus" size={16} />新建采集</button>}</header>
    {(snapshot?.storageError || error) && <p className="inline-error" role="alert">{snapshot?.storageError || error}</p>}
    {[...drafts.current.values()].some(value => value.error) && <button className="button secondary" onClick={() => { setError(''); for (const [key, value] of drafts.current) if (value.text !== value.saved || value.error) void saveDraft(key).catch(fail); }}>重试保存草稿</button>}
    <div className="feed-home" hidden={page !== 'home'}><FeedCollectionList execute={execute} revision={revision} onOpen={(id, button) => navigate(id, button)} onNew={button => navigate('new', button)} disabled={disabled} onError={fail} /></div>
    {page === 'new' && <FeedNewCollection drafts={draftPort} execute={execute} disabled={disabled} onBack={back} navigation={() => navigation.current} onAccepted={(id, epoch) => { if (activeNow.current && epoch === navigation.current) navigate(id); setRefresh(n => n + 1); }} onError={fail} />}
    {page !== 'home' && page !== 'new' && (detail?.collection.id === page ? <FeedCollection key={page} detail={detail} drafts={draftPort} execute={execute} revision={revision} disabled={disabled} active={active} onBack={back} onRefresh={() => setRefresh(n => n + 1)} onError={fail} /> : <section className="feed-loading"><button className="button secondary" onClick={back}><Icon name="back" size={16} />返回信息流</button><p role="status">正在读取采集对话…</p>{error && <button className="button secondary" onClick={() => setRefresh(n => n + 1)}>重试读取</button>}</section>)}
  </main>;
}
