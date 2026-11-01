import { CaptureUpdateAction, Excalidraw, MainMenu, WelcomeScreen, isElementLink, languages, newElementWith, serializeAsJSON } from '@excalidraw/excalidraw';
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI, LibraryItems } from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import '@excalidraw/excalidraw/index.css';
import './Canvases.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CanvasCommand, CanvasDocument, CanvasScene, CanvasSummary } from '../shared/canvases';
import { CanvasSaveQueue } from './canvas-autosave';
import { Dialog } from './Dialog';
import { Icon } from './Icon';

type ThemeChoice = 'light' | 'dark' | 'system';

async function command(input: CanvasCommand) {
  if (!window.mixcat.canvases) throw Error('画布服务尚未就绪。');
  return window.mixcat.canvases(input);
}
function canvasPreferences(state: AppState) {
  const preferences = ['theme', 'scrollX', 'scrollY', 'zoom', 'gridModeEnabled', 'objectsSnapModeEnabled', 'viewModeEnabled', 'zenModeEnabled', 'exportBackground', 'exportEmbedScene', 'exportWithDarkMode', 'exportScale', 'boxSelectionMode', 'bindingPreference', 'isMidpointSnappingEnabled', 'showHints', 'inputDevice', 'penMode', 'colorTopPicks', 'fontTopPicks', 'preferredSelectionTool', 'activeTool'];
  return Object.fromEntries(Object.keys(state).filter(key => preferences.includes(key) || key.startsWith('currentItem')).map(key => [key, state[key as keyof AppState]]));
}
function sceneForStorage(elements: readonly ExcalidrawElement[], state: AppState, files: BinaryFiles): CanvasScene {
  const scene = JSON.parse(serializeAsJSON(elements, state, files, 'local'));
  Object.assign(scene.appState, canvasPreferences(state));
  return scene;
}

