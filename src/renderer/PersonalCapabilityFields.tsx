import { useId, useRef, useState, type KeyboardEvent } from 'react';
import type { FeedCapabilities } from '../shared/feed';
import type { CapabilityCatalog } from '../shared/types';
import { Icon } from './Icon';

function CapabilityChoices<T extends { name: string; description?: string }>({ title, noun, catalog, selected, idOf, onChange, loading, onReload }: {
  title: string;
  noun: string;
  catalog?: T[];
  selected: T[];
  idOf(item: T): string;
  onChange(items: T[]): void;
  loading?: boolean;
  onReload?(): void;
}) {
  const [query, setQuery] = useState('');
  const [compositionQuery, setCompositionQuery] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(true);
  const search = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const resultsId = useId();
  const selectedIds = new Set(selected.map(idOf));
  const available = new Map(catalog?.map(item => [idOf(item), item]));
  const entries = new Map(available);
  for (const item of selected) if (!entries.has(idOf(item))) entries.set(idOf(item), item);
  const idsByName = new Map<string, Set<string>>();
  for (const item of [...entries.values(), ...selected]) {
    const ids = idsByName.get(item.name) ?? new Set<string>();
    ids.add(idOf(item));
    idsByName.set(item.name, ids);
  }
  const keyword = (compositionQuery ?? query).trim().toLowerCase();
  const matches = [...entries.values()].filter(item => `${item.name} ${item.description ?? ''} ${idOf(item)}`.toLowerCase().includes(keyword));
  const status = loading ? `正在读取${noun}…` : !catalog ? `${noun}目录暂不可用` : `可用 ${available.size} 项`;
  const empty = loading ? status : !catalog ? status : keyword ? `没有匹配的${noun}。` : `当前未发现可用${noun}。`;

  function unavailable(id: string) { return !loading && !available.has(id); }
  function focusSearch() { search.current?.focus({ preventScroll: true }); }
  function remove(id: string) { onChange(selected.filter(item => idOf(item) !== id)); }
  function updateSelection(item: T, checked: boolean) {
    if (checked) onChange([...selected, item]);
    else remove(idOf(item));
  }
  function clearSearch() {
    setQuery('');
    setExpanded(true);
    focusSearch();
  }
  function navigateResults(event: KeyboardEvent) {
    if (event.nativeEvent.isComposing || compositionQuery !== null) return;
    const fromSearch = event.target === search.current;
    if (event.key === 'Escape' && expanded) {
      event.preventDefault();
      event.stopPropagation();
      focusSearch();
      setExpanded(false);
      return;
    }
    if (fromSearch && event.key === 'Enter') {
      event.preventDefault();
      setExpanded(true);
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const choices = Array.from(results.current?.querySelectorAll<HTMLInputElement>('input[type=checkbox]') ?? []);
    const index = choices.findIndex(input => input === event.target);
    const next = event.key === 'ArrowDown' ? choices[index + 1] : choices[fromSearch ? choices.length - 1 : index - 1];
    if (!expanded) {
      setExpanded(true);
      requestAnimationFrame(() => next?.focus());
    } else if (next) next.focus();
    else if (index === 0 && event.key === 'ArrowUp') focusSearch();
  }

  return <fieldset className="tools-field capability-group">
    <legend>{title} <span className="field-note">已选 {selected.length}</span></legend>
    <div className="capability-summary">
      <span role="status">{status}</span>
      {onReload && <button type="button" className="text-button" disabled={loading} onClick={onReload}>刷新可用能力</button>}
    </div>
    <div className="capability-search-box">
      <Icon name="search" size={16} />
      <input ref={search} className="capability-search" aria-label={`搜索${noun}`} type="search" value={query} aria-controls={resultsId}
        onChange={event => { setQuery(event.target.value); setExpanded(true); }} onFocus={() => setExpanded(true)} onKeyDown={navigateResults}
        onCompositionStart={() => setCompositionQuery(query)} onCompositionEnd={() => setCompositionQuery(null)} placeholder="搜索名称、说明或来源" />
      {query && <button type="button" aria-label={`清除${noun}搜索`} onClick={clearSearch}><Icon name="close" size={14} /></button>}
      <button type="button" className="capability-disclosure" aria-label={`${expanded ? '收起' : '展开'}${noun}结果`} aria-expanded={expanded} aria-controls={resultsId}
        onClick={() => setExpanded(!expanded)}><Icon name="chevron" size={14} /></button>
    </div>
    {selected.length > 0 && <div className="capability-chips" role="group" aria-label={`已选${noun}`}>
      {selected.map(item => {
        const id = idOf(item);
        const showId = (idsByName.get(item.name)?.size ?? 0) > 1 || unavailable(id);
        const label = showId ? `${item.name}（${id}）` : item.name;
        return <button type="button" key={id} title={`${item.name} · ${id}`} aria-label={`移除${noun} ${label}`} onClick={() => { remove(id); focusSearch(); }}>
          <span className="capability-chip-label">{label}</span>{unavailable(id) && <span className="capability-unavailable">目录暂不可用</span>}<Icon name="close" size={12} />
        </button>;
      })}
    </div>}
    <div ref={results} id={resultsId} className="capability-list" role="group" aria-label={`${noun}搜索结果`} hidden={!expanded} onKeyDown={navigateResults}>
      {matches.map(item => {
        const id = idOf(item);
        const checked = selectedIds.has(id);
        return <label key={id} className="tool-choice">
          <input type="checkbox" checked={checked} onChange={event => updateSelection(item, event.target.checked)} onKeyDown={event => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
            event.preventDefault();
            updateSelection(item, !checked);
          }} />
          <span className="capability-choice-copy">
            <span className="capability-choice-heading"><strong>{item.name}</strong><span className="capability-source" title={id}>{id}</span></span>
            {item.description && <small>{item.description}</small>}
            {unavailable(id) && <small className="capability-unavailable">目录暂不可用 · 已保留</small>}
          </span>
        </label>;
      })}
      {!matches.length && <p className="capability-empty" role="status">{empty}</p>}
    </div>
  </fieldset>;
}

