# Mixcat 首阶段开发版：实现与验收边界

日期：2026-10-20（UTC+08:00）。正式实现位于根目录 `src/`，构建位于 `dist/client/`。Tasks 1–8 已通过逐任务独立评审及必要修复复审，**最终独立整体复核已通过，无 Critical / Important 问题**。当前交付为本地开发版，范围以本文矩阵为准；历史原型观察不替代正式验收。审查记录见[最终复核报告](../../.runtime/implementation/final-review-report.md)。

实施契约见[功能总设计](2026-10-19-mixcat-client-functional-design.md)、[可靠性与边界](2026-10-20-architecture-hardening.md)、[节点控制](2026-10-19-node-controls.md)及[实施计划](../plans/2026-10-20-mixcat-desktop-implementation.md)。历史设计日期、原型测试和 `prototypes/ui/` 图片保持原位。

## 已确认需求的实现矩阵

“已实现”表示存在正式代码及下列范围的验证；不等于真实模型、所有插件或未来扩展桥已经验收。具体记录、命令、退出码和截图位于项目内 `.runtime/implementation/`，逐任务评审记录见 `progress.md`。

| 编号 | 要求 | 当前实现与证据 | 未验证或后续边界 |
| --- | --- | --- | --- |
| 1 | 右键画布新增节点 | 已实现。Task 3 实际鼠标/键盘菜单、表单与重启验收；`workflow.test.ts` / `workflow-electron.mjs`。 | 未增加自动布局。 |
| 2 | 右键节点新增关联节点 | 已实现。创建节点并保存关联边；新节点避开已有占位。Task 3 鼠标命中及持久化证据。 | 多目标汇合、自动文件合并另作设计。 |
| 3 | 选择模型、名称、插件与 skill | 已实现配置/目录读取与激活偏好，修订冲突及忙碌锁定。Task 2/3/7、实际 CLI 目录和 Task 8 配置表单。 | 真实模型调用、所有插件账户和实际执行环境未逐一验证；清单 manifest 的版本/哈希不代表完整包或运行时冻结。 |
| 4 | MCP 工具新规范 | 五个核心工具已实现，旧 handoff/complete_task 和单 node 编辑兼容；真实 HTTP、持久回执、原生 fixture 和 Electron 综合验收见下方 2026-10-21 增量。 | 真实模型自主选路、全部插件账号仍未验收；见 [MCP 协作设计](2026-10-21-mcp-collaboration-design.md)。 |
| 5 | 关联条件保存及以后由 MCP 指导选择 | 已实现自然语言条件、版本化编辑、发送理由、无边发送和可选边版本快照；过期显式选路拒绝，旧消息快照不随编辑改变。 | 条件由 Agent 判断；不增加条件表达式解释器。 |
| 6 | 节点 cwd 等于所属项目 | 已实现启动/恢复均使用原目录；项目级独立 Codex home，复制后的误绑定拒绝。Task 2/8 回归及隔离 Electron。 | 不自动创建 Git 仓库或节点工作树；搬迁项目会话数据尚未支持。 |
| 7 | 向任意节点自由发送内容 | 已实现文本/原生输入块及附件，同节点 FIFO、不同节点独立、暂停时排队。Task 2/4/6/8。 | 输入类型仍须受原生协议支持；真实模型对任意媒体的处理未验证。 |
| 8 | 每节点独立上下文历史 | 已实现独立 thread 复用、原始条目及增量、补读，保留 thread/turn/原始输入/已提交成果。Task 6/8，v1/v2 兼容迁移。 | 原生历史读取失败会显示不完整；不会伪造正文、作者或时间。 |
| 9 | 项目按时间排列并注明节点历史 | 已实现已知时间按时间、未知时间置后按记录序号；原始作者名快照保留。Task 6 排序回归及 Task 8 项目/节点像素。 | 未知时间不能恢复真实发生顺序。 |
| 10 | 保留 Codex 原生能力，只增加协作 | 已实现原生会话、审批/输入/权限/elicitation 验证；未适配宿主方法明确返回 unsupported。Task 7 当前真实协议 schema 的 18 种兼容决策检查。 | 真实登录/模型/全部插件未验收；不能声称所有官方宿主能力均移植。能力分层详见 `task-7-capabilities.md`。 |
| 11 | 当前工作与浏览器、设计图面板 | 已实现节点工作展示、实际 WebContentsView 浏览及项目文本/SVG/HTML/PDF 预览、隔离/覆盖层/代际生命周期。Task 7 像素、Task 8 网页/文件综合路径。 | **Agent 浏览器控制桥、MCP App UI 双向桥、完整交互式终端仍待独立实现。网页/文件预览不能当作这些桥。** |
| 12 | 输入右、输出左及真实来源正文 | 已实现用户/节点/系统/未知来源，原生 role 独立记录，续接不会改称用户原话；Task 6/8 实际几何和截图。 | 无法推断历史未知作者；原始记录不会被摘要覆盖。 |
| 13 | 不强制 summary/verdict 或业务 Schema | 普通会话、旧交接结果和新版 MCP `send_message` 均保留自由内容；null/false/0/空字符串/嵌套 JSON 及原字符串通过正式 HTTP 回归。 | 新版消息不施加旧链路轮数限制；遗留 `start` 演练路径保留旧保护（功能设计 12.3）。 |
| 控制 1 | 当前项目全部暂停 | 已实现覆盖每节点唯一 status，保存正在执行节点恢复范围并请求原生中断。Task 4/6 故障与竞态回归。 | 已发生的外部操作无法撤销；请求中断不等于已确认暂停。 |
| 控制 2 | 当前项目全部开启 | 已实现只续接记录内的原执行节点，原空闲节点待命，单独控制可覆盖。Task 4/6。 | 停止/待核对任务不能被批量盲重放。 |
| 控制 3 | 暂停单节点 | 已实现中断确认、忙碌时可用、晚到响应隔离，Task 4/6/8；确认暂停重启仍保留。 | 存储故障时 best-effort 中断，回执 unknown，不能宣称已保存暂停。 |
| 控制 4 | 启用单节点 | 已实现原 thread 续接、单节点覆盖批量暂停、系统续接来源及原任务保留。Task 4/6/8。 | 原执行结果未知时必须先核对并明确重试。 |

