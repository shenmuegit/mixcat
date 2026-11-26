import { useLayoutEffect, type RefObject } from 'react';

export type MenuLocation = { x: number; y: number; anchor?: HTMLElement; alignEnd?: boolean };

export function useActionMenuPosition(ref: RefObject<HTMLDivElement | null>, location: MenuLocation | null) {
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu || !location) return;
    const position = () => {
      const edge = 8, topEdge = 32;
      const width = menu.offsetWidth, height = menu.offsetHeight;
      const maxLeft = window.innerWidth - width - edge;
      const maxTop = window.innerHeight - height - edge;
      const anchor = location.anchor?.isConnected ? location.anchor.getBoundingClientRect() : undefined;
      const x = anchor ? (location.alignEnd ? anchor.right : anchor.left) : location.x;
      const y = anchor ? anchor.bottom + 4 : location.y;
      const left = location.alignEnd || x > maxLeft && x - width >= edge ? x - width : x;
      const above = (anchor ? anchor.top - 4 : y) - height;
      const flip = y > maxTop && above >= topEdge;
      menu.style.left = `${Math.max(edge, Math.min(left, maxLeft))}px`;
      menu.style.top = `${Math.max(topEdge, Math.min(flip ? above : y, maxTop))}px`;
      menu.toggleAttribute('data-above', flip);
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(menu);
    window.addEventListener('resize', position);
    if (location.anchor) {
      observer.observe(location.anchor);
      window.addEventListener('scroll', position, true);
    }
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
      if (location.anchor) window.removeEventListener('scroll', position, true);
    };
  }, [ref, location]);
}

export function moveMenuFocus(event: KeyboardEvent, menu: HTMLElement | null) {
  if (!menu?.contains(document.activeElement) || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const buttons = [...menu.querySelectorAll<HTMLButtonElement>('button[role=menuitem]:not(:disabled)')];
  if (!buttons.length) return;
  event.preventDefault();
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
    : current < 0 ? (event.key === 'ArrowUp' ? buttons.length - 1 : 0)
      : (current + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
  buttons[index]?.focus();
}
