import { lstatSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { ensureProjectDirectory, insideProject, projectDirectory } from './paths.js';
import { WORKFLOW_TOOLS, type CapabilityCatalog, type HumanReviewPolicy, type NodeDefinition, type WorkflowEdge } from '../shared/types.js';

const planId = 'mvp-001';
const reviewInstructions = `人工核对以当前 get_project_context 的规则、责任节点和版本为准。责任节点用 request_review 提交固定材料，随后用 get_review 查询；回执及核对编号是业务确认依据，文档中的“已通过”不能替代用户决定。通过后在单独的计划／进展记录中引用核对编号，保留已提交材料版本；仅为标记通过而修改需求或设计正文也会改变材料哈希，需要新包。实际方案变化须提交新版本。相关后续任务等待用户通过，原生能力与原生审批照常保留。`;
const sharedInstructions = `每个节点使用所属项目 cwd 和独立原生会话，保留原生能力，用户可自由输入。先读取 get_project_context；用 send_message 分派、协助、通知或交接，回复用 reply_to 关联原消息。普通发送不结束当前 Turn；需要等待回复时正常结束本轮，不自动互发“收到”。用 get_delivery/read_history 核对实际状态与原始记录，文档和自然语言完成声明不能替代引擎运行状态。条件边是建议，可联系无连线节点并说明理由。旧 handoff/complete_task 仅按实际任务需要使用，人工核对遵循当前项目规则。
正式设计在 docs/design/，详细任务在 docs/plans/mvp-001-implementation.md，证据在 docs/reports/mvp-001/。共享文档只有一个明确维护者，修改前重读并保留用户与其他节点内容；非维护者用 MCP 提出建议。产品经理维护 .planning/mvp-001/{task_plan,findings,progress}.md；其余节点读取总计划，维护自己的成果，独立复杂任务才另建明确归属的计划。使用 planning-with-files 时确认项目及 PLAN_ID=mvp-001，不用共享 .active_plan 或最近修改时间选择计划，不假设文件存在就表示 hooks 已绑定。
交接说明任务、成果路径与版本、实际验证、限制、阻塞和期望回复；要固定文档版本时用真实附件，不把路径或 HEAD 当成整个未提交工作区快照。保存文件后需要协作时显式发送 MCP。所有工作数据留在所属项目内的非 C 盘路径，不经过符号链接或目录联接。`;
const engineeringInstructions = `使用 Ponytail full：先读调用方和影响范围，复用现有代码，完成最小但完整的改动并做必要验证，不能省略安全、数据保护、可访问性和验收边界。按需使用 GitNexus 探索、调试和影响分析；说明仓库、cwd、索引版本及未提交改动覆盖，图谱缺失、过期、截断或零调用方不证明没有影响，结合源码、文本搜索和真实测试。后端牵头维护项目的一份代码索引；前端与测试按需请求刷新。能力只从真实目录选择，名称写入职责不表示已经安装、加载或运行。`;

const roles = [
  ['product', '产品经理／协调', '负责目标用户、问题、MVP 范围、优先级、任务依赖与阻塞，组织业务验收。你是 docs/design/product-brief.md、docs/plans/mvp-001-implementation.md 和共享 .planning/mvp-001/ 的主要维护者；开发节点补充自己任务。依据交接、真实执行和证据汇总进度，涉及范围或跨节点冲突时做产品决策。'],
  ['requirements', '需求分析', '负责用户流程、业务规则、状态、异常和可测试验收条件，是 docs/design/requirements.md 的主要维护者。标注未知项；需求足够明确后分别通知设计、后端与测试，测试从需求阶段准备。涉及产品范围请产品经理决定。'],
  ['design', 'UI/UE 设计', '负责信息结构、操作流程、页面组件、视觉和加载／空白／错误状态，是 docs/design/ui-ux.md 的主要维护者。设计资源提供真实位置；交互可供实现后通知前端，需求缺口联系需求分析，范围取舍联系产品经理。'],
  ['frontend', '前端／浏览器开发', '负责页面交互、浏览器调试和接口接入，牵头前后端联调，与后端共同确认技术边界。维护前端源码及其执行证据，参与 docs/design/architecture.md，通过后端维护唯一接口契约，避免覆盖共享配置。交给测试时说明源码与文档版本、启动方式、环境、实际验证和阻塞；浏览器实际页面与接口结果分别验证。'],
  ['backend', '后端／架构牵头', '牵头技术架构，负责接口、业务逻辑、数据模型、权限、迁移和验证，是 docs/design/architecture.md 与项目唯一权威接口契约的主要维护者；前端参与，测试协商。开发前对齐技术栈、模块、数据、认证、接口、运行部署和文件责任。接口可联调时分别通知前端与测试，明确契约版本、错误响应和未完成项。'],
  ['test', '测试', '从需求阶段独立准备场景，依据验收条件验证核心用户流程、边界和回归，是 docs/reports/mvp-001/test-report.md 的主要维护者。记录环境、源码及附件版本、期望、实际、复现步骤、证据和未验证项；缺陷直接联系前端或后端，业务规则与交互缺口联系原负责人，逐项结论交产品经理验收。Ponytail 用于减少重复脆弱测试，不能漏掉核心行为、安全、数据损失与边界。'],
] as const;

export function createWebProductTemplate(): { nodes: NodeDefinition[]; edges: WorkflowEdge[] } {
  const nodes: NodeDefinition[] = roles.map(([id, name, instructions], index) => ({
    id, name, instructions: `${instructions}\n${sharedInstructions}\n${reviewInstructions}${index >= 3 ? `\n${engineeringInstructions}` : ''}`,
    tools: [...WORKFLOW_TOOLS], resultSchema: {}, position: { x: 70 + (index % 3) * 370, y: 80 + Math.floor(index / 3) * 300 }, revision: 1, model: null, planId,
  }));
  const routes = [
    ['product', 'requirements', '目标、核心用户与本轮范围明确，需要细化业务规则'],
    ['requirements', 'design', '相关流程与关键状态足够明确，可以设计交互'],
    ['requirements', 'backend', '业务对象、规则和验收条件足以展开架构及接口讨论'],
    ['requirements', 'test', '验收条件可以转化为测试场景，提前补充边界和疑问'],
    ['design', 'frontend', '界面与交互状态已说明，附设计说明和真实资源引用'],
    ['backend', 'frontend', '接口可以联调，附契约版本、运行条件和未完成部分'],
    ['frontend', 'test', '目标流程可运行，附版本、环境、启动步骤和实际验证'],
    ['test', 'frontend', '发现前端问题，附期望、实际、复现与证据'],
    ['test', 'backend', '发现后端问题，附期望、实际、复现与证据'],
    ['test', 'design', '交互说明存在缺口，需要设计负责人澄清'],
    ['test', 'requirements', '业务规则存在缺口，需要需求负责人澄清'],
    ...roles.filter(([id]) => id !== 'product').map(([id]) => [id, 'product', id === 'test' ? '逐项测试结果已可业务验收；或需要产品范围、优先级和跨节点决策' : '需要范围、优先级、业务目标或跨节点冲突决策']),
  ];
  return { nodes, edges: routes.map(([sourceNodeId, targetNodeId, condition]) => ({ id: `${sourceNodeId}-${targetNodeId}`, sourceNodeId, targetNodeId, condition, revision: 1 })) };
}

export function createWebProductReviewPolicy(): HumanReviewPolicy {
  return { revision: 1, checkpoints: [
    { id: 'product-direction', name: '产品需求方向', ownerNodeId: 'product', requiredForNodeIds: ['design', 'backend', 'frontend'], dependsOn: [], revision: 1 },
    { id: 'ui-ue', name: 'UI/UE 方案', ownerNodeId: 'design', requiredForNodeIds: ['frontend'], dependsOn: ['product-direction'], revision: 1 },
  ] };
}

function checkTarget(root: string, path: string): void {
  insideProject(root, path);
  for (let current = path; current !== root; current = dirname(current)) {
    let stat;
    try { stat = lstatSync(current); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink()) throw new Error(`文档路径不能经过符号链接或目录联接：${current}`);
    if (current === path ? !stat.isFile() : !stat.isDirectory()) throw new Error(`文档文件或父目录类型不正确：${current}`);
  }
}

export function initializeWebProductFiles(root: string, name: string, goal: string): string[] {
  const actualRoot = ensureProjectDirectory(root);
  const intro = `项目：${name}\n\n目标：${goal}\n`;
  const documents = [
    ['docs/design/product-brief.md', `# 产品目标与范围\n\n主要维护者：产品经理／协调。\n\n${intro}\n请明确用户、核心流程、MVP 范围、优先级与业务验收依据。`],
    ['docs/design/requirements.md', `# 需求与验收条件\n\n主要维护者：需求分析。\n\n${intro}\n记录流程、业务规则、状态、异常、可测试验收条件和待澄清事项。`],
    ['docs/design/ui-ux.md', `# 界面与交互设计\n\n主要维护者：UI/UE 设计。\n\n${intro}\n记录页面、交互、组件、视觉、加载／空白／错误状态及资源位置。`],
    ['docs/design/architecture.md', `# 技术架构\n\n主要维护者：后端牵头，前端参与。\n\n${intro}\n对齐技术栈、模块、数据、认证、运行部署与文件责任；引用项目唯一权威接口契约，不复制冲突定义。`],
    ['docs/plans/mvp-001-implementation.md', `# ${name} 实施计划\n\n主要维护者：产品经理组织，开发节点补充各自任务。\n\n${intro}\n依据 docs/design/ 中已明确的需求与设计，填写具体改动、任务依赖、责任人、接口及实际验证步骤。共享工作记忆位于 .planning/mvp-001/，不复制第二份详细任务清单。`],
    ['docs/reports/mvp-001/test-report.md', '# 测试与验收报告\n\n主要维护者：测试；各节点提供自己的执行证据。\n\n当前状态：未验证。\n\n按需求验收条件记录环境、源码及附件版本、期望、实际、复现步骤、证据、缺陷和未验证项。产品经理据此核对业务目标。'],
    ['.planning/mvp-001/task_plan.md', `# 迭代总计划\n\n主要维护者：产品经理／协调。PLAN_ID=mvp-001。\n\n${intro}\n详细实施计划：docs/plans/mvp-001-implementation.md。\n\n当前阶段：待明确需求。记录阶段、依赖、决策和下一步；不替代引擎运行状态。`],
    ['.planning/mvp-001/findings.md', '# 调查发现\n\n主要维护者：产品经理／协调。\n\n记录调查依据、约束、假设和待澄清事项；执行节点通过 MCP 提供成果与证据。'],
    ['.planning/mvp-001/progress.md', '# 执行进展\n\n主要维护者：产品经理／协调。\n\n当前仅建立文档，尚未执行或验证产品功能。按真实交接和验证记录进展、问题与处理结果，不覆盖原始会话历史。'],
  ].map(([path, content]) => ({ path: join(actualRoot, path), content: `${content}\n\n${reviewInstructions}\n` }));
  for (const document of documents) checkTarget(actualRoot, document.path);
  const created: string[] = [];
  for (const document of documents) {
    checkTarget(actualRoot, document.path);
    projectDirectory(actualRoot, relative(actualRoot, dirname(document.path)));
    try { writeFileSync(document.path, document.content, { flag: 'wx' }); created.push(document.path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; checkTarget(actualRoot, document.path); }
  }
  return created;
}

const roleSkills: Record<string, string> = { product: 'ecc:product-lens', requirements: 'ecc:product-capability', design: 'impeccable', frontend: 'ecc:frontend-patterns', backend: 'ecc:backend-patterns', test: 'ecc:e2e-testing' };
const skillName = (name: string) => name.split(':').at(-1)!.toLowerCase();

export function selectWebProductCapabilities(nodes: NodeDefinition[], catalog: CapabilityCatalog): { nodes: NodeDefinition[]; missing: string[] } {
  const missing: string[] = [];
  return { nodes: nodes.map(node => {
    if (!roleSkills[node.id]) return structuredClone(node);
    const skills = structuredClone(node.skills ?? []), plugins = structuredClone(node.plugins ?? []);
    const engineering = ['frontend', 'backend', 'test'].includes(node.id);
    const wantedSkills = [roleSkills[node.id], 'planning-with-files', ...(engineering ? ['ponytail:ponytail', node.id === 'test' ? 'gitnexus-impact-analysis' : 'gitnexus-exploring'] : [])];
    for (const wanted of wantedSkills) {
      const entry = catalog.skills.find(skill => skill.name === wanted) ?? catalog.skills.find(skill => skill.name.toLowerCase() === skillName(wanted));
      if (!entry) { missing.push(`${node.id}: skill ${wanted}`); continue; }
      if (!skills.some(skill => skill.path === entry.path)) skills.push({ name: entry.name, path: entry.path });
    }
    for (const wanted of ['ecc', 'superpowers', ...(engineering ? ['ponytail'] : [])]) {
      const entry = catalog.plugins.find(plugin => plugin.id.split('@')[0].toLowerCase() === wanted || plugin.name.toLowerCase() === wanted);
      if (!entry) { missing.push(`${node.id}: plugin ${wanted}`); continue; }
      if (!plugins.some(plugin => plugin.id === entry.id)) plugins.push({ id: entry.id, name: entry.name });
    }
    return { ...structuredClone(node), skills, plugins };
  }), missing };
}
