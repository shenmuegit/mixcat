# Mixcat 设计文档

2026-10-24：[动态条件边 MCP](2026-10-24-dynamic-edge-mcp.md) 为当前节点流转规则：各节点的条件边动态生成其可见工具，调用直接投递；覆盖下列历史文档中的无连线发送规则。实现与验证见[实施记录](../plans/2026-10-24-dynamic-edge-mcp-implementation.md)。

此目录统一存放架构设计、功能设计和其他专项设计，可嵌入引用已归档的原型图片作为视觉参考；可运行原型、实施计划和测试产物另行存放。后续新增设计也放在 `docs/design/`，不使用工具或技能名称作为归档目录。

以 [客户端功能设计](2026-10-19-mixcat-client-functional-design.md) 为正式产品目标入口，[当前交付与验收矩阵](2026-10-20-delivery-status.md) 集中记录根目录正式开发版的实际实现、证据和未验证范围。八项任务、必要修复复审及最终独立整体复核均已通过。专项设计补充规则，历史原型观察/日期/图片保留决策依据，已被覆盖的规则不作为现行要求。

2026-10-21 节点 MCP 协作已按 [MCP 协作设计](2026-10-21-mcp-collaboration-design.md)和[实施计划](../plans/2026-10-21-mcp-collaboration-implementation.md)完成正式实现与分层验收，实际范围见交付矩阵。2026-10-22 的 [Web 产品六节点工作流与文档协作](2026-10-22-web-product-team-workflow.md) 已完成可选模板、独立评审及真实极小产品协作。用户批准该测试项目的具体 hooks 后，七类 planning-with-files 原生生命周期与两个会话的计划隔离也已实测；分层结果和未测范围见交付矩阵，不推广为全部模型、插件或平台能力已验证。

| 文档 | 类型与适用范围 |
| --- | --- |
| [当前交付与验收矩阵](2026-10-20-delivery-status.md) | 十三项需求、四种控制、生命周期、可靠性、权限实验及真实/fixture/像素证据边界；实际进度统一入口 |
| [人工核对机制](2026-10-22-human-review-design.md) | 六项任务及最终修复复审完成；393/393 完整回归、真实双人工决定、产品 API／Chromium、零未解决执行及所属实例清理通过，见[实施计划](../plans/2026-10-22-human-review-implementation.md)与[最终审计](../../.runtime/implementation/human-review-20261022/records/native-completion-audit.json) |
| [设置、共享账号与节点删除](2026-10-20-settings-and-node-deletion.md) | 客户端统一登录、项目会话边界、归档式删除、并发与原生兼容性 |
| [MCP 协作设计](2026-10-21-mcp-collaboration-design.md) | 已实施的五个核心工具、指导式条件边、普通消息、关联回复、持久受理和工作流编辑契约；实际验收见交付矩阵 |
| [Web 产品六节点工作流与文档协作](2026-10-22-web-product-team-workflow.md) | 已实现模板的六类职责、协作回流、文档归属、技能与工具组合、可选协调／架构角色及 hooks 接入边界；验收以交付矩阵为准 |
| [客户端功能设计](2026-10-19-mixcat-client-functional-design.md) | 正式功能目标、需求对照、状态与验收；第 4.4 节附项目页与工作流页的像素元素版图片，单独标识原型观察和历史证据 |
| [架构可靠性与边界修订](2026-10-20-architecture-hardening.md) | 七项审计问题的设计契约和实施索引；提交、并发、控制、历史、原生能力、隔离边界及待讨论数据关系 |
| [技术架构设计](2026-10-19-mixcat-technical-architecture.md) | 进程、Codex 接入和存储边界；保留初始决策，并注明现行差异 |
| [工作流设计](2026-10-19-mixcat-workflow-design.md) | Agent 自主交接、回流和独立审查的设计依据；历史约束以功能总设计为准 |
| [会话工作台专项设计](2026-10-19-session-workbench-design.md) | 节点创建、模型与能力选择、自由会话、条件边、历史和工作面板 |
| [节点状态与暂停覆盖](2026-10-19-node-controls.md) | 每节点一份多值状态、四种控制覆盖、恢复范围及中断竞态 |

实施计划和执行记录单独保存在 `docs/plans/`。其他文档入口见 [文档目录](../README.md)，运行说明见 [项目 README](../../README.md)。

已完成计划：[MCP 节点协作实施计划](../plans/2026-10-21-mcp-collaboration-implementation.md) 和 [六节点模板实施计划](../plans/2026-10-22-web-product-team-implementation.md)。任务、独立评审、修复及分层验收记录保留在各自计划中；六节点实现当前位于保留既有改动的工作分支，尚未提交或推送。

原型单独归档：`prototypes/desktop/` 保存客户端源码、测试及启动配置，`prototypes/ui/` 保存静态界面图和渲染源。真实项目数据、会话与登录材料保持原位置，不随源码归档搬迁；设计文档中的图片直接引用 `prototypes/ui/` 的归档文件。
