# 人工核对机制实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox tracking. Preserve the current working tree and use a fresh implementer and independent task reviewer, followed by a final implementation review.

**Goal:** 为 Mixcat 增加可持久恢复、关联具体版本的人工核对，需求方向和 UI/UE 必须通过后才派发相应后续工作，用户意见回到原会话。

**Architecture:** 复用 WorkflowEngine、项目 SQLite、固定附件、原生 Thread、现有队列和桌面工作面板。项目保存核对规则与版本化事项；桌面用户命令作出决定，MCP 仅提交和查询；统一派发检查覆盖所有任务入口。

**Tech Stack:** 现有 TypeScript、React、Electron、Node.js 24+、Codex app-server、MCP SDK、SQLite 和 Node 测试工具；不新增依赖、服务或全局配置。

**Spec:** [已确认的人工核对设计](../design/2026-10-22-human-review-design.md)。用户已确认阻断策略、书面方案及本实施计划；代码、真实人工决定、产品行为验证、最后样例任务核对与清理均取得下列证据，Task 6／整计划于 2026-10-24 完成，完成范围以勾选及执行证据为准。

## Global Constraints

- 必须人工通过后，相关后续工作才能继续；首版不增加“只提醒仍继续”的运行选项。
- 每个节点保留现有一份权威多值运行状态；waiting_review 是任务状态，不是第二份节点暂停锁。
- 普通消息、旧 handoff、用户直接输入、恢复队列和重试均检查依赖；输入自由，原文正常保存，受理不表示已执行。
- 正式通过只来自可信桌面用户对具体版本的操作；Agent、自评、普通聊天、节点启用、超时和原生权限审批不能代替。
- 核对正文、附件和原始意见不覆盖；新版本通过不自动适用于旧输入，已发生的操作不倒写或声称撤销。
- 核对通过不启用用户暂停的节点、不复活已取消任务、不重放 needs_reconciliation；不占用长时间挂起的 MCP 请求。
- 新 Web 模板预设两个核对点；既有项目不自动加约束或获得新工具授权。保留原生能力和原生审批。
- 正式设计在 docs/design，计划在 docs/plans；工作数据、缓存、截图、报告及测试项目在 G:/code/mixcat 内，写前校验真实路径和链接祖先。
- 沿用 codex/web-product-team 当前工作区，开始执行时保存本轮 before-images；不覆盖既有 UI、模板和未提交改动。不自动提交、推送或发布混合工作区。
- 不改变此前批准的 hooks 定义／信任，不新增协调服务、人工 Agent 节点、多用户审批、自动审美评分、通知系统或全工作区冻结。

## Review Focus

1. 旧项目迁移、模板重新配置和 Agent 授权：不自动增加门槛或扩授工具；对已有配置的明确编辑才改变核对规则。Task 1／4 测试。
2. 零事项、旧版通过、材料变化和上游换版：没有事项不算通过；新版不能释放旧包任务；普通无关文件变化不使所有事项失效。Task 1／2／3 测试。
3. 直接用户输入、无边消息、旧 handoff、暂停续接和重试：不能绕过核对；旧交接仍须满足来源成功，独立工作保持可执行。Task 3 测试。
4. 重复决定、跨重启丢响应、数据库拒绝及旧窗口：不会双重续接、错误放行或覆盖决定；离线批准不要求先登录。Task 2／5／6 测试。
5. 异步准备期间换版／改规则／停止、删除责任节点和原生执行未知：派发边界重新核验，不误删历史、不恢复取消或未知任务。Task 3／6 测试。

## 文件与职责

