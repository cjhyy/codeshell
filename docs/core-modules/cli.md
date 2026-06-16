# cli

**One-line role.** Self-running process entry points that bootstrap an `EngineRuntime` + `ChatSessionManager` and serve the agent protocol to a host — over stdio (Electron worker) or TCP (headless server) — plus the shared graceful-shutdown helper.

## 职责 / Responsibility

This module contains the *process boot scripts* a host spawns to run agent sessions, not a library you import. Each entry file wires up the standard stack — a "seed" `Engine` to populate the model pool/tool registry from settings, a shared `EngineRuntime`, a `ChatSessionManager` whose `engineFactory` builds per-session engines, and an `AgentServer` bound to a transport. The two entries differ only in transport and lifecycle: `agent-server-stdio` is the on-demand Electron worker (NDJSON over stdin/stdout, cron persistence-only), while `agent-server-tcp` is the always-on headless host (one `AgentServer` per TCP connection, plus the in-process automation scheduler that actually runs cron jobs). The boundary stops at process bootstrap; the protocol/engine/settings logic lives in their own modules.

## 文件 / Files

| File | Purpose |
| --- | --- |
| `agent-server-stdio.ts` | Electron worker entry. Bootstraps the shared runtime and serves `AgentServer` over `StdioTransport` (NDJSON). Re-reads settings per new session; persists cron jobs only (execution disabled); reaps orphaned background shells on boot. Exports `resolveSessionAgentConfig`. |
| `agent-server-tcp.ts` | Headless server entry (Phase 6). Same bootstrap, but listens via `listenTcp` and spawns one `AgentServer` per connection. Also calls `startAutomation(...)` so scheduled jobs run 7x24 with no GUI. Binds `127.0.0.1`, no auth in v1. |
| `graceful-shutdown.ts` | `installGracefulShutdown(server, options?)` — registers SIGTERM/SIGINT/SIGHUP handlers that call `server.close()` once then `process.exit(0)`. Idempotent, best-effort. |
| `__tests__/graceful-shutdown.test.ts`, `__tests__/agent-server-stdio-factory.test.ts` | Tests for the shutdown helper and the per-session engine factory / `resolveSessionAgentConfig`. |

## 公开接口 / Public API

The entry scripts are **not** re-exported from `packages/core/src/index.ts` — hosts spawn the *file* (its built `.js`), they do not import it. The previous named exports (`runAgentServerStdio`, `buildEngineConfigFromSettings`) were removed in the multi-session rewrite. Two named symbols are exported for tests / reuse:

```ts
// graceful-shutdown.ts
export interface GracefulShutdownOptions {
  proc?: ProcLike;          // injectable for tests; defaults to globalThis.process
  signals?: string[];       // defaults to ["SIGTERM", "SIGINT", "SIGHUP"]
}
export function installGracefulShutdown(
  server: { close(): void },
  options?: GracefulShutdownOptions,
): void;

// agent-server-stdio.ts
export function resolveSessionAgentConfig(
  slice: EngineConfigSlice,        // per-session protocol overrides
  settings: ValidatedSettings,     // disk settings fallback
): { preset; customSystemPrompt; appendSystemPrompt };
// Slice wins, else falls back to settings.agent.* — fixes settings.agent.*
// never reaching session engines.
```

The real "interface" is the **spawn contract**: launch the file as a Node process, configured by env vars.

- `agent-server-stdio`: env `AGENT_CWD` (boot cwd; defaults to `process.cwd()`). Subpackage export: `@cjhyy/code-shell-core/bin/agent-server-stdio` → `dist/cli/agent-server-stdio.js`.
- `agent-server-tcp`: env `AGENT_CWD`, `AGENT_TCP_PORT` (default `4321`), `AGENT_TCP_HOST` (default `127.0.0.1`).

## 怎么用 / How to use

**Host spawns the stdio worker** (real call site: `packages/desktop/src/main/agent-bridge.ts`). The desktop main process resolves the bin export and spawns it as a child of the Electron-as-node runtime, then pipes NDJSON both ways:

```ts
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const agentEntry = require.resolve("@cjhyy/code-shell-core/bin/agent-server-stdio");

const child = spawn(process.execPath, [agentEntry], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", AGENT_CWD: projectDir },
  stdio: ["pipe", "pipe", "pipe"],
});
// renderer line  → child.stdin.write(line + "\n")
// child.stdout   → readline → window.webContents.send("agent:msg", line)
```

**Run the headless TCP server** (from its own file header):

```sh
AGENT_TCP_PORT=4321 node dist/cli/agent-server-tcp.js
# logs: [code-shell] automation server listening on 127.0.0.1:4321
```

**Inside an entry script**, the shutdown helper is wired once after the server exists:

```ts
const agentServer = new AgentServer({ chatManager, transport, settingsReader });
installGracefulShutdown(agentServer);
// SIGTERM/SIGINT/SIGHUP → agentServer.close() (reaps sessions + bg shells) → exit(0)
```

## 注意 / Gotchas

- **These files run on import.** They are top-level scripts (the seed Engine, runtime, server are all constructed at module scope). Importing one *starts a worker*. Treat them as process entry points, not modules — that is why they are excluded from `index.ts`.
- **Seed-engine bootstrap.** Both entries build a throwaway `Engine` with no runtime purely so its constructor's `populateModelPoolFromSettings()` reads settings and builds the model pool / tool registry; those are then extracted into a shared `EngineRuntime`. The seed engine never runs a task — don't "optimize it away."
- **Settings scope must be `"full"`.** Hosts read the whole disk hierarchy (incl. `~/.code-shell`), not the SDK default `"project"`, or user-level config and MCP servers silently vanish.
- **Settings hot-reload is per-new-session only.** stdio re-reads settings via `freshSettings()` (best-effort: falls back to the boot snapshot if the freshly edited `settings.json` is malformed) inside `engineFactory` and `settingsReader`. Already-running sessions are NOT hot-reloaded here. TCP pins the boot-time `settings` snapshot in its factory.
- **Cron split-brain (stdio only).** The stdio worker sets `cronScheduler.setExecutionEnabled(false)` — it persists chat-created jobs to the shared `~/.code-shell/cron.json` but must NOT run them; the Electron main process owns execution. TCP, by contrast, *does* run jobs via `startAutomation`. Don't arm timers in the stdio worker or jobs double-run and corrupt run stats.
- **MCP servers must be passed to the session Engine.** The factory merges plugin-provided servers via `mergePluginMcpServers(...)` and folds project `capabilityOverrides` over global `disabledPlugins` (`computeEffectiveDisabledLists`) before the merge. Omitting `mcpServers` leaves `config.mcpServers === undefined` and no server ever connects.
- **TCP v1 has no auth and binds loopback.** Do not expose to a public interface; use SSH tunneling for remote access.
- **`installGracefulShutdown` is idempotent and best-effort.** First signal runs `close()` exactly once; a throwing `close()` is swallowed so the process still exits. Pass `proc`/`signals` to test it without touching the real `process`.
- **Must rebuild.** Hosts spawn the built `dist/cli/*.js` (via the `./bin/agent-server-stdio` package export). Source edits don't take effect until `core` is rebuilt.
