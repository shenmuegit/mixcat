import { WORKFLOW_TOOLS, type NodeDefinition, type WorkflowEdge, type WorkflowGroup } from '../shared/types.js';
import { COMFY_TOOLS } from '../shared/comfy.js';
import type { BuiltinTemplateId } from '../shared/templates.js';
import { questionInstructions } from './web-product.js';

type ScenarioTemplate = Exclude<BuiltinTemplateId, 'web-product'>;
const definitions: Record<ScenarioTemplate, { roles: [string, string, string][]; routes: [string, string, string][] }> = {
  'research-analysis': {
    roles: [
      ['research-lead', '研究协调', '与用户逐步明确研究问题、范围、时效要求、来源标准和报告形式，维护总计划；将明确问题交给资料研究，处理研究中的范围取舍。收到最终报告后核对问题覆盖、证据和未决事项，再向用户交付；发现缺口沿条件边安排补充。'],
      ['researcher', '资料研究', '依据研究问题查找并阅读原始资料，记录可定位来源、发布日期、检索时间、摘录依据和冲突；区分事实、推断与未知，不编造来源。范围不明确时交回协调；把资料与初步发现交独立核查，收到具体缺口后补查。'],
      ['fact-checker', '独立核查', '独立回查关键结论的原始来源、时效和引用上下文，检查相互矛盾的证据及覆盖缺口。问题附位置、依据与影响返回资料研究；核查结果、可信程度和未验证项交报告汇总，不能把未查证内容写成已确认。'],
      ['reporter', '报告汇总', '按研究问题组织可追溯的报告，保留引用、相反证据、推断和不确定性，核查原结论随报告交付。证据不足时交回独立核查，不用润色替代查证；将报告路径、版本和待决定事项交研究协调。'],
    ],
    routes: [
      ['research-lead', 'researcher', '研究问题和本轮范围已明确，附时效、来源标准、交付形式及待查问题'],
      ['researcher', 'research-lead', '范围、资源或证据冲突需要取舍，附具体问题、已有依据和影响'],
      ['researcher', 'fact-checker', '资料与初步发现可供核查，附原始来源、日期、结论依据及疑点'],
      ['fact-checker', 'researcher', '来源、时效、结论或覆盖存在缺口，附逐项核查结果和补查要求'],
      ['fact-checker', 'reporter', '本轮核查完成，附资料版本、原始核查结论、分歧与未验证项'],
      ['reporter', 'fact-checker', '汇总发现引用或证据缺口，附报告位置和需要回查的具体结论'],
      ['reporter', 'research-lead', '报告已形成，附成果版本、来源、原始核查结论及待决定事项'],
    ],
  },
  'content-creation': {
    roles: [
      ['editor', '策划编辑', '与用户明确受众、目的、渠道、语气、篇幅和素材授权，维护总计划与编辑要求；将本轮要求及素材交给撰写。收到核查稿后检查表达与需求覆盖，保留用户内容和修改依据；需修改时交回撰写，达到本轮要求后向用户交付。'],
      ['writer', '内容撰写', '根据编辑要求及用户素材写作，保留用户已有稿件，标出事实依据、引用、推断和待核实内容。方向、素材授权或取舍不明确时交回编辑；将可定位版本的稿件和来源交事实核查，按逐项反馈修改后送复查。'],
      ['content-checker', '事实核查', '独立核对稿件中的事实、日期、数据、引文和来源，检查素材授权说明与用户要求；不凭空补造事实。问题附稿件位置、原始依据及修改建议返回撰写；将核查后的稿件、原始结论和未决事项交策划编辑，由编辑决定成稿。'],
    ],
    routes: [
      ['editor', 'writer', '本轮编辑要求或修改意见已明确，附受众、渠道、素材、授权说明及验收要求'],
      ['writer', 'editor', '方向、素材授权或内容取舍需要决定，附具体问题与已有草稿'],
      ['writer', 'content-checker', '初稿或修改稿可核查，附稿件版本、来源和本轮待查内容'],
      ['content-checker', 'writer', '事实、引用或需求覆盖需要修正，附位置、依据和逐项反馈'],
      ['content-checker', 'editor', '核查已完成，附稿件版本、原始结论及仍需编辑决定的事项'],
    ],
  },
  'bug-fix': {
    roles: [
      ['diagnose', '复现诊断', '读取用户反馈、相关规范、调用方与运行证据，核实触发步骤、当前与预期行为、影响范围及根因；无法复现时说明已知事实和缺失证据，不虚构结果。维护总计划，把明确的修复边界与可测试验收条件交修复实现；收到回归结果后核对证据并向用户交付。'],
      ['fix', '修复实现', '依据诊断读取所有调用边界，先建立能捕获问题的必要失败回归，再复用现有代码完成最小完整修复。保护用户数据、未提交工作及错误处理；根因不符或范围变化时交回复现诊断。交回归验证时附版本、复现、红绿结果、运行方式和限制；按反馈修正。'],
      ['verify', '回归验证', '依据原始复现和验收条件独立验证修复版本，执行相关边界与必要回归，记录环境、版本、期望、实际及证据。失败附具体复现和影响返回修复；把逐项测试结论、未验证项及剩余风险交复现诊断，不把构建或自然语言声明当作功能验证。'],
    ],
    routes: [
      ['diagnose', 'fix', '缺陷和修复边界已有证据，附复现、根因或待验证假设、调用范围及验收条件'],
      ['fix', 'diagnose', '实现发现根因不符、范围变化或缺少必要证据，附实际观察与需要决定的问题'],
      ['fix', 'verify', '修复版本可运行，附源码版本、复现、红绿结果、环境及待验证边界'],
      ['verify', 'fix', '原问题或回归未通过，附期望、实际、复现步骤与证据'],
      ['verify', 'diagnose', '本轮验证结束，附逐项结果、对应版本、未验证项和剩余风险'],
    ],
  },
};

export function createWorkflowTemplate(template: ScenarioTemplate): { nodes: NodeDefinition[]; edges: WorkflowEdge[]; groups: WorkflowGroup[] } {
  const definition = definitions[template];
  const shared = `先读取 get_project_context。用户在对话中逐步明确和调整方向，项目名称不是固定目标。每个节点在所属项目目录使用独立原生会话。节点间交接使用当前出边生成的 edge_ 工具，依据条件选择目标；回复以 reply_to 关联原消息，等待回复时正常结束本轮，不轮询、不互发无内容确认。交接写明问题、成果路径与版本、实际验证、限制和期望回复；用项目 Issue 与文档记录真实进展。正式成果保存在项目内，工作记忆在 .planning/${template}/，总计划由协调节点维护，其他节点维护各自成果，修改共享文档前重读。使用 planning-with-files 时明确 PLAN_ID=${template}。能力从真实目录选择，配置不表示已安装或运行；外部发布及付费操作按用户实际授权执行。所有工作数据留在所属项目内的非 C 盘目录，不经过符号链接或目录联接。${questionInstructions}`;
  return {
    nodes: definition.roles.map(([id, name, instructions], index) => ({ id, name, instructions: `${instructions}\n${shared}`, tools: WORKFLOW_TOOLS.filter(tool => !(COMFY_TOOLS as readonly string[]).includes(tool)), resultSchema: {}, position: { x: 60 + index * 330, y: 160 }, revision: 1, model: null, planId: template })),
    edges: definition.routes.map(([sourceNodeId, targetNodeId, condition]) => ({ id: `${sourceNodeId}-${targetNodeId}`, sourceNodeId, targetNodeId, condition, revision: 1 })),
    groups: [],
  };
}