| 文件 | 变更职责 |
| --- | --- |
| src/shared/types.ts、src/core/model.ts | 公共核对类型、可信命令、任务依赖与内部持久记录；公共快照新增字段允许旧 fixture 缺省 |
| src/core/reviews.ts（新） | 核对输入、规则、版本、回执和依赖判断；不管理原生进程或另建调度器 |
| src/core/store.ts、src/core/history.ts | schema v4 兼容迁移、空默认值及可追溯事件 |
| src/core/engine.ts | 事务提交、桌面决定、队列续接、全入口派发检查及生命周期保护；不整体重构引擎 |
| src/core/mcp.ts、src/core/collaboration.ts、src/core/message-files.ts | 两个新工具、上下文摘要、现有固定附件与来源校验复用 |
| src/core/web-product.ts | 新项目的两个默认核对点及职责说明；配置能力推荐不擅自修改旧项目规则 |
| src/renderer/App.tsx、HumanReviews.tsx（新）、Workbench.tsx、Conversation.tsx、NodeSettings.tsx、styles.css | 稳定命令编号、规则编辑、事项卡片、原始历史、资源打开、待核对任务和配置锁定 |
| tests/human-review*.test.ts、tests/human-review-electron.mjs（新） | 领域、持久化、真实 HTTP、派发、恢复、渲染和桌面验收 |
| 现有模板／消息／暂停／历史测试与 fixtures | 补齐新增状态和默认规则的明确场景，保留原断言的意义 |

## 统一接口决定

以下名称由各任务共用；实现主体由负责该任务的 Agent 编写。

- HumanReviewPolicy：revision，以及 checkpoints。每个 ReviewCheckpoint 为 id、name、ownerNodeId、requiredForNodeIds、dependsOn、revision。新规则 revision=1，新空策略 revision=0；修改提交当前 revision，保存后递增，未改变的核对点保留自己的 revision。
- ReviewDependency：checkpointId、checkpointRevision、reviewId、version；后两者同时为 null 表示尚未首次提交。TaskView／StoredTask 增加可选 reviewDependencies；TaskStatus 增加 waiting_review。
- RequestReviewInput：request_id、checkpoint_id、title、content，以及可选 attachments: MessageAttachmentInput[]。content 为自由 JSON；标题 1–80 字符；request_id 沿用 1–128 个字母、数字、下划线、连字符。
- ReviewReceipt：accepted=true、review_id、checkpoint_id、version、accepted_at。回执是固定受理事实，当前状态通过 get_review 查询。
- StoredHumanReview：保存上述原始请求、真实 project/node/task/thread/turn/call 来源及重放调用关联、核对点 revision、上游 ReviewDependency[]、正文和固定 AttachmentSnapshot[]、源文件引用、提交包字符串及 bundleHash、状态、时间、决定和 supersededBy。状态为 pending／approved／changes_requested／withdrawn／superseded；保留旧决定，不能用替代状态抹去它。
- HumanReviewView：上述事项的可展示字段及固定材料、决定和续接关联；ID 字段使用 id、checkpointId、version。内部重放调用列表不发送给 renderer，原始真实来源与用户意见保留。
- ReviewDecision：commandId、reviewId、version、bundleHash、decision、comment、createdAt、continuationTaskId。决定只记录一次，原始 comment 不 trim 改写；changes_requested 要求存在非空白意见。
- ProjectState 增加 reviewPolicy 和 humanReviews，迁移后始终初始化；ProjectSnapshot 增加可选 reviewPolicy、humanReviews，旧 fixture 可缺省；快照不输出接入 token。
- AppCommand 增加 save_review_policy（projectId、policy）、decide_review（projectId、reviewId、version、bundleHash、decision、comment）、withdraw_review（projectId、reviewId、version、bundleHash）、cancel_review_task（projectId、taskId）。统一使用现有 actionId 作持久决定编号；缺少有效编号的决定调用拒绝，不在引擎内猜测身份或补造重试编号。
- 新增 WORKFLOW_TOOLS 为 request_review、get_review。get_review 只接收 review_id 或当前节点的 request_id，二者选一。无 Agent 批准接口。沿用 REQUEST_CONFLICT、REVISION_CONFLICT、TARGET_UNAVAILABLE、PERMISSION_DENIED 等已有错误码。

### Task 1：核对领域、依赖和存储兼容

**Files:** 新建 src/core/reviews.ts、tests/human-review.test.ts；修改 src/shared/types.ts、src/core/model.ts、src/core/store.ts、src/core/history.ts 及 engine.ts 新项目空状态初始化。

**Interfaces:**

