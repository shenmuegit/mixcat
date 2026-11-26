import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { AppCommand, AppReply } from '../shared/types';
import { itemLink, itemNumber, type ItemSummary } from '../shared/project-items';
import { itemKinds, itemStatuses } from './ProjectMarkdown';
import { placePopover } from './popover-position';

function caretRect(input: HTMLTextAreaElement, offset: number, popup: HTMLElement) {
  const box = input.getBoundingClientRect();
  if (!box.width || box.bottom <= 0 || box.top >= window.innerHeight) return null;
  const style = getComputedStyle(input);
  const mirror = document.createElement('div');
  Object.assign(mirror.style, {
    position: 'fixed', left: `${box.left + input.clientLeft}px`, top: `${box.top + input.clientTop}px`,
    width: `${input.clientWidth}px`, boxSizing: 'border-box', visibility: 'hidden', pointerEvents: 'none',
  });
  for (const name of ['font', 'line-height', 'letter-spacing', 'word-spacing', 'padding', 'direction', 'text-align', 'white-space', 'overflow-wrap', 'word-break', 'tab-size']) {
    mirror.style.setProperty(name, style.getPropertyValue(name));
  }
  const tail = document.createElement('span');
  tail.textContent = input.value.slice(offset) || '\u200b';
  mirror.append(input.value.slice(0, offset), tail);
  document.body.append(mirror);
  const caret = tail.getClientRects()[0] ?? tail.getBoundingClientRect();
  mirror.remove();
  const top = caret.top - input.scrollTop;
  if (top < box.top - 1 || top + caret.height > box.bottom + 1) return null;
  const left = caret.left - input.scrollLeft;
  const hitX = Math.max(box.left + 1, Math.min(left, box.right - 1));
  const hit = document.elementsFromPoint(hitX, top + caret.height / 2).find(element => !popup.contains(element));
  if (hit !== input) return null;
  return new DOMRect(left, top, 0, caret.height);
}

export function ReferenceEditor({ projectId, value, onChange, execute, label, id, rows = 7, placeholder, disabled = false, submitOnEnter = false }: {
  projectId: string; value: string; onChange(value: string): void; execute(command: AppCommand): Promise<AppReply | null>;
  label: string; id?: string; rows?: number; placeholder?: string; disabled?: boolean; submitOnEnter?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null), listId = useId(), executor = useRef(execute); executor.current = execute;
  const list = useRef<HTMLDivElement>(null);
  const [mention, setMention] = useState<{ start: number; end: number; text: string } | null>(null);
  const [choices, setChoices] = useState<ItemSummary[]>([]), [selected, setSelected] = useState(0), [loading, setLoading] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  function locate(text: string, caret: number) {
    const match = /(?:^|[\s(])@([^\n@\[\]()]{0,80})$/.exec(text.slice(0, caret));
    if ((match?.[1] ?? null) !== (mention?.text ?? null)) { setChoices([]); setSelected(0); }
    setMention(match ? { start: caret - match[1].length - 1, end: caret, text: match[1] } : null);
  }
  useEffect(() => {
    if (!mention || dismissed) { setChoices([]); return; }
    let cancelled = false; setChoices([]); setLoading(true);
    const timer = setTimeout(() => { void executor.current({ type: 'search_project_items', projectId, query: { text: mention.text.trim(), limit: 20 } }).then(reply => {
      if (!cancelled) { setChoices(reply?.projectItems?.items ?? []); setSelected(0); setLoading(false); }
    }); }, 150);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [projectId, mention?.text, dismissed]);
  function choose(item: ItemSummary) {
    if (!mention) return;
    const link = itemLink(projectId, item), next = `${value.slice(0, mention.start)}${link} ${value.slice(mention.end)}`;
    onChange(next); setMention(null); setChoices([]);
    requestAnimationFrame(() => { ref.current?.focus(); ref.current?.setSelectionRange(mention.start + link.length + 1, mention.start + link.length + 1); });
  }
  const expanded = !!mention && !dismissed && !disabled;
  const caret = mention?.end;
  useLayoutEffect(() => {
    const input = ref.current, popup = list.current;
    if (!expanded || caret === undefined || !input || !popup) return;
    let frame = 0;
    const place = () => {
      const anchor = caretRect(input, caret, popup);
      if (!anchor) { if (popup.matches(':popover-open')) popup.hidePopover(); setDismissed(true); return; }
      placePopover(popup, anchor, 288, 240);
      if (!popup.matches(':popover-open')) popup.showPopover();
    };
    const update = (event: Event) => {
      if (event.target instanceof Node && popup.contains(event.target)) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(input);
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [expanded, caret, value]);
  useLayoutEffect(() => {
    const popup = list.current, option = popup?.querySelector('[aria-selected=true]');
    if (!popup || !option) return;
    const bounds = popup.getBoundingClientRect(), row = option.getBoundingClientRect();
    if (row.bottom > bounds.bottom) popup.scrollTop += row.bottom - bounds.bottom;
    else if (row.top < bounds.top) popup.scrollTop += row.top - bounds.top;
  }, [choices, selected]);
  return <div className="reference-editor"><textarea ref={ref} id={id} aria-label={label} value={value} rows={rows} maxLength={131072} placeholder={placeholder ?? '输入内容，使用 @ 引用 Issue 或文档'} disabled={disabled}
    role="combobox" aria-autocomplete="list" aria-expanded={expanded} aria-controls={expanded ? listId : undefined} aria-activedescendant={expanded && choices.length ? `${listId}-${selected}` : undefined}
    onChange={event => { setDismissed(false); onChange(event.target.value); locate(event.target.value, event.target.selectionStart); }}
    onSelect={event => locate(event.currentTarget.value, event.currentTarget.selectionStart)}
    onBlur={() => { setMention(null); setChoices([]); }}
    onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      if (submitOnEnter && event.key === 'Enter' && event.ctrlKey) {
        event.preventDefault();
        const start = event.currentTarget.selectionStart, end = event.currentTarget.selectionEnd;
        const next = `${value.slice(0, start)}\n${value.slice(end)}`;
        if (next.length > event.currentTarget.maxLength) return;
        onChange(next); setMention(null); setChoices([]);
        requestAnimationFrame(() => ref.current?.setSelectionRange(start + 1, start + 1));
        return;
      }
      if (!expanded) {
        if (submitOnEnter && event.key === 'Enter') {
          event.preventDefault();
          const submitter = event.currentTarget.form?.querySelector<HTMLButtonElement>('button[type="submit"]');
          if (submitter && !submitter.disabled) event.currentTarget.form?.requestSubmit(submitter);
        }
        return;
      }
      if (event.key === 'Escape') { event.preventDefault(); setDismissed(true); }
      else if (choices.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); setSelected(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length); }
      else if (choices.length && event.key === 'Enter') { event.preventDefault(); choose(choices[selected]); }
      else if (submitOnEnter && event.key === 'Enter') event.preventDefault();
    }} />
    {expanded && <div ref={list} popover="manual" className="reference-results anchored-popover" role="listbox" id={listId} aria-label="引用搜索结果">{loading ? <p role="status">正在查找…</p> : choices.length ? choices.map((item, index) => <button key={item.id} id={`${listId}-${index}`} type="button" role="option" aria-selected={index === selected} tabIndex={-1} onMouseDown={event => event.preventDefault()} onClick={() => choose(item)}><span className="reference-kind">{itemKinds[item.kind]}</span><strong>{itemNumber(item)} · {item.title}</strong><small>{itemStatuses[item.status]}</small></button>) : <p>没有匹配的工作项</p>}</div>}
  </div>;
}
