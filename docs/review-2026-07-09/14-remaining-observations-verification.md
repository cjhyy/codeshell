# Remaining N 系列观察验证

本文按 `13-findings-register.md` 的真实状态，只验证总账中仍为「仅观察」的 N 条目：N-04、N-05、N-07、N-08、N-09。N-01/N-02/N-03 和 N-06 已由既有文档验证或给出修复设计，本轮不重做。

范围：只读源码、`rg` 检索和既有 review 文档；未跑构建/测试；不修改 `packages/**`。结论只按可溯源 file:line 落地；涉及用户期望的部分若源码无法证明，明确标注为推断或部分成立。

## 总览

| 编号 | 结论 | 最终严重度 | 口径 |
|---|---|---|---|
| N-04 | 确证，范围收窄 | P2 | `AgentClient` 丢 notification envelope 的 `sessionId`，且不暴露 `approvalResolved`；普通工具审批可从 `request.sessionId` 部分绕过，但 AskUser/browser/credential/workspace 不能。 |
| N-05 | 确证 | P2 | 类型注释承诺 explicit `agent/goalClear` 产生 `goal_cleared`，server 实际只回 RPC response；desktop 自己本地注入。 |
| N-07 | 确证 | P2 | `permissionDefault` 是注册元数据，当前不进入 `PermissionClassifier` 执行判定。 |
| N-08 | 部分成立 | P2 | PowerShell 不走 sandbox 是代码事实；“用户一定会误解覆盖面”没有运行时/文案证据，只能按风险面校准。 |
| N-09 | 确证为维护债 | P3 | helper 与当前 `tool_result` 契约漂移，但 production 源码未调用，不是当前主链路 bug。 |

## N-04：SDK `AgentClient` approval surface 丢 envelope sessionId，且不处理 `approvalResolved`

### 1. 命题

`AgentClient` 的 public approval 事件没有把 `agent/approvalRequest` notification envelope 上的 `params.sessionId` 暴露给 handler，并且 `handleNotification()` 没有处理 `agent/approvalResolved`。因此对只通过 `AgentClient.onApprovalRequest()` 消费 protocol 的 SDK 客户端，部分多会话 approval/ask 无法从事件参数可靠拿到 originating session，也无法接收 server-initiated resolved 通知。

### 2. 验证方法

- 读 SDK 入口：`AgentClientEvents`、`onApprovalRequest()`、`handleNotification()`、`approve()` overload。
- 读 protocol 类型：`ApproveParams`、`AgentStreamEventNotification`、`ApprovalRequestNotification`、`Methods.ApprovalResolved`。
- 读 server 发送/回收链路：`requestApprovalFromClient()`、`requestAskUserForSession()`、`requestBrowserActionForSession()`、`requestCredentialInjectForSession()`、`requestWorkspaceSwitchForSession()`、`handleApprove()`。
- 对比 desktop 主路径：preload 是否透传 raw params、renderer 是否按 `env.sessionId` 路由。
- `rg -n "agent/approvalRequest|agent/approvalResolved|ApprovalResolved|ApprovalRequest|approvalRequest" packages/core/src/protocol packages/desktop/src/preload/index.ts packages/desktop/src/renderer/App.tsx` 命中包括 `packages/core/src/protocol/client.ts:44`、`:307`、`:388`、`packages/core/src/protocol/server.ts:1937`、`:1981`、`:2017`、`:2096`、`:2152`、`:2217`、`packages/desktop/src/preload/index.ts:190`、`:194`、`packages/desktop/src/renderer/App.tsx:1787`、`:1891`。

### 3. 证据

