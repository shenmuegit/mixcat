# ComfyUI 完整运行组合维护

本维护说明落实 [ComfyUI 项目设计](2026-10-29-comfyui-project.md)第 12 节的开发者升级流程；整体验收仍以 Issue #155 的交付记录为准。

项目的 `runtime_records.selection` 选择实际组合和数据代。组合身份绑定完整运行 manifest、四个 Mixcat 扩展文件的 SHA-256 和桥协议。随客户端发布的 manifest 只用于首次建立推荐组合；已经选择的项目继续使用不可变组合。升级与回退都通过现有 `ComfyHost`、`ComfyRuntime` 和 `ComfyStore`。

目标必须是明确的官方 tag 和完整提交 SHA。将完整目标 manifest 放进 Mixcat 仓库后，用项目 Node 24+ 执行：

```powershell
node --import tsx scripts/comfy-update-review.ts <Mixcat仓库根目录> <目标清单路径> v0.43.0 426f5eea52a7ece1dd599fff4cb6cd1f352ddd24
```

脚本核对 tag、SHA、前端包及完整依赖锁，在项目内 `.runtime/comfy-update-review/<id>/` 输出完整目标 `runtime-manifest.json`、`requirements.lock` 和 `review.json`。审查清单列出官方发行说明、依赖差异、原生兼容验证和回退证据；变更推荐组合时按单独 Issue/PR 流程审查。不得在启动时跟随 master/nightly 或就地更新 pip 包。

维护入口是桌面宿主的 `prepareCandidate(root, manifest)`、`activateVersion(root, versionId)` 和 `rollbackVersion(root, versionId)`。`versionId` 是完整组合 SHA-256，区别于单独 Python/后端 manifest ID。维护期间宿主阻止新的用户/Codex/原生提交，核对活动任务、受理不明任务和未完成编辑，完成全部原生标签页草稿与浏览器状态检查后停止所属后端。候选在独立端口、数据、浏览器及缓存目录运行；模型使用项目内原生 `--models-directory` 资源。

这些方法目前是拥有项目的 Electron 主进程内部 API；已有 `ComfyHost` 必须已通过 `observe(snapshot)` 绑定该项目。调用顺序为：

```ts
const candidate = await host.prepareCandidate(projectRoot, reviewedManifest);
await host.activateVersion(projectRoot, candidate.selection.versionId);
// oldVersionId 来自操作前项目的实际完整组合记录。
await host.rollbackVersion(projectRoot, oldVersionId);
```

当前可执行的端到端入口是 `./scripts/dev.ps1 test tests/comfy-updates-electron.ts`：它建立独立宿主并在仓库内 `u9/` 演练项目执行上述顺序。它不操作任意用户项目。当前尚无面向任意实际项目的维护 CLI 或桌面 IPC 命令；前面的审查脚本只生成可审查文件，不激活或回退项目。要提供日常操作入口，仍需将这些内部 API 接入一个明确的维护命令，复用同一租约和身份校验。

候选先通过真实后端和前端、桥握手、自定义节点及 VIDEO 类型检查，并比较全部恢复的标签页、未保存草稿、活动子图与选区。资格与源数据、原生工作区和项目运行账本绑定；准备后继续编辑需要重新准备。激活先保存切换意图，启动并验证目标，再事务性发布实际选择。失败保留原选择并尝试重新启动旧组合；无法确认停止时保留所有权与具体恢复原因，不能启动竞争实例。

回退将兼容的升级前检查点复制到新的可写数据代，再执行同样的原生启动/兼容验证。升级后的数据代、输出、工作流版本、内容寻址成果和供应商账本继续保留；不会把共享助手会话、附件草稿或远端任务记录回退。`state.sqlite`、`workflows/` 和 `artifacts/` 位于项目公共层，不属于原生数据代。

崩溃后的启动仍需项目生命周期租约。只有实例锁中记录的宿主 PID、后端 PID 均已消失，并确认原本回环端口没有监听者，才将该锁移入项目日志并启动选择的组合。身份未知、PID 存活、端口仍响应或停止失败都必须先解决具体故障；禁止接管或终止陌生进程。修复后重试安全关闭/启动，不能删除供应商不确定性来通过维护门槛。

真实双版本回归使用 `tests/comfy-updates-electron.ts`，限于项目内独立演练数据。准备缓存只证明安装完成；正式资格仍需要实际原生页面、三个本地 fake provider、VIDEO 和保留任务恢复证据。演练普通复制的 venv 仍依赖保留的原解释器路径，不能被视为可独立搬迁的运行环境。
