import type { CapabilityCatalog, NodeDefinition } from '../shared/types.js';

const roleSkills: Record<string, string> = {
  product: 'ecc:product-lens', requirements: 'ecc:product-capability', design: 'impeccable', frontend: 'ecc:frontend-patterns', backend: 'ecc:backend-patterns', test: 'ecc:e2e-testing', architect: 'ecc:architecture-decision-records',
  'research-lead': 'ecc:research-ops', researcher: 'ecc:deep-research', 'fact-checker': 'ecc:research-ops', reporter: 'ecc:article-writing',
  editor: 'ecc:content-engine', writer: 'ecc:article-writing', 'content-checker': 'ecc:research-ops',
  diagnose: 'superpowers:systematic-debugging', fix: 'ecc:coding-standards', verify: 'ecc:verification-loop',
};
const skillName = (name: string) => name.split(':').at(-1)!.toLowerCase();

export function selectWorkflowCapabilities(nodes: NodeDefinition[], catalog: CapabilityCatalog): { nodes: NodeDefinition[]; missing: string[] } {
  const missing: string[] = [];
  return { nodes: nodes.map(node => {
    if (!roleSkills[node.id]) return structuredClone(node);
    const skills = structuredClone(node.skills ?? []), plugins = structuredClone(node.plugins ?? []);
    const engineering = ['frontend', 'backend', 'test', 'diagnose', 'fix', 'verify'].includes(node.id);
    const graphSkill = ['test', 'verify'].includes(node.id) ? 'gitnexus-impact-analysis' : node.id === 'diagnose' ? 'gitnexus-debugging' : 'gitnexus-exploring';
    const wantedSkills = [roleSkills[node.id], 'planning-with-files', ...(engineering ? ['ponytail:ponytail', graphSkill] : [])];
    for (const wanted of wantedSkills) {
      const entry = catalog.skills.find(skill => skill.name === wanted) ?? catalog.skills.find(skill => skill.name.toLowerCase() === skillName(wanted));
      if (!entry) { missing.push(`${node.id}: skill ${wanted}`); continue; }
      if (!skills.some(skill => skill.path === entry.path)) skills.push({ name: entry.name, path: entry.path });
    }
    for (const wanted of ['ecc', 'superpowers', ...(engineering ? ['ponytail'] : [])]) {
      const entry = catalog.plugins.find(plugin => plugin.installed !== false && (plugin.id.split('@')[0].toLowerCase() === wanted || plugin.name.toLowerCase() === wanted));
      if (!entry) { missing.push(`${node.id}: plugin ${wanted}`); continue; }
      if (!plugins.some(plugin => plugin.id === entry.id)) plugins.push({ id: entry.id, name: entry.name });
    }
    return { ...structuredClone(node), skills, plugins };
  }), missing };
}
