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

- [x] **OpenAI 截断续写触发条件不匹配** ✅：已归一。`isTruncatedStop`(llm/stop-reason.ts)接受 `"length"`(OpenAI)与 `"max_tokens"`(Anthropic),turn-loop 截断续写/截断工具调用两处都用它。测试 stop-reason.test.ts + openai-stream-stop.test.ts。
- [x] **RunManager approval/input resume 竞态** ✅：审查发现两处真隐患并修复——(1) `resume()`/`cancel()` 多 await 点 + 顶部状态检查读到陈旧 `waiting_*`(直到后面 `await transition` 才变),并发双 resume(双击批准)或 resume/cancel 互穿都能双双过检查;加 `resolvingRuns` 每-run 串行守卫(迟到者明确拒绝)。(2) handle 在场但 input 类型不匹配(给 waiting_approval 喂 userInput)会穿到 Case 2 **重新入队一个全新执行**而原 Engine 仍挂起→重复 run+泄漏 handle;改为明确报错。handle 的 resolveApproval 本身幂等(`!pendingApproval` 返回 false)缓解了双 resolve。测试 `RunManager.resume-race.test.ts`(去守卫后并发测试确实失败,证明有效)
- [x] **`resolveSandboxBackend` 每 turn 都重 resolve** ✅：已缓存 by `(mode, cwd)`。`EngineRuntime.resolveSandbox`(共享)与 `Engine.resolveSandboxWithoutRuntime`(无 runtime 回退)各有 cache;run 路径 1065-1066 走缓存版,绝不裸调 resolveSandboxBackend;rejection 不缓存(改配置后可重试)。补 runtime.sandbox-cache.test.ts(同键同 promise/异键新建/rejection 不缓存)。
- [x] **Plugin SessionStart hook 运行时验证** ✅：已确认全链路通。`runPluginCommandHook` 把 stdout 的 additionalContext(CC `hookSpecificOutput.additionalContext` / Cursor `additional_context` / SDK `additionalContext` 三形态)→ `HookResult.messages`,engine.ts:1464 把 `on_session_start` 的 messages splice 进 user prompt 前的 `<system-reminder>`。本会话开头的 "You have superpowers" 即此机制。测试 `plugins/pluginCommandHook.test.ts`(6 用例,含失败兜底)
- [x] **自动化 run 卡在 `turn.start` 后、首个 `llm.request` 前** ✅(复核):lock release 与失败恢复已闭环——RunManager 执行 `finally` 块统一 `lock.release` + `executionHandles.delete` + `heartbeat.stop`(engine.ts run 段 640-645);recover() 对 stale-heartbeat 且进程已死的 running/waiting run 重置(340+)。原"卡住"现象的两个真因(preload rpc 30s 硬超时误伤长任务 d50c365、main 同步 fs 阻塞事件循环 178abc8)均已在 main 修复,见记忆 [[project_rpc_30s_timeout_freeze]] / [[project_main_sync_fs_freeze]]。

### ⬜ 错误处理与恢复

- [ ] LLM API 调用重试：指数退避、可配置 retry policy
- [ ] 网络断开自动重连
- [ ] 会话崩溃恢复：RunManager 的 `recover` 已部分实现，需补齐产品闭环
- [ ] 工具执行超时处理与可取消性一致化
- [ ] 优雅的错误消息：用户友好、包含下一步建议

### ✅ ApplyPatch 原子性确认

ApplyPatch 工具已存在；原子性已核实并补测试。

- [x] 审查 `packages/core/src/tool-system/builtin/apply-patch/` 原子性实现 —— plan-then-commit 两阶段，commit 失败用规划期内存快照回滚（TOCTOU-safe），见 `applier.ts`
- [x] 补失败回滚测试：见 `apply-patch/atomicity.test.ts`（plan 期失败零写入 / commit 期失败回滚已写文件 / 回滚删除新增文件 / allowPartialOnCommit codex 语义）

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

### ✅ AGENTS.md 层级指令系统

经核实 `instruction-scanner.ts` 已实现全部层级语义,补测试锁定。

- [x] 实现层级覆盖：从 git root 走到 cwd,`depth` 0→N(越深越大),combineInstructions 按 root→cwd 排序使深层指令排在最后(LLM 更重视后文=就近覆盖)
- [x] 支持 `AGENTS.local.md`：每个指令名都派生 `.local.md` 变体(source:"local"),不入版本控制
- [x] 指令作用域标注：`sourceLabel` 输出 "project (depth N)" / "local override (depth N)" / "user-level" 注释头
- [x] 在 prompt 中按作用域排序注入：managed→user→project(root→cwd)→local;扫描止于 git root。测试 instruction-scanner.test.ts

