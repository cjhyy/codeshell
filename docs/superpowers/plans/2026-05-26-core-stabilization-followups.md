# Core Stabilization · Follow-ups After 13-Commit Sweep

> **Date:** 2026-05-26
> **Status:** Open issues, ready for CC to pick up
> **Prerequisite:** [`2026-05-26-core-stabilization.md`](./2026-05-26-core-stabilization.md) A1-A5 + B1-B4 完成（13 commit 已落）
> **Goal:** 闭合 Business Adoption Gate 剩余三项，让 core v1 可挂"对外稳定"标签

## TL;DR

13 commit 已经把 Phase A 全部 + Phase B 主路径完成。但 [Adoption Gate](./2026-05-26-core-stabilization.md#business-adoption-gate) 还差 **3 件事**才能全勾上：

| # | 项 | 当前状态 | 严重度 | 工作量 |
|---|----|---------|-------|-------|
| 1 | **A6 · SafeSpawn 统一封装** | plan 中标 "deferred to follow-up A1.x" | **P0**（review 抓到的真漏洞，不该是 follow-up） | 3-4 天 |
| 2 | **B2.2 · 通知走 protocol event** | plan 中标 "deferred" | **P1**（Adoption Gate 明文要求） | 3-5 天 |
| 3 | **B1.x · MCP discovered tool 默认 unsafe** | plan 中标 "deferred — not blocking" | **P1**（review 抓到，1 行改动） | 0.5 天 |

总计约 **1-2 周**。

---

## A6. SafeSpawn — 让所有子进程 spawn 走统一权限/沙箱/abort 路径

### 为什么

[A1 plan](./2026-05-26-core-stabilization.md#a1-permission-classifier-hardening) 第 5 个 checkbox 标了：
> [ ] Settings shell hooks and plugin command hooks must be explicitly documented as trusted code or routed through the same permission/sandbox/abort path as Bash. *(deferred to a follow-up A1.x — separate spec)*

**这条不该 defer。** External review 明文标为真 P0：

> Plugin/shell hooks execute arbitrary shell outside Bash permission/sandbox path.

具体问题：
- `packages/core/src/plugins/pluginCommandHook.ts` 自己 spawn 子进程
- `packages/core/src/plugins/gitOps.ts` 自己 spawn git
- Settings 里的 shell hook (`utils/hooks/execPromptHook` 类似机制) 自己跑 shell
- 任何 plugin 自带的 spawn 调用

这些路径都**绕开** Bash 工具的：
1. `PermissionClassifier.classify` 权限决策
2. Sandbox backend 包装（A2 做的 seatbelt/bwrap）
3. `ctx.signal` 监听（A2 做的 SIGTERM→2s→SIGKILL）
4. 输出 byte cap（codex `exec.rs:68` 有，codeshell 还没有）
5. IO drain grace（codex `exec.rs:74-81` 有，codeshell 还没有）

**净效果**：A1-A2 把 Bash 路径锁得死死的，但一个写得不严的 plugin = 整个 codeshell 沙箱失效。

### 怎么做

**核心思路**：抽一个 `SafeSpawn(cmd, args, opts, ctx)` 中央封装；所有 spawn 点必经此处。

**新文件**：`packages/core/src/runtime/safe-spawn.ts`

```ts
export interface SafeSpawnOptions {
  cwd?: string;             // 默认 ctx.cwd
  env?: Record<string, string>;
  timeoutMs?: number;       // 默认从 ToolDef.timeoutMs 取
  maxOutputBytes?: number;  // 默认 1 MB (对照 codex EXEC_OUTPUT_MAX_BYTES)
  ioDrainGraceMs?: number;  // 默认 100ms (对照 codex IO_DRAIN_TIMEOUT_MS)
  sandboxOverride?: SandboxMode; // 默认从 ctx 取
  permissionToolName: string; // 必填，走 PermissionClassifier 时用的工具名
}

export async function safeSpawn(
  cmd: string,
  args: string[],
  opts: SafeSpawnOptions,
  ctx: ToolContext
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  // 1. classify via PermissionClassifier (复用 A1 的 scanShellCommand)
  const decision = await ctx.permission.classify(opts.permissionToolName, { command: `${cmd} ${args.join(" ")}` });
  if (decision === "deny") throw new SpawnDeniedError(cmd);
  if (decision === "ask") await ctx.permission.requestApproval(...);

  // 2. wrap with sandbox backend (复用 A2 的 runtime.resolveSandbox)
  const sandbox = await ctx.runtime.resolveSandbox(opts.sandboxOverride ?? ctx.sandboxConfig, opts.cwd ?? ctx.cwd);
  const wrapped = sandbox.wrap(cmd, args);

  // 3. spawn with ctx.signal listener (复用 A2 的 SIGTERM→2s→SIGKILL pattern)
  const child = spawn(wrapped.cmd, wrapped.args, { cwd, env, signal: undefined });

  // 4. abort cascade
  const onAbort = () => {
    try { child.kill("SIGTERM"); } catch {}
    setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, opts.ioDrainGraceMs ?? 100);
    setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2000).unref();
  };
  if (ctx.signal?.aborted) { child.kill("SIGKILL"); throw new AbortError(); }
  ctx.signal?.addEventListener("abort", onAbort, { once: true });

  // 5. IO drain with byte cap
  // (cap stdout + stderr 各自到 opts.maxOutputBytes; 超了截断 + 标记 truncated)

  // 6. timeout handling (复用现有 Bash 逻辑)

  // 7. cleanup listener on close
  child.on("close", () => ctx.signal?.removeEventListener("abort", onAbort));

  return { stdout, stderr, code };
}
```

**改造点**：

| 现状 | 改成 |
|------|------|
| `packages/core/src/tool-system/builtin/bash.ts` 自己写 spawn 链路 | 调 `safeSpawn(...)` |
| `packages/core/src/tool-system/builtin/repl.ts` 自己写 spawn 链路 | 调 `safeSpawn(...)` |
| `packages/core/src/tool-system/builtin/powershell.ts` 自己写 spawn 链路 | 调 `safeSpawn(...)` |
| `packages/core/src/plugins/pluginCommandHook.ts` 自己 spawn | 调 `safeSpawn(..., { permissionToolName: "PluginHook" })` |
| `packages/core/src/plugins/gitOps.ts` 自己 spawn git | 调 `safeSpawn(..., { permissionToolName: "GitOps" })` |
| Settings shell hook spawn | 调 `safeSpawn(..., { permissionToolName: "SettingsHook" })` |
| LSP `child_process.spawn` (`lsp/client.ts:41`) | **不变**（LSP server 是长连接服务，不是 fire-and-forget 命令）但加个 ctx.signal abort 监听 |

### 验收标准

- [ ] `packages/core/src/runtime/safe-spawn.ts` 新文件 + JSDoc
- [ ] Bash / REPL / PowerShell 全改走 safeSpawn（不再有重复的 SIGTERM/SIGKILL 代码）
- [ ] `pluginCommandHook` / `gitOps` / settings shell hook 走 safeSpawn
- [ ] `tests/safe-spawn.test.ts` 覆盖：
  - permission deny → throws
  - signal abort → SIGTERM 后 SIGKILL（含 IO drain grace 100ms 测试）
  - timeout → 同上
  - stdout/stderr 超 maxOutputBytes → 截断 + flag
  - sandbox 显式模式不可用 → throw（对接 A2 fail-closed）
- [ ] CI 加入 `tests/safe-spawn.test.ts` 到 gate test suite
- [ ] 文档：`docs/architecture/16-core-overall-design-standard.md` 更新 §S4 Security Boundaries，明确「所有 subprocess spawn 必经 safeSpawn」

### 对照 codex

- **IO drain grace**: codex `codex-rs/core/src/exec.rs:81` `IO_DRAIN_TIMEOUT_MS = 100` —— 抄
- **Output cap**: codex `codex-rs/core/src/exec.rs:68` `EXEC_OUTPUT_MAX_BYTES` —— 抄
- **统一封装**: codex 通过 `exec.rs` 中央，codeshell 通过 safeSpawn —— 等价模式

---

## B2.2 · 后台 agent 完成通知走 protocol event

### 为什么

[B2 plan](./2026-05-26-core-stabilization.md#b2-background-agent-notification-as-protocol-feature) 完成了第 1 项（session-scoped bucket），后 3 项明确 deferred：

> - [ ] Deliver completion notifications through the protocol layer with `sessionId`. *(deferred to B2.2)*
> - [ ] Support both paths: user-visible stream marker and LLM-visible injected turn. *(deferred to B2.2)*
> - [ ] Verify TUI and Desktop both deliver background agent results without polling. *(deferred to B2.2 — desktop has no background-agent UI yet)*

[Business Adoption Gate](./2026-05-26-core-stabilization.md#business-adoption-gate) 明文要求：

> - [ ] Multi-session protocol events are session-routed; background agent notifications do not leak across sessions.

当前实现只让 TUI 在内存 bucket 里读，**Desktop / SDK / 远程 host 全收不到**——后台 agent 完成了，业务方只能轮询。**这与 codex / cc 工具 prompt 里"do NOT poll"的指令自相矛盾**。

### 怎么做

**新增 protocol event**：`BackgroundAgentCompleted`

```ts
// packages/core/src/protocol/types.ts
export interface BackgroundAgentCompletedEvent {
  type: "background_agent_completed";
  sessionId: string;
  agentId: string;
  status: "ok" | "error" | "cancelled";
  result?: string;     // 最终文本 (status === "ok")
  error?: string;      // 错误信息 (status === "error")
  usage?: TokenUsage;
  durationMs: number;
}

// 加入 StreamEvent union
export type StreamEvent =
  | { type: "text_delta"; ... }
  | { type: "tool_use_start"; ... }
  | { type: "tool_result"; ... }
  | BackgroundAgentCompletedEvent;  // 新增
```

**发送路径**：

```
asyncAgentRegistry 检测到 agent 完成
  └─→ enqueue(item, sessionId)  // B2 已有
  └─→ 同时 AgentServer.notify(sessionId, BackgroundAgentCompletedEvent)  // 新增
      └─→ Transport emit notification
          └─→ AgentClient 上每个 sessionId-aware listener 收到
              ├─→ TUI: 渲染弹窗 + 注入 user message 到下一轮
              ├─→ Desktop: tray 通知 + 注入下一轮
              └─→ SDK: Promise resolve / callback fire
```

**改造点**：

| 文件 | 改什么 |
|------|--------|
| `packages/core/src/protocol/types.ts` | 加 `BackgroundAgentCompletedEvent` 到 StreamEvent union |
| `packages/core/src/tool-system/builtin/agent-notifications.ts` | enqueue 时同时调 `runtime.protocolBus.publish(sessionId, event)` |
| `packages/core/src/protocol/server.ts` | AgentServer 暴露 `subscribe(sessionId, listener)` 方法（如果还没有） |
| `packages/core/src/protocol/client.ts` | AgentClient 增加 `onBackgroundAgentCompleted(handler)` |
| `packages/tui/src/ui/App.tsx` | 改为订阅 protocol event 而不是直接读队列 bucket（保留过渡期 fallback） |
| `packages/desktop/src/...` | 新增 listener，触发 tray notification |

### 验收标准

- [ ] 新 StreamEvent 类型 + JSDoc
- [ ] `agent-notifications.ts` 同时 publish 到 protocol bus
- [ ] AgentClient 暴露订阅接口
- [ ] TUI 改为 protocol-driven（保留 LEGACY_BUCKET 兼容旧路径直到下个版本删除）
- [ ] Desktop tray 通知 demo（最小可工作）
- [ ] `tests/background-agent-protocol.test.ts` 覆盖：
  - 多 session 并发跑后台 agent，完成时各自 session 收到事件，互不串扰
  - SDK 用户用 `client.onBackgroundAgentCompleted` 收到事件
- [ ] CI 加入新测试
- [ ] 文档：API contract 更新（B3 README 加这个 StreamEvent 到 stable surface）

### 对照 codex

codex 用 `wait_agent()` 工具阻塞父，通信走 channel。codeshell 是 fork 模式（spawn 后台 → 通过 notification 通知完成），protocol event 是补完这条 path。

---

## B1.x · MCP discovered tool 默认 `isConcurrencySafe: false`

### 为什么

[B1 plan](./2026-05-26-core-stabilization.md#b1-engineruntime-real-shared-pools) 第 3 个 checkbox 标了：

> [ ] Default discovered MCP tools to `isConcurrencySafe: false` unless metadata proves read-only/concurrency-safe. *(deferred — separate cleanup, not blocking core stability.)*

External review 抓到的明确漏洞：

> MCP discovered tools default `isConcurrencySafe: true` despite unknown side effects.

**这条不该 defer。** MCP 工具来源各异、副作用未知；默认 true 意味着 codeshell **自己把"未知工具能否并发跑"的判断让给运气**。一个 MCP 工具改文件、另一个并行 grep 同一文件——结果未定义。

而且这是个 **1 行改动**，没有理由延期。

### 怎么做

**改一个地方**：`packages/core/src/tool-system/mcp-manager.ts`

```ts
// 当前 (大致):
function buildToolDef(mcpTool: McpTool): ToolDef {
  return {
    name: `mcp_${serverName}_${mcpTool.name}`,
    description: mcpTool.description,
    inputSchema: mcpTool.inputSchema,
    permissionDefault: "ask",
    isConcurrencySafe: true,  // ← 这是漏洞
    isReadOnly: false,
    execute: ...
  };
}

// 改成:
function buildToolDef(mcpTool: McpTool): ToolDef {
  // 信任 server 提供的 annotations.readOnlyHint，否则保守
  const readOnly = mcpTool.annotations?.readOnlyHint === true;
  return {
    name: `mcp_${serverName}_${mcpTool.name}`,
    description: mcpTool.description,
    inputSchema: mcpTool.inputSchema,
    permissionDefault: "ask",
    isConcurrencySafe: readOnly,  // ← 默认 false，仅 readOnlyHint=true 才 true
    isReadOnly: readOnly,
    execute: ...
  };
}
```

**MCP Spec 参考**：MCP 协议有 [`Tool.annotations`](https://modelcontextprotocol.io/docs/concepts/tools)，其中 `readOnlyHint: boolean` 是工具方声明只读的标准方式。我们只在 server **明确** declare 时才放宽并发。

### 验收标准

- [ ] `mcp-manager.ts` 改完
- [ ] `tests/mcp-default-unsafe.test.ts` 覆盖：
  - 一个 MCP server export 两个工具：一个声明 readOnlyHint，一个不声明
  - 验证 readOnlyHint 的 isConcurrencySafe=true，另一个 false
- [ ] CI 加入新测试

### 对照 codex

codex 的 `ToolRouter::from_turn_context` 每 turn 重建工具集，权限和并发判定都是 per-turn 计算的。codeshell 不上 per-turn 重建（保留启动期注册），所以"默认 false 安全"更必要。

---

## 实施顺序建议

1. **B1.x MCP 默认 unsafe**（0.5 天）—— 最小改动，立刻消除一个真漏洞，作为暖场
2. **A6 SafeSpawn**（3-4 天）—— 最大改动，要新文件 + 多处接入 + 完整测试
3. **B2.2 protocol event**（3-5 天）—— 跨 core + TUI + Desktop，最后做避免和 A6 冲突

**总 7-10 天**，闭合 Adoption Gate。

## 验收门

三项都完成后，[Business Adoption Gate](./2026-05-26-core-stabilization.md#business-adoption-gate) 9 个 checkbox 应能全勾上：

- [x] No open P0 items（A6 闭合）
- [x] packages/core public API surface documented（B3 已完成）
- [x] Permission decisions deterministic（A1 + A6）
- [x] Every builtin tool resolves relative paths from ToolContext.cwd（A4 已完成）
- [x] Long-running subprocess tools stop on turn cancel / server close / timeout（A2 + A6）
- [x] Sandbox explicit modes fail closed（A2 已完成）
- [x] WebFetch cannot reach private IPs（A3 已完成）
- [x] Multi-session protocol events session-routed; background notifications not leaking（B2.2 闭合）
- [x] Core build + targeted tests pass in CI（A5 + B4 已完成）

完成后可考虑挂 `@cjhyy/code-shell-core@0.6.0` 或类似 "stable v1" tag，开始接受业务方接入反馈。

## 不在本次范围

以下 plan 中明确为 P2/P3 的，**不在本次 follow-up 范围**，等业务方接入后按真实需求驱动：

- C1 Edit replacer chain
- C2 Memory hard cap + top-k relevance
- C3 OTel observability
- C4 Cost feedback to model
- C5 `codeshell serve` mode（仅当业务方明确要求网页接入时）
- B1 sub-items: MCP cleanup at session boundaries / costTracker single-path（等 C 阶段一起做）
- 物理 `internal/*` 子路径拆分（contract 已稳定，文件布局微调可慢慢做）

## 来源

- 来自 [`/Users/admin/Documents/个人学习/core内核/`](file:///Users/admin/Documents/个人学习/core内核/) 的外部对比分析（codex 源码精读 + codeshell 现状评估）
- 与 repo 内 [Core Stabilization Plan](./2026-05-26-core-stabilization.md) 校准过的真实状态
- HTML 可视化：[`docs/core-architecture-demo.html`](../../core-architecture-demo.html)（一次请求走完整个 core 的逐步演示）
