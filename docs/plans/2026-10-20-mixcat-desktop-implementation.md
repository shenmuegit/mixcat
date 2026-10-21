# Mixcat 正式桌面客户端实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (user selected). Steps use checkbox syntax for tracking. The user approved the plan review gate on 2026-10-20; implement tasks continuously with per-task review.

**日期：** 2026-10-20（UTC+08:00）。  
**状态：** 2026-10-20 首阶段实现、八项逐任务独立评审、必要修复复审及最终整体复核已完成；交付本地开发版，未公开发布。  
**Goal:** 交付首阶段可运行、可验收的 Mixcat 桌面客户端：项目卡片进入可编辑工作流，节点使用独立 Codex 会话自由交流并可靠交接，保存原始历史，支持四种运行控制及节点工作面板。

**Architecture:** 沿用 Electron、受限 preload、独立 utility-process 后台、项目级 Codex app-server、本地 MCP 和项目 SQLite 的模块化单体。正式代码位于项目根目录 `src/`，选择性复用归档原型的接入、界面和测试逻辑；归档保持不变。可靠性要求从各任务的测试开始落实，不能将复制原型或历史实验视为正式验收。

**Tech Stack:** Node.js 24+、TypeScript、React、Vite、Electron、React Flow、Node SQLite、MCP TypeScript SDK，以及已有 Ajv/Zod。起步复用归档依赖清单与锁文件；当前本地已安装 Electron 44.9.0、React 19.3.1、React Flow 12.12.0、MCP SDK 1.32.1、TypeScript 5.9.3、Vite 8.3.4，不以“实现正式版”为由额外升级依赖。

**Spec:**

- [客户端功能设计](../design/2026-10-19-mixcat-client-functional-design.md)，包括第 4.4 节两张界面图片。
- [架构可靠性与边界修订](../design/2026-10-20-architecture-hardening.md)。
- [节点状态与暂停覆盖](../design/2026-10-19-node-controls.md)。
- [会话工作台专项设计](../design/2026-10-19-session-workbench-design.md)。

## 本阶段交付范围

实现已明确的项目工作流、会话节点、模型和能力选择、条件保存编辑、自由消息和附件、交接回流、原始历史、运行控制、审批及宿主工作面板。界面以归档的像素元素版图片为准，功能数据来自后台。

下列内容继续保留为后续目标，不在本计划中擅自定稿：新版工作流 MCP 工具与条件选路、多目标汇合、自动文件合并、完整条件图生成、确定版本审查自动化、笔记与知识库服务、ComfyUI。左侧保留“项目／笔记／知识库”导航，但后两项明确处于待设计阶段，不伪造内容或搜索结果。

Agent 内嵌浏览器控制桥、MCP App UI 双向桥和完整交互式终端仍是需要交付的能力目标。本阶段先接通已有明确契约的网页/文件宿主面板及原生交互；三个扩展桥另作协议调查与实施计划，不把预览面板当作它们已经完成。

## Global Constraints

- 独立桌面应用，在 Mixcat 内操作 Codex 原生会话，不要求与官方桌面客户端共享会话。
- 每个节点各自只有一份权威、多值 `status`；四种暂停/开启操作在作用范围内相互覆盖，项目状态与恢复名单不形成额外锁。
- 全部暂停/开启的范围是当前项目；A 运行、B 空闲时，批量恢复只续接 A，B 待命且可接收新交接。
- 节点 cwd 固定为所属项目目录；同节点串行，不同节点可分别执行，不为节点自动创建工作树。
- 普通输入输出自由，不要求 `summary`、`verdict` 或固定业务 Schema，不强制 MCP 终结动作。
- 模型、skill、插件选择是配置与激活偏好，只增加协作能力，不将未选原生能力禁用。
- 原始正文、native item、来源、时间及线程关联保留；摘要不覆盖原文，不伪造未知时间。
- 所有工作数据保存在所属项目内且不在 C 盘；创建前校验真实路径及祖先，拒绝符号链接/目录联接逃逸。
- `prototypes/` 保持归档；真实项目、登录信息和已有 `.runtime/` 数据不自动迁移、清空或用于破坏性测试。
- 正式构建输出到 `dist/client/`，工作台开发数据放 `.runtime/client/`，验证证据放 `.runtime/implementation/`；节点数据仍归各项目的 `.mixcat/`。
- 当前目录不是 Git 仓库。不为工具流程初始化 Git、创建工作树或制造提交；使用文件备份、校验及任务记录。若以后引入 Git，再按单独授权处理。
- 本轮完成验收才更新“已实现”标记；真实模型、协议 fixture、桌面交互、图片验收分别记录。

