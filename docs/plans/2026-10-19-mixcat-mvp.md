# Mixcat MVP Implementation Plan

> 历史实施记录：以下清单、首版限制和测试数字描述最初 MVP 阶段，不是当前待执行计划。当前功能以 [客户端功能设计](../design/2026-10-19-mixcat-client-functional-design.md) 为准；后续已加入自由会话、原生审批与历史、节点模型和能力选择、工作面板及四种节点控制。旧项目级串行、强制只读、`never` 审批和固定业务结果格式不适用于新会话界面。每节点唯一状态及覆盖规则见 [节点控制专项](../design/2026-10-19-node-controls.md)。

> **For agentic workers:** Use the existing design and the interfaces in `src/shared/types.ts`. Implementation proceeds in this session under the user's request to build the MVP; scoped parallel work and a fresh final review are used. Steps use checkboxes for progress.

**Goal:** Build a runnable desktop foundation in which Codex conversation nodes discover one another through MCP and hand results to another node, including review feedback loops.

**Architecture:** Electron renderer and restricted preload communicate with a utility-process core. The core owns project SQLite state, a local MCP gateway, and a project-specific Codex app-server; native events release persisted handoffs. A clearly labelled deterministic rehearsal uses the same MCP and scheduling boundaries to verify the loop without account access.

**Tech Stack:** Electron 44.9.0, React 19.3.1, TypeScript, Vite 8.3.4, React Flow 12.12.0, Node SQLite, MCP SDK 1.32.1, JSON Schema validation.

**Design directory:** `docs/design/`.
**Spec:** [Workflow](../design/2026-10-19-mixcat-workflow-design.md), [Architecture](../design/2026-10-19-mixcat-technical-architecture.md).

## Global Constraints

- Desktop application; each node binds a native Codex Thread in native mode.
- Agent chooses the handoff target; no hard-coded production route.
- Node-specific tools and result schemas; server validates identity, permissions and results.
- All project data, dependency caches, logs, fixtures and outputs stay within the owning non-C project; check resolved paths and reparse points.
- Codex internal global executables may be read/reused under the user's updated exception; do not copy or print authentication secrets.
- Existing design documents are preserved. No repository exists; do not initialize Git or create commits merely for workflow bookkeeping.
- No ComfyUI, plugin marketplace, automatic worktree merging, distributed workers or system service.
- MVP result artifacts are structured JSON plus immutable result files; arbitrary external file transfer and full native transcript parity are deferred.

## Review Focus

- Wrong node/token/Thread/Turn cannot submit or route a result (MCP and core tests).
- Duplicate handoff and repeated completion cannot enqueue twice (core transaction tests).
- Failed/interrupted source and native dispatch uncertainty never silently advance (core recovery tests).
- Invalid result schema and stale node editing preserve stored state (core validation tests).
- UI mode labels distinguish rehearsal from native execution, and native login failure is visible (desktop/browser verification).

## Task 1: Runtime and protocol contract

Files: package/build configuration, `src/shared/types.ts`, `src/core/codex.ts`, `src/core/mcp.ts`, `tests/native.test.ts`, `tests/mcp.test.ts`.

- [x] Inspect installed Codex using an isolated project-local home, without reading account secrets or starting inference.
- [x] Define shared commands, snapshots, Codex port and MCP callback contracts.
- [x] Test gateway authentication, tool visibility and metadata extraction before implementing the gateway.
- [x] Implement native stdio initialization, RPC, timeout/unknown outcome and events against the installed schema.
- [x] Verify independent per-thread MCP configuration and project-local runtime directories.

## Task 2: Durable workflow core

Files: `src/core/paths.ts`, `src/core/store.ts`, `src/core/engine.ts`, `src/core/demo.ts`, `tests/core.test.ts`.

Interfaces: `WorkflowEngine.command(AppCommand): Promise<AppReply>`, `WorkflowEngine.subscribe(listener): unsubscribe`, `WorkflowEngine.close(): Promise<void>`; uses shared Codex/MCP contracts.

