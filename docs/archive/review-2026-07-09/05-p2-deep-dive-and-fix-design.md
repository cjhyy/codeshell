# P2 深挖与修复技术设计

本文只展开 `03-optimization-findings.md` 中 3 条 P2：F-05、F-07、F-08。P1 已在 `04-p1-deep-dive-and-fix-design.md` 展开。

边界约束沿用本目录既有文档：本轮只做修复设计，不写代码；core 不得 import tui；desktop renderer 不得 runtime import codeshell 包；`typecheck` 有存量错误，不作为修复设计的阻塞判据，见 `docs/review-2026-07-09/GUIDELINE.md:120`、`docs/review-2026-07-09/GUIDELINE.md:122`、`docs/review-2026-07-09/GUIDELINE.md:127`。

## F-05 `requireExisting` 先创建 live session 再拒绝缺失磁盘会话

### 1. 根因链

1. 协议契约要求 `requireExisting` 为 true 且磁盘会话不存在时返回 `SessionNotFound`，而不是创建空白会话执行任务，见 `packages/core/src/protocol/types.ts:108`、`packages/core/src/protocol/types.ts:109`、`packages/core/src/protocol/types.ts:110`、`packages/core/src/protocol/types.ts:113`。
2. `Engine.sessionExistsOnDisk()` 本身只是 stat probe，注释也说明它用于区分“恢复已有 session”和“静默创建 fresh empty one”，见 `packages/core/src/engine/engine.ts:905`、`packages/core/src/engine/engine.ts:906`、`packages/core/src/engine/engine.ts:912`、`packages/core/src/engine/engine.ts:913`。
3. 多会话 `AgentServer.handleRunMulti()` 在校验 `sessionId` / `task` 后，先调用 `cm.getOrCreate(params.sessionId, ...)`，见 `packages/core/src/protocol/server.ts:394`、`packages/core/src/protocol/server.ts:411`、`packages/core/src/protocol/server.ts:413`、`packages/core/src/protocol/server.ts:417`。
4. `ChatSessionManager.getOrCreate()` 的不存在分支会打开 session path approvals、创建 Engine、创建 `ChatSession`，并写入 `sessions` map，见 `packages/core/src/protocol/chat-session-manager.ts:53`、`packages/core/src/protocol/chat-session-manager.ts:54`、`packages/core/src/protocol/chat-session-manager.ts:78`、`packages/core/src/protocol/chat-session-manager.ts:80`。
5. `requireExisting` 检查发生在 session 已创建之后；失败时 server 只发送 `SessionNotFound` 并 return，没有 `cm.close(params.sessionId)` 或其它清理，见 `packages/core/src/protocol/server.ts:424`、`packages/core/src/protocol/server.ts:429`、`packages/core/src/protocol/server.ts:430`、`packages/core/src/protocol/server.ts:437`。
6. 因此当前实现已经做到“不 run”，但没有做到“不创建 live 空 session”。现有测试只断言错误码和 `state.runs === 0`，没有断言 `chatManager.get("gone-sid") === undefined`，见 `packages/core/src/protocol/server.require-existing.test.ts:61`、`packages/core/src/protocol/server.require-existing.test.ts:78`、`packages/core/src/protocol/server.require-existing.test.ts:80`。
7. 这会占用 `maxSessions` 名额，因为 manager 在创建前才检查 `sessions.size >= maxSessions`，见 `packages/core/src/protocol/chat-session-manager.ts:73`、`packages/core/src/protocol/chat-session-manager.ts:76`。03 已将该问题定性为“protocol 能做到不 run，但仍可能把一个空 ChatSession 留在 manager 里”，见 `docs/archive/review-2026-07-09/03-optimization-findings.md:56`、`docs/archive/review-2026-07-09/03-optimization-findings.md:58`、`docs/archive/review-2026-07-09/03-optimization-findings.md:59`。

### 2. 复现/触发路径

1. 用 `ChatSessionManager` 启动多会话 `AgentServer`，目标 `sessionId` 不在 live map，也不在磁盘。
2. 发送 `agent/run`，参数为 `{ sessionId:"gone-sid", task:"continue", requireExisting:true }`。现有测试已经构造了同类请求，见 `packages/core/src/protocol/server.require-existing.test.ts:70`、`packages/core/src/protocol/server.require-existing.test.ts:74`。
3. `handleRunMulti()` 先进入 `cm.getOrCreate("gone-sid", ...)`，manager 创建并保存 session，见 `packages/core/src/protocol/server.ts:411`、`packages/core/src/protocol/chat-session-manager.ts:78`、`packages/core/src/protocol/chat-session-manager.ts:80`。
4. 随后 `session.engine.sessionExistsOnDisk("gone-sid")` 返回 false，server 发送 `ErrorCodes.SessionNotFound` 并 return，见 `packages/core/src/protocol/server.ts:429`、`packages/core/src/protocol/server.ts:433`、`packages/core/src/protocol/server.ts:437`。
5. 由于没有 enqueue turn，engine `run()` 不执行；这部分已经由 `expect(state.runs).toBe(0)` 覆盖，见 `packages/core/src/protocol/server.require-existing.test.ts:80`。
6. 但因为失败路径没有 close，`chatManager.get("gone-sid")` 会返回刚才创建的空 session（该结论由 `getOrCreate()` 写 map 与失败分支未清理共同推出，见 `packages/core/src/protocol/chat-session-manager.ts:80`、`packages/core/src/protocol/server.ts:437`）。

