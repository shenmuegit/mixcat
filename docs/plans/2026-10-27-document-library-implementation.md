# 项目资料文档库实施计划

> **For agentic workers:** Use superpowers:executing-plans with mattpocock-skills:implement and tdd. Follow the repository's two parallel Standards/Spec review gate. Steps use checkboxes.

**Goal:** 自动呈现项目 Markdown 资料，以文件树和阅读／编辑界面支持新增、删除及恢复，并沿用待办／Issue 引用。

**Architecture:** 真实文件作为正文，已有项目管理记录保留稳定身份。发现与删除／恢复落在核心服务，界面复用当前草稿、修订及引用操作，文档采用独立的展示结构。

**Tech Stack:** Node.js 24+、TypeScript、Electron、React、SQLite、现有 Marked；不增加格式转换依赖。

**Spec:** [项目资料文档库](../design/2026-10-27-document-library.md)。Issue #21；分支 `codex/issue-21-document-library`，基线 `ad397b63e7f034115cfd8faece4d7de0edf1a8a1`。

## Global Constraints

- 工作数据全部位于所属项目；首版取消上传。
- 默认发现 `docs/`，已有注册路径继续有效；用户若更改范围，先更新规格和本计划。
- 扫描界限：5,000 目录项、1,000 Markdown 文件、16 层；UTF-8、256 KiB 正文上限。
- 删除移入项目内回收区，恢复不能覆盖目标；保留 ID、引用和审计。
- 当前标准 Markdown 引用继续使用；文档页不派发任务。

## Review Focus

- 外部文件产生与重复扫描：稳定身份、部分扫描说明、外部移动的显式重新关联（Task 1）。
- 目录联接／硬链接／控制目录与读取失败：不越界、不假报完整（Task 1）。
- 删除／恢复与并发文件写入、提交中断：不覆盖、不重放出重复身份（Task 2）。
- 删除后的引用、工作关联和固定核对材料：历史可解释，当前材料不能误有效（Task 2）。
- 多视图与异步读取、脏草稿及大纲滚动：不丢草稿、不错位、不影响工作流画布（Task 3）。

## Task 1：自动发现项目资料

**Files:** `src/core/project-documents.ts` 或同目录专门发现模块；`project-items.ts`、`engine.ts`、`src/shared/project-items.ts`；`tests/project-items.test.ts`。

**Interfaces:** 发现函数返回规范化的候选路径与扫描问题；项目管理读取／节点结束刷新复用注册、版本和持久化逻辑。查询结果携带可显示的问题列表。

- [x] 写公开命令回归：真实文件创建后查询可见，重复刷新及重启 ID 不变；先验证 RED。
- [x] 实现有界目录遍历、链接拒绝、去重和必要的材料观察；GREEN。
- [x] 覆盖读取／大小／路径错误及旧路径缺失后的显式重新关联，测试 partial-scan 提示。
- [x] 定向测试与 typecheck；提交。

## Task 2：文档删除与恢复

**Files:** `src/shared/project-items.ts`、`src/core/project-items.ts`、`project-documents.ts`、`mcp.ts`、`src/shared/review-gate.ts`相关材料判断；项目项和 MCP 测试。

**Interfaces:** `ItemMutation` 增加文档专属 `delete`；文档记录增加删除时间标记；`restore` 支持恢复已删除文件和显式目标路径。文件协调日志可区分正文写入、移动、删除入回收区、恢复。

- [x] 公共操作先测真实删除／恢复、引用身份、陈旧哈希、请求重放及恢复目标占用；RED。
- [x] 复用受管移动与 journal 实现，GREEN。
- [x] 注入 SQLite 提交失败和外部文件变动；验证重启恢复、历史材料与当前材料判断。
- [x] 定向测试／typecheck；提交。

## Task 3：Markdown 文档工作区

**Files:** `src/renderer/ProjectManagement.tsx`、专门的文件树组件、`ProjectManagement.css`或文档样式、`ProjectMarkdown.tsx`；`tests/project-items-electron.mjs`及相关渲染测试。

**Interfaces:** 文档分支复用当前 `Draft`、加载与变更函数；文件树使用 `ItemSummary.path`；大纲使用同一 Markdown 标题顺序；右侧继续使用 `ItemDetail.references/backlinks`。

- [ ] 渲染／Electron 检查先覆盖文件树、默认阅读、编辑、新增、删除／恢复、大纲和无发送入口；RED。
- [ ] 实现文档专用布局及回收站，复用共享保存／冲突逻辑；GREEN。
- [ ] 检查 `@` 引用、原生生成文档发现、脏草稿、窗口尺寸／工作流切换和缺失文件说明。
- [ ] 定向验证、typecheck/build；提交。

## Task 4：验收与交付

- [ ] 一次完整测试，实际客户端／受控 Electron 交互，记录真实结果。
- [ ] 固定基线和 head，两轴审查并修复发现。
- [ ] PR 关联 Issue #21，验证当前 head 检查后合并，核实 Issue 关闭。
- [ ] 同步 main、构建、正常重启实际客户端并确认新 desktop ready；清理临时分支。

## 执行记录

- 独立 builder check：nothing important left；目录范围已有明确默认值，不阻塞独立工作。
- Task 1：发现、稳定身份、重启、非法 UTF-8／大小／链接、1,000 文件界限、原生轮次结束发布以及外部移动重新关联通过。新增测试先捕获未发现资料和重新关联被新对象占用的问题；修复后连同已有项目项／MCP 定向测试 18/18，typecheck 通过。
- Task 2：删除入项目回收区、恢复到未占用路径、陈旧哈希、相同请求重放、删除提交中断的重启恢复、取消恢复撤回文件位置、已提交 journal 的取消不逆转文件、当前核对材料失效及历史引用继承通过。文档库与 MCP 定向 12/12，原有项目项与 MCP 14/14；typecheck 通过。
