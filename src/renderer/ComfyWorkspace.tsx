import { useEffect, useRef, useState, type ComponentProps } from 'react';
import type { GraphView, RunView } from '../shared/comfy';
import type { ComfyFeedback, ComfyRunPage, ComfyVersions, ComfyWorkspaceCommand } from '../shared/comfy-workspace';
import type { Workbench } from './Workbench';
import type { WorkbenchRequest } from './ProjectManagement';
import { SessionPane, type SessionPaneHandle } from './SessionPane';
import { ComfyProviderSettings } from './ComfyProviderSettings';
import { Dialog } from './Dialog';

const statuses: Record<string, string> = { prepared: '已准备', submitting: '提交中', submission_unknown: '提交结果待核对', queued: '原生队列中', running: '运行中', downloading: '下载中', succeeded: '原生工作流完成', failed: '失败', cancel_requested: '已请求取消', cancelled: '已确认取消', needs_reconciliation: '状态待核对' };
type WorkspaceInput = ComfyWorkspaceCommand extends infer T ? T extends { projectId: string } ? Omit<T, 'projectId'> : never : never;
export function selectedComfyReference(view: GraphView) {
  if (!view.selectedNodeIds.length) throw Error('请先在原生画布中选中节点。');
  return `请查看当前选中的 ComfyUI 节点。\n工作流上下文：${JSON.stringify(view.observation)}\n子图路径：${JSON.stringify(view.subgraphPath)}\n选中节点：${JSON.stringify(view.selectedNodeIds)}`;
}