- SDK event 类型只有 stream 保留多会话 envelope；approvalRequest 只有 `(requestId, request)`：`packages/core/src/protocol/client.ts:41`、`packages/core/src/protocol/client.ts:44`。
- SDK `onApprovalRequest()` / `offApprovalRequest()` handler 签名也只有 `(requestId, request)`：`packages/core/src/protocol/client.ts:307`、`packages/core/src/protocol/client.ts:311`。
- SDK `handleNotification()` 对 `Methods.StreamEvent` 会读取 `params.sessionId` 并 emit `{ sessionId, event }`：`packages/core/src/protocol/client.ts:379`、`packages/core/src/protocol/client.ts:381`、`packages/core/src/protocol/client.ts:383`、`packages/core/src/protocol/client.ts:384`。
- 同一个 `handleNotification()` 对 `Methods.ApprovalRequest` 只读取 `requestId` / `request`，emit 时丢弃 `params.sessionId`：`packages/core/src/protocol/client.ts:388`、`packages/core/src/protocol/client.ts:389`、`packages/core/src/protocol/client.ts:390`、`packages/core/src/protocol/client.ts:392`。
- `handleNotification()` 的 switch 只有 `StreamEvent`、`ApprovalRequest`、`Status`，无 `Methods.ApprovalResolved` case：`packages/core/src/protocol/client.ts:375`、`packages/core/src/protocol/client.ts:378`、`packages/core/src/protocol/client.ts:396`、`packages/core/src/protocol/client.ts:402`。
- protocol 类型本身定义了 approval notification envelope 的可选 `sessionId`：`packages/core/src/protocol/types.ts:319`、`packages/core/src/protocol/types.ts:322`、`packages/core/src/protocol/types.ts:323`、`packages/core/src/protocol/types.ts:324`。
- protocol 方法名包含 `ApprovalResolved`，注释说明用于让 client dismiss stale card：`packages/core/src/protocol/types.ts:367`、`packages/core/src/protocol/types.ts:368`、`packages/core/src/protocol/types.ts:371`。
- `ApproveParams` 在类型层要求 `sessionId`：`packages/core/src/protocol/types.ts:135`、`packages/core/src/protocol/types.ts:137`、`packages/core/src/protocol/types.ts:138`、`packages/core/src/protocol/types.ts:139`。
- SDK `approve()` 虽有多会话 overload，但必须由调用方传入 sessionId：`packages/core/src/protocol/client.ts:143`、`packages/core/src/protocol/client.ts:149`、`packages/core/src/protocol/client.ts:151`、`packages/core/src/protocol/client.ts:154`。
- server `handleApprove()` 在 chatManager path 只在 `params.sessionId` 是 string 时查 session map；否则落到 legacy global map：`packages/core/src/protocol/server.ts:655`、`packages/core/src/protocol/server.ts:659`、`packages/core/src/protocol/server.ts:671`、`packages/core/src/protocol/server.ts:682`、`packages/core/src/protocol/server.ts:692`、`packages/core/src/protocol/server.ts:693`。
- 普通工具审批有一个缓解：`ApprovalRequest` 类型自身也有可选 `sessionId`：`packages/core/src/types.ts:339`、`packages/core/src/types.ts:341`；`PermissionClassifier.handleAsk()` 会把 `opts.sessionId` 放入 approval request：`packages/core/src/tool-system/permission.ts:1011`、`packages/core/src/tool-system/permission.ts:1012`；executor 调用 `handleAsk()` 时传 `toolCtx.sessionId`：`packages/core/src/tool-system/executor.ts:417`、`packages/core/src/tool-system/executor.ts:419`、`packages/core/src/tool-system/executor.ts:420`。
- server 普通工具审批按 `request.sessionId` 找 session 并在 notification envelope 上带 `sessionId`：`packages/core/src/protocol/server.ts:1908`、`packages/core/src/protocol/server.ts:1911`、`packages/core/src/protocol/server.ts:1919`、`packages/core/src/protocol/server.ts:1937`、`packages/core/src/protocol/server.ts:1938`。
- 但 server 合成的 AskUser notification 只在 envelope 上带 `sessionId`，嵌套 `request` 没有 `sessionId` 字段：`packages/core/src/protocol/server.ts:1981`、`packages/core/src/protocol/server.ts:1982`、`packages/core/src/protocol/server.ts:1984`、`packages/core/src/protocol/server.ts:1985`。
- browser / credential / workspace 合成请求同样只在 envelope 带 `sessionId`，嵌套 request 无 sessionId：`packages/core/src/protocol/server.ts:2096`、`packages/core/src/protocol/server.ts:2097`、`packages/core/src/protocol/server.ts:2099`；`packages/core/src/protocol/server.ts:2152`、`packages/core/src/protocol/server.ts:2153`、`packages/core/src/protocol/server.ts:2155`；`packages/core/src/protocol/server.ts:2217`、`packages/core/src/protocol/server.ts:2218`、`packages/core/src/protocol/server.ts:2220`。
- server 会在 goal-active AskUser timeout 时发 `approvalResolved`：`packages/core/src/protocol/server.ts:2007`、`packages/core/src/protocol/server.ts:2010`、`packages/core/src/protocol/server.ts:2017`。
- desktop 主路径不经过 `AgentClient`，preload 直接透传 raw `params`：`packages/desktop/src/preload/index.ts:190`、`packages/desktop/src/preload/index.ts:193`、`packages/desktop/src/preload/index.ts:194`、`packages/desktop/src/preload/index.ts:195`；renderer 按 `env.sessionId` 路由 approval 和 resolved：`packages/desktop/src/renderer/App.tsx:1787`、`packages/desktop/src/renderer/App.tsx:1791`、`packages/desktop/src/renderer/App.tsx:1829`、`packages/desktop/src/renderer/App.tsx:1846`、`packages/desktop/src/renderer/App.tsx:1891`、`packages/desktop/src/renderer/App.tsx:1899`。

