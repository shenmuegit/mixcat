import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { Handle, MarkerType, Position, ReactFlow, useNodesState, type Edge, type Node, type NodeProps, type ReactFlowInstance } from '@xyflow/react';
import type { AppCommand, AppReply, AppSnapshot, CapabilityCatalog, EdgeLayout, HandoffView, MessageSummary, NativeInput, NodeDefinition, NodeView, ProjectSnapshot, TaskView, WorkflowEdge } from '../shared/types';
import { EditableEdge } from './EditableEdge';
import { NodeConfig, NewNodeForm } from './NodeSettings';
import { ConversationFeed } from './Conversation';
import { NativeRequestCard } from './NativeRequests';
import { NodePanels } from './NodePanels';
import { HumanReviews, ReviewPolicyEditor, type ReviewAction } from './HumanReviews';

type DraftNode = Omit<NodeDefinition, 'revision'> & { revision?: number };
type Execute = (command: AppCommand, actionId?: string) => Promise<AppReply | null>;
type WorkflowNode = Node<{ node: NodeView }, 'conversation'>;
const labels: Record<string, string> = { idle: '空闲', starting: '启动中', running: '运行中', pausing: '暂停中', resuming: '等待续接', paused: '已暂停', blocked: '需处理', completed: '已完成', queued: '排队中', failed: '失败', needs_reconciliation: '状态待核对', cancelled: '已取消' };

export function relatedNodePosition(position: NodeDefinition['position'], occupied: { position: NodeDefinition['position']; measured?: { width?: number; height?: number } }[]) {
  const candidate = { ...position }, width = 215, height = 200, gap = 24;
  while (occupied.some(node => candidate.x < node.position.x + (node.measured?.width ?? width) + gap && candidate.x + width + gap > node.position.x
    && candidate.y < node.position.y + (node.measured?.height ?? height) + gap && candidate.y + height + gap > node.position.y)) candidate.y += 230;
  return candidate;
}

export function toWorkflowEdges(handoffs: HandoffView[], nodes: NodeView[], messages: MessageSummary[] = []): Edge[] {
  const ids = new Set(nodes.map(node => node.id));
  const routes = new Map<string, { id: string; fromNodeId: string; toNodeId: string; handoffs: number; messages: number; returning: boolean }>();
  for (const record of [...handoffs.map(handoff => ({ ...handoff, message: false })), ...messages.map(message => ({ ...message, id: `message:${message.message_id}`, message: true }))]) {
    if (!ids.has(record.fromNodeId) || !ids.has(record.toNodeId)) continue;
    const key = JSON.stringify([record.fromNodeId, record.toNodeId]);
    const previous = routes.get(key);
    const returning = previous?.returning ?? routes.has(JSON.stringify([record.toNodeId, record.fromNodeId]));
    routes.set(key, { id: record.message ? previous?.id ?? record.id : record.id, fromNodeId: record.fromNodeId, toNodeId: record.toNodeId, handoffs: (previous?.handoffs ?? 0) + (record.message ? 0 : 1), messages: (previous?.messages ?? 0) + (record.message ? 1 : 0), returning });
  }
  return [...routes.values()].map(({ id, fromNodeId, toNodeId, handoffs, messages, returning }) => ({
    id, source: fromNodeId, target: toNodeId,
    sourceHandle: returning || messages ? 'return-source' : null, targetHandle: returning || messages ? 'return-target' : null,
    label: messages ? `${returning ? '回流 · ' : ''}${messages} 条消息${handoffs ? ` · ${handoffs} 次交接` : ''}` : returning ? (handoffs > 1 ? `回流 · ${handoffs} 次` : '回流') : handoffs > 1 ? `${handoffs} 次交接` : '交接', type: 'smoothstep',
    pathOptions: returning || messages ? { offset: returning ? 48 : 24, borderRadius: 10 } : undefined,
    markerEnd: { type: MarkerType.ArrowClosed, color: returning ? '#9b8f79' : '#8b9189' },
    style: { stroke: returning ? '#9b8f79' : '#8b9189', strokeWidth: 1.5, strokeDasharray: returning ? '5 4' : undefined },
    labelStyle: { fill: returning ? '#8b7d64' : '#626860', fontSize: 11 }, labelBgStyle: { fill: '#f7f7f4' },
  }));
}
function Status({ value }: { value: string }) { return <span className={`status status-${value}`}><span />{labels[value] ?? value}</span>; }
function Dialog({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); return () => ref.current?.close(); }, []);
  return <dialog className={`modal ${wide ? 'wide-modal' : ''}`} ref={ref} onCancel={onClose} aria-label={title}><div className="modal-heading"><h2>{title}</h2><button className="icon-button" aria-label="关闭弹窗" onClick={onClose}>×</button></div>{children}</dialog>;
}
function ConversationNode({ data, selected }: NodeProps<WorkflowNode>) {
  const node = data.node;
  return <div className={`conversation-node ${selected ? 'is-selected' : ''}`}><Handle type="target" position={Position.Left} isConnectable={false} /><div className="node-top"><Status value={node.status} /></div><h3>{node.name}</h3><p>{node.instructions || '独立 Codex 会话'}</p>{node.model && <div className="node-model" title={node.model}>{node.model}</div>}<Handle type="source" position={Position.Right} isConnectable={false} /><Handle id="return-source" type="source" position={Position.Bottom} style={{ left: '38%' }} isConnectable={false} /><Handle id="return-target" type="target" position={Position.Bottom} style={{ left: '62%' }} isConnectable={false} /></div>;
}
const nodeTypes = { conversation: ConversationNode };
const edgeTypes = { condition: EditableEdge };
function attachmentLabel(input: NativeInput) {
  if (typeof input.path === 'string') return input.path.split(/[\\/]/).at(-1);
  if (typeof input.text === 'string') return input.text.split('\n')[0].replace(/^附件：/, '');
  return String(input.name ?? input.type);
}

