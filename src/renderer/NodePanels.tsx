import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { NodePanel, PanelCommand, PanelSnapshot } from '../shared/panels';

export function panelAddress(input: string) {
  const value = input.trim();
  if (/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(value)) return 'http://' + value;
  return /^[a-z][a-z\d+.-]*:/i.test(value) ? value : 'https://' + value;
}

function PanelIcon({ kind }: { kind: NodePanel['kind'] }) {
  return <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">{kind === 'browser' ? <><circle cx="10" cy="10" r="7.5" /><path d="M2.5 10h15M10 2.5c4 4 4 11 0 15-4-4-4-11 0-15Z" /></> : <path d="M5 2.5h6l4 4v11H5v-15Zm6 0v4h4M7.5 10h5m-5 3h5" />}</svg>;
}

export function NodePanels({ projectId, nodeId, visible }: { projectId: string; nodeId: string; visible: boolean }) {
  const [snapshot, setSnapshot] = useState<PanelSnapshot | null>(null);
  const [address, setAddress] = useState('');
  const [opening, setOpening] = useState<'url' | 'file' | null>(null);
  const [drafts, setDrafts] = useState({ url: '', file: '' });
  const [picking, setPicking] = useState(false);
  const [issue, setIssue] = useState<{ text: string; retry: () => void } | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const tabs = useRef<HTMLDivElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const newInput = useRef<HTMLInputElement>(null);
  const [generation, setGeneration] = useState<number | null>(null);
  const alive = useRef(true);
  const scope = { projectId, nodeId };
  function accept(state: PanelSnapshot) {
    if (alive.current) setSnapshot(current => !current || state.revision >= current.revision ? state : current);
  }
  async function command(value: PanelCommand): Promise<PanelSnapshot | null> {
    setIssue(null);
    try {
      const state = await window.mixcat.panel(value);
      if (!alive.current) return null;
      if (value.type === 'bind') setGeneration(state.generation ?? null);
      accept(state); return state;
    } catch (error) {
      if (alive.current) setIssue({ text: error instanceof Error ? error.message : String(error), retry: () => void command(value) });
      return null;
    }
  }
  useEffect(() => {
    alive.current = true;
    let current = true;
    void window.mixcat.panel({ ...scope, type: 'bind' }).then(state => {
      if (current) { setGeneration(state.generation ?? null); accept(state); }
    }).catch(error => {
      if (current) setIssue({ text: String(error), retry: () => void command({ ...scope, type: 'bind' }) });
    });
    const unsubscribe = window.mixcat.subscribePanels(state => {
      if (state.projectId === projectId && state.nodeId === nodeId) accept(state);
    });
    return () => { current = false; alive.current = false; unsubscribe(); };
  }, [projectId, nodeId]);
  const panels = snapshot?.panels ?? [];
  const active = panels.find(panel => panel.id === snapshot?.activePanelId);
  const problem = issue?.text ?? active?.error;
  const presented = visible && !picking && !problem;
  useEffect(() => { setAddress(active?.url ?? ''); }, [active?.id, active?.url]);
  useEffect(() => { if (opening) newInput.current?.focus(); }, [opening]);
  useEffect(() => {
    if (generation === null) return;
    const update = () => {
      const rect = frame.current?.getBoundingClientRect();
      void window.mixcat.panel({ ...scope, type: 'layout', generation, bounds: presented && active && rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null }).catch(() => {});
    };
    const observer = new ResizeObserver(update); if (frame.current) observer.observe(frame.current);
    update(); window.addEventListener('resize', update);
    return () => { observer.disconnect(); window.removeEventListener('resize', update); void window.mixcat.panel({ ...scope, type: 'layout', generation, bounds: null }).catch(() => {}); };
  }, [presented, active?.id, projectId, nodeId, generation]);
  function cancelOpening() { setOpening(null); (addButton.current ?? frame.current?.querySelector<HTMLButtonElement>('.panel-start button'))?.focus(); }
  async function openDraft(event: FormEvent) {
    event.preventDefault();
    if (!opening || !drafts[opening].trim()) return;
    const result = await command({ ...scope, type: 'open', target: opening === 'url' ? { type: 'url', url: panelAddress(drafts.url) } : { type: 'file', path: drafts.file.trim() } });
    if (result) setOpening(null);
  }
  async function pickFile() {
    if (generation === null || picking) return;
    setIssue(null); setPicking(true);
    try {
      const path = await window.mixcat.choosePanelFile(projectId, nodeId, generation);
      if (!alive.current) return;
      if (!path || await command({ ...scope, type: 'open', target: { type: 'file', path } })) setOpening(null);
    } catch (error) {
      if (alive.current) setIssue({ text: error instanceof Error ? error.message : String(error), retry: () => void pickFile() });
    } finally { if (alive.current) setPicking(false); }
  }
  async function closePanel(panelId: string) {
    const state = await command({ ...scope, type: 'close', panelId });
    if (!state) return;
    requestAnimationFrame(() => {
      const next = [...(tabs.current?.querySelectorAll<HTMLButtonElement>('[role=tab]') ?? [])].find(button => button.dataset.panelId === state.activePanelId);
      (next ?? addButton.current ?? frame.current?.querySelector<HTMLButtonElement>('.panel-start button'))?.focus();
    });
  }
  return <section className="node-panels" aria-label="节点工作面板">
    {panels.length > 0 && <div className="panel-tab-bar">
      <div className="panel-tabs" ref={tabs} role="tablist" aria-label="工作资源">
        {panels.map((panel, index) => <div className={panel.id === active?.id ? 'active' : ''} key={panel.id}>
          <button type="button" className="panel-resource-tab" role="tab" data-panel-id={panel.id} aria-selected={panel.id === active?.id} aria-controls="node-panel-content" tabIndex={panel.id === active?.id ? 0 : -1} title={panel.title + '\n' + (panel.path ?? panel.url ?? '')} onClick={() => { setOpening(null); void command({ ...scope, type: 'activate', panelId: panel.id }); }} onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const count = panels.length;
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + count) % count;
            setOpening(null); void command({ ...scope, type: 'activate', panelId: panels[next].id });
            tabs.current?.querySelectorAll<HTMLButtonElement>('[role=tab]')[next]?.focus();
          }}><PanelIcon kind={panel.kind} /><span>{panel.title || (panel.kind === 'browser' ? '网页' : '文件')}</span>{panel.loading && <span className="panel-loading-dot" aria-label="加载中">·</span>}</button>
          <button type="button" className="icon-button panel-close" aria-label={'关闭面板 ' + panel.title} onClick={() => void closePanel(panel.id)}>×</button>
        </div>)}
      </div>
      <button type="button" className="icon-button panel-add" ref={addButton} aria-label="新建面板" title="新建面板" aria-expanded={opening !== null} aria-controls="panel-resource-form" onClick={() => opening ? cancelOpening() : setOpening('url')}>＋</button>
    </div>}
    <div className="panel-open" id="panel-resource-form" hidden={!opening} onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.stopPropagation(); cancelOpening(); } }}>
      <div className="panel-open-types"><button type="button" aria-pressed={opening === 'url'} onClick={() => setOpening('url')}>网页</button><button type="button" aria-pressed={opening === 'file'} onClick={() => setOpening('file')}>项目文件</button><button type="button" className="icon-button" aria-label="取消新建面板" onClick={cancelOpening}>×</button></div>
      {opening && <form className="browser-address panel-open-form" onSubmit={openDraft}>
        <input ref={newInput} aria-label={opening === 'url' ? '网页地址' : '项目文件路径'} value={drafts[opening]} onChange={event => setDrafts(current => ({ ...current, [opening]: event.target.value }))} placeholder={opening === 'url' ? '输入网址或 localhost:3000' : '输入项目内相对路径'} spellCheck={false} />
        <button type="submit" disabled={!drafts[opening].trim()}>{opening === 'url' ? '打开' : '预览文件'}</button>
        {opening === 'file' && <button type="button" aria-label="选择项目文件" disabled={picking || generation === null} onClick={() => void pickFile()}>{picking ? '选择中…' : '选择文件'}</button>}
      </form>}
    </div>
    {!opening && active?.kind === 'browser' && <form className="browser-address panel-toolbar" onSubmit={event => { event.preventDefault(); if (address.trim()) void command({ ...scope, type: 'navigate', panelId: active.id, url: panelAddress(address) }); }}>
      <button type="button" aria-label="后退" title="后退" disabled={!active.canGoBack} onClick={() => void command({ ...scope, type: 'navigate', panelId: active.id, action: 'back' })}>←</button>
      <button type="button" aria-label="前进" title="前进" disabled={!active.canGoForward} onClick={() => void command({ ...scope, type: 'navigate', panelId: active.id, action: 'forward' })}>→</button>
      <button type="button" aria-label="刷新网页" title="刷新网页" onClick={() => void command({ ...scope, type: 'navigate', panelId: active.id, action: 'reload' })}>↻</button>
      <input aria-label="网页地址" value={address} onChange={event => setAddress(event.target.value)} placeholder="输入网址" spellCheck={false} />
      <button type="submit" disabled={!address.trim()}>打开</button>
    </form>}
    {!opening && active?.kind === 'file' && <div className="panel-file-toolbar"><PanelIcon kind="file" /><div title={active.path}><strong>{active.title}</strong><span>{active.path}</span></div><button type="button" className="icon-button" aria-label="刷新文件" title="刷新文件" onClick={() => void command({ ...scope, type: 'navigate', panelId: active.id, action: 'reload' })}>↻</button><button type="button" className="text-button" onClick={() => setOpening('file')}>打开文件</button></div>}
    {active?.loading && !problem && <progress className="panel-progress" aria-label="正在加载面板" />}
    <div className="native-panel-viewport" id="node-panel-content" role="tabpanel" aria-label={active?.title ?? '工作资源预览'} aria-busy={active?.loading ?? false} ref={frame}>
      {problem ? <div className="panel-state panel-error-state" role="alert"><h3>无法打开面板</h3><p>{problem}</p><div><button type="button" className="button secondary" onClick={issue?.retry ?? (() => active && void command({ ...scope, type: 'navigate', panelId: active.id, action: 'reload' }))}>重试</button>{issue && active && <button type="button" className="text-button" onClick={() => { setIssue(null); setOpening(null); }}>返回当前面板</button>}</div></div> : !active && <div className="panel-state panel-start"><PanelIcon kind="browser" /><h3>打开节点工作资源</h3><p>网页、项目文件和预览会在这里显示。</p><div><button type="button" className="button secondary" onClick={() => setOpening('url')}>打开网页</button><button type="button" className="button secondary" disabled={picking || generation === null} onClick={() => void pickFile()}>打开项目文件</button></div></div>}
    </div>
  </section>;
}
