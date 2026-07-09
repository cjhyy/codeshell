# N-06 修复技术设计：InteractiveApprovalBackend session rule cache 隔离

## 0. 范围与结论

本设计只针对已确证的 P1 安全隐患 N-06：`InteractiveApprovalBackend` 的 session allow/deny rule cache 挂在 singleton backend 实例字段上，未按 `ApprovalRequest.sessionId` 分桶，导致会话 A 的“本会话一直允许/拒绝”可能影响会话 B 的同 operation。

推荐方案：在 `InteractiveApprovalBackend` 内引入按 `sessionId` 分桶的 session state，并在 `ChatSessionManager.close(sessionId)` 清理对应 bucket。无 `sessionId` 的请求不得落入共享全局 bucket；若用户选择 session-scope remember，应按一次性审批处理或失败闭合地不记忆。

本轮只写设计，不改源码、不跑构建/测试、不 commit。

## 1. 契约陈述

应有契约：

> session 级权限规则的作用域是单个 `sessionId`。会话 A 的 session allow/deny 只应影响 A 的后续权限判定，不得让会话 B 的同 operation 免审批，也不得让会话 B 被无提示拒绝。没有可靠 `sessionId` 时，不应把“本会话记住”写入任何可被其它请求复用的共享缓存。

现有代码能支撑这个契约：

- `ApprovalScope` 明确区分 `once`、`session`、`project`；其中 `"session"` 是“remembered for the rest of the REPL session (in-memory)”，见 `packages/core/src/types.ts:348` 到 `packages/core/src/types.ts:355`。
- `ApprovalRequest` 已有 `sessionId?: string` 字段，虽然当前注释说 host 用于 prompt UI 路由，见 `packages/core/src/types.ts:339` 到 `packages/core/src/types.ts:341`；N-06 修复应把它扩展为 backend session cache 的隔离 key。
- Engine 会把解析出的 `session.state.sessionId` 写入 tool context：`packages/core/src/engine/engine.ts:1505` 到 `packages/core/src/engine/engine.ts:1511`。
- `ToolExecutor` 在 pre-hook ask 和 classifier ask 两条路径都把 `toolCtx.sessionId` 传给 `PermissionClassifier.handleAsk()`：`packages/core/src/tool-system/executor.ts:334` 到 `packages/core/src/tool-system/executor.ts:341`、`packages/core/src/tool-system/executor.ts:417` 到 `packages/core/src/tool-system/executor.ts:421`。
- `PermissionClassifier.handleAsk()` 已把 `opts.sessionId` spread 到 `approvalBackend.requestApproval()`：`packages/core/src/tool-system/permission.ts:966` 到 `packages/core/src/tool-system/permission.ts:1017`。
- 9ff46639 的同类问题修复已经采用 session 隔离范式：`ChatSession` 每 session 有自己的 `pendingApprovals` map，见 `packages/core/src/protocol/chat-session.ts:40` 到 `packages/core/src/protocol/chat-session.ts:50`；`AgentServer.handleApprove()` 在 session-tagged path 只按 `(sessionId, requestId)` 查对应 session，找不到即失败且不 fallback 到 legacy global map，见 `packages/core/src/protocol/server.ts:655` 到 `packages/core/src/protocol/server.ts:688`；测试用 B 的 `sessionId` resolve A 的 requestId 时断言 `InvalidParams` 且 A/B pending 都还在，见 `packages/core/src/protocol/server.askuser-session-isolation.test.ts:111` 到 `packages/core/src/protocol/server.askuser-session-isolation.test.ts:129`。
- 同仓库已有 session grant 的正确建模：path-policy 用 `Map<sessionId, Set<PathGrant>>`，见 `packages/core/src/tool-system/path-policy.ts:173` 到 `packages/core/src/tool-system/path-policy.ts:180`；读写都带 `sessionId`，见 `packages/core/src/tool-system/path-policy.ts:260` 到 `packages/core/src/tool-system/path-policy.ts:270`、`packages/core/src/tool-system/path-policy.ts:288` 到 `packages/core/src/tool-system/path-policy.ts:304`；close 时清理，见 `packages/core/src/protocol/chat-session-manager.ts:98` 到 `packages/core/src/protocol/chat-session-manager.ts:104`。
- 凭证工具也明确规定“无 sessionId 不共享全局桶”：`UseCredential` 在无 `ctx.sessionId` 时返回一次性 `Set`，避免跨上下文串台，见 `packages/core/src/credentials/use-credential-tool.ts:108` 到 `packages/core/src/credentials/use-credential-tool.ts:116`；`InjectCredential` 同样处理，见 `packages/core/src/credentials/inject-credential-tool.ts:65` 到 `packages/core/src/credentials/inject-credential-tool.ts:74`。

