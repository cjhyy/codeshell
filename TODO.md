# CodeShell TODO

> 基于 Codex CLI、Claude Code 等竞品分析，结合 CodeShell 现状整理的开发路线图。
> 标注：✅ 已完成 | 🔧 部分完成 | ⬜ 未开始

> 本文是**累积式**的——已完成项原地打 ✅ 并附简短证据（commit / spec / 文件），不删除题目；这样老的 review notes 仍可被检索。

---

## Bug — 2026-06-01：自动化「立即运行」连点堆叠多条 run（✅ UI 侧已修）

> systematic-debugging 定位，证据确凿。**UI 侧已修**（commit `9e04789`）；**core 按设计不改**（见下）。分支 `feat/automation-run-sidebar`。spec `docs/superpowers/specs/2026-06-01-automation-runnow-debounce-design.md`。

**现象**：同一个 cron job（id=1「每日早间新闻汇总」）累计堆了 10 条 run（5 `queued` 排不上、几条 `running` 卡死、1 completed）。用户观察到「出 2 个」「session 不一致」——后者其实是 runId vs sessionId 两套 ID 指同一次运行（`session_linked` 绑定），非真不一致。

**根因定位**：堆叠真凶是 **UI「立即运行」按钮无防重复点击 + 无 loading**（`AutomationView.tsx` 的 `act()` 无 in-flight 保护，点完立刻可再点 → 连点就 `runAutomationNow`×N → 每次 `fire`→`RunManager.submit` 一条新 run）。core `scheduler.fire()` 的再入守卫毫秒级失效（`await onExecute` 等的是 submit 返回而非 run 跑完）是叠加因素，**但「同一 cron job 允许多条并发」是期望行为**（cron 到点就跑、重叠合法），cron 定时 tick 是分钟/天级、不会毫秒级重复 → 唯一毫秒级重复 submit 的来源就是被连点的按钮。

**✅ 已修（UI-only，commit `9e04789`）**：`act(key, fn)` 改为按 `"<action>:<jobId>"` key 跟踪 in-flight，`if(pending[key])return` 防重复 + finally 必清；立即运行/删除/暂停Switch/保存 在 pending 时 disabled，立即运行/保存显示 `Loader2 animate-spin` + 「运行中…/保存中…」。每按钮独立。157 desktop tests pass、tsc/build 绿。

**core 按设计不改**：既然允许同 job 并发，就不在 core 做「上一条没跑完就 skip」。`fire` 守卫的毫秒级失效在「允许并发」语义下无害（真正的并发是合法的；防误点归 UI）。

**次生现象（未追，独立）**：有 run 卡在 `turn.start` 之后、首个 `llm.request` 之前（`llm.request=0`、run.lock `acquired` never `released`，4+ 分钟静默）。这是另一个潜在挂起问题，与堆叠无关，**未深挖**——若复现再单独 debug。

现场已清理（10 条 run + 2 session 目录删除）。证据/上下文见 [[project-automation-run-sidebar]] memory。

---

## Review Notes — 2026-05-28

> 上一轮 review 之后的进展快照（截至 2026-05-28）。本文档同步更新了下方对应条目的勾选状态。

**子代理工作流（重头戏，已成体系）**
- ✅ 内置 4 个角色（`researcher` / `explorer` / `planner` / `general-purpose`）落地为 `.code-shell/agents/*.md`，YAML frontmatter + body 格式 → commit `0ba964c`、`e5c9979`
- ✅ Agent 工具新增 `agent_type` 入参，未知角色抛错并列出 Available；模型路由 `resolveChildLlm` 支持 ModelPool key 继承 → commit `e383afe`、`4ecfd80`
- ✅ 子代理生命周期 hook（start/finish/error）+ 端到端测试覆盖
- ✅ 桌面「子代理」配置面板（设置 → 子代理）：列表 + 编辑表单（model 下拉 / tools 多选 / maxTurns / 系统提示词）；内置项保存生成用户级同名覆盖文件、`disabledAgents` 让被禁角色 LLM 不可见；commit 链 `b66ddb1` → `b338d14`，spec `2026-05-27-subagent-config-panel-design.md`、plan `2026-05-27-subagent-config-panel.md`
- ✅ 多 Engine 并发 sid 串扰修复（AsyncLocalStorage scope）→ logger.ts 已合入（2026-05-19）

