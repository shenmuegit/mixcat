# BoardUI 130 项在 Mixcat 的设计规格

2026-11-24 · 评审稿 · 逐项规格覆盖 130/130。现有分支的对应关系见 [现状证据](#evidence)。

## 目标与范围

为每个 BoardUI 目录项记录原始标识、来源、Mixcat 落点、推荐交互、可复测的验收条件和现有分支证据。范围包括布局、按钮、导航、表单、动效、样式、会话组件、数据图表及整页模板。公共组件、上游别名与整页组合各保留自己的目录编号，可以共用一份实现。

产品目标是让用户在真实 Mixcat 客户端检查适用设计，并能从规格反查自己的工作对象。现有节点执行、人工核对、原生权限、项目资料、工作项、信息流和 ComfyUI 仍使用各自的数据与操作契约。财务、人事、医疗、健康的示例只提供版式或组件参考。

固定输入来自 2026-11-24 的 [BoardUI 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/README.md)、[免费注册表](https://www.boardui.com/r/registry.json)和 [Pro 公开注册表](https://www.boardui.com/r/registry-pro.json)。共 69 个 README 条目、21 个免费注册表补充条目、30 个 Pro 组件和 10 个 Pro 模板。官网展示页的当前条目数与这份固定目录口径不同。逐条来源位于对应规格项。

## 采用方案

| 方案 | 适用性与代价 |
| --- | --- |
| 现有业务接入，加独立客户端预览 | 本稿推荐。真实操作放回其持有数据的页面。预览使用 Mixcat 自有样式和固定示例，供全部 130 个条目逐一核对。实现时需要明确预览与真实执行的隔离。 |
| 全部只做客户端预览 | 能系统检查样式、键盘和过渡，速度较快。真实草稿、任务状态、IPC 与文档验证仍须另做。 |
| 每项单独成为正式产品入口 | 组件别名、样式工具和整页组合会重复露出。额度、跨项目统计、单次排期等需要新的业务和数据契约。 |

推荐方案下，规格标注 `接入`（建议接到现有业务）、`条件`（先明确数据或产品前提）、`参考`（以样例或已有机制核对）和 `维持`（回归已接入项，或共用兼容别名）。这些是设计建议。正式入口、预览入口是否随正式版公开、首批范围和新增统计等业务需求均有待后续确认。

若建设预览，在独立开发或评审入口用 `编号/原始标识` 跳转每一条。每条显示实际演示载体、关键状态和验收条件。别名与模板可链接到共享的原型，但需分别演示其兼容或组合契约。样例数据与真实项目、Codex 会话、持久化、授权、调度和进程隔离。已接业务项还须从真实菜单或面板进入验收。

免费源采用 MIT，直接移植时保留版权、许可及来源。文档树已有 [许可通知](../../public/licenses/BoardUI.txt)。Pro 条目依据公开目录与公开展示写规格，采用 Mixcat 独立设计，未核查付费源码内部行为。若以后考虑引入 Pro 源码，须先核对具体授权，尤其是分发源代码及提供预览工具的条款。[BoardUI 许可](https://www.boardui.com/license)

## 跨页面交互与视觉契约

具体尺寸与动效区间为本稿建议，按真实桌面渲染调整。三套现有主题与项目业务规则来自代码和已确认设计。

| 维度 | 要求 |
| --- | --- |
| 常规窗口 | 保留主导航、项目或模块导航、主内容。工作流主区以画布和详情分栏，顶部先显示项目与待办状态，再放同作用域的一组操作。固定操作栏与正文分别布局，内容区独立滚动。现有节点详情初始约 420 px，分栏下限为详情 320 px、画布保留约 270 px，保留拖拽。 |
| 紧凑窗口 | 以实际容器宽度决定是否收纳次要操作、折叠次级栏。节点详情继续支持关闭与恢复。只读成果可以覆盖内容区并返回原位置。最小窗口以现有 `1100×720` 为起点，连同 `1280×800`、`1460×960` 和 125% 缩放检查。 |
| 视觉层级 | 在 `light`、`dark`、`violet` 现有主题建立表面/文字/状态语义。项目名、面板名、表头、正文、元信息各一层。列表紧凑，中文长消息可读。建议用 4/8/12/16/24 px 的间距级差统一布局。状态色同时有文字或形状。正文对比度目标 4.5:1，控件边界及必要焦点标识目标 3:1。 |
| 按钮 | 主动作就地显示，次要动作以文字或图标呈现并保留名称。默认按钮命中区建议至少 32×32 CSS px，紧凑行至少 24×24。对高风险操作给出对象、影响、确认、取消、进行中和失败，每次派发沿用已有 ID/回执。 |
| 键盘与焦点 | 在当前可见层保持合理 Tab 顺序、可见焦点和可达的关闭、取消。菜单、抽屉、对话框和节点页签需明确打开和返回焦点。各输入区保留实际快捷键与 IME 行为。目前节点消息和信息流均按各自实现保留 Ctrl+Enter 换行，节点的编辑器还需保持其他既有换行与选词行为。 |
| 动效 | 建议控件过渡 100–160 ms、弹出与切换 140–200 ms。优先透明度或小位移，避免把输入区、画布和长列表推离焦点。只有前景当前真实活动可做局部反馈。后台、历史、失败、暂停和未知状态有各自稳定样式。`prefers-reduced-motion` 启用后立即呈现可读终态。 |
| 数据与异步反馈 | 原生消息、任务、项目快照、工作项修订与运行回执是权威。分别呈现初次加载、刷新、空数据、无匹配、不可用、错误或结果未知。刷新不清空已有草稿。迟到回包按当前项目、对象身份和查询序列筛除。对请求结果未知时先核对原动作，防止重复提交。 |
| 图表与统计 | 每个统计有单位、时间窗、时区、范围、去重身份、缺失含义和明细来源。同一口径用于图形、提示及可访问明细表。区分 0、未知和不可用。只有真实上限或阶段分母才显示比例。 |

## GitNexus 落点

GitNexus 已在工作台分支 `codex/issue-291-workbench-design` 更新并验证代码索引，分析提交为 `a19a1776c5758265ebdcc16bd44bce83438bda24`，对照基线为 `3ee4810d856edfeb92fb40ec8685a9982cde8202`。查询用正式 `src/renderer` 的符号 UID 区分同名归档原型。图谱提供直接关系。索引的跨语言解析与流程枚举有截断，具体 IPC、状态和条件用源码校对。

| 相关入口 | 已核实关系与后续影响面 |
| --- | --- |
| 外壳、控件与模板 | 图谱 `App → TemplateSetup`、`App → CreateProject`。三套主题来自渲染器 CSS 与宿主读写。设计 001–014、035–057、076、080–082 重点回归创建、切页、账号和主题。 [应用外壳](../../src/renderer/App.tsx) · [主题样式](../../src/renderer/theme.css) · [模板准备](../../src/renderer/TemplateSetup.tsx) |
| 工作流、会话与核对 | 图谱显示 `Workbench` 和 `ComfyWorkspace` 都调用 `SessionPane`。面板进一步调用 `ConversationFeed`、`HumanReviews`、`NodeConfig` 和 `NodePanels`。会话、状态和编辑区的改动需用普通项目与 ComfyUI 双入口验证。 [工作台](../../src/renderer/Workbench.tsx) · [会话面板](../../src/renderer/SessionPane.tsx) · [会话记录](../../src/renderer/Conversation.tsx) · [原生请求](../../src/renderer/NativeRequests.tsx) · [人工核对](../../src/renderer/HumanReviews.tsx) |
| 节点能力 | 图谱 `NodeSettings.CapabilityFields → PersonalCapabilityFields → CapabilityChoices`。目录刷新、草稿和保存的实测须从创建或已有节点的配置入口进入。 [节点设置](../../src/renderer/NodeSettings.tsx) · [能力选择](../../src/renderer/PersonalCapabilityFields.tsx) |
| Issue 与文档 | 图谱 `App → ProjectWorkspace → ProjectManagement → DocumentTree`。`DocumentTree` 的直接调用方为 `ProjectManagement`。Issue 的筛选只改变可见集合。状态、层级、派发与文档导航保护另从原调用边界验证。 [项目管理](../../src/renderer/ProjectManagement.tsx) · [文档树](../../src/renderer/DocumentTree.tsx) · [工作项类型](../../src/shared/project-items.ts) |
| 信息流与图像 | 图谱 `App → FeedWorkspace → FeedCollection`，还包括卡片列表和新建入口。ComfyUI 的工作面板、运行组合、作品和供应商分别有独立处理。图表和模板若需要没有现成的度量，须先明确采集与查询契约。 [信息流工作区](../../src/renderer/FeedWorkspace.tsx) · [采集详情](../../src/renderer/FeedCollection.tsx) · [ComfyUI 工作区](../../src/renderer/ComfyWorkspace.tsx) |
| IPC 与本地数据 | 源码显示渲染器经 `window.mixcat` 访问 preload，命令由桌面主进程按所属窗口、项目和动作身份处理。预览样例不得进入真实命令、媒体写入、登录、队列或调度入口。 [共享数据契约](../../src/shared/types.ts) · [预加载接口](../../src/desktop/preload.ts) · [主进程入口](../../src/desktop/main.ts) |

已确认的契约按专项设计执行。Issue 使用统一对象、旧 Todo 身份和树形状态规则。信息流保留独立 Thread、卡片与对话目标/计划，已移除的工作台搜索或多选不随组件接入恢复。模板只准备所选能力。核对、原生审批、暂停、重置与恢复分别按自身状态处理。[统一 Issue](2026-10-29-unified-issues.md) · [信息流](2026-10-29-personal-information-feed.md) · [模板能力准备](2026-11-06-template-capability-setup.md) · [人工核对](2026-10-22-human-review-design.md) · [工作流重置](2026-10-29-workflow-reset.md)

<a name="evidence"></a>

## 现状证据

规格编号与交付证据分别记录。`已接入` 表示有独立源码及提交证据。`对应改动` 表示 #291 改动了该设计的关键行为。`相邻改动` 表示改到了使用场景或局部行为，逐项写明缺口。其余标为 `未见 #291 对应改动`，只描述这次对照差异的结果。

已接入 **1 项** · 对应改动 **9 项** · 相邻改动 **14 项** · 未见 #291 对应改动 **106 项**

- [Issue #291](https://github.com/shenmuegit/mixcat/issues/291) 与 [PR #292](https://github.com/shenmuegit/mixcat/pull/292) 的对应行为依据 `3ee4810...a19a177` 的渲染器差异。分支范围是工作台与部分项目界面，条目有对应关系也需按本稿验收条件重新取证。
- 034 `tree-view` 有 [PR #280](https://github.com/shenmuegit/mixcat/pull/280)、`f1f0d9a`、源码说明和 MIT 通知的独立接入证据。059 `badge` 是上游兼容名，规格要求与 058 共用表现，证据按各条单独判断。

## 验收与实施依赖

1. **基础、控件和动效。** 先对齐主题、文字、按钮/菜单、焦点与前景反馈。实际客户端在三主题、窄/宽窗口、键盘、中文组词和减弱动态下覆盖，验证编辑器与画布无相互干扰。
2. **现有页面接入。** 再接工作流、会话、核对、Issue、文档和模板。普通项目和 ComfyUI 复验共享面板。受理、未知结果、重试、历史和草稿走正常入口。现有对照测试可从 [会话键盘](../../tests/node-composer-keyboard-electron.mjs)、[核对](../../tests/human-questions-electron.mjs)、[工作项](../../tests/project-items-electron.mjs)、[文档](../../tests/document-workspace-electron.mjs)和 [模板](../../tests/template-setup-electron.mjs) 开始。
3. **样例、数据组件与整页。** 图表需求按真实数据及明细追溯设计，复杂组合引用逐项契约。参考项、受条件限制项和兼容名以样例或行为证据逐条验证。样例测试覆盖发送、授权、附件、调度和 ComfyUI，核对真实 IPC、凭据、项目存储及进程调用均为零。需要保存、重开的场景复用独立样例状态。
4. **交付取证。** 后续按 Mixcat Issue/PR 流程实施。每个条目验收记录带 ID、入口、构建 SHA、数据类型（固定样例或真实运行）、交互或截图证据及结果。正式接入项必须在当前构建的实际客户端复测。全量交付时可逐项查到 130 个结果。规格、截图与分支启动各自只能证明对应的交付阶段。

### 待确定的产品选择

- 预览是否仅在评审构建开放，还是从正式设置进入。规格已定义这两种暴露方式共同需要的隔离与可追溯要求。
- 是否新增手动或跨采集排期、节点统计、额度查询或 Issue 看板，以及看板开放编辑还是保持只读。项目会话历史内直接回复也属于待确定的产品能力。当前规格保留从历史定位后回节点输入区。

## 逐项规格

[001–014 基础样式和通用行为](#foundations) | [015–034 浮层、数据输入和树](#overlays) | [035–058 按钮、表单和界面导航](#controls) | [059–073 状态、提示和日期](#feedback) | [074–090 应用壳、会话和数据区](#workspace) | [091–099 Pro 会话组件和日历](#agentic) | [100–116 Pro 图表](#charts) | [117–120 Pro 看板与多节点组件](#collaboration) | [121–130 Pro 整页模板](#templates)

<a name="foundations"></a>

### 基础样式和通用行为

#### 001 template-copy

**界面文案与翻译** · 接入 · 外壳、节点与模板 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/foundations/template-copy/template-copy.tsx)

- **设计**　统一项目、工作流、节点、会话、待回答和待核对的界面文案与读屏名称。模板显示名与持久 ID 分开，任务、路径、引用和用户内容原样显示。
- **验收**　以带中英文与空格的节点名、模板 ID 和文档路径创建项目。切换入口后名称、读屏和引用均可辨认，已持久化的键和值保持一致。
- **现状证据**　未见 #291 对应改动

#### 002 direction

**文字与界面方向** · 条件 · 外壳、浮层 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/foundations/direction/direction.tsx)

- **设计**　如果支持 RTL，从界面语言决定阅读方向，由同一容器传给布局、键盘导航和 Portal。命令文本、路径与工作流实际连线使用自己的方向。
- **验收**　对同一个导航和浮层样例切换 LTR/RTL。起始侧和键盘方向一致，焦点返回正确，画布边的起点、终点和本地路径不变。
- **现状证据**　未见 #291 对应改动

#### 003 scroll-direction

**横向滚动方向** · 条件 · 工作台壳、节点页签 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/utils/scroll-direction.ts)

- **设计**　横向页签与附件条用逻辑首尾定位。焦点移动或选中项变化时只滚动最近容器，RTL 启用后维持同样的逻辑顺序。
- **验收**　溢出时按 Home、End 或方向键，焦点项完整进入可视区且页面纵向位置不动。LTR 和 RTL 样例均能到达首末项。
- **现状证据**　未见 #291 对应改动

#### 004 directional-icon

**可镜像方向图标** · 条件 · 图标、工作流画布 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/utils/directional-icon.ts)

- **设计**　对阅读方向敏感的返回、前进和侧栏起始侧图标随语言镜像。播放、关闭、排序含义和表示真实任务交接的箭头保持自身语义。
- **验收**　在 RTL 样例比较返回、播放和两个节点的连线，仅返回等导航方向变化。图标的可访问名称始终与动作一致。
- **现状证据**　未见 #291 对应改动

#### 005 theme

**语义色、圆角与阴影** · 接入 · 全局主题 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/styles/theme.css)

- **设计**　在现有 `light`、`dark`、`violet` CSS 中统一底色、表面、边框、文字、主操作、焦点、危险、警告、成功、圆角及阴影层级。正文和状态文字从对应表面的语义色取值。
- **验收**　三套主题的默认、悬停、选中、聚焦、禁用与错误状态均可辨认，切换后工作台、核对、Issue 和文档保持相同状态含义。
- **现状证据**　相邻改动。新增工作台样式使用现有主题变量，语义色与三主题仍来自原主题系统。 [Workbench.css](../../src/renderer/Workbench.css)

#### 006 typography

**文字层级** · 接入 · 工作台、对话、表格 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/styles/typography.css)

