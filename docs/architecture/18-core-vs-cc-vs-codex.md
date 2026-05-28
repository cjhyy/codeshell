# Core 内核架构对比：codeshell vs Claude Code vs Codex

> **Date:** 2026-05-27
> **Scope:** `packages/core` 逐模块 review，与 Claude Code、Codex（codex-rs）内核对比，标注 drift 与改进点。
> **方法:** codeshell 列基于真实 `.ts` 源码（file:line 已核对，非 dist）。CC 列参照 [`../claude-code-architecture.md`](../claude-code-architecture.md) 与官方文档；Codex 列参照 codex-rs 公开架构资料。
> **配套:** sub-agent 专项见 [`../subagent-design-comparison-2026-05-27.md`](../subagent-design-comparison-2026-05-27.md) 及其实现计划 [`../superpowers/plans/2026-05-27-subagent-redesign.md`](../superpowers/plans/2026-05-27-subagent-redesign.md)。

---

## 0. TL;DR

三家都是同一个骨架：**分层配置 → Engine/Session → turn loop（LLM↔工具循环）→ 工具执行（带权限/沙箱）→ 上下文压缩**。差异在“成熟度”与“边界清晰度”：

- **codeshell** 模块划分最细（25 个模块），且**已经把 CC 的关键设计学到位**——protocol 网关（强制 `engine.run` 走 AgentServer/AgentClient）、三层上下文压缩、权限“只降不升”硬化、多 OS 沙箱。它的独特资产是 **Arena（多模型协作，9000+ 行）** 和 **RunManager（托管 run 生命周期）**，这两块 CC/Codex 都没有对等物。
- **Claude Code** 是 codeshell 的主要蓝本，胜在**声明式扩展**（`.claude/agents`、subagent 自动委派、`model` 成本路由）和 context 节流的工程打磨。
- **Codex** 是 Rust 内核，胜在**沙箱严格度**（进程树级隔离、Landlock+seccomp）和**异步 submit/event 模型**（渲染层与 agent loop 完全解耦），配置/审批用 OS 原语（`SandboxPolicy`）。

codeshell 真正的短板不在“缺机制”，而在三处：**① 公共 API 边界未收口**（`index.ts` 把内部/迁移 API 一起导出）；**② 子 agent 的定义层缺失**（见专项文档）；**③ 沙箱仅包 Bash，Write/Edit 与 plugin/settings shell hook 不走沙箱**（A6 待办）。

---

## 1. 模块划分总览

| 关注点 | codeshell（`packages/core/src`） | Claude Code | Codex（codex-rs crates） |
|---|---|---|---|
| Agent 编排 | `engine/`（engine.ts 编排 + turn-loop.ts 回合 FSM，3629 loc） | 单一 agent loop + subagent | `codex-core`（ThreadManager / CodexThread / Session） |
| 协议/网关 | `protocol/`（AgentServer + AgentClient，JSON-RPC，2291 loc） | 内部 query 状态机 | `codex-protocol`（Op / EventMsg 异步 submit/event） |
| 配置 | `settings/`（zod schema + 5 层 merge，534 loc） | `settings.json` 多层 merge | `codex-config`（TOML 5 层 ConfigBuilder） |
| 会话持久化 | `session/`（state.json + transcript.jsonl，1028 loc） | session + transcript | `codex-state`（thread/rollout，`--ephemeral`） |
| 工具系统 | `tool-system/`（registry+executor+permission+sandbox+MCP，9166 loc） | tool registry + permission + MCP | `ToolRouter` + `UnifiedExecProcessManager` |
| 模型层 | `llm/`（ModelPool + ProviderCatalog + capability，2862 loc） | 内部 model client | 内置 provider（GPT 家族为主） |
| 上下文压缩 | `context/`（三层 micro/summary/window） | 三层 compaction | `codex-core` ContextManager（修过“summary of summaries”） |
| 扩展点 | `hooks/` `plugins/` `preset/` `skills/` | hooks + plugins + `.claude/agents` + skills | AGENTS.md + skills + subagents（TOML） |
| 托管运行 | `run/`（RunManager+Queue+Lock+Heartbeat，2539 loc） | — | `codex-exec`（headless，但无 RunManager 对等） |
| 多模型协作 | `arena/`（9073 loc，规划→并行研究→辩论→共识） | — | — |
| headless 入口 | `cli/` `protocol` in-process client | headless mode | `codex-exec` + `codex-app-server` |

