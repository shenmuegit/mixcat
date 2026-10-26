# 项目管理与工作流接入实施计划

> **For agentic workers:** Use superpowers:executing-plans with mattpocock-skills:implement and tdd; perform the repository's two parallel Standards/Spec reviews before PR delivery. Steps use checkbox syntax for tracking.

**Goal:** 用户与节点共同维护树形 Todo、内部 Issue 和真实 Markdown 文档，并通过统一引用和现有工作流追踪工作。

**Architecture:** 在项目状态中增加独立的管理数据和持久回执；以同一个领域操作供客户端命令及 MCP 调用。文档正文保持文件权威，通过恢复日志协调文件与状态提交。现有条件边和人工核对只增加明确的工作关联。

**Tech Stack:** Node.js 24+、TypeScript、SQLite、Electron、React；使用 Marked 的 Markdown token tree 解析引用及安全渲染。

**Spec:** [项目管理设计](../design/2026-10-26-project-management-design.md)

## Global Constraints

- 工作树、临时文件、缓存、日志和验收产物全部位于 `G:\code\mixcat` 项目内部；各受管项目数据仍在其所属目录内。
- Issue #13；分支 `codex/issue-13-project-management`。原始 main 基线 `71d68101134fea8d7141e5ee6e050b652ca611b1`；前置已有改动独立由 Issue #14 交付，后续审查基线使用其已合并 main。
- 用户已授权现有测试数据重置，只保留当前节点定义、条件边和布局；不迁移历史，不清空源码或 Git 数据。
- 验收使用当前项目／本次开发工作树及已有节点图，不额外搭建独立测试工程。
- 采用原生命令、MCP 与 Electron 交互边界测试；业务状态不由执行结束或引用自动改变。
- 状态字段、节点权限、文档冲突及核对行为遵循规格。角色名称不用于硬编码写入权限。

## Review Focus

- 跨节点／重启后重试同一写入：只能有一次效果，改变内容复用编号必须失败（任务 1、3）。
- 管理正文中的代码示例、原始 HTML、伪造项目链接：不能变成错误反链或执行脚本（任务 1、4）。
- 文档写入中断及外部编辑：保存不能覆盖新版本，恢复不能重放旧内容覆盖外部更新（任务 2）。
- 清除工作关联、回复继承、材料归档后重试：旧回执和执行依据必须保持可解释（任务 3）。
- 切换项目／面板时的草稿及延迟回复：不能丢草稿、串项目或让原生面板覆盖管理视图（任务 4、5）。

## 文件与接口

| 文件 | 责任 |
| --- | --- |
| `src/shared/project-items.ts` | 管理对象／操作／引用／工作关联类型，Markdown 引用解析及树进度 |
| `src/core/project-items.ts` | 领域查询和变更、幂等、树及状态约束、来源和引用视图 |
| `src/core/project-documents.ts` | 文件校验、哈希、受管原子保存及待恢复操作 |
| `src/core/model.ts`, `store.ts`, `engine.ts` | 管理状态与原有事务、客户端命令、当前上下文及消息／核对集成 |
| `src/core/mcp.ts`, `collaboration.ts`, `reviews.ts`, `src/shared/review-gate.ts` | 管理工具、工作关联、核对材料和权限边界 |
| `src/renderer/ProjectManagement.tsx`, `ProjectMarkdown.tsx`, `ReferenceEditor.tsx` | 项目管理界面、安全 Markdown、统一引用输入 |
| `src/renderer/App.tsx`, `Workbench.tsx`, `Conversation.tsx`, `styles.css` | 项目入口、会话发送／跳转、草稿与原生面板联动 |
| `scripts/reset-project-data.ts` | 有界、显式的一次性定义保留／数据重置工具 |
| `tests/project-items.test.ts`, `project-items-mcp.test.ts`, `project-items-electron.mjs` | 管理命令、真实 loopback MCP、实际 Electron 验收 |

## Task 1: 业务对象、引用与受管状态

**Interfaces:** `ProjectItem`, `ManagementState`, `ItemMutation`, `ItemActor`, `ItemDetail`, `ItemQuery`, `ItemPage`; `queryProjectItems(state, query)`, `readProjectItem(state, id)`, `applyItemMutation(state, input, actor)`。`ProjectState.management` 保存管理对象、变化记录与回执；客户端增加相应命令。

- [ ] 写命令边界的第一项测试：创建 Todo、重开项目后查询仍存在；同请求重放返回相同 ID；记录 RED。
- [ ] 实现最小创建／读取／持久化，运行该测试达到 GREEN。
- [ ] 逐项新增并通过：子项创建／排序／移动、禁止循环、父项完成约束、重开祖先、归档整树／恢复必要祖先、Issue 状态和评论、来源、旧修订拒绝。
- [ ] 引入 Marked token 解析稳定引用；测试三种类型互引、同类型、反链更新和代码示例排除。
- [ ] 运行 `scripts/dev.ps1 test tests/project-items.test.ts` 与 typecheck；提交这一可独立验证的部分。

## Task 2: 真实文档与恢复

**Interfaces:** 文档读返回正文／哈希／错误状态；受管变更传预期修订和正文哈希。`ProjectStore` 在读取项目状态前恢复已受理的文档操作，只应用明确对应的管理状态变更。

