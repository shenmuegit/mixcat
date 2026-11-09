<div align="center">
  <h1>Mixcat</h1>
  <h3>让 Codex 会话在同一张画布上协作。</h3>
  <p>面向项目协作、资料整理与信息采集的本地桌面工作台。</p>
  <p>
    <a href="#快速开始"><img src="https://img.shields.io/badge/Windows-Desktop-0078D4?style=flat-square" alt="Windows 桌面客户端"></a>
    <a href="package.json"><img src="https://img.shields.io/badge/Node.js-%3E%3D24-417E38?style=flat-square&amp;logo=nodedotjs&amp;logoColor=white" alt="Node.js 24 或更高版本"></a>
    <a href="https://github.com/openai/codex"><img src="https://img.shields.io/badge/Codex-app--server-20271C?style=flat-square" alt="基于 Codex app-server"></a>
  </p>
  <p>
    <a href="#快速开始">快速开始</a> ·
    <a href="#为什么使用-mixcat">功能</a> ·
    <a href="docs/README.md">文档</a> ·
    <a href="https://github.com/shenmuegit/mixcat/issues">问题反馈</a>
  </p>
</div>

<br>

Mixcat 是一个独立的 Codex 桌面工作台。把项目组织成卡片，把会话连接成工作流：每个节点保留自己的原生 Codex 会话、模型配置和历史，Agent 通过 MCP 交接工作、回复与回流，你也可以随时直接与任意节点对话。

> [!NOTE]
> 当前为 **Windows 源码运行的开发预览版**，界面以中文为主。安装与启动方式见下方；具体实现和历史验收证据见[交付记录](docs/design/2026-10-20-delivery-status.md)。

## 快速开始

准备好以下环境：

- Windows、PowerShell 与 Git。
- **Node.js 24+**，并安装 npm。
- 支持 `app-server` 的 Codex CLI，以及可用的 Codex 账号。
- 仓库与项目目录放在 **非 C 盘**，使用普通目录；启动器不接受符号链接或目录联接，项目目录须已存在。

在非 C 盘的目录中执行：

```powershell
git clone https://github.com/shenmuegit/mixcat.git
cd mixcat
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev.ps1 install
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev.ps1 start
```

`start` 会构建并打开 Electron 客户端。启动器自动查找 Node.js 和 `codex.exe`；需要指定可执行文件时，设置 `MIXCAT_NODE`、`MIXCAT_CODEX` 为对应的绝对路径。

1. 打开左下角 **设置**，确认 Codex 已登录；需要登录时点击 **登录 Codex**。
2. 点击 **新建项目**，选择已有的项目目录与工作流模板，按提示准备所需能力。
3. 打开项目，选择一个节点，发送第一条消息。后续可编辑节点、模型、技能、插件与交接条件。

关闭窗口后，Mixcat 留在系统托盘运行；从托盘选择退出才会结束应用。Codex 原生协议和登录接口可能随 CLI 版本变化，兼容性说明见[账号与会话文档](docs/design/2026-10-20-settings-and-node-deletion.md)。

## 为什么使用 Mixcat？

- **把协作关系画出来。** 在画布上添加节点、编辑连线和交接条件。节点的出边生成对应 MCP 工具，由 Agent 根据条件选择并投递工作。
- **让上下文留在项目里。** 每个节点使用独立的原生 Codex 会话，在所属项目目录工作；模型、技能和插件可按节点配置，历史可继续查看。
- **把讨论与成果放在一起。** 项目内的 Issue 支持拆分、讨论和派发；Markdown 文档支持文件树阅读与编辑。输入 `@` 引用项目内容，并查看关联与反向链接。
- **在需要时由你核对。** 人工核对包保留版本、正文和选定附件；用户批准或要求修改，依赖该版本的工作按核对结果继续。
- **直接参与，也能暂停。** 向任意节点发送消息或附件，查看原生审批和输入请求；暂停、恢复单个节点或整个项目。
- **整理项目之外的想法。** 独立笔记支持 Markdown、脑图与关联；独立画布使用 Excalidraw 编辑，并在本地保存。

## 内置工作流

新建项目时可选择四种模板，创建后仍可调整节点与连线。

| 模板 | 节点数 | 分工 |
| --- | ---: | --- |
| **调研分析** | 4 | 研究协调、资料研究、独立核查、报告汇总 |
| **内容创作** | 3 | 策划编辑、内容撰写、事实核查 |
| **缺陷修复** | 3 | 复现诊断、修复实现、回归验证 |
| **Web 产品团队** | 8 | 产品协调、需求、UI/UX、设计测试、架构、前端、后端、实现测试 |

模板能力准备按当前模板推荐插件与技能，并展示已有能力的覆盖或跳过选项。插件使用作者的 Codex 原生安装流程；外部账号、工具依赖及 hooks 信任仍按各自要求配置。详见[工作流模板](docs/design/2026-11-03-builtin-workflow-templates.md)与[模板能力准备](docs/design/2026-11-06-template-capability-setup.md)。

## 个人信息流

在侧边栏打开 **信息流 → 新建采集**，通过对话明确关注的主题、目标与执行计划。每个采集保留独立会话，可从结果卡片查看完整正文，继续追问或调整目标。

支持带时区的每日、每周计划，也可不设周期。定时采集在 Mixcat 或托盘进程运行时执行；重新打开后，会把错过的执行合并为补跑工作。使用方式见[信息流文档](docs/design/2026-10-29-personal-information-feed.md)。

## 开发

客户端使用 **Electron、React、TypeScript 和 React Flow**，工作流进程对接 Codex `app-server`、本地持久化与 MCP。使用现有启动器运行检查，临时文件、缓存和构建数据会留在仓库内：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev.ps1 test
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev.ps1 typecheck
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev.ps1 build
```

测试覆盖工作流、消息交接、持久化、账号与原生协议。完整功能及验收范围见[设计文档索引](docs/design/README.md)。

## 本地数据

| 位置 | 内容 |
| --- | --- |
| 仓库内 `.runtime/client/` | 工作台项目索引、桌面配置、账号数据、信息流、缓存与日志 |
| 仓库内 `.mixcat/notes/` | 独立笔记 |
| 仓库内 `.mixcat/canvases/` | 独立画布与素材 |
| 各项目目录内 `.mixcat/` | 项目状态、会话历史、附件与原生 Codex 会话数据 |

这些目录可能包含登录凭据和私有项目内容，备份时保留所需数据，公开提交或分享源码时排除。

## 文档与反馈

- [文档目录](docs/README.md) — 使用、设计与实施记录的入口。
- [设计文档](docs/design/README.md) — 功能、架构和专项设计。
- [交付与验收记录](docs/design/2026-10-20-delivery-status.md) — 实现范围、验证证据及限制。
- [节点协作](docs/design/2026-10-24-dynamic-edge-mcp.md) — 条件边与 MCP 工具的工作方式。
- [ComfyUI 项目](docs/design/comfy-updates.md) — 已有 ComfyUI 项目的运行组合与维护说明。
- [问题反馈与功能建议](https://github.com/shenmuegit/mixcat/issues) — 提交问题、描述使用场景或跟进已有讨论。
