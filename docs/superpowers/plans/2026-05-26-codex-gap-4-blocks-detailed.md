# 四块 codex 借鉴点 · 详细增强清单

> **Date:** 2026-05-26 (post-followups)
> **Status:** 当前状态 + 剩余 corner cases 的精确清单
> **Prerequisites:**
> - [13-commit core stabilization](./2026-05-26-core-stabilization.md) ✅
> - [3 followups (A6 / B2.2 / B1.x)](./2026-05-26-core-stabilization-followups.md) ✅
>
> **背景**：外部 codex vs codeshell 源码对比里识别出 4 大块借鉴点（Sandbox / Subprocess / MCP / Multi-Agent 通知）。截至本文件写作时，**主体路径 3 块已经做完**，但每一块都还有**真实存在的 corner case**。本文不是替换前述 plan，是把每一块的"已做 + 还缺"列到精确 file:line 级。

## TL;DR · 4 块当前状态

| 块 | 主体 | 测试 | 剩余 corner | 严重度 |
|----|------|-----|-----------|-------|
| **块 1: Sandbox fail-closed** | ✅ A2 (`7d5c3c1`) | `tests/sandbox.test.ts` ✅ | 显式模式 fail-closed 路径未单元测试细化；`auto` 降级 warning 静默 | P2 |
| **块 2: Subprocess 三件套** | ✅ A6 (`8645b04`) — SafeSpawn 落地 | `tests/safe-spawn.test.ts` ✅ | **3 个 spawn 点还没接 SafeSpawn**：pluginCommandHook / lsp.client / updater | **P1**（真漏洞） |
| **块 3: MCP 默认 unsafe** | ✅ B1.x (`1ced4eb`) | `tests/mcp-default-unsafe.test.ts` ✅ | MCP 连接 cleanup at session boundaries 仍 deferred | P2 |
| **块 4: Multi-Agent 通知 protocol event** | ✅ B2.2 (`bd812db`) | `tests/background-agent-protocol.test.ts` ✅ | Desktop tray notification 没接；过渡期 legacy bucket 还没拆 | P2 |

**核心结论**：4 块的主路径全部合上了，**剩 1 个 P1（3 个 spawn 点漏接 SafeSpawn）+ 3 个 P2**。CC 可以按下面优先级补完。

---

## 块 1 · Sandbox fail-closed

### 已完成（A2 commit `7d5c3c1`）

| 项 | 实现 | 文件 |
|----|------|-----|
| `EngineRuntime.resolveSandbox` 按 (mode, cwd) 缓存 | ✅ | `engine/runtime.ts:54` |
| 显式 `seatbelt` / `bwrap` 不可用 → throw（不再静默 catch） | ✅ | `engine.ts:625` 删了 try/catch |
| `auto` 模式可降级到 off + warning | ✅ | `resolveSandboxBackend` 内部分支 |
| Bash 走 SIGTERM → 2s → SIGKILL | ✅ | `bash.ts:131-162` |
| REPL / PowerShell 从 `execSync` 改为 `spawn` + 完整 abort 链 | ✅ | `repl.ts` / `powershell.ts` |
| 测试覆盖：用户取消 / 预 abort signal / 显式模式不可用 | ✅ | `tests/abort-subprocess.test.ts` + `tests/sandbox.test.ts` |

### 还缺的 corner cases

**1.1 显式模式 fail-closed 的错误信息不够明确**

现状：`resolveSandboxBackend` 在显式模式不可用时 throw，但错误对象类型未必让 host 区分得开"sandbox 不可用"和"普通工具 error"。CC 接手时检查：

- [ ] `resolveSandboxBackend` 在显式模式失败时 throw 的应该是带类型的 `SandboxUnavailableError`（继承 `FrameworkError`），不是 plain `Error`
- [ ] `Engine.run()` 捕获此错误后应当返回 `EngineResult { reason: "sandbox_unavailable" }`，让 TUI / Desktop 能给用户准确提示
- [ ] 加 1 个 test：构造 `sandbox.mode = "seatbelt"` 在 Linux 上跑，验证 throw 的是 SandboxUnavailableError + Engine.run 返回 reason

**1.2 `auto` 降级时的 warning 当前只 console.warn，没走 protocol**

