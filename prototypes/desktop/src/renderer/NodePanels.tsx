import { useEffect, useRef, useState } from 'react';
import type { PanelCommand, PanelSnapshot } from '../shared/panels';

export function NodePanels({ projectId, nodeId, visible, onError }: { projectId: string; nodeId: string; visible: boolean; onError: (error: string) => void }) {
  const [snapshot, setSnapshot] = useState<PanelSnapshot | null>(null);
  const [address, setAddress] = useState('');
  const [file, setFile] = useState('');
  const frame = useRef<HTMLDivElement>(null);
  const scope = { projectId, nodeId };
  async function command(value: PanelCommand) {
    try { const state = await window.mixcat.panel(value); setSnapshot(state); }
    catch (error) { onError(error instanceof Error ? error.message : String(error)); }
  }
  useEffect(() => {
    void command({ ...scope, type: 'list' });
    const unsubscribe = window.mixcat.subscribePanels(state => { if (state.projectId === projectId && state.nodeId === nodeId) setSnapshot(state); });
    return () => { unsubscribe(); void window.mixcat.panel({ ...scope, type: 'layout', bounds: null }).catch(() => {}); };
  }, [projectId, nodeId]);
  const active = snapshot?.panels.find(panel => panel.id === snapshot.activePanelId);
  useEffect(() => { setAddress(active?.url ?? ''); }, [active?.id, active?.url]);
  useEffect(() => {
    const update = () => {
      const rect = frame.current?.getBoundingClientRect();
      void window.mixcat.panel({ ...scope, type: 'layout', bounds: visible && active && rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null }).catch(() => {});
    };
    const observer = new ResizeObserver(update); if (frame.current) observer.observe(frame.current);
    update(); window.addEventListener('resize', update);
    return () => { observer.disconnect(); window.removeEventListener('resize', update); void window.mixcat.panel({ ...scope, type: 'layout', bounds: null }).catch(() => {}); };
  }, [visible, active?.id, projectId, nodeId]);
  return <section className="node-panels" aria-label="节点工作面板">
    <div className="panel-tabs">{snapshot?.panels.map(panel => <div className={panel.id === active?.id ? 'active' : ''} key={panel.id}><button className="text-button" onClick={() => void command({ ...scope, type: 'activate', panelId: panel.id })}>{panel.title || (panel.kind === 'browser' ? '浏览器' : '文件')}{panel.loading ? ' · 加载中' : ''}</button><button className="icon-button" aria-label={`关闭面板 ${panel.title}`} onClick={() => void command({ ...scope, type: 'close', panelId: panel.id })}>×</button></div>)}</div>
    <form className="browser-address" onSubmit={event => { event.preventDefault(); const url = /^https?:\/\//i.test(address) ? address : `https://${address}`; void command(active?.kind === 'browser' ? { ...scope, type: 'navigate', panelId: active.id, url } : { ...scope, type: 'open', target: { type: 'url', url } }); }}>
      <button type="button" aria-label="后退" disabled={!active?.canGoBack} onClick={() => active && void command({ ...scope, type: 'navigate', panelId: active.id, action: 'back' })}>←</button><button type="button" aria-label="前进" disabled={!active?.canGoForward} onClick={() => active && void command({ ...scope, type: 'navigate', panelId: active.id, action: 'forward' })}>→</button>
      <input aria-label="网页地址" value={address} onChange={e => setAddress(e.target.value)} placeholder="输入网址" /><button className="button secondary" disabled={!address.trim()}>打开</button>
    </form>
    <form className="browser-address" onSubmit={event => { event.preventDefault(); void command({ ...scope, type: 'open', target: { type: 'file', path: file } }); }}><input aria-label="项目文件路径" value={file} onChange={e => setFile(e.target.value)} placeholder="项目内文件、图片或设计图路径" /><button className="button secondary" disabled={!file.trim()}>预览文件</button></form>
    {active?.error && <p className="inline-error" role="alert">{active.error}</p>}
    <div className="native-panel-viewport" ref={frame}>{!active && <div className="panel-empty"><h3>这个节点的工作面板</h3><p>打开网页，或从会话中预览文件、图片和设计图。面板与当前节点关联。</p></div>}</div>
  </section>;
}
