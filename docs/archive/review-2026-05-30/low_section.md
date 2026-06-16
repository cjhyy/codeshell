### ⚪ 低严重度真问题(60 条,两轮合计)

> 两轮验证里判真但降级为低的 60 条(正确性 48 / 性能 6 / 安全 3 / 简化 3)。多为边界/小一致性/局部优化。**注**:`core/services/oauth.ts:38-44` 的 openBrowser 命令注入与已列为「中」的 notifier.ts 同类,建议提到中级一并修。完整数据 `low_confirmed.json`。

| 状态 | 维度 | 位置 | 问题 | 修复方向 |
| ---- | ---- | ---- | ---- | -------- |
| ⬜ | 安全 | `core/services/oauth.ts:38-44` | Command injection vulnerability in openBrowser URL ⚠️建议提中 | Escape the URL using shell escaping (e.g., use 'printf %q' or a library like 'sh… |
| ⬜ | 安全 | `desktop/preload/index.ts:80-81` | Log function sends unsanitized user data to main process | Add a sanitization step before sending: strip known sensitive keys (passwords, t… |
| ⬜ | 安全 | `tui/cli/commands/builtin/core-commands.ts:627-630` | Unnecessary use of shell command for file I/O | Replace with `readFileSync(join(ctx.cwd, 'package.json'), 'utf-8')` from node:fs… |
| ⬜ | 性能 | `core/engine/engine.ts:929-930` | Double Map.get() call on same key | Store the result of .get() in a variable and reuse it: `const cached = this.comp… |
| ⬜ | 性能 | `core/run/RunQueue.ts:30` | O(n) lookup in enqueue using array.includes() | Use a Set to track pending runIds instead of an array, changing pending to a Map… |
| ⬜ | 性能 | `core/tool-system/builtin/web-fetch.ts:267` | Full response loaded into memory before truncation | For text responses, stream the response and truncate during reading, or limit th… |
| ⬜ | 性能 | `desktop/main/memory-service.ts:51, 68` | Repeated loadAll() calls for same memory manager state | Cache the entries from loadAll() for the same (level, scope, cwd) tuple, or refa… |
| ⬜ | 性能 | `tui/cli/commands/builtin/utility-commands.ts:33` | Synchronous execSync blocks event loop for clipboard operations | Replace execSync with an async alternative: use `exec()` from child_process with… |
| ⬜ | 性能 | `tui/render/output.ts:363-387` | O(n*m) loop checking absoluteClears for every row during blit | Build a Set or Map of row ranges covered by absoluteClears during the initial co… |
| ⬜ | 正确性 | `core/arena/iterate/phases/argue.ts:126-202` | Uninitialized finalText passed to parser on max-token failure | Check if finalText is still empty after the fallback attempt and either: (a) log… |
| ⬜ | 正确性 | `core/arena/phases/participant-research.ts:202-216` | Missing abort signal in force-conclude message | Add `signal,` parameter to the force-conclude client.createMessage call: `signal… |
| ⬜ | 正确性 | `core/arena/providers/docs.ts:109-111` | Truncate fails when no newline in first MAX_DOC_CHARS | Change to `return t.slice(0, lastNl >= 0 ? lastNl : t.length) + '\n... (truncate… |
| ⬜ | 正确性 | `core/arena/providers/repo.ts:204-207` | Truncate fails when no newline in first MAX_FILE_CHARS | Change to `return t.slice(0, lastNl >= 0 ? lastNl : t.length) + '\n... (truncate… |
| ⬜ | 正确性 | `core/arena/strategies/utils.ts:75-83` | extractJSONArray uses greedy regex that captures multiple arrays as one | Use non-greedy matching: `/\[[\s\S]*?\]/` or better yet, try to find balanced br… |
| ⬜ | 正确性 | `core/data/openrouter-sync.ts:73` | Unsafe error message access on caught exception | Use `err instanceof Error ? err.message : String(err)` to safely extract the err… |
| ⬜ | 正确性 | `core/git/worktree.ts:134` | Hardcoded HEAD hash truncation assumes 8-character format | Replace `line.slice(5, 13)` with `line.slice(5).split(/\s/)[0]` or similar to ex… |
| ⬜ | 正确性 | `core/onboarding.ts:282` | validateApiKey may incorrectly return true for malformed API responses | Change `return !data.error;` to `return data.error === undefined \|\| data.error… |
| ⬜ | 正确性 | `core/onboarding.ts:693-700` | Orphaned temporary file when renameSync fails | Add `unlinkSync(tmp)` in the catch block after the fallback write, or use a try-… |
| ⬜ | 正确性 | `core/plugins/installer/codex/convertMcp.ts:32` | Unsafe type cast of unparsed JSON without validation | Add a validation check before line 32: `if (!parsed \|\| typeof parsed !== 'obje… |
| ⬜ | 正确性 | `core/plugins/installer/update.ts:26` | Unhandled JSON/Zod parsing error in update.ts | Wrap JSON.parse() and the Zod validation in a try-catch block, throwing PluginIn… |
| ⬜ | 正确性 | `core/product/define.ts:158-159` | Ambiguous system prompt precedence not enforced | Add validation: if presetDef.customPrompt is defined, do not build agentPreset.p… |
| ⬜ | 正确性 | `core/prompt/composer.ts:64` | System prompt uses UTC date instead of local date | Use `new Date().toLocaleDateString('en-CA')` instead of `new Date().toISOString(… |
| ⬜ | 正确性 | `core/protocol/types.ts:326-328` | isResponse type guard doesn't validate required fields | Add a check to verify at least one of 'result' or 'error' exists: `return "id" i… |
| ⬜ | 正确性 | `core/remote/bridge.ts:66-71` | Missing write error handling in send() | Check the return value of write() and add an error handler to ssh.stdin, or use … |
| ⬜ | 正确性 | `core/remote/bridge.ts:94-100` | Incomplete resource cleanup: listeners not removed | Store listener references and remove them: this.ssh.stdout?.off('data', handler)… |
| ⬜ | 正确性 | `core/run/ArtifactTracker.ts:167` | Regex for bash redirection doesn't handle quoted paths | Enhance the regex to handle both quoted and unquoted paths: `/[>\|]\s*(['"]?)([^… |
| ⬜ | 正确性 | `core/run/FileRunStore.ts:58-63` | Atomic write doesn't clean up temp file on failure | Wrap the rename in a try-catch and delete the temp file on failure: `try { renam… |
| ⬜ | 正确性 | `core/services/memory-orchestrator.ts:75-76` | Memory extraction only checks user scope for duplication, ignoring dream scope | Load both user and dream scopes before extraction: change line 75 to load both s… |
| ⬜ | 正确性 | `core/session/session-manager.ts:169` | Race condition in atomic write with process.pid-based temp file naming | Use a cryptographically unique suffix like `nanoid()` instead of `process.pid.Da… |
| ⬜ | 正确性 | `core/tool-system/builtin/sleep.ts:33-35` | Abort signal listener never removed on normal completion | Use `signal?.addEventListener("abort", ..., { once: true })` to automatically re… |
| ⬜ | 正确性 | `core/types.ts:101` | SessionStatus includes 'paused' but it's not documented as a valid TerminalReason | Either (1) add 'paused' to the TerminalReason union if it represents a valid ter… |
| ⬜ | 正确性 | `core/utils/theme.ts:649` | Incorrect xterm-256 grayscale index formula | Change line 649 from `Math.round((r - 8) / 247 * 24) + 232` to `Math.round((r - … |
| ⬜ | 正确性 | `desktop/main/agent-bridge.ts:103` | Readline interface resource leak on child process exit | Capture `rl` as an instance variable or call `rl.close()` in the 'exit' event ha… |
| ⬜ | 正确性 | `desktop/main/updater.ts:101-102` | Timers not stored or cleaned up on app shutdown | Store the timeout and interval IDs in module-scope variables, and export a clean… |
| ⬜ | 正确性 | `desktop/main/window-state-store.ts:19-20` | Stored window state values not validated, allowing invalid data to be used | Add runtime validation after parsing JSON: check that width/height are positive … |
| ⬜ | 正确性 | `desktop/preload/index.ts:38-44` | msg.id type cast without validation; wrong id type causes silent loss | Add type check: `if (typeof msg.id !== 'number') return;` before line 40. |
| ⬜ | 正确性 | `desktop/preload/index.ts:50-62` | agent/approvalRequest passes undefined params to listeners | Add a null check and ensure params has the expected structure before forwarding:… |
| ⬜ | 正确性 | `desktop/renderer/chat/MentionPopover.tsx:75-85` | Comment-code mismatch: filteredSkills limited to 8 not 6 | Change line 85 to `return matches.slice(0, 6);` to match the documented limit of… |
| ⬜ | 正确性 | `desktop/renderer/messages/FilesChangedCard.tsx:68` | Uncleaned setTimeout in onUndoConfirmed creates memory leak | Wrap the setTimeout logic in a useEffect with proper cleanup: `useEffect(() => {… |
| ⬜ | 正确性 | `desktop/renderer/settings/McpSection.tsx:414` | HTTP headers formatted as KEY=VALUE instead of Key: Value | Modify `envOrHeadersToText` to accept a format parameter, or create a separate f… |
| ⬜ | 正确性 | `desktop/renderer/shell/CommandPalette.tsx:58` | Cursor can become negative when ArrowDown pressed on empty list | Guard the cursor update to only apply when filtered.length > 0, or clamp the res… |
| ⬜ | 正确性 | `desktop/renderer/tool-cards/attachments.ts:74-76` | Write success detection relies on fragile result string heuristic | Add an explicit check for truthy result before adding the attachment: `const lc … |
| ⬜ | 正确性 | `tui/bootstrap/setup.ts:65` | Missing try-catch on process.chdir() | Wrap process.chdir(cwd) in a try-catch block with appropriate error messaging, s… |
| ⬜ | 正确性 | `tui/cli/main.ts:91` | Missing validation on parseInt for --limit option | Validate the parsed integer with Number.isNaN() or use parseInt with radix and v… |
| ⬜ | 正确性 | `tui/index.ts:2-5` | Comment claims UI components are exported, but they are not | Either: (1) add 'export { startInkRepl, type InkReplOptions } from "./ui/index.j… |
| ⬜ | 正确性 | `tui/render/components/Newline.tsx:21-24` | No validation for negative count parameter | Add validation after line 21 to ensure count >= 1, e.g., const count = Math.max(… |
| ⬜ | 正确性 | `tui/render/devtools.ts:54-66` | WriteStream resource leak - stream never closed | Add an explicit close mechanism - either store a cleanup function that calls `st… |
| ⬜ | 正确性 | `tui/render/parse-keypress.ts:177-179` | splitNumericParams does not handle empty numeric parameters | Filter out empty strings before parsing, or use parseInt with a fallback default… |
| ⬜ | 正确性 | `tui/render/terminal-focus-state.ts:18-23` | Dead code: resolvers set is never populated | Either populate the `resolvers` set in `waitForBlur()` or similar function, or r… |
| ⬜ | 正确性 | `tui/render/termio/osc.ts:367-393` | Incomplete escape sequence handling at end of input | Before the final yield on line 392, check if `esc` is true (indicating a trailin… |
| ⬜ | 正确性 | `tui/render/wrap-text.ts:59` | Unsafe non-null assertion on optional parameter | Either: (1) Add a check: `if (wrapType && wrapType.startsWith('truncate'))`, or … |
| ⬜ | 正确性 | `tui/ui/App.tsx:531` | Inconsistent indentation of clearThinkingBuffer() call | Align the indentation of line 531 to match lines 529-530 for consistency. |
| ⬜ | 正确性 | `tui/ui/App.tsx:1042` | Inconsistent indentation of clearThinkingBuffer() call in Ctrl+C handler | Align the indentation of line 1042 to match lines 1040-1041 for consistency. |
| ⬜ | 正确性 | `tui/ui/components/CodeBlock.tsx:28,41` | Inconsistent border width calculations in code block | Calculate a consistent border width. Use the same logic for both borders, or mea… |
| ⬜ | 正确性 | `tui/ui/components/CommandInput.tsx:154` | Dead condition in handleSubmit logic | Remove the redundant trim comparison or clarify the intent—if checking for exact… |
| ⬜ | 正确性 | `tui/ui/store.ts:151-153` | notify() lacks error isolation for listener failures | Wrap listener calls in try-catch blocks to ensure all listeners fire regardless … |
| ⬜ | 正确性 | `tui/ui/terminal-renderer.ts:50` | Resize event listener never unregistered | Store the listener and unregister it in a cleanup/destroy method, or use once() … |
| ⬜ | 简化 | `core/arena/arena.ts:242-247, 356-361` | Duplicate claimSummary construction logic | Extract claimSummary construction into a shared helper function: `function build… |
| ⬜ | 简化 | `core/tool-system/builtin/agent-registry.ts:141-155` | Code duplication: cancel() duplicates markFinished() field updates | Extract the field-setting logic into a helper method or refactor cancel() to cal… |
| ⬜ | 简化 | `tui/ui/components/ModelSelector.tsx:21-27, 30-39` | Duplicated utility functions fmtTokens and modelTags | Extract fmtTokens and modelTags to a shared utilities file (e.g., packages/tui/s… |
