import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type Ref } from 'react';
import { createPortal, flushSync } from 'react-dom';
import type { AppCommand, AppSnapshot, CapabilityCatalog, NativeInput, NodeView, PendingNativeRequest, ProjectSnapshot, TaskView } from '../shared/types';
import { Dialog } from './Dialog';
import { Icon } from './Icon';
import { NodeDetailsButton } from './NodeDetailsButton';
import { updateScrollEdge } from './ReadingFeedback';
import { NodeConfig, nodeConfigLockReason, nodeConfigModel, type DraftNode } from './NodeSettings';
import { useDocumentAutosave } from './document-autosave';
import { ConversationFeed, isCurrentActivity } from './Conversation';
import { NativeRequestCard } from './NativeRequests';
import { NodePanels } from './NodePanels';
import { HumanReviews, type ReviewAction } from './HumanReviews';
import { classifyNativeRequest } from '../shared/native-requests';
import { ReferenceEditor } from './ReferenceEditor';
import { referencesIn, type WorkContext } from '../shared/project-items';
import { attachmentPreviewMime } from '../shared/attachment-preview';
import type { WorkbenchRequest } from './ProjectManagement';
import type { Execute } from './execute-command';
const sessionTabs = [['conversation', '会话'], ['config', '配置'], ['panels', '工作面板']] as const;
const reviewFilters = [['all', '全部'], ['questions', '待回答'], ['reviews', '待核对']] as const;
const nodeStatusLabels: Record<NodeView['status'], string> = {
  idle: '空闲', starting: '启动中', running: '运行中', pausing: '暂停中', resuming: '等待续接',
  paused: '已暂停', queued: '排队中', blocked: '需处理', completed: '已完成'
};
export interface SessionPaneHandle { history(): void; reviews(nodeId?: string): void; config(): void; conversation(): void; latest(nodeId?: string): void; reset(): void; discard(nodeId: string): void; open(path: string): void; }
type SessionDrafts = Record<string, { text: string; attachments: NativeInput[]; context?: WorkContext }>;
export interface SessionPaneProps {
  snapshot: ProjectSnapshot; runtime: AppSnapshot['runtime']; execute: Execute; nodeId: string; busy: boolean; error: string | null; onError(error: string): void;
  obscured?: boolean; visible?: boolean; resizingDetails?: boolean; onClose(): void; onSelect?(nodeId: string): void; onOpen?(): void;
  workRequest?: WorkbenchRequest; reviewActions?: Map<string, ReviewAction>; onDirty?(dirty: boolean): void; onObscured?(obscured: boolean): void;
  ref?: Ref<SessionPaneHandle>;
}
function attachmentLabel(input: NativeInput) {
  if (input.mixcatAttachment?.name) return input.mixcatAttachment.name;
  if (typeof input.path === 'string') return input.path.split(/[\\/]/).at(-1) ?? input.type;
  if (typeof input.text === 'string') return input.text.split('\n')[0].replace(/^附件：/, '');
  return String(input.name ?? input.type);
}

function useAttachmentMedia(projectId: string, nodeId: string, artifactId: string | undefined, thumbnail: boolean) {
  const [media, setMedia] = useState<{ url: string; mime: string } | { error: string } | null>(null);
  useEffect(() => {
    if (!artifactId) return;
    let cancelled = false;
    const preview = window.mixcat.previewAttachment;
    if (!preview) {
      setMedia({ error: '附件预览暂不可用。' });
      return;
    }
    void preview(projectId, nodeId, artifactId, thumbnail).then(result => {
      if (cancelled) return;
      if (!result) {
        setMedia({ error: '此附件没有可用的预览。' });
        return;
      }
      setMedia(result);
    }).catch(error => {
      if (!cancelled) setMedia({ error: String(error instanceof Error ? error.message : error).replace(/^.*?Error: /, '') });
    });
    return () => { cancelled = true; };
  }, [projectId, nodeId, artifactId, thumbnail]);
  return media;
}

function AttachmentTile({ projectId, nodeId, item, label, onPreview, onRemove }: {
  projectId: string; nodeId: string; item: NativeInput; label: string;
  onPreview?(trigger: HTMLButtonElement): void; onRemove(): void;
}) {
  const tile = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const registration = item.mixcatAttachment;
  const image = registration && attachmentPreviewMime(label)?.startsWith('image/');
  useEffect(() => {
    if (!image || !tile.current) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      setVisible(true);
      observer.disconnect();
    });
    observer.observe(tile.current);
    return () => observer.disconnect();
  }, [image]);
  const thumbnail = useAttachmentMedia(projectId, nodeId, visible && image ? registration?.artifact_id : undefined, true);
  return <div className="session-attachment" data-attachment-id={registration?.artifact_id} ref={tile} title={label}>
    <div className="session-attachment-visual">
      {thumbnail && 'url' in thumbnail && !thumbnailFailed
        ? <img src={thumbnail.url} alt="" onError={() => setThumbnailFailed(true)} />
        : <span className="session-attachment-type"><Icon name={image ? 'canvas' : 'note'} size={20} /></span>}
      {onPreview && <button type="button" className="icon-button attachment-preview-button" title={`预览 ${label}`}
        aria-label={`预览 ${label}`} onClick={event => onPreview(event.currentTarget)}><Icon name="panel" size={14} /></button>}
      <button type="button" className="icon-button attachment-remove-button" title={`移除 ${label}`}
        aria-label={`移除 ${label}`} onClick={onRemove}><Icon name="close" size={14} /></button>
    </div>
    <span className="session-attachment-label" title={label}>{label}</span>
  </div>;
}

