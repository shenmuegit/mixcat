import { useRef } from 'react';
import { Icon } from './Icon';

interface ParentLink { id: string; label: string; open(): void }

export function PathBreadcrumb({ label, root, ancestors, current }: {
  label: string; root: ParentLink; ancestors: ParentLink[]; current: string;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);
  const parent = ancestors.at(-1), earlier = ancestors.slice(0, -1);
  const separator = <Icon name="chevron" size={12} />;
  function dismiss() { if (menu.current) menu.current.open = false; summary.current?.focus({ preventScroll: true }); }

  return <nav className="item-path" aria-label={label}>
    <button className="text-button" type="button" onClick={root.open}>{root.label}</button>
    {earlier.length > 0 && <>{separator}<details ref={menu} onKeyDown={event => {
      if (event.key === 'Escape' && menu.current?.open && !event.nativeEvent.isComposing) {
        event.preventDefault(); event.stopPropagation(); dismiss();
      }
    }} onBlur={event => {
      if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
    }}>
      <summary ref={summary}>更多上级</summary>
      <div className="item-path-parents">{earlier.map(ancestor => <button key={ancestor.id} type="button" title={ancestor.label}
        onClick={() => { dismiss(); ancestor.open(); }}>{ancestor.label}</button>)}</div>
    </details></>}
    {parent && <>{separator}<button className="text-button item-path-name" type="button" title={parent.label} onClick={parent.open}>{parent.label}</button></>}
    {separator}<span className="item-path-name item-path-current" title={current} aria-current="page">{current}</span>
  </nav>;
}
