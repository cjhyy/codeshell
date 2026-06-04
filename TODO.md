# CodeShell TODO

> 长期路线图。近期执行队列放在 `TODO-week.md`。
> 只保留未完成、部分完成、待确认项；历史归档内容不再放在本文里。
> 标注：🔧 部分完成 | ⬜ 未开始 | ❓ 待确认

---

## P0 — 安全、权限与隔离基石

### ⬜ 沙箱执行系统（Sandbox）

当前 Bash 工具直接执行命令，无隔离保护。需要引入沙箱机制防止 AI 执行的命令造成不可逆损害。

- [ ] macOS: 基于 `sandbox-exec` / Seatbelt 实现文件系统与网络隔离
- [ ] Linux: 基于 Landlock / bubblewrap 实现沙箱
- [ ] 定义 `SandboxPolicy` 类型：allowed paths read/write、network access、process policy
- [ ] 在 Bash 工具中集成沙箱包装
- [ ] 沙箱失败时优雅降级，并给出可理解的权限/风险提示
- [ ] 配置项：`sandbox.enabled`、`sandbox.allowNetworkFor` 等白名单

### 🔧 权限系统增强

当前权限系统已有基础；剩余重点是细粒度规则、路径策略接入与用户可理解的授权体验。

- [ ] 支持路径级别权限规则：如“允许写入 src/ 下的文件”
- [ ] 支持命令模式匹配：如“允许 `bun test`、`bun run build`”
- [ ] 会话级权限缓存：同一会话内相同操作不重复询问
- [ ] `/permissions` 命令查看和管理当前权限规则
- [ ] **路径策略 block 接入权限系统**：访问 workspace 外路径（如 Desktop、`~/.code-shell`）被 path policy block 时，不应只硬拒绝；应展示原因，并允许用户批准本次/本会话/特定路径
- [ ] **原工具可继续运行**：用户批准路径后，Read/Glob/Grep 等原工具应能继续执行，避免被迫绕到 Bash 导致策略不一致
- [ ] 审计路径授权：记录批准来源、范围、过期策略与被拒原因

### ⬜ Guardian 子代理审批

用轻量 guardian agent 辅助判断低/中风险操作，减少用户打断；高风险操作仍强制人工确认。

- [ ] 实现 `GuardianAgent`：接收操作描述，返回 approve/deny/escalate
- [ ] 配置项：`approvals.reviewer: "guardian_subagent" | "user" | "auto"`
- [ ] Guardian 使用轻量模型降低成本
- [ ] 高风险操作仍强制用户确认：删除、force push、外部发布、共享状态修改等
- [ ] Guardian 判断日志可审计

---

## P1 — 核心运行可靠性

### ❓ LLM / Engine 待确认问题

- [ ] **OpenAI 截断续写触发条件不匹配**：OpenAI provider 透传 `finish_reason === "length"`，而 turn-loop 仍按 `stopReason === "max_tokens"` 判断；需要归一为 `"length" | "max_tokens"`
- [ ] **RunManager approval/input resume 竞态**：单独审查 Waiting states 的 suspend/resume 路径
- [ ] **`resolveSandboxBackend` 每 turn 都重 resolve**：应移到 Engine 构造器或加 per-session 缓存
- [ ] **Plugin SessionStart hook 运行时验证**：确认 superpowers `hooks/hooks.json` 是否真的把 additionalContext 注入 main session prompt
- [ ] **自动化 run 卡在 `turn.start` 后、首个 `llm.request` 前**：收集 events/checkpoints/lock/heartbeat；定位 EngineRunner / RunManager / LLM request 前置路径；确认 lock release 与失败恢复

### ⬜ 错误处理与恢复

- [ ] LLM API 调用重试：指数退避、可配置 retry policy
- [ ] 网络断开自动重连
- [ ] 会话崩溃恢复：RunManager 的 `recover` 已部分实现，需补齐产品闭环
- [ ] 工具执行超时处理与可取消性一致化
- [ ] 优雅的错误消息：用户友好、包含下一步建议

### ❓ ApplyPatch 原子性确认

ApplyPatch 工具已存在；仍需确认原子性是否真正做到“全部成功或全部回滚”。

- [ ] 审查 `packages/core/src/tool-system/builtin/apply-patch/` 原子性实现
- [ ] 补失败回滚测试：多文件 patch 中某个 hunk 失败时，所有文件保持原状

---

## P2 — 交互体验与工作流效率

### ⬜ 运行中输入缓存 / 强制发送下一轮

