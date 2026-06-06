# 本周 TODO — 2026-06-03 → 2026-06-09

> 本周全量执行队列：把 `TODO.md` 的未完成项和本周新增产品项都拍到这里。完成一项就勾掉或移出；本文件暂时作为唯一执行看板。

## 执行原则

- [ ] 先做会影响全局命名 / scope / schema 的底座，再做依赖它的 UI 和工具。
- [ ] 每个大块完成后跑对应测试；改 core 后至少跑 core 相关测试，改 desktop 后至少跑 renderer/main 相关测试和一次手动 smoke。
- [ ] 已确认完成的旧项从本周看板移除；长期路线原文留在 `TODO.md`，这里按执行顺序重排。

---

## 1. Workspace / 设置 Scope / 预设底座

### 1.1 项目概念升级为 Workspace

当前“项目/project”和 workspace 本质上是同一个对象，先做概念升级，避免后续设置页继续扩散 project 命名。

- [ ] UI 文案、侧边栏、设置页 scope、session 归属统一改成 workspace 认知。
- [ ] Hooks / 环境 / 子代理 / 预设选择器统一使用 workspace 选择交互。
- [ ] 底层 `.code-shell/settings.json` 路径语义可以保持，只消除命名混乱，不做重兼容迁移。
- [ ] 梳理 renderer/main/preload 类型里 `project` / `repo` / `workspace` 的边界，必要时分阶段改名。

### 1.2 设置页统一 Workspace 选择器

- [ ] 抽一个可复用 workspace picker，用于 Hooks、环境、子代理、预设等 project-scope 表单。
- [ ] 切换 workspace 时加载对应 `.code-shell/settings.json`。
- [ ] 保存只写当前选中的 workspace。
- [ ] 有未保存改动时给出脏状态提示，避免切换丢失。

### 1.3 本地环境设置支持切换 Workspace

- [ ] 环境页像 Hooks 一样先选 workspace。
- [ ] setup / cleanup 脚本按 workspace 读取和保存。
- [ ] KEY=VALUE 变量按 workspace 读取和保存。
- [ ] macOS / Linux / Windows 分 tab 的内容切换 workspace 后保持正确。

### 1.4 设置页子代理配置改为 Workspace 优先

- [ ] 子代理设置页先选 workspace，再编辑该 workspace 的子代理配置。
- [ ] 明确用户级默认子代理与 workspace 覆盖规则。
- [ ] 子代理列表、详情编辑、保存、删除都绑定当前 workspace。
- [ ] 交互参考 Hooks 的 workspace-scope 编辑模式。

### 1.5 整套预设管理：从 Prompt 到子代理

补完整 preset/profile 层，而不是只改单项设置。

- [ ] 明确概念命名：`general` 作为底座 preset；`terminal-coding` 更像内置 coding profile；Seedance 这类是 workspace profile。
- [ ] 常规页增加入口选择：让用户选择“写代码”还是“普通用户/通用任务”，对应启用 coding profile 或 general profile。
- [ ] 在设置页、会话顶栏或 workspace 信息区显示当前 active profile，让用户知道当前不是隐式跑在 terminal-coding。
- [ ] 增加 Profile 配置页：可查看、编辑、复制、导入、导出 profile。
- [ ] 设计 profile schema：base preset、主 agent prompt / 自定义指令、模型、权限、工具默认值、skills、hooks、env、子 agent 定义与路由配置。
- [ ] 梳理 prompt 组装顺序：customSystemPrompt、appendSystemPrompt、preset 段、personalization、AGENTS.md、skills、agent types。
- [ ] 梳理子 agent 继承 / 覆盖规则：模型、工具、skills、prompt、env、权限。
- [ ] 设置页支持创建、选择、编辑、复制、删除、导入、导出 profile。
- [ ] Profile 可按用户级和 workspace 级应用。
- [ ] 启动新 session 时明确当前使用的 workspace + profile，以及 profile 选择的 base preset。

---

## 2. Desktop 工作台与输入体验

### 2.1 输入框图片附件显示 / 携带路径

- [ ] 输入框里的图片附件同时显示缩略图和 path。
- [ ] 明确发送给模型 / 工具时是否携带 path 元数据。
- [ ] 粘贴、拖拽、文件选择三条入口行为一致。
- [ ] `chat/attachments.ts` title / wire payload 保留图片来源信息。
- [ ] 当前模型不支持图片时，提示里仍保留 path 便于用户引用。

### 2.2 文件结果卡片支持选择打开方式