## 生命周期、可靠性和数据范围

- 关闭窗口隐藏到真实 Electron Tray；托盘打开工作台、明确退出会关闭后台。退出/重启不自动重放活跃任务；标为 `needs_reconciliation` 并保留原生关联。Task 8 的实际 Electron 综合脚本为 `scripts/verify-desktop.mjs`，托盘证据使用真实生命周期 API/菜单回调；物理 OS 托盘像素与点击未自动化。
- `WorkflowEngine.close()` 同步锁闭新工作，并发/重复调用共享同一 Promise 及结果。健康项目的流式尾部在退出前保存；多个保存/原生客户端/MCP/数据库关闭失败仍逐项尝试，合并失败报告。客户端退出共享其唯一关闭 Promise，包括已从当前映射移出、仍在退役的客户端；成功才释放所有权，失败结果继续保留供退出报告。已经锁存存储故障的项目不把未提交内存状态写回；此时关闭成功仅表示资源释放，原故障仍须修复并在重启后核对。
- 候选终结/交接先 SQLite 提交再发布，稳定命令 ID 与原生 task/thread/turn/call/fingerprint 防止进程内重复派发。CommandReceipts 在进程生命周期内保留 ID/回执，可能随长期操作增长内存；跨进程不提供 exactly-once。重启结果未知时不自动重发外部操作。
- 共享连接 Promise、实例身份、stop epoch、修订与导航 token 隔离旧回调。当前整个应用生命周期只有一个 utility worker；generation 的 `Date.now()` 适用于这一生命周期。若未来实现进程内 worker 替换/监督恢复，必须重新设计接收端会话采用与 epoch；本轮未添加这样的重启。
- SQLite JSON 仍保存整份状态，历史写入为 O(history)，活动元数据整体传输；50ms 合并流式文字，崩溃可能损失尚未刷新的窗口。关键输入/终结即时提交；不声称无限历史规模。文件成果与数据库不是同一事务，提交失败可能留下孤立文件，不自动删除。
- 当前正式入口将状态、Codex home、附件、浏览器数据、缓存、验证 profile 及日志路径配置在所属项目内、非 C 盘，并校验真实路径/祖先、保留目录、ADS 和设备路径。该配置保证不代表此前所有工具执行均无路径偏差；早期 Task 1 尚未重定向 tsx 缓存的是否外写仍未确认，保留在[执行记录](../../.runtime/implementation/progress.md)。普通 `.env` / `.env.*` 仍可由用户选择；不增加未要求的内容过滤。本轮测试没有使用真实项目任务、登录信息或凭据。

