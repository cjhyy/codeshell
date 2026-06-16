# runtime

**One-line role.** Core's subprocess execution layer: it owns how a shell command becomes an OS process (sandbox-wrapped spawn, env hardening, platform shell selection), how that process is reaped (single-child or whole process-group kill), and how its output is captured, cleaned, and bounded — for both foreground (one-shot `Bash`) and fire-and-forget background shells.

## 职责 / Responsibility

This module is the single source of truth for spawning and killing child processes in core. Every shell-touching feature — the `Bash` tool, `REPL`, `PowerShell`, `gitOps`, hook scripts, worktree setup, and long-lived background dev servers — routes through it so sandbox semantics, the env allowlist/deny-regex, the POSIX-vs-Windows shell fork, and the SIGTERM→grace→SIGKILL kill cascade can't drift apart between paths. It deliberately does **not** do permission classification, retries, or user-facing output formatting — those stay with the calling tool. Boundary: it knows about `SandboxBackend` and processes; it knows nothing about turns, LLMs, or sessions (the background manager only carries an opaque `sessionId` for bucketing).

> Note: despite the directory name, this is **not** about runtime *config* / hot-reload — that plumbing is `EngineRuntime` (`engine/runtime.ts`) and `Engine.refreshRuntimeConfig`, a different module.

## 文件 / Files

| File | Purpose |
| --- | --- |
| `safe-spawn.ts` | Unified subprocess lifecycle wrapper: sandbox wrap, UTF-8 drain, per-stream byte cap, abort + timeout kill cascade, listener cleanup. Two entry points (`safeSpawn`, `safeSpawnShell`). |
| `spawn-common.ts` | Primitives shared by foreground + background: `(file,args)` resolution under sandbox, env allowlist/deny hardening, project-env merge, single-child and process-group kill, platform shell selection. |
| `background-shell.ts` | `BackgroundShellManager` + the `backgroundShellManager` singleton — session-scoped registry/lifecycle for detached `run_in_background` shells (spawn, read, kill, orphan recovery). |
| `ring-file.ts` | `RingFile` — bounded wrap-around (last 8MB) output sink for a background shell; in-memory tail authoritative, mirrored to disk, with absolute-offset reads that survive wraparound. |
| `output-clean.ts` | `stripAnsi` / `foldProgressLines` / `cleanOutput` — sanitize raw process output (ANSI + `\r` progress redraws) before handing it to the model. |
| `truncate-output.ts` | `truncateHeadTail` — head+tail truncation for over-long one-shot command output (keeps the error/summary at the end, not just the start). |
| `*.test.ts` | Unit/regression tests (background-shell, kill-win32, ring-file, output-clean, truncate-output, shell-invocation, spawn-common). |

There is **no `index.ts`** in this directory. Consumers import the individual `.js` files (e.g. `../../runtime/safe-spawn.js`); the package barrel (`src/index.ts`) re-exports `backgroundShellManager` from `runtime/background-shell.js`.

## 公开接口 / Public API

`safe-spawn.ts`
```ts
function safeSpawn(file: string, args: string[], opts: SafeSpawnOptions): Promise<SafeSpawnResult>;
function safeSpawnShell(command: string, opts: SafeSpawnShellOptions): Promise<SafeSpawnResult>;
// SafeSpawnOptions:      { cwd; env; timeoutMs; maxOutputBytes?; ioDrainGraceMs?; signal? }
// SafeSpawnShellOptions: SafeSpawnOptions & { sandbox?: SandboxBackend; shell? }
// SafeSpawnResult:       { reason: "ok"|"timeout"|"aborted"|"spawn_failed";
//                          stdout; stderr; exitCode; signal;
//                          stdoutTruncated; stderrTruncated; timedOut; aborted; spawnFailed; error? }
```

`spawn-common.ts`
```ts
const ENV_ALLOWLIST: ReadonlySet<string>;
const ENV_DENY_REGEX: RegExp;
function buildSandboxEnv(source?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;      // allowlist ∖ deny-regex
function mergeShellEnv(base: NodeJS.ProcessEnv, projectEnv?: Record<string,string>): NodeJS.ProcessEnv;
function resolveShellInvocation(command: string, shell?: string): { file: string; args: string[] };
function defaultShellBinary(shell?: string): string;
function resolveSpawnTarget(command: string, opts: { cwd; shell; sandbox? }): SpawnTarget; // { file; args; cleanup? }
function killChildTree(child: { pid?: number; kill(sig?): boolean }, graceMs: number): void;
function killProcessGroup(pgid: number, opts?: { graceMs? }): Promise<void>;
function groupAlive(pgid: number): boolean;
```

`background-shell.ts`
```ts
class BackgroundShellManager {
  spawnBackground(opts: SpawnBackgroundOptions): SpawnResult;             // { ok; shellId } | { ok:false; error }
  get(shellId): BgShell | undefined;
  listForSession(sessionId): BgShell[];
  readOutput(shellId, mode?: "incremental"|"all", expectSessionId?): ReadResult;
  kill(shellId, expectSessionId?): Promise<KillResult>;
  killSession(sessionId): Promise<void>;
  killAll(): Promise<void>;
  reapOrphansFromPidfiles(): PidfileRecord[];
}
const backgroundShellManager: BackgroundShellManager;   // process-local singleton
const MAX_SHELLS_PER_SESSION = 16;
```