- **设计**　统一页面标题、面板标题、正文、标签、元信息与等宽内容的层级。中文消息保留换行，时间和计数对齐，长节点名可换行或通过可访问方式读全。
- **验收**　在 100% 与 125% 缩放用长中文节点名、英文路径和多行消息检查。操作名和状态仍可读，代码内容及复制结果完整。
- **现状证据**　相邻改动。调整了模板与会话的局部字号和信息层级，文档及对话的全部排版未在该差异中统一。 [Workbench.css](../../src/renderer/Workbench.css)

#### 007 globals

**全局样式** · 接入 · 主题、编辑器与画布 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/styles/globals.css)

- **设计**　共用变量和焦点、减弱动态、控件尺寸规则放在渲染器样式中。全局作用域限制为宿主，CodeMirror、React Flow、Excalidraw 和嵌入面板继续使用各自输入与画布行为。
- **验收**　在三套主题中输入中文、拖动画布节点和打开 Excalidraw，验证光标、选区、滚动和键盘事件与宿主控件均正常。
- **现状证据**　未见 #291 对应改动

#### 008 cx

**样式类合并工具** · 参考 · 渲染器组件内部 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/utils/cx.ts)

- **设计**　新共用组件先沿用现有 CSS 和类名组合方式。仅当接入确需样式类冲突消解的组件时，在边界收敛合并规则并保留外部传入类。
- **验收**　同一按钮上的危险、尺寸、禁用与调用方样式组合结果可预测，组合路径不会引入未使用的全局样式依赖。
- **现状证据**　未见 #291 对应改动

#### 009 rules

**设计系统编写约定** · 参考 · 设计约定 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/.cursor/rules/boardui.mdc)

- **设计**　规格和组件变更记录操作语义、主题代币、焦点、键盘与动态反馈。依照 Mixcat 的文档目录和既有工程流程提交。
- **验收**　任取一个危险操作变更，能从设计和验收记录查到作用对象、聚焦与取消行为、三套主题和失败反馈对应的证据。
- **现状证据**　未见 #291 对应改动

#### 010 use-dismiss-on-outside-press

**点击外部关闭** · 接入 · 项目与文档行菜单 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/utils/use-dismiss-on-outside-press.ts)

- **设计**　对非模态菜单，在弹层外按下关闭，并允许外部正常点击继续执行。弹层内部的子菜单视为同一上下文，模态确认沿用原确认语义。
- **验收**　打开项目行菜单后点击另一行，只切换一次。子菜单内点击不误关，Escape 返回触发按钮，重置确认不被背景控件触发。
- **现状证据**　未见 #291 对应改动

#### 011 scroll-fade

**滚动边缘提示** · 接入 · 节点页签、附件条 · [免费注册表](https://www.boardui.com/r/scroll-fade.json)

- **设计**　横向溢出时只在仍有隐藏内容的一侧显示边缘淡化，卷到边界消失。边缘视觉层不遮住焦点或拦截操作。
- **验收**　用短、长、缩放后的页签条检查，分别出现零、一或两侧提示。键盘移到末端后淡化及时更新，按钮仍可点击。
- **现状证据**　未见 #291 对应改动

#### 012 use-count-up

**数字递增动画** · 参考 · 概览样例 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/hooks/use-count-up.ts)

- **设计**　短过渡可用于静态摘要卡初次展示。读屏与实时执行、队列及核对数量同步读取最终实数，减弱动态下直接更新。
- **验收**　把概览样例从 9 更新到 12 并启用减弱动态，显示直接到 12。对核对列表的真实 12 项，计数从首次可见就等于列表数量。
- **现状证据**　未见 #291 对应改动

#### 013 chevrons

**展开与排序箭头** · 接入 · 文档树、排序与选单 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/foundations/icons/chevrons.tsx)

- **设计**　区分目录折叠、下拉弹层与排序箭头。状态由打开、展开或排序值驱动，对应控件同时暴露 `aria-expanded` 或 `aria-sort`。
- **验收**　同屏检查关闭目录、打开选单和倒序表头。鼠标或键盘操作后箭头与语义同步，未排序列不会显示为已排序。
- **现状证据**　未见 #291 对应改动

#### 014 logo

**品牌标识占位** · 参考 · 应用品牌区 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/foundations/brand/logo.tsx)

- **设计**　产品继续使用 Mixcat 品牌。紧凑壳允许只放标识并保留应用名，只有明确承担回到项目列表时才作为按钮或链接。
- **验收**　折叠与展开导航时 Mixcat 可以被识别。若标识可交互，键盘能到达并返回既有项目列表，未保存时遵循原导航保护。
- **现状证据**　未见 #291 对应改动

<a name="overlays"></a>

### 浮层、数据输入和树

#### 015 modal

