import { useEffect, useRef, useState, type CSSProperties } from 'react';

const minimum = 160, contentMinimum = 280, handleWidth = 6;

export function useDocumentSplit(active: boolean, sidebar: boolean) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [widths, setWidths] = useState({ tree: 240, outline: 230 });
  const [available, setAvailable] = useState(0);
  function clamp(next: typeof widths, width: number) {
    if (width <= 0) return next;
    const budget = width - contentMinimum - handleWidth * (sidebar ? 2 : 1);
    const outline = sidebar ? Math.max(minimum, Math.min(360, next.outline, budget - minimum)) : next.outline;
    const tree = Math.max(minimum, Math.min(460, next.tree, budget - (sidebar ? outline : 0)));
    return { tree, outline };
  }
  useEffect(() => {
    const element = bodyRef.current;
    if (!active || !element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width <= 0) return;
      setAvailable(entry.contentRect.width);
      setWidths(current => {
        const next = clamp(current, entry.contentRect.width);
        return next.tree === current.tree && next.outline === current.outline ? current : next;
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [active, sidebar]);
  const maxTree = Math.max(minimum, Math.min(460, available ? available - contentMinimum - handleWidth * (sidebar ? 2 : 1) - (sidebar ? widths.outline : 0) : 460));
  const maxOutline = Math.max(minimum, Math.min(360, available ? available - contentMinimum - handleWidth * 2 - widths.tree : 360));
  return {
    bodyRef, widths, maxTree, maxOutline,
    style: active ? { gridTemplateColumns: `${widths.tree}px ${handleWidth}px minmax(${contentMinimum}px,1fr)${sidebar ? ` ${handleWidth}px ${widths.outline}px` : ''}` } as CSSProperties : undefined,
    resize: (pane: 'tree' | 'outline', value: number) => setWidths(current => clamp({ ...current, [pane]: Math.max(minimum, Math.min(pane === 'tree' ? maxTree : maxOutline, value)) }, bodyRef.current?.getBoundingClientRect().width ?? 0)),
  };
}

export function DocumentSplitHandle({ label, width, max, reverse = false, onResize }: { label: string; width: number; max: number; reverse?: boolean; onResize(width: number): void }) {
  const drag = useRef<{ id: number; x: number; width: number } | null>(null), element = useRef<HTMLDivElement>(null);
  function release() {
    const current = drag.current; drag.current = null;
    if (current && element.current?.hasPointerCapture(current.id)) element.current.releasePointerCapture(current.id);
  }
  useEffect(() => release, []);
  return <div ref={element} className="document-split-handle" role="separator" aria-label={label} aria-orientation="vertical" aria-valuemin={minimum} aria-valuemax={Math.round(max)} aria-valuenow={Math.round(width)} tabIndex={0}
    onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); drag.current = { id: event.pointerId, x: event.clientX, width }; event.currentTarget.setPointerCapture(event.pointerId); }}
    onPointerMove={event => { const current = drag.current; if (current?.id === event.pointerId) onResize(current.width + (event.clientX - current.x) * (reverse ? -1 : 1)); }}
    onPointerUp={release} onPointerCancel={release} onLostPointerCapture={release}
    onKeyDown={event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); onResize(event.key === 'Home' ? minimum : event.key === 'End' ? max : width + (event.key === 'ArrowRight' ? 16 : -16) * (reverse ? -1 : 1)); }} />;
}
