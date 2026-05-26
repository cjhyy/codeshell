# Core Stabilization — Calibrated Iteration Plan

> **Goal:** 把 `@cjhyy/code-shell-core` 稳定到可以被 TUI、Desktop、后续业务方共同依赖的程度。业务接入前先收敛安全边界、cwd/权限一致性、运行时共享资源、协议通知闭环和工程门禁。

**Date:** 2026-05-26  
**Status:** Approved for implementation (Phase A starts next)  
**Overall standard:** [`docs/architecture/16-core-overall-design-standard.md`](../../architecture/16-core-overall-design-standard.md) — Gate 0/1/4 ⇔ Phase A; Gate 2/3 ⇔ Phase B.  
**Inputs:**
- External review (private; summary captured in the Verdict table below)
- Current repo inventory: [`docs/architecture/15-current-review-and-bug-inventory.md`](../../architecture/15-current-review-and-bug-inventory.md)
- Current roadmap: [`docs/roadmap.md`](../../roadmap.md)
- Fact-check pass on 2026-05-26 — evidence file:line citations are inline in the Verdict table.

---

## Verdict on External Suggestions

整体判断：建议的大方向是对的，但其中几条已经被当前 repo 状态部分覆盖，不能原样照搬。真正影响 core 对外稳定的优先级应该从“功能补齐”前移到“安全边界和行为一致性”。

| External item | Verdict | Calibrated action |
|---|---|---|
| P0.1 Bash 接入 sandbox backend | **部分过期。** `Bash` 已经通过 `ToolContext.sandbox` 调 backend 包装命令；问题不是“没接入”，而是显式 sandbox 配置失败会降级到 `off`，且每 turn resolve 一次。 | 保留为 P0，但改成：显式 sandbox mode fail-closed、backend per Engine/Runtime 缓存、补平台测试。 |
| P0.2 Bash safe-read 元字符绕过 | **正确。** `PermissionClassifier.classifyBashCommand()` (`permission.ts:389-408`) 用 regex 而非简单前缀，但**不做 shell tokenization**——对 `;`、`&&`、`||`、反引号、`$()`、重定向 `>`、危险管道 `\| sh` 等元字符没有降级；`acceptEdits` fallback (`permission.ts:531`) 会对所有工具返回 `allow`。 | P0。加 shell metacharacter guard、`acceptEdits` 改 allowlist、补权限回归测试。 |
| P0.3 WebFetch redirect SSRF | **正确。** `web-fetch.ts:70` 只在首次请求前校验 hostname；`web-fetch.ts:84-92` 仍是 `redirect: "follow"`，redirect 后的 host 不会被重新校验，也没有 DNS 解析后的私网 IP 判断。 | P0。改手动 redirect loop，逐跳 URL + DNS IP 校验，max redirects=5。 |
| P0.4 cwd 贯穿子进程 | **正确。** `Bash` 已用 `ctx.cwd`；`ApplyPatch` (`apply-patch/index.ts:78`)、`Glob` (`glob.ts:29`)、`Grep` (`grep.ts:60`)、`REPL` (`repl.ts:63`)、`PowerShell` (`powershell.ts:46`)、`Skill` (`skill.ts:41`) 均直接调 `process.cwd()`，未消费 `ctx.cwd`；`Arena` 需进一步审计。 | P0。所有 builtin executor 改用 `ctx.cwd`，测试中强制 `process.cwd() !== EngineConfig.cwd`。 |
| P1.1 fuzzy edit replacer | **正确但不是首要稳定项。** `Edit` 仍 exact match；`ApplyPatch` 已存在并支持多文件/原子提交/上下文匹配。 | P2。先稳定权限与 cwd，再给 `Edit` 加 replacer chain，或把模型默认引导到 `ApplyPatch`。 |
| P1.2 sibling abort | **正确，并且范围更大。** 当前并行工具没有 batch sibling abort；更重要的是部分子进程工具未真正监听 `ctx.signal` kill 子进程。 | P1。先让 Bash/REPL/PowerShell/LSP/MCP 等长任务 honor abort，再做 batch sibling controller。 |
| P1.3 EngineRuntime 真共享 | **部分正确。** Runtime skeleton 已有，`mcpPool` 和 `costTracker` 在 `runtime.ts:23-31` 已是真字段，**不是 placeholder**；真正的问题是 `Engine`（`engine.ts:893`）仍然 lazy `new MCPManager(...)`，绕过 runtime.mcpPool。 | P1。让 Engine 消费 `runtime.mcpPool` 和 `runtime.costTracker`，避免多 session 重连和统计漂移；sandbox backend 走 runtime 缓存。 |
| P1.4 后台 sub-agent 完成通知 | **部分已实现。** TUI 已用 `notificationQueue` 自动注入；但这是进程全局队列 + TUI effect，Desktop/protocol/session 级闭环仍需确认和收敛。 | P1。把通知队列 session-scoped，并通过 protocol event + injection path 统一 TUI/Desktop。 |
| P1.5 typecheck/CI 干净门 | **正确。** repo 目前没有 `.github/workflows`，`CODESHELL.md` 明确 typecheck 不是 clean gate。 | P1。建立 no-new-errors baseline，然后收敛到 core clean gate。 |
| P2 memory / serve / observability / cost feedback | **方向正确，稳定化阶段降级。** Memory 已有 user/dream/project scope 和 dream pipeline，但缺硬上限、top-k relevance；serve/OTel 是业务接入后的扩展能力。 | P2/P3。作为 core 稳定后的增强，不阻塞第一批业务方。 |