- [ ] 应该通过 `BackgroundAgentCompletedEvent` 同类机制发一个 `SandboxDegradedNotice` StreamEvent，让 Desktop / SDK 也知道
- [ ] 否则 Electron 主进程降级了，renderer 完全不知情

**1.3 LSP / MCP 子进程不在 sandbox 内**

- 现状：LSP 用 `lsp/client.ts:41` 直接 spawn，**不走 sandbox**。理由说得过去（LSP server 是长连接服务，沙箱化会限制 fs 访问导致补全等失效），但**没有显式文档说明**
- [ ] `docs/architecture/16-core-overall-design-standard.md` §S4 应加一段："LSP/MCP 服务子进程刻意不在 sandbox 内，因为...；trust boundary 在 server binary 的安装时校验"
- 严重度低 —— 这是设计决定不是漏洞

**1.4 文档：Sandbox 三 backend 各自支持的平台 + 测试矩阵**

- [ ] CC 应该写一份 `docs/architecture/sandbox-matrix.md`：macOS / Linux / Windows × seatbelt / bwrap / off 各种组合下的行为
- [ ] CI 当前只在 ubuntu-latest 跑，macOS-specific seatbelt 路径未被持续验证

---

## 块 2 · Subprocess 三件套（IO drain + byte cap + 统一封装）⚠️

### 已完成（A6 commit `8645b04`）

SafeSpawn 主体在 `packages/core/src/runtime/safe-spawn.ts:1-303`，注释明确写了 6 条职责：

| 项 | 实现 | 对照 codex |
|----|------|----------|
| Sandbox wrap | `SandboxBackend` 包装 | codex `exec.rs` sandbox 层 |
| **UTF-8 IO drain** | `StringDecoder` 避免多字节序列跨 `data` 事件截断 | codex `IO_DRAIN_TIMEOUT_MS=100ms` 等价语义 |
| **每流 byte cap** | `DEFAULT_MAX_OUTPUT_BYTES` + `truncated` flag | codex `EXEC_OUTPUT_MAX_BYTES` |
| `ctx.signal` cascade | SIGTERM → `ioDrainGraceMs`（100ms 默认）→ SIGKILL | codex `or_cancel + 100ms grace + handle.abort()` |
| Hard timeout | SIGTERM → 2s → SIGKILL | codex 同 |
| Listener cleanup | every exit path 都 cleanup，防 MaxListeners 累积 | codex `AbortOnDropHandle` 等价 |

**两个 entry**：
- `safeSpawn(file, args, opts)` —— 直接 argv，给 REPL / PowerShell / gitOps
- `safeSpawnShell(command, opts)` —— 走 shell + sandbox，给 Bash

**已接 SafeSpawn 的 spawn 点**：

| 文件 | 接了？ |
|------|------|
| `bash.ts:118` | ✅ via `safeSpawnShell` |
| `repl.ts:73` | ✅ via `safeSpawn` |
| `powershell.ts:54` | ✅ via `safeSpawn` |
| `plugins/gitOps.ts:18` | ✅ via `safeSpawn` |

**测试覆盖**：`tests/safe-spawn.test.ts` ✅

### 还缺的 corner cases ⚠️ **核心 P1**

`grep -rn "spawn(" packages/core/src` 还有 **3 个 spawn 点没接 SafeSpawn**：

**2.1 `pluginCommandHook.ts:106` 仍直接 `spawn(spec.command, ...)`** ⚠️

```ts
// packages/core/src/plugins/pluginCommandHook.ts:34-117 (当前实现)
import { spawn } from "node:child_process";
...
child = spawn(spec.command, [], { ... });
```

**这是 review 抓到的真 P0 的原始本意所在**——A6 已经把 SafeSpawn 准备好了，但 pluginCommandHook 没改造接入。

- [ ] **接 SafeSpawn**：`pluginCommandHook.ts` 改成调 `safeSpawn(shell, ['-c', spec.command], opts)` 或 `safeSpawnShell(spec.command, opts)`
- [ ] 既得益处：IO drain + byte cap + signal cascade + listener cleanup 全部继承
- [ ] **关键决定**：plugin 命令是否过 PermissionClassifier？
  - 安全派：插件 hook 不是用户写的代码 → 应该过权限链，类似 LLM 的 tool_call
  - 务实派：插件是用户**显式装的**，安装时已审批 → 跳过运行时权限（参考 SafeSpawn header doc "Install/marketplace paths are consented at install time"）
  - **建议**：仿 gitOps 的模式（已经接了 SafeSpawn 但不过 PermissionClassifier），plugin hook 同上 —— 安装时一次审批，运行时只走 sandbox/abort/cap 三件
