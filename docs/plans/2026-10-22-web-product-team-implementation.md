# Web 产品六节点模板实施计划

> **For agentic workers:** Use superpowers:subagent-driven-development for focused implementation and task review. Steps use checkbox tracking. Work from the current preserved working tree; no broad staging, reset, push or publication.

**Goal:** 在 Mixcat 创建可配置的六节点 Web 产品工作流，实际接入推荐能力、文档与计划上下文，以一个“提交一条留言并显示”的极小前后端产品验证完整协作。

**Architecture:** 保留现有消息、原生 Thread、队列、存储和控制。增加可选模板与文档初始化，按真实目录选择能力，复用原生插件导入；项目内规划 hook 适配器按原生 session_id 绑定计划后委托官方脚本。新增能力状态取自原生查询及生命周期事件，不模拟信任或模型执行。

**Tech Stack:** 现有 TypeScript、React、Codex app-server、MCP、SQLite 和 Node 测试／Electron 工具；不新增服务或依赖。

**Spec:** [Web 产品团队工作流设计](../design/2026-10-22-web-product-team-workflow.md)。

## Global Constraints

- 保留 Codex 原生能力；节点工具列表只描述 Mixcat MCP 授权，不是原生能力白名单。
- 项目 cwd、独立 Thread、自由输入、显式回复、原始历史及四种控制沿用已有契约。
- 只有选择 Web 模板才建立六节点；未指定模板与既有演练维持旧行为。
- 所有工作树、临时、下载、缓存、证据和微型产品均在所属项目内、非 C 盘，先核验真实路径。
- 现有 22 个改动文件已保存在本地 before 清单；仅增量修改，不提交外部 UI 改动。
- 原生模型／skill／plugin／MCP 目录是配置依据；缺失必须可见，不能把名字写入职责就称为已激活。
- 不直接写入或伪造原生 hook 信任记录；具体定义经用户明确审核后，使用宿主实际支持的原生配置接口并重新查询核验。不使用直接脚本测试代替宿主生命周期验证。
- 正式设计在 docs/design，计划在 docs/plans，执行证据在 .runtime/implementation/web-product-team-20261022。
- 一个共享文档有明确维护者；MCP 消息与文档内容不替代引擎权威状态。

## Review Focus

1. 已有项目／已有文档／创建重试：不重置配置、历史或覆盖用户内容；预检所有目标路径后才初始化缺失文件。
2. 能力目录缺失、插件导入失败或模型为 null：保留原生默认和成功配置，错误真实可见，不伪造激活。
3. 双 Thread 不同计划、缺失绑定和暂停续接：按 session_id 绑定，不改共享进程环境或回退最近计划。
4. hooks 未信任或失败、外部 MCP 未就绪：显示真实状态，保留原生事件，不放宽审批或制造运行成功。
5. 单功能实测：六个原生会话及真实消息／回复可追溯，需求与测试对应实际文件版本，页面确实访问后端完成核心操作。

## Task 1：六节点模板、文档及配置入口

**Files:** 新建 src/core/web-product.ts、tests/web-product.test.ts；修改 src/shared/types.ts、src/core/engine.ts、tests/projects.test.ts。

**Interfaces:** create_project 增加可选 template='web-product'；ProjectSummary 保存模板来源；NodeDefinition 可选 planId。模板模块提供 createWebProductTemplate()、initializeWebProductFiles(root,name,goal)、selectWebProductCapabilities(nodes,catalog)。节点 ID 为 product、requirements、design、frontend、backend、test；默认计划 mvp-001，产品经理是共享计划维护者。

- [x] 写模板角色、条件边、自由结果、推荐能力匹配和文档不覆盖／路径拒绝测试，先确认失败。
- [x] 实现模板定义与缺失文件初始化，模型／skill／plugin 只解析真实目录，不写死本机路径。
- [x] 在新建状态分支集成；重复注册旧 root 不覆盖旧模板与文档。保留基础三节点 API 和演练。
- [x] Web 模板提供从实际目录配置推荐能力的入口，忙碌／版本变化时拒绝覆盖；保留用户自选能力。
- [x] 运行聚焦测试和类型检查，完成本任务规格与质量评审。

## Task 2：真实能力、计划绑定和原生观察

**Files:** 新建 src/core/planning.ts、src/core/host-mcp.ts 及对应测试；修改 src/core/catalog.ts、src/core/engine.ts、src/shared/types.ts、必要原生 fixture。

**Interfaces:** preparePlanningRuntime(root,skillPath) 安装项目内适配器和未经改写的官方 PWF handlers，返回真实准备结果；bindPlanningThread(root,threadId,planId) 更新项目内映射。catalog 可选择查询 hooks/list 和 mcpServerStatus/list；项目级原生客户端仍共享，普通 Thread 不改变其进程 PLAN_ID。

- [x] 写双会话不同计划、未知绑定不回退、已有 hooks 保留、路径拒绝以及原生通知归属的失败测试。
- [x] 复用选择插件的项目导入；缺少全局 skill 时才使用原生 extraRoots。仅引入模板明确需要的 GitNexus／浏览器 MCP，保存真实可用性。
- [x] 用线程映射的 hook 子进程环境委托官方脚本；初始 SessionStart 尚未绑定时安全跳过，turn/start 前绑定，恢复继续复用。
- [x] 原生 hook/started 和 hook/completed 进入活动与原始历史；目录展示原生 load/trust/error，不创建另一套审批／调度器。
- [x] 在项目内受控 fixture 检查七类 callback 及错误情况；再用真实原生协议核验目录和生命周期。若未信任，保留实际状态并准备可审阅文件供宿主确认。
- [x] 运行受影响测试与任务评审，不扩大原生权限或绕过未知执行核对。

