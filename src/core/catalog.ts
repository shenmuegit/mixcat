import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ensureProjectDirectory } from './paths.js';
import type { CapabilityCatalog, CodexPort, PluginSelection, ReasoningEffortOption } from '../shared/types.js';

const safeName = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
function versionOrder(left: string, right: string): number {
  if (left === 'local' || right === 'local') return left === right ? 0 : left === 'local' ? 1 : -1;
  const pattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
  const a = pattern.exec(left), b = pattern.exec(right);
  const compare = (x: string, y: string) => x === y ? 0 : x < y ? -1 : 1;
  if (!a || !b) return compare(left, right);
  for (let i = 1; i <= 3; i++) if (BigInt(a[i]) !== BigInt(b[i])) return BigInt(a[i]) < BigInt(b[i]) ? -1 : 1;
  if (!a[4] || !b[4]) return a[4] === b[4] ? 0 : a[4] ? -1 : 1;
  const preA = a[4].split('.'), preB = b[4].split('.');
  for (let i = 0; i < Math.max(preA.length, preB.length); i++) {
    if (preA[i] === undefined || preB[i] === undefined) return preA[i] === undefined ? -1 : 1;
    if (preA[i] === preB[i]) continue;
    const numericA = /^\d+$/.test(preA[i]), numericB = /^\d+$/.test(preB[i]);
    return numericA && numericB ? (BigInt(preA[i]) < BigInt(preB[i]) ? -1 : 1) : numericA !== numericB ? numericA ? -1 : 1 : compare(preA[i], preB[i]);
  }
  return 0;
}
export function hostCodexHome() { return process.env.MIXCAT_HOST_CODEX_HOME ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'); }
export function capabilityFingerprint(path: string) {
  const hash = createHash('sha256'), pending = [path];
  while (pending.length) {
    const file = pending.pop()!, stat = lstatSync(file);
    hash.update(file);
    if (stat.isSymbolicLink()) hash.update(readlinkSync(file));
    else if (stat.isDirectory()) pending.push(...readdirSync(file).sort().map(name => join(file, name)));
    else hash.update(readFileSync(file));
  }
  return hash.digest('hex');
}
function cachedPlugins(home: string) {
  const root = join(home, 'plugins', 'cache');
  const plugins: { id: string; name: string; description?: string; version: string; fingerprint: string }[] = [];
  if (!existsSync(root)) return plugins;
  for (const marketplace of readdirSync(root, { withFileTypes: true }).filter(x => x.isDirectory() && safeName.test(x.name))) {
    for (const plugin of readdirSync(join(root, marketplace.name), { withFileTypes: true }).filter(x => x.isDirectory() && safeName.test(x.name))) {
      const base = join(root, marketplace.name, plugin.name);
      const versions = readdirSync(base, { withFileTypes: true }).filter(x => x.isDirectory() && /^[\w.+-]+$/.test(x.name)).map(x => x.name).sort((a, b) => versionOrder(b, a));
      for (const version of versions) {
        const source = join(base, version);
        const manifest = ['.codex-plugin/plugin.json', '.claude-plugin/plugin.json', '.cursor-plugin/plugin.json', 'plugin.json'].map(p => join(source, p)).find(file => existsSync(file) && lstatSync(file).isFile());
        if (!manifest) continue;
        const metadata = JSON.parse(readFileSync(manifest, 'utf8'));
        if (metadata.name !== plugin.name) continue;
        plugins.push({ id: `${plugin.name}@${marketplace.name}`, name: plugin.name, ...(typeof metadata.description === 'string' ? { description: metadata.description } : {}), version: typeof metadata.version === 'string' ? metadata.version : version, fingerprint: capabilityFingerprint(base) });
        break;
      }
    }
  }
  return plugins;
}

export async function ensureSelectedPlugins(client: CodexPort, cwd: string, selections: PluginSelection[]): Promise<void> {
  if (!selections.length) return;
  ensureProjectDirectory(cwd);
  const available = await client.rpc('plugin/installed', { cwds: [cwd] });
  if (!Array.isArray(available?.marketplaces)) throw new Error('无法确认项目内已安装的插件。');
  const installed = new Set<string>(available.marketplaces.flatMap((m: any) => (m.plugins ?? []).filter((p: any) => p.installed && p.enabled).map((p: any) => p.id)));
  for (const selection of selections) {
    if (installed.has(selection.id)) continue;
    throw new Error(`插件尚未在当前项目原生安装，请先准备模板能力或通过官方 Codex 管理安装：${selection.name}`);
  }
}

export async function loadModels(client: CodexPort, models: CapabilityCatalog['models'] = []): Promise<CapabilityCatalog['models']> {
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const page = await client.rpc('model/list', { limit: 100, includeHidden: true, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(page?.data)) throw new Error('Invalid model catalog response');
    for (const model of page.data) {
      if (typeof model?.model !== 'string' || typeof model.displayName !== 'string') throw new Error('Invalid model catalog entry');
      const options = model.supportedReasoningEfforts, defaultEffort = model.defaultReasoningEffort;
      if (options !== undefined && (!Array.isArray(options) || options.some(option => typeof option?.reasoningEffort !== 'string' || !option.reasoningEffort.trim() || typeof option.description !== 'string'))) throw new Error('Invalid model reasoning effort options');
      if (defaultEffort !== undefined && defaultEffort !== null && (typeof defaultEffort !== 'string' || !defaultEffort.trim())) throw new Error('Invalid model default reasoning effort');
      if (!models.some(entry => entry.id === model.model)) models.push({ id: model.model, name: model.displayName, isDefault: model.isDefault === true,
        ...(options !== undefined ? { supportedReasoningEfforts: options.map((option: ReasoningEffortOption) => ({ reasoningEffort: option.reasoningEffort, description: option.description })) } : {}),
        ...(defaultEffort !== undefined ? { defaultReasoningEffort: defaultEffort } : {}),
      });
    }
    cursor = page.nextCursor ?? null;
    if (cursor !== null && (typeof cursor !== 'string' || !cursor || seen.has(cursor))) throw new Error('Invalid or repeated model catalog cursor');
    if (cursor) seen.add(cursor);
  } while (cursor !== null);
  return models;
}

export async function loadCapabilityCatalog(client: CodexPort, cwd: string, forceReload = false): Promise<CapabilityCatalog> {
  const catalog: CapabilityCatalog = { models: [], skills: [], plugins: [], errors: [] };
  let projectPlugins = new Map<string, ReturnType<typeof cachedPlugins>[number]>();
  try { projectPlugins = new Map(cachedPlugins(join(cwd, '.mixcat', 'codex')).map(plugin => [plugin.id, plugin])); }
  catch { catalog.errors.push('项目插件缓存元数据无法读取，请核对已有安装。'); }
  const errors = (method: string, entries: unknown) => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) if (typeof entry?.message === 'string') catalog.errors.push(`${method}: ${entry.message}`);
  };
  const methods = ['model/list', 'skills/list', 'plugin/installed'];
  const results = await Promise.allSettled([
    loadModels(client, catalog.models),
    (async () => {
      const response = await client.rpc('skills/list', { cwds: [cwd], ...(forceReload ? { forceReload: true } : {}) });
      if (!Array.isArray(response?.data)) throw new Error('Invalid skills response');
      for (const group of response.data) {
        errors('skills/list', group.errors);
        if (!Array.isArray(group?.skills)) throw new Error('Invalid skills entry');
        for (const skill of group.skills) {
          if (!skill?.enabled) continue;
          if (typeof skill.name !== 'string' || typeof skill.path !== 'string') throw new Error('Invalid skill');
          if (!catalog.skills.some(entry => entry.path === skill.path)) catalog.skills.push({ name: skill.name, path: skill.path, ...(typeof skill.description === 'string' ? { description: skill.description } : {}) });
        }
      }
    })(),
    (async () => {
      const response = await client.rpc('plugin/installed', { cwds: [cwd] });
      if (!Array.isArray(response?.marketplaces)) throw new Error('Invalid installed plugins response');
      errors('plugin/installed', response.marketplaceLoadErrors);
      for (const marketplace of response.marketplaces) {
        if (!Array.isArray(marketplace?.plugins)) throw new Error('Invalid plugin marketplace');
        for (const plugin of marketplace.plugins) {
          if (!plugin?.installed) continue;
          if (typeof plugin.id !== 'string' || typeof plugin.name !== 'string') throw new Error('Invalid installed plugin');
          const description = plugin.interface?.shortDescription;
          const cached = projectPlugins.get(plugin.id), version = typeof plugin.version === 'string' ? plugin.version : cached?.version;
          if (!catalog.plugins.some(entry => entry.id === plugin.id)) catalog.plugins.push({ id: plugin.id, name: typeof plugin.interface?.displayName === 'string' ? plugin.interface.displayName : plugin.name, ...(plugin.enabled ? {} : { enabled: false }), ...(typeof description === 'string' ? { description } : {}), ...(version ? { version } : {}), ...(cached ? { fingerprint: cached.fingerprint } : {}) });
        }
      }
    })(),
  ]);
  for (const [index, result] of results.entries()) if (result.status === 'rejected') catalog.errors.push(`${methods[index]}: ${result.reason instanceof Error ? result.reason.message : 'Discovery failed'}`);
  try {
    for (const plugin of cachedPlugins(hostCodexHome())) if (!catalog.plugins.some(entry => entry.id === plugin.id)) catalog.plugins.push({ ...plugin, installed: false });
  } catch (error) { catalog.errors.push(`宿主插件目录: ${error instanceof Error ? error.message : '读取失败'}`); }
  return catalog;
}

