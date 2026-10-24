import { useEffect, useState, type FormEvent } from 'react';
import { WORKFLOW_TOOLS, type CapabilityCatalog, type NodeDefinition, type NodeView, type TaskView } from '../shared/types';

type DraftNode = Omit<NodeDefinition, 'revision'> & { revision?: number };

type TrustHooks = (hooks: { key: string; currentHash: string }[]) => Promise<void>;
type CapabilitiesProps = { node: DraftNode; catalog?: CapabilityCatalog | null; loading?: boolean; busy?: boolean; projectRoot?: string; onChange: (patch: Partial<DraftNode>) => void; onReload?: () => void; onTrust?: TrustHooks };
const toolLabels: Record<typeof WORKFLOW_TOOLS[number], string> = { get_project_context: '读取项目上下文', handoff: '交接任务', complete_task: '完成任务', update_workflow: '修改工作流', send_message: '发送节点消息', get_delivery: '查询消息投递', read_history: '读取会话历史', request_review: '提交人工核对', get_review: '查询人工核对' };
const hookLabels: Record<string, string> = { sessionstart: '会话开始', userpromptsubmit: '提交输入', pretooluse: '工具调用前', permissionrequest: '请求权限', posttooluse: '工具调用后', precompact: '压缩上下文前', stop: '本轮结束' };

export function CapabilityFields({ node, catalog, loading, busy, projectRoot, onChange, onReload, onTrust }: CapabilitiesProps) {
  const [query, setQuery] = useState('');
  const projectPrefix = projectRoot ? projectRoot.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() + '/' : null;
  const reviewHooks = (catalog?.hooks ?? []).filter(hook => ['untrusted', 'modified'].includes(hook.trustStatus) && hook.currentHash && projectPrefix && hook.sourcePath.replace(/\\/g, '/').toLowerCase().startsWith(projectPrefix) && !hook.sourcePath.split(/[\\/]/).includes('..'));
  const skills = [...(catalog?.skills ?? [])];
  for (const selected of node.skills ?? []) if (!skills.some(s => s.path === selected.path)) skills.push(selected);
  const plugins = [...(catalog?.plugins ?? [])];
  for (const selected of node.plugins ?? []) if (!plugins.some(p => p.id === selected.id)) plugins.push(selected);
  return <>
    <label>模型<select aria-label="模型" value={node.model ?? ''} onChange={event => onChange({ model: event.target.value || null })}>
      <option value="">原生默认</option>
      {node.model && !catalog?.models.some(m => m.id === node.model) && <option value={node.model}>{node.model}</option>}
      {catalog?.models.map(model => <option key={model.id} value={model.id}>{model.name}{model.isDefault ? ' · 默认' : ''}</option>)}
    </select>{!catalog?.models.length && <span className="field-note">{loading ? '正在读取模型…' : '未获取到可用模型，可保留原生默认。'}</span>}</label>
    <label>计划 ID<input aria-label="计划 ID" pattern="[A-Za-z0-9_][A-Za-z0-9._\-]{0,99}" maxLength={100} placeholder="可选，例如 mvp-001" value={node.planId ?? ''} onChange={event => onChange({ planId: event.target.value || undefined })} /><span className="field-note">使用字母、数字或下划线开头的 slug，可包含点和连字符，最多 100 个字符；此处不是文件路径。</span></label>
    <div className="capability-heading"><span>节点使用的技能与插件</span><button type="button" className="text-button" disabled={loading} onClick={onReload}>{loading ? '读取中…' : '刷新可用能力'}</button></div>
    {catalog?.errors.map(error => <p key={error} className="field-note" role="status">{error}</p>)}
    <fieldset className="tools-field"><legend>MCP 与 hooks 状态</legend><p className="field-note">以原生宿主查询为准；已安装或已选择不代表工具或 hooks 已运行。</p>
      {catalog?.mcpServers?.map(server => <p key={server.name} className="field-note">{server.name} · {({ connected: '已连接', notStarted: '尚未启动', starting: '正在连接', authenticationRequired: '需要登录', failed: '失败', cancelled: '已取消', disabled: '未启用' } as Record<string, string>)[server.status] ?? '状态尚未确认'} · {server.toolCount} 个工具</p>)}
      {!catalog?.mcpServers?.length && <p className="field-note">{loading ? '正在读取 MCP 状态…' : '尚未发现可用的 MCP 状态。'}</p>}
      {catalog?.hooks?.map(hook => <p key={hook.key} className="field-note">{hookLabels[hook.eventName.toLowerCase()] ?? hook.eventName} · {!hook.enabled ? '未启用' : hook.trustStatus === 'managed' ? '宿主管理且已信任' : hook.trustStatus === 'trusted' ? '宿主已信任' : ['untrusted', 'modified'].includes(hook.trustStatus) ? onTrust && reviewHooks.some(review => review.key === hook.key) ? '待信任，请展开下方审核' : '待信任，请在原生宿主确认' : '信任状态尚未确认'}</p>)}
      {!catalog?.hooks?.length && <p className="field-note">{loading ? '正在读取 hooks 状态…' : '尚未发现 hooks 状态。'}</p>}
      {onTrust && reviewHooks.length > 0 && <details className="field-note" key={JSON.stringify(reviewHooks)}><summary>审核项目 hooks（{reviewHooks.length}）</summary><p>请核对当前定义。点击信任后，宿主仍会核对内容是否变化；未启用的 hooks 仍保持未启用。</p>
        {reviewHooks.map(hook => <div key={hook.key}><p>{hookLabels[hook.eventName.toLowerCase()] ?? hook.eventName} · {hook.enabled ? '已启用' : '未启用'}</p><pre className="result-json">{`来源：${hook.sourcePath}\n命令：${hook.command ?? '原生宿主未提供'}\n匹配条件：${hook.matcher ?? '全部'}\nHash：${hook.currentHash}`}</pre>{!hook.command?.trim() && <p role="status">宿主未提供可审核命令，尚不能在此信任</p>}</div>)}
        <button type="button" className="button secondary compact" disabled={busy || loading || reviewHooks.some(hook => !hook.command?.trim())} onClick={() => void onTrust(reviewHooks.map(hook => ({ key: hook.key, currentHash: hook.currentHash! })))}>信任当前显示的项目 hooks</button>
      </details>}
    </fieldset>
    <fieldset className="tools-field"><legend>Skills <span className="field-note">已选择 {node.skills?.length ?? 0}</span></legend>
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
    <fieldset className="tools-field"><legend>节点协作工具 <span className="field-note">已选择 {node.tools.length}</span></legend><p className="field-note">勾选后保存配置生效，原生工具仍可使用。</p>
      <div className="capability-list">{WORKFLOW_TOOLS.map(tool => <label key={tool} className="tool-choice"><input type="checkbox" aria-label={tool} checked={node.tools.includes(tool)} onChange={event => onChange({ tools: event.target.checked ? [...node.tools, tool] : node.tools.filter(selected => selected !== tool) })} /><span><strong>{toolLabels[tool]}</strong><small>{tool}</small></span></label>)}</div>
    </fieldset>
  </>;
}

