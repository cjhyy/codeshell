# CodeShell Architecture

Source-accurate architecture of CodeShell, written against the current tree. This
directory holds two complementary views:

- **The chapters** (`00`–`14`) describe _how the system works_ — each subsystem's
  mechanism, anchored to real `file:line` locations. Read `00-overview.md` first;
  the rest stand on their own.
- **[`11-feature-inventory.md`](11-feature-inventory.md)** is the _breadth map_ — a flat
  inventory of what CodeShell can do today (179 capabilities across desktop main /
  renderer / TUI), each with entry point and usage. It answers "does capability X
  exist and where," where the chapters answer "how does subsystem Y work."

Most subsystem chapters embed generated PNG architecture diagrams under
[`images/`](images/); newer focused chapters may use source-controlled Mermaid
when that keeps the relationship easier to maintain.

Both describe the as-built system. For _what changed in which release_ see the
repo-root [`CHANGELOG.md`](../../CHANGELOG.md); for _planned / not-yet-built_ work
see [`docs/todo/`](../todo/README.md).

## Chapters

| #   | Chapter                                                                                     | Covers                                                                                |
| --- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 00  | [Overview & Reading Path](00-overview.md)                                                   | What CodeShell is, the ten workspace packages, how to read this set                   |
| 01  | [Engine & Turn Loop](01-engine-and-turn-loop.md)                                            | The core run loop, context management, cancellation                                   |
| 02  | [Tool System](02-tool-system.md)                                                            | Builtin tools, executor, permissions, presets                                         |
| 03  | [LLM & Model Layer](03-llm-and-model-layer.md)                                              | Adapters, model catalog, capabilities, reasoning control                              |
| 04  | [Protocol & Sessions](04-protocol-and-sessions.md)                                          | Stream events, session persistence, replay                                            |
| 05  | [Presets, Prompt, Hooks, Skills](05-presets-prompt-hooks-skills.md)                         | System prompt assembly, hook pipeline, skills                                         |
| 06  | [Long-Running Orchestration](06-long-running-orchestration.md)                              | Sub-agents, background work, tasks, cron, goals                                       |
| 07  | [Plugins, Capabilities, Credentials, Memory](07-plugins-capabilities-credentials-memory.md) | Extension surface, credential store, memory & Dream                                   |
| 08  | [Arena & Integrations](08-arena-and-integrations.md)                                        | Arena, CC/Codex orchestration, external CLIs                                          |
| 09  | [TUI Package](09-tui.md)                                                                    | The `code-shell` terminal client (Ink)                                                |
| 10  | [Desktop & Mobile](10-desktop-and-mobile.md)                                                | Electron main/renderer/IPC, panels, phone remote                                      |
| 11  | [Feature Inventory](11-feature-inventory.md)                                                | Flat breadth map — 179 capabilities across desktop main / renderer / TUI              |
| 12  | [Package Boundaries & Release Units](12-package-boundaries-and-release-units.md)            | Monorepo dependency direction, Pet split rationale, exports and publish boundaries    |
| 13  | [Plugin Parity & Video Editor](13-plugin-parity-and-video-editor.md)                        | Codex compatibility matrix, remaining gaps, and the video-editor reference plugin     |
| 14  | [Digital Humans & Pet](14-digital-human-and-pet.md)                                         | Profile/team lifecycle, Pet projection, persistence, recovery and security boundaries |

## Reference

- [Feature inventory (desktop / tui)](11-feature-inventory.md) — full capability breadth map

> The prior architecture set lives in [`docs/archive/architecture/`](../archive/architecture/README.md);
> it is kept for history but predates large subsystems. This directory supersedes it.
