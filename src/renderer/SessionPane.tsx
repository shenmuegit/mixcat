import { useEffect, useImperativeHandle, useRef, useState, type FormEvent, type Ref } from 'react';
import type { AppCommand, AppReply, AppSnapshot, CapabilityCatalog, NativeInput, NodeView, PendingNativeRequest, ProjectSnapshot, TaskView } from '../shared/types';
import { Dialog } from './Dialog';
import { NodeConfig, nodeConfigLockReason, nodeConfigModel, type DraftNode } from './NodeSettings';
import { useDocumentAutosave } from './document-autosave';
import { ConversationFeed } from './Conversation';
import { NativeRequestCard } from './NativeRequests';
import { NodePanels } from './NodePanels';
import { HumanReviews, type ReviewAction } from './HumanReviews';
import { classifyNativeRequest } from '../shared/native-requests';
import { ReferenceEditor } from './ReferenceEditor';
import { referencesIn, type WorkContext } from '../shared/project-items';
import type { WorkbenchRequest } from './ProjectManagement';
type Execute = (command: AppCommand, actionId?: string) => Promise<AppReply | null>;
export interface SessionPaneHandle { history(): void; reviews(): void; config(): void; conversation(): void; latest(): void; reset(): void; discard(nodeId: string): void; open(path: string): void; }
type SessionDrafts = Record<string, { text: string; attachments: NativeInput[]; context?: WorkContext }>;
export interface SessionPaneProps {
  snapshot: ProjectSnapshot; runtime: AppSnapshot['runtime']; execute: Execute; nodeId: string; busy: boolean; error: string | null; onError(error: string): void;
  obscured?: boolean; visible?: boolean; resizingDetails?: boolean; onClose(): void; onSelect?(nodeId: string): void; onOpen?(): void; onDelete?(nodeId: string): void;
  deleteReason?: string | null; workRequest?: WorkbenchRequest; reviewActions?: Map<string, ReviewAction>; onDirty?(dirty: boolean): void; onObscured?(obscured: boolean): void;
  persistDrafts?: boolean; ref?: Ref<SessionPaneHandle>;
}
function attachmentLabel(input: NativeInput) {
  if (typeof input.path === 'string') return input.path.split(/[\\/]/).at(-1);
  if (typeof input.text === 'string') return input.text.split('\n')[0].replace(/^附件：/, '');
  return String(input.name ?? input.type);
}

