# git

**One-line role.** Thin, injection-safe wrappers around the `git`/`gh` CLIs — porcelain helpers (status/diff/log/commit) for the `/git` slash commands, plus full worktree lifecycle (create/setup/remove) for the EnterWorktree/ExitWorktree tools.

## 职责 / Responsibility

This module is the only place in core that shells out to `git` and `gh`. It exists to (a) give higher layers a typed, parsed view of repository state without each caller re-implementing `execFileSync` plumbing, and (b) guarantee every invocation goes through an **argv array** (never a command string), so user-supplied values like commit messages, file paths, branch slugs, and PR URLs can't be interpolated into a shell. It does **not** own any UI, slash-command routing, or worktree-session bookkeeping — `utils.ts` is stateless, and the only mutable worktree state (`_activeWorktree`) lives in the tool layer, not here.

## 文件 / Files

| File | Purpose |
| --- | --- |
| `utils.ts` | git/gh porcelain helpers: repo detection, branch, status, diff, log, add, commit, checkout, remote URL, and `gh pr` comments. Resolves `git`/`gh` binaries once via `resolveExecutable`. |
| `worktree.ts` | Worktree lifecycle: validate slug, find git root, create/remove worktree, list worktrees, run the project's per-platform setup script, and symlink large dirs (`node_modules`, `.venv`, …) into the new worktree. |
| `parse-log.ts` | Pure parser: turns `git log --format=%H\|%s\|%an\|%ci` output into `GitLogEntry[]`. Tolerant of malformed/short lines (defaults missing fields to `""`). |
| `parse-log.test.ts`, `worktree-setup.test.ts`, `worktree-remove.test.ts` | Unit tests for the parser and worktree create/setup/remove behavior. |

There is **no `index.ts`** in this folder — consumers import the concrete files (`./git/utils.js`, `../../git/worktree.js`), and the porcelain helpers are additionally re-exported from the package root (`packages/core/src/index.ts`).

## 公开接口 / Public API

### `utils.ts`
```ts
interface GitStatusEntry { status: string; path: string }
type { GitLogEntry } // re-exported from parse-log

function isGitRepo(cwd: string): boolean
function getCurrentBranch(cwd: string): string
function getGitStatus(cwd: string): GitStatusEntry[]
function getGitDiff(cwd: string, opts?: { staged?: boolean; file?: string }): string
function getGitDiffStat(cwd: string, opts?: { staged?: boolean; file?: string }): string
function getGitLog(cwd: string, n?: number): GitLogEntry[]          // n defaults to 10
function getRemoteUrl(cwd: string): string | undefined             // undefined if no origin
function gitAdd(cwd: string, files?: string[]): void               // files defaults to ["."]
function gitCommit(cwd: string, message: string): string           // returns commit stdout
function gitListBranches(cwd: string): { name: string; current: boolean }[]
function gitCheckout(cwd: string, branch: string, create?: boolean): void
function ghAvailable(): boolean
function ghPrComments(cwd: string, prUrl: string): string          // requires gh CLI
```

### `worktree.ts`
```ts
interface WorktreeSession {
  originalCwd: string; worktreePath: string; worktreeName: string;
  worktreeBranch: string; originalBranch?: string; sessionId: string; createdAt: number;
}
interface PlatformScripts { default?: string; macos?: string; linux?: string; windows?: string }
interface WorktreeSetupResult { skipped: boolean; ok: boolean; output: string; exitCode?: number | null }

function selectPlatformScript(scripts: PlatformScripts | undefined, platform?: NodeJS.Platform): string | undefined
function validateWorktreeSlug(slug: string): void                  // throws on bad slug
function findGitRoot(cwd: string): string                          // git rev-parse --show-toplevel
function createWorktree(cwd: string, slug: string, sessionId: string): WorktreeSession
function runWorktreeSetup(worktreePath: string, script: string | undefined,
  opts?: { sandbox?: SandboxBackend; shellEnv?: Record<string,string>; timeoutMs?: number; signal?: AbortSignal }
): Promise<WorktreeSetupResult>
function removeWorktree(worktreePath: string, removeBranch?: boolean): void
function listWorktrees(cwd: string): Array<{ path: string; branch: string; head: string }>
```

### `parse-log.ts`
```ts
interface GitLogEntry { hash: string; message: string; author: string; date: string }
function parseGitLog(raw: string): GitLogEntry[]
```

## 怎么用 / How to use

**1. Porcelain helpers in a `/git` slash command** (real call site: `packages/tui/src/cli/commands/builtin/git-commands.ts`). These are re-exported from the package root, so hosts import them from `@code-shell/core`:

```ts
import { isGitRepo, getGitStatus, getGitDiff, getGitLog, gitCommit } from "@code-shell/core";

if (!isGitRepo(ctx.cwd)) return "Not a git repository.";

const status = getGitStatus(ctx.cwd);          // [{ status: "M", path: "src/foo.ts" }, ...]
const stat   = getGitDiff(ctx.cwd, { staged: true });
const log    = getGitLog(ctx.cwd, 5);           // last 5 commits, parsed
const result = gitCommit(ctx.cwd, userMessage); // userMessage is safe: passed as an argv token
```

**2. Worktree lifecycle inside the EnterWorktree tool** (real call site: `packages/core/src/tool-system/builtin/worktree.ts`):

```ts
import {
  createWorktree, runWorktreeSetup, selectPlatformScript, type WorktreeSession,
} from "../../git/worktree.js";

const session: WorktreeSession = createWorktree(cwd, slug, sessionId);

// Run the project's localEnvironment.setupScripts once, in the fresh worktree.
const script = selectPlatformScript(ctx.engine?.readWorktreeSetupScripts(cwd));
if (script) {
  const setup = await runWorktreeSetup(session.worktreePath, script, {
    sandbox: ctx.sandbox, shellEnv: ctx.shellEnv, signal: ctx.signal,
  });
  if (!setup.ok) {/* warn-but-continue: setup.output, setup.exitCode */}
}
// later, on exit:  removeWorktree(session.worktreePath, /* removeBranch */ true);
```

## 注意 / Gotchas

- **Synchronous & throwing.** Every `utils.ts` helper and most of `worktree.ts` use `execFileSync` — they block the event loop and **throw** on non-zero exit. `isGitRepo`, `getRemoteUrl`, and `ghAvailable` swallow errors and return a sentinel; everything else propagates. Callers in the main/Electron process must keep these off hot paths (the module is designed for short, on-demand slash-command / tool use, not per-turn polling). `runWorktreeSetup` is the one async function (it goes through `safeSpawnShell`).
- **argv-only, never strings — don't "fix" it.** Args are passed as separate argv tokens precisely so user input can't be interpolated into a shell. `gitCommit` once used `JSON.stringify(message)` (only accidentally safe) — don't reintroduce string commands. `getGitDiff`/`gitAdd` use a trailing `--` so a path starting with `-` isn't parsed as a flag. `gitCheckout` additionally **rejects branch names starting with `-`** (the `--` trick doesn't work for checkout) — passing `--orphan`-style names throws.
- **Windows binary resolution.** `git`/`gh` are resolved once at module load via `resolveExecutable` so a `.cmd`/`.exe` shim on `PATH×PATHEXT` is found (bare `execFile` doesn't walk PATHEXT). On POSIX it's a no-op.
- **`removeWorktree` runs from the MAIN repo, not the worktree.** It derives the main root from `--git-common-dir` and captures the branch name **before** removing the worktree (afterward the dir is gone and the branch-delete would silently no-op). It only deletes branches under the `worktree/` prefix, and the whole thing is best-effort: a failure (already-removed, detached HEAD) is swallowed.
- **Worktree setup failure is non-fatal by design** (Beta decision 2026-06-08, "警告但继续"). `runWorktreeSetup` returns `{ ok: false, output }` instead of throwing so a broken setup script can't strand the agent outside a worktree it already created. Cleanup scripts are intentionally **not** auto-run on exit.
- **`createWorktree` places worktrees at `<repo>/../.worktrees/<slug>-<8charSession>`** and branches at `worktree/<slug>-<8charSession>`. `validateWorktreeSlug` (≤64 chars, `[a-zA-Z0-9._-]` only, no leading `.` / no `..`) guards path traversal — call it (or let `createWorktree` call it) before trusting a slug.
- **Symlinking large dirs is best-effort.** `node_modules`/`.venv`/`vendor`/`.pnpm-store` are symlinked (NTFS `junction` on win32, `dir` elsewhere) from the main repo into the new worktree; failure (e.g. EPERM without Developer Mode) is swallowed — the worktree just uses more disk.
- **`ghPrComments` / `ghAvailable` need the `gh` CLI** installed and authenticated; gate on `ghAvailable()` before offering PR-comment features.
- **`getGitLog` validates `n`** — non-finite or `<= 0` falls back to 10, so it's safe to forward a possibly-stringy count. `parseGitLog` truncates hashes to 8 chars and never crashes on malformed lines.
