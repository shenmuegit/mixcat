# Mixcat MCP 节点协作实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development（沿用用户已选的逐任务子 Agent 实施与评审）。Steps use checkbox syntax for tracking. 本计划已获用户确认；逐任务实施，每项经规格与质量评审，再进行整体复核。

**日期：** 2026-10-21（UTC+08:00）。
**状态：** 书面规格和本计划已确认；正在逐任务实施。
**Goal:** 让项目内独立 Codex 会话通过 MCP 发现协作者、自由发送和回复、查询记录并编辑工作流，同时保留原生能力、旧工具及可核对的执行历史。
**Architecture:** 扩展现有 MCP 网关、WorkflowEngine、项目 SQLite 和节点 FIFO。普通消息持久受理后排队，回复关联原消息，执行状态由已有任务和节点生成；流程编辑复用 UI 的校验与提交，兼容 handoff 的来源完成门槛。
**Tech Stack:** 现有 Node.js 24+、TypeScript、Node SQLite、MCP TypeScript SDK 1.32.1、React、Electron、React Flow、Ajv/Zod；不升级或增加依赖。
**Spec:** [MCP 节点协作规格](../design/2026-10-21-mcp-collaboration-design.md)，执行者必须同时阅读该规格。
**基线：** 当前代码来自 a424d01，规格提交为 c94dd95；仓库为项目内 Git，origin 为公开仓库 shenmuegit/mixcat。旧实施计划中“不是 Git 仓库”的历史规则不适用于本阶段。

## Global Constraints

- 每节点复用自己的原生 Thread 和历史，cwd 始终为项目目录。
- 业务内容自由，不要求 summary、verdict 或统一业务 Schema；字符串不 trim，null、false、0、空字符串、数组、对象均能完整保存。
- 条件边指导选择，允许同项目无连线发送，保留理由与可选边版本快照；不引入自然语言真假解释器。
- 普通发送不结束来源；显式回复，不自动广播普通输出；无默认审查门槛、固定角色编号或二次审查。
- 每节点只有一份权威多值运行状态；等待回复不新增状态或暂停锁；暂停节点收消息不自动启用。
- request_id 为 1–128 个字母、数字、下划线或连字符；单次单目标；不实现自动 join、多目标原子发送。
- schema version 升至 3；v1/v2 保留原字段、Thread、旧 handoffs 与历史，新工具不因迁移自动授权。
- 现有 handoff/complete_task 及旧 update_workflow 单 node 参数保持兼容；新工具权限不能关闭原生工具。
- 仅使用项目内非 C 盘目录；创建前校验绝对路径和祖先链接。不得写系统临时目录，不使用实际用户项目或登录材料测试。
- prototypes/ 保持归档；测试沿用 .runtime/implementation/fixtures，新增综合证据归 .runtime/implementation/mcp-collaboration/，构建归 dist/client/。
- 本阶段不需要新服务、消息中间件、安装包或新工作树。执行时如需隔离工作树，必须放在本项目内部，保留已有提交及无关改动。
- 提交精确列出的文件；不使用 git add .，不自动 push、发布或修改真实项目数据。
- 本计划中的代码与测试块是实施要求，不是已执行结果；完成对应验收后再更新交付矩阵。

## Review Focus

1. 附件准备期间来源被暂停/停止、目标被删除、条件被修改：提交前重读身份、控制状态、目标与版本；任务 1/2/5 用门闩测试。
2. 回执丢失后换 Turn 重试，或同一次原生调用更换 request_id：取回同一持久受理结果或拒绝冲突，不重复投递；任务 1/3 测试。
3. B 接收 A 的消息失败，用户确认重试：新尝试保留原消息来源、附件和 reply_to，原回执不改写；任务 3 测试。
4. 查询分页时有新消息、相同/缺失时间，或界面定位到另一节点的旧回复：游标不跨项目串用，顺序稳定，定位不改变草稿；任务 2/6 测试。
5. 编辑者保留目标原有流程修改权与新增授予混淆：旧参数不扩权，新参数只委派自己有的新工具；任务 4 测试。

## 文件和接口边界

