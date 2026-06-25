# utils

**One-line role.** Leaf-level shared helpers (lockfiles, cross-platform executable resolution, child-process exec wrappers, formatting, env/intl/theme) that the rest of `@code-shell/core` builds on — no engine state, no Ink, no circular deps.

## 职责 / Responsibility

This module is the bottom of the core dependency graph: small, dependency-light, framework-free helpers that everything else imports. It owns concerns that recur across many subsystems — acquiring on-disk locks (run/automation), finding and running external binaries portably (git/lsp/plugins), memoizing scan results, sanitizing pasted input, and pure display formatting (durations, bytes, tokens). Its boundary is "no upward knowledge": files here must not import engine/session/tool-system code, and the display formatters are explicitly leaf-safe (no Ink) so they can run in any host. Most members are also re-exported from `core`'s top-level `index.ts`, so hosts consume them as part of the public core API rather than reaching into `utils/` directly.

## 文件 / Files

| File | Purpose |
|------|---------|
| `lockfile.ts` | Lazy wrapper over `proper-lockfile` (`lock`/`lockSync`/`unlock`/`check`); defers the graceful-fs monkey-patch cost and works under ESM hosts. |
| `exec.ts` | Cross-platform executable resolution (`resolveExecutable`/`findExecutable`/`commandCandidateNames`) + git binary helpers (`resolveGit`/`isGitAvailable`/`setGitPathOverride`). |
| `execFileNoThrow.ts` | Run a child process without throwing; distinguishes spawn failure (`code: null`) from non-zero exit. |
| `memoize.ts` | Minimal `memoize(fn, resolver)` (lodash-shaped) with a `.cache` Map; in-tree to drop the lodash dependency. |
| `semver.ts` | Thin re-export of `semver`'s `gt`/`gte`/`lt`. |
| `task-sanitizer.ts` | `detectPastedNoise` — flags ANSI/box-drawing-heavy pasted task text. |
| `format.ts` | Pure display formatters: `formatFileSize`/`formatBytes`, `formatDuration`, `formatSecondsShort`, `formatTokens`, `singleLine`. |
| `intl.ts` | Locale/timezone/segmenter helpers (`getRelativeTimeFormat`, `getTimeZone`, `getWordSegmenter`, `lastGrapheme`, …). |
| `env.ts` | Host/runtime/platform detection (`env`, `getHostPlatform`, `getRuntime`, `getPackageManager`, `isWSL`, global dir helpers). |
| `envUtils.ts` | Env-var parsing & policy (`isEnvTruthy`, `parseEnvVars`, AWS/Vertex region helpers, `isInProtectedNamespace`). |
| `earlyInput.ts` | Capture/replay stdin typed before the UI is ready (`startCapturingEarlyInput`/`consumeEarlyInput`/…). |
| `toolDisplay.ts` | Tool-call display helpers (`formatToolArgs`, `singleLine`, `MAX_LINE_WIDTH`, `TOOL_DOT_COLORS`). |
| `debug.ts` | `logForDebugging` debug logging. |
| `sliceAnsi.ts` | ANSI-aware string slicing (default export). |
| `theme.ts` / `systemTheme.ts` / `theme-xterm` | Theme palette + OS theme detection. |

## 公开接口 / Public API

```ts
// lockfile.ts — proper-lockfile, loaded lazily
function lock(file: string, options?: LockOptions): Promise<() => Promise<void>>; // returns release fn
function lockSync(file: string, options?: LockOptions): () => void;
function unlock(file: string, options?: UnlockOptions): Promise<void>;
function check(file: string, options?: CheckOptions): Promise<boolean>;

// exec.ts — cross-platform binary resolution
function resolveExecutable(command: string, env?: NodeJS.ProcessEnv): string; // bare name unchanged if not found
function findExecutable(command: string, env?: NodeJS.ProcessEnv): string | null; // null if genuinely missing
function commandCandidateNames(command: string, env?: NodeJS.ProcessEnv): string[];
function resolveGit(env?: NodeJS.ProcessEnv): string;
function isGitAvailable(env?: NodeJS.ProcessEnv): boolean;
function setGitPathOverride(path: string | null | undefined): void;

// execFileNoThrow.ts
interface ExecFileNoThrowResult { code: number | null; stdout: string; stderr: string }
function execFileNoThrow(file: string, args: string[], options?: ExecFileNoThrowOptions): Promise<ExecFileNoThrowResult>;

// memoize.ts
function memoize<Args extends readonly unknown[], R>(
  fn: (...args: Args) => R,
  resolver: (...args: Args) => string,
): MemoizedFn<Args, R>; // result has .cache: Map<string, R>

// semver.ts
function gt(a: string, b: string): boolean;
function gte(a: string, b: string): boolean;

// task-sanitizer.ts
function detectPastedNoise(task: string): { isNoise: boolean; reason: string; cleaned: string };

// format.ts (re-exported from core index)
function formatDuration(ms: number, opts?: { hideTrailingZeros?: boolean; mostSignificantOnly?: boolean }): string;
function formatTokens(n: number): string;
```