**模态框与危险确认** · 接入 · 重置确认、创建项目 · [免费注册表](https://www.boardui.com/r/modal.json)

- **设计**　沿用 `Dialog` 和已有操作处理。在标题与描述中显示对象和后果，危险确认默认焦点给取消。长正文独立可滚，确认中避免重复提交并保留失败原因。
- **验收**　在运行与空闲项目分别打开重置。受保护时无法提交，Escape 和取消不变更数据并回到触发处，失败后仍能读原因。
- **现状证据**　未见 #291 对应改动

#### 016 drawer

**侧边或底部抽屉** · 接入 · 项目节点详情、成果、笔记 · [免费注册表](https://www.boardui.com/r/drawer.json)

- **设计**　节点详情保持非模态分栏，画布仍可操作。依据可用宽度将只读成果或资料详情移至窄窗口覆盖层，显示标题、关闭和必要操作，返回原对象。
- **验收**　缩窄和恢复工作台，展开、关闭并返回同一节点或成果。挂起的草稿、焦点与画布位置可恢复，确认对话框打开时 Escape 只关闭前景层。
- **现状证据**　相邻改动。补了非模态节点详情收起后的重开及焦点定位。成果、笔记与窄窗覆盖层沿各自入口。 [Workbench.tsx](../../src/renderer/Workbench.tsx)

#### 017 popover

**锚定弹层** · 接入 · 模型、引用与行操作 · [免费注册表](https://www.boardui.com/r/popover.json)

- **设计**　弹层锚定触发器，在靠近窗口边界时换向或限高。跟随可见锚点，锚点滚出或被销毁时关闭。选择后回到触发器或所需编辑位置。
- **验收**　在窄侧栏右下角打开模型或引用选择器。全部可选项可滚到，窗口缩放不截断操作，关闭后键盘可继续输入。
- **现状证据**　未见 #291 对应改动

#### 018 combobox

**可搜索选择框** · 接入 · 节点能力、信息流模型 · [免费注册表](https://www.boardui.com/r/combobox.json)

- **设计**　长目录按已有模型 ID、插件 ID 或技能路径选取。搜索名称、说明及来源，可对多选项逐条移除，已保存但目录未返回的项目继续可见。
- **验收**　用键盘搜索并选中同名不同来源的两个条目。刷新目录使一项缺失，已选与草稿保留，清除搜索不会提交或移除选择。
- **现状证据**　相邻改动。能力目录有搜索、复选及移除，控件为搜索字段加列表，未新增组合框交互。 [PersonalCapabilityFields.tsx](../../src/renderer/PersonalCapabilityFields.tsx)

#### 019 toast

**堆叠式短通知** · 接入 · 短时执行反馈 · [免费注册表](https://www.boardui.com/r/toast.json)

- **设计**　复制、导出成功等低风险反馈可在宿主提示区自动消失，同源重复事件更新原提示。保存失败、原生审批与人工核对保留在相应面板。
- **验收**　连续复制三次只保留同源提示。悬停或聚焦时暂停退场，移开后按时清除，同期保存失败仍可在原位置重试。
- **现状证据**　未见 #291 对应改动

#### 020 accordion

**就地展开详情** · 接入 · 模板准备、历史和失败详情 · [免费注册表](https://www.boardui.com/r/accordion.json)

- **设计**　已满足能力和完成的工具段可折叠，当前失败和所需操作默认展开。触发器暴露展开状态，收起时不丢失有意义的列表位置。
- **验收**　键盘折叠五项已满足能力后，失败原因与重试仍可见。重开历史组后能定位原条目，减弱动态下立即切换高度。
- **现状证据**　未见 #291 对应改动

#### 021 spinner

**旋转等待标记** · 接入 · 局部读取 · [免费注册表](https://www.boardui.com/r/spinner.json)

- **设计**　时长未知的读取仅在对应列表、保存区或消息旁显示等待文字，可选局部旋转。无响应时显示重试或明确未知状态。
- **验收**　阻断能力目录刷新，原来的选择且可见，并显示「正在读取」。收到失败后等待标记消失，提供重试，减弱动态仍显示等待文字。
- **现状证据**　未见 #291 对应改动

#### 022 progress

**操作进度** · 接入 · 模板能力准备 · [免费注册表](https://www.boardui.com/r/progress.json)

- **设计**　已知分母时显示已处理项/所需项，逐项区分就绪、已安装、已跳过、失败或未确认。加载与模型执行的未知完成量显示阶段，列表中的失败可单项重试。
- **验收**　模拟 3 项中 1 项就绪、1 项已跳过、1 项失败，摘要为已处理 2/3。重试成功后为 3/3，仍可辨认跳过项。关闭再打开取存储的真实状态。
- **现状证据**　未见 #291 对应改动

#### 023 meter

**用量指示** · 条件 · 配额摘要 · [免费注册表](https://www.boardui.com/r/meter.json)

- **设计**　只有可信的当前值与上限时显示用量、单位和统计窗口。没有上限时显示实数或「未提供」，阈值影响显示颜色与文字。
- **验收**　分别给定 40/100、0/100、未知上限和超限样例。0 与未知可区分，超限值完整可读，宽度可以封顶但不会截断实际数字。
- **现状证据**　未见 #291 对应改动

#### 024 skeleton

**内容骨架** · 接入 · 成果与文档首屏 · [免费注册表](https://www.boardui.com/r/skeleton.json)

- **设计**　首次加载等待时占用真实布局所需的空间。已有数据刷新保留内容、位置、选择与草稿。错误替换骨架并提供对应恢复操作。
- **验收**　延迟一次首屏加载并触发一次后台刷新。首屏就位，刷新时不闪空，失败能看到原因，减少动态时骨架静止。
- **现状证据**　未见 #291 对应改动

#### 025 command-palette

**命令面板** · 接入 · 宿主全局导航 · [免费注册表](https://www.boardui.com/r/command-palette.json)

- **设计**　候选按项目、节点、Issue、文档与命令分组，排序与点击即导航。导航保护可取消跳转。快捷键由宿主处理，组词、编辑器占用和前景模态时退让。
- **验收**　同一查询出现跨对象类型与同名结果，能辨认所属项目。键盘可跳转、无结果时可退出，IME 与脏文档取消均无副作用。
- **现状证据**　未见 #291 对应改动

#### 026 token-input

**带引用的输入框** · 接入 · 项目引用编辑器 · [免费注册表](https://www.boardui.com/r/token-input.json)

- **设计**　以现有引用 ID 表示引用，保留文字、光标、`@` 选择与草稿。对可视引用片段定义删除及复制的稳定语义，原生消息提交沿用当前适配。
- **验收**　中文组词期间 Enter 不发送。选择一个同名文档引用、复制或退格删除后，发送只带仍存在的引用，切换节点能恢复各自草稿。
- **现状证据**　未见 #291 对应改动

#### 027 context-menu

**右键菜单** · 接入 · 项目、文档、笔记与画布 · [免费注册表](https://www.boardui.com/r/context-menu.json)

- **设计**　指针位置和 Shift+F10 都能打开目标对象菜单，窗口边界自动调整位置。常用动作与危险动作分开，并标出运行保护或不可用原因。
- **验收**　从深层文档、项目行和画布节点分别打开菜单。键盘操作的目标始终是触发对象，Escape 返回原焦点，危险项进入已有确认流程。
- **现状证据**　未见 #291 对应改动

#### 028 search-field

**搜索框** · 接入 · Issue、能力与文档目录 · [免费注册表](https://www.boardui.com/r/search-field.json)

- **设计**　搜索输入带名称、清除、查询中、无结果和错误状态。旧查询晚到时丢弃，仅清除检索文本时保留其它筛选、选中对象与草稿。
- **验收**　输入两个快速变化的查询并让旧结果晚到，最终仅显示新结果。清空关键词后负责人筛选与已选插件仍在，IME 组词不提前提交。
- **现状证据**　对应改动。技能与插件目录新增搜索，Issue 保留关键词并与新的状态、负责人条件合用。共享搜索组件的其它状态另验。 [PersonalCapabilityFields.tsx](../../src/renderer/PersonalCapabilityFields.tsx) · [ProjectManagement.tsx](../../src/renderer/ProjectManagement.tsx)

#### 029 number-field

**数值微调框** · 条件 · 带明确数值范围的设置 · [免费注册表](https://www.boardui.com/r/number-field.json)

- **设计**　只用于已定义范围和步进的数值。支持键盘微调、手动输入、可读单位和无效值说明，提交时沿用字段的业务校验。
- **验收**　输入空值、非数字、上下界和越界值。必填态、可保存态与错误原因明确，推理档位继续按模型返回的有限选项展示。
- **现状证据**　未见 #291 对应改动

#### 030 time-field

**分段时间输入** · 条件 · 排期编辑样例 · [免费注册表](https://www.boardui.com/r/time-field.json)

- **设计**　现有信息流以会话沟通目标和计划，顶部只读显示。若明确新增手动排期编辑，按 24 小时编辑时、分并显示 IANA 时区，保存仍用现有校验和调度契约。
- **验收**　在样例设置每日 09:05 与每周排期，验证 24:01 不能提交。跨夏令时以存储时区为准，现有对话制定的计划按原流程生效。
- **现状证据**　未见 #291 对应改动

#### 031 tag-group

**可移除标签组** · 接入 · 插件、技能和 Issue 筛选 · [免费注册表](https://www.boardui.com/r/tag-group.json)

- **设计**　已选项保留名称与来源，删除控件明确对应对象。移除后焦点去邻项或搜索框，Issue 标签只解除对应过滤项。
- **验收**　添加两个同名不同 ID 的插件，移除其中一个，剩余项不变。清除一个 Issue 条件后其它条件生效，键盘焦点不掉到页面开头。
- **现状证据**　对应改动。已选能力及 Issue 生效条件可逐项移除，分别还焦到搜索框或对应筛选器。 [PersonalCapabilityFields.tsx](../../src/renderer/PersonalCapabilityFields.tsx) · [ProjectManagement.tsx](../../src/renderer/ProjectManagement.tsx)

#### 032 date-calendar

**内联月历** · 条件 · 采集结果与历史日期筛选 · [免费注册表](https://www.boardui.com/r/date-calendar.json)

- **设计**　内联月历标明今天、选中日期、禁用范围和当前时区。月格与列表结果区分没有运行和没有取到记录。
- **验收**　跨月和跨年用方向键选择，切月保持焦点语义。以有数据、空和不可选日验证列表范围，窄栏不会截掉单个日期。
- **现状证据**　未见 #291 对应改动

#### 033 color-picker

**颜色选择器** · 条件 · 独立画布或可配置分类 · [免费注册表](https://www.boardui.com/r/color-picker.json)

- **设计**　通过色板和文本输入选择允许的颜色，显示可解析值与当前样本。保存须与该画布或对象的现有格式一致，业务状态使用主题语义色。
- **验收**　输入合法十六进制、非法值和含透明度样例。取消恢复旧颜色，保存重开值一致，节点失败或核对颜色不受影响。
- **现状证据**　未见 #291 对应改动

#### 034 tree-view

**文档树** · 维持 · 项目文档树 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/base/tree-view/tree-view.tsx)

- **设计**　延续 #280 树视图，并覆盖后来同名文件、深层目录、草稿及删除恢复操作。展开、选中、键盘和右键目标以当前文档及目录 ID 为准。
- **验收**　上下左右键及 Shift+F10 正确访问深层项目，切换草稿受现有保护。删除和恢复后焦点落在有效节点，MIT 通知仍可随构建找到。
- **现状证据**　已接入。来自 #280 的独立接入，`f1f0d9a`。与 #291 对照差异分开取证。 [DocumentTree.tsx](../../src/renderer/DocumentTree.tsx)

<a name="controls"></a>

### 按钮、表单和界面导航

#### 035 button

**文字按钮** · 接入 · 全局按钮 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/base/buttons/button.tsx)

- **设计**　主、次、文字和危险按钮保持固定层级与尺寸规则，提交中避免重复发令。主动说明禁用的业务原因，按钮反馈沿用同一个动作名称。
- **验收**　点击「创建项目」、键盘触发「发送」及「重置工作流」，分别验证只执行一次。失败可恢复，危险动作先确认，三主题焦点可见。
- **现状证据**　相邻改动。调整工作流的主要、次要和危险操作排序及样式，原业务命令与确认流程继续独立验证。 [Workbench.tsx](../../src/renderer/Workbench.tsx)

#### 036 icon-button

**纯图标按钮** · 接入 · 工作流详情、弹层工具栏 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/base/buttons/icon-button.tsx)

- **设计**　无文字按钮为可聚焦的实际按钮，提供中文动作名及状态。方形目标区建议最少 32×32 CSS px，紧凑行至少 24×24，文字或提示可揭示动作。
- **验收**　仅用键盘调用「展开节点详情」「关闭弹窗」和「更多」，检查可访问名称和命中区。用名称找到同一焦点后继续操作。
- **现状证据**　对应改动。新增带中文可访问名称的节点详情展开按钮，扩大详情标题区相关按钮的可操作空间。 [Workbench.tsx](../../src/renderer/Workbench.tsx) · [Workbench.css](../../src/renderer/Workbench.css)

#### 037 link-button

**行内文字动作** · 接入 · 材料、来源与历史定位 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/base/buttons/link-button.tsx)

- **设计**　打开外部来源或可导航目标使用链接语义，调用宿主动作时用按钮。显示可读目标和失败反馈，遵循现有可信 URL 与项目路径检查。
- **验收**　分别激活网页来源、项目文档和缺失文件。可用目标按既有规则打开，缺失时给出相应路径和恢复提示，未触发同时执行的命令。
- **现状证据**　未见 #291 对应改动

#### 038 button-group

**同组操作按钮** · 接入 · 项目与节点运行控制 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/base/buttons/button-group.tsx)

- **设计**　同作用域操作成组并有可访问组名，项目级与节点级各在自己的区域，复用现有暂停、恢复和状态门控。危险重置单独放置。
- **验收**　在一运行一空闲时操作节点和项目暂停，再恢复。变化的对象范围与组名一致，键盘逐个到达，重置未在这组触发。
- **现状证据**　对应改动。分别为项目和节点运行操作提供可访问组名与相邻按钮样式。 [Workbench.tsx](../../src/renderer/Workbench.tsx) · [SessionPane.tsx](../../src/renderer/SessionPane.tsx)

#### 039 close-button

**关闭按钮** · 接入 · 弹窗、侧栏与临时反馈 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/base/buttons/close-button.tsx)

- **设计**　关闭按钮命名包含对象或明确上下文。关闭等同取消或隐藏，根据现有未保存保护决定是否可直接退出。关闭后回触发器或最近有效对象。
- **验收**　先打开有草稿的节点详情和一个模态框，依次关闭前景层和详情。草稿仍可恢复，窗口中焦点有明确归属。
- **现状证据**　未见 #291 对应改动

#### 040 input

**单行输入** · 接入 · 项目字段、对象设置 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/base/input/input.tsx)

- **设计**　名称、目录、说明与错误分别关联到输入，保留剪贴板、中文输入和原校验。保存失败保留已输值和焦点，路径禁止规则由已有验证给出。
- **验收**　输入超长名、无效目录和中文名称。问题在对应字段旁给出，修改有效后走原创建流程，已输入的其它字段不清空。
- **现状证据**　未见 #291 对应改动

#### 041 textarea

**多行输入** · 接入 · 核对、问题与备注 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/base/textarea/textarea.tsx)

- **设计**　多行输入允许换行，校验错误关联字段，必要时设可滚动上限。聊天继续复用带引用的编辑器，并保留各入口原有发送与换行规则。
- **验收**　输入长中文核对意见及换行后切换筛选再返回，草稿完整。为带 IME 的原生请求录入后，一次确认只产生一个提交。
- **现状证据**　未见 #291 对应改动

#### 042 checkbox

**复选框** · 接入 · 能力选项、模板准备 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/base/checkbox/checkbox.tsx)

- **设计**　勾选只改变对应 ID。若显示批量选择，部分选中反映当前集合，说明只作用于当前或全部结果的范围。禁用项解释原因。
- **验收**　三个能力中预选一项，检索后改选另一个。已选 ID 和数量准确，Tab/Space 可操作，禁用能力不会被批量动作修改。
- **现状证据**　相邻改动。能力目录的受控复选框与新增搜索、已选摘要共同工作，批量与部分选中契约未在该差异中加入。 [PersonalCapabilityFields.tsx](../../src/renderer/PersonalCapabilityFields.tsx)

#### 043 checkbox-card

**复选项卡片** · 条件 · 能力准备中的少量可选项 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/base/checkbox/checkbox-card.tsx)

- **设计**　每行提供能力名、来源、用途及禁用原因，整行映射同一复选。安装、覆盖及复用继续走模板准备的原状态与确认。
- **验收**　给出可用、需安装和失败三项，点击卡片与 Space 得到一致选择。勾选本身不会触发安装，失败项仍可单项重试。
- **现状证据**　未见 #291 对应改动

#### 044 radio

**单选** · 接入 · 互斥模式选择 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/base/radio/radio.tsx)

- **设计**　少量互斥且可见的选项使用同一单选组。改变选项只更新当前草稿或所定义的可逆偏好，表单动作由用户另行触发。
- **验收**　用方向键在三个合法选项间移动，每次仅一项选中。关闭未提交表单后原值不变，选择不触发创建或开始执行。
- **现状证据**　相邻改动。单选语义落在四套模板的单选卡内，证据与 045 共用。 [App.tsx](../../src/renderer/App.tsx)

#### 045 radio-card

**带说明的单选卡** · 接入 · 新建项目的四种内置模板 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/base/radio/radio-card.tsx)

- **设计**　以单选卡显示模板名、职责说明、节点数或准备提示。整卡与键盘单选行为一致，提交后使用所选模板及其能力准备规则。
- **验收**　用方向键切到 Web 产品团队，校验卡片与选中语义一致。提交只按该模板创建，能力准备状态真实。返回改选不产生多余项目。
- **现状证据**　对应改动。四套内置模板改成同一 `fieldset` 内的单选卡并展示说明。 [App.tsx](../../src/renderer/App.tsx)

#### 046 switch

**切换开关** · 条件 · 个人显示偏好样例 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/base/switch/switch.tsx)

- **设计**　仅在有实际持久化的可逆布尔偏好时采用开关。显示当前值、提交过程和保存错误。信息流排期启停仍通过现有渠道修改。
- **验收**　切换样例偏好并模拟保存失败，界面回到权威值或提示未确认。重开读取持久值，活动任务及排期不被改动。
- **现状证据**　未见 #291 对应改动

#### 047 switch-card

**带说明的切换行** · 条件 · 外观及显示偏好 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/base/switch/switch-card.tsx)

- **设计**　在行内放设置名、简短影响说明与真实开关，行点击与开关按键只触发一次。存在不可逆影响的动作另走确认。
- **验收**　点选文字、按空格及点击开关各切换一次。失去可用前提时说明原因，读屏可关联说明，错误后原设置仍可查。
- **现状证据**　未见 #291 对应改动

#### 048 theme-toggle

**主题切换** · 接入 · 外观设置 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/application/theme/theme-toggle.tsx)

- **设计**　复用现有三选项及存储键，主题立即可见。若试验渐变，只在宿主的非嵌入表层播放，减弱动态时直接应用新主题。
- **验收**　浅色、深色、紫色均可键盘切换并在重开后保留。打开文档或嵌入面板后文字、光标和焦点不因切换失效。
- **现状证据**　未见 #291 对应改动

#### 049 select

**单选下拉** · 接入 · Issue 状态和负责人 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/base/select/select.tsx)

- **设计**　固定值下拉显示当前选择、可用项及清除语义。真实已归档负责方若仍有记录，以现有名称或稳定 ID 显示。
- **验收**　仅用键盘先选「待处理」对应状态再选「未分配」，结果交集准确，选回相应「全部」只清除一项条件。
- **现状证据**　对应改动。Issue 新增原生状态和负责人下拉，两条件可组合或分别清除。 [ProjectManagement.tsx](../../src/renderer/ProjectManagement.tsx)

#### 050 slider

**滑块** · 接入 · 信息流推理档位 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/base/slider/slider.tsx)

- **设计**　滑块档数由模型实际返回的档位决定，注明当前档名。用左右键按一档步进，模型改变时由现有逻辑处理无效档位或默认值。
- **验收**　以两个支持档数不同的模型切换比较。每档文字、辅助技术值及持久值一致。档位缩减后不存在可选的旧档。
- **现状证据**　未见 #291 对应改动

#### 051 social-button

**第三方登录按钮** · 参考 · 账号登录 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/base/social-button/social-button.tsx)

- **设计**　示例只验证提供方标识、文字和连接状态。客户端登录继续使用现有 Codex 登录指令和其打开流程，来源与错误直接显示。
- **验收**　未登录、等待授权和失败样例中，产品只有可用的 Codex 登录入口。取消或失败后可以再次进入同一原生流程。
- **现状证据**　未见 #291 对应改动

#### 052 dropdown

**动作下拉菜单** · 接入 · 工作流行操作和低频命令 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/base/dropdown/dropdown.tsx)