- [ ] 当前轮运行中允许用户继续输入
- [ ] 默认缓存为 queued input，当前轮完成后自动进入下一轮
- [ ] 支持显式“强制发送/打断并进入下一轮”
- [ ] UI 展示“已缓存 N 条/将于本轮后发送”
- [ ] 避免与 approval prompt、AskUserQuestion、后台 agent 通知、automation/headless run 混淆
- [ ] desktop + TUI 行为一致

### ⬜ GenerateImage 工具结果直接展示图片

- [ ] 确认 tool result 的图片路径是否进入 transcript/content block
- [ ] 确认 desktop Markdown/tool-result renderer 是否支持 tool result 本地 PNG 预览
- [ ] 设计 GenerateImage 返回结构：保留路径文本，同时提供可渲染 image block 或 Markdown image
- [ ] 补 desktop 渲染测试/手动 smoke，确保生成后结果区可直接看到图片

### ⬜ Markdown 内容结构与渲染体验优化

- [ ] 梳理 desktop/TUI Markdown 渲染差异：标题、列表、引用、代码块、图片、链接、表格
- [ ] 优化长回答结构：摘要优先、分节标题、步骤列表、结果块、注意事项分离
- [ ] 优化代码块展示：语言标签、复制按钮、长代码折叠/滚动策略
- [ ] 优化图片/链接混排：本地图片路径、图床链接、Markdown image/link 的展示一致性
- [ ] 明确工具结果中的 Markdown 结构规范，避免正文、JSON、日志混在一起难以阅读
- [ ] 补充渲染 smoke/demo，用典型长 Markdown 验证 desktop 与 TUI 表现

### ⬜ Undo / 撤销系统

- [ ] 文件操作前自动备份（基于 file-history 扩展）
- [ ] `/undo` 命令：撤销最近一次文件修改
- [ ] `/undo all` 命令：撤销当前会话所有修改
- [ ] 显示 diff 预览再确认撤销
- [ ] 与 git 集成：自动 stash 或创建 undo commit

### ⬜ Shell Snapshot

- [ ] 捕获命令执行后的 stdout/stderr 完整输出
- [ ] 智能截断：超长输出保留头尾 + 中间摘要
- [ ] 错误输出高亮标注
- [ ] 退出码语义化：非零退出码自动标记为失败

---

## P3 — 上下文、记忆与指令系统

### 🔧 跨会话记忆系统（Memories）

基础 pipeline 与 Memory 工具已存在；剩余待办偏向产品打磨。

- [ ] 记忆合并（consolidation）：相似记忆去重合并
- [ ] 记忆注入：新会话启动时自动加载相关记忆到 prompt
- [ ] 记忆管理命令：`/memories list`、`/memories clear`、`/memories edit`
- [ ] 可配置：`memories.maxAge`、`memories.maxCount`、`memories.extractionModel`

### 🔧 AGENTS.md 层级指令系统

`AGENTS.md` 文件名兼容已支持；剩余为层级覆盖与作用域语义。

- [ ] 实现层级覆盖：深层目录的指令覆盖浅层
- [ ] 支持 `AGENTS.local.md`：不入版本控制的本地指令
- [ ] 指令作用域标注：当前目录 vs 全局
- [ ] 在 prompt 中按作用域排序注入

### ⬜ 智能上下文管理

当前 3 级 compaction 已实现，但可以更智能。

- [ ] 文件内容缓存去重：同一文件多次读取只保留最新版本
- [ ] tool result 压缩：大输出自动截断 + 摘要
- [ ] 请求压缩（`enable_request_compression`）：发送前压缩历史消息
- [ ] token 预算管理：根据剩余 token 动态调整策略

---

## P4 — 插件、MCP 与扩展能力

### 🔧 插件 MCP 加载/禁用链路收尾

- [ ] 安装插件后，新 session 自动加载插件 MCP
- [ ] 禁用插件后，不再合并 MCP server
- [ ] 禁用插件后，已连接 server 被 disconnect
- [ ] 禁用插件后，`ToolRegistry` 对应 MCP tools 被 unregister
- [ ] 重新启用插件后，可重新 connect/register

### ⬜ MCP 管理页展示插件提供的 MCP server

插件强相关 MCP 不应由普通 MCP 配置页编辑其 command/args/env，但应在 MCP 管理页可见。

- [ ] MCP 管理页合并展示配置态 MCP 与运行态/插件提供 MCP
- [ ] 为 server 增加来源/所有者信息：`source: "project" | "user" | "plugin" | "builtin" | "runtime"`、`owner`、`editable`
- [ ] 插件 MCP 显示为只读配置：状态、工具数、工具列表、错误信息可查看；命令/参数不可编辑
- [ ] UI 文案标注“由 xxx 插件管理”，避免用户误以为没有连接
- [ ] 保留用户配置 MCP 的编辑/启停能力；插件 MCP 的启停走插件开关或明确的只读/会话级操作