export async function loadRuntimeCapabilities(client: CodexPort, cwd: string, threadId?: string) {
  const hooks: NonNullable<CapabilityCatalog['hooks']> = [], mcpServers: NonNullable<CapabilityCatalog['mcpServers']> = [], errors: string[] = [];
  const results = await Promise.allSettled([
    (async () => {
      const response = await client.rpc('hooks/list', { cwds: [cwd] });
      if (!Array.isArray(response?.data)) throw new Error('原生 hooks 目录响应无效。');
      for (const group of response.data) {
        if (!Array.isArray(group.hooks)) throw new Error('原生 hooks 条目无效。');
        for (const error of group.errors ?? []) if (typeof error.message === 'string') errors.push(`hooks/list: ${error.message}`);
        for (const warning of group.warnings ?? []) if (typeof warning === 'string') errors.push(`hooks/list: ${warning}`);
        for (const hook of group.hooks) {
          if (typeof hook.eventName !== 'string' || typeof hook.sourcePath !== 'string' || typeof hook.key !== 'string' || typeof hook.enabled !== 'boolean' || typeof hook.trustStatus !== 'string') throw new Error('原生 hook 状态无效。');
          hooks.push({ eventName: hook.eventName, enabled: hook.enabled, trustStatus: hook.trustStatus, sourcePath: hook.sourcePath, key: hook.key, currentHash: typeof hook.currentHash === 'string' ? hook.currentHash : null,
            ...(typeof hook.command === 'string' ? { command: hook.command } : {}), ...(typeof hook.matcher === 'string' || hook.matcher === null ? { matcher: hook.matcher } : {}) });
        }
      }
    })(),
    (async () => {
      let cursor: string | null = null; const seen = new Set<string>();
      do {
        const response = await client.rpc('mcpServerStatus/list', { ...(threadId ? { threadId } : {}), limit: 100, ...(cursor ? { cursor } : {}) });
        if (!Array.isArray(response?.data)) throw new Error('原生 MCP 状态响应无效。');
        for (const server of response.data) {
          if (typeof server.name !== 'string' || !server.tools || typeof server.tools !== 'object' || Array.isArray(server.tools)) throw new Error('原生 MCP 状态条目无效。');
          mcpServers.push({ name: server.name, toolCount: Object.keys(server.tools).length, status: typeof server.toolsError === 'string' && server.toolsError ? 'failed' : typeof server.runtimeStatus === 'string' ? server.runtimeStatus : 'unknown' });
          if (server.toolsError) errors.push(`MCP「${server.name}」工具发现失败。`);
        }
        cursor = response.nextCursor ?? null;
        if (cursor !== null && (typeof cursor !== 'string' || !cursor || seen.has(cursor))) throw new Error('原生 MCP 状态分页游标无效。');
        if (cursor) seen.add(cursor);
      } while (cursor !== null);
    })(),
  ]);
  for (const [index, result] of results.entries()) if (result.status === 'rejected') errors.push(`${index === 0 ? 'hooks/list' : 'mcpServerStatus/list'}: ${result.reason instanceof Error ? result.reason.message : '状态不可读取。'}`);
  return { hooks, mcpServers, errors };
}
