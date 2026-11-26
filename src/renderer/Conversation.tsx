import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ConversationEntry, MessageSummary, NodeView, TaskView } from '../shared/types';
import { orderedConversation } from '../shared/conversation-order';
import { ProjectMarkdown } from './ProjectMarkdown';
import { Icon } from './Icon';
import { ConversationPlan, ExecutionRecordGroup, WebSearchDetails, readPlanSteps, readWebSearch, recordError, useArrivingRecords } from './ConversationProcess';
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
const finishedEventLabels: Record<string, string> = { ...deliveryLabels, canceled: '已取消', interrupted: '已中断', declined: '已拒绝' };
const executingEventStatuses = new Set(['inProgress', 'running', 'started']);
function isFailedExecution(entry: ConversationEntry) {
  const item = (entry.rawItem ?? entry.content) as { type?: string; exitCode?: unknown } | null;
  return entry.status === 'failed' || ((!entry.status || entry.status === 'completed') && item?.type === 'commandExecution'
    && typeof item.exitCode === 'number' && item.exitCode !== 0);
}
function isCurrentExecution(entry: ConversationEntry, task: TaskView | undefined): task is TaskView {
  return task?.status === 'running' && entry.taskId === task.id && entry.nodeId === task.nodeId
    && !!entry.threadId && entry.threadId === task.threadId
    && (entry.resumeActionId === undefined || entry.resumeActionId === (task.resumeActionId ?? null));
}

export function isCurrentActivity(entry: ConversationEntry, task: TaskView | undefined, entries: readonly ConversationEntry[]) {
  if (entry.completedAt || !executingEventStatuses.has(entry.status ?? '') || !isCurrentExecution(entry, task)) return false;
  if (entry.turnId) return entry.turnId === task.turnId;
  const item = (entry.rawItem ?? entry.content) as { type?: string } | null;
  if (item?.type !== 'hookExecution') return false;
  if (entry.resumeActionId !== undefined) return true;
  // Older thread-scoped hooks can be tied to a turn when they follow its input.
  return entries.some(input => input.direction === 'input' && input.taskId === task.id
    && input.turnId === task.turnId && input.seq < entry.seq);
}
function hasExecutionScope(entry: ConversationEntry) {
  return entry.direction === 'event' && !!entry.threadId && !!entry.turnId;
}
function sameExecution(previous: ConversationEntry, entry: ConversationEntry) {
  return previous.taskId === entry.taskId && previous.nodeId === entry.nodeId && previous.threadId === entry.threadId
    && previous.turnId === entry.turnId && (previous.resumeActionId ?? null) === (entry.resumeActionId ?? null);
}
function continuesExecution(previous: ConversationEntry | undefined, entry: ConversationEntry) {
  return previous?.direction === 'event' && hasExecutionScope(entry) && sameExecution(previous, entry);
}