| 文件 | 责任 |
| --- | --- |
| src/shared/types.ts、src/core/model.ts | 对外参数/回执、消息事实、任务尝试关联；不复制节点状态 |
| src/core/collaboration.ts（新增） | 消息参数和重放检查、投递查询及上下文/历史的纯数据处理；不管理进程或数据库 |
| src/core/engine.ts | 绑定身份、原生生命周期、候选状态提交、任务调度及 UI/MCP 共用图编辑 |
| src/core/store.ts | v3 数据读写、兼容迁移；继续保存一份项目状态 |
| src/core/history.ts | 原始来源、消息和回复关联；系统重试说明独立于原文 |
| src/shared/conversation-order.ts（新增） | 从现有 renderer 提取同一个会话排序函数，供 MCP 和界面使用 |
| src/core/message-files.ts（新增） | 已登记附件解析、项目内不可变快照、摘要与安全文件引用 |
| src/core/mcp.ts | Schema、工具目录、真实元数据、回执/错误；不加入调度逻辑 |
| src/renderer/NodeSettings.tsx、Conversation.tsx、Workbench.tsx | 工具选择、回复定位和既有画布/聊天布局 |
| tests/collaboration-fixture.ts（新增） | 复用 runtime-fixture；通过用户配置入口授权测试节点，真实本地 HTTP 调工具 |
| scripts/dev.ps1、scripts/verify-desktop.mjs | 项目内环境下的聚焦测试、已有隔离 Electron 综合故事 |
| README.md、docs/design/ | 实际完成后的英文说明和交付状态 |

固定的新契约：

- MessageAttachmentInput：{path:string} 或 {artifact_id:string}，两者只能出现一种；任务 1 定义，任务 5 接通非空内容。
- SendMessageInput：request_id、to_node_id、content、reason；attachments?: MessageAttachmentInput[]、reply_to?、route? 按规格第 5 节。
- MessageReceipt：accepted: true、message_id、target_task_id、accepted_at；重放返回同一份事实。
- AttachmentSnapshot：artifact_id、name、relativePath、sha256、size。relativePath 是宿主控制的项目内路径，不接受调用方直接提供快照目的地。
- StoredMessage：MessageReceipt 加 request、fromNodeId/fromName、toNodeId/toName、sourceTaskId、threadId/turnId/callId、attachments、edgeSnapshot。request 保存规范化信封，content 保留原始 JSON。
- ProjectState 增加 messages: StoredMessage[] 和 workflowReceipts: StoredWorkflowEditReceipt[]。StoredTask 增加 incomingMessageId?、retryOfTaskId?；ConversationEntry 增加 messageId?、replyTo?。
- WorkflowEditInput：{operation:'save_node',request_id,node,related_to?,condition?} 或 {operation:'save_edge',request_id,edge}。旧 {node} 仍走旧契约。
- WorkflowEditReceipt：accepted: true、request_id、operation、node?、edge?。StoredWorkflowEditReceipt 为 {receipt: WorkflowEditReceipt, nodeId: string, request: WorkflowEditInput, threadId: string, turnId: string, callId: string}，只在 core/model.ts 定义；成功响应不含身份 token。
- HistoryQuery：node_id?、task_id?、message_id?、reply_to?、limit?、cursor?；HistoryPage：entries、next_cursor。
- MessageSummary：message_id、target_task_id、sourceTaskId、fromNodeId/fromName、toNodeId/toName、replyTo、accepted_at。ProjectSnapshot.messages? 仅发布该摘要，不重复广播消息原始内容或凭据。
- WorkflowErrorCode 包含规格第 10 节的八种稳定 code；新增工具错误形状为 MCP isError=true、content 中可读说明、structuredContent.error={code,message}，旧工具保留旧错误表现。
- read-only 工具为 get_project_context/get_delivery/read_history；身份与授权始终校验。读工具不因缺少活动任务而不可查询，传入原生关联时仍拒绝伪造归属；get_project_context.task 无匹配时为 null。新写入必须绑定可执行的实际来源任务，合法已受理重放可来自原 Turn 或同节点合法续接。

规范化只处理信封的缺省值：attachments 缺省为空数组，reply_to/route 缺省为 null；不重排正文数组或改变正文字符串。请求比较使用 Node isDeepStrictEqual，不以 JSON 字符串键排列或正文相似度去重。稳定回执按项目/来源节点/request_id 查找，工具命名空间分开；同时检查首次原生调用与请求编号的对应关系。

## 执行与验证约定