- **设计**　以同组菜单容纳低频操作，触发器上显示是否展开。常用发送与运行控制保持可定位。危险菜单项打开已有确认。
- **验收**　在一处项目操作菜单键盘逐项打开、关闭，快速执行或取消不会重复发令。运行中的不可操作项给出原因，焦点稳定。
- **现状证据**　未见 #291 对应改动

#### 053 divider

**分隔线** · 接入 · 工具栏、选择列表与设置 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/base/divider/divider.tsx)

- **设计**　用间距建立主分组，仅在同一组内区分语义时用细线或栏目标题。装饰分隔退出键盘序列，必要的分组可由读屏理解。
- **验收**　在 100% 与 125% 检查操作分组和菜单危险区，分隔不抢焦点。高对比状态下项目级与节点级操作依然可区分。
- **现状证据**　未见 #291 对应改动

#### 054 file-upload

**附件选择与进度** · 接入 · 节点消息本地附件 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/base/file-upload/file-upload.tsx)

- **设计**　现有文件选择器会按既有规则将文件导入项目。目标先做好文件名、类型、移除及失败反馈。拖放、逐项混合结果和预览可分开纳入。若采用逐项反馈，保留并返回成功文件的 ID，每个失败项单独重选。只有可核实的字节进度显示比例。
- **验收**　文件选取和导入与消息派发分开验证。现有选择器失败保留此前已有附件并提示原因。扩展后以一张可用图片和一不可读取文件确认成功与失败逐项呈现，重试不重复导入成功项，发送前无额外派发或对外上传。
- **现状证据**　未见 #291 对应改动

