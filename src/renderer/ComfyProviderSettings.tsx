import { useEffect, useRef, useState } from 'react';
import { Dialog } from './Dialog.js';
import type { ProviderProfile, ProviderProtocol } from '../shared/comfy.js';
import type { ProviderInput } from '../shared/comfy-providers.js';

const empty = (): ProviderInput => ({ name: '', protocol: 'ark', baseUrl: 'https://', models: {} });
/** Task 8 mounts this dialog from its final workspace settings entry. */
export function ComfyProviderSettings(props: { projectId: string; onClose(): void }) {
  return <ProviderSettingsForm key={props.projectId} {...props} />;
}
function ProviderSettingsForm({ projectId, onClose }: { projectId: string; onClose(): void }) {
  const [profiles, setProfiles] = useState<ProviderProfile[]>([]), [draft, setDraft] = useState<ProviderInput>(empty);
  const [busy, setBusy] = useState(true), [error, setError] = useState('');
  const keyInput = useRef<HTMLInputElement>(null), live = useRef(true);
  useEffect(() => {
    live.current = true;
    void window.mixcat.comfyProviders!({ projectId, op: 'list' }).then(value => { if (live.current) setProfiles(value); }, () => { if (live.current) setError('连接读取失败，请重新打开设置。'); }).finally(() => { if (live.current) setBusy(false); });
    return () => { live.current = false; if (keyInput.current) keyInput.current.value = ''; };
  }, [projectId]);
  const selected = profiles.find(p => p.id === draft.id);
  function choose(id: string) {
    const profile = profiles.find(p => p.id === id);
    setDraft(profile ? { id: profile.id, name: profile.name, protocol: profile.protocol, baseUrl: profile.baseUrl, models: { ...profile.models }, videoApi: profile.videoApi, allowInsecureHttp: profile.baseUrl.startsWith('http:') } : empty());
    if (keyInput.current) keyInput.current.value = ''; setError('');
  }
  async function save() {
    setBusy(true); setError('');
    try {
      const result = await window.mixcat.comfyProviders!({ projectId, op: 'save', input: { ...draft, key: keyInput.current?.value || undefined }, expectedRevision: selected?.revision ?? 0 });
      if (!live.current) return;
      if (keyInput.current) keyInput.current.value = '';
      setProfiles(result); setDraft(current => ({ ...current, id: current.id ?? result.at(-1)?.id }));
    } catch (e) { if (live.current) setError(e instanceof Error ? e.message : '连接保存失败。'); }
    finally { if (live.current) setBusy(false); }
  }
  async function remove() {
    if (!selected) return; setBusy(true); setError('');
    try {
      const result = await window.mixcat.comfyProviders!({ projectId, op: 'remove', id: selected.id, expectedRevision: selected.revision });
      if (live.current) { setProfiles(result); choose(''); }
    } catch (e) { if (live.current) setError(e instanceof Error ? e.message : '连接移除失败。'); }
    finally { if (live.current) setBusy(false); }
  }
  return <Dialog title="供应商连接" onClose={onClose}>
    <form className="form-stack" onSubmit={event => { event.preventDefault(); void save(); }}>
      <label>连接<select aria-label="连接" disabled={busy} value={draft.id ?? ''} onChange={event => choose(event.target.value)}><option value="">新建连接</option>{profiles.map(p => <option key={p.id} value={p.id}>{p.name} · 已配置</option>)}</select></label>
      <label>连接名称<input aria-label="连接名称" required maxLength={100} disabled={busy} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
      <label>协议<select aria-label="协议" disabled={busy} value={draft.protocol} onChange={event => { const protocol = event.target.value as ProviderProtocol; setDraft({ ...draft, protocol, videoApi: protocol.startsWith('minimax') ? 'v2' : undefined }); }}>
        <option value="ark">字节火山方舟</option><option value="minimax-cn">MiniMax 中国</option><option value="minimax-global">MiniMax 国际</option><option value="vidu">Vidu</option>
      </select></label>
      <label>完整 API 基址<input aria-label="完整 API 基址" required type="url" maxLength={8192} disabled={busy} value={draft.baseUrl} onChange={event => setDraft({ ...draft, baseUrl: event.target.value, allowInsecureHttp: false })} /><span className="field-note">包含服务需要的路径前缀。更换地址或协议后需重新填写 Key。</span></label>
      {draft.baseUrl.startsWith('http:') && <label className="tool-choice"><input type="checkbox" checked={draft.allowInsecureHttp ?? false} disabled={busy} onChange={event => setDraft({ ...draft, allowInsecureHttp: event.target.checked })} /><span>明确使用此 HTTP 连接（不加密传输）</span></label>}
      {(['text', 'image', 'video'] as const).map(kind => <label key={kind}>{({ text: '文本', image: '图片', video: '视频' })[kind]}模型 / Endpoint ID<input aria-label={`${kind} 模型 ID`} maxLength={512} disabled={busy} value={draft.models[kind] ?? ''} onChange={event => { const models = { ...draft.models }; if (event.target.value) models[kind] = event.target.value; else delete models[kind]; setDraft({ ...draft, models }); }} /></label>)}
      {draft.protocol.startsWith('minimax') && <label>MiniMax 视频 API<select aria-label="MiniMax 视频 API" disabled={busy} value={draft.videoApi ?? 'v2'} onChange={event => setDraft({ ...draft, videoApi: event.target.value as 'v1' | 'v2' })}><option value="v1">V1</option><option value="v2">V2</option></select></label>}
      <label>API Key<input ref={keyInput} aria-label="API Key" type="password" autoComplete="off" maxLength={16384} required={!selected} disabled={busy} placeholder={selected ? '已配置；留空沿用当前地址的 Key' : '填写自己的 API Key'} /></label>
      {selected && <p className="field-note" role="status">已配置，待实际调用验证</p>}
      {error && <p className="inline-warning" role="alert">{error}</p>}
      <div className="modal-actions">{selected && <button type="button" className="button" disabled={busy} onClick={() => void remove()}>移除连接</button>}<button type="submit" className="button primary" disabled={busy}>{busy ? '处理中…' : '保存连接'}</button></div>
    </form>
  </Dialog>;
}