- [ ] assistant 输出的文档卡片增加“打开方式”菜单。
- [ ] 已编辑文件卡片也能打开方式选择，而不只展示 diff / 路径。
- [ ] 菜单项：Cursor、系统默认 app、Terminal、在文件夹中打开。
- [ ] 抽复用的 open-with 行为，避免每个卡片重复实现。

### 2.3 四面板内文件也能用其他应用打开

- [ ] 文件面板里的文件入口接入同一套打开方式菜单。
- [ ] 审查面板 / diff 文件入口接入同一套打开方式菜单。
- [ ] 浏览器圈选或页面标记关联文件时，能定位到文件或用外部 app 打开。
- [ ] Terminal 面板里可点击文件路径时，复用打开方式能力。

### 2.4 四面板放大 / 缩小并可覆盖输入区

- [ ] `PanelArea` 增加放大 / 缩小状态。
- [ ] 放大态可临时覆盖或占用输入框区域，给文件预览、diff、浏览器更多空间。
- [ ] 返回普通态时保留输入草稿、附件、queued input。
- [ ] 窄屏 / 移动尺寸不遮挡关键操作。
- [ ] 用 Browser / Playwright 做桌面和窄屏 smoke。

### 2.5 `<codeshell-annotations>` 标注块独立样式

- [ ] 写 rehype 插件把 `<codeshell-annotations>` 转成可样式化节点。
- [ ] 样式用左侧色条 + 浅底色 + 圆角边框，和普通消息区分。
- [ ] 覆盖 Markdown 纯文本、列表中嵌入、长内容换行。
- [ ] 补 Markdown 渲染测试。

### 2.6 Markdown 内容结构与渲染体验优化

- [ ] 梳理 desktop / TUI Markdown 渲染差异。
- [ ] 优化标题、列表、引用、代码块、图片、链接、表格。
- [ ] 代码块补语言标签、复制按钮、长代码折叠 / 滚动策略。
- [ ] 工具结果 Markdown 结构规范化，避免正文、JSON、日志混在一起。
- [ ] 补长 Markdown smoke / demo。

### 2.7 运行中输入缓存 / 强制发送下一轮收尾

- [ ] 确认 desktop 当前轮运行中继续输入、queued input、打断发送都稳定。
- [ ] 确认 TUI 行为一致。
- [ ] 避免与 approval prompt、AskUserQuestion、后台 agent 通知、automation/headless run 混淆。
- [ ] 补残缺测试或 smoke。

### 2.8 手动停止消息样式

- [ ] 用户手动停止 / 中断 turn 时，用独立的轻量状态行展示，例如“你在 18s 后停止了”。
- [ ] 这类手动停止提示不需要折叠，不进入 tool / thinking 折叠卡片。
- [ ] 放在对应 assistant 输出下方，视觉上参考截图：右侧弱文本 + 分隔线，避免打断正文阅读。
- [ ] 区分用户手动停止、超时停止、错误停止、模型自然结束。
- [ ] 补 renderer 流事件 / message 分组测试。

### 2.9 图片预览支持下载

- [ ] 图片除了能在消息 / 输入框 / tool result 中预览，也要提供下载按钮。
- [ ] 下载支持生成图、用户上传图、paste / drag 图片，以及本地 `codeshell-path:` 图片。
- [ ] 下载时保留合理文件名；没有文件名时按来源和时间生成。
- [ ] 图片 lightbox / 附件卡 / tool result 图片入口复用同一套下载行为。
- [ ] 下载失败时给出明确提示，并保留“在文件夹中打开”兜底。

### 2.10 Undo / 撤销系统

- [ ] 文件操作前自动备份。
- [ ] `/undo` 撤销最近一次文件修改。
- [ ] `/undo all` 撤销当前会话所有修改。
- [ ] 撤销前显示 diff 预览并确认。
- [ ] 评估与 git 集成：stash 或 undo commit。

### 2.11 Shell Snapshot

- [ ] 捕获命令执行后的 stdout/stderr 完整输出。
- [ ] 超长输出保留头尾 + 中间摘要。
- [ ] 错误输出高亮标注。
- [ ] 非零退出码语义化标记为失败。

---

## 3. Session / Goal / 后台执行可靠性

### 3.1 Goal 模式最大轮次优化 🔧

