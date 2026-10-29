# Notes and Shared Document Editor Implementation Plan

> **For agentic workers:** Execute the approved work in this session with independent owners for shared editing, note storage and the note workspace, then perform the repository's parallel Standards/Spec review. Use the repository's implement/TDD workflow at the public seams below.

**Goal:** Add Grove-style independent notes with mind-map organization and relationships, sharing one reader/editor with project documents.

**Architecture:** A controlled Grove-based reader/editor receives content and source callbacks. A separate note store lives in the workbench root; project documents continue using project files. The note workspace owns the mind map and note relationships.

**Tech Stack:** Existing Electron, React, CodeMirror, React Flow, TypeScript and Node SQLite; Grove's supporting Markdown dependencies where needed for its real editing behavior.

**Spec:** `docs/design/2026-10-29-notes-shared-editor.md`

## Global Constraints

- All generated data, logs, tests, resources and worktrees remain within `G:\code\mixcat` and no linked path escapes it.
- Source checkout is read-only `G:\code\grove`; no Grove data migration.
- Note identity and project file identity stay separate; one shared rendering/editing implementation serves both.
- Existing project file conflict checks and reference identity remain effective.
- Work from baseline `e2c5c4c4d78f5e409a6fd8cf838b7a099fccfca0`, branch `codex/issue-108-notes`; root checkout hosts unrelated concurrent work.

## Review Focus

- Same local ID in different sources, delayed saves or paste callbacks: never replace another document's draft.
- Chinese IME, CRLF, table content and rich paste: preserve intended Markdown and input history.
- Reparenting into a descendant, deleting associated subtrees, repeated mutation IDs: coherent persistent graph or explicit rejection.
- Project external edits and stale note revisions: preserve draft and reject overwrite.
- Media paths, symlinks and dangerous URLs: resolve only within source scope without executing content.

## Task 1: Persistent notes and commands

**Files:** create `src/shared/notes.ts`, `src/core/notes.ts`, `tests/notes.test.ts`; modify `src/shared/types.ts`, `src/core/engine.ts`, `src/desktop/main.ts`.

**Interfaces:** `Note` contains id/title/body/parentId/order/relatedIds/revision/createdAt/updatedAt/deletedAt. `NotesSnapshot` contains revision and notes. `NoteMutation` carries request_id, operation (create/edit/move/associate/delete/restore), expected_revision (notebook revision), and operation-specific id/title/body/parentId/beforeId/targetId/linked. Commands `get_notes` and `update_note {input}` return `notes?: NotesSnapshot` and `noteId?: string` in `AppReply`.

- [ ] Write a public-command failing test: create without project, edit, close/reopen, assert exact body and stable ID.
- [ ] Implement transactional SQLite store under workbench `.mixcat/notes`, validation and IPC reply forwarding; pass persistence test.
- [ ] Add and pass vertical tests for ordering/reparent cycles, symmetric links, subtree recycle/restore, stale revisions, rejected payloads and durable idempotent mutation receipts.

## Task 2: Shared Grove reading/editing

**Files:** shared reader/editor and supporting modules under `src/renderer/`; modify project document rendering in `ProjectManagement.tsx`; associated editor tests and CSS. Owner defines the final minimal props and shares them with Task 3 before integration.

**Interfaces:** controlled title/body/editing/disabled and identity; change callbacks; optional source-specific completion, link/navigation and media handlers. Storage is outside the shared component.

- [ ] Port Grove's current reading/live-preview/table/rich-paste behavior with its required helpers and safe Markdown rendering; preserve source bytes where no edit occurs.
- [ ] Replace the project document editor with the shared component, providing existing saves, @ completions, references and headings through callbacks.
- [ ] Verify source identity isolation, CRLF, Chinese input, undo, table edits, rich paste, safe links and save-failure mode handling through meaningful tests/renderer checks.

## Task 3: Note workspace and mind map

**Files:** create `src/renderer/Notes.tsx` and scoped CSS/helpers; modify `src/renderer/App.tsx`; add note graph tests and Electron interaction checks.

**Consumes:** Task 1 commands/types and Task 2 shared component. `Notes` receives the existing execute callback and reports unsaved content for app navigation/quit protection.

- [ ] Build independent note entry, persisted note loading and drafts, create/edit/save/recycle/restore with conflict recovery.
- [ ] Adapt Grove mind-map organization to Mixcat React Flow: hierarchy, order, collapse, drag organization, keyboard/menu equivalents, search and viewport continuity.
- [ ] Add note association creation/removal/navigation and shared editor source callbacks; validate graph behavior and real interactions.

## Task 4: Resources, integration and delivery

**Files:** source-scoped media operations in core/desktop and shared source types as needed; `tests/notes-electron.mjs`; design index and final evidence records.

- [ ] Connect safe source-local media import/read for note and project content, with read/write/path and unsafe URL tests.
- [ ] Run actual Electron acceptance across both sources and correct observed failures.
- [ ] Run typecheck, build and full test suite, then fixed-baseline Standards and Spec reviews in parallel; fix findings and rerun affected checks.
- [ ] Commit and push only Issue #108 changes; open/attach PR with Summary, Evidence and Merge Danger; inspect current-head checks and merge when clear.
- [ ] Safely synchronize final main with concurrent work, rebuild/restart actual client, verify process start/path and fresh desktop ready, then clean this issue's merged branch/worktree.
