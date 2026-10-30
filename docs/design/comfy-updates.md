# ComfyUI 完整运行组合维护

本维护说明落实 [ComfyUI 项目设计](2026-10-29-comfyui-project.md)第 12 节的开发者升级流程；整体验收仍以 Issue #155 的交付记录为准。

项目的 `runtime_records.selection` 选择实际组合和数据代。组合身份绑定完整运行 manifest、四个 Mixcat 扩展文件的 SHA-256 和桥协议。随客户端发布的 manifest 只用于首次建立推荐组合；已经选择的项目继续使用不可变组合。升级与回退都通过现有 `ComfyHost`、`ComfyRuntime` 和 `ComfyStore`。

目标必须是明确的官方 tag 和完整提交 SHA。将完整目标 manifest 放进 Mixcat 仓库后，用项目 Node 24+ 执行：

```powershell
node --import tsx scripts/comfy-update-review.ts <Mixcat仓库根目录> <目标清单路径> v0.43.0 426f5eea52a7ece1dd599fff4cb6cd1f352ddd24
```

脚本核对 tag、SHA、前端包及完整依赖锁，在项目内 `.runtime/comfy-update-review/<id>/` 输出完整目标 `runtime-manifest.json`、`requirements.lock` 和 `review.json`。审查清单列出官方发行说明、依赖差异、原生兼容验证和回退证据；变更推荐组合时按单独 Issue/PR 流程审查。不得在启动时跟随 master/nightly 或就地更新 pip 包。

维护入口是桌面宿主的 `prepareCandidate(root, manifest)`、`activateVersion(root, versionId)` 和 `rollbackVersion(root, versionId)`。`versionId` 是完整组合 SHA-256，区别于单独 Python/后端 manifest ID。维护期间宿主阻止新的用户/Codex/原生提交，核对活动任务、受理不明任务和未完成编辑，完成全部原生标签页草稿与浏览器状态检查后停止所属后端。候选在独立端口、数据、浏览器及缓存目录运行；模型使用项目内原生 `--models-directory` 资源。仅原 `.mixcat/comfy/data/models` 是声明的共享资源，不复制到检查点，也不重复扫描其权重内容作为用户数据指纹；其他层级的 `models` 目录仍完整保存并参与变更检查。启动时仍核对共享模型树的路径边界。

开发者操作入口是 `scripts/comfy-maintain.mjs`，通过已构建的独立 Electron 维护入口调用上述同一 Host。它从现有 `ProjectStore` 读取项目身份、模板和活动状态，取得现有项目写入所有权及 Comfy 生命周期租约。退出持有目标项目的 Mixcat 工作台后执行；仅关闭窗口内的原生画布并不一定释放项目写入所有权。活动、排队、受理不明、待核对编辑和未验证版本均明确拒绝，不接管其他进程。

先安装项目的正常依赖并完成构建，使用 Node 24+。目标必须是已存在的非 C 盘 ComfyUI 项目；命令不会创建项目或启动 Codex 引擎/账号。清单应先按上面的审查流程确认，命令行 tag/SHA 必须与其完全一致：

```powershell
./scripts/dev.ps1 build
$comfyProject = "G:\projects\my-comfy-project"
$reviewedManifest = "G:\code\mixcat\.runtime\comfy-update-review\comfy043-py31410-cpu1\runtime-manifest.json"
$comfyCandidate = node scripts/comfy-maintain.mjs $comfyProject prepare $reviewedManifest v0.43.0 426f5eea52a7ece1dd599fff4cb6cd1f352ddd24 | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw "候选准备失败" }
node scripts/comfy-maintain.mjs $comfyProject activate $comfyCandidate.versionId
node scripts/comfy-maintain.mjs $comfyProject rollback $comfyCandidate.sourceVersionId
```

普通冷启动使用当前原生浏览器数据，不用旧准备快照覆盖它。`activate` 表示把指定的完整组合应用到项目当前工作：它先以该已审查目标的 manifest 对当前状态重新做本地兼容验证，确认新结果仍是同一个完整 ID，再在同一宿主生命周期中激活，并输出 `requalified: true`。准备后发生的普通画布编辑和用户文件变化因此进入新的兼容检查点；重新验证之后的并发变更仍由核心严格拒绝。若当前构建的适配层与请求 ID 不匹配，应使用匹配构建，或先 prepare/审查新组合；不会静默切换目标。当前浏览器数据代缺失或不能验证时明确拒绝。

每条命令在安全关闭自己的原生宿主后输出一行 JSON；`prepare` 输出候选完整 `versionId` 和原组合 `sourceVersionId`，供后续精确激活/回退使用。它只接受完整 SHA-256 标识，不接受 `latest` 或单独的后端 tag 代替实际组合。目标项目的会话、历史和凭据文件继续由原存储持有；维护读取不执行文档/历史迁移恢复，不导入测试连接，不解密或调用供应商凭据，也不恢复供应商轮询。开发者的 fake-provider 发布回归应先完成，再使用此命令维护实际项目。