## 权限实验：不是强隔离

Task 8 新鲜无凭据 fixture 在 Codex `0.163.0-alpha.10.2` 上运行实际 `command/exec`，分别检查普通工作文件、模拟 `.mixcat/state` 和模拟 `.mixcat/codex` 哨兵的读写。`task-8-boundary-probe/result.json` 记录实际版本、有效配置、请求策略和父进程核验。

Windows `unelevated` + `workspace-write` 下三类哨兵均可读写。named deny profile 虽可枚举为 allowed，实际执行器报告无法实施 deny-read 并拒绝执行；没有自动降级到无沙箱/elevated/MXC/WSL，没有安装系统配置。这里的预览/导入路径守卫只限制宿主入口，不代表 Agent 原生文件能力不能接触项目内控制目录。当前模型是可信本地 OS 用户，**尚未提供对项目内控制与登录目录的强隔离**，后续方案仍需单独确定，不能靠迁出项目或禁用原生能力掩盖。

## 验证层级与后续目标

实际 CLI 的初始化、模型/技能/插件目录、协议 schema 与本次权限探针已经执行，均使用新鲜无凭据 home；未执行真实模型推理或登录。协议/native stdio fixture 验证调度、HTTP、错误与恢复；真实 Electron 验证 main/preload/worker/engine/MCP/panels 和实际鼠标命中、几何及像素。这些证据层级互不替代。最终测试、类型检查、构建退出码及归档哈希列在 `task-8-report.md` / `task-8-verification.json`；独立整体复核已检查实际源码及跨模块调用链，并核对现有证据，没有重复整套测试或将旧集成结果改称最后修复后重跑。

2026-10-20 退役客户端所有权修复后的当前完整正式套件 143/143 通过，类型检查退出 0、构建退出 0；构建保留已知 React Flow `use client` 提示。此前隔离 Electron 综合故事退出 0，三次完整应用启动、8 次受控原生 turn；实际 HTTP 五轮规划→执行→审查→执行→审查，四次交接。确认暂停经过应用重启再明确续接；另一次活跃退出在重启后保持待核对，原生 turn 数量没有增加。本次所有权修复由新增门闩回归和完整套件验证，没有重复运行这组三启动 UI 故事。原型 43 项和历史根 `dist/` 9 项哈希不变；此前记录的三个 Electron 主进程与两个原生 fixture 进程均退出。

## 2026-10-20 增量：设置、共享账号与节点删除

已按用户确认增加“设置”入口，整个客户端共用 Codex 账号；原生项目 home/cwd 和独立会话继续留在所属项目。节点右键及详情支持确认删除，归档节点定义/thread 绑定、保留任务/会话/交接/文件，移除配置关联线并关闭节点工作面板；未完成任务和待回应请求阻止删除。具体契约与内部协议兼容性见[专项设计](2026-10-20-settings-and-node-deletion.md)。

