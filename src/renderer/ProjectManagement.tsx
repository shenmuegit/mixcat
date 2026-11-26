import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ComponentProps, type CSSProperties, type FormEvent, type Ref } from 'react';
import { Workbench } from './Workbench';
import { ComfyWorkspace } from './ComfyWorkspace';
import { ProjectMarkdown, ReferenceNavigation, itemKinds, itemStatuses, markdownHeadings } from './ProjectMarkdown';
import { DocumentTree, documentFolders } from './DocumentTree';
import { Dialog } from './Dialog';
import { DocumentEditorPane } from './DocumentEditorPane';
import { createDocumentMedia } from './document-media';
import { useDocumentAutosave } from './document-autosave';
import { DocumentSplitHandle, useDocumentSplit } from './DocumentSplit';
import { ReferenceEditor } from './ReferenceEditor';
import { Icon } from './Icon';
import { SearchField } from './SearchField';
import { PathBreadcrumb } from './PathBreadcrumb';
import { ReadingPlaceholder } from './ReadingFeedback';
import { documentDeleteCleanupMessage, issueTypeOf, itemLink, itemNumber, parseItemReference, referencesIn, todoProgress, type ItemDetail, type ItemMutation, type ItemReference, type ItemSummary, type ProjectItem, type WorkContext } from '../shared/project-items';
import type { AppCommand, NativeInput, ProjectSnapshot } from '../shared/types';

import type { Execute } from './execute-command';
export interface WorkbenchRequest { id: string; nodeId: string; taskId?: string; messageId?: string; text?: string; context?: WorkContext; attachments?: NativeInput[]; }
interface Draft { item: ProjectItem; hash: string | null; dirty: boolean; reason: string; path: string; }
interface ItemTableRow { item: ItemSummary; depth: number; children: boolean; expanded: boolean; }
interface IssueEditorHandle { leave(): boolean; busy(): boolean; }
type ProjectView = 'workflow' | 'issue' | 'document';
const draftOf = (detail: ItemDetail): Draft => ({ item: structuredClone(detail.item), hash: detail.hash, dirty: false, reason: '', path: detail.item.path ?? '' });
const isNew = (id: string) => id.startsWith('new-issue:');
const hasDraftChanges = (draft?: Draft) => !!draft && (draft.dirty || !isNew(draft.item.id) && draft.path !== (draft.item.path ?? ''));
const newIssueFields = { title: '', body: '', acceptance: '', status: 'open', priority: 'normal', ownerId: null, issueType: 'task' } as const;
function issueFieldsChanged(item: ProjectItem, baseline: ProjectItem | typeof newIssueFields) {
  return item.title !== baseline.title || item.body !== baseline.body || item.acceptance !== baseline.acceptance
    || item.status !== baseline.status || item.priority !== baseline.priority || item.ownerId !== baseline.ownerId
    || issueTypeOf(item) !== ('kind' in baseline ? issueTypeOf(baseline) : baseline.issueType);
}
const issueFilterStatuses = ['open', 'doing', 'blocked', 'done', 'canceled', 'closed'] as const;
const unassignedOwner = ':unassigned';

export function confirmProjectNavigation() {
  return window.dispatchEvent(new Event('mixcat:before-project-navigation', { cancelable: true }));
}

export function ProjectWorkspace(props: ComponentProps<typeof Workbench>) {
  const { snapshot } = props, projectId = snapshot.project.id;
  const Workspace = snapshot.project.template === 'comfyui' ? ComfyWorkspace : Workbench;
  const [view, setView] = useState<ProjectView>('workflow'), [kind, setKind] = useState<'issue' | 'document'>('issue');
  const issueEditor = useRef<IssueEditorHandle>(null);
  const [selection, setSelection] = useState<Partial<Record<'issue' | 'document', string>>>({});
  const [items, setItems] = useState<ItemSummary[]>([]), [documentWarnings, setDocumentWarnings] = useState<string[]>([]);
  const [request, setRequest] = useState<WorkbenchRequest>(), [managementDirty, setManagementDirty] = useState(false), [loading, setLoading] = useState(false);
  const [workflowDirty, setWorkflowDirty] = useState(false), dirty = managementDirty || workflowDirty;
  const [documentMediaPending, setDocumentMediaPending] = useState(false);
  const [commentFocus, setCommentFocus] = useState<{ itemId: string; commentId: string; token: string }>();
  const executor = useRef(props.execute); executor.current = props.execute;
  const epoch = useRef(0);
  const [navigation, setNavigation] = useState(0);
  const reload = useCallback(async () => {
    const generation = ++epoch.current; setLoading(true);
    const collected: ItemSummary[] = [], warnings = new Set<string>();
    for (const archived of [false, true]) {
      let cursor: string | undefined;
      do {
        const result = await executor.current({ type: 'search_project_items', projectId, query: { archived, limit: 200, cursor } });
        if (generation !== epoch.current) return;
        if (!result?.projectItems) { setLoading(false); return; }
        collected.push(...result.projectItems.items); cursor = result.projectItems.nextCursor ?? undefined;
        result.projectItems.documentWarnings?.forEach(warning => warnings.add(warning));
      } while (cursor);
    }
    if (generation === epoch.current) { setItems(collected); setDocumentWarnings([...warnings]); setLoading(false); }
  }, [projectId]);
  useEffect(() => { void reload(); return () => { epoch.current++; }; }, [reload, snapshot.managementRevision, view]);
  useEffect(() => {
    if (view !== 'document') return;
    const refresh = () => { void reload(); };
    const visible = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', visible);
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', visible); };
  }, [reload, view]);
  useEffect(() => {
    const guard = (event: Event) => {
      const prompt = '当前项目有未发送的消息或未保存的内容。放弃并离开？';
      if (documentMediaPending || issueEditor.current?.busy() || (dirty && !window.confirm(prompt))) event.preventDefault();
    };
    window.addEventListener('mixcat:before-project-navigation', guard);
    void window.mixcat?.setUnsaved?.(projectId, dirty || documentMediaPending);
    return () => { window.removeEventListener('mixcat:before-project-navigation', guard); void window.mixcat?.setUnsaved?.(projectId, false); };
  }, [dirty, documentMediaPending, projectId]);
  function leaveIssue() {
    if (view !== 'issue') return true;
    if (issueEditor.current?.leave() === false) return false;
    if (selection.issue && isNew(selection.issue)) setSelection(current => ({ ...current, issue: undefined }));
    return true;
  }
  function changeView(next: ProjectView) {
    if (next !== 'issue' && !leaveIssue()) return;
    setNavigation(value => value + 1);
    setView(next);
    if (next !== 'workflow') setKind(next);
  }
  function open(reference: ItemReference, commentId?: string) {
    if (reference.projectId !== projectId || documentMediaPending) return;
    const targetKind = reference.kind === 'document' ? 'document' : 'issue';
    if ((targetKind !== 'issue' || reference.id !== selection.issue) && !leaveIssue()) return;
    setNavigation(value => value + 1); setKind(targetKind); setView(targetKind); setSelection(current => ({ ...current, [targetKind]: reference.id }));
    setCommentFocus(commentId ? { itemId: reference.id, commentId, token: crypto.randomUUID() } : undefined);
  }
  function locate(taskId: string, messageId?: string) {
    const task = snapshot.tasks.find(task => task.id === taskId); if (!task) { props.onError('找不到关联执行。'); return; }
    if (!leaveIssue()) return;
    setRequest({ id: crypto.randomUUID(), nodeId: task.nodeId, taskId, messageId }); setView('workflow');
  }
  return <ReferenceNavigation.Provider value={{ projectId, items, open }}><div className="project-workspace" data-view={view}>
    <nav className="project-view-nav" aria-label="项目视图">{([['workflow', '工作流'], ['issue', 'Issue'], ['document', '文档']] as const).map(([id, label]) => <button key={id} type="button" disabled={documentMediaPending} aria-current={view === id ? 'page' : undefined} className={view === id ? 'active' : ''} onClick={() => changeView(id)}>{label}</button>)}{dirty && <span className="draft-indicator">有未保存内容</span>}</nav>
    <div className="workspace-view" hidden={view !== 'workflow'}><Workspace {...props} obscured={props.obscured || view !== 'workflow'} workRequest={request} onDirty={setWorkflowDirty} /></div>
    <div className="workspace-view" hidden={view === 'workflow'}><ProjectManagement ref={issueEditor} navigation={navigation} snapshot={snapshot} kind={kind} items={items} selectedId={selection[kind] ?? null} loading={loading} documentWarnings={documentWarnings}
      execute={props.execute} onSelect={id => { setNavigation(value => value + 1); setSelection(current => ({ ...current, [kind]: id })); setCommentFocus(undefined); }} reload={reload} onDirty={setManagementDirty} onOpen={open} onLocate={locate} commentFocus={commentFocus} mediaPending={documentMediaPending} onPendingMediaChange={setDocumentMediaPending}
      onDispatch={(nodeId, context, text) => { if (!leaveIssue()) return; setRequest({ id: crypto.randomUUID(), nodeId, context, text }); setView('workflow'); }} /></div>
  </div></ReferenceNavigation.Provider>;
}