### 3. 影响边界

1. 影响 protocol 多会话 `agent/run` 路径；`requireExisting` 的检查位于 `handleRunMulti()`，而 `handleRun()` 在有 `chatManager` 时才进入该分支，见 `packages/core/src/protocol/server.ts:385`、`packages/core/src/protocol/server.ts:388`、`packages/core/src/protocol/server.ts:394`、`packages/core/src/protocol/server.ts:424`。
2. 主要风险是资源和隔离语义，不是“任务被执行”：现有测试证明 `run()` 未调用，见 `packages/core/src/protocol/server.require-existing.test.ts:80`。
3. 空 session 会打开 path approval session 桶，创建 Engine，并占用 manager 容量；创建与 approval 打开见 `packages/core/src/protocol/chat-session-manager.ts:54`、`packages/core/src/protocol/chat-session-manager.ts:78`、`packages/core/src/protocol/chat-session-manager.ts:80`，容量检查见 `packages/core/src/protocol/chat-session-manager.ts:73`。
4. 同文件已有一个更接近目标语义的参照：`agent/query compact` 先查 live session，再用 probe engine 判断磁盘存在性，磁盘不存在时直接返回 `SessionNotFound`，不创建 chat session；测试还断言 manager 里没有该 id，见 `packages/core/src/protocol/server.ts:1360`、`packages/core/src/protocol/server.ts:1363`、`packages/core/src/protocol/server.compact.test.ts:165`、`packages/core/src/protocol/server.compact.test.ts:186`。

### 4. 修复方案

1. 修改 `packages/core/src/protocol/server.ts` 的 `handleRunMulti()`：在调用 `cm.getOrCreate()` 前增加 `requireExisting` preflight。
2. 推荐逻辑：
   - 校验 `sessionId` / `task` 后，如果 `params.requireExisting === true && !cm.get(params.sessionId)`，先用 probe engine 判断磁盘存在性。
   - probe engine 可复用当前 `anyEngine()`，它会优先取已有 session engine，其次取 `globalQueryEngine`，最后用 manager factory 创建一个不进入 `sessions` map 的 query engine，见 `packages/core/src/protocol/server.ts:2279`、`packages/core/src/protocol/server.ts:2283`、`packages/core/src/protocol/server.ts:2284`、`packages/core/src/protocol/server.ts:2290`。
   - 若 `!probeEngine?.sessionExistsOnDisk(params.sessionId)`，直接发送 `SessionNotFound` 并 return，不调用 `cm.getOrCreate()`。
   - 若磁盘存在，继续走原来的 `cm.getOrCreate()`，保留现有创建、permissionMode 重应用、path approval 打开行为。
3. 保留 `cm.getOrCreate()` 对 live session 的 per-send permission mode 重应用。当前这段逻辑在 existing 分支内，见 `packages/core/src/protocol/chat-session-manager.ts:55`、`packages/core/src/protocol/chat-session-manager.ts:64`、`packages/core/src/protocol/chat-session-manager.ts:69`；因此不建议用 `cm.get()` 直接替代整个创建路径。
4. 不推荐只在失败后追加 `cm.close(params.sessionId)` 作为最终方案。它能清理 map、path approvals、credential approvals 和 MCP owner，见 `packages/core/src/protocol/chat-session-manager.ts:98`、`packages/core/src/protocol/chat-session-manager.ts:102`、`packages/core/src/protocol/chat-session-manager.ts:106`，但仍会先创建 Engine 和打开 approval 桶，不能完全满足“不创建空白会话”的语义。
5. 如果担心 preflight 与后续 `Engine.run()` 之间存在磁盘会话被删除的 TOCTOU，保留现有 `Engine.run()` resume 失败处理即可；本条 P2 只修复“已知缺失时先创建 live session”的顺序问题。

### 5. TDD 测试点

1. 扩展 `packages/core/src/protocol/server.require-existing.test.ts`：
   - 场景：磁盘不存在，发送 `agent/run` with `requireExisting:true`。
   - 断言：错误码仍是 `ErrorCodes.SessionNotFound`；`state.runs === 0`；新增断言 `chatManager.get("gone-sid") === undefined`。
2. 在同一测试文件新增容量回归：
   - 场景：`ChatSessionManager({ maxSessions: 1 })`；先发送缺失 session 的 `requireExisting:true` 请求；再发送另一个普通 `agent/run`。
   - 断言：第一个请求返回 `SessionNotFound`；第二个请求不返回 `Overloaded`，且 fake engine `run()` 被调用一次。
3. 保留并扩展“磁盘存在时正常运行”的测试：
   - 场景：`sessionExistsOnDisk()` 返回 true。
   - 断言：`state.runs === 1`；`chatManager.get("live-sid")` 已存在；`lastError(sent) === undefined`。现有基础断言见 `packages/core/src/protocol/server.require-existing.test.ts:83`、`packages/core/src/protocol/server.require-existing.test.ts:100`、`packages/core/src/protocol/server.require-existing.test.ts:101`。
4. 可参考 `packages/core/src/protocol/server.compact.test.ts` 的 unknown id 测试：
   - 场景：unknown compact session。
   - 已有断言：`SessionNotFound` 且 `chatManager.get("missing-session") === undefined`，见 `packages/core/src/protocol/server.compact.test.ts:165`、`packages/core/src/protocol/server.compact.test.ts:185`、`packages/core/src/protocol/server.compact.test.ts:186`。