### 4. 结论

确证，但范围需要收窄：原观察对 SDK approval event surface 成立，尤其是 AskUser/browser/credential/workspace 这类 server 合成请求；普通工具审批因为 `request.sessionId` 可能随嵌套 request 一起到达，SDK consumer 可以自行读取 `request.sessionId` 作为临时绕路，但这不是 `AgentClientEvents.approvalRequest` 明确承诺的 envelope 契约。`approvalResolved` 不处理为完全确证。

### 5. 严重度校准

P2。desktop 主路径已有 preload/renderer raw envelope 保护，不是全产品 P1；但 public SDK 多会话 approval surface 与 server `approve(sessionId, ...)` 契约不对称，足以造成 SDK/in-process consumer 路由失败或 stale ask 不消失。

修复方向：给 SDK 增加兼容型 approval envelope 事件或扩展 handler 参数，并新增 `onApprovalResolved()`；保留旧 `(requestId, request)` handler 以免破坏现有调用方。

## N-05：`goal_cleared` 注释与 `agent/goalClear` server 行为不一致

### 1. 命题

`StreamEvent` 类型注释承诺 explicit `agent/goalClear` 会产生 `goal_cleared` stream event；但 `AgentServer.handleGoalClear()` 成功 clear 后只返回 RPC response，不发 `agent/streamEvent`，当前 desktop 通过本地 dispatch 弥补 UI。

### 2. 验证方法

- 读 `StreamEvent` goal lifecycle 注释和 union。
- 读 `AgentServer.handleGoalClear()` 是否调用 `notify(Methods.StreamEvent, ...)`。
- `rg -n "goal_cleared" packages/core/src packages/desktop/src`：core 只命中类型注释/union；desktop 命中 reducer、测试和 `App.tsx` 本地注入。
- `rg -n "Methods\\.StreamEvent|notify\\(Methods\\.StreamEvent|goal_cleared|GoalClear" packages/core/src/protocol/server.ts packages/core/src/engine/engine.ts packages/core/src/engine/turn-loop.ts`：server `GoalClear` handler 附近无 stream notify；其它 notify 点是 background bus、run path、legacy run、compact 等。

### 3. 证据

