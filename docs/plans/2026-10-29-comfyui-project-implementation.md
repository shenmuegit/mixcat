# Mixcat 原生 ComfyUI 与厂商 BYOK Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Mixcat 中集成完整 ComfyUI 原生画布，让项目 Codex 编辑并运行同一份图，直连字节、MiniMax、Vidu 的用户 API Key/API 地址，并能审查、验证和回退上游更新。

**Architecture:** 官方 ComfyUI 后端与匹配前端作为项目内受管运行组件，Electron WebContentsView 承载原生页面。独立 Comfy 扩展提供当前图操作桥以及 STRING/IMAGE/VIDEO 厂商节点；Mixcat 主进程托管 ComfyService、任务回执与供应商请求服务，凭据只在可信设置 IPC 和凭据库之间流转。现有 core worker 继续负责原生 Codex 会话，通过一个窄的反向请求通道调用 ComfyService。

**Tech Stack:** 当前 Node 24+、TypeScript、React、Electron 44.9.0、node:sqlite、已有 MCP SDK；ComfyUI 官方 Python 环境、原生前端与扩展 API。供应商 HTTP 使用现有平台 fetch，不为三个适配器引入全套 Agent/供应商 SDK。

**Spec:** [设计](../design/2026-10-29-comfyui-project.md)；[Issue #155](https://github.com/shenmuegit/mixcat/issues/155)。

规划基线：main `c3f299ea9e23055e7ea2abbc51b864d7d9896480`。执行基线已核对为 `2d3a16cd9d8e37aac034a9833f56151f1243b23c`。用户已明确要求先 clone 固定版本，再按本计划开始实现；执行证据由本计划的 SDD 台账记录。

## 执行前准备

- [ ] 读取当前 AGENTS.md 和相关技能，核对 Issue #155 最新正文/评论，核实 main 与并行改动。建立/复用 `codex/issue-155-comfyui`；工作树只放 `G:/code/mixcat/.runtime/worktrees/issue-155-comfyui`，确认真实路径后创建。仅带入本任务设计与计划，记录实际审查基线。
- [ ] 在隔离工作树运行类型检查及项目/MCP/native 核心基线测试，记录真实状态；本次完整测试留到 Task 10。发现主分支接口漂移，先更新计划对应接口而不是照抄旧行号。
- [x] 信息流会话已通知旧验收窗口结束，临时客户端重启协调约束解除。正式构建/重启仍按 AGENTS.md 核实活动任务与草稿并安全退出。

## Global Constraints

- 主画布必须使用完整官方 ComfyUI 前端；Codex 修改当前根工作流，同时保留原生标签页、子图及选区语义。
- 首批厂商：字节火山方舟、MiniMax、Vidu；用户填写自己的 Key、API 基址和模型/Endpoint ID。Comfy credits 不能替代 BYOK。
- GPU 加速不作为画布或 API 模型集成前提。后端可使用官方 CPU 模式；混合本地模型性能按实际任务验证。
- 所有工作树与工作数据位于所属项目内、非 C 盘，并核对实际路径；Python/HTTP 下载/浏览器/安装验证缓存同样适用。官方安装流程例外按 AGENTS.md 执行。
- Key 不进入 AppCommand、CommandDispatcher、MCP、工作流、PNG/视频元数据、聊天、普通日志或回执。原生 Codex 能力、技能/插件、历史和审批继续复用。
- 供应商连接基址与 Key 绑定。工作流只引用 connectionId，不能传任意 URL 或原始鉴权头；更换基址需在可信设置中重新绑定凭据。
- 不假设供应商创建请求幂等。提交结果不明不自动重发；停止等待不等于远端取消，终态 DELETE 不当作取消成功。
- 上游后端/前端/依赖/桥/节点版本作为一个兼容组合管理；活动任务期间不就地升级。
- 用户已授权按本计划实施。实施按 Issue → 项目内工作分支/工作树 → TDD → 双轴审查 → PR → 合并 → 正式客户端重启流程；付费验收单独遵守实际授权。

## Review Focus

1. 手动改图、切换标签页或子图后迟到的 Agent 写入：校验完整观察身份，拒绝覆盖。Task 3/7 测试。
2. 供应商已收单但提交响应丢失、Comfy 缓存和重启：持久回执与 submission_unknown 阻止重复收费。Task 1/6 测试。
3. 导入工作流把 Key 发到另一地址、重定向或错误正文泄露 Key：连接绑定、无鉴权转发重定向、全出口假 Key 检查。Task 4/5 测试。
4. 原生视图仍覆盖设置/文档页、worker 重生或复用端口后旧页面请求：项目+实例+presentation generation 校验。Task 2/3/8 测试。
5. 供应商任务 running 不能取消、升级会迁移数据、主进程退出会强杀 worker：实际状态、活动阻止与完整环境/数据恢复。Task 6/8/9 测试。

## 任务与文件边界

| 任务 | 新建的主要文件 | 接入现有文件 |
| --- | --- | --- |
| 1 类型、项目、持久记录 | src/shared/comfy.ts；src/core/comfy-store.ts；src/core/comfy-template.ts | src/shared/types.ts、src/core/store.ts、src/core/engine.ts、tests/runtime-fixture.ts |
| 2 官方运行组件 | resources/comfy/runtime-manifest.json；resources/comfy/requirements-win-x64.lock；scripts/prepare-comfy.ts；src/core/comfy-runtime.ts | scripts/build.mjs、scripts/dev.ps1、src/core/paths.ts 的现有帮助函数 |
| 3 原生画布与编辑桥 | src/desktop/comfy-host.ts；src/core/comfy-service.ts；src/desktop/comfy-preload.ts；resources/comfy/mixcat/web/bridge.js | src/desktop/main.ts、src/core/worker.ts、src/desktop/preload.ts |
| 4 连接与凭据 | src/desktop/provider-vault.ts；provider-settings.ts；provider-settings-ipc.ts；src/renderer/ComfyProviderSettings.tsx；src/shared/comfy-providers.ts | src/desktop/main.ts、src/desktop/preload.ts、src/shared/comfy.ts |
| 5 三家协议 | src/core/comfy-providers.ts | ComfyService 的供应商请求入口 |
| 6 原生节点与运行 | resources/comfy/mixcat/nodes.py；src/core/comfy-runs.ts；src/desktop/comfy-broker.ts | ComfyService、ComfyStore |
| 7 Codex 工具 | src/core/comfy-tools.ts | src/core/mcp.ts、src/core/engine.ts、src/shared/types.ts、src/core/comfy-template.ts |
| 8 工作区与生命周期 | src/renderer/ComfyWorkspace.tsx；src/renderer/SessionPane.tsx | src/renderer/App.tsx、src/renderer/ProjectManagement.tsx、src/renderer/Workbench.tsx、src/desktop/main.ts、src/core/engine.ts、src/core/project-reset.ts |
| 9 升级与回退 | scripts/update-comfyui.mjs；docs/agents/comfyui-updates.md | prepare/runtime/store/manifest |
| 10 整体验收 | tests/comfy-electron.mjs；scripts/verify-comfy-live.mjs | docs/design/README.md、README.md、相关测试 |

新增测试沿 tasks 分布为 tests/comfy-{project,store,runtime,bridge,providers,credentials,runs,mcp,renderer,updates}.test.ts 和 tests/comfy-python/；全部 fixtures/tmp 在项目内。

## 共享接口合同

以下为拟新增接口，Task 1 建立类型，其拥有者在相应任务实现；不是现有 API。不要向 core 引入 Electron。

```ts
type ProviderProtocol = 'ark' | 'minimax-cn' | 'minimax-global' | 'vidu';
type MediaKind = 'text' | 'image' | 'video';
type ComfyActor = {kind:'user'} | {kind:'codex';nodeId:string;threadId:string;turnId:string;callId:string};
interface ProviderProfile {
  id:string; name:string; protocol:ProviderProtocol; baseUrl:string;
  revision:number; credentialRevision:number; configured:boolean;
  models:Partial<Record<MediaKind,string>>;
  videoApi?:'v1'|'v2';
}
interface ComfyObservation {
  projectId:string; instanceId:string; workflowId:string; tabId:string; revision:string;
}
interface GraphView {
  observation:ComfyObservation; workflow:Record<string,unknown>;
  subgraphPath:string[]; selectedNodeIds:string[];
}
type RunStatus = 'prepared'|'submitting'|'submission_unknown'|'queued'|'running'
  |'downloading'|'succeeded'|'failed'|'cancel_requested'|'cancelled'|'needs_reconciliation';
interface ArtifactRef {id:string;relativePath:string;mime:string;sha256:string;bytes:number}
interface RunView {
  id:string; observation:ComfyObservation; requestId:string; status:RunStatus;
  promptId?:string; assets:ArtifactRef[]; error?:{code:string;message:string};
}
interface EditReceipt {
  requestId:string; beforeVersionId:string; afterVersionId:string;
  observation:ComfyObservation;
}
interface NodeCatalog {nodes:{classType:string;inputs:Record<string,unknown>;outputs:string[]}[];missing:string[]}
interface ComfySummary {
  runtime:{status:string;instanceId?:string;versionId?:string};
  providers:ProviderProfile[];recentRuns:RunView[];
}
type ComfyReply = GraphView | EditReceipt | NodeCatalog | RunView | ComfySummary;
type ComfyRequest =
  | {type:'read_graph'}
  | {type:'apply_graph';requestId:string;expected:ComfyObservation;workflow:Record<string,unknown>}
  | {type:'restore_graph';requestId:string;expected:ComfyObservation;versionId:string}
  | {type:'inspect_nodes';nodeTypes:string[]}
  | {type:'queue_graph';requestId:string;expected:ComfyObservation}
  | {type:'read_run';runId:string}
  | {type:'stop_run';runId:string;action:'stop_waiting'|'cancel_remote'}
  | {type:'summary'};
interface ComfyHostPort {
  request(projectId:string,request:ComfyRequest,actor:ComfyActor):Promise<ComfyReply>;
  closeProject(projectId:string):Promise<void>;
}
```

按 request.type 校验 reply 对应的具体结构后再回到 engine，不能只相信 TypeScript 联合。反向 RPC 信封固定 `{type:'comfy_host_request',id,workerGeneration,projectId,request,actor}` / `{type:'comfy_host_reply',id,workerGeneration,result?,error?}`，图操作超时 30 秒；运行只返回受理回执，不让一次 RPC 等待整个视频生成。

ComfyService 在主进程创建，拥有每项目 ComfyStore、Runtime、Host 和 ProviderJobs；core worker 通过端口使用它。主进程事件发布 `mixcat:comfy-update`，renderer 按项目/实例/修订接收；get_project_context 从服务获取脱敏摘要。

存储约定：`.mixcat/comfy/state.sqlite` 记录版本、编辑回执、运行和厂商任务；`workflows/` 保存内容寻址的原生 JSON。Task 2 已落定：`runtime/<manifest.id>/` 保存独立解释器/venv/backend；`data/{input,output,temp,user,models,custom_nodes}/` 使用官方 base-directory 语义；`downloads/<manifest.id>/` 保存校验过的产物，`home/cache/tmp/logs/browser/` 仍在同一项目子树。凭据文件 `.mixcat/comfy/providers.enc.json` 由主进程原子写入，含加密字段与非敏感配置。工作流只记录连接 ID。

## Task 1: 项目类型与持久回执

**Consumes:** 当前 ProjectSummary、ProjectStore、paths 和 runtime fixture。
**Produces:** 共享合同；`createComfyTemplate(): StoredNode[]`（一个独立原生 Codex 助手）；`ComfyStore(root, projectId)` 的 `beginOperation(id,fingerprint): Receipt`、`commitEdit(id,before,after): EditReceipt`、`createRun(input): RunView`、`updateRun(id,patch): RunView`、`getRun(id)`、`listRuns(cursor,limit)`、`close()`。projectId 由可信项目上下文提供并绑定到库，不通过会执行恢复/迁移的 ProjectStore.read 在主进程旁读。

- [x] 在 tests/comfy-project.test.ts 写创建/重开 `template:'comfyui'` 测试，断言保存与恢复同一项目/助手/原生 Thread；未知类型拒绝，普通/Web 项目不获得 Comfy 工具。在 tests/comfy-store.test.ts 断言同 requestId+同 fingerprint 返回原回执，异 fingerprint 冲突；重新打开库后仍去重。
- [x] `node --import tsx --test tests/comfy-project.test.ts tests/comfy-store.test.ts` 应先因未实现失败，记录具体 RED。
- [x] 扩展 shared/types.ts 的两个 template 联合和 core/store.ts/engine.ts 的实际校验；新增 ComfyStore 事务和结构校验。工作流快照先写临时文件并校验哈希，再提交引用；模拟 fs/SQLite 失败时保留旧版本。大型历史分页，不塞进 AppSnapshot。
- [x] 本任务模板先复用现有基础工具；新 Comfy 工具的类型、校验、授权与模板 grants 由 Task 7 同时接入，避免中间提交引用尚未定义的工具。
- [x] 运行新测试、tests/project-management.test.ts、tests/project-startup.test.ts、tests/native-capabilities.test.ts 和 `npm run typecheck`，验证保存失败、跨项目读取、重开恢复。
- [x] 仅提交此任务文件，记录提交 SHA 和测试证据；独立复核后进入依赖任务。

## Task 2: 受管官方运行环境

**Consumes:** ComfyStore、paths。**Produces:** `prepareRuntime(root,manifest): Promise<PreparedRuntime>`；`ComfyRuntime.start(root,version): Promise<{instanceId,origin,pid}>`、`health()`、`stop()`；版本清单及准备脚本。

候选基线已核对来源：ComfyUI `v0.43.0` / `426f5eea52a7ece1dd599fff4cb6cd1f352ddd24`，官方前端 `1.57.4`。它是待验证候选，不是合格声明。执行时确认当前 Python 3.13.18 没有官方 Windows 二进制，改用官方 Python 3.14.10 标准 GIL x64 运行包（来源与哈希已核实）；把实际 Python、CPU torch 和全部依赖精确版本/校验值写入锁。准备脚本只安装锁定产物，不能每次跟随 latest。若候选失败，记录原因并在同任务修订兼容组合，未通过不进入后续真实运行验收。

- [x] 在 tests/comfy-runtime.test.ts 验证路径在项目内、损坏校验拒绝、安装失败可重试、并发准备单实例、端口被陌生进程占用时不接管/杀进程。验证运行 instanceId 在重启后变化。
- [x] 先运行该文件并记录 RED；测试使用项目内假下载/假进程，不下载大包。
- [x] 按官方手动安装/分发流程实现项目内候选目录与原子 ready 标记。重定向 input/output/temp/user/model/Python cache/下载目录；后端参数使用 `--cpu --disable-auto-launch --listen 127.0.0.1` 和确定的目录/端口。禁止把不同项目指向同一可写运行目录。保留 LICENSE、来源与版本清单；build.mjs 复制自有扩展/清单，不修改上游源文件。
- [x] 跑定向测试/typecheck；实际准备候选环境，记录 `/system_stats`、`/object_info`、`/extensions`、前端资源与版本，完成原生页面启动证据。只通过健康检查不能标记生成通过。
- [x] 提交清单、锁、准备程序和测试。生成的解释器、下载包及 runtime 不提交 Git。

## Task 3: 原生画布宿主、反向 RPC 与编辑事务

执行检查点：3A 完成项目级原生宿主、反向 RPC、读取/修改/恢复与持久编辑事务；3B 完成共享原生队列提交、短事务/输入保护、后端 admission 与提交回执。两者分别实现和复核，全部通过后 Task 3 才完成。Task 6 继续负责供应商节点/远端任务恢复，不重复建立队列受理路径。
3A 执行记录：`867297a` 实现，`2ef3e17` 修复宿主关闭期间的实例身份与失败停止所有权，两项审查问题复审通过。实际原生页面已验证图/子图读取、修改、明确恢复、冲突拒绝和固定 origin 重开。停止失败时保留宿主，解决阻塞后明确重试 `close`，成功后才能重开。主进程生产宿主、既有存储和反向 RPC 已接通；3B 仍待队列受理。最终新建项目验收必须明确断言初始零节点；当前最终 native artifact 证明的是已有图重开。

3B 执行记录：`669d174` 已独立复核通过。原生 Run 与 Codex 共用原生队列流程，实际输入/UUID 在唯一 POST 前持久化；两个后端入口均校验一次性 HMAC，响应丢失保留不明状态并按 UUID 查证。外层 RPC 的 `expiresAt` 贯穿等待、准备和受理；真实原生按钮、随机种子批量、进度/错误、过期与丢失响应验证通过。Tasks 3A/3B 均完成；真实 MCP 工具发布和大图 workflow_path 捕获仍由 Task 7 完成，最终工作区/新建空白图断言由 Tasks 8/10 完成。
**Consumes:** Runtime origin/instanceId、ComfyStore、共享合同。**Produces:** `ComfyHost.observe(snapshot)`、`present(projectId,generation,bounds|null)`、`request(projectId,graphRequest): Promise<GraphView|EditReceipt>`、`close(projectId)`；`ComfyService.handle(projectId,request,actor): Promise<ComfyReply>`；worker 的 ComfyHostPort 客户端。内部图序列化返回 `{workflow,prompt,sha256}`，只用于受理原生队列，不额外公开泛化脚本接口。

- [ ] tests/comfy-bridge.test.ts 检查 worker 重生/迟到响应/超时，错误 frame/origin/instance 拒绝；手动修改或标签页切换使 apply/queue 的旧 observation 冲突；子图读取返回根图和单独 subgraphPath。文件保存失败时不返回成功编辑回执。
- [ ] 运行文件得到 RED；Electron 宿主测试复用 tests/panels-electron.mjs 的项目内 harness。
- [ ] 用独立项目级 WebContentsView 复用 PanelHost 的隔离 session、尺寸与 generation 模式；原页面不使用 Mixcat 主 preload。专用 preload 只允许结构化图请求/回复，校验确切服务 origin、main frame、实例和一次性握手。JS 扩展用官方 app/registerExtension、rootGraph、原生图加载/运行接口，不暴露 arbitrary JS。新增有超时和世代失效的双向 worker/main 通道。
- [ ] 原生扩展在最终应用前再次验证 observation；保存前后快照并回读实际图。原生撤销可验证就使用，否则交付明确的版本恢复操作。MCP/普通命令维持现有约 1 MB 限制；大图由 MCP 传项目内 workflow_path，engine 有界读取并捕获字节/哈希，通过独立 RPC 传图，专用桥最大 8 MiB。超限清晰报错且不清空原图。图序列化包含异步 widget 时，在其结束后再次核对版本；记录实际提交 API 的图/seed，不拿提交后 UI 自动更新的值冒充本次输入。
- [ ] 验证宿主实际原生节点增改、撤销/恢复、原生多标签页和子图，运行定向测试/typecheck/build后提交。该任务完成前不宣称 Codex 工具已真正可用。

## Task 4: 供应商连接与加密凭据

**Consumes:** 已核实项目身份、Electron safeStorage、ProviderProfile。**Produces:** `ProviderVault(root,crypto,guard)` 的 `save(input,expectedRevision): Promise<ProviderProfile>`、`list(): ProviderProfile[]`、`remove(id,expectedRevision)`、仅主进程内部的 `withCredential(id,revision,fn)`。`DesktopApi.comfyProviders({projectId,op,input?})` 是独立可信 IPC，返回值仅有非敏感 profile。

- [ ] tests/comfy-credentials.test.ts 用显眼假 Key 检查：加密文件不含明文，list/reply/普通 AppSnapshot 不含 Key，更新/删除需要修订号；不可解密或加密服务不可用时明确失败。非可信 frame、跨项目 ID、已删除项目不能保存。改 baseUrl 未重新提交 Key 时拒绝沿用旧绑定。
- [ ] 运行该测试取得 RED；注入 crypto port 做单元测试，并增加 Electron 实际 safeStorage 保存/重开读取测试。
- [ ] 主进程使用本地类型已支持的 `isAsyncEncryptionAvailable/encryptStringAsync/decryptStringAsync`，项目内临时文件+原子替换。供应商设置支持名称、协议、完整 API 基址、模型 ID、MiniMax 视频 V1/V2 选择及 Key；保存后 Key 输入清空，界面只显示“已配置”。移除连接前检查活动任务引用。
- [ ] 保存 URL 时校验 http(s)、禁止 URL userinfo/query 中携带凭据；保留用户明确配置的路径前缀。默认外部厂商为 HTTPS，自定义 HTTP 本地服务需用户明确选择该连接；不生成任何浏览器拒绝规则。免费连接检查仅使用文档支持的无生成接口，没有这种接口则显示“已配置，待实际调用验证”，不偷偷发起收费测试。
- [ ] 跑凭据/UI 测试、typecheck，确认 Key 从未经过 generic command clone 后提交。

Task 4 执行记录：`21231ce` 实现，`77fdeac` 将凭据库校验参数改为必填，复审通过；最终 12 项凭据/原生测试及 typecheck/build 通过。两个独立 Electron 进程验证实际系统加密保存/重开与专用 IPC，Key 字段清空。现有连接更新/移除默认明确拒绝，直到 Task 6 注册持久任务引用检查；首次创建可用。这是分阶段依赖，最终接入供应商任务前必须解除。Task 8 挂载实际 `ComfyProviderSettings` Dialog。连接数读取上限与写入容量一致性问题记入最终审查修复清单。
## Task 5: 字节、MiniMax、Vidu 协议适配

**Consumes:** 主进程内部 AuthorizedConnection（profile + 临时解密的 Key）、ArtifactRef/AbortSignal。
**Produces:** `generateText(connection,input,signal)`、`generateImage(connection,input,signal): Promise<MediaResponse>`、`submitVideo(connection,input,signal): Promise<RemoteTask>`、`queryVideo(connection,task,signal): Promise<RemoteTaskState>`、`cancelVideo(connection,task,signal): Promise<CancelOutcome>`；协议范围见附录 A。

`RemoteTask={protocol:'ark-video'|'minimax-video-v1'|'minimax-video-v2'|'vidu-video',id:string}`；`RemoteTaskState={status,rawStatus,outputs?,error?}`。Raw vendor response 和临时签名 URL 只在服务内部处理，公开结果归一为本地 ArtifactRef。`CancelOutcome` 区分 cancelled / not_cancellable / record_deleted / unknown，不能统一转成成功。

- [ ] 在 tests/comfy-providers.test.ts 建项目内本地 HTTP fixtures，分别断言三家真实 method/path/body/auth。覆盖 Ark image.image 与 contents 视频路径；MiniMax 图片 base_resp/部分成功、V1 file_id 与 V2 task 嵌套；Vidu Token 及 images 数组。不同协议请求不能混发。
- [ ] 测试先 RED。每家分别覆盖 401、429、HTTP 200 业务错误、损坏响应、下载失败、响应里回显假 Key、重定向、请求取消和创建超时；不把不认识的状态当成功。
- [ ] 用 fetch 实现三个供应商模块函数（可在同一文件按协议拆小函数），不使用“任意 HTTP 模板”平台。普通创建请求超时 120 秒，查询 30 秒，产物流式下载 300 秒；图片每文件上限 64 MiB、视频 512 MiB，超限失败保留远端任务。模型参数只发送对应契约支持的字段；模型 ID 不自动替换。厂商请求不跟随携带鉴权的重定向，也不自动切换域名。
- [ ] 单图默认 n=1、非流式。Ark 支持同接口参考图；MiniMax 只承诺文档支持的人物参考。视频首版覆盖文本、单图驱动，Vidu/Ark 增加实际支持的参考图模式；音频、唇形、通用蒙版等未确认能力不加入。每模型限制使用适配表验证，模型未知时保留用户 ID 并呈现服务的规范错误，不捏造支持。
- [ ] 跑 provider fixtures/typecheck；将 fake server 协议证据与真实厂商验收分开记录，提交适配器与测试。

Task 5 执行记录：`541d122` 实现，`d99b1b5` 补齐每次调用的显式模型选择，`b9a26d4` 修正图片条目不明错误与 Vidu 实际 JSON 大小边界，独立审查/复审通过。最终 25 项供应商 HTTP fixtures 与 typecheck 通过。私有结果来源先返回，由 Task 6 持久保存后再调用有界 materialize；下载失败不能重新创建收费任务。取消保留真实确认/不可取消/记录删除/不明语义。此阶段是协议与传输验证，实际厂商账号仍待授权验收。
## Task 6: 原生厂商节点、运行账本与恢复

**Consumes:** Task 1/2/4/5，原生 bridge。
**Produces:** Comfy 扩展节点 `MixcatAPIText` → STRING、`MixcatAPIImage` → IMAGE、`MixcatAPIVideo` → VIDEO；`ComfyRuns.queue(expected,requestId,actor): Promise<RunView>`、`read(runId)`、`stop(runId,action)`、`reconcile(runId)`；本机受认证的 Python→Mixcat 请求服务。

- [ ] tests/comfy-runs.test.ts 验证意图先落库、同请求重放不重复提交、同 ID 异输入冲突；模拟厂商已接受但响应丢失，状态必须 submission_unknown 且 POST 次数不增加。已知远端 ID 后重开服务只查询；成功下载失败可重新取回，不重新生成。
- [ ] tests/comfy-python/ 使用 unittest 验证三个节点输入 schema 没有 api_key/base_url；IMAGE/STRING/VIDEO 输出符合选定原生版本。先 RED；测试数据、字节码与临时目录均放项目内。
- [ ] Python 薄节点只提交 connectionId、model、prompt、合法参考素材和非敏感参数。broker 启动 token 仅进该后端进程环境，不进 graph/prompt/extra_pnginfo；校验 token、实例、逻辑 run、节点唯一 ID 和允许的连接修订。token 是进程间认证，不宣称是恶意自定义节点的强沙箱。
- [ ] broker HTTP 合同：`GET /v1/connections` 返回本实例项目的脱敏连接/能力；`POST /v1/jobs` 输入 `{instanceId,runId,nodeId,sequence,connectionId,connectionRevision,kind,model,mode,prompt,references?,parameters?}`，返回 `{jobId,status}`；`GET /v1/jobs/{id}` 返回归一状态与本地 ArtifactRef；`POST /v1/jobs/{id}/stop` 输入 `{action}`；`POST /v1/artifacts` 仅注册本实例已写在项目 inputs 内的参考素材相对路径并返回 ArtifactRef；`GET /v1/artifacts/{id}` 返回经过身份/项目校验的字节。所有路由验证进程 token，作业路由还验证已受理 run；禁止借输入任意 filesystem path 读取项目外文件。保存连接后刷新节点选项，已删除连接保留可见错误，不替用户改选其他连接。
- [ ] main 的 ComfyRuns 写同一持久账本并使用适配器；操作键由逻辑 run + node ID +执行序号确定。新生成创建新逻辑 run，恢复保留原键；连接修订/显式再生成进入缓存指纹，避免 Comfy 重用旧厂商结果。原生“运行”按钮和 Codex queue 都进入这一受理路径；bridge/后端扩展在选定版本的实际队列入口记录同一图及 run 归属。
- [ ] 视频按 5 秒间隔查询，429 依供应商 Retry-After 退避到最多 60 秒；24 小时未终态进入 needs_reconciliation，允许后续查证，不重建任务。记录 rawStatus。完成后及时下载并校验本地文件哈希；Vidu/Ark 临时链接不能作为永久结果。
- [ ] VIDEO 使用 `io.NodeOutput(InputImpl.VideoFromFile(verifiedPath))`，接原生 SaveVideo/PreviewVideo。本机产物通过受认证资源路由或已验证项目内路径交给 Python，不发送供应商 Key/签名下载 URL。参考图按协议使用受限大小的 data URL，避免为本地文件开公网服务。
- [ ] “停止等待”停止本地等待并保留远端任务；“请求取消”依据各协议处理真实结果。Ark/MiniMax 的 DELETE 有删除终态记录语义，必须呈现这个语义及实际 action，不自动当成取消/退款。Comfy 原生 interrupt 也不能抹掉已受理厂商任务。
- [ ] 跑 runs/providers/Python tests、typecheck、真实 Comfy + fake vendor 端到端，确认原生图输出文本、图片和视频。用假 Key 搜索 workflow/prompt/history/PNG/日志/回执所有出口，零命中后提交。

Task 6 执行记录：`5a46cdd` 实现，`2736996` 修正停止请求被恢复读取阻塞的问题，复审通过。原生 STRING/IMAGE/VIDEO、真实图片后处理与 H264 解码、持久作业/引用 guard、受认证 broker、停止/恢复与元数据密钥检查已验证。原生预览到达引起的显示变化通过限定的运行比较投影处理，完整观察/编辑校验与实际提交图保持精确。broker 使用原生 promptId 解析已受理的逻辑运行。Task 7/8 消费最终输出与 recoveredAssets 的区别；关闭谓词不等于可删除持久账本。

执行衔接检查点：在 Task 7 前，将已核实的最新 main 合入本功能分支，整合其原生会话/MCP transport/worker 公共层。复核冲突解析并运行覆盖的回归、类型与构建检查；不在此重启根目录实际客户端或运行完整测试。最终整分支审查仍基于届时最新 main。
当前 main 衔接记录：`7619330` 合入已核实的 `7ea512f`；五处公共接口冲突已复核，107 项相关测试、类型/构建、真实原生 ComfyUI 与生产 IPC harness 通过。后续复用最新 NativeRuntimeHandle、共享 MCP transport 和 typed worker，不恢复旧的内联实现。当前原生 callId 是可信传输上下文中的非空 opaque 标识，未声称独立 call-ID 认证账本；项目/授权/Thread/Turn 与执行状态仍严格校验。
## Task 7: 原生 Codex 工具接入

**Consumes:** ComfyHostPort、现有 authenticated MCP gateway 和原生 session。
**Produces:** `COMFY_TOOLS` 与 `comfyToolsFor(identity)`、`invokeComfyTool(name,args,context)`；工具为 `get_comfy_workflow`、`apply_comfy_workflow`、`restore_comfy_workflow`、`inspect_comfy_nodes`、`run_comfy_workflow`、`get_comfy_run`、`stop_comfy_run`。原有 update_workflow 继续只表达 Mixcat 协作图。

- [ ] tests/comfy-mcp.test.ts 通过真实 loopback MCP 验证工具目录仅给 Comfy 项目获授权助手；普通项目伪造 ID、撤销工具、错误 Thread/Turn、缺失或畸形原生 callId、旧实例及跨项目调用拒绝。只读工具与写入工具依各自现行身份规则验证。
- [ ] 先 RED；更新 WORKFLOW_TOOLS/WorkflowTool、validateNode、toolsFor 的 schema、read-only exemptions、invokeTool、get_project_context、节点授权变更与 catalog refresh 的所有调用点。
- [ ] EngineOptions 注入 ComfyHostPort，core 只拿脱敏 summary/graph/run。写入从有效 native call 派生 actor，不接受模型自报其他项目身份。apply 支持内联小图或项目内 workflow_path；engine 在界限内捕获文件字节、解析/哈希，再通过独立反向 RPC 传图；不能把任意路径或脚本交给宿主执行。
- [ ] get_comfy_workflow 返回根图与 observation；apply/run 必须带读取时 observation 和稳定 request_id。原生会话 instructions 说明连接引用、厂商能力、提交不明时先查询、实际产物与反馈关联；不削减其原生工具/技能/插件。有效授权范围内自动执行已请求生成，超范围付费重试不自动增加。
- [ ] 运行 `node --import tsx --test tests/comfy-mcp.test.ts tests/mcp.test.ts tests/dynamic-edge-mcp.test.ts tests/native-contracts.test.ts tests/native-capabilities.test.ts tests/native-conversation.test.ts` 和 typecheck。真实 Codex 经工具修改一个原生节点并回读确认，再提交。

## Task 8: 工作区、助手交互与安全生命周期

**Consumes:** 全部前述合同。**Produces:** `ComfyWorkspace`、复用的 `SessionPane`、ComfyProviderSettings、运行/反馈入口；明确的项目删除/重开/退出/暂停行为。

- [ ] tests/comfy-renderer.test.ts 与 Electron harness 验证新建 ComfyUI 类型、准备状态、原生视图、打开/收起助手、供应商配置、选中节点/结果引用和版本恢复。切换设置/笔记/项目列表/Issue/Document 时，即使 selected project 未变，也必须隐藏原生 view；旧 layout 消息不得复活它。
- [ ] 先 RED。将 Workbench 现有会话子树提取为 `SessionPane({snapshot,execute,nodeId,obscured,onClose})`，保留其配置、原生请求、人工问题、历史、附件、引用和草稿。Workbench 和 ComfyWorkspace 共用，不再复制一份输入框。普通工作流的选择/草稿/暂停回归测试随提取一起完成。
- [ ] App 的创建入口增加 ComfyUI 选项；ProjectWorkspace 按保存的 template 路由到 ComfyWorkspace。主要助手固定一个现有 StoredNode；对话可收起，原生画布占剩余主区域。运行记录分页展示必要状态及实际文件引用，选择某次输出进入同一会话反馈；不用新的自定义图重画 ComfyUI。
- [ ] delete_project 检查安装/编辑/提交/运行未决项；重开保持项目 ID、Thread、连接引用、图及任务账本。reset_workflow 对 Comfy 项目明确拒绝并提示其语义属于协作图；维护脚本 project-reset.ts 检测 Comfy 数据后拒绝通用清空，不能默默删凭据/产物。
- [ ] 退出时先完成持久化与受管服务的安全停止。ComfyService 若有不能安全结束的操作，closeProject 返回明确失败，main 的 before-quit 必须保留窗口和 worker，不能沿现有 catch 后无条件 kill。用户已停止本地等待且远端任务 ID/恢复信息已落盘时，可按明确恢复策略退出；重开查原任务，不能自动重提交整图。异常 worker/main/backend 死亡后进入 needs_reconciliation，不伪称流程完成。
- [ ] 登录/外部链接若被实际使用，采用独立受控登录窗口/返回流程，不沿用普通 PanelHost 把登录 URL 导入画布的 popup 行为。BYOK 主流程直接使用供应商设置；不强制用户登录 Comfy 账号。
- [ ] 跑 UI、项目生命周期、panels、native 会话定向回归、typecheck/build。实际 Electron 检查原生菜单、文件导入、视频预览、键盘、草稿和窗口缩放后提交。

## Task 9: 上游版本更新、回归与回退

**Consumes:** Runtime manifest、ComfyStore、已有升级验证 fixtures。**Produces:** `prepareCandidate(root,manifest)`、`activateVersion(root,versionId)`、`rollbackVersion(root,versionId)`，以及维护文档/脚本；运行组合始终由项目实际版本记录选择。

- [ ] tests/comfy-updates.test.ts 模拟新包缺失、错误校验、前后端不匹配、扩展加载失败、安装/切换途中故障、活动任务及回退。断言原环境仍可启动，实际版本只有在完整验证后原子改变。
- [ ] 先 RED。update 脚本读取明确目标 tag/SHA，更新后端对应前端包和完整依赖锁；不跟随 master/nightly，不自动在启动时更新。版本变更输出审查清单和差异，正常走单独 PR。
- [ ] 候选在项目内独立目录、端口和用户数据副本运行，使用同一项目内的既有模型资源；执行原生页面、bridge、子图/标签页、三家 fake provider、视频类型及恢复测试。先验证数据兼容，再允许无活动任务时切换。
- [ ] 回退恢复旧完整运行组合及兼容的升级前用户数据；升级后生成的文件/工作流保留独立记录，不被覆盖或清理。回退失败给出具体原因；保留旧目录直到验证完成。
- [ ] 跑更新测试/typecheck；用两个实际官方版本完成一次候选验证和回退演练，记录各自 manifest、页面/节点/工作流恢复证据后提交。不能把 fake process 测试称为真实上游升级成功。

## Task 10: 全链路验收、审查与正式客户端交付

**Consumes:** 已通过独立复核的 Tasks 1–9。**Produces:** 完整证据、PR、合并和正式运行版本核实。

- [ ] `node --import tsx --test tests/comfy-*.test.ts`、项目内 Python 环境的 `python -m unittest discover -s tests/comfy-python`、`npm run typecheck`、`npm run build`，然后运行一次 `npm test`。失败按基线/本改动调查，实际修复引起变化时再运行受影响检查。
- [ ] `node tests/comfy-electron.mjs` 使用真正固定的官方 ComfyUI 前后端和内置扩展、fake vendor 验证完整 native→Codex→API→结果链路；证明原生画布来源/版本、实际图内容和真实任务身份，不只截屏空页面。真实 native Codex 经工具读/改/运行和用户手动改图回流分别记录。
- [ ] `node scripts/verify-comfy-live.mjs --project <已核实项目> --provider <连接ID>` 默认只读检查配置；只有已授权的验收模式才能真实生成。对字节图片/参考图、MiniMax 图片/视频、Vidu 视频逐项核对实际请求、状态、产物与反馈；测试报告不得包含 Key 或签名 URL。没有账号/额度/调用授权时，将该厂商标为未完成真实验收，不能把 mock 结果写成厂商可用，也不能为完成表格擅自消费。
- [ ] 阅读当前 mattpocock-skills:code-review，按固定基线并行做仓库规范与 Issue 验收两轴审查；修复后复验。使用 pr 技能模板，正文写 `Closes #155`，附真实验证与必要限制，创建后附加当前 chat。核实当前 head 的 CI/审查条件再合并，不绕过失败检查。
- [ ] 合并后同步实际 main，按 scripts/dev.ps1、build.mjs、start.mjs 保护活动任务并重建重启正式 Mixcat；核对进程路径、启动时间、desktop ready 日志及内嵌 Comfy 版本/运行环境。确认 Issue 状态，清理已合并临时分支。
- [ ] 更新设计索引、README 和升级文档；明确实现/自动化验证/真实厂商验证/正式客户端运行各自证据。未经满足验收不能将任务或 Issue 提前完成。

## 附录 A：首批供应商协议表

下列为 2026-10-29 核对官方资料得到的请求契约，用于 fixture 和实现。默认域名可由用户配置覆盖；路径拼接要保留选定协议前缀、不得重复添加 v1/v2/api/v3。账号和模型权限由真实调用验证。

| Profile / 能力 | 默认基址与鉴权 | 创建/查询/结果 |
| --- | --- | --- |
| Ark text | https://ark.cn-beijing.volces.com/api/v3；Bearer | POST /chat/completions，标准明确的聊天消息形状 |
| Ark image | 同上 | POST /images/generations；model,prompt,stream:false；参考图为 image；data[].url 或 b64_json，逐项 error 单独处理 |
| Ark video | 同上 | POST /contents/generations/tasks → id；GET 同路径/{id} → queued/running/cancelled/succeeded/failed/expired；成功 content.video_url；DELETE 仅 queued 可取消，终态可能删记录 |
| MiniMax text | 国内 https://api.minimax.cn，国际 https://api.minimax.io；Bearer | POST /v1/chat/completions；国内国际连接与 Key 分开 |
| MiniMax image | 同上 | POST /v1/image_generation；response_format=url/base64；data.image_urls/image_base64，解析 base_resp 和 metadata 成败计数；subject_reference 只承诺 character |
| MiniMax video V2 | 同上；连接默认 V2 | POST /v2/video_generation → task_id；GET /v2/query/video_generation/{id} → task.status/content.url/error；DELETE /v2/video_generation/{id} → action cancelled/deleted，running 不可取消 |
| MiniMax video V1 | 同上；显式选择旧协议 | POST /v1/video_generation → task_id；GET /v1/query/video_generation?task_id= → status/file_id/base_resp；GET /v1/files/retrieve?file_id= → file.download_url。状态 Preparing/Queueing/Processing/Success/Fail，不能复用 V2 decoder |
| Vidu video | https://api.vidu.com；Token | POST /ent/v2/text2video、/img2video、/reference2video；model,prompt,images[] 等按模式；返回 task_id；GET /ent/v2/tasks/{id}/creations → created/queueing/processing/success/failed、creations[].url；POST /ent/v2/tasks/{id}/cancel body {id}，失败或不可取消须保留实际状态 |

模型 ID、时长、比例、分辨率、引用数量按所用模型契约校验。Vidu 的 images 使用数组，不能照抄某些生成示例中的 scalar；其 payload 只当回传关联值，不当供应商幂等保证。Vidu/Ark 产物链接文档标注 24 小时有效；完成后取回本地，过期则通过原任务重新查询。MiniMax V2 查询的 task 是嵌套对象，不能误当 Ark 平铺结构。

### 官方来源

- Ark：[图片](https://console.volcengine.com/ark/region:cn-beijing/docs/image-generation-api)、[视频创建](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh)、[视频查询](https://docs.volcengine.com/docs/ark/get-video-generation-task-api?lang=zh)、[取消/删除](https://docs.volcengine.com/docs/ark/cancel-or-delete-video-generation-tasks-api)。
- MiniMax：[图片](https://platform.minimax.cn/docs/api-reference/image-generation-t2i)、[人物参考](https://platform.minimax.cn/docs/api-reference/image-generation-i2i)、[V2 创建](https://platform.minimax.cn/docs/api-reference/video-generation-v2-create)、[V2 查询](https://platform.minimax.cn/docs/api-reference/video-generation-v2-query)、[V2 删除](https://platform.minimax.cn/docs/api-reference/video-generation-v2-delete)、[V1 查询](https://platform.minimax.cn/docs/api-reference/video-generation-query)。
- Vidu：[文生视频](https://platform.vidu.com/docs/api-reference/video-models/vidu-q3/text-to-video)、[图生视频](https://platform.vidu.com/docs/api-reference/video-models/vidu-q3/image-to-video)、[任务查询](https://platform.vidu.com/docs/api-reference/task-management/task-detail)、[取消](https://platform.vidu.com/docs/api-reference/task-management/cancel-task)。
- 原生 VIDEO：[v0.43.0 VideoFromFile](https://github.com/Comfy-Org/ComfyUI/blob/v0.43.0/comfy_api/latest/_input_impl/video_types.py)、[原生保存/预览节点](https://github.com/Comfy-Org/ComfyUI/blob/v0.43.0/comfy_extras/nodes_video.py)。
- 凭据：[Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)；本地 Electron 类型已核对异步接口存在。

## 执行顺序与自审

依赖顺序：1 → 2 → 3；4 可在 1 后独立实现，5 在 4 后实现；6 需要 1–5；7 接上 3/6；8 完成真实工作区与生命周期；9 完成升级；10 总验收。建议逐任务由独立实现者完成并复核，再做整分支双轴审查；同文件的整合按上述顺序，避免主进程/engine 同时修改冲突。

自审结果：

- 设计第 1–4 节由 Tasks 1–3/8 覆盖；第 5 节由 3/7 覆盖；第 6 节由 5–8 覆盖；第 7–8 节由 2/4/6/8/10 覆盖；第 11 节由 4–6 覆盖；第 12 节由 9 覆盖。14 条验收条件都有任务和验证层级。
- 五项 Review Focus 分别有 observation 竞态、提交不明、密钥出口、视图 generation 和退出/升级故障测试；没有用 UI 可见替代原生/厂商/恢复验证。
- 对照当前源码补齐了 store 类型校验、无反向 RPC、command clone、主进程无条件 kill、project-reset 清空数据和 MCP 体积限制这些实际边界。
- 统一了 ComfyHostPort/ComfyReply、graph observation、RunView、供应商 profile 和 broker 路由；大图使用有界项目文件捕获，不绕过普通命令限制。
- 上游基线是待验证候选；现成节点调查不能算已复用，fake provider 不能算真实账户/生成通过。计划包含必要 RED/GREEN、实际 Electron、真实 Codex、供应商授权验证与完整测试。
- 按前述依赖顺序逐任务独立实现/复核；用户已授权进入执行，具体完成与测试证据记录在本计划独立 SDD 台账。