#### 055 tabs

**页签** · 接入 · 节点详情的会话、配置、工作面板 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/base/tabs/tabs.tsx)

- **设计**　一组选项和相应 panel 有稳定关联，左右、Home、End 可切换，Tab 进入活跃面板。恢复页签时保留选中节点和已有编辑状态。
- **验收**　三栏只暴露活跃面板。编辑草稿后用左右键及 Home/End 循环切换，回到原栏目时草稿与选中节点还在。
- **现状证据**　对应改动。新增节点详情页签、面板关联和方向键、Home、End 行为。 [SessionPane.tsx](../../src/renderer/SessionPane.tsx)

#### 056 table

**基础表格** · 接入 · Issue 列表、数据摘要 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/base/table/table.tsx)

- **设计**　统一列标题、单位、对齐、行菜单和可滚区域。Issue 仍保留树形缩进与含义，窄栏的必需列优先，次级列能在详情查看。
- **验收**　对长中文标题、无负责人及深层子项检查缩放与水平滚动。键盘访问每行核心操作，滚动后可识别仍对应的行头与列头。
- **现状证据**　未见 #291 对应改动

#### 057 tooltip

**操作提示** · 接入 · 图标操作和快捷键 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/base/tooltip/tooltip.tsx)

- **设计**　悬停与键盘聚焦均可看到简短提示，Escape 隐藏，提示不接管焦点。操作名放在可访问名称，失败原因和运行状态还需直接可读。
- **验收**　对「展开节点详情」分别悬停、聚焦和按 Escape。提示对应当前动作，按 Escape 不误退工作台，屏幕阅读仍能读出按钮名。
- **现状证据**　相邻改动。新展开按钮带 `title` 和可访问名称，通用键盘可见提示仍需独立验证。 [Workbench.tsx](../../src/renderer/Workbench.tsx)

#### 058 counter

**数量标记** · 接入 · 待答、待审、队列数量 · [免费注册表](https://www.boardui.com/r/counter.json)

- **设计**　数量来自当前项目快照和明确的对象过滤，贴近栏目文字，即时反映权威总数。长数可以缩写，可访问名称和详情保留精确值。
- **验收**　以两条原生待回答、一条人工问题、一条待核对为样例，工作流入口显示总数 4，核对弹层的两类按钮分别显示 3 与 1。处理后重新读取，旧快照不重复计数。
- **现状证据**　对应改动。待回答和待核对按钮旁计算出类别数量，全部数量在工作流入口。尚无共用计数组件。 [Workbench.tsx](../../src/renderer/Workbench.tsx) · [SessionPane.tsx](../../src/renderer/SessionPane.tsx)

<a name="feedback"></a>

### 状态、提示和日期

#### 059 badge

**数量标记兼容名** · 维持 · 数字计数样式 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/base/badges/badge.tsx)

- **设计**　保留上游快照的别名条目，产品与 058 `counter` 共用同一数量样式和可访问名称。状态类短文字走 060 `chip` 的规则。
- **验收**　同一个数值以两种名称引用时展示、更新及读屏表现一致。检查产品里不存在因别名重复产生的第二个数量标签。
- **现状证据**　未见 #291 对应改动

#### 060 chip

**状态标签** · 接入 · Issue、工具结果和节点状态 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/base/badges/chip.tsx)

- **设计**　用短文字和语义色表达状态，选中、焦点与状态颜色各有用途。可删除的选择项使用带动作的标签，静态状态不冒充按钮。
- **验收**　在三套主题检查看似近色的「暂停」「待核对」「失败」。移除选择有可达按钮，静态状态保留文字且没有伪焦点。
- **现状证据**　未见 #291 对应改动

#### 061 status-dot

**小状态点** · 接入 · 节点列表和当前会话 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/base/badges/status-dot.tsx)

- **设计**　静态点紧贴状态文字。当前选中节点的真实活动允许局部提示，终止、暂停、排队、未知或历史记录均按权威状态显示。
- **验收**　两个节点分别运行与排队，切换查看并暂停运行节点。状态文字及时更新，只有前景真实活动有动态反馈，减少动态时静态点仍能分辨。
- **现状证据**　相邻改动。前景会话加入局部状态指示，远端及历史的状态仍各按原视图显示。 [SessionPane.tsx](../../src/renderer/SessionPane.tsx) · [Workbench.css](../../src/renderer/Workbench.css)

#### 062 avatar

**头像与首字** · 接入 · 会话条目与核对来源 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/base/avatar/avatar.tsx)

- **设计**　节点以名称或首字作为备用标识，角色颜色仅辅助，长名称能读全，历史上的已归档发起者按已有快照身份显示。
- **验收**　同名节点、无图片节点和已归档节点出现在同一历史样例中。用户可通过可读名称及对象定位分清来源，切换主题不丢身份信息。
- **现状证据**　未见 #291 对应改动

#### 063 breadcrumb

**路径导航** · 接入 · 嵌套 Issue、项目文档 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/base/breadcrumb/breadcrumb.tsx)

- **设计**　用父级 ID 生成路径，长路径保留末段与可回导航，点击上级沿用未保存保护和原项目范围。已失效层级有可读提示。
- **验收**　在四层目录和三层 Issue 先修改草稿，再用键盘跳父级。取消时留在原对象，确认后定位真实父级，改名后路径更新。
- **现状证据**　未见 #291 对应改动

#### 064 pagination

**分页** · 条件 · 信息流历史与结果分页 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/base/pagination/pagination.tsx)

- **设计**　信息流历史与成果沿用各自游标及数据范围，无可靠总页数时使用继续加载。项目会话历史按节点补齐并合并已有记录。如要新增该视图的分页，先定义一致的排序、存量与原生补齐契约。
- **验收**　依序加载两段信息流历史或结果，无重条。失败保留已有内容。项目历史样例中让一个节点补齐失败，其他节点和已持久化历史仍可读并标明失败节点。
- **现状证据**　未见 #291 对应改动

#### 065 carousel

**横向预览** · 条件 · 图片结果和附件预览 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/base/carousel/carousel.tsx)

- **设计**　多张本地图片在有预览需求时提供前后切换、当前位置、键盘导航与手动控制。保持图像比例，不做自动轮播。
- **验收**　在仅一张、混合成功和缺失、十张图片样例中测试首尾控制、缩放和退出。缺失文件有占位和原因，焦点返回原缩略图。
- **现状证据**　未见 #291 对应改动

#### 066 input-otp

**一次性验证码框** · 参考 · 独立验证码样例 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/base/input-otp/input-otp.tsx)

- **设计**　客户侧账号继续走现有登录流程。若以后有已确认的一次性验证码能力，支持整串粘贴、逐位修正、可访问名称和错误恢复。
- **验收**　样例内粘贴一串含前导零的代码，能退格改一位并读取错误。产品设置中没有额外验证码框，也不会收集第三方验证码。
- **现状证据**　未见 #291 对应改动

#### 067 segmented-control

**分段筛选** · 接入 · 待人工核对筛选 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/base/segmented-control/segmented-control.tsx)

- **设计**　一组只选「全部／待回答／待核对」之一。待答和待核对显示分项数量，总数可在工作流入口读取。切换过滤保留会话中的草稿、执行中的决定和可定位的行。
- **验收**　依次切三项并验证唯一选中。为待回答录入内容，切到待核对再切回，草稿还在。某类别为 0 时给出相应空态。
- **现状证据**　对应改动。核对列表加入全部、待回答、待核对三项互斥过滤，以 `aria-pressed` 暴露选中。 [SessionPane.tsx](../../src/renderer/SessionPane.tsx)

#### 068 announcement

**可关闭公告** · 参考 · 壳内版本资讯样例 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/base/announcement/announcement.tsx)

- **设计**　仅为有产品来源的一次性资讯提供正文、详情和关闭。按公告 ID 记录已关闭，关键任务、兼容或执行阻塞继续在相关工作对象旁说明。
- **验收**　关闭公告 A 后重启，A 不再弹出。新公告 B 可正常查看，存储与核对事件、错误状态互不影响。
- **现状证据**　未见 #291 对应改动

#### 069 notification

**单条通知** · 接入 · 保存失败、原生审批与运行反馈 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/base/notification/notification.tsx)

- **设计**　单条反馈显示事件类型、影响对象和时间。失败或要求决定时持续可见，允许已授权重试、打开原对象或返回待处理队列。
- **验收**　使同一文档保存失败并触发无关原生请求，两条分开呈现。重试成功只清除对应错误，未决定的请求不会因关闭页面被确认。
- **现状证据**　未见 #291 对应改动

#### 070 kbd

**快捷键键帽** · 接入 · 命令、菜单、编辑器提示 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/base/kbd/kbd.tsx)

- **设计**　键帽读取 Windows 当前实际快捷键。显示动作名、组合键顺序与冲突范围，只有已实现并能在该上下文触发的快捷键才展示。
- **验收**　检查菜单 Shift+F10、关闭 Escape、节点输入 Enter 和 Ctrl+Enter 与各入口实测行为一致。中文组词时不会误发送或跳转。
- **现状证据**　未见 #291 对应改动

#### 071 date-picker

**日期选择器** · 条件 · 单日采集或历史筛选 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/base/date-picker/date-picker.tsx)

- **设计**　输入与日历围绕一个本地日期选择，标明时间范围的时区，提供清除。文案说明无此日期数据和加载失败的差异。
- **验收**　选择某时区午夜边界前后的一天，验证只读取该当地自然日。直接输错日期可修正，清除后恢复原范围。
- **现状证据**　未见 #291 对应改动

#### 072 date-range-picker

**日期区间** · 条件 · 历史、成果范围筛选 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/base/date-picker/date-range-picker.tsx)

- **设计**　支持首尾日期和区间预览，呈现包含首尾的日期文案，查询用同一时区计算首日零时至末日下一日零时的半开区间。窄栏单月可完成。
- **验收**　用跨月与夏令时区间校验，最后一天晚间包含而次日零时排除。取消保持旧范围，倒序输入获得明确校验消息。
- **现状证据**　未见 #291 对应改动

#### 073 meeting-scheduler

**日期及时段选择** · 参考 · 单次排期样例 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/base/date-picker/meeting-scheduler.tsx)

- **设计**　可用样例组合日期、时区和可用时段。生产采用前须有明确单次执行契约，区分过期、冲突与夏令时重复时段。现有每日/每周计划在信息流「目标与计划」只读展示。
- **验收**　在样例选择过期和重叠的夏令时时段，能识别原因与 UTC 偏移。在真实采集对话修改周期后，目标与计划显示已受理的频率、时区和下一次运行。
- **现状证据**　未见 #291 对应改动

