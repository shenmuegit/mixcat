import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { BaseEdge, Controls, EdgeLabelRenderer, getSmoothStepPath, Handle, MarkerType, Position, ReactFlow, useNodesState, type Edge, type EdgeProps, type Node, type NodeProps, type ReactFlowInstance } from '@xyflow/react';
import type { AppCommand, AppReply, AppSnapshot, CapabilityCatalog, HandoffView, NativeInput, NodeDefinition, NodeView, ProjectSnapshot, TaskView, WorkflowEdge } from '../shared/types';
import { NodeConfig, NewNodeForm } from './NodeSettings';
import { ConversationFeed } from './Conversation';
import { NativeRequestCard } from './NativeRequests';
import { NodePanels } from './NodePanels';

type DraftNode = Omit<NodeDefinition, 'revision'> & { revision?: number };
type Execute = (command: AppCommand) => Promise<AppReply | null>;
type WorkflowNode = Node<{ node: NodeView; index: number; taskCount: number }, 'conversation'>;
const labels: Record<string, string> = { idle: '空闲', starting: '启动中', running: '运行中', pausing: '暂停中', resuming: '等待续接', paused: '已暂停', blocked: '需处理', completed: '已完成', queued: '排队中', failed: '失败', needs_reconciliation: '状态待核对', cancelled: '已取消' };

export function relatedNodePosition(position: NodeDefinition['position'], occupied: { position: NodeDefinition['position']; measured?: { width?: number; height?: number } }[]) {
  const candidate = { ...position }, width = 215, height = 200, gap = 24;
  while (occupied.some(node => candidate.x < node.position.x + (node.measured?.width ?? width) + gap && candidate.x + width + gap > node.position.x
    && candidate.y < node.position.y + (node.measured?.height ?? height) + gap && candidate.y + height + gap > node.position.y)) candidate.y += 230;
  return candidate;
}