- [ ] 加 test：plugin hook 命令在 abort 时正确 SIGTERM；超过 byte cap 时正确 truncate
- 工作量：1-2 天

**2.2 `lsp/client.ts:41` 仍直接 `spawn(this.command, this.args, ...)`** 

```ts
// packages/core/src/lsp/client.ts:5
import { spawn, type ChildProcess } from "node:child_process";
this.process = spawn(this.command, this.args, { ... });
```

**这是 LSP server 子进程**——长连接，不是 fire-and-forget。能接 SafeSpawn 吗？

- LSP server 是常驻进程，**没有 hard timeout 概念**（设 0 / Infinity 即可）
- IO drain / byte cap 对长连接也有用（防 stdout 缓存爆）
- abort signal 监听必须有 —— Engine 关闭时要 kill LSP server
- [ ] **接 SafeSpawn**：传 `timeoutMs: Infinity` + 较大的 `maxOutputBytes`（LSP 输出量大）+ 必须传 `ctx.signal`
- [ ] 但 SafeSpawn 当前 API 要求 `timeoutMs` 必填、`cwd` 必填——可能需要小幅扩展 SafeSpawnOptions 让 LSP 这种长连接也能用
- [ ] 替代方案：保持 LSP 独立 spawn，但**抽出 abort cascade + listener cleanup** 复用 SafeSpawn 的工具函数
- 工作量：2 天（含 SafeSpawn API 扩展或重构）

**2.3 `updater.ts:351` 自更新跑 `spawn("sh", ["-c", cmd], ...)`**

```ts
// packages/core/src/updater.ts:28
import { execFile, spawn } from "node:child_process";
const child = spawn("sh", ["-c", cmd], { ... });
```

- 自更新场景，运行时机不固定（启动时 / 定时检查）
- 建议：接 SafeSpawn，主要为 byte cap + listener cleanup
- 工作量：0.5 天

**2.4 `utils/execFileNoThrow.ts:36` 是另一个 spawn 入口**

- 多个 builtin 工具用它（`grep.ts:5` 直接 import `execFile`）
- 当前 execFileNoThrow 没 IO drain / byte cap
- [ ] 评估：execFileNoThrow 内部改用 SafeSpawn？还是保留为独立轻量工具（用于已知可控命令 like `git --version`）
- [ ] 至少加个 byte cap 防 grep 输出过大撑爆内存
- 工作量：1 天

**2.5 `lsp/manager.ts:126` 用 `execSync("which command...")` 探测**

- 同步阻塞调用，不该走 SafeSpawn
- 但有 `timeout: 2000` 防卡住 —— OK
- 严重度：低，可以放着

**2.6 文档：标注哪些 spawn 点**故意**不接 SafeSpawn**

- [ ] safe-spawn.ts 注释里列清单（"以下 spawn 点刻意不走 SafeSpawn：utils/env.ts uname / lsp/manager.ts which / utils/execFileNoThrow 已知工具命令"），防 future PR 误回归

### 块 2 总评

主路径 ✅，但**剩 3 个 spawn 点（pluginCommandHook / lsp.client / updater）没接 SafeSpawn**——这跟我们最早讨论的 "A6 把所有插件 hook 拉回权限链" 还没完全到位。**P1**，约 3-4 天全部接完。

---

## 块 3 · MCP discovered tool 默认 unsafe

### 已完成（B1.x commit `1ced4eb`）

```ts
// packages/core/src/tool-system/mcp-manager.ts (B1.x 之后)
// MCP tools honor annotations.readOnlyHint
const readOnly = mcpTool.annotations?.readOnlyHint === true;
return {
  ...
  isConcurrencySafe: readOnly,   // 默认 false, 仅 readOnlyHint=true 才 true
  isReadOnly: readOnly,
};
```

