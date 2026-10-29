import { useEffect, useRef, useState } from 'react';
import type { FeedCommand, FeedCommandResult, FeedPage } from '../shared/feed';
import { COMMAND_JSON_LIMIT } from '../shared/commands';
import type { FeedExecute } from './FeedWorkspace';
export interface FeedDraftPort { text(key: string): string; loaded(key: string): boolean; load(key: string, fallback?: string): Promise<void>; edit(key: string, text: string): void; update(key: string, transform: (text: string) => string | undefined): void; save(key: string): Promise<void>; }
export interface FormDraft<T> { fields: T; version: number; clean?: boolean; pending?: { command: FeedCommand; version: number }; }
export function useFeedForm<T>(key: string, initial: T, drafts?: FeedDraftPort) {
  const local = useRef<FormDraft<T>>({ fields: initial, version: 0 });
  const [, render] = useState(0), busy = useRef(false);
  const serialized = drafts?.text(key);
  const restored: FormDraft<T> = serialized ? JSON.parse(serialized) : local.current;
  const value = restored.clean ? { ...restored, fields: initial } : restored;
  const current = useRef(value); current.current = value;
  useEffect(() => { void drafts?.load(key).catch(() => {}); }, [key]);
  function write(next: FormDraft<T>) { current.current = next; local.current = next; drafts?.edit(key, JSON.stringify(next)); render(n => n + 1); }
  function change(fields: T) { write({ ...current.current, fields, clean: false, version: current.current.version + 1 }); }
  function resolveSubmission(pending: NonNullable<FormDraft<T>['pending']>, accepted: boolean, clear: T) {
    let resolved: FormDraft<T> | undefined;
    const transform = (text: string) => {
      if (drafts && !text) return undefined;
      const latest: FormDraft<T> = text ? JSON.parse(text) : local.current;
      current.current = latest;
      if (JSON.stringify(latest.pending) !== JSON.stringify(pending)) return undefined;
      const { pending: _pending, ...retained } = latest;
      resolved = accepted ? { ...retained, clean: latest.version === pending.version, fields: latest.version === pending.version ? clear : latest.fields, version: latest.version + 1 } : retained;
      return JSON.stringify(resolved);
    };
    // Resolve in the shared owner, not the hook instance that may have been unmounted.
    if (drafts) drafts.update(key, transform); else transform(JSON.stringify(local.current));
    if (!resolved) return false;
    current.current = resolved; local.current = resolved; render(n => n + 1); return true;
  }
  async function submit(command: FeedCommand, execute: FeedExecute, clear: T): Promise<FeedCommandResult | undefined> {
    if (busy.current) return; busy.current = true; render(n => n + 1);
    try {
      await drafts?.load(key);
      // Read from the shared owner after load; navigation and reload may have restored a pending admission.
      if (drafts?.text(key)) { const restored: FormDraft<T> = JSON.parse(drafts.text(key)); current.current = restored.clean ? { ...restored, fields: initial } : restored; }
      if (!current.current.pending) {
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
      const next = { ...current.current, pending: current.current.pending ?? { command, version: current.current.version } };
      const text = JSON.stringify(next), requestId = crypto.randomUUID();
      if (JSON.stringify({ id: requestId, command: next.pending.command }).length > COMMAND_JSON_LIMIT || new TextEncoder().encode(text).length > 1024 * 1024 || JSON.stringify({ id: requestId, command: { type: 'save_feed_draft', draft: { key, text }, expectedRevision: Number.MAX_SAFE_INTEGER, requestId } }).length > COMMAND_JSON_LIMIT) throw Error('提交与草稿超过传输上限，请缩短输入后重试。');
      write(next); await drafts?.save(key);
      let result: FeedCommandResult;
      try { result = await execute(next.pending.command); }
      catch (error) {
        // These durable-service rejections occur before acceptance; transport errors keep the original identity.
        if (/采集任务版本冲突|选中的素材已删除|文字超过 256 KiB|来源偏好超过 64 KiB|删除前必须先安全停止并核对当前运行|必须先核对尚未确认结束的运行|采集任务已删除|IANA 时区无效/.test(String(error))) { if (resolveSubmission(next.pending, false, clear)) await drafts?.save(key); }
        throw error;
      }
      // Only the still-owned submission may consume its original edit version before awaiting cleanup.
      if (resolveSubmission(next.pending, true, clear)) await drafts?.save(key);
      return result;
    } finally { busy.current = false; render(n => n + 1); }
  }
  return { value, change, submit, clean: () => !!current.current.clean, busy: busy.current, ready: !drafts || drafts.loaded(key) };
}

export function useFeedPage<T>(command: FeedCommand, field: 'history' | 'runs' | 'results' | 'failures' | 'collectionPage', execute: FeedExecute, revision: string | number, onError: (error: string) => void) {
  const [items, setItems] = useState<T[]>([]), [cursor, setCursor] = useState<string | null>(null), [loading, setLoading] = useState(false);
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
    })().catch(error => { if (token === sequence.current) errorRef.current(String(error)); });
    return () => { sequence.current++; };
  }, [scope, revision]);
  async function more() {
    if (!cursor || loadingRef.current) return; const token = sequence.current; loadingRef.current = true; setLoading(true);
    try { const reply = await executeRef.current({ ...JSON.parse(scope), cursor }); if (token !== sequence.current) return; const page = reply[field] as FeedPage<T>; pages.current++; const rows = [...(cache.current.get(scope)?.items ?? []), ...page.items]; cache.current.set(scope, { items: rows, cursor: page.nextCursor, pages: pages.current }); setItems(rows); setCursor(page.nextCursor); }
    catch (error) { if (token === sequence.current) errorRef.current(String(error)); } finally { loadingRef.current = false; setLoading(false); }
  }
  return { items, cursor, more, loading };
}