export function toWorkflowEdges(handoffs: HandoffView[], nodes: NodeView[]): Edge[] {
  const ids = new Set(nodes.map(node => node.id));
  const routes = new Map<string, { handoff: HandoffView; count: number; returning: boolean }>();
  for (const handoff of handoffs) {
    if (!ids.has(handoff.fromNodeId) || !ids.has(handoff.toNodeId)) continue;
    const key = JSON.stringify([handoff.fromNodeId, handoff.toNodeId]);
    const previous = routes.get(key);
    const returning = previous?.returning ?? routes.has(JSON.stringify([handoff.toNodeId, handoff.fromNodeId]));
    routes.set(key, { handoff, count: (previous?.count ?? 0) + 1, returning });
  }
  return [...routes.values()].map(({ handoff, count, returning }) => ({
    id: handoff.id, source: handoff.fromNodeId, target: handoff.toNodeId,
    sourceHandle: returning ? 'return-source' : null, targetHandle: returning ? 'return-target' : null,
    label: returning ? (count > 1 ? `回流 · ${count} 次` : '回流') : count > 1 ? `${count} 次交接` : '交接', type: 'smoothstep',
    pathOptions: returning ? { offset: 48, borderRadius: 10 } : undefined,
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
  return <div className={`conversation-node ${selected ? 'is-selected' : ''}`}><Handle type="target" position={Position.Left} isConnectable={false} /><div className="node-top"><span className="node-number">{String(data.index + 1).padStart(2, '0')}</span><Status value={node.status} /></div><h3>{node.name}</h3><p>{node.instructions || '独立 Codex 会话'}</p><div className="node-model" title={node.model ?? '原生默认模型'}>{node.model ?? '原生默认模型'}</div><div className="node-bottom"><span>{node.threadId ? '已建立会话' : '独立会话'}</span><span>{data.taskCount} 项任务</span></div><Handle type="source" position={Position.Right} isConnectable={false} /><Handle id="return-source" type="source" position={Position.Bottom} style={{ left: '38%' }} isConnectable={false} /><Handle id="return-target" type="target" position={Position.Bottom} style={{ left: '62%' }} isConnectable={false} /></div>;
}
const nodeTypes = { conversation: ConversationNode };
function ConditionEdge(props: EdgeProps<Edge<{ definition: WorkflowEdge; onEdit: (edge: WorkflowEdge) => void }>>) {
  const [path, x, y] = getSmoothStepPath(props);
  const { definition, onEdit } = props.data!;
  return <><BaseEdge id={props.id} path={path} markerEnd={props.markerEnd} style={props.style} /><EdgeLabelRenderer><button className="condition-label nodrag nopan" style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }} title={definition.condition || '点击设置条件'} aria-label={`编辑关联条件：${definition.condition || '尚未设置'}`} onClick={() => onEdit({ ...definition })}>条件 · {definition.condition || '点击设置'}</button></EdgeLabelRenderer></>;
}
const edgeTypes = { condition: ConditionEdge };
function attachmentLabel(input: NativeInput) {
  if (typeof input.path === 'string') return input.path.split(/[\\/]/).at(-1);
  if (typeof input.text === 'string') return input.text.split('\n')[0].replace(/^附件：/, '');
  return String(input.name ?? input.type);
}

export function Workbench({ snapshot, runtime, execute, busy, error, onBack, onError }: { snapshot: ProjectSnapshot; runtime: AppSnapshot['runtime']; execute: Execute; busy: boolean; error: string | null; onBack: () => void; onError: (error: string) => void }) {
  const { project } = snapshot;
  const [selectedId, setSelectedId] = useState(snapshot.nodes[0]?.id ?? '');
  const selected = snapshot.nodes.find(node => node.id === selectedId) ?? snapshot.nodes[0];
  const [tab, setTab] = useState<'conversation' | 'config' | 'panels'>('conversation');
  const mode = project.mode;
  const [drafts, setDrafts] = useState<Record<string, { text: string; attachments: NativeInput[] }>>({});
  const draft = drafts[selected?.id] ?? { text: '', attachments: [] };
  const [catalog, setCatalog] = useState<CapabilityCatalog | null>(null);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [nodes, setNodes, onNodesChange] = useNodesState<WorkflowNode>([]);
  const flow = useRef<ReactFlowInstance<WorkflowNode> | null>(null);
  const dragging = useRef(false);
  const [menu, setMenu] = useState<{ x: number; y: number; position: NodeDefinition['position']; nodeId?: string } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [creation, setCreation] = useState<{ position: NodeDefinition['position']; relatedTo?: string } | null>(null);
  const [edgeDraft, setEdgeDraft] = useState<WorkflowEdge | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyFailures, setHistoryFailures] = useState<string[]>([]);
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
    if (snapshot.tasks.some(task => task.nodeId === nodeId && ['running', 'paused', 'queued', 'waiting_source', 'needs_reconciliation'].includes(task.status))
      || snapshot.nodes.some(node => node.id === nodeId && ['starting', 'running', 'pausing', 'resuming'].includes(node.status)))
      return '节点仍有未完成任务。请先停止本轮，并核对状态待确认的任务后再删除。';
    if (snapshot.requests?.some(request => !request.nodeId || request.nodeId === nodeId))
      return '节点仍有原生请求待回应。请先处理请求，或停止本轮并核对任务后再删除。';
    return null;
  }
  const deleteReason = selected ? deletionBlockReason(selected.id) : null;
  const entries = snapshot.conversation ?? [];
  const nodeEntries = entries.filter(entry => entry.nodeId === selected?.id);
  const pendingTasks = snapshot.tasks.filter(task => task.nodeId === selected?.id && task.status === 'queued').length;
  const ongoing = selected && ['running', 'pausing', 'resuming'].includes(selected.status) && [...nodeEntries].reverse().find(entry => entry.direction === 'event' && ['inProgress', 'running', 'started'].includes(entry.status ?? '') && snapshot.tasks.some(task => task.id === entry.taskId && task.turnId === entry.turnId && task.status === 'running'));
  const definitions = snapshot.edges ?? [];
  const edges = useMemo(() => [
    ...toWorkflowEdges(snapshot.handoffs, snapshot.nodes),
    ...definitions.map(edge => ({ id: `definition:${edge.id}`, source: edge.sourceNodeId, target: edge.targetNodeId, type: 'condition', data: { definitionId: edge.id, definition: edge, onEdit: setEdgeDraft }, markerEnd: { type: MarkerType.ArrowClosed, color: '#a58abb' }, style: { stroke: '#a58abb', strokeWidth: 1.5 } })),
  ], [snapshot.handoffs, snapshot.nodes, definitions]);
  useEffect(() => {
    if (dragging.current) return;
    setNodes(snapshot.nodes.map((node, index) => ({ id: node.id, position: node.position, type: 'conversation', data: { node, index, taskCount: snapshot.tasks.filter(task => task.nodeId === node.id).length }, selected: selected?.id === node.id, ariaLabel: `${node.name}，${labels[node.status]}` })));
  }, [snapshot.nodes, snapshot.tasks, selected?.id, setNodes]);
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
  async function reloadCatalog() {
    if (loadingCatalog) return; setLoadingCatalog(true);
    try { const reply = await execute({ type: 'catalog', projectId: project.id }); if (reply?.catalog) setCatalog(reply.catalog); }
    finally { setLoadingCatalog(false); }
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
  function create(position: NodeDefinition['position'], relatedTo?: string) { setCreation({ position: relatedTo ? relatedNodePosition(position, nodes) : position, relatedTo }); setMenu(null); if (!catalog) void reloadCatalog(); }
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
    try { await window.mixcat.panel({ type: 'open', projectId: project.id, nodeId: targetNode.id, target: resource.path ? { type: 'file', path: resource.path } : { type: 'url', url: resource.url! } }); setSelectedId(targetNode.id); setTab('panels'); setHistoryOpen(false); }
    catch (error) { onError(error instanceof Error ? error.message : String(error)); }
  }
  async function saveNode(node: DraftNode) { const reply = await execute({ type: 'save_node', projectId: project.id, node }); return reply?.snapshot.selected?.nodes.find(n => n.id === node.id) ?? null; }
  const modalOpen = !!creation || !!edgeDraft || historyOpen || !!retry || !!deletingNode || !!menu || attaching;
  return <main className="workbench session-workbench">
    <header className="project-header"><div className="project-heading"><button className="icon-button" aria-label="返回项目列表" onClick={onBack}>←</button><div><h1>{project.name}</h1><div className="project-directory" title={project.root}>{project.root}</div></div><Status value={project.status} /></div><div className="project-statusbar" role="group" aria-label="项目状态栏"><span className="workflow-summary">WORKFLOW · {snapshot.nodes.length} 个会话</span><div className="execution-overview" role="status" aria-label="节点执行状态">{(['running', 'starting', 'pausing', 'resuming', 'paused', 'queued', 'blocked', 'idle', 'completed'] as const).map(status => { const count = snapshot.nodes.filter(node => node.status === status).length; return (count > 0 || status === 'running') && <span key={status} data-node-status={status} className={`status-${status}`}>{labels[status]} <strong>{count}</strong></span>; })}</div><button className="button secondary compact" onClick={() => create({ x: 80 + snapshot.nodes.length % 3 * 300, y: 100 + Math.floor(snapshot.nodes.length / 3) * 230 })}>＋ 添加节点</button></div><div className="project-controls"><button className="button secondary compact" disabled={historyLoading} onClick={() => void openProjectHistory()}>项目会话历史</button><button className="button secondary compact" disabled={!canPauseAll} onClick={() => void execute({ type: 'pause', projectId: project.id })}>全部暂停</button><button className="button secondary compact" disabled={!canResumeAll} title="续接全部暂停时记录的运行节点，其他空闲节点恢复待命" onClick={() => void execute({ type: 'resume', projectId: project.id })}>全部开启</button><button className="button secondary compact" disabled={!busy && !['running', 'pausing', 'paused', 'blocked'].includes(project.status)} onClick={() => void execute({ type: 'stop', projectId: project.id })}>停止本轮</button></div></header>
    <div className="workbench-body"><section className="canvas-column" aria-label="工作流画布"><div className="project-objective"><span>目标</span><p>{project.goal}</p></div>
      <div className="flow-wrap" tabIndex={0} aria-label="工作流画布，Shift+F10 打开新建菜单" onKeyDown={event => { if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') { event.preventDefault(); const target = (event.target as HTMLElement).closest('.react-flow__node'); const node = nodes.find(item => item.id === target?.getAttribute('data-id')); const rect = (target ?? event.currentTarget).getBoundingClientRect(); setMenu({ x: rect.x + 40, y: rect.y + 40, position: node ? { x: node.position.x + 300, y: node.position.y } : flow.current?.screenToFlowPosition({ x: rect.x + 40, y: rect.y + 40 }) ?? { x: 80, y: 100 }, nodeId: node?.id }); } }}>
        <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onInit={instance => { flow.current = instance; }} onNodesChange={onNodesChange} onNodeClick={(_, node) => setSelectedId(node.id)}
          onPaneContextMenu={event => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, position: flow.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY }) ?? { x: 80, y: 100 } }); }}
          onNodeContextMenu={(event, node) => { event.preventDefault(); event.stopPropagation(); setSelectedId(node.id); setMenu({ x: event.clientX, y: event.clientY, position: { x: node.position.x + 300, y: node.position.y }, nodeId: node.id }); }}
          onEdgeClick={(_, edge) => { const definition = definitions.find(item => item.id === edge.data?.definitionId); if (definition) setEdgeDraft({ ...definition }); }}
          onNodeDragStart={() => { dragging.current = true; }} onNodeDragStop={async (_, dragged) => { dragging.current = false; const before = snapshot.nodes.find(node => node.id === dragged.id); const reply = await execute({ type: 'move_node', projectId: project.id, nodeId: dragged.id, position: dragged.position }); if (!reply && before) setNodes(current => current.map(node => node.id === before.id ? { ...node, position: before.position } : node)); }}
          nodesConnectable={false} deleteKeyCode={null} fitView fitViewOptions={{ padding: .25, maxZoom: 1 }} minZoom={.2} maxZoom={1.5} proOptions={{ hideAttribution: true }}><Controls showInteractive={false} /></ReactFlow>
      </div><div className="activity-strip"><span className="local-indicator" />{(snapshot.requests?.length ?? 0) > 0 && <button className="text-button" onClick={() => { const request = snapshot.requests![0]; if (request.nodeId) setSelectedId(request.nodeId); setTab('conversation'); }}>{snapshot.requests!.length} 个请求待回应</button>}<span className="latest-activity">{snapshot.activities.at(-1)?.text ?? '选择任意节点开始会话'}</span></div>
    </section><aside className="detail-panel session-detail" aria-label="节点详情">
      {runtime?.error && <p className="runtime-error" role="alert">{runtime.error}</p>}
      {selected ? <><div className="detail-heading"><div><h2>{selected.name}</h2><Status value={selected.status} /></div><div className="node-controls" role="group" aria-label="节点运行控制"><button className="button secondary compact" disabled={['paused', 'pausing'].includes(selected.status)} onClick={() => void execute({ type: 'pause_node', projectId: project.id, nodeId: selected.id })}>暂停节点</button><button className="button secondary compact" disabled={!['paused', 'pausing'].includes(selected.status)} onClick={() => void execute({ type: 'resume_node', projectId: project.id, nodeId: selected.id })}>启用节点</button><button className="button secondary compact danger-button" disabled={busy || !!deleteReason} title={deleteReason ?? '移除节点并保留会话历史与项目文件'} onClick={() => setDeletingId(selected.id)}>删除节点</button></div>{deleteReason && <p className="field-note">{deleteReason}</p>}{selected.status === 'pausing' && <p className="field-note">正在等待原生轮次停止；可直接启用节点覆盖暂停。</p>}{selected.status === 'resuming' && <p className="field-note">已请求启用，等待原生轮次停止后续接。</p>}{selected.status === 'paused' && <p className="field-note">节点已暂停，可单独启用；新消息将留在队列。</p>}</div>
        <div className="detail-tabs" role="tablist" aria-label="节点详情栏目">{([['conversation', '会话'], ['config', '配置'], ['panels', '工作面板']] as const).map(([value, label]) => <button key={value} id={`tab-${value}`} role="tab" aria-selected={tab === value} className={tab === value ? 'active' : ''} onClick={() => { setTab(value); if (value === 'config' && !catalog) void reloadCatalog(); }}>{label}</button>)}</div>
        {ongoing && <div className="current-activity" role="status"><span className="local-indicator" />{ongoing.text || '正在处理原生工具调用'}</div>}
        <div className="detail-scroll session-scroll" hidden={tab === 'panels'}><div hidden={tab !== 'conversation'}>{(snapshot.requests ?? []).filter(request => !request.nodeId || request.nodeId === selected.id).map(request => <NativeRequestCard key={request.key} request={request} item={nodeEntries.find(entry => entry.itemId === request.params?.itemId)?.content} onOpenUrl={url => void openResource(request.nodeId ?? selected.id, { url })} onRespond={async result => { await execute({ type: 'respond_native', projectId: project.id, requestKey: request.key, result }); }} onError={onError} />)}<ConversationFeed entries={nodeEntries} nodes={snapshot.nodes} tasks={snapshot.tasks.filter(task => task.nodeId === selected.id)} onOpen={openResource} onRetry={task => { setRetry(task); setConfirmed(false); }} /></div><div hidden={tab !== 'config'}><NodeConfig key={selected.id} node={selected} tasks={snapshot.tasks} busy={busy} onSave={saveNode} onError={onError} catalog={catalog} loading={loadingCatalog} onReload={reloadCatalog} /></div></div>
        <div className="panels-container" hidden={tab !== 'panels'}><NodePanels key={selected.id} projectId={project.id} nodeId={selected.id} visible={tab === 'panels' && !modalOpen} onError={onError} /></div>
        <form className="task-composer node-composer" onSubmit={send}><div className="composer-header"><label htmlFor="task-instruction">发送给 <strong>{selected.name}</strong>{pendingTasks > 0 && <span> · {pendingTasks} 条排队中</span>}</label></div><textarea id="task-instruction" value={draft.text} onChange={e => updateDraft({ text: e.target.value })} placeholder={`给「${selected.name}」发送消息…`} rows={3} />{draft.attachments.length > 0 && <div className="attachment-list">{draft.attachments.map((item, i) => <span key={i}>{attachmentLabel(item)}<button type="button" className="icon-button" aria-label={`移除附件 ${i + 1}`} onClick={() => updateDraft({ attachments: draft.attachments.filter((_, index) => index !== i) })}>×</button></span>)}</div>}<div className="composer-bottom"><button type="button" className="text-button" disabled={attaching} onClick={() => void attach()}>{attaching ? '添加中…' : '＋ 添加附件'}</button><span>{['paused', 'pausing'].includes(selected.status) ? '消息将排队，启用节点后处理' : selected.status === 'resuming' ? '等待当前轮次停止后继续处理' : ['starting', 'running'].includes(selected.status) ? '消息会按顺序继续处理' : '自由输入 · 保留会话上下文'}</span><button className="button primary" disabled={busy || (!draft.text.trim() && !draft.attachments.length)}>发送</button></div></form>
      </> : <div className="panel-empty"><h3>添加一个会话节点</h3><p>在画布空白处右键，选择模型、名称和能力。</p></div>}
    </aside></div>
    {menu && <div className="canvas-context-menu" role="menu" ref={menuRef} style={{ left: Math.min(menu.x, window.innerWidth - 220), top: Math.min(menu.y, window.innerHeight - 170) }}><button role="menuitem" onClick={() => create(menu.position, menu.nodeId)}>{menu.nodeId ? '新增关联节点' : '新增节点'}</button>{menu.nodeId && <button role="menuitem" onClick={() => { setSelectedId(menu.nodeId!); setTab('config'); setMenu(null); if (!catalog) void reloadCatalog(); }}>配置此节点</button>}{menu.nodeId && <button role="menuitem" className="danger-button" disabled={busy || !!deletionBlockReason(menu.nodeId)} title={deletionBlockReason(menu.nodeId) ?? undefined} onClick={() => { setDeletingId(menu.nodeId!); setMenu(null); }}>删除节点</button>}</div>}
    {deletingNode && <Dialog title="删除节点" onClose={() => setDeletingId(null)}><div className="form-stack"><p>确认从画布移除「{deletingNode.name}」？</p><p className="muted">该节点的配置关联线会一并移除。会话历史、任务记录与项目文件都会保留，可在「项目会话历史」查看。</p>{deletionBlockReason(deletingNode.id) && <p className="inline-warning" role="alert">{deletionBlockReason(deletingNode.id)}</p>}{error && <p className="inline-error" role="alert">{error}</p>}<div className="modal-actions"><button className="button secondary" onClick={() => setDeletingId(null)}>取消</button><button className="button primary danger-button" disabled={busy || !!deletionBlockReason(deletingNode.id)} onClick={async () => { if (deletionBlockReason(deletingNode.id)) return; if (await execute({ type: 'delete_node', projectId: project.id, nodeId: deletingNode.id })) setDeletingId(null); }}>确认删除</button></div></div></Dialog>}
    {creation && <Dialog title={creation.relatedTo ? '新增关联节点' : '新增节点'} onClose={() => setCreation(null)}>{error && <p className="inline-error">{error}</p>}<NewNodeForm position={creation.position} relatedName={snapshot.nodes.find(node => node.id === creation.relatedTo)?.name} catalog={catalog} loading={loadingCatalog} busy={busy} onReload={reloadCatalog} onSave={async (node, condition) => { const reply = await execute({ type: 'save_node', projectId: project.id, node, relatedTo: creation.relatedTo, condition }); if (reply) { setSelectedId(node.id); setCreation(null); setTab('conversation'); } }} /></Dialog>}
    {edgeDraft && <Dialog title="关联条件" onClose={() => setEdgeDraft(null)}><form className="form-stack" onSubmit={async event => { event.preventDefault(); if (await execute({ type: 'save_edge', projectId: project.id, edge: edgeDraft })) setEdgeDraft(null); }}>{error && <p className="inline-error" role="alert">{error}</p>}<p>{snapshot.nodes.find(n => n.id === edgeDraft.sourceNodeId)?.name} → {snapshot.nodes.find(n => n.id === edgeDraft.targetNodeId)?.name}</p><label>条件<textarea aria-label="条件" rows={5} value={edgeDraft.condition} onChange={e => setEdgeDraft(current => current && { ...current, condition: e.target.value })} /></label><p className="field-note">条件说明保存在关联边上，自动选择规则待后续确定。</p><div className="modal-actions"><button type="button" className="button secondary" disabled={busy} onClick={async () => { if (await execute({ type: 'delete_edge', projectId: project.id, edgeId: edgeDraft.id })) setEdgeDraft(null); }}>移除关联</button><button className="button primary" disabled={busy}>保存条件</button></div></form></Dialog>}
    {historyOpen && <Dialog title="项目会话历史" wide onClose={() => setHistoryOpen(false)}><p className="field-note">所有节点按时间排列 · 未知时间置后按记录顺序 · {entries.length} 条记录{historyLoading ? ' · 正在补齐原生历史…' : ''}</p>{historyFailures.length > 0 && <p className="inline-warning">以下节点的原生历史暂未完整载入：{historyFailures.join('、')}。当前展示已保存记录。</p>}<ConversationFeed entries={entries} nodes={historyNodes} projectTimeline onOpen={openResource} /></Dialog>}
    {retry && <Dialog title="核对任务后重试" onClose={() => setRetry(null)}><div className="form-stack"><p className="inline-warning">请核对上次执行和已有成果，避免重复操作。</p><p>{retry.instruction}</p><label className="confirm-choice"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />我已核对，确认可以重试</label><button className="button primary" disabled={!confirmed || busy} onClick={async () => { if (await execute({ type: 'retry_task', projectId: project.id, taskId: retry.id, confirmed: true })) setRetry(null); }}>确认重试</button></div></Dialog>}
  </main>;
}
