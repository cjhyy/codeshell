# CodeShell TODO

> 基于 Codex CLI、Claude Code 等竞品分析，结合 CodeShell 现状整理的开发路线图。
> 标注：✅ 已完成 | 🔧 部分完成 | ⬜ 未开始

---

## Review Notes — 2026-05-14

> 先记录，不一定立即优化。来源：repo-wide review（安全、架构、LLM 正确性、发布/API、测试信号）。

- [ ] **P0 权限：Bash safe-read 分类可被 shell 元字符绕过。** 当前 `classifyBashCommand()` 仍会把 `echo x > file`、`git status && touch file`、`cat package.json | sh` 这类命令判为 safe-read；需要统一拒绝重定向、链式执行、危险管道，或复用 `ToolExecutor.isReadOnlyBashCommand()` 的更严格逻辑。
- [ ] **P0 权限：`acceptEdits` 对非 Bash 工具过宽。** 默认 CLI 模式是 `acceptEdits`，但 PermissionClassifier fallback 会 allow 所有未匹配工具，导致 `Config`、`CronCreate`、`MCPTool`、`RemoteTrigger`、`REPL`、`PowerShell` 等 `permissionDefault: "ask"` 的工具也被放行。
- [ ] **P1 cwd 一致性：EngineConfig.cwd 没有贯穿到所有工具执行。** `Bash`、`Glob`、`Grep`、`Config` 等工具仍默认使用 `process.cwd()` 或未注入的 `__cwd`，RunManager/SDK 传入非当前进程 cwd 时，模型看到的 cwd 和实际工具 cwd 可能不一致。
- [ ] **P1 LLM 正确性：OpenAI 截断续写触发条件不匹配。** TurnLoop 只识别 `stopReason === "max_tokens"`，但 OpenAI chat completion 常见截断 finish_reason 是 `"length"`；流式路径还把最终 `stopReason` 硬编码成 `"stop"`。
- [ ] **P1 WebFetch SSRF：重定向后未重新校验目标主机。** 初始 URL 会检查 loopback/RFC1918/metadata host，但 `redirect: "follow"` 后没有对最终 URL 再检查，仍可能被外部 302 带到内网地址。
- [ ] **P2 RunManager：approval/input resume 有竞态。** `RunApprovalBackend` 和 `createRunAskUserFn()` 都是先通知 lifecycle hook，再设置 pending promise；外部系统很快 `resume()` 时可能 resolve 失败且返回值被忽略。
- [ ] **P2 发布/API：public `VERSION` 与 package version 漂移。** `package.json` 是 `0.1.6`，`src/index.ts` 仍导出 `VERSION = "0.1.0"`；另外 `build:dts` 使用 `|| true`，声明文件失败不会阻断发布。
- [ ] **P3 性能：`resolveSandboxBackend` 每 turn 都重 resolve。** `Engine.run()` 每次调用都跑 `detectSandboxCapabilities()` + 动态 import backend 模块——一个 session 几百个 turn 就重做几百次。功能正确，纯性能问题：把 backend 选择移到 Engine 构造器或加 per-session 缓存即可。

## Review Notes — 2026-05-20

- [ ] **P1 Plugin hooks 未接通 — 复用 Claude Code 兼容的 plugin SessionStart hook 机制。** 当前 codeshell 已经能扫描 `~/.code-shell/plugins/*/skills/*/SKILL.md`(实测 superpowers 14 个 + document-skills 17 个 skill 全识别),且 `SkillTool` 可加载全文。但 plugin 自带的 `hooks/hooks.json` (定义 SessionStart、PostToolUse 等事件 + 跑外部命令 + 读取 stdout JSON 的 `hookSpecificOutput.additionalContext` 注入 system prompt) 没有触发,导致:(a) superpowers 的 `using-superpowers` 强制注入 prompt 不生效,LLM 没有"必须用 skill"的硬约束;(b) 任何依赖 plugin hooks 的能力(skill auto-loading、telemetry、guardrails)都无法工作。**等 hook 系统整体补全时一起做**,不单独修。参考实现:`~/.claude/plugins/cache/superpowers-dev/superpowers/5.1.0/hooks/{hooks.json,session-start,run-hook.cmd}`。

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

### ⬜ 跨会话记忆系统（Memories）
需要实现真正的跨会话持久化记忆。