- 产出 parseReviewSubmission(value: unknown): RequestReviewInput、validateReviewPolicy(value: unknown, state: ProjectState): HumanReviewPolicy。
- 产出 reviewDependencies(state: ProjectState, nodeId: string): ReviewDependency[]、reviewGate(state: ProjectState, dependencies: ReviewDependency[]): { state: 'ready' | 'waiting' | 'stale'; checkpointIds: string[] }。
- 产出 reconcileReviewTasks(state: ProjectState): void，仅绑定首次提交／转换未派发的 queued 与 waiting_review；不释放 waiting_source、paused、cancelled、running 或 needs_reconciliation。事务由 engine.commit 提供。
- 公共和持久类型均按上节；ProjectStore 接受 schema 1–4 并写入 v4，旧项目迁移为空策略／空事项，不按 template 字段补入新规则。

- [x] 写失败测试：空旧策略 gate=ready；已配置但零事项 gate=waiting；第一版通过 gate=ready；被新包替代的旧依赖 gate=stale。任意 JSON 正文不改写；规则节点／依赖缺失、重复 ID、自依赖和循环拒绝。

  关键断言（state 来自现有 fixture，检查其受限 frontend 节点）：
  ```ts
  assert.equal(reviewGate(state, reviewDependencies(state, 'frontend')).state, 'waiting');
  assert.deepEqual(state.nodes.map(node => node.tools), originalTools);
  ```
- [x] 运行 `./scripts/dev.ps1 test tests/human-review.test.ts`，保留因新增行为缺失而失败的结果。
- [x] 实现最小领域与类型；同一内容的重放按现有 isDeepStrictEqual 规则比较，提交包以保存的实际序列化字符串计算 SHA-256，不从 UI 重新序列化猜测哈希。
- [x] 测试旧 schema 1／2／3 的历史、权限和节点状态迁移不变；新 v4 重读包含规则、事项和依赖；未来未知 schema 继续拒绝。只读存储检查不启动原生客户端。
- [x] 聚焦测试和 `./scripts/dev.ps1 typecheck` 通过后，保存本任务差异与结果，进行独立规格／质量评审；不提交混合文件。

### Task 2：持久事项、MCP 和可信用户决定

**Files:** 修改 src/core/engine.ts、mcp.ts、collaboration.ts、message-files.ts；新建 tests/human-review-http.test.ts、tests/human-review-decisions.test.ts；沿用 tests/collaboration-fixture.ts。

**Interfaces:**

- 消费 Task 1 类型和领域判断；引擎新增 private requestReview(state: ProjectState, args: Record<string, unknown>, context: McpCallContext): Promise<ReviewReceipt>，invokeTool 对应 request_review／get_review。
- save_review_policy、decide_review、withdraw_review、cancel_review_task 均经可信 AppCommand 与现有 commit 执行；MCP 不得伪装这四个命令。
- message-files.ts 导出 resolveAttachmentSource(root: string, state: ProjectState, input: MessageAttachmentInput): { path: string; name: string; snapshot?: AttachmentSnapshot }，提取现有来源解析并由原 prepareMessageAttachments 和核对材料共同复用；原函数签名及路径防护不变。
- registeredArtifact 同时识别已持久登记的核对附件，保持字节／哈希和保留路径校验；正文材料通过现有 messageAttachmentInput 传给原会话。
- 产出 validateReviewMaterials(root: string, state: ProjectState, review: HumanReviewView): Promise<void>（message-files.ts），复用安全来源解析与摘要核验，供本任务决定前及 Task 3 派发前共同使用。

- [x] 写真实 HTTP 失败测试：原生 Thread／Turn／call 身份与 owner 对应；自由 JSON 与固定图片／文档；同请求重放一个事项、换正文冲突；提交回执立即返回 pending，不等待人工。
- [x] 写决定失败测试：同 actionId 跨重启查询／重试只创建一个续接；不同内容同编号冲突；旧 version／bundleHash、材料被改、上游版本过期不通过；Agent 无批准工具、不可越权提交其他 owner 的核对。

  关键断言（receipt 与 replay 来自两次相同 HTTP 提交）：
  ```ts
  assert.equal(receipt.review_id, replay.review_id);
  assert.equal(f.state.humanReviews.length, 1);
  assert.equal(f.state.tasks.filter(task => task.id === f.state.humanReviews[0].decision?.continuationTaskId).length, 1);
  ```
