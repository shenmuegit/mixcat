# Feed results drawer implementation plan

> Execution: implement in this session using the project's authorized git-delivery-workflow, official Matt Pocock stages, TDD, and two independent whole-branch reviews. Current AGENTS.md governs delivery and restart.

**Goal:** Read current-feed Markdown results in a right drawer and generate result titles without a Codex title parameter.
**Architecture:** Reuse the existing result records, pagination, Markdown renderer and durable receipts. Generate a new title inside first-save processing so retry identity excludes the generated name/time.
**Tech Stack:** TypeScript, React, Electron, existing Zod/SQLite/MCP and Electron/CDP fixtures.
**Spec:** [Feed design](../design/2026-10-29-personal-information-feed.md), Issue #209.

## Global constraints

- `信息流名称_YYYY-MM-DD HH:mm`, first successful save in the local machine time zone; historical titles retained.
- No Computer Use; build and safely restart the actual final-main client.
- Protect existing AGENTS.md/.agents and user state. Follow the existing Issue/PR workflow.

## Review focus

- Retries after a minute, rename or restart retain the first title and receipt.
- A maximum-length feed name and distinct same-minute results remain readable and independently stored.
- Late result responses cannot cross feed navigation or replace the selected result.
- Empty, paged and failed result reads expose usable feedback and retry.
- Keyboard focus, narrow windows and long Markdown keep the drawer closable and drafts intact.

### Task 1: Native result title

**Files:** `src/core/feed-mcp.ts`, `src/core/feed.ts`, `tests/feed-mcp.test.ts`, `tests/feed-production-native-fixture.mjs`.
**Interfaces:** `save_feed_result` removes title. Existing `FeedService.saveResult` permits agent input without title and generates it during the original receipt transaction; explicit user-created text retains its existing contract.

- [ ] Extend the real HTTP/MCP test: schema has no title; no-title save generates `A_2026-11-09 08:37`; rename and clock advance preserve the first receipt/title; two distinct requests retain separate entries.
- [ ] Run `scripts/dev.ps1 test tests/feed-mcp.test.ts`; expect the new schema assertion to fail.
- [ ] Implement generation inside first-save processing, keep original request fingerprint and trust checks, update native fixture and tool instructions.
- [ ] Run `scripts/dev.ps1 test tests/feed.test.ts tests/feed-mcp.test.ts tests/feed-runtime.test.ts`; expect all related tests to pass.
- [ ] Commit only Task 1 paths.

### Task 2: Current-feed result drawer

**Files:** `src/renderer/FeedCollection.tsx`, `src/renderer/feed.css`, `tests/feed-result-drawer-electron.mjs` and the existing feed design.
**Interfaces:** Consume FeedCollection's existing result page. Drawer selection uses the existing discovery identity and reads its selected entry through `get_feed_entry`, so a page refresh can retain the chosen result. Reuse FeedResult in the same file and delegate pagination/retry to existing hooks.

- [ ] Add a real FeedWorkspace Electron/CDP test for the results entry, selection, full safe Markdown, close/Escape/focus, pagination, data refresh, errors and independent feed navigation.
- [ ] Run the test against the current build; expect the missing results entry/drawer to fail.
- [ ] Implement the drawer beside the conversation; at narrow widths it occupies the available content area while the mounted chat draft is retained.
- [ ] Run related Electron and renderer tests, typecheck and build. Verify wide, narrow and 720px-high windows, complete Markdown and draft preservation.
- [ ] Run the full project test suite; investigate failures and report pre-existing limits accurately.
- [ ] Commit only Task 2 paths, pin base/head and run separate Standards/Spec reviews. Fix and verify findings, push, create PR and merge when current-head conditions allow.
- [ ] Fast-forward final main, build/restart actual client normally, check fresh process and desktop-ready, verify real rendering/state, close temporary inspector, and clean only this task's merged branch.