因此，N-06 的目标不是改变 project-scope 持久规则的语义，而是把 “session-scope in-memory remember” 从进程级 singleton 状态收窄到 `sessionId`。

## 2. 缺陷精确定位

### 2.1 cache 字段与当前 key 结构

缺陷类：`InteractiveApprovalBackend`，文件 `packages/core/src/tool-system/permission.ts`。

当前 session cache 是两个实例字段数组：

- `private sessionAllowRules: PermissionRule[] = []`，见 `packages/core/src/tool-system/permission.ts:142`。
- `private sessionDenyRules: PermissionRule[] = []`，见 `packages/core/src/tool-system/permission.ts:143`。

注释说明它们按 operation 缩窄：`tool + argsPattern`，不是只按 tool name，见 `packages/core/src/tool-system/permission.ts:137` 到 `packages/core/src/tool-system/permission.ts:141`。operation rule 由 `buildProjectRule()` 生成：Bash 缩窄到 head command，见 `packages/core/src/tool-system/permission.ts:351` 到 `packages/core/src/tool-system/permission.ts:365`；Write/Edit 可按 path scope 缩窄，见 `packages/core/src/tool-system/permission.ts:368` 到 `packages/core/src/tool-system/permission.ts:381`；其它工具 fallback 为 tool-wide，见 `packages/core/src/tool-system/permission.ts:386` 到 `packages/core/src/tool-system/permission.ts:390`。

问题点：这个 key 只有 operation 维度，没有 `sessionId` 维度。

### 2.2 读取点

`requestApproval(req)` 在弹 prompt 前先读 cache：

- fast path：`const cached = this.checkSessionRules(req)`，见 `packages/core/src/tool-system/permission.ts:191` 到 `packages/core/src/tool-system/permission.ts:194`。
- 串行 prompt 后二次检查：`const nowCached = this.checkSessionRules(req)`，见 `packages/core/src/tool-system/permission.ts:204` 到 `packages/core/src/tool-system/permission.ts:211`。

`checkSessionRules(req)` 的实际匹配只看 deny/allow arrays、`req.toolName`、`req.args`：

- deny 先匹配：`packages/core/src/tool-system/permission.ts:219` 到 `packages/core/src/tool-system/permission.ts:222`。
- allow 再匹配：`packages/core/src/tool-system/permission.ts:223` 到 `packages/core/src/tool-system/permission.ts:224`。

该函数没有读取 `req.sessionId`。

### 2.3 写入点

用户选择 session scope 后写入实例级数组：

- `promptAndRecord(req)` 取 prompt result：`packages/core/src/tool-system/permission.ts:230` 到 `packages/core/src/tool-system/permission.ts:235`。
- 判断 `scope === "session" && result.always`：`packages/core/src/tool-system/permission.ts:244`。
- 生成 operation rule：`packages/core/src/tool-system/permission.ts:248`。
- 按 approved/denied 选择 `this.sessionAllowRules` 或 `this.sessionDenyRules`：`packages/core/src/tool-system/permission.ts:250`。
- 去重只比较 `tool` 与 `argsPattern`：`packages/core/src/tool-system/permission.ts:251` 到 `packages/core/src/tool-system/permission.ts:255`。
- 写入 `target.push(...)`：`packages/core/src/tool-system/permission.ts:256` 到 `packages/core/src/tool-system/permission.ts:258`。

project scope approve 也会 seed 到同一个 `sessionAllowRules`：

- project persist 分支：`packages/core/src/tool-system/permission.ts:261` 到 `packages/core/src/tool-system/permission.ts:296`。
- “Also seed the session allow list” 写入同一个数组：`packages/core/src/tool-system/permission.ts:297` 到 `packages/core/src/tool-system/permission.ts:306`。

这条 seed 的初衷是让当前 session 立即受益；修复时也必须只 seed 当前 `sessionId` 的 bucket，不能继续 seed singleton 数组。

### 2.4 为什么会串

默认 interactive backend 是进程级 singleton：

