import { SnapshotReceiver } from '../shared/snapshots';
import { ProjectWorkspace, confirmProjectNavigation } from './ProjectManagement';
import type { ReviewAction } from './HumanReviews';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode, type MouseEvent as ReactMouseEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { AppCommand, AppReply, AppSnapshot, ProjectSummary, RuntimeStatus } from '../shared/types';

const STATUS: Record<string, string> = { idle: '待开始', running: '运行中', pausing: '暂停中', paused: '已暂停', blocked: '需处理', completed: '已完成', queued: '等待中', waiting_source: '等待源任务', failed: '失败', needs_reconciliation: '状态待核对', released: '已交接', delivered: '已投递', pending: '待交接', cancelled: '已取消' };
type Execute = (command: AppCommand, actionId?: string) => Promise<AppReply | null>;

function messageOf(error: unknown) { return error instanceof Error ? error.message : String(error); }
function Status({ status }: { status: string }) { return <span className={`status status-${status}`}><span className="status-dot" />{STATUS[status] ?? status}</span>; }
function Icon({ name, size = 18 }: { name: 'plus' | 'arrow' | 'back' | 'close' | 'folder' | 'play' | 'nodes' | 'check'; size?: number }) {
  const paths = { plus: 'M12 5v14M5 12h14', arrow: 'M5 12h14m-6-6 6 6-6 6', back: 'M19 12H5m6-6-6 6 6 6', close: 'm6 6 12 12M18 6 6 18', folder: 'M3 6h7l2 3h9v11H3V6Z', play: 'm8 5 11 7-11 7V5Z', nodes: 'M3 4h6v6H3zM15 14h6v6h-6zM6 10v7h9M9 7h9v7', check: 'm5 12 4 4L19 6' };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
function PixelCat() { return <svg className="pixel-cat" viewBox="0 0 16 16" aria-hidden="true"><path d="M1 1h4v2h6V1h4v11h-2v2H3v-2H1V1Zm3 5v4h2V6H4Zm6 0v4h2V6h-2ZM6 11v2h4v-2H6Z" fill="currentColor" /></svg>; }
function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => { ref.current?.showModal(); return () => { ref.current?.close(); }; }, []);
  return <dialog ref={ref} className="modal" aria-labelledby={id} onCancel={onClose}><div className="modal-heading"><h2 id={id}>{title}</h2><button type="button" className="icon-button" aria-label="关闭弹窗" onClick={onClose}><Icon name="close" /></button></div>{children}</dialog>;
}

