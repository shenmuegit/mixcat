import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import { getViewportForBounds, Handle, MarkerType, Panel, Position, ReactFlow, useInternalNode, useNodesState, useUpdateNodeInternals, type Edge, type Node, type NodeProps, type ReactFlowInstance } from '@xyflow/react';
import type { AppCommand, AppSnapshot, CapabilityCatalog, EdgeLayout, NodeDefinition, NodeView, ProjectSnapshot, WorkflowEdge, WorkflowGroup } from '../shared/types';
import { EditableEdge } from './EditableEdge';
import { Dialog } from './Dialog';
import { Icon } from './Icon';
import { moveMenuFocus, useActionMenuPosition, type MenuLocation } from './action-menu';
import { NodeDetailsButton } from './NodeDetailsButton';
import { arrangeWorkflow, workflowBounds } from '../shared/workflow-layout';
import { groupBounds, projectEdgeBounds } from '../shared/group-geometry';
import { GroupNode, GroupEditor, type GroupCanvasNode } from './WorkflowGroups';
import { NewNodeForm, nodeConfigModel } from './NodeSettings';
import { classifyNativeRequest } from '../shared/native-requests';
import type { ReviewAction } from './HumanReviews';
import type { WorkbenchRequest } from './ProjectManagement';
import { SessionPane, type SessionPaneHandle } from './SessionPane';

import type { Execute } from './execute-command';
type WorkflowNode = Node<{ node: NodeView; model: string | null; onReview?: () => void }, 'conversation'>;
type CanvasNode = WorkflowNode | GroupCanvasNode;
const labels: Record<string, string> = { idle: '空闲', starting: '启动中', running: '运行中', pausing: '暂停中', resuming: '等待续接', paused: '已暂停', blocked: '需处理', completed: '已完成', queued: '排队中', waiting_source: '等待来源', waiting_review: '等待核对', failed: '失败', needs_reconciliation: '状态待核对', cancelled: '已取消' };
const minCanvasZoom = .2, maxCanvasZoom = 1.5;
const workingStates = ['starting', 'running', 'pausing', 'resuming'];
const deliveryStates = [...workingStates, 'needs_reconciliation', 'paused', 'waiting_review', 'waiting_source', 'queued'];

export function relatedNodePosition(position: NodeDefinition['position'], occupied: { position: NodeDefinition['position']; measured?: { width?: number; height?: number } }[]) {
  const candidate = { ...position }, width = 215, height = 200, gap = 24;
  while (occupied.some(node => candidate.x < node.position.x + (node.measured?.width ?? width) + gap && candidate.x + width + gap > node.position.x
    && candidate.y < node.position.y + (node.measured?.height ?? height) + gap && candidate.y + height + gap > node.position.y)) candidate.y += 230;
  return candidate;
}