当前完整套件 **156/156** 通过，类型检查与构建退出 0。原普通沙箱运行的一个既有符号链接测试因 EPERM 无法创建 fixture，另一个既有控制测试暴露“消息受理即已建立 thread”的测试前置假定，已改为等待真实 `turn/start`；正常桌面权限的完整复跑全部通过，未跳过用例。React Flow 的既有 `use client` 构建提示仍保留。

独立增量评审发现并已修复、复审通过三处竞态：暂停恢复仍用旧账号、删除抢先于失败任务重试后改写历史、已撤销原生 token 刷新请求产生未捕获 rejection。对应测试先执行失败，再执行通过。

本次可定位证据：

- [完整测试日志](../../.runtime/implementation/settings-delete-tests.log)。
- [Settings/删除实际 DOM、鼠标与命中测试](../../.runtime/implementation/settings-delete-ui-8IgKm9/result.json)及[设置页像素](../../.runtime/implementation/settings-delete-ui-8IgKm9/settings.png)：采用受控 IPC，图片中的账号为合成 fixture。
- [真实 worker 与原生面板删除链路](../../.runtime/implementation/settings-delete-native-panel-result.json)：删除关闭 WebContentsView，旧布局请求被拒绝。
- [更新后综合桌面流程](../../.runtime/implementation/task-8-electron-result.json)：三次启动、八个受控 turn、实际 MCP HTTP 交接回流、暂停续接、活跃退出恢复和清理检查通过，测试进程全部退出。
- [实际 Codex 合成认证探测](../../.runtime/implementation/shared-account-native-5fE4kS/result.json)：版本 `0.163.0-alpha.10.2` 接受 external token，未创建项目凭据文件；不代表真实 OAuth 或模型业务验收。

Electron 普通沙箱启动遇到宿主安装目录 ACL 检查失败后，同一隔离验证入口在正常桌面权限下通过；未修改系统 ACL、产品沙箱参数或使用真实账号。

## 登录成功状态与恢复修复

认证确认后，简洁登录按钮显示绿色勾与“已登录”。登录完成或账号变更通知使更早的账号查询结果失效，避免迟到的未登录结果／错误覆盖成功状态。桌面后台启动时异步恢复本客户端已保存的登录；无缓存时不额外启动连接，不打开浏览器或启动项目任务。

当前完整回归 **160/160** 通过，类型检查和构建退出 0。四个新增回归先执行失败再通过，覆盖成功通知与旧查询并发、旧查询出错、保存登录恢复及无缓存不连接。实际 Electron 回调状态／绿色按钮／页面刷新验证见 [UI 验收](../../.runtime/implementation/settings-delete-ui-of87tv/result.json)；[综合桌面验收](../../.runtime/implementation/task-8-electron-result.json)新增了实际 worker 重启后直接显示“已登录”的断言，全部通过。

本机保存登录另经原生只读账号查询确认可识别，只输出布尔结果，未输出账号与凭据、未重新发起浏览器授权或模型调用。受限工具沙箱的查询曾报工作区路由发现失败，同一查询在正常桌面权限下成功，不将其误报为登录丢失。此次修复未新增连接操作或账号详情展示。

## 2026-10-21 MCP 协作实现与综合验收

已按确认的 [MCP 协作方案](2026-10-21-mcp-collaboration-design.md)和[实施计划](../plans/2026-10-21-mcp-collaboration-implementation.md)完成正式代码。五个核心工具为 `get_project_context`、`send_message`、`get_delivery`、`read_history`、`update_workflow`；条件边采用自然语言指导，允许无边发送并记录理由。新版普通消息先持久提交再排队，不结束来源工作，来源后续失败不撤销已受理消息；显式 `reply_to` 关联回复，普通输出不自动广播。等待回复可结束原 turn 并保留原 thread，不新增节点暂停状态。

单次发送一个目标，可分别多次发送；不做自动 join。旧 `handoff`、`complete_task` 保留兼容，其中来源成功完成门槛只适用于旧交接。审查只按用户任务要求参与，不作为默认必经步骤。工作流编辑复用 UI 校验、版本与现有授权，节点 cwd、原生能力及每节点唯一多值状态不变。附件版本快照已纳入消息方案，自动文件冲突处理和审查结论失效另作设计。