- `StreamEvent` 注释写明 `goal_cleared` fires on explicit clear (`agent/goalClear`)：`packages/core/src/types.ts:482`、`packages/core/src/types.ts:484`、`packages/core/src/types.ts:487`、`packages/core/src/types.ts:488`。
- `handleGoalClear()` 只解析 session、调用 `session.clearGoal()` 或 legacy `clearGoal()`，最后回 `{ ok: true, cleared }`：`packages/core/src/protocol/server.ts:825`、`packages/core/src/protocol/server.ts:827`、`packages/core/src/protocol/server.ts:841`、`packages/core/src/protocol/server.ts:846`。
- `handleGoalClear()` 区间没有 `this.notify(Methods.StreamEvent, ...)`：`packages/core/src/protocol/server.ts:825` 到 `packages/core/src/protocol/server.ts:847`。
- core 中 `goal_cleared` 只在 `packages/core/src/types.ts:484` 和 `packages/core/src/types.ts:488` 命中，未见 engine/protocol producer。
- `AgentClient.goalClear()` 也只等待 RPC result 的 `cleared` boolean，没有 stream event 处理：`packages/core/src/protocol/client.ts:181`、`packages/core/src/protocol/client.ts:182`、`packages/core/src/protocol/client.ts:185`。
- desktop renderer 注释明确说 clear 后可能“NO live worker and thus NO stream”，所以本地喂入 `goal_cleared`：`packages/desktop/src/renderer/App.tsx:3334`、`packages/desktop/src/renderer/App.tsx:3335`、`packages/desktop/src/renderer/App.tsx:3336`、`packages/desktop/src/renderer/App.tsx:3340`、`packages/desktop/src/renderer/App.tsx:3351`、`packages/desktop/src/renderer/App.tsx:3354`。
- 主 reducer 和 mobile reducer 都能消费 `goal_cleared`：`packages/desktop/src/renderer/types.ts:862`、`packages/desktop/src/renderer/types.ts:863`；`packages/desktop/src/renderer/lib/streamReducer.ts:392`、`packages/desktop/src/renderer/lib/streamReducer.ts:393`。

### 4. 结论

确证。原观察没有误读：类型注释把 explicit clear 写成 stream event 契约，但 protocol/server 的 authoritative clear path 只回 RPC response。desktop 现有体验靠本地 optimistic dispatch 弥补；SDK 或其它只监听 stream 的 client 会缺失该 marker。

### 5. 严重度校准

P2。core state 会被清掉，不是数据丢失；问题是 protocol observable contract 断开，影响非 desktop-local-injection client 的 UI 同步。

修复方向：要么在 `handleGoalClear()` 成功 clear 且有 sessionId 时统一 notify `{ type:"goal_cleared" }` 并让 desktop 去重；要么把类型注释/SDK 文档改成“RPC response only”并明确 host 需本地更新。

## N-07：`RegisteredTool.permissionDefault` 不参与 classifier 判定

### 1. 命题

`RegisteredTool.permissionDefault` 是 required 注册元数据，builtin/MCP 均填充；但当前 `PermissionClassifier` 的构造、`classify()` 和 executor 权限路径不读取 tool definition，也不读取 `permissionDefault`。实际判定来自显式 rules、Bash 特判和 `defaultMode` fallback。

### 2. 验证方法

- `rg -n "permissionDefault" packages/core/src`：命中类型、builtin/MCP 注册、preset 注释、测试夹具；未见 classifier/executor 执行判定引用。
- 专门检索 `rg -n "permissionDefault" packages/core/src/tool-system/permission.ts packages/core/src/tool-system/executor.ts`，结果为空，退出码 1。
- 读 `RegisteredTool` 类型、`BUILTIN_TOOLS`、MCP `buildRegisteredTool()`。
- 读 `PermissionClassifier` constructor / `classify()` / `handleAsk()`，确认输入不含 registry/tool definition。
- 读 Engine/preset 构造 permission rules 的注释，校准当前现有工具是否由显式 rules 补齐。

### 3. 证据