- [ ] 自动从对话中提取关键记忆（项目偏好、编码规范、常见模式）
- [ ] 记忆持久化存储（`~/.codeshell/memories.json`）
- [ ] 记忆合并（consolidation）：相似记忆去重合并
- [ ] 记忆注入：新会话启动时自动加载相关记忆到 prompt
- [ ] 记忆管理命令：`/memories list`、`/memories clear`、`/memories edit`
- [ ] 可配置：`memories.maxAge`、`memories.maxCount`、`memories.extractionModel`

### 🔧 权限系统增强
当前权限系统（`src/tool-system/permission.ts`）已有基础，但缺少持久化和精细控制。

- [ ] 权限规则持久化到 `~/.codeshell/settings.json`
- [ ] 支持路径级别的权限规则（如 "允许写入 src/ 下的文件"）
- [ ] 支持命令模式匹配（如 "允许 `npm test`、`pnpm build`"）
- [ ] 会话级权限缓存（同一会话内相同操作不重复询问）
- [ ] `/permissions` 命令查看和管理当前权限规则

---

## P1 — 效率提升

### ⬜ apply_patch 批量编辑工具
当前 Edit 工具只能单文件单次替换，多文件修改需要多次 tool call，浪费 token。

- [ ] 设计 patch 格式（参考 Codex 的 unified diff 风格）
- [ ] 实现 `ApplyPatch` 工具，支持：
  - [ ] 单次调用修改多个文件
  - [ ] 创建新文件（`Add File`）
  - [ ] 删除文件（`Delete File`）
  - [ ] 重命名文件（`Rename File`）
  - [ ] 基于上下文行的 hunk 匹配
- [ ] 原子性：全部成功或全部回滚
- [ ] 与现有 Edit 工具共存，由模型自行选择

### 🔧 AGENTS.md 层级指令系统
当前 `instruction-scanner.ts` 已支持 CLAUDE.md 扫描，但缺少层级覆盖。

- [ ] 支持 `AGENTS.md` 文件名（兼容 Codex 生态）
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

### ⬜ 多代理增强
当前 Agent 工具已实现基础子代理，需要增强。

#### 🔥 P0 — logger `_currentSid` 在多 Engine 并发下被串扰（多代理基础设施）
**所有 multi-agent 数据混乱的根因**。`src/logging/logger.ts` 的 sid resolution 用 process-global 单例；`engine.run()` 入口 `logger.setSid(session.state.sessionId)`，主 Engine 启动 child Engine 后，child 自己 setSid(child_sid)，主 Engine 后续的 turn **不会重新 setSid 回到主**。`session-recorder` 里 `recordLLMRequest` / `recordToolCall` / `recordLLMResponse` 都通过 `getCurrentSid()` 拿 sid 写日志，导致：(a) 主 session 的 LLM 请求被错记进子 session 的 log file，反之亦然；(b) `tool.call` 事件归属错乱，看似主 agent 调了一堆它实际没调的工具；(c) 用户切到子 agent 视图、`/sid` 命令、auto-injection 等任何依赖 currentSid 的功能都会拿到错值。
**实证案例**：2026-05-19 session `v3KHFDkimhi3_ClO` 主 session log 里出现了 `messageCount=4 messages[1]=子 agent prompt` 的 r5 llm.request——其实是子 agent 9ZZ 的请求被错记到主 file。

**已修复（2026-05-19）**：
- `logger.ts` 加了 `AsyncLocalStorage<string>` 后端：`getCurrentSid()` 先查 ALS，回退到 module global `_currentSidFallback`。
- 新增 `runWithSid(sid, fn)`：在 ALS sub-scope 里运行 `fn`，scope 退出时父 scope 的 sid binding 自动恢复——不会像 `_currentSid` 全局赋值那样被 awaited child engine 永久覆盖。
- `Engine.run` 在 session 解析完后用 `return runWithSid(session.state.sessionId, async () => { ...body... })` 包住整个 body。每次 Engine.run 都开自己的 ALS scope，并发主 + 子 engine 各跑各的，互不串扰。
- `setCurrentSid` 仍同步更新 module global 作为 ALS-外路径的 fallback（bootstrap、`/sid` 在 run 启动前等）。
- 子 engine spawn 处不需要额外的 `runWithSid` wrap，因为 child.run 本身会建自己的 ALS scope。