export function PersonalCapabilityFields({ node, catalog, loading, onChange, onReload, hideReasoningDescription }: { node: FeedCapabilities & { id: string }; catalog?: CapabilityCatalog | null; loading?: boolean; onChange(patch: Partial<FeedCapabilities>): void; onReload?(): void; hideReasoningDescription?: boolean }) {
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
    </select>{!hideReasoningDescription && selectedReasoning?.description && <span className="field-note">{selectedReasoning.description}</span>}
      {reasoningReset?.nodeId === node.id && reasoningReset.model === node.model && !node.reasoningEffort && <span className="field-note" role="status">新模型不支持思考强度「{reasoningReset.effort}」，已切换为模型默认。</span>}
      {node.reasoningEffort && !selectedReasoning && <span className="field-note" role="status">{model?.supportedReasoningEfforts ? '当前模型不支持已保存的思考强度，请重新选择。' : '无法验证已保存的思考强度，原生目录暂不可用；已保留当前选择。'}</span>}
      {!node.reasoningEffort && !reasoningOptions.length && <span className="field-note">{loading ? '正在读取思考强度…' : node.model ? '当前模型未提供思考强度选项，使用模型默认。' : '选择模型后读取可用思考强度。'}</span>}
    </label>
    {catalog?.errors.map(error => <p key={error} className="field-note" role="status">{error}</p>)}
    <CapabilityChoices key={`${node.id}-skills`} title="Skills" noun="技能" catalog={catalog?.skills} selected={node.skills ?? []} idOf={item => item.path}
      loading={loading} onReload={onReload} onChange={items => onChange({ skills: items.map(({ name, path }) => ({ name, path })) })} />
    <CapabilityChoices key={`${node.id}-plugins`} title="插件" noun="插件" catalog={catalog?.plugins} selected={node.plugins ?? []} idOf={item => item.id}
      loading={loading} onChange={items => onChange({ plugins: items.map(({ name, id }) => ({ name, id })) })} />
  </>;
}
