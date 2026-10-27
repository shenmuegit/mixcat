# 文档工作区实施计划

> **For agentic workers:** Task 1 was executed inline; use superpowers:subagent-driven-development for the remaining editor task, with mattpocock-skills:implement/tdd. Steps use checkbox syntax. Repository standing authorization covers implementation, PR, merge and actual-client restart.

**Goal:** 完成用户的八项文档工作区调整，采用已确认的 Grove 式实时预览编辑。

**Architecture:** 真实文件提供排序时间；原有 Draft/mutate 是保存边界。文档专用布局和实时预览编辑器复用共享引用与安全渲染，不重写 Todo/Issue。

**Tech Stack:** Electron、React、TypeScript、现有 Marked，以及 CodeMirror state/view/commands/autocomplete/lang-markdown。

**Spec:** [文档工作区与实时预览编辑](../design/2026-10-27-document-workspace.md)。Issue #35；基线 `810678f`。

## Global Constraints

- 所有工作数据在 Mixcat 项目内；Grove 仅只读参考。
- 真实文件为正文权威，文件时间查询不产生修订；同时间按路径稳定排序。
- 树／大纲宽度下限 160px，上限分别 460px／360px；正文至少 280px。
- 保存沿用修订与哈希检查；失败不退出编辑、不丢草稿。
- 无上传、媒体导入或额外派发入口；既有 Issue 表格基线必须纳入回归。

## Review Focus

- 批量发现旧文件时不能按注册顺序冒充修改时间；文件丢失可回退（Task 1）。
- 分栏在隐藏视图和缩窄窗口时不能归零或挤掉正文，拖动取消要释放捕获（Task 2）。
- 预览块要保留全文引用定义、标题锚点和安全链接策略（Task 2）。
- 中文输入、撤销、长文本及切换文档时不能丢草稿或错写其他文档（Task 2）。
- 切回阅读的保存失败、外部冲突及待移动路径不能被误标记成功（Task 2）。

### Task 1: 文档时间元信息和文件树

**Files:** `src/core/project-documents.ts`、`src/core/project-items.ts`、`src/shared/project-items.ts`、`src/renderer/DocumentTree.tsx`；`tests/document-library.test.ts`、`tests/project-items-renderer.test.ts`。

**Interfaces:** `readDocument` 读出的文件修改时间进入 `ItemSummary.fileModifiedAt?: string`；未读取到时间的项回退 `updatedAt`。`DocumentTree` 保持原有属性接口。

- [x] 公开查询测试：使用不同 mtime 的真实文件，注册与重复读取不改变文件时间；触碰时间后刷新可见且不产生内容修订。先确认 RED。
- [x] 展示测试：同目录最新文件在前，同时间路径排序，主行文档名、次行文件名；实现并确认 GREEN。
- [x] 定向测试／typecheck 后提交。

### Task 2: 可调文档工作区与实时预览

**Files:** `src/renderer/ProjectManagement.tsx`、`ProjectManagement.css`、`ProjectMarkdown.tsx`；新增文档编辑／预览和分栏组件；`package.json`、锁文件；相关渲染和 Electron 测试。

**Interfaces:** 新编辑器接收正文、编辑状态、禁用状态、项目 ID、`execute`、`onChange` 和标题前缀；父组件持有 Draft 和保存逻辑。非活动块通过原 `ProjectMarkdown` 渲染，引用沿用 `ReferenceNavigation`。

- [ ] 在真实 Electron 边界加入排序、主次行、可拖分隔线和八项清理断言；先确认 RED。
- [ ] 通过官方 npm 安装 CodeMirror，落实当前块源文／其他块预览、中文输入和 @ 补全，保持安全渲染。
- [ ] 标题与正文共用画布；阅读按钮先保存，失败保留编辑；支持快捷键保存和滚动位置保留。
- [ ] 加入鼠标／键盘分栏及宽度约束；隐藏文档视图不清零宽度。
- [ ] 移除常规编号、页面标题、纳入按钮和阅读路径；折叠文件操作，新建缺省路径复用服务。
- [ ] 更新已有文档、Todo、Issue 表格 Electron 回归及冲突／重连断言，定向验证、typecheck/build 后提交。

### Task 3: 交付

- [ ] 完整测试；实际渲染／交互证据；两轴审查并处理发现。
- [ ] 推送并创建关联 #35 的 PR，附加当前任务；检查当前 head 并合并。
- [ ] 同步最终 main，保护草稿后正常重启实际客户端，验收并清理临时分支。