**桌面 UI 重排**
- ✅ 左上 nav：新对话 / 搜索 / **MCP** / **技能与插件** / 自动化（重命名 + 增加 customize 入口）
- ✅ 全屏「技能与插件」视图（复用 `PluginsAndSkillsSection`）→ commit `f51987d`
- ✅ SettingsMenu 精简为「打开设置 + 切换语言（右侧级联）」→ commit `a0e25fe`
- ✅ AgentsSection 重做：复用 `<Select>` / `settings-field` / `settings-toggle-inline`，三色来源 pill → commit `b338d14`

**安全 / 隔离**
- ✅ `disabledPlugins` 现在也压制 plugin hooks（不再只是 skills）→ commit `ed30bb9`
- ✅ MCP per-server enabled toggle + 修 stdio worker 不连问题 → commit `6760704`
- ✅ SDK settings 隔离设计（spec `2026-05-27-sdk-settings-isolation-design.md`，部分实现已合入）

**其他**
- ✅ `GenerateImage` 内置工具（OpenAI gpt-image-2）→ commit `d43d652`，spec `2026-05-27-generate-image-tool-design.md`
- ✅ 架构对照文档：core vs Claude Code vs Codex → commit `ac6aea8`，`docs/architecture/18-core-vs-cc-vs-codex.md`
- ✅ core 版本号同步：bump 到 `0.5.0-rc.1`（解决之前 VERSION 漂移）→ commit `dc21ed7`

**真正仍未动 / 部分缺位**（基于 2026-05-28 实地核查）：
- ⬜ 完整沙箱执行（A2 abort 设计已写，主体未落地）
- 🔧 Memories（pipeline + 工具已实现，缺 `/memories` 命令、consolidation、可配置）
- ⬜ Guardian 子代理审批
- ⬜ Undo / 撤销系统
- ⬜ Shell Snapshot
- ⬜ Code Review 内置 `/review` 命令
- ⬜ Feature Flags 系统
- 🔧 后台 agent 自动完成通知（registry 完整，缺自动注入主 session）
- 🔧 Plugin SessionStart hook 全套打通（已加载、需运行时验证 superpowers 是否真注入到 prompt）
- ⬜ Agent mailbox / per-agent skill 精选层 / `max_depth` / `max_threads` 配置
- ⬜ AGENTS.md 层级覆盖 + AGENTS.local.md
- ⬜ OpenAI `finish_reason === "length"` 归一（5/14 P1）
- ⬜ `resolveSandboxBackend` per-turn 缓存（5/14 P3）
- ⬜ Provider 增强大部分（reasoning_summary、service_tier、模型降级、auth.command、env_http_headers）

---

## Review Notes — 2026-05-14

> 来源：repo-wide review。**2026-05-28 已逐条对照代码核实**，每项尾标注最新状态与证据。

- ✅ **P0 权限：Bash safe-read 分类可被 shell 元字符绕过。** 已修。`permission.ts:391` 注释 "A1 hardening: classifyBashCommand previously ran SAFE_READ_PATTERNS … We now scan the command" — 重定向 / 链式 / 危险管道已被统一处理。spec `2026-05-26-a1-permission-hardening-design.md`。
- ✅ **P0 权限：`acceptEdits` 对非 Bash 工具过宽。** 已修（A1 部分）。`permission.ts:624` 注释 "A1 hardening: tools that `acceptEdits` mode will auto-allow without …" — 显式名单已收紧。
- ✅ **P1 cwd 一致性：EngineConfig.cwd 贯穿。** 已修（A4）。`bash.ts:106`、`glob.ts:36`、`grep.ts:66` 均改为 `ctx?.cwd ?? process.cwd()`；spec `2026-05-26-a4-cwd-consistency-design.md`。
- [ ] **P1 LLM 正确性：OpenAI 截断续写触发条件不匹配。** **仍未修。** `turn-loop.ts:343` 仍是 `response.stopReason === "max_tokens"`，但 OpenAI provider `openai.ts:475` 直接透传 `choice.finish_reason`（即 `"length"`），流式路径 chunk 也透传 `finish_reason`。需要在 turn-loop 或 provider 适配层做 `"length" | "max_tokens"` 归一。
- ✅ **P1 WebFetch SSRF：重定向后未重新校验目标主机。** 已修（A3）。`web-fetch.ts:210` 注释 "A3 hardening: manual redirect loop. Each hop revalidates the URL"。spec `2026-05-26-a3-webfetch-ssrf-design.md`。
- [ ] **P2 RunManager：approval/input resume 有竞态。** 未确认是否修复。`RunManager.ts:170` 有 "Resolve the pending promise" 但未做明显的 race 缓解。需要单独审查。
- ✅ **P2 发布/API：public `VERSION` 与 package version 漂移。** 已通过 commit `dc21ed7` 将 core 升到 `0.5.0-rc.1` 同步；`build:dts` 强度仍有待审视。
- [ ] **P3 性能：`resolveSandboxBackend` 每 turn 都重 resolve。** **仍未修。** `engine.ts:719` 仍在 `Engine.run()` 主体内 `await resolveSandboxBackend(sandboxConfig, cwd)`。把 backend 选择移到 Engine 构造器或加 per-session 缓存即可。

