import { PersonalCapabilityFields } from './PersonalCapabilityFields';
import { useState } from 'react';
import { WORKFLOW_TOOLS, type CapabilityCatalog, type NodeDefinition, type NodeView, type TaskView } from '../shared/types';

export type DraftNode = Omit<NodeDefinition, 'revision'> & { revision?: number };

type CapabilitiesProps = { node: DraftNode; catalog?: CapabilityCatalog | null; loading?: boolean; onChange: (patch: Partial<DraftNode>) => void; onReload?: () => void };
const toolLabels: Record<typeof WORKFLOW_TOOLS[number], string> = { get_project_context: '读取项目上下文', handoff: '交接任务', complete_task: '完成任务', update_workflow: '修改工作流', send_message: '发送节点消息', get_delivery: '查询消息投递', read_history: '读取会话历史', request_review: '向用户提问', get_review: '查询用户回答', search_project_items: '搜索项目工作项', get_project_item: '读取项目工作项', update_project_item: '维护项目工作项' };
const configurableTools = WORKFLOW_TOOLS.filter(tool => tool !== 'handoff' && tool !== 'send_message');

export function CapabilityFields({ node, catalog, loading, onChange, onReload }: CapabilitiesProps) {
  return <><PersonalCapabilityFields node={{ ...node, model: node.model ?? null, skills: node.skills ?? [], plugins: node.plugins ?? [] }} catalog={catalog} loading={loading} onChange={onChange} onReload={onReload} />
    <fieldset className="tools-field"><legend>节点协作工具</legend>
      <div className="capability-list">{configurableTools.map(tool => <label key={tool} className="tool-choice"><input type="checkbox" aria-label={tool} checked={node.tools.includes(tool)} onChange={event => onChange({ tools: event.target.checked ? [...node.tools, tool] : node.tools.filter(selected => selected !== tool) })} /><span><strong>{toolLabels[tool]}</strong><small>{tool}</small></span></label>)}</div>
    </fieldset>
  </>;
}

export function nodeConfigModel(node: NodeView, tasks: TaskView[], draft: DraftNode = node) {
  return draft.model ?? (node.threadId ? tasks.findLast(task => task.nodeId === node.id && task.threadId === node.threadId && task.provenance?.actualModel)?.provenance?.actualModel : null) ?? null;
}

export function nodeConfigLockReason(nodeId: string, tasks: TaskView[]) {
  return tasks.some(task => task.nodeId === nodeId && task.status === 'needs_reconciliation')
    ? '节点有状态待确认的任务，请到「会话」核对并处理后自动保存配置；可继续编辑草稿。'
    : tasks.some(task => task.nodeId === nodeId && task.status === 'waiting_review')
      ? '节点有等待人工核对的任务，请先处理核对或取消等待任务后自动保存配置；可继续编辑草稿。'
    : tasks.some(task => task.nodeId === nodeId && ['running', 'paused', 'queued', 'waiting_source'].includes(task.status))
      ? '节点仍有正在运行或待处理的任务，任务结束或处理完成后自动保存配置；可继续编辑草稿。' : null;
}

export function NodeConfig({ node, draft: editedDraft, tasks, saving, saveFailed, onRetry, onDraftChange, catalog, loading, onReload }: { node: NodeView; draft?: DraftNode; tasks: TaskView[]; saving: boolean; saveFailed: boolean; onRetry(): void; onDraftChange: (draft: DraftNode | null) => void; catalog?: CapabilityCatalog | null; loading?: boolean; onReload?: () => void }) {
  const draft = editedDraft ?? node, dirty = !!editedDraft;
  const model = nodeConfigModel(node, tasks, draft);
  const stale = draft.revision !== node.revision, lockReason = nodeConfigLockReason(node.id, tasks);
  const status = !dirty ? '配置已保存' : saving ? '自动保存中…' : !draft.name.trim() ? '请填写节点名称，草稿已保留' : !model ? '请选择模型，草稿已保留' : stale ? '配置有冲突，草稿已保留' : '等待自动保存…';
  function change(patch: Partial<DraftNode>) { onDraftChange({ ...draft, model, ...patch }); }
  return <form className="form-stack node-config" onSubmit={event => event.preventDefault()}>
    {lockReason && <div className="inline-warning" role="status">{lockReason}</div>}
    {stale && <div className="inline-warning">节点配置已更新。<button type="button" className="text-button" onClick={() => onDraftChange(null)}>载入最新配置</button></div>}
    <label>节点名称<input required maxLength={80} value={draft.name} onChange={e => change({ name: e.target.value })} /></label>
    <label>职责与指令<textarea aria-label="职责与指令" rows={5} value={draft.instructions} onChange={e => change({ instructions: e.target.value })} /></label>
    <CapabilityFields node={{ ...draft, model }} catalog={catalog} loading={loading} onChange={change} onReload={onReload} />
    <div className="config-actions"><span className="field-note" role="status">{status}</span></div>
    {saveFailed && <p className="inline-warning" role="alert">有节点配置自动保存失败，草稿已保留。<button type="button" className="text-button" onClick={onRetry}>重试自动保存</button></p>}
  </form>;
}

export function NewNodeForm({ position, relatedName, catalog, loading, busy, onReload, onSave }: { position: NodeDefinition['position']; relatedName?: string; catalog: CapabilityCatalog | null; loading: boolean; busy: boolean; onReload: () => void; onSave: (node: DraftNode, condition: string) => Promise<void> }) {
  const [draft, setDraft] = useState<DraftNode>(() => ({ id: crypto.randomUUID(), name: '', instructions: '根据用户消息完成工作，按需要使用已配置的能力。', position, revision: 0, tools: ['get_project_context', 'complete_task', 'update_workflow', 'request_review', 'get_review', 'search_project_items', 'get_project_item', 'update_project_item'], resultSchema: {}, model: null, skills: [], plugins: [] }));
  const [condition, setCondition] = useState('');
  function change(patch: Partial<DraftNode>) { setDraft(current => ({ ...current, ...patch })); }
  return <form className="form-stack" onSubmit={event => { event.preventDefault(); void onSave({ ...draft, model: draft.model ?? null }, condition); }}>
    <label>节点名称<input autoFocus required maxLength={80} placeholder="给这个会话起一个名字" value={draft.name} onChange={e => change({ name: e.target.value })} /></label>
    <label>职责与指令<textarea aria-label="职责与指令" rows={3} value={draft.instructions} onChange={e => change({ instructions: e.target.value })} /></label>
    <CapabilityFields node={draft} catalog={catalog} loading={loading} onChange={change} onReload={onReload} />
    {relatedName && <label>关联条件 <span className="field-note">从「{relatedName}」到这个节点</span><textarea aria-label="关联条件" rows={3} placeholder="例如：成果需要独立审查时，交给此节点" value={condition} onChange={e => setCondition(e.target.value)} /><span className="field-note">保存条件说明，条件如何参与自动选择将在后续确定。</span></label>}
    <div className="modal-actions"><button className="button primary" disabled={busy || !draft.name.trim()}>{busy ? '创建中…' : relatedName ? '创建关联节点' : '创建节点'}</button></div>
  </form>;
}