`output-clean.ts`: `stripAnsi(s)`, `foldProgressLines(s)`, `cleanOutput(s)`.
`truncate-output.ts`: `truncateHeadTail(text, { cap; headRatio? })`.
`ring-file.ts`: `class RingFile(path, capBytes, readonlyExisting?)` — internal to the background manager.

## 怎么用 / How to use

Foreground shell tool (real call site, `tool-system/builtin/bash.ts`) — build a hardened env, spawn through the sandbox, then truncate the body:

```ts
import { safeSpawnShell } from "../../runtime/safe-spawn.js";
import { truncateHeadTail } from "../../runtime/truncate-output.js";
import { buildSandboxEnv, mergeShellEnv, defaultShellBinary } from "../../runtime/spawn-common.js";

const shell = defaultShellBinary();
// `off` backend keeps full env passthrough; otherwise harden to the allowlist.
const baseEnv = backend.name === "off" ? { ...process.env } : buildSandboxEnv();
const env = mergeShellEnv(baseEnv, ctx?.shellEnv);   // layer project localEnvironment.env on top

const result = await safeSpawnShell(command, {
  cwd, env, timeoutMs: timeout, maxOutputBytes: MAX_BUFFER,
  sandbox: backend, shell, signal: ctx?.signal,
});
if (result.aborted) return "Bash aborted by signal.";
if (result.timedOut) return `Command timed out after ${timeout}ms`;
let body = result.stdout + (result.stderr ? `\nSTDERR:\n${result.stderr}` : "");
if (body.length > MAX_OUTPUT) body = truncateHeadTail(body, { cap: MAX_OUTPUT });
```

Background dev server via the singleton (`Bash(run_in_background=true)` path + `protocol/server.ts` RPC handlers):

```ts
import { backgroundShellManager } from "../../runtime/background-shell.js";

const spawned = backgroundShellManager.spawnBackground({
  command: "npm run dev", cwd, sessionId,
  sandbox: backend, shellEnv: ctx?.shellEnv,
});
if (!spawned.ok) return spawned.error;          // e.g. over MAX_SHELLS_PER_SESSION

// later — agent reads incremental output (cleaned + capped, session-ownership enforced):
const out = backgroundShellManager.readOutput(spawned.shellId, "incremental", sessionId);
// on session delete / app exit:
await backgroundShellManager.killSession(sessionId);
await backgroundShellManager.killAll();
// on worker startup, recover dev servers an earlier crashed worker left behind:
const orphans = backgroundShellManager.reapOrphansFromPidfiles();
```

Direct argv spawn when the binary is known (`gitOps.ts`, `repl.ts`, `powershell.ts`): use `safeSpawn(file, args, { cwd, env, timeoutMs, signal })` instead of `safeSpawnShell`.

## 注意 / Gotchas

- **Env hardening only applies under a real sandbox.** `buildSandboxEnv()` (allowlist ∖ deny-regex) is the gate that stops a tainted model exfiltrating host secrets via `env | curl`. With `backend.name === "off"` callers pass full `process.env` by design. `mergeShellEnv` layers user-configured project env on top and is **intentionally not** deny-filtered — those are a different trust class. Don't "fix" that.
- **Detached spawn ⇒ pgid == pid, and only then can you group-kill.** Background shells spawn `detached` on POSIX so `killProcessGroup(-pgid)` reaps the whole `sh → npm → node vite` tree. Foreground `safeSpawn` is **not** detached, so it uses `killChildTree` (single child). Windows has no process groups: both kill paths fall back to `taskkill /T /F` and there is no graceful phase.
- **Incremental reads use an absolute stream offset, not a window-relative one.** `RingFile` wraps at 8MB; `agentReadOffset` tracks `totalWritten()` (monotonic) so a read after wraparound doesn't silently skip bytes. If you add a new reader, use `sliceFromAbsolute`, not `sliceFrom`.
- **`backgroundShellManager` is a process-local singleton and lives in the worker process.** It is deliberately separate from `asyncAgentRegistry` so `Engine.run`'s wait-for-background loop never blocks on a dev server. Crashing the worker leaks detached children as orphans — pidfiles under `~/.code-shell/bg-shells/<sessionId>/` let a restarted worker find and reap them via `reapOrphansFromPidfiles()`. Recovered orphans open their `.log` read-only (the live process in the dead worker still owns writes).
- **Best-effort everywhere.** Pidfile writes, disk mirroring, `cleanup()` callbacks, and all kill paths swallow errors and never throw — a process that already exited (`ESRCH`) is treated as success. Disk-unavailable degrades `RingFile` to memory-only.
- **Output is cleaned only when handed to the agent.** Raw bytes (with ANSI/colors) stay on disk for the user to `tail`; `cleanOutput` (ANSI strip + `\r` progress fold) runs only inside `readOutput` before returning to the model, then a 16KB tail cap is applied.
- **Per-session soft cap.** `spawnBackground` rejects past `MAX_SHELLS_PER_SESSION` (16) as a fork-bomb guard; handle the `{ ok: false }` branch.
- **ESM `.js` import suffixes are required** (this is ESM core) and the test files import from `src/` — running tests against stale `dist` will mislead. Rebuild core before relying on `dist` consumers (TUI/desktop).
- **No barrel file.** Import the specific source file; only `backgroundShellManager` is surfaced through the package root.
