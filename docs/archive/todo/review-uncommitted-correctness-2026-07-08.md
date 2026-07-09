# Review: local unpushed correctness/regression batch, 2026-07-08

Reviewed exact range: `da84f435~1..HEAD` from `git log --oneline da84f435~1..HEAD`, then inspected the commits with `git show <hash>`.

## Summary verdict

Safe to push: **No**.

Why: I did not find a clear 🔴 release-stopper, but there are three 🟠 issues that should be fixed before pushing: unsafe plugin transports can be bypassed with uppercase schemes, the CDP viewport-clamp click path likely dispatches scroll-offset coordinates instead of viewport coordinates, and closing a session does not guard against an in-flight path approval re-creating a grant after the clear. There is also one 🟡 incomplete CDP keypress edge case around literal `+`.

## Findings by severity

### 🟠 `0d175ef0` allows uppercase unsafe plugin schemes through the new default deny

The unsafe transport detection is case-sensitive: `unsafeTransport()` only checks lower-case `http://`, `git://`, and `file://` at `packages/core/src/plugins/installer/parseSource.ts:44`. The gate then trusts that result at `packages/core/src/plugins/installer/parseSource.ts:68`. URL schemes are case-insensitive in practice, so `HTTP://example.com/repo.git`, `GIT://...`, or `FILE://...` are still classified as remote by the generic `://` check at `packages/core/src/plugins/installer/parseSource.ts:35` but are not rejected by the unsafe-transport gate.

The tests only cover lower-case unsafe schemes, so they would not catch this bypass. This is a root-cause gap in the security fix.

### 🟠 `8ef89609` likely breaks clicks after scrolling by mixing page and viewport coordinate spaces

`centerOf()` now intersects the node box with `layoutViewportRect()` and dispatches the resulting point directly as the mouse event coordinate at `packages/cdp/src/driver.ts:119` and `packages/cdp/src/driver.ts:123`. `layoutViewportRect()` includes `layoutViewport.pageX/pageY` as the rectangle origin at `packages/cdp/src/driver.ts:363`.

CDP `Input.dispatchMouseEvent` coordinates are viewport-relative. With a non-zero scroll offset, this implementation either intersects viewport-relative DOM quads against a page-offset viewport, or returns page coordinates without subtracting the viewport origin before dispatch. The tests only use a viewport whose `pageX/pageY` are absent/zero, so they would still pass while below-the-fold clicks fail after `DOM.scrollIntoViewIfNeeded`.

### 🟠 `944bd2ef` clears completed path grants on close, but an in-flight approval can re-create them after close

`ChatSessionManager.close()` cancels the session and clears path approvals at `packages/core/src/protocol/chat-session-manager.ts:100` and `packages/core/src/protocol/chat-session-manager.ts:101`. That removes the current map entries at `packages/core/src/tool-system/path-policy.ts:362`.

However, an already-running `enforcePathPolicyWithApproval()` can still be awaiting `promptForPathApproval()` at `packages/core/src/tool-system/path-policy.ts:617`. If the user answers after close with `本目录本会话允许`, `recordPathApproval("session", ...)` runs at `packages/core/src/tool-system/path-policy.ts:685` and creates a fresh grant set when none exists at `packages/core/src/tool-system/path-policy.ts:296`. If the user answers `本目录本项目允许`, it writes a persisted project grant at `packages/core/src/tool-system/path-policy.ts:689`.

The added test covers a grant that was already completed before close; it does not cover a pending prompt resolving after close. That leaves the approval-cache cleanup incomplete for the race it is meant to close.

### 🟡 `c72df028` handles control keys correctly, but literal `+` is still untypeable

The new printable-text logic correctly suppresses `text` for Control/Alt/Meta combinations at `packages/cdp/src/keymap.ts:223`, so it does not appear to wrongly set text for `Control+a` or similar chords.

The edge case is literal plus. The commit adds a `"+": ["Equal", 187]` mapping at `packages/cdp/src/keymap.ts:86`, but `planKeySequence()` tokenizes every spec with `spec.split("+")` at `packages/cdp/src/keymap.ts:245`. For `pressKey("+")`, that produces only empty segments and returns no events at `packages/cdp/src/keymap.ts:246`. For `Control++`, the main key is also lost. The regression test covers `"a"` and `"Enter"` only, so this intended printable key path is untested.

## Per-commit risk table

