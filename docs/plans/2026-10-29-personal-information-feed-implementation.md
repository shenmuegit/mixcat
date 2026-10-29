# Personal Information Feed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 仓库同时要求官方 mattpocock-skills:implement、tdd、code-review、pr；执行前读取当前技能。按 AGENTS.md 的既有授权完成交付。

**Goal:** 交付独立于项目的个人文本信息流，每个采集任务拥有独立 Codex 对话，采集/调研成果统一入流，并支持手动及每日/每周运行。

**Architecture:** 新增独立 FeedStore 与 FeedEngine，由现有 WorkflowEngine 组合并共享唯一 SharedAccount；不创建虚拟项目或节点。复用 CodexPort、现有 HTTP MCP 安全边界和文本呈现，个人更新通过独立的订阅通道传递，避免改写项目增量快照协议。任务队列、原生执行与定时触发共用一套持久化运行记录。

**Tech Stack:** Node.js >=24、TypeScript、node:sqlite、Electron、React、marked、现有 MCP SDK 与 Codex app-server；首版不新增依赖。

**Spec:** [已确认界面与流程](../design/2026-10-29-personal-information-feed.md)。Issue：[shenmuegit/mixcat#114](https://github.com/shenmuegit/mixcat/issues/114)。调查基线：`b639997146794db6f0b938608b06bb2d73030364`；这是规划基线，执行时须重新核实远端 main 并记录实际审查基线。

## Global Constraints

- “首版只支持文本，暂不做项目关联。”正文为文本/Markdown；来源 URL 是元信息，不引入 PDF、图片或网页阅读器。
- “每个采集任务有自己的 Codex 对话，采集结果汇总到同一个信息流。”普通聊天回答留在对话，明确采集/调研成果经保存回执入流。
- 宽窗口列表和阅读器并排；窄窗口切换阅读并恢复筛选、选择、滚动和草稿。
- 原始文本、AI 摘要与用户备注分开；重复发现不改变首次收集排序、阅读、收藏或备注；删除后不被自动收回。
- 长期说明仅显式编辑，下次运行生效；手动采集与定时均采用保存的说明，临时追问不能成为长期要求。
- 同任务串行；停止本次使现有队列待继续，暂停定时撤销未开始的自动触发；未知执行不得自动重放。
- 数据、工作树、测试 profile、截图和日志均留在所属仓库内，拒绝 C 盘、链接祖先与项目外路径。复用 paths.ts 的真实路径检查。
- 原生模型、skills/plugins、MCP 与原生确认继续有效；个人 MCP 工具边界不被描述为对原生文件能力的强隔离。
- 所有新增/修复按 Issue → 临时分支 → 实现与验证 → 两轴审查 → PR → 合并 → 最终 main 构建和真实客户端重启执行。

## Review Focus

1. 回执丢失与同 URL 重复/已删除条目：请求重放不重复计数，内容去重不复活条目或覆盖个人状态；Task 1/4。
2. turn/start 回包前停止、原生断线、旧连接迟到事件：不能多开轮次或把未知执行当作漏跑；Task 3/5。
3. 定时到期与暂停/停止同时发生、睡眠跨多次计划、夏令时重叠：只持久受理一次应执行任务，尊重队列待继续；Task 6。
4. 切项目/个人入口与延迟查询/备注保存并发：个人状态和未保存文字不被旧结果覆盖；Task 2/7。
5. 来源文本中的 HTML、危险链接、伪造来源身份或越任务 MCP 写入：安全呈现与运行归属校验同时成立；Task 1/3/4。

## 执行准备与任务顺序

本文件只安排未来实施，勾选项不是已执行记录。开工时核实 #114 的最新正文、Agent Brief 和评论，检查本地状态；共享目录可能有并行任务，禁止切走其分支。使用项目内 `.worktrees/issue-114-personal-feed/`（若确需工作树）及 `codex/issue-114-personal-feed`，从重新核实的 main 建立，记录 baseline SHA。将本次设计/计划准确带入该分支。

按 Task 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 执行。每项实现与针对性验证后提交；共享接入点较多，采用逐任务实现、独立复核，避免多个实现者同时编辑 engine/App。Task 8 末运行一次完整测试；之后仅在新改动、失败或审查问题需要时重跑相应检查。

## 文件与数据边界

| 文件 | 职责 |
|---|---|
| 新 `src/shared/feed.ts` | Feed DTO、用户命令 union、入库参数/回执、个人快照；下文接口的唯一命名来源 |
| 新 `src/core/feed-store.ts`、`feed.ts` | SQLite 存储/事务/版本与个人领域服务；组合运行与调度 |
| 新 `src/core/native-runtime.ts` | 从现有 engine 提取共享账号绑定、连接代际、原生请求刷新与关闭能力 |
| 新 `src/core/mcp-transport.ts`、`feed-mcp.ts` | 共用 HTTP 安全传输；独立个人工具目录、身份和保存入口 |
| 新 `src/core/feed-runtime.ts`、`feed-scheduler.ts` | 采集原生 Thread/Turn、队列/恢复；可注入时钟的日/周计划计算 |
| 改 `src/core/engine.ts`、`worker.ts`、`src/shared/types.ts` | 全局命令路由、FeedEngine 生命周期、回复 DTO 与独立个人通知 |
| 改 `src/desktop/main.ts`、`preload.ts` | 个人订阅 IPC、个人草稿退出保护；电源恢复触发重新核对计划 |
| 新 `src/renderer/FeedWorkspace.tsx`、`FeedReader.tsx`、`FeedCollection.tsx`、`feed.css` | 信息流列表/阅读、采集列表与详情；使用现有控件和字型 |
| 改 `src/renderer/App.tsx`、`NativeRequests.tsx`、`src/shared/conversation-order.ts` | 应用入口；请求视图只接收需要的字段；会话排序仅泛化共同排序字段 |
| 复用 `paths.ts`、`codex.ts`、`account.ts`、`ProjectMarkdown.tsx`、`native-requests.ts` | 路径、传输、账号、文本渲染和原生响应校验；不另造对应系统 |

所有个人持久数据放 `<workbenchRoot>/.runtime/client/feed/`：`feed.sqlite` 为领域库；`collections/<id>/workspace/` 为采集工作目录，其 `.codex/` 为该任务的原生 home。每任务惰性建立一个原生连接与固定 Thread，共享应用账号。已有项目目录索引不登记采集任务。

FeedStore 使用与 ProjectStore 相同的 SQLite WAL/FULL、schema version、单写实例与事务失败语义。保存 `entries`、`collections`、`runs`、`conversation_entries`、`discoveries`、`receipts`、`drafts` 及 revision 元信息；正文不复制到 Markdown 文件形成第二权威。列表分页读取摘要，按需读正文/历史，不在每次推送中携带全部内容。

## 固定接口与实施默认值

以下是构建者选定的工程默认值，不称为用户逐项指定。类型都在 `src/shared/feed.ts` 定义，后续任务不得另起同义字段。

```ts
type FeedActor = { kind: 'user' } | { kind: 'agent'; collectionId: string; runId: string; threadId: string; turnId: string; callId: string };
type FeedSchedule = { frequency: 'manual' } | { frequency: 'daily' | 'weekly'; time: string; weekday?: number; timeZone: string; enabled: boolean };
type FeedRunStatus = 'queued' | 'starting' | 'running' | 'needs_input' | 'stopping' | 'completed' | 'partial' | 'failed' | 'stopped' | 'needs_reconciliation';
type FeedDraft = { key: string; text: string; revision: number; updatedAt: string };
type FeedEntryInput = { title: string; body: string; aiSummary?: string; sourceUrl?: string; publishedAt?: string; coverage: 'full' | 'partial' | 'excerpt'; referenceEntryIds?: string[] };
type FeedReceipt = { accepted: true; requestId: string; entryId: string; outcome: 'new' | 'duplicate' | 'suppressed_deleted'; revision: number };
type FeedQuery = { text?: string; view?: 'all' | 'unread' | 'saved' | 'trash'; collectionId?: string | 'manual'; cursor?: string; limit?: number };
type FeedPage<T> = { items: T[]; nextCursor: string | null; revision: number };
type FeedConversationEntry = Omit<ConversationEntry, 'nodeId' | 'taskId' | 'source' | 'messageId' | 'replyTo' | 'sentMessage'> & {
  collectionId: string; runId: string | null;
  source: { kind: 'user' | 'agent' | 'system' | 'unknown'; name?: string } | null;
};
```

- `FeedEntry`：`id,title,body,aiSummary,sourceUrl,publishedAt,coverage,referenceEntryIds,firstCollectedAt,updatedAt,readAt,starred,note,revision,deletedAt`；可空值用 null，不猜发布时间。`FeedEntrySummary` 只省略 body 与 note，提供 excerpt。
- `FeedCollection`：`id,name,instruction,instructionRevision,sourcePreferences,capabilities,threadId,schedule,nextDueAt,queueHeld,revision,deletedAt`。`capabilities` 复用 `Pick<NodeDefinition,'model'|'skills'|'plugins'>` 的配置形状，不建立假 Node。删除为软删除，保留线程与结果来源记录。
- `FeedRun`：`id,collectionId,trigger,status,instructionSnapshot,instructionRevision,inputSnapshot,threadId,turnId,previousTurnIds,coverageWindow,startedAt,finishedAt,sourceOutcomes,error,revision`。trigger 为 manual/scheduled/catchup/message/research；inputSnapshot 为保存的文字和所选文本材料，保持此次输入可追溯。
- `FeedSnapshot`：`generation,revision,unreadCount,collections,runsNeedingAttention,storageError`，仅概要。个人 `generation/revision` 独立于项目，启动时持久递增 generation；任务详情/历史/条目正文用查询取得。
- `FeedCommandResult`：`{snapshot:FeedSnapshot;entry?:FeedEntry;entries?:FeedPage<FeedEntrySummary>;collection?:FeedCollectionDetail;history?:FeedPage<FeedConversationEntry>;draft?:FeedDraft|null;receipt?:FeedReceipt}`。现有 AppReply 增加 `feed?:FeedCommandResult`，由 WorkflowEngine 包装现有应用 snapshot；FeedEngine 本身不依赖 ProjectState/AppSnapshot。
- `FeedCollectionDetail`：`{collection:FeedCollection;runs:FeedPage<FeedRun>;results:FeedPage<FeedEntrySummary>;history:FeedPage<FeedConversationEntry>;requests:(NativeServerRequest & {key:string;collectionId:string})[];runtime:RuntimeStatus|null;catalog?:CapabilityCatalog}`；catalog 采用现有能力目录类型。正文/历史分页独立游标，不用静默截断代替分页。
- 每条正文 UTF-8 上限 256 KiB、标题 512 字符、摘要/备注/说明 131072 字符，查询页 1–200（默认 50）、资料多选最多 50；超限返回明确错误，保留输入。
- URL 只接受 http/https，拒绝 userinfo；仅规范化主机大小写、默认端口与片段，保留路径及查询的内容含义。相同 URL 去重只追加发现记录，既有正文不自动覆盖。无 URL 的自动资料用规范换行后的精确 body SHA-256；手动保存的独立笔记不因相同文字自动合并。
- 回执键为 `(user,requestId)` 或 `(collectionId,runId,requestId)`；相同参数重放返回原回执，不同参数冲突。重放先核实原运行身份，允许返回已受理的同一请求回执，但已过期 Turn 不能进行新写入。删除 tombstone 可识别重复来源，只有用户恢复才重新出现。
- `FeedCommand` 为严格判别 union：`feed_snapshot`、`search_feed_entries(query)`、`get_feed_entry(entryId)`、`update_feed_entry(mutation)`、`get_feed_collection(collectionId)`、`read_feed_history(collectionId,cursor?)`、`create_feed_collection(input)`、`update_feed_collection(mutation)`、`run_feed_collection(collectionId,requestId)`、`send_feed_message(collectionId,text,entryIds,requestId)`、`cancel_feed_run(runId,requestId)`、`stop_feed_run(runId,requestId)`、`continue_feed_queue(collectionId,requestId)`、`reconcile_feed_run(runId,requestId)`、`respond_feed_native(collectionId,requestKey,result)`、`read_feed_draft(key)`、`save_feed_draft(draft,expectedRevision,requestId)`。每种变更只接受自身参数。
- `FeedEntryMutation`：createText(input,requestId)、setRead(id,read,expectedRevision,requestId)、setStarred(id,starred,expectedRevision,requestId)、saveNote(id,note,expectedRevision,requestId)、delete/restore(id,expectedRevision,requestId)、saveAnswer(collectionId,conversationEntryId,title,requestId)。最后一项由服务端读取已保存会话文本，不能伪造回答归属。
- `FeedCollectionCreate`：`{name?:string;instruction:string;sourcePreferences?:string;entryIds?:string[];capabilities?:FeedCollection['capabilities'];requestId:string}`，原子创建与首次入队，初始 schedule=manual。`FeedCollectionMutation`：rename、instruction、capabilities、schedule、pauseSchedule、resumeSchedule、delete、restore，均带 id/expectedRevision/requestId；schedule 生效时原子更新 nextDueAt。
- 删除/恢复永不物理清除历史；备注与草稿保存采用 revision，旧保存响应不能覆盖新输入。删除后的来源引用保留标题及删除提示，不能悄悄换成其他文本。
- 仅两个 feed 运行可并行、每任务一个活动轮次，属于内部默认上限；项目执行额度与能力不因此改变。调度每 30 秒核对一次，启动和系统恢复立即核对。

## Task 1: 独立个人存储与文本领域操作

执行预检裁定：Task 1 先交付文本/状态/草稿及 schema 约束；saveAnswer 随 Task 4 的持久会话记录实现。Task 2 提前建立 FeedEngine 最小命令/lifecycle 外壳，Task 4 扩展同一类。运行状态补充 cancelled（仅撤回排队输入）；queued 采集在原子进入 starting 时冻结当时保存的长期说明，已 starting/running 的说明不再变化。FeedEntry 完整详情需提供 discoveries 与 reference summaries；当前文字条目的 source 导航元数据由后续 Task 4 补全，不伪造采集任务。

**Files:** 新 `src/shared/feed.ts`、`src/core/feed-store.ts`、`src/core/feed.ts`、`tests/feed-store.test.ts`、`tests/feed.test.ts`；复用 `paths.ts` 和 `store.ts` 的约束。

**Interfaces:** `new FeedStore(workbenchRoot:string)`；`new FeedService(store:FeedStore)` 提供 `query(query:FeedQuery):FeedPage<FeedEntrySummary>`、`getEntry(id:string):FeedEntry`、`mutate(input:FeedEntryMutation,actor:{kind:'user'}):FeedReceipt`、`saveResult(requestId:string,input:FeedEntryInput,actor:FeedActor):FeedReceipt`、`readDraft(key:string):FeedDraft|null`、`saveDraft(input:Pick<FeedDraft,'key'|'text'>,expectedRevision:number,requestId:string):FeedDraft`。存储事务接口 `transaction<T>(operation:()=>T):T`，异常回滚；初始对象 revision=1，新草稿预期版本=0，后续必须精确匹配；时间由服务端产生。

- [ ] **1. 写失败测试。** `duplicate_preserves_personal_state`、`receipt_replay_survives_restart`、`deleted_source_is_suppressed`、`save_failure_is_atomic`、`stale_note_rejected`、`path_links_rejected`，用真实项目内 SQLite 临时目录。关键断言：
  ```ts
  assert.equal(repeated.outcome, 'duplicate'); assert.equal(after.firstCollectedAt, before.firstCollectedAt);
  assert.equal(after.note, '我的备注'); assert.equal(after.starred, true); assert.equal(after.readAt, before.readAt);
  assert.deepEqual(replayedReceipt, originalReceipt); assert.equal(query({view:'all'}).items.length, 1);
  assert.equal(deletedReceipt.outcome, 'suppressed_deleted'); assert.equal(query({view:'all'}).items.length, 0);
  ```
- [ ] **2. 运行并确认失败。** `powershell -NoProfile -File scripts/dev.ps1 test tests/feed-store.test.ts tests/feed.test.ts`；初次预期缺失模块/行为断言失败，不能以测试脚本错误充当有效红灯。
- [ ] **3. 实现上述接口。** 校验输入、SQLite 事务/持久回执、内容与发现去重、来源时间、read/starred/note、删除恢复、分页排序、全文字段搜索与草稿；并测数据库损坏/写入失败、源链接危险协议、无来源精确去重和用户不能伪造 agent actor。
- [ ] **4. 用同一命令验证通过。** 增加重开数据库后内容/回执/草稿仍在、并发 writer 被拒绝、重复请求不增加发现计数的断言；顺序稳定为 firstCollectedAt DESC、id DESC。
- [ ] **5. 提交。** 仅暂存本任务明确文件，提交 `feat(feed): persist personal text entries and user state`。

## Task 2: 个人命令通道与可用的文本阅读界面

**Files:** 改 `src/core/engine.ts`、`worker.ts`、`src/shared/types.ts`、`src/desktop/main.ts`、`preload.ts`、`src/renderer/App.tsx`；新 `src/renderer/FeedWorkspace.tsx`、`FeedReader.tsx`、`feed.css`、`tests/feed-commands.test.ts`、`tests/feed-renderer.test.ts`、`tests/feed-electron.mjs`。

**Interfaces:** 在读取 command.projectId 之前分发 `FeedCommand`。`DesktopApi` 增加 `subscribeFeed(listener:(snapshot:FeedSnapshot)=>void):()=>void`、`setFeedUnsaved(dirty:boolean):Promise<void>`；沿已有 command 通道返回 query/detail/draft。worker 发 `type:'feed_snapshot'`，desktop/preload 独立转发，不加入项目 `AppUpdate` delta。`FeedWorkspace` 接收 `snapshot, execute, onError`，父层保存导航/选择/滚动；`FeedReader` 接收 entry 与 typed mutation 回调。

- [ ] **1. 写失败测试。** 无项目的初始应用仍可 `createText` 并查询；项目 snapshot/delta 不清除个人状态；乱序 `getEntry/saveNote` 不回填旧内容；Markdown 原始 HTML 和危险链接不能执行。
- [ ] **2. 验证红灯。** `powershell -NoProfile -File scripts/dev.ps1 test tests/feed-commands.test.ts tests/feed-renderer.test.ts`，预期缺少个人命令/页面入口的断言失败。
- [ ] **3. 实现内容页。** 全部/未读/收藏/回收入口、搜索与任务/手动筛选、阅读器、保存文本及来源、备注自动保存、删除确认与 8 秒撤销入口、回收恢复；明确标未读不会被同一个已打开 reader 的 effect 立即清除。查询使用递增请求序号，草稿 revision 与界面当前文本分开。页面只复用安全 Markdown 渲染，不依赖项目引用解析。
- [ ] **4. 验证。** 上述单元命令 PASS；`powershell -NoProfile -File scripts/dev.ps1 build` 后 `powershell -NoProfile -File scripts/dev.ps1 test tests/feed-electron.mjs`，真实 Electron 验证无项目入口、打开/关闭恢复焦点和滚动、收藏/已读、内容过滤、切页/重开后的草稿以及保存失败保留输入。fixture 路径全部在仓库 `.runtime/implementation/feed/`。
- [ ] **5. 提交。** `feat(feed): add personal text reading workspace`。

## Task 3: 提取原生连接与 MCP 传输的最小共用边界

**Files:** 新 `src/core/native-runtime.ts`、`mcp-transport.ts`、`tests/native-runtime.test.ts`；改 `src/core/engine.ts`、`mcp.ts`；回归 `tests/runtime.test.ts`、`account-global.test.ts`、`native-contracts.test.ts`、`mcp.test.ts`。

**Interfaces:** `openNativeRuntime(options:NativeRuntimeHostOptions):Promise<NativeRuntimeHandle>`；options 含现有 NativeClientOptions 的 executable/cwd/home、`mode:'codex'|'demo'`、`account:SharedAccount`、nativeFactory、`isCurrent:()=>boolean`、onEvent/onRequest/onDisconnect 和 `onStatus:(status:RuntimeStatus)=>void`；handle 提供 `client:CodexPort,status:RuntimeStatus,ensureAccount():Promise<void>,close():Promise<void>`。`startMcpTransport<I,C>(options:{resolveIdentity:(token:string)=>I|undefined;toolsFor:(identity:I)=>Tool[];contextFor:(identity:I,meta:unknown)=>C;invoke:(name:string,args:Record<string,unknown>,context:C)=>Promise<unknown>}):Promise<{url:string;close():Promise<void>}>`；Tool 为 SDK 工具类型，工作流 edge 转换仍留在原 mcp.ts adapter。各 adapter 在 invoke 前区分读取与写入，写入必须有有效 native thread/turn/call 元数据，不能因抽取泛化而取消该校验。

- [ ] **1. 写失败测试。** 对新宿主重复 close 只关闭一次、认证并发只共享一个账号刷新、resolved/旧代际 refresh 不响应新连接、未实现宿主请求明确拒绝；传输保留 Host/Origin/Bearer/请求大小/工具白名单。输入原生时间请求仍使用真实当前秒数。
- [ ] **2. 验证红灯。** `powershell -NoProfile -File scripts/dev.ps1 test tests/native-runtime.test.ts`；新入口未定义应失败。
- [ ] **3. 搬移而非重写。** 共用账号绑定、刷新撤销、代际判定、错误与 closePromise；项目/node/人工核对/pump 仍由原 engine 管理。HTTP transport 提取不放宽工具权限、错误回执和断连清理；metadata 解析保留 native thread/turn/call 的真实性校验。WorkflowEngine 仍拥有唯一 SharedAccount，后续注入给 FeedEngine，无需新增应用框架。
- [ ] **4. 验证。** `powershell -NoProfile -File scripts/dev.ps1 test tests/native-runtime.test.ts tests/runtime.test.ts tests/account-global.test.ts tests/native-contracts.test.ts tests/mcp.test.ts` 全部通过，再执行 typecheck；原项目 request/refresh/暂停相关回归不能跳过。
- [ ] **5. 提交。** `refactor(runtime): share native connection and MCP transport boundaries`。

## Task 4: 独立采集对话与受管结果入流

**Files:** 新 `src/core/feed-runtime.ts`、`feed-mcp.ts`、`tests/feed-runtime.test.ts`、`feed-mcp.test.ts`；改 `feed.ts`、`feed-store.ts`、`engine.ts`、`src/shared/feed.ts`。

**Interfaces:** `FeedEngine({store,account,executable,nativeFactory?,onSnapshot})` 提供 `init():Promise<void>,command(command:FeedCommand):Promise<FeedCommandResult>,subscribe(listener):()=>void,close():Promise<void>`。`CollectionRuntime` 使用 Task 3 handle；每任务一个 threadId。`recordFeedNativeItem(store:FeedStore,collectionId:string,runId:string|null,threadId:string,turnId:string,item:unknown,completed:boolean,createdAt:string):FeedConversationEntry` 留在 feed-runtime.ts，复用 history.ts 的 `contentText`，不传假 ProjectState 给 `nativeItem`。个人工具：`get_collection_context()`、`search_feed_entries(query)`、`get_feed_entry({entryId})`、`save_feed_result({requestId,...FeedEntryInput})`、`record_feed_source_failure({requestId,url,reason})`。`FeedMcpIdentity={token,collectionId}`；运行时从 native metadata 派生 FeedActor，参数不得指定 run/actor/其他 collection。

- [ ] **1. 写失败测试。** 无项目创建 A/B，断言 threadId 不同；A 第二次采集 resume 原 Thread；原子 create+enqueue 请求重放不创建第二任务；MCP 保存失败不计新增；冒用 B/旧 Turn 拒绝新写；对话文字中声称“已保存”不产生条目。
- [ ] **2. 验证红灯。** `powershell -NoProfile -File scripts/dev.ps1 test tests/feed-runtime.test.ts tests/feed-mcp.test.ts`。
- [ ] **3. 实现一次性端到端链路。** `create_feed_collection` 原子保存任务/首次输入；复制 inputSnapshot 和说明版本后启动；延续已有插件准备、Windows readiness、native 账户校验、skill/plugin mentions、真实模型与权限回执、早到 Thread/Turn 事件绑定。共享账号恢复/登录完成唤醒等待账号的个人队列，但不绕过 queueHeld 或待核对状态。保存结果、发现、source failure 与 request receipt 在同一事务，计数从数据库产生。素材在推理中是待分析数据，不作为系统指令；普通 message 模式默认只聊天。
- [ ] **4. 验证通过。** 受控原生 fixture 覆盖登录/插件/权限请求，以及 loopback MCP 实际 HTTP 调用；失败/部分成功/零新增有不同结果。输入材料提交时校验未删除并保存当时文本；历史按 thread/turn/item 身份去重，用户原输入与附加说明可区分，终态正文不能被迟到 inProgress 或历史回填覆盖。保留未知时间与真实 collection/run/thread/turn/call，历史按需分页。
- [ ] **5. 提交。** `feat(feed): collect text through independent Codex conversations`。

## Task 5: 串行队列、停止、请求回应与重启恢复

**Files:** 改 `feed-runtime.ts`、`feed.ts`、`feed-store.ts`、`engine.ts`、`src/shared/feed.ts`；新 `tests/feed-controls.test.ts`、`feed-recovery.test.ts`。

**Interfaces:** `enqueueCollectionRun(collectionId:string,input:FeedRunInput,requestId:string):FeedRun`，其中 FeedRunInput 为 `{trigger,text,entryIds,coverageWindow?}`；`stopRun(runId:string,requestId:string):Promise<void>`、`continueQueue(collectionId:string,requestId:string):Promise<void>`、`reconcileRun(runId:string):Promise<FeedRun>`、`respondNative(collectionId:string,key:string,result:unknown):Promise<void>`。每条 command 都经 Task 4 FeedEngine 统一调用。

- [ ] **1. 写失败测试。** A1 正运行、A2 排队、B1 可独立执行；停止 A1 后 A2 仍 queued 且 queueHeld=true，重开库仍不派发；继续才派发。对 `starting`/turn-start unknown 注入停止与断线，禁止生成第二 Turn。相同“采集一次”点击复用未结同类请求，独立追问按各自 requestId 排队。
- [ ] **2. 验证红灯。** `powershell -NoProfile -File scripts/dev.ps1 test tests/feed-controls.test.ts tests/feed-recovery.test.ts`。
- [ ] **3. 实现控制状态机。** 持久化 intent → 原生调用 → 保存回执，过渡为 starting/running/stopping；interrupt 确认后才 stopped，未知则 needs_reconciliation。只恢复确知未派发输入；历史核对不能确认结果时显示待处理，不以重试掩盖。响应原生请求复用 validateNativeResponse，绑定 collection/key/连接代际，正确清除 resolved 请求。安全退出先停止派发、保存队列，再关闭 native 与 store；FeedEngine 关闭完再关闭共享账号。
- [ ] **4. 验证通过。** 重启、退出、断线、存储失败、旧回调、正在认证/建立 Thread 时停止、删除运行中任务均有断言；继续队列不能绕过待核对状态。当前 run 用启动时说明，说明编辑只影响未来创建的采集轮次。
- [ ] **5. 提交。** `feat(feed): preserve collection controls and recovery state`。

## Task 6: 每日/每周计划与漏跑合并

**Files:** 新 `src/core/feed-scheduler.ts`、`tests/feed-scheduler.test.ts`；改 `feed.ts`、`feed-store.ts`、`src/desktop/main.ts`、`src/shared/feed.ts`。

**Interfaces:** `nextDueAt(schedule:FeedSchedule,after:string):string|null`，返回严格晚于 after 的 UTC ISO 时刻；`reconcileSchedules(now:string):void` 原子生成或合并待执行自动输入；`pauseSchedule(id:string,expectedRevision:number,requestId:string):void`、`resumeSchedule(...):void`。调度只 enqueueCollectionRun，不直接调用原生服务。固定 now 可注入测试。

- [ ] **1. 写失败测试。** `Asia/Shanghai` 每天09:00在 `2026-10-29T00:59:00Z` 后应为 `2026-10-29T01:00:00.000Z`；跨三天只产生一个补采窗口；暂停取消 scheduled/catchup queued 但保留 message/manual queued 与 active run；queueHeld 下到期只合并不启动。
- [ ] **2. 验证红灯。** `powershell -NoProfile -File scripts/dev.ps1 test tests/feed-scheduler.test.ts`。
- [ ] **3. 实现持久触发。** 用 Intl 的 IANA 时区日期部件计算日/周时刻，weekday 为0–6、time 为HH:mm；保存时区取用户选择，默认当前系统时区，此用户显示 Asia/Shanghai。夏令时缺失时刻跳过当日，重复时刻只取首次；用本地日期/计划 revision 唯一键防回拨重触发。enabled 与 nextDueAt、due receipt/coverageWindow 同事务；30秒 tick、startup、resume 都调用同一入口。
- [ ] **4. 验证通过。** 增加 America/New_York 春季02:30缺失、秋季01:30重复、周计划、无效时区、手动变定时、重启 receipt、暂停/到期竞态。已开始但未知的 run 不算漏跑；恢复定时从当前时刻算下一次，不补执行用户主动暂停期间的日程。timer 在关闭时撤销。
- [ ] **5. 提交。** `feat(feed): schedule and reconcile daily and weekly collection runs`。

## Task 7: 采集任务工作区、追问与继续调研

**Files:** 新 `src/renderer/FeedCollection.tsx`；改 `FeedWorkspace.tsx`、`FeedReader.tsx`、`feed.css`、`App.tsx`、`NativeRequests.tsx`、`src/shared/conversation-order.ts`；扩展 `tests/feed-renderer.test.ts`、`feed-electron.mjs`，回归 `tests/session-renderer.test.ts`。

**Interfaces:** `FeedCollection({detail,execute,onBack,onError})` 消费已定义 FeedCollectionDetail。NativeRequestCard 的展示 props 改为 `NativeServerRequest & {key:string}` 加既有 callback。`orderedConversation<T extends Pick<ConversationEntry,'id'|'seq'|'createdAt'>>(entries:readonly T[]):T[]` 只泛化排序；个人对话外层在 FeedCollection 内复用排序、ProjectMarkdown 与 NativeRequestCard，不改项目 ConversationFeed 的任务/消息逻辑，不制造虚假 nodes。

- [ ] **1. 写失败测试。** 从条目追问进入最近仍有效的来源任务，输入框带明确资料且未发送；选择多条跨任务资料只在发送后创建新任务；取消不产生空任务；临时聊天不改变 instructionRevision。
- [ ] **2. 验证红灯。** `powershell -NoProfile -File scripts/dev.ps1 test tests/feed-renderer.test.ts` 及构建后的 `tests/feed-electron.mjs`，相关控件缺失应失败。
- [ ] **3. 实现已确认布局。** 任务列表、对话/结果/运行记录、重命名、编辑采集说明/能力、运行安排与下一次时间、立即采集、停止本次、排队撤回/继续、暂停定时、删除恢复；原生待确认和存储失败进入任务列表提示。单条无来源/来源任务已删除时建立新调研任务，不自动恢复旧任务。支持从会话回答显式保存到信息流。
- [ ] **4. 验证通过。** 键盘路径、窄窗口、关闭返回焦点、来源/Markdown阅读、结果反向进入对话、多来源选择、独立任务草稿、排队/原生请求与失败重试；切项目/信息流收到晚到通知不丢个人数据。所有长列表分页，旧 query/detail 响应不得覆盖当前选择，草稿只在保存成功后清理。
- [ ] **5. 提交。** `feat(feed): add collection conversations and research flows`。

## Task 8: 端到端集成与实际客户端验收

**Files:** 扩展 `tests/feed-electron.mjs`；新增必要的受控 native fixture 到 `tests/`；证据只写 `.runtime/implementation/feed/`；更新 `README.md`、设计文档验收记录及本计划勾选。

- [ ] **1. 补齐跨边界失败用例。** 真实 worker→命令→个人数据库→原生 fixture→HTTP MCP→推送→renderer：一次保存回执丢失后重试只有一条；任务删除保留成果；恢复重启后 queueHeld 与已保存备注仍在。
- [ ] **2. 验证层级。** 先跑全部 feed 测试及相关 native/account/MCP/commands 回归，再 `powershell -NoProfile -File scripts/dev.ps1 typecheck`、`powershell -NoProfile -File scripts/dev.ps1 build` 和 `powershell -NoProfile -File scripts/dev.ps1 test tests/feed-electron.mjs`。受控 fixture 结果只证明受控链路。
- [ ] **3. 实际客户端采集。** 安全退出旧客户端并以当前版本重启，核对路径/启动时间/desktop ready；实际创建两个文本采集任务，确认不同原生 thread，保存有来源的真实资料、单条追问、多条研究、备注/收藏、原生请求入口与手动日程配置。用一次可观察的真实到期执行核对时区和保存回执；真实模型/来源访问失败如实记录。
- [ ] **4. 完整回归。** `powershell -NoProfile -File scripts/dev.ps1 test`，预期全部通过；失败调查归因，不能把跳过或既有失败记作通过。检查原项目创建、登录、工作流执行、人工核对与资料操作，确保公共提取没有改变已交付行为。
- [ ] **5. 提交验收记录。** `test(feed): verify collection and reading lifecycle`；记录测试数量、真实与受控边界、实际执行的日程，不以草图或 fixture 代替真实客户端。

## Task 9: 两轴审查、PR、合并与最终交付

- [ ] 使用当前官方 code-review 技能，以实际 baseline SHA 为固定比较基线，两个并行审查 Agent 分别核对仓库规范和 #114 验收条件；处理发现并验证。
- [ ] 按官方 pr 技能的 Summary / Evidence / Merge Danger 写 PR，关联 `Closes #114`，推送专用分支并创建 PR 后附加到当前 Codex chat。
- [ ] 核对当前 PR head 的 CI、审查和未解决讨论；必要检查失败或阻塞未解决时保留 PR。无仓库 CI 时提供实际本地验证，不能宣称远端 CI 已通过。
- [ ] 合并后同步 main，核实 merge SHA 和 Issue 关闭；再次构建并安全重启实际客户端，核对 desktop ready、进程路径和启动时间，并在最终版本复验个人入口、保存/阅读及采集对话。
- [ ] 删除本次已合并的本地/远端临时分支，必要工作树按可恢复方式清理；交付 Issue、PR、合并提交、测试与重启证据。

## 验收映射与计划自审

| 规格验收 | 实施任务 |
|---|---|
| 1 无项目个人入口 | 1、2 |
| 2 一句话创建、独立对话 | 3、4、7 |
| 3 搜索/筛选组合 | 1、2 |
| 4 阅读/收藏/重复状态 | 1、2、4 |
| 5 来源/摘要/备注与未知时间 | 1、2 |
| 6 文本保存与采集失败 | 1、4、7 |
| 7 原任务追问、多条研究、说明隔离 | 4、5、7 |
| 8 说明下次生效、串行/撤回 | 4、5、7 |
| 9 时区日程与停止/暂停 | 5、6、7 |
| 10 部分结果、原生请求与未知执行 | 3、4、5、8 |
| 11 删除/撤销/恢复/防回流 | 1、2、5、7 |
| 12 键盘、窄窗、滚动与草稿 | 2、7、8 |

计划自审时逐项核对：上述验收全部有任务；下游接口与类型名一致；每个实现步骤给定明确文件和行为；五类 Review Focus 均有测试归属；代码块只表达接口和关键断言。后续更新计划必须同步接口与验收映射，不以额外抽象扩大首版范围。

2026-10-29 规划自审完成：12 条规格验收均已映射；补齐个人命令回复、会话记录类型、恢复核对命令、来源身份回执键与共享账号唤醒；将项目会话复用收窄为泛型排序与既有文本/请求组件。文档链接、9 项任务编号及代码围栏检查通过。以上是计划检查，任务中的测试命令均为实施阶段要求。
