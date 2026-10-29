import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Background, BackgroundVariant, Controls, Handle, Position, ReactFlow, useNodesState, type Edge, type Node, type NodeProps, type ReactFlowInstance, type Viewport } from '@xyflow/react';
import type { AppCommand, AppReply } from '../shared/types';
import type { Note, NoteMutation, NotesSnapshot } from '../shared/notes';
import { DocumentEditorPane } from './DocumentEditorPane';
import { createDocumentMedia } from './document-media';
import { useDocumentAutosave } from './document-autosave';
import { layoutNotes, noteMoveTarget, noteSubtree, type NoteMapItem } from './notes-map';

type Execute = (command: AppCommand, actionId?: string) => Promise<AppReply | null>;
type Draft = { title: string; body: string; baseTitle: string; baseBody: string };
type CanvasState = { collapsed: string[]; positions: Record<string, { x: number; y: number }>; viewport?: Viewport };
type NoteNode = Node<{ note: Note; topic: NoteMapItem; collapsed: boolean; guide: boolean; disabled: boolean; add(id: string): void; fold(id: string): void }, 'note'>;
const canvasKey = 'mixcat.notes.canvas.v1';
const cleanDraft = (note: Note): Draft => ({ title: note.title, body: note.body, baseTitle: note.title, baseBody: note.body });
const isDirty = (draft: Draft) => draft.title !== draft.baseTitle || draft.body !== draft.baseBody;

function readCanvas(): CanvasState {
  try {
    const value = JSON.parse(localStorage.getItem(canvasKey) ?? 'null');
    if (!value || !Array.isArray(value.collapsed) || !value.positions) return { collapsed: [], positions: {} };
    const finitePoint = (point: any) => point && Number.isFinite(point.x) && Number.isFinite(point.y) && Math.abs(point.x) < 100000 && Math.abs(point.y) < 100000;
    return { collapsed: value.collapsed.filter((id: unknown) => typeof id === 'string'),
      positions: Object.fromEntries(Object.entries(value.positions).filter(([, point]) => finitePoint(point))) as CanvasState['positions'],
      viewport: finitePoint(value.viewport) && Number.isFinite(value.viewport.zoom) && value.viewport.zoom >= .05 && value.viewport.zoom <= 2 ? value.viewport : undefined };
  } catch { return { collapsed: [], positions: {} }; }
}