## Review Focus

1. 交接写库失败后重试：不得因未提交内存记录返回成功；由任务 5 验证。
2. 同时初始化两个节点及旧客户端迟到回调：只能有一个有效项目运行时；由任务 2、8 验证。
3. 慢 RPC 中发送后停止、关闭或超时：不得迟到新增任务或自动重复派发；由任务 4、8 验证。
4. 历史补读、增量与切换项目乱序：不得倒退终态、切回旧项目、清除新草稿或伪造作者；由任务 6 验证。
5. 原生网页与菜单、节点切换、文件路径交错：不得盖住操作、串节点或越界读写；由任务 7 验证。

## 文件与接口边界

| 位置 | 责任 |
| --- | --- |
| 根目录配置、`scripts/` | 正式安装、开发、构建、启动和检查入口，输出与原型隔开。 |
| `src/core/engine.ts`、`model.ts` | 项目/节点/任务调度与状态，实际交接的唯一入口。 |
| `src/core/store.ts`、`history.ts` | 持久提交、兼容迁移、原始历史与来源。 |
| `src/core/codex.ts`、`catalog.ts`、`mcp.ts` | 原生连接、能力目录及现有工作流 MCP 兼容接入。 |
| `src/core/commands.ts` | 最小命令编号、受理查询与调度分类，不维护另一套节点状态。 |
| `src/shared/types.ts`、`snapshots.ts` | 命令、会话来源、完整基线与增量合并契约。 |
| `src/shared/native-requests.ts`、`src/core/native-responses.ts` | 前者提供纯请求分类，后者负责后台回应校验；Ajv 不进入界面模块。 |
| `src/desktop/` | 窗口/托盘、受限 IPC、网页及文件面板生命周期。 |
| `src/renderer/` | 极简像素布局、画布、配置、会话与原生交互，不直接访问数据库或 shell。 |
| `tests/` | 从归档测试提取可复用用例，增加正式契约的失败回归及隔离桌面验收。 |

基础签名沿用原型的 `WorkflowEngine.init/command/subscribe/close`、`CodexPort.connect/rpc/close`、`ProjectStore.read/save/artifact/close` 和 `PanelCommand`。新增接口在所属任务中定义，不提前建立通用插件框架。

---

### Task 1：正式入口与项目卡工作台

**Files:** 创建根目录 `package.json`、`package-lock.json`、`tsconfig.json`、`vite.config.ts`、`index.html`、`.npmrc`、`scripts/{dev.ps1,build.mjs,start.mjs}`、`src/desktop/{main,preload}.ts`、`src/core/{paths,store,worker,engine,model}.ts`、`src/shared/types.ts`、`src/renderer/{main,App}.tsx`、`src/renderer/styles.css`；复用依赖代码按编译需要一并移入正式 `src/`，不保留跨向 `prototypes/` 的产品 import。测试 `tests/{paths,projects}.test.ts`。

**Interfaces:** 消费归档的 `AppCommand` 和 `AppReply` 基础契约；产出 `create_project`、`snapshot` 命令及可用的 `window.mixcat.command/subscribe`，工作台索引归 `.runtime/client/`，构建加载路径归 `dist/client/`。

- [x] 在项目创建/恢复 fixture 上先加入失败测试：名称、目标、root 重启后不变；相同 root 不重复创建项目；C 盘/junction 在产生目录前拒绝；不得改用户项目根 `.gitignore`。
- [x] 运行 `powershell -NoProfile -File scripts/dev.ps1 test`，确认新契约失败；首次尚无脚本时用已提供 Node 24 运行同一组测试，路径和缓存仍归项目。
- [x] 按上表恢复正式运行入口并选择性复用原型；实现固定左栏、项目卡列表、卡片进入工作流。复用像素 SVG、淡紫选择与细边框，正文保持正常字体；页面中不放硬编码示例项目数据。
- [x] 通过测试、typecheck、build，并实际打开隔离 Electron 的项目列表和创建项目流程；对比功能设计第 4.4 节的项目页。验证归档清单哈希未变。
- [x] 将证据与任务完成状态记入 `.runtime/implementation/` 和本计划，不生成 Git 提交。

