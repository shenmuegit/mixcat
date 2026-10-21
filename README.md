# Mixcat

An independent desktop workbench for persistent Codex conversations and collaborative workflows.

Mixcat organizes projects into cards and conversations into an editable workflow canvas. Each node has its own Codex session, conversation history, model selection, and configured skills or plugins. Agents can pass work to other nodes through a local Model Context Protocol (MCP) service, including review and revision loops, while users can message any node directly.

**Status: early development preview.** Run from source on Windows. Packaged installers are not available, and the current interface and most design documentation are in Chinese. Mixcat is an independent project, not an official OpenAI client.

## Features

- **Project workspace:** project cards, an editable node canvas, related-node creation, and editable connection conditions.
- **Persistent conversations:** a separate Codex thread for each node, using the project's directory as its working directory.
- **Direct interaction:** send messages and attachments to any node; inspect current activity, responses, and native requests for approval or input.
- **Agent collaboration:** durable MCP messages with free JSON content, explicit replies, delivery receipts, immutable attachment snapshots, and optional handoff or review workflows.
- **Execution controls:** pause and resume individual nodes, a project, or the workbench. Bulk resume restores executions captured by the corresponding pause operation.
- **Project history:** chronological conversation records with node attribution and distinct incoming and outgoing content. Removing a node preserves its history and project files.
- **Work panels:** embedded web browsing and previews of project text, SVG, HTML, and PDF files.
- **Shared sign-in:** one Codex account for the application, with separate project sessions and working directories.

## Requirements

- Windows and PowerShell.
- Node.js **24 or later**, with npm available.
- An installed Codex CLI that supports `app-server`, plus a Codex account for native model execution.
- A checkout and project directories on a **drive other than C:**. The current launcher rejects symbolic links, directory junctions, and linked ancestor directories. Project directories must already exist.

The native integration has been checked against Codex CLI `0.163.0-alpha.10.2`. Shared sign-in currently depends on an internal, unstable Codex authentication interface; other versions may require compatibility changes.

## Getting started

Clone the repository into a location on a drive other than C:, then run:

```powershell
git clone https://github.com/shenmuegit/mixcat.git
cd mixcat
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev.ps1 install
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev.ps1 start
```

The launcher discovers Node.js and Codex locally. If discovery does not find the intended executables, set `MIXCAT_NODE` and `MIXCAT_CODEX` to their absolute executable paths before running it. The `start` command builds the application and opens the Electron client.

Open **Settings** using the gear at the bottom-left, then select **Log in to Codex**. Mixcat connects automatically as part of sign-in. The button changes to a confirmed signed-in state after authentication, and saved sign-in is restored on subsequent launches.

Create a project using an existing directory, open its workflow, and select a node to start a conversation. Closing the window keeps Mixcat in the system tray; use the tray's exit action to stop the application.

## Development

Use the project launcher to keep temporary files, caches, and build data within the checkout:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev.ps1 test
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev.ps1 typecheck
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev.ps1 build
```

The application uses Electron, React, TypeScript, and React Flow, with a separate workflow worker integrating Codex `app-server`, local persistence, and the MCP gateway.

Automated tests cover workflow state, delivery, persistence, account handling, and native protocol behavior. Controlled protocol fixtures also support desktop integration checks. These checks do not establish end-to-end compatibility with every live model, plugin, or account.

## MCP collaboration

Each node keeps its own native Codex thread and runs in the project directory. Enable the desired collaboration tools in the node configuration and save before starting work. Existing projects retain their previous permissions; the new message and history tools are not granted automatically.

| Tool | Behavior |
| --- | --- |
| `get_project_context` | Read the project, nodes, versioned connection conditions, current task, and incoming message. Capability catalogs are loaded only when requested. |
| `send_message` | Persist one message and enqueue one target task. Content may be any JSON value; no summary, verdict, or business schema is required. |
| `get_delivery` | Recover an accepted receipt by request ID or inspect a message's attempts and explicit replies. |
| `read_history` | Read retained conversation entries with filters and stable pagination. |
| `update_workflow` | Save versioned nodes or connections within the caller's granted permissions. The legacy single-node form remains supported. |

Agents choose collaborators using node responsibilities and natural language connection conditions. A message may target any available node in the same project without a connection, with a recorded reason. An explicit connection reference must match its current revision. Conditions guide the agent's choice; Mixcat does not evaluate them as logical expressions.

Sending does not finish the source's turn. Different nodes may execute concurrently, while each node processes its own queue in order. A reply is another explicit `send_message` with `reply_to`; it waits while its recipient is busy and continues that node's original thread. Ordinary output is not broadcast, and review is required only when the user's task requires it. The compatibility tools `handoff` and `complete_task` remain available with their existing semantics.

Use a stable `request_id` when retrying a send after a lost response. An accepted replay returns the original receipt; conflicting content is rejected. A receipt confirms durable acceptance, not successful execution. Confirmed user retries preserve the original incoming message and attachment references. Attachments accept a project-relative file path or an already registered artifact ID; the accepted copy has a recorded size and SHA-256 digest. This freezes the attachment bytes, not the entire workspace.

The integrated checks in [the HTTP story](tests/collaboration-http.test.ts) and [the desktop verifier](scripts/verify-desktop.mjs) use actual loopback MCP HTTP, the production workflow worker, and controlled native stdio fixtures. The desktop verifier also exercises real Electron main/preload, persistence, pause/resume/stop, queued recovery, and a connection lost after dispatch. Live model routing, real plugin accounts, and strong filesystem isolation are separate verification boundaries; see [delivery status](docs/design/2026-10-20-delivery-status.md) and [the collaboration contract](docs/design/2026-10-21-mcp-collaboration-design.md).

## Local data

| Location | Contents |
| --- | --- |
| `dist/client/` in the checkout | Built desktop application |
| `.runtime/client/` in the checkout | Project index, desktop profile, caches, and logs |
| `.runtime/client/account/` in the checkout | Application-owned Codex sign-in data |
| `.mixcat/` in each selected project directory | Project state, conversation records, attachments, and runtime data |
| `.mixcat/codex/` in each selected project directory | Project-specific Codex home and native session data |

Runtime directories can contain credentials and private project content. Keep them out of version control and shared source archives. Mixcat currently assumes a trusted local user; its project control data is not strongly isolated from an agent's native filesystem access.

## Current boundaries

- Connection conditions guide agent routing; there is no automatic condition interpreter, multi-target atomic send, automatic join, or file conflict resolution.
- Web and file panels provide browsing and previews. An agent browser-control bridge, bidirectional MCP App UI integration, and a full interactive terminal remain future work.
- Notes and knowledge-base entries are placeholders.
- Native executions whose outcome is unknown after a restart require reconciliation; Mixcat does not automatically replay them or guarantee exactly-once external effects.
- The integration preserves supported native session operations, but does not reproduce every feature of the official Codex desktop client.

## Documentation

- [Design documentation](docs/design/README.md) — architecture, product behavior, and focused design contracts.
- [Implementation status and limitations](docs/design/2026-10-20-delivery-status.md) — implemented capabilities and verification boundaries.
- [Technical architecture](docs/design/2026-10-19-mixcat-technical-architecture.md) — process and integration design, with links to subsequent revisions.
- [Shared sign-in and node deletion](docs/design/2026-10-20-settings-and-node-deletion.md) — account ownership, compatibility, and history retention.
- [Documentation index](docs/README.md) — the complete documentation collection.
- [Prototype archive](prototypes/README.md) — earlier desktop experiments and visual design references; these are separate from the current application.
