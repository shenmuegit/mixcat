import { useState } from 'react';
import type { FeedCapabilities } from '../shared/feed';
import type { CapabilityCatalog } from '../shared/types';

export function PersonalCapabilityFields({ node, catalog, loading, onChange, onReload }: { node: FeedCapabilities & { id: string }; catalog?: CapabilityCatalog | null; loading?: boolean; onChange(patch: Partial<FeedCapabilities>): void; onReload?(): void }) {
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
      <div className="capability-list">{plugins.map(plugin => <label key={plugin.id} className="tool-choice"><input type="checkbox" checked={node.plugins?.some(p => p.id === plugin.id) ?? false} onChange={event => onChange({ plugins: event.target.checked ? [...(node.plugins ?? []), { id: plugin.id, name: plugin.name }] : node.plugins?.filter(p => p.id !== plugin.id) })} /><span><strong>{plugin.name}</strong>{plugin.description && <small>{plugin.description}</small>}</span></label>)}
        {!plugins.length && <p className="field-note">{loading ? '正在读取插件…' : '当前尚无可用插件。'}</p>}</div>
    </fieldset>
  </>;
}