- [x] 运行 `./scripts/dev.ps1 test tests/human-review-http.test.ts tests/human-review-decisions.test.ts`，确认新增行为缺失导致失败。
- [x] 实现受理前查持久回执，异步附件准备后再查身份／权限／配置／控制状态；事项与提交历史在候选状态一次保存后才发布。首次提交同时绑定此前等待首次提交的任务；新包替代保留旧包、决定及附件。
- [x] 实现用户决定：复核当前材料和上游依赖后，在一次 commit 保存决定、唯一来源节点续接输入和可释放任务；输入事件保留原始用户意见，通知标注系统投递及核对版本。续接使用现有 nativeInput 和固定附件构造方式，不误套旧演练步数上限。相同版本、同内容的重复决定返回已保存事实，不新增任务。
- [x] 测试 SQLite 拒绝时无决定、无通知、无放行；离线批准可持久排队，不为保存决定强行连接或发起登录。撤回 pending 不算通过；仅 waiting_review 可单独取消。有效规则引用或未决事项的责任节点不能删除。
- [x] 扩展 get_project_context 为规则、适用依赖和事项摘要；保持默认只读，不触发目录扫描。新工具委派不能超过编辑者已有权限，旧项目不自动扩权。聚焦测试／类型检查及独立评审通过。

### Task 3：所有任务入口的核对条件与生命周期

**Files:** 修改 src/core/engine.ts、collaboration.ts；新建 tests/human-review-dispatch.test.ts、tests/human-review-recovery.test.ts；补充 tests/pause.test.ts、delete-node.test.ts、recovery.test.ts、collaboration-lifecycle.test.ts 的相关状态断言。

**Interfaces:**

- addTask 捕获 reviewDependencies；普通直接输入和节点消息产生 waiting_review 或 queued。旧 handoff 先保留 waiting_source，来源成功后才依据 reviewGate 转为 waiting_review／queued。
- pump 和 dispatch 消费 Task 1 的判断；不存在第二个执行器。核对阻断只修改未派发任务；原已执行并暂停的任务保留 paused／原 Turn 信息，恢复前重新核对，不能丢失续接身份。
- 新规则／包提交／决定后在相同候选状态 reconcileReviewTasks；取消或未知任务不释放。UI 从任务依赖读取等待原因，不增加 NodeStatus 值。

- [x] 写失败测试：同一受限目标分别从 start、用户 send_message、MCP 无边 send_message、旧 handoff、retry_task、单节点恢复进入，未通过时零 turn/start；未受限节点继续运行。
- [x] 写失败测试：产品方向未提交不能启动设计；方向通过仍不能启动前端；UI 通过后前端可执行。已受理任务保留原文和来源，按原接收顺序释放；普通启用／全部开启不产生通过决定。
- [x] 写失败测试：先批准再来源失败的旧 handoff 不执行；批准后节点仍暂停；stop 取消等待，后批准不复活；原生未知执行仍待核对，不因业务批准自动重放。

  关键断言（beforeTurns 为发送前记录的实际 fixture RPC 数）：
  ```ts
  assert.equal(f.state.tasks.at(-1)?.status, 'waiting_review');
  assert.equal(f.clients.flatMap(client => client.calls).filter(call => call.method === 'turn/start').length, beforeTurns);
  assert.equal(f.state.nodes.find(node => node.id === 'frontend')?.status, 'paused'); // 已暂停场景批准后仍暂停
  ```
- [x] 运行两项新增测试，保留失败证据；实现统一入口检查，并在 runtime／账号／插件／材料等异步等待后、thread/start 或 resume 及 turn/start 前检查最新依赖和 stop epoch。
- [x] 以 deferred 原生 fixture 测试准备期间换包／改规则／停止：不得派发过期工作，不把它误报为原生执行未知；已提交远端操作仍保留实际事实，不声称撤销。
- [x] 检索并处理所有 unfinished 状态清单：配置／删除保护、模式切换、暂停恢复、stop、finishTurn、init、close、refreshNodeStatus 和 updateStatus。waiting_review 不进入正在运行的暂停快照；无其他工作但必需核对未完成时项目汇总为 blocked，并显示业务核对原因。
- [x] 重启重读等待／决定／原 Thread，确认无丢失或双重通知；过期包任务保持等待并可明确取消／重新交接，不能悄悄套用新版。相关控制、历史、旧交接测试和类型检查通过，完成独立评审。