<a name="workspace"></a>

### 应用壳、会话和数据区

#### 074 agent-runtime

**聊天示例运行层** · 参考 · 原生会话边界 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/app/api/chat/route.ts)

- **设计**　真实桌面继续使用现有原生 Codex、快照、任务及持久化协议。设计样例经隔离的固定数据重放加载、错误和事件，保存和重开使用独立的样例状态。
- **验收**　在样例逐个触发发送、授权、附件、排期和图像生成，真实桌面 IPC、凭据、项目写入与进程调用计数均为零。真实项目另验原生回执、会话重连和日志。
- **现状证据**　未见 #291 对应改动

#### 075 agent-chat

**基础聊天工作区** · 接入 · 节点会话 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/application/agent-chat/agent-chat.tsx)

- **设计**　上下文、对话与输入栏共享空间和阅读顺序。用户在读旧消息时尊重滚动位置，有新输出时可主动回到最新，发送绑定当前节点。
- **验收**　流式追加时滚到历史，滚动位置保留且可返回最新。切换到另一节点后输入和历史由该节点决定，原生请求仍能处理。
- **现状证据**　相邻改动。现有节点聊天增加页签、局部执行提示与历史入口可达性，主聊天结构及原生传输沿原路径。 [SessionPane.tsx](../../src/renderer/SessionPane.tsx)

#### 076 app-shell

**应用外壳** · 接入 · 应用导航与工作台 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/application/app-shell/app-shell.tsx)

- **设计**　保持主导航、上下文导航和内容区层级。当可用宽度不足，折叠次级导航或让只读详情覆盖，工作流继续提供可操作画布。
- **验收**　在 1460×960、1280×800、1100×720 和 125% 显示缩放检查项目、笔记、信息流和设置，导航、主操作及退出均可达，无全窗口横向溢出。
- **现状证据**　未见 #291 对应改动

#### 077 agent-thinking

**等待回复指示** · 接入 · 前景节点状态 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/application/agent-thinking/agent-thinking.tsx)

- **设计**　将「等待回复」「正在执行」「暂停中」「等待续接」和未知状态分别映射到现有状态。局部动态由当前节点与轮次驱动，标签只表达执行阶段。
- **验收**　先触发原生执行，再暂停、恢复与中断。历史、失败、排队和没有确认的轮次保持正确文字，状态不会因动画误报，减少动态时无持续动画。
- **现状证据**　相邻改动。现有活动文字与局部指示绑定真实执行状态。无单独的思考计时或阶段推断。 [SessionPane.tsx](../../src/renderer/SessionPane.tsx) · [Conversation.tsx](../../src/renderer/Conversation.tsx)

#### 078 agent-log

**执行记录引导线** · 接入 · 执行活动与项目会话历史 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/application/agent-log/agent-log.tsx)

- **设计**　相邻工具事件可按项目、节点、线程和轮次分组，同组保有原始顺序及失败。项目历史沿用逐节点补齐与合并，含已移除节点，未知时间置后，缺少来源时定位到现有接收记录。
- **验收**　用两线程重名工具、同轮重试和失败验证分组。再进入项目历史确认记录可展开、补齐失败时仍可读已有内容，历史不重放活动动效。
- **现状证据**　相邻改动。只有与当前任务的线程和轮次一致的事件标为运行中。尚无新的同轮交互分组契约。 [Conversation.tsx](../../src/renderer/Conversation.tsx)

#### 079 composer-loader

**输入框环形加载** · 参考 · 会话输入区动效样例 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/application/composer-loader/composer-loader.tsx)

- **设计**　可用局部轮廓演示提交过程。产品当前状态优先用文字和局部短反馈，输入区即使在等待时也应反映真实可输入、可排队与禁用情况。
- **验收**　同时运行两节点的样例只有关注输入区可见局部反馈。将窗口置后台或启用减弱动态后不播循环装饰，用户仍能读到真实阶段与输入状态。
- **现状证据**　未见 #291 对应改动

#### 080 sidebar

**可折叠导航栏** · 接入 · 主图标栏与项目上下文栏 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/application/dashboard/dashboard-sidebar.tsx)

- **设计**　折叠保留同一入口图标和中文名称，支持恢复宽度与路径。当前入口、折叠入口、未保存保护和独立滚动区相互明确。
- **验收**　打开项目文档、折叠再展开栏，保持当前对象和可见选择。键盘可呼出折叠入口，返回项目仍经过现有导航保护。
- **现状证据**　未见 #291 对应改动

#### 081 settings-modal

**分栏设置** · 接入 · 账号、外观和供应商设置 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/application/settings/settings-modal.tsx)

- **设计**　从各自设置入口采用同样的标题、分区与正文层级。宽窗可用分栏，窄窗切换为顶部入口或单列。供应商配置继续从所属 ComfyUI 项目进入。
- **验收**　在三种尺寸访问全局账号、外观与项目供应商设置。切换分区不重提授权、不丢必要信息，返回仍在原入口的作用域。
- **现状证据**　未见 #291 对应改动

#### 082 auth-card

**登录表单块** · 参考 · 原生 Codex 登录反馈 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/application/auth/auth-card.tsx)

- **设计**　登录面板清楚呈现未连接、授权中、已连接、错误和重新登录。按钮绑定现有原生账号命令，所有表单仍由拥有身份流程的一方显示。
- **验收**　模拟授权取消和断开后，用户能返回设置并重试原生登录。已有项目、线程和本地文档不因 UI 切换被重置。
- **现状证据**　未见 #291 对应改动

#### 083 notification-center

**分类通知中心** · 接入 · 待人工核对入口 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/application/notification-center/notification-center.tsx)

- **设计**　总数由原生问题与项目人工核对记录推导。列表显示类别、来源、时间与可用动作，打开材料仅导航，只有明确且成功的决定改变处理状态。
- **验收**　同一待答同时在节点与核对入口可定位，按类别筛选后打开材料，仍显示待处理。提交失败或结果未知时保留草稿和原请求供恢复。
- **现状证据**　相邻改动。现有核对弹层新增按待答/待核对分类和空态。原生审批和一般通知继续从各自入口进入。 [SessionPane.tsx](../../src/renderer/SessionPane.tsx) · [HumanReviews.tsx](../../src/renderer/HumanReviews.tsx)

#### 084 data-grid

**可编辑数据网格** · 参考 · 批量编辑样例 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/application/data-grid/data-grid.tsx)

- **设计**　仅在未来真实存在单元格批量编辑工作时引入选区、撤销、列宽和虚拟滚动规则。在样例中以惰性数据模拟，生产 Issue 继续由对象操作和权限处理。
- **验收**　样例中多选、非法值校验、撤销与滚出再返回可验证。真实 Issue 不会通过拖选或批量粘贴越过原有状态、修订与派发规则。
- **现状证据**　未见 #291 对应改动

#### 085 data-table

**可排序数据表** · 接入 · Issue 列表和详情 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/application/data-table/data-table.tsx)

- **设计**　组合关键字、状态与负责人过滤，缩进保留匹配后代的祖先。详情和列表有独立选择，后续排序或分页以同级排序和稳定 ID 为前提。
- **验收**　用含不匹配父项、匹配子项、未分配和旧负责人样例验证过滤，清除一个条件后保持其它条件与当前可用选择，祖先不被当作命中结果。
- **现状证据**　相邻改动。Issue 现有树表新增组合筛选与祖先保留，证据覆盖筛选路径。通用表格排序、选择、分页未作为该次改动验收。 [ProjectManagement.tsx](../../src/renderer/ProjectManagement.tsx)

#### 086 stat-cards

**指标卡组** · 条件 · 项目或信息流概览 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/application/dashboard/stat-cards.tsx)

- **设计**　指标需要明确所属项目、时间窗、去重身份、单位和明细入口。首发可探索待回答、待核对和失败运行，数据未加载时说明，不以零代替。
- **验收**　构造 0、已知非零、未知三种结果，卡片有不同可读表达。打开明细的计数、筛选和统计窗口一致。
- **现状证据**　未见 #291 对应改动

#### 087 revenue-chart-card

**趋势面积图卡** · 条件 · 采集成果趋势 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/application/dashboard/revenue-chart-card.tsx)

- **设计**　复用面积趋势卡的标题、时段、单位和明细结构。业务数据取采集成果或运行记录，统计单位明确为成果数或执行次数。
- **验收**　滚动选两个月，样本中包含 0 项日期与记录缺失日期，显示准确区分。图表各点和可访问明细表按同一时区与口径对齐。
- **现状证据**　未见 #291 对应改动

#### 088 orders-chart-card

**同期柱状图卡** · 条件 · 采集周期对比 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/application/dashboard/orders-chart-card.tsx)

- **设计**　按两个实际可比区间展示执行次数等同单位柱组。当前和对照区间均写起止，重跑是否计入使用显式口径。
- **验收**　比较本周与上周的同样天数，在含重跑、无执行和数据缺失的样例中验证柱、图例、提示和明细表一致。
- **现状证据**　未见 #291 对应改动

#### 089 important-alerts-card

**重要提醒列表** · 接入 · 工作台或信息流的关键提醒 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/application/medical/important-alerts-card.tsx)

- **设计**　紧凑列表按严重程度和时间显示少量待处理事件，可定位到真实任务、采集或文档。状态和影响用文字，动作沿用拥有对象的页面。
- **验收**　同时放入保存失败、待回答和过往已解决记录，验证排序、过滤及原位置跳转，无权或找不到对象时给出原因并保留当前阅读位置。
- **现状证据**　未见 #291 对应改动

#### 090 patient-info-card