**测试覆盖**：`tests/mcp-default-unsafe.test.ts` ✅

### 还缺的 corner cases

**3.1 MCP 连接 cleanup at session boundaries 仍 deferred**

[B1 plan §B1](./2026-05-26-core-stabilization.md#b1-engineruntime-real-shared-pools) 第 2 个 checkbox：
> [ ] Define MCP connection ownership and cleanup at worker/session boundaries. *(deferred — needs runtime close semantics)*

现状：MCPManager 是 `runtime.mcpPool` 单例共享，**连接在第一次用时建立，从来不主动关**。对单进程 TUI / 单 Electron 主进程都 OK（进程退出时连接也死）。但：

- 长跑 server 模式（业务方 SDK 起 fastify 跑很久）：MCP 连接会越积越多
- session 显式 close 时也不释放
- [ ] 加 `runtime.close()` 时遍历 mcpPool.connections 调 `client.close()`
- [ ] 加 `chatSessionManager.delete(sid)` 时引用计数，最后一个 session 释放 MCP 连接（或保留单例直到 runtime close —— 设计决定，更倾向后者）
- 工作量：2-3 天

**3.2 MCP 工具元数据声明 `annotations.destructiveHint`、`annotations.idempotentHint` 等其他 hint 未利用**

- [MCP spec 1.0.0](https://modelcontextprotocol.io/docs/concepts/tools) 还有 `destructiveHint` / `idempotentHint` / `openWorldHint` —— 当前只用了 `readOnlyHint`
- [ ] 评估：`destructiveHint: true` 的工具是否要把 `permissionDefault` 设为 `"ask"`？
- [ ] `idempotentHint` 影响 retry policy
- 严重度：低 —— hint 都是 hint，不是强约束
- 工作量：1 天

**3.3 MCP server 失联时的重连策略**

- 当前 `mcp-manager.ts:60-129` 单例，连接断了不自动重连
- 业务方业务方场景：网络抖动后 MCP server 接不回来 → tool_call 抛错 → session 死掉
- [ ] 加指数退避 + 上限 3 次的自动重连
- [ ] 在 retry 期间收到的 tool_call 应该排队等连接恢复
- 工作量：2 天

**3.4 codeshell 自己暴露为 MCP server（codex 是双向，codeshell 是单向）**

- [前期对比文档](../../../../core内核/docs/comparison/codex-vs-codeshell.md#10-mcp) 明确这是不该跟的项 —— codex 暴露自己为 MCP 是为让其他 agent 接它，codeshell 没这场景
- **不在本 plan 范围**，列出来仅作记录

### 块 3 总评

主路径 ✅（默认 unsafe + readOnlyHint 接入），**剩 3 个 P2**：连接 cleanup、其他 annotations、重连策略。**任何一个都不阻塞 v1**。

---

## 块 4 · Multi-Agent 完成通知走 protocol event

### 已完成（B2.2 commit `bd812db`）

| 项 | 实现 |
|----|------|
| `BackgroundAgentCompletedEvent` 加入 StreamEvent union | ✅ `types.ts` |
| `notificationQueue.enqueue` 同时 publish 到 `agentNotificationBus` | ✅ `agent-notifications.ts:67` |
| AgentServer 订阅 bus → 通过 protocol 发给 client | ✅ `agent-notifications.ts:123` 注释明示 |
| Session-scoped routing（不会串到别的 session） | ✅ B2 已做 + B2.2 通过 sessionId 参数透传 |
| 测试覆盖 | ✅ `tests/background-agent-protocol.test.ts` |

### 还缺的 corner cases

**4.1 Desktop tray notification 没接**

- B2.2 让事件流到 client，**但 Desktop renderer 没消费这个事件**
- 用户期望：后台 agent 完成时 macOS 弹通知 + dock 图标 badge
- [ ] `packages/desktop/src/main` 监听 `BackgroundAgentCompletedEvent` → 调用 Electron `Notification` API + dock.setBadge
- [ ] 用户点通知应该 focus 对应窗口（按 sessionId 路由）
- 工作量：1 天

**4.2 过渡期 `__legacy__` bucket 还没拆**

agent-notifications.ts:48 写明：
```
没传 sessionId 的旧路径降级到这个 bucket
```

- 当前哪些代码路径还在用 legacy？grep 一下：
  - [ ] CC 接手：搜 `notificationQueue.enqueue(item)`（没传第二参数的）—— 找出来全改成传 sessionId
  - [ ] 然后删除 LEGACY_BUCKET 兜底
  - [ ] 加 strict 校验：未传 sessionId 直接 throw（防 future regression）
- 工作量：0.5-1 天

**4.3 通知载荷是否包含 result 文本？**

- 当前 `BackgroundAgentCompletedEvent` 包含 finalText（completed 时）/ error（failed 时）
- 长 result（比如 agent 写了几千行代码）会让 StreamEvent 巨大
- [ ] 评估：是否截断到 N KB + 提供 `getArtifact(agentId)` 单独获取完整 result？
- 工作量：1-2 天（如果需要）

**4.4 SDK 业务方订阅 API 缺文档示例**

- `packages/core/README.md` "Stable surface" 里需要加 BackgroundAgentCompletedEvent 的接入示例
- 给业务方一个 "怎么订阅 + 怎么处理" 的完整代码块
- 工作量：0.5 天（纯文档）

**4.5 SendMessage 工具仍是半成品**

- [B2 plan](./2026-05-26-core-stabilization.md#b2-background-agent-notification-as-protocol-feature) 提到 SendMessage 是 codex swarm 模式的对应，但 codeshell 是 parent-child fork，没做完
- 这是设计取舍，**不必跟 codex swarm 路线**
- 列出来仅作记录

### 块 4 总评

主路径 ✅（StreamEvent 化 + session-scoped 闭环），**剩**：Desktop tray UI、legacy bucket 拆除、SDK 文档示例。任何一个都是体验/工程项，不是 P0 漏洞。

---

## 综合优先级（CC 接手时的顺序建议）

| 序 | 项 | 块 | 严重度 | 工作量 |
|----|----|---|-------|-------|
| 1 | **`pluginCommandHook` 接 SafeSpawn** | 块 2 | **P1**（最初 review 抓到的真漏洞收口） | 1-2 天 |
| 2 | `lsp/client.ts` 接 SafeSpawn（或抽 abort cascade 函数复用） | 块 2 | P1 | 2 天 |
| 3 | `updater.ts` 接 SafeSpawn | 块 2 | P2 | 0.5 天 |
| 4 | `execFileNoThrow` 加 byte cap | 块 2 | P2 | 1 天 |
| 5 | 拆除 `__legacy__` notification bucket | 块 4 | P2 | 0.5-1 天 |
| 6 | MCP 连接 cleanup at runtime close | 块 3 | P2 | 2-3 天 |
| 7 | Desktop tray notification | 块 4 | P2（体验） | 1 天 |
| 8 | Sandbox `auto` 降级走 protocol event | 块 1 | P2 | 1 天 |
| 9 | `SandboxUnavailableError` 类型化 + Engine 返回 reason | 块 1 | P2 | 1 天 |
| 10 | MCP 重连策略 | 块 3 | P2 | 2 天 |

**总计**：P1 部分（1-3）约 4-5 天，做完插件 hook 漏洞收口；P2 全部（4-10）约 1.5-2 周。

---

## 不在本 plan 范围

明确**不做**的事项（防 scope creep）：

- 暴露 codeshell 自己为 MCP server（codex 双向，codeshell 单向 — 设计取舍）
- Swarm-style peer-to-peer agent 消息（codex multi_agents v2 路线 — 不跟）
- worker_threads / 跨进程隔离不可信代码（之前讨论过）
- SQLite 索引 / session 浏览器（业务方场景再说）
- `costTracker` 单路径记账（C 阶段）
- Edit replacer chain（C1）
- Memory hard cap + top-k（C2）
- OTel observability（C3）
- `codeshell serve --port` mode（C5）

---

## 来源

- 源码现状：codeshell main 分支 13 + 3 commit 之后
- codex 对比：`/Users/admin/Documents/个人学习/core内核/docs/comparison/codex-vs-codeshell.md`
- 前置 plan：[`2026-05-26-core-stabilization.md`](./2026-05-26-core-stabilization.md) + [`2026-05-26-core-stabilization-followups.md`](./2026-05-26-core-stabilization-followups.md)
