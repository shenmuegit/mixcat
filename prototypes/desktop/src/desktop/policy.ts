export function allowedLoginUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.port && ['auth.openai.com', 'auth0.openai.com', 'chatgpt.com', 'openai.com'].includes(url.hostname); }
  catch { return false; }
}

export function panelUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 16384) throw new Error('网页地址不正确。');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('面板仅支持不含账号密码的 HTTP 或 HTTPS 地址。');
  return url.href;
}

export function panelBounds(value: unknown, size: { width: number; height: number }): { x: number; y: number; width: number; height: number } | null {
  if (value === null) return null;
  const bounds = value as Record<string, unknown>;
  if (!bounds || ['x', 'y', 'width', 'height'].some(key => typeof bounds[key] !== 'number' || !Number.isFinite(bounds[key]) || Number(bounds[key]) < 0)) throw new Error('面板显示范围不正确。');
  const x = Math.min(Math.round(Number(bounds.x)), size.width), y = Math.min(Math.round(Number(bounds.y)), size.height);
  return { x, y, width: Math.min(Math.round(Number(bounds.width)), size.width - x), height: Math.min(Math.round(Number(bounds.height)), size.height - y) };
}
