# Review Verification

Independent verification of the uncommitted fix batch. Verdicts are intentionally skeptical:

- SOLID: closes the reported issue with useful negative coverage.
- WEAK: likely improves the issue, but leaves a meaningful gap, regression, or shallow test coverage.
- BROKEN: the claimed class of bug is still exploitable in a reachable path.
- OVER-SCOPED: change is outside the stated fix surface.

## Core P1

### Plugin path traversal - SOLID

Evidence:

- `packages/core/src/plugins/installer/sourcePath.ts:18` rejects empty, absolute, NUL, and `..` source subpaths.
- `packages/core/src/plugins/installer/sourcePath.ts:42` realpaths both root and candidate, and `:57` requires the candidate to be a strict child of the source tree.
- `packages/core/src/plugins/installer/installFromSource.ts:38` applies this to remote `#subdir`.
- `packages/core/src/plugins/pluginInstaller.ts:122` applies it to marketplace string sources; `:157`/`:168` applies validation plus containment to `git-subdir`.
- Negative tests cover parent traversal, absolute marketplace paths, and symlink escape: `packages/core/src/plugins/installer/sourcePath.test.ts:27`, `:33`; `packages/core/src/plugins/installSourcePath.test.ts:49`, `:58`, `:67`.

Notes:

- This intentionally rejects absolute marketplace source paths that used to be accepted. That looks security-consistent with the finding rather than accidental breakage.

### Settings prototype pollution - BROKEN

Evidence:

- `packages/core/src/settings/manager.ts:65` rejects `__proto__`, `prototype`, and `constructor`; `:89` only descends own plain objects. Manager tests assert the negative cases at `packages/core/src/settings/manager.test.ts:323` and `:354`.
- A reachable adjacent writer was missed: `packages/core/src/tool-system/builtin/config.ts:60` still does `key.split(".")`, `:63` reads inherited objects, `:66` descends into them, and `:68` assigns the leaf.
- `Config` is shipped as a builtin mutating tool at `packages/core/src/tool-system/builtin/index.ts:418`.
- Reproduction run during review: `Config` write with key `__proto__.polluted_review_<pid>` printed `yes` from `({}).polluted_review_<pid>`.

Gap:

- The fix protected `SettingsManager` but not all dotted-key writers. The `Config` builtin can still mutate `Object.prototype`.

Recommended follow-up:

- Share the safe dotted-key parser/writer with `Config`, or route `Config` writes through `SettingsManager`.
- Add negative `Config` tests for `__proto__.polluted`, `constructor.prototype.x`, empty segments, and inherited-object descent.

### Path policy vs execution cwd - SOLID

Evidence:

- Runtime path policy now resolves single string args against `ctx.cwd` before classification at `packages/core/src/tool-system/executor.ts:582`.
- Array path args are handled at `packages/core/src/tool-system/executor.ts:605`; apply-patch targets at `:620`.
- The builtins now execute relative paths against `ctx.cwd`: `read.ts:44`, `write.ts:34`, `edit.ts:55`, `notebook-edit.ts:69`, `lsp.ts:50`, `generate-video.ts:286`.
- Tests prove `Read`, `Write`, `Edit`, and `NotebookEdit` use `ctx.cwd`, not `process.cwd`: `packages/core/src/tool-system/builtin/file-tools-cwd.test.ts:31`, `:41`, `:49`, `:59`.
- GenerateVideo image path normalization has a ctx-cwd test at `packages/core/src/tool-system/builtin/generate-video.fal.test.ts:87`.

Test gap:

- There is no direct LSP cwd regression test, but the implementation is the same simple `isAbsolute ? raw : resolve(cwd, raw)` pattern.

### RunId traversal - WEAK

Evidence:

- Core guard exists at `packages/core/src/run/ids.ts:1`; it rejects separators and parent-dir tokens at `:5` and `:8`.
- `FileRunStore` composes paths via guarded `runDir` at `packages/core/src/run/FileRunStore.ts:47`; checkpoint and approval file ids are also guarded at `:198` and `:225`.
- `RunLock` and `Heartbeat` guard before composing paths: `packages/core/src/run/RunLock.ts:164`, `packages/core/src/run/Heartbeat.ts:42`, `:64`, `:86`, `:149`.
- Tests cover FileRunStore, RunLock, and Heartbeat path-shaped ids: `packages/core/src/run/FileRunStore.ids.test.ts:44`, `:50`, `:57`; `packages/core/src/run/RunLock.test.ts:80`; `packages/core/src/run/Heartbeat.ids.test.ts:18`.

Gap:

- Desktop's run viewer/deleter still uses a different policy. `packages/desktop/src/main/runs-service.ts:132` strips slashes (`r/un` aliases to `run`) instead of rejecting invalid ids, and `deleteRunDir` at `:117` only checks `SAFE_ID`, not the new no-`..`/length policy.
- This is not the same traversal exploit as the core store, but it is an inconsistent run-id sink and can produce surprising aliasing.

Recommended follow-up:

- Reuse/export the same run-id validator in desktop or duplicate the exact policy. Reject invalid ids rather than normalizing them.

### Run approval races - WEAK

Evidence:

- `RunManager` now serializes resume/cancel per run at `packages/core/src/run/RunManager.ts:182` and `:281`.
- It validates the approval id is latest, belongs to the run, and is still pending at `packages/core/src/run/RunManager.ts:831`.
- Tests cover double resume, stale approval id, mismatch input, cancel race, and empty input at `packages/core/src/run/RunManager.resume-race.test.ts:155`, `:180`, `:193`, `:209`, `:228`.

Gap:

- `RunApprovalBackend.requestApproval` awaits `hooks.onApprovalNeeded` before installing/superseding the pending slot (`packages/core/src/run/RunApprovalBackend.ts:72`, `:76`, `:86`). If an older hook resolves after a newer hook, the older request supersedes the newer pending approval.
- Reproduction run during review produced: newer approval result `approved:false, reason:"superseded..."`; older approval then resolved `approved:true`.
- The added backend test at `packages/core/src/run/RunApprovalBackend.test.ts:38` covers sequential hook resolution only; it does not cover out-of-order hook completion.

Recommended follow-up:

- Allocate a monotonic request sequence before awaiting the hook. After the hook resolves, only publish a pending approval if that request is still the latest.
- Add a test where request 1's hook resolves after request 2's hook.

## Core P2

### RunManager empty-input resume - SOLID

Evidence:

- `RunManager` uses an own-string guard, so `userInput: ""` is accepted rather than treated as absent: `packages/core/src/run/RunManager.ts:237`.
- Regression test: `packages/core/src/run/RunManager.resume-race.test.ts:228`.

### SessionManager explicit-id reuse and injected preview - SOLID

Evidence:

- Explicit ids are validated and `mkdirSync(sessionDir)` no longer uses recursive creation, so EEXIST fails instead of mixing state: `packages/core/src/session/session-manager.ts:105`, `:109`, `:111`.
- Injected user messages are excluded from previews at `packages/core/src/session/session-manager.ts:491`, `:501`, `:502`.
- Tests cover both: `packages/core/src/session/session-manager.create.test.ts:19`, `:31`.

### FileRunStore temp-name uuid - SOLID

Evidence:

- Temp writes use `process.pid` plus `randomUUID()` instead of a fixed target tmp path: `packages/core/src/run/FileRunStore.ts:61`.
- Regression test keeps a pre-existing `run.json.tmp` sentinel intact at `packages/core/src/run/FileRunStore.ids.test.ts:64`.

### Heartbeat idempotent start - SOLID

Evidence:

- `Heartbeat.start` clears an existing timer before creating a new one: `packages/core/src/run/Heartbeat.ts:44`.
- Test starts the same run twice, stops once, waits, and confirms no heartbeat is recreated: `packages/core/src/run/Heartbeat.ids.test.ts:26`.

### MCP manager owner teardown - SOLID

Evidence:

- Owner desired sets are tracked in `connectAll` and `reconcile`: `packages/core/src/tool-system/mcp-manager.ts:294`, `:332`.
- `unregisterOwner` removes only servers no remaining owner wants at `packages/core/src/tool-system/mcp-manager.ts:356`.
- `disconnectAll` clears owner state at `packages/core/src/tool-system/mcp-manager.ts:579`.
- `ChatSessionManager.close` unregisters the session engine from the shared pool at `packages/core/src/protocol/chat-session-manager.ts:94`, with implementation at `:153`.
- Tests cover shared-owner reconciliation and final-owner close at `packages/core/src/tool-system/mcp-manager.test.ts:369`, `:398`, `:411`; chat close at `packages/core/src/protocol/chat-session-manager.mcp.test.ts:5`.

## UI Security P1

### Markdown inline style removal - WEAK

Evidence:

- Inline `style` is removed from raw HTML span allowances at `packages/desktop/src/renderer/Markdown.tsx:51`.
- Tests assert style is stripped and syntax highlighting remains at `packages/desktop/src/renderer/Markdown.test.tsx:89`, `:100`.

Gap:

