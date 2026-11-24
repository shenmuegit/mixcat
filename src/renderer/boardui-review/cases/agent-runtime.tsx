import { useEffect, useRef, useState } from 'react';
import type { ReviewCase, ReviewContext } from '../main.js';

const actions = {
  send: { label: '发送消息', receipt: '已收到样例消息' },
  approve: { label: '批准样例请求', description: '读取样例会话', receipt: '已批准样例权限' },
  attach: { label: '选择样例附件', description: '评审清单.md', receipt: '已附加评审清单.md' },
  schedule: { label: '提交样例排期', description: '2026-11-25 09:00', receipt: '已登记 2026-11-25 09:00' },
  generate: { label: '生成样例图像', description: '桌面评审封面', receipt: '已返回桌面评审封面' },
};
const extraActions = ['approve', 'attach', 'schedule', 'generate'] as const;
type Action = keyof typeof actions;
type Outcome = 'success' | 'error';
interface Receipt {
  action: Action;
  outcome: Outcome;
}
const storageKey = 'boardui-review.074.receipts';
const exampleMessage = '整理这次设计评审的验收记录。';

function readReceipts(): Receipt[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
    return Array.isArray(saved) ? saved.filter((receipt): receipt is Receipt =>
      receipt && Object.hasOwn(actions, receipt.action)
      && (receipt.outcome === 'success' || receipt.outcome === 'error')) : [];
  } catch {
    return [];
  }
}

function AgentRuntimeReplay({ context }: { context: ReviewContext }) {
  const [receipts, setReceipts] = useState(readReceipts);
  const [outcome, setOutcome] = useState<Outcome>('success');
  const [message, setMessage] = useState(exampleMessage);
  const [pending, setPending] = useState<Action>();
  const [notice, setNotice] = useState('');
  const timer = useRef<number>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  function replay(action: Action) {
    if (timer.current !== undefined) return;
    setPending(action);
    setNotice('');
    const complete = () => {
      const next: Receipt[] = [...receipts, { action, outcome }];
      setReceipts(next);
      setPending(undefined);
      timer.current = undefined;
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
        setNotice(outcome === 'success' ? '回放完成' : '回放失败');
      } catch {
        setNotice('已回放，未能保存样例记录');
      }
    };
    if (context.reducedMotion) complete();
    else timer.current = window.setTimeout(complete, 320);
  }

  function reopen() {
    setReceipts(readReceipts());
    setMessage(exampleMessage);
    setOutcome('success');
    setNotice('已重开样例');
  }

  function reset() {
    try {
      localStorage.removeItem(storageKey);
      reopen();
      setNotice('已重置样例');
    } catch {
      setNotice('未能重置样例');
    }
  }

  return (
    <>
      <p className="case-description">在固定数据上回放请求。回执保存在评审窗口的本地样例中。</p>
      <div className="runtime-grid">
        <section className="runtime-panel">
          <div className="runtime-heading">
            <h3>运行请求</h3>
            <label className="replay-choice">
              回放结果
              <select id="replay-mode" value={outcome} disabled={!!pending}
                onChange={event => setOutcome(event.currentTarget.value === 'error' ? 'error' : 'success')}>
                <option value="success">成功</option>
                <option value="error">失败</option>
              </select>
            </label>
          </div>
          <form className="runtime-composer" onSubmit={event => {
            event.preventDefault();
            if (message.trim()) replay('send');
          }}>
            <label htmlFor="runtime-message">样例消息</label>
            <div>
              <input id="runtime-message" value={message} onChange={event => setMessage(event.currentTarget.value)} />
              <button className="primary-action" disabled={!!pending || !message.trim()}>{actions.send.label}</button>
            </div>
          </form>
          <ul className="runtime-actions">
            {extraActions.map(action => (
              <li key={action}>
                <button type="button" disabled={!!pending} onClick={() => replay(action)}>{actions[action].label}</button>
                <span>{actions[action].description}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="runtime-panel">
          <div className="runtime-heading"><h3>事件回执</h3><span className="review-muted">{receipts.length} 条</span></div>
          <div className="runtime-status" role="status">
            {pending ? actions[pending].label + '回放中…' : (notice || '等候样例请求')}
          </div>
          <ol id="review-receipts" className="runtime-receipts">
            {receipts.map(({ action, outcome }, index) => (
              <li key={index} data-outcome={outcome}>
                <code>R-{String(index + 1).padStart(2, '0')}</code>
                <div><strong>{actions[action].label}</strong>
                  <span>{outcome === 'success' ? actions[action].receipt : '样例请求失败 · 固定错误回执'}</span>
                </div>
              </li>
            ))}
          </ol>
          {receipts.length === 0 && <p className="empty-receipts">回执将在运行请求后显示。</p>}
        </section>
      </div>
      <div className="runtime-footer">
        <button type="button" disabled={!!pending} onClick={reopen}>重开样例</button>
        <button type="button" disabled={!!pending} onClick={reset}>重置样例</button>
      </div>
    </>
  );
}

export const agentRuntime: ReviewCase = {
  entryId: 74,
  caseId: 'runtime-replay',
  title: '本地运行回放',
  render: context => <AgentRuntimeReplay context={context} />,
};