export function SessionPane({ snapshot, runtime, execute, nodeId, busy, error, onError, obscured = false, visible = true, resizingDetails = false, onClose, onSelect, onOpen, onDelete, deleteReason, workRequest, reviewActions, onDirty, onObscured, persistDrafts = false, ref }: SessionPaneProps) {
  const { project } = snapshot, mode = project.mode, selected = snapshot.nodes.find(node => node.id === nodeId);
  const detailsOpen = visible, closeDetails = onClose;
  const setSelectedId = (id: string) => onSelect?.(id), setDetailsOpen = (value: boolean) => { if (value) onOpen?.(); };
  const [latestConversation, setLatestConversation] = useState<{ nodeId: string } | null>(null);
  const [tab, setTab] = useState<'conversation' | 'config' | 'panels'>('conversation');
  const localReviewActions = useRef(new Map<string, ReviewAction>());
  const actionStore = reviewActions ?? localReviewActions.current;
  const draftKey = `mixcat:comfy-drafts:${project.id}`;
  const draftReadError = useRef(false);
  const [drafts, setDrafts] = useState<SessionDrafts>(() => {
    if (!persistDrafts || typeof localStorage === 'undefined') return {};
    try {
      const value = JSON.parse(localStorage.getItem(draftKey) ?? '{}');
      if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.values(value).every((draft: any) => draft && typeof draft.text === 'string' && Array.isArray(draft.attachments) && draft.attachments.every((input: any) => input && typeof input.type === 'string') && (!draft.context || Array.isArray(draft.context.references)))) throw Error('Invalid saved draft');
      return value;
    } catch { draftReadError.current = true; return {}; }
  });
  const [draftSaveFailed, setDraftSaveFailed] = useState(false);
  useEffect(() => {
    if (!persistDrafts || draftReadError.current) return;
    try { localStorage.setItem(draftKey, JSON.stringify(drafts)); setDraftSaveFailed(false); }
    catch { setDraftSaveFailed(true); }
  }, [drafts, draftKey, persistDrafts]);
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
  const dirty = draftReadError.current || Object.keys(configDrafts).length > 0 || (!persistDrafts || draftSaveFailed) && Object.values(drafts).some(draft => !!draft.text || draft.attachments.length > 0 || !!draft.context)
    || (snapshot.requests ?? []).some(request => Object.values(nativeAnswers[request.key] ?? {}).some(Boolean))
    || (snapshot.humanReviews ?? []).some(review => review.status === 'pending' && !!reviewAnswers[review.id]);
  useEffect(() => { onDirty?.(dirty); }, [dirty, onDirty]);
  const draft = drafts[selected?.id ?? ''] ?? { text: '', attachments: [] };
  const [catalog, setCatalog] = useState<CapabilityCatalog | null>(null);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const catalogRequest = useRef(0);
  const catalogNodeId = useRef<string | null>(selected?.id ?? null);
  catalogNodeId.current = selected?.id ?? null;
  const [historyOpen, setHistoryOpen] = useState(false);
  const [reviewsOpen, setReviewsOpen] = useState(false);
  const questions = (snapshot.requests ?? []).filter(request => classifyNativeRequest(request) === 'question');
  const pendingReviews = (snapshot.humanReviews ?? []).filter(review => review.status === 'pending');
  function renderNativeRequest(request: PendingNativeRequest) {
    return <NativeRequestCard key={request.key} request={request} answerDraft={nativeAnswers[request.key] ?? {}} onAnswerChange={answers => setNativeAnswers(current => ({ ...current, [request.key]: answers }))}
      item={snapshot.conversation?.find(entry => entry.nodeId === request.nodeId && entry.itemId === request.params?.itemId)?.content}
      onOpenUrl={url => { if (request.nodeId ?? selected?.id) void openResource((request.nodeId ?? selected?.id)!, { url }); }}
      onRespond={async result => { await execute({ type: 'respond_native', projectId: project.id, requestKey: request.key, result }); }} onError={onError} />;
  }
  const sessionRequest = useRef(0);
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
    setLatestConversation({ nodeId: workRequest.nodeId }); setSelectedId(workRequest.nodeId); setTab('conversation'); setDetailsOpen(true); setLocation(null);
    if (workRequest.text || workRequest.attachments?.length) setDrafts(current => {
      const previous = current[workRequest.nodeId] ?? { text: '', attachments: [] };
      return { ...current, [workRequest.nodeId]: { ...previous, text: workRequest.text ? (previous.text ? `${previous.text}\n\n${workRequest.text}` : workRequest.text) : previous.text, attachments: [...previous.attachments, ...(workRequest.attachments ?? [])], context: workRequest.context ?? previous.context } };
    });
    if (workRequest.messageId) locateMessage(workRequest.messageId);
    else if (workRequest.taskId && !snapshot.nodes.some(node => node.id === workRequest.nodeId)) void openProjectHistory();
  }, [workRequest?.id]);
  const [retry, setRetry] = useState<TaskView | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [attaching, setAttaching] = useState(false);
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
  const ongoing = selected && ['running', 'pausing', 'resuming'].includes(selected.status) && [...nodeEntries].reverse().find(entry => entry.direction === 'event' && ['inProgress', 'running', 'started'].includes(entry.status ?? '') && snapshot.tasks.some(task => task.id === entry.taskId && task.turnId === entry.turnId && task.status === 'running'));
  const loadedHistory = useRef(new Set<string>());
  useEffect(() => {
    if (selected?.threadId && !selected.historyPending && nativeConnected && !loadedHistory.current.has(selected.threadId)) {
      loadedHistory.current.add(selected.threadId);
      void execute({ type: 'read_history', projectId: project.id, nodeId: selected.id }).then(reply => { if (!reply || reply.historyPending) loadedHistory.current.delete(selected.threadId!); });
    }
  }, [selected?.id, selected?.threadId, selected?.historyPending, nativeConnected]);
  useEffect(() => {
    setCatalog(null);
    if (tab === 'config') void reloadCatalog(selected?.id ?? null);
    return () => { catalogRequest.current++; };
  }, [selected?.id, selected?.threadId, tab]);
  async function reloadCatalog(nodeId: string | null = catalogNodeId.current, errors: string[] = []) {
    const request = ++catalogRequest.current; setLoadingCatalog(true);
    try { const reply = await execute({ type: 'catalog', projectId: project.id, ...(nodeId ? { nodeId } : {}) }); if (request === catalogRequest.current && nodeId === catalogNodeId.current) setCatalog(reply?.catalog ? { ...reply.catalog, errors: [...new Set([...errors, ...reply.catalog.errors])] } : null); }
    finally { if (request === catalogRequest.current) setLoadingCatalog(false); }
  }
  async function openProjectHistory() {
    const request = sessionRequest.current;
    setHistoryOpen(true); setHistoryLoading(true); setHistoryFailures([]);
    const failed: string[] = [];
    try {
      for (const node of historyNodes.filter(node => node.threadId && !node.threadId.startsWith('demo-'))) {
        const reply = await execute({ type: 'read_history', projectId: project.id, nodeId: node.id });
        if (!reply || reply.historyPending) failed.push(node.name);
        if (request !== sessionRequest.current) return;
      }
      setHistoryFailures(failed);
    } finally { if (request === sessionRequest.current) setHistoryLoading(false); }
  }
  function locateMessage(messageId: string) {
    const sourceNodeId = snapshot.messages?.find(message => message.message_id === messageId)?.fromNodeId
      ?? entries.find(entry => entry.messageId === messageId && entry.direction === 'event')?.nodeId;
    const inNode = snapshot.nodes.some(node => node.id === sourceNodeId) && entries.some(entry => entry.messageId === messageId && entry.nodeId === sourceNodeId);
    setLocation({ messageId, sourceNodeId, history: !inNode });
    if (inNode) { setSelectedId(sourceNodeId!); setTab('conversation'); setDetailsOpen(true); setHistoryOpen(false); }
    else void openProjectHistory();
  }
  function updateDraft(patch: Partial<typeof draft>, nodeId = selected?.id) { if (nodeId) setDrafts(current => ({ ...current, [nodeId]: { ...(current[nodeId] ?? { text: '', attachments: [] }), ...patch } })); }
  function updateConfigDraft(nodeId: string, draft: DraftNode | null) {
    setConfigDrafts(current => { const next = { ...current }; if (draft) next[nodeId] = draft; else delete next[nodeId]; return next; });
  }
  function configSaved(submitted: DraftNode, updated: NodeView) {
    setConfigDrafts(current => {
      const next = { ...current }, latest = next[submitted.id];
      if (!latest || latest === submitted) delete next[submitted.id];
      else next[submitted.id] = { ...latest, revision: updated.revision };
      return next;
    });
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
  async function send(event: FormEvent) {
    event.preventDefault(); if (!selected || (!draft.text.trim() && !draft.attachments.length)) return;
    const nodeId = selected.id; const input: NativeInput[] = [...(draft.text ? [{ type: 'text', text: draft.text, text_elements: [] }] : []), ...draft.attachments];
    const references = [...new Map([...(draft.context?.references ?? []), ...referencesIn(draft.text, project.id)].map(reference => [`${reference.kind}:${reference.id}`, reference])).values()];
    const work_context = draft.context || references.length ? { primary_issue_id: draft.context?.primary_issue_id ?? draft.context?.primary_todo_id ?? null, references } : undefined;
    if (await execute({ type: 'send_message', projectId: project.id, nodeId, input, mode, ...(work_context ? { work_context } : {}) })) {
      setDrafts(current => current[nodeId] === draft ? { ...current, [nodeId]: { text: '', attachments: [] } } : current);
      setTab('conversation');
    }
  }
  async function attach() {
    if (!selected) return; const nodeId = selected.id, request = sessionRequest.current; setAttaching(true);
    try { const input = await window.mixcat.chooseAttachments(project.id, nodeId); if (request === sessionRequest.current && input.length) setDrafts(current => { const previous = current[nodeId] ?? { text: '', attachments: [] }; return { ...current, [nodeId]: { ...previous, attachments: [...previous.attachments, ...input] } }; }); }
    catch (error) { if (request === sessionRequest.current) onError(error instanceof Error ? error.message : String(error)); } finally { if (request === sessionRequest.current) setAttaching(false); }
  }
  async function openResource(nodeId: string, resource: { path?: string; url?: string }) {
    const targetNode = snapshot.nodes.find(node => node.id === nodeId) ?? selected;
    if (!targetNode) { onError('此节点已移除。请先添加一个会话节点，再从项目历史中打开资源；原文件与历史仍然保留。'); return; }
    const request = ++resourceRequest.current;
    try { await window.mixcat.panel({ type: 'open', projectId: project.id, nodeId: targetNode.id, target: resource.path ? { type: 'file', path: resource.path } : { type: 'url', url: resource.url! } }); if (request !== resourceRequest.current) return; setSelectedId(targetNode.id); setTab('panels'); setHistoryOpen(false); setReviewsOpen(false); setDetailsOpen(true); }
    catch (error) { if (request === resourceRequest.current) onError(error instanceof Error ? error.message : String(error)); }
  }
  async function saveNode(node: DraftNode) { const reply = await execute({ type: 'save_node', projectId: project.id, node }); return reply?.snapshot.selected?.nodes.find(n => n.id === node.id) ?? null; }
  const modalOpen = obscured || historyOpen || reviewsOpen || !!retry || attaching;
  useEffect(() => { onObscured?.(historyOpen || reviewsOpen || !!retry || attaching); }, [historyOpen, reviewsOpen, retry, attaching, onObscured]);
  useEffect(() => { setLatestConversation({ nodeId }); }, [nodeId]);
  useImperativeHandle(ref, () => ({
    history: () => { setLocation(null); void openProjectHistory(); }, reviews: () => setReviewsOpen(true), config: () => setTab('config'), conversation: () => setTab('conversation'),
    latest: () => { setLocation(null); setLatestConversation({ nodeId }); },
    open: path => setResourceIntent({ nodeId, path }),
    reset: () => { sessionRequest.current++; resourceRequest.current++; loadedHistory.current.clear(); for (const [key, action] of actionStore) if ('projectId' in action.command && action.command.projectId === project.id) actionStore.delete(key); setDrafts({}); setRetry(null); setConfirmed(false); setLocation(null); setHistoryOpen(false); setHistoryLoading(false); setHistoryFailures([]); setReviewsOpen(false); setTab('conversation'); },
    discard: id => { updateConfigDraft(id, null); setDrafts(current => { const next = { ...current }; delete next[id]; return next; }); }
  }));
  return <div className="session-pane" onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.stopPropagation(); if (!modalOpen) onClose(); } }}>
      {(draftSaveFailed || draftReadError.current) && <p className="inline-warning" role="alert">{draftReadError.current ? '助手草稿读取失败，原草稿未被覆盖。请核对本机草稿存储后重新打开项目；当前输入尚未持久保存。' : '助手草稿尚未持久保存，请保持此窗口并复制重要内容后再离开。'}</p>}
      {runtime?.error && <p className="runtime-error" role="alert">{runtime.error}</p>}
      <div className="detail-heading"><div><h2>{selected?.name ?? '节点详情'}</h2><button className="icon-button" aria-label="收起节点详情" title="收起节点详情" onClick={closeDetails}>×</button></div>{selected && <><div className="node-controls" role="group" aria-label="节点运行控制"><button className="button secondary compact" disabled={!!reconciliationReason || ['paused', 'pausing'].includes(selected.status)} title={reconciliationReason} onClick={() => void execute({ type: 'pause_node', projectId: project.id, nodeId: selected.id })}>暂停节点</button><button className="button secondary compact" disabled={!!reconciliationReason || !['paused', 'pausing'].includes(selected.status)} title={reconciliationReason} onClick={() => void execute({ type: 'resume_node', projectId: project.id, nodeId: selected.id })}>启用节点</button>{onDelete && <button className="button secondary compact danger-button" disabled={busy || !!deleteReason} title={deleteReason ?? '移除节点并保留会话历史与项目文件'} onClick={() => onDelete?.(selected.id)}>删除节点</button>}</div>{reconciliationReason && <p className="field-note" role="status">{reconciliationReason}</p>}{deleteReason && <p className="field-note">{deleteReason}</p>}{selected.status === 'pausing' && <p className="field-note">正在等待原生轮次停止；可直接启用节点覆盖暂停。</p>}{selected.status === 'resuming' && <p className="field-note">已请求启用，等待原生轮次停止后续接。</p>}</>}</div>
      {selected ? <>
        <div className="detail-tabs" role="tablist" aria-label="节点详情栏目">{([['conversation', '会话'], ['config', '配置'], ['panels', '工作面板']] as const).map(([value, label]) => <button key={value} id={`tab-${value}`} role="tab" aria-selected={tab === value} className={tab === value ? 'active' : ''} onClick={() => { setTab(value); }}>{label}</button>)}</div>
        {ongoing && <div className="current-activity" role="status"><span className="local-indicator" />{ongoing.text || '正在处理原生工具调用'}</div>}
        <div className="detail-scroll session-scroll" hidden={tab === 'panels'}><div hidden={tab !== 'conversation'}>{reviewWaits.length > 0 && <div className="field-note" role="status">{reviewWaits.length} 条任务等待人工核对。输入会保存，通过后才执行。{reviewWaits.map(task => <p key={task.id}>{task.error}{task.reviewDependencies?.map(dependency => `${snapshot.reviewPolicy?.checkpoints.find(point => point.id === dependency.checkpointId)?.name ?? dependency.checkpointId} · ${dependency.reviewId === null ? '等待首次提交' : `版本 ${dependency.version} 待通过或依据已过期`}`).join('；')}</p>)}</div>}{(snapshot.requests ?? []).filter(request => !request.nodeId || request.nodeId === selected.id).map(renderNativeRequest)}<HumanReviews actionStore={actionStore} project={project} policy={snapshot.reviewPolicy ?? { revision: 0, checkpoints: [] }} reviews={snapshot.humanReviews ?? []} tasks={snapshot.tasks} nodes={historyNodes} execute={execute} onOpen={openResource} onError={onError} nodeId={selected.id} answerDrafts={reviewAnswers} onAnswerChange={(id, answer) => setReviewAnswers(current => ({ ...current, [id]: answer }))} /><ConversationFeed entries={nodeEntries} latestRequest={latestConversation?.nodeId === selected.id ? latestConversation : undefined} nodes={snapshot.nodes} tasks={snapshot.tasks} messages={snapshot.messages} projectRoot={project.root} locatedEntryId={workRequest?.taskId && !workRequest.messageId ? entries.find(entry => entry.taskId === workRequest.taskId && entry.direction === 'input')?.id : location?.history ? undefined : locatedEntry?.id} locationRequest={workRequest?.taskId && !workRequest.messageId ? workRequest : location?.history ? undefined : location ?? undefined} onLocateMessage={locateMessage} onOpen={openResource} onRetry={task => { setRetry(task); setConfirmed(false); }} /></div><div hidden={tab !== 'config'}><NodeConfig comfy={project.template === 'comfyui'} key={selected.id} node={selected} draft={configDrafts[selected.id]} onDraftChange={draft => updateConfigDraft(selected.id, draft)} tasks={snapshot.tasks} saving={configAutosave.savingId === selected.id} saveFailed={configAutosave.failed} onRetry={configAutosave.retry} catalog={catalog} loading={loadingCatalog} onReload={() => void reloadCatalog()} /></div></div>
        <div className="panels-container" hidden={tab !== 'panels'}><NodePanels key={selected.id} projectId={project.id} nodeId={selected.id} visible={detailsOpen && tab === 'panels' && !modalOpen && !resizingDetails} /></div>
        <form className="task-composer node-composer" hidden={tab === 'panels'} onSubmit={send}><div className="composer-header"><label htmlFor="task-instruction">发送给 <strong>{selected.name}</strong>{pendingTasks > 0 && <span> · {pendingTasks} 条排队中</span>}</label></div><ReferenceEditor submitOnEnter id="task-instruction" projectId={project.id} value={draft.text} onChange={text => updateDraft({ text })} execute={execute} label="节点消息" placeholder={`给「${selected.name}」发送消息…，@ 引用项目内容`} rows={3} />{(draft.context?.primary_issue_id ?? draft.context?.primary_todo_id) && <p className="composer-work-context">已关联 Issue<button type="button" className="text-button" onClick={() => updateDraft({ context: undefined })}>解除工作关联</button></p>}{draft.attachments.length > 0 && <div className="attachment-list">{draft.attachments.map((item, i) => <span key={i}>{attachmentLabel(item)}<button type="button" className="icon-button" aria-label={`移除附件 ${i + 1}`} onClick={() => updateDraft({ attachments: draft.attachments.filter((_, index) => index !== i) })}>×</button></span>)}</div>}<div className="composer-bottom"><button type="button" className="text-button" disabled={attaching} onClick={() => void attach()}>{attaching ? '添加中…' : '＋ 添加附件'}</button><span>{['paused', 'pausing'].includes(selected.status) ? '消息将排队，启用节点后处理' : selected.status === 'resuming' ? '等待当前轮次停止后继续处理' : ['starting', 'running'].includes(selected.status) ? '消息会按顺序继续处理' : ''}</span><button type="submit" className="button primary" disabled={busy || (!draft.text.trim() && !draft.attachments.length)}>发送</button></div></form>
      </> : <div className="panel-empty"><h3>{nodeId ? '会话节点已移除' : '添加一个会话节点'}</h3><p>{nodeId ? '可从项目会话历史查看已有记录；请明确选择已有节点继续。' : '在画布空白处右键，选择模型、名称和能力。'}</p></div>}
    {reviewsOpen && <Dialog title="待人工核对" onClose={() => setReviewsOpen(false)}>{error && <p className="inline-error" role="alert">{error}</p>}<p className="field-note">节点中的 Codex 需要你补充信息或确认时，会在这里提问。回答会返回发起问题的会话。</p>{!questions.length && !pendingReviews.length && <p className="field-note">当前没有节点等待你的回答。</p>}{questions.map(request => <div key={request.key}><h3>{historyNodes.find(node => node.id === request.nodeId)?.name ?? '项目会话'}</h3>{renderNativeRequest(request)}</div>)}<HumanReviews actionStore={actionStore} project={project} policy={snapshot.reviewPolicy ?? { revision: 0, checkpoints: [] }} reviews={snapshot.humanReviews ?? []} tasks={snapshot.tasks} nodes={historyNodes} execute={execute} onOpen={openResource} onError={onError} answerDrafts={reviewAnswers} onAnswerChange={(id, answer) => setReviewAnswers(current => ({ ...current, [id]: answer }))} /></Dialog>}
    {historyOpen && <Dialog title="项目会话历史" wide onClose={() => setHistoryOpen(false)}><p className="field-note">所有节点按时间排列 · 未知时间置后按记录顺序 · {entries.length} 条记录{historyLoading ? ' · 正在补齐原生历史…' : ''}</p>{historyFailures.length > 0 && <p className="inline-warning">以下节点的原生历史暂未完整载入：{historyFailures.join('、')}。当前展示已保存记录。</p>}{location?.history && !historyLoading && <p className="field-note" role="status">{locatedSource ? (snapshot.nodes.some(node => node.id === location.sourceNodeId) ? '已在项目历史定位原消息。' : '来源节点已移除，已在项目历史定位原消息。') : locatedEntry ? '来源节点的原始发送记录缺失，已定位保留的接收记录。' : '未找到原消息记录，当前已保存历史及可读取的原生历史中均无此条目。'}</p>}<ConversationFeed entries={entries} nodes={historyNodes} tasks={snapshot.tasks} messages={snapshot.messages} projectRoot={project.root} locatedEntryId={workRequest?.taskId && !workRequest.messageId && !historyLoading ? entries.find(entry => entry.taskId === workRequest.taskId && entry.direction === 'input')?.id : location?.history && !historyLoading ? locatedEntry?.id : undefined} locationRequest={workRequest?.taskId && !workRequest.messageId ? workRequest : location?.history ? location : undefined} onLocateMessage={locateMessage} projectTimeline onOpen={openResource} /></Dialog>}
    {retry && <Dialog title="核对任务后重试" onClose={() => setRetry(null)}><div className="form-stack"><p className="inline-warning">请核对上次执行和已有成果，避免重复操作。</p><p>{retry.instruction}</p><label className="confirm-choice"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />我已核对，确认可以重试</label><button className="button primary" disabled={!confirmed || busy} onClick={async () => { if (await execute({ type: 'retry_task', projectId: project.id, taskId: retry.id, confirmed: true })) setRetry(null); }}>确认重试</button></div></Dialog>}
  </div>;
}