节点设置支持逐项授予新工具，旧项目迁移至 v3 时不自动扩权；UI 显示受理时来源、投递尝试、原始正文、附件和回复定位，定位保留节点草稿。原始历史和旧交接保持独立，接收失败后的明确重试保留消息身份、来源、reply_to 和固定附件，原始受理回执不改写。节点/边编辑复用正式校验、忙碌保护、版本冲突和原有编辑权，新授予不能超过编辑者拥有的新工具。

| 证据层级 | 实际范围 | 不能推出的结论 |
| --- | --- | --- |
| 真实本地 MCP HTTP | `tests/collaboration-http.test.ts` 组合默认权限/上下文、自由 JSON、无边并行发送、丢响应后的查询/并发重放、冲突拒绝、忙碌显式回复、原 Thread、接收重试、跨轮登记附件、版本化条件编辑。分模块测试另覆盖事务失败、授权、身份、分页、迁移和附件路径。 | HTTP 通过不等于真实模型会自主采用这些工具。 |
| 受控原生 stdio fixture | 正式 native client 协议、实际 thread/turn/call 元数据、选定 model/skill/plugin 参数和项目 cwd；接收方失败后由用户明确重试，回复仍关联原消息。 | fixture 返回的模型标识和合成账号不是真实推理、OAuth 或插件业务执行。 |
| 真实 Electron | 扩展原 `scripts/verify-desktop.mjs`，实际 main/preload/utility worker/MCP/SQLite；旧交接回流、新消息回流、无审查节点完成、暂停/续接/停止、暂停队列保存后整应用重启再启用一次、回执丢失后查询和跨重启重放、派发后真实 stdio 进程断连及未知执行零自动重放。保留窗口/托盘生命周期、原生面板和截图检查，成功结果确认所属进程全部退出。 | OS 物理托盘点击/像素、全部媒体和真实插件账号未自动验收；原生面板预览不构成 Agent 控制桥。 |
| 真实 Codex / 模型 | 沿用前文有日期的真实 CLI 初始化、目录、协议及权限探针事实；本次没有真实账号授权或模型调用。 | 模型自主选择、全部媒体/插件账号和项目控制目录强隔离仍未知。 |

本次使用项目内既有依赖，无新增服务或安装包。完整测试、类型检查、构建和上述桌面层分别记录命令、退出码、计数、源码哈希、截图和清理结果，位于本地忽略的 `.runtime/implementation/mcp-collaboration/task-7/`。外部并行 UI 改动未混入 MCP 提交：干净固定 HEAD 导出作为提交代码的最终验收，混合工作区验证单独保存哈希清单；更晚的外部编辑不被追认为已验证。前文历史测试数字、原型记录和旧交付事实保留原日期，不能替代此次分层证据。整体最终评审及计划状态以实施计划的实际完成记录为准。

待后续独立设计：笔记/知识库服务、多目标汇合、自动文件冲突处理、确定版本审查自动化、ComfyUI、Agent 浏览器控制桥、MCP App UI、交互式终端。固定附件快照不代表整个工作区冻结，持久幂等受理不保证外部副作用 exactly-once。

