export const BUILTIN_TEMPLATES = [
  { id: 'research-analysis', name: '调研分析', nodeCount: 4, description: '研究协调、资料研究、独立核查与报告汇总。' },
  { id: 'content-creation', name: '内容创作', nodeCount: 3, description: '策划编辑、内容撰写与事实核查。' },
  { id: 'bug-fix', name: '缺陷修复', nodeCount: 3, description: '复现诊断、修复实现与回归验证。' },
  { id: 'web-product', name: 'Web 产品团队', nodeCount: 8, description: '产品、需求、设计、架构、前后端与独立测试。' },
] as const;

export type BuiltinTemplateId = typeof BUILTIN_TEMPLATES[number]['id'];
export type ProjectTemplate = BuiltinTemplateId | 'comfyui';

export function isProjectTemplate(value: unknown): value is ProjectTemplate {
  return value === 'comfyui' || BUILTIN_TEMPLATES.some(template => template.id === value);
}