- 模块级 `_interactiveBackend`：`packages/core/src/tool-system/permission.ts:499` 到 `packages/core/src/tool-system/permission.ts:500`。
- `getInteractiveApprovalBackend()` 懒创建并返回同一实例：`packages/core/src/tool-system/permission.ts:502` 到 `packages/core/src/tool-system/permission.ts:506`。
- `setInteractiveApprovalFn()` 把 promptFn 装到这个 singleton 上：`packages/core/src/tool-system/permission.ts:509` 到 `packages/core/src/tool-system/permission.ts:512`。
- `AgentServer` 构造时安装该全局 promptFn：`packages/core/src/protocol/server.ts:195` 到 `packages/core/src/protocol/server.ts:197`。
- Engine 默认没有显式 `config.approvalBackend` 时会取这个 singleton interactive backend：`packages/core/src/engine/engine.ts:3077` 到 `packages/core/src/engine/engine.ts:3094`。
- `ChatSessionManager` 每 session 创建独立 `Engine`，但 `ChatSession` 只持有 `engine` 和自己的 `pendingApprovals`，没有独立 backend，见 `packages/core/src/protocol/chat-session-manager.ts:78` 到 `packages/core/src/protocol/chat-session-manager.ts:81`、`packages/core/src/protocol/chat-session.ts:40` 到 `packages/core/src/protocol/chat-session.ts:50`。

因此触发序列是：

1. 会话 A 与会话 B 都通过默认路径使用同一个 `InteractiveApprovalBackend` singleton。
2. A 对 operation X 选择 `{ approved: true, always: true, scope: "session" }`，写入 singleton 的 `sessionAllowRules`。
3. B 请求 operation X 时，`requestApproval()` 的 fast path 在同一个 singleton array 中命中 A 写入的 rule。
4. 因为 `checkSessionRules()` 不读 `req.sessionId`，B 直接得到 `{ approved: true }`，不会弹出 B 自己的审批卡。

若 A 写入的是 session deny，B 的同 operation 会被无提示拒绝。

附带注意：同一个类上还有 `cwd`、`savedProjectRules`、`onProjectRules`、`promptTurn` 等实例字段，见 `packages/core/src/tool-system/permission.ts:145` 到 `packages/core/src/tool-system/permission.ts:159`；Engine 每次 run 会在 singleton 上重设 `cwd` 和 `onProjectRules`，见 `packages/core/src/engine/engine.ts:1663` 到 `packages/core/src/engine/engine.ts:1670`。这不是 N-06 的主缺陷，但修复 session bucket 时应避免继续让这些 session/run 相关字段影响其它 session。

## 3. 候选修复方案对比

### 方案 A：在 InteractiveApprovalBackend 内按 sessionId 分桶（推荐）

核心改法：

- 在 `packages/core/src/tool-system/permission.ts` 中把 `sessionAllowRules` / `sessionDenyRules` 改为 `Map<string, InteractiveApprovalSessionState>`。
- state 至少包含 `allowRules`、`denyRules`、`promptTurn`；建议同时包含 `cwd`、`savedProjectRules`、`onProjectRules`，避免 project/path-scoped approval 的运行期上下文继续被 singleton 字段串扰。
- `requestApproval(req)` 通过 `req.sessionId` 取对应 bucket；`checkSessionRules(req, bucket)` 只查该 bucket。
- `promptAndRecord(req, bucket)` 只写当前 bucket。
- 无 `req.sessionId` 时不创建共享 bucket；session-scope remember 不落盘、不入全局 map，按一次性审批结果返回。可记录 debug/warn 日志便于追踪 legacy caller。
- 增加 `openInteractiveApprovalSession(sessionId)` / `clearInteractiveApprovalSession(sessionId)` 或 backend 方法，在 `ChatSessionManager.getOrCreate()` / `close()` 接入，模式参考 path-policy 的 `openSessionPathApprovals()` / `clearSessionPathApprovals()`。

改动文件/函数：

- `packages/core/src/tool-system/permission.ts`：新增 state 类型、bucket helper、按 bucket 读写、session open/clear API；保留 `setPromptFn()` 作为 singleton prompt 路由入口。
- `packages/core/src/engine/engine.ts`：把 `approvalBackend.setCwd(cwd)` / `setOnProjectRules(...)` 改为带 `sessionId` 的 session context 注入，例如 `setSessionContext(session.state.sessionId, { cwd, onProjectRules })`；旧方法可保留给 legacy/测试。
- `packages/core/src/protocol/chat-session-manager.ts`：像 path-policy 一样在 `getOrCreate(sessionId, ...)` open，在 `close(sessionId)` clear。
- `packages/core/src/tool-system/permission.session-cache.test.ts`：新增跨 session 隔离失败测试；现有期望 cache 生效的 direct backend 测试需要补 `sessionId`，以匹配“无 sessionId 不记忆”的新契约。