### ⬜ 智能上下文管理

当前 3 级 compaction 已实现，但可以更智能。

- [ ] 文件内容缓存去重：同一文件多次读取只保留最新版本
- [ ] tool result 压缩：大输出自动截断 + 摘要
- [ ] 请求压缩（`enable_request_compression`）：发送前压缩历史消息
- [ ] token 预算管理：根据剩余 token 动态调整策略

---

## P4 — 插件、MCP 与扩展能力

### ⬜ Workspace 数据源绑定与作用域分配（Roadmap）

每个项目都是一个 workspace。用户可以把不同外部数据源 link 到 CodeShell，再按 workspace 分配可访问的数据范围，让 agent 只读取和操作该 workspace 关联的内容。

- [ ] 定义 workspace 级资源模型：project path、linked data sources、allowed scopes、默认读取策略
- [ ] 支持 link 外部数据源：Figma、文档库、issue/PR、云盘、知识库、数据库等
- [ ] 支持按 workspace 分配数据源范围：例如只允许某个 workspace 读取指定 Figma 文件/页面/组件
- [ ] Agent 读取上下文时自动发现当前 workspace 已授权的数据源与范围
- [ ] 工具调用必须检查 workspace scope，避免跨项目读取未分配内容
- [ ] 提供管理 UI/命令：查看当前 workspace 绑定了哪些数据源、哪些文件/资源可读
- [ ] 记录授权来源、更新时间、失效/撤销状态，保证可审计与可撤销

### ✅ 插件 MCP 加载/禁用链路收尾

链路全通(reconcile→disconnect→unregister),并补上 reconcile 的 catch/日志兜底。

- [x] 安装插件后，新 session 自动加载插件 MCP（mergePluginMcpServers,ea9dc50)
- [x] 禁用插件后，不再合并 MCP server（reconcile 按 enabled!==false 过滤)
- [x] 禁用插件后，已连接 server 被 disconnect（reconcile 把 stale 全 disconnect)
- [x] 禁用插件后，`ToolRegistry` 对应 MCP tools 被 unregister（disconnect 的 finally 块逐工具 unregisterTool)
- [x] 重新启用插件后，可重新 connect/register（connectAll 幂等)
- [x] **`engine.ts` 的 async reconcile 加 catch/日志兜底**（原 `void reconcile()` 无 catch,失败=未处理拒绝可崩主进程;已加 `.catch` → `engine.mcp_reconcile_failed` 日志。测试 engine-config-hot-reload.test.ts)

### ⬜ MCP 管理页展示插件提供的 MCP server

插件强相关 MCP 不应由普通 MCP 配置页编辑其 command/args/env，但应在 MCP 管理页可见。

- [ ] MCP 管理页合并展示配置态 MCP 与运行态/插件提供 MCP
- [ ] 为 server 增加来源/所有者信息：`source: "project" | "user" | "plugin" | "builtin" | "runtime"`、`owner`、`editable`
- [ ] 插件 MCP 显示为只读配置：状态、工具数、工具列表、错误信息可查看；命令/参数不可编辑
- [ ] UI 文案标注“由 xxx 插件管理”，避免用户误以为没有连接
- [ ] 保留用户配置 MCP 的编辑/启停能力；插件 MCP 的启停走插件开关或明确的只读/会话级操作

### 🔧 Feature Flags 系统

- [x] 定义 `FeatureFlags` 类型和默认值（`settings/feature-flags.ts` 的 `FEATURE_FLAGS` const,typo-safe 名集 + 各自 default）
- [x] 从配置文件加载 flags（`settings.featureFlags` Zod 字段,project 覆盖 user 走常规 merge,空={}默认)
- [x] 在各模块中检查 flag 状态（`isFeatureEnabled`;首个消费者:engine toolDefs 按 `TOOL_FEATURE_FLAGS`(WebSearch→web_search、Bash→shell_tool)隐藏关闭的工具,每 turn 重读=下条消息生效)
- [x] `/features` 命令查看 flags（TUI command,经 config query 读 `getFeatureFlags()` 解析态;**只读**,切换走 settings.json/Customize)
- [x] 候选 flags 全部登记：`web_search`(默认开)、`shell_tool`(默认开)、`fast_mode`、`undo`、`shell_snapshot`(后三默认关)
- 备注:`/features` 写入(命令内直接 toggle)与 fast_mode/undo/shell_snapshot 的真实消费端接线后续按需补;系统底座 + 工具可见性闭环已就绪。测试 feature-flags.test.ts

