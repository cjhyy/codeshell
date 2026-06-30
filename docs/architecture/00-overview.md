# 00 · CodeShell Architecture — Overview & Reading Path

> A source-accurate architecture of CodeShell, written against the current tree (commit `060c22e0`, 2026-06-30). This set supersedes the prior `docs/archive/architecture/` documents, which are kept for history but predate large subsystems (Codex orchestration, the unified model catalog, the phone remote, capability control). Each chapter is anchored to real `file:line` locations and intended to read on its own.

## What CodeShell is

CodeShell is **one agent-orchestration engine wearing three faces**:

- a terminal CLI (`code-shell`) — interactive REPL and headless `run`;
- an Electron **desktop app** — chat, a file/browser/terminal/diff panel dock, model & credential management, an extensions marketplace, automation, persistent goals, memory, and a phone remote; and
- a programmatic **SDK** — `import { Engine } from "@cjhyy/code-shell"`.

The core is deliberately **domain-agnostic**: the turn loop, context management, permissions, MCP, hooks, tasks, cron, sub-agents, sessions, and memory are all generic. Coding behavior is a *preset* layered on top, not baked into the engine (`packages/core/CONTRIBUTING.md`: "core only carries mechanism, not policy"). Status: `0.5.0-rc.2`, preparing for beta.

## The four packages

```
packages/
├── core/      Engine, tools, MCP, hooks, sessions, runs, automation, presets, LLM,
│              model catalog, plugins, capabilities, credentials, memory, arena, cc-orchestrator
├── tui/       Terminal CLI, Ink REPL, custom terminal renderer, slash commands
├── desktop/   Electron main (service broker) + per-session core worker + React renderer + mobile remote
└── cdp/       Environment-agnostic CDP browser-action layer (no Playwright)
```

`@cjhyy/code-shell` (root) is a meta-package re-exporting core + bundling the CLI. The build is `core → tui → build-meta`, with `sync-models` fetched first (the build depends on it).

## The layered picture

```
   CLI · headless · SDK · desktop renderer · phone remote
                          │
                  AgentClient  ⇄  AgentServer        ← protocol seam (in-process / stdio / tcp)
                          │
                       Engine.run
                          │
   preset → prompt ─▶ TurnLoop ◀─ context manager
                          │
        model stream ─ tool execution ─ hooks ─ lifecycle StreamEvents
                          │
   ModelFacade/LLM   ToolRegistry+Executor (permission · path · sandbox · MCP)
                          │
       sessions · transcripts · runs · memory · cron   (durable, under ~/.code-shell)
```

The non-obvious load-bearing decisions:

- **Everything runs through the protocol seam.** Every `engine.run` — CLI, desktop worker, even in-process REPL — goes through `AgentServer` + `AgentClient`, so the permission allowlist and lifecycle are enforced at one place. ([04](04-protocol-and-sessions.md))
- **The desktop main process is a broker, not an executor.** It spawns a per-session core worker and streams its stdout to a thin renderer that imports no core code. ([10](10-desktop-and-mobile.md))
- **Behavior is configuration.** A preset selects the system prompt sections, the builtin-tool whitelist, and permission defaults. ([05](05-presets-prompt-hooks-skills.md))
- **The tool executor is the single choke point.** Permission, path policy, plan mode, and hooks all run there; nothing bypasses it, and it never throws. ([02](02-tool-system.md))
- **Provider divergence is data, not code.** Per-model quirks live in a capabilities `RULES` table; clients have no per-model `switch`. ([03](03-llm-and-model-layer.md))
- **Long-running work is first-class.** Runs, cron, persistent goals, sub-agents, and background shells all survive process restarts and wake an idle engine on completion. ([06](06-long-running-orchestration.md))

## Reading path

