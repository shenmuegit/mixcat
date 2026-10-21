import { Workbench } from './Workbench';
export { toWorkflowEdges } from './Workbench';
export { NodeConfig } from './NodeSettings';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { AppCommand, AppReply, AppSnapshot, JsonObject, ProjectSummary } from '../shared/types';

const STATUS: Record<string, string> = { idle: '待开始', running: '运行中', pausing: '暂停中', paused: '已暂停', blocked: '需处理', completed: '已完成', queued: '等待中', waiting_source: '等待源任务', failed: '失败', needs_reconciliation: '状态待核对', released: '已交接', delivered: '已投递', pending: '待交接', cancelled: '已取消' };
const ACTIVITY_NAMES: Record<string, string> = { user: '指令', assistant: 'Agent', agent_message: 'Agent', reasoning: '思考', tool: '工具调用', handoff: '任务交接', error: '运行错误', task_started: '任务开始', task_completed: '任务完成', task_failed: '任务失败', thread_started: '会话建立', runtime: '运行环境', info: '工作流', connected: '已连接', login: '账号登录', control: '运行控制', run: '本轮任务', completed: '成果确认', definition: '节点配置', recovery: '状态恢复', limit: '执行上限', activity: '执行记录' };
type Execute = (command: AppCommand) => Promise<AppReply | null>;

export function activityLabel(kind: string) { return kind.startsWith('message:') ? 'Agent' : ACTIVITY_NAMES[kind] ?? '工作流记录'; }

