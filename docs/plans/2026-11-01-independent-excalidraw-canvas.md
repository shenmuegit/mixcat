# Independent Excalidraw Canvas Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task. Repository authorization supplies inline implementation and two independent final reviews.

**Goal:** Deliver an independent local whiteboard matching the current Excalidraw editor's visuals and interactions.

**Architecture:** Embed the official commit-matched React editor. Add a small SQLite workspace store and authorized desktop IPC for independent canvas documents and the local library. Integrate the module with existing navigation, unsaved guards and project-local download handling.

**Tech Stack:** TypeScript, React 19, Electron, Node SQLite, official Excalidraw 0.18.0-4ce8305, Vite.

**Spec:** `docs/design/2026-11-01-independent-excalidraw-canvas.md`; GitHub Issue #180.

## Global Constraints

- All work, caches, screenshots, exports and verification artifacts remain under the actual Mixcat root on G:; use existing path helpers.
- Pin `@excalidraw/excalidraw` to `0.18.0-4ce8305`, matching website commit `4ce8305ca78e4ea05ad78c306292932bfe6b256f`.
- Use official editor styling and local fonts; cloud collaboration, online sharing and Codex are outside this iteration.
- Scene JSON limit 64 MiB; library JSON limit 8 MiB; dedicated IPC must authorize its sender.
- Root branch baseline: `b1b67ac36d104075779a3b1c90e5d53334cfe3df`; branch `codex/issue-180-excalidraw-canvas`.
- Implementation uses `.runtime/worktrees/issue-180-excalidraw-canvas`; the actual client is rebuilt from the owning root after merge.

## Review Focus

- Saving while another edit arrives must not mark the later edit clean.
- A failed or conflicting save must retain the current scene and block destructive navigation.
- Imported images and viewport/library preferences must survive a process restart.
- Host global CSS must not change official editor controls or responsive hit targets.
- IPC and export names must not permit out-of-workspace writes or linked-file access.

### Task 1: Independent document persistence

**Files:** create `src/shared/canvases.ts`, `src/core/canvases.ts`, `tests/canvases.test.ts`.

**Interfaces:** `CanvasStore(root).command(CanvasCommand): CanvasReply`; operations `list`, `read`, `create`, `save`, `rename`, `delete`, `get_library`, `save_library`. Documents have id/name/revision/timestamps/scene; list replies carry summaries, not full scenes. Mutations carry a request ID and expected document/library revision.

- [x] Write and run a failing test that creates two canvases without a business project, saves a scene with an image and viewport, reopens the store and reads both identities and their distinct contents.
- [x] Implement minimal SQLite store using existing project-path/link validation and atomic transactions; run the test green.
- [x] Add red/green coverage for stale writes, identical request replay, reused request IDs with changed input, independent document revisions, rename/delete, malformed/oversized payloads and linked database files.
- [x] Verify with `scripts/dev.ps1 test tests/canvases.test.ts` and typecheck.

### Task 2: Native editor and reliable save coordination

**Files:** create `src/renderer/Canvases.tsx`, `src/renderer/Canvases.css`, save coordination module and its behavior tests; modify `package.json`, lockfile, `scripts/build.mjs`, `src/shared/types.ts`, `src/desktop/preload.ts`, `src/desktop/main.ts`, `src/renderer/App.tsx`, `src/renderer/Icon.tsx`.

**Interfaces:** `DesktopApi.canvases(command): Promise<CanvasReply>`; trusted main owns the store. `Canvases` receives sidebar element and active state. Editor scene uses upstream serialize/restore helpers and stores images plus viewport; library changes persist separately. Existing unsaved API accepts the canvas namespace.

- [x] Install the exact official editor package through npm with all configurable cache/temp paths rooted in the project; inspect its public types and assets.
- [x] Red/green tests at the save coordinator's public boundary: edits during a pending save remain dirty; failed save retains latest scene; retries reuse the same operation ID; board switch waits for durable persistence.
- [x] Add the authorized bounded desktop IPC and preload method, preserving existing sender validation and close protection.
- [x] Add native editor, sidebar management and isolated official styling; copy package fonts into the build and point EXCALIDRAW_ASSET_PATH to local assets.
- [x] Handle exports through validated project-local download destinations.
- [x] Verify relevant tests, typecheck and build.

### Task 3: Desktop acceptance, review and delivery

**Files:** create a focused Electron acceptance entry point under `tests/`; record evidence under `.runtime/issue-180/`; add the design index entry.

- [x] Start an isolated real Electron renderer using existing fixture patterns with all data under the project.
- [x] Exercise real pointer drawing, rectangle styling, text/notes, pan/zoom, undo/redo, menus, library, theme and resize. Compare official toolbar/property-panel metrics at matched viewport/DPR; save screenshots and actual results.
- [x] Verify actual import/export formats and paths, two-board isolation, scene/image/library restore and desktop IPC/unsaved behavior.
- [x] Run complete tests once, typecheck and build; investigate all failures.
- [ ] Commit and run two parallel review Agents against the pinned baseline: repository standards and Issue/spec acceptance. Resolve findings and verify changes.
- [ ] Push, create a Summary/Evidence/Merge Danger PR with Closes #180, attach it to the current chat, verify current-head checks/reviews and merge when clear.
- [ ] Synchronize main, build with existing scripts, safely restart the actual client and verify process path/start time/desktop ready plus actual canvas interaction. Clean up the merged temporary branch.

## Execution ledger

- Scope confirmed by the user: standalone editor, complete canvas visuals/interaction, no collaboration/sharing or Codex.
- Official website revision and npm build matched by direct live evidence.
- Repository standing authorization supersedes routine repeated design/implementation permission gates; this plan uses the existing required test and final-review boundaries.
- Builder check completed with no unresolved user decisions.
- Execution moved to `.runtime/worktrees/issue-180-excalidraw-canvas` after concurrent changes were observed in the shared root checkout. The root checkout was released for the user's actual client.
- Main was synchronized through `1019f497bf7a2951a49af5cc7616853fff6f2338`; navigation/icon conflicts were resolved by keeping the new canvas and current main controls together.
- Store and save-queue red/green tests passed. Desktop regressions verified persistent image acknowledgements, idle dirty-state completion, concurrent-edit draining and active-canvas deletion.
- Production main/preload IPC and project-local export were exercised; visible DPR 1.5 metrics match the website's toolbar and shape panel. Complete tests passed 901/901, renderer acceptance 3/3, production desktop acceptance 1/1 before final review.
- Independent Standards review found no blocking issue. Spec review identified missing native element-link navigation; a real native-link click reproduced the failure and a local/website-import/reopen regression now covers the correction. Post-review verification and delivery are recorded in the task report.
