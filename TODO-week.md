# 本周 TODO — 2026-05-28 → 2026-06-03

> 这周要做的事。**只放本周**;长线路线图见 `TODO.md`。只保留未完成/进行中的。

## 待办

| 状态 | #   | 任务                          | 备注 / 关键落点                                                                                                                                                                                                                            |
| ---- | --- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🟡 | 4   | plugin / skill 系统跟 Codex 对齐 | 本地安装 / 转换 / 运行时加载 / list-update-uninstall / **远程安装(#11 已完成)**。**剩**:跨 MCP/builtin/skill 统一能力注册表收尾(core 大改) |
| ✅ | 11  | 远程插件安装(git 来源)        | spec `docs/superpowers/specs/2026-05-29-plugin-remote-install-design.md`,**已实现**(2026-05-30,TDD)。`parseSource.ts`(解析 `github:org/repo`/https/ssh + `@ref`/`#subdir`)+ `installFromSource.ts`(薄桥:`gitClone` 临时目录 → `installPluginFromPath` 转换+装 → 改写 `.cs-meta.json.source` 为原始 git 串 → 删临时目录);`update.ts` 远程源重拉重装;CLI dispatch 本地/远程。16 个新单测/集成测全绿 |
| 🟡 | 10  | 多 session 上下文/串台 + 慢 修复 | 辅助任务模型已落地。**剩**:见「遗留 / 待确认」 |
| 🟡 | 12  | 全量逐文件 review 修复          | 2026-05-30 multi-agent review,两轮对抗验证后 **121 条真问题(9 高 + 52 中 + 60 低)**。**9 个高已全部处理**:8 修复(6 第一轮 + lsp 路径 + FileRunStore 锁链)、1 误报(voice execSync 本就走 shell)。**剩 52 中 + 60 低**,逐个验证(高误报率)后修+提交。详见下「🔬 全量逐文件 review」 |

## 遗留 / 待确认

- [ ] **memory extraction 耗时波动** —— `elapsedMs` 3083→5939→8689 递增又掉回 1772,原因未查。
- [ ] **Anthropic provider 图片过滤未做** —— `stripVisionFromHistory` 只接 OpenAI-compat 路径;接非视觉 anthropic-style 模型时会漏(当前 claude 全支持视觉,YAGNI)。
- [ ] **main 领先 origin/main 未 push**。
- [ ] **并行 session 撞车风险** —— 同仓库可能有另一 session 在写+提交;在 main 上干活前先确认。
- [ ] **根 `tsup.config.ts` 是死配置**(指向不存在的 `src/run`/`src/product`,真实构建走 workspaces `--filter`),可顺手删/更新(低优先)。

## 🔬 全量逐文件 review(2026-05-30,multi-agent workflow)

**方法**:对 core/tui/desktop 三包 **571 个非测试源文件**逐文件 review(143 个 reviewer agent 并行,每 agent 读全文件再判定),覆盖正确性/安全/简化/性能四维。初轮 **296 条**(高 58 / 中 144 / 低 94)。对 **58 条高严重度** 再跑一轮**对抗式验证**(58 个 skeptic agent 逐条重读代码尝试反驳)→ **28 条(48%)被判误报**,印证单 reviewer 噪声率。下面 **30 条为验证通过的真问题**;**第二轮**又对那 143 条中严重度跑了对抗验证 → **52 条(36%)误报**,**91 条判真**(3 高 + 33 中 + 55 低)。两轮合计 **121 条已验证真问题**(9 高 + 52 中 + 60 低,低的已全部列表见文末)。

> 原始数据:`docs/review-2026-05-30/`(`confirmed.json` 30 条验证通过、`backlog.json` 143 条待分诊、`findings.json` 全 296 条)

### ✅ 已验证的真问题(30 条)

| 状态 | 严重度 | 维度 | 位置 | 问题 | 修复方向 |
| ---- | ------ | ---- | ---- | ---- | -------- |
| ✅ | 🔴 高 | 正确性 | `core/cli/agent-server-stdio.ts:159-172` | No graceful shutdown on process signals (SIGTERM, SIGINT, SIGHUP) | **已修(2026-05-30,TDD)**:抽出 `cli/graceful-shutdown.ts`(可测纯函数,幂等+吞 close 异常),入口注册 SIGTERM/SIGINT/SIGHUP → `agentServer.close()` → exit |
| ✅ | 🔴 高 | 正确性 | `core/cron/scheduler.ts:100-110` | Race condition in async setInterval callback with overlapping executions | **已修**:加 `running` Set 重入守卫,上一次 onExecute 未完成时跳过本 tick;`finally` 清守卫。测试证明 maxConcurrent=1 |
| ✅ | 🔴 高 | 正确性 | `core/tool-system/builtin/apply-patch/index.ts:109-111` | File cache invalidated with relative paths instead of absolute paths | **已修**:invalidate 改用 `resolvePath(cwd, hunk.path)` 绝对路径(与 policy gate 一致)。测试断言 cache size 归零(非 get,避开 mtime 自愈掩盖) |
| ✅ | 🔴 高 | 安全 | `tui/cli/commands/builtin/core-commands.ts:512, 523` | Command injection vulnerability via unsanitized git diff argument | **已修**:抽出 `git-diff.ts`,改 `execFileSync("git", [argv])` 不过 shell。测试用 `; touch PWNED #` 恶意 arg 证明不执行、被当字面 pathspec |
| ✅ | 🔴 高 | 正确性 | `tui/native-ts/yoga-layout/index.ts:958` | Root position TOP inset resolved against wrong dimension | **已修**:`posT` 从 `isDefined(w)?w:0` 改为按高度 `isDefined(h)?h:0`。`position-percent.test.ts` 覆盖 |
| ✅ | 🔴 高 | 正确性 | `tui/native-ts/yoga-layout/index.ts:1859-1865` | Flex item relative position TOP/BOTTOM resolved against wrong dimension | **已修**:`relTop`/`relBottom` 从 `ownerW` 改为 `ownerH`(LEFT/RIGHT 仍 ownerW)。abs 定位路径本就正确,未动 |
| ⬜ | 🟡 中 | 正确性 | `core/arena/iterate/tools/web-tools.ts:52-56` | Missing await on async tool function calls | Add await before both webSearchTool(args) on line 53 and webFetchTool(args) on line 56: `r… |
| ⬜ | 🟡 中 | 正确性 | `core/arena/phases/planning-detail-expansion.ts:88-142` | LLM not invoked after tool execution on final round | Either: (1) use `round < maxRounds` instead of `round <= maxRounds` and make an additional… |
| ⬜ | 🟡 中 | 正确性 | `core/git/worktree.ts:97-104` | Running git commands on already-removed worktree will fail | Extract and store the branch name before removing the worktree (line 89), then use it to d… |
| ⬜ | 🟡 中 | 正确性 | `core/lsp/manager.ts:44-47` | Race condition: polling for server readiness without guarantee | Use a proper synchronization primitive (e.g., a promise that resolves when state changes t… |
| ⬜ | 🟡 中 | 正确性 | `core/plugins/installer/update.ts:45-46` | Inconsistent state if reinstall fails after uninstall | Wrap the uninstall+install sequence in try-catch, or call install first (to validate) befo… |
| ⬜ | 🟡 中 | 正确性 | `core/remote/bridge.ts:53-59` | Logic error: exit handler always rejects due to redundant condition | Change the exit handler to track connection state separately or check the exit code. For e… |
| ⬜ | 🟡 中 | 正确性 | `core/remote/bridge.ts:36-60` | Promise rejection race condition: error events after resolution are unhandled | Add a resolved flag: let resolved = false; Set it to true after resolve/reject, then check… |
| ⬜ | 🟡 中 | 安全 | `core/services/notifier.ts:28-31` | Command injection vulnerability in macOS notification | Use parameterized execution or properly quote the entire osascript command. Consider using… |
| ⬜ | 🟡 中 | 正确性 | `core/tool-system/builtin/send-message.ts:33` | __agentName is read from args but never injected | Add an `agentName` field to ToolContext (or use a different mechanism to inject the agent'… |
| ⬜ | 🟡 中 | 正确性 | `desktop/main/desktop-logger.ts:52-63` | Cached log path doesn't roll over at midnight | Check if the cached date still matches today before returning the cached path. Compare the… |
| ⬜ | 🟡 中 | 正确性 | `desktop/preload/index.ts:69-76` | RPC function has no error handling or timeout, causes infinite hangs | Add error handling: wrap `ipcRenderer.send()` in try-catch, add a timeout using Promise.ra… |
| ⬜ | 🟡 中 | 安全 | `desktop/preload/index.ts:213-225` | File paths passed to main process without traversal validation | Validate paths: reject absolute paths, reject paths containing '..', and ensure paths are … |
| ⬜ | 🟡 中 | 正确性 | `desktop/renderer/settings/PermissionSection.tsx:27-33` | Unhandled promise rejection in load() function | Wrap the getSettings call in try-catch: try { const s = (await window.codeshell.getSetting… |
| ⬜ | 🟡 中 | 安全 | `tui/cli/commands/builtin/more-commands.ts:21` | Command injection vulnerability in /files command pattern | Use execSync's built-in argument arrays instead of string interpolation, or escape the pat… |
| ⬜ | 🟡 中 | 正确性 | `tui/render/ink.tsx:410-411, 1757-1759, 1762-1768` | Promise in waitUntilExit can hang indefinitely if unmount is called first | In waitUntilExit, ensure the promise is created first before assigning resolve/reject hand… |
| ⬜ | 🟡 中 | 正确性 | `tui/render/render-border.ts:46` | Text truncation ignores ANSI color codes, corrupting output | Use a width-aware truncation: iterate through the text character-by-character, tracking vi… |
| ⬜ | 🟡 中 | 正确性 | `tui/ui/vim-mode.ts:108` | Cursor movement 'l' can position cursor at -1 in empty text | Change to: s.cursor = text.length > 0 ? Math.min(text.length - 1, s.cursor + 1) : 0; |
| ⬜ | 🟡 中 | 正确性 | `tui/ui/vim-mode.ts:174` | Cursor movement 'l' in visual mode can position cursor at -1 | Change to: s.cursor = text.length > 0 ? Math.min(text.length - 1, s.cursor + 1) : 0; |
| ⬜ | 🟡 中 | 正确性 | `tui/utils/fullscreen.ts:34-51` | Incorrect logic in probeTmuxControlModeSync: env heuristic result cached as probe result | Remove lines 35-36. Start probing directly only if TERM_PROGRAM is not set or not iTerm (t… |
| ⬜ | ⚪ 低 | 正确性 | `core/arena/iterate/phases/argue.ts:126-202` | Uninitialized finalText passed to parser on max-token failure | Check if finalText is still empty after the fallback attempt and either: (a) log an error … |
| ⬜ | ⚪ 低 | 正确性 | `core/onboarding.ts:282` | validateApiKey may incorrectly return true for malformed API responses | Change `return !data.error;` to `return data.error === undefined \|\| data.error === false… |
| ⬜ | ⚪ 低 | 正确性 | `core/plugins/installer/update.ts:26` | Unhandled JSON/Zod parsing error in update.ts | Wrap JSON.parse() and the Zod validation in a try-catch block, throwing PluginInstallError… |
| ⬜ | ⚪ 低 | 正确性 | `core/types.ts:101` | SessionStatus includes 'paused' but it's not documented as a valid TerminalReason | Either (1) add 'paused' to the TerminalReason union if it represents a valid terminal stat… |
| ⬜ | ⚪ 低 | 正确性 | `desktop/main/agent-bridge.ts:103` | Readline interface resource leak on child process exit | Capture `rl` as an instance variable or call `rl.close()` in the 'exit' event handler at l… |

#### 高严重度 / 安全项详解

- **[🔴 高 正确性] core/cli/agent-server-stdio.ts:159-172 — No graceful shutdown on process signals (SIGTERM, SIGINT, SIGHUP)**
  - The file sets up long-lived resources (chatManager with idleSweeper interval, StdioTransport, AgentServer) but has no signal handlers (process.on('SIGTERM'), process.on('SIGINT'), etc.). If the parent process sends SIGTERM or the user presses Ctrl+C, the process terminates immediately without calling AgentServer.close() to clean up (bgAgentBusUnsubscribe, chatManager.closeAll(), pending approvals, approval timers). This risks resource leaks and can leave child processes hanging (MCP servers, tool processes). The comment on line 170-171 incorrectly assumes shutdown is always graceful (stdin EOF only).
  - **修复**:Add signal handlers before the comment on line 170, e.g., `process.on('SIGTERM', () => { agentServer.close(); process.exit(0); })` and similarly for SIGINT and SIGHUP, ensuring cleanup before exit.
  - _验证_:The file creates an AgentServer with chatManager containing an idleSweeper interval and establishes StdioTransport, but fails to register signal handlers (process.on for SIGTERM, SIGINT, SIGHUP). When the parent process sends SIGTERM or user presses Ctrl+C, the process terminates immediately without

- **[🔴 高 正确性] core/cron/scheduler.ts:100-110 — Race condition in async setInterval callback with overlapping executions**
  - The async callback in setInterval (line 100) can overlap if onExecute takes longer than intervalMs. Multiple timer firings will queue simultaneously, causing nextRun and runCount to be updated multiple times before the first execution completes. The calculation on line 104 (nextRun = Date.now() + intervalMs) will then be wrong for all but the last queued execution. For long-running jobs, this causes scheduling drift and incorrect state tracking.
  - **修复**:Use a flag to prevent concurrent executions (e.g., set a boolean flag before awaiting, clear after), or use setTimeout with manual rescheduling instead of setInterval to ensure sequential execution.
  - _验证_:The setInterval callback can indeed be queued multiple times if onExecute takes longer than intervalMs. JavaScript's setInterval fires independently of callback completion. When multiple timer firings occur before the first onExecute completes, the synchronous state updates (lines 102-104) execute m

- **[🔴 高 正确性] core/tool-system/builtin/apply-patch/index.ts:109-111 — File cache invalidated with relative paths instead of absolute paths**
  - At lines 109-111, fileCache.invalidate() is called with hunk.path and hunk.movePath (relative paths from the patch). However, at line 102, applyPatch() is called with parsed.hunks containing the original relative paths. The applier resolves these to absolute paths internally (line 92 in applier.ts via resolveAgainst()). If fileCache stores entries by absolute path, invalidating by relative path will not match and cache entries will remain stale. This could cause the tool to report file contents that don't reflect the patch application.
  - **修复**:Store the resolved absolute paths from the planning phase and invalidate by those absolute paths, or pass the resolved paths back from applyPatch() in the result object.
  - _验证_:The fileCache is keyed by absolute paths (see file-cache.ts and usage in edit.ts line 80, read.ts lines 64-67). However, in apply-patch/index.ts lines 109-111, fileCache.invalidate() is called with relative paths (hunk.path and hunk.movePath) from parsed.hunks. These relative paths will not match th

- **[🔴 高 安全] tui/cli/commands/builtin/core-commands.ts:512, 523 — Command injection vulnerability via unsanitized git diff argument**
  - The `_arg` parameter (user input) is interpolated directly into shell commands without escaping: `execSync(\`git diff --stat HEAD ${file}\`, ...)`. An attacker could pass shell metacharacters like `; rm -rf /` or backticks to execute arbitrary commands. This affects both the stat and diff commands at these lines.
  - **修复**:Use `execFileSync` instead of `execSync` to avoid shell interpretation, or properly escape the file argument using a library like `shell-escape` before interpolation.
  - _验证_:The /diff command in core-commands.ts (lines 512 and 523) directly interpolates the user-provided `_arg` parameter into shell command templates without any sanitization or escaping. The code `execSync(\`git diff --stat HEAD ${file}\`, ...)` passes a backtick template literal to execSync, which inter

- **[🔴 高 正确性] tui/native-ts/yoga-layout/index.ts:958 — Root position TOP inset resolved against wrong dimension**
  - Line 958 resolves position TOP inset using `isDefined(w) ? w : 0` (width), but should use height. Top position insets should resolve against the container's height dimension, not width. This causes percentage-based position:top values on the root to be calculated incorrectly when the owner width differs significantly from height.
  - **修复**:Change line 958 from `isDefined(w) ? w : 0` to `isDefined(h) ? h : 0`
  - _验证_:Line 958 uses `isDefined(w) ? w : 0` to resolve the TOP position inset, but this is incorrect. The variable `w` holds the owner width, while `h` (defined on line 937) holds the owner height. For percentage-based position values, TOP/BOTTOM insets should resolve against the container's height dimensi

- **[🔴 高 正确性] tui/native-ts/yoga-layout/index.ts:1859-1865 — Flex item relative position TOP/BOTTOM resolved against wrong dimension**
  - Lines 1861 and 1865 resolve position TOP and BOTTOM insets using `ownerW` (width), but should use `ownerH` (height). Percentage-based position:top and position:bottom values on flex items with relative positioning will be calculated incorrectly, causing items to be positioned at wrong vertical offsets when using percentage position values.
  - **修复**:Change line 1861 from `ownerW` to `ownerH` and line 1865 from `ownerW` to `ownerH`
  - _验证_:Lines 1861 and 1865 in the flex layout relative positioning section incorrectly use `ownerW` (parent width) when resolving percentage values for `EDGE_TOP` and `EDGE_BOTTOM`. According to CSS specifications, TOP and BOTTOM insets should resolve against the parent's HEIGHT dimension, not width. This 

- **[🟡 中 安全] core/services/notifier.ts:28-31 — Command injection vulnerability in macOS notification**
  - The URL constructed with escape(message) and escape(title) is passed directly to osascript via execSync with double quotes. The escape() function replaces quotes and backslashes, but when placed inside a double-quoted string in the shell command, malicious input like `$(command)` or backtick substitution could still execute arbitrary commands. Example: a title containing `$(whoami)` would execute despite escaping.
  - **修复**:Use parameterized execution or properly quote the entire osascript command. Consider using 'printf %q' for shell-safe quoting or pass arguments via environment variables instead of string interpolation.
  - _验证_:The escape() function does not properly protect against shell injection via single quotes. In shell syntax, backslash does not escape quotes inside single-quoted strings — a backslash before a quote just produces a literal backslash and quote, which breaks the quoting boundary. Therefore, if a messa

- **[🟡 中 安全] desktop/preload/index.ts:213-225 — File paths passed to main process without traversal validation**
  - Multiple functions (`readSkillBody` line 213, `readAgentBody` line 223, and others) accept file paths and pass them directly to main process handlers without validating they stay within expected directories. An attacker can pass paths like '../../../etc/passwd' or absolute paths to read arbitrary files.
  - **修复**:Validate paths: reject absolute paths, reject paths containing '..', and ensure paths are relative to expected base directories before sending to main process.
  - _验证_:The functions `readSkillBody` (line 46-48 of skills-service.ts) and `readAgentBody` (line 56-58 of agents-service.ts) accept file paths and directly pass them to `fs.readFile()` without any validation. The IPC handlers in main/index.ts (line 273 for skills:read and line 293-295 for agents:read) also

- **[🟡 中 安全] tui/cli/commands/builtin/more-commands.ts:21 — Command injection vulnerability in /files command pattern**
  - The `pattern` variable from user input is directly interpolated into a shell command without escaping: `find . -maxdepth 3 -name "${pattern}"`. An attacker can inject arbitrary shell commands using backticks or `$(...)` syntax, e.g., `/files $(rm -rf /)` would execute the rm command.
  - **修复**:Use execSync's built-in argument arrays instead of string interpolation, or escape the pattern using shell escaping library (e.g., `shlex.quote` equivalent) before interpolating.
  - _验证_:The pattern variable at line 18 comes directly from untrimmed user input (`_arg.trim()`) with no sanitization. It is then interpolated directly into a shell command string at line 21: `find . -maxdepth 3 -name "${pattern}"`. The command is executed via execSync which interprets shell metacharacters.

### ✅ 第二轮已验证的真问题(91 条,下表列 3 高 + 33 中;另 55 条降级为低见 `backlog_confirmed.json`)

> 对 143 条 backlog 跑了 143 个 skeptic agent 对抗验证 → **52 条(36%)误报**,91 条判真;其中 3 条提升到高、33 条中、55 条降级为低。下表只列高+中(36 条),低的见数据文件。

| 状态 | 严重度 | 维度 | 位置 | 问题 | 修复方向 |
| ---- | ------ | ---- | ---- | ---- | -------- |
| ✅ | 🔴 高 | 正确性 | `core/lsp/manager.ts:71` | Incorrect path handling with simple string replace | **已修(TDD)**:抽 `lsp/root-path.ts` 用 `fileURLToPath`(修 Windows `/C:/` + %20 解码),替换 `replace("file://","")` |
| ✅ | 🔴 高 | 正确性 | `core/run/FileRunStore.ts:73-81` | Promise rejection in appendJsonl lock chain not handled | **已修(TDD)**:存进 map 的 lock 永不 reject(prev 用 `.catch`),本次错误仍抛给本 caller,无更新 writer 时清 map 项。补 recovery + 并发序列化两个测试 |
| ❎ | 🔴 高 | 正确性 | `tui/voice/index.ts:90, 94` | Shell redirections in which checks fail without shell: true | **误报**:`execSync` 默认走 `/bin/sh -c`(与 `execFileSync` 不同),`\|\|` 和 `2>/dev/null` 本就生效;已实测复现验证。darwin/linux 分支不跑 Windows。未改 |
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

---

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

---

## 📚 相关研究 / 资料

- 多 session 隔离/上下文装配调研:`docs/research/session-isolation-state.md`
- [CC vs Codex 图片处理对比](./docs/research-cc-vs-codex-image-handling.md)
- 插件系统设计:`docs/superpowers/specs/2026-05-29-plugin-cc-codex-compat-design.md`、`2026-05-29-plugin-remote-install-design.md`
