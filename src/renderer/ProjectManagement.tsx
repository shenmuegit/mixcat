import { useCallback, useEffect, useRef, useState, type ComponentProps, type FormEvent } from 'react';
import { Workbench } from './Workbench';
import { ProjectMarkdown, ReferenceNavigation, itemKinds, itemStatuses, markdownHeadings } from './ProjectMarkdown';
import { DocumentTree } from './DocumentTree';
import { ReferenceEditor } from './ReferenceEditor';
import { itemLink, itemNumber, referencesIn, todoProgress, type DocumentRecovery, type ItemDetail, type ItemKind, type ItemMutation, type ItemReference, type ItemSummary, type ProjectItem, type WorkContext } from '../shared/project-items';
import type { AppCommand, AppReply, ProjectSnapshot } from '../shared/types';

type Execute = (command: AppCommand, actionId?: string) => Promise<AppReply | null>;
export interface WorkbenchRequest { id: string; nodeId: string; taskId?: string; messageId?: string; text?: string; context?: WorkContext; }
interface Draft { item: ProjectItem; hash: string | null; dirty: boolean; reason: string; path: string; register: boolean; }
const draftOf = (detail: ItemDetail): Draft => ({ item: structuredClone(detail.item), hash: detail.hash, dirty: false, reason: '', path: detail.item.path ?? '', register: false });
const isNew = (id: string) => id.startsWith('draft:');
const hasDraftChanges = (draft?: Draft) => !!draft && (draft.dirty || !isNew(draft.item.id) && draft.path !== (draft.item.path ?? ''));

export function confirmProjectNavigation() { return window.dispatchEvent(new Event('mixcat:before-project-navigation', { cancelable: true })); }

export function ProjectWorkspace(props: ComponentProps<typeof Workbench>) {
  const { snapshot } = props, projectId = snapshot.project.id;
  const [view, setView] = useState<'workflow' | ItemKind>('workflow'), [kind, setKind] = useState<ItemKind>('todo');
  const [selection, setSelection] = useState<Partial<Record<ItemKind, string>>>({});
  const [items, setItems] = useState<ItemSummary[]>([]), [recovery, setRecovery] = useState<DocumentRecovery>(), [documentWarnings, setDocumentWarnings] = useState<string[]>([]);
  const [request, setRequest] = useState<WorkbenchRequest>(), [dirty, setDirty] = useState(false), [loading, setLoading] = useState(false);
  const [commentFocus, setCommentFocus] = useState<{ itemId: string; commentId: string; token: string }>();
  const executor = useRef(props.execute); executor.current = props.execute;
  const epoch = useRef(0);
  const [navigation, setNavigation] = useState(0);
  const reload = useCallback(async () => {
    const generation = ++epoch.current; setLoading(true);
    const collected: ItemSummary[] = [], warnings = new Set<string>(); let pendingRecovery: DocumentRecovery | undefined;
    for (const archived of [false, true]) {
      let cursor: string | undefined;
      do {
        const result = await executor.current({ type: 'search_project_items', projectId, query: { archived, limit: 200, cursor } });
        if (generation !== epoch.current) return;
        if (!result?.projectItems) { setLoading(false); return; }
        collected.push(...result.projectItems.items); pendingRecovery = result.projectItems.recovery; cursor = result.projectItems.nextCursor ?? undefined;
        result.projectItems.documentWarnings?.forEach(warning => warnings.add(warning));
      } while (cursor);
    }
    if (generation === epoch.current) { setItems(collected); setRecovery(pendingRecovery); setDocumentWarnings([...warnings]); setLoading(false); }
  }, [projectId]);
  useEffect(() => { void reload(); return () => { epoch.current++; }; }, [reload, snapshot.managementRevision, view]);
  useEffect(() => {
    const guard = (event: Event) => { if (dirty && !window.confirm('当前项目有未保存的工作项或评论草稿。放弃这些草稿并离开？')) event.preventDefault(); };
    window.addEventListener('mixcat:before-project-navigation', guard);
    void window.mixcat?.setUnsaved?.(projectId, dirty);
    return () => { window.removeEventListener('mixcat:before-project-navigation', guard); void window.mixcat?.setUnsaved?.(projectId, false); };
  }, [dirty, projectId]);
  function open(reference: ItemReference, commentId?: string) {
    if (reference.projectId !== projectId) return;
    setNavigation(value => value + 1); setKind(reference.kind); setView(reference.kind); setSelection(current => ({ ...current, [reference.kind]: reference.id }));
    setCommentFocus(commentId ? { itemId: reference.id, commentId, token: crypto.randomUUID() } : undefined);
  }
  function locate(taskId: string, messageId?: string) {
    const task = snapshot.tasks.find(task => task.id === taskId); if (!task) { props.onError('找不到关联执行。'); return; }
    setRequest({ id: crypto.randomUUID(), nodeId: task.nodeId, taskId, messageId }); setView('workflow');
  }
  return <ReferenceNavigation.Provider value={{ projectId, items, open }}><div className="project-workspace">
    <nav className="project-view-nav" aria-label="项目视图"><strong>{snapshot.project.name}</strong>{([['workflow', '工作流'], ['todo', '待办'], ['issue', 'Issue'], ['document', '文档']] as const).map(([id, label]) => <button key={id} type="button" aria-current={view === id ? 'page' : undefined} className={view === id ? 'active' : ''} onClick={() => { setNavigation(value => value + 1); setView(id); if (id !== 'workflow') setKind(id); }}>{label}</button>)}{dirty && <span className="draft-indicator">有未保存草稿</span>}</nav>
    <div className="workspace-view" hidden={view !== 'workflow'}><Workbench {...props} obscured={props.obscured || view !== 'workflow'} workRequest={request} /></div>
    <div className="workspace-view" hidden={view === 'workflow'}><ProjectManagement navigation={navigation} snapshot={snapshot} kind={kind} items={items} selectedId={selection[kind] ?? null} loading={loading} recovery={recovery} documentWarnings={documentWarnings}
      execute={props.execute} onSelect={id => { setNavigation(value => value + 1); setSelection(current => ({ ...current, [kind]: id })); setCommentFocus(undefined); }} reload={reload} onDirty={setDirty} onOpen={open} onLocate={locate} commentFocus={commentFocus}
      onDispatch={(nodeId, context, text) => { setRequest({ id: crypto.randomUUID(), nodeId, context, text }); setView('workflow'); }} /></div>
  </div></ReferenceNavigation.Provider>;
}

