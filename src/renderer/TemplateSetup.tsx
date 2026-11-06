import { useEffect, useRef, useState } from 'react';
import type { AppCommand, AppReply } from '../shared/types';
import type { TemplateCapabilityId, TemplateCapabilityItem, TemplateSetupDecision, TemplateSetupProgress, TemplateSetupReport } from '../shared/template-setup';
import { Dialog } from './Dialog';

const labels = { missing: '待安装', existing: '已有相关能力', installing: '正在安装', installed: '已安装并确认', skipped: '已跳过', failed: '未完成', unknown: '结果待核实', needs_auth: '需要授权' };
type Execute = (command: AppCommand) => Promise<AppReply | null>;

export function TemplateSetup({ projectId, execute, progress, onClose }: { projectId: string; execute: Execute; progress?: TemplateSetupProgress; onClose(): void }) {
  const [report, setReport] = useState<TemplateSetupReport | null>(null);
  const [phase, setPhase] = useState<'checking' | 'choices' | 'installing' | 'results' | 'error'>('checking');
  const [choices, setChoices] = useState<TemplateSetupDecision['choices']>({});
  const alive = useRef(true);
  function accept(next: TemplateSetupReport) {
    setReport(next); setChoices({});
    setPhase(next.needsChoices || next.blocked ? 'choices' : 'results');
  }
  async function install(plan: TemplateSetupReport, selected: TemplateSetupDecision['choices']) {
    setPhase('installing');
    const reply = await execute({ type: 'template_setup', projectId, phase: 'install', decision: { observation: plan.observation, choices: selected } });
    if (!alive.current) return;
    if (reply?.templateSetup) accept(reply.templateSetup); else setPhase('error');
  }
  async function inspect() {
    setPhase('checking');
    const reply = await execute({ type: 'template_setup', projectId, phase: 'inspect' });
    if (!alive.current) return;
    const next = reply?.templateSetup;
    if (!next) { setPhase('error'); return; }
    setReport(next); setChoices({});
    if (next.needsChoices || next.blocked) setPhase('choices');
    else await install(next, {});
  }
  useEffect(() => { alive.current = true; void inspect(); return () => { alive.current = false; }; }, [projectId]);
  const installing = phase === 'installing', waiting = installing || phase === 'checking';
  const items = installing && progress?.items.length ? progress.items : report?.items ?? [];
  function origin(item: TemplateCapabilityItem) {
    return (['project', 'codex'] as const).filter(scope => item.existing.some(entry => entry.scope === scope)).map(scope => {
      const versions = [...new Set(item.existing.filter(entry => entry.scope === scope).flatMap(entry => entry.version ? [entry.version] : []))];
      return `${scope === 'project' ? '当前项目' : '本机 Codex'}已有${versions.length ? ` · ${versions.join('、')}` : ''}`;
    }).join('；');
  }
  return <Dialog title="准备模板能力" onClose={onClose} wide descriptionId="template-setup-description"><div className="form-stack template-setup">
    <p id="template-setup-description">只准备所选模板需要的插件和技能。已有能力默认跳过；选择覆盖后，在当前项目安装模板版本，不修改其他 Codex 环境。</p>
    {report && <p className="field-note template-setup-target">安装目标：{report.target}</p>}
    {waiting && <p className="template-setup-status" role="status" aria-live="polite">{installing ? '正在通过官方流程准备所选能力，完成后会重新检查实际目录。可关闭此窗口，稍后在项目中查看结果。' : '正在检查当前项目与本机 Codex 的已有能力…'}</p>}
    {report?.message && <p className="inline-warning" role="status">{report.message}</p>}
    <ul className="template-setup-list">{items.map(item => <li key={item.id} className="template-setup-item" data-state={item.state}>
      <div className="template-setup-item-heading"><strong>{item.name}</strong><span className="field-note">{item.kind === 'plugin' ? '原生插件' : '独立技能'} · {labels[item.state]}</span></div>
      {item.existing.length > 0 && <p className="field-note">{origin(item)}</p>}
      {item.skills.length > 0 && <details><summary>模板需要 {item.skills.length} 项技能</summary><p className="field-note">{item.skills.join('、')}</p></details>}
      {phase === 'choices' && ['existing', 'unknown'].includes(item.state) && <label className="template-setup-choice">处理方式<select aria-label={`${item.name} 已有能力处理`} value={choices[item.id] ?? 'skip'} onChange={event => setChoices(current => ({ ...current, [item.id]: event.target.value as 'overwrite' | 'skip' }))}><option value="skip">跳过安装，保留已有能力</option><option value="overwrite">覆盖当前项目的同名能力</option></select></label>}
      {item.message && (item.message.length > 220 && ['failed', 'unknown'].includes(item.state) ? <details className="inline-warning"><summary>官方准备未完成，查看错误详情</summary><pre>{item.message}</pre></details> : <p className={['failed', 'unknown', 'needs_auth'].includes(item.state) ? 'inline-warning' : 'field-note'}>{item.message}</p>)}
    </li>)}</ul>
    {phase === 'results' && <div className="template-setup-results" role="status"><strong>{report?.status === 'ready' ? '模板能力已就绪' : '项目已创建，部分模板能力尚未就绪'}</strong><p className="field-note">安装与实际能力目录已分别检查。插件 hooks 的信任和相关账号授权仍按官方流程处理。</p></div>}
    {phase === 'error' && <p className="inline-warning" role="alert">准备操作尚未确认。项目已保留，请重新检查实际能力后再继续。</p>}
    <div className="modal-actions">
      {phase === 'choices' && !report?.blocked && <button className="button primary" onClick={() => { if (report) void install(report, Object.fromEntries(report.items.filter(item => ['existing', 'unknown'].includes(item.state)).map(item => [item.id, choices[item.id] ?? 'skip'])) as Partial<Record<TemplateCapabilityId, 'overwrite' | 'skip'>>); }}>准备所选能力</button>}
      {(phase === 'error' || phase === 'choices' && report?.blocked) && <button className="button primary" onClick={() => void inspect()}>重新检查</button>}
      {phase === 'results' && report?.status !== 'ready' && <button className="button secondary" onClick={() => void inspect()}>重试未完成项</button>}
      <button className={`button ${phase === 'results' ? 'primary' : 'secondary'}`} onClick={onClose}>{waiting ? '后台继续' : phase === 'results' ? '进入项目' : '暂不准备'}</button>
    </div>
  </div></Dialog>;
}
