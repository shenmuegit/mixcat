import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { FeedCapabilities } from '../shared/feed';
import type { CapabilityCatalog } from '../shared/types';
import { Icon } from './Icon';
import type { FeedExecute } from './FeedWorkspace';

export function FeedModelPicker({ value, onChange, execute, collectionId, disabled = false }: { value: FeedCapabilities; onChange(patch: Partial<FeedCapabilities>): void; execute: FeedExecute; collectionId?: string; disabled?: boolean }) {
  const [catalog, setCatalog] = useState<CapabilityCatalog | null>(null), [loading, setLoading] = useState(false);
  const [choosingModel, setChoosingModel] = useState(false), [notice, setNotice] = useState('');
  const id = `feed-model-${useId().replace(/:/g, '')}`, anchor = `--${id}`;
  const modelButton = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const sequence = useRef(0), port = useRef(execute); port.current = execute;
  async function load() {
    const token = ++sequence.current; setLoading(true);
    try { const reply = await port.current({ type: 'feed_capabilities', ...(collectionId ? { collectionId } : {}) }); if (sequence.current === token) setCatalog(reply.capabilities!); }
    catch (error) { if (sequence.current === token) setCatalog(current => ({ models: [], skills: [], plugins: [], ...current, errors: [String(error)] })); }
    finally { if (sequence.current === token) setLoading(false); }
  }
  useEffect(() => { void load(); return () => { sequence.current++; }; }, [collectionId]);
  const model = catalog?.models.find(model => value.model ? model.id === value.model : model.isDefault);
  const efforts = model?.supportedReasoningEfforts ?? [], effort = value.reasoningEffort ?? model?.defaultReasoningEffort;
  const index = efforts.findIndex(option => option.reasoningEffort === effort), blocked = disabled || loading;
  const effortLabel = effort === 'xhigh' ? 'Extra high' : effort ? effort[0].toUpperCase() + effort.slice(1) : '模型默认';
  const modelLabel = model?.name ?? value.model ?? (loading ? '正在读取模型…' : '选择模型');
  useLayoutEffect(() => {
    if (choosingModel) (menu.current?.querySelector<HTMLButtonElement>('[aria-checked=true]') ?? menu.current?.querySelector('button'))?.focus();
    else if (modelButton.current?.closest(':popover-open')) modelButton.current.focus();
  }, [choosingModel]);
  function changeEffort(position: string) { const option = efforts[Number(position)]; if (!blocked && model && option) { setNotice(''); onChange({ model: model.id, reasoningEffort: option.reasoningEffort }); } }
  function chooseModel(id: string) {
    const next = catalog?.models.find(model => model.id === id); if (blocked || !next) return;
    const reset = value.reasoningEffort && !next.supportedReasoningEfforts?.some(option => option.reasoningEffort === value.reasoningEffort);
    setNotice(reset ? `新模型不支持推理强度「${value.reasoningEffort}」，已切换为模型默认。` : '');
    onChange({ model: id, ...(reset ? { reasoningEffort: null } : {}) }); setChoosingModel(false);
  }
  return <div className="feed-model-picker">
    <button type="button" className="feed-model-trigger" aria-label="选择模型与思考强度" popoverTarget={id} disabled={disabled} style={{ anchorName: anchor } as CSSProperties}><span>{modelLabel}</span><span className="feed-effort">{effortLabel}</span><Icon name="chevron" size={12} /></button>
    <div id={id} popover="auto" className="feed-model-controls" style={{ positionAnchor: anchor } as CSSProperties} onToggle={event => { if (event.newState === 'closed') setChoosingModel(false); }}>
      <header className="feed-model-header"><span className="feed-model-bolt"><Icon name="bolt" size={16} /></span><div><strong className="feed-effort-title">{effortLabel}</strong><button ref={modelButton} type="button" className="feed-model-choice" aria-label="选择模型" aria-haspopup="menu" aria-expanded={choosingModel} disabled={blocked || !catalog?.models.length} onClick={() => setChoosingModel(!choosingModel)}><span>{modelLabel}</span><Icon name="chevron" size={12} /></button></div><button type="button" className="feed-model-reset" aria-label="重置为模型默认推理强度" title="重置为模型默认推理强度" disabled={blocked || !model} onClick={() => { if (model && !blocked) { setNotice(''); onChange({ model: model.id, reasoningEffort: null }); } }}><Icon name="reset" size={16} /></button></header>
      {choosingModel ? <div className="feed-model-list" ref={menu} role="menu" aria-label="可用模型" onKeyDown={event => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')], current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length]?.focus();
      }}>{catalog?.models.map(option => <button type="button" key={option.id} role="menuitemradio" aria-checked={option.id === model?.id} tabIndex={option.id === model?.id ? 0 : -1} disabled={blocked} onClick={() => chooseModel(option.id)}><span>{option.name}</span>{option.id === model?.id && <Icon name="check" size={14} />}</button>)}</div> : !!efforts.length && <div className="feed-effort-slider" data-unset={index < 0} style={{ '--effort-progress': `calc(14px + (100% - 28px) * ${efforts.length > 1 && index >= 0 ? index / (efforts.length - 1) : .5})` } as CSSProperties}>
        <span className="feed-effort-stops" aria-hidden="true">{efforts.map((option, position) => <i key={option.reasoningEffort} data-selected={position <= index} />)}</span><input type="range" aria-label="推理强度" aria-valuetext={effortLabel} title={efforts[index]?.description} min={0} max={efforts.length - 1} step={1} value={Math.max(0, index)} disabled={blocked || efforts.length < 2} onChange={event => changeEffort(event.target.value)} onPointerUp={event => { if (index < 0) changeEffort(event.currentTarget.value); }} onKeyDown={event => { if (index < 0 && ['Home', 'ArrowLeft', 'ArrowDown', 'PageDown'].includes(event.key)) { event.preventDefault(); changeEffort('0'); } }} />
      </div>}
      {catalog && !loading && (!model || !efforts.length) && <p className="field-note" role="status">{value.model && !model ? '无法验证已保存的模型，请重新选择或刷新。' : model ? '当前模型未提供推理强度选项，使用模型默认。' : '未获取到可用模型。'}</p>}
      {catalog && !loading && value.reasoningEffort && index < 0 && <p className="field-note" role="status">已保存的推理强度「{value.reasoningEffort}」暂不可用，请重新选择或重置。</p>}
      {notice && <p className="field-note" role="status">{notice}</p>}{catalog?.errors.map(error => <p key={error} className="field-note" role="status">{error}</p>)}
      {(!!catalog?.errors.length || !loading && (!catalog?.models.length || !!value.model && !model || !!value.reasoningEffort && index < 0)) && <button type="button" className="text-button" disabled={blocked} onClick={() => void load()}>重新读取模型</button>}
    </div>
  </div>;
}
