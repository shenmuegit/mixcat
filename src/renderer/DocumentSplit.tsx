import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';

const minimum = 160, contentMinimum = 280, handleWidth = 6;

export function useDocumentSplit(active: boolean, sidebar: boolean) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null), actionsRef = useRef<HTMLDivElement>(null);
  const [widths, setWidths] = useState({ tree: 240, outline: 230 });
  const [available, setAvailable] = useState(0);
  const [minTree, setMinTree] = useState(minimum);
  function clamp(next: typeof widths, width: number, treeMinimum = minTree) {
    if (width <= 0) return next;
    const budget = width - contentMinimum - handleWidth * (sidebar ? 2 : 1);
    const outline = sidebar ? Math.max(minimum, Math.min(360, next.outline, budget - treeMinimum)) : next.outline;
    const tree = Math.max(treeMinimum, Math.min(460, next.tree, budget - (sidebar ? outline : 0)));
    return { tree, outline };
  }
  useEffect(() => {
    const element = bodyRef.current, toolbar = toolbarRef.current, actions = actionsRef.current;
    const input = toolbar?.querySelector('input'), pane = toolbar?.parentElement;
    if (!active || !element || !toolbar || !actions || !input || !pane) return;
    const observer = new ResizeObserver(() => {
      const width = element.getBoundingClientRect().width;
      if (width <= 0) return;
      const style = getComputedStyle(toolbar);
      const treeMinimum = Math.max(minimum, Math.ceil(parseFloat(getComputedStyle(input).minWidth) + actions.getBoundingClientRect().width
        + parseFloat(style.columnGap) + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + pane.offsetWidth - pane.clientWidth));
      setMinTree(treeMinimum); setAvailable(width);
      setWidths(current => {
        const next = clamp(current, width, treeMinimum);
        return next.tree === current.tree && next.outline === current.outline ? current : next;
      });
    });
    observer.observe(element);
    observer.observe(toolbar); observer.observe(actions);
    return () => observer.disconnect();
  }, [active, sidebar]);
  const maxTree = Math.max(minTree, Math.min(460, available ? available - contentMinimum - handleWidth * (sidebar ? 2 : 1) - (sidebar ? widths.outline : 0) : 460));
  const maxOutline = Math.max(minimum, Math.min(360, available ? available - contentMinimum - handleWidth * 2 - widths.tree : 360));
  return {
    bodyRef, toolbarRef, actionsRef, widths, minTree, maxTree, maxOutline,
    style: active ? { gridTemplateColumns: `${widths.tree}px ${handleWidth}px minmax(${contentMinimum}px,1fr)${sidebar ? ` ${handleWidth}px ${widths.outline}px` : ''}` } as CSSProperties : undefined,
    resize: (pane: 'tree' | 'outline', value: number) => setWidths(current => clamp({ ...current, [pane]: Math.max(pane === 'tree' ? minTree : minimum, Math.min(pane === 'tree' ? maxTree : maxOutline, value)) }, bodyRef.current?.getBoundingClientRect().width ?? 0)),
  };
}

