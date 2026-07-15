# Core Export Surface Convergence (Phase 1c) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the three core entries mean what they claim: `.` = public SDK, `/internal` = in-repo host (tui/desktop) surface, `/extension` = capability-package (coding/arena) contract. Host-only exports leave the root barrel; coding stops importing root.

**Architecture:** Three parallel consumer migrations (coding→/extension, tui→/internal, desktop→/internal) while root still exports everything; then a final root-shrink + contract-test rewrite in one pass. `notificationQueue` (process singleton shared by tui and coding) is re-exported from BOTH /internal and /extension from the same source module, preserving identity.

**Tech Stack:** bun workspaces; bun test resolves via root tsconfig paths (`@cjhyy/code-shell-core[/internal|/extension]` → core src entries). package.json export subpaths stay untouched.

**Execution notes:** No commits (uncommitted user work in tree); `git stash create` snapshots instead. Baseline: full repo suites green as of Phase 1a completion.

---

### Task A: Extend /extension and migrate packages/coding off the root barrel

**Files:**
- Modify: `packages/core/src/index.extension.ts` (append exports)
- Modify: all 18 non-test coding files importing `@cjhyy/code-shell-core`

- [x] **Step A1: Append to index.extension.ts** (keep existing exports; same source modules as index.ts uses so identity is preserved):

```ts
// ── Capability composition contract ──────────────────────────────────
export type {
  CapabilityArtifactDetector,
  CapabilityDynamicContextProvider,
  CapabilityModule,
  CapabilityToolServiceHost,
} from "./capabilities/index.js";
export { registerCapability } from "./capabilities/index.js";
export {
  BUILTIN_AGENT_PRESETS,
  derivePresetExposure,
  type AgentPreset,
} from "./preset/presets.js";
export { BUILTIN_TOOLS, type BuiltinTool } from "./tool-system/builtin/index.js";
export { SessionManager } from "./session/session-manager.js";
export { codeShellHome } from "./utils/paths.js";
export type { SessionWorkspace } from "./types.js";
export { invalidateFileCache } from "./tool-system/file-cache.js";
export { notificationQueue } from "./tool-system/builtin/agent-notifications.js";
export { resolveExecutable, resolveGit } from "./utils/resolve-executable.js";
export {
  buildSandboxEnv,
  defaultShellBinary,
  killChildTree,
  killProcessGroup,
  mergeShellEnv,
} from "./runtime/spawn-common.js";
export { safeSpawnShell, type SandboxBackend } from "./tool-system/sandbox.js";
export { isExistingDirectory, normalizeCwdPath } from "./utils/cwd.js";
export { backgroundJobRegistry, type BackgroundJobEntry } from "./tool-system/builtin/background-jobs.js";
```

IMPORTANT: the exact source-module paths above are best-effort — before writing, `grep -n "<symbol>" packages/core/src/index.ts` and copy the EXACT `from "./…"` specifier index.ts uses for each symbol, so both entries re-export the same module (identity).

- [x] **Step A2: Migrate coding imports.** In each of the 18 non-test files, change `from "@cjhyy/code-shell-core"` → `from "@cjhyy/code-shell-core/extension"`. All symbols coding imports are now on /extension (32 total: ToolContext/ToolDefinition/RegisteredTool/logger already there + 28 new).

- [x] **Step A3: Verify**

```bash
grep -rn 'from "@cjhyy/code-shell-core"' packages/coding/src --include='*.ts' | grep -v test    # expect empty
bun test packages/coding
```

Expected: coding suite green (same count as baseline).

### Task B: Migrate tui host imports to /internal

**Files:** ~40 tui files, 60 import statements (56 pure, 4 mixed: `ui/App.tsx:58`, `bootstrap/setup.ts:11`, `render/ink.tsx:10`, `cli/commands/arena.ts:31`).