源码已公开至 [GitHub 仓库](https://github.com/shenmuegit/mixcat) 的 `main` 分支。公开源码不等于发布可安装产品；当前没有安装包发布或生产部署验收。

## 2026-10-22 Web 产品六节点模板增量

按 [六节点设计](2026-10-22-web-product-team-workflow.md) 与 [实施计划](../plans/2026-10-22-web-product-team-implementation.md) 增加可选模板，复用现有会话、消息、队列、历史及控制。旧项目和未选模板的创建行为不变；已有文件不覆盖，原生默认模型和用户自选能力保留。

| 范围 | 当前证据 | 验收边界 |
| --- | --- | --- |
| 模板与能力配置 | 六个角色、建议路线、文档维护责任及缺失文档初始化；真实目录推荐配置、重试及并发版本保护；Task 1 规格与质量审查通过 | 外部工具和账号需要各自实际可用，不能由已选择推定成功 |
| 计划绑定与原生观察 | 项目内适配器委托官方 handlers，按 Thread 绑定计划；已有会话恢复前更新／移除旧绑定；无效或清空选择不沿用旧计划。用户批准后11项定义原生信任，七类 PWF 事件真实触发，两个原 Thread 的 A／B 自动上下文隔离后恢复主计划 | 初始 SessionStart 尚无绑定时安全跳过；I/O无法安全清除时停止派发。条件式 Ponytail SubagentStart未人为强制触发 |
| 客户端操作 | 模板选择、配置失败保留项目、推荐重试、model=null、合法计划 ID、节点目录异步归属与显式 hooks 审核；26 项 renderer 检查、受控 Electron 与独立复审通过 | 信任测试使用受控 bridge，没有代替用户授予真实信任 |
| 六节点受控流程 | 真实引擎／SQLite／HTTP MCP 串联六角色、忙碌／暂停队列、单节点覆盖、空闲节点恢复后接收、原 Thread 回复、版本附件、QA 回流及重启；专用回归与独立审查通过 | 原生 Thread／模型回包是 fixture 数据，不替代真实产品流程 |
| 当前整体代码 | 完整套件 **289/289** 通过，无跳过；类型检查、最新构建和 Electron 操作检查退出0；最终独立评审的映射写入失败 P1 已用真实 Windows 只读故障复现、修复并复审 | 映射无法安全清除时在恢复／开始原生轮次前失败，不伪装成安全跳过；代码检查与真实原生验收分别保存 |
| 真实原生环境与产品 | 六个不同的真实 Codex Thread 已完成需求、设计、前后端、独立测试和产品验收；60条受理消息、26条显式回复、20次无边发送及97份附件哈希核对。真实浏览器／接口验证、设计问题回流已保存；重启后原 Thread 继续接收用户输入 | 不能据此推广全部插件、账号、浏览器或硬件能力；人工输入法／读屏及全部平台等未验证范围保留 |
| 外部 MCP 接入复验 | 项目原生配置指定已安装 Edge 及项目内 profile，并对齐后端 GitNexus 注册目录；原测试 Thread 完成浏览器 MCP 的打开、输入、点击、真实响应与DOM核对及关页，GitNexus查询实际函数调用图；最终目录原生回报connected、无错误 | 属于本机实际配置，不是模板自动选择所有浏览器；索引新鲜度仍需核对。前一轮出现 MCP 传输错误，保留记录，不声明零失败或 exactly-once |
| 插件运行依赖 | ECC 原生命令缺少 js-yaml 的失败已诊断；官方锁定生产依赖在项目中准备，最终运行文件按 Codex 内部数据例外安装。ECC原生SessionStart重试成功；全新原生导入保留自身依赖的 smoke 通过 | 未修改已审核定义或哈希；上游替换版本目录后需重新准备相应运行依赖 |

本轮代码在 `codex/web-product-team` 工作分支及当前保留的工作区内，尚未提交或推送；既有 UI 改动保留。报告和本机证据位于 [逐项完成审计](../../.runtime/implementation/web-product-team-20261022/records/completion-audit.md)、[完整回归日志](../../.runtime/implementation/web-product-team-20261022/logs/final-tests-3.log)、[真实协作审计](../../.runtime/implementation/web-product-team-20261022/evidence/live-audit.json) 和 [原生验收记录](../../.runtime/implementation/web-product-team-20261022/records/native-acceptance.md)。测试引擎正常退出，26个已记录的所属后代进程均不再存活；专用浏览器及4173后端已关闭，无活动任务，详见[清理记录](../../.runtime/implementation/web-product-team-20261022/evidence/cleanup.json)。真实测试项目与证据保留，运行数据、文档、浏览器 profile、截图、下载与缓存留在项目内；Codex全局目录只补齐已安装插件的最终运行依赖。原生信任仅作用于用户批准的该测试项目，不推广到其他项目。

## 2026-10-24 人工核对机制增量（实现、验收与清理完成）

按[人工核对设计](2026-10-22-human-review-design.md)与[实施计划](../plans/2026-10-22-human-review-implementation.md)，Tasks 1–6 及整计划完成；最终整体评审的一次集中修复经独立限定范围复审，I1／I2／I3／M1 全部 ADDRESSED，最终代码 READY。新 Web 项目默认需求方向及 UI/UE 两个核对点；旧项目保持空规则和原授权。等待业务核对使用任务 `waiting_review`，每节点仍只有原有一份多值运行状态；正式决定仅来自可信桌面针对具体版本、包哈希及 actionId 的操作。普通输入先保存，受理不代表派发；暂停、取消、旧输入与未知原生执行不能被新通过暗中复活或改写。最后样例任务核对、当前材料校验及全部所属实例清理通过，[最终完成审计](../../.runtime/implementation/human-review-20261022/records/native-completion-audit.json)于 2026-10-24T08:39:56Z 记录 PASS。

| 证据层级 | 本轮实际结果 | 边界 |
| --- | --- | --- |
| 领域／存储／HTTP／派发／renderer | 最终修复后 `./scripts/dev.ps1 test` **393/393**，零失败／取消／跳过；聚焦 82/82，类型检查／构建退出 0。保留默认双门、回流、过期、暂停、停止、原 Thread、固定附件及重启覆盖，并新增来源祖先异步换版、运行中旧依据警告和材料差异回归 | 393 是当前完整代码边界；289／374／90／376 是各自历史阶段，不能视为最终修复后的新结果。原生回包和受控决定仍标记 fixture |
| 实际 Electron 与原生材料面板 | 最终修复后受控 Electron 1/1 通过；保留卡片／原始意见／同 actionId 重试／键盘与命中／固定 Markdown 和图片／full-delta 及关闭详情后隐藏原生 view 的断言，白灰像素比 0.9875。迟到材料场景以 IPC 完成确认加 renderer 两帧稳定取代固定 200ms 等待 | 真实 Electron DOM／WebContentsView，桥回包仍是 fixture，不能称用户已认可方案。此前两次 UnknownVizError 捕获失败保留，原因未确认；后续 PASS 不证明原因或通用捕获可靠性 |
| 生产 main/preload/utility worker／SQLite／HTTP | 两次整应用启动，保留原生产入口与预加载；隔离副本只增加测试 inspector 引用。需求决定、暂停的已排队 backend、未决 UI 及等待 frontend 均跨重启保留；包哈希／续接任务 ID／design Thread 不变；UI 受控决定后放行一次，最终全部任务完成 | 合成账号和 native stdio fixture，无真实模型、真实业务决定或 hooks 自动信任；与 Controller 的真实模型组合入口区别记载 |
| 实际模型／用户两次业务核对 | 真实 product／design 原生会话提交包；用户原话“通过这个 v1”及“通过 UI/UE v1”分别保存为 [human-direction-v1.json](../../.runtime/implementation/human-review-20261022/native/live-20261024-Q92z63/human-direction-v1.json)／[human-ui-v1.json](../../.runtime/implementation/human-review-20261022/native/live-20261024-Q92z63/human-ui-v1.json)，对应确切 v1／bundleHash，可信命令各提交一次，续接原 Thread；frontend 在第二次决定后才开始 | 这是 Controller 转交的真实聊天授权，未冒充物理鼠标点击。业务通过不替代原生权限／hooks 信任。真实入口为隔离生产组件组合，与上一行正常编译 main/worker 受控入口分开；普通 start 包装入口本轮未测 |
| 极小产品真实 HTTP／浏览器 | backend 在 Node 18 完成 18 项真实 HTTP 检查；Controller 在 Node v24.19.0 通过实际 Chromium CDP 输入提交页面并读取真实后端网络响应，5 项场景通过：中文／空白原文、危险标记按文本、空／纯空白拒绝及错误焦点、键盘提交、320px 无横向溢出。[产品结果](../../.runtime/implementation/human-review-20261022/records/native-product-result.json)记录 source hashes、截图、实际响应和 serverStopped=true；最终完成审计确认结果与源码哈希不变 | 不是 mock 后端；不据此声称每个节点用过全部插件、每种浏览器都实测或所有外部账号可用。整体清理另见下一行的进程／端口审计 |
| 最终代码评审／运行核对／清理 | [最终修复](../../.runtime/implementation/human-review-20261022/records/final-fix.md)与[独立复审](../../.runtime/implementation/human-review-20261022/records/final-rereview.md)确认 I1／I2／I3／M1 关闭、代码 READY。最终持久项目 completed，18 个任务记录中 13 个完成、5 个历史失败／重试尝试保留；零活动／等待／暂停／needs_reconciliation、零原生请求，两次决定各恰好一次已完成原 Thread 续接；当前生产校验确认所有本项／祖先来源和固定材料字节有效 | 最终 run 5d99db6a-196a-4b4b-8c84-2930e467b222 正常关闭、驱动退出 0；[进程审计](../../.runtime/implementation/human-review-20261022/native/live-20261024-Q92z63/final-process-audit.json)确认 10 个 PID＋创建时间身份均退出；最终完成审计确认 14317／29802／14319／13559 所属端口全关闭。历史中断及捕获失败保留，不包装成零失败；Task 6／整计划完成 |

最终修复保留来源任务捕获的祖先版本，在材料准备前、准备后及最终验证后检查，重放仍返回原回执；运行中依据过期只显示可见警告，不自动停止／改写原任务。材料失败显示本项／上游核对身份、版本、所选路径／artifact 及保存／当前 SHA-256 和字节数。实际差异仅来自已核验的固定原件，支持已知 UTF-8 文本不超过 64 KiB 的首个变化区域，每侧最多 5 行、每行 240 字符；二进制、缺失、不可读或原件不可用时明确说明限制，仍阻止决定。此功能只核对所选材料及捕获的祖先，不冻结工作区，不保证外部稍后修改永不发生。

当前最终证据：[393 项完整测试](../../.runtime/implementation/human-review-20261022/records/final-fix-full-suite.log)、[82 项聚焦检查](../../.runtime/implementation/human-review-20261022/records/final-fix-focused-green.log)、[Electron 结果](../../.runtime/implementation/human-review-20261022/records/final-fix-electron.log)与上述 final-fix／final-rereview；早期受控证据仍见 [Task 6 报告](../../.runtime/implementation/human-review-20261022/records/task-6.md)、[374 项历史完整测试](../../.runtime/implementation/human-review-20261022/task-6/logs/full-suite.log)、[两次生产桌面启动](../../.runtime/implementation/human-review-20261022/task-6/desktop/desktop-n9GhKp/result.json)。原生分阶段记录见[native-acceptance.md](../../.runtime/implementation/human-review-20261022/records/native-acceptance.md)，早期 pending 描述保留阶段背景；当前决定以原始文件为准，最终持久状态、材料与清理以最终完成审计及进程审计为准。

Node v24.19.0、Electron 44.9.0；真实样例最初 CLI 0.163.0-alpha.11，宿主更新后续接已有原生会话使用 0.164.0-alpha.11.1，不将新版本回写旧证据。初始 CLI 目录及旧原生信任证据沿用各自日期。现有 React Flow `use client` 构建提示保留；项目未配置 lint／coverage 命令，没有新增检查框架。源码／产物哈希和 before-image 差异包保留于报告；未自动提交、推送或发布，未改全局账号、hooks 或浏览器规则，也未启动生产用户根或迁移其他项目。
