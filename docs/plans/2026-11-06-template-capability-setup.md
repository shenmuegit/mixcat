# On-demand template capability setup implementation plan

**Goal:** Create only the selected template's capabilities, prompting before overwriting existing Codex abilities.

**Spec:** `docs/design/2026-11-06-template-capability-setup.md`; Issue #193.

**Architecture:** Derive install units from existing role recommendations, inspect native/project/host capability observations, use official native plugin and authored standalone-skill installers, then re-read and configure nodes. A dedicated creation dialog owns user choices and per-item results.

**Tech stack:** TypeScript, React, Electron, Codex native protocol, existing node:test and Electron drivers.

**PLAN_ID:** `template-capabilities-193`
**Baseline:** `6fd09ca3873083e7d271bd3e63a5e5d41837965c`

## Constraints and review focus

- Only fresh template creation triggers setup; no installation at client startup or existing-project restoration.
- Existing capabilities default to skip; replacements require a fresh, explicit user choice and a stated project target.
- Native plugins use author-supported original marketplaces; standalone Impeccable uses its official Codex CLI installer, never a repackaged plugin.
- Setup must recheck real capability state and refuse stale decisions or concurrent setup.
- Network/authorization failure retains the project and completed work; retries query actual state before mutations.
- Global credentials, unrelated capabilities and user hooks trust are outside overwrite scope.
- All task data is inside the project on G:, with no links or C: temporary paths.

## Task 1: Inspect and prepare native template capabilities

Files: `src/core/workflow-capabilities.ts`, `src/core/template-setup.ts`, `src/shared/template-setup.ts`, `src/core/engine.ts`, `src/core/catalog.ts`, shared command/reply types and persistence/snapshot boundaries.

- [x] Write and run a failing public-engine inspection test for research's exact install units and no installation during inspection.
- [x] Implement requirement derivation and observed existing-capability reporting.
- [x] Add red/green overwrite/skip, stale observation and selected-template-only installation tests.
- [x] Use official marketplace/install operations and the authored standalone-skill installer; replace manual cache/marketplace import with installed-capability validation.
- [x] Cover partial failure, retry, duplicate setup, busy work and restart at public boundaries; typecheck.

## Task 2: Creation dialog and real installation evidence

Files: new renderer setup component, `src/renderer/App.tsx`, desktop command/receipt IPC, snapshot/reply fields, meaningful existing/new Electron fixtures.

- [x] Add failing Electron checks for existing capability choice before any mutation, default skip and selected-template-only setup.
- [x] Implement progress/results/retry and explicit overwrite/skip controls; restore existing projects without setup.
- [x] Verify new reply metadata across actual production IPC and normal restart.
- [x] Validate actual official installations in a clean project-scoped Codex home, real loaded skill discovery and native hook provenance without granting trust.

## Task 3: Review and deliver

- [ ] Run focused tests, complete tests, typecheck, build and actual rendered interactions.
- [ ] Commit and run independent Standards/Spec review agents against the recorded baseline; fix findings and verify.
- [ ] Push and create/attach PR with real before/after evidence; inspect current head checks/reviews and merge.
- [ ] Sync final main, safely rebuild/restart actual client, verify process/start time/new desktop ready and interface.
- [ ] Clean task branches and record Issue/PR/merge and validation evidence.
