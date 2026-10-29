import { useState } from 'react';
import { WORKFLOW_TOOLS, type CapabilityCatalog, type NodeDefinition, type NodeView, type TaskView } from '../shared/types';

export type DraftNode = Omit<NodeDefinition, 'revision'> & { revision?: number };

type CapabilitiesProps = { node: DraftNode; catalog?: CapabilityCatalog | null; loading?: boolean; onChange: (patch: Partial<DraftNode>) => void; onReload?: () => void };
const toolLabels: Record<typeof WORKFLOW_TOOLS[number], string> = { get_project_context: '读取项目上下文', handoff: '交接任务', complete_task: '完成任务', update_workflow: '修改工作流', send_message: '发送节点消息', get_delivery: '查询消息投递', read_history: '读取会话历史', request_review: '向用户提问', get_review: '查询用户回答', search_project_items: '搜索项目工作项', get_project_item: '读取项目工作项', update_project_item: '维护项目工作项' };
const configurableTools = WORKFLOW_TOOLS.filter(tool => tool !== 'handoff' && tool !== 'send_message');

export function CapabilityFields({ node, catalog, loading, onChange, onReload }: CapabilitiesProps) {
  const [query, setQuery] = useState('');
  const [reasoningReset, setReasoningReset] = useState<{ nodeId: string; model: string; effort: string } | null>(null);
  const model = catalog?.models.find(model => model.id === node.model);
  const reasoningOptions = model?.supportedReasoningEfforts ?? [];
  const selectedReasoning = reasoningOptions.find(option => option.reasoningEffort === node.reasoningEffort);
  const skills = [...(catalog?.skills ?? [])];
  for (const selected of node.skills ?? []) if (!skills.some(s => s.path === selected.path)) skills.push(selected);
  const plugins = [...(catalog?.plugins ?? [])];
  for (const selected of node.plugins ?? []) if (!plugins.some(p => p.id === selected.id)) plugins.push(selected);
  function changeModel(value: string) {
    const supported = catalog?.models.find(model => model.id === value)?.supportedReasoningEfforts;
    if (node.model !== value && node.reasoningEffort && supported && !supported.some(option => option.reasoningEffort === node.reasoningEffort)) {
      setReasoningReset({ nodeId: node.id, model: value, effort: node.reasoningEffort });
      onChange({ model: value, reasoningEffort: null });
    } else { setReasoningReset(null); onChange({ model: value }); }
  }
  return <>
    <label>模型<select aria-label="模型" required value={node.model ?? ''} onChange={event => changeModel(event.target.value)}>
      <option value="" disabled hidden>{loading ? '正在读取模型…' : '选择模型'}</option>
      {node.model && !catalog?.models.some(m => m.id === node.model) && <option value={node.model}>{node.model}</option>}
      {catalog?.models.map(model => <option key={model.id} value={model.id}>{model.name}{model.isDefault ? ' · 默认' : ''}</option>)}
    </select>{!catalog?.models.length && <span className="field-note">{loading ? '正在读取模型…' : '未获取到可用模型，请刷新重试。'}</span>}</label>
    <label>思考强度<select aria-label="思考强度" value={node.reasoningEffort ?? ''} onChange={event => { setReasoningReset(null); onChange({ reasoningEffort: event.target.value || null }); }}>
      <option value="">模型默认{model?.defaultReasoningEffort ? `（${model.defaultReasoningEffort}）` : ''}</option>
      {node.reasoningEffort && !selectedReasoning && <option value={node.reasoningEffort}>{node.reasoningEffort} · 已保存</option>}
      {reasoningOptions.map(option => <option key={option.reasoningEffort} value={option.reasoningEffort}>{option.reasoningEffort}</option>)}
    </select>{selectedReasoning?.description && <span className="field-note">{selectedReasoning.description}</span>}
      {reasoningReset?.nodeId === node.id && reasoningReset.model === node.model && !node.reasoningEffort && <span className="field-note" role="status">新模型不支持思考强度「{reasoningReset.effort}」，已切换为模型默认。</span>}
      {node.reasoningEffort && !selectedReasoning && <span className="field-note" role="status">{model?.supportedReasoningEfforts ? '当前模型不支持已保存的思考强度，请重新选择。' : '无法验证已保存的思考强度，原生目录暂不可用；已保留当前选择。'}</span>}
      {!node.reasoningEffort && !reasoningOptions.length && <span className="field-note">{loading ? '正在读取思考强度…' : node.model ? '当前模型未提供思考强度选项，使用模型默认。' : '选择模型后读取可用思考强度。'}</span>}
    </label>
    {catalog?.errors.map(error => <p key={error} className="field-note" role="status">{error}</p>)}
    <fieldset className="tools-field"><legend>Skills <span className="field-note">已选择 {node.skills?.length ?? 0}</span> {onReload && <button type="button" className="text-button" disabled={loading} onClick={onReload}>{loading ? '读取中…' : '刷新可用能力'}</button>}</legend>
      <input aria-label="搜索技能" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索名称或职责" />
      <div className="capability-list">{skills.filter(skill => `${skill.name} ${skill.description ?? ''}`.toLowerCase().includes(query.toLowerCase())).map(skill => <label key={skill.path} className="tool-choice">
        <input type="checkbox" checked={node.skills?.some(s => s.path === skill.path) ?? false} onChange={event => onChange({ skills: event.target.checked ? [...(node.skills ?? []), { name: skill.name, path: skill.path }] : node.skills?.filter(s => s.path !== skill.path) })} />
        <span><strong>{skill.name}</strong>{skill.description && <small>{skill.description}</small>}</span>
      </label>)}{!skills.length && <p className="field-note">{loading ? '正在读取可用技能…' : '当前未发现可用技能。'}</p>}</div>
    </fieldset>
    <fieldset className="tools-field"><legend>插件 <span className="field-note">已选择 {node.plugins?.length ?? 0}</span></legend>
      <div className="capability-list">{plugins.map(plugin => <label key={plugin.id} className="tool-choice"><input type="checkbox" checked={node.plugins?.some(p => p.id === plugin.id) ?? false} onChange={event => onChange({ plugins: event.target.checked ? [...(node.plugins ?? []), { ...plugin }] : node.plugins?.filter(p => p.id !== plugin.id) })} /><span><strong>{plugin.name}</strong>{plugin.description && <small>{plugin.description}</small>}</span></label>)}
        {!plugins.length && <p className="field-note">{loading ? '正在读取插件…' : '当前项目尚无可用插件。'}</p>}</div>
    </fieldset>
    <fieldset className="tools-field"><legend>节点协作工具</legend>
      <div className="capability-list">{configurableTools.map(tool => <label key={tool} className="tool-choice"><input type="checkbox" aria-label={tool} checked={node.tools.includes(tool)} onChange={event => onChange({ tools: event.target.checked ? [...node.tools, tool] : node.tools.filter(selected => selected !== tool) })} /><span><strong>{toolLabels[tool]}</strong><small>{tool}</small></span></label>)}</div>
    </fieldset>
  </>;
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
  const model = draft.model ?? (node.threadId ? tasks.findLast(task => task.nodeId === node.id && task.threadId === node.threadId && task.provenance?.actualModel)?.provenance?.actualModel : null) ?? null;
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