### Task 4：Web 模板默认核对与项目规则编辑

**Files:** 修改 src/core/web-product.ts、engine.ts、src/renderer/Workbench.tsx、NodeSettings.tsx；新建 src/renderer/HumanReviews.tsx、tests/human-review-renderer.test.ts；更新 tests/web-product.test.ts、web-product-engine.test.ts、web-product-workflow.test.ts 及必要 fixtures。

**Interfaces:**

- web-product.ts 产出 createWebProductReviewPolicy(): HumanReviewPolicy，仅新建 Web 项目调用。product-direction：owner=product，requiredForNodeIds=[design, backend, frontend]，dependsOn=[]；ui-ue：owner=design，requiredForNodeIds=[frontend]，dependsOn=[product-direction]。新策略与两点 revision 均为 1。
- 新 Web 节点通过 WORKFLOW_TOOLS 选择两项新能力；保存职责及初始化文档说明人工核对。旧项目的 configure_template 保持已有规则，不借推荐能力重建默认核对。
- HumanReviews.tsx 产出 ReviewPolicyEditor({policy,nodes,busy,onSave,onError})，onSave 接收完整当前修订策略，调用 save_review_policy；只由用户编辑 owner、适用节点及上游依赖，不添加“仅提醒”开关。

- [x] 写失败测试：新 Web 项目恰有两个上述核对点；基本模板与迁移旧 Web 项目保持空策略；配置推荐及重试不覆盖用户规则。
- [x] 写渲染失败测试：规则节点引用、无环关系、修订冲突及丢失 owner 的可见错误；受限任务输入框仍可输入并保存，显示等待原因，不禁用整个会话入口。

  默认值断言：
  ```ts
  assert.deepEqual(createWebProductReviewPolicy().checkpoints.map(point => point.id), ['product-direction', 'ui-ue']);
  assert.deepEqual(createWebProductReviewPolicy().checkpoints[1].dependsOn, ['product-direction']);
  ```
- [x] 运行模板和新增 renderer 测试，确认失败；实现默认策略和最小规则编辑入口，保持白灰布局，规则编辑不进入 Agent 的 update_workflow 参数。
- [x] 更新现有新 Web 模板测试的明确场景：需要单独验证旧协作／控制时，可通过可信 save_review_policy 显式设为空并断言保存，不能直接删内部状态或改变模板默认以让旧测试通过；Task 6 专门保留默认两道核对全流程。
- [x] waiting_review 加入节点配置／删除前置检查，但只拖动位置继续可用。现有用户模型、技能和插件选择保留；新增字段不使旧快照无法渲染。聚焦测试／类型检查及任务评审通过。

### Task 5：核对卡片、材料、决定与原始历史

**Files:** 修改 src/renderer/App.tsx、HumanReviews.tsx、Workbench.tsx、Conversation.tsx、styles.css；扩展 tests/human-review-renderer.test.ts，新建 tests/human-review-electron.mjs；验证 tests/snapshots.test.ts、renderer.test.ts、commands.test.ts。

**Interfaces:**

- HumanReviews({project,policy,reviews,tasks,nodes,execute,onOpen,onError}) 接收 ProjectSnapshot 的核对部分和现有 DesktopApi 命令执行函数；onOpen 复用 Workbench.openResource，不新增任意文件读取通道。
- App 与 Workbench 的 Execute 兼容扩展为 (command: AppCommand, actionId?: string) => Promise<AppReply | null>；App.execute 的 envelope.id 使用传入编号或原来的 crypto.randomUUID()。旧调用方无需改动，核对卡片可以在失败重试时复用原编号；不另建 IPC 或绕过 SnapshotReceiver。
- 项目状态栏“待人工核对 N”打开项目列表；节点会话呈现自己的提交、决定及版本历史。卡片显示来源、正文、固定材料、bundleHash、上游依据，主按钮为“通过”“提出修改”，另提供撤回未决事项及取消等待任务。
- 决定使用用户当前展示的 reviewId／version／bundleHash 和一个可复用 actionId；请求中或返回未知时保留它，确认结果前不生成新编号或乐观显示通过。