export function Workbench({ snapshot, runtime, execute, busy, error, onError, reviewActions }: { snapshot: ProjectSnapshot; runtime: AppSnapshot['runtime']; execute: Execute; busy: boolean; error: string | null; onError: (error: string) => void; reviewActions?: Map<string, ReviewAction> }) {
  const { project } = snapshot;
  const localReviewActions = useRef(new Map<string, ReviewAction>());
  const actionStore = reviewActions ?? localReviewActions.current;
  const [selectedId, setSelectedId] = useState(snapshot.nodes[0]?.id ?? '');
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const selected = snapshot.nodes.find(node => node.id === selectedId) ?? snapshot.nodes[0];
  const [tab, setTab] = useState<'conversation' | 'config' | 'panels'>('conversation');
  const [detailsOpen, setDetailsOpen] = useState(true);
  const detailsToggle = useRef<HTMLButtonElement>(null);
  const detailsBody = useRef<HTMLDivElement>(null);
  const [detailsWidth, setDetailsWidth] = useState(420);
  const [resizingDetails, setResizingDetails] = useState(false);
  function resizeDetails(width: number) { setDetailsWidth(Math.max(320, Math.min(width, Math.max(320, (detailsBody.current?.clientWidth ?? 690) - 270)))); }
  useEffect(() => {
    const body = detailsBody.current; if (!body) return;
    const observer = new ResizeObserver(() => setDetailsWidth(width => Math.max(320, Math.min(width, Math.max(320, body.clientWidth - 270)))));
    observer.observe(body); return () => observer.disconnect();
  }, []);
  function closeDetails() { setResizingDetails(false); setDetailsOpen(false); detailsToggle.current?.focus(); }
  const mode = project.mode;
  const [drafts, setDrafts] = useState<Record<string, { text: string; attachments: NativeInput[] }>>({});
  const draft = drafts[selected?.id] ?? { text: '', attachments: [] };
  const [catalog, setCatalog] = useState<CapabilityCatalog | null>(null);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const catalogRequest = useRef(0);
  const catalogNodeId = useRef<string | null>(selected?.id ?? null);
  const [nodes, setNodes, onNodesChange] = useNodesState<WorkflowNode>([]);
  const flow = useRef<ReactFlowInstance<WorkflowNode> | null>(null);
  const dragging = useRef(false);
  const [menu, setMenu] = useState<{ x: number; y: number; position: NodeDefinition['position']; nodeId?: string } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [creation, setCreation] = useState<{ position: NodeDefinition['position']; relatedTo?: string } | null>(null);
  catalogNodeId.current = creation ? null : selected?.id ?? null;
  const [edgeDraft, setEdgeDraft] = useState<WorkflowEdge | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [reviewPolicyOpen, setReviewPolicyOpen] = useState(false);
  const [reviewsOpen, setReviewsOpen] = useState(false);
  const resourceRequest = useRef(0);
  useEffect(() => { resourceRequest.current++; return () => { resourceRequest.current++; }; }, [project.id, selected?.id, tab, detailsOpen, historyOpen, reviewsOpen]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyFailures, setHistoryFailures] = useState<string[]>([]);
  const [location, setLocation] = useState<{ messageId: string; sourceNodeId?: string; history: boolean } | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [retry, setRetry] = useState<TaskView | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const nativeConnected = runtime?.mode === 'codex' && runtime.connected;
  const canPauseAll = snapshot.nodes.some(node => !['paused', 'pausing'].includes(node.status));
  const resumableNodes = snapshot.nodes.filter(node => snapshot.resumeNodeIds?.includes(node.id) && ['paused', 'pausing'].includes(node.status));
  const canResumeAll = resumableNodes.length > 0 || snapshot.nodes.some(node => node.status === 'paused' && !snapshot.tasks.some(task => task.nodeId === node.id && ['running', 'paused', 'queued', 'waiting_source', 'needs_reconciliation'].includes(task.status)));
  const historyNodes = [...snapshot.nodes, ...(snapshot.archivedNodes ?? []).map(node => ({ ...node, name: `${node.name}（已移除）` }))];
  const deletingNode = snapshot.nodes.find(node => node.id === deletingId);
  function deletionBlockReason(nodeId: string) {
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
  const edges = useMemo(() => [
    ...toWorkflowEdges(snapshot.handoffs, snapshot.nodes, snapshot.messages),
    ...definitions.map(edge => ({ id: `definition:${edge.id}`, source: edge.sourceNodeId, target: edge.targetNodeId, type: 'condition', selected: selectedEdgeId === edge.id,
      data: { definitionId: edge.id, definition: edge, onEdit: setEdgeDraft, layout: Object.hasOwn(snapshot.edgeLayouts ?? {}, edge.id) ? snapshot.edgeLayouts![edge.id] : undefined, onLayout: async (edgeId: string, layout: EdgeLayout) => {
        const layouts = (await execute({ type: 'save_edge_layout', projectId: project.id, edgeId, layout }))?.snapshot.selected?.edgeLayouts;
        return layouts && Object.hasOwn(layouts, edgeId) ? layouts[edgeId] : null;
      } },
      markerEnd: { type: MarkerType.ArrowClosed, color: selectedEdgeId === edge.id ? '#2563eb' : '#888888' }, style: { stroke: selectedEdgeId === edge.id ? '#2563eb' : '#888888', strokeWidth: selectedEdgeId === edge.id ? 3 : 1.5 } })),
  ], [snapshot.handoffs, snapshot.nodes, snapshot.messages, definitions, snapshot.edgeLayouts, selectedEdgeId, execute, project.id]);
  useEffect(() => {
    if (dragging.current) return;
    setNodes(current => snapshot.nodes.map(node => ({ ...current.find(item => item.id === node.id), id: node.id, position: node.position, type: 'conversation', data: { node }, selected: selected?.id === node.id, ariaLabel: `${node.name}，${labels[node.status]}` })));
  }, [snapshot.nodes, selected?.id, setNodes]);
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
    if (selected?.threadId && nativeConnected && !loadedHistory.current.has(selected.threadId)) {
      loadedHistory.current.add(selected.threadId);
      void execute({ type: 'read_history', projectId: project.id, nodeId: selected.id }).then(reply => { if (!reply) loadedHistory.current.delete(selected.threadId!); });
    }
  }, [selected?.id, selected?.threadId, nativeConnected]);
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
  async function configureTemplate() {
    catalogRequest.current++;
    const reply = await execute({ type: 'configure_template', projectId: project.id });
    if (!reply) return;
    const errors = reply.catalog?.errors ?? [];
    await reloadCatalog(catalogNodeId.current, errors);
    if (errors.length) onError(`部分推荐能力尚未配置，可重试：${errors.join('；')}`);
  }
  async function trustHooks(hooks: { key: string; currentHash: string }[]) {
    catalogRequest.current++;
    const reply = await execute({ type: 'trust_hooks', projectId: project.id, hooks });
    const errors = reply?.catalog?.errors ?? catalog?.errors ?? [];
    await reloadCatalog(catalogNodeId.current, errors);
    if (!reply) onError('Hooks 信任未完成，请重新查看当前来源、命令与 Hash 后重试。');
    else if (errors.length) onError(`Hooks 状态已刷新，仍有能力缺口：${errors.join('；')}`);
  }
  async function openProjectHistory() {
    setHistoryOpen(true); setHistoryLoading(true); setHistoryFailures([]);
    const failed: string[] = [];
    try {
      for (const node of historyNodes.filter(node => node.threadId && !node.threadId.startsWith('demo-'))) {
        if (!(await execute({ type: 'read_history', projectId: project.id, nodeId: node.id }))) failed.push(node.name);
      }
      setHistoryFailures(failed);
    } finally { setHistoryLoading(false); }
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
  async function send(event: FormEvent) {
    event.preventDefault(); if (!selected || (!draft.text.trim() && !draft.attachments.length)) return;
    const nodeId = selected.id; const input: NativeInput[] = [...(draft.text ? [{ type: 'text', text: draft.text, text_elements: [] }] : []), ...draft.attachments];
    if (await execute({ type: 'send_message', projectId: project.id, nodeId, input, mode })) {
      setDrafts(current => current[nodeId] === draft ? { ...current, [nodeId]: { text: '', attachments: [] } } : current);
      setTab('conversation');
    }
  }
  async function attach() {
    if (!selected) return; const nodeId = selected.id; setAttaching(true);
    try { const input = await window.mixcat.chooseAttachments(project.id, nodeId); if (input.length) setDrafts(current => { const previous = current[nodeId] ?? { text: '', attachments: [] }; return { ...current, [nodeId]: { ...previous, attachments: [...previous.attachments, ...input] } }; }); }
    catch (error) { onError(error instanceof Error ? error.message : String(error)); } finally { setAttaching(false); }
  }
  async function openResource(nodeId: string, resource: { path?: string; url?: string }) {
    const targetNode = snapshot.nodes.find(node => node.id === nodeId) ?? selected;
    if (!targetNode) { onError('此节点已移除。请先添加一个会话节点，再从项目历史中打开资源；原文件与历史仍然保留。'); return; }
    const request = ++resourceRequest.current;
    try { await window.mixcat.panel({ type: 'open', projectId: project.id, nodeId: targetNode.id, target: resource.path ? { type: 'file', path: resource.path } : { type: 'url', url: resource.url! } }); if (request !== resourceRequest.current) return; setSelectedId(targetNode.id); setTab('panels'); setHistoryOpen(false); setReviewsOpen(false); setDetailsOpen(true); }
    catch (error) { if (request === resourceRequest.current) onError(error instanceof Error ? error.message : String(error)); }
  }
  async function saveNode(node: DraftNode) { const reply = await execute({ type: 'save_node', projectId: project.id, node }); return reply?.snapshot.selected?.nodes.find(n => n.id === node.id) ?? null; }
  const modalOpen = !!creation || !!edgeDraft || historyOpen || reviewPolicyOpen || reviewsOpen || !!retry || !!deletingNode || !!menu || attaching;
  return <main className="workbench session-workbench">
    <header className="project-header"><div className="project-statusbar" role="group" aria-label="项目状态栏"><span className="workflow-summary">{snapshot.nodes.length} 个会话</span><button className="text-button" onClick={() => setReviewsOpen(true)}>待人工核对 {(snapshot.humanReviews ?? []).filter(review => review.status === 'pending').length}</button><div className="execution-overview" role="status" aria-label="节点执行状态">{(['running', 'starting', 'pausing', 'resuming', 'paused', 'queued', 'blocked', 'idle', 'completed'] as const).map(status => { const count = snapshot.nodes.filter(node => node.status === status).length; return (count > 0 || status === 'running') && <span key={status} data-node-status={status} className={`status-${status}`}>{labels[status]} <strong>{count}</strong></span>; })}</div><button className="button secondary compact" onClick={() => create({ x: 80 + snapshot.nodes.length % 3 * 300, y: 100 + Math.floor(snapshot.nodes.length / 3) * 230 })}>＋ 添加节点</button>{(snapshot.requests?.length ?? 0) > 0 && <button className="text-button" onClick={() => { const request = snapshot.requests![0]; if (request.nodeId) setSelectedId(request.nodeId); setTab('conversation'); setDetailsOpen(true); }}>{snapshot.requests!.length} 个请求待回应</button>}</div><div className="project-controls"><button className="button secondary compact" onClick={() => setReviewPolicyOpen(true)}>人工核对规则</button>{project.template === 'web-product' && <button className="button secondary compact" disabled={busy} onClick={() => void configureTemplate()}>配置推荐能力</button>}<button ref={detailsToggle} className="button secondary compact" aria-expanded={detailsOpen} aria-controls="node-details-drawer" onClick={() => detailsOpen ? closeDetails() : setDetailsOpen(true)}>节点详情</button><button className="button secondary compact" disabled={historyLoading} onClick={() => { setLocation(null); void openProjectHistory(); }}>项目会话历史</button><button className="button secondary compact" disabled={!canPauseAll} onClick={() => void execute({ type: 'pause', projectId: project.id })}>全部暂停</button><button className="button secondary compact" disabled={!canResumeAll} title="续接全部暂停时记录的运行节点，其他空闲节点恢复待命" onClick={() => void execute({ type: 'resume', projectId: project.id })}>全部开启</button><button className="button secondary compact" disabled={!busy && !['running', 'pausing', 'paused', 'blocked'].includes(project.status)} onClick={() => void execute({ type: 'stop', projectId: project.id })}>停止本轮</button></div></header>
    <div ref={detailsBody} style={{ '--details-width': detailsWidth + 'px' } as CSSProperties} className={detailsOpen ? 'workbench-body' : 'workbench-body details-collapsed'}><section className="canvas-column" aria-label="工作流画布">
      <div className="flow-wrap" tabIndex={0} aria-label="工作流画布，Shift+F10 打开新建菜单" onKeyDown={event => { if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') { event.preventDefault(); const target = (event.target as HTMLElement).closest('.react-flow__node'); const node = nodes.find(item => item.id === target?.getAttribute('data-id')); const rect = (target ?? event.currentTarget).getBoundingClientRect(); setMenu({ x: rect.x + 40, y: rect.y + 40, position: node ? { x: node.position.x + 300, y: node.position.y } : flow.current?.screenToFlowPosition({ x: rect.x + 40, y: rect.y + 40 }) ?? { x: 80, y: 100 }, nodeId: node?.id }); } }}>
        <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onInit={instance => { flow.current = instance; }} onNodesChange={onNodesChange} onNodeClick={(_, node) => { setSelectedEdgeId(null); setSelectedId(node.id); setDetailsOpen(true); }} onPaneClick={() => setSelectedEdgeId(null)}
          onPaneContextMenu={event => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, position: flow.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY }) ?? { x: 80, y: 100 } }); }}
          onNodeContextMenu={(event, node) => { event.preventDefault(); event.stopPropagation(); setSelectedId(node.id); setMenu({ x: event.clientX, y: event.clientY, position: { x: node.position.x + 300, y: node.position.y }, nodeId: node.id }); }}
          onEdgeClick={(_, edge) => { if (edge.data?.definitionId) setSelectedEdgeId(String(edge.data.definitionId)); }}
          onEdgeDoubleClick={(_, edge) => { const definition = definitions.find(item => item.id === edge.data?.definitionId); if (definition) setEdgeDraft({ ...definition }); }}
          onNodeDragStart={() => { dragging.current = true; }} onNodeDragStop={async (_, dragged) => { dragging.current = false; const before = snapshot.nodes.find(node => node.id === dragged.id); const reply = await execute({ type: 'move_node', projectId: project.id, nodeId: dragged.id, position: dragged.position }); if (!reply && before) setNodes(current => current.map(node => node.id === before.id ? { ...node, position: before.position } : node)); }}
          nodesConnectable={false} deleteKeyCode={null} fitView fitViewOptions={{ padding: .25, maxZoom: 1 }} minZoom={.2} maxZoom={1.5} proOptions={{ hideAttribution: true }} />
      </div>
    </section><aside id="node-details-drawer" className="detail-panel session-detail" aria-label="节点详情" hidden={!detailsOpen} onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing && !modalOpen) { event.stopPropagation(); closeDetails(); } }}>
      <div className="drawer-resizer" role="separator" aria-label="调整节点详情宽度" aria-orientation="vertical" aria-controls="node-details-drawer" aria-valuemin={320} aria-valuemax={Math.max(320, (detailsBody.current?.clientWidth ?? 690) - 270)} aria-valuenow={Math.round(detailsWidth)} tabIndex={0} onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); setResizingDetails(true);
      }} onPointerMove={event => { if (resizingDetails && detailsBody.current) resizeDetails(detailsBody.current.getBoundingClientRect().right - event.clientX); }} onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); setResizingDetails(false); }} onPointerCancel={() => setResizingDetails(false)} onLostPointerCapture={() => setResizingDetails(false)} onKeyDown={event => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); resizeDetails((event.currentTarget.parentElement?.getBoundingClientRect().width ?? detailsWidth) + (event.key === 'ArrowLeft' ? 24 : -24)); }
      }} />
      {runtime?.error && <p className="runtime-error" role="alert">{runtime.error}</p>}
      <div className="detail-heading"><div><h2>{selected?.name ?? '节点详情'}</h2><button className="icon-button" aria-label="收起节点详情" title="收起节点详情" onClick={closeDetails}>×</button></div>{selected && <><div className="node-controls" role="group" aria-label="节点运行控制"><button className="button secondary compact" disabled={['paused', 'pausing'].includes(selected.status)} onClick={() => void execute({ type: 'pause_node', projectId: project.id, nodeId: selected.id })}>暂停节点</button><button className="button secondary compact" disabled={!['paused', 'pausing'].includes(selected.status)} onClick={() => void execute({ type: 'resume_node', projectId: project.id, nodeId: selected.id })}>启用节点</button><button className="button secondary compact danger-button" disabled={busy || !!deleteReason} title={deleteReason ?? '移除节点并保留会话历史与项目文件'} onClick={() => setDeletingId(selected.id)}>删除节点</button></div>{deleteReason && <p className="field-note">{deleteReason}</p>}{selected.status === 'pausing' && <p className="field-note">正在等待原生轮次停止；可直接启用节点覆盖暂停。</p>}{selected.status === 'resuming' && <p className="field-note">已请求启用，等待原生轮次停止后续接。</p>}{selected.status === 'paused' && <p className="field-note">节点已暂停，可单独启用；新消息将留在队列。</p>}</>}</div>
      {selected ? <>
        <div className="detail-tabs" role="tablist" aria-label="节点详情栏目">{([['conversation', '会话'], ['config', '配置'], ['panels', '工作面板']] as const).map(([value, label]) => <button key={value} id={`tab-${value}`} role="tab" aria-selected={tab === value} className={tab === value ? 'active' : ''} onClick={() => { setTab(value); }}>{label}</button>)}</div>
        {ongoing && <div className="current-activity" role="status"><span className="local-indicator" />{ongoing.text || '正在处理原生工具调用'}</div>}
        <div className="detail-scroll session-scroll" hidden={tab === 'panels'}><div hidden={tab !== 'conversation'}>{reviewWaits.length > 0 && <div className="field-note" role="status">{reviewWaits.length} 条任务等待人工核对。输入会保存，通过后才执行。{reviewWaits.map(task => <p key={task.id}>{task.error}{task.reviewDependencies?.map(dependency => `${snapshot.reviewPolicy?.checkpoints.find(point => point.id === dependency.checkpointId)?.name ?? dependency.checkpointId} · ${dependency.reviewId === null ? '等待首次提交' : `版本 ${dependency.version} 待通过或依据已过期`}`).join('；')}</p>)}</div>}{(snapshot.requests ?? []).filter(request => !request.nodeId || request.nodeId === selected.id).map(request => <NativeRequestCard key={request.key} request={request} item={nodeEntries.find(entry => entry.itemId === request.params?.itemId)?.content} onOpenUrl={url => void openResource(request.nodeId ?? selected.id, { url })} onRespond={async result => { await execute({ type: 'respond_native', projectId: project.id, requestKey: request.key, result }); }} onError={onError} />)}<HumanReviews actionStore={actionStore} project={project} policy={snapshot.reviewPolicy ?? { revision: 0, checkpoints: [] }} reviews={snapshot.humanReviews ?? []} tasks={snapshot.tasks} nodes={historyNodes} execute={execute} onOpen={openResource} onError={onError} nodeId={selected.id} /><ConversationFeed entries={nodeEntries} nodes={snapshot.nodes} tasks={snapshot.tasks} messages={snapshot.messages} projectRoot={project.root} locatedEntryId={location?.history ? undefined : locatedEntry?.id} locationRequest={location?.history ? undefined : location ?? undefined} onLocateMessage={locateMessage} onOpen={openResource} onRetry={task => { setRetry(task); setConfirmed(false); }} /></div><div hidden={tab !== 'config'}><NodeConfig key={selected.id} node={selected} tasks={snapshot.tasks} busy={busy} onSave={saveNode} onError={onError} catalog={catalog} loading={loadingCatalog} projectRoot={project.root} onTrust={trustHooks} onReload={() => void reloadCatalog()} /></div></div>
        <div className="panels-container" hidden={tab !== 'panels'}><NodePanels key={selected.id} projectId={project.id} nodeId={selected.id} visible={detailsOpen && tab === 'panels' && !modalOpen && !resizingDetails} /></div>
        <form className="task-composer node-composer" hidden={tab === 'panels'} onSubmit={send}><div className="composer-header"><label htmlFor="task-instruction">发送给 <strong>{selected.name}</strong>{pendingTasks > 0 && <span> · {pendingTasks} 条排队中</span>}</label></div><textarea id="task-instruction" value={draft.text} onChange={e => updateDraft({ text: e.target.value })} placeholder={`给「${selected.name}」发送消息…`} rows={3} />{draft.attachments.length > 0 && <div className="attachment-list">{draft.attachments.map((item, i) => <span key={i}>{attachmentLabel(item)}<button type="button" className="icon-button" aria-label={`移除附件 ${i + 1}`} onClick={() => updateDraft({ attachments: draft.attachments.filter((_, index) => index !== i) })}>×</button></span>)}</div>}<div className="composer-bottom"><button type="button" className="text-button" disabled={attaching} onClick={() => void attach()}>{attaching ? '添加中…' : '＋ 添加附件'}</button><span>{['paused', 'pausing'].includes(selected.status) ? '消息将排队，启用节点后处理' : selected.status === 'resuming' ? '等待当前轮次停止后继续处理' : ['starting', 'running'].includes(selected.status) ? '消息会按顺序继续处理' : ''}</span><button className="button primary" disabled={busy || (!draft.text.trim() && !draft.attachments.length)}>发送</button></div></form>
      </> : <div className="panel-empty"><h3>添加一个会话节点</h3><p>在画布空白处右键，选择模型、名称和能力。</p></div>}
    </aside></div>
    {menu && <div className="canvas-context-menu" role="menu" ref={menuRef} style={{ left: Math.min(menu.x, window.innerWidth - 220), top: Math.min(menu.y, window.innerHeight - 170) }}><button role="menuitem" onClick={() => create(menu.position, menu.nodeId)}>{menu.nodeId ? '新增关联节点' : '新增节点'}</button>{menu.nodeId && <button role="menuitem" onClick={() => { setSelectedId(menu.nodeId!); setTab('config'); setMenu(null); setDetailsOpen(true); }}>配置此节点</button>}{menu.nodeId && <button role="menuitem" className="danger-button" disabled={busy || !!deletionBlockReason(menu.nodeId)} title={deletionBlockReason(menu.nodeId) ?? undefined} onClick={() => { setDeletingId(menu.nodeId!); setMenu(null); }}>删除节点</button>}</div>}
    {deletingNode && <Dialog title="删除节点" onClose={() => setDeletingId(null)}><div className="form-stack"><p>确认从画布移除「{deletingNode.name}」？</p><p className="muted">该节点的配置关联线会一并移除。会话历史、任务记录与项目文件都会保留，可在「项目会话历史」查看。</p>{deletionBlockReason(deletingNode.id) && <p className="inline-warning" role="alert">{deletionBlockReason(deletingNode.id)}</p>}{error && <p className="inline-error" role="alert">{error}</p>}<div className="modal-actions"><button className="button secondary" onClick={() => setDeletingId(null)}>取消</button><button className="button primary danger-button" disabled={busy || !!deletionBlockReason(deletingNode.id)} onClick={async () => { if (deletionBlockReason(deletingNode.id)) return; if (await execute({ type: 'delete_node', projectId: project.id, nodeId: deletingNode.id })) setDeletingId(null); }}>确认删除</button></div></div></Dialog>}
    {creation && <Dialog title={creation.relatedTo ? '新增关联节点' : '新增节点'} onClose={() => setCreation(null)}>{error && <p className="inline-error">{error}</p>}<NewNodeForm position={creation.position} relatedName={snapshot.nodes.find(node => node.id === creation.relatedTo)?.name} catalog={catalog} loading={loadingCatalog} busy={busy} onReload={() => void reloadCatalog(null)} onSave={async (node, condition) => { const reply = await execute({ type: 'save_node', projectId: project.id, node, relatedTo: creation.relatedTo, condition }); if (reply) { setSelectedId(node.id); setCreation(null); setTab('conversation'); setDetailsOpen(true); } }} /></Dialog>}
    {edgeDraft && <Dialog title="关联条件" onClose={() => setEdgeDraft(null)}><form className="form-stack" onSubmit={async event => { event.preventDefault(); if (await execute({ type: 'save_edge', projectId: project.id, edge: edgeDraft })) setEdgeDraft(null); }}>{error && <p className="inline-error" role="alert">{error}</p>}<p>{snapshot.nodes.find(n => n.id === edgeDraft.sourceNodeId)?.name} → {snapshot.nodes.find(n => n.id === edgeDraft.targetNodeId)?.name}</p><label>条件<textarea aria-label="条件" rows={5} value={edgeDraft.condition} onChange={e => setEdgeDraft(current => current && { ...current, condition: e.target.value })} /></label><p className="field-note">条件说明保存在关联边上，自动选择规则待后续确定。</p><div className="modal-actions"><button type="button" className="button secondary" disabled={busy} onClick={async () => { if (await execute({ type: 'delete_edge', projectId: project.id, edgeId: edgeDraft.id })) setEdgeDraft(null); }}>移除关联</button><button className="button primary" disabled={busy}>保存条件</button></div></form></Dialog>}
    {reviewsOpen && <Dialog title="项目人工核对事项" onClose={() => setReviewsOpen(false)}>{!(snapshot.humanReviews ?? []).length && <p className="field-note">当前没有核对事项。</p>}<HumanReviews actionStore={actionStore} project={project} policy={snapshot.reviewPolicy ?? { revision: 0, checkpoints: [] }} reviews={snapshot.humanReviews ?? []} tasks={snapshot.tasks} nodes={historyNodes} execute={execute} onOpen={openResource} onError={onError} /></Dialog>}
    {reviewPolicyOpen && <Dialog title="人工核对规则" onClose={() => setReviewPolicyOpen(false)}>{error && <p className="inline-error" role="alert">{error}</p>}<ReviewPolicyEditor policy={snapshot.reviewPolicy ?? { revision: 0, checkpoints: [] }} nodes={snapshot.nodes} busy={busy} onError={onError} onSave={async policy => !!await execute({ type: 'save_review_policy', projectId: project.id, policy })} /></Dialog>}
    {historyOpen && <Dialog title="项目会话历史" wide onClose={() => setHistoryOpen(false)}><p className="field-note">所有节点按时间排列 · 未知时间置后按记录顺序 · {entries.length} 条记录{historyLoading ? ' · 正在补齐原生历史…' : ''}</p>{historyFailures.length > 0 && <p className="inline-warning">以下节点的原生历史暂未完整载入：{historyFailures.join('、')}。当前展示已保存记录。</p>}{location?.history && !historyLoading && <p className="field-note" role="status">{locatedSource ? (snapshot.nodes.some(node => node.id === location.sourceNodeId) ? '已在项目历史定位原消息。' : '来源节点已移除，已在项目历史定位原消息。') : locatedEntry ? '来源节点的原始发送记录缺失，已定位保留的接收记录。' : '未找到原消息记录，当前已保存历史及可读取的原生历史中均无此条目。'}</p>}<ConversationFeed entries={entries} nodes={historyNodes} tasks={snapshot.tasks} messages={snapshot.messages} projectRoot={project.root} locatedEntryId={location?.history && !historyLoading ? locatedEntry?.id : undefined} locationRequest={location?.history ? location : undefined} onLocateMessage={locateMessage} projectTimeline onOpen={openResource} /></Dialog>}
    {retry && <Dialog title="核对任务后重试" onClose={() => setRetry(null)}><div className="form-stack"><p className="inline-warning">请核对上次执行和已有成果，避免重复操作。</p><p>{retry.instruction}</p><label className="confirm-choice"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />我已核对，确认可以重试</label><button className="button primary" disabled={!confirmed || busy} onClick={async () => { if (await execute({ type: 'retry_task', projectId: project.id, taskId: retry.id, confirmed: true })) setRetry(null); }}>确认重试</button></div></Dialog>}
  </main>;
}