### Task 2：节点配置与第一条真实会话路径

**Files:** 修改 `src/core/{engine,codex,catalog}.ts`、`src/shared/types.ts`、`src/renderer/App.tsx`；创建/复用 `src/renderer/{Workbench,NodeSettings,Conversation}.tsx`。测试 `tests/{runtime,session,catalog}.test.ts`。

**Interfaces:** 消费任务 1 的项目与 IPC。保留 `send_message({projectId,nodeId,input,mode})`、`catalog({projectId})`，沿用 `NativeInput[]`；扩展 `CodexPort.info?(): NativeRuntimeInfo`，运行信息来自实际二进制和初始化回执，未知可空。项目运行时的初始化 Promise 与有效实例身份由引擎统一维护。

- [x] 先写 `concurrent_first_messages_share_runtime`、`old_runtime_callbacks_are_ignored`、`node_queue_reuses_thread_and_project_cwd`；断言一个客户端初始化、各节点不同 thread、同节点不并发 turn、旧回调不改变当前实例。
- [x] 运行对应 Node 测试，观察当前原型逻辑的并发/旧回调用例失败。
- [x] 实现节点名称、职责、模型、skills/plugins 选择及能力目录错误展示；复用当前原生输入与插件导入逻辑。连接初始化共享、失败后重建、所有异步回调核对有效实例；普通会话成功无需调用 MCP。
- [x] 验证文本、图片/音频/文件引用、模型/skill/plugin 参数与实际 cwd；目录某来源失败不抹掉其他来源。界面左侧输出、右侧输入，节点草稿与发送目标一致；忙时可排队。
- [x] 记录协议 fixture 与实际无模型目录检查的结果，真实登录/模型尚未验证时保持未验证，不复制宿主凭据。

### Task 3：可编辑工作流与条件说明

**Files:** 修改 `src/renderer/{Workbench,NodeSettings}.tsx`、`src/renderer/styles.css`、`src/core/engine.ts`、`src/shared/types.ts`。测试 `tests/{workflow,renderer}.test.ts`。

**Interfaces:** 消费任务 2 的节点；保留 `save_node`、`move_node`、`save_edge`、`delete_edge` 和 `WorkflowEdge` 的 `sourceNodeId/targetNodeId/condition/revision`。布局与配置版本分开。

- [x] 写失败测试 `related_node_and_edge_commit_together`、`move_preserves_revision_thread_and_identity`、`stale_config_cannot_undo_recent_layout`；断言节点/边同时保存、移动不换 thread/token、旧配置不能覆盖新坐标。
- [x] 运行测试确认失败，再复用 React Flow 与现有校验实现右键画布、右键节点及键盘等价入口。
- [x] 完成关联条件编辑/删除、配置 revision 冲突提示与待处理任务的配置保存保护；条件只保存自然语言，实际交接线从历史记录生成，不固定路线。
- [x] 在 Electron 中创建、拖动、编辑、重启；删除配置边后历史交接仍在。对比工作流图片的画布、节点、右侧详情结构，并确认正文和命中区域可用。
- [x] 记录页面与交互证据；条件 MCP 的新工具和自动选路继续按设计待讨论。

### Task 4：四种控制、停止与命令核对

**Files:** 修改 `src/core/{engine,worker}.ts`、`src/desktop/{main,preload}.ts`、`src/shared/types.ts`、`src/renderer/{App,Workbench}.tsx`；创建 `src/core/commands.ts`。测试 `tests/{pause,commands}.test.ts`。

**Interfaces:** 新增 `CommandEnvelope = {id:string; command:AppCommand}`、`CommandDispatcher.dispatch(envelope):Promise<AppReply>` 与 `inspect(id):CommandReceipt`；回执状态为 queued/running/succeeded/failed/cancelled/unknown。编号在用户动作创建时确定并贯穿重传，不按消息正文去重；回执状态不是节点控制状态。

- [x] 先复现慢历史/目录查询挡住控制，以及等待账号的发送在 stop 后迟到创建任务；加入同编号同内容只执行一次、同编号不同内容拒绝、不同编号相同正文分别执行的断言。
- [x] 用受控 RPC 门闩验证失败，避免用固定墙钟时长代替并发条件。
- [x] 将短状态修改与长等待分开，控制/审批优先受理；停止取消此前未开始的启动动作，等待完成后重新核对关闭、停止及当前节点状态。界面控制按钮不依赖无关查询 busy。
- [x] 覆盖节点状态专项全部例子：A 运行/B 空闲批量恢复只续接 A；排队未运行不被批量启动；暂停→启用→再暂停以最后状态为准；续接同 task/thread、新 turn，原文只发送一次；旧 turn 不能完成新 turn。
- [x] 验证超时查询原编号、未知结果不盲目重放；记录进程内回执的边界，跨进程结果通过持久任务/会话核对，不宣称全局恰好执行一次。