| Commit | Risk | Review note |
|---|---:|---|
| `ba7b2dc5` fix(core): persist context usage anchor | 🟡 | Mostly coherent persist/resume path; tests cover persistence and compatible resume estimate. Residual risk around stale anchors if prompt/tool surface changes, but no concrete blocker found. |
| `df8e9e83` fix(infra): keep cdp out of npm publish set | 🟢 | Marks CDP private and adds a workflow consistency test; interacts cleanly with the publish set. |
| `c72df028` fix(cdp): send text for printable key presses | 🟡 | Control keys are guarded, but literal `+` remains unhandled because `+` is also the chord delimiter. |
| `2e7111c5` fix(tui): guard background notification drain | 🟢 | Predicate is sensible; `isQueryActive` already subscribes to the same guard store, so the sampled guard is a same-render race guard rather than the only reactivity source. |
| `a49c1b72` fix(tui): wire unseen divider scroll-away | 🟢 | Wires the callback through and test exercises scroll-away. Repeated non-sticky notifications are idempotent in the hook. |
| `cc25bc31` fix(tui): drop sub-agent thinking from main feed | 🟢 | Narrow routing filter; test covers main vs sub-agent thinking. |
| `1f59c49c` fix(tui): key markdown cache by width | 🟢 | Cache key and marked instances now include normalized width; no obvious regression. |
| `c621140a` fix(desktop): require pty sender ownership | 🟢 | IPC callers now pass `e.sender`; lifecycle cleanup uses an owner-bypass helper. Test covers write/resize/kill denial. |
| `cec153ab` fix(tui): catch async slash command failures | 🟢 | Root cause fixed by catching both sync throw and async rejection; test is meaningful. |
| `9aa19ecd` fix(tui): mask provider api key input | 🟢 | TextInput display masking preserves value/cursor behavior; test verifies secret absence while typing. |
| `5ece9d28` fix(test): isolate stdio factory config | 🟢 | Test isolation only; no product risk found. |
| `944bd2ef` fix(core): clear session approval caches on close | 🟠 | Completed grants are cleared, but pending path approvals can re-create session/project grants after close. |
| `70099d52` fix(tui): render compact tool results | 🟢 | Store type and renderer now carry `compact`; test would fail without the prop pass-through. |
| `aa71492e` fix(tui): skip inline login secrets in history | 🟢 | Narrow filter for `/login <secret>`; test checks memory and disk. |
| `a92d9cd6` fix(tui): let repl handle ctrl-c cancellation | 🟢 | Render option changes from root exit to App-owned cancellation; test inspects render options. |
| `8a0a2c7c` fix(tui): share repl max context resolution | 🟢 | Removes duplicated fallback logic; test is source-level but adequate for this wiring. |
| `e1de20fd` fix(prompt): clarify runtime reminder trust | 🟢 | Prompt wording fixes the trust ambiguity; test checks the old unsafe wording is gone. |
| `eb568522` fix(infra): enforce lint boundary guards in ci | 🟢 | Adds real lint execution and custom dynamic/relative import guard; probe test is meaningful. |
| `949cb6fb` fix(infra): restrict release workflow permissions | 🟢 | Job-scoped permissions and checkout credential persistence are tested. |
| `7f5942c8` fix(infra): gate npm publish on version checks | 🟢 | Publish job now needs version verification; test covers all listed package jsons. |
| `538008cf` fix(core): prune old mcp image spills | 🟢 | Per server/tool cap is implemented after write; test covers pruning older files. |
| `d523f298` fix(tui): handle delete key at cursor | 🟢 | Separates Backspace and Delete semantics; test exercises cursor delete. |
| `90fb6c0f` fix(desktop): restrict markdown reads to listed paths | 🟢 | Allowlist model is stronger than path-shape validation; list/save/install paths register themselves. |
| `46d2e826` fix(core): sanitize settings prototype keys | 🟢 | Sanitizes loaded/merged settings recursively and rejects dangerous dotted segments; test exercises `__proto__` smuggling. |
| `8fb60acc` fix(desktop): use replay clock for agent timestamps | 🟢 | Agent start/end timestamps now use reducer clock; test verifies replay determinism. |
| `1ea527ad` fix(infra): fail asset copy on empty globs | 🟢 | Root cause fixed; test covers empty and non-empty glob behavior. |
| `daebaccb` fix(tui): reject oversized images before reading | 🟢 | Size is checked before `readFileSync`; test would fail on the old read-first path. |
| `0d175ef0` fix(plugins): reject unsafe source transports by default | 🟠 | Lower-case unsafe transports are rejected, but uppercase schemes bypass the check. |
| `4e2f5454` fix(tui): redact secrets in config output | 🟢 | Covers common schema keys (`apiKey`, `secret`, `token`, etc.); tests check show/get. |
| `55ae9cf8` fix(core): honor codeshell home for background shells | 🟢 | Moves artifacts under `codeShellHome()` directly; tests cover path layout. |
| `053ceaae` fix(core): honor codeshell home for mcp images | 🟢 | Same home-resolution correction for image spills; test covers non-nested layout. |
| `4fd4a12f` fix(core): expose marketplace tool in presets | 🟢 | Simple preset whitelist addition with direct test. |
| `e32c0fb7` fix(core): clean up failed mcp discovery | 🟢 | Discovery failures now disconnect/unregister through the existing cleanup path; test covers close and server removal. |
| `8588d7a6` fix(core): run async context cleanup passes | 🟢 | Brings async path in line with sync cleanup before compaction gates; test exercises below-threshold cleanup. |
| `eac53b98` fix(core): rewrite plugin vars on local install | 🟢 | Calls existing rewrite utility for local installs; test verifies installed copy. |
| `b9cdd43b` fix(core): retain mcp resource ownership | 🟢 | Resources now carry `serverName` and list filtering uses the allowed set; test covers hiding another server. |
| `c3163e35` fix(core): forward abort signal to mcp tools | 🟢 | Discovered MCP tools receive the registry child signal; direct MCP builtins already forward `__signal`. |
| `a8158866` fix(core): scope browser credential injection | 🟢 | Propagates `settingsScope` into tool visibility and resolve/auto-approve paths; TUI/servers set `full`, project engines stay restricted. |
| `bf66737a` fix(cdp): mark missing media refs stale | 🟢 | Missing image refs now signal `staleRef`; test covers the flag. |
| `32ab8d10` fix(cdp): return video extract refs | 🟢 | Video refs are assigned and returned for element/source URLs; test checks generated script. |
| `be7a393b` fix(cdp): sanitize image max dimension | 🟢 | `maxDim` is normalized before interpolation; test covers injection-shaped input. |
| `8ef89609` fix(cdp): clamp click points to viewport | 🟠 | Origin-viewport tests pass, but non-zero `pageX/pageY` likely produces non-viewport dispatch coordinates. |
| `da84f435` fix(cdp): reject no-box synthetic clicks | 🟢 | Removes JS click fallback and test confirms no resolve/callFunction fallback remains. |

