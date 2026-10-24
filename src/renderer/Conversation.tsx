import { useEffect, useRef } from 'react';
import type { ConversationEntry, MessageSummary, NodeView, TaskView } from '../shared/types';
import { orderedConversation } from '../shared/conversation-order';
export { orderedConversation } from '../shared/conversation-order';
export function entryResources(entry: ConversationEntry, projectRoot?: string): { label: string; path?: string; url?: string }[] {
  const result: { label: string; path?: string; url?: string }[] = [];
  const add = (label: string, value: unknown) => {
    if (typeof value !== 'string' || !value) return;
    if (/^https?:\/\//i.test(value)) result.push({ label, url: value });
    else if (/^(?:[a-z]:[\\/]|\/)/i.test(value)) result.push({ label, path: value });
  };
  const content: any = entry.direction === 'input' && entry.messageId ? null : entry.content;
  if (projectRoot) for (const attachment of entry.attachments ?? []) add(`打开附件：${attachment.name}`, `${projectRoot.replace(/[\\/]+$/, '')}/${attachment.relativePath}`);
  const items = Array.isArray(content) ? content : Array.isArray(content?.input) ? content.input : [content];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    if (item.mixcatAttachment) add(`打开附件：${item.mixcatAttachment.name}`, item.mixcatAttachment.path);
    add('查看图片', item.savedPath);
    if (['imageView', 'localImage', 'localAudio', 'mention'].includes(item.type)) add('打开附件', item.path);
    if (['image', 'audio', 'resource_link'].includes(item.type)) add(typeof item.name === 'string' ? item.name : '打开资源', item.url ?? item.uri);
    for (const change of Array.isArray(item.changes) ? item.changes : []) add('查看文件', change?.path);
    for (const block of Array.isArray(item.result?.content) ? item.result.content : []) {
      if (block?.type === 'resource_link') add(typeof block.name === 'string' ? block.name : '打开资源', block.uri);
    }
  }
  return result.filter((resource, index) => result.findIndex(other => other.path === resource.path && other.url === resource.url) === index);
}

const deliveryLabels: Record<string, string> = { queued: '排队中', running: '运行中', paused: '已暂停', waiting_source: '等待来源完成', waiting_review: '等待人工核对', completed: '已完成', failed: '失败', cancelled: '已取消', needs_reconciliation: '状态待核对' };
export function ConversationFeed({ entries, nodes, tasks = [], messages = [], projectRoot, locatedEntryId, locationRequest, projectTimeline = false, onOpen, onRetry, onLocateMessage }: { entries: ConversationEntry[]; nodes: NodeView[]; tasks?: TaskView[]; messages?: MessageSummary[]; projectRoot?: string; locatedEntryId?: string; locationRequest?: object; projectTimeline?: boolean; onOpen: (nodeId: string, resource: { path?: string; url?: string }) => void; onRetry?: (task: TaskView) => void; onLocateMessage?: (messageId: string) => void }) {
  const ordered = orderedConversation(entries);
  const feed = useRef<HTMLDivElement>(null);
  const focusedRequest = useRef<object | null>(null);
  useEffect(() => {
    if (!locationRequest || focusedRequest.current === locationRequest) return;
    const entry = [...(feed.current?.querySelectorAll<HTMLElement>('[data-entry-id]') ?? [])].find(element => element.dataset.entryId === locatedEntryId);
    if (entry) { focusedRequest.current = locationRequest; entry.scrollIntoView({ block: 'center' }); entry.focus({ preventScroll: true }); }
  }, [locationRequest, locatedEntryId, entries]);
  return <div ref={feed} className={`conversation-feed chat-history ${projectTimeline ? 'project-timeline' : ''}`} aria-label={projectTimeline ? '项目会话历史' : '节点聊天记录'}>
    {!ordered.length && <div className="panel-empty"><h3>开始这个会话</h3><p>发送文字或附件，输入与回复会保存在该节点的历史中。</p></div>}
    {ordered.map(entry => {
      const node = nodes.find(n => n.id === entry.nodeId);
      const message = messages.find(message => message.message_id === entry.messageId);
      const source = entry.source?.kind === 'node' ? entry.source.name ?? nodes.find(n => n.id === entry.source?.nodeId)?.name ?? '其他节点' : entry.source?.kind === 'user' ? '用户' : entry.source?.kind === 'system' ? '系统续接' : '原生输入（来源未知）';
      const author = entry.source?.name ?? (entry.source?.kind === 'unknown' ? '来源未知' : node?.name ?? entry.nodeId);
      const label = message ? `${message.fromName} → ${message.toName}` : entry.direction === 'input' ? `${source} → ${node?.name ?? entry.nodeId}` : projectTimeline && author !== node?.name ? `${node?.name ?? entry.nodeId} · ${author}` : author;
      const delivery = message && tasks.find(task => task.id === (entry.direction === 'input' ? entry.taskId : message.target_task_id));
      const resources = entryResources(entry, projectRoot);
      const hasTime = Number.isFinite(Date.parse(entry.createdAt));
      return <article className={`chat-entry chat-${entry.direction}${locatedEntryId === entry.id ? ' is-located' : ''}`} key={entry.id} tabIndex={-1} data-entry-id={entry.id} data-node-id={entry.nodeId} data-message-id={entry.messageId}>
        <div className="feed-meta"><strong>{label}{entry.direction === 'event' ? ' · 执行记录' : ''}</strong><time dateTime={hasTime ? entry.createdAt : undefined}>{hasTime ? new Date(entry.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '原生历史未提供时间'}</time></div>
        <div className="chat-bubble">{entry.text && <p>{entry.text}</p>}
          {entry.sentMessage && <div className="sent-message-body"><strong>发送正文</strong><p>{typeof entry.sentMessage.content === 'string' ? entry.sentMessage.content : JSON.stringify(entry.sentMessage.content, null, 2)}</p></div>}
          {message && <p className="message-delivery">协作消息 · {delivery ? `投递 · ${deliveryLabels[delivery.status] ?? delivery.status}` : '投递任务记录缺失'}</p>}
          {entry.replyTo && <div className="reply-reference">{onLocateMessage ? <button className="text-button" data-reply-to={entry.replyTo} onClick={() => onLocateMessage(entry.replyTo!)}>查看原消息</button> : <span>回复消息：{entry.replyTo}</span>}</div>}
          {resources.length > 0 && <div className="resource-actions">{resources.map((resource, i) => <button key={i} className="text-button" onClick={() => onOpen(entry.nodeId, resource)}>{resource.label}</button>)}</div>}
          {!entry.text && !resources.length && <p>{entry.direction === 'input' ? '已发送内容' : '原生会话记录'}</p>}
          {entry.direction === 'event' && <details><summary>原始记录{entry.status ? ` · ${entry.status}` : ''}</summary><pre className="result-json">{JSON.stringify(entry.content, null, 2)}</pre></details>}
        </div>
      </article>;
    })}
    {tasks.filter(task => (task.status === 'failed' || task.status === 'needs_reconciliation') && entries.some(entry => entry.taskId === task.id)).map(task => <div className="inline-warning" key={task.id}><strong>{nodes.find(n => n.id === task.nodeId)?.name} · {task.status === 'needs_reconciliation' ? '状态待核对' : '执行未完成'}</strong><p>{task.error}</p>{onRetry && <button className="text-button" onClick={() => onRetry(task)}>核对后重试</button>}</div>)}
  </div>;
}