- [x] Add failing tests for result schema, source completion gate, duplicate handoff, failed source, loop limit and restart reconciliation.
- [x] Implement project registration, editable node definitions, SQLite task/hand-off records and immutable result files.
- [x] Bind node authentication to registered native Thread/Turn; reject unknown callers and unauthorized workflow edits.
- [x] Implement one active task per project for the MVP, sequential node inbox, pause/resume/stop and explicit retry after reconciliation.
- [x] Route via MCP; release target only after successful native completion and valid terminal result.
- [x] Implement a labelled deterministic rehearsal through the actual MCP gateway; it is not evidence of model reasoning.

## Task 3: Desktop workbench

Files: `src/desktop/main.ts`, `src/desktop/preload.ts`, `src/core/worker.ts`, `src/renderer/*`, `index.html`, `vite.config.ts`.

Interfaces: renderer uses only `window.mixcat` from shared types; the core worker accepts typed commands and emits snapshots.

- [x] Create project cards and a node canvas with actual handoff edges.
- [x] Add node editing, tools/result-schema controls, task input, live activity and result views.
- [x] Add native connect/login status and explicit rehearsal/native modes.
- [x] Restrict IPC, navigation and external URL opening; place all Electron data under the workbench root.
- [x] Closing the window keeps the main process in the tray; explicit exit shuts down core and records unresolved work.

## Task 4: Verification and handoff

Files: `README.md`, `scripts/dev.ps1`, `scripts/build.mjs`, `scripts/start.mjs`, project-local validation evidence.

- [x] Run TypeScript checking, behavior tests and production build.
- [x] Launch actual Electron and inspect rendered UI/interaction, using project-local screenshots and logs.
- [x] Exercise create/edit/rehearsal/feedback/result/reload paths, plus native connection without assuming login.
- [x] Perform fresh code review, resolve blocking findings and document remaining native end-to-end limits.

## Execution notes

- Installed system Node is 18; use the verified Codex-bundled Node 24.19.0 for tools. The launcher also accepts a configured modern Node.
- Installed Codex is 0.163.0-alpha.10.2. Isolated probe confirms per-thread `config.mcp_servers` replacement and tool discovery; model calls and login are not yet verified.
- UI uses a restrained monochrome desktop workbench. No image generation, remote fonts or asset downloads are needed.

## Completed verification

- 34 behavior tests passed; TypeScript and production build passed.
- Actual Electron UI verified two five-turn rehearsal runs, node creation/editing, readable feedback edges, native connection, reload and full application restart.
- Native connection reported authenticated=false; no real model inference or login was performed.
- Reviewed and fixed runtime junction handling, moved project roots, stale Agent updates, cancelled inbox state, loop-limit exit and stop/start races.
- Windows native close now releases owned pipes only after the direct process has exited; actual Electron shutdown completes without the previous timeout.
- Current scope and start commands are in README.md; runtime evidence is in .runtime/ui-evidence and .runtime/logs.

## Subsequent native execution verification

- 2026-10-19: user requested actual execution. Project-local Codex login completed; no existing global credential file was copied.
- First native attempt exposed missing MCP approval configuration. Added explicit approval only for the node's authorized mixcat tools; retained server default prompt, approvalPolicy never and read-only sandbox. Added a start/resume regression test; 35/35 tests, typecheck and build passed.
- Retried the real task and verified plan → implement → review → implement → review. All five native executions completed; four MCP handoffs were delivered; final review verdict was approved for checklist design only.
- Durable evidence: .runtime/native-execution/verification.json and release-checklist.md, plus original per-task JSON artifacts under the project's .mixcat/artifacts.
- The post-run screenshot helper timed out after successful completion. The run and immutable result were verified from SQLite and the final artifact; screenshot failure is not treated as a workflow failure or as successful visual evidence.
