export function popoverSpace(anchor: DOMRect, maxHeight: number, preferAbove: boolean) {
  const edge = 16, gap = 8;
  const above = anchor.top - edge - gap;
  const below = window.innerHeight - anchor.bottom - edge - gap;
  const openAbove = preferAbove ? above >= Math.min(maxHeight, below) : below < Math.min(maxHeight, above);
  return { openAbove, height: Math.max(0, Math.min(maxHeight, openAbove ? above : below)) };
}

export function placePopover(panel: HTMLElement, anchor: DOMRect, widthLimit: number, heightLimit: number) {
  const edge = 16, gap = 8;
  const { openAbove, height } = popoverSpace(anchor, heightLimit, false);
  const width = Math.min(widthLimit, window.innerWidth - edge * 2);
  const left = Math.max(edge, Math.min(anchor.left, window.innerWidth - width - edge));
  panel.style.width = `${width}px`;
  panel.style.maxHeight = `${height}px`;
  panel.style.left = `${left}px`;
  panel.style.top = openAbove ? 'auto' : `${anchor.bottom + gap}px`;
  panel.style.bottom = openAbove ? `${window.innerHeight - anchor.top + gap}px` : 'auto';
  panel.toggleAttribute('data-above', openAbove);
  panel.setAttribute('data-positioned', '');
}