任务 1 在现有 scripts/dev.ps1 增加仅供 test 使用的剩余 TestFiles 参数，空值仍跑 tests/*.test.ts；沿用原脚本的 Node 24 发现、路径校验和项目内临时/缓存环境，不另建测试启动器。之后聚焦命令统一为：

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev.ps1 test tests/collaboration.test.ts tests/mcp.test.ts
~~~

任务 1 的初次 RED 可先用原脚本跑整套，确认新增断言失败；增加聚焦参数后，检查输出确实只包含指定文件。各任务 RED/GREEN 跑自己的用例与相邻旧回归；最后任务 7 统一跑全套、类型和构建。

测试帮助接口由任务 1 提供：collaborationFixture(t)，返回原 fixture 的 root/projectId/clients/engine/send，以及实时 state/store、active(nodeId)、context(nodeId,callId)、invoke(nodeId,tool,args,callId)、finish(nodeId,status='completed')、reopen()。active 复用已有运行任务或通过原用户发送入口启动；invoke 使用真实 /mcp HTTP 和从任务取得的 Thread/Turn/call，不绕过网关。reopen 沿用合成账号和原生工厂，每个新引擎登记关闭清理，不访问真实凭据。

---

### Task 1：普通消息的持久受理与独立投递

**Files:** 创建 src/core/collaboration.ts、tests/collaboration-fixture.ts、tests/collaboration.test.ts；修改 src/shared/types.ts、src/core/{model,store,engine,history,mcp}.ts、scripts/dev.ps1；扩展 tests/mcp.test.ts、tests/recovery.test.ts。

**Interfaces:** 消费旧 WorkflowEngine.commit/addTask/nodeIdentity、ProjectStore 和 runtime-fixture。产出 SendMessageInput/MessageReceipt/StoredMessage、schema v3、MCP send_message/get_delivery、MessageSummary。collaboration.ts 定义 parseMessageInput(value: Record<string,unknown>): SendMessageInput、findMessageReceipt(state: ProjectState,nodeId: string,input: SendMessageInput,context: McpCallContext): MessageReceipt|null、deliveryView(state: ProjectState,nodeId: string,args: {message_id?:string;request_id?:string}): object。引擎私有 sendNodeMessage(state: ProjectState,args: Record<string,unknown>,context: McpCallContext): Promise<MessageReceipt> 负责提交与调度。

- [x] **1. 写失败测试。** 保存如下断言，并覆盖 v1/v2→v3 保留所有旧字段/未知来源、默认工具授权不变。创建 tests/collaboration-fixture.ts 的实际帮助接口，设置节点授权走 save_node。
~~~ts
const f = await collaborationFixture(t);
const a = await f.active('plan');
const receipt = await f.invoke('plan', 'send_message', {
  request_id: 'first', to_node_id: 'implement',
  content: { custom: [false, null, 0, ''], text: ' 原文\n ' }, reason: '协作'
}, 'call-1');
await until(() => f.state.tasks.some(x => x.id === receipt.target_task_id && !!x.turnId));
assert.equal(a.status, 'running');
assert.equal(a.terminal, null);
assert.equal(a.result, null);
assert.equal(f.state.tasks.find(x => x.id === receipt.target_task_id)?.incomingMessageId, receipt.message_id);
assert.equal(f.state.conversation.find(x => x.messageId === receipt.message_id && x.direction === 'input')?.source?.kind, 'node');
~~~
- [x] **2. 运行 RED。** 原脚本运行 test；预期新工具或新字段断言失败，旧文件仍能装载。加入 TestFiles 后用上方聚焦命令验证文件筛选，不改变 install/start/build/typecheck 的调用。
- [x] **3. 实现最小受理闭环。** 扩充工具枚举与 Schema，send_message 分支必须在旧 result 必填判断之前。读 get_delivery 不要求活动来源；新写核验真实身份/授权/原生关联/可执行任务。新任务设置 nativeInput，避免继承旧演练 12 轮上限；原始 JSON 单独保存，传给模型的来源说明不覆盖原文。回复基本校验和 route 基本版本校验在本任务实现，任务 2/3 再验收相关查询与竞态。非空附件在任务 5 完成前明确拒绝，不能静默丢弃。
- [x] **4. 实现持久重放与原子提交。** 入参在异步等待前 structuredClone；保存 message+目标任务+输入历史+源发送事件；先查成功回执，再检查目标/来源当前状态。相同键与相同内容取原回执，不同内容/同原生调用更换编号拒绝。候选经现有 commit 保存成功后才可调度；不得复用 UI send_message 的用户身份与重置停止意图。v1/v2 迁移补空集合、保存版本 3，新建项目初始化同样字段。
- [x] **5. 运行 GREEN 和失败回归。** 新增 SQLite reject_save 触发器断言磁盘与内存均不出现消息/任务/输入/成功回执；相同请求并发只生成一个任务；正文对象键顺序不产生新消息，数组顺序/字符串改变则冲突；同正文新编号可产生第二条。源 Turn 失败不撤销新消息，旧 handoff 仍等待来源成功。命令：test tests/collaboration.test.ts tests/mcp.test.ts tests/handoff.test.ts tests/recovery.test.ts。
- [x] **6. 评审并提交。** 规格与质量评审通过后，精确 git add 本任务文件；提交 feat: add durable nonterminal node messaging。旧 handoff/complete_task 的输入、回执和错误不可因新目录一起改变。

### Task 2：协作上下文、条件依据和分页历史

**Files:** 修改 src/core/{collaboration,engine,mcp}.ts、src/shared/types.ts；创建 src/shared/conversation-order.ts、tests/collaboration-queries.test.ts；修改 src/renderer/Conversation.tsx 的排序导出与 tests/history.test.ts。

**Interfaces:** 消费任务 1 的消息/任务关联。定义 projectContext(state: ProjectState,nodeId: string,task: StoredTask|null): object、readConversationPage(state: ProjectState,query: HistoryQuery): HistoryPage。把现有 orderedConversation(entries: ConversationEntry[]): ConversationEntry[] 提取到 shared，renderer 重新导出以保留旧调用者。新增 MCP read_history；扩充 get_project_context 的可选 include_capabilities。

- [x] **1. 写失败测试。** 默认上下文保留 project/task/nodes/remainingSteps，同时返回 self、edges、incoming_message；引用边快照由后台复制。查询不依赖当前账号连接，伪造原生归属/跨项目编号拒绝。
~~~ts
const ctx = await f.invoke('plan', 'get_project_context', {}, 'context');
assert.deepEqual(ctx.edges, f.state.edges);
assert.equal(ctx.self.id, 'plan');
assert.equal(ctx.remainingSteps, null);
const first = await f.invoke('plan', 'read_history', { limit: 1 }, 'history-1');
assert.equal(first.entries.length, 1);
assert.ok(first.next_cursor);
~~~
- [x] **2. 运行 RED。** test tests/collaboration-queries.test.ts tests/history.test.ts；预期缺少上下文字段或 read_history，不能把完整旧结果放宽为任意对象来通过。
- [x] **3. 实现查询和选路依据。** 默认上下文只读内存已有事实。include_capabilities=true 才复用 runtime/loadCapabilityCatalog，等待在提交区间外，检查关闭与实例归属，保留部分失败。新 route 需来源/目标相符且 revision 当前；被修改或删除返回 ROUTE_CHANGED，无边发送仍可直接成功；旧消息保留旧边快照。
- [x] **4. 实现有界历史读取。** 默认 limit=50、上限=200；cursor 携带项目、过滤条件、排序位置及 seq 上界，做形状与一致性校验，不带 token。过滤 node/task/message/reply_to，排序严格复用 shared 函数；对新增消息不纳入当前遍历，对未知时间不编造。普通旧输出通过 task.incomingMessageId 也能按消息查询。保留原始条目，只做返回值分页。
- [x] **5. 运行 GREEN。** 门闩挂起能力目录时默认 context、控制和消息查询仍可用；测试 0/负数/201/非整数 limit、破损/跨项目/改过滤条件 cursor、等价时区时间/未知时间/相同 seq 的稳定排序、分页中插入新消息不重复漏旧条目。旧排序与补读测试继续通过。命令：test tests/collaboration-queries.test.ts tests/history.test.ts tests/session-renderer.test.ts tests/recovery.test.ts。
- [x] **6. 评审并提交。** 精确提交本任务文件，消息自由内容与底层 JSON 存储不变；提交 feat: expose collaboration context and paginated history。

### Task 3：显式回复、任务重试和暂停恢复

**Files:** 修改 src/core/{engine,history,collaboration}.ts、src/core/worker.ts（仅恢复调度所需接点）、src/shared/types.ts；创建 tests/collaboration-lifecycle.test.ts；扩展 tests/pause.test.ts、tests/recovery.test.ts、tests/history.test.ts。

**Interfaces:** 消费 MessageReceipt 和 incomingMessageId。finishTurn 仅更新当前接收尝试，普通消息不进入 terminal handoff 分支。retry_task 以 incomingMessageId/retryOfTaskId 关联原消息；get_delivery 的 receipt 保持不变，attempts 列出该消息实际接收任务。复用原 turn/interrupt、paused 确认及 resume 控制。

- [x] **1. 写失败测试。** A→B 后，B 向 A 显式回复，A 忙时回复只排队，A 结束后原 Thread 开新 Turn；B 普通输出不自动生成消息。
~~~ts
const original = await sendFromA(f);
const aThread = f.state.tasks.find(x => x.nodeId === 'plan')!.threadId;
await f.invoke('implement', 'send_message', {
  request_id: 'reply-1', to_node_id: 'plan', reply_to: original.message_id,
  content: ' 原样答复 ', reason: '回复原请求'
}, 'reply-call');
assert.equal(f.state.tasks.filter(x => x.nodeId === 'plan' && x.status === 'running').length, 1);
f.finish('plan');
await until(() => f.state.tasks.some(x => x.nodeId === 'plan' && x.incomingMessageId !== undefined && !!x.turnId));
assert.equal(f.state.tasks.filter(x => x.nodeId === 'plan').at(-1)!.threadId, aThread);
~~~
sendFromA 是本测试文件内的局部测试帮助，调用任务 1 的 f.invoke；不是新增产品函数。
- [x] **2. 运行 RED。** test tests/collaboration-lifecycle.test.ts tests/pause.test.ts tests/recovery.test.ts，重点确认当前 retry_task/初始化对 queued 的处理与新契约不符。
- [x] **3. 补齐回复与等待。** reply_to 校验同项目原收件者回原发件者，非法关系报 INVALID_REPLY；来源已归档报 TARGET_UNAVAILABLE。更新传给 Codex 的稳定协作说明，区分来信与回复，不要求固定下一节点或审查。不提供阻塞式 wait；普通会话结束完成本次任务，不把所有普通消息节点空闲解释为目标已经验收。
- [x] **4. 修正重试与恢复。** retry_task 候选原子提交，复制 incomingMessageId/附件和真实原文、记录 retryOfTaskId，系统重试说明独立记录；旧 handoff 取消逻辑只处理旧 handoffs。初始化不得把未派发新消息一概当活跃执行或用户暂停：queued 且无原生派发关联的任务在节点允许且账号就绪后可调度；running/结果未知保持 needs_reconciliation；confirmed paused 保留。账号未就绪时保持未派发队列，保存登录恢复/登录完成后唤醒，不发起交互登录，也不把缺账号误记为任务已执行失败。
- [x] **5. 运行 GREEN。** 验证：A 运行/B 空闲→项目暂停→批量恢复只续 A，B 保持待命并能收新消息；单独启用覆盖项目暂停。源单独停止不撤回已受理消息，项目停止可取消未派发目标。B 失败→确认重试→仍识别 A 并回复原消息；原 target_task_id 不变、attempts 增加。重启丢回执取原结果、未知 turn 零自动重放、无已保存账号时零派发、登录恢复后 queued 可继续。测试等待期间晚到旧事件不能结束新 turn。命令：test tests/collaboration-lifecycle.test.ts tests/pause.test.ts tests/recovery.test.ts tests/history.test.ts tests/account-global.test.ts。
- [x] **6. 评审并提交。** 精确提交文件；提交 fix: preserve message identity across control and recovery。不得新增 waiting_reply、第二组节点暂停 flags 或自动回复触发器。

### Task 4：带版本和授权边界的工作流编辑

**Files:** 修改 src/core/{engine,mcp,collaboration}.ts、src/shared/types.ts、src/core/model.ts；创建 tests/collaboration-workflow.test.ts；扩展 tests/workflow.test.ts、tests/catalog.test.ts。

**Interfaces:** 消费 include_capabilities、workflowReceipts。引擎内部 applyNodeChange(draft: ProjectState,node: NodeDefinition,actor: McpIdentity|null,relatedTo?: string,condition?: string): StoredNode、applyEdgeChange(draft: ProjectState,edge: WorkflowEdge): WorkflowEdge 为同步校验/候选修改，UI 和 MCP 各自在一次 commit 中调用。私有 editWorkflow(state: ProjectState,args: Record<string,unknown>,context: McpCallContext): Promise<object> 处理新 operation 与旧参数分支，不直接重放 AppCommand。

- [x] **1. 写失败测试。** 具备 update_workflow 的 A 建 B 和初始边，返回实际 revision；请求回执丢失后重放不再新增节点。模拟 SQLite 失败，节点/边/回执全不出现。
~~~ts
const before = structuredClone(f.state);
rejectSave(f.store);
await assert.rejects(f.invoke('plan', 'update_workflow', request, 'edit-call'));
assert.deepEqual(f.state, before);
~~~
request 使用本任务接口的 save_node，node/related_to/condition 为测试中实际存在的来源及新编号；rejectSave 沿用 handoff.test.ts 的 SQLite trigger。
- [x] **2. 运行 RED。** test tests/collaboration-workflow.test.ts tests/workflow.test.ts，当前新 operation 缺失应失败。
- [x] **3. 共用候选修改。** 从现有 saveNode/save_edge 校验提取上述同步方法，保留名称/模型/技能/插件/初始位置/既有布局/忙碌/版本/归档 ID 规则。save_edge 和 delete_edge 的 UI 路径改为 commit 后发布，失败不留下候选边；删除仍不开放给 MCP。新 operation 的 node/edge/成功回执同次提交，调用真实能力目录确认新增选择，目录失败明确报错，默认模型 null 仍合法。目录等待后重新核验身份、来源控制、节点版本、所选来源与目标。
- [x] **4. 固定授权和旧兼容。** 比较目标原有 tools 与本次新增项；新 send_message/get_delivery/read_history 只能委派编辑者已具备的工具。新 operation 可保留目标原有 update_workflow，但不能新增授予；旧 {node} 不新增必填 request_id，并保留旧权限/结果形状。旧形态不能因扩展全局 enum 而新增授予新工具；回执命名空间按 send_message/update_workflow 分开，事务中重放同键不同内容报 REQUEST_CONFLICT。
- [x] **5. 运行 GREEN。** 覆盖 stale revision、目录挂起时用户改节点/暂停来源、busy/queued/reconciliation 目标不能改、伪造模型/skill/plugin、null 默认模型、Agent 不能自授流程编辑权、保留既有编辑权不误拒绝、旧工具形态输入与旧回归保持。已受理消息的目标配置快照不被后续图编辑改写。命令：test tests/collaboration-workflow.test.ts tests/workflow.test.ts tests/catalog.test.ts tests/mcp.test.ts。
- [x] **6. 评审并提交。** 精确提交本任务文件；提交 feat: support versioned workflow edits through MCP。

### Task 5：固定附件版本与安全资源引用

**Files:** 创建 src/core/message-files.ts、tests/message-files.test.ts；修改 src/core/{collaboration,engine,store}.ts、src/shared/types.ts、src/desktop/panel-files.ts（仅资源解析/打开适配所需）；扩展 tests/collaboration.test.ts、tests/panel-files.test.ts。

**Interfaces:** 消费任务 1 的 MessageAttachmentInput。prepareMessageAttachments(root: string,state: ProjectState,input: MessageAttachmentInput[]): Promise<AttachmentSnapshot[]>；resolveMessageArtifact(root: string,state: ProjectState,id: string): string。快照登记在对应 StoredMessage，不另引入附件数据库；同项目已提交消息快照和可核实的宿主导入附件才是有效 artifact_id，不能按 ID 直接拼私密目录路径。

- [x] **1. 写失败测试。** 项目文件发送后修改原文件，再按回执读取附件仍是旧字节和摘要；相同请求重试不重读源文件，新请求可取得新版本。
~~~ts
writeFileSync(join(f.root, 'report.txt'), 'v1');
const first = await sendAttachment(f, { path: 'report.txt' });
writeFileSync(join(f.root, 'report.txt'), 'v2');
const delivered = f.state.messages.find(x => x.message_id === first.message_id)!;
assert.equal(readFileSync(resolveMessageArtifact(f.root, f.state, delivered.attachments[0].artifact_id), 'utf8'), 'v1');
~~~
sendAttachment 是局部帮助，复用 f.invoke 并提供唯一 request_id，不绕过受理路径。
- [x] **2. 运行 RED。** test tests/message-files.test.ts tests/collaboration.test.ts tests/panel-files.test.ts，非空附件尚未接通必须失败。
- [x] **3. 实现快照。** 在 .mixcat/artifacts/messages/ 下用随机目的地和独占创建写快照，记录字节长度/SHA-256/名称/相对路径；请求方不指定目的地，登记前的文件不参与查询。已有 artifact_id 按本项目持久记录解析，再走路径/文件校验；宿主导入附件的引用只能从已保存的真实输入资源产生，不从任意正文里的路径造登记。对当前原生模型不支持的类型传文件引用，不伪造可理解。
- [x] **4. 接入投递与收尾校验。** 成功回执先于准备检查；新发送准备完附件后重读身份/任务/节点/边及幂等键，在一次 commit 中登记快照和目标任务。并发同键不得登记两份消息；第二次命中原回执时不得以新孤立文件替换旧引用。输入原文与 native 增强提示分开，接收方资源按钮和快照引用指向固定字节；准备或提交失败不成功，孤立文件不自动清除。
- [x] **5. 运行 GREEN。** 覆盖相对越界、绝对/UNC/设备路径、大小写保留目录、ADS、文件/祖先 junction、目录冒充文件、伪造/跨项目 artifact_id、部分附件失败、DB 失败、准备中 stop/pause/delete/改边、重试输入保留。普通项目 .env/.env.example 不按业务内容擅自过滤。命令：test tests/message-files.test.ts tests/collaboration.test.ts tests/panel-files.test.ts tests/paths.test.ts。
- [x] **6. 评审并提交。** 精确提交本任务文件；提交 feat: snapshot collaboration message attachments。不把单文件快照描述成整个工作区冻结或自动复审。

### Task 6：节点能力选择、会话来源与回复定位

**Files:** 修改 src/renderer/{NodeSettings,Conversation,Workbench}.tsx、src/renderer/styles.css、src/shared/types.ts、src/core/engine.ts 的 snapshot 投影；创建 tests/collaboration-renderer.test.ts；扩展 tests/snapshots.test.ts、tests/session-renderer.test.ts、scripts/verify-settings-delete-ui.mjs。

**Interfaces:** 消费 MessageSummary 和 ConversationEntry 的 messageId/replyTo。在原 CapabilityFields 中增设“节点协作工具”勾选项，以 WORKFLOW_TOOLS 为候选，不隐藏原生能力。ConversationFeed 增加可选 onLocateMessage(messageId: string): void；Workbench 负责切换/打开对应节点或项目历史、定位原条目并保留各节点草稿。toWorkflowEdges 增加第三个可选参数 messages: MessageSummary[]= []，旧两参保持有效。

- [ ] **1. 写失败测试。** 节点配置可显式选新工具，旧节点未选的保持未选；来源使用受理时名称快照，回复有可操作关联，消息接收输入右侧、模型输出左侧。
~~~ts
assert.match(html, /节点协作工具/);
assert.match(html, /来源节点 → 接收节点/);
assert.match(html, /查看原消息/);
assert.equal(toWorkflowEdges([], nodes, []).length, 0);
~~~
html 由实际组件和包含 messageId/replyTo 的测试数据渲染，不能仅检查孤立字符串常量。
- [ ] **2. 运行 RED。** test tests/collaboration-renderer.test.ts tests/session-renderer.test.ts tests/snapshots.test.ts。
- [ ] **3. 接通现有布局。** 配置工具勾选由用户显式保存，既有任务锁和配置冲突提示不变。发送/接收事实及回复关系从后台消息/历史产生，不能把配置边当成发送记录；普通消息和旧 handoff 可分别计数标识，零消息不造连线。消息投递显示使用 snapshot.tasks 的真实状态，不存第二份节点状态。
- [ ] **4. 接通定位与资源。** 回复定位切换到真实来源节点；原节点已归档或当前子集无条目时打开项目历史定位，明确缺失记录。保留来源/目标名称、未知时间、正文和当前草稿；资源打开通过现有受限 panel API，不增加 renderer 文件系统入口。沿用淡色细边框和白底，不改用户已确认的项目状态栏、设置位置或登录布局。
- [ ] **5. 运行 GREEN 与真实鼠标检查。** 静态组件测试之外，扩展现有受控 IPC Electron 脚本：实际点击工具选择、保存、回复定位、归档来源历史、资源按钮和项目切换；检查 DOM 几何/命中及截图，不能用直接设 React state 代替交互。验证 delta 合并包含 messages 元数据且旧 generation 不覆盖新页面。命令：test tests/collaboration-renderer.test.ts tests/session-renderer.test.ts tests/snapshots.test.ts；随后按原脚本运行方式执行 verify-settings-delete-ui.mjs，证据写项目内。
- [ ] **6. 评审并提交。** 精确提交本任务文件；提交 feat: expose node collaboration in the workbench。所有提示使用中文，根 README 最后统一保持英文专业说明。

### Task 7：综合验收、旧数据兼容与交付记录

**Files:** 创建 tests/collaboration-http.test.ts；扩展 scripts/verify-desktop.mjs 和相关受控原生 fixture；更新 README.md、docs/design/2026-10-20-delivery-status.md、本计划勾选。必要修复只落到任务 1–6 的责任文件，保持 prototypes 归档不变。

**Interfaces:** 消费前六项全部接口。沿用正式 main/preload/worker 和真实本地 HTTP MCP；原生行为用合成 stdio fixture 驱动，不借真实账号或模型完成确定性验收。

- [ ] **1. 写综合失败断言并核对覆盖。** HTTP 故事包含自由 JSON、无边发送、A 未结束时 B 已开始、B 回复但 A 忙时不重入、A 原 Thread 继续、普通输出无自动广播、无审查节点可完成。另跑配置边编辑/选择、相同键并发/丢回执、用户重试 B、已登记附件跨轮引用。
- [ ] **2. 运行聚焦故事。** test tests/collaboration-http.test.ts。任何失败先定位负责模块，再修改并重跑该模块与此故事；不能修改 fixture 来绕过正式 source/turn/call、SQL 提交或授权检查。
- [ ] **3. 执行隔离 Electron 综合验收。** 扩展现有 verify-desktop 故事而非复制第二套启动器。用真实 worker/MCP 完成消息回流、pause/resume/stop、保存后重启和 queued 恢复；注入“受理后丢回执”和“派发后断连”分别证明可查回执、未知执行不自动再跑；选择模型/skill/plugin 参数仍传入原生请求，cwd 仍是测试项目。用户真实项目保持未访问。
- [ ] **4. 运行最终检查。** 精确命令：
~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev.ps1 test
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev.ps1 typecheck
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev.ps1 build
~~~
再以现有项目内 Node 环境运行 scripts/verify-desktop.mjs，退出 0、result.json passed=true、所属测试进程均关闭，才算该层通过。保存完整测试计数、退出码、范围和截图于 .runtime/implementation/mcp-collaboration/；不预填新的通过数量。只有新变化或失败才重复对应检查。
- [ ] **5. 独立整体评审与修正。** 按保留的子 Agent 执行方式完成最终整体规格/质量复核，至少核对下方 14 项映射、默认权限、重试后消息身份、恢复零重复、旧工具和普通消息隔离。修复后只重跑受影响检查，再核对最终 diff、归档未变和测试资源已释放。
- [ ] **6. 更新文档并提交。** 英文 README 写实际可用工具和当前边界；交付矩阵分别记录真实 HTTP、fixture、Electron、真实 Codex/模型的验证范围。真实模型选路、全部媒体/插件账号或强隔离未验证时保留未知。精确提交最终变更，提交 test: verify MCP collaboration end to end；本阶段不自动 push 或发布安装包。

## 规格验收映射

| 规格第 12 节 | 责任任务 |
| --- | --- |
| 1 默认上下文与目录隔离 | 2 |
| 2 无边自由发送，来源可继续 | 1、7 |
| 3 FIFO、并行与暂停覆盖 | 3、7 |
| 4 原 Thread 关联回复 | 3、7 |
| 5 无自动广播、无强制审查 | 3、7 |
| 6 并发、重启重放、冲突 | 1、3、7 |
| 7 消息/图编辑原子提交 | 1、4 |
| 8 普通消息来源失败、旧交接和未知恢复 | 1、3、7 |
| 9 路由/身份/回复/删除目标校验 | 1、2、3 |
| 10 附件固定版本与路径边界 | 5 |
| 11 受理快照、编辑冲突和忙碌保护 | 2、4 |
| 12 v1/v2、旧工具与 UI 历史 | 1、4、6、7 |
| 13 接收任务重试保留消息身份 | 3 |
| 14 新工具委派与原有编辑权 | 4、6 |

## 自查与后续执行

- [x] 已逐节对照规格，五工具、信封、文件、幂等、控制、旧兼容和 14 项验收均有责任任务。
- [x] 共享接口的名称和参数已固定，任务之间不使用未定义的产品帮助函数；局部测试帮助在对应任务说明。
- [x] 五项 Review Focus 均落实到具体门闩/失败测试。
- [x] 本计划只决定必要接口、测试与步骤，不写完整函数实现、不扩大到新的基础设施。
- [x] 用户已确认本计划；沿用逐任务子 Agent 实施和评审。