### 🔧 配置系统完善

- [ ] 支持 YAML 配置（目前是 JSON）
- [ ] 配置 JSON Schema 生成（IDE 自动补全）
- [ ] `/config` 命令交互式编辑配置
- [ ] 配置迁移机制：版本升级时自动迁移旧配置

---

## P5 — Agent / 多代理能力

### ⬜ 远程控制入口 / 跨代理编排（Roadmap）

让 CodeShell 作为统一控制台，通过安全授权连接远程设备/环境，并编排 Codex、Claude Code 等外部 coding agent 干活。

- [ ] 支持 SSH 连接远程机器或开发环境
- [ ] 支持手机扫码 / 临时配对码完成设备授权与会话绑定
- [ ] 定义远程控制会话：CodeShell 下发任务、跟踪状态、收集日志与产物
- [ ] 支持编排 Codex CLI、Claude Code 等外部 coding agent 执行任务
- [ ] 统一管理外部 agent 的 cwd、权限、审批、日志、产物与失败恢复
- [ ] 明确安全边界：不自动外发密钥，不绕过外部 agent 自身审批，不允许未授权远控

### 🔧 后台 agent 完成通知机制（消灭 Sleep+AgentStatus 轮询）

- [ ] 改 Agent 工具的 schema description + tool prompt：后台 agent 会自动通知完成，不要 sleep/poll
- [ ] 改 background spawn 的 tool_result 文本：明确 async agent 已启动、结果会自动回来
- [ ] 实现“自动注入完成消息”机制：`markCompleted/markFailed` 后把结果作为下一 turn 输入注入主 session
- [ ] outputFile 机制 + 删 AgentStatus：每个 background agent 写 `~/.code-shell/agents/<agentId>.txt`
- [ ] auto-background after 120s：同步 `Agent(...)` 跑超过 120s 自动转后台

### ✅ 对齐 CC 的 subagent_type / agents 目录机制（剩余项）

- [x] 把 `agent_type` 升级为 schema enum，动态注入已 load 的 kind 名让 LLM 看得见（`agentToolDefWithTypes`；空 registry 维持自由串）
- [x] `AsyncAgentEntry.name` 改成填 kind name：省略 name 时回退 resolvedType，增强 dock 显示
- [x] 主 agent kind 选择指南：`buildAgentTypesBlock` 已注入 Agent 工具描述（含 enum）

### 🔧 其他多代理增强

- [ ] Agent 角色预定义到 config：已有用户级目录可放，但缺 settings-level 默认配置
- [x] `max_depth` 嵌套深度限制 —— 现为有意的扁平层级(depth=1):`isSubAgent` 两道把关(engine spawn 剥 Agent 工具 + agent.ts 运行时拒绝),子 agent 不能再 spawn。配置化暂无必要(放孙代理违背无状态设计)。
- [x] `max_threads` 并发线程数限制 —— `MAX_BACKGROUND_AGENTS=6`(对齐 Codex),agent.ts 超限拒绝并提示。
- [x] `job_max_runtime_seconds` 超时控制 —— 经核实**有意不设**同步子 agent 墙钟超时(见 agent.ts 注释:旧 5min 超时既误杀重活又制造 double agent_end 竞态);边界由 maxTurns + 各工具自身超时 + parent/user abort 兜底。
- [x] **Agent 间通信:决定删除半成品** —— `SendMessage` / `agentCoordinator` 是死代码:coordinator 的 `register()`/`receive()` 从未被调用(Agent 工具用的是另一套 `asyncAgentRegistry`),所以 SendMessage 永远找不到目标。且扁平无状态设计本就不该有 mailbox,后台完成回灌已走 `notificationQueue`。已删两文件 + 反注册工具 + 清 toolDisplay,从 LLM 工具面移除这个坏工具。
- [ ] `task` 加 `agentId` tag，避免子 agent task 混进主视图
- [ ] Agent 执行结果汇总视图
### ✅ 子 agent skill 隔离（per-agent skill allowlist）

已实现硬隔离：director 子 agent 物理上只看到自己的 skill。照搬了现有 `tools` 白名单链路（overrides → SubAgentSpawnRequest → EngineConfig → PromptComposer + ToolContext）。