- `RegisteredTool` 明确要求 `permissionDefault`：`packages/core/src/types.ts:111`、`packages/core/src/types.ts:117`。
- builtin Read/Write 填充 `permissionDefault`：`packages/core/src/tool-system/builtin/index.ts:159`、`packages/core/src/tool-system/builtin/index.ts:164`、`packages/core/src/tool-system/builtin/index.ts:172`、`packages/core/src/tool-system/builtin/index.ts:175`。
- PowerShell 等执行工具也在 builtin 注册层填充 `permissionDefault`，但没有 pathPolicy 等执行语义自动关联：`packages/core/src/tool-system/builtin/index.ts:657`、`packages/core/src/tool-system/builtin/index.ts:661`。
- MCP tool 构造时固定 `permissionDefault: "ask"`：`packages/core/src/tool-system/mcp-manager.ts:281`、`packages/core/src/tool-system/mcp-manager.ts:289`。
- `PermissionClassifier` constructor 只接收 `rules`、`defaultMode`、`approvalBackend`：`packages/core/src/tool-system/permission.ts:901`、`packages/core/src/tool-system/permission.ts:902`、`packages/core/src/tool-system/permission.ts:903`、`packages/core/src/tool-system/permission.ts:904`。
- `classify()` 顺序为 bypass、显式 rules、Bash 特判、defaultMode fallback，没有 tool definition lookup：`packages/core/src/tool-system/permission.ts:926`、`packages/core/src/tool-system/permission.ts:928`、`packages/core/src/tool-system/permission.ts:930`、`packages/core/src/tool-system/permission.ts:937`、`packages/core/src/tool-system/permission.ts:951`。
- default fallback 在 `acceptEdits` 只看 `ACCEPT_EDITS_ALLOWLIST`，默认模式直接 ask：`packages/core/src/tool-system/permission.ts:955`、`packages/core/src/tool-system/permission.ts:960`、`packages/core/src/tool-system/permission.ts:961`、`packages/core/src/tool-system/permission.ts:962`。
- `handleAsk()` 构造 approval request 时也只带 `toolName`、`args`、description、riskLevel、可选 sessionId：`packages/core/src/tool-system/permission.ts:966`、`packages/core/src/tool-system/permission.ts:999`、`packages/core/src/tool-system/permission.ts:1011`、`packages/core/src/tool-system/permission.ts:1013`。
- preset 确实用显式 rules auto-allow 常见 read-only 工具：`packages/core/src/preset/index.ts:141`、`packages/core/src/preset/index.ts:142`、`packages/core/src/preset/index.ts:143`、`packages/core/src/preset/index.ts:144`、`packages/core/src/preset/index.ts:153`、`packages/core/src/preset/index.ts:166`、`packages/core/src/preset/index.ts:167`。
- 但 preset 注释仍把未显式 allow 的行为解释为 “tool-level default”：`packages/core/src/preset/index.ts:159`、`packages/core/src/preset/index.ts:161`、`packages/core/src/preset/index.ts:162`、`packages/core/src/preset/index.ts:164`、`packages/core/src/preset/index.ts:165`。
- Engine permission config 注释也写 Memory user-scope fall through to tool `permissionDefault("ask")`，但实际 classifier fallback 是 default ask：`packages/core/src/engine/engine.ts:3037`、`packages/core/src/engine/engine.ts:3039`、`packages/core/src/engine/engine.ts:3041`。

### 4. 结论

确证。`permissionDefault` 当前是注册/展示/维护元数据，不是执行期 classifier 输入。原观察理解正确；需要补充的是，许多现有 builtin 的实际行为被 preset rules 或 default ask 覆盖，所以它不是“所有现有工具都错判”的 P1 级运行缺陷。

### 5. 严重度校准

P2。它会误导维护者和未来第三方/custom tool 的安全预期；但当前 default fallback 偏 ask，且关键 read-only allow 多由显式 preset rules 覆盖，未见可直接绕过审批的现行 P1 触发链。

修复方向：产品/安全层先决定 `permissionDefault` 是 UI hint 还是执行语义；若是执行语义，让 classifier 在显式 rules 和 Bash 特判后读取 tool definition，并补 custom allow/ask/deny 测试。

## N-08：PowerShell 执行工具不走 sandbox

### 1. 命题

Bash foreground/background shell 使用 `ToolContext.sandbox` 和 sandbox backend 包裹执行；PowerShell 工具直接调用 `safeSpawn("pwsh"/"powershell.exe", ...)`，不读取 `ctx.sandbox`、不走 `backend.wrap()`，也不会返回 `ToolResult.sandbox` 标记。至于用户是否会把 sandbox 理解成覆盖所有 shell，是风险推断，源码只能证明覆盖面差异。

### 2. 验证方法

