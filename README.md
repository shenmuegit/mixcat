# Mixcat

An independent desktop workbench for persistent Codex conversations and collaborative workflows.

Mixcat organizes projects into cards and conversations into an editable workflow canvas. Each node has its own Codex session, conversation history, model selection, and configured skills or plugins. Agents can pass work to other nodes through a local Model Context Protocol (MCP) service, including review and revision loops, while users can message any node directly.

**Status: early development preview.** Run from source on Windows. Packaged installers are not available, and the current interface and most design documentation are in Chinese. Mixcat is an independent project, not an official OpenAI client.

## Features

- **Project workspace:** project cards, an editable node canvas, related-node creation, and editable connection conditions.
- **Shared project management:** nested todos, internal issues and real Markdown documents, maintained through the same client and Agent APIs. Type `@` to insert project references, navigate linked content and inspect backlinks.
- **Persistent conversations:** a separate Codex thread for each node, using the project's directory as its working directory.
- **Personal text feed:** discuss a collection goal with Codex, accept a daily or weekly plan, and read its full execution results from project-style cards. Each collection continues its own native conversation independently of projects.
- **Direct interaction:** send messages and attachments to any node; inspect current activity, responses, and native requests for approval or input.
- **Agent collaboration:** node-specific MCP tools generated from outgoing conditional edges, durable messages with free JSON content, explicit replies, delivery receipts, immutable attachment snapshots, and review workflows.
- **Execution controls:** pause and resume individual nodes, a project, or the workbench. Bulk resume restores executions captured by the corresponding pause operation.
- **Project history:** chronological conversation records with node attribution and distinct incoming and outgoing content. Removing a node preserves its history and project files.
- **Work panels:** resource tabs, browser navigation, a project file chooser, and previews of text, SVG, HTML, and PDF files in a resizable node drawer.
- **Shared sign-in:** one Codex account for the application, with separate project sessions and working directories.
- **Web product template:** an optional eight-node team with a grouped product-definition stage, a separate architect, owned project documents, and recommended capabilities.
- **Human review gates:** versioned review packages with fixed attachments, explicit user decisions, and durable waiting tasks for dependent work.

## Requirements

- Windows and PowerShell.
- Node.js **24 or later**, with npm available.
- An installed Codex CLI that supports `app-server`, plus a Codex account for native model execution.
- A checkout and project directories on a **drive other than C:**. The current launcher rejects symbolic links, directory junctions, and linked ancestor directories. Project directories must already exist.

Native protocol checks used Codex CLI `0.163.0-alpha.10.2`; the human-review sample began on `0.163.0-alpha.11` and later resumed its existing sessions on `0.164.0-alpha.11.1`. These are dated verification boundaries, not a guarantee for every CLI version. Shared sign-in currently depends on an internal, unstable Codex authentication interface; other versions may require compatibility changes.

## Getting started

Clone the repository into a location on a drive other than C:, then run:

```powershell
git clone https://github.com/shenmuegit/mixcat.git
cd mixcat
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev.ps1 install
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev.ps1 start
```

The launcher discovers Node.js and Codex locally. If discovery does not find the intended executables, set `MIXCAT_NODE` and `MIXCAT_CODEX` to their absolute executable paths before running it. The `start` command builds the application and opens the Electron client. The latest human-review acceptance used controlled compiled desktop launches and an isolated live composition; it did not retest this ordinary `start` wrapper.

Open **Settings** using the gear at the bottom-left, then select **Log in to Codex**. Mixcat connects automatically as part of sign-in. The button changes to a confirmed signed-in state after authentication, and saved sign-in is restored on subsequent launches.

Create a project using an existing directory, open its workflow, and select a node to start a conversation. Closing the window keeps Mixcat in the system tray; use the tray's exit action to stop the application.

Unsent messages, attachments, and unsaved node settings participate in the project's navigation and exit warning. Node settings survive switching between nodes; edits made while a save is pending remain as a new draft after that save completes.

Only one Mixcat workbench can own a project for writing at a time. If a saved project is missing, damaged, or already open elsewhere, its card displays the error while other projects remain usable. Restore the directory or close the other workbench, then select its project card to retry opening. Removing an unavailable entry from the project list does not delete its files or history.

## Personal text feed

Open **信息流** in the sidebar and choose **新建采集**. Describe what you want to follow in the conversation. The first send creates an independent Codex thread using the shared account; returning before sending keeps a draft without creating a collection. The home page shows collection cards with their current objective, plan and latest result.

Continue the same conversation to agree on a goal, change its schedule or pause it. Codex proposes the goal in its workspace's `goal.json`; a successful turn validates and atomically accepts the objective and plan. Rejected proposals appear in the conversation so they can be corrected. The detail page shows the accepted plan and next run time above the full result history, with conversation alongside it. Daily and weekly plans include an explicit time zone; a collection can also have no recurring schedule.