优点：

- 改动半径小到中，主要集中在 permission backend 和 session lifecycle。
- 保留现有 `AgentServer` / renderer promptFn 路由，不需要重做协议层。
- 能直接修复 session allow 与 session deny 的跨会话泄漏。
- 可顺手把 `promptTurn` 改成 per-session，避免 B 被 A 的 pending prompt 无谓阻塞。
- 与 path-policy、credential 的 session bucket 模式一致。

风险：

- 直接调用 `InteractiveApprovalBackend.requestApproval()` 且不带 `sessionId` 的单元测试或 legacy caller，如果期望 session cache 生效，需要显式传入测试 sessionId。运行时 Engine 主链路已会写入 `toolCtx.sessionId`，见 `packages/core/src/engine/engine.ts:1511`，风险可控。
- 如果一次实现中没有把 `cwd` / `onProjectRules` 也纳入 session context，仍可能留下 project/path-scoped approval 的邻近串扰；建议本次一起纳入 state，但不改变 project-scope 持久化语义。

指定情形影响：

- 单 session 正常审批记忆：仍生效；同一 `sessionId` 下 operation cache 逻辑不变。
- session 结束缓存回收：通过 `ChatSessionManager.close(sessionId)` 清理；late approval 应参考 path-policy 的 closed-session guard，避免 close 后异步 prompt resolve 重新创建 bucket。
- subagent/headless/automation：正常 subagent child run 使用 `req.resumeSessionId ?? req.agentId` 作为 child sessionId，见 `packages/core/src/engine/engine.ts:1253` 到 `packages/core/src/engine/engine.ts:1265`；headless 默认走 `HeadlessApprovalBackend` 或 `AutoApprovalBackend`，不使用 interactive session cache；automation 如果显式 delegate 到 interactive backend，也必须携带 `sessionId` 才能记忆，否则按一次性处理。
- 跨 session 并发：A/B 分别命中各自 bucket；A 的 prompt resolve 不会让 B 的 queued ask 命中 A 的 cache。

### 方案 B：每 session 创建一个 InteractiveApprovalBackend 实例

核心改法：

- `ChatSessionManager` 或 host engine factory 为每个 session 创建独立 `InteractiveApprovalBackend`。
- 每个 session Engine 的 `config.approvalBackend` 注入该实例。
- 每个 backend 的 promptFn 仍调用 `AgentServer.requestApprovalFromClient()`，并确保 request 带自己的 sessionId。

改动文件/函数：

- `packages/core/src/protocol/chat-session-manager.ts`：engineFactory 需要知道 `sessionId`，当前签名只有 `(slice) => Engine`，见 `packages/core/src/protocol/chat-session-manager.ts:32` 到 `packages/core/src/protocol/chat-session-manager.ts:33`、`packages/core/src/protocol/chat-session-manager.ts:78`。
- `packages/core/src/cli/agent-server-stdio.ts` 与 `packages/core/src/cli/agent-server-tcp.ts`：session engine factory 需要注入 backend；当前 new Engine 未传 per-session approvalBackend，见 `packages/core/src/cli/agent-server-stdio.ts:235` 到 `packages/core/src/cli/agent-server-stdio.ts:285`、`packages/core/src/cli/agent-server-tcp.ts:94` 到 `packages/core/src/cli/agent-server-tcp.ts:116`。
- `packages/tui/src/cli/commands/repl.ts`：当前 shared config 显式用 singleton `getInteractiveApprovalBackend()`，见 `packages/tui/src/cli/commands/repl.ts:156` 到 `packages/tui/src/cli/commands/repl.ts:168`。
- `packages/core/src/protocol/server.ts`：`requestApprovalFromClient()` 是 private，per-session backend promptFn 注入需要重构 server 与 manager 的构造顺序或暴露一个安全 callback。

优点：

- ownership 最清晰：backend 实例字段天然属于一个 session，`cwd`、`savedProjectRules`、`onProjectRules`、`promptTurn` 都不再跨 session。
- close 回收可以随 ChatSession/Engine 生命周期自然释放，理论上不需要额外 map cleanup。

风险：

