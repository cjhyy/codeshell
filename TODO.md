# CodeShell TODO

> 基于 Codex CLI、Claude Code 等竞品分析，结合 CodeShell 现状整理的开发路线图。
> 标注：✅ 已完成 | 🔧 部分完成 | ⬜ 未开始

---

## P0 — 核心安全与体验基石

### ⬜ 沙箱执行系统（Sandbox）
当前 Bash 工具直接执行命令，无隔离保护。需要引入沙箱机制防止 AI 执行的命令造成不可逆损害。

- [ ] macOS: 基于 `sandbox-exec` (Seatbelt) 实现文件系统/网络隔离
- [ ] Linux: 基于 Landlock / bubblewrap 实现沙箱
- [ ] 定义 `SandboxPolicy` 类型（allowed paths read/write、network access）
- [ ] 在 `src/tool/builtin/bash.ts` 中集成沙箱包装
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
当前权限系统（`src/tool/permission.ts`）已有基础，但缺少持久化和精细控制。

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

- [ ] Agent 角色预定义（在 config 中配置常用角色）
- [ ] `max_depth` 嵌套深度限制
- [ ] `max_threads` 并发线程数限制
- [ ] `job_max_runtime_seconds` 超时控制
- [ ] Agent 间通信增强（当前 SendMessage 已有基础）
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
