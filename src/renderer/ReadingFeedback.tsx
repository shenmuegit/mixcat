import type { UIEvent } from 'react';

export function updateScrollEdge({ currentTarget }: UIEvent<HTMLElement>) {
  const distance = Math.max(0, currentTarget.scrollTop);
  currentTarget.style.setProperty('--scroll-edge-opacity', String(Math.min(distance / 24, 1)));
  currentTarget.toggleAttribute('data-scrolled', distance > 0);
}

export function ReadingPlaceholder({ label, list = false }: { label: string; list?: boolean }) {
  return <div className={`reading-placeholder${list ? ' reading-placeholder-list' : ''}`} role="status">
    <span className="visually-hidden">{label}</span>
    <div className="reading-placeholder-lines" aria-hidden="true"><span /><span /><span />{!list && <span />}</div>
  </div>;
}
