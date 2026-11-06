import type { CapabilityCatalog, NodeDefinition } from '../shared/types.js';
import type { TemplateCapabilityId } from '../shared/template-setup.js';
import { isAbsolute, relative, sep } from 'node:path';

const roleSkills: Record<string, string> = {
  product: 'ecc:product-lens', requirements: 'ecc:product-capability', design: 'impeccable', frontend: 'ecc:frontend-patterns', backend: 'ecc:backend-patterns', test: 'ecc:e2e-testing', architect: 'ecc:architecture-decision-records',
  'research-lead': 'ecc:research-ops', researcher: 'ecc:deep-research', 'fact-checker': 'ecc:research-ops', reporter: 'ecc:article-writing',
  editor: 'ecc:content-engine', writer: 'ecc:article-writing', 'content-checker': 'ecc:research-ops',
  diagnose: 'superpowers:systematic-debugging', fix: 'ecc:coding-standards', verify: 'ecc:verification-loop',
};
const skillName = (name: string) => name.split(':').at(-1)!.toLowerCase();
export function workflowSkillProvider(name: string): TemplateCapabilityId { return (name.startsWith('gitnexus-') ? 'gitnexus' : name.split(':')[0]) as TemplateCapabilityId; }
function matchesSkill(name: string, wanted: string) {
  return name === wanted || name.toLowerCase() === skillName(wanted)
    || ['planning-with-files', 'gitnexus'].includes(workflowSkillProvider(wanted)) && name === `${workflowSkillProvider(wanted)}:${wanted}`;
}

export function recommendedCapabilities(nodeId: string): { skills: string[]; plugins: string[] } {
  if (!Object.hasOwn(roleSkills, nodeId)) return { skills: [], plugins: [] };
  const engineering = ['frontend', 'backend', 'test', 'diagnose', 'fix', 'verify'].includes(nodeId);
  const graphSkill = ['test', 'verify'].includes(nodeId) ? 'gitnexus-impact-analysis' : nodeId === 'diagnose' ? 'gitnexus-debugging' : 'gitnexus-exploring';
  return { skills: [roleSkills[nodeId], 'planning-with-files', ...(engineering ? ['ponytail:ponytail', graphSkill] : [])], plugins: ['ecc', 'superpowers', ...(engineering ? ['ponytail'] : [])] };
}

export function findWorkflowSkill(catalog: CapabilityCatalog, wanted: string, root?: string) {
  const matches = catalog.skills.filter(skill => matchesSkill(skill.name, wanted));
  return (root ? matches.find(skill => { const path = relative(root, skill.path); return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`); }) : undefined) ?? matches[0];
}

export function selectWorkflowCapabilities(nodes: NodeDefinition[], catalog: CapabilityCatalog, root?: string, overwritten: TemplateCapabilityId[] = []): { nodes: NodeDefinition[]; missing: string[] } {
  const missing: string[] = [];
  return { nodes: nodes.map(node => {
    if (!Object.hasOwn(roleSkills, node.id)) return structuredClone(node);
    let skills = structuredClone(node.skills ?? []), plugins = structuredClone(node.plugins ?? []);
    const recommended = recommendedCapabilities(node.id);
    for (const wanted of recommended.skills) {
      const entry = findWorkflowSkill(catalog, wanted, root);
      if (!entry) { missing.push(`${node.id}: skill ${wanted}`); continue; }
      if (overwritten.includes(workflowSkillProvider(wanted))) skills = skills.filter(skill => !matchesSkill(skill.name, wanted));
      else if (skills.some(skill => matchesSkill(skill.name, wanted))) continue;
      if (!skills.some(skill => skill.path === entry.path)) skills.push({ name: entry.name, path: entry.path });
    }
    for (const wanted of recommended.plugins) {
      const entry = catalog.plugins.find(plugin => plugin.installed !== false && plugin.enabled !== false && (plugin.id.split('@')[0].toLowerCase() === wanted || plugin.name.toLowerCase() === wanted));
      if (!entry) { missing.push(`${node.id}: plugin ${wanted}`); continue; }
      if (overwritten.includes(wanted as TemplateCapabilityId)) plugins = plugins.filter(plugin => plugin.id.split('@')[0].toLowerCase() !== wanted);
      else if (plugins.some(plugin => plugin.id.split('@')[0].toLowerCase() === wanted)) continue;
      if (!plugins.some(plugin => plugin.id === entry.id)) plugins.push({ id: entry.id, name: entry.name });
    }
    return { ...structuredClone(node), skills, plugins };
  }), missing };
}