export function DocumentSplitHandle({ label, width, min = minimum, max, reverse = false, onResize, scrollRef, toolbarRef }: { label: string; width: number; min?: number; max: number; reverse?: boolean; onResize(width: number): void; scrollRef?: RefObject<HTMLElement | null>; toolbarRef?: RefObject<HTMLElement | null> }) {
  const drag = useRef<{ id: number; x: number; y: number; width: number; scroll: number; scale: number; axis: 'scroll' | 'resize' | null } | null>(null), element = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ inset: 0, viewport: 0, extent: 0, top: 0 });
  useLayoutEffect(() => {
    const pane = scrollRef?.current, toolbar = toolbarRef?.current, track = element.current;
    if (!pane || !toolbar || !track) return;
    const update = () => {
      if (!pane.clientHeight) return;
      const inset = toolbar.offsetHeight, viewport = Math.max(0, pane.clientHeight - inset), extent = Math.max(viewport, pane.scrollHeight - inset);
      const top = Math.max(0, Math.min(extent - viewport, pane.scrollTop));
      setScroll(current => current.inset === inset && current.viewport === viewport && current.extent === extent && current.top === top ? current : { inset, viewport, extent, top });
    };
    const resize = new ResizeObserver(update), mutation = new MutationObserver(update);
    resize.observe(pane); resize.observe(toolbar);
    const tree = pane.querySelector('.document-tree'); if (tree) resize.observe(tree);
    mutation.observe(pane, { childList: true, subtree: true });
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || !event.deltaY) return;
      event.preventDefault();
      pane.scrollTop += event.deltaY * (event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? pane.clientHeight - toolbar.offsetHeight : 1);
    };
    track.addEventListener('wheel', wheel, { passive: false });
    pane.addEventListener('scroll', update, { passive: true }); update();
    return () => { resize.disconnect(); mutation.disconnect(); pane.removeEventListener('scroll', update); track.removeEventListener('wheel', wheel); };
  }, [scrollRef, toolbarRef]);
  const range = scroll.extent - scroll.viewport;
  const thumbHeight = Math.min(scroll.viewport, Math.max(24, scroll.viewport * scroll.viewport / (scroll.extent || 1)));
  const travel = scroll.viewport - thumbHeight;
  const resizeAccessibility = { role: 'separator' as const, 'aria-label': label, 'aria-orientation': 'vertical' as const, 'aria-valuemin': min, 'aria-valuemax': Math.round(max), 'aria-valuenow': Math.round(width), tabIndex: 0 };
  function release() {
    const current = drag.current; drag.current = null;
    if (current && element.current?.hasPointerCapture(current.id)) element.current.releasePointerCapture(current.id);
  }
  useEffect(() => release, []);
  return <div ref={element} className="document-split-handle" {...!scrollRef && resizeAccessibility} style={scrollRef ? { marginTop: scroll.inset, minHeight: 0 } : undefined}
    onPointerDown={event => {
      if (event.button !== 0) return;
      event.preventDefault();
      const thumb = (event.target as HTMLElement).closest<HTMLElement>('[role=scrollbar]');
      (thumb ?? event.currentTarget.querySelector<HTMLElement>('[role=separator]') ?? event.currentTarget).focus({ preventScroll: true });
      drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, width, scroll: scrollRef?.current?.scrollTop ?? 0, scale: travel > 0 ? range / travel : 0, axis: thumb ? null : 'resize' };
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event => {
      const current = drag.current; if (current?.id !== event.pointerId) return;
      const dx = event.clientX - current.x, dy = event.clientY - current.y;
      if (!current.axis) { if (Math.max(Math.abs(dx), Math.abs(dy)) < 4) return; current.axis = Math.abs(dy) > Math.abs(dx) ? 'scroll' : 'resize'; }
      if (current.axis === 'scroll') { if (scrollRef?.current) scrollRef.current.scrollTop = current.scroll + dy * current.scale; }
      else onResize(current.width + dx * (reverse ? -1 : 1));
    }}
    onPointerUp={release} onPointerCancel={release} onLostPointerCapture={release}
    onKeyDown={event => {
      if ((event.target as HTMLElement).getAttribute('role') === 'scrollbar') {
        const pane = scrollRef?.current;
        if (!pane || !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        pane.scrollTop = event.key === 'Home' ? 0 : event.key === 'End' ? range : pane.scrollTop + (event.key === 'ArrowUp' ? -40 : event.key === 'ArrowDown' ? 40 : event.key === 'PageUp' ? -scroll.viewport : scroll.viewport);
      } else {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); onResize(event.key === 'Home' ? min : event.key === 'End' ? max : width + (event.key === 'ArrowRight' ? 16 : -16) * (reverse ? -1 : 1));
      }
    }}>
    {scrollRef && <div className="document-resize-hitbox" {...resizeAccessibility} />}
    {scrollRef && range > 0 && travel > 0 && <div className="document-scroll-thumb" role="scrollbar" aria-label="滚动文档目录" aria-controls={scrollRef.current?.id} aria-orientation="vertical" aria-valuemin={0} aria-valuemax={range} aria-valuenow={Math.round(scroll.top)} tabIndex={0} title="上下拖动滚动目录，左右拖动调整宽度" style={{ height: thumbHeight, top: scroll.top / range * travel }} />}
  </div>;
}