从子进程启动时起，HOME、APPDATA、临时目录、缓存、Electron profile/crash dumps 和维护日志均在目标项目 `.mixcat/comfy/maintenance/` 内。原生 Comfy 数据/浏览器仍选择该项目的受管数据代。成功/错误记录写入该目录的 `logs/operations.jsonl`，结果不包含工作流内容、浏览器存储或凭据。若安全清理失败，维护宿主继续持有项目所有权并显示原因；修复存储/运行故障后在同一终端输入 `retry`，成功完成安全清理后才退出。不要直接启动内部 Electron 入口绕过 Node 启动器的环境配置。

实际命令回归为 `./scripts/dev.ps1 test tests/comfy-maintenance-electron.ts`：在已持久化的真实 `ProjectStore` 演练项目上执行三条独立命令，包含 prepare 后普通原生编辑、保存新用户文件再关闭、activate 保留这些当前改动、rollback 恢复其兼容检查点并保留升级后新文件，并核对历史、凭据和账本字节未变及所有权释放。完整双版本/provider 发布回归仍由 `tests/comfy-updates-electron.ts` 提供，两个测试都限定于仓库内拥有的 `u9/` 项目。

候选先通过真实后端和前端、桥握手、自定义节点及 VIDEO 类型检查，并比较全部恢复的标签页、未保存草稿、活动子图与选区。桥的首个 afterLoadGraph 早于上游标签页恢复结束，因此宿主在握手后有界等待上游工作区初始化完成。捕获/恢复时，只有当前原生活动标签页与 OpenPaths 一致，才将持久活动指针写成这个已验证的当前标签页；不从指纹中忽略 ActivePath 不一致。DraftIndex 的缓存 LRU 触碰顺序属于运行记录，实际标签页次序、草稿条目/内容及保存状态仍严格绑定。资格与源数据、原生工作区和项目运行账本绑定；准备后继续编辑需要重新准备。激活先保存切换意图，启动并验证目标，再事务性发布实际选择。失败保留原选择并尝试重新启动旧组合；无法确认停止时保留所有权与具体恢复原因，不能启动竞争实例。

回退将兼容的升级前检查点复制到新的可写数据代，再执行同样的原生启动/兼容验证。升级后的数据代、输出、工作流版本、内容寻址成果和供应商账本继续保留；不会把共享助手会话、附件草稿或远端任务记录回退。`state.sqlite`、`workflows/` 和 `artifacts/` 位于项目公共层，不属于原生数据代。

崩溃后的启动仍需项目生命周期租约。只有实例锁中记录的宿主 PID、后端 PID 均已消失，并确认原本回环端口没有监听者，才将该锁移入项目日志并启动选择的组合。身份未知、PID 存活、端口仍响应或停止失败都必须先解决具体故障；禁止接管或终止陌生进程。修复后重试安全关闭/启动，不能删除供应商不确定性来通过维护门槛。

真实双版本回归使用 `tests/comfy-updates-electron.ts`，限于项目内独立演练数据。准备缓存只证明安装完成；正式资格仍需要实际原生页面、三个本地 fake provider、VIDEO 和保留任务恢复证据。演练普通复制的 venv 仍依赖保留的原解释器路径，不能被视为可独立搬迁的运行环境。

## 配置检查与验收边界

`node scripts/verify-comfy-live.mjs --project PROJECT --provider CONNECTION_ID` 只读现有项目身份与供应商配置元数据，输出连接修订、协议、模型与 `liveValidated: false`；不会解密 Key、请求供应商或创建生成任务。缺少模型返回 `missing_models`，缺少连接或试图传入生成开关会明确失败。真实厂商调用应在用户明确授权的原生工作流中进行，以实际 runId、远端状态、本地原生产物和反馈验收；本地假供应商证据不能替代账号权限、额度或质量验证。

`scripts/verify-comfy-native-live.ts` 的验收夹具使用真实生产 worker、SharedAccount 和原生 Codex 工具，从新项目空图创建参考图生成流程，再验证同线程新轮次读取手动控件改动。假供应商仅接受两次 image 创建，最终结果需由原生 ImageScale/SaveImage 产生并验证尺寸与 SHA-256。原生控件回调与真正 Windows 键盘输入分别记录，结果中的 `modelPassed`、`keyboardPassed`、`nativeVideoPassed` 是独立证据。

Windows 深目录下的 Python 依赖普通文件读取可能失败。运行启动与准备命令遇到包含超长绝对路径的 `FileNotFoundError [Errno 2]` 时，提示路径长度是可能原因，并指向项目日志。请在所属项目内选择更短目录、在最终位置重新准备；不能通过复制 venv 声称可独立搬迁，也不能据此假定所有 ENOENT 都源于路径长度。任意深目录兼容性尚未得到验证。