## Task 3：客户端模板与能力配置

**Files:** 修改 src/renderer/App.tsx、NodeSettings.tsx、Workbench.tsx、必要样式和 renderer／Electron 测试。

**Interfaces:** 创建项目可选 Web 产品模板；复用现有节点能力字段，保留 model=null 的“原生默认”。节点可查看推荐能力缺口、真实 MCP 工具状态、hooks 状态和自己的 planId。

- [x] 写创建模板参数、原生默认模型保存、目录缺失和未信任提示的行为测试。
- [x] 添加模板选择与推荐配置操作，复用现有表单与节点编辑；不改已确认的白灰布局、输入输出及侧栏安排。
- [x] 显示准确的能力与计划状态，不把安装目录当成工具运行成功。
- [x] 用真实 Electron DOM、鼠标与截图验证模板创建、六节点配置和错误展示，保留现有 UI 改动。
- [x] 完成任务评审；仅在新变化需要时重跑相关 UI 检查。

## Task 4：完整流程与极小产品实测

**Files:** 增加受控六节点协作测试及可复用验证脚本；更新交付矩阵、英文 README、设计与本计划完成记录。

**Interfaces:** 复用真实 WorkflowEngine、HTTP MCP、原生账号接入与历史；微型产品和所有证据在 .runtime/implementation/web-product-team-20261022。实际运行模型与受控 stdio fixture 的结论分别保存。

- [x] 验证六节点创建／重启、不同 Thread、相同 cwd、同节点原上下文继续，以及任意输入保留。
- [x] 用真实 HTTP 检查正常分派、显式回复、无边直发、忙碌／暂停排队、测试问题回流与同一计划维护规则。
- [x] 复用已登录共享账号，实际运行六角色开发极小留言功能；只在本地项目操作，不发布外部内容。
- [x] 运行产生的前后端，通过浏览器提交留言并检查真实接口结果；保存需求、设计、接口、源码版本、测试和协作证据。
- [x] 原生 hooks 由宿主真实确认后核验自动生命周期；缺失或未知不得标记已通过。需要用户原生信任时在准备好具体配置后请求，期间继续其他验证。
- [x] 运行完整测试、类型检查、构建和本次必要桌面检查，确认所有所属测试进程退出。
- [x] 最终独立评审、修复和逐项完成审计，更新交付状态；无必要剩余工作才完成目标。

## 执行与证据

使用当前明确授权的实现任务继续工作，不重复询问是否开始。任务实现与评审结果记录在 .runtime/implementation/web-product-team-20261022/records/；本计划的勾选只随实际证据更新。安装／可发现／已选择／已加载／可信任／实际执行分别陈述。

2026-10-22 当前记录：Task 1／3 及 Task 4 的受控六节点流程均通过独立评审。Task 2 的恢复前绑定、清空选择的持久化形状，以及映射无法替换时不得注入旧计划三项问题，均已修复和复审；最后一项用真实 Windows 只读文件故障先红后绿。当前完整套件 **289/289**、类型检查、最新构建及 Electron 操作检查通过。

六个真实模型会话已完成极小产品开发与业务验收，包含设计回流修正、独立浏览器测试、60 条受理消息、26 条显式回复、20 次无边发送和97份逐一核验的固定附件。重启后原测试 Thread 接收新的用户输入，并继续进行真实 MCP 接入复验。运行时端口冲突、Chrome 缺失和 GitNexus 注册目录差异已按实际环境处理；MCP 传输失败保留原始错误与受理记录，不冒充送达。

用户随后明确批准该测试项目的11项当前定义；已通过原生接口信任并再次核对，所有哈希和启用值与审核清单一致。七类 planning-with-files 原生事件均实际完成；两个原 Thread 分别自动收到 A／B 计划，未交叉注入，随后恢复主计划。手动压缩以原生 contextCompaction 完成项为证，未把即时 idle 回执当成完成。

ECC SessionStart 的实测失败已定位为官方生产依赖缺失。按官方锁文件在项目内暂存／安装依赖，再复制最终 Codex 插件运行文件；未改 hook 定义或信任哈希。原生重试成功，独立全新原生导入 smoke 证明依赖随导入保留。真实浏览器 MCP 留言往返与 GitNexus 调用图查询均通过，实际范围及未测项详见[原生验收](../../.runtime/implementation/web-product-team-20261022/records/native-acceptance.md)。

最终引擎以退出码0关闭，已记录的26个所属后代进程、专用浏览器及4173后端均已退出；没有活动或未决任务，未操作其他服务。关闭后重读持久化数据，全部受理消息与97份固定附件再次核对通过。八项设计验收标准的证据与限制见[逐项完成审计](../../.runtime/implementation/web-product-team-20261022/records/completion-audit.md)，进程核对见[清理记录](../../.runtime/implementation/web-product-team-20261022/evidence/cleanup.json)。本计划完成；当前保留工作区和测试成果，未提交、推送或发布。