### 6. 风险与回归面

1. `anyEngine()` 可能创建 `globalQueryEngine`，见 `packages/core/src/protocol/server.ts:2284`、`packages/core/src/protocol/server.ts:2290`。这比创建 chat session 半径小，但仍是 Engine 实例化；测试 fake factory 要覆盖该路径。
2. 不能破坏 live session 的 `permissionMode` 重应用；这曾是明确修复点，见 `packages/core/src/protocol/chat-session-manager.ts:58`、`packages/core/src/protocol/chat-session-manager.ts:63`、`packages/core/src/protocol/chat-session-manager.permission.test.ts:115`、`packages/core/src/protocol/chat-session-manager.permission.test.ts:119`。
3. 不能把“不存在”误判为“可新建”：`requireExisting:false` 仍必须保持 resume-or-create 行为，现有测试见 `packages/core/src/protocol/server.require-existing.test.ts:104`、`packages/core/src/protocol/server.require-existing.test.ts:117`、`packages/core/src/protocol/server.require-existing.test.ts:121`。
4. 如果后续把 probe 封装到 `ChatSessionManager`，要避免 manager 直接依赖 `Engine.sessionExistsOnDisk()` 之外的更大 Engine 表面；A1 已记录 manager/Engine 边界，见 `docs/archive/review-2026-07-09/01-core-engine-structure.md:225`、`docs/archive/review-2026-07-09/01-core-engine-structure.md:235`。

## F-07 builtin capability 的 `off` 可热生效，`on` 受构造期 frozen registry 限制

### 1. 根因链

1. 能力控制层允许项目级 override 写到 `capabilityOverrides.builtin.<token>`；`setEnabled(..., { scope:"project" })` 会转成 `setOverride(id, "on" | "off")`，见 `packages/core/src/capability-control/service.ts:123`、`packages/core/src/capability-control/service.ts:125`、`packages/core/src/capability-control/service.ts:127`、`packages/core/src/capability-control/service.ts:130`。
2. `CapabilityService.setOverride()` 注释明确说 all capability kinds 包括 builtin 都支持 project overrides，见 `packages/core/src/capability-control/service.ts:136`、`packages/core/src/capability-control/service.ts:138`、`packages/core/src/capability-control/service.ts:139`、`packages/core/src/capability-control/service.ts:143`。
3. builtin override 的合并语义在 `effectiveBuiltinLists()` 中是三态覆盖：`on` 加入 enabled、移出 disabled；`off` 加入 disabled、移出 enabled，见 `packages/core/src/capability-control/overlay.ts:120`、`packages/core/src/capability-control/overlay.ts:123`、`packages/core/src/capability-control/overlay.ts:136`、`packages/core/src/capability-control/overlay.ts:141`。
4. Engine 构造期会读取 `readBuiltinOverride(config.cwd)` 并生成 builtinLists，然后用 `resolveBuiltinToolNames()` 构造 `ToolRegistry`，见 `packages/core/src/engine/engine.ts:562`、`packages/core/src/engine/engine.ts:578`、`packages/core/src/engine/engine.ts:580`、`packages/core/src/engine/engine.ts:582`。
5. 构造期注释已明确这是 frozen builtin tool set：`on` 能在构造时把全局禁用工具 force-enable 进集合，但 mid-session 的 `on` 无法把不在 registry 的工具加回来，需要 session restart，见 `packages/core/src/engine/engine.ts:569`、`packages/core/src/engine/engine.ts:573`、`packages/core/src/engine/engine.ts:575`、`packages/core/src/engine/engine.ts:576`。
6. 每 turn 的动态路径只做过滤：`applyBuiltinOverrideVisibility()` 对 `off` 过滤工具，对 `on` / `inherit` 只是 keep；注释同样写明“can't re-add a tool the ctor-frozen registry omitted”，见 `packages/core/src/engine/engine.ts:267`、`packages/core/src/engine/engine.ts:270`、`packages/core/src/engine/engine.ts:271`、`packages/core/src/engine/engine.ts:280`。
7. `run()` 每 turn 重新读取 override，并把 `off` 同时转成 executor 执行期 gate；但 `allToolDefs` 的来源仍是当前 registry，所以缺失工具不能被 `on` 加回，见 `packages/core/src/engine/engine.ts:1754`、`packages/core/src/engine/engine.ts:1761`、`packages/core/src/engine/engine.ts:1771`、`packages/core/src/engine/engine.ts:1808`。
8. `ToolRegistry` 的 builtin 注册只在 constructor 里调用 `registerBuiltins()`；后续 `getToolDefinitions()` 只是返回 map 里已有工具，见 `packages/core/src/tool-system/registry.ts:26`、`packages/core/src/tool-system/registry.ts:27`、`packages/core/src/tool-system/registry.ts:69`、`packages/core/src/tool-system/registry.ts:74`。
9. 因此这条不是隐藏的实现 bug，而是代码注释承认的折中。03 把它归为 P2，理由是设置语义不对称、排障成本增加，见 `docs/archive/review-2026-07-09/03-optimization-findings.md:74`、`docs/archive/review-2026-07-09/03-optimization-findings.md:76`、`docs/archive/review-2026-07-09/03-optimization-findings.md:77`。

### 2. 复现/触发路径

