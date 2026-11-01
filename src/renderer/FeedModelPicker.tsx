import { useEffect, useRef, useState } from 'react';
import type { FeedCapabilities } from '../shared/feed';
import type { CapabilityCatalog } from '../shared/types';
import { PersonalCapabilityFields } from './PersonalCapabilityFields';
import type { FeedExecute } from './FeedWorkspace';

export function FeedModelPicker({ value, onChange, execute, collectionId, disabled = false }: { value: FeedCapabilities; onChange(patch: Partial<FeedCapabilities>): void; execute: FeedExecute; collectionId?: string; disabled?: boolean }) {
  const [catalog, setCatalog] = useState<CapabilityCatalog | null>(null), [loading, setLoading] = useState(false);
  const sequence = useRef(0), port = useRef(execute); port.current = execute;
  async function load() {
    const token = ++sequence.current; setLoading(true);
    try { const reply = await port.current({ type: 'feed_capabilities', ...(collectionId ? { collectionId } : {}) }); if (sequence.current === token) setCatalog(reply.capabilities!); }
    catch (error) { if (sequence.current === token) setCatalog(current => ({ models: [], skills: [], plugins: [], ...current, errors: [String(error)] })); }
    finally { if (sequence.current === token) setLoading(false); }
  }
  useEffect(() => { void load(); return () => { sequence.current++; }; }, [collectionId]);
  const model = catalog?.models.find(model => value.model ? model.id === value.model : model.isDefault);
  return <details className="feed-model-picker"><summary aria-label="选择模型与思考强度"><span>{model?.name ?? value.model ?? '模型默认'}</span><span className="feed-effort">{value.reasoningEffort ?? '默认'}</span><span aria-hidden="true">⌄</span></summary>
    <fieldset className="feed-model-controls" disabled={disabled || loading}><PersonalCapabilityFields node={{ ...value, id: collectionId ?? 'new', model: value.model ?? model?.id ?? null }} catalog={catalog} loading={loading} onChange={onChange} modelsOnly /><button type="button" className="text-button" onClick={() => void load()}>刷新模型</button></fieldset>
  </details>;
}