- [x] 写失败测试：需求 Markdown、图片固定附件打开正确面板；正文不当 HTML 执行；输入来源与原始用户意见可追溯；已通过／修改／替代版本清楚区分。
- [x] 写失败测试：重复点击、请求失败后重试、旧窗口收到新版本、切换项目／节点时延迟返回，不覆盖当前材料或误发决定；规定未决确认与输入焦点行为，键盘和可访问名称可用。

  渲染与命令关键断言（html 为实际组件渲染，envelopes 为 DesktopApi bridge 记录）：
  ```ts
  assert.match(html, /待人工核对 1/);
  assert.match(html, /提出修改/);
  assert.equal(envelopes[0].id, envelopes[1].id); // 同一决定丢响应后明确重试
  ```
- [x] 运行新增 renderer 测试；实现卡片与列表，复用现有表单、原生资源面板和历史排序。当前核对点显示最新事项，旧版本可展开，不把普通消息变成审批按钮。
- [x] 运行 `./scripts/dev.ps1 test tests/human-review-electron.mjs`：真实 Electron DOM、鼠标／键盘、命中、白灰像素和材料面板；控制回包注明 fixture，不能称用户已认可真实方案。
- [x] 验证 full／delta 快照均带当前核对数据，旧项目缺省仍正常，过期异步结果不跨项目采用。聚焦测试和任务规格／质量评审通过。

### Task 6：完整流程、真实人工介入与交付审计

**Files:** 新建 tests/human-review-workflow.test.ts；扩展 tests/human-review-electron.mjs；更新 README.md、docs/README.md、docs/design/README.md、交付矩阵与本计划。验证脚本、测试产品与报告位于 .runtime/implementation/human-review-20261022/，不覆盖上一轮实测成果。

**Interfaces:** 消费 Task 1–5 的真实生产引擎、HTTP MCP、SQLite、桌面命令和 renderer；受控原生 fixture、真实模型、自动点击与真实用户决定分别记载，不互相冒充。

- [x] 写并运行真实 HTTP／生产引擎的组合回归：默认两核对点、未提交阻断、通过、修改回流、新版提交、无边发送、旧交接、暂停／覆盖、停止、取消过期任务、原 Thread、重启及固定附件。受控用户决定通过可信命令，保留 actionId 和版本证据。

  跨重启关键断言（before 为重启前固定包快照）：
  ```ts
  assert.equal(restored.humanReviews[0].bundleHash, before.humanReviews[0].bundleHash);
  assert.equal(restored.humanReviews[0].decision?.continuationTaskId, before.humanReviews[0].decision?.continuationTaskId);
  assert.equal(restored.nodes.find(node => node.id === 'design')?.threadId, before.nodes.find(node => node.id === 'design')?.threadId);
  ```