## 怎么用 / How to use

Acquiring a run lock (from `run/RunLock.ts`):

```ts
import { lock, check, unlock } from "../utils/lockfile.js";

// lock() resolves to a release function; throws on conflict.
const release = await lock(lockTarget, { stale: this.staleMs, retries: 0 });
this.releaseFns.set(runId, release);
// later:
const held = await check(lockTarget, { stale: this.staleMs });
await unlock(lockTarget);
```

Resolving + probing git before shelling out (from `plugins/gitOps.ts`):

```ts
import { resolveGit, isGitAvailable } from "../utils/exec.js";

if (!isGitAvailable()) throw new Error("git not found on PATH");
const r = await safeSpawn(resolveGit(), args, { cwd });
```

Memoizing a directory scan keyed by external state (from `skills/scanner.ts`):

```ts
import { memoize } from "../utils/memoize.js";

// resolver mixes in mtime so the cache invalidates when plugins change.
const memoized = memoize(scanOnce, (cwd: string) =>
  `${cwd}\0${userHome()}\0${installedPluginsMtime()}`);
const all = memoized(cwd);
memoized.cache.clear?.(); // drop the cache when needed
```

## 注意 / Gotchas

- **`lockfile.ts` MUST be imported instead of `proper-lockfile` directly.** Two reasons baked into the file: (1) `proper-lockfile` pulls in `graceful-fs`, which monkey-patches all of `fs` on first require (~8ms) — the lazy wrapper keeps that off the `--help`/startup path; (2) it's CommonJS, and a bare `require('proper-lockfile')` throws "require is not defined" under the Electron main ESM bundle. The wrapper uses `createRequire(import.meta.url)`. A regression here previously surfaced as "Run now does nothing" (locks silently failing). Follow the same pattern for any CJS dep consumed from core.
- **`resolveExecutable` vs `findExecutable` are not interchangeable.** `resolveExecutable` returns the bare command *unchanged* when nothing is found (so `spawn` surfaces its own ENOENT) — use it right before spawning. `findExecutable` returns `null` when the binary genuinely doesn't exist — use it to *detect* a missing tool up front. The Windows path here walks `PATH × PATHEXT` so `.cmd`/`.bat` shims are found (Node won't do this for a bare name without `shell:true`).
- **`setGitPathOverride` is process-global mutable state.** The desktop host calls it at startup / on settings change to honor the `git.path` setting; `resolveGit`/`isGitAvailable` read it. `resolveExecutable` also memoizes results in a module-level cache (`_clearExecutableCache()` is the test-only seam).
- **`execFileNoThrow` never throws.** `code: null` means spawn failure (ENOENT/EACCES/EPERM) with the error message in `stderr`; a numeric `code` means the process ran. Default timeout 10s, maxBuffer 10MB. `execSyncWithDefaults_DEPRECATED` is a dead stub — don't use it.
- **`memoize` is not LRU and lives forever.** Growth is bounded only by the cardinality of your resolver key, so the key must change when external state changes (the scanner mixes in mtime + home dir). `.cache` only exposes the lodash subset actually used (`.clear()`).
- **Imports use the `.js` extension** even from `.ts` sources (ESM, `module: ESNext`). Most members are also re-exported from core's top-level `index.ts`; consumers outside core should import from `@code-shell/core` rather than deep-pathing into `utils/`. Changes to core require a rebuild before TUI/desktop dist picks them up.
- **`format.ts` is leaf-safe (no Ink).** Width-aware truncation lives elsewhere (`./truncate.ts`); keep Ink/terminal-rendering concerns out of this module so formatters stay usable in any host.