## Review Notes — 2026-05-20

- 🔧 **P1 Plugin hooks — Claude Code 兼容的 plugin hook 机制。** 部分接通；需要运行时验证。
  - 进展：`loadPluginHooks(this.hooks, this.readDisabledLists().disabledPlugins)` 在 `engine.ts:363` 已调用；`on_session_start` 在 `engine.ts:879` 已 emit；`hooks/registry.ts:55-60` 已支持 `additionalContext` 聚合；`disabledPlugins` 也压制 plugin hooks（commit `ed30bb9`）。
  - **未验证**：superpowers `hooks/hooks.json` 中的 SessionStart 是否真的把 `using-superpowers` additionalContext 注入到了 main session 的 prompt——需要起一次 session 看实际行为。如确认 OK 就升 ✅；如未注入，要查 hooks.json 解析或 plugin hook adapter。

---

## P0 — 核心安全与体验基石

### ⬜ 沙箱执行系统（Sandbox）
当前 Bash 工具直接执行命令，无隔离保护。需要引入沙箱机制防止 AI 执行的命令造成不可逆损害。

- [ ] macOS: 基于 `sandbox-exec` (Seatbelt) 实现文件系统/网络隔离
- [ ] Linux: 基于 Landlock / bubblewrap 实现沙箱
- [ ] 定义 `SandboxPolicy` 类型（allowed paths read/write、network access）
- [ ] 在 `src/tool-system/builtin/bash.ts` 中集成沙箱包装
- [ ] 沙箱失败时优雅降级（提示用户手动确认）
- [ ] 配置项：`sandbox.enabled`、`sandbox.allowNetworkFor` 白名单

> 注：spec `2026-05-26-a2-sandbox-abort-design.md` 已写沙箱 abort 设计，但完整沙箱机制未落地。

### 🔧 跨会话记忆系统（Memories）
**基础已实现**：`packages/core/src/tool-system/builtin/memory.ts` 暴露 Memory 工具；`engine.ts:1257` 注释 "Fire-and-forget memory pipeline: extract durable memories from the transcript"，`engine.ts:1306` "Extracts durable memories from the transcript, saves a session"。剩下的待办偏向产品打磨：

- [x] 自动从对话中提取关键记忆（已有 fire-and-forget pipeline）
- [x] 记忆持久化存储（已有 memory 工具读写）
- [ ] 记忆合并（consolidation）：相似记忆去重合并
- [ ] 记忆注入：新会话启动时自动加载相关记忆到 prompt（需确认是否已通过 SessionStart hook 注入）
- [ ] 记忆管理命令：`/memories list`、`/memories clear`、`/memories edit`
- [ ] 可配置：`memories.maxAge`、`memories.maxCount`、`memories.extractionModel`

### 🔧 权限系统增强
当前权限系统（`src/tool-system/permission.ts`）已有基础，但缺少持久化和精细控制。

- [x] 权限规则持久化到 `~/.codeshell/settings.json` —— `disabledSkills` / `disabledPlugins` / **`disabledAgents`** / `mcpServers[].enabled` 都已经走 settings 持久化
- [ ] 支持路径级别的权限规则（如 "允许写入 src/ 下的文件"）—— spec `2026-05-26-a1-permission-hardening-design.md` 已写
- [ ] 支持命令模式匹配（如 "允许 `npm test`、`pnpm build`"）
- [ ] 会话级权限缓存（同一会话内相同操作不重复询问）
- [ ] `/permissions` 命令查看和管理当前权限规则