- [x] 调研：Goal 模式由 on_stop 裁判 hook(goal-stop-hook)+ complete_goal 主动声明协作;停止条件 = maxStopBlocks(默认8 连续) + maxTurns 上限 + run-scoped token/time budget(goal.ts GoalBudgetTracker)。
- [x] 判断问题:**核心 bug = goal 运行仍用交互默认 maxTurns 100**,无人值守长目标被静默截断,且无 goal 级配置。
- [x] 按 goal 配置默认 max turns:`resolveMaxTurns` 优先级 = 显式 config > goal.maxTurns > GOAL_DEFAULT_MAX_TURNS(300) > 交互默认(100);`GoalConfig.maxTurns` 经 normalizeGoal 归一(floored,非正丢弃)。
- [x] 接近上限提示 + 失败总结:turn-loop 已有 turnsRemaining===2 预警 / ===0 强制总结;goal 续跑达 maxStopBlocks 上限输出「先停下」;judge 失败/不可解析不放行(P0)。
- [ ] 运行中续轮 / 加预算(UI 交互层,需 desktop 配合,排后)。

### 3.2 Session 内后台命令支持

已有设计：`docs/superpowers/specs/2026-06-05-background-shell-design.md`。

- [ ] 把 spec 拆成实现 plan。
- [ ] Bash 增加 `run_in_background`。
- [ ] 新增 BashOutput / KillShell / ListShells。
- [ ] core 层实现 `BackgroundShellManager`。
- [ ] 进程组杀净，避免孤儿进程。
- [ ] 运行中不灌 context，靠主动拉取输出。
- [ ] 落盘 8MB 环绕覆盖。
- [ ] app 退出 / 删除 session 时清理后台命令。
- [ ] automation 禁用后台 shell。
- [ ] desktop UI 面板二期排入实现。

### 3.3 LLM / Engine 待确认问题

- [x] OpenAI 截断续写触发条件统一 ✅：`isTruncatedStop` 已归一 length/max_tokens,turn-loop 两处都用。
- [x] RunManager approval / input resume 竞态审查 ✅：修两处——并发 resume 加 `resolvingRuns` 每-run 串行守卫;handle 在场但 input 不匹配改为报错(原会重新入队重复执行)。测试 RunManager.resume-race.test.ts(去守卫后失败证明有效)。
- [x] `resolveSandboxBackend` 缓存 ✅：EngineRuntime.resolveSandbox + Engine.resolveSandboxWithoutRuntime 均 cache by (mode,cwd),run 路径走缓存版,rejection 不缓存。测试 runtime.sandbox-cache.test.ts。
- [x] Plugin SessionStart hook 运行时验证 ✅：全链路通(runPluginCommandHook 三形态 additionalContext→messages,engine splice 进 user prompt 前 system-reminder)。测试 pluginCommandHook.test.ts。
- [ ] 自动化 run 首个 LLM 前卡住的链路复核，确认 lock release 与失败恢复。

### 3.4 错误处理与恢复

- [ ] LLM API 指数退避重试和可配置 retry policy。
- [ ] 网络断开自动重连。
- [ ] 会话崩溃恢复补齐产品闭环。
- [ ] 工具执行超时和可取消性一致化。
- [ ] 错误消息用户友好，并包含下一步建议。

### 3.5 ApplyPatch 原子性确认 ✅

- [x] 审查 `packages/core/src/tool-system/builtin/apply-patch/` 原子性实现 —— plan-then-commit + 内存快照回滚已就位。
- [x] 补多文件 patch 某个 hunk 失败时全部回滚测试 —— `apply-patch/atomicity.test.ts`。

---

## 4. Agent / 子代理 / 多代理能力

### 4.1 后台 agent 完成通知机制

- [ ] 改 Agent 工具 schema description 和 tool prompt：后台 agent 会自动通知完成，不要 sleep / poll。
- [ ] 改 background spawn tool_result 文本：明确 async agent 已启动、结果会自动回来。
- [ ] `markCompleted` / `markFailed` 后把结果作为下一 turn 输入注入主 session。
- [ ] outputFile：每个 background agent 写 `~/.code-shell/agents/<agentId>.txt`。
- [ ] 删除或替换 AgentStatus 轮询路径。
- [ ] 同步 `Agent(...)` 超过 120s 自动转后台。

### 4.2 对齐 subagent_type / agents 目录机制 🔧