- 读 sandbox backend 注释和接口，确认设计边界是 spawned shell / Bash-tool commands。
- 读 Engine 构造 `toolCtx.sandbox` 和 worktree setup sandbox。
- 读 Bash 工具前台/后台执行路径：`ctx.sandbox`、`safeSpawnShell()`、sandbox mark。
- 读 PowerShell 工具执行路径：`safeSpawn()`、env、返回类型。
- 读 `safeSpawn` vs `safeSpawnShell` 注释和 `resolveSpawnTarget()`，确认只有 shell-mode 会调用 `sandbox.wrap()`。
- 读 registry 结果归一化，确认 PowerShell 返回 string 时不会带 sandbox 字段。
- `rg -n "ctx\\.sandbox|sandbox:|ToolResult\\[\\\"sandbox\\\"\\]|safeSpawnShell\\(|safeSpawn\\(" packages/core/src/tool-system/builtin/powershell.ts packages/core/src/tool-system/builtin/bash.ts packages/core/src/tool-system/registry.ts` 命中：Bash 的 sandbox mark/use 和 PowerShell 的 `safeSpawn()`。

### 3. 证据

- sandbox 模块注释说 “wrap Bash-tool commands”，并说明 Engine 本身不 sandbox、只 sandbox spawned shell：`packages/core/src/tool-system/sandbox/index.ts:1`、`packages/core/src/tool-system/sandbox/index.ts:4`、`packages/core/src/tool-system/sandbox/index.ts:7`、`packages/core/src/tool-system/sandbox/index.ts:8`。
- sandbox backend 接口的 `wrap()` 是 shell command wrapper：`packages/core/src/tool-system/sandbox/index.ts:47`、`packages/core/src/tool-system/sandbox/index.ts:51`、`packages/core/src/tool-system/sandbox/index.ts:52`。
- Engine 每 run resolve sandbox 并写进 `ToolContext.sandbox`：`packages/core/src/engine/engine.ts:1271`、`packages/core/src/engine/engine.ts:1282`、`packages/core/src/engine/engine.ts:1302`、`packages/core/src/engine/engine.ts:1310`。
- worktree setup 也可 resolve sandbox：`packages/core/src/engine/engine.ts:3457`、`packages/core/src/engine/engine.ts:3459`、`packages/core/src/engine/engine.ts:3463`。
- Bash 工具注释明确 sandbox 由 Engine 通过 `ToolContext.sandbox` 下传；PowerShell 不属于其 env allowlist threat-model：`packages/core/src/tool-system/builtin/bash.ts:4`、`packages/core/src/tool-system/builtin/bash.ts:5`、`packages/core/src/tool-system/builtin/bash.ts:13`、`packages/core/src/tool-system/builtin/bash.ts:14`。
- Bash 读取 `ctx?.sandbox ?? createOffBackend()`，构造 sandbox 标记，sandboxed 时用 hardened env：`packages/core/src/tool-system/builtin/bash.ts:95`、`packages/core/src/tool-system/builtin/bash.ts:96`、`packages/core/src/tool-system/builtin/bash.ts:99`、`packages/core/src/tool-system/builtin/bash.ts:103`。
- Bash 前台通过 `safeSpawnShell()` 且传入 `sandbox: backend`：`packages/core/src/tool-system/builtin/bash.ts:121`、`packages/core/src/tool-system/builtin/bash.ts:126`。
- Bash background 也把 `ctx?.sandbox` 传给 manager：`packages/core/src/tool-system/builtin/bash.ts:175`、`packages/core/src/tool-system/builtin/bash.ts:188`、`packages/core/src/tool-system/builtin/bash.ts:192`。
- `safeSpawnShell()` 会调用 `resolveSpawnTarget()` 并带 `opts.sandbox`：`packages/core/src/runtime/safe-spawn.ts:142`、`packages/core/src/runtime/safe-spawn.ts:151`、`packages/core/src/runtime/safe-spawn.ts:154`。
- `resolveSpawnTarget()` 只有收到 `opts.sandbox` 时调用 `opts.sandbox.wrap()`：`packages/core/src/runtime/spawn-common.ts:260`、`packages/core/src/runtime/spawn-common.ts:264`、`packages/core/src/runtime/spawn-common.ts:265`。
- `safeSpawn()` 是 direct argv spawn，注释列出 REPL/PowerShell/gitOps 使用；不是 sandbox shell wrapper：`packages/core/src/runtime/safe-spawn.ts:29`、`packages/core/src/runtime/safe-spawn.ts:30`、`packages/core/src/runtime/safe-spawn.ts:31`、`packages/core/src/runtime/safe-spawn.ts:121`。
- PowerShell 直接选择 `powershell.exe`/`pwsh`，调用 `safeSpawn()`，传完整 `process.env`，未出现 `ctx.sandbox` 或 `sandbox` option：`packages/core/src/tool-system/builtin/powershell.ts:52`、`packages/core/src/tool-system/builtin/powershell.ts:53`、`packages/core/src/tool-system/builtin/powershell.ts:60`、`packages/core/src/tool-system/builtin/powershell.ts:65`。
- PowerShell 返回 `Promise<string>`，成功/失败都是字符串：`packages/core/src/tool-system/builtin/powershell.ts:38`、`packages/core/src/tool-system/builtin/powershell.ts:41`、`packages/core/src/tool-system/builtin/powershell.ts:72`、`packages/core/src/tool-system/builtin/powershell.ts:87`。
- registry 对 string result 归一化为 `{ id, toolName, result }`，只有结构化 result 才会取 `sandbox` 字段：`packages/core/src/tool-system/registry.ts:148`、`packages/core/src/tool-system/registry.ts:151`、`packages/core/src/tool-system/registry.ts:152`、`packages/core/src/tool-system/registry.ts:154`、`packages/core/src/tool-system/registry.ts:158`、`packages/core/src/tool-system/registry.ts:164`。
- PowerShell 注册元数据无 pathPolicy，只是 `permissionDefault:"ask"`、非 read-only：`packages/core/src/tool-system/builtin/index.ts:657`、`packages/core/src/tool-system/builtin/index.ts:661`、`packages/core/src/tool-system/builtin/index.ts:662`、`packages/core/src/tool-system/builtin/index.ts:665`。