export function ComfyWorkspace(props: ComponentProps<typeof Workbench>) {
  const { snapshot, obscured = false } = props, projectId = snapshot.project.id, nodeId = 'comfy-assistant';
  const [assistantOpen, setAssistantOpen] = useState(true), [providersOpen, setProvidersOpen] = useState(false), [runsOpen, setRunsOpen] = useState(false), [versionsOpen, setVersionsOpen] = useState(false);
  const [overlay, setOverlay] = useState(false), [sessionOverlay, setSessionOverlay] = useState(false), [generation, setGeneration] = useState<number | null>(null), [attempt, setAttempt] = useState(0);
  const [preparation, setPreparation] = useState<'preparing' | 'ready' | 'error' | 'closed'>('preparing'), [error, setError] = useState(''), [pending, setPending] = useState('');
  const [page, setPage] = useState<ComfyRunPage>({ runs: [] }), [versions, setVersions] = useState<ComfyVersions>({ versions: [], recovery: [] }), [version, setVersion] = useState('');
  const [selectedRun, setSelectedRun] = useState<RunView | null>(null), [feedback, setFeedback] = useState<WorkbenchRequest>();
  const frame = useRef<HTMLDivElement>(null), pane = useRef<SessionPaneHandle>(null), alive = useRef(true), layoutSequence = useRef(0);
  const loadedMore = useRef(false);
  useEffect(() => { if (props.workRequest) setFeedback(props.workRequest); }, [props.workRequest?.id]);
  const hidden = obscured || overlay || sessionOverlay || providersOpen || runsOpen || versionsOpen || preparation === 'closed';
  const command = async (value: WorkspaceInput) => {
    if (!window.mixcat.comfyWorkspace) throw Error('Comfy 工作区连接尚未就绪。');
    return window.mixcat.comfyWorkspace({ ...value, projectId } as ComfyWorkspaceCommand);
  };
  useEffect(() => {
    alive.current = true; let current = true;
    void command({ type: 'bind' }).then(result => { if (current && result && 'generation' in result) setGeneration(result.generation); }).catch(error => { if (current) { setPreparation('error'); setError(String(error.message ?? error)); } });
    return () => { current = false; alive.current = false; };
  }, [projectId, attempt]);
  useEffect(() => {
    const update = () => setOverlay(!!document.querySelector('dialog[open]'));
    const observer = new MutationObserver(update); observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] }); update();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (generation === null) return;
    const update = () => {
      const sequence = ++layoutSequence.current, rect = frame.current?.getBoundingClientRect();
      const bounds = !hidden && rect && rect.width > 0 && rect.height > 0 ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
      void command({ type: 'layout', generation, bounds }).then(() => { if (alive.current && sequence === layoutSequence.current && bounds) setPreparation('ready'); }).catch(error => { if (alive.current && sequence === layoutSequence.current) { setPreparation('error'); setError(String(error.message ?? error)); } });
    };
    const observer = new ResizeObserver(update); if (frame.current) observer.observe(frame.current); update(); window.addEventListener('resize', update);
    return () => { layoutSequence.current++; observer.disconnect(); window.removeEventListener('resize', update); void command({ type: 'layout', generation, bounds: null }).catch(() => {}); };
  }, [generation, hidden]);
  async function refreshRuns(cursor?: string) {
    const next = await command({ type: 'runs', cursor }) as ComfyRunPage;
    if (cursor) loadedMore.current = true;
    if (alive.current) setPage(current => cursor ? { ...next, runs: [...new Map([...current.runs, ...next.runs].map(run => [run.id, run])).values()] } : loadedMore.current ? { ...current, runs: [...next.runs, ...current.runs.filter(run => !next.runs.some(fresh => fresh.id === run.id))] } : next);
  }
  useEffect(() => {
    if (preparation === 'closed' || pending === 'close' || pending === 'retry') return;
    let current = true;
    const refresh = () => { void refreshRuns().catch(() => {}); void command({ type: 'request', request: { type: 'summary' } }).then(result => {
      if (current && alive.current && preparation === 'ready' && result && 'runtime' in result && result.runtime.status !== 'ready') { setPreparation('error'); setError('Comfy 原生运行环境已停止，未完成运行需核对。请重新打开画布。'); }
    }).catch(error => { if (current && alive.current && preparation === 'ready') { setPreparation('error'); setError(String(error.message ?? error)); } }); };
    refresh(); const timer = window.setInterval(refresh, 3000); return () => { current = false; clearInterval(timer); };
  }, [projectId, preparation, runsOpen, pending]);
  async function act(name: string, action: () => Promise<void>) {
    setPending(name); setError('');
    try { await action(); } catch (error) { if (alive.current) setError(String((error as Error).message ?? error)); }
    finally { if (alive.current) setPending(current => current === name ? '' : current); }
  }
  async function readGraph() { return await command({ type: 'request', request: { type: 'read_graph' } }) as GraphView; }
  async function referenceNodes() {
    const text = selectedComfyReference(await readGraph());
    if (alive.current) { setFeedback({ id: crypto.randomUUID(), nodeId, text }); setAssistantOpen(true); }
  }
  async function run() { const graph = await readGraph(); await command({ type: 'request', request: { type: 'queue_graph', requestId: crypto.randomUUID(), expected: graph.observation } }); await refreshRuns(); }
  async function inspect(runId: string) { const run = await command({ type: 'request', request: { type: 'read_run', runId } }) as RunView; if (alive.current) setSelectedRun(run); }
  async function output(run: RunView, assetId: string, open: boolean) {
    const result = await command({ type: 'feedback', runId: run.id, assetId }) as ComfyFeedback;
    if (!alive.current) return;
    setRunsOpen(false); setAssistantOpen(true);
    if (open) pane.current?.open(result.path);
    else setFeedback({ id: crypto.randomUUID(), nodeId, text: result.text, attachments: result.attachments });
  }
  return <main className="workbench session-workbench comfy-workspace">
    <header className="project-header"><div className="project-statusbar"><strong>ComfyUI</strong><span role="status">{preparation === 'ready' ? '原生画布已就绪' : preparation === 'preparing' ? '正在准备官方运行环境…' : preparation === 'closed' ? '画布已安全关闭' : '准备未完成'}</span></div><div className="project-controls">
      <button className="button secondary compact" onClick={() => setProvidersOpen(true)}>供应商</button>
      <button className="button secondary compact" onClick={() => { setRunsOpen(true); void act('runs', () => refreshRuns()); }}>运行记录 {page.runs.length}</button>
      <button className="button secondary compact" onClick={() => { setVersionsOpen(true); void act('versions', async () => { const result = await command({ type: 'versions' }) as ComfyVersions; if (alive.current) { setVersions(result); setVersion(result.recovery[0]?.beforeVersionId ?? result.versions[0] ?? ''); } }); }}>版本恢复</button>
      <button className="button secondary compact" disabled={preparation !== 'ready' || !!pending} onClick={() => void act('reference', referenceNodes)}>引用选中节点</button>
      <button className="button primary compact" disabled={preparation !== 'ready' || !!pending} onClick={() => void act('run', run)}>{pending === 'run' ? '正在受理…' : '运行工作流'}</button>
      <button className="button secondary compact" aria-expanded={assistantOpen} onClick={() => setAssistantOpen(open => !open)}>{assistantOpen ? '收起助手' : '打开助手'}</button>
    </div></header>
    {error && <p className="inline-error" role="alert">{error}</p>}
    <div className={`workbench-body${assistantOpen ? '' : ' details-collapsed'}`}><section className="comfy-canvas-column" aria-label="ComfyUI 原生画布">
      <div className="comfy-native-frame" ref={frame} tabIndex={-1}>{preparation !== 'ready' && <div className="panel-empty"><h3>{preparation === 'preparing' ? '正在准备官方 ComfyUI' : preparation === 'closed' ? '画布已关闭' : 'ComfyUI 准备未完成'}</h3><p>首次启动需要准备官方 CPU 运行环境。准备完成后才可运行工作流。</p>{preparation !== 'preparing' && <button className="button secondary" disabled={!!pending} onClick={() => void act('retry', async () => { await command({ type: 'retry' }); setPreparation('preparing'); setGeneration(null); setAttempt(value => value + 1); })}>重新打开画布</button>}</div>}</div>
      <div className="comfy-canvas-footer"><span>完整官方画布 · 使用项目供应商连接</span><button className="text-button" disabled={!!pending || preparation === 'closed'} onClick={() => void act('close', async () => { await command({ type: 'close' }); if (alive.current) setPreparation('closed'); })}>安全关闭画布</button></div>
    </section><aside className="detail-panel session-detail" hidden={!assistantOpen} aria-label="ComfyUI 助手"><div className="comfy-session-actions"><button className="text-button" onClick={() => pane.current?.history()}>项目会话历史</button><button className="text-button" onClick={() => pane.current?.reviews()}>待人工核对</button><button className="text-button" onClick={() => void props.execute({ type: 'stop', projectId })}>停止助手本轮</button></div><SessionPane {...props} ref={pane} nodeId={nodeId} visible={assistantOpen} onClose={() => { setAssistantOpen(false); frame.current?.focus(); }} onOpen={() => setAssistantOpen(true)} obscured={obscured || providersOpen || runsOpen || versionsOpen} onObscured={setSessionOverlay} workRequest={feedback ?? props.workRequest} persistDrafts /></aside></div>
    {providersOpen && <ComfyProviderSettings projectId={projectId} onClose={() => setProvidersOpen(false)} />}
    {runsOpen && <Dialog title="ComfyUI 运行记录" wide onClose={() => setRunsOpen(false)}><p className="field-note">停止等待会保存远端任务身份；重开时核对原任务，不会自动重新提交工作流。</p>{error && <p className="inline-error" role="alert">{error}</p>}<div className="comfy-run-list">{page.runs.map(run => <div key={run.id} className="comfy-run-row"><button className="text-button" onClick={() => void act('inspect', () => inspect(run.id))}>{run.id.slice(0, 12)} · {statuses[run.status] ?? run.status}</button><span>{run.waiting === false ? '已停止本地等待' : ''}</span><button className="text-button" onClick={() => void act('stop', async () => { setSelectedRun(await command({ type: 'request', request: { type: 'stop_run', runId: run.id, action: 'stop_waiting' } }) as RunView); await refreshRuns(); })}>停止等待</button><button className="text-button" onClick={() => void act('cancel', async () => { setSelectedRun(await command({ type: 'request', request: { type: 'stop_run', runId: run.id, action: 'cancel_remote' } }) as RunView); await refreshRuns(); })}>请求远端取消</button></div>)}</div>{page.nextCursor && <button className="button secondary" onClick={() => void act('more', () => refreshRuns(page.nextCursor))}>加载更早记录</button>}
      {selectedRun && <section className="comfy-run-detail"><h3>{statuses[selectedRun.status] ?? selectedRun.status}</h3><p>{selectedRun.id}</p>{selectedRun.error && <p role="alert">{selectedRun.error.message}</p>}{selectedRun.providerJobs?.map(job => <p key={job.jobId}>节点 {job.nodeId} · {job.status}{job.rawStatus ? ` (${job.rawStatus})` : ''}{job.cancelOutcome ? ` · 取消结果：${job.cancelOutcome}` : ''}{job.waiting ? '' : ' · 已停止本地等待'}{job.failure ? ` · ${job.failure.message}` : ''}</p>)}{[['原生工作流成果', selectedRun.assets], ['恢复的供应商中间产物（原生后处理未完成）', selectedRun.recoveredAssets ?? []]].map(([label, assets]) => <div key={String(label)}><h4>{String(label)}</h4>{(assets as RunView['assets']).map(asset => <div key={asset.id} className="comfy-output"><span>{asset.relativePath} · {asset.bytes} bytes</span><button className="text-button" onClick={() => void act('open', () => output(selectedRun, asset.id, true))}>打开成果</button><button className="button secondary compact" onClick={() => void act('feedback', () => output(selectedRun, asset.id, false))}>引用到助手并反馈</button></div>)}</div>)}</section>}
    </Dialog>}
    {versionsOpen && <Dialog title="恢复原生工作流版本" onClose={() => setVersionsOpen(false)}>{error && <p className="inline-error" role="alert">{error}</p>}<p className="field-note">恢复会先保存当前图的版本，再替换当前根工作流。不会运行模型。</p>{versions.recovery.length > 0 && <p className="inline-warning">有 {versions.recovery.length} 次编辑结果待核对，可选择其编辑前版本恢复。</p>}<label>工作流版本<select aria-label="工作流版本" value={version} onChange={event => setVersion(event.target.value)}>{versions.versions.map(id => <option key={id} value={id}>{versions.recovery.some(item => item.beforeVersionId === id) ? '待核对编辑前 · ' : ''}{id.slice(0, 20)}</option>)}</select></label><div className="modal-actions"><button className="button primary" disabled={!version || !!pending} onClick={() => void act('restore', async () => { const graph = await readGraph(); await command({ type: 'request', request: { type: 'restore_graph', requestId: crypto.randomUUID(), versionId: version, expected: graph.observation } }); setVersionsOpen(false); })}>恢复选中版本</button></div></Dialog>}
  </main>;
}
