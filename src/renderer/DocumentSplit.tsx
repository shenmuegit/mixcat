import { useEffect, useRef, useState, type CSSProperties } from 'react';

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

export function DocumentSplitHandle({ label, width, min = minimum, max, reverse = false, onResize }: { label: string; width: number; min?: number; max: number; reverse?: boolean; onResize(width: number): void }) {
  const drag = useRef<{ id: number; x: number; width: number } | null>(null), element = useRef<HTMLDivElement>(null);
  function release() {
    const current = drag.current; drag.current = null;
    if (current && element.current?.hasPointerCapture(current.id)) element.current.releasePointerCapture(current.id);
  }
  useEffect(() => release, []);
  return <div ref={element} className="document-split-handle" role="separator" aria-label={label} aria-orientation="vertical" aria-valuemin={min} aria-valuemax={Math.round(max)} aria-valuenow={Math.round(width)} tabIndex={0}
    onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); drag.current = { id: event.pointerId, x: event.clientX, width }; event.currentTarget.setPointerCapture(event.pointerId); }}
    onPointerMove={event => { const current = drag.current; if (current?.id === event.pointerId) onResize(current.width + (event.clientX - current.x) * (reverse ? -1 : 1)); }}
    onPointerUp={release} onPointerCancel={release} onLostPointerCapture={release}
    onKeyDown={event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); onResize(event.key === 'Home' ? min : event.key === 'End' ? max : width + (event.key === 'ArrowRight' ? 16 : -16) * (reverse ? -1 : 1)); }} />;
}
