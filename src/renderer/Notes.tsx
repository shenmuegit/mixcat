import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Handle, Position, ReactFlow, useNodesState, type Edge, type Node, type NodeProps, type ReactFlowInstance, type Viewport } from '@xyflow/react';
import type { AppCommand, AppReply } from '../shared/types';
import type { Note, NoteMutation, NotesSnapshot } from '../shared/notes';
import { DocumentEditorPane } from './DocumentEditorPane';
import { Dialog } from './Dialog';
import { DocumentSplitHandle } from './DocumentSplit';
import { createDocumentMedia } from './document-media';
import { useDocumentAutosave } from './document-autosave';
import { layoutNotes, noteMoveTarget, noteSubtree, type NoteMapItem, type NoteMoveGuide } from './notes-map';

type Execute = (command: AppCommand, actionId?: string) => Promise<AppReply | null>;
type Draft = { title: string; body: string; baseTitle: string; baseBody: string; source: Note };
type Confirmation = { title: string; message: string; label: string; danger: boolean; apply(): Promise<void> };
type CanvasState = { collapsed: string[]; positions: Record<string, { x: number; y: number }>; viewport?: Viewport; drawerWidth?: number };
type NoteNode = Node<{ note: Note; topic: NoteMapItem; collapsed: boolean; guide: boolean; disabled: boolean; add(id: string): void; fold(id: string): void }, 'note'>;
const canvasKey = 'mixcat.notes.canvas.v1';
const minNoteZoom = .000001, maxNoteZoom = 1.5;
const drawerCloseExclusions = '.notes-document-pane,.react-flow__node,.notes-context-menu,.notes-toolbar,.notes-search-results,.notes-error,.notes-orphan-drafts,.notes-map-actions,dialog';
const mediaNavigationMessage = '媒体正在插入，完成后可切换或新建笔记。';
const cleanDraft = (note: Note): Draft => ({ title: note.title, body: note.body, baseTitle: note.title, baseBody: note.body, source: note });
const isDirty = (draft: Draft) => draft.title !== draft.baseTitle || draft.body !== draft.baseBody;

function readCanvas(): CanvasState {
  try {
    const value = JSON.parse(localStorage.getItem(canvasKey) ?? 'null');
    if (!value || !Array.isArray(value.collapsed) || !value.positions) return { collapsed: [], positions: {} };
    const finitePoint = (point: any) => point && Number.isFinite(point.x) && Number.isFinite(point.y) && Math.abs(point.x) < 100000 && Math.abs(point.y) < 100000;
    return { collapsed: value.collapsed.filter((id: unknown) => typeof id === 'string'),
      positions: Object.fromEntries(Object.entries(value.positions).filter(([, point]) => finitePoint(point))) as CanvasState['positions'],
      drawerWidth: Number.isFinite(value.drawerWidth) && value.drawerWidth > 0 && value.drawerWidth <= 100000 ? value.drawerWidth : undefined,
      viewport: finitePoint(value.viewport) && Number.isFinite(value.viewport.zoom) && value.viewport.zoom > 0 ? { ...value.viewport, zoom: Math.max(minNoteZoom, Math.min(maxNoteZoom, value.viewport.zoom)) } : undefined };
  } catch { return { collapsed: [], positions: {} }; }
}

function NoteTopic({ data }: NodeProps<NoteNode>) {
  const { note, topic } = data;
  return <div className={`note-topic${data.guide ? ' is-guide' : ''}`} data-note-id={note.id} data-topic-kind={topic.kind} data-side={topic.side} style={{ '--topic-color': topic.color } as CSSProperties}>
    <Handle id="left-in" type="target" position={Position.Left} /><Handle id="left-out" type="source" position={Position.Left} />
    <strong title={note.title}>{note.title}</strong>
    <button type="button" className="note-topic-add nodrag nopan" aria-label={`在 ${note.title} 下新建笔记`} disabled={data.disabled} onClick={event => { event.stopPropagation(); data.add(note.id); }}>＋</button>
    {!!topic.descendants && <button type="button" className="note-topic-fold nodrag nopan" aria-expanded={!data.collapsed} aria-label={`${data.collapsed ? '展开' : '折叠'} ${note.title} 的 ${topic.descendants} 个后代笔记`} disabled={data.disabled} onClick={event => { event.stopPropagation(); data.fold(note.id); }}>{data.collapsed ? topic.descendants : '−'}</button>}
    <Handle id="right-in" type="target" position={Position.Right} /><Handle id="right-out" type="source" position={Position.Right} />
  </div>;
}
const nodeTypes = { note: NoteTopic };