**读法**：codeshell 的模块边界与 Codex 几乎一一对应（`protocol`↔`codex-protocol`，`settings`↔`codex-config`，`session`↔`codex-state`，`engine`↔`codex-core`），说明它走的是“CC 的设计哲学 + Codex 式的清晰分层”路线。`arena` 和 `run` 是 codeshell 独有的上层能力。

---

## 2. 逐模块对比

### 2.1 Engine / Turn Loop（执行核心）

| 维度 | codeshell | Claude Code | Codex |
|---|---|---|---|
| 编排入口 | `Engine.run(task, opts)`（engine.ts:505-1210）：image/noise 网关 → session resume/create → prompt/tools/context setup → 启动 TurnLoop | 单一 agent loop | `codex-core` Session，`Op::UserTurn` 驱动 |
| 回合循环 | `TurnLoop.run()`（turn-loop.ts:208-576）while 循环：pre-check 压缩 → LLM call（含 max_tokens continuation 3x）→ 工具执行 → post_compact hook | while needs_follow_up：history→LLM→tool→history | 同一 while 循环，异步 EventMsg 流式发出 |
| 取消/abort | `config.signal`（AbortSignal）级联；LLM call 后、tool 前检查一次（turn-loop.ts:385），工具内自查 | AbortController | `Op` 取消，事件驱动 |
| maxTurns | 默认 100（engine.ts:1183） | 有上限 | 有上限 |
| 上下文压缩触发 | TurnLoop pre-check 调 `ContextManager.manageAsync`（turn-loop.ts:260），85%→micro，92%→LLM summary | 三层 compaction | ContextManager 按 token 比率自动触发 |
| 渲染/loop 解耦 | 经 protocol 层 onStream 事件解耦（见 2.2） | query 状态机解耦 | **最彻底**：submit/event 异步模型，TUI 不同步调 core |

**codeshell 粗糙点**（来自源码）：
- `maxContextTokens` 默认硬编码 200k（engine.ts:272）——CC/Codex 倾向从模型动态取（Codex 默认 272K 可配到 1M）。
- max_tokens continuation 硬编码 3x retry（turn-loop.ts:348），不可配。
- abort 在回合内只检查一次（turn-loop.ts:385），长工具执行中的中止靠工具自觉。
- post_compact hook 用“漏斗”（`consumePendingCompactInfo`，turn-loop.ts:76）绕开 ContextManager→HookRegistry 的循环依赖——是 workaround，不是干净边界。

### 2.2 Protocol（网关层）—— codeshell 与 Codex 的共同选择

| 维度 | codeshell | Claude Code | Codex |
|---|---|---|---|
| 形态 | `AgentServer`/`AgentClient` JSON-RPC 2.0（protocol/types.ts:25-51） | 内部 query/状态机 | `codex-protocol` Op/EventMsg |
| 为何强制走网关 | ADR（[doc 14](14-engine-call-paths.md)）：TaskManager 流订阅、status 通知、in-process 重入保护（pendingApprovals + abortController）。`lint:engine-bypass` 守卫禁止直调 `engine.run`（SDK 除外） | — | app-server dispatch 到 core，client 异步消费 |
| 多会话 | `ChatSessionManager` getOrCreate(sid)（server.ts:173） | 单会话为主 | ThreadManager 多 thread |
| 子 agent 例外 | 子 agent 仍走 `new Engine` cloning，不经 ChatSessionManager（engine.ts:611+）——刻意避免嵌套 AgentServer 开销 | subagent 独立 context | subagent TOML 定义 |

**评价**：这是 codeshell 学 CC/Codex 学得最好的一处——把“所有执行走统一协议”做成了带 lint 守卫的硬约束。**粗糙点**：`Methods.Query` 返回 `unknown`（类型不统一）；approval timeout 硬编码 5 分钟（server.ts:69）；ChatSessionManager 与 legacy path 共存，维护面偏大。

### 2.3 工具系统 + 权限 + 沙箱