---

## P1 — 效率提升

### ✅ apply_patch 批量编辑工具（已实现）
**已实现**。`packages/core/src/tool-system/builtin/apply-patch/index.ts` 模块；`BUILTIN_TOOLS` 列表（`builtin/index.ts:109-115`）含 `ApplyPatch`；preset/index.ts:38、permission.ts:634 都已配置。Patch 格式与 Codex 一致。剩余可能的打磨（按需）：

- [x] 设计 patch 格式（unified diff 风格，与 Codex 兼容）
- [x] 实现 `ApplyPatch` 工具（含 Add File / Delete File / Rename File / hunk 匹配）
- [x] 与现有 Edit 工具共存
- [ ] 原子性：全部成功或全部回滚（待确认实现细节）

### 🔧 AGENTS.md 层级指令系统
`instruction-scanner.ts` 已支持 CLAUDE.md + AGENTS.md（`compatFileNames` 默认 `["CLAUDE.md", "AGENTS.md"]`，`schema.ts:202`、`instruction-scanner.ts:61`）。层级覆盖、local 文件、作用域标注尚未实现。

- [x] 支持 `AGENTS.md` 文件名（兼容 Codex 生态）
- [ ] 实现层级覆盖：深层目录的指令覆盖浅层
- [ ] 支持 `AGENTS.local.md`（不入版本控制的本地指令）
- [ ] 指令作用域标注（当前目录 vs 全局）
- [ ] 在 prompt 中按作用域排序注入

### ⬜ 智能上下文管理
当前 3 级 compaction 已实现，但可以更智能。

- [ ] 文件内容缓存去重（同一文件多次读取只保留最新版本）
- [ ] tool result 压缩（大输出自动截断 + 摘要）
- [ ] 请求压缩（`enable_request_compression`）：发送前压缩历史消息
- [ ] token 预算管理：根据剩余 token 动态调整策略

---

## P2 — 体验优化

### ⬜ Guardian 子代理审批
用 AI 代替用户判断操作是否安全，减少打断频率。

- [ ] 实现 `GuardianAgent`：接收操作描述，返回 approve/deny/escalate
- [ ] 配置项：`approvals.reviewer: "guardian_subagent" | "user" | "auto"`
- [ ] Guardian 使用轻量模型（如 haiku）降低成本
- [ ] 高风险操作仍强制用户确认（删除文件、force push 等）
- [ ] Guardian 判断日志，用户可审计

### ⬜ Feature Flags 系统
方便渐进式发布和实验性功能管理。

- [ ] 定义 `FeatureFlags` 类型和默认值
- [ ] 从配置文件加载 flags
- [ ] 在各模块中检查 flag 状态
- [ ] `/features` 命令查看和切换 flags
- [ ] 候选 flags：`web_search`、`shell_tool`、`fast_mode`、`undo`、`shell_snapshot`

### ⬜ Undo / 撤销系统
让用户可以撤销 AI 的文件修改操作。

- [ ] 文件操作前自动备份（基于 file-history 扩展）
- [ ] `/undo` 命令：撤销最近一次文件修改
- [ ] `/undo all` 命令：撤销当前会话所有修改
- [ ] 显示 diff 预览再确认撤销
- [ ] 与 git 集成：自动 stash 或创建 undo commit

### ⬜ Shell Snapshot
命令执行后捕获终端状态快照，帮助 AI 理解命令输出。

- [ ] 捕获命令执行后的 stdout/stderr 完整输出
- [ ] 智能截断：超长输出保留头尾 + 中间摘要
- [ ] 错误输出高亮标注
- [ ] 退出码语义化（非零退出码自动标记为失败）

---

## P3 — 功能丰富度

### ⬜ Code Review 内置命令
结构化的代码审查能力。

- [ ] `/review` 命令：审查当前 git diff 或指定文件
- [ ] 结构化输出：findings 列表，含优先级（P0-P3）、置信度、位置
- [ ] 支持 JSON 输出格式（方便 CI/CD 集成）
- [ ] 可配置审查维度（安全、性能、可读性、正确性）
- [ ] 支持增量审查（只审查变更部分）

### 🔧 多代理增强
当前 Agent 工具已实现基础子代理，**配置面板（设置 → 子代理）已上线**，能新增/禁用/编辑模型与工具白名单；下面是仍欠的部分。