1. 构造一个 Engine，其 builtin set 中不包含某个工具，例如该工具被全局 `disabledBuiltinTools` 移除，或不在 preset effective builtin set 中。`resolveBuiltinToolNames()` 会先加 enabled，再按 disabled 删除，见 `packages/core/src/preset/index.ts:331`、`packages/core/src/preset/index.ts:341`、`packages/core/src/preset/index.ts:345`。
2. 同一个 session 运行期间，项目设置写入 `capabilityOverrides.builtin.<tool> = "on"`。desktop main 的 `capabilities:setOverride` IPC 会调用 `setCapabilityOverride(cwd, id, state)`，见 `packages/desktop/src/main/index.ts:1728`、`packages/desktop/src/main/index.ts:1734`；实际写入由 `CapabilityService.setOverride()` 完成，见 `packages/core/src/capability-control/service.ts:153`、`packages/core/src/capability-control/service.ts:156`。
3. 下一条消息进入同一个 Engine。`run()` 重新读取 builtin override，见 `packages/core/src/engine/engine.ts:1765`。
4. 如果 override 是 `on`，`applyBuiltinOverrideVisibility()` 不会过滤，但也无法把 registry 没有的工具加回；`allToolDefs` 仍来自 `this.toolRegistry.getToolDefinitions()`，见 `packages/core/src/engine/engine.ts:1808`、`packages/core/src/engine/engine.ts:1809`、`packages/core/src/engine/engine.ts:1810`。
5. 模型仍看不到该工具；如果模型直接点名该工具，`ToolRegistry.executeTool()` 会在 map 中找不到并抛 `ToolNotFoundError`，见 `packages/core/src/tool-system/registry.ts:90`、`packages/core/src/tool-system/registry.ts:92`。
6. 相反，从 `on` 或 inherit 热切到 `off` 能生效：工具列表被过滤，executor 还会因 `ctx.disabledBuiltins` 拒绝直接调用，见 `packages/core/src/engine/engine.ts:1771`、`packages/core/src/tool-system/executor.ts:139`、`packages/core/src/tool-system/executor.ts:145`、`packages/core/src/tool-system/executor.ts:149`。

### 3. 影响边界

1. 影响 builtin capability 的 mid-session enable，不影响 mid-session disable。现有测试已覆盖 `off` 可隐藏、执行期可拒绝，见 `packages/core/src/engine/__tests__/builtin-override-per-turn.test.ts:16`、`packages/core/src/engine/__tests__/builtin-override-per-turn.test.ts:19`、`packages/core/src/tool-system/__tests__/disabled-builtin-execution-gate.test.ts:47`、`packages/core/src/tool-system/__tests__/disabled-builtin-execution-gate.test.ts:65`。
2. 安全角度是 fail-closed：本该启用的工具继续不可用，而不是本该禁用的工具被放开。这也是本条保持 P2 的主要原因。
3. UX/配置角度存在不一致：能力列表可以把 project override 显示为 enabled，`CapabilityService.list()` 会按 override 计算 `enabled` 与 `effectiveSource`，见 `packages/core/src/capability-control/service.ts:105`、`packages/core/src/capability-control/service.ts:109`、`packages/core/src/capability-control/service.ts:112`、`packages/core/src/capability-control/service.ts:115`；但已存在 Engine 的工具 registry 不能热加入该 builtin。
4. 这条不应顺手扩展到 plugin hook：Engine 注释已说明 plugin hooks 的 override 也是 new sessions 生效，见 `packages/core/src/engine/engine.ts:605`、`packages/core/src/engine/engine.ts:607`。本条只讨论 03 指出的 builtin visibility / execution 语义。
5. 本条我判断不值得作为近期 core 重构强行修。依据是：限制已经被代码注释明示，且失败模式是工具继续不可用；完整热启用需要改 registry/visibility/executor 三层，半径明显大于收益。若产品必须承诺“启用后下一条消息可用”，再做长期方案。

### 4. 修复方案

1. 短期推荐方案：承认这是设计折中，把行为显式暴露为“启用 builtin 需要新 session / 重启，禁用下一条消息生效”。
   - 在 `packages/core/src/capability-control/types.ts` 的 `CapabilityDescriptor` 增加可选运行时提示字段，例如 `runtimeEffect?: "nextTurn" | "nextSession"` 或更具体的 `requiresNewSessionOnEnable?: boolean`。
   - 在 `packages/core/src/capability-control/service.ts` 生成 builtin descriptor 时，如果 `d.kind === "builtin"` 且项目 override 为 `on`、但该 builtin 不是当前 live Engine registry 的成员，则标记需要新 session。当前 service 只能看到 settings UI 临时 registry，见 `packages/desktop/src/main/capabilities-service.ts:29`、`packages/desktop/src/main/capabilities-service.ts:32`、`packages/desktop/src/main/capabilities-service.ts:35`；是否能准确判断 live Engine 缺失，需要 main 额外传入 active session registry 信息（这一点属于推测，因为当前 main service 注释说明它只看“configured on disk data”，见 `packages/desktop/src/main/capabilities-service.ts:4`、`packages/desktop/src/main/capabilities-service.ts:7`）。
   - 在 `packages/desktop/src/renderer/settings/CapabilitiesOverviewSection.tsx` 的 project override 操作后，展示该提示；当前保存后只 reload list，见 `packages/desktop/src/renderer/settings/CapabilitiesOverviewSection.tsx:205`、`packages/desktop/src/renderer/settings/CapabilitiesOverviewSection.tsx:209`。
