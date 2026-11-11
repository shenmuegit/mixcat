export function readTheme(): 'light' | 'dark' {
  const applied = typeof document === 'undefined' ? undefined : document.documentElement.dataset.theme;
  if (applied === 'light' || applied === 'dark') return applied;
  try { return localStorage.getItem('mixcat.theme') === 'dark' ? 'dark' : 'light'; }
  catch { return 'light'; }
}

export function applyTheme(theme: 'light' | 'dark') {
  document.documentElement.dataset.theme = theme;
  return window.mixcat?.setTheme?.(theme) ?? Promise.resolve();
}