**对象摘要卡** · 参考 · 节点详情摘要样例 · [MIT 仓库快照](https://github.com/BoardUI/boardui/blob/ec5c5eb3e29c2441be63b9422cd54f411ef23466/components/application/medical/patient-info-card.tsx)

- **设计**　借用对象名加关键值列表的版式。用节点角色、当前模型、执行状态与最近实际活动组织样例，字段没有值时明确未提供。
- **验收**　长角色名、未分配模型和归档对象均可读，样例使用自有字段。真实客户端不从项目数据推断或录入医疗资料。
- **现状证据**　未见 #291 对应改动

<a name="agentic"></a>

### Pro 会话组件和日历

#### 091 web-search

**检索过程记录** · 条件 · 节点会话的检索记录 · [Pro 公开说明](https://www.boardui.com/components/web-search)

- **设计**　如原生事件提供可信的检索词、动作和链接，以同一轮次的时间顺序展示。检索动作、引用的文章和用户可点外部来源有明确区分。
- **验收**　用一次搜索、两次打开来源和一条失败事件检查。只有确认存在的来源可点击，数据库中仅有正文时也不会生成虚构的搜索轨迹。
- **现状证据**　未见 #291 对应改动

#### 092 task-list

**流式步骤清单** · 接入 · 当前执行与工具段落 · [Pro 公开说明](https://www.boardui.com/components/task-list)

- **设计**　按真实任务或工具事件显示当前、待执行、成功、失败等状态，支持查看来源及折叠完成项。可交互状态以已有任务数据或动作入口为边界。
- **验收**　给定三步且中间一步失败，失败原因仍可读，第三步按原事件显示未知或待执行。切到旧轮次不重复动画，点定位能回原任务。
- **现状证据**　未见 #291 对应改动

#### 093 composer

**完整会话输入区** · 接入 · 节点会话和信息流输入区 · [Pro 公开说明](https://www.boardui.com/components/composer)

- **设计**　节点输入呈现消息、引用或受支持的附件、实际接收节点与发送动作。信息流保留纯文本、原生模型及推理档位。消息进入队列、追加到当前轮次或等待确认均用各自回执表达。
- **验收**　在项目或 ComfyUI 支持的节点入口验证中文输入、附件及失败恢复。在信息流验证请求固定选定模型和档位，活动轮次处理与原规则一致，未知回执重试沿用原请求并保留新草稿。
- **现状证据**　未见 #291 对应改动

#### 094 composer-panel

**双行消息编辑面板** · 接入 · 节点消息编辑 · [Pro 公开说明](https://www.boardui.com/components/composer-panel)

- **设计**　上层为可换行的消息编辑与引用，下层为实际可用的附件或控制与发送。保留接收节点标签和各个输入区自己的快捷键，长消息滚动时主要动作仍可达。
- **验收**　在窗口最小尺寸与 125% 下录入三屏文本，切换配置再回来，滚动、参照及草稿正确，提交只走现有入口一次。
- **现状证据**　未见 #291 对应改动

#### 095 composer-attachments

**附件预览条** · 接入 · 支持附件的节点消息区 · [Pro 公开说明](https://www.boardui.com/components/composer-attachments)

- **设计**　先显示已导入的文件名、类型和移除操作，标识绑定项目、节点及输入。预览作为新增交互，仅对校验通过的媒体类型开放。移除后从当前草稿排除对应 ID，已发送材料继续由原生命周期管理。
- **验收**　添加两张同名文件、移除一张并切换节点，回来只保留正确 ID。发送回执与本轮历史只含所保留附件，预览缺失媒体时显示原因及重选入口。
- **现状证据**　未见 #291 对应改动

#### 096 agent-progress

**多步执行进度** · 接入 · 模板准备及已知阶段的任务 · [Pro 公开说明](https://www.boardui.com/components/agent-progress)

- **设计**　按权威记录列出状态、顺序和失败原因。允许折叠完成项。没有真实总步数时显示当前阶段与结果，重连后依真实状态重建。
- **验收**　同一草稿先显示检查、随后两项安装，模拟一项失败及重启。完成项保留已确认状态，失败可重试，未知执行不会被重标为完成。
- **现状证据**　未见 #291 对应改动

#### 097 agent-limits-card

**上下文与限额卡** · 条件 · 会话上下文及限额 · [Pro 公开说明](https://www.boardui.com/components/agent-limits-card)

- **设计**　只有原生运行时提供可靠的用量、上限或重置时点时才使用。标明单位、来源、作用域及数据时间。局部上下文量与账号额度分开呈现。
- **验收**　用有效 token 数据、未知分母及过时用量验证。无值时显示未提供，恢复后用真实数据刷新。不同节点的用量没有混算。
- **现状证据**　未见 #291 对应改动

#### 098 questionnaire

**分步问答卡** · 接入 · 原生多题请求与人工问题 · [Pro 公开说明](https://www.boardui.com/components/questionnaire)

- **设计**　逐题导航可单独用样例评审。正式入口沿用现有语义，人工问题单选点击即发送，自由输入交由提交按钮。原生题目按请求与题目 ID 暂存，答案完整时沿用点选或表单提交处理，不增加确认步骤。敏感答案遵循原请求生命周期。
- **验收**　人工单选一次点击发送一次，人工自由输入仅提交后发送。原生多题缺值时没有应答回执，全部给值后验证仅向该请求返回一次。过期时拒绝旧答案，失败按原生或持久核对的各自路径恢复。
- **现状证据**　未见 #291 对应改动

#### 099 calendar

**活动月历** · 条件 · 信息流计划概览 · [Pro 公开说明](https://www.boardui.com/components/calendar)

- **设计**　仅在明确需要跨采集排期概览时，按已有任务时区展示下一次安排及实际发生的运行，选中可回采集详情。周期规则继续由现有调度维护。
- **验收**　在周末、跨时区及夏令时放置两条计划与一次失败运行，界面能区分计划和实际。点击回到正确采集，不改动调度。
- **现状证据**　未见 #291 对应改动

<a name="charts"></a>

### Pro 图表

#### 100 earnings-chart-card

**柱图与周期切换** · 参考 · 周期柱图样例 · [Pro 公开说明](https://www.boardui.com/components/earnings-chart-card)

- **设计**　复用「时间范围→总量→按期柱→明细」顺序，用自有的运行次数数据演示单位和交互。金额和收入样例没有对应业务数据源。
- **验收**　样例切换周与月时，柱子的合计与当前标题总数一致。真实产品没有从运行次数推断收入或可用余额。
- **现状证据**　未见 #291 对应改动

#### 101 line-chart-card

**多序列折线图** · 条件 · 项目运行时长趋势 · [Pro 公开说明](https://www.boardui.com/components/line-chart-card)

- **设计**　等周期间用折线表示可追溯时长，执行时长与等待核对时长分线展示。截断、取消或未完成样本须有明确排除或标识规则。
- **验收**　给定两个完成样本、一条取消和一条等待样本，折线值与明细表及规则匹配。缺失区间不断言为 0，使用键盘查看每点数值。
- **现状证据**　未见 #291 对应改动

#### 102 contributions-card

**活动日历热图** · 条件 · 采集运行日历 · [Pro 公开说明](https://www.boardui.com/components/contributions-card)

- **设计**　按选择的时区把运行启动或成果完成时间归到日期，每次运行由唯一 ID 去重，标明定时、手动或补跑范围。
- **验收**　同一运行重复送达且存在午夜前后运行，日历计数保持准确。日期点击打开同范围明细，色阶、空白和缺失均可用文字解释。
- **现状证据**　未见 #291 对应改动

#### 103 radar-chart-card

**雷达图** · 参考 · 多维指标样例 · [Pro 公开说明](https://www.boardui.com/components/radar-chart-card)

- **设计**　用已定义量纲和相同方向的自有数据演示轴、范围与标注。只有指标可归一且结果可解释时考虑产品接入，节点能力或质量不生成推测评分。
- **验收**　两个轴量纲不一致或缺失时显示说明与原值，样例可逐轴读数。真实工作台没有由这些轴生成节点综合分。
- **现状证据**　未见 #291 对应改动

#### 104 radial-chart-card

**径向用量图** · 条件 · 有上限的用量 · [Pro 公开说明](https://www.boardui.com/components/radial-chart-card)

- **设计**　多个环分别显示指标名称、上限、当前值和相应单位。只存在一个额度时采用更易读的 023 线性用量，同一值口径一致。
- **验收**　样例提供一项已知额度和一项未知额度，只有已知项能形成比例环。放大显示时外部可读标签和顺序仍与环对应。
- **现状证据**　未见 #291 对应改动

#### 105 funnel-chart-card

**漏斗图** · 参考 · 单向流程统计样例 · [Pro 公开说明](https://www.boardui.com/components/funnel-chart-card)

- **设计**　只有存在同一批对象、单向阶段和固定统计窗时才计算相邻阶段比例。工作流回退与重试可用交接明细或流向图表达。
- **验收**　样例中计算 10→6→3 的同批比率。加入回流对象后单独说明适用性，真实工作流仍按规则显示回流且未输出错误转化率。
- **现状证据**　未见 #291 对应改动

#### 106 sankey-chart-card

**流向桑基图** · 条件 · 历史交接分布 · [Pro 公开说明](https://www.boardui.com/components/sankey-chart-card)

- **设计**　以已持久化的 `HandoffView` 或消息交接身份去重，按发送与接收节点聚合真实历史量。统计图作为只读分析，当前条件边走工作流原视图。
- **验收**　构造 A→B、B→A、孤立及归档节点的数据，聚合与明细可追溯。若循环无法清楚绘制，提供按方向的可访问表，当前可执行边不受影响。
- **现状证据**　未见 #291 对应改动

#### 107 stage-bars-card

**阶段横条** · 条件 · 当前任务状态分布 · [Pro 公开说明](https://www.boardui.com/components/stage-bars-card)

- **设计**　对同一快照按排队、执行、待核对、失败等真实任务状态分组，用横条与数值呈现。分类口径需对每条任务唯一，未知状态单列。
- **验收**　把混合状态任务逐一核数，点击每行只打开该类明细。任务跃迁一次后旧行减一、新行加一，跨项目计数保持独立。
- **现状证据**　未见 #291 对应改动

#### 108 bar-list-card

**排行横条** · 条件 · 按节点的工作量或失败量 · [Pro 公开说明](https://www.boardui.com/components/bar-list-card)

- **设计**　以稳定节点 ID 聚合、降序展示数值和来源，平局采用可重现顺序，长名字能够完整获取。归档节点在该统计范围内仍可追溯。
- **验收**　同名节点和并列值各自得到正确排序和可访问名称。点击任一行只打开该节点自身记录，数值与合计可核对。
- **现状证据**　未见 #291 对应改动

#### 109 area-chart-card

**多序列面积图** · 条件 · 任务按日状态趋势 · [Pro 公开说明](https://www.boardui.com/components/area-chart-card)

- **设计**　只有已有可信的历史状态或事件时才生成时间序列，标明总量/构成模式、所在时区和跨天运行计入规则。重试以不同的执行身份处理并说明。
- **验收**　用跨日、重试、缺记录样例核对两种显示模式。堆叠之和等于对应明细的分栏合计，缺记录点由占位或说明表示。
- **现状证据**　未见 #291 对应改动

#### 110 combo-chart-card

**柱线组合图** · 参考 · 运行次数与耗时对照样例 · [Pro 公开说明](https://www.boardui.com/components/combo-chart-card)

- **设计**　同一时间轴上并排校对次数与耗时，若并图则提供各自的轴及单位。窄区可拆为两个同范围图，键盘定位同一周期。
- **验收**　给定次数相同而耗时不同的周期，读数与两单位一一对应。缩窄后两个面板的时间范围和记忆的当前日期仍一致。
- **现状证据**　未见 #291 对应改动

#### 111 scatter-chart-card

**散点或气泡图** · 参考 · 输入量与时长诊断样例 · [Pro 公开说明](https://www.boardui.com/components/scatter-chart-card)

- **设计**　只用可追溯的同一运行 ID 配对输入量与时长，说明小样本、缺项、异常值及单位。保留查看单点来源，避免用图形暗示因果。
- **验收**　输入缺一个变量的记录和可用极值，缺项数可查，极值保持。读屏表和点提示显示同一 ID 的实际数据。
- **现状证据**　未见 #291 对应改动

#### 112 heatmap-chart-card

**矩阵热图** · 条件 · 节点 × 时段工作量 · [Pro 公开说明](https://www.boardui.com/components/heatmap-chart-card)

- **设计**　把运行量映射到节点与时间区段，图例标明单位和时区，缺失单独标识。提供数值表，并可查询某格对应的数据。
- **验收**　以两节点、一有值、一为零、一未知的几个时段校对矩阵。键盘和表格能找到同一记录集合，颜色不作为唯一线索。
- **现状证据**　未见 #291 对应改动

#### 113 steps-card

**周步数图** · 参考 · 七日对比样例 · [Pro 公开说明](https://www.boardui.com/components/steps-card)

- **设计**　借用周窗和逐日浏览布局。样例用既有术语标注「运行次数」或「已保存成果」，星期起点、时区和目标线仅在有真实目标时定义。
- **验收**　切换上周与本周，展示正确日期与单日数。合法的无目标样例没有暗示达标的线，产品无新建健康类指标。
- **现状证据**　未见 #291 对应改动

#### 114 sleep-score-card

**得分与分项卡** · 参考 · 指标分解样例 · [Pro 公开说明](https://www.boardui.com/components/sleep-score-card)

- **设计**　可演示总值和分项阅读顺序。真实项目若无公认评分契约，使用各执行结果与失败原因的并列数据。
- **验收**　样例中每一分项都能追踪值、单位和计算方法。对于真实节点，分项缺失不补出总分或质量等级。
- **现状证据**　未见 #291 对应改动

#### 115 activity-rings-card

**目标活动环** · 参考 · 目标环样例 · [Pro 公开说明](https://www.boardui.com/components/activity-rings-card)

- **设计**　多个目标只有都具备真实上限且单位清楚时才适用。样例包括进度、超过目标及无目标，图形与文字同一口径。
- **验收**　检查 0%、100%、125% 及没有目标。环可封顶或有超出提示，读数原样保留。非定长 Agent 执行不显示完成目标。
- **现状证据**　未见 #291 对应改动

#### 116 most-active-days-card

**按日活动环** · 参考 · 密集日期对比样例 · [Pro 公开说明](https://www.boardui.com/components/most-active-days-card)

- **设计**　借用纵向日期与逐行摘要。可用运行数与日期演示，不存在的目标值保持空白并有释义，行顺序有确定的时间或排行定义。
- **验收**　在无记录、并列最大值和跨月样例验证排序与读数。没有数据的日期与 0 可区分，能用键盘读取日期及指标。
- **现状证据**　未见 #291 对应改动

<a name="collaboration"></a>

### Pro 看板与多节点组件

#### 117 project-board

**看板组件** · 条件 · 统一 Issue 的状态视图 · [Pro 公开说明](https://www.boardui.com/components/project-board)

- **设计**　看板若接入，共用同一 Issue 数据与父级上下文，保留旧 T- 标识和 `closed` 状态。若获准编辑，跨列仅选择状态，完成、取消、关闭、重开须先按现有规则填写说明，再提交原对象版本与动作身份。
- **验收**　带未结束子项的父项无法完成或取消，重开结束祖先依既有规则处理。仅切列时父 ID 和树顺序不变。版本冲突能恢复旧列，成功更新后树表读到同一状态。
- **现状证据**　未见 #291 对应改动

#### 118 agent-avatar

**动态角色头像** · 参考 · 节点角色样例 · [Pro 公开说明](https://www.boardui.com/components/multi-agent-chat)

- **设计**　以 Mixcat 自有图形或首字区分角色，静态轮廓加名称。只把真实活动状态反馈到文字和现有状态点，不从表情猜测阶段。
- **验收**　三个名称相似的节点在高对比及减弱动态模式下仍可区分角色。历史记录头像与节点身份保持稳定。
- **现状证据**　未见 #291 对应改动

#### 119 agent-creator

**角色编辑侧栏** · 接入 · 节点创建和配置 · [Pro 公开说明](https://www.boardui.com/components/agent-creator)

- **设计**　按角色与名称、真实模型、能力和关联条件组织已有字段，节点原生工作目录来自所属项目。可编辑草稿，执行中的配置写入按原限制延后，并显示等待、保存及失败状态。
- **验收**　新建后读取持久配置，验证原生工作目录等于项目目录。运行中编辑仅留草稿，无提前写入。执行结束后按现有规则保存。丢弃未保存草稿不改 revision，刷新目录保留合法选择。
- **现状证据**　未见 #291 对应改动

#### 120 multi-agent-chat

**多 Agent 会话组件** · 接入 · 项目会话历史与节点定位 · [Pro 公开说明](https://www.boardui.com/components/multi-agent-chat)

- **设计**　只读跨节点视图展示发起者、接收者、所依据的交接及任务引用。找回所选消息或任务后，继续沟通从原节点的输入区进入，已有原生 `reply_to` 身份按协作命令契约解释。
- **验收**　两节点生成重名工具记录并互相交接，点击消息定位到正确源节点和任务或实际存在的接收记录。退出聚合历史后，按当前节点显式发送，草稿始终归属对应节点。
- **现状证据**　未见 #291 对应改动

<a name="templates"></a>

### Pro 整页模板

#### 121 template-multi-agent-chat

**多 Agent 工作区模板** · 条件 · 多节点工作区样例 · [Pro 公开说明](https://www.boardui.com/components/multi-agent-chat)

- **设计**　左区为节点/会话导航，主区为所选节点对话或项目历史，使用原有节点选择与定位语义。次级区域可放上下文，当前接收方持续可见。
- **验收**　在隔离样例完成三节点交接、选中历史消息定位和起草回复。切节点及时显示接收方，缩窄后从上下文返回保留原位置。
- **现状证据**　未见 #291 对应改动

#### 122 template-home-dashboard

**运营概览模板** · 条件 · 项目首页概览样例 · [Pro 公开说明](https://www.boardui.com/components/home-dashboard)

- **设计**　先提供可恢复的工作对象入口，必要时添加口径明确的小型指标区和可点明细。项目、Issue 或核对数量以各自来源呈现。
- **验收**　空项目、待处理、多项目样例能区分。顶部数值有时间范围及同口径明细，键盘可直接打开真实入口，首页项目列表仍可达。
- **现状证据**　未见 #291 对应改动

#### 123 template-project-board

**项目看板模板** · 条件 · Issue 页面布局样例 · [Pro 公开说明](https://www.boardui.com/components/project-board)

- **设计**　用状态分列、独立滚动与详情结合，沿用 117 的状态、版本和父级契约。窄窗通过紧凑列和详情返回导航。是否开放编辑随看板决定。
- **验收**　三列各有多条任务时打开并关闭详情，保留列位置和筛选。可编辑样例验证需说明、拒绝与成功三条状态路径，切回树表显示同一值且层级未变。
- **现状证据**　未见 #291 对应改动

#### 124 template-marketing

**营销仪表盘模板** · 参考 · 概览到明细的布局样例 · [Pro 公开说明](https://www.boardui.com/components/marketing-dashboard)

- **设计**　提取总览、同期变化和明细的顺序，用项目运行或采集成果样例演示。营销预算、渠道和转化字段需有独立业务需求才有生产入口。
- **验收**　样例内选择周期后摘要、图例和明细同步，缩放后阅读顺序稳定。实际项目不会从执行记录生成营销数据或字段。
- **现状证据**　未见 #291 对应改动

#### 125 template-finance

**财务仪表盘模板** · 参考 · 密集筛选与表格布局样例 · [Pro 公开说明](https://www.boardui.com/components/finance-dashboard)

- **设计**　用原生工作项样例验证工具栏、过滤项、摘要和密集可滚表格如何共存。现金流、资产及交易改为中性示例数据，不接入财务服务。
- **验收**　改变两个条件后摘要和行出现同一变化，清除一项保留其它项。可通过键盘打开对象，真实项目没有自动新增财务导航或表。
- **现状证据**　未见 #291 对应改动

#### 126 template-hr

**人力资源模板** · 参考 · 多对象摘要和列表样例 · [Pro 公开说明](https://www.boardui.com/components/hr-management)

- **设计**　学习头部摘要、状态分布与名单的分区写法，用节点/工作项的非个人样例复核密度。招聘、薪酬和组织数据属于独立业务范围。
- **验收**　样例的一组摘要可导航到对应节点样例列表，列宽与过滤正常。产品运行不会新增个人资料采集或员工入口。
- **现状证据**　未见 #291 对应改动

#### 127 template-medical-profile

**医疗报告模板** · 参考 · 对象详情布局样例 · [Pro 公开说明](https://www.boardui.com/components/medical-profile)

- **设计**　借用对象摘要、指标与活动历史分区，使用虚拟节点资料展示。原型和客户端均不需要真实医疗数据或健康评分。
- **验收**　在对象字段缺失、长名称和多段历史样例比较阅读顺序。样例功能不暴露医疗信息入口，点击一条记录可定位到其中的原对象。
- **现状证据**　未见 #291 对应改动

#### 128 template-ai-chat

**聊天与上下文分栏模板** · 条件 · 对话与工作面板的组合样例 · [Pro 公开说明](https://www.boardui.com/components/ai-chat)

- **设计**　左侧会话导航、中间原生会话、右侧工作面板或项目资料。使用既有节点身份和面板宿主。窄窗口保留主要会话，辅助列可折叠或跳转再返回。
- **验收**　同一节点打开工作面板、写长消息、切回预览，草稿与当前面板对象不变。编辑器的快捷键按当前焦点生效，宿主页面无法把输入误发给其它节点。
- **现状证据**　未见 #291 对应改动

#### 129 template-ai-profile

**Agent 活动档案模板** · 条件 · 节点活动概览样例 · [Pro 公开说明](https://www.boardui.com/components/ai-profile)

- **设计**　在有跨会话数据时组合节点简介、真实活动量和可追溯历史。角色字段来自节点定义，计量按 097 和 102 的来源、时区和单位规则。
- **验收**　用活跃、无历史和归档节点样例核对归属。历史缺失时不填推测值，图表与该节点明细一致，返回会话保持项目上下文。
- **现状证据**　未见 #291 对应改动

#### 130 template-ai-image-generation

**图像生成模板** · 条件 · ComfyUI 工作区样例 · [Pro 公开说明](https://www.boardui.com/components/ai-image-generation)

- **设计**　将提示输入、实际队列或生成状态、可访问媒体及历史结果靠近组织。继续使用现有 ComfyUI 图、供应商和文件契约，保留原生输出与权限。
- **验收**　验证无模型、排队、执行失败和成功输出样例。成功对象可定位原节点和文件，失败则显示原因，静态样例不启动 GPU 或创建真实任务。
- **现状证据**　未见 #291 对应改动