- 改动半径大，涉及 server、CLI/TUI factory、EngineConfig 注入与构造顺序。
- 需要谨慎保留 singleton promptFn 的旧兼容路径，否则 legacy single-engine path 或 TUI 可能失去交互审批。
- 如果实现不彻底，可能出现部分 session 用 per-session backend、部分 session 仍用 singleton 的混合状态，测试矩阵更大。

指定情形影响：

- 单 session 正常审批记忆：生效，且最自然。
- session 结束缓存回收：实例释放即可；但需要确认 idle close、server close、TUI exit 都释放引用。
- subagent/headless/automation：subagent child Engine 是否继承 parent backend 还是创建 child backend 需要重新定义；headless 仍不应提示；automation delegate 需要独立接线。
- 跨 session 并发：天然隔离。

### 方案 C：在判定入口包一层 session-scoped wrapper

核心改法：

- 保留 singleton `InteractiveApprovalBackend`，但在 `Engine.run()` 或 `PermissionClassifier` 附近创建 `SessionScopedApprovalBackend` wrapper。
- wrapper 持有固定 `sessionId`，在 `requestApproval()` 前后做 cache scoped lookup/record，或把 `sessionId` 注入 singleton 的某种 session context。

改动文件/函数：

- `packages/core/src/engine/engine.ts`：`buildPermissionConfig()` 目前不知道 resolved sessionId；需要把 wrapper 创建移到 session resolve 之后，或扩展函数参数。
- `packages/core/src/tool-system/permission.ts`：需要拆分 interactive prompt 与 cache 逻辑，否则 wrapper 会复制 `promptAndRecord()` / `buildProjectRule()` 逻辑。

优点：

- 理论上可以少改 host wiring。
- 可以让 wrapper 成为未来每 session backend 的过渡层。

风险：

- 容易引入 ambient/current-session 状态，异步并发下风险高。
- 若 wrapper 只在入口注入 sessionId，但底层 singleton 仍持有 global arrays/cwd/onProjectRules，不能根治 N-06。
- 重复实现 cache 逻辑会让 `ruleMatches()`、project seed、pathScope 行为分叉。

指定情形影响：

- 单 session 正常审批记忆：可做到，但依赖 wrapper 覆盖所有入口。
- session 结束缓存回收：仍要另建 registry 和 clear API。
- subagent/headless/automation：需要确保所有 Engine 构造路径都包 wrapper，漏一条就回到 singleton。
- 跨 session 并发：若实现为显式 per-wrapper state 可以隔离；若用 ambient state 不推荐。

## 4. 推荐方案与理由

推荐方案 A：在 `InteractiveApprovalBackend` 内按 `sessionId` 分桶，并把 session lifecycle 接入 `ChatSessionManager`。

一句话理由：它直接修复缺陷所在的数据结构，保留现有 prompt 路由与 Engine 架构，改动小于 per-session backend 重构，同时能与仓库已有 path-policy / credential session bucket 模式对齐。

实现边界：

- 必须修复 `sessionAllowRules` 与 `sessionDenyRules` 的跨 session 泄漏。
- 应同步把 `promptTurn` 做成 per-session，避免跨 session 队列互相等待。
- 建议把 `cwd`、`savedProjectRules`、`onProjectRules` 纳入同一个 session state，避免后续 project/pathScope approval 的运行期上下文继续受 singleton 字段影响；这是同文件邻近状态，改动仍在同一落点内。
- 不改变 persisted project rule 的语义：用户选择 project scope 时仍写 `.code-shell/settings.local.json`；但“seed session allow list”只能 seed 当前 `sessionId` 的 bucket。

## 5. 推荐方案落地步骤

### 步骤 1：先写失败测试锁定 N-06

文件：`packages/core/src/tool-system/permission.session-cache.test.ts`。

新增用例：同一个 `InteractiveApprovalBackend` 实例中，session A 的 session allow 不影响 session B。

场景：

1. 创建一个 backend。
2. promptFn 记录收到的 `req.sessionId`。
3. 第一次请求带 `sessionId: "sess-a"`，tool 为 `Bash`，command 为 `curl https://a.example`，返回 `{ approved: true, always: true, scope: "session" }`。
4. 第二次请求带 `sessionId: "sess-b"`，tool 仍为 `Bash`，command 为 `curl https://b.example`，promptFn 返回 `{ approved: false }`。

断言：

- 第二次必须调用 promptFn，`seen` 应为 `["sess-a", "sess-b"]` 或 prompt count 为 2。
- 第二次结果 `approved === false`。
- 当前代码会失败：B 会命中 A 写入的 `^curl(\s|$)` allow rule，prompt count 仍为 1，结果为 allow。

