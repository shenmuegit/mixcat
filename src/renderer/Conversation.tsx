import { useEffect, useLayoutEffect, useRef } from 'react';
import type { ConversationEntry, MessageSummary, NodeView, TaskView } from '../shared/types';
import { orderedConversation } from '../shared/conversation-order';
import { ProjectMarkdown } from './ProjectMarkdown';
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
export function ConversationFeed({ entries, nodes, tasks = [], messages = [], projectRoot, locatedEntryId, locationRequest, latestRequest, projectTimeline = false, onOpen, onRetry, onLocateMessage }: { entries: ConversationEntry[]; nodes: NodeView[]; tasks?: TaskView[]; messages?: MessageSummary[]; projectRoot?: string; locatedEntryId?: string; locationRequest?: object; latestRequest?: object; projectTimeline?: boolean; onOpen: (nodeId: string, resource: { path?: string; url?: string }) => void; onRetry?: (task: TaskView) => void; onLocateMessage?: (messageId: string) => void }) {
  const ordered = orderedConversation(entries.filter(entry => entry.direction !== 'event' || !['executionProvenance', 'sessionConfiguration'].includes((entry.rawItem as any)?.type ?? (entry.content as any)?.type)));
  const feed = useRef<HTMLDivElement>(null);
  const focusedRequest = useRef<object | null>(null);
  const consumedLatestRequest = useRef<object | null>(null);
  const followingLatest = useRef(false);
  useLayoutEffect(() => {
    followingLatest.current = false;
    const content = feed.current, viewport = content?.closest<HTMLElement>('.session-scroll');
    if (!latestRequest || consumedLatestRequest.current === latestRequest || !content || !viewport) return;
    consumedLatestRequest.current = latestRequest;
    followingLatest.current = true;
    // A node click supersedes older message-location requests, including ones still loading.
    focusedRequest.current = locationRequest ?? null;
    const scrollLatest = () => { if (followingLatest.current && content.getClientRects().length) viewport.scrollTop = viewport.scrollHeight; };
    const stopFollowing = () => { if (content.getClientRects().length && viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop > 8) followingLatest.current = false; };
    scrollLatest();
    const observer = new ResizeObserver(scrollLatest);
    observer.observe(content); observer.observe(viewport);
    viewport.addEventListener('scroll', stopFollowing, { passive: true });
    return () => { observer.disconnect(); viewport.removeEventListener('scroll', stopFollowing); };
  }, [latestRequest]);
  useEffect(() => {
    if (!locationRequest || focusedRequest.current === locationRequest) return;
    const entry = [...(feed.current?.querySelectorAll<HTMLElement>('[data-entry-id]') ?? [])].find(element => element.dataset.entryId === locatedEntryId);
    if (entry) { followingLatest.current = false; focusedRequest.current = locationRequest; entry.scrollIntoView({ block: 'center' }); entry.focus({ preventScroll: true }); }
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
      const item: any = entry.rawItem ?? entry.content, type = entry.direction === 'input' ? undefined : item?.type;
      const thinking = type === 'reasoning';
      const parts: string[] = thinking ? [item.summary, item.content].find(value => Array.isArray(value) && value.some(part => typeof part === 'string' && part))?.filter((part: unknown) => typeof part === 'string' && part) ?? (entry.text ? [entry.text] : []) : [];
      const task = tasks.find(task => task.id === entry.taskId);
      const active = !entry.completedAt && ['inProgress', 'running', 'started'].includes(entry.status ?? '') && (!task || task.status === 'running');
      if ((type === 'agentMessage' && !entry.text && !resources.length) || (thinking && !parts.length && !active)) return null;
      const toolName = type === 'commandExecution' ? item.command : type === 'mcpToolCall' ? `${item.server} / ${item.tool}` : type === 'dynamicToolCall' ? item.tool : type === 'fileChange' ? '文件修改' : type === 'plan' ? '计划' : type;
      return <article className={`chat-entry chat-${entry.direction}${thinking ? ' chat-reasoning' : ''}${locatedEntryId === entry.id ? ' is-located' : ''}`} key={entry.id} tabIndex={-1} data-entry-id={entry.id} data-node-id={entry.nodeId} data-message-id={entry.messageId} data-native-type={type} data-native-phase={type === 'agentMessage' ? item.phase : undefined}>
        <div className="feed-meta"><strong>{label}</strong><time dateTime={hasTime ? entry.createdAt : undefined}>{hasTime ? new Date(entry.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '原生历史未提供时间'}</time></div>
        <div className="chat-bubble">
          {thinking ? <details className="native-reasoning" open={active}><summary>{active ? '正在思考' : '思考'}</summary>{parts.map((text, index) => <ProjectMarkdown key={index} text={text} historical />)}</details>
            : type === 'plan' && typeof item.text === 'string' ? <ProjectMarkdown text={item.text} historical />
              : entry.direction === 'event' ? <details className="native-tool"><summary>{toolName ?? '活动'}{entry.status && <span className="native-status">{entry.status}</span>}</summary>{entry.text && <pre className="native-output">{entry.text}</pre>}<details><summary>原始记录</summary><pre className="result-json">{JSON.stringify(entry.rawItem ?? entry.content, null, 2)}</pre></details></details>
              : entry.text && (entry.direction === 'output' || entry.text.includes('mixcat://') ? <ProjectMarkdown text={entry.text} historical /> : <p>{entry.text}</p>)}
          {entry.sentMessage && <div className="sent-message-body"><strong>发送正文</strong>{typeof entry.sentMessage.content === 'string' && entry.sentMessage.content.includes('mixcat://') ? <ProjectMarkdown text={entry.sentMessage.content} historical /> : <p>{typeof entry.sentMessage.content === 'string' ? entry.sentMessage.content : JSON.stringify(entry.sentMessage.content, null, 2)}</p>}</div>}
          {message && <p className="message-delivery">协作消息 · {delivery ? `投递 · ${deliveryLabels[delivery.status] ?? delivery.status}` : '投递任务记录缺失'}</p>}
          {entry.replyTo && <div className="reply-reference">{onLocateMessage ? <button className="text-button" data-reply-to={entry.replyTo} onClick={() => onLocateMessage(entry.replyTo!)}>查看原消息</button> : <span>回复消息：{entry.replyTo}</span>}</div>}
          {resources.length > 0 && <div className="resource-actions">{resources.map((resource, i) => <button key={i} className="text-button" onClick={() => onOpen(entry.nodeId, resource)}>{resource.label}</button>)}</div>}
          {entry.direction === 'input' && !entry.text && !resources.length && <p>已发送内容</p>}
        </div>
      </article>;
    })}
    {tasks.filter(task => (task.status === 'failed' || task.status === 'needs_reconciliation') && entries.some(entry => entry.taskId === task.id)).map(task => <div className="inline-warning" key={task.id}><strong>{nodes.find(n => n.id === task.nodeId)?.name} · {task.status === 'needs_reconciliation' ? '状态待核对' : '执行未完成'}</strong><p>{task.error}</p>{onRetry && <button className="text-button" onClick={() => onRetry(task)}>核对后重试</button>}</div>)}
  </div>;
}