### 4. 结论

部分成立。代码事实完全成立：PowerShell 不走 sandbox，也不返回 sandbox 标记；Bash/background/worktree setup 才接入 sandbox backend。原观察里“sandbox 覆盖面容易被误解”属于风险推断，源码中反而有若干 Bash-specific 注释，因此不能把“用户必然误解”写成确证。

### 5. 严重度校准

P2。它不是当前权限绕过：PowerShell 仍走工具权限审批；但当用户显式启用 sandbox 时，同为 command execution surface 的 PowerShell 未隔离且无 result 标记，安全可见性和期望边界都不够清楚。

修复方向：短期在 sandbox status/UI/文档明确“当前只覆盖 Bash/background/worktree setup，不覆盖 PowerShell”；中期评估让 PowerShell 也走 sandbox wrapper 或至少返回 `sandbox:{backend:"off"}` 并在 sandbox enabled 时提示未隔离。

## N-09：`ToolExecutor.resultsToMessages()` 与当前 `tool_result` 契约漂移，但未被主链路调用

### 1. 命题

`ToolExecutor.resultsToMessages()` 仍把 tool result 转成纯文本 `tool_result` blocks，不保留 `contentBlocks`，也不设置 `is_error`；当前 production 主链路不调用它，而是由 TurnLoop 使用 `toolResultToBlock()`，后者保留 `contentBlocks` 并设置 `is_error`。因此这是 P3 维护债，不是现行主链路 runtime bug。

### 2. 验证方法

- 读 `ToolExecutor.resultsToMessages()` helper。
- 读 TurnLoop `toolResultToBlock()` 和工具结果回填路径。
- 读 registry 对 `contentBlocks` / `sandbox` 的 `ToolResult` 归一化，确认当前 result 形状里确实有 helper 会丢的信息。
- `rg -n "resultsToMessages\\(|\\.resultsToMessages" packages/core/src --glob '!**/executor.ts'`：无输出，退出码 1。
- `rg -n "resultsToMessages\\(|\\.resultsToMessages" packages/core/src docs/architecture docs/review-2026-07-09`：除 helper 定义外，只命中旧架构文档和本轮 review/register。
- `rg -n "toolResultToBlock\\(" packages/core/src`：命中 TurnLoop 主链路和相关单测。