建议再补一个 deny 对称用例：

- A 对 `curl https://a.example` 返回 `{ approved: false, always: true, scope: "session" }`。
- B 对同 head command 返回 `{ approved: true }`。
- 断言 B 必须被 prompt 且最终 allow；当前代码会让 B 被 A 的 deny cache 无提示拒绝。

### 步骤 2：把 backend session cache 改为按 sessionId 分桶

文件：`packages/core/src/tool-system/permission.ts`。

建议结构：

- 新增内部类型 `InteractiveApprovalSessionState`，字段包含：
  - `allowRules: PermissionRule[]`
  - `denyRules: PermissionRule[]`
  - `promptTurn: Promise<void>`
  - `cwd: string | null`
  - `savedProjectRules: PermissionRule[]`
  - `onProjectRules: ((rules: PermissionRule[]) => void) | null`
- 新增 `sessionStateById = new Map<string, InteractiveApprovalSessionState>()`。
- 新增 `closedSessionIds = new Set<string>()`，用于防止 close 后 late approval 重新建 bucket，参考 path-policy 的 `closedPathApprovalSessions`。
- 新增 helper：
  - `private getSessionState(sessionId: string | undefined, create: boolean): InteractiveApprovalSessionState | null`
  - `private makeSessionState(): InteractiveApprovalSessionState`

规则：

- `sessionId` 是非空 string 才能创建 bucket。
- `sessionId` 缺失时，`getSessionState()` 返回 `null`，不得落入 `"__global__"` / `"__nosession__"` 这种共享 key。
- `closedSessionIds` 包含该 sessionId 时，`create` 不应重建 bucket；`openInteractiveApprovalSession(sessionId)` 负责移除 closed 标记。

### 步骤 3：改读取路径

文件：`packages/core/src/tool-system/permission.ts`。

把 `requestApproval(req)` 的两次 `checkSessionRules(req)` 改成：

- 先按 `req.sessionId` 取 state。
- 有 state 才查 `checkSessionRules(req, state)`。
- 无 state 时跳过 cache fast path，继续走 prompt；如果 prompt 结果是 session-scope remember，后续也不写 cache。

把 `promptTurn` 从 backend 实例字段移到 state：

- 有 state 时使用 `state.promptTurn` 串行同 session prompt，并在轮到自己后重新查该 state 的 rules。
- 无 state 时可使用一个 legacy/no-session promptTurn 只做 prompt UI 串行，但不能复用 rules。也可以不串行，取决于现有 UI 是否强依赖 backend 串行；若保留，必须保证它不携带 cache。

### 步骤 4：改写入路径

文件：`packages/core/src/tool-system/permission.ts`。

在 `promptAndRecord(req, state)` 中：

- session scope：
  - 只有 `state !== null` 且 `result.always` 时才写 `state.allowRules` / `state.denyRules`。
  - 去重仍按 `tool + argsPattern`，但只在当前 state 内去重。
  - 如果 `state === null`，返回用户结果但不记忆；建议记录日志说明缺少 sessionId，session-scope remember ignored。
- project scope：
  - `cwd` 使用 `state.cwd`，不是 singleton `this.cwd`。
  - `savedProjectRules` 与 `onProjectRules` 使用 state 内字段。
  - project rule 持久化后，只 seed 当前 state 的 `allowRules`；不要写入任何 global allow array。
  - 如果无 state 或无 cwd，可以保持现有 best-effort 行为：不持久化、不 seed，只返回审批结果；需记录日志便于发现 legacy caller。

### 步骤 5：替换 session context 注入

文件：`packages/core/src/tool-system/permission.ts`、`packages/core/src/engine/engine.ts`。

新增 backend API，例如：

- `setSessionContext(sessionId: string, context: { cwd: string; onProjectRules: (rules: PermissionRule[]) => void }): void`

然后把 Engine 当前逻辑：

- `approvalBackend.setCwd(cwd)`，见 `packages/core/src/engine/engine.ts:1663` 到 `packages/core/src/engine/engine.ts:1665`。
- `approvalBackend.setOnProjectRules(...)`，见 `packages/core/src/engine/engine.ts:1665` 到 `packages/core/src/engine/engine.ts:1670`。

改为对当前 `session.state.sessionId` 调 `setSessionContext(...)`。

