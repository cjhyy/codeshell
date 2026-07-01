# CodeShell Architecture

Source-accurate architecture of CodeShell, written against the current tree. This
directory holds two complementary views:

- **The chapters** (`00`–`10`) describe *how the system works* — each subsystem's
  mechanism, anchored to real `file:line` locations. Read `00-overview.md` first;
  the rest stand on their own.
- **[`feature-inventory.md`](feature-inventory.md)** is the *breadth map* — a flat
  inventory of what CodeShell can do today (149 capabilities across desktop main /
  renderer / TUI), each with entry point and usage. It answers "does capability X
  exist and where," where the chapters answer "how does subsystem Y work."

Both describe the as-built system. For *what changed in which release* see the
repo-root [`CHANGELOG.md`](../../CHANGELOG.md); for *planned / not-yet-built* work
see [`docs/todo/`](../todo/README.md).

## Chapters

| # | Chapter | Covers |
|---|---------|--------|
| 00 | [Overview & Reading Path](00-overview.md) | What CodeShell is, the four packages, how to read this set |
| 01 | [Engine & Turn Loop](01-engine-and-turn-loop.md) | The core run loop, context management, cancellation |
| 02 | [Tool System](02-tool-system.md) | Builtin tools, executor, permissions, presets |
| 03 | [LLM & Model Layer](03-llm-and-model-layer.md) | Adapters, model catalog, capabilities, reasoning control |
| 04 | [Protocol & Sessions](04-protocol-and-sessions.md) | Stream events, session persistence, replay |
| 05 | [Presets, Prompt, Hooks, Skills](05-presets-prompt-hooks-skills.md) | System prompt assembly, hook pipeline, skills |
| 06 | [Long-Running Orchestration](06-long-running-orchestration.md) | Sub-agents, background work, tasks, cron, goals |
| 07 | [Plugins, Capabilities, Credentials, Memory](07-plugins-capabilities-credentials-memory.md) | Extension surface, credential store, memory & Dream |
| 08 | [Arena & Integrations](08-arena-and-integrations.md) | Arena, CC/Codex orchestration, external CLIs |
| 09 | [TUI Package](09-tui.md) | The `code-shell` terminal client (Ink) |
| 10 | [Desktop & Mobile](10-desktop-and-mobile.md) | Electron main/renderer/IPC, panels, phone remote |

## Reference

- [Feature inventory (desktop / tui)](feature-inventory.md) — full capability breadth map

> The prior architecture set lives in [`docs/archive/architecture/`](../archive/architecture/README.md);
> it is kept for history but predates large subsystems. This directory supersedes it.
