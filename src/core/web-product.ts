import { lstatSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { ensureProjectDirectory, insideProject, projectDirectory } from './paths.js';
import { WORKFLOW_TOOLS, type CapabilityCatalog, type HumanReviewPolicy, type NodeDefinition, type WorkflowEdge, type WorkflowGroup } from '../shared/types.js';

const planId = 'mvp-001';
export const questionInstructions = `人工核对由节点主动向用户提问。需要用户补充信息、选择方案或确认结果时，由你主动用 request_review 提问：省略 checkpoint_id，在 content 中写清实际问题，使用稳定 request_id；用户无需创建核对规则。提问成功仅表示问题已受理，不代表用户已回答或确认。提交后正常结束本轮，等待用户回答，回答会送回本节点原会话；不要轮询、猜测回答、替用户批准或自行继续依赖该回答的工作。用户问题也可使用当前可用的原生提问能力。已有旧核对点只在 get_project_context 确实返回规则时适用。`;
const sharedInstructions = `每个节点使用所属项目 cwd 和独立原生会话，保留原生能力，用户可自由输入。用户和节点通过 search_project_items/get_project_item/update_project_item 共同维护 Issue 和文档；新建工作统一使用 kind=issue，普通任务类型为 task；先读当前版本再更新，业务进度以 Issue 为准，.planning/ 记录工作记忆并引用工作项。先读取 get_project_context；跨节点分派、协助、通知或交接使用根据本节点出边动态生成的 edge_ 工具，依据已有条件与描述选择，目标由工具绑定；回复用已有条件边工具并以 reply_to 关联原消息。普通发送不结束当前 Turn；需要等待回复时正常结束本轮，不自动互发“收到”。用 get_delivery/read_history 核对实际状态与原始记录，文档和自然语言完成声明不能替代引擎运行状态。条件是否适用由 Agent 判断，调用后直接保存投递。complete_task 仅按实际任务需要使用，人工核对遵循当前项目规则。
正式设计在 docs/design/，详细任务在 docs/plans/mvp-001-implementation.md，证据在 docs/reports/mvp-001/。共享文档只有一个明确维护者，修改前重读并保留用户与其他节点内容；非维护者用 MCP 提出建议。产品经理维护 .planning/mvp-001/{task_plan,findings,progress}.md；其余节点读取总计划，维护自己的成果，独立复杂任务才另建明确归属的计划。使用 planning-with-files 时确认项目及 PLAN_ID=mvp-001，不用共享 .active_plan 或最近修改时间选择计划，不假设文件存在就表示 hooks 已绑定。
交接说明任务、成果路径与版本、实际验证、限制、阻塞和期望回复；用 work_context 以 primary_issue_id 关联本轮 Issue，并引用相关文档，observed 仅记录版本观察，不能替代正文。要固定本轮内容时发送需求、设计、测试报告与真实资源的附件快照，不把路径、文档引用、修订号或 HEAD 当成整个未提交工作区快照；多文件原型按实际资源清单附齐，无法固定或操作时说明限制。保存文件后需要协作时显式发送 MCP。分组不自动汇合成果、不新增语义检查或任务完成条件；工作项完成须引用真实交付消息和证据。所有工作数据留在所属项目内的非 C 盘路径，不经过符号链接或目录联接。`;
const engineeringInstructions = `使用 Ponytail full：先读调用方和影响范围，复用现有代码，完成最小但完整的改动并做必要验证，不能省略安全、数据保护、可访问性和验收边界。按需使用 GitNexus 探索、调试和影响分析；说明仓库、cwd、索引版本及未提交改动覆盖，图谱缺失、过期、截断或零调用方不证明没有影响，结合源码、文本搜索和真实测试。后端牵头维护项目的一份代码索引；前端与测试按需请求刷新。能力只从真实目录选择，名称写入职责不表示已经安装、加载或运行。`;

const roles = [
  ['product', '产品经理／协调', '负责目标用户、问题、MVP 范围、优先级、任务依赖与阻塞，组织业务验收，协调产品定义域。你是 docs/design/product-brief.md、docs/plans/mvp-001-implementation.md 和共享 .planning/mvp-001/ 的主要维护者；开发节点补充自己任务。与需求分析反复讨论目标、规则与取舍，以具体问题和文档变化推进，不规定轮数；涉及用户决定时提交产品方向人工核对。按需复用本轮父 Issue 及需求、设计、设计测试、汇总子 Issue，不每次运行重复创建。汇总同一轮产品说明、需求、设计及真实资源、设计测试的原始报告、问题结论和核对编号，保留原文及未决事项，统一交给架构师；不能用自写摘要替换独立测试结论。架构师返回可行性或决策问题后组织下一轮组内处理。依据交接、真实执行和证据汇总进度，涉及范围或跨节点冲突时做产品决策。'],
  ['requirements', '需求分析', '负责用户流程、业务规则、状态、异常和可测试验收条件，是 docs/design/requirements.md 的主要维护者。标注未知项，反复与产品经理澄清疑点、冲突、需求草案及范围取舍；需求足够明确后交给设计，附版本、验收条件、已处理问题和剩余非阻塞项。接收设计的规则、状态或流程缺口，影响目标、范围或优先级时交产品经理决策。'],
  ['design', 'UI/UE 设计', '负责信息结构、操作流程、页面组件、视觉和加载／空白／错误状态，是 docs/design/ui-ux.md 的主要维护者。需求存在规则、状态或流程缺口时交需求分析，附具体场景和影响。将需求与设计版本、真实资源及待查范围交 UI/UE 测试，处理缺陷后沿同一条件边送回复查。测试后提交 UI/UE 人工核对，附原始测试报告和已通过的产品方向版本；不能把自己的判断替换成测试结论。成果、测试原结论、核对信息和未决问题交产品经理汇总；等待核对时也准确同步进展。'],
  ['frontend', '前端／浏览器开发', '依据架构师的技术方案与接口契约、UI/UE 的设计实现页面交互和接口接入，负责浏览器调试并牵头前后端联调。维护前端源码及执行证据；技术边界或契约变更通过条件边交回架构师，避免覆盖共享方案与配置。交给测试时说明源码与文档版本、启动方式、环境、实际验证和阻塞；浏览器实际页面与接口结果分别验证。'],
  ['backend', '后端开发', '依据架构师的技术方案与接口契约，负责服务端接口、业务逻辑、数据处理、权限、迁移和验证，维护后端源码与实际执行证据。技术边界或契约变更通过条件边交回架构师。接口可联调时交给前端，明确契约版本、运行条件、错误响应和未完成项。'],
  ['test', '测试', '收到前端提交的可运行版本后，依据随成果流转的需求验收条件独立验证核心用户流程、边界和回归，是 docs/reports/mvp-001/test-report.md 的主要维护者。记录环境、源码及附件版本、期望、实际、复现步骤、证据和未验证项；实现缺陷沿当前条件边回流，逐项测试结论及需求或交互缺口交产品经理验收和决策。Ponytail 用于减少重复脆弱测试，不能漏掉核心行为、安全、数据损失与边界。'],
  ['architect', '架构师', '负责技术栈选择、模块边界、数据与权限方案、运行部署及关键技术取舍，是 docs/design/architecture.md 与项目唯一权威接口契约的主要维护者；前后端提供实现反馈，测试提供验证约束。接收产品经理的统一产品定义成果，核对需求、设计、测试原结论与人工决定的版本；可行性问题、冲突或产品取舍交回产品经理组织澄清。形成足以实施的方案与契约后，分别交给前端与后端，附相关设计材料及验收条件；收到技术边界或契约问题时修订同一权威方案并通知受影响的实现节点。后端负责服务端实现，前端负责页面实现；共享方案与实现成果分别记录，不重复承担实现或逐函数审批。'],
  ['design-test', 'UI/UE 测试', '独立检查 UI/UE 设计与需求的对应关系，检查流程、状态、交互一致性、可用性和可访问性，是 docs/reports/mvp-001/ui-ue-test-report.md 的主要维护者。每项问题记录位置、依据、影响、实际观察和复查方式，缺陷使用已有内部 Issue，纯风格偏好列为建议。仅有静态设计时限定为静态检查；存在可操作原型时才验证点击、返回、键盘、响应式、加载和错误反馈，说明未验证范围，不将设计检查冒充真实后端产品验收。问题、建议及复查结论沿条件边交回设计节点，以 reply_to 关联原送测消息与相关 Issue，修正后独立复查。报告保留原始结论与证据，不代替用户人工核对。能力从实际目录选择，不因职责名称宣称某个 skill 或插件已经启用。'],
] as const;

export function createWebProductTemplate(): { nodes: NodeDefinition[]; edges: WorkflowEdge[]; groups: WorkflowGroup[] } {
  const positions = [{ x: 70, y: 80 }, { x: 440, y: 80 }, { x: 70, y: 380 }, { x: 1270, y: 80 }, { x: 900, y: 380 }, { x: 1270, y: 380 }, { x: 900, y: 80 }, { x: 440, y: 380 }];
  const nodes: NodeDefinition[] = roles.map(([id, name, instructions], index) => ({
    id, name, instructions: `${instructions}\n${sharedInstructions}\n${questionInstructions}${['frontend', 'backend', 'test'].includes(id) ? `\n${engineeringInstructions}` : ''}`,
    tools: [...WORKFLOW_TOOLS], resultSchema: {}, position: positions[index], revision: 1, model: null, planId,
  }));
  const routes = [
    ['product', 'requirements', '开始细化需求、回应问题或调整范围；附目标、约束、决定及本轮变更'],
    ['requirements', 'product', '需要产品取舍、发现冲突，或提交需求草案供确认；明确需要回答的问题'],
    ['requirements', 'design', '本轮需求可用于设计；附需求版本、验收条件、已处理问题和剩余非阻塞项'],
    ['design', 'requirements', '设计发现具体规则、状态或流程缺口；附场景、现有依据及影响'],
    ['design', 'design-test', '初次送测或修正后复查；附需求与设计版本、真实材料和本轮待查内容'],
    ['design-test', 'design', '返回缺陷、建议或复查通过结论；关联原送测消息和相关 Issue'],
    ['design', 'product', '提交设计成果、测试原结论与人工核对信息；等待核对或存在未决问题时准确说明进展'],
    ['product', 'architect', '汇总本轮完整产品定义；附明确版本的材料、测试结论、核对记录及需要架构解决的问题'],
    ['architect', 'product', '统一成果存在可行性问题、冲突或需要产品决策；由产品经理组织组内下一轮处理'],
    ['architect', 'backend', '服务端技术边界与接口契约已明确，附方案版本、实现任务及验证要求'],
    ['architect', 'frontend', '前端技术边界与接口契约已明确，附方案版本、接入约定及实现约束'],
    ['backend', 'architect', '实现发现技术边界或契约冲突，需要架构师明确或修订方案，附影响与证据'],
    ['frontend', 'architect', '页面接入发现技术边界或契约冲突，需要架构师明确或修订方案，附影响与证据'],
    ['backend', 'frontend', '接口可以联调，附契约版本、运行条件和未完成部分'],
    ['frontend', 'test', '目标流程可运行，附版本、环境、启动步骤和实际验证'],
    ['test', 'frontend', '发现前端问题，附期望、实际、复现与证据'],
    ['test', 'backend', '发现后端问题，附期望、实际、复现与证据'],
    ['test', 'product', '逐项测试结果已可业务验收；或发现需求、交互缺口，需要产品决策并重新安排下一轮需求'],
  ];
  return { nodes, edges: routes.map(([sourceNodeId, targetNodeId, condition]) => ({ id: `${sourceNodeId}-${targetNodeId}`, sourceNodeId, targetNodeId, condition, revision: 1 })), groups: [{ id: 'product-definition', name: '产品定义', nodeIds: ['product', 'requirements', 'design', 'design-test'], coordinatorNodeId: 'product', revision: 1 }] };
}

export function createWebProductReviewPolicy(): HumanReviewPolicy {
  return { revision: 0, checkpoints: [] };
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

export function initializeWebProductFiles(root: string, name: string): string[] {
  const actualRoot = ensureProjectDirectory(root);
  const intro = `项目：${name}\n\n项目方向与范围待与用户沟通确认，并可在后续沟通中调整。\n`;
  const documents = [
    ['docs/design/product-brief.md', `# 产品目标与范围\n\n主要维护者：产品经理／协调。\n\n${intro}\n请明确用户、核心流程、MVP 范围、优先级与业务验收依据。`],
    ['docs/design/requirements.md', `# 需求与验收条件\n\n主要维护者：需求分析。\n\n${intro}\n记录流程、业务规则、状态、异常、可测试验收条件和待澄清事项。`],
    ['docs/design/ui-ux.md', `# 界面与交互设计\n\n主要维护者：UI/UE 设计。\n\n${intro}\n记录页面、交互、组件、视觉、加载／空白／错误状态及资源位置。`],
    ['docs/design/architecture.md', `# 技术架构\n\n主要维护者：架构师；前后端提供实现反馈。\n\n${intro}\n对齐技术栈、模块、数据、认证、运行部署与文件责任；维护项目唯一权威接口契约，前后端依据同一版本实现并报告冲突，不复制冲突定义。`],
    ['docs/plans/mvp-001-implementation.md', `# ${name} 实施计划\n\n主要维护者：产品经理组织，开发节点补充各自任务。\n\n${intro}\n依据 docs/design/ 中已明确的需求与设计，填写具体改动、任务依赖、责任人、接口及实际验证步骤。共享工作记忆位于 .planning/mvp-001/，不复制第二份详细任务清单。`],
    ['docs/reports/mvp-001/test-report.md', '# 测试与验收报告\n\n主要维护者：测试；各节点提供自己的执行证据。\n\n当前状态：未验证。\n\n按需求验收条件记录环境、源码及附件版本、期望、实际、复现步骤、证据、缺陷和未验证项。产品经理据此核对业务目标。'],
    ['docs/reports/mvp-001/ui-ue-test-report.md', '# UI/UE 设计测试报告\n\n主要维护者：UI/UE 测试。\n\n当前状态：未验证。\n\n对应本轮需求、设计和原送测消息，记录问题位置、依据、影响、实际观察、内部 Issue 与复查结果；区分静态设计检查、可操作原型验证及未验证行为。原始结论交回设计，由产品经理连同设计成果和核对编号统一交付。'],
    ['.planning/mvp-001/task_plan.md', `# 迭代总计划\n\n主要维护者：产品经理／协调。PLAN_ID=mvp-001。\n\n${intro}\n详细实施计划：docs/plans/mvp-001-implementation.md。\n\n当前阶段：待明确需求。记录阶段、依赖、决策和下一步；不替代引擎运行状态。`],
    ['.planning/mvp-001/findings.md', '# 调查发现\n\n主要维护者：产品经理／协调。\n\n记录调查依据、约束、假设和待澄清事项；执行节点通过 MCP 提供成果与证据。'],
    ['.planning/mvp-001/progress.md', '# 执行进展\n\n主要维护者：产品经理／协调。\n\n当前仅建立文档，尚未执行或验证产品功能。按真实交接和验证记录进展、问题与处理结果，不覆盖原始会话历史。'],
  ].map(([path, content]) => ({ path: join(actualRoot, path), content: `${content}\n\n${questionInstructions}\n` }));
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

const roleSkills: Record<string, string> = { product: 'ecc:product-lens', requirements: 'ecc:product-capability', design: 'impeccable', frontend: 'ecc:frontend-patterns', backend: 'ecc:backend-patterns', test: 'ecc:e2e-testing', architect: 'ecc:architecture-decision-records' };
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
