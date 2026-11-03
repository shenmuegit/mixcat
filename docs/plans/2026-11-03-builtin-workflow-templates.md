# Built-in workflow templates implementation plan

**Goal:** Deliver the four project templates confirmed in Issue #191.

**Architecture:** Reuse the existing workflow engine, native sessions, conditional edges and capability selection. Share the allowed template identifiers between commands, storage and the picker; keep existing saved projects readable.

**Tech stack:** TypeScript, React, Electron, node:test and the existing Electron fixture driver.

**Spec:** `docs/design/2026-11-03-builtin-workflow-templates.md`

**PLAN_ID:** `builtin-workflow-templates-20261103`

**Review baseline:** `0cc21dfe9b70c715f42bfb881144fb3c259b7d26`

## Constraints and review focus

- New-project choices are exactly research, content, bug fix and Web product; research is the default.
- All project data and acceptance artifacts stay under the owning project on G: without directory links.
- Unknown template identifiers fail validation; existing basic and ComfyUI projects reopen without replacing definitions.
- Configuring an empty or failing capability catalog preserves the created project and reports the actual failure.
- Node edits, edge edits, independent sessions and persisted reopen behavior survive template creation.
- Conditional-edge tools must support forward delivery and linked feedback in each new template.
- End-to-end transport fixtures are not evidence of live autonomous model quality.

## Task 1: Create and persist the new workflows

Files: `src/shared/templates.ts`, `src/shared/types.ts`, `src/core/workflow-templates.ts`, `src/core/engine.ts`, `src/core/store.ts`, `tests/workflow-templates.test.ts`.

- [ ] Add a failing public create/reopen test with literal role and feedback expectations for each new template.
- [ ] Run the test and record rejection by the old template validator.
- [ ] Implement shared identifiers, the three role/edge definitions and engine/store integration.
- [ ] Verify the new test plus existing Web and Comfy project persistence tests.

## Task 2: Capability setup and conditional-edge collaboration

Files: existing capability selector and template definitions, engine configure command, `tests/workflow-templates.test.ts`, existing runtime fixture and MCP helpers.

- [ ] Test real-catalog selection, unavailable capability feedback and user selections through configure commands.
- [ ] Reuse the Web capability selection/loading flow for the new role recommendations.
- [ ] Test a forward-and-feedback cycle over public MCP HTTP for each new workflow.
- [ ] Verify typechecking and relevant regressions.

## Task 3: Four-choice picker and desktop acceptance

Files: `src/renderer/App.tsx`, `tests/project-direction-electron.mjs`, existing creation acceptance fixtures and documentation index.

- [ ] Capture the old picker failing the four-choice/default assertion in actual Electron.
- [ ] Update the picker and all affected creation fixtures; verify four real creations, graphs, node/edge editing and reopening.
- [ ] Run full tests, typechecking and build; run parallel Standards and Spec reviews against the recorded baseline.
- [ ] Resolve findings, publish and attach the PR, verify checks and merge.
- [ ] Sync final main, build and safely restart the actual client; verify executable, start time, desktop ready and rendered choices.
- [ ] Delete this task's merged branches and record final delivery evidence.