2. 若只想避免误导，也可以不加 descriptor 字段，而是在 `packages/desktop/src/main/capabilities-service.ts` 或相关设置文案中把 builtin project `on` 标为 new-session 生效。这个方案不改变 core runtime，风险最低。
3. 长期对称热生效方案：拆分“工具定义注册全集”和“本 turn 可见/可执行集合”。
   - 修改 `packages/core/src/tool-system/registry.ts`，让 registry 能持有 host 支持的 builtin 全集，而不是只持有当前 preset/effective set。现有 constructor 只注册 selected builtins，见 `packages/core/src/tool-system/registry.ts:26`、`packages/core/src/tool-system/registry.ts:30`、`packages/core/src/tool-system/registry.ts:45`。
   - 在 `packages/core/src/engine/engine.ts` 每 turn 计算 `visibleBuiltinNames`，综合 preset、global enabled/disabled、project override、host desktop 特例和 feature flags；`allToolDefs` 从 registry 全集中按 `visibleBuiltinNames` 过滤。
   - 在 `packages/core/src/tool-system/context.ts` 增加 `allowedBuiltins` 或 `visibleBuiltins`，并在 `packages/core/src/tool-system/executor.ts` 早期 gate 中拒绝不在本 turn 可执行集合里的 builtin。不能只扩大 registry，否则模型记住隐藏工具名时可能绕过 prompt visibility；当前 executor 只处理 `disabledBuiltins`、goal-only、context guard、MCP 和 plan mode，见 `packages/core/src/tool-system/executor.ts:139`、`packages/core/src/tool-system/executor.ts:153`、`packages/core/src/tool-system/executor.ts:164`、`packages/core/src/tool-system/executor.ts:176`、`packages/core/src/tool-system/executor.ts:219`。
   - 保留 desktop host 特例：`resolveBuiltinToolNames()` 对 desktop 删除 `EnterWorktree` / `ExitWorktree` 并加入 `SwitchSessionWorkspace`，见 `packages/core/src/preset/index.ts:335`、`packages/core/src/preset/index.ts:338`。全集注册也不能让不适合 host 的工具可执行。
4. 不建议使用“每次设置变更后 rebuild 当前 session registry”的中间方案，除非先解决 runtime shared registry。Engine 可能复用 `config.runtime?.toolRegistry`，见 `packages/core/src/engine/engine.ts:582`、`packages/core/src/engine/engine.ts:583`；重建共享 registry 容易影响其它 session。

### 5. TDD 测试点

1. 短期提示方案的测试：
   - `packages/core/src/capability-control/service.test.ts`：构造 builtin descriptor，项目 override 为 `on`，断言新增的 runtime 提示字段存在；已有同文件覆盖 `setOverride 'off'` 与 project off list，见 `packages/core/src/capability-control/service.test.ts:335`、`packages/core/src/capability-control/service.test.ts:357`、`packages/core/src/capability-control/service.test.ts:361`、`packages/core/src/capability-control/service.test.ts:388`。
   - `packages/desktop/src/main/capabilities-service.test.ts`：断言 `listCapabilities(cwd)` 对 builtin project `on` 返回同样的 runtime 提示，避免 core descriptor 到 main forwarding 丢字段。现有 main service 直接返回 `CapabilityDescriptor[]`，见 `packages/desktop/src/main/capabilities-service.ts:50`、`packages/desktop/src/main/capabilities-service.ts:54`。
   - 若 renderer 有设置页测试，则在 `packages/desktop/src/renderer/settings/CapabilitiesOverviewSection` 相邻测试中断言该提示在 project view 可见；当前组件保存 override 后 reload，见 `packages/desktop/src/renderer/settings/CapabilitiesOverviewSection.tsx:205`、`packages/desktop/src/renderer/settings/CapabilitiesOverviewSection.tsx:209`。
2. 长期热启用方案的测试：
   - 新增 `packages/core/src/engine/__tests__/builtin-override-hot-on.test.ts`。
   - 场景：Engine 构造时某 builtin 不在 visible set；第一 turn 捕获 model 看到的 `toolDefs`，断言不包含该工具；写入 `.code-shell/settings.json` 使 `capabilityOverrides.builtin.<tool> = "on"`；第二 turn 捕获 `toolDefs`。
   - 断言：第二 turn 包含该工具，不需要重建 Engine。
3. executor gate 测试：
   - 扩展 `packages/core/src/tool-system/__tests__/disabled-builtin-execution-gate.test.ts` 或新增 `builtin-visibility-execution-gate.test.ts`。
   - 场景：registry 持有 `DangerTool`，但 `ctx.allowedBuiltins` 不包含它。
   - 断言：`executeSingle()` 返回 error，handler 不运行；当 `allowedBuiltins` 包含它时 handler 正常运行。现有 disabled gate 的 handler-not-run 断言可复用，见 `packages/core/src/tool-system/__tests__/disabled-builtin-execution-gate.test.ts:47`、`packages/core/src/tool-system/__tests__/disabled-builtin-execution-gate.test.ts:65`。
4. host 特例测试：
   - 扩展 `packages/core/src/preset` 或 Engine 相关测试，断言 desktop host 下 `EnterWorktree` / `ExitWorktree` 即使 registry 全集存在，也不进入 visible/executable set；host 特例源头见 `packages/core/src/preset/index.ts:335`、`packages/core/src/preset/index.ts:338`。