export function NodeConfig({ node, tasks, busy, onSave, onError, catalog, loading, onReload, projectRoot, onTrust }: { node: NodeView; tasks: TaskView[]; busy: boolean; onSave: (node: DraftNode) => Promise<NodeView | null>; onError: (error: string) => void; catalog?: CapabilityCatalog | null; loading?: boolean; onReload?: () => void; projectRoot?: string; onTrust?: TrustHooks }) {
  const [draft, setDraft] = useState<DraftNode>(node);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const stale = draft.revision !== node.revision;
  const lockReason = tasks.some(task => task.nodeId === node.id && task.status === 'needs_reconciliation')
    ? '节点有状态待确认的任务，请到「会话」核对并处理后保存配置；可继续编辑草稿。'
    : tasks.some(task => task.nodeId === node.id && task.status === 'waiting_review')
      ? '节点有等待人工核对的任务，请先处理核对或取消等待任务后保存配置；可继续编辑草稿。'
    : tasks.some(task => task.nodeId === node.id && ['running', 'paused', 'queued', 'waiting_source'].includes(task.status))
      ? '节点仍有正在运行或待处理的任务，请等待任务结束，或停止本轮并处理未确认任务后保存配置；可继续编辑草稿。' : null;
  useEffect(() => { if (!dirty) setDraft(node); }, [node, dirty]);
  function change(patch: Partial<DraftNode>) { setDraft(current => ({ ...current, ...patch })); setDirty(true); setSaved(false); }
  async function save(event: FormEvent) {
    event.preventDefault(); if (lockReason || stale || busy) return;
    try { const updated = await onSave({ ...draft, model: draft.model ?? null, position: node.position }); if (updated) { setDraft(updated); setDirty(false); setSaved(true); } }
    catch (error) { onError(error instanceof Error ? error.message : String(error)); }
  }
  return <form className="form-stack node-config" onSubmit={save}>
    {lockReason && <div className="inline-warning" role="status">{lockReason}</div>}
    {stale && <div className="inline-warning">节点配置已更新。<button type="button" className="text-button" onClick={() => { setDraft(node); setDirty(false); }}>载入最新配置</button></div>}
    <label>节点名称<input required maxLength={80} value={draft.name} onChange={e => change({ name: e.target.value })} /></label>
    <label>职责与指令<textarea aria-label="职责与指令" rows={5} value={draft.instructions} onChange={e => change({ instructions: e.target.value })} /></label>
    <CapabilityFields node={draft} catalog={catalog} loading={loading} busy={busy} projectRoot={projectRoot} onChange={change} onReload={onReload} onTrust={onTrust} />
    <div className="config-actions">{saved && <span className="field-note" role="status">配置已保存</span>}<button className="button primary" disabled={busy || !!lockReason || stale || !draft.name.trim()}>{busy ? '保存中…' : '保存配置'}</button></div>
  </form>;
}

export function NewNodeForm({ position, relatedName, catalog, loading, busy, onReload, onSave }: { position: NodeDefinition['position']; relatedName?: string; catalog: CapabilityCatalog | null; loading: boolean; busy: boolean; onReload: () => void; onSave: (node: DraftNode, condition: string) => Promise<void> }) {
  const [draft, setDraft] = useState<DraftNode>(() => ({ id: crypto.randomUUID(), name: '', instructions: '根据用户消息完成工作，按需要使用已配置的能力。', position, revision: 0, tools: ['get_project_context', 'handoff', 'complete_task', 'update_workflow'], resultSchema: {}, model: null, skills: [], plugins: [] }));
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
