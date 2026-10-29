import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { Handle, MarkerType, Panel, Position, ReactFlow, useNodesState, type Edge, type Node, type NodeProps, type ReactFlowInstance } from '@xyflow/react';
import type { AppCommand, AppReply, AppSnapshot, CapabilityCatalog, EdgeLayout, NativeInput, NodeDefinition, NodeView, ProjectSnapshot, TaskView, WorkflowEdge, WorkflowGroup } from '../shared/types';
import { EditableEdge } from './EditableEdge';
import { arrangeWorkflow, workflowBounds } from './workflow-layout';
import { groupBounds, projectEdgeBounds } from './group-geometry';
import { GroupNode, GroupEditor, type GroupCanvasNode } from './WorkflowGroups';
import { NodeConfig, NewNodeForm, type DraftNode } from './NodeSettings';
import { ConversationFeed } from './Conversation';
import { NativeRequestCard } from './NativeRequests';
import { NodePanels } from './NodePanels';
import { HumanReviews, ReviewPolicyEditor, type ReviewAction } from './HumanReviews';
import { ReferenceEditor } from './ReferenceEditor';
import { referencesIn, type WorkContext } from '../shared/project-items';
import type { WorkbenchRequest } from './ProjectManagement';

type Execute = (command: AppCommand, actionId?: string) => Promise<AppReply | null>;
type WorkflowNode = Node<{ node: NodeView }, 'conversation'>;
type CanvasNode = WorkflowNode | GroupCanvasNode;
const labels: Record<string, string> = { idle: '空闲', starting: '启动中', running: '运行中', pausing: '暂停中', resuming: '等待续接', paused: '已暂停', blocked: '需处理', completed: '已完成', queued: '排队中', failed: '失败', needs_reconciliation: '状态待核对', cancelled: '已取消' };

export function relatedNodePosition(position: NodeDefinition['position'], occupied: { position: NodeDefinition['position']; measured?: { width?: number; height?: number } }[]) {
  const candidate = { ...position }, width = 215, height = 200, gap = 24;
  while (occupied.some(node => candidate.x < node.position.x + (node.measured?.width ?? width) + gap && candidate.x + width + gap > node.position.x
    && candidate.y < node.position.y + (node.measured?.height ?? height) + gap && candidate.y + height + gap > node.position.y)) candidate.y += 230;
  return candidate;
}

export function toWorkflowEdges(definitions: WorkflowEdge[], nodes: NodeView[], onEdit: (edge: WorkflowEdge) => void, selectedNodeId?: string): Edge[] {
  const ids = new Set(nodes.map(node => node.id));
  return definitions.filter(edge => ids.has(edge.sourceNodeId) && ids.has(edge.targetNodeId)).map(edge => {
    const highlighted = edge.sourceNodeId === selectedNodeId || edge.targetNodeId === selectedNodeId;
    return {
    id: `definition:${edge.id}`, source: edge.sourceNodeId, target: edge.targetNodeId, type: 'condition',
    data: { definitionId: edge.id, definition: edge, onEdit, highlighted },
    markerEnd: { type: MarkerType.ArrowClosed, color: highlighted ? '#2563eb' : '#888888' },
    style: { stroke: highlighted ? '#2563eb' : '#888888', strokeWidth: highlighted ? 3 : 1.5, opacity: 1 },
  }; });
}
function Status({ value }: { value: string }) { return <span className={`status status-${value}`}><span />{labels[value] ?? value}</span>; }
function Dialog({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); return () => ref.current?.close(); }, []);
  return <dialog className={`modal ${wide ? 'wide-modal' : ''}`} ref={ref} onCancel={event => { event.preventDefault(); onClose(); }} aria-label={title}><div className="modal-heading"><h2>{title}</h2><button className="icon-button" aria-label="关闭弹窗" onClick={onClose}>×</button></div>{children}</dialog>;
}
function ConversationNode({ data, selected }: NodeProps<WorkflowNode>) {
  const node = data.node;
  return <div className={`conversation-node ${selected ? 'is-selected' : ''}`}><Handle type="target" position={Position.Left} isConnectable={false} /><div className="node-top"><Status value={node.status} /></div><h3>{node.name}</h3><p>{node.instructions || '独立 Codex 会话'}</p>{node.model && <div className="node-model" title={node.model}>{node.model}</div>}<Handle type="source" position={Position.Right} isConnectable={false} /><Handle id="return-source" type="source" position={Position.Bottom} style={{ left: '38%' }} isConnectable={false} /><Handle id="return-target" type="target" position={Position.Bottom} style={{ left: '62%' }} isConnectable={false} /></div>;
}
const nodeTypes = { conversation: ConversationNode, workflowGroup: GroupNode };
const edgeTypes = { condition: EditableEdge };
function attachmentLabel(input: NativeInput) {
  if (typeof input.path === 'string') return input.path.split(/[\\/]/).at(-1);
  if (typeof input.text === 'string') return input.text.split('\n')[0].replace(/^附件：/, '');
  return String(input.name ?? input.type);
}