### 6. 风险与回归面

1. 长期方案的最大风险是扩大 registry 后漏掉执行期 allowlist gate，导致隐藏 builtin 可被直接调用。当前 `off` 的执行期 gate 是专门补上的，见 `packages/core/src/tool-system/executor.ts:139`、`packages/core/src/tool-system/executor.ts:145`。
2. runtime shared registry 会跨 session 复用，见 `packages/core/src/engine/engine.ts:582`、`packages/core/src/engine/engine.ts:583`。因此 visible/executable set 必须是 per-turn / per-session 状态，不能写成 registry 全局删除或全局启用。
3. 需要避免破坏已覆盖的 `off` 行为：`applyBuiltinOverrideVisibility()` 当前明确过滤 `off`，见 `packages/core/src/engine/engine.ts:275`、`packages/core/src/engine/engine.ts:280`；已有测试应继续通过。
4. 若选择短期提示方案，需要接受“启用需新 session”不是 runtime 修复。这个判断是工程取舍：基于本条 fail-closed、已有注释明示限制、完整修复半径较大；若产品承诺不同，应升级为长期方案。

## F-08 `tool_summary` 没有目标 id / agent 契约，desktop 只能挂到最近顶层工具

### 1. 根因链

1. `StreamEvent` 中 `tool_summary` 只有 `{ summary: string }`，没有 `toolCallId`、`toolCallIds`、`agentId` 或 turn/request id，见 `packages/core/src/types.ts:534`。
2. 相邻工具事件已有 agent 路由字段：`tool_use_start`、`tool_result` 都声明 `agentId?: string`，见 `packages/core/src/types.ts:453`、`packages/core/src/types.ts:460`。这说明工具事件家族并非不能携带 agent 归属。
3. TurnLoop 在每个工具结果发完 `tool_result` 后，异步生成工具批次 summary。代码把整个 `toolCalls` 和 `results` 数组传给 `generateToolUseSummary()`，但 emit 时只发 `{ type:"tool_summary", summary }`，见 `packages/core/src/engine/turn-loop.ts:1034`、`packages/core/src/engine/turn-loop.ts:1037`、`packages/core/src/engine/turn-loop.ts:1045`、`packages/core/src/engine/turn-loop.ts:1048`。
4. `tool-summary.ts` 文件头把它定义为“after tool batch execution”的一行 progress label；函数签名也接收 `toolCalls: ToolCall[]` 和 `results: ToolResult[]`，见 `packages/core/src/engine/tool-summary.ts:2`、`packages/core/src/engine/tool-summary.ts:20`、`packages/core/src/engine/tool-summary.ts:23`、`packages/core/src/engine/tool-summary.ts:25`。
5. 子 Engine 的 stream events 会经 parent wrapper 转发。同步子代理没有 `streamOverride` 时会 fall back 到 parent UI onStream；wrapper 对未过滤事件统一 spread `agentId: req.agentId`，见 `packages/core/src/engine/engine.ts:1219`、`packages/core/src/engine/engine.ts:1224`、`packages/core/src/engine/engine.ts:1226`、`packages/core/src/engine/engine.ts:1246`。
6. 但类型没有声明 `tool_summary.agentId`，desktop reducer 的注释也写着“tool_summary has no agentId in the StreamEvent type”，于是只从末尾找最近的顶层 `ToolMessage` 并写 `summary`，见 `packages/desktop/src/renderer/types.ts:650`、`packages/desktop/src/renderer/types.ts:651`、`packages/desktop/src/renderer/types.ts:654`、`packages/desktop/src/renderer/types.ts:657`。
7. 同一个 reducer 对 `tool_result.agentId` 已能路由到 agent card 内部 `toolCalls`，见 `packages/desktop/src/renderer/types.ts:630`、`packages/desktop/src/renderer/types.ts:637`、`packages/desktop/src/renderer/types.ts:639`；现有测试也覆盖 agent tool start/result 不产生顶层 tool message，见 `packages/desktop/src/renderer/types.test.ts:281`、`packages/desktop/src/renderer/types.test.ts:295`、`packages/desktop/src/renderer/types.test.ts:300`。
8. 结果是 `tool_summary` 与其它工具事件契约不一致。03 已记录：子代理 summary 可能误挂到主 feed 最近工具，或无顶层工具时丢失，见 `docs/archive/review-2026-07-09/03-optimization-findings.md:83`、`docs/archive/review-2026-07-09/03-optimization-findings.md:85`、`docs/archive/review-2026-07-09/03-optimization-findings.md:86`。

### 2. 复现/触发路径