The collection exposes one MCP output tool, `save_feed_result`. Only a successful persistent receipt adds a result to its card and detail; ordinary assistant replies stay in the conversation. Distinct outputs retain their own text, including when they cite the same source. A retry with the same request identity reuses its original receipt. Result bodies render as safe text and Markdown.

Scheduling runs while Mixcat or its tray process is running. Reopening combines missed occurrences into catch-up work in the same native thread. **停止本次运行** holds the queue until **继续队列**; unknown execution outcomes require reconciliation. Native approval/input requests appear in the conversation. New-collection and existing-conversation drafts survive navigation, delayed acknowledgements and normal restart.

Controlled renderer tests cover cards, full result bodies, independent drafts, navigation races, keyboard input and narrow layouts. The production IPC fixture exercises goal-file acceptance, a real scheduler boundary, same-thread execution and the sole HTTP MCP result tool through the actual desktop main/preload/worker, SQLite, pushes and renderer. Its native stdio server is synthetic; it does not establish live-model behavior. See [the feed design](docs/design/2026-10-29-personal-information-feed.md) for the flow and runtime boundaries.

## Web product template

Choose the **Web product** template when creating a new project to start with eight nodes: product manager/coordinator, requirements analyst, UI/UX designer, design tester, architect, frontend developer, backend developer, and implementation tester. The first four form the product-definition group. Requirements and product direction can iterate; design testing feeds corrections back to design. The product manager assembles their versioned results for the architect, who assigns frontend and backend work. Each node's saved outgoing connections generate its collaboration tools, including configured feedback routes.

The template creates missing design documents, an implementation plan, test-report scaffolds, and a shared `.planning/mvp-001/` plan. Existing files and existing projects are preserved. Template nodes initially use the native model configuration; the node editor requires a concrete model and can display the current thread's last recorded actual model.

New Web projects include two human review checkpoints: product direction, then UI/UX. Design waits for product direction; architecture, frontend, and backend execution depend on the applicable approved product and design versions. Independent preparation can continue. Existing projects retain their previous policy and tool permissions.

Recommended configuration uses the actual skill and plugin catalogs. It combines role-specific ECC skills, Superpowers, and planning-with-files; engineering roles also select Ponytail and GitNexus. Missing entries and setup errors remain visible, and configuration can be retried without recreating the project. These recommendations use existing host installations; selecting a name does not establish that a tool or external account works.

Node-based plugins need their declared production dependencies prepared according to their own installation instructions. Mixcat preserves a prepared plugin package, including its local runtime dependencies; it does not run arbitrary plugin install scripts. An upstream package replacement may require preparing that version again.

The template's saved plan binding maps each native thread to the shared plan through project-local adapters that delegate to the official planning-with-files handlers. The simplified node editor does not expose a plan-ID field. On Windows, this optional integration requires Python and Git Bash. Missing or cleared bindings remove stale thread mappings and report a skipped integration while other native work can continue. If a binding cannot be safely updated or removed, dispatch stops before resuming the thread or starting its turn, with a visible error.

Node configuration shows models, skills, plugins, collaboration tools, and discovery errors. It does not display the former MCP/hooks status and trust section. Native hook trust remains a host decision; discovery and recommendation configuration do not grant it. Tool discovery, hook trust, and successful execution are separate checks. Browser executables, GitNexus indexing, and external plugin accounts still need to work in the selected project's native environment.

## Development

Use the project launcher to keep temporary files, caches, and build data within the checkout:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev.ps1 test
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev.ps1 typecheck
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev.ps1 build
```

The application uses Electron, React, TypeScript, and React Flow, with a separate workflow worker integrating Codex `app-server`, local persistence, and the MCP gateway.

The worker retains the latest 32 completed command receipts for up to two minutes, pruning them on subsequent completion, dispatch, or inspection. Pending and unresolved commands remain inspectable. An expired receipt is **unknown**, so inspect persisted tasks and messages before deciding to retry a write. This process-local cache does not provide indefinite or cross-restart deduplication; durable MCP message request IDs have their own persisted replay handling.

Automated tests cover workflow state, delivery, persistence, account handling, and native protocol behavior. Controlled protocol fixtures also support desktop integration checks. These checks do not establish end-to-end compatibility with every live model, plugin, or account.

After building, run the feed's production host and failure-cleanup checks sequentially:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev.ps1 test --test-concurrency=1 tests/feed-production-cleanup-electron.mjs tests/feed-production-ipc-electron.mjs
```

They launch isolated desktop profiles with a controlled native stdio server and exercise the actual main/preload/worker, HTTP MCP, SQLite and renderer path. They do not run a paid model or modify an existing user's feed.