- [x] 把 `agent_type` 升级为 schema enum（`agentToolDefWithTypes` 动态注入 enum=已 load 的 kind 名;空 registry 维持自由串以跑临时 agent）。
- [x] 动态注入已 load 的 kind 名，让 LLM 看得见可选子代理（enum + 描述块双管）。
- [x] `AsyncAgentEntry.name` 填 kind name：省略 `name` 时回退到 resolvedType,dock 显示有意义标签而非裸 "Agent"。
- [x] 主 agent kind 选择指南：已由 `buildAgentTypesBlock` 注入 Agent 工具描述（CC 范式,指南随工具走不重复进 system prompt）。
- [ ] Agent 角色预定义到 config：用户级目录已有，补 settings-level 默认配置。

### 4.3 子 agent skill 隔离 ✅

- [x] `agent/agent-definition.ts` 解析并保留 `skills`（YAML 列表 / 逗号串归一，复用 normalizeNameList，tools 一并升级）。
- [x] `serializeAgentDefinition` 对称回写 `skills`。
- [x] 构造子 engine 时把 `def.skills` 作为 skill allowlist 下传（overrides.skillAllowlist → SubAgentSpawnRequest.skillAllowlist → EngineConfig.skillAllowlist）。
- [x] `skills/scanner.ts` 支持 allowlist（ScanSkillsOptions.skillAllowlist，[] = 无 skill,undefined = 继承全量）。
- [x] `tool-system/builtin/skill.ts` 列出 / invoke 时按 allowlist 过滤（ctx.skillAllowlist；池外 skill 报「not available to this sub-agent」而非 not found）。
- [x] 未在 allowlist 的 skill 不进入 system prompt（PromptComposer.skillAllowlist），也拒绝 invoke。
- [x] `buildAgentTypesBlock` 显示受限 agent 的 skill 集（仅当 role 限制时显示，避免噪声）。
- [x] 未配 `skills:` 维持继承项目全量池。
- [x] 测试：`scanner.allowlist.test.ts` / `agent-definition.skills.test.ts` / `skill.allowlist.test.ts`（15 用例,含未配行为不变）。

### 4.4 多代理控制与结果视图 🔧

- [x] `max_depth`：现为有意的扁平层级(depth=1),isSubAgent 双把关,子 agent 不能 spawn。
- [x] `max_threads`：`MAX_BACKGROUND_AGENTS=6` 已存在并把关(对齐 Codex)。
- [x] `job_max_runtime_seconds`：有意不设同步墙钟超时(旧 5min 误杀重活+double agent_end 竞态),靠 maxTurns+工具超时+abort。
- [x] Agent 间通信:**删除半成品** SendMessage/agentCoordinator(死代码,register/receive 从未被调,扁平无状态设计不需要 mailbox,回灌走 notificationQueue)。
- [ ] `task` 加 `agentId` tag，避免子 agent task 混进主视图。
- [ ] Agent 执行结果汇总视图。

### 4.5 Guardian 子代理审批

- [ ] 实现 `GuardianAgent`：接收操作描述，返回 approve / deny / escalate。
- [ ] 配置项：`approvals.reviewer: "guardian_subagent" | "user" | "auto"`。
- [ ] Guardian 使用轻量模型降低成本。
- [ ] 高风险操作仍强制用户确认：删除、force push、外部发布、共享状态修改等。
- [ ] Guardian 判断日志可审计。

---

## 5. 安全、权限与沙箱

### 5.1 路径权限与审计收尾

- [ ] 路径级权限规则：如允许写入 `src/`。
- [ ] 命令模式匹配：如允许 `bun test`、`bun run build`。
- [ ] 会话级权限缓存：同一会话内相同操作不重复询问。
- [ ] `/permissions` 命令查看和管理当前权限规则。
- [ ] 路径策略 block 时展示原因，并允许批准本次 / 本会话 / 特定路径。
- [ ] 用户批准路径后，Read / Glob / Grep / NotebookEdit / ApplyPatch 等原工具继续执行。
- [ ] 审计路径授权：批准来源、范围、过期策略、被拒原因。
- [ ] 修复路径审批弹窗匹配过宽：不要用 `startsWith("允许本次")`。
- [ ] 修复路径审批标题误导：按 reason 区分工作区外、敏感文件等。
- [ ] 统一 `notebook-edit` / `apply-patch` / `glob` / `grep` 的 approval path policy。

### 5.2 沙箱执行系统