function CreateProject({ execute, busy, error, onClose, onCreated, onError }: { execute: Execute; busy: boolean; error: string | null; onClose: () => void; onCreated: () => void; onError: (error: string) => void }) {
  const [name, setName] = useState('');
  const [root, setRoot] = useState('');
  const [goal, setGoal] = useState('');
  const [template, setTemplate] = useState<'basic' | 'web-product'>('basic');
  const [choosing, setChoosing] = useState(false);
  async function chooseDirectory() {
    setChoosing(true);
    try { const path = await window.mixcat.chooseDirectory(); if (path) setRoot(path); }
    catch (error) { onError(messageOf(error)); }
    finally { setChoosing(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    const reply = await execute({ type: 'create_project', name: name.trim(), root: root.trim(), goal: goal.trim(), ...(template === 'web-product' ? { template } : {}) });
    if (!reply) return;
    onCreated();
    const projectId = reply.snapshot.selected?.project.id;
    if (template === 'web-product' && projectId) {
      await execute({ type: 'configure_template', projectId });
    }
  }
  return <Modal title="新建项目" onClose={onClose}><form onSubmit={submit} className="form-stack">{error && <div className="inline-error" role="alert">{error}</div>}<p className="muted">为一个具体目标建立工作流。每个节点都有自己的模型、会话历史和可选能力。</p><label>项目名称<input autoFocus required maxLength={100} value={name} onChange={event => setName(event.target.value)} placeholder="例如：产品文档更新" /></label><label>项目目录<div className="input-with-button"><input required value={root} onChange={event => setRoot(event.target.value)} placeholder="选择已有的非 C 盘项目目录" /><button type="button" className="button secondary" onClick={chooseDirectory} disabled={choosing}>{choosing ? '选择中…' : '浏览'}</button></div><span className="field-note">会话数据、日志和结果保存在这个项目目录内。</span></label><label>工作流模板<select aria-label="工作流模板" value={template} onChange={event => setTemplate(event.target.value as 'basic' | 'web-product')}><option value="basic">基础工作流 · 3 个节点</option><option value="web-product">Web 产品团队 · 8 个节点</option></select><span className="field-note">Web 模板创建后会读取真实能力目录，配置推荐技能与插件；缺失或失败可在节点配置中查看并调整。</span></label><label>项目目标<textarea required rows={4} value={goal} onChange={event => setGoal(event.target.value)} placeholder="描述需要完成的工作，以及完成的判断标准。" /></label><div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>取消</button><button className="button primary" disabled={busy || !name.trim() || !root.trim() || !goal.trim()}>{busy ? '创建中…' : '创建项目'}<Icon name="arrow" size={16} /></button></div></form></Modal>;
}

function ProjectCard({ project, onOpen, disabled }: { project: ProjectSummary; onOpen: () => void; disabled: boolean }) {
  return <button className="project-card" type="button" onClick={onOpen} disabled={disabled}><div className="project-card-top"><span className="project-icon"><Icon name="folder" size={22} /></span><Status status={project.status} /></div><h2>{project.name}</h2><p className="project-goal">{project.goal}</p>{project.unavailable && <p className="inline-error" role="status">{project.unavailable}</p>}<div className="project-path" title={project.root}>{project.root}</div><div className="project-card-bottom"><span>{project.unavailable ? '重试打开 →' : '进入工作流 →'}</span></div></button>;
}

function Projects({ projects, busy, onCreate, onOpen }: { projects: ProjectSummary[]; busy: boolean; onCreate: () => void; onOpen: (id: string) => void }) {
  return <main className="projects-page"><div className="page-heading"><h1>项目<span className="heading-count">{projects.length}</span></h1><button className="button secondary" onClick={onCreate} disabled={busy}><Icon name="plus" size={16} />新建项目</button></div>{projects.length ? <div className="project-grid">{projects.map(project => <ProjectCard key={project.id} project={project} onOpen={() => onOpen(project.id)} disabled={busy} />)}</div> : <section className="empty-workspace"><PixelCat /><h2>从一个项目开始</h2><p>选择项目目录，写下需要完成的目标。</p><button className="button secondary" onClick={onCreate} disabled={busy}><Icon name="plus" size={16} />新建项目</button></section>}<p className="projects-hint">→ 打开一个项目，进入它的工作流。</p></main>;
}
function ProjectActionDialog({ project, action, execute, busy, error, onClose, onDone }: { project: ProjectSummary; action: 'rename' | 'delete'; execute: Execute; busy: boolean; error: string | null; onClose: () => void; onDone: (reply: AppReply) => void }) {
  const [name, setName] = useState(project.name);
  const rename = action === 'rename';
  async function submit(event: FormEvent) {
    event.preventDefault();
    const reply = await execute(rename ? { type: 'rename_project', projectId: project.id, name: name.trim() } : { type: 'delete_project', projectId: project.id });
    if (reply) onDone(reply);
  }
  return <Modal title={rename ? '重命名项目' : '删除项目'} onClose={onClose}><form className="form-stack" onSubmit={submit}>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {rename ? <label>项目名称<input autoFocus required maxLength={100} value={name} onChange={event => setName(event.target.value)} /></label> : <><p>确认从项目列表删除「{project.name}」？</p><p className="muted">本地项目文件、会话和历史记录都会保留。以后可通过「新建项目」选择原目录重新打开。</p></>}
    <div className="modal-actions"><button className="button secondary" type="button" onClick={onClose} disabled={busy}>取消</button><button className={`button primary${rename ? '' : ' danger-button'}`} disabled={busy || rename && !name.trim()}>{rename ? '保存名称' : '确认删除'}</button></div>
  </form></Modal>;
}
export function Settings({ account, execute, busy }: { account: RuntimeStatus | null; execute: Execute; busy: boolean }) {
  const authenticated = !!account?.connected && !!account.authenticated;
  return <main className="settings-page"><div className="page-heading"><h1>设置</h1></div><section className="account-settings" aria-label="Codex 账号"><h2>Codex 账号</h2>{account?.error && <p className="inline-error" role="alert">{account.error}</p>}<div className="settings-actions" aria-live="polite"><button className={authenticated ? 'button secondary login-success' : 'button primary'} disabled={busy || authenticated} onClick={() => void execute({ type: 'login' })}>{authenticated && <Icon name="check" size={16} />}{authenticated ? '已登录' : '登录 Codex'}</button></div></section></main>;
}

export default function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [failure, setFailure] = useState<{ message: string; command?: AppCommand } | null>(null);
  const errorScope = useRef(0), renderedScope = errorScope.current, error = failure?.message ?? null;
  function clearError() { errorScope.current++; setFailure(null); }
  function reportError(message: string, scope = errorScope.current) { if (scope === errorScope.current) setFailure({ message }); }
  const [pending, setPending] = useState<{ type: AppCommand['type']; projectId: string | undefined }[]>([]);
  const [openProject, setOpenProject] = useState(false);
  const [projectsExpanded, setProjectsExpanded] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [section, setSection] = useState<'projects' | 'notes' | 'knowledge' | 'settings'>('projects');
  const [projectMenu, setProjectMenu] = useState<{ projectId: string; x: number; y: number } | null>(null);
  const [projectAction, setProjectAction] = useState<{ projectId: string; type: 'rename' | 'delete' } | null>(null);
  const projectMenuRef = useRef<HTMLDivElement>(null);
  const projectMenuTrigger = useRef<HTMLButtonElement | null>(null);
  const receiver = useRef<SnapshotReceiver | null>(null);
  const reviewActions = useRef(new Map<string, ReviewAction>());
  receiver.current ??= new SnapshotReceiver(async id => (await window.mixcat.command({ id: crypto.randomUUID(), command: { type: 'snapshot', projectId: id, background: true } })).snapshot, setSnapshot, caught => reportError(messageOf(caught)));
  const busy = pending.length > 0;
  const pendingExecution = pending.some(request => request.projectId === snapshot?.selected?.project.id && ['start', 'send_message', 'retry_task', 'resume', 'resume_node'].includes(request.type));
  async function execute(command: AppCommand, actionId?: string) {
    const request = { type: command.type, projectId: 'projectId' in command ? command.projectId : undefined };
    setPending(current => [...current, request]);
    const navigationToken = command.type === 'create_project' || command.type === 'delete_project' && receiver.current!.snapshot?.selected?.project.id === command.projectId ? receiver.current!.navigate(null)
      : command.type === 'snapshot' && command.projectId && !command.background ? receiver.current!.navigate(command.projectId) : undefined;
    if (navigationToken !== undefined) clearError();
    const scope = errorScope.current, fingerprint = JSON.stringify(command);
    const envelope = { id: actionId ?? crypto.randomUUID(), command };
    try {
      const reply = await window.mixcat.command(envelope); receiver.current!.accept({ kind: 'full', snapshot: reply.snapshot }, navigationToken);
      if (scope === errorScope.current) setFailure(current => command.type === 'configure_template' && reply.catalog?.errors.length
        ? { command, message: `项目已创建，部分推荐能力尚未配置，请在节点配置中查看并调整：${reply.catalog.errors.join('；')}` }
        : current?.command && JSON.stringify(current.command) === fingerprint ? null : current);
      return reply;
    }
    catch (caught) {
      if (navigationToken !== undefined) receiver.current!.cancelNavigation(navigationToken);
      if (scope === errorScope.current) setFailure({ command, message: command.type === 'configure_template' ? `项目已创建，推荐能力配置失败，可重试配置或在节点配置中调整：${messageOf(caught)}` : messageOf(caught) });
      return null;
    }
    finally { setPending(current => current.filter(entry => entry !== request)); }
  }
  useEffect(() => {
    if (!window.mixcat) { reportError('桌面连接未就绪。请通过 Mixcat 桌面程序打开此工作台。'); return; }
    try {
      const unsubscribe = window.mixcat.subscribe(update => receiver.current!.accept(update));
      void execute({ type: 'snapshot' });
      return unsubscribe;
    } catch (caught) { reportError(messageOf(caught)); }
  }, []);
  useEffect(() => {
    if (!projectMenu) return;
    projectMenuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const close = (event: PointerEvent) => { if (!projectMenuRef.current?.contains(event.target as HTMLElement)) setProjectMenu(null); };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setProjectMenu(null); projectMenuTrigger.current?.focus(); }
      else if (event.key === 'Tab') setProjectMenu(null);
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const buttons = [...(projectMenuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
        buttons[index]?.focus();
      }
    };
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', key); };
  }, [projectMenu]);
  function openProjectMenu(event: ReactMouseEvent<HTMLButtonElement> | ReactKeyboardEvent<HTMLButtonElement>, projectId: string) {
    event.preventDefault(); if (busy) return;
    const rect = event.currentTarget.getBoundingClientRect(); projectMenuTrigger.current = event.currentTarget;
    setProjectMenu({ projectId, x: 'clientX' in event && event.clientX ? event.clientX : rect.left + 12, y: 'clientY' in event && event.clientY ? event.clientY : rect.bottom });
  }
  const actionProject = snapshot?.projects.find(project => project.id === projectAction?.projectId);
  const projectActions = <>
    {projectMenu && <div className="canvas-context-menu project-context-menu" role="menu" aria-label="项目操作" ref={projectMenuRef} style={{ left: Math.max(8, Math.min(projectMenu.x, window.innerWidth - 190)), top: Math.max(32, Math.min(projectMenu.y, window.innerHeight - 100)) }}>
      <button role="menuitem" disabled={!!snapshot?.projects.find(project => project.id === projectMenu.projectId)?.unavailable} onClick={() => { setProjectAction({ projectId: projectMenu.projectId, type: 'rename' }); setProjectMenu(null); }}>重命名</button>
      <button role="menuitem" className="danger-button" onClick={() => { if (snapshot?.selected?.project.id === projectMenu.projectId && !confirmProjectNavigation()) return; setProjectAction({ projectId: projectMenu.projectId, type: 'delete' }); setProjectMenu(null); }}>删除项目</button>
    </div>}
    {projectAction && actionProject && <ProjectActionDialog key={`${projectAction.projectId}:${projectAction.type}`} project={actionProject} action={projectAction.type} execute={execute} busy={busy} error={error} onClose={() => { setProjectAction(null); projectMenuTrigger.current?.focus(); }} onDone={reply => { if (projectAction.type === 'delete' && !reply.snapshot.selected) setOpenProject(false); setProjectAction(null); }} />}
  </>;
  function goSection(section: 'notes' | 'knowledge' | 'settings') { if (confirmProjectNavigation()) { clearError(); setSection(section); } }
  const goProjects = () => { if (!confirmProjectNavigation()) return; clearError(); setSection('projects'); setOpenProject(false); setProjectsExpanded(expanded => section !== 'projects' || !expanded); };
  async function openProjectById(id: string) {
    if (!(openProject && snapshot?.selected?.project.id === id) && !confirmProjectNavigation()) return;
    setSection('projects'); setProjectsExpanded(true);
    if (openProject && snapshot?.selected?.project.id === id) return;
    const project = snapshot?.projects.find(project => project.id === id);
    const reply = await execute(project?.unavailable ? { type: 'create_project', root: project.root, name: project.name, goal: project.goal } : { type: 'snapshot', projectId: id });
    if (reply?.snapshot.selected) setOpenProject(true);
  }
  return <div className="app-shell"><div className="window-titlebar" aria-hidden="true">Mixcat</div><aside className="icon-rail" aria-label="Mixcat"><PixelCat /><span aria-hidden="true">⌕</span><span aria-hidden="true">◫</span><span aria-hidden="true">♧</span><button type="button" className={section === 'settings' ? 'icon-button rail-settings is-active' : 'icon-button rail-settings'} aria-label="设置" title="设置" aria-current={section === 'settings' ? 'page' : undefined} onClick={() => goSection('settings')}><span aria-hidden="true">⚙</span></button></aside><aside className="workspace-sidebar"><div className="brand"><strong>mixcat</strong></div><nav aria-label="工作空间"><button className={section === 'projects' ? 'active' : ''} aria-expanded={projectsExpanded} aria-controls="sidebar-project-list" onClick={goProjects}><Icon name="folder" />项目</button>
<ul id="sidebar-project-list" className="sidebar-project-list" aria-label="项目列表" hidden={!projectsExpanded}>{snapshot?.projects.map(project => {
  const active = section === 'projects' && openProject && snapshot.selected?.project.id === project.id;
  return <li key={project.id}><button type="button" className={active ? 'active' : ''} aria-current={active ? 'page' : undefined} title={project.root} disabled={busy} onClick={() => void openProjectById(project.id)} onContextMenu={event => openProjectMenu(event, project.id)} onKeyDown={event => { if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') openProjectMenu(event, project.id); }}><Icon name="nodes" size={14} /><span className="sidebar-project-name">{project.name}</span></button></li>;
})}</ul><button className={section === 'notes' ? 'active' : ''} onClick={() => goSection('notes')}><span aria-hidden="true">▤</span>笔记</button><button className={section === 'knowledge' ? 'active' : ''} onClick={() => goSection('knowledge')}><span aria-hidden="true">◫</span>知识库</button></nav></aside><div className="workspace-shell">{error && <div className="error-banner" role="alert"><span><strong>操作未完成</strong>{error}</span>{failure?.command?.type === 'configure_template' && section === 'projects' && openProject && failure.command.projectId === snapshot?.selected?.project.id && <button className="button secondary compact" disabled={busy} onClick={() => void execute(failure.command!)}>重试配置</button>}<button className="icon-button" aria-label="关闭错误提示" onClick={() => setFailure(null)}><Icon name="close" size={16} /></button></div>}<div className="app-content">{section === 'settings' ? <Settings account={snapshot?.account ?? null} execute={execute} busy={busy} /> : section !== 'projects' ? <main className="pending-page"><h1>{section === 'notes' ? '笔记' : '知识库'}</h1><p>待设计</p><p className="muted">这项功能尚未实现。</p></main> : snapshot ? openProject && snapshot.selected ? <ProjectWorkspace reviewActions={reviewActions.current} obscured={!!projectMenu || !!projectAction} key={snapshot.selected.project.id} snapshot={snapshot.selected} runtime={snapshot.runtime} execute={execute} busy={busy} pendingExecution={pendingExecution} error={error} onError={message => reportError(message, renderedScope)} /> : <Projects projects={snapshot.projects} busy={busy} onCreate={() => setCreateOpen(true)} onOpen={openProjectById} /> : <main className="loading-state"><span className="loading-mark" /><h1>{error ? '工作台暂不可用' : '正在打开工作空间'}</h1><p>{error ? '修复连接后，可以重新加载项目。' : '读取本地项目与会话状态…'}</p>{error && <button className="button secondary" disabled={busy || !window.mixcat} onClick={() => execute({ type: 'snapshot' })}>重新加载</button>}</main>}</div></div>{createOpen && <CreateProject execute={execute} busy={busy} error={error} onError={message => reportError(message, renderedScope)} onClose={() => setCreateOpen(false)} onCreated={() => { setCreateOpen(false); setOpenProject(true); setProjectsExpanded(true); }} />}{projectActions}</div>;
}
