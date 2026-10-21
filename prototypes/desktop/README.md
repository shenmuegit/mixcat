# Mixcat 桌面客户端原型

归档日期：2026-10-20（UTC+08:00）。

这里保存用于验证会话节点、交接、回流、原生历史、节点控制和工作面板的桌面原型。它不是正式客户端实现。源码已恢复到本次架构审计修订前的原型状态；审计后的改进保留为设计要求，没有合入此原型。

## 内容

- `src/`：Electron 主进程、业务后台、Codex 接入和 React 原型界面。
- `tests/`：原型阶段的既有测试。
- `scripts/`：原型安装、构建和启动脚本。
- `package.json`、`package-lock.json`、`.npmrc`：依赖及安装配置。
- `dist/`：此前原型验证时保存的构建快照。
- [归档清单](archive-manifest.json)：归档文件及校验摘要。

## 后续需要运行原型时

在本目录打开 PowerShell。依赖仍要求 Windows、Node.js 24+ 和可用的 Codex；工作目录必须位于非 C 盘。首次在归档目录运行前安装该目录自己的依赖：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\dev.ps1 install
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\dev.ps1 start
```

归档操作没有执行这些命令，也没有重新启动客户端。本目录不包含原工作台的项目索引、真实项目数据库或登录材料；旧数据仍在原位，不能将复制原生会话目录当作受支持的数据迁移方式。

## 设计与原型的关系

以 [客户端功能设计](../../docs/design/2026-10-19-mixcat-client-functional-design.md) 和 [架构修订](../../docs/design/2026-10-20-architecture-hardening.md) 作为后续实现依据。原型中的接口、存储方式、审批交互和可靠性边界不自动成为正式架构。

本原型保留原有能力和已知限制；架构文档中的提交一致性、连接生命周期、控制响应、来源分类、增量同步和宿主适配要求仍需按后续开发任务实现与验收。
