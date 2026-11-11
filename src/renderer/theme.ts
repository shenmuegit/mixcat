export function readTheme(): 'light' | 'dark' {
  try { return localStorage.getItem('mixcat.theme') === 'dark' ? 'dark' : 'light'; }
  catch { return 'light'; }
}

export function applyTheme(theme: 'light' | 'dark') {
  document.documentElement.dataset.theme = theme;
  return window.mixcat?.setTheme?.(theme) ?? Promise.resolve();
}
