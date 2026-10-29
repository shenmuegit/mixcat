import { useEffect, useId, useRef, useState } from 'react';
import type { AppCommand, AppReply } from '../shared/types';
import { itemLink, itemNumber, type ItemSummary } from '../shared/project-items';
import { itemKinds, itemStatuses } from './ProjectMarkdown';

export function ReferenceEditor({ projectId, value, onChange, execute, label, id, rows = 7, placeholder, disabled = false }: {
  projectId: string; value: string; onChange(value: string): void; execute(command: AppCommand): Promise<AppReply | null>;
  label: string; id?: string; rows?: number; placeholder?: string; disabled?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null), listId = useId(), executor = useRef(execute); executor.current = execute;
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
  const expanded = !!mention && !dismissed;
  const above = !!ref.current && ref.current.getBoundingClientRect().bottom > window.innerHeight - 280;
  return <div className="reference-editor"><textarea ref={ref} id={id} aria-label={label} value={value} rows={rows} maxLength={131072} placeholder={placeholder ?? '输入内容，使用 @ 引用 Issue 或文档'} disabled={disabled}
    role="combobox" aria-autocomplete="list" aria-expanded={expanded} aria-controls={expanded ? listId : undefined} aria-activedescendant={expanded && choices.length ? `${listId}-${selected}` : undefined}
    onChange={event => { setDismissed(false); onChange(event.target.value); locate(event.target.value, event.target.selectionStart); }}
    onSelect={event => locate(event.currentTarget.value, event.currentTarget.selectionStart)}
    onBlur={() => { setMention(null); setChoices([]); }}
    onKeyDown={event => {
      if (!expanded || event.nativeEvent.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); setDismissed(true); }
      else if (choices.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); setSelected(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length); }
      else if (choices.length && event.key === 'Enter') { event.preventDefault(); choose(choices[selected]); }
    }} />
    {expanded && <div className={`reference-results${above ? ' above' : ''}`} role="listbox" id={listId} aria-label="引用搜索结果">{loading ? <p role="status">正在查找…</p> : choices.length ? choices.map((item, index) => <button key={item.id} id={`${listId}-${index}`} type="button" role="option" aria-selected={index === selected} tabIndex={-1} onMouseDown={event => event.preventDefault()} onClick={() => choose(item)}><span className="reference-kind">{itemKinds[item.kind]}</span><strong>{itemNumber(item)} · {item.title}</strong><small>{itemStatuses[item.status]}</small></button>) : <p>没有匹配的工作项</p>}</div>}
  </div>;
}
