import { execFile } from 'node:child_process';
import type { CodexPort, PluginSelection } from '../shared/types.js';
import { projectDirectory } from './paths.js';

interface OfficialPlugin { id: string; name: string; displayName: string; marketplace: string; path: string | null; installed: boolean; enabled: boolean; }
function nativePlugins(response: any): OfficialPlugin[] {
  if (!Array.isArray(response?.marketplaces)) throw new Error('原生官方插件目录响应无效。');
  if (response.marketplaceLoadErrors?.length) throw new Error('原生官方插件市场读取失败。');
  return response.marketplaces.flatMap((marketplace: any) => {
    if (typeof marketplace.name !== 'string' || (marketplace.path != null && typeof marketplace.path !== 'string') || !Array.isArray(marketplace.plugins)) throw new Error('原生官方插件市场坐标无效。');
    return marketplace.plugins.map((plugin: any) => { if (typeof plugin.id !== 'string' || typeof plugin.name !== 'string') throw new Error('原生插件标识无效。'); return { id: plugin.id, name: plugin.name, displayName: plugin.interface?.displayName ?? plugin.name, marketplace: marketplace.name, path: marketplace.path ?? null, installed: plugin.installed === true, enabled: plugin.enabled === true }; });
  });
}
async function hostJson(executable: string, cwd: string, args: string[]) {
  const directory = projectDirectory(cwd, '.codex', 'official-discovery');
  const stdout = await new Promise<string>((resolve, reject) => execFile(executable, ['-c', `log_dir=${JSON.stringify(directory)}`, 'plugin', ...args, '--json'], { cwd, windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, ...(process.env.MIXCAT_HOST_CODEX_HOME ? { CODEX_HOME: process.env.MIXCAT_HOST_CODEX_HOME } : {}), TEMP: directory, TMP: directory, TMPDIR: directory, XDG_CACHE_HOME: directory } }, (error, stdout) => error ? reject(new Error('无法通过官方 CLI 读取宿主插件注册。')) : resolve(stdout)));
  return JSON.parse(stdout);
}
type OfficialCliReader = (args: string[]) => Promise<any>;
async function discover(client: CodexPort, cwd: string, executable: string, missing?: Set<string>, readCli: OfficialCliReader = args => hostJson(executable, cwd, args)): Promise<OfficialPlugin[]> {
  let plugins = nativePlugins(await client.rpc('plugin/list', { cwds: [cwd] }));
  if (missing && [...missing].every(id => plugins.some(p => p.id === id))) return plugins;
  const registrations = await readCli(['marketplace', 'list']);
  if (!Array.isArray(registrations?.marketplaces)) throw new Error('官方 CLI 市场注册响应无效。');
  const roots: string[] = [];
  for (const market of registrations.marketplaces) {
    if (typeof market.name !== 'string' || typeof market.root !== 'string') continue;
    const listed = await readCli(['list', '--marketplace', market.name]);
    const records = [...(listed.installed ?? []), ...(listed.available ?? [])];
    if (!missing || records.some((p: any) => missing.has(p.pluginId))) roots.push(market.root);
  }
  if (roots.length) plugins = nativePlugins(await client.rpc('plugin/list', { cwds: [cwd, ...roots] }));
  return plugins;
}
export async function loadFeedPluginCatalog(client: CodexPort, cwd: string, executable: string) {
  let plugins = nativePlugins(await client.rpc('plugin/list', { cwds: [cwd] })); const errors: string[] = [];
  try { plugins = await discover(client, cwd, executable); } catch (error) { errors.push(error instanceof Error ? error.message : '官方宿主插件发现失败。'); }
  return { plugins: plugins.map(p => ({ id: p.id, name: p.displayName, installed: p.installed && p.enabled })), errors };
}
export async function ensureFeedPlugins(client: CodexPort, cwd: string, selections: PluginSelection[], executable: string, readCli?: OfficialCliReader): Promise<void> {
  if (!selections.length) return;
  const installed = nativePlugins(await client.rpc('plugin/installed', { cwds: [cwd] }));
  const missing = selections.filter(selection => !installed.some(p => p.id === selection.id && p.installed && p.enabled));
  if (!missing.length) return;
  // Renderer IDs select server-discovered coordinates; no supplied path or inferred repository is used.
  if (missing.some(p => p.id.includes('@mixcat-import-'))) throw new Error('该插件缺少官方原生市场坐标，请从个人采集目录重新选择。');
  const catalog = await discover(client, cwd, executable, new Set(missing.map(p => p.id)), readCli);
  for (const selection of missing) {
    const plugin = catalog.find(p => p.id === selection.id); if (!plugin) throw new Error(`插件缺少官方市场坐标：${selection.name}`);
    const coordinate = { ...(plugin.path ? { marketplacePath: plugin.path } : { remoteMarketplaceName: plugin.marketplace }), pluginName: plugin.name };
    const read = await client.rpc('plugin/read', coordinate);
    if (read.plugin?.marketplaceName !== plugin.marketplace || read.plugin?.summary?.id !== plugin.id || read.plugin?.summary?.name !== plugin.name) throw new Error('官方插件身份复核失败。');
    const receipt = await client.rpc('plugin/install', coordinate);
    if (receipt.appsNeedingAuth?.length) throw new Error(`插件仍需原生账号授权：${selection.name}`);
    const confirmed = nativePlugins(await client.rpc('plugin/installed', { cwds: [cwd] }));
    if (!confirmed.some(p => p.id === plugin.id && p.installed && p.enabled)) throw new Error(`原生安装未确认插件已启用：${selection.name}`);
  }
}
