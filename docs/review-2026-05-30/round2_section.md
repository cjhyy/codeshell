### ✅ 第二轮已验证的真问题(91 条,下表列 3 高 + 33 中;另 55 条降级为低见 `backlog_confirmed.json`)

> 对 143 条 backlog 跑了 143 个 skeptic agent 对抗验证 → **52 条(36%)误报**,91 条判真;其中 3 条提升到高、33 条中、55 条降级为低。下表只列高+中(36 条),低的见数据文件。

| 状态 | 严重度 | 维度 | 位置 | 问题 | 修复方向 |
| ---- | ------ | ---- | ---- | ---- | -------- |
| ⬜ | 🔴 高 | 正确性 | `core/lsp/manager.ts:71` | Incorrect path handling with simple string replace | Replace with `fileURLToPath(this.rootUri)` |
| ⬜ | 🔴 高 | 正确性 | `core/run/FileRunStore.ts:73-81` | Promise rejection in appendJsonl lock chain not handled | Catch and handle errors within the promise: `const current = prev.then(() => { try { appen… |
| ⬜ | 🔴 高 | 正确性 | `tui/voice/index.ts:90, 94` | Shell redirections in which checks fail without shell: true | Add { shell: true } option to both execSync calls in isRecordingAvailable() |
| ⬜ | 🟡 中 | 安全 | `core/arena/context-tools.ts:126` | Path traversal vulnerability on Windows systems | Use path.sep instead of hardcoded '/': `resolved === REPO_ROOT \|\| resolved.startsWith(RE… |
| ⬜ | 🟡 中 | 正确性 | `core/arena/providers/docs.ts:55` | Relevant documents excluded due to discovery order | Change to include documents in two sequential phases: first collect all relevant docs, the… |
| ⬜ | 🟡 中 | 正确性 | `core/context/compaction.ts:349` | Underestimated replacement size in applyToolResultBudget | Update line 349 to: `remaining += 656;` or better yet, calculate the actual replacement st… |
| ⬜ | 🟡 中 | 正确性 | `core/cron/scheduler.ts:131-136` | Silent default fallback masks invalid schedule configuration | Throw an Error or log a warning when schedule parsing falls back to the default, or valida… |
| ⬜ | 🟡 中 | 正确性 | `core/git/utils.ts:84` | Unvalidated split result in getGitLog may cause undefined property access | Add validation: `const parts = line.split("\|"); if (parts.length < 4) continue;` or use `… |
| ⬜ | 🟡 中 | 正确性 | `core/onboarding.ts:309` | resolveApiKey bypasses sanitization unlike detectEnvKeys | Replace `process.env[p.envKey]?.trim()` with `sanitizeApiKey(process.env[p.envKey] \|\| ''… |
| ⬜ | 🟡 中 | 安全 | `core/remote/bridge.ts:106-116` | Command injection risk via identityFile and remoteCommand | Validate identityFile path (reject absolute paths, '..' sequences). For remoteCommand, avo… |
| ⬜ | 🟡 中 | 正确性 | `core/services/session-memory.ts:51-55` | Incorrect 'most recent first' sorting for session memories | Parse the createdAt timestamp from the SessionMemoryEntry objects and sort by that, or ens… |
| ⬜ | 🟡 中 | 正确性 | `core/tool-system/builtin/apply-patch/parser.ts:261-267` | Blank lines treated as context lines without marker verification | Require blank lines to have an explicit ' ' marker prefix, treating truly blank lines (no … |
| ⬜ | 🟡 中 | 正确性 | `core/tool-system/builtin/arena.ts:498` | Unsafe error property access in catch block | Use `const msg = err instanceof Error ? err.message : String(err);` or `const msg = (err a… |
| ⬜ | 🟡 中 | 正确性 | `core/tool-system/builtin/lsp.ts:103` | Hardcoded 2-second timeout for LSP diagnostics is a race condition | Either: (1) Subscribe to LSP diagnostic notifications and collect results until no new one… |
| ⬜ | 🟡 中 | 正确性 | `core/tool-system/sandbox/seatbelt.ts:115-116` | Incomplete escape sequence handling in SBPL profile path quoting | Escape backslashes before double quotes: return `"${path.replace(/\\/g, '\\\\').replace(/"… |
| ⬜ | 🟡 中 | 正确性 | `core/utils/format.ts:38-49` | formatDuration incorrectly returns '0s' for milliseconds in range [1, 1000) | After line 40, before line 48, add a check: if the floored value is 0 and ms > 0, format w… |
| ⬜ | 🟡 中 | 正确性 | `desktop/renderer/Markdown.tsx:108-113` | Uncleanable timer may cause memory leak warning on unmount | Use useEffect with a cleanup that aborts the timer, or store the timeout ID in a useRef an… |
| ⬜ | 🟡 中 | 正确性 | `desktop/renderer/TopBar.tsx:98-107` | Div with onFocus/onBlur handlers is not keyboard-focusable | Add tabIndex={0} to the div at line 98 to make it keyboard-focusable so focus/blur handler… |
| ⬜ | 🟡 中 | 正确性 | `desktop/renderer/messages/fileChangeAggregator.ts:12-14` | countLines() counts trailing newline as extra line, inconsistent with linesOf() | Make countLines() consistent with linesOf(): `return typeof s === "string" && s.length > 0… |
| ⬜ | 🟡 中 | 正确性 | `desktop/renderer/sessions/SessionsView.tsx:49-55` | Missing error handling in commitEdit allows silent failures | Wrap the renameSession call in a try-catch block and only clear the editing state on succe… |
| ⬜ | 🟡 中 | 正确性 | `desktop/renderer/sessions/SessionsView.tsx:124-127` | Unhandled promise rejection in delete button handler | Wrap the deleteSession call in a try-catch block. Only call refresh() on success, and disp… |
| ⬜ | 🟡 中 | 正确性 | `desktop/renderer/settings/AgentsSection.tsx:98-110` | Missing error handling in remove function | Wrap the deleteAgent call and subsequent load() call in a try-catch block. Only clear UI s… |
| ⬜ | 🟡 中 | 正确性 | `desktop/renderer/settings/PermissionSection.tsx:39-55` | No error handling for updateSettings failure | Add a catch block to handle and display errors: catch (e) { console.error(e); /* display e… |
| ⬜ | 🟡 中 | 正确性 | `desktop/renderer/settings/SearchConnectionsPanel.tsx:159-161` | Silent error handling in saveProvider with no user feedback | Add error state tracking to ProviderState (or panel-level) and display error messages to u… |
| ⬜ | 🟡 中 | 正确性 | `desktop/renderer/settings/SearchConnectionsPanel.tsx:164-171` | No error handling in clearProvider, risking UI/state desync | Wrap writeBack in try-catch and only call setByProvider after a successful write, or rever… |
| ⬜ | 🟡 中 | 正确性 | `desktop/renderer/workspace-trust/TrustGate.tsx:16` | Unhandled promise rejection in getTrust call | Add .catch(err => { if (!cancelled) console.error(err); }) or use try-catch in an async II… |
| ⬜ | 🟡 中 | 正确性 | `tui/cli/commands/builtin/extra-commands.ts:29` | Silent error handling when parsing settings.json | Log the error or validate JSON parsing with explicit error handling, e.g., `} catch (err) … |
| ⬜ | 🟡 中 | 正确性 | `tui/cli/input/ndjson-reader.ts:30-50` | Unclosed readline interface resource leak in start() method | Add rl.close() in the 'close' event handler, or return a cleanup function from start() tha… |
| ⬜ | 🟡 中 | 正确性 | `tui/cli/main.ts:190` | Missing validation on parseInt for --max-turns option | Add validation with Number.isNaN() before returning, or use a safer parsing function. |
| ⬜ | 🟡 中 | 正确性 | `tui/render/measure-text.ts:27` | Loop processes text one position past the end, creating spurious empty line | Change loop condition to 'while (start < text.length)' or add explicit check to break when… |
| ⬜ | 🟡 中 | 安全 | `tui/render/render-node-to-output.ts:182-186` | Unvalidated URL in OSC 8 hyperlink sequences | Validate and escape the URL before use. At minimum, reject URLs containing  (BEL) or  (E… |
| ⬜ | 🟡 中 | 正确性 | `tui/render/render-node-to-output.ts:453-460, 546, 1241` | Absolute-positioned element y-clamping not reflected in cached geometry | Store the actual computed yogaTop separately from the rendered y position. Use the actual … |
| ⬜ | 🟡 中 | 简化 | `tui/ui/components/ModelManager.tsx:411-416, 419-428` | Duplicated utility functions fmtTokens and modelTags | Extract fmtTokens and modelTags to a shared utilities file (e.g., packages/tui/src/ui/util… |
| ⬜ | 🟡 中 | 正确性 | `tui/ui/index.tsx:92-96` | Resource leak on unhandled rejection from waitUntilExit() | Wrap the await in try-catch-finally: try { await instance.waitUntilExit(); } finally { cle… |
| ⬜ | 🟡 中 | 正确性 | `tui/ui/onboarding-runner.tsx:31-47` | Race condition: instance assigned asynchronously but used synchronously | Await the render promise before subscribing to the component callbacks, or guard the finis… |
| ⬜ | 🟡 中 | 正确性 | `tui/ui/vim-mode.ts:129` | Cursor position not re-clamped after deletion in 'x' command | After line 129, add: s.cursor = Math.min(s.cursor, text.length > 0 ? text.length - 1 : 0); |

#### 第二轮高严重度详解(3)

- **[🔴 高 正确性] core/lsp/manager.ts:71 — Incorrect path handling with simple string replace**
  - The line `this.rootUri.replace('file://', '')` only removes the first occurrence of 'file://' and doesn't properly convert a file URL to a platform-specific path. On Windows, 'file:///C:/Users/...' becomes '/C:/Users/...' which is invalid. The correct approach is to use `fileURLToPath()` from 'node:url' which is already imported.
  - **修复**:Replace with `fileURLToPath(this.rootUri)`
  - _验证_:Line 71 uses `this.rootUri.replace("file://", "")` to convert a file URI to a file path for passing to `spawn()` as the `cwd` option. However, this approach is platform-unsafe: on Windows, a file URI like `file:///C:/Users/test` becomes `/C:/Users/test` (invalid path), whereas th

- **[🔴 高 正确性] core/run/FileRunStore.ts:73-81 — Promise rejection in appendJsonl lock chain not handled**
  - If `appendFileSync()` throws inside the `.then()` callback (line 77), the returned `current` promise rejects. The lock map stores this rejected promise, and the next write will await the rejected promise, causing it to fail immediately without retrying. This breaks the serialize-writes guarantee.
  - **修复**:Catch and handle errors within the promise: `const current = prev.then(() => { try { appendFileSync(...); } catch (e) { console.error(...); throw; } }).catch(e => { this.appendLocks.delete(filePath); throw e; });` or use Promise.allSettled.
  - _验证_:The code chains `.then()` without an error handler on the previous lock promise. If `appendFileSync()` throws inside the callback (line 77), the returned `current` promise becomes rejected and is stored in the lock map (line 79). When the next write calls `appendJsonl()`, it retr

- **[🔴 高 正确性] tui/voice/index.ts:90, 94 — Shell redirections in which checks fail without shell: true**
  - The execSync calls on lines 90 and 94 use shell OR operators (||) and redirections (2>/dev/null) which require shell interpretation, but do not pass { shell: true } option. The commands will fail because || is treated as a literal argument.
  - **修复**:Add { shell: true } option to both execSync calls in isRecordingAvailable()
  - _验证_:The execSync calls on lines 90 and 94 use shell operators (||) and redirections (2>/dev/null) without the shell: true option. Without this option, Node.js does not interpret these as shell syntax — instead, it attempts to execute the entire string as a program name with the opera