External review missed several current-repo blockers:

- External hooks/plugins can upgrade permission decisions to `allow`.
- Plugin/shell hooks execute arbitrary shell outside Bash permission/sandbox path.
- MCP discovered tools default `isConcurrencySafe: true` despite unknown side effects.
- `lint:engine-bypass` guard still scans old `src/` path.
- `packages/core/src/index.ts` is still a broad compatibility barrel, not a stable SDK contract.

---

## Business Adoption Gate

Core 可以给其他业务方接入前，至少满足这些门槛：

- [ ] No open P0 items in this plan.
- [ ] `packages/core` public API surface documented and intentionally exported.
- [ ] Permission decisions are deterministic across CLI/TUI/Desktop/SDK paths.
- [ ] Every builtin tool resolves relative paths from `ToolContext.cwd`.
- [ ] Long-running subprocess tools stop on turn cancel / server close / timeout.
- [ ] Sandbox explicit modes fail closed; only `auto` may degrade with a visible warning.
- [ ] WebFetch cannot reach private/loopback/link-local/metadata IPs through redirects or DNS tricks.
- [ ] Multi-session protocol events are session-routed; background agent notifications do not leak across sessions.
- [ ] Core build and targeted core tests pass in CI; typecheck/lint have either a clean gate or an explicit baseline with no-new-errors enforcement.

---

## Phase A — P0 Safety and Boundary Hardening

### A1. Permission classifier hardening

**Why:** `acceptEdits` and Bash safe-read are direct authority boundaries. They must be conservative before business users rely on default modes.

**Files:**
- `packages/core/src/tool-system/permission.ts`
- `packages/core/src/tool-system/executor.ts`
- `tests/permission*.test.ts`
- `tests/hooks*.test.ts`