1. 主 feed 已存在一个顶层工具消息，例如 `tool_use_start` / `tool_result` 创建并完成 `ToolMessage`；`ToolMessage.summary` 是 UI 用来展示自然语言摘要的字段，见 `packages/desktop/src/renderer/types.ts:67`、`packages/desktop/src/renderer/types.ts:81`。
2. 同一会话启动同步子代理。子代理工具事件经 parent wrapper 带上 `agentId`，见 `packages/core/src/engine/engine.ts:1246`。
3. 子代理工具执行完成后，child TurnLoop 的 fire-and-forget summary emit 运行。运行时事件可能带有 spread 出来的 `agentId`，但 `StreamEvent` 类型没有该字段，见 `packages/core/src/types.ts:534`、`packages/core/src/engine/engine.ts:1246`。
4. desktop reducer 收到该事件后进入 `tool_summary` 分支，不读取 `event.agentId`，只倒序找顶层 `m.kind === "tool"` 并写 summary，见 `packages/desktop/src/renderer/types.ts:650`、`packages/desktop/src/renderer/types.ts:654`、`packages/desktop/src/renderer/types.ts:656`、`packages/desktop/src/renderer/types.ts:657`。
5. 如果主 feed 有最近顶层工具，子代理 summary 会被写到这个主工具卡；如果没有顶层工具，循环结束后返回原 state，summary 丢失，见 `packages/desktop/src/renderer/types.ts:660`、`packages/desktop/src/renderer/types.ts:661`。
6. 推测：即使是顶层工具，fire-and-forget summary 也可能晚于后续工具事件到达；由于 payload 没有目标 id，desktop 只能按“到达时最近工具”挂载，存在挂到后一批工具的可能。这个风险来自 summary 链“non-blocking / fire-and-forget”的注释和无 id payload，见 `packages/core/src/engine/turn-loop.ts:1037`、`packages/core/src/engine/turn-loop.ts:1040`、`packages/core/src/types.ts:534`。

### 3. 影响边界

1. 直接影响普通 desktop renderer 的工具卡 summary；主链路归约位置是 `packages/desktop/src/renderer/types.ts`，A2 已校正普通 desktop 不走 `lib/streamReducer.ts`，见 `docs/archive/review-2026-07-09/02-desktop-stream-walkthrough.md:75`、`docs/archive/review-2026-07-09/02-desktop-stream-walkthrough.md:78`。
2. 影响子代理 inline card 的工具摘要。`AgentMessage.toolCalls` 是 agent card 内部工具列表，见 `packages/desktop/src/renderer/types.ts:100`、`packages/desktop/src/renderer/types.ts:122`、`packages/desktop/src/renderer/types.ts:123`；当前 `tool_summary` 没有写入这一路。
3. 不影响工具执行结果本身：`tool_result` 已有 id 和 agent route，见 `packages/core/src/types.ts:460`、`packages/desktop/src/renderer/types.ts:630`。这也是本条保持 P2 的原因。
4. `tool_summary` 是 best-effort observability；TurnLoop 注释明确该链路不应阻塞或导致 fatal rejection，见 `packages/core/src/engine/turn-loop.ts:1037`、`packages/core/src/engine/turn-loop.ts:1039`、`packages/core/src/engine/turn-loop.ts:1053`。修复不能把它改成 turn 关键路径。
5. mobile / CC Room 复用的 `packages/desktop/src/renderer/lib/streamReducer.ts` 也有“tool_summary carries no id; attach to last tool item”的逻辑，见 `packages/desktop/src/renderer/lib/streamReducer.ts:334`、`packages/desktop/src/renderer/lib/streamReducer.ts:335`。本轮范围是普通 desktop，但扩展事件契约时应评估是否同步兼容该 reducer。

### 4. 修复方案

1. 先定语义：`tool_summary` 当前生成自一批 `toolCalls/results`，更接近 batch summary，而不是单个 tool result summary，依据见 `packages/core/src/engine/tool-summary.ts:20`、`packages/core/src/engine/tool-summary.ts:23`、`packages/core/src/engine/tool-summary.ts:25`。
2. 最小兼容方案：扩展事件 payload，但保留旧字段可选。
   - 修改 `packages/core/src/types.ts`：把 `tool_summary` 改为 `{ type:"tool_summary"; summary:string; toolCallIds?: string[]; agentId?: string }`。
   - 修改 `packages/core/src/engine/turn-loop.ts`：在 `this.config.onStream?.({ type:"tool_summary", summary })` 处加入 `toolCallIds: toolCalls.map((t) => t.id)`。
   - `agentId` 不需要 child TurnLoop 自己设置；parent wrapper 已会 spread `agentId`，见 `packages/core/src/engine/engine.ts:1246`。类型补上是为了让 consumer 正确处理这个运行时事实。
3. 修改 `packages/desktop/src/renderer/types.ts` 的 `tool_summary` 分支：
   - 如果 `event.agentId` 存在，先按 `state.agentMessageIndex[event.agentId]` 找 agent message，再在 `m.toolCalls` 中按 `toolCallIds` 的最后一个 id 或全部 id 更新 summary。为了保持现有 UI 最小改动，推荐先把 batch summary 写到 `toolCallIds` 最后一个工具；未来若要 group-level summary，再改 `ToolGroup` / `TurnProcessGroup` 数据结构。
   - 如果没有 `agentId` 且有 `toolCallIds`，按 id 找顶层 tool message，而不是找“最近顶层工具”。
   - 如果没有 `toolCallIds`，保留旧 fallback：挂到最近顶层 tool，兼容历史 snapshot / 老 worker。
   - 如果有 `agentId` 但找不到 agent 或 tool id，不要 fallback 到顶层工具，避免把子代理 summary 写错位置。
4. 如果产品判断 `tool_summary` 只服务顶层工具卡，不服务子代理，则另一条更小方案是：在 `packages/core/src/engine/engine.ts` 的 child stream wrapper 中过滤 `event.type === "tool_summary"`，让子代理 summary 不进入主 feed。这个方案能避免误挂，但会继续丢失子代理工具摘要；由于 03 的问题包含“子代理 summary 可被误挂或丢失”，我不推荐把过滤作为最终方案，除非明确接受子代理不展示该摘要。
5. 不建议把 summary 生成改成同步等待。当前注释要求 fire-and-forget、失败不可影响 turn，见 `packages/core/src/engine/turn-loop.ts:1037`、`packages/core/src/engine/turn-loop.ts:1040`；修复目标是路由契约，不是让 summary 成为关键路径。