#### ✅ logger `_currentSid` 在多 Engine 并发下被串扰
**已修复（2026-05-19）**。`logger.ts` 用 `AsyncLocalStorage<string>` 后端 + `runWithSid(sid, fn)`；`Engine.run` 在 session 解析完后用 `return runWithSid(...)` 包整个 body，每次 Engine.run 都开自己的 ALS scope，并发主 + 子 engine 各跑各的互不串扰。`setCurrentSid` 仍同步更新 module global 作为 ALS-外路径的 fallback。

可能的进一步加固（未做，必要时再上）：把 `recordLLMRequest(sid, ...)` / `recordToolCall(sid, ...)` 的调用方改成显式从 Engine 上下文拿 sid，彻底不依赖 ALS。

#### 🔧 后台 agent 完成通知机制（消灭 Sleep+AgentStatus 轮询）
当前后台 agent 跑起来后，主 agent **仍是 polling**（反复 `Sleep` + `AgentStatus`）。需要照搬 CC 的"自动注入完成消息"机制。

- [ ] **(A) 改 Agent 工具的 schema description + tool prompt**："do NOT sleep, poll, or proactively check on its progress. You will be automatically notified when it completes. Continue with other work or end your response." 见 CC `~/Documents/个人学习/代码学习/claude-code-sourcemap/restored-src/src/tools/AgentTool/prompt.ts:263` 和 `AgentTool.tsx:87`；改 `src/tool-system/builtin/agent.ts:17-50` 的 schema。
- [ ] **(B) 改 background spawn 的 tool_result 文本**："Async agent launched. agent_id: ... The agent is working in the background. You will be notified automatically when it completes. Briefly tell the user what you launched and end your response. Do not generate any other text — agent results will arrive in a subsequent message."
- [ ] **(C) 实现"自动注入完成消息"机制**【关键，无此 A/B 只是画饼】：当 `asyncAgentRegistry.markCompleted(agentId, text)` / `markFailed` 触发时，把"Agent <description> completed: <text>"作为一条 user message 注入主 session 的下一个 turn 输入。难点：主 session 当时可能 idle（已 `turn_complete`），需要打通 `RunManager` 或 `protocol/server.ts` 的 client 注入路径。
- [ ] **(D) outputFile 机制 + 删 AgentStatus**：每个 background agent 写 `~/.code-shell/agents/<agentId>.txt`（持续 append 它的 assistant_text/tool 输出）。主 agent 想看中途状态用现有的 `Read` / `Bash tail`，不需要专用工具。
- [ ] **(E) auto-background after 120s**：同步 `Agent(...)` 跑超过 120s 自动转后台。

#### ✅ 对齐 CC 的 subagent_type / agents 目录机制（基础部分）
- ✅ 新建 `.code-shell/agents/` loader 读 frontmatter + body（`AgentDefinitionRegistry`，含项目级 + 用户级合并）
- ✅ Agent 工具加 `agent_type` 入参；未知类型抛错且列出 Available
- ✅ `runSubAgent` 用 kind 的 system prompt / tools 子集 / model override 覆盖默认
- ✅ 桌面配置面板：新增 / 禁用 / 编辑模型 / 工具白名单 / 系统提示词
- [ ] **进一步对齐 CC** —— 把 `agent_type` 升级为 schema enum（当前是字符串 + 描述提示），动态注入已 load 的 kind 名让 LLM 看得见
- [ ] `AsyncAgentEntry.name` 改成填 kind name（增强 dock 显示）
- [ ] 主 agent 系统 prompt 加 kind 选择指南