**可能的进一步加固（未做，必要时再上）**：把 `recordLLMRequest(sid, ...)` / `recordToolCall(sid, ...)` 的调用方（`model-facade.ts:38`、`executor.ts:202`）改成显式从 Engine 上下文拿 sid，彻底不依赖 ALS。但 ALS 方案在 Node.js 是 first-class 并发隔离手段，目前先这样。

#### P0 — 后台 agent 完成通知机制（消灭 Sleep+AgentStatus 轮询）
当前后台 agent 跑起来后，主 agent **只能 polling**（反复 `Sleep` + `AgentStatus`），因为：(a) Agent 工具 description 里就写着"Use AgentStatus to check progress"——LLM 字面照做；(b) 没有自动完成通知机制——LLM 不轮询就永远不知道结果；(c) prompt 没禁止 polling。CC 的做法：spawn 返回时 prompt LLM "Briefly tell the user what you launched and end your response. results will arrive in a subsequent message"，结束当前 turn；agent 跑完时**框架自动给主 session 注入一条消息**带结果，主 agent 下一个 turn 自然看到。落地依赖关系：(A) → (B) → (C) 是同一组改动一起上，(D)/(E) 是 follow-up。
- [ ] **(A) 改 Agent 工具的 schema description + tool prompt**：照搬 CC 的措辞——"do NOT sleep, poll, or proactively check on its progress. You will be automatically notified when it completes. Continue with other work or end your response." 见 `~/Documents/个人学习/代码学习/claude-code-sourcemap/restored-src/src/tools/AgentTool/prompt.ts:263` 和 `AgentTool.tsx:87`。改 `src/tool-system/builtin/agent.ts:17-50` 的 schema。
- [ ] **(B) 改 background spawn 的 tool_result 文本**：当前是 "Agent launched in background. agent_id: ... Use AgentStatus(...) to check progress"，改成 "Async agent launched. agent_id: ... The agent is working in the background. You will be notified automatically when it completes. Briefly tell the user what you launched and end your response. Do not generate any other text — agent results will arrive in a subsequent message." 见 `AgentTool.tsx:1328`。改 `src/tool-system/builtin/agent.ts:153-167`。
- [ ] **(C) 实现"自动注入完成消息"机制**【关键，无此 A/B 只是画饼】：当 `asyncAgentRegistry.markCompleted(agentId, text)` / `markFailed` 触发时，把"Agent <description> completed: <text>"作为一条 user message 注入主 session 的下一个 turn 输入。难点：主 session 当时可能 idle（已 `turn_complete`）。需要打通 `RunManager` 或 `protocol/server.ts` 的 client 注入路径——参考现有 user input pipeline。可能需要在 UI 端拦截 markCompleted 信号、调 `client.submit(...)`。
- [ ] **(D) outputFile 机制 + 删 AgentStatus**：每个 background agent 写 `~/.code-shell/agents/<agentId>.txt`（持续 append 它的 assistant_text/tool 输出）。主 agent 想看中途状态用现有的 `Read` / `Bash tail`，不需要专用工具。删 `AgentStatus` / `AgentCancel`（保留 cancel 工具但改名/重新设计）。见 `AgentTool.tsx:151, 1329`。
- [ ] **(E) auto-background after 120s**：同步 `Agent(...)` 跑超过 120s 自动转后台，spawn turn 不阻塞主对话。见 `AgentTool.tsx:73-77`。

#### 其他多代理增强
- [ ] **对齐 CC 的 subagent_type / agents 目录机制**：当前 `Agent` 工具只接受自由文本 `name?` label（dock 用），主 agent 多数情况留空。CC 做法是 `subagent_type` 必填、从内置表（`general-purpose` / `Explore` / `Plan` / ...）+ `~/.claude/agents/<name>/agent.md` 自定义目录里选；每种 kind 自带 system prompt、工具子集白名单、可选模型覆盖。落地路径：(1) 新建 `~/.code-shell/agents/` loader（读 frontmatter + body）；(2) `Agent` 工具加 required `subagent_type`，schema enum 动态注入已 load 的 kind 名；(3) `runSubAgent` 用 kind 的 system prompt / tools 子集 / model override 覆盖默认；(4) `AsyncAgentEntry.name` 改成填 kind name；(5) 主 agent 系统 prompt 加 kind 选择指南。
- [ ] Agent 角色预定义（在 config 中配置常用角色）
- [ ] `max_depth` 嵌套深度限制
- [ ] `max_threads` 并发线程数限制
- [ ] `job_max_runtime_seconds` 超时控制
- [ ] Agent 间通信：评估 mailbox 路线（参考 CC `~/.claude/teams/<team>/inboxes/`，文件 + lockfile，tool round 间隙 readMailbox → 注入 user turn 的 `<teammate-message>` XML）。当前 `SendMessage` + `agentCoordinator` 是半成品死代码（register 从未被调用），下一次推进时一并决定：补齐 mailbox / 还是删掉
- [ ] **task 加 agentId tag**：当前 `taskManager` 是全局 module-level singleton，所有 agent 共享同一个 `tasks: Map`，子 agent 创建 task 会混进主视图。具体改动：`Task` 类型加 `agentId?: string`；`taskManager.create` 接受 agentId（subagent Engine 启动时注入 ToolContext）；`emitUpdate` 按 agentId 路由 stream；UI 渲染按 viewMode 过滤。当前 workaround：App.tsx:1358 `viewMode.kind === "main"` 才显示 TaskList，子视图直接隐藏。
- [ ] Agent 执行结果汇总视图

