import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { FeedCommand, FeedCommandResult, FeedPage } from '../shared/feed';
import { COMMAND_JSON_LIMIT } from '../shared/commands';
import type { FeedExecute } from './FeedWorkspace';
export interface FeedFormMemory {
  read<T>(key: string): FeedFormInput<T> | undefined;
  write<T>(key: string, input: FeedFormInput<T>): void;
}
export interface FeedFormInput<T> { fields: T; version: number; edited: boolean; pending?: { command: FeedCommand; version: number }; }
export function submitFeedOnEnter(event: KeyboardEvent<HTMLTextAreaElement>, change: (text: string) => void) {
  if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.currentTarget.readOnly) return;
  if (event.ctrlKey) {
    event.preventDefault();
    const input = event.currentTarget, start = input.selectionStart;
    change(`${input.value.slice(0, start)}\n${input.value.slice(input.selectionEnd)}`);
    requestAnimationFrame(() => input.setSelectionRange(start + 1, start + 1)); return;
  }
  if (event.shiftKey || event.altKey || event.metaKey) return;
  event.preventDefault();
  const submitter = event.currentTarget.form?.querySelector<HTMLButtonElement>('.feed-send');
  if (!event.repeat && submitter && !submitter.disabled) event.currentTarget.form?.requestSubmit(submitter);
}
export function useFeedForm<T>(key: string, initial: T, memory?: FeedFormMemory) {
  const local = useRef<FeedFormInput<T>>({ fields: initial, version: 0, edited: false });
  const [, render] = useState(0), busy = useRef(false);
  function read() {
    const stored = memory?.read<T>(key) ?? local.current;
    return stored.edited ? stored : { ...stored, fields: initial };
  }
  function write(next: FeedFormInput<T>) { local.current = next; memory?.write(key, next); render(n => n + 1); }
  function change(fields: T) {
    const current = read();
    write({ ...current, fields, edited: JSON.stringify(fields) !== JSON.stringify(initial), version: current.version + 1 });
  }
  function resolveSubmission(pending: NonNullable<FeedFormInput<T>['pending']>, accepted: boolean, clear: T) {
    const latest = read();
    if (latest.pending !== pending || memory && memory.read<T>(key)?.pending !== pending) return;
    const { pending: _pending, ...retained } = latest;
    write(accepted && latest.version === pending.version ? { fields: clear, version: latest.version + 1, edited: false } : retained);
  }
  async function submit(command: FeedCommand, execute: FeedExecute, clear: T): Promise<FeedCommandResult | undefined> {
    if (busy.current) return; busy.current = true; render(n => n + 1);
    try {
      const current = read();
      if (!current.pending) {
        if (command.type === 'set_feed_schedule' && command.schedule.frequency !== 'manual') {
          if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(command.schedule.time)) throw Error('请选择有效的运行时间。');
          try { if (/^[+-]/.test(command.schedule.timeZone) || command.schedule.timeZone.length > 200) throw Error(); new Intl.DateTimeFormat('zh-CN', { timeZone: command.schedule.timeZone }); } catch { throw Error('请输入有效的 IANA 时区，例如 Asia/Shanghai。'); }
        }
        const bytes = (text: string) => new TextEncoder().encode(text).length;
        if (command.type === 'create_feed_collection' && (bytes(command.instruction)>256*1024 || bytes(command.sourcePreferences??'')>64*1024)) throw Error('采集说明最多 256 KiB，来源偏好最多 64 KiB。');
        if (command.type === 'edit_feed_collection') {
          if (command.changes.name !== undefined && !command.changes.name.trim()) throw Error('任务名称不能为空。');
          if ((command.changes.capabilities?.skills.length ?? 0) > 100 || (command.changes.capabilities?.plugins.length ?? 0) > 100) throw Error('技能和插件各最多选择 100 项。');
        }
      }
      const pending = current.pending ?? { command, version: current.version };
      if (JSON.stringify({ id: crypto.randomUUID(), command: pending.command }).length > COMMAND_JSON_LIMIT) throw Error('提交内容超过传输上限，请缩短输入后重试。');
      write({ ...current, pending });
      let result: FeedCommandResult;
      try { result = await execute(pending.command); }
      catch (error) {
        // A failed delivery can be retried with the same immutable request.
        if (/采集工作目录无效|采集任务版本冲突|信息条目不存在|文字超过 256 KiB|来源偏好超过 64 KiB|删除前必须先安全停止并核对当前运行|必须先核对尚未确认结束的运行|采集任务不存在|采集运行不存在|正在删除|已经永久删除|IANA 时区无效|只能插队尚未开始的聊天消息|当前回合已变化或不可插队/.test(String(error))) resolveSubmission(pending, false, clear);
        throw error;
      }
      resolveSubmission(pending, true, clear);
      return result;
    } finally { busy.current = false; render(n => n + 1); }
  }
  return { value: read(), change, submit, busy: busy.current };
}

export function useFeedPage<T>(command: FeedCommand, field: 'history' | 'runs' | 'results' | 'failures' | 'collectionPage', execute: FeedExecute, revision: string | number, onError: (error: string) => void) {
  const [items, setItems] = useState<T[]>([]), [cursor, setCursor] = useState<string | null>(null), [loading, setLoading] = useState(false);
  const [pageRequest, requestPage] = useState(0);
  const cache = useRef(new Map<string, { items: T[]; cursor: string | null; pages: number }>());
  const loadingRef = useRef(false);
  const sequence = useRef(0), pages = useRef(1), prior = useRef(''), executeRef = useRef(execute), errorRef = useRef(onError);
  executeRef.current = execute; errorRef.current = onError;
  const scope = JSON.stringify(command);
  useEffect(() => {
    const token = ++sequence.current; if (prior.current !== scope) { prior.current = scope; const saved = cache.current.get(scope); pages.current = saved?.pages ?? 1; setItems(saved?.items ?? []); setCursor(saved?.cursor ?? null); }
    void (async () => {
      const rows: T[] = []; let next: string | undefined;
      for (let i = 0; i < pages.current; i++) {
        const reply = await executeRef.current({ ...JSON.parse(scope), ...(next ? { cursor: next } : {}) }); if (sequence.current !== token) return;
        const page = reply[field] as FeedPage<T>; rows.push(...page.items); next = page.nextCursor ?? undefined; if (!next) break;
      }
      cache.current.set(scope, { items: rows, cursor: next ?? null, pages: pages.current }); setItems(rows); setCursor(next ?? null);
    })().catch(error => { if (token === sequence.current) { pages.current = cache.current.get(scope)?.pages ?? 1; errorRef.current(String(error)); } }).finally(() => { if (token === sequence.current) { loadingRef.current = false; setLoading(false); } });
    return () => { sequence.current++; };
  }, [scope, revision, pageRequest]);
  function more() {
    if (!cursor || loadingRef.current) return;
    // Retain requested page depth before a native update can restart the load.
    pages.current++; loadingRef.current = true; setLoading(true); requestPage(value => value + 1);
  }
  return { items, cursor, more, loading };
}