export function Notes({ active, execute }: { active: boolean; execute: Execute }) {
  const executor = useRef(execute); executor.current = execute;
  const [book, setBook] = useState<NotesSnapshot>({ revision: 0, notes: [] }), bookRef = useRef(book); bookRef.current = book;
  const [loaded, setLoaded] = useState(false), [pending, setPending] = useState(false), pendingRef = useRef(false);
  const savingNote = useRef(false);
  const [error, setError] = useState(''), [status, setStatus] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null), [openedId, setOpenedId] = useState<string | null>(null);
  const navigationRevision = useRef(0);
  const [closeRequested, setCloseRequested] = useState<string | null>(null);
  const importingMedia = useRef(new Map<string, number>()), [mediaRevision, setMediaRevision] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({}), draftsRef = useRef(drafts); draftsRef.current = drafts;
  const [editing, setEditing] = useState(new Set<string>());
  const [search, setSearch] = useState('');
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null), menuTrigger = useRef<HTMLElement | null>(null), workspace = useRef<HTMLElement>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null), confirmationRef = useRef<Confirmation | null>(null);
  const confirmationTrigger = useRef<HTMLElement | null>(null), cancelButton = useRef<HTMLButtonElement>(null), confirmationDescription = useId();
  const activeRef = useRef(active); activeRef.current = active;
  const drawerPress = useRef<{ id: string; pointerId: number; x: number; y: number; at: number } | null>(null);
  const [canvas, setCanvas] = useState(readCanvas), canvasRef = useRef(canvas); canvasRef.current = canvas;
  const bodyRef = useRef<HTMLDivElement>(null), [bodyWidth, setBodyWidth] = useState(0);
  const viewportWidth = typeof window === 'undefined' ? 0 : window.innerWidth;
  const narrowDrawer = viewportWidth > 0 && viewportWidth <= 900;
  const maxDrawerWidth = bodyWidth ? Math.max(0, bodyWidth - (narrowDrawer ? 0 : 96)) : 1050;
  const minDrawerWidth = Math.min(500, maxDrawerWidth);
  const drawerWidth = Math.round(narrowDrawer ? maxDrawerWidth : Math.max(minDrawerWidth, Math.min(maxDrawerWidth, canvas.drawerWidth ?? Math.max(750, Math.min(1050, viewportWidth * .66)))));
  const [flow, setFlow] = useState<ReactFlowInstance<NoteNode> | null>(null), initialView = useRef(false);
  const [guide, setGuide] = useState<NoteMoveGuide | null>(null), guideRef = useRef<NoteMoveGuide | null>(null);
  const drag = useRef<{ id: string; start: { x: number; y: number }; positions: Map<string, { x: number; y: number }>; ids: Set<string> } | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<NoteNode>([]);
  const nodeSizes = nodes.map(node => `${node.id}:${node.measured?.width}:${node.measured?.height}`).join(',');
  const visibleNotes = book.notes.filter(note => !note.deletedAt), source = book.notes.find(note => note.id === openedId);
  const pendingCurrentMedia = !!openedId && importingMedia.current.has(openedId);
  const missingSource = !!openedId && !source && !!drafts[openedId] && (isDirty(drafts[openedId]) || pendingCurrentMedia);
  const opened = source ?? (missingSource ? drafts[openedId!].source : undefined);
  const orphanDrafts = Object.entries(drafts).filter(([id, value]) => isDirty(value) && !book.notes.some(note => note.id === id));
  const draft = opened ? drafts[opened.id] ?? cleanDraft(opened) : undefined;
  const dirty = Object.values(drafts).some(isDirty), isEditing = !!opened && editing.has(opened.id) && !opened.deletedAt && (!missingSource || pendingCurrentMedia);
  const conflicted = !missingSource && !!opened && !!draft && isDirty(draft) && (opened.title !== draft.baseTitle || opened.body !== draft.baseBody);
  const media = useMemo(() => createDocumentMedia({ kind: 'notes' }), []);
  const map = useMemo(() => layoutNotes(book.notes, new Set(canvas.collapsed), nodes), [book.notes, canvas.collapsed, nodeSizes]);
  const matched = search.trim() ? visibleNotes.filter(note => `${note.title}\n${note.body}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) : [];
  const dirtyCount = Object.values(drafts).filter(isDirty).length;
  const autosave = useDocumentAutosave(Object.entries(drafts).filter(([id, value]) => {
    const note = book.notes.find(note => note.id === id);
    return note && !note.deletedAt && isDirty(value) && value.title.trim() && note.title === value.baseTitle && note.body === value.baseBody;
  }).map(([id, value]) => ({ id, fingerprint: JSON.stringify(value) })), !loaded || pending || !!confirmation, save);
  const unsaved = dirty || autosave.savingId !== null || pending && savingNote.current || importingMedia.current.size > 0;

  const reload = useCallback(async () => {
    try {
      const reply = await executor.current({ type: 'get_notes' });
      if (!reply?.notes) { setError('读取笔记失败，请重试。'); return false; }
      if (reply.notes.revision >= bookRef.current.revision) { bookRef.current = reply.notes; setBook(reply.notes); }
      setLoaded(true); return true;
    } catch (caught) { setError(`读取笔记失败：${caught instanceof Error ? caught.message : String(caught)}`); return false; }
  }, []);
  useEffect(() => {
    if (!closeRequested || pending || confirmation || menu || autosave.savingId !== null || importingMedia.current.has(closeRequested)) return;
    if (missingSource && draft && isDirty(draft)) { setCloseRequested(null); return; }
    if (active && opened?.id === closeRequested && !conflicted && !(draft && isDirty(draft) && autosave.failed)) void returnToMap();
    else setCloseRequested(null);
  }, [closeRequested, pending, confirmation, menu, autosave.savingId, autosave.failed, active, opened, conflicted, draft, missingSource, mediaRevision]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (!active || !opened || event.key !== 'Escape' || event.defaultPrevented || event.isComposing || confirmationRef.current || menu
        || document.querySelector('dialog[open]') || workspace.current?.querySelector('.cm-tooltip-autocomplete')) return;
      event.preventDefault(); event.stopPropagation(); void returnToMap();
    };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  });
  useEffect(() => { if (active) void reload(); }, [active, reload]);
  useEffect(() => { if (loaded && openedId && !opened) { setOpenedId(null); setCloseRequested(null); } }, [loaded, openedId, opened]);
  useEffect(() => { if (!active) { confirmationRef.current = null; setConfirmation(null); drawerPress.current = null; } }, [active]);
  useEffect(() => { if (!active || pending || openedId) cancelDrag(); }, [active, pending, openedId]);
  useEffect(() => {
    const cancel = () => cancelDrag();
    window.addEventListener('blur', cancel); window.addEventListener('pointercancel', cancel, true);
    return () => { window.removeEventListener('blur', cancel); window.removeEventListener('pointercancel', cancel, true); drag.current = null; guideRef.current = null; };
  }, [flow]);
  useLayoutEffect(() => {
    const body = bodyRef.current; if (!body) return;
    const update = () => setBodyWidth(body.clientWidth);
    const observer = new ResizeObserver(update); observer.observe(body); update();
    return () => observer.disconnect();
  }, [loaded]);
  useEffect(() => { if (!active || pending || menu && !book.notes.some(note => note.id === menu.id && !note.deletedAt)) setMenu(null); }, [active, pending, book.notes, menu]);
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as HTMLElement)) setMenu(null); };
    const close = () => setMenu(null);
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setMenu(null); menuTrigger.current?.focus({ preventScroll: true }); }
      else if (event.key === 'Tab') setMenu(null);
      else if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) && menuRef.current?.contains(event.target as HTMLElement)) {
        event.preventDefault();
        const buttons = [...menuRef.current.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')], index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length]?.focus();
      }
    };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', key);
    window.addEventListener('resize', close); window.addEventListener('blur', close); window.addEventListener('scroll', close, true);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key); window.removeEventListener('resize', close); window.removeEventListener('blur', close); window.removeEventListener('scroll', close, true); };
  }, [menu]);
  function showMenu(id: string, x: number, y: number, trigger: HTMLElement) {
    if (pendingRef.current || confirmationRef.current || !active || !bookRef.current.notes.some(note => note.id === id && !note.deletedAt)) return;
    menuTrigger.current = trigger; setSelectedId(id); setMenu({ id, x, y });
  }
  useEffect(() => {
    setDrafts(current => {
      let next = current;
      for (const [id, value] of Object.entries(current)) {
        const fresh = book.notes.find(note => note.id === id);
        if (fresh && !isDirty(value) && (fresh.title !== value.title || fresh.body !== value.body)) { if (next === current) next = { ...current }; next[id] = cleanDraft(fresh); }
      }
      return next;
    });
  }, [book.notes]);
  useEffect(() => {
    if (!loaded) return;
    try { localStorage.setItem(canvasKey, JSON.stringify(canvas)); }
    catch { setError('脑图视图保存失败。请检查工作台存储空间。'); }
  }, [canvas, loaded]);
  useEffect(() => {
    void window.mixcat?.setUnsaved?.('notes', unsaved).catch(caught => setError(String(caught)));
    const guard = (event: BeforeUnloadEvent) => { if (unsaved) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', guard);
    return () => { window.removeEventListener('beforeunload', guard); void window.mixcat?.setUnsaved?.('notes', false); };
  }, [unsaved]);
  useEffect(() => { if (active && flow) requestAnimationFrame(() => { if (canvasRef.current.viewport) void flow.setViewport(canvasRef.current.viewport); }); }, [active, flow]);
  useEffect(() => {
    if (!flow || !loaded || !nodes.length || nodes.some(node => !node.measured?.width || !node.measured?.height) || initialView.current) return;
    initialView.current = true;
    requestAnimationFrame(() => { if (canvasRef.current.viewport) void flow.setViewport(canvasRef.current.viewport); else void flow.fitView({ padding: .15, maxZoom: 1 }); });
  }, [flow, loaded, nodes.length, nodeSizes]);

  async function mutate(input: Omit<NoteMutation, 'request_id' | 'expected_revision'>) {
    if (pendingRef.current) return null;
    pendingRef.current = true; setPending(true); setError(''); setStatus('');
    try {
      const reply = await executor.current({ type: 'update_note', input: { ...input, request_id: crypto.randomUUID(), expected_revision: bookRef.current.revision } });
      if (!reply?.notes) { setError('操作未完成，草稿已保留。刷新后可核对最新内容。'); await reload(); return null; }
      if (reply.notes.revision >= bookRef.current.revision) { bookRef.current = reply.notes; setBook(reply.notes); }
      return reply;
    } catch (caught) {
      setError(`操作未完成，草稿已保留：${caught instanceof Error ? caught.message : String(caught)}`); await reload(); return null;
    } finally { pendingRef.current = false; setPending(false); }
  }
  function updateDraft(id: string, change: Partial<Pick<Draft, 'title' | 'body'>>) {
    const note = bookRef.current.notes.find(note => note.id === id) ?? draftsRef.current[id]?.source; if (!note) return;
    setDrafts(current => ({ ...current, [id]: { ...(current[id] ?? cleanDraft(note)), ...change } })); setStatus('');
  }
  async function save(id: string): Promise<boolean> {
    const note = bookRef.current.notes.find(note => note.id === id), value = draftsRef.current[id];
    if (!note || note.deletedAt || pendingRef.current) return false;
    if (!value || !isDirty(value)) return true;
    if (!value.title.trim()) { setError('请填写标题，草稿已保留。'); return false; }
    if (note.title !== value.baseTitle || note.body !== value.baseBody) { setError('这份笔记已有其他修改。请核对最新内容后合并草稿。'); return false; }
    savingNote.current = true;
    try {
      const reply = await mutate({ operation: 'edit', id, title: value.title, body: value.body });
      const saved = reply?.notes?.notes.find(item => item.id === id); if (!saved) return false;
      const current = draftsRef.current, latest = current[id];
      if (latest) {
        const next = { ...current, [id]: { title: latest.title === value.title ? saved.title : latest.title, body: latest.body === value.body ? saved.body : latest.body, baseTitle: saved.title, baseBody: saved.body, source: saved } };
        // A close/retry can arrive before React commits the saved baseline.
        draftsRef.current = next; setDrafts(next);
      }
      setStatus('已保存'); return true;
    } finally { savingNote.current = false; }
  }
  async function toggleMode() {
    if (!opened || pendingRef.current || blockMediaNavigation()) return;
    const id = opened.id, navigation = navigationRevision.current;
    if (isEditing && !await save(id)) return;
    if (navigation !== navigationRevision.current) return;
    if (blockMediaNavigation()) return;
    setEditing(current => { const next = new Set(current); isEditing ? next.delete(id) : next.add(id); return next; });
  }
  async function add(parentId: string | null = null, beforeId?: string | null) {
    if (blockMediaNavigation()) return;
    const reply = await mutate({ operation: 'create', title: '新笔记', body: '', parentId, ...(beforeId ? { beforeId } : {}) });
    if (!reply?.noteId) return;
    navigationRevision.current++;
    const id = reply.noteId; setSelectedId(id); setOpenedId(id); setEditing(current => new Set(current).add(id));
    if (parentId) setCanvas(current => ({ ...current, collapsed: current.collapsed.filter(item => item !== parentId) }));
    requestAnimationFrame(() => workspace.current?.querySelector<HTMLInputElement>(`[data-content-identity="note:${id}"] .document-title`)?.focus());
  }
  function open(id: string, edit = false) {
    if (blockMediaNavigation()) return;
    if (pendingRef.current && !savingNote.current) return;
    navigationRevision.current++;
    setCloseRequested(null);
    setSelectedId(id); setOpenedId(id); setError(''); setStatus('');
    if (edit) setEditing(current => new Set(current).add(id));
  }
  async function returnToMap() {
    const id = opened?.id, navigation = navigationRevision.current;
    if (id && importingMedia.current.has(id)) { setCloseRequested(id); return; }
    if (pendingRef.current) { if (savingNote.current && id) setCloseRequested(id); return; }
    setCloseRequested(null);
    if (opened && isEditing && !await save(opened.id)) return;
    if (navigation !== navigationRevision.current) return;
    if (id && (importingMedia.current.has(id) || isEditing && draftsRef.current[id] && isDirty(draftsRef.current[id]))) { setCloseRequested(id); return; }
    navigationRevision.current++; setOpenedId(current => current === id ? null : current);
    if (id) setEditing(current => { const next = new Set(current); next.delete(id); return next; });
  }
  async function importNoteMedia<T>(note: Note, operation: () => Promise<T>): Promise<T> {
    const id = note.id;
    if (!draftsRef.current[id]) { const next = { ...draftsRef.current, [id]: cleanDraft(note) }; draftsRef.current = next; setDrafts(next); }
    importingMedia.current.set(id, (importingMedia.current.get(id) ?? 0) + 1); setMediaRevision(value => value + 1);
    try { return await operation(); }
    catch (caught) { setCloseRequested(current => current === id ? null : current); throw caught; }
    finally {
      // Let the shared editor insert the returned media before a queued close.
      requestAnimationFrame(() => {
        const remaining = (importingMedia.current.get(id) ?? 1) - 1;
        if (remaining) importingMedia.current.set(id, remaining); else importingMedia.current.delete(id);
        if (!remaining) setError(current => current === mediaNavigationMessage ? '' : current);
        setMediaRevision(value => value + 1);
      });
    }
  }
  function blockMediaNavigation() {
    if (!opened || !importingMedia.current.has(opened.id)) return false;
    setError(mediaNavigationMessage); return true;
  }
  function fold(id: string) { setCanvas(current => ({ ...current, collapsed: current.collapsed.includes(id) ? current.collapsed.filter(item => item !== id) : [...current.collapsed, id] })); }
  function reveal(id: string) {
    const ancestors = new Set<string>(); let item = bookRef.current.notes.find(note => note.id === id);
    while (item?.parentId && !ancestors.has(item.parentId)) { ancestors.add(item.parentId); item = bookRef.current.notes.find(note => note.id === item!.parentId); }
    setCanvas(current => ({ ...current, collapsed: current.collapsed.filter(item => !ancestors.has(item)) })); setSelectedId(id);
    requestAnimationFrame(() => { const item = flow?.getNode(id), position = item?.position ?? canvasRef.current.positions[id] ?? layoutNotes(bookRef.current.notes, new Set()).find(item => item.id === id)?.position; if (position) void flow?.setCenter(position.x + (item?.measured?.width ?? 180) / 2, position.y + 25, { zoom: Math.max(flow.getZoom(), .8), duration: 200 }); });
  }
  function confirm(request: Confirmation) {
    if (pendingRef.current || confirmationRef.current || !activeRef.current) return;
    confirmationTrigger.current = document.activeElement as HTMLElement;
    confirmationRef.current = request; setConfirmation(request);
  }
  function finishConfirmation(accepted = false) {
    const request = confirmationRef.current; if (!request) return;
    confirmationRef.current = null; setConfirmation(null);
    if (accepted) void request.apply();
    requestAnimationFrame(() => {
      if (!activeRef.current || confirmationRef.current) return;
      const fallback = workspace.current?.querySelector<HTMLElement>('[aria-label=搜索笔记]'), trigger = accepted ? fallback : confirmationTrigger.current;
      (trigger?.isConnected && !trigger.closest('[hidden]') && !trigger.matches(':disabled') ? trigger : fallback)?.focus({ preventScroll: true });
    });
  }
  function confirmDraft(action: 'discard' | 'load' | 'merge') {
    if (!opened || !draft) return;
    const note = opened, value = draftsRef.current[note.id], revision = bookRef.current.revision;
    const title = action === 'discard' ? '放弃草稿' : action === 'load' ? '载入最新内容' : '确认合并';
    confirm({ title, label: action === 'merge' ? '继续编辑' : title, danger: action !== 'merge',
      message: action === 'discard' ? '放弃当前笔记草稿？' : action === 'load' ? '放弃当前草稿并读取最新内容？' : '确认已经核对最新内容并合并到当前草稿？',
      apply: async () => {
        if (pendingRef.current) return;
        pendingRef.current = true; setPending(true); setError('');
        try {
          if (!await reload()) return;
          if (bookRef.current.revision !== revision || draftsRef.current[note.id] !== value) { setError('笔记或草稿已变化，请核对最新内容后重新确认。'); return; }
          if (action === 'discard' && !bookRef.current.notes.some(item => item.id === note.id)) {
            setDrafts(current => Object.fromEntries(Object.entries(current).filter(([id]) => id !== note.id))); setOpenedId(null); return;
          }
          setDrafts(current => ({ ...current, [note.id]: action === 'merge' ? { ...value, baseTitle: note.title, baseBody: note.body, source: note } : cleanDraft(note) })); setStatus('');
        } finally { pendingRef.current = false; setPending(false); }
      } });
  }
  function deleteNote(id: string) {
    const note = bookRef.current.notes.find(note => note.id === id); if (!note || note.deletedAt) return;
    const revision = bookRef.current.revision;
    const subtree = noteSubtree(bookRef.current.notes, id);
    const branchDrafts = new Map([...subtree].map(child => [child, draftsRef.current[child]]));
    const dirtyInBranch = [...subtree].some(child => draftsRef.current[child] && isDirty(draftsRef.current[child]));
    confirm({ title: '删除笔记', label: '永久删除', danger: true,
      message: `永久删除「${note.title}」${subtree.size > 1 ? `及其 ${subtree.size - 1} 个后代笔记` : ''}？此操作无法撤销。${dirtyInBranch ? '其中有未保存草稿，确认后将放弃这些草稿。' : ''}`,
      apply: async () => {
        if (bookRef.current.revision !== revision || [...subtree].some(child => draftsRef.current[child] !== branchDrafts.get(child))) { setError('笔记或草稿已变化，请核对删除范围后重新确认。'); return; }
        if (!await mutate({ operation: 'delete', id })) return;
        setCanvas(current => ({ ...current, positions: Object.fromEntries(Object.entries(current.positions).filter(([key]) => !subtree.has(key))), collapsed: current.collapsed.filter(key => !subtree.has(key)) }));
        setDrafts(current => Object.fromEntries(Object.entries(current).filter(([key, value]) => !subtree.has(key) || value !== branchDrafts.get(key))));
        if ([...subtree].some(child => draftsRef.current[child] !== branchDrafts.get(child))) setError('删除期间有新草稿，已保留在当前窗口，请先复制内容。');
        if (openedId && subtree.has(openedId) && draftsRef.current[openedId] === branchDrafts.get(openedId)) setOpenedId(null);
        if (selectedId && subtree.has(selectedId)) setSelectedId(note.parentId);
        requestAnimationFrame(() => { if (activeRef.current && !confirmationRef.current) (workspace.current?.querySelector<HTMLElement>(`.react-flow__node[data-id="${note.parentId}"]`) ?? workspace.current?.querySelector<HTMLElement>('[aria-label=搜索笔记]'))?.focus({ preventScroll: true }); });
      } });
  }
  async function move(id: string, parentId: string | null, beforeId?: string | null) {
    const reply = await mutate({ operation: 'move', id, parentId, beforeId });
    if (reply && parentId) setCanvas(current => ({ ...current, collapsed: current.collapsed.filter(item => item !== parentId) }));
  }
  const actions = useRef({ add, fold }); actions.current = { add, fold };
  useEffect(() => {
    const byId = new Map(visibleNotes.map(note => [note.id, note]));
    setNodes(previous => { const moving = new Map(previous.map(item => [item.id, item])); return map.map(topic => ({ ...moving.get(topic.id), id: topic.id, type: 'note', position: drag.current && moving.get(topic.id)?.position || canvas.positions[topic.id] || topic.position, initialWidth: topic.width, initialHeight: topic.height, selected: topic.id === selectedId,
      ariaLabel: `笔记 ${byId.get(topic.id)!.title}`, data: { note: byId.get(topic.id)!, topic, collapsed: canvas.collapsed.includes(topic.id), guide: guide?.parentId === topic.id || guide?.childId === topic.id, disabled: pending,
        add: id => void actions.current.add(id), fold: id => actions.current.fold(id) } })); });
  }, [map, canvas.positions, canvas.collapsed, selectedId, guide, pending, setNodes]);
  const edges: Edge[] = useMemo(() => {
    const byId = new Map(nodes.map(item => [item.id, item]));
    const centerX = (node: NoteNode) => node.position.x + (node.measured?.width ?? node.width ?? node.initialWidth ?? 160) / 2;
    const hierarchy: Edge[] = map.filter(item => item.parentId && byId.has(item.parentId) && byId.has(item.id)).map(item => {
      const side = centerX(byId.get(item.id)!) < centerX(byId.get(item.parentId!)!) ? 'left' : 'right';
      return { id: `tree:${item.id}`, source: item.parentId!, target: item.id, sourceHandle: `${side}-out`, targetHandle: `${side === 'left' ? 'right' : 'left'}-in`, type: 'default', style: { stroke: item.color, strokeWidth: item.kind === 'main' ? 2 : 1.5 }, selectable: false };
    });
    for (const note of visibleNotes) for (const target of note.relatedIds) if (note.id < target && byId.has(note.id) && byId.has(target)) hierarchy.push({ id: `related:${note.id}:${target}`, source: note.id, target, sourceHandle: 'right-out', targetHandle: 'left-in', type: 'default', className: 'note-association-edge', style: { stroke: '#a8aca8', strokeDasharray: '5 5', opacity: selectedId === note.id || selectedId === target ? 1 : .45 }, selectable: false });
    if (guide && byId.has(guide.parentId) && byId.has(guide.childId)) hierarchy.push({ id: `reparent-guide:${guide.parentId}:${guide.childId}`, source: guide.parentId, target: guide.childId, sourceHandle: `${guide.side}-out`, targetHandle: `${guide.side === 'left' ? 'right' : 'left'}-in`, type: 'default', className: 'note-reparent-guide', animated: true, style: { stroke: '#ea580c', strokeWidth: 3, strokeDasharray: '6 4' }, zIndex: 1, selectable: false });
    return hierarchy;
  }, [map, nodes, book.notes, selectedId, guide]);
  function dragStart(node: NoteNode) {
    if (pendingRef.current || openedId || !activeRef.current) return;
    const complete = layoutNotes(visibleNotes, new Set(), flow?.getNodes() ?? nodes), natural = new Map(complete.map(item => [item.id, item.position]));
    const positions = new Map(Object.entries(canvasRef.current.positions).map(([id, position]) => [id, { ...position }]));
    for (const item of flow?.getNodes() ?? nodes) positions.set(item.id, { ...item.position });
    for (const item of complete) {
      if (positions.has(item.id)) continue;
      const parent = item.parentId ? positions.get(item.parentId) : undefined, originalParent = item.parentId ? natural.get(item.parentId) : undefined;
      positions.set(item.id, { x: item.position.x + (parent && originalParent ? parent.x - originalParent.x : 0), y: item.position.y + (parent && originalParent ? parent.y - originalParent.y : 0) });
    }
    drag.current = { id: node.id, start: { ...positions.get(node.id)! }, positions, ids: noteSubtree(visibleNotes, node.id) };
    guideRef.current = null; setGuide(null); setSelectedId(node.id);
  }
  function dragMove(node: NoteNode) {
    const origin = drag.current; if (!origin || origin.id !== node.id) return;
    const delta = { x: node.position.x - origin.start.x, y: node.position.y - origin.start.y };
    setNodes(current => current.map(item => origin.ids.has(item.id) && item.id !== node.id ? { ...item, position: { x: origin.positions.get(item.id)!.x + delta.x, y: origin.positions.get(item.id)!.y + delta.y } } : item));
    const next = noteMoveTarget(bookRef.current.notes, node, flow?.getNodes() ?? nodes, flow?.getZoom() ?? 1);
    guideRef.current = next;
    setGuide(current => current?.parentId === next?.parentId && current?.childId === next?.childId && current?.side === next?.side ? current : next);
  }
  function keepDragPosition(node: NoteNode) {
    const origin = drag.current; if (!origin || origin.id !== node.id) return;
    const delta = { x: node.position.x - origin.start.x, y: node.position.y - origin.start.y };
    const positions = Object.fromEntries([...origin.positions].map(([id, point]) => [id, origin.ids.has(id) ? { x: point.x + delta.x, y: point.y + delta.y } : point]));
    setCanvas(current => ({ ...current, positions: { ...current.positions, ...positions } }));
  }
  function cancelDrag() {
    const origin = drag.current;
    if (origin) { const node = flow?.getNode(origin.id); if (node) keepDragPosition(node); }
    drag.current = null; guideRef.current = null; setGuide(null);
    // End D3's window gesture and auto-pan after clearing the business drag callback.
    if (origin) window.dispatchEvent(new MouseEvent('mouseup', { view: window, button: 0, buttons: 0, cancelable: true }));
  }
  async function dragStop(node: NoteNode) {
    const origin = drag.current; if (!origin || origin.id !== node.id) return;
    const target = noteMoveTarget(bookRef.current.notes, node, flow?.getNodes() ?? nodes, flow?.getZoom() ?? 1);
    keepDragPosition(node); drag.current = null; guideRef.current = null; setGuide(null);
    if (target && activeRef.current && !pendingRef.current) await move(node.id, target.parentId);
  }
  function drawerPointerDown(event: React.PointerEvent) {
    drawerPress.current = null;
    if (!opened || confirmationRef.current || menu || !event.isPrimary || event.button !== 0
      || (event.target as Element).closest(drawerCloseExclusions)) return;
    drawerPress.current = { id: opened.id, pointerId: event.pointerId, x: event.clientX, y: event.clientY, at: event.timeStamp };
  }
  function drawerPointerUp(event: React.PointerEvent) {
    const press = drawerPress.current; drawerPress.current = null;
    if (!press || press.id !== opened?.id || !activeRef.current || confirmationRef.current || menu
      || event.pointerId !== press.pointerId || event.button !== 0 || event.timeStamp < press.at || event.timeStamp - press.at > 250
      || Math.hypot(event.clientX - press.x, event.clientY - press.y) > 6
      || (event.target as Element).closest(drawerCloseExclusions)) return;
    void returnToMap();
  }
  function keyboard(event: React.KeyboardEvent) {
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    if (confirmationRef.current) { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') event.preventDefault(); return; }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && opened) { event.preventDefault(); autosave.retry(); return; }
    if (pendingRef.current) return;
    const target = event.target as HTMLElement;
    const nodeElement = target.closest<HTMLElement>('.react-flow__node');
    if (nodeElement && (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10')) {
      event.preventDefault(); event.stopPropagation(); const rect = nodeElement.getBoundingClientRect();
      showMenu(nodeElement.dataset.id!, rect.left + rect.width / 2, rect.top + rect.height / 2, nodeElement); return;
    }
    if (target.closest('input,textarea,select,button,[contenteditable=true]') || !target.closest('.react-flow') || openedId) return;
    const focusedId = target.closest('.react-flow__node')?.getAttribute('data-id');
    const current = visibleNotes.find(note => note.id === (focusedId ?? selectedId));
    if (event.key === 'Tab' && current) { event.preventDefault(); void add(current.id); }
    else if (event.key === 'Enter' && current) { event.preventDefault(); event.ctrlKey ? open(current.id) : void add(current.parentId); }
    else if (event.key === 'F2' && current) { event.preventDefault(); open(current.id, true); }
    else if (event.key === 'Delete' && current) { event.preventDefault(); void deleteNote(current.id); }
  }

  return <main ref={workspace} className={`notes-workspace${opened ? ' has-document' : ''}`} aria-label="笔记工作区" onKeyDown={keyboard}
    onPointerDownCapture={drawerPointerDown} onPointerUpCapture={drawerPointerUp} onPointerCancelCapture={() => { drawerPress.current = null; }}>
    <header className="notes-toolbar"><div className="notes-search"><input aria-label="搜索笔记" placeholder="搜索笔记" value={search} onChange={event => setSearch(event.target.value)} />{search && <button type="button" className="icon-button" aria-label="清除笔记搜索" onClick={() => setSearch('')}>×</button>}</div>{dirtyCount > 0 && <span className="draft-indicator">{dirtyCount} 份草稿</span>}</header>
    {error && <div className="notes-error" role="alert">{error}{autosave.failed && <button type="button" className="text-button" onClick={() => autosave.retry()}>重试</button>}<button type="button" className="text-button" onClick={() => setError('')}>关闭</button></div>}
    {orphanDrafts.length > 0 && <div className="notes-orphan-drafts" role="region" aria-label="已删除笔记的草稿"><p>原笔记已删除，未保存草稿仍可查看、复制或放弃。</p>{orphanDrafts.map(([id, value]) => <button key={id} type="button" className="text-button" onClick={() => open(id)}>{value.title.trim() || value.source.title}</button>)}</div>}
    {!loaded ? <p className="notes-loading" role="status">正在读取笔记…</p> : <div ref={bodyRef} className="notes-body">
      <section className="notes-map-pane" aria-label="笔记脑图" onContextMenu={event => event.preventDefault()}>
          <ReactFlow<NoteNode> nodes={nodes} edges={edges} nodeTypes={nodeTypes} onInit={setFlow} onNodesChange={onNodesChange} onMoveStart={() => setMenu(null)} onMoveEnd={(_, viewport) => setCanvas(current => ({ ...current, viewport }))} onNodeClick={(_, node) => { if (pending) return; openedId ? open(node.id) : setSelectedId(node.id); }} onNodeDoubleClick={(_, node) => open(node.id)} onNodeContextMenu={(event, node) => { event.preventDefault(); event.stopPropagation(); showMenu(node.id, event.clientX, event.clientY, (event.target as HTMLElement).closest<HTMLElement>('.react-flow__node')!); }} onNodeDragStart={(_, node) => dragStart(node)} onNodeDrag={(_, node) => dragMove(node)} onNodeDragStop={(_, node) => void dragStop(node)} onConnect={connection => { if (connection.source && connection.target) void mutate({ operation: 'associate', id: connection.source, targetId: connection.target, linked: true }); }} nodesDraggable={!pending && !openedId} nodesConnectable={!pending && !openedId} elementsSelectable={false} multiSelectionKeyCode={null} deleteKeyCode={null} nodeDragThreshold={6} nodeClickDistance={6} zoomOnDoubleClick={false} minZoom={minNoteZoom} maxZoom={maxNoteZoom} defaultViewport={canvas.viewport} proOptions={{ hideAttribution: true }} />
          {!visibleNotes.length && <div className="notes-empty"><h1>把想法连成自己的笔记</h1><p>从一份笔记开始，在脑图中展开、组织和连接内容。</p><button type="button" className="button primary" disabled={pending} onClick={() => void add(null)}>新建第一份笔记</button></div>}
          {search.trim() && <div className="notes-search-results" role="region" aria-label="笔记搜索结果"><strong>{matched.length} 个结果</strong>{matched.length ? matched.map(note => <button type="button" key={note.id} onClick={() => { reveal(note.id); open(note.id); }}><span>{note.title}</span><small>{note.body.replace(/[#*_`\[\]]/g, '').slice(0, 80)}</small></button>) : <p>没有匹配的笔记</p>}</div>}
          <div className="notes-map-actions"><button type="button" className="text-button" disabled={pending || !visibleNotes.length} onClick={() => { setCanvas(current => ({ ...current, positions: {} })); requestAnimationFrame(() => void flow?.fitView({ padding: .15, maxZoom: 1 })); }}>整理脑图</button><button type="button" className="text-button" onClick={() => setCanvas(current => ({ ...current, collapsed: [] }))}>展开全部</button></div>
      </section>
      {opened && draft && <section className="notes-document-pane" aria-label="笔记内容" style={{ width: drawerWidth }}>
        <DocumentSplitHandle label="调整笔记抽屉宽度" width={drawerWidth} min={minDrawerWidth} max={maxDrawerWidth} reverse onResize={width => setCanvas(current => ({ ...current, drawerWidth: Math.round(Math.max(minDrawerWidth, Math.min(maxDrawerWidth, width))) }))} />
        <div className="notes-document-toolbar"><button type="button" className="text-button" disabled={pending} onClick={() => void returnToMap()}>← 脑图</button><span role="status">{importingMedia.current.has(opened.id) ? '正在插入媒体…' : autosave.savingId === opened.id ? '保存中…' : isDirty(draft) ? draft.title.trim() ? '未保存' : '请填写标题，草稿已保留' : status}{opened.deletedAt || missingSource ? ' · 已删除' : ''}</span>{!opened.deletedAt && !missingSource && <button type="button" className="text-button" disabled={pending || conflicted} onClick={() => void toggleMode()}>{isEditing ? '阅读' : '编辑'}</button>}</div>
        {conflicted && <div className="notes-conflict" role="alert"><strong>笔记已有其他修改，草稿已保留。</strong><details><summary>查看最新内容</summary><h3>{opened.title}</h3><pre>{opened.body}</pre></details><button type="button" className="text-button" onClick={() => confirmDraft('load')}>载入最新内容</button><button type="button" className="text-button" onClick={() => confirmDraft('merge')}>已合并，继续编辑</button></div>}
        <div className="notes-document-scroll"><DocumentEditorPane identity={`note:${opened.id}`} title={draft.title} content={draft.body} editing={isEditing} disabled={pending && !savingNote.current || !!opened.deletedAt} onTitleChange={title => updateDraft(opened.id, { title })} onContentChange={body => updateDraft(opened.id, { body })} titleLabel="笔记标题" bodyLabel="笔记正文" headingPrefix={`note-${opened.id}`} onComplete={async query => visibleNotes.filter(note => note.id !== opened.id && note.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())).slice(0, 20).map(note => ({ label: note.title, apply: `[${note.title.replace(/[\\[\]]/g, '\\$&')}](mixcat-note://${note.id}) ` }))} onOpenLink={href => { const match = /^mixcat-note:\/\/([A-Za-z0-9_-]+)\/?$/.exec(href); if (match && (bookRef.current.notes.some(note => note.id === match[1]) || draftsRef.current[match[1]] && isDirty(draftsRef.current[match[1]]))) open(match[1]); else if (/^https?:\/\//i.test(href)) void window.mixcat?.openExternal?.(href).catch(caught => setError(String(caught))); else setError('这个链接目前无法打开。'); }} resolveResource={media.resolveResource} onPasteImage={files => importNoteMedia(opened, () => media.importImages(files))} onInsertMedia={(files, address) => importNoteMedia(opened, () => media.importMedia(files, address))} />
          {isDirty(draft) && <button type="button" className="text-button" disabled={pending} onClick={() => confirmDraft('discard')}>放弃草稿</button>}
        </div>
      </section>}
    </div>}
    {menu && <div ref={menuRef} className="canvas-context-menu notes-context-menu" role="menu" aria-label="笔记操作" style={{ left: Math.max(8, Math.min(menu.x, window.innerWidth - 188)), top: Math.max(40, Math.min(menu.y, window.innerHeight - 100)) }}><button type="button" role="menuitem" disabled={pending} onClick={() => { const id = menu.id; setMenu(null); void add(id); }}>新建笔记</button><button type="button" role="menuitem" className="danger-button" disabled={pending} onClick={() => { const id = menu.id; setMenu(null); menuTrigger.current?.focus({ preventScroll: true }); void deleteNote(id); }}>删除</button></div>}
    {active && confirmation && <Dialog title={confirmation.title} descriptionId={confirmationDescription} initialFocus={cancelButton} onClose={() => finishConfirmation()}><div className="form-stack"><p id={confirmationDescription} className="notes-confirmation-copy">{confirmation.message}</p><div className="modal-actions"><button ref={cancelButton} type="button" className="button secondary" onClick={() => finishConfirmation()}>取消</button><button type="button" className={`button primary${confirmation.danger ? ' danger-button' : ''}`} onClick={() => finishConfirmation(true)}>{confirmation.label}</button></div></div></Dialog>}
  </main>;
}