### ⬜ Model Provider 增强
当前 LLM 层较简单，需要更灵活的 provider 支持。

- [ ] 支持通过外部命令获取 token（`auth.command`）
- [ ] 支持自定义 HTTP headers（`env_http_headers`）
- [ ] `reasoning_effort` 参数支持（已部分实现）
- [ ] `reasoning_summary` 参数支持
- [ ] `service_tier` 参数支持
- [ ] 模型自动降级：主模型失败时切换备用模型
- [ ] 支持本地模型（Ollama、llama.cpp）

### ⬜ 配置系统完善
当前 `src/settings/` 较基础。

- [ ] 支持 `~/.codeshell/config.yaml` 全局配置
- [ ] 支持项目级 `.codeshell/config.yaml`
- [ ] 配置 JSON Schema 生成（IDE 自动补全）
- [ ] `/config` 命令交互式编辑配置
- [ ] 配置迁移机制（版本升级时自动迁移旧配置）

---

## P4 — 工程质量

### 🔧 测试覆盖
- [ ] 核心模块单元测试（engine、turn-loop、permission）
- [ ] 工具集成测试（每个 builtin tool）
- [ ] E2E 测试（完整对话流程）
- [ ] CI 流水线（GitHub Actions）
- [ ] 测试覆盖率 > 60%

### ⬜ 错误处理与恢复
- [ ] LLM API 调用重试（指数退避）
- [ ] 网络断开自动重连
- [ ] 会话崩溃恢复（从 transcript 恢复）
- [ ] 工具执行超时处理
- [ ] 优雅的错误消息（用户友好的错误提示）

### ⬜ 性能优化
- [ ] 启动时间优化（懒加载非核心模块）
- [ ] 流式渲染优化（减少不必要的重渲染）
- [ ] 大文件处理优化（分块读取、增量搜索）
- [ ] MCP 连接池复用

### ⬜ 文档
- [ ] 用户指南（Getting Started、Configuration、Tools Reference）
- [ ] 开发者文档（Architecture、Contributing Guide）
- [ ] API 文档（公开 API 的 TypeDoc）
- [ ] 中文文档

---

## 已完成功能清单

- ✅ Terminal-native UI（Ink + React）
- ✅ 28 个内置工具（Read/Write/Edit/Glob/Grep/Bash/Web/Agent/Plan/Task/Worktree/LSP/Cron/Config/Notebook/Sleep/SendMessage/ToolSearch）
- ✅ 多模型支持（Anthropic/OpenAI/DeepSeek/OpenRouter）
- ✅ MCP 协议支持
- ✅ REPL 模式 + One-shot 模式
- ✅ 权限控制基础框架
- ✅ Plan Mode
- ✅ Task 系统（创建/跟踪/依赖）
- ✅ Sub-Agent 子代理
- ✅ Session 管理（持久化/恢复）
- ✅ CLAUDE.md 指令扫描
- ✅ Git 状态注入
- ✅ Arena 多模型竞技
- ✅ Cost Tracker 成本追踪
- ✅ 3 级 Context Compaction
- ✅ Skill 系统
- ✅ Hook 系统
- ✅ Git Worktree 隔离
- ✅ LSP 集成
- ✅ Cron 定时任务
- ✅ Vim Mode
- ✅ RunManager 托管执行框架（`src/run/`）
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