### ⬜ Feature Flags 系统

- [ ] 定义 `FeatureFlags` 类型和默认值
- [ ] 从配置文件加载 flags
- [ ] 在各模块中检查 flag 状态
- [ ] `/features` 命令查看和切换 flags
- [ ] 候选 flags：`web_search`、`shell_tool`、`fast_mode`、`undo`、`shell_snapshot`

### 🔧 配置系统完善

- [ ] 支持 YAML 配置（目前是 JSON）
- [ ] 配置 JSON Schema 生成（IDE 自动补全）
- [ ] `/config` 命令交互式编辑配置
- [ ] 配置迁移机制：版本升级时自动迁移旧配置

---

## P5 — Agent / 多代理能力

### 🔧 后台 agent 完成通知机制（消灭 Sleep+AgentStatus 轮询）

- [ ] 改 Agent 工具的 schema description + tool prompt：后台 agent 会自动通知完成，不要 sleep/poll
- [ ] 改 background spawn 的 tool_result 文本：明确 async agent 已启动、结果会自动回来
- [ ] 实现“自动注入完成消息”机制：`markCompleted/markFailed` 后把结果作为下一 turn 输入注入主 session
- [ ] outputFile 机制 + 删 AgentStatus：每个 background agent 写 `~/.code-shell/agents/<agentId>.txt`
- [ ] auto-background after 120s：同步 `Agent(...)` 跑超过 120s 自动转后台

### 🔧 对齐 CC 的 subagent_type / agents 目录机制（剩余项）

- [ ] 把 `agent_type` 升级为 schema enum，动态注入已 load 的 kind 名让 LLM 看得见
- [ ] `AsyncAgentEntry.name` 改成填 kind name：增强 dock 显示
- [ ] 主 agent 系统 prompt 加 kind 选择指南

### 🔧 其他多代理增强

- [ ] Agent 角色预定义到 config：已有用户级目录可放，但缺 settings-level 默认配置
- [ ] `max_depth` 嵌套深度限制
- [ ] `max_threads` 并发线程数限制
- [ ] `job_max_runtime_seconds` 超时控制
- [ ] Agent 间通信：评估 mailbox 路线；决定补齐 mailbox 还是删除半成品 `SendMessage` / `agentCoordinator`
- [ ] `task` 加 `agentId` tag，避免子 agent task 混进主视图
- [ ] Agent 执行结果汇总视图
- [ ] per-agent skill 精选层：给 agent 定义加 `skills: [...]` 字段

---

## P6 — 模型与工具能力扩展

### ⬜ Model Provider 增强

- [ ] 支持通过外部命令获取 token：`auth.command`
- [ ] 支持自定义 HTTP headers：`env_http_headers`
- [ ] `reasoning_summary` 参数支持
- [ ] `service_tier` 参数支持
- [ ] 模型自动降级：主模型失败时切换备用模型

### ⬜ Code Review 内置命令

- [ ] `/review` 命令：审查当前 git diff 或指定文件
- [ ] 结构化输出：findings 列表，含优先级（P0-P3）、置信度、位置
- [ ] 支持 JSON 输出格式：方便 CI/CD 集成
- [ ] 可配置审查维度：安全、性能、可读性、正确性
- [ ] 支持增量审查：只审查变更部分

### ⬜ view_image 后续增量

- [ ] TUI 端图片渲染：终端 inline image（iTerm/kitty graphics protocol）
- [ ] 策略 B：看过一轮后把历史图降级成文字摘要，以进一步节省 token

---

## P7 — 工程质量、性能与文档

### 🔧 测试覆盖

- [ ] 工具集成测试：每个 builtin tool
- [ ] E2E 测试：完整对话流程
- [ ] CI 流水线：GitHub Actions
- [ ] 测试覆盖率 > 60%
- [ ] 清理已知不稳定 / 待修测试

### ⬜ 性能优化

- [ ] 启动时间优化：懒加载非核心模块
- [ ] 流式渲染优化：减少不必要的重渲染
- [ ] 大文件处理优化：分块读取、增量搜索
- [ ] MCP 连接池复用

### 🔧 文档

- [ ] 用户指南：Getting Started、Configuration、Tools Reference
- [ ] 开发者文档：Contributing Guide
- [ ] API 文档：公开 API 的 TypeDoc
- [ ] 中文文档