export function toWorkflowEdges(definitions: WorkflowEdge[], nodes: NodeView[], onEdit: (edge: WorkflowEdge) => void, selectedNodeId?: string, execution?: Pick<ProjectSnapshot, 'tasks' | 'messages'>): Edge[] {
  const ids = new Set(nodes.map(node => node.id));
  const pendingTasks = (execution?.tasks ?? []).filter(task => deliveryStates.includes(task.status));
  return definitions.filter(edge => ids.has(edge.sourceNodeId) && ids.has(edge.targetNodeId)).map(edge => {
    const highlighted = edge.sourceNodeId === selectedNodeId || edge.targetNodeId === selectedNodeId;
    const target = nodes.find(node => node.id === edge.targetNodeId)!;
    const states: string[] = (execution?.messages ?? []).flatMap(message => {
      const accepted = message.edgeSnapshot;
      if (!accepted || accepted.id !== edge.id || accepted.revision !== edge.revision || accepted.condition !== edge.condition || accepted.sourceNodeId !== edge.sourceNodeId || accepted.targetNodeId !== edge.targetNodeId || message.fromNodeId !== edge.sourceNodeId || message.toNodeId !== edge.targetNodeId) return [];
      return pendingTasks.filter(task => task.nodeId === edge.targetNodeId && (task.incomingMessageId === message.message_id || task.id === message.target_task_id)).map(task =>
        task.status === 'running' && workingStates.includes(target.status) ? target.status : task.status === 'queued' && target.status === 'paused' ? 'paused' : task.status);
    });
    const status = deliveryStates.find(status => states.includes(status));
    const activity = status ? { status, label: labels[status], working: workingStates.includes(status) } : undefined;
    const color = activity ? activity.working ? 'var(--theme-success,#0f766e)' : 'var(--theme-warning,#a16207)' : highlighted ? 'var(--theme-accent,#2563eb)' : 'var(--theme-faint,#888888)';
    return {
    id: `definition:${edge.id}`, source: edge.sourceNodeId, target: edge.targetNodeId, type: 'condition',
    data: { definitionId: edge.id, definition: edge, onEdit, highlighted, activity },
    animated: activity?.working ?? false, className: activity ? 'workflow-edge has-activity' : undefined, zIndex: activity?.working ? 2 : activity ? 1 : 0,
    markerEnd: { type: MarkerType.ArrowClosed, color },
    style: { stroke: color, strokeWidth: activity ? 3.5 : highlighted ? 3 : 1.5, opacity: 1 },
  }; });
}
function Status({ value }: { value: string }) {
  return <span className={`status status-${value}`} data-status={value}><span className="node-status-dot" aria-hidden="true" />{labels[value] ?? value}</span>;
}
function ConversationNode({ id, data, selected }: NodeProps<WorkflowNode>) {
  const node = data.node;
  const internal = useInternalNode(id), updateNodeInternals = useUpdateNodeInternals();
  const measured = !!internal?.measured.width && !!internal.measured.height;
  const hasHandles = !!internal?.internals.handleBounds;
  useEffect(() => {
    // A snapshot can replace a node after React Flow measures it and before its handles are copied.
    if (measured && !hasHandles) updateNodeInternals(id);
  }, [id, measured, hasHandles, updateNodeInternals]);
  const working = workingStates.includes(node.status);
  return <div className={`conversation-node ${selected ? 'is-selected' : ''}${working ? ' is-working' : ''}`} data-node-status={node.status} aria-busy={working}>
    <Handle type="target" position={Position.Left} isConnectable={false} />
    <div className="node-top">
      {data.onReview && <button type="button" className="node-review-marker nodrag nopan nokey" aria-label={`${node.name}，待人工核对`} onClick={event => { event.stopPropagation(); data.onReview?.(); }}>待人工核对</button>}
      <Status value={node.status} />
    </div>
    <h3>{node.name}</h3>
    <p>{node.instructions || '独立 Codex 会话'}</p>
    {data.model && <div className="node-model" title={data.model}>{data.model}</div>}
    <Handle type="source" position={Position.Right} isConnectable={false} />
    <Handle id="return-source" type="source" position={Position.Bottom} style={{ left: '38%' }} isConnectable={false} />
    <Handle id="return-target" type="target" position={Position.Bottom} style={{ left: '62%' }} isConnectable={false} />
  </div>;
}
const nodeTypes = { conversation: ConversationNode, workflowGroup: GroupNode };
const edgeTypes = { condition: EditableEdge };
export function Workbench({ snapshot, runtime, execute, busy, pendingExecution = false, error, onError, reviewActions, obscured = false, fitInitialLayout = false, workRequest, onDirty }: { snapshot: ProjectSnapshot; runtime: AppSnapshot['runtime']; execute: Execute; busy: boolean; pendingExecution?: boolean; error: string | null; onError: (error: string) => void; reviewActions?: Map<string, ReviewAction>; obscured?: boolean; fitInitialLayout?: boolean; workRequest?: WorkbenchRequest; onDirty?: (dirty: boolean) => void }) {
  const { project } = snapshot;
  const session = useRef<SessionPaneHandle>(null);
  const [catalog, setCatalog] = useState<CapabilityCatalog | null>(null), [loadingCatalog, setLoadingCatalog] = useState(false);
  const catalogRequest = useRef(0);
  async function reloadCatalog() { const request = ++catalogRequest.current; setLoadingCatalog(true); try { const reply = await execute({ type: 'catalog', projectId: project.id }); if (request === catalogRequest.current) setCatalog(reply?.catalog ?? null); } finally { if (request === catalogRequest.current) setLoadingCatalog(false); } }

  const [selectedId, setSelectedId] = useState(snapshot.nodes[0]?.id ?? '');
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const selected = snapshot.nodes.find(node => node.id === selectedId) ?? snapshot.nodes[0];
  const [detailsOpen, setDetailsOpen] = useState(true);
  const canvasFocus = useRef<HTMLDivElement>(null);
  const detailsOpener = useRef<HTMLButtonElement>(null);
  const detailsBody = useRef<HTMLDivElement>(null);
  const resetCancel = useRef<HTMLButtonElement>(null);
  const resetTrigger = useRef<HTMLButtonElement>(null);
  const resetDescriptionId = useId();
  const resetAvailabilityId = useId();
  const [detailsWidth, setDetailsWidth] = useState(420);
  const [resizingDetails, setResizingDetails] = useState(false);
  function resizeDetails(width: number) { setDetailsWidth(Math.max(320, Math.min(width, Math.max(320, (detailsBody.current?.clientWidth ?? 690) - 270)))); }
  useEffect(() => {
    const body = detailsBody.current; if (!body) return;
    const observer = new ResizeObserver(() => setDetailsWidth(width => Math.max(320, Math.min(width, Math.max(320, body.clientWidth - 270)))));
    observer.observe(body); return () => observer.disconnect();
  }, []);
  function closeDetails() {
    setResizingDetails(false);
    setDetailsOpen(false);
    requestAnimationFrame(() => (detailsOpener.current ?? canvasFocus.current)?.focus());
  }
  function reopenDetails() {
    setDetailsOpen(true);
    requestAnimationFrame(() => detailsBody.current?.querySelector<HTMLButtonElement>('#node-details-drawer [role="tab"][aria-selected="true"]')?.focus());
  }
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
  const [menu, setMenu] = useState<(MenuLocation & { position: NodeDefinition['position']; nodeId?: string; groupId?: string }) | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTrigger = useRef<HTMLElement | null>(null);
  useActionMenuPosition(menuRef, menu);
  const [creation, setCreation] = useState<{ position: NodeDefinition['position']; relatedTo?: string } | null>(null);
  useEffect(() => { if (creation) void reloadCatalog(); return () => { catalogRequest.current++; }; }, [!!creation]);
  useEffect(() => { if (workRequest) { setSelectedId(workRequest.nodeId); setDetailsOpen(true); } }, [workRequest?.id]);
  const [edgeDraft, setEdgeDraft] = useState<WorkflowEdge | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const resetInFlight = useRef(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const reconciliationNodes = new Set(snapshot.tasks.filter(task => task.status === 'needs_reconciliation' && !task.steering).map(task => task.nodeId));
  const canPauseAll = snapshot.nodes.some(node => !reconciliationNodes.has(node.id) && !['paused', 'pausing'].includes(node.status));
  const resumableNodes = snapshot.nodes.filter(node => !reconciliationNodes.has(node.id) && snapshot.resumeNodeIds?.includes(node.id) && ['paused', 'pausing'].includes(node.status));
  const canResumeAll = resumableNodes.length > 0 || snapshot.nodes.some(node => node.status === 'paused' && !snapshot.tasks.some(task => task.nodeId === node.id && ['running', 'paused', 'queued', 'waiting_source', 'needs_reconciliation'].includes(task.status)));
  const deletingNode = snapshot.nodes.find(node => node.id === deletingId);
  const resetReason = pendingExecution || snapshot.tasks.some(task => !['completed', 'failed', 'cancelled'].includes(task.status))
    || snapshot.nodes.some(node => ['starting', 'running', 'pausing', 'resuming'].includes(node.status))
    ? '工作流仍有未完成任务或启动操作，请先停止本轮并核对后重置。'
    : snapshot.requests?.length ? '工作流仍有待回应请求，请先处理请求后重置。' : null;
  const resetAvailability = resetReason ?? (busy || resetting ? '请等待当前操作完成。' : null);
  const { reviewNodeIds, otherRequests } = useMemo(() => {
    const reviewNodeIds = new Set<string | null>((snapshot.humanReviews ?? []).filter(review => review.status === 'pending').map(review => review.nodeId));
    const otherRequests = [];
    for (const request of snapshot.requests ?? []) {
      if (classifyNativeRequest(request) === 'question') reviewNodeIds.add(request.nodeId);
      else otherRequests.push(request);
    }
    return { reviewNodeIds, otherRequests };
  }, [snapshot.humanReviews, snapshot.requests]);
  const hasUnassignedReview = [...reviewNodeIds].some(id => !snapshot.nodes.some(node => node.id === id));
  function openReviews(nodeId?: string) {
    if (nodeId) {
      setSelectedEdgeId(null);
      setSelectedId(nodeId);
      session.current?.latest(nodeId);
    }
    session.current?.conversation();
    setDetailsOpen(true);
    session.current?.reviews(nodeId);
  }
  function deletionBlockReason(nodeId: string) {
    if (groups.some(group => group.coordinatorNodeId === nodeId)) return '请先更换分组协调节点或解除分组，再删除此节点。';
    if (snapshot.reviewPolicy?.checkpoints.some(point => point.ownerNodeId === nodeId || point.requiredForNodeIds.includes(nodeId)) || snapshot.humanReviews?.some(review => review.nodeId === nodeId && review.status === 'pending'))
      return '节点仍有关联的核对约束或待回答事项，请先处理后再删除。';
    if (snapshot.tasks.some(task => task.nodeId === nodeId && ['running', 'paused', 'queued', 'waiting_source', 'waiting_review', 'needs_reconciliation'].includes(task.status))
      || snapshot.nodes.some(node => node.id === nodeId && ['starting', 'running', 'pausing', 'resuming'].includes(node.status)))
      return '节点仍有未完成任务。请先停止本轮，并核对状态待确认的任务后再删除。';
    if (snapshot.requests?.some(request => !request.nodeId || request.nodeId === nodeId))
      return '节点仍有原生请求待回应。请先处理请求，或停止本轮并核对任务后再删除。';
    return null;
  }
  const definitions = snapshot.edges ?? [];
  const visibleLayouts = arrangePreview ?? snapshot.edgeLayouts ?? {};
  const edges = useMemo<Edge[]>(() => toWorkflowEdges(definitions, snapshot.nodes, setEdgeDraft, selected?.id, snapshot).map(edge => {
    const id = String(edge.data!.definitionId), editing = selectedEdgeId === id;
    const editingColor = editing && !edge.data!.activity;
    const projected = groups.length ? projectEdgeBounds(edge.data!.definition as WorkflowEdge, groups, nodes, definitions, visibleLayouts) : null;
    return { ...edge, selected: editing,
      data: { ...edge.data, disabled: arranging, sourceBounds: projected?.source, targetBounds: projected?.target, layout: arrangePreview && Object.hasOwn(arrangePreview, id) ? arrangePreview[id] : Object.hasOwn(snapshot.edgeLayouts ?? {}, id) ? snapshot.edgeLayouts![id] : undefined, onLayout: async (edgeId: string, layout: EdgeLayout) => {
        const layouts = (await execute({ type: 'save_edge_layout', projectId: project.id, edgeId, layout }))?.snapshot.selected?.edgeLayouts;
        return layouts && Object.hasOwn(layouts, edgeId) ? layouts[edgeId] : null;
      } },
      markerEnd: editingColor ? { type: MarkerType.ArrowClosed, color: 'var(--theme-accent,#2563eb)' } : edge.markerEnd,
      style: editingColor ? { ...edge.style, stroke: 'var(--theme-accent,#2563eb)', strokeWidth: 3 } : edge.style };
  }), [snapshot.nodes, snapshot.tasks, snapshot.messages, definitions, selected?.id, snapshot.edgeLayouts, selectedEdgeId, execute, project.id, arranging, arrangePreview, snapshot.groups, nodes]);
  useEffect(() => {
    if (dragging.current) return;
    setNodes(current => snapshot.nodes.map(node => ({
      ...current.find(item => item.id === node.id),
      id: node.id,
      position: pendingMoves.get(node.id) ?? node.position,
      type: 'conversation',
      zIndex: 5,
      // The card and configuration use the same model before and after an inherited model is saved.
      data: { node, model: nodeConfigModel(node, snapshot.tasks) },
      ariaLabel: `${node.name}，${labels[node.status]}`,
    })));
  }, [snapshot.nodes, snapshot.tasks, pendingMoves, setNodes]);
  useEffect(() => {
    if (restoredView.current || (fitInitialLayout && obscured) || !flow.current || !nodes.length || nodes.some(node => !node.measured?.width || !node.measured?.height)) return;
    const instance = flow.current, first = nodes.find(node => node.id === selectedId) ?? nodes[0];
    const frame = requestAnimationFrame(async () => {
      const canvas = canvasFocus.current, layouts = snapshot.edgeLayouts ?? {};
      if (fitInitialLayout && (!canvas?.clientWidth || !canvas.clientHeight)) return;
      restoredView.current = true;
      if (fitInitialLayout && canvas) {
        // The template status can resize the canvas in the same frame that it becomes visible.
        const bounds = workflowBounds(nodes, definitions, layouts, groups);
        await instance.setViewport(getViewportForBounds(bounds, canvas.clientWidth, canvas.clientHeight, minCanvasZoom, maxCanvasZoom, .08));
        return;
      }
      if (Object.values(layouts).some(layout => layout.route)) await instance.fitBounds(workflowBounds(nodes, definitions, layouts, groups), { padding: .08 });
      else await instance.fitView({ padding: .25, maxZoom: 1 });
      // Large graphs stay readable on entry; manual zoom and explicit arrangement still show the full graph.
      if (instance.getZoom() < .75) await instance.setCenter(first.position.x + first.measured!.width! / 2, first.position.y + first.measured!.height! / 2, { zoom: 1 });
    });
    return () => cancelAnimationFrame(frame);
  }, [nodes, definitions, snapshot.edgeLayouts, snapshot.groups, selectedId, fitInitialLayout, obscured]);
  useEffect(() => {
    const layer = menuRef.current;
    if (!menu || !layer) return;
    layer.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
    const close = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as HTMLElement)) setMenu(null); };
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || !layer.contains(document.activeElement)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        setMenu(null);
        focusMenuTrigger();
      } else if (event.key === 'Tab') setMenu(null);
      else moveMenuFocus(event, layer);
    };
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', key); };
  }, [menu]);
  function focusMenuTrigger() {
    const target = menuTrigger.current;
    if (target?.isConnected && target.getClientRects().length) target.focus({ preventScroll: true });
    if (!target || document.activeElement !== target) canvasFocus.current?.focus({ preventScroll: true });
  }
  function closeReset() {
    setResetOpen(false);
    requestAnimationFrame(() => (resetTrigger.current?.disabled ? canvasFocus.current : resetTrigger.current)?.focus());
  }
  async function resetWorkflow() {
    if (busy || resetInFlight.current || resetReason) return;
    resetInFlight.current = true; setResetting(true);
    try {
      if (!(await execute({ type: 'reset_workflow', projectId: project.id, confirmed: true }))) return;
      session.current?.reset(); closeReset();
    } finally { resetInFlight.current = false; setResetting(false); }
  }
  function create(position: NodeDefinition['position'], relatedTo?: string) { setCreation({ position: relatedTo ? relatedNodePosition(position, nodes) : position, relatedTo }); setMenu(null); }
  function editGroup(group?: WorkflowGroup, initialId?: string) {
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && !menuRef.current?.contains(focused)) menuTrigger.current = focused;
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
  }), ...nodes.map(node => ({
    ...node,
    selected: selected?.id === node.id,
    ...(reviewNodeIds.has(node.id) && {
      ariaLabel: `${node.ariaLabel}，待人工核对`,
      data: { ...node.data, onReview: () => openReviews(node.id) },
    }),
  }))];
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
  function closeNodeDeletion() {
    setDeletingId(null);
    requestAnimationFrame(focusMenuTrigger);
  }
  const modalOpen = obscured || !!creation || !!groupDraft || !!edgeDraft || resetOpen || !!deletingNode || !!menu;
  const menuDeleteReason = menu?.nodeId ? deletionBlockReason(menu.nodeId) ?? (busy ? '请等待当前操作完成。' : null) : null;
  return <main className="workbench session-workbench">
    <header className="project-header">
      <div className="project-controls">
        <div className="workbench-button-group" role="group" aria-label="项目运行控制">
          <button className="button secondary compact" disabled={!canPauseAll} onClick={() => void execute({ type: 'pause', projectId: project.id })}>全部暂停</button>
          <button className="button secondary compact" disabled={!canResumeAll} title="续接全部暂停时记录的运行节点，其他空闲节点恢复待命" onClick={() => void execute({ type: 'resume', projectId: project.id })}>全部开启</button>
          <button className="button secondary compact" disabled={!pendingExecution && !['running', 'pausing', 'paused', 'blocked'].includes(project.status)} onClick={() => void execute({ type: 'stop', projectId: project.id })}>停止本轮</button>
          <button ref={resetTrigger} type="button" className="button secondary compact danger-button workflow-reset-action" disabled={!!resetAvailability} aria-describedby={resetReason ? resetAvailabilityId : undefined} title={resetAvailability ?? '清空所有节点的会话与执行记录，下次发送建立新会话'} onClick={() => setResetOpen(true)}>重置工作流</button>
        </div>
        {otherRequests.length > 0 && <button type="button" className="text-button workflow-request-button" onClick={() => {
          const nodeId = otherRequests[0].nodeId;
          if (nodeId) setSelectedId(nodeId);
          session.current?.conversation();
          setDetailsOpen(true);
        }}>{otherRequests.length} 个请求待回应</button>}
        {hasUnassignedReview && <button type="button" className="text-button workflow-request-button" onClick={() => openReviews()}>查看项目待回应事项</button>}
        {resetReason && <p id={resetAvailabilityId} className="workflow-reset-reason">{resetReason}</p>}
      </div>
    </header>
    <div ref={detailsBody} style={{ '--details-width': detailsWidth + 'px' } as CSSProperties} className={detailsOpen ? 'workbench-body' : 'workbench-body details-collapsed'}><section className="canvas-column" aria-label="工作流画布">
      <div ref={canvasFocus} className="flow-wrap" tabIndex={0} aria-label="工作流画布，Shift+F10 打开画布菜单" aria-keyshortcuts="Shift+F10" onKeyDown={event => {
        const trigger = event.target instanceof HTMLElement ? event.target : event.currentTarget;
        if (event.key === 'Enter' && trigger.matches('.react-flow__node')) { event.preventDefault(); trigger.click(); }
        if (!(event.shiftKey && event.key === 'F10') && event.key !== 'ContextMenu') return;
        event.preventDefault();
        const target = trigger.closest('.react-flow__node');
        const node = canvasNodes.find(item => item.id === target?.getAttribute('data-id'));
        const rect = (target ?? event.currentTarget).getBoundingClientRect();
        menuTrigger.current = trigger;
        setMenu({
          x: rect.x + 40, y: rect.y + 40, anchor: trigger !== event.currentTarget ? trigger : undefined,
          position: node ? { x: node.position.x + 300, y: node.position.y } : flow.current?.screenToFlowPosition({ x: rect.x + 40, y: rect.y + 40 }) ?? { x: 80, y: 100 },
          ...node && ('group' in node.data ? { groupId: node.data.group.id } : { nodeId: node.id })
        });
      }}>
        <ReactFlow<CanvasNode> nodes={canvasNodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onInit={instance => { flow.current = instance; }} onNodesChange={changes => onNodesChange(changes.filter(change => change.type !== 'add' && change.type !== 'replace'))} onNodeClick={(_, node) => { setSelectedEdgeId(null); if (!('group' in node.data)) { setSelectedId(node.id); session.current?.latest(node.id); setDetailsOpen(true); } }} onPaneClick={() => setSelectedEdgeId(null)}
          onPaneContextMenu={event => { event.preventDefault(); menuTrigger.current = canvasFocus.current; setMenu({ x: event.clientX, y: event.clientY, position: flow.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY }) ?? { x: 80, y: 100 } }); }}
          onNodeContextMenu={(event, node) => {
            event.preventDefault(); event.stopPropagation();
            const target = event.target instanceof Element ? event.target.closest<HTMLElement>('.react-flow__node') : null;
            menuTrigger.current = target?.querySelector<HTMLElement>('.workflow-group-title') ?? target ?? canvasFocus.current;
            if (!('group' in node.data)) setSelectedId(node.id);
            setMenu({ x: event.clientX, y: event.clientY, position: { x: node.position.x + 300, y: node.position.y }, ...('group' in node.data ? { groupId: node.data.group.id } : { nodeId: node.id }) });
          }}
          onEdgeClick={(_, edge) => { if (edge.data?.definitionId) setSelectedEdgeId(String(edge.data.definitionId)); }}
          onEdgeDoubleClick={(_, edge) => { const definition = definitions.find(item => item.id === edge.data?.definitionId); if (definition) setEdgeDraft({ ...definition }); }}
          onNodeDragStart={(_, node) => { dragging.current = true; if ('group' in node.data) { const group = node.data.group, bounds = groupBounds(group, nodes, definitions, visibleLayouts)!; groupDrag.current = { origin: { x: bounds.x, y: bounds.y }, positions: new Map(nodes.filter(member => group.nodeIds.includes(member.id)).map(member => [member.id, { ...member.position }])) }; } else { setSelectedEdgeId(null); setSelectedId(node.id); if (selected?.id !== node.id) session.current?.latest(node.id); } }}
          onNodeDrag={(_, node) => { if ('group' in node.data) moveGroupPreview(node.position); }}
          onNodeDragStop={(_, node) => { if ('group' in node.data) { const positions = groupPositions(node.position); moveGroupPreview(node.position); void moveMembers(positions); } else void moveNode(node as WorkflowNode); }}
          nodesConnectable={false} nodesDraggable={!arranging} nodeDragThreshold={6} nodeClickDistance={6} deleteKeyCode={null} minZoom={minCanvasZoom} maxZoom={maxCanvasZoom} proOptions={{ hideAttribution: true }}>
          {!detailsOpen && selected && <Panel position="top-right" className="workflow-reopen-panel">
            <NodeDetailsButton ref={detailsOpener} expanded={false} description={selected.name} onClick={reopenDetails} />
          </Panel>}
          <Panel position="bottom-left" style={{ zIndex: 1007 }}><button className="button secondary compact workflow-arrange" aria-label="整理画布" title="整理节点、连线和条件标签，并适配视图" disabled={arranging || !!pendingMoves.size || !nodes.length} onClick={() => void arrange()}>{arranging ? '整理中…' : '整理'}</button></Panel>
        </ReactFlow>
      </div>
    </section>
    <aside id="node-details-drawer" className="detail-panel session-detail" aria-label="节点详情" hidden={!detailsOpen} onKeyDown={event => { if (!event.defaultPrevented && event.key === 'Escape' && !event.nativeEvent.isComposing && !modalOpen) { event.stopPropagation(); closeDetails(); } }}>
      <div className="drawer-resizer" role="separator" aria-label="调整节点详情宽度" aria-orientation="vertical" aria-controls="node-details-drawer" aria-valuemin={320} aria-valuemax={Math.max(320, (detailsBody.current?.clientWidth ?? 690) - 270)} aria-valuenow={Math.round(detailsWidth)} tabIndex={0} onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); setResizingDetails(true);
      }} onPointerMove={event => { if (resizingDetails && detailsBody.current) resizeDetails(detailsBody.current.getBoundingClientRect().right - event.clientX); }} onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); setResizingDetails(false); }} onPointerCancel={() => setResizingDetails(false)} onLostPointerCapture={() => setResizingDetails(false)} onKeyDown={event => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); resizeDetails((event.currentTarget.parentElement?.getBoundingClientRect().width ?? detailsWidth) + (event.key === 'ArrowLeft' ? 24 : -24)); }
      }} />
      <SessionPane ref={session} snapshot={snapshot} runtime={runtime} execute={execute} nodeId={selected?.id ?? ''} busy={busy} error={error} onError={onError} reviewActions={reviewActions} obscured={modalOpen} visible={detailsOpen} resizingDetails={resizingDetails} onClose={closeDetails} onOpen={() => setDetailsOpen(true)} onSelect={setSelectedId} workRequest={workRequest} onDirty={onDirty} />
    </aside></div>
    {menu && <div className="canvas-context-menu action-menu" role="menu" aria-label="画布操作" ref={menuRef}>
      <button role="menuitem" onClick={() => create(menu.position, menu.nodeId)}><Icon name="plus" size={16} />{menu.nodeId ? '新增关联节点' : '新增节点'}</button>
      <button role="menuitem" disabled={arranging || !!pendingMoves.size} onClick={() => editGroup(groups.find(group => group.id === menu.groupId || group.nodeIds.includes(menu.nodeId ?? '')), menu.nodeId)}><Icon name="nodes" size={16} />{groups.some(group => group.id === menu.groupId || group.nodeIds.includes(menu.nodeId ?? '')) ? '编辑分组' : '创建分组'}</button>
      {!menu.nodeId && !menu.groupId && <button role="menuitem" disabled={resetting} onClick={() => {
        canvasFocus.current?.focus({ preventScroll: true });
        setMenu(null);
        session.current?.history();
      }}><Icon name="book" size={16} />项目会话历史</button>}
      {menu.nodeId && <button role="menuitem" onClick={() => { focusMenuTrigger(); setSelectedId(menu.nodeId!); session.current?.config(); setMenu(null); setDetailsOpen(true); }}><Icon name="settings" size={16} />配置此节点</button>}
      {menu.nodeId && <button role="menuitem" className="danger-button" disabled={!!menuDeleteReason} title={menuDeleteReason ?? undefined} aria-describedby={menuDeleteReason ? 'node-delete-menu-reason' : undefined} onClick={() => { setDeletingId(menu.nodeId!); setMenu(null); }}><Icon name="close" size={16} />删除节点</button>}
      {menuDeleteReason && <p id="node-delete-menu-reason" className="action-menu-reason">{menuDeleteReason}</p>}
    </div>}
    {groupDraft && <Dialog title={groupDraft.revision ? '编辑分组' : '创建分组'} onClose={() => {
      if (groupSaving) return;
      setGroupDraft(null); requestAnimationFrame(focusMenuTrigger);
    }}>{error && <p className="inline-error" role="alert">{error}</p>}<GroupEditor value={groupDraft} nodes={snapshot.nodes} groups={groups} busy={groupSaving} onChange={setGroupDraft} onSave={async () => {
      setGroupSaving(true); try { if (await execute({ type: 'save_group', projectId: project.id, group: groupDraft })) setGroupDraft(null); } finally { setGroupSaving(false); }
    }} onDelete={groupDraft.revision ? async () => { setGroupSaving(true); try { if (await execute({ type: 'delete_group', projectId: project.id, groupId: groupDraft.id, revision: groupDraft.revision })) setGroupDraft(null); } finally { setGroupSaving(false); } } : undefined} /></Dialog>}
    {deletingNode && <Dialog title="删除节点" onClose={closeNodeDeletion}><div className="form-stack"><p>确认从画布移除「{deletingNode.name}」？</p><p className="muted">该节点的配置和关联线会一并删除，清除未发送的消息和未保存的输入。可在画布空白处右键打开「项目会话历史」。</p>{deletionBlockReason(deletingNode.id) && <p className="inline-warning" role="alert">{deletionBlockReason(deletingNode.id)}</p>}{error && <p className="inline-error" role="alert">{error}</p>}<div className="modal-actions"><button className="button secondary" onClick={closeNodeDeletion}>取消</button><button className="button primary danger-button" disabled={busy || !!deletionBlockReason(deletingNode.id)} onClick={async () => { if (deletionBlockReason(deletingNode.id)) return; if (await execute({ type: 'delete_node', projectId: project.id, nodeId: deletingNode.id })) { session.current?.discard(deletingNode.id); setDeletingId(null); } }}>确认删除</button></div></div></Dialog>}
    {creation && <Dialog title={creation.relatedTo ? '新增关联节点' : '新增节点'} onClose={() => {
      setCreation(null); requestAnimationFrame(focusMenuTrigger);
    }}>{error && <p className="inline-error">{error}</p>}<NewNodeForm comfy={project.template === 'comfyui'} position={creation.position} relatedName={snapshot.nodes.find(node => node.id === creation.relatedTo)?.name} catalog={catalog} loading={loadingCatalog} busy={busy} onReload={() => void reloadCatalog()} onSave={async (node, condition) => { const reply = await execute({ type: 'save_node', projectId: project.id, node, relatedTo: creation.relatedTo, condition }); if (reply) { setSelectedId(node.id); setCreation(null); session.current?.conversation(); setDetailsOpen(true); } }} /></Dialog>}
    {edgeDraft && <Dialog title="关联条件" onClose={() => setEdgeDraft(null)}><form className="form-stack" onSubmit={async event => { event.preventDefault(); if (await execute({ type: 'save_edge', projectId: project.id, edge: edgeDraft })) setEdgeDraft(null); }}>{error && <p className="inline-error" role="alert">{error}</p>}<p>{snapshot.nodes.find(n => n.id === edgeDraft.sourceNodeId)?.name} → {snapshot.nodes.find(n => n.id === edgeDraft.targetNodeId)?.name}</p><label>条件<textarea aria-label="条件" rows={5} value={edgeDraft.condition} onChange={e => setEdgeDraft(current => current && { ...current, condition: e.target.value })} /></label><p className="field-note">条件说明保存在关联边上，自动选择规则待后续确定。</p><div className="modal-actions"><button type="button" className="button secondary" disabled={busy} onClick={async () => { if (await execute({ type: 'delete_edge', projectId: project.id, edgeId: edgeDraft.id })) setEdgeDraft(null); }}>移除关联</button><button className="button primary" disabled={busy}>保存条件</button></div></form></Dialog>}
    {resetOpen && <Dialog title="重置工作流" className="project-dialog" closeLabel="取消重置" closeDisabled={resetting}
      initialFocus={resetCancel} descriptionId={resetDescriptionId} onClose={() => { if (!resetInFlight.current) closeReset(); }}>
      <div className="workflow-reset-content">
        <div className="workflow-reset-scroll">
          <p id={resetDescriptionId} className="workflow-reset-description">将重置项目 <strong>{project.name}</strong>。节点恢复空闲，下次发送会创建新会话。</p>
          <dl className="workflow-reset-impact">
            <div><dt>清除</dt><dd>所有节点（含已移除节点）的会话、当前输入和附件、任务、交接、消息、执行记录与人工核对结果。此操作不可撤销。</dd></div>
            <div><dt>保留</dt><dd>节点配置、条件边、分组、布局、人工核对规则、Issue、文档和项目文件。</dd></div>
          </dl>
          {resetReason && <p className="inline-warning" role="alert">{resetReason}</p>}
        </div>
        {error && <p className="inline-error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button ref={resetCancel} type="button" className="button secondary" disabled={resetting} onClick={closeReset}>取消</button>
          <button type="button" className="button primary danger-button" disabled={busy || resetting || !!resetReason} onClick={() => void resetWorkflow()}>{resetting ? '重置中…' : '确认重置'}</button>
        </div>
      </div>
    </Dialog>}
  </main>;
}