| # | Chapter | Read it for |
|---|---------|-------------|
| 01 | [Engine & turn loop](01-engine-and-turn-loop.md) | How `Engine.run` drives a turn; context compaction; steering; goal ceilings; invariants |
| 02 | [Tool system](02-tool-system.md) | Registry → executor → permission/path/sandbox/MCP; the builtin tools; the two-place gotcha |
| 03 | [LLM & model layer](03-llm-and-model-layer.md) | Tag → catalog → provider client; capabilities RULES; reasoning/params; streaming & cost |
| 04 | [Protocol & sessions](04-protocol-and-sessions.md) | The RPC seam, transports, the run path; transcripts, undo, disk recovery |
| 05 | [Presets, prompt, hooks, skills](05-presets-prompt-hooks-skills.md) | How behavior is configured; prompt assembly & cache breakpoint; hook chain; skills |
| 06 | [Long-running orchestration](06-long-running-orchestration.md) | RunManager state machine; cron & the read-only contract; persistent goals |
| 07 | [Plugins, capabilities, credentials, memory](07-plugins-capabilities-credentials-memory.md) | Plugin install (CC/Codex); capability projection; credential store; memory + Dream |
| 08 | [Arena & integrations](08-arena-and-integrations.md) | Multi-model Arena (review vs author); CC/Codex orchestration; STT; review |
| 09 | [TUI package](09-tui.md) | The CLI, the Ink REPL, the custom terminal renderer |
| 10 | [Desktop & mobile](10-desktop-and-mobile.md) | The three-process model; main services; renderer panels; phone remote; CDP |

## Cross-cutting: settings, onboarding, disk layout

These underpin every chapter and live mostly in `packages/core/src/settings/`, `onboarding.ts`, `runtime/`, and `utils/`.

**Settings merge order** (`settings/manager.ts`): managed < user < project < local < flags. `SettingsScope` gates which layers are read: `"full"` (host terminals, includes `~/.code-shell`), `"project"` (default; project+local only — SDK isolation), `"isolated"` (flags only). The `agent.*` block (`preset`, `enabledBuiltinTools`/`disabledBuiltinTools`, `customSystemPrompt`, `appendSystemPrompt`, `responseLanguage`, `userProfile`) feeds the engine via `personalizationFrom`. Config carries a version (`CURRENT_CONFIG_VERSION`) with `migrate-config.ts` migrations. **Hot-reload** rides `Configure({reloadSettings})` → `refreshRuntimeConfig` on each live session at turn boundaries (the config-hotreload-layer2 note); builtin-tool-set changes still need a session restart.

**Onboarding** (`onboarding.ts`): first-run key detection (`detectEnvKeys` + `sanitizeApiKey`), provider inference from key prefix, optimistic key validation, and model-pool seeding from `data/model-metadata.json` (PROVIDERS, KNOWN_MAX_OUTPUT/CONTEXT_WINDOWS) — externalized so model data updates without a code rebuild.

**Runtime** (`runtime/`): the worker-process subprocess layer — `BackgroundShellManager` (detached, own pgid, 8 MB `RingFile` output cap, orphan reaping), and `spawn-common.ts` with an env allowlist + deny-regex (drops `*KEY*/*TOKEN*/*SECRET*…`) and `killProcessGroup` guarded to `pgid > 1` (the killprocessgroup-pgid-guard note — removing that guard once SIGKILL'd the test runner).

**Disk layout** under `~/.code-shell/` (test-isolated via `CODE_SHELL_HOME` / `userHome()`, never bare `homedir()` — the test-pollutes-real-settings note):
```
settings.json · settings.managed.json · credentials.json(0o600) · cron.json
model-catalog.user.json · auto-dream-state.json
sessions/<id>/{state.json, transcript.jsonl, file-history/}
session-memories/ · memory/ · memory-trash/ · dream/
runs/<id>/{run.json, events.jsonl, checkpoints/, approvals/, artifacts/, heartbeat}
plugins/{installed_plugins.json, known_marketplaces.json, cache/, marketplaces/}
logs/ · bg-shells/ · cache/models/ · mcp_images/ · agents/ · skills/
```

## Primary source anchors

- Public API surface: `packages/core/src/index.ts`
- Engine facade / turn loop: `packages/core/src/engine/engine.ts`, `engine/turn-loop.ts`
- Tool registry/executor: `packages/core/src/tool-system/registry.ts`, `tool-system/executor.ts`
- Protocol: `packages/core/src/protocol/{server,client,types,factories}.ts`
- Presets: `packages/core/src/preset/index.ts`
- TUI entry: `packages/tui/src/cli/main.ts`
- Desktop main / preload / worker spawn: `packages/desktop/src/main/index.ts`, `main/agent-bridge.ts`, `src/preload/index.ts`

## A note on accuracy

Each chapter was produced by reading the current source, not the archived docs. `file:line` anchors are accurate as of commit `060c22e0`; line numbers drift as code moves, so treat them as "look near here" rather than exact addresses, and verify a symbol still exists before relying on it. When a chapter cites a design rationale, it reflects the code and design notes at the time of writing.