| 维度 | codeshell | Claude Code | Codex |
|---|---|---|---|
| 注册/执行分离 | `ToolRegistry`（只存定义）+ `ToolExecutor`（6 检查点执行链，executor.ts:39-547） | registry + permission 分离 | `ToolRouter` 统一路由 |
| 权限决策 | `PermissionClassifier.classify()` 返回 allow/deny/ask（permission.ts:639）：规则 > Bash 命令分类器 > 模式默认 | 规则 + 模式 | `SandboxPolicy` + 审批模式 |
| Bash 命令分类 | `scanShellCommand()` 三段式扫描器，逐段取最小安全级（permission.ts:417-512） | 命令分类 | 不按命令分类，靠沙箱兜底 |
| Hook 改权限 | **只降不升**：`clampHookDecision`（executor.ts:28-37）拒绝 hook 把决策升到 allow，记日志 `permission.hook_upgrade_rejected` | — | — |
| 沙箱后端 | seatbelt(macOS)/bwrap(Linux)/off，auto 选择（sandbox/index.ts:156），writableRoots + deniedReads（~/.ssh、~/.aws 拒读） | OS 沙箱 | **进程树级**：sandbox-exec / Landlock+seccomp / Windows restricted token，覆盖整个子进程树 |
| 沙箱覆盖范围 | **仅 Bash 命令**；Write/Edit 走权限门不走沙箱 | — | 所有 tool 命令的进程树 |
| 并发 | safe 工具并行、unsafe 串行（executor.ts:495） | 并发安全标记 | — |
| MCP | `mcp_${server}_${tool}` 动态注册，默认 `permissionDefault="ask"`（mcp-manager.ts:50） | MCP servers | MCP 支持 |

**codeshell 关键差距 vs Codex**：
1. **沙箱只包 Bash**。Codex 把沙箱套在“tool call 产生的整个进程树”，防止后台 worker 逃逸；codeshell 的 Write/Edit 以及 **plugin/settings shell hook 完全不走沙箱**（见 2.5）——这正是仓库自己标的 **A6（SafeSpawn）P0 待办**（见 [stabilization-followups](../superpowers/plans/2026-05-26-core-stabilization-followups.md)）。
2. **`acceptEdits` 模式下分类器 fallback 放行所有非 Bash 工具**（doc 15 已记录的风险点）。
3. Bash 扫描器虽细但有遗漏（如 `less /etc/shadow` 被当 safe-read）。

**codeshell 领先处**：hook“只降不升”的硬化（A1）比 CC 文档化的更显式，是个干净的安全不变量。

### 2.4 Hooks 系统

| 维度 | codeshell | Claude Code | Codex |
|---|---|---|---|
| 事件点 | 16 个（events.ts:76-92）：session/turn/tool 链（pre_tool_use→on_tool_start→on_tool_end→post_tool_use）/permission/notification/file_changed/post_compact | PreToolUse/PostToolUse/SessionStart 等 | 较少 |
| 事件名类型 | **封闭 union** `HookEventName`（events.ts:76）——加新事件要改 union | 字符串约定 | — |
| 能力 | decision（受 clamp 约束）/messages 注入/updatedInput 改参/additionalContext 追加/updatedPrompt/stop | 类似 | — |
| 错误隔离 | 单 handler 抛错被捕获、不断链（registry.ts:34-69） | — | — |
| emit 形态 | **async** `emit(): Promise<HookResult>`（registry.ts:27），串行聚合 | — | — |

**对比要点**：codeshell 的 hook 系统**几乎是 CC 的超集**（CC 兼容的 PreToolUse/PostToolUse 映射见 2.5），且加了 `post_compact`、错误隔离、只降不升。封闭 union 的取舍是类型安全换灵活性——加 sub-agent 生命周期事件时要么扩 union、要么复用 `notification`+kind（后者是现有约定，agent.ts:240）。

### 2.5 Plugins（CC 兼容）—— 安全边界的薄弱点

| 维度 | codeshell | Claude Code | Codex |
|---|---|---|---|
| 加载源 | `~/.claude/plugins/*/hooks/hooks.json`（loadPluginHooks.ts:145），CC 事件名映射（PreToolUse→pre_tool_use） | 原生 | — |
| 命令执行 | `spawn(cmd, {shell:true})`（pluginCommandHook.ts:89），剥离 `CLAUDE_PLUGIN_ROOT` 注入 `CODESHELL_PLUGIN_ROOT` | 原生 spawn | — |
| 信任模型 | **用户安装即信任**：无权限分类、无沙箱（[doc 17](17-plugin-shell-hook-trust-model.md)）；护栏仅 60s timeout + fail-silent | 同 | — |
| 绕过安全边界？ | **是**：plugin/settings shell hook 自己 spawn 子进程，绕过 Bash 的权限分类 + 沙箱 + abort + 输出 cap | — | Codex 无插件 shell hook 这类面 |