export default function Canvases({ sidebar, active }: { sidebar: HTMLElement | null; active: boolean }) {
  const [canvases, setCanvases] = useState<CanvasSummary[]>([]), [document, setDocument] = useState<CanvasDocument | null>(null);
  const [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [language, setLanguage] = useState(() => languages.find(item => item.code === localStorage.getItem('mixcat.canvas.language'))?.code ?? 'zh-CN');
  const [theme, setTheme] = useState<ThemeChoice>(() => { const value = localStorage.getItem('mixcat.canvas.theme'); return value === 'dark' || value === 'system' ? value : 'light'; });
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);
  const [, render] = useState(0);
  const [menu, setMenu] = useState<{ canvas: CanvasSummary; x: number; y: number } | null>(null);
  const [action, setAction] = useState<{ operation: 'rename' | 'delete'; canvas: CanvasSummary } | null>(null), [name, setName] = useState('');
  const sceneQueue = useRef<CanvasSaveQueue<CanvasScene> | null>(null), libraryQueue = useRef<CanvasSaveQueue<LibraryItems> | null>(null);
  const api = useRef<ExcalidrawImperativeAPI | null>(null), selectedId = useRef<string | null>(null), navigating = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null), libraryItems = useRef<LibraryItems>([]);
  const scenePending = useRef(false);
  const observed = useRef<{ signature: string; elements: readonly ExcalidrawElement[]; files: BinaryFiles } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  function openLink(url: string) { void window.mixcat.openExternal?.(url).catch(caught => setError(String(caught))); }
  const initialData = useMemo(() => document ? { ...document.scene, elements: document.scene.elements as ExcalidrawElement[], appState: document.scene.appState, files: document.scene.files as BinaryFiles, libraryItems: libraryItems.current } : null, [document?.id, document?.scene]);
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)'), change = () => setSystemDark(media.matches);
    media.addEventListener('change', change); return () => media.removeEventListener('change', change);
  }, []);
  function changed() {
    render(value => value + 1);
    void window.mixcat.setUnsaved?.('canvases', scenePending.current || !!sceneQueue.current?.dirty || !!libraryQueue.current?.dirty).catch(caught => setError(String(caught)));
  }
  async function flush() {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (api.current && !api.current.isDestroyed) {
      const state = api.current.getAppState();
      if (!state.isLoading) { scenePending.current = false; sceneQueue.current?.change(sceneForStorage(api.current.getSceneElementsIncludingDeleted(), state, api.current.getFiles())); }
    }
    const scene = await sceneQueue.current?.flush() ?? true;
    const library = await libraryQueue.current?.flush() ?? true;
    return scene && library;
  }
  function schedule() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      if (!sceneQueue.current?.error && !libraryQueue.current?.error) void flush();
    }, 600);
  }
  function sceneChanged(elements: readonly ExcalidrawElement[], state: AppState, files: BinaryFiles) {
    const signature = JSON.stringify([elements.map(element => [element.id, element.version, element.versionNonce, element.isDeleted]), canvasPreferences(state), Object.keys(files).map(id => [id, files[id].version, files[id].dataURL.length])]);
    const previous = observed.current;
    if (previous?.signature === signature && elements.every((element, index) => element === previous.elements[index]) && Object.keys(files).every(id => files[id] === previous.files[id])) return;
    observed.current = { signature, elements: [...elements], files: { ...files } };
    if (!scenePending.current) { scenePending.current = true; changed(); }
    schedule();
  }
  async function refresh() { setCanvases((await command({ operation: 'list' })).canvases!); }
  function select(canvas: CanvasDocument) {
    selectedId.current = canvas.id; api.current = null; scenePending.current = false; observed.current = null;
    sceneQueue.current = new CanvasSaveQueue(canvas.revision, canvas.scene, async request => {
      const saved = (await command({ operation: 'save', id: canvas.id, requestId: request.requestId, expectedRevision: request.expectedRevision, scene: request.value })).saved!;
      setCanvases(current => current.map(item => item.id === saved.id ? saved : item));
      if (selectedId.current === canvas.id && api.current && !api.current.isDestroyed) {
        let updated = false;
        const elements = api.current.getSceneElementsIncludingDeleted().map(element => {
          if (element.type === 'image' && !element.isDeleted && element.status === 'pending' && element.fileId && request.value.files[element.fileId]) { updated = true; return newElementWith(element, { status: 'saved' }); }
          return element;
        });
        if (updated) api.current.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER });
      }
      return saved.revision;
    }, changed);
    localStorage.setItem('mixcat.canvas.selected', canvas.id);
    setDocument(canvas); changed();
  }
  async function perform(work: () => Promise<void>) {
    if (navigating.current) return;
    navigating.current = true; setBusy(true); setError(null); setMenu(null);
    try { if (await flush()) await work(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { navigating.current = false; setBusy(false); }
  }
  async function load() {
      const library = (await command({ operation: 'get_library' })).library!;
      libraryItems.current = library.items as LibraryItems;
      libraryQueue.current = new CanvasSaveQueue(library.revision, libraryItems.current, async request => (await command({ operation: 'save_library', requestId: request.requestId, expectedRevision: request.expectedRevision, items: request.value })).libraryRevision!, changed);
      const list = (await command({ operation: 'list' })).canvases!; setCanvases(list);
      const id = list.find(item => item.id === localStorage.getItem('mixcat.canvas.selected'))?.id ?? list[0]?.id;
      if (id) select((await command({ operation: 'read', id })).canvas!);
      setLoaded(true);
  }
  useEffect(() => {
    if (!active || loaded || navigating.current) return;
    void perform(load);
  }, [active, loaded]);
  useEffect(() => { if (!active) void flush(); }, [active]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const close = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as HTMLElement)) setMenu(null); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(null); };
    window.addEventListener('pointerdown', close); window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', key); };
  }, [menu]);
  function create() { void perform(async () => { select((await command({ operation: 'create', requestId: crypto.randomUUID() })).canvas!); await refresh(); }); }
  function open(id: string) { if (id !== selectedId.current) void perform(async () => select((await command({ operation: 'read', id })).canvas!)); }
  function openMenu(canvas: CanvasSummary, x: number, y: number) { setMenu({ canvas, x: Math.min(x, innerWidth - 150), y: Math.min(y, innerHeight - 100) }); }
  async function submitAction() {
    if (!action) return;
    await perform(async () => {
      const id = action.canvas.id;
      const current = (await command({ operation: 'read', id })).canvas!;
      const result = await command(action.operation === 'delete' ? { operation: 'delete', id, expectedRevision: current.revision, requestId: crypto.randomUUID() } : { operation: 'rename', id, expectedRevision: current.revision, requestId: crypto.randomUUID(), name });
      if (selectedId.current === id) {
        if (action.operation === 'delete') { selectedId.current = null; sceneQueue.current = null; api.current = null; scenePending.current = false; observed.current = null; localStorage.removeItem('mixcat.canvas.selected'); setDocument(null); changed(); }
        else { sceneQueue.current!.revision = result.saved!.revision; setDocument(value => value ? { ...value, ...result.saved! } : value); }
      }
      setAction(null); await refresh();
    });
  }
  const saveError = sceneQueue.current?.error ?? libraryQueue.current?.error;
  const navigation = <><header className="canvas-sidebar-heading"><h2>画布</h2><button type="button" className="icon-button" aria-label="新建画布" title="新建画布" disabled={busy || !loaded} onClick={create}><Icon name="plus" size={16} /></button></header><ul className="workspace-list" aria-label="画布列表">{canvases.map(canvas => <li className="canvas-list-item" key={canvas.id}><button type="button" className={`canvas-item-open${canvas.id === document?.id ? ' active' : ''}`} aria-current={canvas.id === document?.id ? 'page' : undefined} disabled={busy} onClick={() => open(canvas.id)} onContextMenu={event => { event.preventDefault(); openMenu(canvas, event.clientX, event.clientY); }}><Icon name="canvas" size={14} /><span className="sidebar-project-name">{canvas.name}</span></button><button type="button" className="canvas-item-menu" aria-label={`管理画布：${canvas.name}`} disabled={busy} onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); openMenu(canvas, rect.right, rect.bottom); }}>⋯</button></li>)}</ul>{loaded && !canvases.length && <p className="sidebar-empty">暂无画布</p>}</>;
  return <div className="canvas-workspace" aria-label="独立画布工作区" onClick={event => {
    const anchor = (event.target as Element).closest<HTMLAnchorElement>('a[href]');
    if (!event.defaultPrevented && anchor && /^https?:\/\//i.test(anchor.href)) { event.preventDefault(); openLink(anchor.href); }
  }}>
    {active && sidebar && createPortal(navigation, sidebar)}
    {document ? <Excalidraw key={document.id} langCode={language} theme={theme === 'system' ? systemDark ? 'dark' : 'light' : theme} onThemeChange={value => { setTheme(value); localStorage.setItem('mixcat.canvas.theme', value); }} aiEnabled={false} interaction={!busy} name={document.name} autoFocus initialData={initialData} onExcalidrawAPI={value => { api.current = value; }} handleKeyboardGlobally={false} libraryReturnUrl="https://excalidraw.com" onChange={(elements, state, files) => {
      if (selectedId.current !== document.id || !api.current || state.isLoading) return;
      sceneChanged(elements, state, files);
    }} onScrollChange={() => { if (selectedId.current === document.id && api.current) sceneChanged(api.current.getSceneElementsIncludingDeleted(), api.current.getAppState(), api.current.getFiles()); }} onLibraryChange={items => { libraryItems.current = items; libraryQueue.current?.change(items); schedule(); }} onLinkOpen={(element, event) => {
      let link = element.link; if (!link) return;
      const url = URL.canParse(link) ? new URL(link) : null;
      if (url?.origin === 'https://excalidraw.com' && url.searchParams.has('element')) {
        const local = new URL(window.location.href); local.search = url.search; link = local.href;
      }
      if (isElementLink(link)) {
        event.preventDefault(); api.current?.setViewport({ target: link, fit: 'scale-down', animation: true });
      } else if (/^https?:\/\//i.test(link)) { event.preventDefault(); openLink(link); }
    }}>
      <MainMenu><MainMenu.DefaultItems.LoadScene /><MainMenu.DefaultItems.SaveToActiveFile /><MainMenu.DefaultItems.Export /><MainMenu.DefaultItems.SaveAsImage /><MainMenu.DefaultItems.CommandPalette /><MainMenu.DefaultItems.SearchMenu /><MainMenu.DefaultItems.Help /><MainMenu.DefaultItems.ClearCanvas /><MainMenu.Separator /><MainMenu.DefaultItems.Preferences /><MainMenu.DefaultItems.ToggleTheme allowSystemTheme theme={theme} /><MainMenu.ItemCustom><select className="dropdown-select dropdown-select__language" aria-label="选择语言" style={{ width: '100%' }} value={language} onChange={event => { setLanguage(event.target.value); localStorage.setItem('mixcat.canvas.language', event.target.value); }}>{languages.map(item => <option key={item.code} value={item.code}>{item.label}</option>)}</select></MainMenu.ItemCustom><MainMenu.DefaultItems.ChangeCanvasBackground /></MainMenu>
      <WelcomeScreen><WelcomeScreen.Hints.MenuHint>导出、首选项、语言……</WelcomeScreen.Hints.MenuHint><WelcomeScreen.Hints.ToolbarHint /><WelcomeScreen.Hints.HelpHint /><WelcomeScreen.Center><WelcomeScreen.Center.Logo /><WelcomeScreen.Center.Heading>您的绘图已自动保存在本地。<br />每张画布的内容与视图会独立保存。<br />您也可以将工作保存到一个文件。</WelcomeScreen.Center.Heading><WelcomeScreen.Center.Menu><WelcomeScreen.Center.MenuItemLoadScene /><WelcomeScreen.Center.MenuItemHelp /></WelcomeScreen.Center.Menu></WelcomeScreen.Center></WelcomeScreen>
    </Excalidraw> : <div className="canvas-empty"><Icon name="canvas" size={36} /><span>{loaded ? '创建一张画布，开始绘图' : '正在读取画布…'}</span><button className="button secondary" disabled={busy || !loaded} onClick={create}>新建画布</button></div>}
    {(error || saveError) && <div className="canvas-notice" role="alert"><span>{error ?? saveError}</span><button className="button secondary compact" onClick={() => { setError(null); if (!loaded) { void perform(load); } else void flush(); }}>重试</button></div>}
    {menu && createPortal(<div className="canvas-actions" ref={menuRef} role="menu" style={{ left: menu.x, top: menu.y }}>{(['rename', 'delete'] as const).map(operation => <button key={operation} role="menuitem" onClick={() => { setAction({ operation, canvas: menu.canvas }); setName(menu.canvas.name); setMenu(null); }}>{operation === 'rename' ? '重命名' : '删除'}</button>)}</div>, window.document.body)}
    {action && <Dialog title={action.operation === 'rename' ? '重命名画布' : '删除画布'} onClose={() => { if (!busy) setAction(null); }}>{action.operation === 'rename' ? <form className="form-stack" onSubmit={event => { event.preventDefault(); void submitAction(); }}><label>画布名称<input autoFocus required maxLength={200} value={name} onChange={event => setName(event.target.value)} /></label><div className="modal-actions"><button className="button primary" disabled={busy || !name.trim()}>保存</button></div></form> : <><p>确定删除“{action.canvas.name}”？画布内容将永久删除。</p><div className="modal-actions"><button className="button secondary" disabled={busy} onClick={() => setAction(null)}>取消</button><button className="button primary danger-button" disabled={busy} onClick={() => void submitAction()}>删除画布</button></div></>}</Dialog>}
  </div>;
}
