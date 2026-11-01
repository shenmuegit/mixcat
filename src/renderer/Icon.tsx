export function Icon({ name, size = 18 }: { name: 'plus' | 'minus' | 'arrow' | 'back' | 'close' | 'folder' | 'play' | 'nodes' | 'check' | 'feed' | 'note' | 'book' | 'chevron' | 'bolt' | 'reset'; size?: number }) {
  const paths = { plus: 'M12 5v14M5 12h14', minus: 'M5 12h14', arrow: 'M5 12h14m-6-6 6 6-6 6', back: 'M19 12H5m6-6-6 6 6 6', close: 'm6 6 12 12M18 6 6 18', folder: 'M3 6h7l2 3h9v11H3V6Z', play: 'm8 5 11 7-11 7V5Z', nodes: 'M3 4h6v6H3zM15 14h6v6h-6zM6 10v7h9M9 7h9v7', check: 'm5 12 4 4L19 6',
    feed: 'M4 4h13v16H4V4ZM17 8h3v10a2 2 0 0 1-2 2H6M7 7h7v4H7V7ZM7 14h7M7 17h7',
    note: 'M12 4H4v16h16v-8M17 3l4 4-10 10-5 1 1-5L17 3ZM15 5l4 4',
    book: 'M12 5C9 3 6 3 3 4v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1ZM12 5v15',
    chevron: 'm9 6 6 6-6 6', bolt: 'm13 2-9 12h7l-1 8 10-13h-7l1-7Z', reset: 'M3 4v5h5M3.8 9a9 9 0 1 1 .6 8' };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