**这是 codeshell 当前最大的安全开口**，也是 A6 待办的核心：A1/A2 把 Bash 路径锁死了，但一个 plugin 的 shell hook 就能绕过全部。Codex 因为没有“用户脚本 hook 直接 spawn”这种扩展面，且沙箱覆盖进程树，天然没这个洞。**改进方向**：把所有子进程 spawn 收敛到统一 `SafeSpawn`（权限/沙箱/abort/输出 cap 一处实现），plugin/settings hook 也走它。

### 2.6 模型层（LLM / ModelPool / ProviderCatalog）

| 维度 | codeshell | Claude Code | Codex |
|---|---|---|---|
| Provider 抽象 | **Kind × Protocol 双层**：kind（openai/anthropic/deepseek/google/xai...）决定能力查询，protocol（openai-compat / anthropic-style）决定 client 类型（provider-catalog.ts） | 内部 client | GPT 家族为主，少多 provider |
| 多模型池 | `ModelPool`：key→ModelEntry→`resolveLLMConfig(key, base)`（model-pool.ts:279）；context window 4 级 resolve（内置→provider 缓存→OpenRouter 快照→200k 兜底） | — | profile 切换 |
| 能力判定 | `capabilitiesFor(kind, model)` 规则表（capabilities/rules.ts）：supportsVision / tokenLimitField / rejectedParams / reasoning | — | 内置已知 |
| thinking 控制 | 三层 override：entry > catalog > base（DeepSeek V4 Pro/Flash 可分别开关） | — | reasoning_effort |
| streaming | `runStreamWithWatchdog` idle-timeout 防守（providers/openai.ts:47） | stream | EventMsg delta |
| 成本 | `LLMClientBase.onUsage` 静态钩子上报 token；**只记 token 不记费用**（pricing 表缺） | — | — |

**评价**：codeshell 的多 provider/多模型层是三家里**最强的**——CC 基本绑 Anthropic，Codex 基本绑 GPT，codeshell 真正做了 kind×protocol 的可插拔（这也是它能轻松实现“父 DeepSeek / 子 Flash”路由的底气，见 sub-agent 专项）。**粗糙点**：`OPENROUTER_VENDOR_BY_KIND` 表需手动与 `PROVIDER_KINDS` 同步；context window 4 级 resolve 偏复杂；无 pricing 绑定。

### 2.7 配置 / 会话持久化

| 维度 | codeshell | Claude Code | Codex |
|---|---|---|---|
| 配置格式 | JSON（zod schema，schema.ts:6-283），passthrough 允许未知字段 | JSON | TOML |
| merge 层级 | 5 层：managed < user < project < local < flag（manager.ts:62-138） | 多层 | 5 层：defaults < user < project < env < flag |
| scope 隔离 | full/project/isolated——防 SDK 嵌入时误继承宿主 `~/.code-shell`（manager.ts） | — | — |
| 写入约束 | 只能 `saveUserSetting`，无 saveProjectSetting（防污染版本库） | — | — |
| 会话存储 | state.json（快照）+ transcript.jsonl（事件流）分离；saveState 原子写 rename（session-manager.ts:115） | session + transcript | rollout 文件，`--ephemeral` 可不落盘 |
| 恢复 | `repairToolResultPairs()` 修复孤立 tool_call（transcript.ts:158） | — | summary 保留近期 |

**评价**：codeshell 的配置分层与 Codex 几乎同构（5 层），且多了 **scope 隔离**（SDK 友好）和**只写 user 不写 project**（防版本库污染）两个细节，是亮点。`activeKey` 与 legacy `model` 字段双写是个一致性风险点（manager.ts 已收敛到单点，但易踩）。

### 2.8 codeshell 独有：Arena + RunManager

CC 和 Codex 都没有对等物，这是 codeshell 的差异化资产：

- **Arena**（9073 loc）：多模型协作分析——规划 → 证据提供 → 并行研究 → 交叉评审 → 辩论 → 裁决 → 共识。每个 participant 可用不同模型（复用 ModelPool）。这是 codeshell 把“多 provider 能力”变现的旗舰功能。
- **RunManager**（2539 loc）：托管 run 生命周期——`RunQueue`（FIFO+并发上限）+ `RunLock`（文件分布式锁）+ `Heartbeat`，状态机 queued→running→waiting_approval/input→completed/failed/cancelled，支持 in-process resolve 或跨进程 re-queue 两种恢复路径。对标的是“CI/批量/远程托管执行”，CC/Codex 的 headless 模式都没做到这个生命周期管理深度。