- `className` is still globally allowed on all elements at `packages/desktop/src/renderer/Markdown.tsx:55`. Because the renderer app ships utility classes such as `hidden`, `fixed`, `inset-0`, and `absolute` (`packages/desktop/src/renderer/components/ui/dialog.tsx:18`, `:35`; `packages/desktop/src/renderer/App.tsx:3243`), raw assistant HTML can still use CSS classes for visual hiding/overlay-style spoofing.

Recommended follow-up:

- Restrict raw HTML class names to the highlight.js shapes actually needed, or allow `className` only on code/highlight spans after sanitization.
- Add negative tests for raw HTML classes like `hidden`, `fixed inset-0`, and `text-transparent`.

### Browser console-open-tab hardening - SOLID

Evidence:

- Parser requires the sentinel at the start, structured JSON payload, matching nonce, and http(s) URL: `packages/desktop/src/renderer/browser/useBrowserTabs.ts:33`.
- Rate limiting and duplicate suppression are at `packages/desktop/src/renderer/browser/useBrowserTabs.ts:58`.
- Injected hook emits sentinel JSON with the nonce and only for http(s) new-tab intent: `packages/desktop/src/renderer/browser/useBrowserTabs.ts:192`.
- Tests cover spoofed prefix text, wrong nonce, malformed payloads, non-http targets, dedupe, and rate limit: `packages/desktop/src/renderer/browser/useBrowserTabs.test.ts:18`, `:32`, `:43`, `:64`.

## UI/CDP P2

### App dock-resize disposer - SOLID

Evidence:

- Existing in-flight resize cleanup is called before a new drag and on unmount: `packages/desktop/src/renderer/App.tsx:2668`, `:2672`, `:2679`.
- Event listeners and body styles are restored in one idempotent cleanup: `packages/desktop/src/renderer/App.tsx:2691`.

### useElementPicking cleanup - WEAK

Evidence:

- The guest script exposes `__codeshellElementPickerCleanup` and makes finish idempotent: `packages/desktop/src/renderer/browser/pickerScript.ts:43`, `:107`, `:115`.
- Host cleanup is injected on abandon/timeout/unmount through `PICKER_CLEANUP_SCRIPT`: `packages/desktop/src/renderer/browser/useElementPicking.ts:35`, `:51`, `:82`, `:110`.

Gap:

- Tests only assert the cleanup hook appears in the string (`packages/desktop/src/renderer/browser/pickerScript.test.ts:28`). They do not exercise `useElementPicking` lifecycle behavior: timeout, tab switch, unmount, or stale promise resolution.

Recommended follow-up:

- Add a hook-level test with a fake webview that verifies `PICKER_CLEANUP_SCRIPT` runs on timeout/tab change/unmount and stale results do not update picked state.

### useSettingsResource cancellation - WEAK

Evidence:

- The hook now aborts the previous logical request and ignores stale completions by request id/signal at `packages/desktop/src/renderer/settings/useSettingsResource.ts:61`, `:64`, `:72`.
- Cleanup aborts and removes listeners at `packages/desktop/src/renderer/settings/useSettingsResource.ts:98`.

Gap:

- Existing tests only cover `seedValue`, not cancellation or stale result suppression: `packages/desktop/src/renderer/settings/useSettingsResource.seed.test.ts:14`.

Recommended follow-up:

- Add a hook test where loader A resolves after loader B and assert A cannot overwrite state/cache.

### pty-service cwd validation - WEAK

Evidence:

- Main process validates cwd exists and is a directory before `node-pty.spawn`: `packages/desktop/src/main/pty-service.ts:177`, `:212`.
- Spawn errors are returned as `{ ok:false, detail }`: `packages/desktop/src/main/pty-service.ts:216`.
- Tests cover file and missing cwd rejection at `packages/desktop/src/main/pty-resize-clamp.test.ts:125`.

Gap:

- The IPC/preload/renderer contract was not updated. Preload still types `ptyStart` as `Promise<{ pid: number }>` at `packages/desktop/src/preload/index.ts:772` and `packages/desktop/src/preload/types.d.ts:544`.
- `TerminalPanel` ignores the result and calls resize on any resolved value at `packages/desktop/src/renderer/panels/TerminalPanel.tsx:78`.
- Result: invalid cwd no longer spawns, but the terminal can silently appear started with no user-visible error.

Recommended follow-up:

- Update the preload type to the union, handle `{ ok:false }` in `TerminalPanel`, and add a renderer/preload contract test.

### automation-host detach-after-action - SOLID

Evidence:

- The host tracks whether the current action attached the debugger and detaches in `finally`: `packages/desktop/src/main/browser-driver/automation-host.ts:170`, `:173`, `:225`.
- It resets domains without discarding the cached driver/ref map: `packages/desktop/src/main/browser-driver/automation-host.ts:228`.
- Tests verify detach after snapshot and click while cached refs survive: `packages/desktop/src/main/browser-driver/automation-host.test.ts:134`, `:150`.

### Browser automation policy comment - SOLID

Evidence:

- The comment now explicitly states execution-layer enforcement, whitelist semantics, and sensitive-action approval: `packages/desktop/src/main/browser-driver/policy.ts:1`.
- No behavioral change identified.

### CDP driver hardening - SOLID

Evidence:

- Navigation rejects empty, relative, and unsafe schemes before `Page.navigate`: `packages/cdp/src/driver.ts:55`, `:384`.
- Optional host policy is honored at `packages/cdp/src/driver.ts:388`.
- Image fetch timeout is passed into the in-page fetch/canvas path at `packages/cdp/src/driver.ts:286`.
- Extraction refs are namespaced and old refs are cleared: `packages/cdp/src/driver.ts:615`, `:621`, `:641`, `:650`.
- Screenshots clip to the visible viewport and clamp scale via `positiveFinite`: `packages/cdp/src/driver.ts:321`, `:334`, `:347`.
- Tests cover unsafe navigation, host policy, timeout wiring, namespaced refs, and screenshot clamp: `packages/cdp/src/driver.test.ts:178`, `:220`, `:248`, `:273`, `:302`.

## Architecture

### extractJSON moved to utils/json.ts - SOLID

Evidence:

- Arena utilities re-export the generic JSON helpers from `packages/core/src/utils/json.ts` at `packages/core/src/arena/strategies/utils.ts:43`.
- The new helper tests cover fenced JSON, balanced object extraction, braces in strings, unbalanced fallback, and no-object fallback: `packages/core/src/utils/json.test.ts:4`.
- Existing array-extraction regression tests now import from the generic utility and still cover first balanced array behavior: `packages/core/src/arena/strategies/extract-json-array.test.ts:9`.

Note:

- The uncommitted diff also changes `extractJSON` behavior to balanced-object scanning; tests cover the new behavior, so this is acceptable if intentional.

## Over-Scope

### Broad docs/release metadata churn - OVER-SCOPED

Evidence:

- The working tree changes many docs outside the three review files and outside the described code fixes, including `CODESHELL.md`, `README.md`, `README.zh-CN.md`, `TODO.md`, `bench/README.md`, `docs/architecture/00-overview.md`, archived architecture docs, deep-dive docs, `packages/desktop/CLAUDE.md`, and `packages/tui/README.md`.
- Examples: README status/version and tool-list changes at `README.md:24` and `:119`; root TODO adds a new dated review block at `TODO.md:8`; package publish files add an architecture image at `package.json:57`.

Risk:

- These are not part of the reported security/P2 fix surface. They increase review load and can smuggle inaccurate status/roadmap updates into a security batch.

Recommended follow-up:

- Split docs/release metadata into a separate change, or revert unrelated docs churn from the security fix batch.

## Test Commands Run

- `bun test packages/core/src/plugins/installer/installFromSource.test.ts packages/core/src/plugins/installSourcePath.test.ts packages/core/src/settings/manager.test.ts packages/core/src/tool-system/builtin/file-tools-cwd.test.ts packages/core/src/run/FileRunStore.ids.test.ts packages/core/src/run/RunLock.test.ts packages/core/src/run/RunApprovalBackend.test.ts packages/core/src/run/RunManager.resume-race.test.ts packages/core/src/session/session-manager.create.test.ts packages/core/src/tool-system/mcp-manager.test.ts`
  - Result: 111 pass, 0 fail.
- `bun test packages/desktop/src/renderer/Markdown.test.tsx packages/desktop/src/renderer/browser/useBrowserTabs.test.ts packages/desktop/src/renderer/browser/pickerScript.test.ts packages/desktop/src/renderer/settings/useSettingsResource.seed.test.ts packages/desktop/src/main/pty-resize-clamp.test.ts packages/desktop/src/main/browser-driver/automation-host.test.ts packages/cdp/src/driver.test.ts packages/core/src/utils/json.test.ts packages/core/src/arena/strategies/extract-json-array.test.ts`
  - Result: 90 pass, 0 fail.
- `bun test packages/core/src/run/Heartbeat.ids.test.ts packages/core/src/plugins/installer/sourcePath.test.ts packages/core/src/protocol/chat-session-manager.mcp.test.ts`
  - Result: 6 pass, 0 fail.