function NoteTopic({ data }: NodeProps<NoteNode>) {
  const { note, topic } = data;
  return <div className={`note-topic${data.guide ? ' is-guide' : ''}`} data-note-id={note.id} data-topic-kind={topic.kind} style={{ '--topic-color': topic.color } as CSSProperties}>
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
  const [drafts, setDrafts] = useState<Record<string, Draft>>({}), draftsRef = useRef(drafts); draftsRef.current = drafts;
  const [editing, setEditing] = useState(new Set<string>());
  const [search, setSearch] = useState(''), [trash, setTrash] = useState(false);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null), menuTrigger = useRef<HTMLElement | null>(null), workspace = useRef<HTMLElement>(null);
  const [canvas, setCanvas] = useState(readCanvas), canvasRef = useRef(canvas); canvasRef.current = canvas;
  const [flow, setFlow] = useState<ReactFlowInstance<NoteNode> | null>(null), initialView = useRef(false);
  const [guide, setGuide] = useState<string | null>(null), guideRef = useRef<string | null>(null);
  const drag = useRef<{ id: string; start: { x: number; y: number }; positions: Map<string, { x: number; y: number }>; ids: Set<string> } | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<NoteNode>([]);
  const visibleNotes = book.notes.filter(note => !note.deletedAt), opened = book.notes.find(note => note.id === openedId);
  const draft = opened ? drafts[opened.id] ?? cleanDraft(opened) : undefined;
  const dirty = Object.values(drafts).some(isDirty), isEditing = !!opened && editing.has(opened.id) && !opened.deletedAt;
  const conflicted = !!opened && !!draft && isDirty(draft) && (opened.title !== draft.baseTitle || opened.body !== draft.baseBody);
  const media = useMemo(() => createDocumentMedia({ kind: 'notes' }), []);
  const map = useMemo(() => layoutNotes(book.notes, new Set(canvas.collapsed)), [book.notes, canvas.collapsed]);
  const matched = search.trim() ? visibleNotes.filter(note => `${note.title}\n${note.body}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) : [];
  const dirtyCount = Object.values(drafts).filter(isDirty).length;
  const autosave = useDocumentAutosave(Object.entries(drafts).filter(([id, value]) => {
    const note = book.notes.find(note => note.id === id);
    return note && !note.deletedAt && isDirty(value) && value.title.trim() && note.title === value.baseTitle && note.body === value.baseBody;
  }).map(([id, value]) => ({ id, fingerprint: JSON.stringify(value) })), !loaded || pending, save);
  const unsaved = dirty || autosave.savingId !== null || pending && savingNote.current;

  const reload = useCallback(async () => {
    try {
      const reply = await executor.current({ type: 'get_notes' });
      if (!reply?.notes) { setError('读取笔记失败，请重试。'); return false; }
      if (reply.notes.revision >= bookRef.current.revision) { bookRef.current = reply.notes; setBook(reply.notes); }
      setLoaded(true); return true;
    } catch (caught) { setError(`读取笔记失败：${caught instanceof Error ? caught.message : String(caught)}`); return false; }
  }, []);
  useEffect(() => { if (active) void reload(); }, [active, reload]);
  useEffect(() => { if (!active || trash || pending || menu && !book.notes.some(note => note.id === menu.id && !note.deletedAt)) setMenu(null); }, [active, trash, pending, book.notes, menu]);
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
    if (pendingRef.current || !active || !bookRef.current.notes.some(note => note.id === id && !note.deletedAt)) return;
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
    if (!flow || !loaded || !nodes.length || initialView.current) return;
    initialView.current = true;
    requestAnimationFrame(() => { if (canvasRef.current.viewport) void flow.setViewport(canvasRef.current.viewport); else void flow.fitView({ padding: .25, maxZoom: 1 }); });
  }, [flow, loaded, nodes.length]);

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
    const note = bookRef.current.notes.find(note => note.id === id); if (!note) return;
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
      setDrafts(current => current[id] ? { ...current, [id]: { title: current[id].title === value.title ? saved.title : current[id].title, body: current[id].body === value.body ? saved.body : current[id].body, baseTitle: saved.title, baseBody: saved.body } } : current);
      setStatus('已保存'); return true;
    } finally { savingNote.current = false; }
  }
  async function toggleMode() {
    if (!opened || pendingRef.current) return;
    const id = opened.id;
    if (isEditing && !await save(id)) return;
    setEditing(current => { const next = new Set(current); isEditing ? next.delete(id) : next.add(id); return next; });
  }
  async function add(parentId: string | null = null, beforeId?: string | null) {
    const reply = await mutate({ operation: 'create', title: '新笔记', body: '', parentId, ...(beforeId ? { beforeId } : {}) });
    if (!reply?.noteId) return;
    const id = reply.noteId; setSelectedId(id); setOpenedId(id); setTrash(false); setEditing(current => new Set(current).add(id));
    if (parentId) setCanvas(current => ({ ...current, collapsed: current.collapsed.filter(item => item !== parentId) }));
    requestAnimationFrame(() => workspace.current?.querySelector<HTMLInputElement>(`[data-content-identity="note:${id}"] .document-title`)?.focus());
  }
  function open(id: string, edit = false) {
    if (pendingRef.current && !savingNote.current) return;
    setSelectedId(id); setOpenedId(id); setError(''); setStatus('');
    if (edit) setEditing(current => new Set(current).add(id));
  }
  async function returnToMap() {
    if (pendingRef.current || opened && isEditing && !await save(opened.id)) return;
    setOpenedId(null);
  }
  function fold(id: string) { setCanvas(current => ({ ...current, collapsed: current.collapsed.includes(id) ? current.collapsed.filter(item => item !== id) : [...current.collapsed, id] })); }
  function reveal(id: string) {
    const ancestors = new Set<string>(); let item = bookRef.current.notes.find(note => note.id === id);
    while (item?.parentId && !ancestors.has(item.parentId)) { ancestors.add(item.parentId); item = bookRef.current.notes.find(note => note.id === item!.parentId); }
    setCanvas(current => ({ ...current, collapsed: current.collapsed.filter(item => !ancestors.has(item)) })); setSelectedId(id);
    requestAnimationFrame(() => { const item = flow?.getNode(id), position = item?.position ?? canvasRef.current.positions[id] ?? layoutNotes(bookRef.current.notes, new Set()).find(item => item.id === id)?.position; if (position) void flow?.setCenter(position.x + (item?.measured?.width ?? 180) / 2, position.y + 25, { zoom: Math.max(flow.getZoom(), .8), duration: 200 }); });
  }
  async function recycle(id: string) {
    const note = bookRef.current.notes.find(note => note.id === id); if (!note) return;
    const subtree = noteSubtree(bookRef.current.notes.filter(item => !item.deletedAt), id);
    const dirtyInBranch = [...subtree].some(child => draftsRef.current[child] && isDirty(draftsRef.current[child]));
    if (!window.confirm(`将「${note.title}」及其 ${subtree.size - 1} 个后代笔记移入回收站？${dirtyInBranch ? '其中有未保存草稿，确认后将放弃这些草稿。' : ''}`)) return;
    if (!await mutate({ operation: 'delete', id })) return;
    setDrafts(current => Object.fromEntries(Object.entries(current).filter(([key]) => !subtree.has(key))));
    if (openedId && subtree.has(openedId)) setOpenedId(null);
    if (selectedId && subtree.has(selectedId)) setSelectedId(note.parentId);
  }
  async function move(id: string, parentId: string | null, beforeId?: string | null) {
    const reply = await mutate({ operation: 'move', id, parentId, beforeId });
    if (reply) setCanvas(current => ({ ...current, positions: Object.fromEntries(Object.entries(current.positions).filter(([key]) => !noteSubtree(reply.notes!.notes, id).has(key))), collapsed: parentId ? current.collapsed.filter(item => item !== parentId) : current.collapsed }));
  }
  const actions = useRef({ add, fold }); actions.current = { add, fold };
  useEffect(() => {
    const byId = new Map(visibleNotes.map(note => [note.id, note]));
    setNodes(previous => { const moving = new Map(previous.map(item => [item.id, item.position])); return map.map(topic => ({ id: topic.id, type: 'note', position: drag.current && moving.get(topic.id) || canvas.positions[topic.id] || topic.position, selected: topic.id === selectedId,
      ariaLabel: `笔记 ${byId.get(topic.id)!.title}`, data: { note: byId.get(topic.id)!, topic, collapsed: canvas.collapsed.includes(topic.id), guide: guide === topic.id, disabled: pending,
        add: id => void actions.current.add(id), fold: id => actions.current.fold(id) } })); });
  }, [map, canvas.positions, canvas.collapsed, selectedId, guide, pending, setNodes]);
  const edges: Edge[] = useMemo(() => {
    const byId = new Map(map.map(item => [item.id, item]));
    const hierarchy: Edge[] = map.filter(item => item.parentId && byId.has(item.parentId)).map(item => ({ id: `tree:${item.id}`, source: item.parentId!, target: item.id, sourceHandle: `${item.side}-out`, targetHandle: `${item.side === 'left' ? 'right' : 'left'}-in`, type: 'default', style: { stroke: item.color, strokeWidth: item.kind === 'main' ? 2 : 1.5 }, selectable: false }));
    for (const note of visibleNotes) for (const target of note.relatedIds) if (note.id < target && byId.has(note.id) && byId.has(target)) hierarchy.push({ id: `related:${note.id}:${target}`, source: note.id, target, sourceHandle: 'right-out', targetHandle: 'left-in', type: 'default', className: 'note-association-edge', style: { stroke: '#a8aca8', strokeDasharray: '5 5', opacity: selectedId === note.id || selectedId === target ? 1 : .45 }, selectable: false });
    return hierarchy;
  }, [map, book.notes, selectedId]);
  function dragStart(node: NoteNode) { const positions = new Map((flow?.getNodes() ?? nodes).map(item => [item.id, { ...item.position }])); drag.current = { id: node.id, start: { ...node.position }, positions, ids: noteSubtree(visibleNotes, node.id) }; setSelectedId(node.id); }
  function dragMove(node: NoteNode) {
    const origin = drag.current; if (!origin || origin.id !== node.id) return;
    const delta = { x: node.position.x - origin.start.x, y: node.position.y - origin.start.y };
    setNodes(current => current.map(item => origin.ids.has(item.id) && item.id !== node.id ? { ...item, position: { x: origin.positions.get(item.id)!.x + delta.x, y: origin.positions.get(item.id)!.y + delta.y } } : item));
    guideRef.current = noteMoveTarget(visibleNotes, node.id, node.position, origin.positions); setGuide(guideRef.current);
  }
  async function dragStop(node: NoteNode) {
    const origin = drag.current, target = guideRef.current; drag.current = null; guideRef.current = null; setGuide(null); if (!origin) return;
    if (target && target !== visibleNotes.find(item => item.id === node.id)?.parentId) { await move(node.id, target); return; }
    const delta = { x: node.position.x - origin.start.x, y: node.position.y - origin.start.y };
    setCanvas(current => ({ ...current, positions: { ...current.positions, ...Object.fromEntries([...origin.ids].filter(id => origin.positions.has(id)).map(id => [id, { x: origin.positions.get(id)!.x + delta.x, y: origin.positions.get(id)!.y + delta.y }])) } }));
  }
  function keyboard(event: React.KeyboardEvent) {
    if (event.nativeEvent.isComposing) return;
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
    else if (event.key === 'Delete' && current) { event.preventDefault(); void recycle(current.id); }
  }

  return <main ref={workspace} className={`notes-workspace${opened ? ' has-document' : ''}`} aria-label="笔记工作区" onKeyDown={keyboard}>
    <header className="notes-toolbar"><strong>笔记</strong><div className="notes-search"><input aria-label="搜索笔记" placeholder="搜索笔记" value={search} onChange={event => setSearch(event.target.value)} />{search && <button type="button" className="icon-button" aria-label="清除笔记搜索" onClick={() => setSearch('')}>×</button>}</div><button type="button" className="button secondary compact" disabled={!loaded || pending} onClick={() => void add(null)}>＋ 新建笔记</button><button type="button" className="text-button" aria-pressed={trash} onClick={() => setTrash(value => !value)}>回收站{book.notes.filter(note => note.deletedAt).length ? ` (${book.notes.filter(note => note.deletedAt).length})` : ''}</button><button type="button" className="icon-button" aria-label="刷新笔记" disabled={pending} onClick={() => void reload()}>↻</button>{dirtyCount > 0 && <span className="draft-indicator">{dirtyCount} 份草稿</span>}</header>
    {error && <div className="notes-error" role="alert">{error}{autosave.failed && <button type="button" className="text-button" onClick={() => autosave.retry()}>重试</button>}<button type="button" className="text-button" onClick={() => setError('')}>关闭</button></div>}
    {!loaded ? <p className="notes-loading" role="status">正在读取笔记…</p> : <div className="notes-body">
      <section className="notes-map-pane" aria-label="笔记脑图" onContextMenu={event => event.preventDefault()}>
        {trash ? <div className="notes-trash"><h2>回收站</h2>{book.notes.some(note => note.deletedAt) ? book.notes.filter(note => note.deletedAt).map(note => <div className="notes-trash-row" key={note.id}><button type="button" className="text-button" onClick={() => open(note.id)}>{note.title}</button><button type="button" className="text-button" disabled={pending} onClick={() => void mutate({ operation: 'restore', id: note.id })}>恢复</button></div>) : <p>回收站为空</p>}</div> : <>
          <ReactFlow<NoteNode> nodes={nodes} edges={edges} nodeTypes={nodeTypes} onInit={setFlow} onNodesChange={onNodesChange} onMoveStart={() => setMenu(null)} onMoveEnd={(_, viewport) => setCanvas(current => ({ ...current, viewport }))} onNodeClick={(_, node) => { if (pending) return; openedId ? open(node.id) : setSelectedId(node.id); }} onNodeDoubleClick={(_, node) => open(node.id)} onNodeContextMenu={(event, node) => { event.preventDefault(); event.stopPropagation(); showMenu(node.id, event.clientX, event.clientY, (event.target as HTMLElement).closest<HTMLElement>('.react-flow__node')!); }} onNodeDragStart={(_, node) => dragStart(node)} onNodeDrag={(_, node) => dragMove(node)} onNodeDragStop={(_, node) => void dragStop(node)} onConnect={connection => { if (connection.source && connection.target) void mutate({ operation: 'associate', id: connection.source, targetId: connection.target, linked: true }); }} nodesDraggable={!pending && !openedId} nodesConnectable={!pending} multiSelectionKeyCode={null} deleteKeyCode={null} nodeDragThreshold={6} nodeClickDistance={6} zoomOnDoubleClick={false} minZoom={.05} maxZoom={2} defaultViewport={canvas.viewport} proOptions={{ hideAttribution: true }}><Background variant={BackgroundVariant.Dots} gap={22} size={.8} color="#dde2dd" /><Controls showInteractive={false} /></ReactFlow>
          {!visibleNotes.length && <div className="notes-empty"><h1>把想法连成自己的笔记</h1><p>从一份笔记开始，在脑图中展开、组织和连接内容。</p><button type="button" className="button primary" disabled={pending} onClick={() => void add(null)}>新建第一份笔记</button></div>}
          {search.trim() && <div className="notes-search-results" role="region" aria-label="笔记搜索结果"><strong>{matched.length} 个结果</strong>{matched.length ? matched.map(note => <button type="button" key={note.id} onClick={() => { reveal(note.id); open(note.id); }}><span>{note.title}</span><small>{note.body.replace(/[#*_`\[\]]/g, '').slice(0, 80)}</small></button>) : <p>没有匹配的笔记</p>}</div>}
          <div className="notes-map-actions"><button type="button" className="text-button" disabled={pending || !visibleNotes.length} onClick={() => { setCanvas(current => ({ ...current, positions: {} })); requestAnimationFrame(() => void flow?.fitView({ padding: .25, maxZoom: 1 })); }}>整理脑图</button><button type="button" className="text-button" onClick={() => setCanvas(current => ({ ...current, collapsed: [] }))}>展开全部</button><span>{guide ? `移入「${visibleNotes.find(note => note.id === guide)?.title}」` : '双击阅读 · Tab 子笔记 · Enter 同级笔记'}</span></div>
        </>}
      </section>
      {opened && draft && <section className="notes-document-pane" aria-label="笔记内容"><div className="notes-document-toolbar"><button type="button" className="text-button" disabled={pending} onClick={() => void returnToMap()}>← 脑图</button><span role="status">{autosave.savingId === opened.id ? '保存中…' : isDirty(draft) ? draft.title.trim() ? '未保存' : '请填写标题，草稿已保留' : status}{opened.deletedAt ? ' · 已删除' : ''}</span>{!opened.deletedAt && <button type="button" className="text-button" disabled={pending || conflicted} onClick={() => void toggleMode()}>{isEditing ? '阅读' : '编辑'}</button>}</div>
        {conflicted && <div className="notes-conflict" role="alert"><strong>笔记已有其他修改，草稿已保留。</strong><details><summary>查看最新内容</summary><h3>{opened.title}</h3><pre>{opened.body}</pre></details><button type="button" className="text-button" onClick={() => { if (window.confirm('放弃当前草稿并读取最新内容？')) setDrafts(current => ({ ...current, [opened.id]: cleanDraft(opened) })); }}>载入最新内容</button><button type="button" className="text-button" onClick={() => { if (window.confirm('确认已经核对最新内容并合并到当前草稿？')) setDrafts(current => ({ ...current, [opened.id]: { ...current[opened.id], baseTitle: opened.title, baseBody: opened.body } })); }}>已合并，继续编辑</button></div>}
        <div className="notes-document-scroll"><DocumentEditorPane identity={`note:${opened.id}`} title={draft.title} content={draft.body} editing={isEditing} disabled={pending && !savingNote.current || !!opened.deletedAt} onTitleChange={title => updateDraft(opened.id, { title })} onContentChange={body => updateDraft(opened.id, { body })} titleLabel="笔记标题" bodyLabel="笔记正文" headingPrefix={`note-${opened.id}`} onComplete={async query => visibleNotes.filter(note => note.id !== opened.id && note.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())).slice(0, 20).map(note => ({ label: note.title, apply: `[${note.title.replace(/[\\[\]]/g, '\\$&')}](mixcat-note://${note.id}) ` }))} onOpenLink={href => { const match = /^mixcat-note:\/\/([A-Za-z0-9_-]+)\/?$/.exec(href); if (match && bookRef.current.notes.some(note => note.id === match[1])) open(match[1]); else if (/^https?:\/\//i.test(href)) void window.mixcat?.openExternal?.(href).catch(caught => setError(String(caught))); else setError('这个链接目前无法打开。'); }} resolveResource={media.resolveResource} onPasteImage={media.importImages} onInsertMedia={media.importMedia} />
          {isDirty(draft) && <button type="button" className="text-button" disabled={pending} onClick={() => { if (window.confirm('放弃当前笔记草稿？')) setDrafts(current => ({ ...current, [opened.id]: cleanDraft(opened) })); }}>放弃草稿</button>}
        </div>
      </section>}
    </div>}
    {menu && <div ref={menuRef} className="canvas-context-menu notes-context-menu" role="menu" aria-label="笔记操作" style={{ left: Math.max(8, Math.min(menu.x, window.innerWidth - 188)), top: Math.max(40, Math.min(menu.y, window.innerHeight - 100)) }}><button type="button" role="menuitem" disabled={pending} onClick={() => { const id = menu.id; setMenu(null); void add(id); }}>新建笔记</button><button type="button" role="menuitem" className="danger-button" disabled={pending} onClick={() => { const id = menu.id; setMenu(null); menuTrigger.current?.focus({ preventScroll: true }); void recycle(id); }}>删除</button></div>}
  </main>;
}