function AttachmentPreviewDialog({ projectId, nodeId, artifactId, label, onClose, onReselect }: {
  projectId: string; nodeId: string; artifactId: string; label: string; onClose(): void; onReselect(): void;
}) {
  const media = useAttachmentMedia(projectId, nodeId, artifactId, false);
  const [decodeFailed, setDecodeFailed] = useState(false);
  const error = decodeFailed ? '无法播放或显示此文件。' : media && 'error' in media ? media.error : undefined;
  return <Dialog title={`预览 ${label}`} onClose={onClose}>
    <div className="session-attachment-preview">
      {error ? <>
        <p className="inline-error" role="alert">{error}</p>
        <button type="button" className="button secondary" onClick={onReselect}>重新选择</button>
      </> : media && 'url' in media ? (
        media.mime.startsWith('image/') ? <img src={media.url} alt={label} onError={() => setDecodeFailed(true)} /> :
        media.mime.startsWith('video/') ? <video src={media.url} aria-label={label} controls onError={() => setDecodeFailed(true)} /> :
        <audio src={media.url} aria-label={label} controls onError={() => setDecodeFailed(true)} />
      ) : <p className="field-note" role="status">正在读取附件…</p>}
    </div>
  </Dialog>;
}
function focusChoice(event: KeyboardEvent<HTMLButtonElement>, index: number, count: number) {
  const destinations: Record<string, number> = { ArrowLeft: (index + count - 1) % count, ArrowRight: (index + 1) % count, Home: 0, End: count - 1 };
  const target = destinations[event.key];
  if (target === undefined || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  event.preventDefault();
  event.currentTarget.parentElement?.querySelectorAll('button')[target]?.focus();
  return target;
}

export function SessionPane({ snapshot, runtime, execute, nodeId, busy, error, onError, obscured = false, visible = true, resizingDetails = false, onClose, onSelect, onOpen, workRequest, reviewActions, onDirty, onObscured, ref }: SessionPaneProps) {
  const { project } = snapshot, mode = project.mode, selected = snapshot.nodes.find(node => node.id === nodeId);
  const detailsOpen = visible, closeDetails = onClose;
  const setSelectedId = (id: string) => onSelect?.(id), setDetailsOpen = (value: boolean) => { if (value) onOpen?.(); };
  const [latestConversation, setLatestConversation] = useState<{ nodeId: string } | null>(null);
  const [tab, setTab] = useState<(typeof sessionTabs)[number][0]>('conversation');
  const localReviewActions = useRef(new Map<string, ReviewAction>());
  const actionStore = reviewActions ?? localReviewActions.current;
  const [drafts, setDrafts] = useState<SessionDrafts>({});
  const [attaching, setAttaching] = useState(false);
  const [configDrafts, setConfigDrafts] = useState<Record<string, DraftNode>>({});
  const configAutosave = useDocumentAutosave(Object.values(configDrafts).filter(draft => {
    const node = snapshot.nodes.find(node => node.id === draft.id);
    return node && draft.revision === node.revision && draft.name.trim() && nodeConfigModel(node, snapshot.tasks, draft) && !nodeConfigLockReason(node.id, snapshot.tasks);
  }).map(draft => ({ id: draft.id, fingerprint: JSON.stringify(draft) })), busy, saveConfig);
  const [nativeAnswers, setNativeAnswers] = useState<Record<string, Record<string, string>>>({});
  const [reviewAnswers, setReviewAnswers] = useState<Record<string, string>>({});
  useEffect(() => {
    setNativeAnswers(current => {
      const next = Object.fromEntries(Object.entries(current).filter(([key]) => snapshot.requests?.some(request => request.key === key)));
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
    setReviewAnswers(current => {
      const next = Object.fromEntries(Object.entries(current).filter(([id]) => snapshot.humanReviews?.some(review => review.id === id && review.status === 'pending')));
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  }, [snapshot.requests, snapshot.humanReviews]);
  const dirty = attaching || Object.keys(configDrafts).length > 0 || Object.values(drafts).some(draft => !!draft.text || draft.attachments.length > 0 || !!draft.context)
    || (snapshot.requests ?? []).some(request => Object.values(nativeAnswers[request.key] ?? {}).some(Boolean))
    || (snapshot.humanReviews ?? []).some(review => review.status === 'pending' && !!reviewAnswers[review.id]);
  useEffect(() => { onDirty?.(dirty); }, [dirty, onDirty]);
  const draft = drafts[selected?.id ?? ''] ?? { text: '', attachments: [] };
  const references = useMemo(() => [...new Map([
    ...(draft.context?.references ?? []),
    ...referencesIn(draft.text, project.id)
  ].map(reference => [`${reference.kind}:${reference.id}`, reference])).values()], [draft.context, draft.text, project.id]);
  const [catalog, setCatalog] = useState<CapabilityCatalog | null>(null);
  const [catalogError, setCatalogError] = useState('');
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const catalogRequest = useRef(0);
  const catalogNodeId = useRef<string | null>(selected?.id ?? null);
  catalogNodeId.current = selected?.id ?? null;
  const [historyOpen, setHistoryOpen] = useState(false);
  const [reviewScope, setReviewScope] = useState<{ nodeId?: string } | null>(null);
  const reviewsOpen = reviewScope !== null;
  const reviewNodeId = reviewScope?.nodeId;
  const [reviewFilter, setReviewFilter] = useState<(typeof reviewFilters)[number][0]>('all');
  const reviewViewport = useRef<HTMLDivElement>(null);
  const reviewPositions = useRef<Partial<Record<typeof reviewFilter, number>>>({});
  useLayoutEffect(() => {
    if (reviewViewport.current) reviewViewport.current.scrollTop = reviewPositions.current[reviewFilter] ?? 0;
  }, [reviewFilter, reviewsOpen]);
  function filterReviews(filter: typeof reviewFilter) {
    reviewPositions.current[reviewFilter] = reviewViewport.current?.scrollTop ?? 0;
    setReviewFilter(filter);
  }
  const questions = (snapshot.requests ?? []).filter(request => classifyNativeRequest(request) === 'question' && (!reviewNodeId || request.nodeId === reviewNodeId));
  const pendingReviews = (snapshot.humanReviews ?? []).filter(review => review.status === 'pending' && (!reviewNodeId || review.nodeId === reviewNodeId));
  const questionCount = questions.length + pendingReviews.filter(review => review.kind === 'question').length;
  const reviewCount = questions.length + pendingReviews.length - questionCount;
  const nativeResponses = useRef(new Set<string>());
  function renderNativeRequest(request: PendingNativeRequest) {
    return <NativeRequestCard key={request.key} request={request} answerDraft={nativeAnswers[request.key] ?? {}} onAnswerChange={answers => setNativeAnswers(current => ({ ...current, [request.key]: answers }))}
      item={snapshot.conversation?.find(entry => entry.nodeId === request.nodeId && entry.itemId === request.params?.itemId)?.content}
      onOpenUrl={url => { if (request.nodeId ?? selected?.id) void openResource((request.nodeId ?? selected?.id)!, { url }); }}
      onRespond={async result => {
        const key = JSON.stringify([project.id, request.key]);
        if (nativeResponses.current.has(key)) return;
        nativeResponses.current.add(key);
        try { await execute({ type: 'respond_native', projectId: project.id, requestKey: request.key, result }); }
        finally { nativeResponses.current.delete(key); }
      }} onError={onError} />;
  }
  const sessionRequest = useRef(0);
  const historyRequest = useRef(0);
  const historyReturnFocus = useRef<HTMLElement | null>(null);
  const resourceRequest = useRef(0);
  useEffect(() => { resourceRequest.current++; return () => { resourceRequest.current++; }; }, [project.id, selected?.id, tab, detailsOpen, historyOpen, reviewsOpen, obscured]);
  const [resourceIntent, setResourceIntent] = useState<{ nodeId: string; path: string } | null>(null);
  useEffect(() => {
    if (!resourceIntent || obscured || !visible) return;
    setResourceIntent(null); void openResource(resourceIntent.nodeId, { path: resourceIntent.path });
  }, [resourceIntent, obscured, visible]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyFailures, setHistoryFailures] = useState<string[]>([]);
  const [location, setLocation] = useState<{ messageId: string; sourceNodeId?: string; history: boolean } | null>(null);
  useEffect(() => {
    if (!workRequest) return;
    setLatestConversation(workRequest.taskId || workRequest.messageId ? null : { nodeId: workRequest.nodeId }); setSelectedId(workRequest.nodeId); setTab('conversation'); setDetailsOpen(true); setLocation(null);
    if (workRequest.text || workRequest.attachments?.length) setDrafts(current => {
      const previous = current[workRequest.nodeId] ?? { text: '', attachments: [] };
      return { ...current, [workRequest.nodeId]: { ...previous, text: workRequest.text ? (previous.text ? `${previous.text}\n\n${workRequest.text}` : workRequest.text) : previous.text, attachments: [...previous.attachments, ...(workRequest.attachments ?? [])], context: workRequest.context ?? previous.context } };
    });
    if (workRequest.messageId) locateMessage(workRequest.messageId);
    else if (workRequest.taskId && !snapshot.nodes.some(node => node.id === workRequest.nodeId)) void openProjectHistory();
  }, [workRequest?.id]);
  const [retry, setRetry] = useState<TaskView | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [attachmentPreview, setAttachmentPreview] = useState<{ projectId: string; nodeId: string; artifactId: string; label: string; trigger: HTMLButtonElement } | null>(null);
  const activeAttachmentPreview = attachmentPreview?.projectId === project.id && attachmentPreview.nodeId === selected?.id ? attachmentPreview : null;
  useEffect(() => { setAttachmentPreview(null); }, [project.id, selected?.id]);
  const nativeConnected = runtime?.mode === 'codex' && runtime.connected;
  const reconciliationNodes = new Set(snapshot.tasks.filter(task => task.status === 'needs_reconciliation').map(task => task.nodeId));
  const reconciliationReason = selected && reconciliationNodes.has(selected.id) ? '上次执行结果待核对，请先查看会话记录，再决定是否重试。' : undefined;
  const historyNodes = [...snapshot.nodes, ...(snapshot.archivedNodes ?? []).map(node => ({ ...node, name: `${node.name}（已移除）` }))];
  const entries = snapshot.conversation ?? [];
  const nodeEntries = entries.filter(entry => entry.nodeId === selected?.id);
  const locatedSource = location && entries.find(entry => entry.messageId === location.messageId && entry.nodeId === location.sourceNodeId);
  const locatedEntry = locatedSource || (location?.history ? entries.find(entry => entry.messageId === location.messageId) : undefined);
  const pendingTasks = snapshot.tasks.filter(task => task.nodeId === selected?.id && task.status === 'queued').length;
  const reviewWaits = snapshot.tasks.filter(task => task.nodeId === selected?.id && task.status === 'waiting_review');
  const runningTask = snapshot.tasks.find(task => task.nodeId === selected?.id && task.status === 'running');
  const ongoing = runningTask && nodeEntries.findLast(entry => entry.direction === 'event' && isCurrentActivity(entry, runningTask, nodeEntries));
  const nodeStatus = selected ? nodeStatusLabels[selected.status] : '';
  const showActivity = selected && ['starting', 'running', 'pausing', 'resuming'].includes(selected.status);
  const [windowFocused, setWindowFocused] = useState(false);
  useEffect(() => {
    const updateFocus = () => setWindowFocused(document.hasFocus() && !document.hidden);
    updateFocus();
    window.addEventListener('focus', updateFocus);
    window.addEventListener('blur', updateFocus);
    document.addEventListener('visibilitychange', updateFocus);
    return () => {
      window.removeEventListener('focus', updateFocus);
      window.removeEventListener('blur', updateFocus);
      document.removeEventListener('visibilitychange', updateFocus);
    };
  }, []);
  const loadedHistory = useRef(new Set<string>());
  useEffect(() => {
    if (selected?.threadId && !selected.historyPending && nativeConnected && !loadedHistory.current.has(selected.threadId)) {
      loadedHistory.current.add(selected.threadId);
      void execute({ type: 'read_history', projectId: project.id, nodeId: selected.id }).then(reply => { if (!reply || reply.historyPending) loadedHistory.current.delete(selected.threadId!); });
    }
  }, [selected?.id, selected?.threadId, selected?.historyPending, nativeConnected]);
  useEffect(() => {
    setCatalog(null);
    setCatalogError('');
    if (tab === 'config') void reloadCatalog(selected?.id ?? null);
    else setLoadingCatalog(false);
    return () => { catalogRequest.current++; };
  }, [project.id, selected?.id, selected?.threadId, tab]);
  async function reloadCatalog(nodeId: string | null = catalogNodeId.current) {
    const request = ++catalogRequest.current;
    const isCurrent = () => request === catalogRequest.current && nodeId === catalogNodeId.current;
    setCatalogError('');
    setLoadingCatalog(true);
    try {
      const reply = await execute({ type: 'catalog', projectId: project.id, ...(nodeId ? { nodeId } : {}) }, undefined, { handleFailure: 'caller' });
      if (!isCurrent()) return;
      const next = reply?.catalog;
      if (!next || next.errors.length) {
        if (next) setCatalog(current => current ?? next);
        setCatalogError(next ? [...new Set(next.errors)].join('；') : '能力目录未返回结果。');
      } else setCatalog(next);
    } catch (caught) {
      if (isCurrent()) setCatalogError(caught instanceof Error ? caught.message : String(caught));
    }
    finally { if (request === catalogRequest.current) setLoadingCatalog(false); }
  }
  function closeProjectHistory(restoreFocus = false) {
    historyRequest.current++;
    const trigger = historyReturnFocus.current;
    historyReturnFocus.current = null;
    setHistoryOpen(false);
    if (restoreFocus && trigger) requestAnimationFrame(() => { if (trigger.isConnected) trigger.focus({ preventScroll: true }); });
  }
  async function openProjectHistory() {
    const request = ++historyRequest.current;
    if (!historyOpen && document.activeElement instanceof HTMLElement) historyReturnFocus.current = document.activeElement;
    setHistoryOpen(true); setHistoryLoading(true); setHistoryFailures([]);
    const failed: string[] = [];
    try {
      for (const node of historyNodes.filter(node => node.threadId && !node.threadId.startsWith('demo-'))) {
        const reply = await execute({ type: 'read_history', projectId: project.id, nodeId: node.id });
        if (!reply || reply.historyPending) failed.push(node.name);
        if (request !== historyRequest.current) return;
      }
      setHistoryFailures(failed);
    } finally { if (request === historyRequest.current) setHistoryLoading(false); }
  }
  function locateMessage(messageId: string) {
    const sourceNodeId = snapshot.messages?.find(message => message.message_id === messageId)?.fromNodeId
      ?? entries.find(entry => entry.messageId === messageId && entry.direction === 'event')?.nodeId;
    const inNode = snapshot.nodes.some(node => node.id === sourceNodeId) && entries.some(entry => entry.messageId === messageId && entry.nodeId === sourceNodeId);
    setLocation({ messageId, sourceNodeId, history: !inNode });
    if (inNode) { setSelectedId(sourceNodeId!); setTab('conversation'); setDetailsOpen(true); closeProjectHistory(); }
    else void openProjectHistory();
  }
  function updateDraft(patch: Partial<typeof draft>, nodeId = selected?.id) { if (nodeId) setDrafts(current => ({ ...current, [nodeId]: { ...(current[nodeId] ?? { text: '', attachments: [] }), ...patch } })); }
  function updateConfigDraft(nodeId: string, draft: DraftNode | null) {
    setConfigDrafts(current => { const next = { ...current }; if (draft) next[nodeId] = draft; else delete next[nodeId]; return next; });
  }
  function configSaved(submitted: DraftNode, updated: NodeView) {
    // Publish the acknowledged revision before the next editor event builds another draft.
    flushSync(() => setConfigDrafts(current => {
      const next = { ...current }, latest = next[submitted.id];
      if (!latest || latest === submitted) delete next[submitted.id];
      else next[submitted.id] = { ...latest, revision: updated.revision };
      return next;
    }));
  }
  async function saveConfig(id: string) {
    const submitted = configDrafts[id], node = snapshot.nodes.find(node => node.id === id);
    if (!submitted || !node) return false;
    try {
      const updated = await saveNode({ ...submitted, model: nodeConfigModel(node, snapshot.tasks, submitted), position: node.position });
      if (!updated) return false;
      configSaved(submitted, updated); return true;
    } catch (error) { onError(error instanceof Error ? error.message : String(error)); return false; }
  }
  const sending = useRef(false);
  const [sendingMessage, setSendingMessage] = useState(false);
  async function send(event: FormEvent) {
    event.preventDefault();
    if (busy || sending.current || !selected || (!draft.text.trim() && !draft.attachments.length)) return;
    const nodeId = selected.id; const input: NativeInput[] = [...(draft.text ? [{ type: 'text', text: draft.text, text_elements: [] }] : []), ...draft.attachments];
    const work_context = draft.context || references.length ? { primary_issue_id: draft.context?.primary_issue_id ?? draft.context?.primary_todo_id ?? null, references } : undefined;
    sending.current = true;
    setSendingMessage(true);
    try {
      if (await execute({ type: 'send_message', projectId: project.id, nodeId, input, mode, ...(work_context ? { work_context } : {}) })) {
        setDrafts(current => current[nodeId] === draft ? { ...current, [nodeId]: { text: '', attachments: [] } } : current);
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      sending.current = false;
      setSendingMessage(false);
    }
  }
  async function attach(replaceId?: string) {
    if (!selected || attaching) return;
    const nodeId = selected.id, request = sessionRequest.current;
    setAttaching(true);
    try {
      const input = await window.mixcat.chooseAttachments(project.id, nodeId);
      if (request !== sessionRequest.current || !input.length) return;
      setDrafts(current => {
        const previous = current[nodeId] ?? { text: '', attachments: [] };
        const attachments = replaceId
          ? previous.attachments.flatMap(item => item.mixcatAttachment?.artifact_id === replaceId ? input : [item])
          : [...previous.attachments, ...input];
        return { ...current, [nodeId]: { ...previous, attachments } };
      });
    } catch (error) {
      if (request === sessionRequest.current) onError(error instanceof Error ? error.message : String(error));
    } finally {
      if (request === sessionRequest.current) setAttaching(false);
    }
  }
  function closeAttachmentPreview() {
    const trigger = activeAttachmentPreview?.trigger;
    setAttachmentPreview(null);
    if (trigger) requestAnimationFrame(() => { if (trigger.isConnected) trigger.focus({ preventScroll: true }); });
  }
  async function openResource(nodeId: string, resource: { path?: string; url?: string }) {
    const targetNode = snapshot.nodes.find(node => node.id === nodeId) ?? selected;
    if (!targetNode) { onError('此节点已移除。请先添加一个会话节点，再从项目历史中打开资源；原文件与历史仍然保留。'); return; }
    const request = ++resourceRequest.current;
    try { await window.mixcat.panel({ type: 'open', projectId: project.id, nodeId: targetNode.id, target: resource.path ? { type: 'file', path: resource.path } : { type: 'url', url: resource.url! } }); if (request !== resourceRequest.current) return; setSelectedId(targetNode.id); setTab('panels'); setHistoryOpen(false); setReviewScope(null); setDetailsOpen(true); }
    catch (error) { if (request === resourceRequest.current) onError(error instanceof Error ? error.message : String(error)); }
  }
  async function saveNode(node: DraftNode) { const reply = await execute({ type: 'save_node', projectId: project.id, node }); return reply?.snapshot.selected?.nodes.find(n => n.id === node.id) ?? null; }
  const modalOpen = obscured || historyOpen || reviewsOpen || !!retry || attaching || !!activeAttachmentPreview;
  useEffect(() => { if (obscured && historyOpen) closeProjectHistory(); }, [obscured, historyOpen]);
  useEffect(() => { onObscured?.(historyOpen || reviewsOpen || !!retry || attaching || !!activeAttachmentPreview); }, [historyOpen, reviewsOpen, retry, attaching, activeAttachmentPreview, onObscured]);
  useEffect(() => {
    if (workRequest?.nodeId === nodeId && (workRequest.taskId || workRequest.messageId)) return;
    if (location && !location.history && location.sourceNodeId === nodeId) return;
    setLatestConversation({ nodeId });
  }, [nodeId]);
  useImperativeHandle(ref, () => ({
    history: () => { setLocation(null); void openProjectHistory(); }, reviews: nodeId => { reviewPositions.current = {}; setReviewFilter('all'); setReviewScope({ nodeId }); }, config: () => setTab('config'), conversation: () => setTab('conversation'),
    latest: (targetId = nodeId) => { setLocation(null); setLatestConversation({ nodeId: targetId }); },
    open: path => setResourceIntent({ nodeId, path }),
    reset: () => { sessionRequest.current++; resourceRequest.current++; loadedHistory.current.clear(); for (const [key, action] of actionStore) if ('projectId' in action.command && action.command.projectId === project.id) actionStore.delete(key); setDrafts({}); setAttaching(false); setAttachmentPreview(null); setRetry(null); setConfirmed(false); setLocation(null); closeProjectHistory(); setHistoryLoading(false); setHistoryFailures([]); setReviewScope(null); setTab('conversation'); },
    discard: id => { updateConfigDraft(id, null); setDrafts(current => { const next = { ...current }; delete next[id]; return next; }); }
  }));
  return <div className="session-pane" onKeyDown={event => {
    if (!event.defaultPrevented && event.key === 'Escape' && !event.nativeEvent.isComposing) {
      event.stopPropagation();
      if (!modalOpen) onClose();
    }
  }}>
      {runtime?.error && <p className="runtime-error" role="alert">{runtime.error}</p>}
      <div className="detail-heading">
        <div className="session-node-title">
          <h2 title={selected?.name}>{selected?.name ?? '节点详情'}</h2>
          {selected && <span className="session-node-status" data-status={selected.status}>{nodeStatus}</span>}
          <NodeDetailsButton expanded onClick={closeDetails} />
        </div>
        {selected && <>
          <div className="node-controls">
            <div className="workbench-button-group" role="group" aria-label="节点运行控制">
              <button className="button secondary compact" disabled={!!reconciliationReason || ['paused', 'pausing'].includes(selected.status)} title={reconciliationReason} onClick={() => void execute({ type: 'pause_node', projectId: project.id, nodeId: selected.id })}>暂停节点</button>
              <button className="button secondary compact" disabled={!!reconciliationReason || !['paused', 'pausing'].includes(selected.status)} title={reconciliationReason} onClick={() => void execute({ type: 'resume_node', projectId: project.id, nodeId: selected.id })}>启用节点</button>
            </div>
          </div>
          {reconciliationReason && <p className="field-note" role="status">{reconciliationReason}</p>}
          {selected.status === 'pausing' && <p className="field-note">正在等待原生轮次停止；可直接启用节点覆盖暂停。</p>}
          {selected.status === 'resuming' && <p className="field-note">已请求启用，等待原生轮次停止后续接。</p>}
        </>}
      </div>
      {selected ? <>
        <div className="detail-tabs" role="tablist" aria-label="节点详情栏目" data-active-tab={tab}>
          {sessionTabs.map(([value, label], index) => <button key={value} id={`tab-${value}`} type="button" role="tab"
            aria-controls={`node-${value}-panel`} aria-selected={tab === value} tabIndex={tab === value ? 0 : -1}
            className={tab === value ? 'active' : ''} onKeyDown={event => { const target = focusChoice(event, index, sessionTabs.length); if (target !== undefined) setTab(sessionTabs[target][0]); }}
            onClick={() => setTab(value)}>{label}</button>)}
        </div>
        <div id="node-conversation-panel" role="tabpanel" aria-labelledby="tab-conversation" className="session-conversation" hidden={tab !== 'conversation'}>
          <div className="detail-scroll session-scroll scroll-edge" tabIndex={0} role="region" aria-label="节点会话消息" onScroll={updateScrollEdge}>
            <div className="session-message-stack">
              {reviewWaits.length > 0 && <div className="field-note" role="status">
                {reviewWaits.length} 条任务等待人工核对。输入会保存，通过后才执行。
                {reviewWaits.map(task => <p key={task.id}>{task.error}{task.reviewDependencies?.map(dependency => `${snapshot.reviewPolicy?.checkpoints.find(point => point.id === dependency.checkpointId)?.name ?? dependency.checkpointId} · ${dependency.reviewId === null ? '等待首次提交' : `版本 ${dependency.version} 待通过或依据已过期`}`).join('；')}</p>)}
              </div>}
              <ConversationFeed entries={nodeEntries} selectedNodeId={selected.id} latestRequest={latestConversation?.nodeId === selected.id ? latestConversation : undefined}
                nodes={snapshot.nodes} tasks={snapshot.tasks} messages={snapshot.messages} projectRoot={project.root}
                locatedEntryId={workRequest?.taskId && !workRequest.messageId ? entries.find(entry => entry.taskId === workRequest.taskId && entry.direction === 'input')?.id : location?.history ? undefined : locatedEntry?.id}
                locationRequest={workRequest?.taskId && !workRequest.messageId ? workRequest : location?.history ? undefined : location ?? undefined}
                onLocateMessage={locateMessage} onOpen={openResource} onRetry={task => { setRetry(task); setConfirmed(false); }} />
              <HumanReviews actionStore={actionStore} project={project} policy={snapshot.reviewPolicy ?? { revision: 0, checkpoints: [] }} reviews={snapshot.humanReviews ?? []}
                tasks={snapshot.tasks} nodes={historyNodes} execute={execute} onOpen={openResource} onError={onError} nodeId={selected.id}
                answerDrafts={reviewAnswers} onAnswerChange={(id, answer) => setReviewAnswers(current => ({ ...current, [id]: answer }))} />
              {(snapshot.requests ?? []).filter(request => !request.nodeId || request.nodeId === selected.id).map(renderNativeRequest)}
            </div>
          </div>
        </div>
        <div id="node-config-panel" role="tabpanel" aria-labelledby="tab-config" className="detail-scroll session-config" hidden={tab !== 'config'}>
          <NodeConfig comfy={project.template === 'comfyui'} key={selected.id} node={selected} draft={configDrafts[selected.id]} onDraftChange={draft => updateConfigDraft(selected.id, draft)}
            tasks={snapshot.tasks} saving={configAutosave.savingId === selected.id} saveFailed={configAutosave.failed} onRetry={configAutosave.retry}
            catalog={catalog} catalogError={catalogError} loading={loadingCatalog} onReload={() => void reloadCatalog()} />
        </div>
        <div id="node-panels-panel" role="tabpanel" aria-labelledby="tab-panels" className="panels-container" hidden={tab !== 'panels'}><NodePanels key={selected.id} projectId={project.id} nodeId={selected.id} visible={detailsOpen && tab === 'panels' && !modalOpen && !resizingDetails} /></div>
        {showActivity && tab === 'conversation' && <div className="current-activity" role="status"
          data-pulse={windowFocused && visible && !modalOpen && selected.status === 'running' && !!runningTask ? '' : undefined}>
          <span className="session-activity-dot" aria-hidden="true" />
          <span className="activity-label">{nodeStatus}</span>
          {ongoing?.text && <span className="activity-copy" title={ongoing.text}>{ongoing.text}</span>}
        </div>}
        <form className="task-composer node-composer" hidden={tab !== 'conversation'} onSubmit={send}>
          <div className="composer-header">
            <label htmlFor="task-instruction">发送给 <strong title={selected.name}>{selected.name}</strong></label>
            {pendingTasks > 0 && <span>{pendingTasks} 条排队中</span>}
          </div>
          {(references.length > 0 || (draft.context?.primary_issue_id ?? draft.context?.primary_todo_id)) && <p className="composer-work-context">
            {references.length > 0 && <span>已引用 {references.length} 个工作项</span>}
            {(draft.context?.primary_issue_id ?? draft.context?.primary_todo_id) && <>
              <span>已关联 Issue</span><button type="button" className="text-button" onClick={() => updateDraft({ context: undefined })}>解除工作关联</button>
            </>}
          </p>}
          {(draft.attachments.length > 0 || attaching) && <div className="attachment-list" role="group" aria-label="已选附件">
            {draft.attachments.map((item, index) => {
              const label = attachmentLabel(item);
              const artifactId = item.mixcatAttachment?.artifact_id;
              return <AttachmentTile key={artifactId ?? index} projectId={project.id} nodeId={selected.id} item={item} label={label}
                onPreview={artifactId && attachmentPreviewMime(label) ? trigger => setAttachmentPreview({ projectId: project.id, nodeId: selected.id, artifactId, label, trigger }) : undefined}
                onRemove={() => updateDraft({ attachments: draft.attachments.filter(attachment => artifactId ? attachment.mixcatAttachment?.artifact_id !== artifactId : attachment !== item) })} />;
            })}
            {attaching && <span className="session-attachment-pending" role="status">正在选择或导入…</span>}
          </div>}
          <div className="session-editor">
            <ReferenceEditor key={selected.id} submitOnEnter id="task-instruction" projectId={project.id} value={draft.text} onChange={text => updateDraft({ text })}
              execute={execute} label="节点消息" placeholder="输入消息，@ 引用项目内容" rows={3} />
            <div className="composer-bottom">
              <button type="button" className="text-button session-attach" disabled={attaching} onClick={() => void attach()}>
                <Icon name="plus" size={16} />{attaching ? '添加中…' : '添加附件'}
              </button>
              <span>{['paused', 'pausing'].includes(selected.status) ? '消息将排队，启用节点后处理' : selected.status === 'resuming' ? '当前轮次停止后继续' : ''}</span>
              <button type="submit" className="button primary session-send" disabled={busy || sendingMessage || (!draft.text.trim() && !draft.attachments.length)}>{sendingMessage ? '发送中…' : '发送'}</button>
            </div>
          </div>
        </form>
      </> : <div className="panel-empty"><h3>{nodeId ? '会话节点已移除' : '添加一个会话节点'}</h3><p>{nodeId ? '可从项目会话历史查看已有记录；请明确选择已有节点继续。' : '在画布空白处右键，选择模型、名称和能力。'}</p></div>}
    {activeAttachmentPreview && <AttachmentPreviewDialog key={activeAttachmentPreview.artifactId} {...activeAttachmentPreview}
      onClose={closeAttachmentPreview} onReselect={() => {
        const { artifactId } = activeAttachmentPreview;
        closeAttachmentPreview();
        void attach(artifactId);
      }} />}
    {reviewsOpen && <Dialog title={`${reviewNodeId && selected?.id === reviewNodeId ? `${selected.name} · ` : ''}待人工核对 ${questionCount + reviewCount}`} onClose={() => setReviewScope(null)}>
      <div className="review-inbox">
        <div className="review-inbox-filters" role="group" aria-label="核对事项筛选" data-filter={reviewFilter}>
          {reviewFilters.map(([value, label], index) => {
            const count = value === 'questions' ? questionCount : value === 'reviews' ? reviewCount : undefined;
            return <button type="button" key={value} aria-pressed={reviewFilter === value} tabIndex={reviewFilter === value ? 0 : -1}
              aria-label={count == null ? undefined : `${label} ${count}`}
              onKeyDown={event => { const target = focusChoice(event, index, reviewFilters.length); if (target !== undefined) filterReviews(reviewFilters[target][0]); }}
              onClick={() => filterReviews(value)}>
              {label}{count != null && <span className="review-inbox-count" aria-hidden="true">{count > 99 ? '99+' : count}</span>}
            </button>;
          })}
        </div>
        <div className="review-inbox-body" ref={reviewViewport}>
          {error && <p className="inline-error" role="alert">{error}</p>}
          {(reviewFilter === 'all' ? !(questionCount + reviewCount) : reviewFilter === 'questions' ? !questionCount : !reviewCount) &&
            <p className="review-inbox-empty" role="status">{reviewFilter === 'questions' ? '当前没有待回答的问题。' : reviewFilter === 'reviews' ? '当前没有待核对的材料。' : '当前没有待处理的事项。'}</p>}
          <div hidden={reviewFilter === 'reviews'}>
            {questions.map(request => <div className="review-inbox-question" key={request.key}>
              <header>
                <strong>待回答</strong>
                <span>{historyNodes.find(node => node.id === request.nodeId)?.name ?? '项目会话'}</span>
                <span>原生请求未提供时间</span>
              </header>
              {renderNativeRequest(request)}
            </div>)}
          </div>
          <HumanReviews nodeId={reviewNodeId} pendingKind={reviewFilter === 'all' ? undefined : reviewFilter} actionStore={actionStore} project={project}
            policy={snapshot.reviewPolicy ?? { revision: 0, checkpoints: [] }} reviews={snapshot.humanReviews ?? []} tasks={snapshot.tasks} nodes={historyNodes}
            execute={execute} onOpen={openResource} onError={onError} answerDrafts={reviewAnswers} onAnswerChange={(id, answer) => setReviewAnswers(current => ({ ...current, [id]: answer }))} />
        </div>
      </div>
    </Dialog>}
    {historyOpen && !obscured && createPortal(<Dialog title="项目会话历史" wide onClose={() => closeProjectHistory(true)}>
      <p className="field-note">所有节点按时间排列 · 未知时间置后按记录顺序 · {entries.length} 条记录{historyLoading ? ' · 正在补齐原生历史…' : ''}</p>
      {historyFailures.length > 0 && <p className="inline-warning">以下节点的原生历史暂未完整载入：{historyFailures.join('、')}。当前展示已保存记录。</p>}
      {location?.history && !historyLoading && <p className="field-note" role="status">{locatedSource ? (snapshot.nodes.some(node => node.id === location.sourceNodeId) ? '已在项目历史定位原消息。' : '来源节点已移除，已在项目历史定位原消息。') : locatedEntry ? '来源节点的原始发送记录缺失，已定位保留的接收记录。' : '未找到原消息记录，当前已保存历史及可读取的原生历史中均无此条目。'}</p>}
      <ConversationFeed entries={entries} nodes={historyNodes} tasks={snapshot.tasks} messages={snapshot.messages} projectRoot={project.root} locatedEntryId={workRequest?.taskId && !workRequest.messageId && !historyLoading ? entries.find(entry => entry.taskId === workRequest.taskId && entry.direction === 'input')?.id : location?.history && !historyLoading ? locatedEntry?.id : undefined} locationRequest={workRequest?.taskId && !workRequest.messageId ? workRequest : location?.history ? location : undefined} onLocateMessage={locateMessage} projectTimeline onOpen={openResource} />
    </Dialog>, document.body)}
    {retry && <Dialog title="核对任务后重试" onClose={() => setRetry(null)}><div className="form-stack"><p className="inline-warning">请核对上次执行和已有成果，避免重复操作。</p><p>{retry.instruction}</p><label className="confirm-choice"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />我已核对，确认可以重试</label><button className="button primary" disabled={!confirmed || busy} onClick={async () => { if (await execute({ type: 'retry_task', projectId: project.id, taskId: retry.id, confirmed: true })) setRetry(null); }}>确认重试</button></div></Dialog>}
  </div>;
}