- [ ] 先测新建／注册已有 Markdown，外部改动后旧哈希保存被拒绝且原文保留；记录 RED。
- [ ] 实现项目路径验证、正文读取、原子替换和持久操作日志，达到 GREEN。
- [ ] 逐项覆盖：文档移动后 ID 与引用稳定、标题更新、缺失文件与重新关联、目录链接／穿越／硬链接拒绝、恢复过程中外部文件变化。
- [ ] 注入文件已替换但状态未提交、移动中断等故障，证明恢复不丢新状态、不错误覆盖。
- [ ] 运行项目项定向测试与 typecheck；提交。

## Task 3: MCP、消息与核对集成

**Interfaces:** MCP `search_project_items`, `get_project_item`, `update_project_item` 复用 Task 1 操作；`WorkContext` 包含主要 Todo 和引用；`get_project_context` 返回摘要。消息、任务与核对材料保存工作关联。

- [ ] 写真实 loopback MCP 测试：带有效原生身份创建／修改工作项，伪造身份和关闭工具的调用被拒绝；记录 RED。
- [ ] 公开三项工具和节点默认能力，完成 GREEN。
- [ ] 测试并实现：节点请求幂等、修订冲突、直接输入关联、边发送继承／覆盖／清空、关联回复继承、重试保留，业务状态不被运行事件改变。
- [ ] 测试并实现：选定管理材料纳入核对包；正文变化陈旧、状态／负责人变化不误失效；历史包保持原文。
- [ ] 运行 `scripts/dev.ps1 test tests/project-items-mcp.test.ts tests/dynamic-edge-mcp.test.ts tests/human-review.test.ts`，按实际文件名调整；typecheck；提交。

## Task 4: 客户端管理与引用交互

**Interfaces:** 管理界面调用同一命令；`ReferenceEditor` 插入标准 Markdown 引用；`ProjectMarkdown` 用 token 转 React 元素并对内部引用导航；工作流入口保留草稿和原生面板遮挡状态。

- [ ] 写渲染测试／Electron 验收：管理入口、创建和保存、树结构、键盘 @ 选择与跨类型跳转；运行观察 RED。
- [ ] 实现工作流／待办／Issue／文档入口、列表及详情、字段编辑、树操作、评论、搜索、归档恢复、预览和反链，达到 GREEN。
- [ ] 实现逐对象草稿、失败保留、切换保护及延迟响应识别；实际输入验证。
- [ ] 接入“交给节点”输入和会话引用导航；验证普通对话无工作项也可发送。
- [ ] 运行 typecheck/build 和 Electron 检查；提交。

## Task 5: 一次性重置与真实验收

**Interfaces:** 显式命令要求已关闭客户端及确认目标路径；导出节点／边定义并校验，再清理授权的运行数据并以新格式恢复。普通启动不会执行重置。

- [ ] 写最小重置自检：原节点与条件边定义／布局相同，Thread／队列／历史为空，源码文件仍在；验证 RED→GREEN。
- [ ] 记录已有图，正常关闭目标执行，完成一次性重置；在当前项目／工作树启动实际客户端。
- [ ] 按规格第 14 节验证用户建工作、真实节点 MCP 维护、已有条件边交接、冲突／版本及重启恢复；分别记录实际证据和限制。
- [ ] 运行完整测试、typecheck、build；记录准确结果。

## Task 6: 双轴审查与交付

- [ ] 固定最终 main 基线和当前 head；并行 Standards／Spec 审查，修复可行动问题并定向复验。
- [ ] 提交／推送并创建关联 `Closes #13` 的 PR，附 Summary／Evidence／Merge Danger；附加到当前聊天。
- [ ] 核查当前 head 的 CI／审查状态，满足条件后合并。
- [ ] 同步 main，构建并安全重启实际客户端，核实进程路径、启动时间和新 desktop ready；删除已合并临时分支。

## 执行记录

- 2026-10-26：用户确认继续并要求先提交已有改动；旧改动已独立提交在 #14 分支。#13 从该基线继续，避免混合两个 PR。
- 路径裁定：应用原生 worktree 工具不能指定项目内路径，按用户路径规则使用 Git 创建 `.runtime/worktrees/issue-13-project-management`。
- 测试基线：原有完整测试 420/424；四项均因测试硬编码旧 planning-with-files 个人路径失败。#14 修正为发现官方 Codex 插件目录，定向 5/5；完整复跑中。
- 前置交付完成：#15 合并 #14，最终基线 `df03351996e61faa91f4e23136d34757058b1f51`；424/424 完整回归、typecheck、build、5 项 Electron 检查通过，两轴审查无发现。仓库当前未配置远端 CI。
- Task 1：创建／重放／重开、树循环和父项完成、归档恢复、Issue 评论与反向引用已按 RED→GREEN 验证；首次实现提交 `a342ebe`。
- Task 2：真实文档、外部冲突、文件移动／注册通过；注入 SQLite 提交失败后恢复以及外部再次修改后保留现状／取消待恢复保存的检查通过。
- Task 3：真实 loopback MCP 查询写入及身份检查、完成后的原回执重放、工作关联继承／回复／清空，以及固定核对材料和进度修改区别已通过。当前新增定向测试合计 9/9。
- Ruling：读取引用时由已保存正文按需重建关系，复用 Marked 语法树；避免首版重复维护一份易陈旧的正文索引。文档读失败显式返回索引错误；大规模索引优化留待实际性能证据。
- Ruling：文档中断冲突增加“保留磁盘内容并取消待恢复保存”的明确恢复动作；取消记录仍留在项目内，避免单个恢复冲突让项目无法继续使用。