- [x] `agent/agent-definition.ts`：解析时保留 `skills`（数组/逗号串归一，抽 `normalizeNameList`，tools 一并升级）；`serializeAgentDefinition` 对称回写
- [x] `tool-system/builtin/agent.ts`：构造子 engine 时把 `def.skills` 作为 skill allowlist 下传（`overrides.skillAllowlist`，类比 `toolAllowlist: def.tools`）
- [x] `skills/scanner.ts` + `tool-system/builtin/skill.ts`：scan/列出/invoke 接收 allowlist（`ScanSkillsOptions.skillAllowlist` / `ctx.skillAllowlist`），未在 allowlist 的 skill 不进 system prompt，也拒绝 invoke（专属报错）
- [x] `buildAgentTypesBlock`：受限 agent 在 agent types 块显示 skill 集（仅受限时显示）
- [x] 未配 `skills:` → 维持现状（继承项目全量池），向后兼容（`undefined` vs `[]` 语义区分）
- [x] 测试：`scanner.allowlist.test.ts` / `agent-definition.skills.test.ts` / `skill.allowlist.test.ts`（15 用例）

---

## P6 — 模型与工具能力扩展

### ⬜ Model Provider 增强

- [ ] 支持通过外部命令获取 token：`auth.command`
- [ ] 支持自定义 HTTP headers：`env_http_headers`
- [ ] `reasoning_summary` 参数支持
- [ ] `service_tier` 参数支持
- [ ] 模型自动降级：主模型失败时切换备用模型

### ⬜ 多 provider 图片 / 视频生成工具（统一内置工具 + 连接 tab 配置）

把生图/生视频从「写死 OpenAI」升级为**统一内置工具 + 多 provider 适配器**，且**配置了才进可用工具池**（沿用 `isGenerateImageAvailable` 的 tool-visibility guard 与 `SearchConnectionsPanel` 的多卡片连接范式）。

> 现状：`GenerateImage` 已存在，但写死复用 `kind:"openai"` provider + 模型 `gpt-image-2`（`packages/core/src/tool-system/builtin/generate-image.ts`）；可见性已走 guard。连接 tab（`SearchConnectionsPanel`）已是「多 provider 卡片：配置/测试/默认/清除/状态 pill」的成熟样板，注释里已预告「以后新增浏览器、仓库、外部数据源按工具分组放这里」。本条就是把图片/视频接进这套范式。

**A. 图片生成（GenerateImage 泛化为多 provider）**
- [ ] 抽 `ImageProvider` 适配器接口：`generate(prompt, opts) → { b64/url }`，统一入参（size/quality/n）与错误归一
- [ ] 内置适配器：OpenAI `gpt-image`（迁移现有实现）、Google Gemini「Nano Banana」（Gemini 2.5 Flash Image）；预留 1~2 个扩展位
- [ ] provider/模型从配置读取，不再写死 `gpt-image-2`；落盘路径仍 `<cwd>/.code-shell/generated_images/`
- [ ] 工具入参加可选 `provider` / `model`；未指定走该类目「默认 provider」

**B. 视频生成（新内置工具 GenerateVideo）**
- [ ] 新增 `GenerateVideo` 内置工具：text-to-video（首期）；产物写 `<cwd>/.code-shell/generated_videos/`，返回绝对路径
- [ ] `VideoProvider` 适配器接口：处理**异步任务轮询**（生视频普遍是 submit→poll→download 异步流程，不同于同步生图）
- [ ] 内置适配器：即梦（字节 Dreamina/Seedance）、可灵（Kling）；预留其他（Sora/Veo 等）扩展位
- [ ] 长任务与超时：复用/对齐 `index.ts` 已有的 GenerateImage 600s 放宽逻辑，避免 rpc 30s 误杀；考虑后台任务 + 完成通知

**C. 连接 tab 配置（settings 连接页新增分组）**
- [ ] 连接页新增「图片生成」「视频生成」两个 provider 分组（复刻 `SearchConnectionsPanel` 卡片：apiKey/baseUrl/model、测试连接、设为默认、清除、状态 pill）
- [ ] settings schema：`imageGen.providers[]` / `videoGen.providers[]`（各带 default provider）；按 user/project scope 隔离，密钥存 `~/.code-shell/settings.json`
- [ ] 复用 search 的 legacy→providers 迁移与 probe 范式；为生图/生视频实现各自 `probe`（轻量鉴权/配额校验）

**D. 可见性闭环（配了才可用）**
- [ ] `isGenerateImageAvailable` 泛化：任一 image provider 配齐 → GenerateImage 进工具池；否则隐藏
- [ ] 新增 `isGenerateVideoAvailable`：任一 video provider 配齐 → GenerateVideo 进池
- [ ] tool prompt/描述按已配 provider 动态生成（告诉模型有哪些 provider/model 可选）
- [ ] 测试：未配 → 工具不出现且 invoke 被拒；配了某 provider → 仅该 provider 可用；多 provider → 默认生效、可指定覆盖

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