export function ProjectManagement({ ref, navigation = 0, snapshot, kind, items, selectedId, loading, documentWarnings = [], execute, onSelect, reload, onDirty, onOpen, onLocate, onDispatch, commentFocus, mediaPending = false, onPendingMediaChange }: {
  ref?: Ref<IssueEditorHandle>;
  navigation?: number; snapshot: ProjectSnapshot; kind: 'issue' | 'document'; items: ItemSummary[]; selectedId: string | null; loading: boolean; execute: Execute;
  documentWarnings?: string[];
  onSelect(id: string): void; reload(): Promise<void>; onDirty(dirty: boolean): void; onOpen(reference: ItemReference, commentId?: string): void; onLocate(taskId: string, messageId?: string): void;
  commentFocus?: { itemId: string; commentId: string; token: string };
  mediaPending?: boolean; onPendingMediaChange?(pending: boolean): void;
  onDispatch(nodeId: string, context: WorkContext, text: string): void;
}) {
  const projectId = snapshot.project.id, [drafts, setDrafts] = useState<Record<string, Draft>>({}), [comments, setComments] = useState<Record<string, string>>({});
  const [detail, setDetail] = useState<ItemDetail | null>(null), [error, setError] = useState(''), [pending, setPending] = useState(false);
  const [documentReadFailure, setDocumentReadFailure] = useState<{ id: string; message: string }>();
  const [search, setSearch] = useState(''), [collapsed, setCollapsed] = useState(new Set<string>());
  const [matches, setMatches] = useState<{ text: string; items: ItemSummary[] } | null>(null);
  const [searchFailure, setSearchFailure] = useState('');
  const [searchRetry, setSearchRetry] = useState(0);
  const [statusFilter, setStatusFilter] = useState('');
  const [ownerFilter, setOwnerFilter] = useState('');
  const [draggingTodo, setDraggingTodo] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; position: 'before' | 'inside' | 'after' } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null), [targetNode, setTargetNode] = useState(snapshot.nodes[0]?.id ?? '');
  const [deleteError, setDeleteError] = useState('');
  const [documentMode, setDocumentMode] = useState<'active' | 'archived'>('active'), [sidebar, setSidebar] = useState(true);
  const [editingDocuments, setEditingDocuments] = useState(new Set<string>());
  const [folderRequest, setFolderRequest] = useState<{ path: string | null }>();
  const [contentInset, setContentInset] = useState(0);
  const split = useDocumentSplit(kind === 'document', sidebar);
  const executor = useRef(execute); executor.current = execute;
  const draftsRef = useRef(drafts); draftsRef.current = drafts;
  const pendingRef = useRef(false), pendingIssue = useRef(false), savingDocument = useRef(false);
  const listRef = useRef<HTMLElement>(null), detailRef = useRef<HTMLElement>(null), documentToolbarRef = useRef<HTMLDivElement>(null);
  const newIssueButton = useRef<HTMLButtonElement>(null);
  const filterSearchRef = useRef<HTMLInputElement>(null);
  const statusFilterRef = useRef<HTMLSelectElement>(null), ownerFilterRef = useRef<HTMLSelectElement>(null);
  const requestEpoch = useRef(0), selectionRef = useRef(selectedId); selectionRef.current = selectedId;
  const saveRequests = useRef(new Map<string, { fingerprint: string; id: string; input: Omit<ItemMutation, 'request_id'> }>());
  const editorNavigation = useRef({ key: `${kind}:${selectedId}`, revision: 0 });
  if (editorNavigation.current.key !== `${kind}:${selectedId}`) editorNavigation.current = { key: `${kind}:${selectedId}`, revision: editorNavigation.current.revision + 1 };
  const pendingMediaRef = useRef(mediaPending); pendingMediaRef.current = mediaPending;
  const consumedComment = useRef<string | undefined>(undefined);
  const draft = selectedId ? drafts[selectedId] : undefined, item = draft?.item;
  const documentItem = item?.kind === 'document' ? item : undefined;
  const couldNotReadDocument = documentReadFailure?.id === selectedId;
  const media = useMemo(() => createDocumentMedia({ kind: 'project', projectId, path: item?.path || draft?.path || 'docs/document.md' }), [projectId, item?.path, draft?.path]);
  const dirty = Object.values(drafts).some(draft => hasDraftChanges(draft) || !!draft.reason.trim()) || Object.values(comments).some(text => !!text.trim());
  const autosave = useDocumentAutosave(Object.values(drafts).filter(value => value.item.kind === 'document' && !value.item.archived && !value.item.deletedAt && value.item.id !== documentReadFailure?.id && value.dirty && value.item.title.trim()
    && !(detail?.item.id === value.item.id && (detail.item.revision !== value.item.revision || detail.hash !== value.hash)))
    .map(value => ({ id: value.item.id, fingerprint: JSON.stringify([value.item.title, value.item.body, value.item.revision, value.hash, value.path]) })), pending, async id => !!await persistDocument(id));
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  useEffect(() => {
    if (kind !== 'issue' || !selectedId || commentFocus) return;
    const target = isNew(selectedId) ? detailRef.current?.querySelector<HTMLInputElement>('input[aria-label="工作项标题"]') : detailRef.current;
    target?.focus({ preventScroll: true });
  }, [kind, selectedId, commentFocus]);
  useEffect(() => { if (!commentFocus) detailRef.current?.scrollTo({ top: 0 }); }, [selectedId, kind, commentFocus]);
  useEffect(() => {
    if (!commentFocus || detail?.item.id !== commentFocus.itemId || consumedComment.current === commentFocus.token) return;
    const element = document.getElementById(`comment-${commentFocus.commentId}`); if (!element) return;
    element.scrollIntoView({ block: 'center' }); element.focus({ preventScroll: true }); consumedComment.current = commentFocus.token;
  }, [commentFocus, detail]);
  useEffect(() => { setSearch(''); setMatches(null); setSearchFailure(''); setDeleteTarget(null); setDraggingTodo(null); setDropTarget(null); setFolderRequest(undefined); }, [kind]);
  useEffect(() => { if (!snapshot.nodes.some(node => node.id === targetNode)) setTargetNode(snapshot.nodes[0]?.id ?? ''); }, [snapshot.nodes, targetNode]);
  const loadDetail = useCallback(async (id: string) => {
    const generation = ++requestEpoch.current;
    if (isNew(id)) { setDetail(null); return; }
    const actionId = crypto.randomUUID();
    setDocumentReadFailure(current => current?.id === id ? undefined : current);
    const result = await executor.current({ type: 'get_project_item', projectId, itemId: id, commentId: commentFocus?.itemId === id ? commentFocus.commentId : undefined }, actionId);
    if (generation !== requestEpoch.current || selectionRef.current !== id) return;
    if (!result?.projectItem) {
      if (kind !== 'document') { setError('工作项读取失败，请重新打开后重试。'); return; }
      const receipt = await window.mixcat?.inspect?.(actionId).catch(() => undefined);
      if (generation === requestEpoch.current && selectionRef.current === id) setDocumentReadFailure({
        id, message: receipt?.id === actionId && receipt.error ? receipt.error : '读取文档失败。',
      });
      return;
    }
    setDetail(result.projectItem); setError('');
    const loaded = result.projectItem;
    if (loaded.item.kind === 'document' && loaded.error) setDocumentReadFailure({ id, message: loaded.error });
    setDrafts(current => !loaded.item.deletedAt && current[id] && (loaded.error || hasDraftChanges(current[id])) ? current
      : { ...current, [id]: { ...draftOf(loaded), reason: loaded.item.deletedAt ? '' : current[id]?.reason ?? '' } });
    if (loaded.item.kind === 'document') setDocumentMode(loaded.item.archived && !loaded.item.deletedAt ? 'archived' : 'active');
  }, [projectId, commentFocus, kind]);
  useEffect(() => setDeleteTarget(current => current === selectedId ? current : null), [selectedId]);
  useEffect(() => { if (selectedId) void loadDetail(selectedId); else setDetail(null); return () => { requestEpoch.current++; }; }, [selectedId, loadDetail, snapshot.managementRevision, navigation]);
  const searchText = search.trim();
  useEffect(() => {
    if (!searchText) { setMatches(null); setSearchFailure(''); return; }
    let cancelled = false;
    async function findItems() {
      const found: ItemSummary[] = [];
      let cursor: string | undefined;
      try {
        do {
          const result = await executor.current({ type: 'search_project_items', projectId, query: { kind, archived: kind === 'document' && documentMode !== 'active', text: searchText, limit: 200, cursor } });
          if (cancelled) return;
          if (!result?.projectItems) {
            setSearchFailure(searchText);
            return;
          }
          found.push(...result.projectItems.items);
          cursor = result.projectItems.nextCursor ?? undefined;
        } while (cursor);
        setSearchFailure('');
        setMatches({ text: searchText, items: found });
      } catch {
        if (!cancelled) setSearchFailure(searchText);
      }
    }
    const timer = setTimeout(() => { void findItems(); }, 180);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [searchText, documentMode, kind, projectId, snapshot.managementRevision, items, searchRetry]);

  function clearIssueSearch() {
    setSearch('');
    filterSearchRef.current?.focus({ preventScroll: true });
  }
  function edit(change: Partial<ProjectItem>) {
    if (!selectedId) return;
    setDrafts(current => {
      const currentDraft = current[selectedId];
      if (!currentDraft) return current;
      const item = { ...currentDraft.item, ...change };
      const saved = detail?.item.id === selectedId && detail.item.revision === item.revision ? detail.item : null;
      const baseline = isNew(selectedId) ? newIssueFields : saved;
      return { ...current, [selectedId]: { ...currentDraft, item, dirty: kind !== 'issue' || !baseline || issueFieldsChanged(item, baseline) } };
    });
  }
  const issueBusy = () => pendingIssue.current;
  function leaveIssueEditor() {
    const id = selectedId;
    if (kind !== 'issue' || !id) return true;
    if (issueBusy() || mediaPending) return false;
    if ((hasDraftChanges(draft) || draft?.reason.trim() || comments[id]?.trim()) && !window.confirm('放弃当前 Issue 的未保存内容？')) return false;
    requestEpoch.current++;
    setDrafts(current => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    setComments(current => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    if (isNew(id)) saveRequests.current.delete(id);
    setError('');
    return true;
  }
  useImperativeHandle(ref, () => ({ leave: leaveIssueEditor, busy: issueBusy }));
  function openIssue(id: string) {
    if (id !== selectedId && !leaveIssueEditor()) return false;
    onSelect(id);
    return true;
  }
  function closeDetail() {
    if (!leaveIssueEditor()) return;
    const creating = isNew(selectedId ?? '');
    const returnId = creating ? item?.parentId : selectedId;
    onSelect('');
    requestAnimationFrame(() => {
      const row = returnId ? listRef.current?.querySelector<HTMLButtonElement>(`[data-item-id="${CSS.escape(returnId)}"]`) : null;
      (row ?? (creating ? newIssueButton.current : filterSearchRef.current))?.focus();
    });
  }
  function showDocuments() { setDocumentMode('active'); setMatches(null); onSelect(''); }
  function revealFolder(path: string | null) { setSearch(''); setMatches(null); setFolderRequest({ path }); }
  function create(parentId: string | null = null) {
    if (!leaveIssueEditor()) return;
    const id = `new-issue:${crypto.randomUUID()}`, date = new Date().toISOString();
    const next: ProjectItem = { ...newIssueFields, id, kind: 'issue', number: 0, parentId, position: 0, path: null, archived: false, revision: 0, createdAt: date, updatedAt: date, comments: [] };
    setDrafts(current => ({ ...current, [id]: { item: next, hash: null, dirty: false, reason: '', path: '' } }));
    onSelect(id);
  }
  async function createDocument() {
    if (pendingRef.current || pendingMediaRef.current) return;
    const navigation = editorNavigation.current.revision, key = 'create-document';
    const saved = await mutate({ operation: 'create', kind: 'document', nameFromTitle: true, body: '' }, key);
    if (!saved) return;
    saveRequests.current.delete(key);
    if (navigation !== editorNavigation.current.revision) return;
    const id = saved.item.id;
    setSearch(''); setMatches(null); setDocumentMode('active'); setDetail(saved);
    setEditingDocuments(current => new Set(current).add(id));
    onSelect(id);
    requestAnimationFrame(() => {
      if (selectionRef.current !== id) return;
      const title = detailRef.current?.querySelector<HTMLTextAreaElement>('.document-editing .document-title');
      title?.focus({ preventScroll: true }); title?.select();
    });
  }
  function requestDocumentDeletion(id: string) {
    if (pendingRef.current || pendingMediaRef.current) return;
    if (hasDraftChanges(draftsRef.current[id])) { setError('请先保存或放弃此文档的更改，再删除。'); return; }
    setError(''); setDeleteError('');
    if (selectionRef.current !== id) onSelect(id);
    setDeleteTarget(id);
  }
  async function mutate(input: Omit<ItemMutation, 'request_id'>, key = selectedId ?? input.id ?? 'action') {
    if (pendingRef.current) return null;
    const documentSave = savingDocument.current;
    const documentMutation = documentSave || input.kind === 'document' || draftsRef.current[key]?.item.kind === 'document';
    if (drafts[key]?.reason.trim() && input.reason === undefined) input = { ...input, reason: drafts[key].reason };
    const fingerprint = JSON.stringify(input), previous = saveRequests.current.get(key), request = previous?.fingerprint === fingerprint ? previous : { fingerprint, id: crypto.randomUUID(), input };
    const actionId = documentMutation ? crypto.randomUUID() : request.id;
    input = request.input;
    const failure = input.operation === 'create' && input.kind === 'document' ? '文档创建未完成，请重试。'
      : input.operation === 'delete' ? '文档删除未完成，请核对最新版本后重试。'
      : '保存未完成，输入仍在当前窗口。请核对最新内容或重试。';
    const setFailure = input.operation === 'delete' ? setDeleteError : setError;
    setFailure('');
    saveRequests.current.set(key, request); requestEpoch.current++; pendingRef.current = true; pendingIssue.current = !documentMutation; setPending(true); setError('');
    const inspect = async () => {
      const receipt = await window.mixcat?.inspect?.(actionId).catch(() => null);
      if (receipt?.id !== actionId) return null;
      if (!documentMutation && (receipt?.status === 'failed' || receipt?.status === 'cancelled')) saveRequests.current.delete(key);
      return receipt;
    };
    const reportFailure = async (message?: string) => {
      const detail = typeof message === 'string' ? message.trim() : '';
      if (input.operation === 'delete' && detail.includes(documentDeleteCleanupMessage)) { setDeleteError(documentDeleteCleanupMessage); return; }
      if ((documentSave || input.operation === 'delete') && selectionRef.current === key) await loadDetail(key);
      setFailure(input.operation === 'delete' && detail ? `文档删除未完成。${detail}` : failure);
    };
    try {
      let result = await execute({ type: 'update_project_item', projectId, input: { ...input, request_id: request.id } }, actionId);
      if (!result?.projectItem) {
        const receipt = await inspect();
        result = receipt?.status === 'succeeded' ? receipt.result ?? null : null;
        if (!result?.projectItem) { await reportFailure(receipt?.error); return null; }
      }
      const saved = result.projectItem;
      if (input.operation === 'delete') {
        saveRequests.current.delete(key);
        setDrafts(current => { const next = { ...current }; delete next[key]; return next; });
        setEditingDocuments(current => { const next = new Set(current); next.delete(key); return next; });
        if (selectionRef.current === key) { showDocuments(); setDetail(null); }
        await reload(); return saved;
      }
      const pendingPath = input.operation === 'edit' && saved.item.kind === 'document' && drafts[key]?.path !== drafts[key]?.item.path ? drafts[key]?.path : undefined;
      if (saved.item.kind === 'document') {
        if (selectionRef.current === key) setDocumentMode(saved.item.archived && !saved.item.deletedAt ? 'archived' : 'active');
        if (saved.item.archived) setEditingDocuments(current => { const next = new Set(current); next.delete(saved.item.id); return next; });
      }
      setDrafts(current => {
        const latest = current[key], nextDraft = draftOf(saved);
        if (saved.item.kind === 'document' && documentSave && latest) {
          nextDraft.item = { ...saved.item, title: latest.item.title === input.title ? saved.item.title : latest.item.title, body: latest.item.body === input.body ? saved.item.body : latest.item.body };
          nextDraft.dirty = nextDraft.item.title !== saved.item.title || nextDraft.item.body !== saved.item.body;
          nextDraft.path = latest.path !== (latest.item.path ?? '') ? latest.path : saved.item.path ?? '';
        } else if (pendingPath !== undefined) nextDraft.path = pendingPath;
        const next = { ...current, [saved.item.id]: nextDraft }; if (isNew(key)) delete next[key]; return next;
      });
      if (selectionRef.current === key) { if (saved.item.id !== key || !savingDocument.current) onSelect(saved.item.id); setDetail(saved); }
      await reload(); return saved;
    } catch (error) { const receipt = await inspect(); await reportFailure(receipt?.error ?? String(error)); return null; } finally { pendingRef.current = false; pendingIssue.current = false; setPending(false); }
  }
  async function persistDocument(id: string): Promise<ItemDetail | null> {
    const value = draftsRef.current[id], document = value?.item;
    if (!value || !document || document.kind !== 'document' || document.archived || document.deletedAt || pendingRef.current || documentReadFailure?.id === id) return null;
    if (!document.title.trim()) { setError('请填写标题。'); return null; }
    if (!value.dirty) return detail?.item.id === id ? detail : null;
    savingDocument.current = true;
    try { return await mutate({ operation: 'edit', id, expected_revision: document.revision, expected_hash: value.hash, nameFromTitle: true, title: document.title, body: document.body }, id); }
    finally { savingDocument.current = false; }
  }
  async function save(event?: FormEvent) {
    event?.preventDefault(); if (!draft || !item || !selectedId || pending || conflicted) return null;
    if (!item.title.trim()) { setError('请填写标题。'); return null; }
    if (item.kind === 'document') return await persistDocument(item.id);
    const base = isNew(item.id) ? { operation: 'create' as const, kind: item.kind, parentId: item.parentId }
      : { operation: 'edit' as const, id: item.id, expected_revision: item.revision };
    return await mutate({ ...base, title: item.title, body: item.body, acceptance: item.acceptance, ownerId: item.ownerId, priority: item.priority, issueType: issueTypeOf(item), ...(!isNew(item.id) ? { status: item.status } : {}), ...(draft.reason.trim() ? { reason: draft.reason } : {}) });
  }
  async function move(id: string, parentId: string | null, beforeId: string | null = null) {
    const target = items.find(item => item.id === id);
    if (!target || hasDraftChanges(drafts[id]) || drafts[id]?.reason.trim()) { setError('请先保存 Issue 的修改，再调整层级或顺序。'); return; }
    await mutate({ operation: 'move', id, expected_revision: target.revision, parentId, beforeId }, id);
  }
  async function toggleDocumentMode() {
    if (!item || pending || conflicted || mediaPending) return;
    const navigation = editorNavigation.current.revision;
    let targetId = item.id;
    if (documentEditing && hasDraftChanges(draft)) {
      const saved = await save();
      if (!saved) return;
      targetId = saved.item.id;
      if (draft!.path !== (item.path ?? '')) { setError('正文已保存。请完成移动文件操作后再切换阅读。'); return; }
    }
    if (navigation !== editorNavigation.current.revision || pendingMediaRef.current) return;
    const scrollTop = detailRef.current?.scrollTop ?? 0;
    setEditingDocuments(current => { const next = new Set(current); documentEditing ? next.delete(targetId) : next.add(targetId); return next; });
    // The first CodeMirror mount measures after the mode's initial render.
    requestAnimationFrame(() => requestAnimationFrame(() => { if (detailRef.current && selectionRef.current === targetId && navigation === editorNavigation.current.revision) detailRef.current.scrollTop = scrollTop; }));
  }
  const searching = !!searchText;
  const searchFailed = searching && searchFailure === searchText;
  const searchPending = searching && !searchFailed && matches?.text !== searchText;
  const searchResults = kind !== 'issue' || matches?.text === searchText ? matches?.items : undefined;
  const currentItems = searching ? searchResults ?? (kind === 'issue' ? [] : items) : items;
  const todoItems = kind === 'issue' ? items.filter(item => item.kind !== 'document' && !item.archived) : [];
  const todoById = new Map(todoItems.map(item => [item.id, item]));
  function issuePath(current: ProjectItem) {
    const parents = [], seen = new Set([current.id]);
    let next = current.parentId;
    while (next && !seen.has(next)) {
      const parent = todoById.get(next) ?? items.find(candidate => candidate.id === next && candidate.kind !== 'document');
      if (!parent) break;
      seen.add(next); parents.unshift({ id: next, label: parent.title, open: () => openIssue(parent.id) }); next = parent.parentId;
    }
    return parents;
  }
  const filtering = searching || kind === 'issue' && !!(statusFilter || ownerFilter);
  const ownerIds = new Set([...snapshot.nodes.map(node => node.id), ...todoItems.flatMap(item => item.ownerId ? [item.ownerId] : []), ...(ownerFilter ? [ownerFilter] : [])]);
  ownerIds.delete('user');
  ownerIds.delete(unassignedOwner);
  function ownerLabel(id: string | null | undefined) {
    if (!id || id === unassignedOwner) return '未分配';
    if (id === 'user') return '我';
    return snapshot.nodes.find(node => node.id === id)?.name ?? `${snapshot.archivedNodes?.find(node => node.id === id)?.name ?? id}（已归档）`;
  }
  const visible = currentItems.filter(item => {
    if (kind === 'document') {
      return item.kind === 'document' && !item.deletedAt && item.archived === (documentMode === 'archived');
    }
    const status = item.status === 'todo' ? 'open' : item.status;
    return item.kind !== 'document' && !item.archived && (!statusFilter || statusFilter === status)
      && (!ownerFilter || ownerFilter === (item.ownerId || unassignedOwner));
  });
  const matchingIds = new Set(visible.map(item => item.id)), visibleIds = new Set(matchingIds);
  if (kind === 'issue' && filtering) {
    for (const match of [...visible]) {
      const seen = new Set([match.id]); let parent = todoById.get(match.parentId ?? '');
      while (parent && !seen.has(parent.id)) {
        seen.add(parent.id); if (!visibleIds.has(parent.id)) { visible.push(parent); visibleIds.add(parent.id); }
        parent = todoById.get(parent.parentId ?? '');
      }
    }
  }
  function rows(parentId: string | null, depth: number, seen = new Set<string>()): ItemTableRow[] {
    return visible.filter(item => (item.parentId ?? null) === parentId || depth === 0 && !visibleIds.has(item.parentId ?? '')).sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.number - b.number).flatMap(item => {
      if (seen.has(item.id)) return [];
      const children = visible.some(child => child.parentId === item.id), expanded = children && (filtering || !collapsed.has(item.id));
      return [{ item, depth, children, expanded }, ...(expanded ? rows(item.id, depth + 1, new Set(seen).add(item.id)) : [])];
    });
  }
  const tableRows = kind !== 'document' ? rows(null, 0) : [];
  const maxDepth = tableRows.reduce((max, row) => Math.max(max, row.depth), 0), todoEditable = kind !== 'document' && !pending;
  let dropIndicator = dropTarget;
  if (dropTarget?.position === 'after') {
    const index = tableRows.findIndex(row => row.item.id === dropTarget.id);
    let last = index;
    while (index >= 0 && last + 1 < tableRows.length && tableRows[last + 1].depth > tableRows[index].depth) last++;
    if (last >= 0) dropIndicator = { ...dropTarget, id: tableRows[last].item.id };
  }
  function rowDropPosition(event: React.DragEvent) {
    const bounds = event.currentTarget.getBoundingClientRect(), offset = (event.clientY - bounds.top) / bounds.height;
    return offset < .25 ? 'before' : offset > .75 ? 'after' : 'inside';
  }
  function siblingsOf(row: ItemSummary, excludeId?: string) {
    return todoItems.filter(item => item.id !== excludeId && item.parentId === row.parentId).sort((a, b) => a.position - b.position || a.number - b.number);
  }
  function dropTodo(event: React.DragEvent, row?: ItemSummary) {
    if (!todoEditable) return;
    event.preventDefault(); event.stopPropagation(); setDraggingTodo(null); setDropTarget(null);
    const id = event.dataTransfer.getData('application/x-mixcat-todo'); if (!id || id === row?.id) return;
    if (!row) { void move(id, null); return; }
    const position = rowDropPosition(event);
    if (position === 'inside') { void move(id, row.id); return; }
    const siblings = siblingsOf(row, id), index = siblings.findIndex(item => item.id === row.id);
    void move(id, row.parentId, position === 'before' ? row.id : siblings[index + 1]?.id ?? null);
  }
  function moveWithKeyboard(event: React.KeyboardEvent, row: ItemSummary) {
    if (!todoEditable || !event.altKey || event.ctrlKey || event.metaKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const siblings = siblingsOf(row), index = siblings.findIndex(item => item.id === row.id);
    if (event.key === 'ArrowUp' && index > 0) void move(row.id, row.parentId, siblings[index - 1].id);
    else if (event.key === 'ArrowDown' && index < siblings.length - 1) void move(row.id, row.parentId, siblings[index + 2]?.id ?? null);
  }
  const fresh = detail?.item.id === selectedId ? detail : null;
  const creatingIssue = kind === 'issue' && isNew(selectedId ?? '');
  const discussion = fresh ? [...(fresh.focusedComment && !fresh.item.comments.some(comment => comment.id === fresh.focusedComment!.id) ? [fresh.focusedComment] : []), ...fresh.item.comments] : [];
  const conflicted = !!draft && hasDraftChanges(draft) && !!fresh && !fresh.error && (fresh.item.revision !== item?.revision || item?.kind === 'document' && fresh.hash !== draft.hash);
  const canManage = !!item && !isNew(item.id) && !pending && !mediaPending && !draft?.dirty;
  const readableDocument = !!documentItem && (!couldNotReadDocument && !fresh?.error || draft?.hash != null);
  const documentEditing = !!documentItem && readableDocument && editingDocuments.has(documentItem.id) && !documentItem.archived && !documentItem.deletedAt;
  const documentStatus = documentItem && (documentItem.deletedAt ? '已永久删除' : [
    documentItem.archived ? '已归档' : '',
    autosave.savingId === documentItem.id ? '保存中…' : hasDraftChanges(draft) ? '未保存' : fresh?.error ? '无法读取文件' : '已保存',
  ].filter(Boolean).join(' · '));
  const headingPrefix = `document-${selectedId}`, headings = documentItem ? markdownHeadings(documentItem.body, headingPrefix) : [];
  const documentPath = documentFolders(documentItem?.path ?? '').map(({ name, path }) => ({ id: path, label: name, open: () => revealFolder(path) }));
  const actions = <div className="management-actions">
    {kind === 'document' && (documentMode === 'archived' || documentItem?.deletedAt) && <button type="button" className="button secondary compact" disabled={pending} onClick={showDocuments}>返回文档</button>}
    {kind !== 'document' && <button type="button" className="button secondary compact" disabled={pending} onClick={() => { void reload(); if (selectedId && !isNew(selectedId)) void loadDetail(selectedId); }}>刷新</button>}
    <button ref={kind === 'issue' ? newIssueButton : undefined} type="button" className="button primary compact" disabled={pending || mediaPending} onClick={() => { if (kind === 'document') void createDocument(); else create(); }}>新建{itemKinds[kind]}</button>
  </div>;
  const links = <section className="item-links"><h2>引用了</h2>{fresh?.references.length ? fresh.references.map(reference => { const target = items.find(item => item.id === reference.id && item.kind === reference.kind); return <button type="button" className="text-button" key={`${reference.kind}:${reference.id}`} onClick={() => onOpen(reference)}>{target ? `${itemNumber(target)} ${target.title}${target.archived ? '（已归档）' : ''}` : '查看引用记录'}</button>; }) : <p>暂无已保存引用</p>}<h2>被引用</h2>{fresh?.backlinks.length ? fresh.backlinks.map((link, index) => <button type="button" className="text-button" key={index} data-message-id={link.messageId} onClick={() => link.taskId ? onLocate(link.taskId, link.messageId) : onOpen({ projectId, kind: link.kind, id: link.itemId }, link.commentId)}>{link.title}{link.commentId && ' · 评论'}{link.taskId && ' · 会话消息'}</button>) : <p>暂无反向引用</p>}{fresh?.referenceErrors?.map(message => <p className="inline-warning" key={message}>{message}</p>)}</section>;
  return <main className={`project-management${kind === 'document' ? ` document-workspace${sidebar ? ' with-sidebar' : ''}` : ` table-workspace ${kind}-workspace${selectedId ? ' with-item-detail' : ''}`}`} aria-label={`${itemKinds[kind]}管理`}>
    {kind === 'document' && documentMode === 'archived' && <header className="management-heading"><div><h1>已归档文档</h1></div></header>}
    {kind === 'document' && documentWarnings.length > 0 && <details className="document-warnings" open><summary>文档提示（{documentWarnings.length}）</summary>{documentWarnings.map(warning => <p key={warning}>{warning}</p>)}<p>文件缺失或移动时，请打开原文档，进入编辑并使用“重新关联”。</p></details>}
    <div ref={split.bodyRef} className="management-body" style={split.style}><aside ref={listRef} id={kind === 'document' ? `document-list-${projectId}` : undefined} className="management-list">
      <div ref={split.toolbarRef} className="management-filters">
        <SearchField key={`${projectId}:${kind}`} inputRef={filterSearchRef} value={search} onChange={setSearch} label="搜索工作项"
          className={kind === 'document' ? 'document-tree-search' : 'issue-search'}
          placeholder={kind === 'document' ? '搜索文档' : '搜索 Issue 标题、编号或正文'}
          clearLabel={kind === 'document' ? '清除文档搜索' : '清除 Issue 搜索'} busy={searchPending} />
        {kind === 'issue' && <div className="issue-filter-controls" role="group" aria-label="Issue 筛选">
          <div className="issue-filter-select">
            <select ref={statusFilterRef} aria-label="筛选 Issue 状态" value={statusFilter} onChange={event => setStatusFilter(event.target.value)}>
              <option value="">全部状态</option>
              {issueFilterStatuses.map(status => <option key={status} value={status}>{itemStatuses[status]}</option>)}
            </select><Icon name="chevron" size={14} />
          </div>
          <div className="issue-filter-select owner-filter-select">
            <select ref={ownerFilterRef} aria-label="筛选 Issue 负责人" title={ownerFilter ? ownerLabel(ownerFilter) : undefined} value={ownerFilter} onChange={event => setOwnerFilter(event.target.value)}>
              <option value="">全部负责人</option>
              <option value={unassignedOwner}>未分配</option>
              <option value="user">我</option>
              {[...ownerIds].map(id => <option key={id} value={id}>{ownerLabel(id)}</option>)}
            </select><Icon name="chevron" size={14} />
          </div>
        </div>}
        {actions}
      </div>
      {kind === 'issue' && filtering && <div className="issue-filter-chips" aria-label="已应用筛选" role="group">
        {searching && <button type="button" aria-label="清除关键词筛选" title={searchText} onClick={clearIssueSearch}><span>关键词</span><strong>{searchText}</strong><Icon name="close" size={12} /></button>}
        {statusFilter && <button type="button" aria-label="清除状态筛选" onClick={() => { setStatusFilter(''); statusFilterRef.current?.focus(); }}><span>状态</span><strong>{itemStatuses[statusFilter]}</strong><Icon name="close" size={12} /></button>}
        {ownerFilter && <button type="button" aria-label="清除负责人筛选" title={ownerLabel(ownerFilter)} onClick={() => { setOwnerFilter(''); ownerFilterRef.current?.focus(); }}><span>负责人</span><strong>{ownerLabel(ownerFilter)}</strong><Icon name="close" size={12} /></button>}
      </div>}
      {searchFailed && <div className={kind === 'document' ? 'document-search-feedback' : 'issue-search-feedback'} role="alert"><span>{kind === 'document' ? '文档搜索失败。' : 'Issue 搜索失败。'}</span><button type="button" className="text-button" onClick={() => { setSearchFailure(''); setSearchRetry(current => current + 1); filterSearchRef.current?.focus(); }}>重试搜索</button></div>}
      <span className="management-search-status" role="status">{searchPending ? (kind === 'document' ? '正在搜索文档…' : '正在搜索 Issue…') : ''}</span>
      {kind !== 'document' && !selectedId && error && <p className="inline-error management-list-error" role="alert">{error}</p>}
      {kind === 'document' && <DocumentTree focusFolder={folderRequest} items={visible.map(row => {
        const draft = drafts[row.id];
        if (!draft) return row;
        const latest = draft.item.revision >= row.revision;
        const title = (draft.dirty || latest) && draft.item.title.trim() || row.title, path = latest ? draft.item.path ?? row.path : row.path;
        return title === row.title && path === row.path ? row : { ...row, title, path };
      })} selectedId={selectedId} dirtyIds={new Set(Object.values(drafts).filter(hasDraftChanges).map(draft => draft.item.id))}
        onSelect={id => { if (!mediaPending) onSelect(id); }} onDelete={requestDocumentDeletion} />}
      {kind !== 'document' ? <div className={`item-table-scroll issue-table-scroll${visible.length ? '' : ' is-compact'}`} role="region" aria-label="Issue 表格" aria-busy={loading || searchPending} tabIndex={0}><table className="item-table issue-table todo-table" aria-label="Issue 列表" style={{ '--issue-tree-indent': `${maxDepth * 18}px` } as CSSProperties}>
        <thead><tr>{['标题', '状态', '类型', '进度', '优先级', '负责人', '更新时间'].map((label, index) => <th key={label} scope="col" className={index === 0 ? `todo-root-drop${draggingTodo ? ' is-dragging' : ''}` : undefined} title={index === 0 ? '拖到此处移至根级' : undefined} onDragOver={event => { if (todoEditable && draggingTodo && index === 0) { event.preventDefault(); setDropTarget(null); } }} onDrop={event => { if (index === 0) dropTodo(event); }}>{index === 0 && draggingTodo ? '拖到此处移至根级' : label}</th>)}</tr></thead>
        <tbody>
        {!visible.length && !searchFailed && <tr className="issue-empty-row"><td colSpan={7} className="management-empty"><span role="status">{searchPending ? '正在搜索 Issue…' : loading ? '正在读取…' : filtering ? '没有匹配的 Issue，请调整搜索或筛选条件。' : '还没有 Issue'}</span></td></tr>}
        {tableRows.map(({ item: row, depth, children, expanded }) => {
          const owner = ownerLabel(row.ownerId);
          const parent = todoById.get(row.parentId ?? ''), context = filtering && !matchingIds.has(row.id);
          const progress = todoItems.some(item => item.parentId === row.id) ? todoProgress(items, row.id) : null;
          const titleButton = <button type="button" className="item-title issue-title management-row-main" data-item-id={row.id} data-issue-id={row.id} title={`${row.title} · Alt+↑/↓ 调整同级顺序`} aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown" onKeyDown={event => moveWithKeyboard(event, row)} aria-label={`${itemNumber(row)} ${row.title}，第${depth + 1}级${parent ? `，父 Issue ${itemNumber(parent)} ${parent.title}` : ''}${context ? '，匹配结果的上级' : ''}`} aria-expanded={selectedId === row.id}><strong>{row.title}</strong><span className="issue-title-meta"><span className="item-number issue-number">{itemNumber(row)}</span>{context && <span className="todo-context">上级</span>}</span></button>;
          return <tr key={row.id} className={`management-row${context ? ' is-ancestor' : ''}${selectedId === row.id ? ' is-selected' : ''}`} data-todo-id={row.id} data-issue-row={row.id} data-drop-position={dropTarget?.id === row.id ? dropTarget.position : undefined} data-drop-indicator={dropIndicator?.id === row.id ? dropIndicator.position : undefined} draggable={todoEditable} onDragStart={event => { if (!todoEditable) return; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-mixcat-todo', row.id); setDraggingTodo(row.id); }} onDragEnd={() => { setDraggingTodo(null); setDropTarget(null); }} onDragOver={event => {
            if (!todoEditable || !draggingTodo || draggingTodo === row.id) return;
            event.preventDefault(); event.dataTransfer.dropEffect = 'move';
            const position = rowDropPosition(event); setDropTarget(current => current?.id === row.id && current.position === position ? current : { id: row.id, position });
          }} onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDropTarget(null); }} onDrop={event => dropTodo(event, row)} onClick={() => openIssue(row.id)}>
            <td style={{ paddingLeft: 12 + depth * 18 }}><div className="todo-title-cell">{children ? <button type="button" className="tree-toggle" aria-label={`${expanded ? '折叠' : '展开'} ${itemNumber(row)} ${row.title}`} aria-expanded={expanded} disabled={filtering} title={filtering ? '筛选时展示匹配项的上级路径' : undefined} onClick={event => { event.stopPropagation(); setCollapsed(current => { const next = new Set(current); next.has(row.id) ? next.delete(row.id) : next.add(row.id); return next; }); }}><Icon name="chevron" size={14} /></button> : <span className="tree-toggle" />}{titleButton}</div></td>
            <td><span className={`item-status issue-status status-${row.archived ? 'archived' : row.status}`}>{row.archived ? '已归档' : itemStatuses[row.status]}</span></td>
            <td>{{ task: '普通任务', bug: '缺陷', enhancement: '功能改进', requirement: '需求' }[issueTypeOf(row)]}</td>
            <td><span className="todo-progress">{progress?.total ? `${progress.completed}/${progress.total}` : '—'}</span></td>
            <td><span className={`item-priority issue-priority priority-${row.priority}`}>{{ low: '低', normal: '普通', high: '高' }[row.priority]}</span></td>
            <td title={owner}>{owner}</td>
            <td><time dateTime={row.updatedAt} title={new Date(row.updatedAt).toLocaleString()}>{new Date(row.updatedAt).toLocaleString(undefined, { hourCycle: 'h23' })}</time></td>
          </tr>;
        })}</tbody>
      </table></div> : !visible.length && !searchFailed && <p role="status" className="management-empty">{searchPending ? '正在搜索文档…' : loading ? '正在读取…' : search ? '没有匹配的内容' : documentMode === 'archived' ? '没有归档内容' : '还没有文档'}</p>}
    </aside>{kind === 'document' && <DocumentSplitHandle scrollRef={listRef} toolbarRef={split.toolbarRef} label="调整文件树宽度" width={split.widths.tree} min={split.minTree} max={split.maxTree} onResize={width => split.resize('tree', width)} />}{(kind === 'document' || selectedId) && <section ref={detailRef} id={kind === 'document' ? `document-detail-${projectId}` : undefined} className="management-detail" aria-label="工作项详情" tabIndex={kind !== 'document' ? -1 : undefined} onKeyDown={event => { if (kind === 'document' && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && !event.nativeEvent.isComposing) { event.preventDefault(); if (documentEditing) void save(); } if (kind !== 'document' && event.key === 'Escape' && !event.defaultPrevented && !event.nativeEvent.isComposing) { event.preventDefault(); closeDetail(); } }}>
      {kind !== 'document' && <div className="item-detail-actions">
        {item && item.kind !== 'document' && !isNew(item.id) && <PathBreadcrumb label="Issue 路径"
          root={{ id: 'issues', label: 'Issue', open: closeDetail }} ancestors={issuePath(item)} current={item.title} />}
        {creatingIssue ? <span className="item-detail-state">{item?.parentId ? '新建子 Issue' : '新建 Issue'}</span>
          : item?.archived && <span className="item-detail-state">已归档</span>}
        {item && !creatingIssue && <button type="button" className="text-button" disabled={!canManage || item.archived || ['done', 'closed', 'canceled'].includes(item.status)} onClick={() => create(item.id)}>＋ 子 Issue</button>}
        <button type="button" className="icon-button" disabled={issueBusy()} onClick={closeDetail} aria-label="关闭 Issue 详情" title="关闭详情"><Icon name="close" size={16} /></button>
      </div>}
      {mediaPending && <p className="document-resource-status" role="status">正在插入媒体，请稍后切换文档或阅读模式。</p>}
      {error && <p className="inline-error" role="alert">{error}{autosave.failed && <button type="button" className="text-button" onClick={() => autosave.retry()}>重试</button>}</p>}
      {kind === 'document' && !!selectedId && documentReadFailure?.id === selectedId && <p className="inline-error" role="alert">
        {documentReadFailure.message}<button type="button" className="text-button" onClick={() => void loadDetail(selectedId)}>重试读取文档</button>
      </p>}
      {kind === 'document' && <div ref={documentToolbarRef} className="item-detail-heading" aria-hidden={!documentItem} style={documentItem ? undefined : { visibility: 'hidden' }}><span>{documentStatus}</span><div>{!documentItem?.deletedAt && <button type="button" className="text-button" disabled={!readableDocument || pending || documentItem?.archived || conflicted} onClick={() => void toggleDocumentMode()}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d={documentEditing ? 'M3 5h7l2 2 2-2h7v15h-7l-2 2-2-2H3z M12 7v15' : 'm4 17-1 4 4-1L21 6l-3-3z M15 6l3 3'} /></svg>{documentEditing ? '阅读' : '编辑'}</button>}<button type="button" className="text-button" disabled={!documentItem} aria-expanded={sidebar} onClick={() => setSidebar(value => !value)}>{sidebar ? '收起大纲与引用' : '展开大纲与引用'}</button></div></div>}
      {!item || (kind === 'document' ? item.kind !== 'document' : item.kind === 'document') ? kind !== 'document' ? !error && <p role="status" className="management-empty">正在读取{itemKinds[kind]}…</p>
        : selectedId ? documentReadFailure?.id !== selectedId && <ReadingPlaceholder label="正在读取文档…" />
          : <div className="management-placeholder"><h2>选择或新建{itemKinds[kind]}</h2><p>在正文中输入 @，连接项目中的工作与资料。</p></div> : <>
        {kind !== 'document' && fresh?.error && <p className="inline-error" role="alert">{fresh.error}</p>}
        {conflicted && <section className="draft-conflict" role="alert"><strong>内容已有新版本，当前输入仍在窗口中</strong><details><summary>比较最新内容：{fresh!.item.title} · {itemStatuses[fresh!.item.status]}</summary><ProjectMarkdown text={`${fresh!.item.body}\n\n${fresh!.item.acceptance}`} /></details><button type="button" className="button secondary" onClick={() => setDrafts(current => ({ ...current, [item.id]: { ...current[item.id], item: { ...current[item.id].item, revision: fresh!.item.revision }, hash: fresh!.hash } }))}>已手动合并，更新保存基线</button></section>}
        {item.kind === 'document' && item.deletedAt && <section className="management-placeholder"><h2>{item.title}</h2><p>{item.path}</p><p>删除于 <time dateTime={item.deletedAt}>{new Date(item.deletedAt).toLocaleString()}</time></p></section>}
        {item.kind === 'document' && !item.deletedAt && <form className="management-form document-form" key={item.id} onSubmit={event => { void save(event); }}>
          <PathBreadcrumb label="文档路径" root={{ id: 'docs', label: '项目文档', open: () => revealFolder(null) }} ancestors={documentPath} current={item.title} />
          {readableDocument && <DocumentEditorPane identity={`project:${projectId}:${item.id}`} title={item.title} content={item.body} editing={documentEditing} disabled={pending && !savingDocument.current || item.archived} onTitleChange={title => edit({ title })} onContentChange={body => edit({ body })} headingPrefix={headingPrefix}
            onComplete={async query => { const result = await execute({ type: 'search_project_items', projectId, query: { text: query, limit: 20 } }); return (result?.projectItems?.items ?? []).map(target => ({ label: `${itemNumber(target)} ${target.title}`, detail: itemKinds[target.kind], apply: `${itemLink(projectId, target)} ` })); }}
            onOpenLink={href => { const reference = parseItemReference(href); if (reference?.projectId === projectId) onOpen(reference); }}
            renderLink={(href, children) => {
              const reference = parseItemReference(href);
              if (!reference || reference.projectId !== projectId) return <span className="unresolved-reference" title="该引用属于其他项目或当前环境无法打开">{children}</span>;
              const target = items.find(item => item.id === reference.id && item.kind === reference.kind);
              const title = target ? `${itemKinds[target.kind]} · ${target.deletedAt ? '已删除' : target.archived ? '已归档' : itemStatuses[target.status]}` : '查看引用；目标可能尚未加载或已缺失';
              return <button type="button" className="item-reference" title={title} onClick={() => onOpen(reference)}>{target ? `@${itemNumber(target)} ${target.title}` : children}{target?.deletedAt ? '（已删除）' : target?.archived ? '（归档）' : ''}</button>;
            }} onPasteImage={media.importImages} onInsertMedia={media.importMedia} onPendingMediaChange={onPendingMediaChange} resolveResource={media.resolveResource} />}
          <details className="document-file-operations"><summary>文件操作</summary><label>项目内路径<div className="document-path-control"><input aria-label="文档路径" disabled={pending || item.archived} value={draft!.path} onChange={event => setDrafts(current => ({ ...current, [item.id]: { ...current[item.id], path: event.target.value } }))} /><button type="button" className="button secondary" disabled={!canManage || !draft!.path || draft!.path === item.path} onClick={() => void mutate({ operation: fresh?.error ? 'relink' : 'move', id: item.id, expected_revision: fresh?.error ? fresh.item.revision : item.revision, expected_hash: fresh?.error ? fresh.hash : draft!.hash, path: draft!.path })}>{fresh?.error ? '重新关联' : '移动文件'}</button></div></label></details>
          {documentEditing && hasDraftChanges(draft) && <button type="button" className="text-button" disabled={pending} onClick={() => { if (fresh && window.confirm('放弃未保存的更改并载入最新内容？')) setDrafts(current => ({ ...current, [item.id]: draftOf(fresh) })); }}>放弃更改</button>}
        </form>}
        {item.kind !== 'document' && <form className="management-form" onSubmit={event => { void save(event); }}><fieldset disabled={issueBusy() || item.archived}>
          <label>标题<input aria-label="工作项标题" required maxLength={200} value={item.title} onChange={event => edit({ title: event.target.value })} /></label>
          <div className="item-fields"><label>状态<select aria-label="工作项状态" disabled={isNew(item.id)} value={item.status === 'todo' ? 'open' : item.status} onChange={event => edit({ status: event.target.value as ProjectItem['status'] })}>{['open', 'doing', 'blocked', 'done', 'canceled', ...(item.status === 'closed' ? ['closed'] : [])].map(status => <option key={status} value={status}>{itemStatuses[status]}</option>)}</select></label><label>优先级<select aria-label="优先级" value={item.priority} onChange={event => edit({ priority: event.target.value as ProjectItem['priority'] })}><option value="low">低</option><option value="normal">普通</option><option value="high">高</option></select></label><label>负责人<select aria-label="负责人" value={item.ownerId ?? ''} onChange={event => edit({ ownerId: event.target.value || null })}><option value="">未分配</option><option value="user">我</option>{snapshot.nodes.map(node => <option key={node.id} value={node.id}>{node.name}</option>)}{item.ownerId && item.ownerId !== 'user' && !snapshot.nodes.some(node => node.id === item.ownerId) && <option value={item.ownerId}>{snapshot.archivedNodes?.find(node => node.id === item.ownerId)?.name ?? "节点"}（已归档）</option>}</select></label><label>类型<select aria-label="Issue 类型" value={issueTypeOf(item)} onChange={event => edit(item.kind === 'todo' ? { legacyTodoType: event.target.value as ProjectItem['issueType'] } : { issueType: event.target.value as ProjectItem['issueType'] })}><option value="task">普通任务</option><option value="bug">缺陷</option><option value="enhancement">功能改进</option><option value="requirement">需求</option></select></label></div>
          {!isNew(item.id) && !item.archived && <div className="todo-structure"><label>父 Issue<select aria-label="父 Issue" disabled={!canManage} value={item.parentId ?? ''} onChange={event => void move(item.id, event.target.value || null)}><option value="">根级</option>{items.filter(other => other.kind !== 'document' && !other.archived && other.id !== item.id).map(other => <option key={other.id} value={other.id}>{itemNumber(other)} · {other.title}</option>)}</select></label></div>}
          <label>正文<ReferenceEditor projectId={projectId} value={item.body} onChange={body => edit({ body })} execute={execute} label="工作项正文" rows={7} disabled={issueBusy() || item.archived} /></label>
          <><label>验收说明<ReferenceEditor projectId={projectId} value={item.acceptance} onChange={acceptance => edit({ acceptance })} execute={execute} label="验收说明" rows={3} disabled={issueBusy() || item.archived} /></label><label>处理说明<input aria-label="处理说明" value={draft!.reason} placeholder="完成、取消或重开时填写实际依据" onChange={event => setDrafts(current => ({ ...current, [item.id]: { ...current[item.id], reason: event.target.value } }))} /></label></>
          <div className="item-save-actions">
            <button className="button primary" disabled={pending || item.archived || conflicted || (creatingIssue && !item.title.trim())}>{creatingIssue ? '创建 Issue' : '保存'}</button>
            {creatingIssue && <button type="button" className="button secondary" onClick={closeDetail}>取消</button>}
            {['done', 'closed', 'canceled'].includes(item.status) && <button type="button" className="button secondary" disabled={!canManage} onClick={() => void mutate({ operation: 'reopen', id: item.id, expected_revision: item.revision, reason: draft!.reason })}>重新打开</button>}
          </div>
        </fieldset></form>}
        {!isNew(item.id) && <>
          {item.kind !== 'document' && !item.archived && <div className="item-dispatch"><select aria-label="交给节点" value={targetNode} onChange={event => setTargetNode(event.target.value)}>{snapshot.nodes.map(node => <option key={node.id} value={node.id}>{node.name}</option>)}</select><button type="button" className="button secondary" disabled={!canManage || !snapshot.nodes.some(node => node.id === targetNode)} onClick={() => {
            const references = referencesIn(item.body + '\n' + item.acceptance, projectId); if (!references.some(reference => reference.id === item.id)) references.unshift({ projectId, kind: item.kind, id: item.id });
            onDispatch(targetNode, { primary_issue_id: item.id, references }, `请处理 ${itemLink(projectId, item)}，依据工作项中的说明和验收条件完成，并记录实际结果。`);
          }}>交给节点…</button><small>打开输入框，发送后开始处理</small></div>}
          {item.kind !== 'document' && links}
          {!!fresh?.taskIds.length && <section className="item-links"><h2>关联执行</h2>{fresh.taskIds.map(id => { const task = snapshot.tasks.find(task => task.id === id); return <button className="text-button" type="button" key={id} onClick={() => onLocate(id)}>{snapshot.nodes.find(node => node.id === task?.nodeId)?.name ?? '已归档节点'} · {task?.status ?? '未知'}</button>; })}</section>}
          {item.kind !== 'document' && <section className="item-comments"><h2>讨论</h2>{discussion.map(comment => <article tabIndex={-1} id={`comment-${comment.id}`} key={comment.id}><small>{comment.author.kind === 'user' ? '我' : snapshot.nodes.find(node => node.id === comment.author.nodeId)?.name ?? '节点'} · {new Date(comment.createdAt).toLocaleString()}</small><ProjectMarkdown text={comment.body} historical /></article>)}{!item.archived && <><ReferenceEditor projectId={projectId} label="Issue 评论" value={comments[item.id] ?? ''} onChange={text => setComments(current => ({ ...current, [item.id]: text }))} execute={execute} rows={3} disabled={pending} /><button type="button" className="button secondary" disabled={!canManage || !comments[item.id]?.trim()} onClick={async () => { if (await mutate({ operation: 'comment', id: item.id, expected_revision: item.revision, body: comments[item.id] })) setComments(current => ({ ...current, [item.id]: '' })); }}>发表评论</button>{draft!.dirty && <small>保存修改后可发表评论。</small>}</>}</section>}
          {fresh?.nextCursor && <button type="button" className="text-button" disabled={pending} onClick={async () => {
            const generation = ++requestEpoch.current; setPending(true);
            try { const reply = await execute({ type: 'get_project_item', projectId, itemId: item.id, cursor: fresh.nextCursor! }); const older = reply?.projectItem;
              if (older && generation === requestEpoch.current) setDetail(current => current?.item.id === item.id ? { ...older, focusedComment: current.focusedComment, item: { ...older.item, comments: [...older.item.comments, ...current.item.comments] }, references: [...older.references, ...current.references], backlinks: [...older.backlinks, ...current.backlinks], events: [...older.events, ...current.events], taskIds: [...older.taskIds, ...current.taskIds], referenceErrors: [...(older.referenceErrors ?? []), ...(current.referenceErrors ?? [])] } : current);
            } finally { setPending(false); }
          }}>加载更早的引用、讨论和记录</button>}
          <details className="item-history"><summary>修改记录（{fresh?.events.length ?? 0}）</summary>{fresh?.events.slice().reverse().map(event => <p key={event.id}><strong>{event.actor.kind === 'user' ? '我' : event.actor.kind === 'external' ? '外部工具' : snapshot.nodes.find(node => node.id === event.actor.nodeId)?.name ?? '已归档节点'}</strong> · {({ create: '新建', edit: '编辑', move: '移动', archive: '归档', restore: '恢复', reopen: '重开', comment: '发表评论', register: '纳入文档', relink: '重新关联', external_edit: '外部修改', delete: '删除' } as Record<string, string>)[event.operation] ?? event.operation} · {new Date(event.at).toLocaleString()}{event.reason && <span> — {event.reason}</span>}</p>)}</details>
          {item.kind === 'document' ? !item.deletedAt && <div className="item-archive document-lifecycle">
            {item.archived ? <button type="button" className="button secondary" disabled={!canManage || conflicted} onClick={() => void mutate({ operation: 'restore', id: item.id, expected_revision: item.revision })}>取消归档</button>
              : <button type="button" className="text-button danger-button" disabled={!canManage || conflicted || draft!.path !== item.path} onClick={() => requestDocumentDeletion(item.id)}>删除文档</button>}
            {!item.archived && deleteTarget === item.id && fresh && <Dialog title="确认删除文档" onClose={() => { if (!pendingRef.current) setDeleteTarget(null); }}>
              <p>永久删除「{item.title}」及其文件？</p><p>{item.path}</p><p>已有引用仍可查看删除记录。</p>
              {(fresh.error || deleteError) && <p className="inline-error" role="alert">{fresh.error || deleteError}</p>}
              <div className="modal-actions">
                <button type="button" className="button secondary" disabled={pending} onClick={() => setDeleteTarget(null)}>取消</button>
                <button type="button" className="button secondary danger-button" disabled={!canManage || conflicted || draft!.path !== item.path || !!fresh.error} onClick={async () => {
                  if (await mutate({ operation: 'delete', id: item.id, expected_revision: item.revision, expected_hash: draft!.hash })) setDeleteTarget(null);
                }}>确认删除</button>
              </div>
            </Dialog>}
          </div> : item.archived && <div className="item-archive"><button type="button" className="button secondary" disabled={pending} onClick={async () => { await mutate({ operation: 'restore', id: item.id, expected_revision: item.revision }); }}>恢复子树</button></div>}
        </>}
      </>}
    </section>}{kind === 'document' && sidebar && <DocumentSplitHandle key={selectedId} scrollRef={detailRef} toolbarRef={documentToolbarRef} showScrollThumb={!!documentItem} onInsetChange={setContentInset} scrollLabel="滚动文档正文" label="调整大纲宽度" width={split.widths.outline} max={split.maxOutline} reverse onResize={width => split.resize('outline', width)} />}{kind === 'document' && sidebar && <aside className="document-sidebar" aria-label="大纲与引用" style={{ marginTop: contentInset }}><h2>大纲</h2>{headings.length ? <nav aria-label="文档大纲">{headings.map(heading => <button type="button" className="text-button" key={heading.id} style={{ paddingLeft: (heading.depth - 1) * 10 }} onClick={() => { const target = document.getElementById(heading.id); target?.scrollIntoView({ block: 'start' }); target?.focus({ preventScroll: true }); }}>{heading.text}</button>)}</nav> : <p>当前文档没有标题</p>}{links}</aside>}</div>
  </main>;
}