#### 其他多代理增强
- [ ] Agent 角色预定义到 config（已有用户级目录可放，但缺 settings-level 默认配置）
- [ ] `max_depth` 嵌套深度限制（当前通过 `NESTED_AGENT_TOOLS` 禁用 grandchildren，是 0 vs 多层而非可配）
- [ ] `max_threads` 并发线程数限制
- [ ] `job_max_runtime_seconds` 超时控制（当前有 `DEFAULT_SUBAGENT_TIMEOUT_MS = 5min` 硬编码，未暴露配置）
- [ ] Agent 间通信：评估 mailbox 路线（参考 CC `~/.claude/teams/<team>/inboxes/`）。当前 `SendMessage` + `agentCoordinator` 是半成品死代码（`register` 从未被调用），下一次推进时一并决定：补齐 mailbox / 还是删掉
- [ ] **task 加 agentId tag**：当前 `taskManager` 是全局 module-level singleton，所有 agent 共享同一个 `tasks: Map`，子 agent 创建 task 会混进主视图。`Task` 类型加 `agentId?: string`；`taskManager.create` 接受 agentId（subagent Engine 启动时注入 ToolContext）；`emitUpdate` 按 agentId 路由 stream；UI 渲染按 viewMode 过滤。当前 workaround：`App.tsx` viewMode === "main" 才显示 TaskList。
- [ ] Agent 执行结果汇总视图
- [ ] **per-agent skill 精选层**（spec 已写"先做总开关"非目标，留作下一步）：给 agent 定义加 `skills: [...]` 字段，该 agent 只看得到列出的 skill。CC 已有 `skills` frontmatter 字段可参考。

### ⬜ Model Provider 增强
当前 LLM 层较简单，需要更灵活的 provider 支持。

- [ ] 支持通过外部命令获取 token（`auth.command`）
- [ ] 支持自定义 HTTP headers（`env_http_headers`）
- [x] `reasoning_effort` 参数支持（已部分实现）
- [ ] `reasoning_summary` 参数支持
- [ ] `service_tier` 参数支持
- [ ] 模型自动降级：主模型失败时切换备用模型
- [x] 支持本地模型（Ollama — `onboarding.ts:136`、`provider-kinds.ts:20`、`migrate-models.ts:60` 都已识别；llama.cpp 暂未列出但同 OpenAI-compatible base URL 路径可用）

### 🔧 配置系统完善
当前 `src/settings/` 较基础。

- [x] 支持 `~/.code-shell/settings.json` 全局配置（已实现）
- [x] 支持项目级 `.code-shell/settings.json`（已实现）
- [ ] 支持 YAML 配置（目前是 JSON）
- [ ] 配置 JSON Schema 生成（IDE 自动补全）
- [ ] `/config` 命令交互式编辑配置
- [ ] 配置迁移机制（版本升级时自动迁移旧配置）

---

## P4 — 工程质量

### 🔧 测试覆盖
- [x] 核心模块单元测试（engine、turn-loop、permission）—— 已有相当覆盖；详见 `packages/core/tests/` 117 文件
- [ ] 工具集成测试（每个 builtin tool）
- [ ] E2E 测试（完整对话流程）
- [ ] CI 流水线（GitHub Actions）
- [ ] 测试覆盖率 > 60%
- [ ] **清理已知不稳定 / 待修测试**：repo 当前 5 个无关失败（gpt-5.5 capabilities、model resync、legacy 迁移、taskManager 导出、notification daemon offline）需要逐一关单

### ⬜ 错误处理与恢复
- [ ] LLM API 调用重试（指数退避）
- [ ] 网络断开自动重连
- [ ] 会话崩溃恢复（从 transcript 恢复）—— RunManager 的 `recover` 已部分实现
- [ ] 工具执行超时处理
- [ ] 优雅的错误消息（用户友好的错误提示）

### ⬜ 性能优化
- [ ] 启动时间优化（懒加载非核心模块）
- [ ] 流式渲染优化（减少不必要的重渲染）
- [ ] 大文件处理优化（分块读取、增量搜索）
- [ ] MCP 连接池复用

### 🔧 文档
- [ ] 用户指南（Getting Started、Configuration、Tools Reference）
- [x] 开发者文档（Architecture）—— `docs/architecture/` 已积累 18 篇，含 core vs CC vs Codex 对照
- [ ] 开发者文档：Contributing Guide
- [ ] API 文档（公开 API 的 TypeDoc）
- [ ] 中文文档

---

## 已完成功能清单

