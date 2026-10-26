import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MANAGEMENT_TOOLS, emptyManagement } from '../shared/project-items.js';
import type { EdgeLayout, NodeDefinition, ProjectSummary, WorkflowEdge } from '../shared/types.js';
import { ensureProjectDirectory, insideProject, projectDirectory } from './paths.js';
import { ProjectStore } from './store.js';
import type { ProjectState } from './model.js';

export interface WorkflowDefinition { project: ProjectSummary; nodes: NodeDefinition[]; edges: WorkflowEdge[]; edgeLayouts: Record<string, EdgeLayout>; }
export function readWorkflowDefinition(root: string): WorkflowDefinition {
  root = ensureProjectDirectory(root);
  const db = new DatabaseSync(insideProject(root, join(root, '.mixcat/state/workflow.sqlite')), { readOnly: true });
  try {
    const row = db.prepare('SELECT body FROM project_state WHERE id=1').get(); if (!row) throw new Error('没有可保留的项目定义。');
    const state = JSON.parse(String(row.body)) as ProjectState;
    if (state.project.root.toLowerCase() !== root.toLowerCase()) throw new Error('项目定义所属目录不同。');
    return { project: structuredClone(state.project), nodes: state.nodes.map(({ threads, status, ...node }) => structuredClone({ ...node, model: node.model ?? null, skills: node.skills ?? [], plugins: node.plugins ?? [] })), edges: structuredClone(state.edges), edgeLayouts: structuredClone(state.edgeLayouts ?? {}) };
  } finally { db.close(); }
}
function checkTree(root: string, path: string) {
  insideProject(root, path); if (!existsSync(path)) return;
  const stat = lstatSync(path); if (stat.isSymbolicLink()) throw new Error(`重置目标包含链接，已停止：${path}`);
  if (stat.isDirectory()) for (const entry of readdirSync(path)) checkTree(root, join(path, entry));
}
export function resetProjectData(root: string, definition: WorkflowDefinition) {
  root = ensureProjectDirectory(root);
  if (typeof definition.project?.id !== 'string' || typeof definition.project.name !== 'string' || !Array.isArray(definition.nodes) || !Array.isArray(definition.edges)
    || definition.nodes.some(node => typeof node.id !== 'string' || typeof node.name !== 'string' || typeof node.instructions !== 'string' || !Array.isArray(node.tools))) throw new Error('项目节点定义格式不完整。');
  const ids = new Set(definition.nodes.map(node => node.id)), edgeIds = new Set(definition.edges.map(edge => edge.id));
  if (ids.size !== definition.nodes.length || edgeIds.size !== definition.edges.length || definition.edges.some(edge => !ids.has(edge.sourceNodeId) || !ids.has(edge.targetNodeId))) throw new Error('节点或条件边保留清单不完整。');
  if (process.platform === 'win32') {
    const running = execFileSync('powershell.exe', ['-NoProfile', '-Command', "@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'electron.exe' -and $_.CommandLine -and $_.CommandLine.IndexOf($env:MIXCAT_RESET_ROOT,[StringComparison]::OrdinalIgnoreCase) -ge 0 }).Count"], { encoding: 'utf8', windowsHide: true, env: { ...process.env, MIXCAT_RESET_ROOT: root } }).trim();
    if (running !== '0') throw new Error('目标目录仍有 Electron 进程，请正常退出客户端后再重置。');
  }
  const data = insideProject(root, join(root, '.mixcat'));
  const plans = [...new Set(definition.nodes.map(node => node.planId).filter((id): id is string => !!id))];
  for (const id of plans) if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/.test(id)) throw new Error('保留的计划编号不安全。');
  const planPaths = plans.map(id => insideProject(root, join(root, '.planning', id)));
  for (const target of [data, ...planPaths]) checkTree(root, target);
  const catalog = insideProject(root, join(projectDirectory(root, '.runtime', 'client'), 'projects.json'));
  const roots = existsSync(catalog) ? JSON.parse(readFileSync(catalog, 'utf8')) : [];
  if (!Array.isArray(roots) || roots.some(value => typeof value !== 'string')) throw new Error('工作台项目清单格式不正确。');
  const records = projectDirectory(root, '.runtime', 'implementation', 'project-management-reset');
  const definitionPath = insideProject(root, join(records, `definition-${randomUUID()}.json`));
  writeFileSync(definitionPath, JSON.stringify(definition, null, 2), { flag: 'wx', flush: true });
  const verified = JSON.parse(readFileSync(definitionPath, 'utf8')) as WorkflowDefinition;
  if (JSON.stringify(verified) !== JSON.stringify(definition)) throw new Error('节点图保留清单校验失败。');
  for (const target of [data, ...planPaths]) { insideProject(root, target); rmSync(target, { recursive: true, force: true }); }
  const store = new ProjectStore(root);
  try {
    store.save({ project: { ...definition.project, root, status: 'idle', updatedAt: new Date().toISOString() },
      nodes: definition.nodes.map(node => ({ ...node, tools: [...new Set([...node.tools, ...MANAGEMENT_TOOLS])], threads: {}, status: 'idle' })), edges: definition.edges, edgeLayouts: definition.edgeLayouts,
      tasks: [], handoffs: [], activities: [], conversation: [], messages: [], workflowReceipts: [], reviewPolicy: { revision: 0, checkpoints: [] }, humanReviews: [], runId: null, maxSteps: 12, management: emptyManagement() });
  } finally { store.close(); }
  for (const id of plans) {
    const directory = projectDirectory(root, '.planning', id);
    for (const [file, title] of [['task_plan.md', '工作计划'], ['findings.md', '调查发现'], ['progress.md', '执行进展']]) writeFileSync(insideProject(root, join(directory, file)), `# ${title}\n\n本次测试数据已重置。业务进度由项目 TodoList 维护，在此引用相关工作项并记录工作记忆。\n`, { flag: 'wx' });
  }
  writeFileSync(catalog, JSON.stringify([...new Set([...roots.filter(value => value.toLowerCase() !== definition.project.root.toLowerCase()), root])], null, 2), { flush: true });
  return { root, projectId: definition.project.id, definitionPath, nodes: definition.nodes.length, edges: definition.edges.length };
}
