# Unified Issues Implementation Plan

> **For agentic workers:** Follow the repository implement/TDD workflow and parallel ownership below; verify each slice through its public boundary before final independent standards/spec reviews.

**Goal:** Merge todos into Issues and remove the Todo entry.
**Architecture:** Reuse ProjectItem, existing tree/comment operations and dispatch. Retain legacy storage identities and review material serialization while exposing one Issue capability set.
**Tech Stack:** Existing TypeScript, React, Electron, SQLite and Node test runner; no new dependencies.
**Spec:** [Unified Issue design](../design/2026-10-29-unified-issues.md).
**Baseline:** `e2c5c4c4d78f5e409a6fd8cf838b7a099fccfca0` on main; Issue #107.

## Global constraints

All work data stays inside G:/code/mixcat. No bulk rewrite of historical messages, receipts or approved review bundles. New UI creates issue, default task. Existing todo identities remain compatible. Runtime completion does not complete business work.

## Review focus

Legacy Todo's unused bug type must display task; explicit type edits must invalidate materials. T-1 and I-1 must not collide. Mixed trees must reject cycles and premature completion. Closed/canceled work must not count as delivered. New primary associations must survive composer and edge inheritance without copying observed metadata into input.

## Task 1 — Unified domain and compatibility

Files: src/shared/project-items.ts, src/core/project-items.ts, tests/project-items.test.ts.
Interfaces: IssueType includes task; issueTypeOf(item) reads legacyTodoType for todo; ProjectItem/ItemMaterial carry optional legacyTodoType. WorkContext accepts primary_issue_id and legacy primary_todo_id. todoProgress handles all non-document work and excludes closed/canceled leaves.

- [ ] Write and run a failing command-level mixed Issue/tree/type test.
- [ ] Generalize existing mutation/query/tree logic, preserve legacy identities/materials, add primary association parsing and validation; repeat red/green for state/material edge cases.
- [ ] Run focused project item tests and typecheck.

## Task 2 — Unified user flow

Files: src/renderer/ProjectManagement.tsx, ProjectManagement.css, ProjectMarkdown.tsx, tests/project-items-renderer.test.ts.
Consumes: issueTypeOf, expanded ProjectItem states, primary_issue_id.

- [ ] Add failing renderer assertions for three navigation entries and mixed Issue tree.
- [ ] Remove Todo entry, unify selection/search/details and create issue records; expose tree, type, progress, comments and dispatch for both identities.
- [ ] Verify old reference navigation, draft/focus retention, status options and rendering.

## Task 3 — Node integration and delivery

Files: src/core/mcp.ts, src/core/engine.ts, src/core/web-product-template.ts, src/renderer/Workbench.tsx, tests/project-items-mcp.test.ts, tests/project-items-electron.mjs, related fixtures/docs.

- [ ] Add failing MCP test for canonical Issue association and edge inheritance.
- [ ] Update schema/instructions/composer/inheritance to consume canonical field and legacy alias, keeping runtime state independent.
- [ ] Run focused tests, typecheck/build, Electron interactions and one complete unit suite; investigate failures.
- [ ] Run parallel standards/spec reviews, resolve findings and validate affected behavior.
- [ ] Publish and attach PR, check its head CI/reviews, merge, sync main, rebuild and safely restart actual client; verify paths/start time/desktop ready and final UI, then remove merged temporary branches.
