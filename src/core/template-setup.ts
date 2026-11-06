import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { CapabilityCatalog, CodexPort, NodeDefinition } from '../shared/types.js';
import type { BuiltinTemplateId } from '../shared/templates.js';
import type { ExistingTemplateCapability, TemplateCapabilityId, TemplateCapabilityItem, TemplateSetupDecision, TemplateSetupProgress, TemplateSetupReport } from '../shared/template-setup.js';
import { insideProject } from './paths.js';
import { hostCodexHome } from './catalog.js';
import { createWebProductTemplate } from './web-product.js';
import { createWorkflowTemplate } from './workflow-templates.js';
import { findWorkflowSkill, recommendedCapabilities, workflowSkillProvider } from './workflow-capabilities.js';

export const TEMPLATE_CAPABILITIES = [
  { id: 'ecc', name: 'ECC', kind: 'plugin', source: 'https://github.com/affaan-m/ECC', sparsePaths: ['.claude-plugin', '.codex-plugin', 'skills', 'hooks', 'scripts', 'agents', 'rules', 'contexts', 'assets'] },
  { id: 'superpowers', name: 'Superpowers', kind: 'plugin', source: 'https://github.com/obra/superpowers-marketplace' },
  { id: 'planning-with-files', name: 'planning-with-files', kind: 'plugin', source: 'https://github.com/OthmanAdi/planning-with-files', sparsePaths: ['.claude-plugin', '.codex-plugin', '.agents', '.codex', 'skills', 'hooks', 'scripts', 'assets'] },
  { id: 'ponytail', name: 'Ponytail', kind: 'plugin', source: 'https://github.com/DietrichGebert/ponytail', sparsePaths: ['.claude-plugin', '.codex-plugin', 'skills', 'hooks', 'scripts', 'assets'] },
  { id: 'gitnexus', name: 'GitNexus', kind: 'plugin', source: 'https://github.com/abhigyanpatwari/GitNexus', sparsePaths: ['.claude-plugin', 'gitnexus-claude-plugin'] },
  { id: 'impeccable', name: 'Impeccable', kind: 'skill', source: 'https://github.com/pbakaus/impeccable' },
] as const;

export function templateRequirements(template: BuiltinTemplateId) {
  const nodes = template === 'web-product' ? createWebProductTemplate().nodes : createWorkflowTemplate(template).nodes;
  const recommendations = nodes.map(node => recommendedCapabilities(node.id));
  const skills = [...new Set(recommendations.flatMap(item => item.skills))];
  const units = new Set([...recommendations.flatMap(item => item.plugins), ...skills.map(workflowSkillProvider)]);
  return TEMPLATE_CAPABILITIES.filter(item => units.has(item.id)).map(item => ({ ...item, skills: skills.filter(skill => workflowSkillProvider(skill) === item.id) }));
}

function fileObservation(path: string) {
  const stat = lstatSync(path);
  if (!stat.isFile()) return 'unavailable';
  return createHash('sha256').update(stat.size <= 1024 * 1024 ? readFileSync(path) : `${stat.size}:${stat.mtimeMs}`).digest('hex');
}
export function standaloneSkillDirectories(root: string, names: string[]) {
  if (!existsSync(root)) return [];
  const wanted = new Set(names.map(value => value.split(':').at(-1)!));
  return readdirSync(root).filter(name => wanted.has(name) || wanted.has('impeccable') && name.endsWith('-impeccable')).map(name => join(root, name));
}
function skillDirectories(roots: string[], names: string[], scope: 'project' | 'codex'): ExistingTemplateCapability[] {
  const result: ExistingTemplateCapability[] = [];
  for (const root of roots) for (const path of standaloneSkillDirectories(root, names)) {
    const hash = createHash('sha256'), pending = [path];
    while (pending.length) {
      const file = pending.pop()!, stat = lstatSync(file);
      hash.update(file);
      if (stat.isSymbolicLink()) hash.update(readlinkSync(file));
      else if (stat.isDirectory()) pending.push(...readdirSync(file).sort().map(name => join(file, name)));
      else hash.update(fileObservation(file));
    }
    result.push({ scope, name: path.slice(root.length + 1), fingerprint: `${path}:${hash.digest('hex')}` });
  }
  return result;
}

export function capabilityReady(item: Pick<TemplateCapabilityItem, 'id' | 'kind' | 'skills'>, catalog: CapabilityCatalog) {
  return (item.kind === 'skill' || catalog.plugins.filter(plugin => plugin.installed !== false && plugin.enabled !== false && plugin.id.split('@')[0].toLowerCase() === item.id).length === 1)
    && item.skills.every(skill => !!findWorkflowSkill(catalog, skill));
}