- [x] Add a shell metacharacter/tokenization guard before safe-read prefix matching: `;`, `&&`, `||`, backticks, `$()`, redirects, process substitution, dangerous pipes. *(done — `permission.ts:scanShellCommand`)*
- [x] Keep simple read-only commands allowed, but downgrade mixed/compound commands to `ask`. *(done — per-segment classification with `minSafety`)*
- [x] Change `acceptEdits` fallback from allow-all to a strict allowlist: read tools plus known edit tools (`Write`, `Edit`, `ApplyPatch`, `NotebookEdit`, `TodoWrite` if intentionally accepted). *(done — `permission.ts:ACCEPT_EDITS_ALLOWLIST`)*
- [x] External hooks/plugins may downgrade (`allow -> ask/deny`) but may never upgrade (`deny/ask -> allow`). No trust escape hatch — promotion to `allow` happens only through user approval. See [standard §S4](../../architecture/16-core-overall-design-standard.md#s4-security-boundaries-fail-closed). *(done — `executor.ts:clampHookDecision`)*
- [ ] Settings shell hooks and plugin command hooks must be explicitly documented as trusted code or routed through the same permission/sandbox/abort path as Bash. *(deferred to a follow-up A1.x — separate spec)*
- [x] Add regression tests for examples like `echo ok; touch x`, `git status && touch x`, `cat package.json | sh`, `cat x > y`, ``echo `curl ...` ``. *(done — `tests/permission.test.ts` + `tests/hooks-on-permission-check.test.ts` + `tests/hooks-pre-tool-deny.test.ts`)*

### A2. Sandbox fail-closed + cancellation

**Why:** Sandbox exists, but explicit misconfiguration currently degrades to `off` inside a hot turn. Also, aborting a tool race is not enough if the child process keeps running.

**Files:**
- `packages/core/src/engine/engine.ts`
- `packages/core/src/engine/runtime.ts`
- `packages/core/src/tool-system/builtin/bash.ts`
- `packages/core/src/tool-system/sandbox/*`
- `packages/core/src/tool-system/registry.ts`
- `tests/sandbox*.test.ts`
- `tests/tool-abort*.test.ts`

- [ ] Cache resolved sandbox backend on `EngineRuntime` or per Engine; do not resolve on every turn.
- [ ] `sandbox.mode === "auto"` may degrade to `off` with a warning; explicit `seatbelt` / `bwrap` / future modes must fail closed.
- [ ] Wire `ctx.signal` into Bash child process handling; abort should send `SIGTERM`, then `SIGKILL` after grace period.
- [ ] Audit REPL, PowerShell, LSP, MCP, plugin command hooks, settings shell hooks, and other subprocess/network tools for the same abort semantics.
- [ ] Add tests for timeout, user cancel, server close, and explicit sandbox mode unavailable.

### A3. WebFetch SSRF redirect guard

**Why:** Initial host filtering is not enough when redirects are followed automatically.

**Files:**
- `packages/core/src/tool-system/builtin/web-fetch.ts`
- `tests/web-fetch*.test.ts`

- [ ] Replace `redirect: "follow"` with manual redirect handling.
- [ ] Validate every redirect target protocol and hostname before following it.
- [ ] Resolve DNS and reject private/loopback/link-local/multicast/metadata ranges after resolution.
- [ ] Enforce max redirects=5.
- [ ] Block user-supplied headers that can spoof routing or credentials.

### A4. cwd consistency across all tools

**Why:** Desktop, managed runs, worktrees, and sub-agents all depend on tool execution happening in the Engine cwd, not the host process cwd.

**Files:**
- `packages/core/src/tool-system/builtin/{apply-patch,glob,grep,config,skill,repl,powershell,arena,worktree}.ts`
- `packages/core/src/tool-system/registry.ts`
- `tests/tool-cwd*.test.ts`

- [ ] Make builtin executors use `ctx?.cwd` directly; remove `__cwd` hidden arg paths where possible.
- [ ] For tools with a `path` input, interpret relative paths against `ctx.cwd`.
- [ ] Run cwd tests with `process.chdir(tempA)` and `EngineConfig.cwd=tempB`.
- [ ] Ensure `ApplyPatch` resolves patch paths against `ctx.cwd`.

### A5. CI guard correctness

**Why:** If architectural guardrails are false positives, business-facing stability will drift silently.

**Files:**
- `scripts/check-no-engine-bypass.sh`
- `tests/engine-bypass-guard.test.ts`
- `.github/workflows/*`

- [x] Update engine-bypass guard to scan `packages/core/src`, `packages/tui/src`, and desktop main/preload paths with a package-aware allowlist. *(done — `scripts/check-no-engine-bypass.sh:32-34` already scans the monorepo paths.)*
- [ ] Add/repair tests proving the guard fails on a forbidden `new Engine()` call outside approved sites.
- [ ] Add initial GitHub Actions workflow for install, targeted tests, build, lint guard. (Same workflow closes [Gate 4](../../architecture/16-core-overall-design-standard.md#gate-4-verification-gate).)

---

## Phase B — P1 Runtime and Protocol Stabilization

### B1. EngineRuntime real shared pools

**Files:**
- `packages/core/src/engine/runtime.ts`
- `packages/core/src/engine/engine.ts`
- `packages/core/src/tool-system/mcp-manager.ts`
- `packages/core/src/engine/model-facade.ts`
- `packages/core/src/cli/agent-server-stdio.ts`
- `packages/tui/src/cli/commands/{repl,run}.ts`

- [ ] Make `Engine` use `runtime.mcpPool` instead of lazy-creating `new MCPManager`.
- [ ] Define MCP connection ownership and cleanup at worker/session boundaries.
- [ ] Default discovered MCP tools to `isConcurrencySafe: false` unless metadata proves read-only/concurrency-safe.
- [ ] Thread `runtime.costTracker` or `config.costStore` through one canonical usage-recording path.
- [ ] Persist per-session cost state without losing aggregate process totals.

### B2. Background agent notification as protocol feature

**Files:**
- `packages/core/src/tool-system/builtin/agent-notifications.ts`
- `packages/core/src/tool-system/builtin/agent.ts`
- `packages/core/src/protocol/chat-session.ts`
- `packages/core/src/protocol/server.ts`
- `packages/tui/src/ui/App.tsx`
- `packages/desktop/src/*`

- [ ] Move notification queue from process-global to session-scoped ownership.
- [ ] Deliver completion notifications through the protocol layer with `sessionId`.
- [ ] Support both paths: user-visible stream marker and LLM-visible injected turn.
- [ ] Verify TUI and Desktop both deliver background agent results without polling.

### B3. Public core API contract

**Files:**
- `packages/core/src/index.ts`
- `packages/core/README.md`
- `packages/core/package.json`
- `docs/architecture/*`

- [ ] Split stable exports from compatibility/internal exports.
- [ ] Document supported construction paths: `Engine`, `AgentServer`, `AgentClient`, `ChatSessionManager`, transports, custom tools, hooks.
- [ ] Mark internal APIs explicitly or move them behind `internal/*` exports.
- [ ] Add a small SDK smoke test that imports from package entrypoints only.

### B4. Typecheck/lint gate

**Files:**
- `CODESHELL.md`
- `package.json`
- `packages/*/package.json`
- `.github/workflows/*`

- [ ] Capture current typecheck/lint baseline.
- [ ] Enforce no-new-errors for touched packages.
- [ ] Drive `packages/core` to clean `tsc --noEmit`.
- [ ] Then promote `bun run typecheck` and `bun run lint` into blocking CI.

---

## Phase C — P2 Developer Ergonomics and Scale

### C1. Edit reliability

- [ ] Keep `ApplyPatch` as the preferred multi-file edit tool.
- [ ] Add an `Edit` replacer chain for common whitespace/indent/context mismatch cases.
- [ ] Preserve uniqueness guarantees; ambiguous fuzzy matches must fail.

### C2. Memory relevance and caps

- [ ] Add `MEMORY.md` hard limits: max lines and max bytes.
- [ ] Inject top-k relevant memories instead of dumping every indexed memory.
- [ ] Keep user/dream/project scopes explicit in prompts and tools.

### C3. Observability

- [ ] Add standard spans around `Engine.run`, model calls, tool calls, MCP calls, and compaction.
- [ ] Keep the local log/session-recorder path working without an OTLP collector.
- [ ] Make OTLP export optional and off by default.

### C4. Cost/context feedback

- [ ] Surface current `tokenUsage / contextWindow` to the model as a compact system reminder near thresholds.
- [ ] Trigger stronger reminders around 80% and emergency compaction around 95%.
- [ ] Keep UI context bar and model-facing reminders sourced from the same accounting.

### C5. Serve mode

- [ ] Add `codeshell serve --port <n>` only after the core protocol/session layer is stable.
- [ ] Prefer a real transport implementation over duplicating protocol handling.
- [ ] Treat auth and workspace boundary as part of the feature, not a follow-up.

---

## Suggested Implementation Order

1. A1 permission classifier + `acceptEdits` allowlist + hook trust boundary.
2. A3 WebFetch SSRF guard.
3. A4 cwd consistency.
4. A2 sandbox fail-closed + subprocess abort.
5. A5 guard/CI correctness.
6. B1 Runtime shared MCP/cost/sandbox resources.
7. B2 session-scoped background agent notifications.
8. B3 public core API contract.
9. B4 typecheck/lint gate.
10. Phase C improvements.

This order makes the core safer first, then makes it predictable under multiple hosts, then makes it pleasant to use.