export function parseResultSchema(value: string): JsonObject {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error('结果 Schema 不是有效的 JSON，请检查引号、逗号和括号。'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('结果 Schema 必须是一个 JSON 对象。');
  return parsed as JsonObject;
}

function messageOf(error: unknown) { return error instanceof Error ? error.message : String(error); }
function dateLabel(value: string, timeOnly = false) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return timeOnly ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}
function Status({ status }: { status: string }) { return <span className={`status status-${status}`}><span className="status-dot" />{STATUS[status] ?? status}</span>; }
function Icon({ name, size = 18 }: { name: 'plus' | 'arrow' | 'back' | 'close' | 'folder' | 'play' | 'nodes' | 'check'; size?: number }) {
  const paths = { plus: 'M12 5v14M5 12h14', arrow: 'M5 12h14m-6-6 6 6-6 6', back: 'M19 12H5m6-6-6 6 6 6', close: 'm6 6 12 12M18 6 6 18', folder: 'M3 6h7l2 3h9v11H3V6Z', play: 'm8 5 11 7-11 7V5Z', nodes: 'M3 4h6v6H3zM15 14h6v6h-6zM6 10v7h9M9 7h9v7', check: 'm5 12 4 4L19 6' };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
function Logo() { return <div className="brand"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span><strong>mixcat</strong><span className="edition">本地工作台</span></div>; }
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
  const [choosing, setChoosing] = useState(false);
  async function chooseDirectory() {
    setChoosing(true);
    try { const path = await window.mixcat.chooseDirectory(); if (path) setRoot(path); }
    catch (error) { onError(messageOf(error)); }
    finally { setChoosing(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (await execute({ type: 'create_project', name: name.trim(), root: root.trim(), goal: goal.trim() })) onCreated();
  }
  return <Modal title="新建项目" onClose={onClose}><form onSubmit={submit} className="form-stack">{error && <div className="inline-error" role="alert">{error}</div>}<p className="muted">为一个具体目标建立工作流。每个节点都有自己的模型、会话历史和可选能力。</p><label>项目名称<input autoFocus required maxLength={120} value={name} onChange={event => setName(event.target.value)} placeholder="例如：产品文档更新" /></label><label>项目目录<div className="input-with-button"><input required value={root} onChange={event => setRoot(event.target.value)} placeholder="选择已有的非 C 盘项目目录" /><button type="button" className="button secondary" onClick={chooseDirectory} disabled={choosing}>{choosing ? '选择中…' : '浏览'}</button></div><span className="field-note">会话数据、日志和结果保存在这个项目目录内。</span></label><label>项目目标<textarea required rows={4} value={goal} onChange={event => setGoal(event.target.value)} placeholder="描述需要完成的工作，以及完成的判断标准。" /></label><div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>取消</button><button className="button primary" disabled={busy || !name.trim() || !root.trim() || !goal.trim()}>{busy ? '创建中…' : '创建项目'}<Icon name="arrow" size={16} /></button></div></form></Modal>;
}

function ProjectCard({ project, onOpen, disabled }: { project: ProjectSummary; onOpen: () => void; disabled: boolean }) {
  return <button className="project-card" type="button" onClick={onOpen} disabled={disabled}><div className="project-card-top"><span className="project-icon"><Icon name="folder" size={22} /></span><Status status={project.status} /></div><h2>{project.name}</h2><p className="project-goal">{project.goal}</p><div className="project-path" title={project.root}>{project.root}</div><div className="project-card-bottom"><span>{project.mode === 'codex' ? 'Codex 原生' : '确定性演练'}<span className="separator">·</span>{dateLabel(project.updatedAt)}</span><Icon name="arrow" size={17} /></div></button>;
}

function Projects({ projects, busy, onCreate, onDemo, onOpen }: { projects: ProjectSummary[]; busy: boolean; onCreate: () => void; onDemo: () => void; onOpen: (id: string) => void }) {
  return <main className="projects-page"><div className="page-heading"><div><div className="eyebrow">WORKSPACE</div><h1>我的项目<span className="heading-count">{projects.length.toString().padStart(2, '0')}</span></h1><p>让独立会话协作，把目标推进到结果。</p></div><button className="button primary" onClick={onCreate} disabled={busy}><Icon name="plus" size={17} />新建项目</button></div>{projects.length ? <><div className="section-line"><span>全部项目</span><button className="text-button" disabled={busy} onClick={onDemo}>创建演练项目<Icon name="plus" size={14} /></button></div><div className="project-grid">{projects.map(project => <ProjectCard key={project.id} project={project} onOpen={() => onOpen(project.id)} disabled={busy} />)}</div></> : <section className="empty-workspace"><div className="empty-illustration" aria-hidden="true"><div className="mini-node">01<div /></div><span /><div className="mini-node middle">02<div /></div><span /><div className="mini-node">03<div /></div></div><div className="eyebrow">从一个目标开始</div><h2>给每一步工作，一个专注的会话。</h2><p>创建项目，定义节点职责。Agent 通过 MCP 选择下一位协作者，<br />交接任务、提交结果，也能把修改意见送回上一节点。</p><div className="empty-actions"><button className="button primary" onClick={onCreate} disabled={busy}><Icon name="plus" size={16} />创建第一个项目</button><button className="button secondary" onClick={onDemo} disabled={busy}>{busy ? '准备中…' : '先体验演练'}</button></div><div className="empty-note">演练无需登录，使用确定性任务展示交接流程，不调用模型。</div></section>}<footer className="workspace-footer"><span className="local-indicator" />项目数据保存在本地<span className="footer-right">独立会话 · 自由输入 · 按需协作</span></footer></main>;
}

export default function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const [openProject, setOpenProject] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const busy = pending > 0;
  async function execute(command: AppCommand) {
    setPending(value => value + 1);
    setError(null);
    try { const reply = await window.mixcat.command(command); setSnapshot(reply.snapshot); return reply; }
    catch (caught) { setError(messageOf(caught)); return null; }
    finally { setPending(value => value - 1); }
  }
  useEffect(() => {
    if (!window.mixcat) { setError('桌面连接未就绪。请通过 Mixcat 桌面程序打开此工作台。'); return; }
    try {
      const unsubscribe = window.mixcat.subscribe(setSnapshot);
      void execute({ type: 'snapshot' });
      return unsubscribe;
    } catch (caught) { setError(messageOf(caught)); }
  }, []);
  async function demo() { if (await execute({ type: 'create_demo' })) setOpenProject(true); }
  return <div className="app-shell"><header className="app-header"><Logo /><div className="app-header-right"><span className="local-indicator" />本地工作空间<span className="app-version">MVP / 0.1</span></div></header>{error && <div className="error-banner" role="alert"><span><strong>操作未完成</strong>{error}</span><button className="icon-button" aria-label="关闭错误提示" onClick={() => setError(null)}><Icon name="close" size={16} /></button></div>}{snapshot ? openProject && snapshot.selected ? <Workbench key={snapshot.selected.project.id} snapshot={snapshot.selected} runtime={snapshot.runtime} execute={execute} busy={busy} error={error} onBack={() => setOpenProject(false)} onError={setError} /> : <Projects projects={snapshot.projects} busy={busy} onCreate={() => setCreateOpen(true)} onDemo={demo} onOpen={async id => { if (await execute({ type: 'snapshot', projectId: id })) setOpenProject(true); }} /> : <main className="loading-state"><span className="loading-mark" /><h1>{error ? '工作台暂不可用' : '正在打开工作空间'}</h1><p>{error ? '修复连接后，可以重新加载项目。' : '读取本地项目与会话状态…'}</p>{error && <button className="button secondary" disabled={busy || !window.mixcat} onClick={() => execute({ type: 'snapshot' })}>重新加载</button>}</main>}{createOpen && <CreateProject execute={execute} busy={busy} error={error} onError={setError} onClose={() => setCreateOpen(false)} onCreated={() => { setCreateOpen(false); setOpenProject(true); }} />}</div>;
}