### 基础设施 / 引擎
- ✅ Terminal-native UI（Ink + React）
- ✅ Electron 桌面 app（broker 架构，commit `2026-05-23-electron-mvp-broker`）
- ✅ 28+ 个内置工具（Read/Write/Edit/Glob/Grep/Bash/Web/Agent/Plan/Task/Worktree/LSP/Cron/Config/Notebook/Sleep/SendMessage/ToolSearch/GenerateImage/…）
- ✅ 多模型支持（Anthropic/OpenAI/DeepSeek/OpenRouter）
- ✅ MCP 协议支持 + per-server enabled toggle（commit `6760704`）
- ✅ REPL 模式 + One-shot 模式
- ✅ 权限控制基础框架
- ✅ Plan Mode
- ✅ Task 系统（创建/跟踪/依赖）
- ✅ Sub-Agent 子代理（详见下方）
- ✅ Session 管理（持久化/恢复）
- ✅ CLAUDE.md 指令扫描
- ✅ Git 状态注入
- ✅ Arena 多模型竞技
- ✅ Cost Tracker 成本追踪
- ✅ 3 级 Context Compaction
- ✅ Skill 系统（项目 / 用户 / plugin 三源；`disabledSkills` / `disabledPlugins` 过滤）
- ✅ Hook 系统（含 `disabledPlugins` 同时压制 plugin hooks）
- ✅ Git Worktree 隔离
- ✅ LSP 集成
- ✅ Cron 定时任务
- ✅ Vim Mode
- ✅ GenerateImage 内置工具（OpenAI gpt-image-2，commit `d43d652`）

### 子代理（subagent）—— 2026-05-27 完成
- ✅ 内置 4 个角色文件（`researcher` / `explorer` / `planner` / `general-purpose`）
- ✅ Agent definition 格式：YAML frontmatter + markdown body
- ✅ `AgentDefinitionRegistry`：合并项目级 + 用户级两源，用户级同名覆盖、`override` 标记
- ✅ Agent 工具 `agent_type` 入参 + 未知类型报错列出 Available
- ✅ 模型路由 `resolveChildLlm`（ModelPool key 继承，未配置则回退父模型）
- ✅ Tool 白名单（per-role tools 字段，含 `Skill` 总开关）
- ✅ `disabledAgents` settings 字段 + 加载时过滤（被禁角色 LLM 完全不可见）
- ✅ `serializeAgentDefinition`（与 `parseAgentDefinition` 互逆）
- ✅ Engine 缓存按 disabledAgents 指纹失效
- ✅ 桌面 `agents-service.ts` + IPC + preload 桥
- ✅ 桌面「设置 → 子代理」面板（三栏，复用 `<Select>` / `settings-field` / `settings-toggle-inline` 等项目组件）
- ✅ 子代理生命周期 hook（start / finish / error）
- ✅ End-to-end agent_type smoke + registry / serializer 单元测试

### 桌面 UI（renderer）
- ✅ 左上 nav 重排：新对话 / 搜索 / **MCP** / **技能与插件** / 自动化
- ✅ 全屏「技能与插件」customize 视图（复用 `PluginsAndSkillsSection`，commit `f51987d`）
- ✅ SettingsMenu 精简为「打开设置… + 切换语言（右侧级联）」（commit `a0e25fe`）
- ✅ UI 语言偏好持久化（`uiLanguage.ts`，localStorage）

### RunManager 托管执行（`src/run/`）
- ✅ Run 生命周期状态机（queued → running → completed/failed/cancelled）
- ✅ FileRunStore 本地持久化（run.json + events.jsonl + checkpoints/ + approvals/ + artifacts/）
- ✅ RunQueue FIFO 队列（可配并发）
- ✅ EngineRunner 桥接层（RunSnapshot → Engine.run()）
- ✅ Waiting states（waiting_input / waiting_approval）+ Promise suspend/resume
- ✅ RunApprovalBackend — 审批桥接到 Run 状态
- ✅ CheckpointWriter — 阶段边界检测 + 周期 turn checkpoint
- ✅ ArtifactTracker — Write/Edit/Bash 产出追踪
- ✅ RunLock — proper-lockfile 文件锁
- ✅ Heartbeat — PID + 时间戳心跳 + crash recovery
- ✅ Evaluator 合约（Noop + Composite 内置实现）
- ✅ CLI 命令组：`code-shell runs list/get/submit/resume/cancel/events/recover`

### 文档 / 工程
- ✅ Monorepo 拆分（packages/core + packages/desktop + packages/tui，commit `2026-05-22`）
- ✅ 架构文档体系 `docs/architecture/`（18 篇，含 core vs Claude Code vs Codex 对照）
- ✅ Superpowers spec/plan 流程稳定运转（`docs/superpowers/specs/`、`docs/superpowers/plans/`）
- ✅ Core 版本号同步（`0.5.0-rc.1`，commit `dc21ed7`）