旧的 `setCwd()` / `setOnProjectRules()` 可以保留为 legacy wrapper 或标注 deprecated，但修复路径不要再依赖它们的 singleton 字段。

### 步骤 6：接入 session open/clear

文件：`packages/core/src/tool-system/permission.ts`、`packages/core/src/protocol/chat-session-manager.ts`。

在 `permission.ts` 导出：

- `openInteractiveApprovalSession(sessionId: string): void`
- `clearInteractiveApprovalSession(sessionId: string): void`

语义：

- open：移除 closed 标记；不需要预建 bucket。
- clear：删除 bucket、删除 per-session prompt chain、加入 closed 标记，防止 late approval 重新创建。

在 `ChatSessionManager.getOrCreate()` 中，紧邻 `openSessionPathApprovals(sessionId)` 调 open，见 `packages/core/src/protocol/chat-session-manager.ts:53` 到 `packages/core/src/protocol/chat-session-manager.ts:55`。

在 `ChatSessionManager.close()` 中，紧邻 `clearSessionPathApprovals(sessionId)` / credential cleanup 调 clear，见 `packages/core/src/protocol/chat-session-manager.ts:98` 到 `packages/core/src/protocol/chat-session-manager.ts:104`。

### 步骤 7：补齐 cleanup 与 no-session 测试

建议文件：

- `packages/core/src/tool-system/permission.session-cache.test.ts`
- `packages/core/src/protocol/chat-session-manager.permission.test.ts`

新增测试点：

- `session allow rules are isolated by ApprovalRequest.sessionId`。
- `session deny rules are isolated by ApprovalRequest.sessionId`。
- `session remember is ignored when ApprovalRequest.sessionId is absent`：无 sessionId 的两个同 operation 请求都必须 prompt，参考 credential 工具无 sessionId 不共享的契约。
- `ChatSessionManager.close clears interactive approval session rules`：可参考 `chat-session-manager.permission.test.ts:124` 到 `chat-session-manager.permission.test.ts:159` 的 path approval cleanup 测试结构。
- `late interactive approval after close does not recreate session bucket`：可参考 `chat-session-manager.permission.test.ts:161` 到 `chat-session-manager.permission.test.ts:209` 的 in-flight path approval 测试结构。

## 6. TDD 测试点

首个失败测试应落在 `packages/core/src/tool-system/permission.session-cache.test.ts`，因为缺陷就在 backend cache，最小复现不需要启动 `AgentServer`。

推荐测试名：

- `session allow rules are isolated by ApprovalRequest.sessionId`

具体场景与断言：

- 用同一个 backend 实例模拟 singleton。
- A 请求：`{ sessionId: "sess-a", toolName: "Bash", args: { command: "curl https://a.example" } }`。
- promptFn 对 A 返回 session allow。
- B 请求：`{ sessionId: "sess-b", toolName: "Bash", args: { command: "curl https://b.example" } }`。
- promptFn 对 B 返回 deny。
- 断言 promptFn 被调用两次，第二次收到 `"sess-b"`。
- 断言 B 结果为 denied。

为什么这个测试精准：当前 `buildProjectRule()` 会把 A 的 Bash approval 缩窄为 `^curl(\s|$)`，见 `packages/core/src/tool-system/permission.ts:356` 到 `packages/core/src/tool-system/permission.ts:365`；当前 `checkSessionRules()` 不看 sessionId，见 `packages/core/src/tool-system/permission.ts:219` 到 `packages/core/src/tool-system/permission.ts:224`，所以 B 会错误免审批 allow。

已有测试关系：

- `permission.session-cache.test.ts` 目前覆盖同一 backend 内 operation cache 不能过宽，以及并发 duplicate prompt 去重，见 `packages/core/src/tool-system/permission.session-cache.test.ts:24` 到 `packages/core/src/tool-system/permission.session-cache.test.ts:194`、`packages/core/src/tool-system/permission.session-cache.test.ts:196` 到 `packages/core/src/tool-system/permission.session-cache.test.ts:250`；缺少跨 `sessionId` 断言。
- `server.askuser-session-isolation.test.ts` 覆盖 pending resolver 按 session 隔离，见 `packages/core/src/protocol/server.askuser-session-isolation.test.ts:69` 到 `packages/core/src/protocol/server.askuser-session-isolation.test.ts:162`；它是范式参考，不覆盖 rule cache。

## 7. 回归面与应跑测试

可能受影响行为：