**风险**：这两块各占 ~9k/2.5k 行，是维护面大头；Arena 的 model pool resolve 与 settings 校验有静默降级（doc 已记）。

---

## 3. 改进点汇总（按优先级）

> 与既有 review（[doc 15](15-current-review-and-bug-inventory.md)）和 [stabilization-followups](../superpowers/plans/2026-05-26-core-stabilization-followups.md) 对齐，不重复其全部条目，只列“对比后凸显”的。

### P0 — 安全边界

1. **SafeSpawn 统一封装**（= A6）：plugin/settings shell hook 当前绕过 Bash 的权限/沙箱/abort/输出 cap。把所有子进程 spawn 收敛到一处。**对比依据**：Codex 沙箱覆盖整个进程树，codeshell 只包 Bash —— 这是三家里最明显的安全差距。
2. **`acceptEdits` 分类器 fallback**：当前放行所有非 Bash 工具，收紧为显式白名单。

### P1 — 边界清晰度

3. **公共 API 收口**：`packages/core/src/index.ts` 把 stable SDK / experimental / internal（迁移、TUI 支持）API 混在一个导出面（README 已自承）。拆成 stable/experimental/internal 子路径。**对比依据**：Codex 的 crate 边界（core/protocol/config/state）天然区分了公共与内部；codeshell 是单包，需要靠导出面纪律。
4. **sub-agent 定义层**：见 [专项文档](../subagent-design-comparison-2026-05-27.md)——补 `.code-shell/agents/*.md` 角色注册表 + per-agent 工具白名单/模型路由。**对比依据**：CC 的 `.claude/agents` 与 Codex 的 `.codex/agents/*.toml` 都有声明式角色，codeshell 缺。

### P2 — 工程打磨

5. **`maxContextTokens` 动态化**：从模型能力取，替代硬编码 200k（Codex 默认 272K 可到 1M）。
6. **pricing 绑定**：`onUsage` 只记 token，补一张 pricing 表把成本算出来（CC/Codex 都向用户展示成本）。
7. **OPENROUTER_VENDOR_BY_KIND 与 PROVIDER_KINDS 解耦**：消除手动同步两张表的负担。

---

## 4. 现有文档 drift 提示

本次 review 顺带核对的、与真实源码不一致或需更新的现有文档（供后续清理，本文档不直接改它们）：

- `codeshell-full-architecture.md`（5/8）、多数 `docs/architecture/01-12`（5/16）写于 monorepo split 前，部分仍用老 `src/...` 锚点（README 已自承）。涉及 engine/tool-system 路径的，应改为 `packages/core/src/...`。
- `engine-turnloop-architecture.md`（5/8）：核对 turn-loop.ts 当前的 continuation/abort/compaction 漏斗逻辑是否仍一致。
- maxTurns 默认值：部分文档可能写旧值，真实为 100（engine.ts:1183）。

> 处理建议：把 `docs/architecture/` 的路径锚点统一刷新到 `packages/core/src/`，并在 README 的 drift 警告里点名本文档为“最新三方对比基线”。

---

### 附：本文档的源码锚点（codeshell 列，便于核对）

- Engine 编排：`engine.ts:505-1210`；子 agent spawn：`engine.ts:611+`
- Turn loop：`turn-loop.ts:208-576`；abort 检查：`:385`；compaction 漏斗：`:76`
- Protocol：`protocol/types.ts:25-51`、`protocol/server.ts:129-180`
- 工具执行链：`tool-system/executor.ts:39-547`；权限：`permission.ts:639-831`；hook 钳制：`executor.ts:28-37`
- 沙箱后端：`tool-system/.../sandbox/index.ts:156-250`
- Hooks：`hooks/events.ts:76-92`、`hooks/registry.ts:15-105`
- Plugins：`plugins/loadPluginHooks.ts:145-195`、`plugins/pluginCommandHook.ts:89-218`
- ModelPool：`llm/model-pool.ts:96-285`；ProviderCatalog：`llm/provider-catalog.ts:10-71`；capability：`llm/capabilities/`
- Settings：`settings/schema.ts:6-283`、`settings/manager.ts:50-220`
- Session：`session/session-manager.ts:44-202`、`session/transcript.ts:26-190`
- Run：`run/RunManager.ts:65-278`、`run/EngineRunner.ts:51-150`