### Task 5：持久提交后的成果、交接与回流

**Files:** 修改 `src/core/{engine,store,mcp}.ts`、`src/core/model.ts`。测试 `tests/{handoff,mcp}.test.ts`。

**Interfaces:** 消费任务 2/4 的活动执行及命令边界。保持现有 `get_project_context/handoff/complete_task/update_workflow` 兼容契约；使用共享提交入口 `commit(state:ProjectState, update:(draft:ProjectState)=>void):void`，提交成功后才发布活动对象和成功回执。新业务 MCP 仍未冻结。

- [x] 故障注入测试 `failed_handoff_commit_cannot_acknowledge_on_retry`：`handoffs.length === 0`、来源 `terminal === null`、native 接收派发次数为 0；随后相同调用成功重试只产生 1 个接收任务。
- [x] 在原型的先改内存后保存逻辑上观察失败，再实现候选提交；交接、完成、阻塞报告走同一提交规则，发布保持活动任务引用一致，数据库事务内不等待网络。
- [x] 覆盖提交成功但回执丢失、重复调用、重启、来源失败/中断、已受理后暂停续接；来源成功后只释放一次，失败不投递。
- [x] 用实际本地 MCP HTTP 跑规划→执行→审查→返工→复审的受控演练；任意用户业务字段/非字符串结果完整保留，不强制 summary/verdict，不硬编码生产路由。
- [x] 记录数据库与成果文件不共事务的边界；未登记的孤立文件可核对，不自动删除未知用户文件。

### Task 6：原始历史、作者与增量同步

**Files:** 修改 `src/core/{history,store,engine,worker}.ts`、`src/desktop/main.ts`、`src/shared/types.ts`、`src/renderer/{App,Conversation,Workbench}.tsx`；创建 `src/shared/snapshots.ts`。测试 `tests/{history,snapshots,streaming}.test.ts`。

**Interfaces:** `ConversationEntry.source.kind` 扩为 user/node/system/unknown，保留原正文、raw item、seq 和原生角色；系统续接关联控制动作。定义完整基线与项目条目增量 `AppUpdate`；`mergeUpdate(previous:AppSnapshot|null, update:AppUpdate):{snapshot:AppSnapshot|null; resyncProjectId:string|null}` 为纯合并函数，网络补偿由界面外层执行并按导航失效。

- [x] 先写作者/原文回读、旧完成状态不倒退、A 基线→B 增量→B 较早基线、无基线首个增量、切项目后旧补偿、发送中新增草稿等失败用例。
- [x] 验证原型的系统续接作者与全量广播问题，再实现来源迁移、条目 ID 去重、单调版本和缺基线补读；node/project 两视图使用同份原始记录，未知时间保持未知。
- [x] 合并纯流式保存，关键输入/交接/状态/条目完成立即保存，正常关闭刷新；存储失败可见并阻止未提交结果参与派发。合并周期是有测试的实现参数，依据测量选择，不作为业务协议。
- [x] 固定 1,000 条已有历史与 100 个同步 delta，断言合并写次数小于 delta 数、广播只含变化条目，完成/关闭尾段落盘；记录实际字节量与延迟，其他项目变化不重复传输当前项目完整历史。
- [x] 本阶段保留项目快照存储形态，明确已知规模边界。SQLite 历史分表、持久层分页与界面虚拟化另据测量推进，不宣称已解决无限历史规模。

### Task 7：原生请求与节点工作面板

**Files:** 修改 `src/core/{codex,catalog,engine}.ts`、`src/shared/{types,panels}.ts`、`src/desktop/{main,panels,panel-files,policy}.ts`、`src/renderer/{NativeRequests,NodePanels,Conversation}.tsx`；创建 `src/shared/native-requests.ts`、`src/core/native-responses.ts`、`src/core/provenance.ts`。测试 `tests/{native-contracts,panels,panel-files,provenance}.test.ts`。

