import type { ConversationEntry, NodeView, TaskView } from '../shared/types';
import { orderedConversation } from '../shared/conversation-order';
export { orderedConversation } from '../shared/conversation-order';
export function entryResources(entry: ConversationEntry): { label: string; path?: string; url?: string }[] {
  const result: { label: string; path?: string; url?: string }[] = [];
  const add = (label: string, value: unknown) => {
    if (typeof value !== 'string' || !value) return;
    if (/^https?:\/\//i.test(value)) result.push({ label, url: value });
    else if (/^(?:[a-z]:[\\/]|\/)/i.test(value)) result.push({ label, path: value });
  };
  const content: any = entry.content;
  const items = Array.isArray(content) ? content : Array.isArray(content?.input) ? content.input : [content];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    add('查看图片', item.savedPath);
    if (['imageView', 'localImage', 'localAudio', 'mention'].includes(item.type)) add('打开附件', item.path);
    if (['image', 'audio', 'resource_link'].includes(item.type)) add(item.name ?? '打开资源', item.url ?? item.uri);
    for (const change of item.changes ?? []) add('查看文件', change.path);
    for (const block of item.result?.content ?? []) {
      if (block.type === 'resource_link') add(block.name ?? '打开资源', block.uri);
    }
  }
  return result.filter((resource, index) => result.findIndex(other => other.path === resource.path && other.url === resource.url) === index);
}

export function ConversationFeed({ entries, nodes, tasks = [], projectTimeline = false, onOpen, onRetry }: { entries: ConversationEntry[]; nodes: NodeView[]; tasks?: TaskView[]; projectTimeline?: boolean; onOpen: (nodeId: string, resource: { path?: string; url?: string }) => void; onRetry?: (task: TaskView) => void }) {
  const ordered = orderedConversation(entries);
  return <div className={`conversation-feed chat-history ${projectTimeline ? 'project-timeline' : ''}`} aria-label={projectTimeline ? '项目会话历史' : '节点聊天记录'}>
    {!ordered.length && <div className="panel-empty"><h3>开始这个会话</h3><p>发送文字或附件，输入与回复会保存在该节点的历史中。</p></div>}
    {ordered.map(entry => {
      const node = nodes.find(n => n.id === entry.nodeId);
      const source = entry.source?.kind === 'node' ? entry.source.name ?? nodes.find(n => n.id === entry.source?.nodeId)?.name ?? '其他节点' : entry.source?.kind === 'user' ? '用户' : entry.source?.kind === 'system' ? '系统续接' : '原生输入（来源未知）';
      const author = entry.source?.name ?? (entry.source?.kind === 'unknown' ? '来源未知' : node?.name ?? entry.nodeId);
      const label = entry.direction === 'input' ? `${source} → ${node?.name ?? entry.nodeId}` : projectTimeline && author !== node?.name ? `${node?.name ?? entry.nodeId} · ${author}` : author;
      const resources = entryResources(entry);
      const hasTime = Number.isFinite(Date.parse(entry.createdAt));
      return <article className={`chat-entry chat-${entry.direction}`} key={entry.id} data-entry-id={entry.id} data-node-id={entry.nodeId}>
        <div className="feed-meta"><strong>{label}{entry.direction === 'event' ? ' · 执行记录' : ''}</strong><time dateTime={hasTime ? entry.createdAt : undefined}>{hasTime ? new Date(entry.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '原生历史未提供时间'}</time></div>
        <div className="chat-bubble">{entry.text && <p>{entry.text}</p>}
          {resources.length > 0 && <div className="resource-actions">{resources.map((resource, i) => <button key={i} className="text-button" onClick={() => onOpen(entry.nodeId, resource)}>{resource.label}</button>)}</div>}
          {!entry.text && !resources.length && <p>{entry.direction === 'input' ? '已发送内容' : '原生会话记录'}</p>}
          {entry.direction === 'event' && <details><summary>原始记录{entry.status ? ` · ${entry.status}` : ''}</summary><pre className="result-json">{JSON.stringify(entry.content, null, 2)}</pre></details>}
        </div>
      </article>;
    })}
    {tasks.filter(task => task.status === 'failed' || task.status === 'needs_reconciliation').map(task => <div className="inline-warning" key={task.id}><strong>{nodes.find(n => n.id === task.nodeId)?.name} · {task.status === 'needs_reconciliation' ? '状态待核对' : '执行未完成'}</strong><p>{task.error}</p>{onRetry && <button className="text-button" onClick={() => onRetry(task)}>核对后重试</button>}</div>)}
  </div>;
}