- [ ] macOS 基于 `sandbox-exec` / Seatbelt 实现文件系统与网络隔离。
- [ ] Linux 基于 Landlock / bubblewrap 实现沙箱。
- [ ] 定义 `SandboxPolicy`：allowed paths read/write、network access、process policy。
- [ ] Bash 工具集成沙箱包装。
- [ ] 沙箱失败时优雅降级，并给出可理解的权限 / 风险提示。
- [ ] 配置项：`sandbox.enabled`、`sandbox.allowNetworkFor` 等白名单。
- [ ] 与后台 shell 的 `spawn-common` 统一，避免两套进程安全边界。

---

## 6. 插件、MCP、Workspace 数据源与远程控制

### 6.1 插件 MCP 加载 / 禁用链路收尾 ✅

- [x] 安装插件后，新 session 自动加载插件 MCP（mergePluginMcpServers)。
- [x] 禁用插件后，不再合并 MCP server（reconcile 按 enabled 过滤)。
- [x] 禁用插件后，已连接 server 被 disconnect（reconcile 把 stale 全 disconnect)。
- [x] 禁用插件后，`ToolRegistry` 对应 MCP tools 被 unregister（disconnect finally 逐工具 unregister)。
- [x] 重新启用插件后，可重新 connect / register（connectAll 幂等)。
- [x] `engine.ts` 的 async reconcile 加 catch / 日志兜底（原 void 无 catch,失败=未处理拒绝可崩主进程;已加 catch→日志。测试 engine-config-hot-reload.test.ts)。
- [ ] 评估 reconcile 切断进行中 MCP 调用的用户体验(UI/产品观察,排后)。

### 6.2 MCP 管理页展示插件提供的 MCP server

- [ ] MCP 管理页合并展示配置态 MCP 与运行态 / 插件提供 MCP。
- [ ] server 增加来源 / 所有者信息：`source`、`owner`、`editable`。
- [ ] 插件 MCP 只读展示：状态、工具数、工具列表、错误信息。
- [ ] UI 标注“由 xxx 插件管理”。
- [ ] 用户配置 MCP 保留编辑 / 启停能力；插件 MCP 启停走插件开关。
- [ ] `McpSection.stripNameFromServer` 剥掉 `source` / `editable`，避免污染 settings。

### 6.3 Workspace 数据源绑定与作用域分配

- [ ] 定义 workspace 级资源模型：path、linked data sources、allowed scopes、默认读取策略。
- [ ] 支持 link 外部数据源：Figma、文档库、issue / PR、云盘、知识库、数据库等。
- [ ] 支持按 workspace 分配数据源范围。
- [ ] Agent 读取上下文时自动发现当前 workspace 已授权的数据源与范围。
- [ ] 工具调用检查 workspace scope，避免跨 workspace 读取未分配内容。
- [ ] 管理 UI / 命令：查看当前 workspace 绑定的数据源和可读资源。
- [ ] 记录授权来源、更新时间、失效 / 撤销状态。

### 6.4 远程控制入口 / 跨代理编排

- [ ] 支持 SSH 连接远程机器或开发环境。
- [ ] 支持手机扫码 / 临时配对码完成设备授权与会话绑定。
- [ ] 定义远程控制会话：下发任务、跟踪状态、收集日志与产物。
- [ ] 支持编排 Codex CLI、Claude Code 等外部 coding agent。
- [ ] 统一管理外部 agent 的 cwd、权限、审批、日志、产物与失败恢复。
- [ ] 明确安全边界：不自动外发密钥，不绕过外部 agent 自身审批，不允许未授权远控。

---

## 7. 模型、图片 / 视频、工具能力扩展

### 7.1 多 provider 图片 / 视频生成工具

- [ ] 抽 `ImageProvider` 适配器接口。
- [ ] 内置 OpenAI `gpt-image` 适配器，迁移现有实现。
- [ ] 内置 Gemini Nano Banana / Gemini 2.5 Flash Image 适配器。
- [ ] provider / model 从配置读取，不再写死 `gpt-image-2`。
- [ ] GenerateImage 入参加可选 `provider` / `model`。
- [ ] 新增 `GenerateVideo` 内置工具，产物写 `.code-shell/generated_videos/`。
- [ ] 抽 `VideoProvider` 适配器接口，支持 submit / poll / download。
- [ ] 内置即梦 / Seedance、可灵 / Kling 适配器。
- [ ] 长任务与超时对齐 GenerateImage 600s 放宽逻辑，必要时走后台任务 + 完成通知。
- [ ] 连接页新增“图片生成”“视频生成”两个 provider 分组。
- [ ] settings schema：`imageGen.providers[]` / `videoGen.providers[]`，各带 default provider。
- [ ] 密钥存 user scope，非密钥设置支持 workspace scope。
- [ ] 实现 image / video probe。
- [ ] 泛化 `isGenerateImageAvailable`。
- [ ] 新增 `isGenerateVideoAvailable`。
- [ ] tool prompt / 描述按已配置 provider 动态生成。
- [ ] 测试未配置隐藏、配置后可用、多 provider 默认和覆盖。