export function ProjectManagement({ navigation = 0, snapshot, kind, items, selectedId, loading, recovery, documentWarnings = [], execute, onSelect, reload, onDirty, onOpen, onLocate, onDispatch, commentFocus }: {
  navigation?: number; snapshot: ProjectSnapshot; kind: ItemKind; items: ItemSummary[]; selectedId: string | null; loading: boolean; recovery?: DocumentRecovery; execute: Execute;
  documentWarnings?: string[];
  onSelect(id: string): void; reload(): Promise<void>; onDirty(dirty: boolean): void; onOpen(reference: ItemReference, commentId?: string): void; onLocate(taskId: string, messageId?: string): void;
  commentFocus?: { itemId: string; commentId: string; token: string };
  onDispatch(nodeId: string, context: WorkContext, text: string): void;
}) {
  const projectId = snapshot.project.id, [drafts, setDrafts] = useState<Record<string, Draft>>({}), [comments, setComments] = useState<Record<string, string>>({});
  const [detail, setDetail] = useState<ItemDetail | null>(null), [error, setError] = useState(''), [pending, setPending] = useState(false), [preview, setPreview] = useState(false);
  const [archived, setArchived] = useState(false), [search, setSearch] = useState(''), [matches, setMatches] = useState<ItemSummary[] | null>(null), [collapsed, setCollapsed] = useState(new Set<string>());
  const [archiveConfirm, setArchiveConfirm] = useState(false), [targetNode, setTargetNode] = useState(snapshot.nodes[0]?.id ?? '');
  const [documentMode, setDocumentMode] = useState<'active' | 'archived' | 'deleted'>('active'), [sidebar, setSidebar] = useState(true);
  const [editingDocuments, setEditingDocuments] = useState(new Set<string>());
  const executor = useRef(execute); executor.current = execute;
  const requestEpoch = useRef(0), selectionRef = useRef(selectedId); selectionRef.current = selectedId;
  const saveRequests = useRef(new Map<string, { fingerprint: string; id: string }>());
  const consumedComment = useRef<string | undefined>(undefined);
  const draft = selectedId ? drafts[selectedId] : undefined, item = draft?.item;
  const dirty = Object.values(drafts).some(draft => hasDraftChanges(draft) || !!draft.reason.trim()) || Object.values(comments).some(text => !!text.trim());
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  useEffect(() => { if (!commentFocus) document.querySelector('.management-detail')?.scrollTo({ top: 0 }); }, [selectedId, kind, commentFocus]);
  useEffect(() => {
    if (!commentFocus || detail?.item.id !== commentFocus.itemId || consumedComment.current === commentFocus.token) return;
    const element = document.getElementById(`comment-${commentFocus.commentId}`); if (!element) return;
    element.scrollIntoView({ block: 'center' }); element.focus({ preventScroll: true }); consumedComment.current = commentFocus.token;
  }, [commentFocus, detail]);
  useEffect(() => { setSearch(''); setMatches(null); setArchiveConfirm(false); }, [kind]);
  useEffect(() => { if (!snapshot.nodes.some(node => node.id === targetNode)) setTargetNode(snapshot.nodes[0]?.id ?? ''); }, [snapshot.nodes, targetNode]);
  const loadDetail = useCallback(async (id: string) => {
    const generation = ++requestEpoch.current;
    if (isNew(id)) { setDetail(null); return; }
    const result = await executor.current({ type: 'get_project_item', projectId, itemId: id, commentId: commentFocus?.itemId === id ? commentFocus.commentId : undefined });
    if (generation !== requestEpoch.current || selectionRef.current !== id) return;
    if (!result?.projectItem) { setError('工作项读取失败，请刷新后重试。'); return; }
    setDetail(result.projectItem); setError('');
    setDrafts(current => hasDraftChanges(current[id]) ? current : { ...current, [id]: { ...draftOf(result.projectItem!), reason: current[id]?.reason ?? '' } });
    if (result.projectItem.item.kind === 'document') setDocumentMode(result.projectItem.item.deletedAt ? 'deleted' : result.projectItem.item.archived ? 'archived' : 'active');
    else if (result.projectItem.item.archived) setArchived(true);
  }, [projectId, commentFocus]);
  useEffect(() => setArchiveConfirm(false), [selectedId]);
  useEffect(() => { if (selectedId) void loadDetail(selectedId); else setDetail(null); return () => { requestEpoch.current++; }; }, [selectedId, loadDetail, snapshot.managementRevision, navigation]);
  useEffect(() => {
    if (!search.trim()) { setMatches(null); return; }
    let cancelled = false;
    const timer = setTimeout(() => { void (async () => {
      const found: ItemSummary[] = []; let cursor: string | undefined;
      do { const result = await executor.current({ type: 'search_project_items', projectId, query: { kind, archived: kind === 'document' ? documentMode !== 'active' : archived, text: search.trim(), limit: 200, cursor } }); if (cancelled || !result?.projectItems) return; found.push(...result.projectItems.items); cursor = result.projectItems.nextCursor ?? undefined; } while (cursor);
      if (!cancelled) setMatches(found);
    })(); }, 180);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [search, archived, documentMode, kind, projectId, snapshot.managementRevision, items]);
  function edit(change: Partial<ProjectItem>) { if (selectedId) setDrafts(current => ({ ...current, [selectedId]: { ...current[selectedId], item: { ...current[selectedId].item, ...change }, dirty: true } })); }
  function showDocuments(mode: typeof documentMode) { setDocumentMode(mode); setMatches(null); onSelect(''); }
  function create(parentId: string | null = null, register = false) {
    const id = `draft:${crypto.randomUUID()}`, date = new Date().toISOString();
    const next: ProjectItem = { id, kind, number: 0, title: '', body: '', acceptance: '', status: kind === 'todo' ? 'todo' : kind === 'issue' ? 'open' : 'active', priority: 'normal', ownerId: null, parentId, position: 0, issueType: 'bug', path: null, archived: false, revision: 0, createdAt: date, updatedAt: date, comments: [] };
    setDrafts(current => ({ ...current, [id]: { item: next, hash: null, dirty: false, reason: '', path: kind === 'document' ? 'docs/' : '', register } })); onSelect(id); setPreview(false); setError(''); setArchived(false); setDocumentMode('active');
    if (kind === 'document') setEditingDocuments(current => new Set(current).add(id));
  }
  async function mutate(input: Omit<ItemMutation, 'request_id'>, key = selectedId ?? input.id ?? 'action') {
    if (drafts[key]?.reason.trim() && input.reason === undefined) input = { ...input, reason: drafts[key].reason };
    const fingerprint = JSON.stringify(input), previous = saveRequests.current.get(key), request = previous?.fingerprint === fingerprint ? previous : { fingerprint, id: crypto.randomUUID() };
    saveRequests.current.set(key, request); requestEpoch.current++; setPending(true); setError('');
    try {
      const result = await execute({ type: 'update_project_item', projectId, input: { ...input, request_id: request.id } });
      if (!result?.projectItem) { setError('保存未完成，草稿已保留。请查看上方错误并刷新需要合并的版本。'); return null; }
      const saved = result.projectItem;
      const pendingPath = input.operation === 'edit' && saved.item.kind === 'document' && drafts[key]?.path !== drafts[key]?.item.path ? drafts[key]?.path : undefined;
      if (saved.item.kind === 'document') { setDocumentMode(saved.item.deletedAt ? 'deleted' : saved.item.archived ? 'archived' : 'active'); if (pendingPath === undefined) setEditingDocuments(current => { const next = new Set(current); next.delete(key); return next; }); }
      setDrafts(current => { const next = { ...current, [saved.item.id]: { ...draftOf(saved), ...(pendingPath !== undefined ? { path: pendingPath } : {}) } }; if (isNew(key)) delete next[key]; return next; });
      if (selectionRef.current === key) { onSelect(saved.item.id); setDetail(saved); }
      await reload(); return saved;
    } finally { setPending(false); }
  }
  async function save(event: FormEvent) {
    event.preventDefault(); if (!draft || !item || !selectedId) return;
    if (draft.register) { await mutate({ operation: 'register', kind: 'document', path: draft.path, ...(item.title.trim() ? { title: item.title } : {}) }); return; }
    const base = isNew(item.id) ? { operation: 'create' as const, kind: item.kind, ...(item.kind === 'todo' ? { parentId: item.parentId } : {}) }
      : { operation: 'edit' as const, id: item.id, expected_revision: item.revision, ...(item.kind === 'document' ? { expected_hash: draft.hash } : {}) };
    await mutate({ ...base, title: item.title, body: item.body, ...(item.kind === 'document' ? isNew(item.id) && draft.path ? { path: draft.path } : {}
      : { acceptance: item.acceptance, ownerId: item.ownerId, priority: item.priority, ...(item.kind === 'issue' ? { issueType: item.issueType } : {}), ...(!isNew(item.id) ? { status: item.status } : {}), ...(draft.reason.trim() ? { reason: draft.reason } : {}) }) });
  }
  async function move(id: string, parentId: string | null, beforeId: string | null = null) {
    const target = items.find(item => item.id === id); if (!target || hasDraftChanges(drafts[id])) { setError('请先保存待办草稿，再调整层级或顺序。'); return; }
    await mutate({ operation: 'move', id, expected_revision: target.revision, parentId, beforeId }, id);
  }
  const visible = (matches ?? items).filter(item => item.kind === kind && (kind === 'document' ? documentMode === 'deleted' ? !!item.deletedAt : documentMode === 'archived' ? item.archived && !item.deletedAt : !item.archived : item.archived === archived));
  const visibleIds = new Set(visible.map(item => item.id));
  function rows(parentId: string | null, depth: number, seen = new Set<string>()): React.ReactNode {
    return visible.filter(item => search.trim() ? depth === 0 : item.parentId === parentId || depth === 0 && !visibleIds.has(item.parentId ?? '')).sort((a, b) => a.position - b.position).map(row => {
      if (seen.has(row.id)) return null; const branch = new Set(seen).add(row.id);
      const children = kind === 'todo' && !search.trim() && visible.some(item => item.parentId === row.id), progress = todoProgress(items, row.id);
      return <li key={row.id}><div className={`management-row${selectedId === row.id ? ' is-selected' : ''}`} style={{ paddingLeft: 10 + depth * 18 }}
        draggable={kind === 'todo' && !archived && !pending} onDragStart={event => event.dataTransfer.setData('application/x-mixcat-todo', row.id)}
        onDragOver={event => { if (kind === 'todo' && !archived) event.preventDefault(); }} onDrop={event => { event.preventDefault(); const id = event.dataTransfer.getData('application/x-mixcat-todo'); if (id) void move(id, row.id); }}>
        {children ? <button type="button" className="tree-toggle" aria-label={`${collapsed.has(row.id) ? '展开' : '折叠'} ${row.title}`} aria-expanded={!collapsed.has(row.id)} onClick={() => setCollapsed(current => { const next = new Set(current); next.has(row.id) ? next.delete(row.id) : next.add(row.id); return next; })}>{collapsed.has(row.id) ? '▸' : '▾'}</button> : <span className="tree-toggle" />}
        <button type="button" className="management-row-main" onClick={() => onSelect(row.id)}><small>{itemNumber(row)}{row.path && ` · ${row.path}`}</small><strong>{row.title}</strong><span>{row.archived ? '已归档' : itemStatuses[row.status]}{children && ` · ${progress.completed}/${progress.total}`}{hasDraftChanges(drafts[row.id]) && ' · 草稿'}</span></button>
      </div>{children && !collapsed.has(row.id) && <ul>{rows(row.id, depth + 1, branch)}</ul>}</li>;
    });
  }
  const fresh = detail?.item.id === selectedId ? detail : null;
  const discussion = fresh ? [...(fresh.focusedComment && !fresh.item.comments.some(comment => comment.id === fresh.focusedComment!.id) ? [fresh.focusedComment] : []), ...fresh.item.comments] : [];
  const conflicted = !!draft && hasDraftChanges(draft) && !!fresh && (fresh.item.revision !== item?.revision || item?.kind === 'document' && fresh.hash !== draft.hash);
  const canManage = !!item && !isNew(item.id) && !pending && !draft?.dirty;
  const documentEditing = !!item && (isNew(item.id) || editingDocuments.has(item.id)) && !item.archived;
  const headingPrefix = `document-${selectedId}`, headings = item?.kind === 'document' ? markdownHeadings(item.body, headingPrefix) : [];
  const links = <section className="item-links"><h2>引用了</h2>{fresh?.references.length ? fresh.references.map(reference => { const target = items.find(item => item.id === reference.id && item.kind === reference.kind); return <button type="button" className="text-button" key={`${reference.kind}:${reference.id}`} onClick={() => onOpen(reference)}>{target ? `${itemNumber(target)} ${target.title}${target.deletedAt ? '（已删除）' : target.archived ? '（已归档）' : ''}` : '引用目标缺失'}</button>; }) : <p>暂无已保存引用</p>}<h2>被引用</h2>{fresh?.backlinks.length ? fresh.backlinks.map((link, index) => <button type="button" className="text-button" key={index} data-message-id={link.messageId} onClick={() => link.taskId ? onLocate(link.taskId, link.messageId) : onOpen({ projectId, kind: link.kind, id: link.itemId }, link.commentId)}>{link.title}{link.commentId && ' · 评论'}{link.taskId && ' · 会话消息'}</button>) : <p>暂无反向引用</p>}{fresh?.referenceErrors?.map(message => <p className="inline-warning" key={message}>{message}</p>)}</section>;
  return <main className={`project-management${kind === 'document' ? ` document-workspace${sidebar ? ' with-sidebar' : ''}` : ''}`} aria-label={`${itemKinds[kind]}管理`}>
    <header className="management-heading"><div><h1>{kind === 'document' && documentMode !== 'active' ? documentMode === 'deleted' ? '回收站' : '已归档文档' : itemKinds[kind]}</h1>{kind !== 'document' && <p>{kind === 'todo' ? '拆分工作，追踪每一步' : '记录问题、讨论和解决依据'}</p>}</div><div>
      {kind === 'document' && (documentMode === 'active' ? <>
        <button type="button" className="text-button" disabled={pending} onClick={() => showDocuments('deleted')}>回收站</button>
        {items.some(item => item.kind === 'document' && item.archived && !item.deletedAt) && <button type="button" className="text-button" disabled={pending} onClick={() => showDocuments('archived')}>已归档</button>}
      </> : <button type="button" className="text-button" disabled={pending} onClick={() => showDocuments('active')}>返回文档</button>)}
      <button type="button" className="button secondary" disabled={pending} onClick={() => { void reload(); if (selectedId && !isNew(selectedId)) void loadDetail(selectedId); }}>刷新</button>{kind === 'document' && <button type="button" className="button secondary" disabled={pending} onClick={() => create(null, true)}>纳入已有文档</button>}<button type="button" className="button primary" disabled={pending} onClick={() => create()}>新建{itemKinds[kind]}</button></div></header>
    {recovery && <section className="management-recovery" role="alert"><strong>文档操作需要处理</strong><p>{recovery.message}</p><details><summary>查看保留的草稿：{recovery.path}</summary><pre>{recovery.draft}</pre></details><button type="button" className="button secondary" disabled={pending || !recovery.id} onClick={async () => { setPending(true); try { if (await execute({ type: 'cancel_document_write', projectId, recoveryId: recovery.id })) await reload(); } finally { setPending(false); } }}>取消此次操作</button></section>}
    {kind === 'document' && documentWarnings.length > 0 && <details className="management-recovery document-warnings" open><summary>文档发现提示（{documentWarnings.length}）</summary>{documentWarnings.map(warning => <p key={warning}>{warning}</p>)}<p>文件缺失或移动时，请打开原文档，进入编辑并使用“重新关联”。</p></details>}
    <div className="management-body"><aside className="management-list"><div className="management-filters"><input aria-label="搜索工作项" placeholder="搜索标题、编号或正文" value={search} onChange={event => setSearch(event.target.value)} />{kind !== 'document' && <label><input type="checkbox" checked={archived} onChange={event => setArchived(event.target.checked)} />已归档</label>}</div>
      {Object.values(drafts).filter(draft => isNew(draft.item.id) && draft.item.kind === kind).map(draft => <div className="new-item-draft" key={draft.item.id}><button type="button" className="text-button" onClick={() => onSelect(draft.item.id)}>{draft.item.title || '未命名'} · 草稿</button><button type="button" className="icon-button" aria-label="丢弃新建草稿" onClick={() => { if (draft.dirty && !window.confirm('丢弃这个新建草稿？')) return; setDrafts(current => { const next = { ...current }; delete next[draft.item.id]; return next; }); if (selectedId === draft.item.id) onSelect(''); }}>×</button></div>)}
      {kind === 'todo' && <div className="tree-root-drop" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); const id = event.dataTransfer.getData('application/x-mixcat-todo'); if (id) void move(id, null); }}>根级待办<span>拖到这里移至根级</span></div>}
      {kind === 'document' && <DocumentTree items={visible} selectedId={selectedId} dirtyIds={new Set(Object.values(drafts).filter(hasDraftChanges).map(draft => draft.item.id))} onSelect={onSelect} />}
      {loading && !visible.length ? <p role="status" className="management-empty">正在读取…</p> : visible.length ? kind !== 'document' && <ul className="management-tree">{rows(null, 0)}</ul> : <p className="management-empty">{search ? '没有匹配的内容' : kind === 'document' && documentMode === 'deleted' ? '回收站为空' : archived ? '没有归档内容' : `还没有${itemKinds[kind]}`}</p>}
    </aside><section className="management-detail" aria-label="工作项详情">
      {error && <p className="inline-error" role="alert">{error}</p>}
      {!item || item.kind !== kind ? <div className="management-placeholder"><h2>选择或新建{itemKinds[kind]}</h2><p>在正文中输入 @，连接项目中的工作与资料。</p></div> : <>
        <div className="item-detail-heading"><span>{isNew(item.id) ? '新建' : itemNumber(item)}{item.deletedAt ? ' · 已删除' : item.archived ? ' · 已归档' : ''}{hasDraftChanges(draft) && ' · 未保存'}</span><div>{item.kind === 'document' ? <><button type="button" className="text-button" disabled={item.archived || isNew(item.id)} onClick={() => setEditingDocuments(current => { const next = new Set(current); documentEditing ? next.delete(item.id) : next.add(item.id); return next; })}>{documentEditing ? '阅读' : '编辑'}</button><button type="button" className="text-button" aria-expanded={sidebar} onClick={() => setSidebar(value => !value)}>{sidebar ? '收起大纲与引用' : '展开大纲与引用'}</button></> : <button type="button" className="text-button" onClick={() => setPreview(value => !value)}>{preview ? '编辑' : '预览'}</button>}{item.kind === 'todo' && <button type="button" className="text-button" disabled={!canManage || item.archived || item.status === 'done'} onClick={() => create(item.id)}>＋ 子待办</button>}</div></div>
        {fresh?.error && <p className="inline-error" role="alert">{fresh.error}</p>}
        {conflicted && <section className="draft-conflict" role="alert"><strong>内容已有新版本，当前草稿已保留</strong><details><summary>比较最新内容：{fresh!.item.title} · {itemStatuses[fresh!.item.status]}</summary><ProjectMarkdown text={`${fresh!.item.body}\n\n${fresh!.item.acceptance}`} /></details><button type="button" className="button secondary" onClick={() => setDrafts(current => ({ ...current, [item.id]: { ...current[item.id], item: { ...current[item.id].item, revision: fresh!.item.revision }, hash: fresh!.hash } }))}>已手动合并，更新保存基线</button></section>}
        {item.kind === 'document' && !documentEditing && <article className="document-reading" aria-label="文档阅读"><header><h1>{item.title}</h1><p>{item.path}{item.deletedAt && ' · 回收站副本'}</p></header><ProjectMarkdown text={item.body} headingPrefix={headingPrefix} /></article>}
        {(item.kind !== 'document' || documentEditing) && <form className="management-form" onSubmit={save}><fieldset disabled={pending || item.archived}>
          <label>标题<input aria-label="工作项标题" required={!draft!.register} maxLength={200} value={item.title} onChange={event => edit({ title: event.target.value })} /></label>
          {item.kind !== 'document' && <div className="item-fields"><label>状态<select aria-label="工作项状态" disabled={isNew(item.id)} value={item.status} onChange={event => edit({ status: event.target.value as ProjectItem['status'] })}>{(item.kind === 'todo' ? ['todo', 'doing', 'blocked', 'done'] : ['open', 'doing', 'closed']).map(status => <option key={status} value={status}>{itemStatuses[status]}</option>)}</select></label><label>优先级<select aria-label="优先级" value={item.priority} onChange={event => edit({ priority: event.target.value as ProjectItem['priority'] })}><option value="low">低</option><option value="normal">普通</option><option value="high">高</option></select></label><label>负责人<select aria-label="负责人" value={item.ownerId ?? ''} onChange={event => edit({ ownerId: event.target.value || null })}><option value="">未分配</option><option value="user">我</option>{snapshot.nodes.map(node => <option key={node.id} value={node.id}>{node.name}</option>)}{item.ownerId && item.ownerId !== 'user' && !snapshot.nodes.some(node => node.id === item.ownerId) && <option value={item.ownerId}>{snapshot.archivedNodes?.find(node => node.id === item.ownerId)?.name ?? "节点"}（已归档）</option>}</select></label>{item.kind === 'issue' && <label>类型<select aria-label="Issue 类型" value={item.issueType} onChange={event => edit({ issueType: event.target.value as ProjectItem['issueType'] })}><option value="bug">缺陷</option><option value="enhancement">功能改进</option></select></label>}</div>}
          {item.kind === 'document' && <label>项目内路径<div className="document-path-control"><input aria-label="文档路径" value={draft!.path} placeholder="docs/说明.md" onChange={event => setDrafts(current => ({ ...current, [item.id]: { ...current[item.id], path: event.target.value, dirty: isNew(item.id) ? true : current[item.id].dirty } }))} />{!isNew(item.id) && <button type="button" className="button secondary" disabled={!canManage || !draft!.path || draft!.path === item.path} onClick={() => void mutate({ operation: fresh?.error ? 'relink' : 'move', id: item.id, expected_revision: item.revision, expected_hash: draft!.hash, path: draft!.path })}>{fresh?.error ? '重新关联' : '移动文件'}</button>}</div></label>}
          {!draft!.register && (item.kind !== 'document' && preview ? <ProjectMarkdown text={item.body} /> : <label>正文<ReferenceEditor projectId={projectId} value={item.body} onChange={body => edit({ body })} execute={execute} label="工作项正文" rows={item.kind === 'document' ? 13 : 7} disabled={pending || item.archived} /></label>)}
          {item.kind !== 'document' && <><label>验收说明<ReferenceEditor projectId={projectId} value={item.acceptance} onChange={acceptance => edit({ acceptance })} execute={execute} label="验收说明" rows={3} disabled={pending || item.archived} /></label><label>处理说明<input aria-label="处理说明" value={draft!.reason} placeholder="完成、关闭或重开时填写实际依据" onChange={event => setDrafts(current => ({ ...current, [item.id]: { ...current[item.id], reason: event.target.value } }))} /></label></>}
          <div className="item-save-actions"><button className="button primary" disabled={pending || item.archived || conflicted}>{draft!.register ? '纳入文档' : '保存'}</button>{hasDraftChanges(draft) && !isNew(item.id) && <button type="button" className="button secondary" onClick={() => { if (fresh && window.confirm('放弃当前草稿并载入最新内容？')) setDrafts(current => ({ ...current, [item.id]: draftOf(fresh) })); }}>放弃草稿</button>}{['done', 'closed'].includes(item.status) && <button type="button" className="button secondary" disabled={!canManage} onClick={() => void mutate({ operation: 'reopen', id: item.id, expected_revision: item.revision, reason: draft!.reason })}>重新打开</button>}</div>
        </fieldset></form>}
        {!isNew(item.id) && <>
          {item.kind === 'todo' && !item.archived && <div className="todo-structure"><label>父待办<select aria-label="父待办" disabled={!canManage} value={item.parentId ?? ''} onChange={event => void move(item.id, event.target.value || null)}><option value="">根级</option>{items.filter(other => other.kind === 'todo' && !other.archived && other.id !== item.id).map(other => <option key={other.id} value={other.id}>{itemNumber(other)} · {other.title}</option>)}</select></label>{(['up', 'down'] as const).map(direction => <button type="button" key={direction} className="button secondary" disabled={!canManage} onClick={() => { const siblings = items.filter(other => other.kind === 'todo' && !other.archived && other.parentId === item.parentId).sort((a, b) => a.position - b.position), index = siblings.findIndex(other => other.id === item.id); if (direction === 'up' && index > 0) void move(item.id, item.parentId, siblings[index - 1].id); else if (direction === 'down' && index < siblings.length - 1) void move(item.id, item.parentId, siblings[index + 2]?.id ?? null); }}>{direction === 'up' ? '上移' : '下移'}</button>)}</div>}
          {item.kind !== 'document' && !item.archived && <div className="item-dispatch"><select aria-label="交给节点" value={targetNode} onChange={event => setTargetNode(event.target.value)}>{snapshot.nodes.map(node => <option key={node.id} value={node.id}>{node.name}</option>)}</select><button type="button" className="button secondary" disabled={!canManage || !snapshot.nodes.some(node => node.id === targetNode)} onClick={() => {
            const references = referencesIn(item.body + '\n' + item.acceptance, projectId); if (!references.some(reference => reference.id === item.id)) references.unshift({ projectId, kind: item.kind, id: item.id });
            onDispatch(targetNode, { primary_todo_id: item.kind === 'todo' ? item.id : null, references }, `请处理 ${itemLink(projectId, item)}，依据工作项中的说明和验收条件完成，并记录实际结果。`);
          }}>交给节点…</button><small>打开输入框，发送后开始处理</small></div>}
          {item.kind !== 'document' && links}
          {!!fresh?.taskIds.length && <section className="item-links"><h2>关联执行</h2>{fresh.taskIds.map(id => { const task = snapshot.tasks.find(task => task.id === id); return <button className="text-button" type="button" key={id} onClick={() => onLocate(id)}>{snapshot.nodes.find(node => node.id === task?.nodeId)?.name ?? '已归档节点'} · {task?.status ?? '未知'}</button>; })}</section>}
          {item.kind === 'issue' && <section className="item-comments"><h2>讨论</h2>{discussion.map(comment => <article tabIndex={-1} id={`comment-${comment.id}`} key={comment.id}><small>{comment.author.kind === 'user' ? '我' : snapshot.nodes.find(node => node.id === comment.author.nodeId)?.name ?? '节点'} · {new Date(comment.createdAt).toLocaleString()}</small><ProjectMarkdown text={comment.body} historical /></article>)}{!item.archived && <><ReferenceEditor projectId={projectId} label="Issue 评论" value={comments[item.id] ?? ''} onChange={text => setComments(current => ({ ...current, [item.id]: text }))} execute={execute} rows={3} disabled={pending} /><button type="button" className="button secondary" disabled={!canManage || !comments[item.id]?.trim()} onClick={async () => { if (await mutate({ operation: 'comment', id: item.id, expected_revision: item.revision, body: comments[item.id] })) setComments(current => ({ ...current, [item.id]: '' })); }}>发表评论</button>{draft!.dirty && <small>保存正文草稿后可发表评论。</small>}</>}</section>}
          {fresh?.nextCursor && <button type="button" className="text-button" disabled={pending} onClick={async () => {
            const generation = ++requestEpoch.current; setPending(true);
            try { const reply = await execute({ type: 'get_project_item', projectId, itemId: item.id, cursor: fresh.nextCursor! }); const older = reply?.projectItem;
              if (older && generation === requestEpoch.current) setDetail(current => current?.item.id === item.id ? { ...older, focusedComment: current.focusedComment, item: { ...older.item, comments: [...older.item.comments, ...current.item.comments] }, references: [...older.references, ...current.references], backlinks: [...older.backlinks, ...current.backlinks], events: [...older.events, ...current.events], taskIds: [...older.taskIds, ...current.taskIds], referenceErrors: [...(older.referenceErrors ?? []), ...(current.referenceErrors ?? [])] } : current);
            } finally { setPending(false); }
          }}>加载更早的引用、讨论和记录</button>}
          <details className="item-history"><summary>修改记录（{fresh?.events.length ?? 0}）</summary>{fresh?.events.slice().reverse().map(event => <p key={event.id}><strong>{event.actor.kind === 'user' ? '我' : event.actor.kind === 'external' ? '外部工具' : snapshot.nodes.find(node => node.id === event.actor.nodeId)?.name ?? '已归档节点'}</strong> · {({ create: '新建', edit: '编辑', move: '移动', archive: '归档', restore: '恢复', reopen: '重开', comment: '发表评论', register: '纳入文档', relink: '重新关联', external_edit: '外部修改', delete: '删除' } as Record<string, string>)[event.operation] ?? event.operation} · {new Date(event.at).toLocaleString()}{event.reason && <span> — {event.reason}</span>}</p>)}</details>
          {item.kind === 'document' ? <div className="item-archive document-lifecycle">{item.archived ? <><p>{item.deletedAt ? `已删除 · ${new Date(item.deletedAt).toLocaleString()}。恢复时不会覆盖已有文件。` : '已归档文档'}</p>{item.deletedAt && <label>恢复到项目内路径<input aria-label="恢复文档路径" value={draft!.path} onChange={event => setDrafts(current => ({ ...current, [item.id]: { ...current[item.id], path: event.target.value } }))} /></label>}<button type="button" className="button secondary" disabled={pending || !canManage || conflicted} onClick={async () => { await mutate({ operation: 'restore', id: item.id, expected_revision: item.revision, ...(item.deletedAt ? { expected_hash: draft!.hash, path: draft!.path } : {}) }); }}>恢复文档</button></> : archiveConfirm ? <div role="alertdialog" aria-label="确认删除文档"><p>将「{item.title}」移入项目回收站？</p><p>{item.path}</p><p>已有引用仍可打开已删除记录。{fresh?.backlinks.length ? `当前已加载 ${fresh.backlinks.length} 条反向引用。` : '其他工作项可能引用此文档。'}</p><button type="button" className="button secondary" onClick={() => setArchiveConfirm(false)}>取消</button><button type="button" className="button secondary danger-button" disabled={!canManage || conflicted || draft!.path !== item.path} onClick={async () => { if (await mutate({ operation: 'delete', id: item.id, expected_revision: item.revision, expected_hash: draft!.hash })) setArchiveConfirm(false); }}>确认删除</button></div> : <button type="button" className="text-button danger-button" disabled={!canManage || conflicted || draft!.path !== item.path} onClick={() => setArchiveConfirm(true)}>删除文档</button>}</div> : <div className="item-archive">{item.archived ? <button type="button" className="button secondary" disabled={pending} onClick={async () => { if (await mutate({ operation: 'restore', id: item.id, expected_revision: item.revision })) setArchived(false); }}>恢复{item.kind === 'todo' ? '子树' : itemKinds[item.kind]}</button> : archiveConfirm ? <div role="alertdialog" aria-label="确认归档"><p>归档「{item.title}」{item.kind === 'todo' ? '及其全部子待办' : ''}？</p><button type="button" className="button secondary" onClick={() => setArchiveConfirm(false)}>取消</button><button type="button" className="button secondary danger-button" disabled={pending} onClick={async () => { if (await mutate({ operation: 'archive', id: item.id, expected_revision: item.revision })) { setArchived(true); setArchiveConfirm(false); } }}>确认归档</button></div> : <button type="button" className="text-button danger-button" disabled={!canManage} onClick={() => setArchiveConfirm(true)}>归档{item.kind === 'todo' ? '子树' : itemKinds[item.kind]}</button>}</div>}
        </>}
      </>}
    </section>{kind === 'document' && sidebar && <aside className="document-sidebar" aria-label="大纲与引用"><h2>大纲</h2>{documentEditing ? <p>切换到阅读视图可跳转标题。</p> : headings.length ? <nav aria-label="文档大纲">{headings.map(heading => <button type="button" className="text-button" key={heading.id} style={{ paddingLeft: (heading.depth - 1) * 10 }} onClick={() => { const target = document.getElementById(heading.id); target?.scrollIntoView({ block: 'start' }); target?.focus({ preventScroll: true }); }}>{heading.text}</button>)}</nav> : <p>当前文档没有标题</p>}{links}</aside>}</div>
  </main>;
}