- [x] 用实际 main/preload/worker 的桌面验证方式检查决定持久化、排队放行与恢复，不只对 renderer 注入快照。复用 scripts/verify-desktop.mjs 的项目内隔离和资源清理模式，必要的测试差异明确记录。
- [x] 准备独立单功能产品材料及隔离客户端组合入口，复用现有共享账号，不复制凭据，只对本轮测试项目发命令。真实入口组合生产 engine／CommandDispatcher／preload／renderer／PanelHost；正常编译 main/preload/worker 另有受控两次启动证据，普通 start 包装入口本轮未实测，不把组合入口改称该入口验收。
- [x] 真实产品经理／设计原生会话通过 request_review 提交需求和 UI 材料，分别向用户展示可审阅包；原始“通过这个 v1”与“通过 UI/UE v1”保存在 human-direction-v1.json／human-ui-v1.json，以具体版本／哈希的可信命令各提交一次并续接原 Thread。自动化 fixture 的修改意见仍单独标记。
- [x] 两次真实用户决定均已收到并保留原话；业务通过不替代原生权限审批／hooks 信任，没有自动信任未批准定义。用户决定不授权重放未知原生执行。
- [x] 验证极小产品实际行为：backend 在 Node 18 通过 18 项真实 HTTP 检查；Controller 在 Node v24.19.0 以实际 Chromium 输入提交 UI 并读取真实后端网络响应，5 项场景通过且该验收服务已停止。不是 mock 后端，不推广全部浏览器／插件／节点能力。
- [x] 运行 `./scripts/dev.ps1 test`、`./scripts/dev.ps1 typecheck`、`./scripts/dev.ps1 build` 及本轮必要 Electron 检查；记录实际命令、退出码、计数、版本和源码哈希，不把上一轮 289 项结果当成新功能验证。
- [x] 完成最终独立整体评审、一次集中修复及限定实际修复范围的独立复审；I1／I2／I3／M1 均 ADDRESSED，代码 READY。更新设计第 9 节、入口文档及交付矩阵，并检查本次文档链接／差异；源码 before-images 和范围哈希核对记录于 final-fix.md／final-rereview.md，最终交付聚合包由 Controller 保存。
- [x] Controller 已核对最后被验证驱动中断的样例原生任务并明确处理已审计本地重试，保留原始中断历史和两次人工决定。最终持久项目 completed，18 个任务记录中 13 个完成、5 个历史失败／重试尝试保留，零活动／等待／暂停／needs_reconciliation、零原生请求；两个原 Thread 的决定续接各恰好完成一次，当前生产材料校验通过全部本项／祖先来源及固定字节，5 项产品结果和源码哈希不变，见[最终完成审计](../../.runtime/implementation/human-review-20261022/records/native-completion-audit.json)。
- [x] 本轮所属引擎正常关闭，最终 run 5d99db6a-196a-4b4b-8c84-2930e467b222 的驱动退出 0；10 个 PID＋创建时间身份均不存活，14317／29802／14319／13559 四个所属 API／debug 端口均关闭，见[进程审计](../../.runtime/implementation/human-review-20261022/native/live-20261024-Q92z63/final-process-audit.json)及最终完成审计。用户客户端、其他服务、测试成果和原始记录保留；所有必需验收完成，Task 6／整计划完成，未自动提交或推送。

## 计划自检与执行交接

规格映射：第 1–3 节由 Task 1／4 实现，第 4 节由 Task 3 实现，第 5 节由 Task 1／2／3 实现，第 6 节由 Task 2／5 实现，第 7 节由 Task 2 实现，第 8 节由 Task 2／3 实现，第 9 节由 Task 6 做最终覆盖。五项 Review Focus 都已分配到具体测试任务。

实施前自检已核对当时的文件名、函数调用、schema v3、原有状态清单与测试入口，并补齐 App.execute 稳定 actionId 的调用链。用户随后批准计划并完成逐任务子 Agent 实施／独立评审；此段保留实施前自检背景，不再作为新的设计或开工确认请求。

当前状态（2026-10-24）：Tasks 1–6 及整计划完成。Tasks 1–5 已实现并通过各自独立规格／质量评审；Task 6 已完成受控 HTTP／桌面重启、真实双人工决定、极小产品 API／Chromium 验收、最终代码修复复审、最后样例任务核对及全部本轮所属实例清理。I1／I2／I3／M1 全部 ADDRESSED，代码 READY。最终修复后完整套件 **393/393**、聚焦 82/82、类型检查／构建退出 0、受控 Electron 1/1 通过；393 为当前完整代码验证边界，此前 374／90／376 保留为历史阶段结果。原生业务决定初始使用 CLI 0.163.0-alpha.11，宿主更新后以 0.164.0-alpha.11.1 续接已有会话；不回写旧来源版本。最终完成审计于 2026-10-24T08:39:56Z PASS，零未解决执行、两次真实决定各一次已完成原 Thread 续接、当前所选材料有效、所属运行实例关闭。

执行恢复账本见[progress.md](../../.runtime/implementation/human-review-20261022/records/progress.md)，最终修复／复审见[final-fix.md](../../.runtime/implementation/human-review-20261022/records/final-fix.md)与[final-rereview.md](../../.runtime/implementation/human-review-20261022/records/final-rereview.md)，实际产品证据见[native-product-result.json](../../.runtime/implementation/human-review-20261022/records/native-product-result.json)。[native-acceptance.md](../../.runtime/implementation/human-review-20261022/records/native-acceptance.md)保留分阶段原生过程；最新持久状态和关闭结果以最终完成审计为准，不将早期 pending 描述当成当前状态。文档检查见[delivery-docs.md](../../.runtime/implementation/human-review-20261022/records/delivery-docs.md)。