## MCP collaboration

Projects also expose **待办**, **Issue** and **文档** views. Todos support nested work, explicit completion, ordering, reparenting and subtree archive/restore. Issues carry acceptance notes and discussion. Documents edit project files with version/hash conflict checks; interrupted saves retain a recovery record. Work items can open a node's composer with their context, and related executions remain reachable from the item. Finishing an Agent turn does not automatically finish business work.

Management links use stable identities rather than file names. Query results are paginated; detail responses include a cursor for older discussion, references and changes. Code examples are excluded from reference discovery, and Markdown previews do not execute raw HTML. Registered documents must be project-local UTF-8 Markdown files, at most 256 KiB; submitted text fields are limited to 131,072 characters.

Each node keeps its own native Codex thread and runs in the project directory. Every outgoing conditional edge generates a node-specific MCP tool from the saved workflow. The tool binds its destination and describes the edge condition; agents choose an available edge and supply their content. Optional context, history, workflow-editing, and review tools remain configurable per node.

| Tool | Behavior |
| --- | --- |
| `get_project_context` | Read the project, nodes, versioned connection conditions, current task, and incoming message. Capability catalogs are loaded only when requested. |
| `search_project_items` | Search current-project todos, issues and documents, returning summaries and a cursor. |
| `get_project_item` | Read an item, its document hash, references, discussion and recent changes; continue older pages with its cursor or locate a specific comment with `comment_id`. |
| `update_project_item` | Create/edit business items, maintain todo trees, comment, archive/restore and manage documents with expected revisions and durable request IDs. |
| `edge_<hash>` | Generated for one outgoing edge. Persist one message and enqueue its bound target. Content may be any JSON value; no summary, verdict, or business schema is required. |
| `get_delivery` | Recover an accepted receipt by request ID or inspect a message's attempts and explicit replies. |
| `read_history` | Read retained conversation entries with filters and stable pagination. |
| `request_review` | Submit a fixed version of a package for a checkpoint owned by the current node; return its durable receipt immediately. |
| `get_review` | Read a review by ID, or recover the current node's submission by request ID. |
| `update_workflow` | Save versioned nodes or connections within the caller's granted permissions. The legacy single-node form remains supported. |

Agents choose an available edge tool using its condition and description. The saved connection supplies its target; calls do not accept an arbitrary target or require a second routing decision. Conditions guide the agent's choice; Mixcat does not evaluate them as logical expressions. Editing connections updates the tool catalog. Loaded Codex threads refresh it before their next turn while retaining the same thread and history; an active turn is not interrupted.

Sending does not finish the source's turn. Different nodes may execute concurrently, while each node processes its own queue in order. A reply uses an existing outgoing edge tool with `reply_to`; it waits while its recipient is busy and continues that node's original thread. Ordinary output is not broadcast. Project review policies apply to direct user input, edge messages, legacy handoffs, resumed work, and retries. `complete_task` remains configurable. Previous handoff records and internal recovery routines are retained, while arbitrary-target `handoff` and `send_message` are no longer exposed through MCP.

Use a stable `request_id` when retrying a send after a lost response. An accepted replay returns the original receipt; conflicting content is rejected. A receipt confirms durable acceptance, not successful execution. Confirmed user retries preserve the original incoming message and attachment references. Attachments accept a project-relative file path or an already registered artifact ID; the accepted copy has a recorded size and SHA-256 digest. This freezes the attachment bytes, not the entire workspace.

The integrated checks in [the HTTP story](tests/collaboration-http.test.ts) and [the desktop verifier](scripts/verify-desktop.mjs) use actual loopback MCP HTTP, the production workflow worker, and controlled native stdio fixtures. The desktop verifier also exercises real Electron main/preload, persistence, pause/resume/stop, queued recovery, and a connection lost after dispatch. [The native catalog verifier](scripts/verify-dynamic-edge-native.ts) uses a real Codex app-server with a local controlled Responses service to check tool isolation, catalog changes, retained history, and unchanged native capabilities. Live model routing, real plugin accounts, and strong filesystem isolation are separate verification boundaries; see [delivery status](docs/design/2026-10-20-delivery-status.md) and [the dynamic-edge contract](docs/design/2026-10-24-dynamic-edge-mcp.md).

## Human review

Open **Human review rules** in a project's workflow to choose checkpoint owners, dependent nodes, and upstream checkpoints. The project status bar lists pending reviews; review cards show the submitted body, fixed attachments, version, and original decision comments. The desktop user can approve a specific package, request changes with a comment, or withdraw a pending package. Agents can submit and query reviews; they cannot approve them.

