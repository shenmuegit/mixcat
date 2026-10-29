export function Icon({ name, size = 18 }: { name: 'plus' | 'arrow' | 'back' | 'close' | 'folder' | 'play' | 'nodes' | 'check'; size?: number }) {
  const paths = { plus: 'M12 5v14M5 12h14', arrow: 'M5 12h14m-6-6 6 6-6 6', back: 'M19 12H5m6-6-6 6 6 6', close: 'm6 6 12 12M18 6 6 18', folder: 'M3 6h7l2 3h9v11H3V6Z', play: 'm8 5 11 7-11 7V5Z', nodes: 'M3 4h6v6H3zM15 14h6v6h-6zM6 10v7h9M9 7h9v7', check: 'm5 12 4 4L19 6' };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
