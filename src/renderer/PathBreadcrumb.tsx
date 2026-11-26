import { Fragment, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

interface ParentLink { id: string; label: string; open(): void | boolean }

export function PathBreadcrumb({ label, root, ancestors, current }: {
  label: string; root: ParentLink; ancestors: ParentLink[]; current: string;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);
  const nav = useRef<HTMLElement>(null), meter = useRef<HTMLSpanElement>(null);
  const [fold, setFold] = useState(false);
  const earlier = fold ? ancestors.slice(0, -1) : [];
  const visible = fold ? ancestors.slice(-1) : ancestors;
  const separator = <Icon name="chevron" size={12} />;
  function dismiss() { if (menu.current) menu.current.open = false; summary.current?.focus({ preventScroll: true }); }

  useLayoutEffect(() => {
    const view = nav.current!, content = meter.current!;
    const measure = () => setFold(content.getBoundingClientRect().width > view.clientWidth + 1);
    const observer = new ResizeObserver(measure);
    observer.observe(view); observer.observe(content); measure();
    return () => observer.disconnect();
  }, []);

  return <nav ref={nav} className="item-path" aria-label={label}>
    <div className="item-path-probe" aria-hidden="true"><span ref={meter}>
      <span>{root.label}</span>{ancestors.map(ancestor => <Fragment key={ancestor.id}>{separator}<span>{ancestor.label}</span></Fragment>)}
      {separator}<span className="item-path-current">{current}</span>
    </span></div>
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
        onClick={event => {
          if (ancestor.open() === false) event.currentTarget.focus({ preventScroll: true });
          else dismiss();
        }}>{ancestor.label}</button>)}</div>
    </details></>}
    {visible.map(parent => <Fragment key={parent.id}>{separator}<button className="text-button item-path-name" type="button" title={parent.label} onClick={parent.open}>{parent.label}</button></Fragment>)}
    {separator}<span className="item-path-name item-path-current" title={current} aria-current="page">{current}</span>
  </nav>;
}