export function inspectTemplateSetup(projectId: string, template: BuiltinTemplateId, root: string, nodes: NodeDefinition[], catalog: CapabilityCatalog, previous?: TemplateSetupProgress): TemplateSetupReport {
  const home = hostCodexHome();
  const items: TemplateCapabilityItem[] = templateRequirements(template).map(requirement => {
    const existing: ExistingTemplateCapability[] = catalog.plugins.filter(plugin => plugin.id.split('@')[0].toLowerCase() === requirement.id).map(plugin => ({ scope: plugin.installed === false ? 'codex' : 'project', name: plugin.name, version: plugin.version, fingerprint: `${plugin.id}:${plugin.version ?? ''}:${plugin.installed !== false}:${plugin.enabled !== false}` }));
    for (const wanted of requirement.skills) {
      const skill = findWorkflowSkill(catalog, wanted, root);
      if (skill) {
        const part = relative(root, skill.path), local = !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`);
        existing.push({ scope: local ? 'project' : 'codex', name: skill.name, fingerprint: `${skill.path}:${existsSync(skill.path) ? fileObservation(skill.path) : 'native'}` });
      }
    }
    existing.push(...skillDirectories([join(root, '.agents', 'skills'), join(root, '.codex', 'skills')], requirement.skills, 'project'));
    existing.push(...skillDirectories([join(home, 'skills'), join(dirname(home), '.agents', 'skills')], requirement.skills, 'codex'));
    const prior = previous?.items.find(item => item.id === requirement.id);
    const installed = prior?.state === 'installed' && capabilityReady(requirement, catalog) && JSON.stringify(existing) === JSON.stringify(prior.existing);
    return { id: requirement.id, name: requirement.name, kind: requirement.kind, skills: requirement.skills, existing, state: installed ? 'installed' : prior?.state === 'unknown' || prior?.state === 'installing' ? 'unknown' : existing.length ? 'existing' : 'missing' };
  });
  const observation = createHash('sha256').update(JSON.stringify({ template, root, nodes: nodes.map(node => [node.id, node.revision]), items })).digest('hex');
  const discoveryErrors = catalog.errors.filter(error => /^(skills\/list|plugin\/installed|宿主插件目录|项目插件缓存)/.test(error));
  return { projectId, template, target: root, observation, needsChoices: items.some(item => item.state === 'existing' || item.state === 'unknown'), items, status: 'pending', ...(discoveryErrors.length ? { blocked: true, message: `无法确认已有能力，尚未安装：${discoveryErrors.join('；')}` } : {}) };
}

export function setupDecisionReady(report: TemplateSetupReport, decision?: TemplateSetupDecision) {
  if (decision) {
    if (typeof decision.observation !== 'string' || !decision.choices || typeof decision.choices !== 'object' || Array.isArray(decision.choices)
      || Object.entries(decision.choices).some(([id, value]) => !report.items.some(item => item.id === id) || !['overwrite', 'skip'].includes(value ?? ''))) throw new Error('模板能力选择不正确，请重新检查。');
    if (decision.observation !== report.observation) { report.needsChoices = true; report.message = '已有能力或节点配置发生变化，请重新选择覆盖或跳过。'; return false; }
  }
  return !report.blocked && report.items.every(item => item.state !== 'existing' && item.state !== 'unknown' || decision?.choices[item.id] !== undefined);
}

export async function installTemplateCapability(client: CodexPort, root: string, id: TemplateCapabilityId, overwrite: boolean, installSkill: (root: string, overwrite: boolean) => Promise<void>, current: () => void) {
  const definition = TEMPLATE_CAPABILITIES.find(item => item.id === id)!;
  current();
  if (definition.kind === 'skill') { await installSkill(root, overwrite); current(); return { needsAuth: false }; }
  const added = await client.rpc('marketplace/add', { source: definition.source, ...('sparsePaths' in definition ? { sparsePaths: [...definition.sparsePaths] } : {}) }, 180000); current();
  if (typeof added?.marketplaceName !== 'string' || typeof added.installedRoot !== 'string') throw new Error('官方市场注册未返回安装位置。');
  const installedRoot = insideProject(root, added.installedRoot);
  const list = await client.rpc('plugin/list', { cwds: [root], forceRefetch: false }); current();
  const market = list?.marketplaces?.find((item: any) => item.name === added.marketplaceName && item.plugins?.some((plugin: any) => plugin.name === id));
  if (typeof market?.path !== 'string') throw new Error(`官方市场未提供 ${definition.name} 的安装入口。`);
  const marketplacePath = insideProject(root, market.path), part = relative(installedRoot, marketplacePath);
  if (part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)) throw new Error('官方市场位置发生变化，请重新检查。');
  const nativeId = market.plugins.find((plugin: any) => plugin.name === id)?.id;
  if (typeof nativeId !== 'string') throw new Error('官方市场未提供原生插件标识。');
  const before = await client.rpc('plugin/installed', { cwds: [root] }); current();
  if (!Array.isArray(before?.marketplaces) || before.marketplaceLoadErrors?.length) throw new Error('无法确认已有原生插件，请重新检查。');
  const superseded: string[] = [];
  for (const previous of before.marketplaces) for (const plugin of previous.plugins ?? []) {
    if (!plugin.installed || typeof plugin.id !== 'string' || plugin.id.split('@')[0].toLowerCase() !== id || plugin.id === nativeId) continue;
    if (!overwrite) throw new Error('发现同名原生插件，请重新选择覆盖或跳过。');
    if (typeof previous.path !== 'string') throw new Error('已有同名插件由其他 Codex 环境管理，请先通过官方插件管理处理，或跳过此项。');
    insideProject(root, previous.path);
    superseded.push(plugin.id);
  }
  const result = await client.rpc('plugin/install', { marketplacePath, pluginName: id, installAttemptId: randomUUID() }, 180000); current();
  if (!Array.isArray(result?.appsNeedingAuth)) throw Object.assign(new Error('原生安装结果不完整，请重新检查实际能力。'), { outcome: 'unknown' });
  if (superseded.length) {
    const installed = await client.rpc('plugin/installed', { cwds: [root] }); current();
    if (!installed?.marketplaces?.some((entry: any) => entry.plugins?.some((plugin: any) => plugin.id === nativeId && plugin.installed && plugin.enabled))) throw new Error('新插件尚未确认可用，已保留旧安装。');
    for (const pluginId of superseded) { await client.rpc('plugin/uninstall', { pluginId }, 180000); current(); }
  }
  return { needsAuth: result.appsNeedingAuth.length > 0 };
}
