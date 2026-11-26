import { useEffect, useId, useRef, useState, type ComponentProps } from 'react';
import type { AppCommand } from '../shared/types';
import type { TemplateCapabilityId, TemplateCapabilityItem, TemplateSetupDecision, TemplateSetupProgress, TemplateSetupReport } from '../shared/template-setup';
import { Dialog } from './Dialog';
import { Icon } from './Icon';
import type { Execute } from './execute-command';

const labels = { missing: '待安装', existing: '已有相关能力', installing: '正在安装', installed: '已安装并确认', skipped: '已跳过', failed: '未完成', unknown: '结果待核实', needs_auth: '需要授权' };
const stateIcons: Partial<Record<TemplateCapabilityItem['state'], ComponentProps<typeof Icon>['name']>> = {
  installed: 'check', skipped: 'minus', failed: 'alert', unknown: 'alert', needs_auth: 'alert',
};

export function TemplateSetup({ projectId, projectRoot, autoReuseOnCreate = false, retryUnfinishedOnOpen = false, execute, progress, onClose }: {
  projectId: string;
  projectRoot: string;
  autoReuseOnCreate?: boolean;
  retryUnfinishedOnOpen?: boolean;
  execute: Execute;
  progress?: TemplateSetupProgress;
  onClose(): void;
}) {
  const [report, setReport] = useState<TemplateSetupReport | null>(null);
  const showSavedResult = useRef(retryUnfinishedOnOpen && progress?.status === 'partial' && progress.items.length > 0);
  const [phase, setPhase] = useState<'background' | 'checking' | 'choices' | 'installing' | 'results' | 'error'>(
    showSavedResult.current ? 'results' : autoReuseOnCreate ? 'background' : 'checking',
  );
  const [choices, setChoices] = useState<TemplateSetupDecision['choices']>({});
  const [readError, setReadError] = useState('');
  const [stepsExpanded, setStepsExpanded] = useState(true);
  const stepsId = useId();
  const alive = useRef(true);
  const retryUnfinished = useRef(retryUnfinishedOnOpen);
  function accept(next: TemplateSetupReport) {
    setReport(next); setChoices({});
    setPhase(next.needsChoices || next.blocked ? 'choices' : 'results');
  }
  async function prepare(command: Extract<AppCommand, { type: 'template_setup' }>) {
    setReadError('');
    try {
      const result = await execute(command, undefined, { handleFailure: 'caller' });
      if (!alive.current) return;
      if (result?.templateSetup) return result.templateSetup;
      setReadError('原生进程未返回准备结果。');
    } catch (caught) {
      if (!alive.current) return;
      setReadError(caught instanceof Error ? caught.message : String(caught));
    }
    setPhase('error');
  }
  async function install(plan: TemplateSetupReport, selected: TemplateSetupDecision['choices'], enterWhenPrepared = false) {
    setPhase(enterWhenPrepared ? 'background' : 'installing');
    const next = await prepare({ type: 'template_setup', projectId, phase: 'install', retryUnfinished: retryUnfinished.current, decision: { observation: plan.observation, choices: selected } });
    if (!next || !alive.current) return;
    if (enterWhenPrepared && !next.needsChoices && !next.blocked && next.status !== 'pending') onClose();
    else accept(next);
  }
  async function inspect(tryReuse = false, unfinishedOnly = retryUnfinished.current) {
    retryUnfinished.current = unfinishedOnly;
    setPhase(tryReuse ? 'background' : 'checking');
    const next = await prepare({ type: 'template_setup', projectId, phase: 'inspect', retryUnfinished: unfinishedOnly });
    if (!next || !alive.current) return;
    setReport(next); setChoices({});
    if (tryReuse && next.canReuseExisting) {
      const skip = Object.fromEntries(next.items.map(item => [item.id, 'skip'] as const));
      await install(next, skip, true);
    } else if (next.needsChoices || next.blocked) setPhase('choices');
    else await install(next, {});
  }
  useEffect(() => {
    alive.current = true;
    if (!showSavedResult.current) void inspect(autoReuseOnCreate, retryUnfinishedOnOpen);
    return () => { alive.current = false; };
  }, [projectId, autoReuseOnCreate, retryUnfinishedOnOpen]);
  if (phase === 'background') return null;
  const installing = phase === 'installing', waiting = installing || phase === 'checking';
  const items = (installing || phase === 'error') && progress?.items.length ? progress.items : report?.items ?? progress?.items ?? [];
  const satisfied = items.filter(item => item.state === 'installed');
  const remaining = items.filter(item => item.state !== 'installed');
  const processed = satisfied.length + items.filter(item => item.state === 'skipped').length;
  const status = report?.status ?? progress?.status;
  const canRetry = phase === 'results' && status === 'partial';
  const unfinished = remaining.filter(item => item.state !== 'skipped');
  const retryItem = canRetry && unfinished.length === 1 && unfinished[0].state === 'failed' ? unfinished[0].id : undefined;
  function origin(item: TemplateCapabilityItem) {
    return (['project', 'codex'] as const).filter(scope => item.existing.some(entry => entry.scope === scope)).map(scope => {
      const versions = [...new Set(item.existing.filter(entry => entry.scope === scope).flatMap(entry => entry.version ? [entry.version] : []))];
      return `${scope === 'project' ? '当前项目' : '本机 Codex'}已有${versions.length ? ` · ${versions.join('、')}` : ''}`;
    }).join('；');
  }
  function renderItem(item: TemplateCapabilityItem) {
    const stateIcon = stateIcons[item.state];
    return <li key={item.id} className="template-setup-item progress-step" data-state={item.state}>
      <div className="progress-step-icon" aria-hidden="true">{stateIcon ? <Icon name={stateIcon} size={16} /> : <span />}</div>
      <div className="template-step-copy">
        <div className="progress-step-heading"><strong>{item.name}</strong><span className="progress-step-status">{labels[item.state]}</span></div>
        <p className="field-note">{item.kind === 'plugin' ? '原生插件' : '独立技能'}</p>
        {item.existing.length > 0 && <p className="field-note">{origin(item)}</p>}
        {item.skills.length > 0 && <details><summary>模板需要 {item.skills.length} 项技能</summary><p className="field-note">{item.skills.join('、')}</p></details>}
        {phase === 'choices' && ['existing', 'unknown', 'needs_auth'].includes(item.state) && <label className="template-setup-choice">处理方式<select aria-label={`${item.name} 已有能力处理`} value={choices[item.id] ?? 'skip'} onChange={event => setChoices(current => ({ ...current, [item.id]: event.target.value as 'overwrite' | 'skip' }))}><option value="skip">跳过安装，保留已有能力</option><option value="overwrite">覆盖当前项目的同名能力</option></select></label>}
        {item.message && (item.message.length > 220 && ['failed', 'unknown'].includes(item.state) ? <details className="inline-warning"><summary>官方准备未完成，查看错误详情</summary><pre>{item.message}</pre></details> : <p className={['failed', 'unknown', 'needs_auth'].includes(item.state) ? 'inline-warning' : 'field-note'}>{item.message}</p>)}
        {item.id === retryItem && <button type="button" className="button secondary compact progress-step-retry" aria-label={`重试 ${item.name}`} onClick={() => void inspect(false, true)}>重试</button>}
      </div>
    </li>;
  }
  return <Dialog title="准备模板能力" onClose={onClose} className="template-setup-dialog" descriptionId="template-setup-description"><div className="form-stack template-setup">
    <p id="template-setup-description">已有能力默认跳过。选择覆盖时，仅在当前项目安装模板版本。</p>
    <p className="field-note template-setup-target">安装目标：{report?.target ?? projectRoot}</p>
    {items.length > 0 && <section className="template-progress" aria-label="模板能力准备">
      <div className="template-progress-label"><strong>准备进度</strong><span aria-live="polite">已处理 {processed}/{items.length}</span></div>
      <div className="template-progress-track" role="progressbar" aria-label="准备进度" aria-valuemin={0}
        aria-valuemax={items.length} aria-valuenow={processed} aria-valuetext={`已处理 ${processed}/${items.length}`}>
        <div style={{ width: `${processed / items.length * 100}%` }} />
      </div>
    </section>}
    {waiting && <p className="template-setup-status" role="status">{installing ? '正在准备所选能力，完成后会重新检查实际目录。可关闭窗口，稍后查看结果。' : '正在检查当前项目与本机 Codex 的已有能力…'}</p>}
    {report?.message && <p className="inline-warning" role="status">{report.message}</p>}
    {items.length > 0 && <section className="progress-steps">
      <div className="progress-steps-heading"><strong>准备步骤</strong>
        <button type="button" className="text-button" onClick={() => setStepsExpanded(value => !value)} aria-expanded={stepsExpanded} aria-controls={stepsId}>
          {stepsExpanded ? '收起步骤' : '展开步骤'}<Icon name="chevron" size={14} />
        </button>
      </div>
      <div id={stepsId} className="progress-steps-body" hidden={!stepsExpanded}>
        {remaining.length > 0 && <ul className="progress-step-list">{remaining.map(renderItem)}</ul>}
        {satisfied.length > 0 && <details className="workspace-disclosure template-satisfied">
          <summary><span>已满足（{satisfied.length}）</span><Icon name="chevron" size={14} /></summary>
          <ul className="progress-step-list">{satisfied.map(renderItem)}</ul>
        </details>}
      </div>
    </section>}
    {phase === 'results' && <div className="template-setup-results" role="status">
      <strong>{status === 'ready' ? '模板能力已就绪' : status === 'complete' ? '模板准备已完成' : '项目已创建，部分模板能力尚未就绪'}</strong>
      <p className="field-note">{status === 'complete' ? '已跳过的能力可通过项目菜单按需准备。' : '安装与实际能力目录已分别检查。插件 hooks 的信任和相关账号授权仍按官方流程处理。'}</p>
    </div>}
    {phase === 'error' && <p className="inline-warning" role="alert">准备操作尚未确认。{readError}</p>}
    <div className="modal-actions">
      {phase === 'choices' && !report?.blocked && <button className="button primary" onClick={() => { if (report) void install(report, Object.fromEntries(report.items.filter(item => ['existing', 'unknown', 'needs_auth'].includes(item.state)).map(item => [item.id, choices[item.id] ?? 'skip'])) as Partial<Record<TemplateCapabilityId, 'overwrite' | 'skip'>>); }}>准备所选能力</button>}
      {(phase === 'error' || phase === 'choices' && report?.blocked) && <button className="button primary" onClick={() => void inspect()}>重新检查</button>}
      {canRetry && (!retryItem || !stepsExpanded) && <button className="button secondary" onClick={() => void inspect(false, true)}>重试未完成项</button>}
      <button className={`button ${phase === 'results' ? 'primary' : 'secondary'}`} onClick={onClose}>{waiting ? '后台继续' : phase === 'results' ? '进入项目' : '暂不准备'}</button>
    </div>
  </div></Dialog>;
}