- 单会话内 remember：同一 `sessionId` 下 `always + scope:"session"` 仍应吸收后续同 operation。需要更新现有 direct backend 测试，为期望 cache 的请求补 `sessionId`。
- 并发 duplicate prompt 去重：同 session 同 operation 并发仍应只 prompt 一次；不同 session 的并发不应互相吸收。
- session deny：同 session 内 deny cache 仍应优先于 allow；不同 session deny 不应无提示拒绝。
- project approval：project-scope approve 仍应持久化到当前 session cwd 的 `.code-shell/settings.local.json`；live classifier reconfigure 仍只影响当前 Engine；session allow seed 只进当前 session bucket。
- 自动化/无人值守 no-ask 路径：`HeadlessApprovalBackend` 与无 delegate 的 `AutoApprovalBackend` 不应受影响，见 `packages/core/src/tool-system/permission.ts:28` 到 `packages/core/src/tool-system/permission.ts:44`、`packages/core/src/tool-system/permission.ts:51` 到 `packages/core/src/tool-system/permission.ts:91`。
- subagent 权限继承：child Engine 正常有自己的 child sessionId，见 `packages/core/src/engine/engine.ts:1253` 到 `packages/core/src/engine/engine.ts:1265`；不会继承 parent 的 session rule cache。若某些 ad-hoc ToolContext 没有 sessionId，remember 应失效而不是共享。
- session close：关闭 session 后 interactive session bucket 应被清理；late approval 不应重建 bucket。

建议运行的既有/新增测试：

- `bun test packages/core/src/tool-system/permission.session-cache.test.ts`
- `bun test packages/core/src/protocol/chat-session-manager.permission.test.ts`
- `bun test packages/core/src/protocol/server.askuser-session-isolation.test.ts`
- `bun test packages/core/src/protocol/server.askuser-chatmanager.test.ts`
- `bun test packages/core/src/protocol/server.askuser-timeout.test.ts`
- `bun test packages/core/src/protocol/server.askuser-headless.test.ts`
- `bun test packages/core/src/tool-system/path-policy-approval.test.ts`
- `bun test packages/core/src/credentials/use-credential-tool.test.ts`
- `bun test packages/core/src/credentials/inject-credential-tool.test.ts`
- `bun test packages/core/src/tool-system/builtin/agent.send-input.llm.test.ts`
- `bun test packages/core/src/automation/runner.permission.test.ts`

本设计轮不运行这些测试；它们是后续实现轮的验证清单。

## 8. 安全影响声明与临时缓解

安全影响：

- 这是权限边界跨 session 泄漏。修复前，同一进程、同一 OS 用户、共享 interactive backend 的 host 中，会话 B 可能绕过本应弹出的审批，直接继承会话 A 的 session allow。
- 对 Bash 尤其需要重视：A 对 `curl ...` 的 session allow 会生成 head-command rule，B 的其它单条 `curl ...` 可能命中；虽然 `ruleMatches()` 已防止链式命令/危险尾巴直接骑同 head grant，见 `packages/core/src/tool-system/permission.ts:419` 到 `packages/core/src/tool-system/permission.ts:428`，但同 head 单命令仍可能覆盖网络访问或数据外传类操作。
- 对 session deny，B 也可能被 A 的 deny cache 无提示拒绝，造成可用性和审计混淆。

修复前临时缓解：

- 在多会话 desktop/stdio/TCP 场景中，避免在敏感工具审批卡上选择“本会话一直允许/拒绝”；优先选择“仅本次”。
- 处理不同信任级任务时，使用独立进程隔离，而不是同一进程内多 tab/session 并行。
- 若必须并行多 session，避免把 `Bash` 的网络/外传类 head command（如 `curl`、`wget`、`ssh` 等）设为 session allow。
- 对自动化/headless 任务，优先使用明确的 headless/auto 策略，不接入共享 interactive backend。

## 9. 自查

- 缺陷定位已精确到 `InteractiveApprovalBackend` 字段、读写点、singleton 获取点和 Engine/ChatSession 持有关系的 file:line。
- 候选方案覆盖 A/B/C，并比较了单 session remember、session 结束回收、subagent/headless/automation、跨 session 并发。
- 推荐方案明确：backend 内按 `sessionId` 分桶，接入 `ChatSessionManager` open/clear。
- TDD 首测具体：同 singleton backend，A session allow 不影响 B session，并给出场景和断言。
- 回归面覆盖单会话 remember、no-ask、subagent、project seed、session close。
- 安全影响已声明，并给出修复前临时缓解。