- [x] **Step B1:** For every tui import of an internal-set symbol (list in recon report; includes getGraphemeSegmenter, sliceAnsi, env, execFileNoThrow, gte, logForDebugging, isEnvTruthy/isEnvDefinedFalsy, stopCapturingEarlyInput, formatBytes/formatToolArgs/singleLine/MAX_LINE_WIDTH/TOOL_DOT_COLORS, classifyBashLines, formatDuration/formatTokens, getTheme/Theme/ThemeName/ThemeSetting/resolveThemeSetting, rotateLogs, recordUIEvent, getInteractiveApprovalBackend, defaultSandboxConfig/SandboxConfig, buildNotificationMessage/buildNotificationSummary/notificationQueue/NotificationItem, CronStore/CronRunResult/bindCronToEngine/cronScheduler, asyncAgentRegistry/AsyncAgentEntry, createInProcessClient, ProtocolModelEntry, CachedModel/defaultCacheDir/fetchModelList/FetchResult/sanitizeApiKey/hasNonAsciiPrintable/PROVIDER_KINDS/ProviderKindName/ProviderConfig, getMergedCatalog, ApprovalRequest/ApprovalResult/ApprovalScope/TaskInfo): change specifier to `@cjhyy/code-shell-core/internal`. Split the 4 mixed statements into two imports (public symbols stay on root entry).
- [x] **Step B2:** First ensure every symbol above actually exists in index.internal.ts; if one is missing (e.g. it was only in index.ts @internal region), ADD it to index.internal.ts re-exporting from the same source module index.ts uses.
- [x] **Step B3: Verify**

```bash
bun test packages/tui
```

Expected: green, same as baseline.

### Task C: Migrate desktop host imports to /internal

**Files:** 10 desktop files, 11 statements (3 mixed: `renderer/types.ts:8` type-only, `main/automation-host.ts:18`, `main/index.ts:21` — 22 internal + 13 public symbols in one statement).

- [x] **Step C1:** Same rewrite as Task B for desktop's 34 internal symbols (setGitPathOverride/isGitAvailable/resolveGitPath, lock, agentNotificationBus, startAutomation/AutomationHandle/CronStore/defaultCronStorePath/CronScheduler/CronJob/CronPermissionLevel/CronRunner/CronRunResult/CronRunRequest, ENV_DENY_REGEX, getImageProvider/DEFAULT_IMAGE_MODEL, transcribe/resolveTranscribeProvider/isTranscribeAvailable/describeTranscribe, getMergedCatalog/saveCatalogEntry/deleteUserCatalogEntry/userCatalogPath/catalogEntryOrigins, defaultCacheDir/fetchModelList/PROVIDER_KINDS/capabilitiesFor/reasoningControlFor, defaultSandboxConfig, TaskInfo, …per recon mapping). Split mixed statements.
- [x] **Step C2:** Add any missing symbols to index.internal.ts (same-module re-export).
- [x] **Step C3: Verify**

```bash
bun test packages/desktop/src/main 2>&1 | tail -4   # or the desktop test entry the repo uses
```

Expected: green, same as baseline.

### Task D (after A+B+C): Shrink index.ts, rewrite the exports contract test

- [x] **Step D1:** Delete from `packages/core/src/index.ts` the @internal partitions (lines ~551–614 utils, 617–620 logging, 649–735 tool-system extended, 737–750 stt, 752–762 model-catalog, 765–772 protocol extended, 788–800 llm extended, 807–809 types extended) EXCEPT any symbol still imported from root by tui/desktop/coding/chat/arena/product code after A–C (verify per-symbol with grep before deleting; keep `fileCache`/`validateToolArgs`/`createOffBackend`/harness exports — public section — as-is).
- [x] **Step D2:** Ensure index.internal.ts now contains everything tui/desktop consume plus what it already had; keep header comment describing the contract.
- [x] **Step D3:** Rewrite `packages/core/src/index.exports.test.ts`:
  - Drop the "every internal export must remain public on root + identity" assertion (L141–150); replace with: internal exports that ALSO exist on root must be identical references (identity check only for the overlap).
  - Keep: /internal runtime-export pin list (update to new actual list), no Engine/Arena on internal, root must export Engine/createServer and must NOT export leaked symbols — extend the must-NOT list with a sample of moved host symbols (e.g. `sliceAnsi`, `notificationQueue`, `cronScheduler`).
  - Keep package.json/tsconfig shape assertions unchanged.
  - Add: /extension must export the coding contract sample (`CapabilityModule` type can't be runtime-checked; assert runtime ones: `registerCapability`, `SessionManager`, `notificationQueue`, and identity with /internal's `notificationQueue`).
- [x] **Step D4: Full verify**

```bash
bun test packages/core packages/coding packages/tui packages/chat packages/arena
grep -c "^export" packages/core/src/index.ts   # expect ≈ 40% fewer symbols (843→~550 lines)
```

Expected: all green; record `git stash create` snapshot.
