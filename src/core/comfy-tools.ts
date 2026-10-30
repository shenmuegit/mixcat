import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { McpIdentity, WorkflowTool } from '../shared/types.js';

const object = (properties: Record<string, object>, required = Object.keys(properties)) => ({ type: 'object' as const, properties, required, additionalProperties: false });
const text = { type: 'string', minLength: 1, maxLength: 1000 };
const request_id = { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,128}$' };
const observation = object(Object.fromEntries(['projectId', 'instanceId', 'workflowId', 'tabId', 'revision'].map(key => [key, text])));
const read = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
export function comfyToolsFor(identity: McpIdentity): Tool[] {
  if (!identity.comfy) return [];
  return ([
    { name: 'get_comfy_workflow', description: 'Read the current native root workflow, observation, subgraph path and selection. Keep native tabs/subgraphs/selection intact. update_workflow edits the Mixcat collaboration graph, not this graph.', inputSchema: object({}), annotations: read },
    { name: 'apply_comfy_workflow', description: 'Apply a native root workflow using its last read observation and stable request_id. Supply exactly one small inline workflow or project-local workflow_path (UTF-8 JSON, up to 8 MiB). The engine captures the file; the host never executes paths or scripts. Read back after editing. Reuse request_id after uncertain delivery.', inputSchema: { ...object({ observation, request_id, workflow: { type: 'object' }, workflow_path: text }, ['observation', 'request_id']), oneOf: [{ required: ['workflow'], not: { required: ['workflow_path'] } }, { required: ['workflow_path'], not: { required: ['workflow'] } }] } },
    { name: 'restore_comfy_workflow', description: 'Restore a captured version using the current observation and a stable request_id.', inputSchema: object({ observation, request_id, version_id: text }) },
    { name: 'inspect_comfy_nodes', description: 'Inspect actual native runtime node input/output definitions. node_types must contain 1–50 exact class types. Reports missing node types explicitly; runtime setup can take time.', inputSchema: object({ node_types: { type: 'array', items: text, minItems: 1, maxItems: 50, uniqueItems: true } }), annotations: read },
    { name: 'run_comfy_workflow', description: 'Queue the last observed native workflow with a stable request_id. This is an initial queue receipt, not a finished output. Inspect get_comfy_run after uncertainty; never use a new ID to repeat an uncertain paid submission.', inputSchema: object({ observation, request_id }) },
    { name: 'get_comfy_run', description: 'Read current run state and assets. Recovery may download accepted provider work and take time; timeout does not mean submission failed. assets are final native outputs; recoveredAssets are provider intermediates, not native success.', inputSchema: object({ run_id: text }), annotations: read },
    { name: 'stop_comfy_run', description: 'stop_waiting stops waiting; it does not guarantee remote cancellation. cancel_remote requests supported cancellation and reports the actual outcome.', inputSchema: object({ run_id: text, action: { enum: ['stop_waiting', 'cancel_remote'] } }) },
  ] satisfies Tool[]).filter(tool => identity.tools.includes(tool.name as WorkflowTool));
}

export const comfyInstructions = `当前项目使用完整原生 ComfyUI。内置供应商节点为 MixcatAPIText、MixcatAPIImage、MixcatAPIVideo；原生参考图、缩放与保存可检查 EmptyImage、ImageScale、SaveImage、SaveVideo。构建空图前必须用 inspect_comfy_nodes 查询所用类的真实字段与选项。apply 接收原生工作流 JSON，不是 API prompt：保留读取到的根图 envelope；节点使用 id/type/pos/size/flags/order/mode/inputs/outputs/properties/widgets_values，控件值按实际 required/optional 定义顺序排列；连接用 [id,源节点,源插槽,目标节点,目标插槽,类型]，并同步 input.link/output.links 及 last_node_id/last_link_id，修改后回读原生规范化结果。缺少连接时请用户在可信供应商设置中配置，不要索要聊天中的 Key。修改前用 get_comfy_workflow 读取根图与 observation；用 inspect_comfy_nodes 查询实际节点字段，保留标签页、子图、连接和选区语义。update_workflow 仅修改 Mixcat 协作图。先读取 get_project_context 的 Comfy 连接元数据，使用实际目录中的连接引用（含 revision 编码），绝不填写原始 Key、鉴权头或任意 API 基址。除非用户明确选定其他模型，否则采用连接配置的默认模型。apply/run 必须用读取到的 observation 和稳定 request_id；提交不明时查询原请求/当前运行，不改 ID 重复提交。用户已请求且授权范围内的生成可直接执行；不能自行扩大付费次数或超范围重试。队列受理不是生成完成；用 get_comfy_run 核对当前状态与实际产物，并将用户反馈关联到具体运行和产物。assets 是原生最终成果，recoveredAssets 是恢复的供应商中间成果；stop_waiting 不表示远端取消。`;