export function Workbench({ snapshot, runtime, execute, busy, pendingExecution = false, error, onError, reviewActions, obscured = false, workRequest, onDirty }: { snapshot: ProjectSnapshot; runtime: AppSnapshot['runtime']; execute: Execute; busy: boolean; pendingExecution?: boolean; error: string | null; onError: (error: string) => void; reviewActions?: Map<string, ReviewAction>; obscured?: boolean; workRequest?: WorkbenchRequest; onDirty?: (dirty: boolean) => void }) {
  const { project } = snapshot;
  const localReviewActions = useRef(new Map<string, ReviewAction>());
  const actionStore = reviewActions ?? localReviewActions.current;
  const [selectedId, setSelectedId] = useState(snapshot.nodes[0]?.id ?? '');
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const selected = snapshot.nodes.find(node => node.id === selectedId) ?? snapshot.nodes[0];
  const [tab, setTab] = useState<'conversation' | 'config' | 'panels'>('conversation');
  const [detailsOpen, setDetailsOpen] = useState(true);
  const canvasFocus = useRef<HTMLDivElement>(null);
  const detailsBody = useRef<HTMLDivElement>(null);
  const [detailsWidth, setDetailsWidth] = useState(420);
  const [resizingDetails, setResizingDetails] = useState(false);
  function resizeDetails(width: number) { setDetailsWidth(Math.max(320, Math.min(width, Math.max(320, (detailsBody.current?.clientWidth ?? 690) - 270)))); }
  useEffect(() => {
    const body = detailsBody.current; if (!body) return;
    const observer = new ResizeObserver(() => setDetailsWidth(width => Math.max(320, Math.min(width, Math.max(320, body.clientWidth - 270)))));
    observer.observe(body); return () => observer.disconnect();
  }, []);
  function closeDetails() { setResizingDetails(false); setDetailsOpen(false); canvasFocus.current?.focus(); }
  const mode = project.mode;
  const [drafts, setDrafts] = useState<Record<string, { text: string; attachments: NativeInput[]; context?: WorkContext }>>({});
  const [configDrafts, setConfigDrafts] = useState<Record<string, DraftNode>>({});
  const dirty = Object.keys(configDrafts).length > 0 || Object.values(drafts).some(draft => !!draft.text || draft.attachments.length > 0 || !!draft.context);
  useEffect(() => { onDirty?.(dirty); }, [dirty, onDirty]);
  const draft = drafts[selected?.id] ?? { text: '', attachments: [] };
  const [catalog, setCatalog] = useState<CapabilityCatalog | null>(null);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const catalogRequest = useRef(0);
  const catalogNodeId = useRef<string | null>(selected?.id ?? null);
  const [nodes, setNodes, onNodesChange] = useNodesState<WorkflowNode>([]);
  const [pendingMoves, setPendingMoves] = useState(new Map<string, NodeDefinition['position']>());
  const [arranging, setArranging] = useState(false);
  const [arrangePreview, setArrangePreview] = useState<Record<string, EdgeLayout> | null>(null);
  const flow = useRef<ReactFlowInstance<CanvasNode> | null>(null);
  const restoredView = useRef(false);
  const dragging = useRef(false);
  const groupDrag = useRef<{ origin: NodeDefinition['position']; positions: Map<string, NodeDefinition['position']> } | null>(null);
  const [groupDraft, setGroupDraft] = useState<WorkflowGroup | null>(null);
  const [groupSaving, setGroupSaving] = useState(false);
  const groups = snapshot.groups ?? [];
  const [menu, setMenu] = useState<{ x: number; y: number; position: NodeDefinition['position']; nodeId?: string; groupId?: string } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [creation, setCreation] = useState<{ position: NodeDefinition['position']; relatedTo?: string } | null>(null);
  catalogNodeId.current = creation ? null : selected?.id ?? null;
  const [edgeDraft, setEdgeDraft] = useState<WorkflowEdge | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [reviewPolicyOpen, setReviewPolicyOpen] = useState(false);
  const [reviewsOpen, setReviewsOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const resetInFlight = useRef(false);
  const sessionRequest = useRef(0);
  const resourceRequest = useRef(0);
  useEffect(() => { resourceRequest.current++; return () => { resourceRequest.current++; }; }, [project.id, selected?.id, tab, detailsOpen, historyOpen, reviewsOpen, obscured]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyFailures, setHistoryFailures] = useState<string[]>([]);
  const [location, setLocation] = useState<{ messageId: string; sourceNodeId?: string; history: boolean } | null>(null);
  useEffect(() => {
    if (!workRequest) return;
    setSelectedId(workRequest.nodeId); setTab('conversation'); setDetailsOpen(true); setLocation(null);
    if (workRequest.text) setDrafts(current => {
      const previous = current[workRequest.nodeId] ?? { text: '', attachments: [] };
      return { ...current, [workRequest.nodeId]: { ...previous, text: previous.text ? `${previous.text}\n\n${workRequest.text}` : workRequest.text!, context: workRequest.context } };
    });
    if (workRequest.messageId) locateMessage(workRequest.messageId);
    else if (workRequest.taskId && !snapshot.nodes.some(node => node.id === workRequest.nodeId)) void openProjectHistory();
  }, [workRequest?.id]);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [retry, setRetry] = useState<TaskView | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const nativeConnected = runtime?.mode === 'codex' && runtime.connected;
  const reconciliationNodes = new Set(snapshot.tasks.filter(task => task.status === 'needs_reconciliation').map(task => task.nodeId));
  const reconciliationReason = selected && reconciliationNodes.has(selected.id) ? '上次执行结果待核对，请先查看会话记录，再决定是否重试。' : undefined;
  const canPauseAll = snapshot.nodes.some(node => !reconciliationNodes.has(node.id) && !['paused', 'pausing'].includes(node.status));
  const resumableNodes = snapshot.nodes.filter(node => !reconciliationNodes.has(node.id) && snapshot.resumeNodeIds?.includes(node.id) && ['paused', 'pausing'].includes(node.status));
  const canResumeAll = resumableNodes.length > 0 || snapshot.nodes.some(node => node.status === 'paused' && !snapshot.tasks.some(task => task.nodeId === node.id && ['running', 'paused', 'queued', 'waiting_source', 'needs_reconciliation'].includes(task.status)));
  const historyNodes = [...snapshot.nodes, ...(snapshot.archivedNodes ?? []).map(node => ({ ...node, name: `${node.name}（已移除）` }))];
  const deletingNode = snapshot.nodes.find(node => node.id === deletingId);
  const resetReason = pendingExecution || snapshot.tasks.some(task => !['completed', 'failed', 'cancelled'].includes(task.status))
    || snapshot.nodes.some(node => ['starting', 'running', 'pausing', 'resuming'].includes(node.status))
    ? '工作流仍有未完成任务或启动操作，请先停止本轮并核对后重置。'
    : snapshot.requests?.length ? '工作流仍有待回应请求，请先处理请求后重置。' : null;
  function deletionBlockReason(nodeId: string) {
    if (groups.some(group => group.coordinatorNodeId === nodeId)) return '请先更换分组协调节点或解除分组，再删除此节点。';
    if (snapshot.reviewPolicy?.checkpoints.some(point => point.ownerNodeId === nodeId || point.requiredForNodeIds.includes(nodeId)) || snapshot.humanReviews?.some(review => review.nodeId === nodeId && review.status === 'pending'))
      return '节点仍被核对规则或待核对事项引用，请先调整规则或撤回事项。';
    if (snapshot.tasks.some(task => task.nodeId === nodeId && ['running', 'paused', 'queued', 'waiting_source', 'waiting_review', 'needs_reconciliation'].includes(task.status))
      || snapshot.nodes.some(node => node.id === nodeId && ['starting', 'running', 'pausing', 'resuming'].includes(node.status)))
      return '节点仍有未完成任务。请先停止本轮，并核对状态待确认的任务后再删除。';
    if (snapshot.requests?.some(request => !request.nodeId || request.nodeId === nodeId))
      return '节点仍有原生请求待回应。请先处理请求，或停止本轮并核对任务后再删除。';
    return null;
  }
  const deleteReason = selected ? deletionBlockReason(selected.id) : null;
  const entries = snapshot.conversation ?? [];
  const nodeEntries = entries.filter(entry => entry.nodeId === selected?.id);
  const locatedSource = location && entries.find(entry => entry.messageId === location.messageId && entry.nodeId === location.sourceNodeId);
  const locatedEntry = locatedSource || (location?.history ? entries.find(entry => entry.messageId === location.messageId) : undefined);
  const pendingTasks = snapshot.tasks.filter(task => task.nodeId === selected?.id && task.status === 'queued').length;
  const reviewWaits = snapshot.tasks.filter(task => task.nodeId === selected?.id && task.status === 'waiting_review');
  const ongoing = selected && ['running', 'pausing', 'resuming'].includes(selected.status) && [...nodeEntries].reverse().find(entry => entry.direction === 'event' && ['inProgress', 'running', 'started'].includes(entry.status ?? '') && snapshot.tasks.some(task => task.id === entry.taskId && task.turnId === entry.turnId && task.status === 'running'));
  const definitions = snapshot.edges ?? [];
  const visibleLayouts = arrangePreview ?? snapshot.edgeLayouts ?? {};
  const edges = useMemo<Edge[]>(() => toWorkflowEdges(definitions, snapshot.nodes, setEdgeDraft, selected?.id).map(edge => {
    const id = String(edge.data!.definitionId), editing = selectedEdgeId === id;
    const projected = groups.length ? projectEdgeBounds(edge.data!.definition as WorkflowEdge, groups, nodes, definitions, visibleLayouts) : null;
    return { ...edge, selected: editing,
      data: { ...edge.data, disabled: arranging, sourceBounds: projected?.source, targetBounds: projected?.target, layout: arrangePreview && Object.hasOwn(arrangePreview, id) ? arrangePreview[id] : Object.hasOwn(snapshot.edgeLayouts ?? {}, id) ? snapshot.edgeLayouts![id] : undefined, onLayout: async (edgeId: string, layout: EdgeLayout) => {
        const layouts = (await execute({ type: 'save_edge_layout', projectId: project.id, edgeId, layout }))?.snapshot.selected?.edgeLayouts;
        return layouts && Object.hasOwn(layouts, edgeId) ? layouts[edgeId] : null;
      } },
      markerEnd: editing ? { type: MarkerType.ArrowClosed, color: '#2563eb' } : edge.markerEnd,
      style: editing ? { ...edge.style, stroke: '#2563eb', strokeWidth: 3 } : edge.style };
  }), [snapshot.nodes, definitions, selected?.id, snapshot.edgeLayouts, selectedEdgeId, execute, project.id, arranging, arrangePreview, snapshot.groups, nodes]);
  useEffect(() => {
    if (dragging.current) return;
    setNodes(current => snapshot.nodes.map(node => ({ ...current.find(item => item.id === node.id), id: node.id, position: pendingMoves.get(node.id) ?? node.position, type: 'conversation', data: { node }, selected: selected?.id === node.id, ariaLabel: `${node.name}，${labels[node.status]}` })));
  }, [snapshot.nodes, selected?.id, pendingMoves, setNodes]);
  useEffect(() => {
    if (restoredView.current || !flow.current || !nodes.length || nodes.some(node => !node.measured?.width || !node.measured?.height)) return;
    if (!Object.values(snapshot.edgeLayouts ?? {}).some(layout => layout.route)) { restoredView.current = true; return; }
    const bounds = workflowBounds(nodes, definitions, snapshot.edgeLayouts ?? {}, groups);
    const frame = requestAnimationFrame(() => { restoredView.current = true; void flow.current?.fitBounds(bounds, { padding: .08 }); });
    return () => cancelAnimationFrame(frame);
  }, [nodes, definitions, snapshot.edgeLayouts, snapshot.groups]);
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const close = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as HTMLElement)) setMenu(null); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(null); };
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', key); };
  }, [menu]);
  const loadedHistory = useRef(new Set<string>());
  useEffect(() => {
    if (selected?.threadId && !selected.historyPending && nativeConnected && !loadedHistory.current.has(selected.threadId)) {
      loadedHistory.current.add(selected.threadId);
      void execute({ type: 'read_history', projectId: project.id, nodeId: selected.id }).then(reply => { if (!reply || reply.historyPending) loadedHistory.current.delete(selected.threadId!); });
    }
  }, [selected?.id, selected?.threadId, selected?.historyPending, nativeConnected]);
  useEffect(() => {
    setCatalog(null);
    if (tab === 'config' || creation) void reloadCatalog(creation ? null : selected?.id ?? null);
    return () => { catalogRequest.current++; };
  }, [selected?.id, selected?.threadId, tab, !!creation]);
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
  async function resetWorkflow() {
    if (busy || resetInFlight.current || resetReason || attaching) return;
    resetInFlight.current = true; setResetting(true);
    try {
      if (!(await execute({ type: 'reset_workflow', projectId: project.id, confirmed: true }))) return;
      sessionRequest.current++; resourceRequest.current++;
      loadedHistory.current.clear();
      for (const [key, action] of actionStore) if ('projectId' in action.command && action.command.projectId === project.id) actionStore.delete(key);
      setDrafts({}); setRetry(null); setConfirmed(false); setLocation(null);
      setHistoryOpen(false); setHistoryLoading(false); setHistoryFailures([]); setReviewsOpen(false);
      setTab('conversation'); setResetOpen(false);
    } finally { resetInFlight.current = false; setResetting(false); }
  }
  function locateMessage(messageId: string) {
    const sourceNodeId = snapshot.messages?.find(message => message.message_id === messageId)?.fromNodeId
      ?? entries.find(entry => entry.messageId === messageId && entry.direction === 'event')?.nodeId;
    const inNode = snapshot.nodes.some(node => node.id === sourceNodeId) && entries.some(entry => entry.messageId === messageId && entry.nodeId === sourceNodeId);
    setLocation({ messageId, sourceNodeId, history: !inNode });
    if (inNode) { setSelectedId(sourceNodeId!); setTab('conversation'); setDetailsOpen(true); setHistoryOpen(false); }
    else void openProjectHistory();
  }
  function create(position: NodeDefinition['position'], relatedTo?: string) { setCreation({ position: relatedTo ? relatedNodePosition(position, nodes) : position, relatedTo }); setMenu(null); }
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
  function editGroup(group?: WorkflowGroup, initialId?: string) {
    const nodeId = initialId && !groups.some(item => item.nodeIds.includes(initialId)) ? initialId : snapshot.nodes.find(node => !groups.some(item => item.nodeIds.includes(node.id)))?.id;
    setGroupDraft(group ? { ...group, nodeIds: [...group.nodeIds] } : { id: crypto.randomUUID(), name: '新分组', nodeIds: nodeId ? [nodeId] : [], coordinatorNodeId: nodeId ?? '', revision: 0 });
    setMenu(null);
  }
  async function moveMembers(positions: { nodeId: string; position: NodeDefinition['position'] }[]) {
    dragging.current = false; groupDrag.current = null;
    setPendingMoves(current => { const next = new Map(current); for (const item of positions) next.set(item.nodeId, item.position); return next; });
    try { await execute({ type: 'move_nodes', projectId: project.id, positions }); }
    finally { setPendingMoves(current => { const next = new Map(current); for (const item of positions) if (next.get(item.nodeId) === item.position) next.delete(item.nodeId); return next; }); }
  }
  function groupPositions(position: NodeDefinition['position']) {
    const active = groupDrag.current;
    return active ? [...active.positions].map(([nodeId, original]) => ({ nodeId, position: { x: original.x + position.x - active.origin.x, y: original.y + position.y - active.origin.y } })) : [];
  }
  function moveGroupPreview(position: NodeDefinition['position']) {
    const positions = new Map(groupPositions(position).map(item => [item.nodeId, item.position]));
    setNodes(current => current.map(node => positions.has(node.id) ? { ...node, position: positions.get(node.id)! } : node));
  }
  const canvasNodes: CanvasNode[] = [...groups.flatMap(group => {
    const bounds = groupBounds(group, nodes, definitions, visibleLayouts); if (!bounds) return [];
    let id = `group:${group.id}`; while (nodes.some(node => node.id === id)) id = `group:${id}`;
    const running = snapshot.nodes.filter(node => group.nodeIds.includes(node.id) && ['starting', 'running', 'resuming'].includes(node.status)).length;
    const disabled = arranging || !!pendingMoves.size;
    return [{ id, type: 'workflowGroup' as const, position: { x: bounds.x, y: bounds.y }, width: bounds.width, height: bounds.height, style: { width: bounds.width, height: bounds.height }, zIndex: 0, selectable: false, focusable: false, draggable: !disabled, dragHandle: '.workflow-group-title',
      data: { group, status: `${group.nodeIds.length} 个会话${running ? ` · ${running} 运行中` : ''}`, disabled, onEdit: () => editGroup(group), onMove: (delta: NodeDefinition['position']) => {
        if (!disabled && !dragging.current) void moveMembers(nodes.filter(node => group.nodeIds.includes(node.id)).map(node => ({ nodeId: node.id, position: { x: node.position.x + delta.x, y: node.position.y + delta.y } })));
      } } }];
  }), ...nodes];
  async function moveNode(dragged: WorkflowNode) {
    dragging.current = false;
    const position = { ...dragged.position };
    setPendingMoves(current => new Map(current).set(dragged.id, position));
    try { await execute({ type: 'move_node', projectId: project.id, nodeId: dragged.id, position }); }
    finally {
      setPendingMoves(current => {
        if (current.get(dragged.id) !== position) return current;
        const next = new Map(current); next.delete(dragged.id); return next;
      });
    }
  }
  async function arrange() {
    if (arranging || dragging.current || pendingMoves.size || !nodes.length) return;
    const preview = new Map<string, NodeDefinition['position']>();
    setArranging(true);
    try {
      const rect = detailsBody.current?.querySelector('.flow-wrap')?.getBoundingClientRect();
      const plan = await arrangeWorkflow(nodes, definitions, snapshot.edgeLayouts ?? {}, rect ?? undefined, groups);
      for (const item of plan.positions) preview.set(item.nodeId, item.position);
      setPendingMoves(new Map(preview)); setArrangePreview(Object.fromEntries(plan.edgeLayouts.map(item => [item.edgeId, item.layout])));
      if (await execute({ type: 'move_nodes', projectId: project.id, positions: plan.positions, edgeLayouts: plan.edgeLayouts })) {
        await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));
        await flow.current?.fitBounds(plan.bounds, { padding: .08 });
      }
    } catch (caught) { onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPendingMoves(current => { const next = new Map(current); for (const [id, position] of preview) if (next.get(id) === position) next.delete(id); return next; });
      setArrangePreview(null); setArranging(false);
    }
  }
  const modalOpen = obscured || !!creation || !!groupDraft || !!edgeDraft || historyOpen || reviewPolicyOpen || reviewsOpen || resetOpen || !!retry || !!deletingNode || !!menu || attaching;
  return <main className="workbench session-workbench">
    <header className="project-header"><div className="project-statusbar" role="group" aria-label="项目状态栏"><span className="workflow-summary">{snapshot.nodes.length} 个会话</span><button className="text-button" onClick={() => setReviewsOpen(true)}>待人工核对 {(snapshot.humanReviews ?? []).filter(review => review.status === 'pending').length}</button><div className="execution-overview" role="status" aria-label="节点执行状态">{(['running', 'starting', 'pausing', 'resuming', 'paused', 'queued', 'blocked', 'idle', 'completed'] as const).map(status => { const count = snapshot.nodes.filter(node => node.status === status).length; return (count > 0 || status === 'running') && <span key={status} data-node-status={status} className={`status-${status}`}>{labels[status]} <strong>{count}</strong></span>; })}</div><button className="button secondary compact" onClick={() => create({ x: 80 + snapshot.nodes.length % 3 * 300, y: 100 + Math.floor(snapshot.nodes.length / 3) * 230 })}>＋ 添加节点</button>{(snapshot.requests?.length ?? 0) > 0 && <button className="text-button" onClick={() => { const request = snapshot.requests![0]; if (request.nodeId) setSelectedId(request.nodeId); setTab('conversation'); setDetailsOpen(true); }}>{snapshot.requests!.length} 个请求待回应</button>}</div><div className="project-controls"><button className="button secondary compact" onClick={() => setReviewPolicyOpen(true)}>人工核对规则</button><button className="button secondary compact" disabled={historyLoading} onClick={() => { setLocation(null); void openProjectHistory(); }}>项目会话历史</button><button className="button secondary compact" disabled={!canPauseAll} onClick={() => void execute({ type: 'pause', projectId: project.id })}>全部暂停</button><button className="button secondary compact" disabled={!canResumeAll} title="续接全部暂停时记录的运行节点，其他空闲节点恢复待命" onClick={() => void execute({ type: 'resume', projectId: project.id })}>全部开启</button><button className="button secondary compact" disabled={!pendingExecution && !['running', 'pausing', 'paused', 'blocked'].includes(project.status)} onClick={() => void execute({ type: 'stop', projectId: project.id })}>停止本轮</button><button className="button secondary compact danger-button" disabled={busy || resetting || attaching || !!resetReason} title={resetReason ?? '清空所有节点的会话与执行记录，下次发送建立新会话'} onClick={() => setResetOpen(true)}>重置工作流</button></div></header>
    <div ref={detailsBody} style={{ '--details-width': detailsWidth + 'px' } as CSSProperties} className={detailsOpen ? 'workbench-body' : 'workbench-body details-collapsed'}><section className="canvas-column" aria-label="工作流画布">
      <div ref={canvasFocus} className="flow-wrap" tabIndex={0} aria-label="工作流画布，Shift+F10 打开新建菜单" onKeyDown={event => { if (event.key === 'Enter' && (event.target as HTMLElement).matches('.react-flow__node')) { event.preventDefault(); (event.target as HTMLElement).click(); } if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') { event.preventDefault(); const target = (event.target as HTMLElement).closest('.react-flow__node'); const node = canvasNodes.find(item => item.id === target?.getAttribute('data-id')); const rect = (target ?? event.currentTarget).getBoundingClientRect(); setMenu({ x: rect.x + 40, y: rect.y + 40, position: node ? { x: node.position.x + 300, y: node.position.y } : flow.current?.screenToFlowPosition({ x: rect.x + 40, y: rect.y + 40 }) ?? { x: 80, y: 100 }, ...node && ('group' in node.data ? { groupId: node.data.group.id } : { nodeId: node.id }) }); } }}>
        <ReactFlow<CanvasNode> nodes={canvasNodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onInit={instance => { flow.current = instance; }} onNodesChange={changes => onNodesChange(changes.filter(change => change.type !== 'add' && change.type !== 'replace'))} onNodeClick={(_, node) => { setSelectedEdgeId(null); if (!('group' in node.data)) { setSelectedId(node.id); setDetailsOpen(true); } }} onPaneClick={() => setSelectedEdgeId(null)}
          onPaneContextMenu={event => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, position: flow.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY }) ?? { x: 80, y: 100 } }); }}
          onNodeContextMenu={(event, node) => { event.preventDefault(); event.stopPropagation(); if (!('group' in node.data)) setSelectedId(node.id); setMenu({ x: event.clientX, y: event.clientY, position: { x: node.position.x + 300, y: node.position.y }, ...('group' in node.data ? { groupId: node.data.group.id } : { nodeId: node.id }) }); }}
          onEdgeClick={(_, edge) => { if (edge.data?.definitionId) setSelectedEdgeId(String(edge.data.definitionId)); }}
          onEdgeDoubleClick={(_, edge) => { const definition = definitions.find(item => item.id === edge.data?.definitionId); if (definition) setEdgeDraft({ ...definition }); }}
          onNodeDragStart={(_, node) => { dragging.current = true; if ('group' in node.data) { const group = node.data.group, bounds = groupBounds(group, nodes, definitions, visibleLayouts)!; groupDrag.current = { origin: { x: bounds.x, y: bounds.y }, positions: new Map(nodes.filter(member => group.nodeIds.includes(member.id)).map(member => [member.id, { ...member.position }])) }; } }}
          onNodeDrag={(_, node) => { if ('group' in node.data) moveGroupPreview(node.position); }}
          onNodeDragStop={(_, node) => { if ('group' in node.data) { const positions = groupPositions(node.position); moveGroupPreview(node.position); void moveMembers(positions); } else void moveNode(node as WorkflowNode); }}
          nodesConnectable={false} nodesDraggable={!arranging} deleteKeyCode={null} fitView fitViewOptions={{ padding: .25, maxZoom: 1 }} minZoom={.2} maxZoom={1.5} proOptions={{ hideAttribution: true }}>
          <Panel position="bottom-left" style={{ zIndex: 1002 }}><button className="button secondary compact" aria-label="整理画布" title="整理节点、连线和条件标签，并适配视图" disabled={arranging || !!pendingMoves.size || !nodes.length} onClick={() => void arrange()}>{arranging ? '整理中…' : '整理'}</button></Panel>
        </ReactFlow>
      </div>
    </section><aside id="node-details-drawer" className="detail-panel session-detail" aria-label="节点详情" hidden={!detailsOpen} onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing && !modalOpen) { event.stopPropagation(); closeDetails(); } }}>
      <div className="drawer-resizer" role="separator" aria-label="调整节点详情宽度" aria-orientation="vertical" aria-controls="node-details-drawer" aria-valuemin={320} aria-valuemax={Math.max(320, (detailsBody.current?.clientWidth ?? 690) - 270)} aria-valuenow={Math.round(detailsWidth)} tabIndex={0} onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); setResizingDetails(true);
      }} onPointerMove={event => { if (resizingDetails && detailsBody.current) resizeDetails(detailsBody.current.getBoundingClientRect().right - event.clientX); }} onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); setResizingDetails(false); }} onPointerCancel={() => setResizingDetails(false)} onLostPointerCapture={() => setResizingDetails(false)} onKeyDown={event => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); resizeDetails((event.currentTarget.parentElement?.getBoundingClientRect().width ?? detailsWidth) + (event.key === 'ArrowLeft' ? 24 : -24)); }
      }} />
      {runtime?.error && <p className="runtime-error" role="alert">{runtime.error}</p>}
      <div className="detail-heading"><div><h2>{selected?.name ?? '节点详情'}</h2><button className="icon-button" aria-label="收起节点详情" title="收起节点详情" onClick={closeDetails}>×</button></div>{selected && <><div className="node-controls" role="group" aria-label="节点运行控制"><button className="button secondary compact" disabled={!!reconciliationReason || ['paused', 'pausing'].includes(selected.status)} title={reconciliationReason} onClick={() => void execute({ type: 'pause_node', projectId: project.id, nodeId: selected.id })}>暂停节点</button><button className="button secondary compact" disabled={!!reconciliationReason || !['paused', 'pausing'].includes(selected.status)} title={reconciliationReason} onClick={() => void execute({ type: 'resume_node', projectId: project.id, nodeId: selected.id })}>启用节点</button><button className="button secondary compact danger-button" disabled={busy || !!deleteReason} title={deleteReason ?? '移除节点并保留会话历史与项目文件'} onClick={() => setDeletingId(selected.id)}>删除节点</button></div>{reconciliationReason && <p className="field-note" role="status">{reconciliationReason}</p>}{deleteReason && <p className="field-note">{deleteReason}</p>}{selected.status === 'pausing' && <p className="field-note">正在等待原生轮次停止；可直接启用节点覆盖暂停。</p>}{selected.status === 'resuming' && <p className="field-note">已请求启用，等待原生轮次停止后续接。</p>}</>}</div>
      {selected ? <>
        <div className="detail-tabs" role="tablist" aria-label="节点详情栏目">{([['conversation', '会话'], ['config', '配置'], ['panels', '工作面板']] as const).map(([value, label]) => <button key={value} id={`tab-${value}`} role="tab" aria-selected={tab === value} className={tab === value ? 'active' : ''} onClick={() => { setTab(value); }}>{label}</button>)}</div>
        {ongoing && <div className="current-activity" role="status"><span className="local-indicator" />{ongoing.text || '正在处理原生工具调用'}</div>}
        <div className="detail-scroll session-scroll" hidden={tab === 'panels'}><div hidden={tab !== 'conversation'}>{reviewWaits.length > 0 && <div className="field-note" role="status">{reviewWaits.length} 条任务等待人工核对。输入会保存，通过后才执行。{reviewWaits.map(task => <p key={task.id}>{task.error}{task.reviewDependencies?.map(dependency => `${snapshot.reviewPolicy?.checkpoints.find(point => point.id === dependency.checkpointId)?.name ?? dependency.checkpointId} · ${dependency.reviewId === null ? '等待首次提交' : `版本 ${dependency.version} 待通过或依据已过期`}`).join('；')}</p>)}</div>}{(snapshot.requests ?? []).filter(request => !request.nodeId || request.nodeId === selected.id).map(request => <NativeRequestCard key={request.key} request={request} item={nodeEntries.find(entry => entry.itemId === request.params?.itemId)?.content} onOpenUrl={url => void openResource(request.nodeId ?? selected.id, { url })} onRespond={async result => { await execute({ type: 'respond_native', projectId: project.id, requestKey: request.key, result }); }} onError={onError} />)}<HumanReviews actionStore={actionStore} project={project} policy={snapshot.reviewPolicy ?? { revision: 0, checkpoints: [] }} reviews={snapshot.humanReviews ?? []} tasks={snapshot.tasks} nodes={historyNodes} execute={execute} onOpen={openResource} onError={onError} nodeId={selected.id} /><ConversationFeed entries={nodeEntries} nodes={snapshot.nodes} tasks={snapshot.tasks} messages={snapshot.messages} projectRoot={project.root} locatedEntryId={workRequest?.taskId && !workRequest.messageId ? entries.find(entry => entry.taskId === workRequest.taskId && entry.direction === 'input')?.id : location?.history ? undefined : locatedEntry?.id} locationRequest={workRequest?.taskId && !workRequest.messageId ? workRequest : location?.history ? undefined : location ?? undefined} onLocateMessage={locateMessage} onOpen={openResource} onRetry={task => { setRetry(task); setConfirmed(false); }} /></div><div hidden={tab !== 'config'}><NodeConfig key={selected.id} node={selected} draft={configDrafts[selected.id]} onDraftChange={draft => updateConfigDraft(selected.id, draft)} onSaved={configSaved} tasks={snapshot.tasks} busy={busy} onSave={saveNode} onError={onError} catalog={catalog} loading={loadingCatalog} onReload={() => void reloadCatalog()} /></div></div>
        <div className="panels-container" hidden={tab !== 'panels'}><NodePanels key={selected.id} projectId={project.id} nodeId={selected.id} visible={detailsOpen && tab === 'panels' && !modalOpen && !resizingDetails} /></div>
        <form className="task-composer node-composer" hidden={tab === 'panels'} onSubmit={send}><div className="composer-header"><label htmlFor="task-instruction">发送给 <strong>{selected.name}</strong>{pendingTasks > 0 && <span> · {pendingTasks} 条排队中</span>}</label></div><ReferenceEditor id="task-instruction" projectId={project.id} value={draft.text} onChange={text => updateDraft({ text })} execute={execute} label="节点消息" placeholder={`给「${selected.name}」发送消息…，@ 引用项目内容`} rows={3} />{(draft.context?.primary_issue_id ?? draft.context?.primary_todo_id) && <p className="composer-work-context">已关联 Issue<button type="button" className="text-button" onClick={() => updateDraft({ context: undefined })}>解除工作关联</button></p>}{draft.attachments.length > 0 && <div className="attachment-list">{draft.attachments.map((item, i) => <span key={i}>{attachmentLabel(item)}<button type="button" className="icon-button" aria-label={`移除附件 ${i + 1}`} onClick={() => updateDraft({ attachments: draft.attachments.filter((_, index) => index !== i) })}>×</button></span>)}</div>}<div className="composer-bottom"><button type="button" className="text-button" disabled={attaching} onClick={() => void attach()}>{attaching ? '添加中…' : '＋ 添加附件'}</button><span>{['paused', 'pausing'].includes(selected.status) ? '消息将排队，启用节点后处理' : selected.status === 'resuming' ? '等待当前轮次停止后继续处理' : ['starting', 'running'].includes(selected.status) ? '消息会按顺序继续处理' : ''}</span><button className="button primary" disabled={busy || (!draft.text.trim() && !draft.attachments.length)}>发送</button></div></form>
      </> : <div className="panel-empty"><h3>添加一个会话节点</h3><p>在画布空白处右键，选择模型、名称和能力。</p></div>}
    </aside></div>
    {menu && <div className="canvas-context-menu" role="menu" ref={menuRef} style={{ left: Math.min(menu.x, window.innerWidth - 220), top: Math.min(menu.y, window.innerHeight - 210) }}><button role="menuitem" onClick={() => create(menu.position, menu.nodeId)}>{menu.nodeId ? '新增关联节点' : '新增节点'}</button><button role="menuitem" disabled={arranging || !!pendingMoves.size} onClick={() => editGroup(groups.find(group => group.id === menu.groupId || group.nodeIds.includes(menu.nodeId ?? '')), menu.nodeId)}>{groups.some(group => group.id === menu.groupId || group.nodeIds.includes(menu.nodeId ?? '')) ? '编辑分组' : '创建分组'}</button>{menu.nodeId && <button role="menuitem" onClick={() => { setSelectedId(menu.nodeId!); setTab('config'); setMenu(null); setDetailsOpen(true); }}>配置此节点</button>}{menu.nodeId && <button role="menuitem" className="danger-button" disabled={busy || !!deletionBlockReason(menu.nodeId)} title={deletionBlockReason(menu.nodeId) ?? undefined} onClick={() => { setDeletingId(menu.nodeId!); setMenu(null); }}>删除节点</button>}</div>}
    {groupDraft && <Dialog title={groupDraft.revision ? '编辑分组' : '创建分组'} onClose={() => { if (!groupSaving) setGroupDraft(null); }}>{error && <p className="inline-error" role="alert">{error}</p>}<GroupEditor value={groupDraft} nodes={snapshot.nodes} groups={groups} busy={groupSaving} onChange={setGroupDraft} onSave={async () => {
      setGroupSaving(true); try { if (await execute({ type: 'save_group', projectId: project.id, group: groupDraft })) setGroupDraft(null); } finally { setGroupSaving(false); }
    }} onDelete={groupDraft.revision ? async () => { setGroupSaving(true); try { if (await execute({ type: 'delete_group', projectId: project.id, groupId: groupDraft.id, revision: groupDraft.revision })) setGroupDraft(null); } finally { setGroupSaving(false); } } : undefined} /></Dialog>}
    {deletingNode && <Dialog title="删除节点" onClose={() => setDeletingId(null)}><div className="form-stack"><p>确认从画布移除「{deletingNode.name}」？</p><p className="muted">该节点的配置关联线会一并移除。未发送的消息与未保存的节点配置草稿会被丢弃。会话历史、任务记录与项目文件都会保留，可在「项目会话历史」查看。</p>{deletionBlockReason(deletingNode.id) && <p className="inline-warning" role="alert">{deletionBlockReason(deletingNode.id)}</p>}{error && <p className="inline-error" role="alert">{error}</p>}<div className="modal-actions"><button className="button secondary" onClick={() => setDeletingId(null)}>取消</button><button className="button primary danger-button" disabled={busy || !!deletionBlockReason(deletingNode.id)} onClick={async () => { if (deletionBlockReason(deletingNode.id)) return; if (await execute({ type: 'delete_node', projectId: project.id, nodeId: deletingNode.id })) { updateConfigDraft(deletingNode.id, null); setDrafts(current => { const next = { ...current }; delete next[deletingNode.id]; return next; }); setDeletingId(null); } }}>确认删除</button></div></div></Dialog>}
    {creation && <Dialog title={creation.relatedTo ? '新增关联节点' : '新增节点'} onClose={() => setCreation(null)}>{error && <p className="inline-error">{error}</p>}<NewNodeForm position={creation.position} relatedName={snapshot.nodes.find(node => node.id === creation.relatedTo)?.name} catalog={catalog} loading={loadingCatalog} busy={busy} onReload={() => void reloadCatalog(null)} onSave={async (node, condition) => { const reply = await execute({ type: 'save_node', projectId: project.id, node, relatedTo: creation.relatedTo, condition }); if (reply) { setSelectedId(node.id); setCreation(null); setTab('conversation'); setDetailsOpen(true); } }} /></Dialog>}
    {edgeDraft && <Dialog title="关联条件" onClose={() => setEdgeDraft(null)}><form className="form-stack" onSubmit={async event => { event.preventDefault(); if (await execute({ type: 'save_edge', projectId: project.id, edge: edgeDraft })) setEdgeDraft(null); }}>{error && <p className="inline-error" role="alert">{error}</p>}<p>{snapshot.nodes.find(n => n.id === edgeDraft.sourceNodeId)?.name} → {snapshot.nodes.find(n => n.id === edgeDraft.targetNodeId)?.name}</p><label>条件<textarea aria-label="条件" rows={5} value={edgeDraft.condition} onChange={e => setEdgeDraft(current => current && { ...current, condition: e.target.value })} /></label><p className="field-note">条件说明保存在关联边上，自动选择规则待后续确定。</p><div className="modal-actions"><button type="button" className="button secondary" disabled={busy} onClick={async () => { if (await execute({ type: 'delete_edge', projectId: project.id, edgeId: edgeDraft.id })) setEdgeDraft(null); }}>移除关联</button><button className="button primary" disabled={busy}>保存条件</button></div></form></Dialog>}
    {reviewsOpen && <Dialog title="项目人工核对事项" onClose={() => setReviewsOpen(false)}>{!(snapshot.humanReviews ?? []).length && <p className="field-note">当前没有核对事项。</p>}<HumanReviews actionStore={actionStore} project={project} policy={snapshot.reviewPolicy ?? { revision: 0, checkpoints: [] }} reviews={snapshot.humanReviews ?? []} tasks={snapshot.tasks} nodes={historyNodes} execute={execute} onOpen={openResource} onError={onError} /></Dialog>}
    {reviewPolicyOpen && <Dialog title="人工核对规则" onClose={() => setReviewPolicyOpen(false)}>{error && <p className="inline-error" role="alert">{error}</p>}<ReviewPolicyEditor policy={snapshot.reviewPolicy ?? { revision: 0, checkpoints: [] }} nodes={snapshot.nodes} busy={busy} onError={onError} onSave={async policy => !!await execute({ type: 'save_review_policy', projectId: project.id, policy })} /></Dialog>}
    {historyOpen && <Dialog title="项目会话历史" wide onClose={() => setHistoryOpen(false)}><p className="field-note">所有节点按时间排列 · 未知时间置后按记录顺序 · {entries.length} 条记录{historyLoading ? ' · 正在补齐原生历史…' : ''}</p>{historyFailures.length > 0 && <p className="inline-warning">以下节点的原生历史暂未完整载入：{historyFailures.join('、')}。当前展示已保存记录。</p>}{location?.history && !historyLoading && <p className="field-note" role="status">{locatedSource ? (snapshot.nodes.some(node => node.id === location.sourceNodeId) ? '已在项目历史定位原消息。' : '来源节点已移除，已在项目历史定位原消息。') : locatedEntry ? '来源节点的原始发送记录缺失，已定位保留的接收记录。' : '未找到原消息记录，当前已保存历史及可读取的原生历史中均无此条目。'}</p>}<ConversationFeed entries={entries} nodes={historyNodes} tasks={snapshot.tasks} messages={snapshot.messages} projectRoot={project.root} locatedEntryId={workRequest?.taskId && !workRequest.messageId && !historyLoading ? entries.find(entry => entry.taskId === workRequest.taskId && entry.direction === 'input')?.id : location?.history && !historyLoading ? locatedEntry?.id : undefined} locationRequest={workRequest?.taskId && !workRequest.messageId ? workRequest : location?.history ? location : undefined} onLocateMessage={locateMessage} projectTimeline onOpen={openResource} /></Dialog>}
    {resetOpen && <Dialog title="重置工作流" onClose={() => { if (!resetInFlight.current) setResetOpen(false); }}><div className="form-stack"><p className="inline-warning">将清空所有节点（含已移除节点）的会话历史、未发送草稿与附件、任务、交接、消息、执行记录和人工核对结果。此操作不可撤销。</p><p>节点恢复空闲，下次发送会创建新会话。节点配置、条件边、分组、布局、人工核对规则、Issue、文档和项目文件继续保留。</p>{resetReason && <p className="inline-warning" role="alert">{resetReason}</p>}{error && <p className="inline-error" role="alert">{error}</p>}<div className="modal-actions"><button autoFocus className="button secondary" disabled={resetting} onClick={() => setResetOpen(false)}>取消</button><button className="button primary danger-button" disabled={busy || resetting || attaching || !!resetReason} onClick={() => void resetWorkflow()}>{resetting ? '重置中…' : '确认重置'}</button></div></div></Dialog>}
    {retry && <Dialog title="核对任务后重试" onClose={() => setRetry(null)}><div className="form-stack"><p className="inline-warning">请核对上次执行和已有成果，避免重复操作。</p><p>{retry.instruction}</p><label className="confirm-choice"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />我已核对，确认可以重试</label><button className="button primary" disabled={!confirmed || busy} onClick={async () => { if (await execute({ type: 'retry_task', projectId: project.id, taskId: retry.id, confirmed: true })) setRetry(null); }}>确认重试</button></div></Dialog>}
  </main>;
}
