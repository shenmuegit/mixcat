import { useEffect, useId, useRef, type CSSProperties, type Ref } from 'react';
import { Icon } from './Icon';

export function NodeDetailsButton({ expanded, onClick, description, ref }: {
  expanded: boolean; onClick(): void; description?: string; ref?: Ref<HTMLButtonElement>;
}) {
  const id = useId(), anchor = `--node-details-${id.replace(/:/g, '')}`;
  const tooltip = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const label = expanded ? '收起节点详情' : '展开节点详情';
  useEffect(() => {
    function escape(event: KeyboardEvent) {
      const current = tooltip.current;
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || !current?.matches(':popover-open')) return;
      dismiss();
      if (document.querySelector('dialog:modal') || [...document.querySelectorAll('[role=menu], :popover-open')].some(layer => layer !== current && layer.getClientRects().length)) return;
      event.preventDefault();
      event.stopPropagation();
    }
    document.addEventListener('keydown', escape, true);
    return () => {
      clearTimeout(timer.current);
      document.removeEventListener('keydown', escape, true);
    };
  }, []);

  function show(button: HTMLButtonElement) {
    const current = tooltip.current;
    if (current && button.getClientRects().length && !current.matches(':popover-open')) current.showPopover();
  }

  function dismiss() {
    clearTimeout(timer.current);
    if (tooltip.current?.matches(':popover-open')) tooltip.current.hidePopover();
  }

  return <>
    <button ref={ref} type="button" className={`icon-button node-details-toggle${expanded ? ' dialog-close' : ''}`}
      aria-controls="node-details-drawer" aria-expanded={expanded} aria-label={label}
      aria-describedby={description ? `${id}-description` : undefined} style={{ anchorName: anchor } as CSSProperties}
      onPointerEnter={event => {
        if (event.pointerType === 'touch') return;
        const button = event.currentTarget;
        clearTimeout(timer.current);
        timer.current = setTimeout(() => show(button), 400);
      }} onPointerLeave={event => {
        clearTimeout(timer.current);
        if (!event.currentTarget.matches(':focus-visible')) dismiss();
      }}
      onFocus={event => { if (event.currentTarget.matches(':focus-visible')) show(event.currentTarget); }}
      onBlur={dismiss} onClick={() => { dismiss(); onClick(); }}><Icon name={expanded ? 'close' : 'panel'} size={16} /></button>
    <span ref={tooltip} role="tooltip" popover="manual" className="node-details-tooltip" style={{ positionAnchor: anchor } as CSSProperties}>
      {label}{description && <> · <span id={`${id}-description`}>{description}</span></>}
    </span>
  </>;
}