**Interfaces:** 复用 `PanelCommand`；`classifyNativeRequest(request):NativeRequestKind` 为纯分类，`validateNativeResponse(request,result):void` 在后台执行；扩展 `CodexPort.reject?(id,error):void` 回答真实未完成的宿主请求。`executionProvenance(root,node,runtimeInfo)` 仅记录可核实的所选能力来源，失败为 unknown，不禁用原生能力。

- [x] 先测试真实 availableDecisions、问题 ID、权限范围、表单 schema、取消/失效请求；未知宿主请求必须返回明确协议错误，不能由用户 JSON 假装宿主执行。验证非法回应不消费待回应请求。
- [x] 实现分类控件和后台校验；记录实际二进制/版本/初始化、请求模型与实际模型回执。选中 skill 和项目导入插件来源只读明确文件，不读认证材料；manifest 摘要不冒充整包或实际缓存版本。
- [x] 复用真实 WebContentsView 和文件预览；网页无主 IPC/Node，profile、下载和附件归项目；打开菜单隐藏覆盖视图，节点切换令旧加载/隐藏操作失效。
- [x] 用本地 HTTP 与项目内文本/图片/PDF/HTML，在 Electron 验证加载、导航、弹窗与节点切换；检查截图和真实命中区域，页面树或健康端点不代替像素验收。
- [x] 逐项记录基础会话、能力目录、审批、网页展示、文件预览的可用性和运行版本；浏览器控制桥、MCP App UI、交互式终端保持后续独立验收目标，不标成已完成。

### Task 8：托盘、退出恢复与整体验收

**Files:** 修改 `src/desktop/main.ts`、`src/core/{engine,store,paths}.ts`、根 `README.md` 和设计文档的实际进度标记；创建 `tests/{recovery,boundary}.test.ts` 与 `scripts/verify-desktop.mjs`。测试产物仅在 `.runtime/implementation/`。

**Interfaces:** 消费前面全部任务；`WorkflowEngine.close():Promise<void>` 并发/重复调用共享关闭结果，保存或一项关闭失败仍释放其他自有资源；原生运行时/任务的未知结果保留核对路径。

- [x] 先写 v1/v2 迁移、已确认暂停重启、活跃任务退出、迟到 RPC/工具调用、多资源保存与关闭同时失败的回归；原文、线程和已提交成果不可丢失。
- [x] 实现关闭窗口留托盘、明确退出后台、关闭后拒绝新工作与过期回调；重启不重放未知原生操作，原目录误绑定拒绝，不强制非 Git 项目初始化仓库。
- [x] 用无凭据 fixture 检查普通工作文件与模拟控制目录的实际权限；记录版本/有效策略。强隔离尚未设计或平台不支持时明确未强隔离，不降级原生能力、不搬数据到项目外、不安装系统沙箱配置。
- [x] 运行正式 `test`、`typecheck`、`build`；隔离 Electron 完成项目创建→配置节点→自由会话→交接回流→暂停/续接→原始时间线→面板→退出重启；使用已提供的浏览器验证运行时，所有输出与 profile 归项目，结束释放进程。
- [x] ECC 代码/安全审查与一次独立完整复核，处理重要问题后只重跑相关回归及必要集成检查。确认原型归档未变；更新需求对照表，逐项写明完成、未验证和后续目标，再开放正式开发版启动入口。

## 完成定义与执行记录

- 每项按失败测试→最小实现→通过回归推进，不沿用原型旧结果充数。
- 用 `.runtime/implementation/progress.md` 持久记录当前任务、已完成步骤、实际测试和必要裁决；临时脚本、截图、日志与测试项目都在该目录或所属 fixture 项目内。
- 完成任务 8 后交付首阶段正式开发版、启动命令、需求覆盖及验证报告。没有真实登录/模型执行的部分明确未验证；不挪用真实项目任务来制造测试结果。
- 计划审阅通过后任务间连续执行，不在每项完成后重复询问。未冻结的业务规则、系统级权限变更与外部发布仍按明确范围处理。
- 当前无 Git 仓库，ECC 的提交确认关口只有在后续明确引入版本库时才适用；本计划不包含初始化仓库、提交、推送或发布。

## 审阅与执行方式

用户已选择逐任务子 Agent 实现与逐任务评审。每项由新的实现者执行，独立评审需求符合性和代码质量；重要问题解决后才进入下一项，全部完成后做一次整体复核。交付范围和验收标准按本计划，不再重复询问是否继续。
