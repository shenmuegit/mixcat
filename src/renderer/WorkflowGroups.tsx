import type { Node, NodeProps } from '@xyflow/react';
import type { EdgePoint, NodeView, WorkflowGroup } from '../shared/types';

export type GroupCanvasNode = Node<{ group: WorkflowGroup; status: string; disabled: boolean; onEdit: () => void; onMove: (delta: EdgePoint) => void }, 'workflowGroup'>;

export function GroupNode({ data }: NodeProps<GroupCanvasNode>) {
  return <div className="workflow-group" data-group-id={data.group.id}>
    <div className="workflow-group-title" tabIndex={0} role="button" aria-label={`移动分组 ${data.group.name}`} aria-disabled={data.disabled} onKeyDown={event => {
      const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
      if (!direction) return;
      event.preventDefault(); event.stopPropagation();
      if (!data.disabled) { const step = event.shiftKey ? 50 : 10; data.onMove({ x: direction[0] * step, y: direction[1] * step }); }
    }}><strong>{data.group.name}</strong><span className="workflow-group-status">{data.status}</span><button className="icon-button nodrag nopan" aria-label={`编辑分组 ${data.group.name}`} disabled={data.disabled} onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); data.onEdit(); }}>⋯</button></div>
  </div>;
}

export function GroupEditor({ value, nodes, groups, busy, onChange, onSave, onDelete }: {
  value: WorkflowGroup; nodes: NodeView[]; groups: WorkflowGroup[]; busy: boolean;
  onChange: (group: WorkflowGroup) => void; onSave: () => Promise<void>; onDelete?: () => Promise<void>;
}) {
  const taken = new Set(groups.filter(group => group.id !== value.id).flatMap(group => group.nodeIds));
  return <form className="form-stack" onSubmit={event => { event.preventDefault(); void onSave(); }}>
    <label>分组名称<input aria-label="分组名称" required maxLength={80} value={value.name} disabled={busy} onChange={event => onChange({ ...value, name: event.target.value })} /></label>
    <fieldset className="group-members" disabled={busy}><legend>成员节点</legend>{nodes.map(node => <label key={node.id}><input type="checkbox" aria-label={`成员 ${node.name}`} disabled={taken.has(node.id)} checked={value.nodeIds.includes(node.id)} onChange={event => {
      const nodeIds = event.target.checked ? [...value.nodeIds, node.id] : value.nodeIds.filter(id => id !== node.id);
      onChange({ ...value, nodeIds, coordinatorNodeId: nodeIds.includes(value.coordinatorNodeId) ? value.coordinatorNodeId : nodeIds[0] ?? '' });
    }} />{node.name}{taken.has(node.id) && <span className="field-note">已在其他分组</span>}</label>)}</fieldset>
    <label>协调节点<select aria-label="协调节点" disabled={busy || !value.nodeIds.length} value={value.coordinatorNodeId} onChange={event => onChange({ ...value, coordinatorNodeId: event.target.value })}>
      {!value.nodeIds.length && <option value="">先选择成员</option>}{nodes.filter(node => value.nodeIds.includes(node.id)).map(node => <option key={node.id} value={node.id}>{node.name}</option>)}
    </select></label>
    <p className="field-note">成员各自保存会话，协作方向由条件边定义。</p>
    <div className="modal-actions">{onDelete && <button type="button" className="button secondary" disabled={busy} onClick={() => void onDelete()}>解除分组</button>}<button className="button primary" disabled={busy || !value.name.trim() || !value.nodeIds.length || !value.nodeIds.includes(value.coordinatorNodeId)}>保存分组</button></div>
  </form>;
}
