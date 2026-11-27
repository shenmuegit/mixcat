import type { NativeInput, TaskView } from '../shared/types';

function messagePreview(task: TaskView) {
  const input = Array.isArray(task.input) ? task.input as NativeInput[] : [];
  const text = input.filter(item => item?.type === 'text' && !item.mixcatAttachment && typeof item.text === 'string');
  const body = text.map(item => item.text).join(' ').trim();
  const attachments = input.length - text.length;
  const materials = attachments ? `${attachments} 个附件` : '';
  return [body, materials].filter(Boolean).join(' · ') || task.instruction;
}

export function SessionMessageQueue({ messages, active, paused, busy, onSteer, onCheck, onRetry }: {
  messages: TaskView[];
  active?: TaskView;
  paused: boolean;
  busy: boolean;
  onSteer(task: TaskView, trigger: HTMLButtonElement): void;
  onCheck(task: TaskView, trigger: HTMLButtonElement): void;
  onRetry(task: TaskView): void;
}) {
  if (!messages.length) return null;
  return <ul className="session-queue" aria-label="排队消息">
    {messages.map(task => {
      const preview = messagePreview(task);
      const previewId = `waiting-${task.id}`;
      const uncertain = task.steering === 'unknown';
      const steering = task.steering === 'sending';
      const status = uncertain ? '引导结果待核对' : steering ? '等待原生确认' : task.error ? '引导未送达，仍在排队'
        : paused ? '等待节点启用' : active ? '等待当前回复结束' : '等待发送';
      return <li className="session-queue-row" key={task.id} data-queued-message={task.id}>
        <div className="session-queue-copy">
          <span id={previewId} className="session-queue-preview" title={preview}>{preview}</span>
          <small role="status" data-warning={uncertain || !!task.error || undefined} title={task.error ?? undefined}>{status}</small>
        </div>
        {(steering || task.canSteer && active?.turnId) && <button type="button" className="button secondary compact" disabled={steering || busy}
          title="交给当前轮次" aria-describedby={previewId} onClick={event => onSteer(task, event.currentTarget)}>{steering ? '引导中…' : '引导'}</button>}
        {uncertain && <div className="session-queue-actions">
          <button type="button" className="button secondary compact" disabled={busy} aria-describedby={previewId} onClick={event => onCheck(task, event.currentTarget)}>核对原生记录</button>
          {!active && <button type="button" className="text-button" disabled={busy} aria-describedby={previewId} onClick={() => onRetry(task)}>核对后重试</button>}
        </div>}
      </li>;
    })}
  </ul>;
}
