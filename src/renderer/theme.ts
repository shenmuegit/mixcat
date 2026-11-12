export function readTheme(): 'light' | 'dark' | 'violet' {
  const applied = typeof document === 'undefined' ? undefined : document.documentElement.dataset.theme;
  if (applied === 'light' || applied === 'dark' || applied === 'violet') return applied;
  try { const saved = localStorage.getItem('mixcat.theme'); return saved === 'dark' || saved === 'violet' ? saved : 'light'; }
  catch { return 'light'; }
}

export function applyTheme(theme: 'light' | 'dark' | 'violet') {
  document.documentElement.dataset.theme = theme;
  return window.mixcat?.setTheme?.(theme) ?? Promise.resolve();
}
