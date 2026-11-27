import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FeedCollection } from './FeedCollection';
import type { FeedNotionDirectory } from './FeedNotion';
import { FeedCollectionList, FeedNewCollection } from './FeedCollectionList';
import type { FeedFormInput, FeedFormMemory } from './FeedForms';
import type { FeedCollectionDetail, FeedCommand, FeedCommandResult, FeedSnapshot } from '../shared/feed';
import { Icon } from './Icon';
export type FeedExecute = (command: FeedCommand) => Promise<FeedCommandResult>;
export function FeedWorkspace({ snapshot, execute, onError, active = true, runtimeRevision = 0, sidebar }: { snapshot: FeedSnapshot | null; execute: FeedExecute; onError(message: string): void; active?: boolean; runtimeRevision?: number; sidebar?: HTMLElement | null }) {
  const [page, setPage] = useState<'home' | 'new' | string>('home');
  const pageNow = useRef(page); pageNow.current = page;
  const [detail, setDetail] = useState<FeedCollectionDetail | null>(null), [refresh, setRefresh] = useState(0), [error, setError] = useState('');
  const [, renderForms] = useState(0);
  const forms = useRef(new Map<string, FeedFormInput<unknown>>());
  const notionDirectories = useRef(new Map<string, FeedNotionDirectory>());
  const navigation = useRef(0), collectionSequence = useRef(0);
  const trigger = useRef<HTMLButtonElement | null>(null), homeButton = useRef<HTMLButtonElement | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const activeNow = useRef(active); activeNow.current = active;
  const disabled = !!snapshot?.storageError || !snapshot;
  const revision = `${snapshot?.generation}:${snapshot?.revision}:${refresh}:${runtimeRevision}`;
  const memory: FeedFormMemory = {
    read: <T,>(key: string) => forms.current.get(key) as FeedFormInput<T> | undefined,
    write(key, input) {
      if (input.edited || input.pending || input.messageFeedback) forms.current.set(key, input);
      else forms.current.delete(key);
      renderForms(n => n + 1);
      reportUnsaved();
    },
  };
  useEffect(() => { navigation.current++; }, [active]);
  useEffect(() => { reportUnsaved(); }, []);
  useEffect(() => {
    if (page === 'home' || page === 'new') return;
    const token = ++collectionSequence.current;
    void execute({ type: 'get_feed_collection', collectionId: page }).then(reply => {
      if (token === collectionSequence.current) setDetail(current => current?.collection.id === page && current.collection.revision > reply.collection!.collection.revision ? current : reply.collection!);
    }).catch(caught => {
      if (token !== collectionSequence.current) return;
      if (String(caught).includes('采集任务不存在')) forgetCollection(page, true);
      else fail(caught);
    });
    return () => { collectionSequence.current++; };
  }, [page, revision]);
  function navigate(next: string, button?: HTMLButtonElement) {
    if (button) trigger.current = button;
    if (next === page) return;
    navigation.current++; collectionSequence.current++; setError(''); setDetail(null); setPage(next);
  }
  function back() {
    navigate('home');
    requestAnimationFrame(() => {
      if (!activeNow.current || pageNow.current !== 'home') return;
      const button = trigger.current;
      if (button?.isConnected && !button.disabled && !button.closest('[hidden], [inert]')) button.focus();
      else if (homeButton.current && !homeButton.current.disabled) homeButton.current.focus();
      else heading.current?.focus();
    });
  }
  function fail(caught: unknown) { const message = caught instanceof Error ? caught.message : String(caught); setError(message); onError(message); }
  function reportUnsaved() { void window.mixcat?.setFeedUnsaved?.([...forms.current.values()].some(input => input.edited || !!input.pending)).catch(fail); }
  function forgetCollection(id: string, keepDeleteRequest = false) {
    const prefix = `collection:${id}:`;
    for (const key of forms.current.keys())
      if (key.startsWith(prefix) && (!keepDeleteRequest || key !== `${prefix}delete`)) forms.current.delete(key);
    notionDirectories.current.delete(id);
    reportUnsaved();
    if (pageNow.current === id) back();
  }
  function directoryFor(id: string) {
    let value = notionDirectories.current.get(id);
    if (!value) { value = { roots: {}, children: {} }; notionDirectories.current.set(id, value); }
    return value;
  }
  return <main className={`projects-page feed-workspace${page !== 'home' && page !== 'new' ? ' feed-detail-page' : ''}`}>
    {active && sidebar && createPortal(<FeedCollectionList compact selectedId={page} execute={execute} memory={memory} revision={revision} active={active} onOpen={(id, button) => navigate(id, button)} onNew={button => navigate('new', button)} disabled={disabled} onDeleted={forgetCollection} onError={fail} />, sidebar)}
    <header className="page-heading"><h1 ref={heading} tabIndex={-1}>信息流</h1>{page === 'home' && <button ref={homeButton} className="button secondary" disabled={disabled} onClick={event => navigate('new', event.currentTarget)}><Icon name="plus" size={16} />新建采集</button>}</header>
    {(snapshot?.storageError || snapshot?.cleanupError || error) && <p className="inline-error" role="alert">{snapshot?.storageError || snapshot?.cleanupError || error}</p>}
    <div className="feed-home" hidden={page !== 'home'}><FeedCollectionList execute={execute} memory={memory} revision={revision} active={active && page === 'home'} onOpen={(id, button) => navigate(id, button)} onNew={button => navigate('new', button)} disabled={disabled} onDeleted={forgetCollection} onError={fail} /></div>
    {page === 'new' && <FeedNewCollection memory={memory} execute={execute} disabled={disabled} onBack={back} navigation={() => navigation.current} onAccepted={(id, epoch) => { if (activeNow.current && epoch === navigation.current) navigate(id); setRefresh(n => n + 1); }} onError={fail} />}
    {page !== 'home' && page !== 'new' && (detail?.collection.id === page ? <FeedCollection key={page} detail={detail} notionDirectory={directoryFor(page)} memory={memory} execute={execute} revision={revision} disabled={disabled} active={active} onBack={back} onRefresh={() => setRefresh(n => n + 1)} onError={fail} /> : <section className="feed-loading"><button className="button secondary" onClick={back}><Icon name="back" size={16} />返回信息流</button><p role="status">正在读取采集对话…</p>{error && <button className="button secondary" onClick={() => setRefresh(n => n + 1)}>重试读取</button>}</section>)}
  </main>;
}