### 3. 证据

- stale helper 定义在 `ToolExecutor` 内：`packages/core/src/tool-system/executor.ts:635`、`packages/core/src/tool-system/executor.ts:638`。
- helper 对每个 result 只写 `content: result.error ? ... : result.result ?? "(no output)"`，没有使用 `result.contentBlocks` 或 `result.isError`：`packages/core/src/tool-system/executor.ts:641`、`packages/core/src/tool-system/executor.ts:642`、`packages/core/src/tool-system/executor.ts:645`。
- helper 返回 user message blocks：`packages/core/src/tool-system/executor.ts:649`、`packages/core/src/tool-system/executor.ts:651`、`packages/core/src/tool-system/executor.ts:652`。
- registry 当前会把 handler 的 `contentBlocks` 和 `sandbox` 带入 `ToolResult`：`packages/core/src/tool-system/registry.ts:148`、`packages/core/src/tool-system/registry.ts:156`、`packages/core/src/tool-system/registry.ts:158`、`packages/core/src/tool-system/registry.ts:162`、`packages/core/src/tool-system/registry.ts:163`。
- 当前主链路 `toolResultToBlock()` 明确保留 `result.contentBlocks`，并在 `result.isError || result.error` 时设置 `block.is_error = true`：`packages/core/src/engine/turn-loop.ts:177`、`packages/core/src/engine/turn-loop.ts:181`、`packages/core/src/engine/turn-loop.ts:183`、`packages/core/src/engine/turn-loop.ts:185`。
- TurnLoop 工具结果回填用的是 `toolResultToBlock(result)`，同时写 transcript 并发 `StreamEvent.tool_result`：`packages/core/src/engine/turn-loop.ts:1019`、`packages/core/src/engine/turn-loop.ts:1023`、`packages/core/src/engine/turn-loop.ts:1024`、`packages/core/src/engine/turn-loop.ts:1026`、`packages/core/src/engine/turn-loop.ts:1034`。
- TurnLoop 随后把 `resultBlocks` push 回 messages，形成下一次模型请求上下文：`packages/core/src/engine/turn-loop.ts:1061`、`packages/core/src/engine/turn-loop.ts:1062`。
- `toolResultToBlock(` 在 production 源码的主调用只有 TurnLoop；其它命中是测试：`packages/core/src/engine/turn-loop.ts:177`、`packages/core/src/engine/turn-loop.ts:1024`、`packages/core/src/engine/turn-loop-image-result.test.ts:15`。
- 旧架构文档仍写 `returns ToolResult -> resultsToMessages(...) executor.ts:638`：`docs/architecture/02-tool-system.md:44`、`docs/architecture/02-tool-system.md:49`。

### 4. 结论

确证为维护债。helper 的转换确实落后于当前 `tool_result` 契约；但 production 源码排除 helper 定义后没有调用点，TurnLoop 主链路使用的是正确的 `toolResultToBlock()`。因此原观察的“契约漂移”成立，“未被主链路调用”也成立。

### 5. 严重度校准

P3。不是当前 runtime bug，不能列 P1/P2；但 stale helper 和旧架构文档会误导后续重构，把 image result 或 error semantics 回退成旧形状，仍应作为维护债处理。

修复方向：删除 `resultsToMessages()`，或让它委托 `toolResultToBlock()` / 共享转换函数；同步更新 `docs/architecture/02-tool-system.md`。

## 自查

1. register 中本轮原为「仅观察」的 N 条目已全部覆盖：N-04、N-05、N-07、N-08、N-09。
2. 本轮没有新升到 P1 的项。
3. 每条结论均有 file:line 证据；N-08 的用户期望风险未当作确证，标为部分成立。
4. 未跑构建/测试，未修改 `packages/**`，未 commit。