### 7.2 Model Provider 增强

- [ ] 支持通过外部命令获取 token：`auth.command`。
- [ ] 支持自定义 HTTP headers：`env_http_headers`。
- [ ] `reasoning_summary` 参数支持。
- [ ] `service_tier` 参数支持。
- [ ] 模型自动降级：主模型失败时切换备用模型。

### 7.3 Code Review 内置命令

- [ ] `/review` 命令审查当前 git diff 或指定文件。
- [ ] 结构化 findings：优先级 P0-P3、置信度、位置。
- [ ] 支持 JSON 输出格式，便于 CI/CD。
- [ ] 可配置审查维度：安全、性能、可读性、正确性。
- [ ] 支持增量审查：只审查变更部分。

### 7.4 view_image 后续增量

- [ ] TUI 端 inline image 渲染：iTerm / kitty graphics protocol。
- [ ] 看过一轮后把历史图降级成文字摘要，节省 token。

---

## 8. 上下文、记忆、指令与配置

### 8.1 跨会话记忆系统

- [ ] 记忆合并：相似记忆去重合并。
- [ ] 新会话启动时自动加载相关记忆到 prompt。
- [ ] `/memories list`、`/memories clear`、`/memories edit`。
- [ ] 配置：`memories.maxAge`、`memories.maxCount`、`memories.extractionModel`。

### 8.2 AGENTS.md 层级指令系统

- [ ] 深层目录指令覆盖浅层。
- [ ] 支持 `AGENTS.local.md`。
- [ ] 指令作用域标注：当前目录 vs 全局。
- [ ] 在 prompt 中按作用域排序注入。

### 8.3 智能上下文管理

- [ ] 文件内容缓存去重：同一文件多次读取只保留最新版本。
- [ ] tool result 压缩：大输出自动截断 + 摘要。
- [ ] 请求压缩：发送前压缩历史消息。
- [ ] token 预算管理：根据剩余 token 动态调整策略。

### 8.4 Feature Flags 系统 🔧

- [x] 定义 `FeatureFlags` 类型和默认值（feature-flags.ts FEATURE_FLAGS）。
- [x] 从配置文件加载 flags（settings.featureFlags Zod 字段）。
- [x] 各模块检查 flag 状态（isFeatureEnabled;engine toolDefs 按 flag 隐藏 WebSearch/Bash）。
- [x] `/features` 命令查看 flags（TUI,只读;切换走 settings.json）。
- [x] 候选 flags 登记齐：web_search/shell_tool(默认开)、fast_mode/undo/shell_snapshot(默认关)。测试 feature-flags.test.ts。

### 8.5 配置系统完善

- [ ] 支持 YAML 配置。
- [ ] 生成配置 JSON Schema，支持 IDE 自动补全。
- [ ] `/config` 命令交互式编辑配置。
- [ ] 配置迁移机制：版本升级时自动迁移旧配置。

---

## 9. 工程质量、性能与文档

### 9.1 Renderer / Desktop 清理项

- [ ] `App.tsx` 抽 `makeCreateRepoForCwd`，收拢重复 `createRepoForCwd` 闭包。
- [ ] `repos.ts` 的 `loadRemovedRepoPaths` 在磁盘重建循环里 hoist，避免逐会话重复 JSON.parse。
- [ ] 继续清理 settings / repo / workspace 命名混杂点。

### 9.2 测试覆盖

- [ ] builtin tools 集成测试。
- [ ] E2E 完整对话流程。
- [ ] GitHub Actions CI。
- [ ] 测试覆盖率 > 60%。
- [ ] 清理已知不稳定 / 待修测试。

### 9.3 性能优化

- [ ] 启动时间优化：懒加载非核心模块。
- [ ] 流式渲染优化：减少不必要重渲染。
- [ ] 大文件处理优化：分块读取、增量搜索。
- [ ] MCP 连接池复用。

### 9.4 文档

- [ ] 用户指南：Getting Started、Configuration、Tools Reference。
- [ ] 开发者文档：Contributing Guide。
- [ ] API 文档：公开 API 的 TypeDoc。
- [ ] 中文文档。