Review submissions can select `item_ids` for work-item bodies and `comment_ids` for specific Issue comments. Selected comments retain their original identity, author and time; unrelated Issue edits do not invalidate them.

You can keep typing and sending while a checkpoint is pending. Mixcat saves the original input as a waiting task and starts it only when its captured dependencies are approved. A user decision queues one notification in the submitting node's original thread. Approval preserves explicit node pauses, cancelled tasks, and executions whose outcome still needs reconciliation. A newer package does not silently update old waiting input; cancel obsolete input and submit a fresh task against the current version.

Review approval is separate from Codex permission prompts and hook trust. Opening or enabling a node, sending ordinary chat, and waiting do not create approval. Attachments freeze the selected bytes; the remaining project workspace stays editable. Changes to selected source files or captured upstream material require a current package before dependent dispatch can proceed.

Running work displays a warning when its captured basis becomes stale, while its original input and existing pause/stop controls remain available. A rejected material check identifies the review, selected file, saved/current hash and size, and an available text difference. Text comparison is limited to known UTF-8 text up to 64 KiB and the first changed region, with at most five lines per side and 240 characters per line. Binary files and unavailable originals show the applicable limitation. These checks cover selected material and its captured ancestors; they do not freeze the workspace.

The [default-gate HTTP workflow regression](tests/human-review-workflow.test.ts) and [Electron review checks](tests/human-review-electron.mjs) cover controlled decisions, persistence, material previews, and delayed UI responses. The final reviewed fix passed 393/393 tests, 82/82 focused checks, type checking, build, and a separate 1/1 controlled Electron check. Two authentic human decisions approved the sample's product-direction v1 and UI/UE v1; an actual Chromium session then exercised the resulting UI against its real backend, including text preservation, escaped markup, blank-input errors, keyboard submission, and a narrow layout. The sample backend also passed 18 HTTP cases. The human-review implementation and acceptance plan is complete: the [final audit](.runtime/implementation/human-review-20261022/records/native-completion-audit.json) confirms no unresolved sample execution, valid selected material, exactly one completed original-thread continuation per human decision, and owned-runtime cleanup. See [delivery status](docs/design/2026-10-20-delivery-status.md) for the distinct evidence layers and retained capture/build warnings. No result establishes every node's use of every plugin or compatibility with every browser.

## Local data

| Location | Contents |
| --- | --- |
| `dist/client/` in the checkout | Built desktop application |
| `.runtime/client/` in the checkout | Project index, desktop profile, caches, and logs |
| `.runtime/client/account/` in the checkout | Application-owned Codex sign-in data |
| `.runtime/client/feed/` in the checkout | Personal entries, discoveries, receipts, collection runs and drafts |
| `.runtime/client/feed/collections/` in the checkout | Collection-specific native workspaces and Codex homes |
| `.mixcat/` in each selected project directory | Project state, conversation records, attachments, and runtime data |
| `.mixcat/codex/` in each selected project directory | Project-specific Codex home and native session data |
| `.mixcat/planning/` in each selected project directory | Planning adapters, official handler copies, thread bindings, and their cache |
| `.planning/<plan-id>/` in a product project | Plan, findings, and progress maintained by the assigned owner |

Runtime directories can contain credentials and private project content. Keep them out of version control and shared source archives. Mixcat currently assumes a trusted local user; its project control data is not strongly isolated from an agent's native filesystem access.

## Current boundaries

- Connection conditions guide agent routing; there is no automatic condition interpreter, multi-target atomic send, automatic join, or file conflict resolution.
- Web and file panels provide browsing and previews. An agent browser-control bridge, bidirectional MCP App UI integration, and a full interactive terminal remain future work.
- Notes are independent of projects and support mind-map organization, associations and recycling. Notes and project documents share the Grove-based Markdown reader/editor; note data lives under the workbench root's `.mixcat/notes/`. The knowledge-base entry is a placeholder.
- Native executions whose outcome is unknown after a restart require reconciliation; Mixcat does not automatically replay them or guarantee exactly-once external effects.
- The integration preserves supported native session operations, but does not reproduce every feature of the official Codex desktop client.

## Documentation

- [Design documentation](docs/design/README.md) — architecture, product behavior, and focused design contracts.
- [Implementation status and limitations](docs/design/2026-10-20-delivery-status.md) — implemented capabilities and verification boundaries.
- [Technical architecture](docs/design/2026-10-19-mixcat-technical-architecture.md) — process and integration design, with links to subsequent revisions.
- [Shared sign-in and node deletion](docs/design/2026-10-20-settings-and-node-deletion.md) — account ownership, compatibility, and history retention.
- [Documentation index](docs/README.md) — the complete documentation collection.
- [Prototype archive](prototypes/README.md) — earlier desktop experiments and visual design references; these are separate from the current application.