### 5. TDD 测试点

1. core 事件契约测试：新增或扩展 `packages/core/src/engine/turn-loop-summary-safety.test.ts`。
   - 场景：fake model 返回两个 tool call，fake `summarize` 返回 `"读了两个文件"`。
   - 断言：最终 emitted `tool_summary` 包含 `summary === "读了两个文件"`，并包含 `toolCallIds`，顺序等于两个 tool call id。
   - 现有测试已经验证 summary 链 crash-safe，可复用它的 microtask flush 模式，见 `packages/core/src/engine/turn-loop-summary-safety.test.ts:63`、`packages/core/src/engine/turn-loop-summary-safety.test.ts:75`、`packages/core/src/engine/turn-loop-summary-safety.test.ts:82`。
2. desktop 主工具 id 路由测试：扩展 `packages/desktop/src/renderer/types.test.ts`。
   - 场景：顶层 `tool_use_start(t1)`、`tool_result(t1)`、随后 `tool_use_start(t2)`、再收到 `tool_summary({ toolCallIds:["t1"], summary:"summary-1" })`。
   - 断言：`t1.summary === "summary-1"`；`t2.summary` 仍为空，证明不再按“最近工具”误挂。
3. desktop 子代理路由测试：同文件扩展 subagent isolation describe。
   - 场景：先有顶层工具 `main1`；再 `agent_start(A)`、`tool_use_start({ agentId:"A", id:"a1" })`、`tool_result({ agentId:"A", id:"a1" })`、`tool_summary({ agentId:"A", toolCallIds:["a1"], summary:"child-summary" })`。
   - 断言：`findAgent(s,"A").toolCalls[0].summary === "child-summary"`；顶层 `main1.summary` 未改变。现有 agent tool routing 测试位置见 `packages/desktop/src/renderer/types.test.ts:281`、`packages/desktop/src/renderer/types.test.ts:300`。
4. legacy 兼容测试：
   - 场景：旧事件 `{ type:"tool_summary", summary:"old" }`，没有 `toolCallIds` / `agentId`。
   - 断言：仍挂到最近顶层 tool，保持现有行为；当前旧行为在 `packages/desktop/src/renderer/types.ts:650`、`packages/desktop/src/renderer/types.ts:657`。
5. 可选同步 `lib/streamReducer.test.ts`：
   - 如果本轮修复也覆盖 mobile/CC Room reducer，则把 `packages/desktop/src/renderer/lib/streamReducer.test.ts` 的“tool_summary 挂到最后一个 tool”测试扩展为 id 优先、无 id fallback，当前测试见 `packages/desktop/src/renderer/lib/streamReducer.test.ts:98`、`packages/desktop/src/renderer/lib/streamReducer.test.ts:103`。

### 6. 风险与回归面

1. `StreamEvent` 类型扩展需要兼容旧 snapshot / 老 worker：`toolCallIds` 和 `agentId` 应保持可选；无 id 时保留 legacy fallback。
2. 子代理事件的 `agentId` 目前来自 parent wrapper 的 spread 和 type cast，见 `packages/core/src/engine/engine.ts:1246`。给 `tool_summary` 类型补 `agentId` 是收敛事实，但要确认其它 consumer 不把它当顶层事件。
3. batch summary 写到最后一个 tool 是 UI 最小改动，不是完美语义。若要真正 group-level summary，需要改 `ToolGroup` / `TurnProcessGroup` 数据结构；A2 说明分组逻辑集中在 `streamGroups.ts`，见 `docs/archive/review-2026-07-09/02-desktop-stream-walkthrough.md:99`、`docs/archive/review-2026-07-09/02-desktop-stream-walkthrough.md:103`、`docs/archive/review-2026-07-09/02-desktop-stream-walkthrough.md:111`、`docs/archive/review-2026-07-09/02-desktop-stream-walkthrough.md:115`。
4. summary 仍可能在 `turn_complete` 后到达；reducer 按 id 更新已有 message 应能处理，但测试要覆盖“summary 晚到仍更新目标 tool”。不能因为它晚到而 bump `turnEpoch` 或改变折叠边界。
5. 不要让 summary 失败影响工具结果或 turn 完成；当前 catch 明确吞掉失败并打 warning，见 `packages/core/src/engine/turn-loop.ts:1052`、`packages/core/src/engine/turn-loop.ts:1054`。

## 自查

1. 覆盖范围：已覆盖全部 3 条 P2 finding：F-05、F-07、F-08。
2. 小节完整性：每条 P2 均包含根因链、复现/触发路径、影响边界、修复方案、TDD 测试点、风险与回归面。
3. 溯源性：事实结论均锚定到源码或 03/02/GUIDELINE；只有 F-07 短期提示方案需要 active session registry 信息、F-08 fire-and-forget 乱序挂载用「推测」标注。
4. P2 取舍：F-07 判断为已知设计折中，不建议近期强推 core 长期重构；可先做“启用需新 session”的显式提示。
5. 边界约束：本文只给修复设计，未要求改 tui/cdp/mobile 主链路，未要求 desktop renderer runtime import codeshell 包。
