import { useRef, useState } from 'react';
import type { FeedCapabilities } from '../shared/feed';
import type { CapabilityCatalog } from '../shared/types';
import { Icon } from './Icon';

function CapabilityChoices<T extends { name: string; description?: string }>({ title, noun, catalog, selected, idOf, onChange, loading, onReload }: {
  title: string;
  noun: string;
  catalog: T[];
  selected: T[];
  idOf(item: T): string;
  onChange(items: T[]): void;
  loading?: boolean;
  onReload?(): void;
}) {
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);
  const selectedIds = new Set(selected.map(idOf));
  const options = new Map(catalog.map(item => [idOf(item), item]));
  for (const item of selected) if (!options.has(idOf(item))) options.set(idOf(item), item);
  const idsByName = new Map<string, Set<string>>();
  for (const item of [...catalog, ...selected]) {
    const ids = idsByName.get(item.name) ?? new Set<string>();
    ids.add(idOf(item));
    idsByName.set(item.name, ids);
  }
  function choiceLabel(item: T) { return idsByName.get(item.name)!.size > 1 ? `${item.name}（${idOf(item)}）` : item.name; }
  const keyword = query.trim().toLowerCase();
  const matches = [...options.values()].filter(item => `${item.name} ${item.description ?? ''} ${idOf(item)}`.toLowerCase().includes(keyword));
  function remove(id: string) { onChange(selected.filter(item => idOf(item) !== id)); }
  return <fieldset className="tools-field">
    <legend>{title} <span className="field-note">已选择 {selected.length}</span> {onReload && <button type="button" className="text-button" disabled={loading} onClick={onReload}>{loading ? '读取中…' : '刷新可用能力'}</button>}</legend>
    <input ref={search} className="capability-search" aria-label={`搜索${noun}`} type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={`搜索${noun}名称或说明`} />
    {selected.length > 0 && <div className="capability-chips" role="group" aria-label={`已选${noun}`}>
      {selected.map(item => {
        const label = choiceLabel(item);
        return <button type="button" key={idOf(item)} title={label} aria-label={`移除${noun} ${label}`} onClick={() => { remove(idOf(item)); search.current?.focus({ preventScroll: true }); }}>
          <span>{label}</span><Icon name="close" size={12} />
        </button>;
      })}
    </div>}
    <div className="capability-list">
      {matches.map(item => <label key={idOf(item)} className="tool-choice">
        <input type="checkbox" checked={selectedIds.has(idOf(item))} onChange={event => event.target.checked ? onChange([...selected, item]) : remove(idOf(item))} />
        <span><strong>{choiceLabel(item)}</strong>{item.description && <small>{item.description}</small>}</span>
      </label>)}
      {!matches.length && <p className="field-note" role="status">
        {loading ? `正在读取${noun}…` : keyword ? `没有匹配的${noun}。` : `当前未发现可用${noun}。`}
      </p>}
    </div>
  </fieldset>;
}

export function PersonalCapabilityFields({ node, catalog, loading, onChange, onReload }: { node: FeedCapabilities & { id: string }; catalog?: CapabilityCatalog | null; loading?: boolean; onChange(patch: Partial<FeedCapabilities>): void; onReload?(): void }) {
  const [reasoningReset, setReasoningReset] = useState<{ nodeId: string; model: string; effort: string } | null>(null);
  const model = catalog?.models.find(model => model.id === node.model);
  const reasoningOptions = model?.supportedReasoningEfforts ?? [];
  const selectedReasoning = reasoningOptions.find(option => option.reasoningEffort === node.reasoningEffort);
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
    <CapabilityChoices title="Skills" noun="技能" catalog={catalog?.skills ?? []} selected={node.skills ?? []} idOf={item => item.path}
      loading={loading} onReload={onReload} onChange={items => onChange({ skills: items.map(({ name, path }) => ({ name, path })) })} />
    <CapabilityChoices title="插件" noun="插件" catalog={catalog?.plugins ?? []} selected={node.plugins ?? []} idOf={item => item.id}
      loading={loading} onChange={items => onChange({ plugins: items.map(({ name, id }) => ({ name, id })) })} />
  </>;
}