export function ConversationFeed({ entries, nodes, tasks = [], messages = [], projectRoot, selectedNodeId, locatedEntryId, locationRequest, latestRequest, projectTimeline = false, animateLive = false, onOpen, onRetry, onLocateMessage }: { entries: ConversationEntry[]; nodes: Pick<NodeView, 'id' | 'name'>[]; tasks?: TaskView[]; messages?: MessageSummary[]; projectRoot?: string; selectedNodeId?: string; locatedEntryId?: string; locationRequest?: object; latestRequest?: object; projectTimeline?: boolean; animateLive?: boolean; onOpen: (nodeId: string, resource: { path?: string; url?: string }) => void; onRetry?: (task: TaskView) => void; onLocateMessage?: (messageId: string) => void }) {
  const ordered = orderedConversation(entries.filter(entry => entry.direction !== 'event' || !['executionProvenance', 'sessionConfiguration'].includes((entry.rawItem as any)?.type ?? (entry.content as any)?.type)));
  const feed = useRef<HTMLDivElement>(null);
  const focusedRequest = useRef<object | null>(null);
  const consumedLatestRequest = useRef<object | null>(null);
  const followingLatest = useRef(true);
  const pausedAtLocation = useRef(false);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const arrivals = useArrivingRecords(ordered.map(entry => entry.id), selectedNodeId, animateLive && !projectTimeline);
  useLayoutEffect(() => {
    const element = feed.current;
    if (!selectedNodeId || !element?.getClientRects().length || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const fade = element.animate([{ opacity: 0.8 }, { opacity: 1 }], { duration: 140, easing: 'ease-out' });
    return () => fade.cancel();
  }, [selectedNodeId]);
  useLayoutEffect(() => {
    const content = feed.current, viewport = content?.closest<HTMLElement>('.session-scroll');
    if (!content || !viewport) return;
    pausedAtLocation.current = false;
    const updateFollowing = () => {
      if (!viewport.clientHeight || pausedAtLocation.current) return;
      const atLatest = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 24;
      followingLatest.current = atLatest;
      setAwayFromLatest(!atLatest);
    };
    const observer = new ResizeObserver(() => {
      if (!viewport.clientHeight) return;
      if (followingLatest.current) viewport.scrollTop = viewport.scrollHeight;
      updateFollowing();
    });
    observer.observe(content.parentElement!);
    observer.observe(viewport);
    viewport.addEventListener('scroll', updateFollowing, { passive: true });
    return () => { observer.disconnect(); viewport.removeEventListener('scroll', updateFollowing); };
  }, [selectedNodeId]);
  useLayoutEffect(() => {
    if (!latestRequest || consumedLatestRequest.current === latestRequest) return;
    const viewport = feed.current?.closest<HTMLElement>('.session-scroll');
    if (!viewport) return;
    consumedLatestRequest.current = latestRequest;
    // An explicit move to the latest record supersedes an older location request.
    focusedRequest.current = locationRequest ?? null;
    pausedAtLocation.current = false;
    followingLatest.current = true;
    setAwayFromLatest(false);
    viewport.scrollTop = viewport.scrollHeight;
  }, [latestRequest]);
  function focusEntry(id: string | undefined) {
    if (!id) return false;
    const entry = [...(feed.current?.querySelectorAll<HTMLElement>('[data-entry-id]') ?? [])].find(element => element.dataset.entryId === id);
    if (!entry) return false;
    const group = entry.closest<HTMLDetailsElement>('.execution-log');
    if (group) group.open = true;
    pausedAtLocation.current = true;
    followingLatest.current = false;
    if (!projectTimeline) setAwayFromLatest(true);
    entry.scrollIntoView({ block: 'center' });
    entry.focus({ preventScroll: true });
    return true;
  }
  useEffect(() => {
    if (!locationRequest || focusedRequest.current === locationRequest) return;
    if (focusEntry(locatedEntryId)) focusedRequest.current = locationRequest;
  }, [locationRequest, locatedEntryId, entries]);
  const groups: ConversationEntry[][] = [];
  for (const entry of ordered) {
    const previous = groups.at(-1);
    if (previous && continuesExecution(previous.at(-1), entry)) previous.push(entry);
    else groups.push([entry]);
  }
  function renderEntry(entry: ConversationEntry) {
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
      const active = isCurrentActivity(entry, task, entries);
      if ((type === 'agentMessage' && !entry.text && !resources.length) || (thinking && !parts.length && !active)) return null;
      const web = type === 'webSearch' ? readWebSearch(item, resources) : null;
      const otherResources = web ? resources.filter(resource => !resource.url) : resources;
      const toolName = web ? `检索记录 · ${web.action}` : type === 'commandExecution' ? item.command : type === 'mcpToolCall' ? `${item.server} / ${item.tool}` : type === 'dynamicToolCall' ? item.tool : type === 'fileChange' ? '文件修改' : type === 'plan' ? '计划' : type;
      const failed = isFailedExecution(entry);
      const observedError = failed ? recordError(item?.error) : undefined;
      const searchError = failed && web && !entry.text.trimStart().startsWith('{') ? recordError(entry.text) : undefined;
      const reason = observedError ?? searchError;
      const toolStatus = active ? '运行中' : failed ? '失败' : executingEventStatuses.has(entry.status ?? '') ? '结果未确认'
        : entry.status && (finishedEventLabels[entry.status] ?? entry.status);
      const toolState = active && !projectTimeline ? 'active' : failed ? 'failed' : undefined;
      const historicalTool = projectTimeline && !active && !executingEventStatuses.has(entry.status ?? '');
      const planSteps = type === 'plan' ? readPlanSteps(item.plan) : null;
      const livePlan = !projectTimeline && active;
      const original = planSteps && hasExecutionScope(entry) ? ordered.find(candidate => candidate.direction === 'input' && sameExecution(candidate, entry)) : undefined;
      const currentTurn = isCurrentExecution(entry, task) && !!entry.turnId && entry.turnId === task.turnId;
      const reveal = entry.direction === 'event' && !entry.fromHistory && (currentTurn || active) && arrivals.has(entry.id);
      return <article className={`chat-entry chat-${entry.direction}${thinking ? ' chat-reasoning' : ''}${locatedEntryId === entry.id ? ' is-located' : ''}`} key={entry.id} tabIndex={-1} data-entry-id={entry.id} data-node-id={entry.nodeId} data-message-id={entry.messageId} data-native-type={type} data-native-phase={type === 'agentMessage' ? item.phase : undefined} data-user-message={entry.direction === 'input' && entry.source?.kind === 'user' ? '' : undefined} data-record-enter={reveal ? '' : undefined}>
        <div className="feed-meta"><strong>{label}</strong><time dateTime={hasTime ? entry.createdAt : undefined}>{hasTime ? new Date(entry.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '原生历史未提供时间'}</time></div>
        <div className="chat-bubble">
          {thinking ? <details className="native-reasoning" open={active}><summary>{active ? '正在思考' : '思考'}</summary>{parts.map((text, index) => <ProjectMarkdown key={index} text={text} historical />)}</details>
            : planSteps ? <ConversationPlan steps={planSteps} explanation={item.explanation} raw={item} live={livePlan}
                animate={animateLive && !entry.fromHistory} locateLabel={entry.taskId ? '定位原任务' : '定位原消息'}
                onLocate={original ? () => { focusEntry(original.id); } : undefined} />
              : type === 'plan' && typeof item.text === 'string' ? <ProjectMarkdown text={item.text} historical />
              : entry.direction === 'event' ? <details className={`native-tool${historicalTool ? ' workspace-disclosure' : ''}`} data-tool-state={toolState}>
                <summary aria-label={`执行记录 · ${toolName ?? '活动'}${toolStatus ? ` · ${toolStatus}` : ''}`}>
                  <span>{toolName ?? '活动'}{toolStatus && <span className="native-status">{toolStatus}</span>}</span>
                  {historicalTool && <Icon name="chevron" size={14} />}
                </summary>
                {web && (web.queries.length > 0 || web.sources.length > 0) && <WebSearchDetails search={web} onOpen={url => onOpen(entry.nodeId, { url })} />}
                {!web && entry.text && entry.text.trim() !== reason && <pre className="native-output">{entry.text}</pre>}
                <details><summary>原始记录</summary><pre className="result-json">{JSON.stringify(entry.rawItem ?? entry.content, null, 2)}</pre></details>
              </details>
              : entry.text && (entry.direction === 'output' || entry.text.includes('mixcat://') ? <ProjectMarkdown text={entry.text} historical /> : <p>{entry.text}</p>)}
          {entry.direction === 'event' && reason && <p className="execution-record-error">{reason}</p>}
          {entry.sentMessage && <div className="sent-message-body"><strong>发送正文</strong>{typeof entry.sentMessage.content === 'string' && entry.sentMessage.content.includes('mixcat://') ? <ProjectMarkdown text={entry.sentMessage.content} historical /> : <p>{typeof entry.sentMessage.content === 'string' ? entry.sentMessage.content : JSON.stringify(entry.sentMessage.content, null, 2)}</p>}</div>}
          {message && <p className="message-delivery">协作消息 · {delivery ? `投递 · ${deliveryLabels[delivery.status] ?? delivery.status}` : '投递任务记录缺失'}</p>}
          {entry.replyTo && <div className="reply-reference">{onLocateMessage ? <button className="text-button" data-reply-to={entry.replyTo} onClick={() => onLocateMessage(entry.replyTo!)}>查看原消息</button> : <span>回复消息：{entry.replyTo}</span>}</div>}
          {otherResources.length > 0 && <div className="resource-actions">{otherResources.map((resource, i) => <button key={i} className="text-button" onClick={() => onOpen(entry.nodeId, resource)}>{resource.label}</button>)}</div>}
          {entry.direction === 'input' && !entry.text && !otherResources.length && <p>已发送内容</p>}
        </div>
      </article>;
  }
  return <><div key={selectedNodeId} ref={feed} className={`conversation-feed chat-history ${projectTimeline ? 'project-timeline' : 'node-chat-history'}`} aria-label={projectTimeline ? '项目会话历史' : '节点聊天记录'}>
    {!ordered.length && <div className="panel-empty"><h3>开始这个会话</h3><p>发送文字或附件，输入与回复会保存在该节点的历史中。</p></div>}
    {groups.map(group => {
      const first = group[0];
      if (!hasExecutionScope(first)) return renderEntry(first);
      const rows = group.map(renderEntry).filter(Boolean);
      if (!rows.length) return null;
      const task = tasks.find(task => task.id === first.taskId);
      const state = group.some(isFailedExecution) ? 'failed' : group.some(entry => isCurrentActivity(entry, task, entries)) ? 'active' : undefined;
      const title = task?.instruction?.split('\n')[0].trim();
      return <ExecutionRecordGroup key={first.id} state={state} title={title} count={rows.length}>{rows}</ExecutionRecordGroup>;
    })}
    {tasks.filter(task => (task.status === 'failed' || task.status === 'needs_reconciliation') && entries.some(entry => entry.taskId === task.id)).map(task => <div className="inline-warning" key={task.id}><strong>{nodes.find(n => n.id === task.nodeId)?.name} · {task.status === 'needs_reconciliation' ? '状态待核对' : '执行未完成'}</strong><p>{task.error}</p>{onRetry && <button className="text-button" onClick={() => onRetry(task)}>核对后重试</button>}</div>)}
  </div>{!projectTimeline && awayFromLatest && <button type="button" className="session-jump-latest" aria-label="回到最新" onClick={() => {
    const viewport = feed.current?.closest<HTMLElement>('.session-scroll');
    if (!viewport) return;
    pausedAtLocation.current = false;
    followingLatest.current = true;
    setAwayFromLatest(false);
    viewport.scrollTop = viewport.scrollHeight;
    viewport.focus({ preventScroll: true });
  }}><Icon name="chevron" size={14} />回到最新</button>}</>;
}
