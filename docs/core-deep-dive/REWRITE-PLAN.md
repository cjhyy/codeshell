# CodeShell Core v2 深度长文重写规划

> 本文件是 v2 重写策划，不是正式文章正文。范围限制：保留现有 12 篇短文与 SVG，不删除、不覆盖；新 5 篇长文作为 v2 文件放在同目录。实际 PNG 图后续由主 agent 用 GenerateImage 生成，本规划只给 prompt，不生成图片文件。

## 0. 重写目标

- **篇数**：从 12 篇短文压缩为 5 篇长文。
- **单篇长度**：建议 5000-9000 中文字；每篇必须有源码级锚点、设计取舍、故障模式，不接受只做模块概述。
- **核心基调**：CodeShell Core 是通用 Agent 编排内核，不是写死的 coding agent；coding 行为来自 preset、工具白名单、prompt 段与权限配置。
- **素材融合**：每篇同时吸收现有 `docs/core-deep-dive/*.md` 的源码细节，以及 `docs/archive/articles/harness-agent-series/*.md` 的读者心智模型、类比和 checklist。
- **配图策略**：每篇 2-4 张 AI image PNG，统一技术编辑风格；现有 SVG 作为事实结构参考，不替换。

## 1. 新系列总表

| 顺序 | v2 文件名 | 长文定位 | 建议字数 |
| --- | --- | --- | ---: |
| 01 | `01-core-as-agent-harness.md` | Core 总览 + Harness Agent 设计哲学 + 为什么不是 coding agent | 5000-8000 |
| 02 | `02-engine-turn-loop-deep-dive.md` | Engine、TurnLoop、context compaction、steering、goal stop-hook，必须源码级展开 | 7000-9000 |
| 03 | `03-tool-system-security-deep-dive.md` | ToolExecutor、permission、path policy、sandbox、hooks、MCP、builtin whitelist，强调安全边界和设计收益 | 7000-9000 |
| 04 | `04-model-context-memory-deep-dive.md` | LLM/model catalog/capabilities、prompt/preset/skills、session transcript、memory/Dream，解释长期上下文和模型适配 | 7000-9000 |
| 05 | `05-protocol-hosts-orchestration-deep-dive.md` | protocol/session、TUI/desktop/mobile/SDK hosts、RunManager/cron/goals、plugins/arena/DriveAgent，强调宿主解耦和长任务编排 | 7000-9000 |

## 2. 全系列准确性红线

这些红线要放进每篇 Claude Code 新 session 的 prompt，并在成稿前逐条核对。

1. **不要说所有 `Engine.run` 都经 protocol。** 正确说法：TUI、headless CLI、桌面 worker、RunManager 等主路径常通过 `AgentServer`/`AgentClient` 接缝收口；但 SDK、`asyncAgentRegistry` 子 agent、测试或专用 runner 可以直接装配或派生 `Engine`。
2. **不要说 desktop main 绝不运行 Engine。** 正确说法：桌面交互式聊天主路径由 Electron main spawn per-session `agent-server-stdio` worker，Engine 在 worker 子进程中运行；main 是 broker 并持有服务，也存在 automation 等服务性路径会接触 core 能力。措辞落在“哪个进程/哪条路径”。
3. **不要说所有后台任务都跨进程重启可恢复。** 正确说法：RunManager、cron job 定义、持久 goal、session transcript/state 明确持久化；普通在飞 model stream、外部 child process、后台 shell、部分同步/异步子 agent 状态不能泛化成 restart-durable。
4. **始终强调 core 是通用编排内核。** Turn loop、context、permission、MCP、hooks、session、memory、run/cron/goals、sub-agent 都是通用机制；coding 是 `terminal-coding` preset 叠加出来的行为。
5. **其它事实红线**：R-2 cookie 加密暂缓，现状是 0o600 明文；Windows 无 OS sandbox 后端，`auto` 降级为 `off`；新增 builtin tool 要同时改 `BUILTIN_TOOLS` 和 preset 白名单；Gemini 仅 AI-Studio `AIza...` 口径，不支持 Vertex OAuth token；hooks 是唯一跨层数组拼接特例。

## 3. 分篇策划

### 01 · `01-core-as-agent-harness.md`

**建议标题**：《CodeShell Core：从 LLM Call 到 Agent Harness，一套通用编排内核如何成形》

**文章任务**：建立全局心智模型。先讲为什么 LLM call / Deep Research 还不是完整运行系统，再落到 CodeShell Core 如何把模型、循环、工具、上下文、会话、安全、宿主协议组织成 harness。重点解释“不是 coding agent”：coding 是配置，不是 core 的内建本质。

**应吸收现有 12 篇内容**：
- `01-core-overview.md`：四个包、Core First、行为即配置、一次请求主链路、常见误解。
- `06-presets-prompt-hooks-skills.md`：`general` vs `terminal-coding` 的配置差异，用作“不是 coding agent”的直接证据。
- `12-module-map-and-recap.md`：模块全景、跨切面、设置/onboarding/runtime/磁盘布局。
- 轻量引用 `02-engine-turn-loop.md`、`03-tool-system.md`、`05-protocol-and-sessions.md` 的主链路，不在本篇展开细节。

**应借鉴 harness-agent-series**：
- `01-what-is-harness-agent.md`：LLM Call → Deep Research → Harness Agent 的演进线；“LLM call 是一次推理，Agent Harness 是一次受控运行”的论述。
- `06-harness-agent-checklist.md`：MVP / Production / Advanced 三层能力地图，用来解释 CodeShell 为什么不只是工具列表。
- 可借鉴 `README.md` 的系列约定：围绕核心问题，不做逐行源码解析，但必须用真实模块和链路作为案例。

**应引用现有 SVG**：
- `assets/core-big-picture.svg`：开篇全局结构。
- `assets/module-map.svg`：文末模块地图，告诉读者后续四篇怎么读。
- `assets/prompt-presets-hooks-skills.svg`：在解释“行为即配置”处轻引。

**源码锚点建议**：
- `packages/core/src/index.ts`：公共 API 面。
- `packages/core/CONTRIBUTING.md`：core only carries mechanism, not policy。
- `packages/core/src/preset/index.ts`：`BUILTIN_AGENT_PRESETS`、`GENERAL_BUILTIN_TOOLS`、`terminal-coding` 额外工具。
- `packages/core/src/engine/engine.ts`、`engine/turn-loop.ts`：只作为全局主链路锚点。
- `packages/core/src/protocol/{server,client,transport,factories}.ts`：host 主路径。
- `packages/core/src/settings/manager.ts`、`onboarding.ts`、`runtime/`：跨切面在本篇只点出，不展开。

**AI image 配图方案**：

1. 建议文件名：`assets/v2-01-llm-call-to-harness.png`  
   尺寸：`1536x1024`  
   用途：开篇解释从单次模型调用到受控运行系统的演进。  
   Prompt: `Technical editorial illustration, clean futuristic systems diagram on a dark navy background. Show three stages from left to right: "LLM Call", "Research Loop", "Agent Harness". Use abstract glowing blocks for model, tools, context, permissions, transcript, and host protocol. Cyan, purple, and amber highlights, readable short labels only, no dense paragraphs, avoid tiny text, high contrast, polished product engineering style.`

2. 建议文件名：`assets/v2-01-core-runtime-layers.png`  
   尺寸：`1536x1024`  
   用途：替代“模块堆砌”，把 core 描述为可运行 runtime。  
   Prompt: `Technical editorial illustration of a generic agent orchestration core as layered runtime architecture. Dark navy background, central glowing core labeled "CodeShell Core", surrounding layers labeled "Engine", "Turn Loop", "Tool System", "Context", "Session", "Protocol", "Hosts". Use cyan/purple/amber highlights, thin connector lines, clean futuristic systems diagram, readable abstract labels, no small text, no code snippets.`

3. 建议文件名：`assets/v2-01-presets-not-hardcoding.png`  
   尺寸：`1536x1024`  
   用途：说明 coding 能力是 preset/工具白名单/prompt 叠加，而不是 core 内建。  
   Prompt: `Clean futuristic technical diagram on dark navy background. Show one neutral "Generic Core" engine connected to two configuration cartridges: "general" and "terminal-coding". Each cartridge controls prompt sections, tool whitelist, and permission defaults. Use cyan for core, purple for presets, amber for tool gates. Readable short labels only, avoid tiny text, technical editorial illustration.`

**给 Claude Code 的单篇写作 context 摘要**：
- 目标读者是能看代码但不熟悉仓库的工程师。不要一上来列目录，要先讲为什么“模型外面的运行壳”才是 agent 的关键。
- 本篇不是 12 篇内容的缩写，而是为后四篇建立心智模型：Harness Agent = Engine + TurnLoop + Tool System + Context/Session/Memory + Permission/Sandbox + Protocol/Host。
- 必须正面解释：CodeShell Core 是通用编排内核，不是 coding agent；`general` 与 `terminal-coding` 差别来自 `preset/index.ts` 的配置。
- 红线：不要说所有 `Engine.run` 都经 protocol；不要说 desktop main 绝不运行 Engine；不要说所有后台任务 restart-durable；不要把 core 写成 coding agent。
- 要讲取舍：为什么不把所有逻辑写进一个 `runAgent()` 大函数；为什么用 preset 而非 fork；为什么 host 是外壳而不是 core 的一部分。

### 02 · `02-engine-turn-loop-deep-dive.md`

**建议标题**：《Engine 与 TurnLoop 深潜：一次任务如何变成多轮模型-工具-上下文闭环》

**文章任务**：源码级拆解 `Engine.run` 五阶段、`TurnLoop.run` 每轮状态机、上下文 compaction 分层、step-gap steering、goal stop-hook 与 `complete_goal`。这是五篇里技术密度最高的一篇，必须讲清楚不变量和故障模式。

**应吸收现有 12 篇内容**：
- `02-engine-turn-loop.md`：五阶段、turn loop 每步、context compaction、steering、goal 上限、四条不变量。
- `07-run-automation-goal.md`：goal stop-hook、`complete_goal`、预算硬底线、后台 job 停泊而非自旋。
- `05-protocol-and-sessions.md`：session queue、transcript 恢复、`tool_use`/`tool_result` 修补，仅作为 loop 的外部支撑。
- `12-module-map-and-recap.md`：runtime、磁盘布局和 durable 边界可作为旁注。

**应借鉴 harness-agent-series**：
- `02-agent-turn-loop.md`：Engine 是装配器、Turn Loop 是心跳、工具结果面向下一轮模型、Stop 不是简单“无工具调用”。
- `04-context-session-memory.md`：Context Window 是工作台，不是数据库；Transcript 是账本。
- `06-harness-agent-checklist.md`：Turn loop / Context management / Session recovery 的 checklist。

**应引用现有 SVG**：
- `assets/engine-turn-loop.svg`：主循环图。
- `assets/context-compaction.svg`：上下文压缩图。
- `assets/run-automation-goal.svg`：goal 与 stop-hook 相关段落轻引。
- `assets/protocol-sessions.svg`：session queue 与恢复段落轻引。

**源码锚点建议**：
- `packages/core/src/engine/engine.ts`：`Engine`、`Engine.run`、goal hook 接线、runtime config refresh、image policy、sub-agent spawner。
- `packages/core/src/engine/turn-loop.ts`：`TurnLoop.run`、model call、tool decision、budget check、`complete_goal` 短路、usage update。
- `packages/core/src/engine/steer-queue.ts`：`consumeSteerItems`、撤回边界。
- `packages/core/src/engine/goal.ts`：`GoalConfig`、`resolveMaxTurns`、`resolveMaxStopBlocks`、`createGoalBudgetTracker`、`applyGoalExtension`。
- `packages/core/src/hooks/goal-stop-hook.ts`：stop-hook judge。
- `packages/core/src/context/manager.ts`、`context/compaction.ts`、`context/tool-result-storage.ts`：Tier 0-3、冻结决策、pair invariant。
- `packages/core/src/engine/patch-orphaned-tools.ts`：恢复修补。
- `packages/core/src/engine/streaming-tool-queue.ts`：安全并发与串行工具。

**AI image 配图方案**：

1. 建议文件名：`assets/v2-02-engine-run-five-stages.png`  
   尺寸：`1536x1024`  
   用途：讲 `Engine.run` 是装配器，不是循环本身。  
   Prompt: `Technical editorial illustration, dark navy background, clean futuristic systems diagram. Show "Engine.run" as a five-stage assembly line: validate input, session setup, build dependencies, run TurnLoop, terminate and persist. Use glowing cyan pathway, purple modules, amber warning gates. Short readable labels only, avoid tiny text and long paragraphs, no code snippets.`

2. 建议文件名：`assets/v2-02-turn-loop-state-machine.png`  
   尺寸：`1536x1024`  
   用途：主讲 `TurnLoop.run` 一轮如何转。  
   Prompt: `Clean futuristic state machine diagram on dark navy background. Center a circular loop labeled "TurnLoop". Around it place compact nodes: pre-check, context manage, model stream, tool decision, tool execute, final answer, stop hook. Add small icons for abort, usage, tool_result pairing. Cyan/purple/amber highlights, readable abstract labels, no tiny text, technical editorial style.`

3. 建议文件名：`assets/v2-02-context-compaction-tiers.png`  
   尺寸：`1024x1536`  
   用途：纵向解释 Tier 0-3 从无损到有损。  
   Prompt: `Vertical technical systems illustration, dark navy background. Show four stacked compaction tiers from top to bottom: "Tier 0 persist", "Tier 1 microcompact", "Tier 2 summarize", "Tier 3 window compact". Include a side rail showing token pressure rising. Cyan, purple, amber highlights, clean diagram, readable short labels, avoid tiny text, no dense annotations.`

4. 建议文件名：`assets/v2-02-goal-steering-stop-hooks.png`  
   尺寸：`1536x1024`  
   用途：区分 step-gap steering、goal stop-hook、预算硬底线。  
   Prompt: `Technical editorial illustration on dark navy background. Show an agent loop with three control overlays: "Steering Queue" inserting messages between steps, "Goal Judge" checking stop, and "Budget Backstop" blocking runaway execution. Use cyan loop, purple queue, amber safety gate. Readable labels only, avoid tiny text, clean futuristic systems diagram.`

**给 Claude Code 的单篇写作 context 摘要**：
- 本篇必须像源码导读：按 `Engine.run` 五阶段和 `TurnLoop.run` 的 while loop 顺序组织，讲清楚每一步为什么在这个位置。
- 重点源码细节：图片策略 fail-closed、`patchOrphanedToolUses`、`ContextManager.manageAsync`、`streamingQueue.drain()`、goal budget 在 model call 后/tool 执行前检查、`on_stop` 返回 `continueSession` 后继续循环、`complete_goal` 主动声明。
- 必须讲故障模式：provider 拒绝孤儿 tool pair、上下文爆炸、截断续写、用户 abort、goal 无限 stop-block、后台 job 自旋、usage 估算漂移。
- 红线：不要说所有 `Engine.run` 都经 protocol；turn loop 是 engine 内部机制，不等于 protocol。不要把 goal/RunManager durable 性质推广给普通后台 shell 或外部子进程。core 是通用编排，不是 coding agent。
- 成稿不能只画流程图，要解释设计收益：循环可移植、成本可控、恢复合法、用户能步间补话、无人值守有硬预算。

### 03 · `03-tool-system-security-deep-dive.md`

**建议标题**：《Tool System 安全深潜：为什么 Agent 能做事之前，必须先学会被约束》

**文章任务**：把工具系统写成安全架构长文，而不只是工具清单。主线是模型 `tool_use` 如何穿过单一 executor：能力门、plan-mode、schema、hooks、path policy、permission classifier、approval backend、sandbox、registry、post hooks、MCP 输出防注入、builtin whitelist。

**应吸收现有 12 篇内容**：
- `03-tool-system.md`：端到端管线、五条不变量、权限、path policy、MCP、sandbox、builtin 两处改动。
- `06-presets-prompt-hooks-skills.md`：hooks 只能收紧、shell hook 信任模型、preset 白名单。
- `08-plugins-capabilities-credentials-memory.md`：凭证三档门、插件 hooks、git `--` 防 RCE。
- `11-desktop-mobile-host.md`：CDP 浏览层和浏览器工具真实输入事件，可作为工具系统边界实例。
- `12-module-map-and-recap.md`：runtime subprocess 与 env allowlist、磁盘敏感路径。

**应借鉴 harness-agent-series**：
- `03-tool-system.md`：工具不是函数表；Tool System 是 control layer；approval backend 与 host 解耦；MCP 必须进入同一条管线。
- `06-harness-agent-checklist.md`：Production 层安全边界 checklist。
- `05-protocol-and-hosts.md`：Approval 必须走协议，不写死在 core/UI。

**应引用现有 SVG**：
- `assets/tool-executor-pipeline.svg`：主图。
- `assets/prompt-presets-hooks-skills.svg`：hook/preset 白名单交叉引用。
- `assets/plugins-capabilities-memory.svg`：凭证与 capability control 交叉引用。
- `assets/desktop-tui-hosts.svg`：浏览器/CDP 工具的 host bridge 可轻引。

**源码锚点建议**：
- `packages/core/src/tool-system/executor.ts`：`ToolExecutor.executeSingle`、`clampHookDecision`、plan-mode、path-policy、permission、hook 顺序。
- `packages/core/src/tool-system/registry.ts`：`ToolRegistry.executeTool`、timeout、abort cascade、`__signal` 注入。
- `packages/core/src/tool-system/permission.ts`：`PermissionClassifier`、`ruleMatches`、`scanShellCommand`、三种 approval backend。
- `packages/core/src/tool-system/path-policy.ts`：realpath 双侧、敏感文件/目录、workspace containment。
- `packages/core/src/tool-system/sandbox/index.ts`：seatbelt/bwrap/off、Windows 降级。
- `packages/core/src/tool-system/mcp-manager.ts`：MCP 发现、`wrapMcpOutput`、图片 spillover。
- `packages/core/src/tool-system/builtin/index.ts`：`BUILTIN_TOOLS`、guards、分类。
- `packages/core/src/preset/index.ts`：`GENERAL_BUILTIN_TOOLS` 白名单。
- `packages/core/src/credentials/use-gate.ts`、`credentials/store.ts`：凭证 gate。
- `packages/cdp/src/driver.ts` 与 `packages/desktop/src/main/browser-driver/`：浏览器工具 host bridge。

**AI image 配图方案**：

1. 建议文件名：`assets/v2-03-tool-executor-choke-point.png`  
   尺寸：`1536x1024`  
   用途：展示 executor 是唯一收口。  
   Prompt: `Technical editorial illustration on dark navy background. Show many incoming tool calls funneling into one central gateway labeled "ToolExecutor". Outgoing path passes through compact gates: schema, hooks, path policy, permission, sandbox, registry. Cyan flow lines, purple modules, amber safety gates, readable short labels, avoid tiny text, clean futuristic systems diagram.`

2. 建议文件名：`assets/v2-03-permission-path-sandbox-layers.png`  
   尺寸：`1536x1024`  
   用途：解释 permission / path policy / sandbox 是三层不同边界。  
   Prompt: `Layered security diagram, dark navy background. Show an agent action passing through three transparent shields labeled "Permission", "Path Policy", and "Sandbox". Include small abstract icons for shell command, file path, credential folder, and workspace boundary. Cyan, purple, amber highlights, readable labels only, no tiny text, technical editorial style.`

3. 建议文件名：`assets/v2-03-approval-backends-hosts.png`  
   尺寸：`1536x1024`  
   用途：解释 `ask` 如何被 TUI、desktop、mobile、automation 处理，但 ToolExecutor 不关心 UI。  
   Prompt: `Clean futuristic systems diagram on dark navy background. Center "ApprovalBackend" as a routing hub. Connect to four host surfaces: terminal prompt, desktop approval card, phone approval, headless policy. Show allow, ask, deny as three amber/cyan decision chips. Readable short labels, avoid tiny text, no paragraphs.`

4. 建议文件名：`assets/v2-03-mcp-untrusted-output.png`  
   尺寸：`1536x1024`  
   用途：解释 MCP 外部工具也进入同一管线，输出要当不可信数据。  
   Prompt: `Technical editorial diagram, dark navy background. Show external MCP servers entering the same tool pipeline as built-in tools. Add an amber wrapper around output labeled "untrusted result" before it returns to the model. Cyan/purple/amber highlights, clean futuristic systems diagram, readable abstract labels, avoid tiny text.`

**给 Claude Code 的单篇写作 context 摘要**：
- 本篇必须从“工具不是函数表”开场，强调工具系统的核心是 control layer。按 `ToolExecutor.executeSingle` 的真实顺序展开。
- 必须讲清每层边界的责任差异：permission 决定是否执行，path policy 管文件边界与敏感路径，sandbox 限制 Bash 执行环境，hooks 只能收紧，approval backend 处理 ask 的宿主差异。
- 必须包含 builtin whitelist 坑：新工具要同时进入 `BUILTIN_TOOLS` 与 preset 白名单，否则模型看不见或得到 tool not found。
- 必须讲故障模式：模型幻觉工具名、schema 失败、`git status && rm -rf /` 搭便车、symlink 逃逸、MCP prompt injection、Windows sandbox off、shell hook 绕过 Bash 审批但被视为受信任配置。
- 红线：不要说 MCP 有独立宽松权限；不要说 hook 能放行 deny；不要说沙箱全平台；不要说 cookie 已加密；不要把 coding 工具作为 core 本质。

### 04 · `04-model-context-memory-deep-dive.md`

**建议标题**：《模型、上下文与记忆深潜：Agent 的脑容量不是 prompt 长度》

**文章任务**：把模型适配、prompt/preset/skills、context window、session transcript、persistent memory/Dream 放在同一篇里讲清“长期上下文”的真实层次。不要把它写成“LLM 层 + 记忆层”拼接，而要围绕一个问题：系统如何在模型差异、上下文预算、会话事实日志、长期知识之间建立边界。

**应吸收现有 12 篇内容**：
- `04-llm-model-layer.md`：tag → ModelEntry → ModelPool → LLMConfig → provider client；capabilities RULES；ParamSpec；stream/retry/usage；Gemini 边界。
- `06-presets-prompt-hooks-skills.md`：prompt 缓存断点、dynamic context、instruction scanning、skills。
- `02-engine-turn-loop.md`：context compaction 的技术细节可在本篇做“上下文层”延伸。
- `05-protocol-and-sessions.md`：transcript 是事实源，`toMessages()` 是模型输入边界。
- `08-plugins-capabilities-credentials-memory.md`：MemoryManager、pending、pinned、Dream consolidation。
- `12-module-map-and-recap.md`：settings/onboarding/model metadata/磁盘布局。

**应借鉴 harness-agent-series**：
- `04-context-session-memory.md`：Context Window 是工作台，Transcript 是账本，Persistent Memory 是长期知识。
- `02-agent-turn-loop.md`：ModelFacade 统一 provider response 与 StreamEvent。
- `06-harness-agent-checklist.md`：Context Management、Memory Pipeline、Session Recovery 的检查清单。

**应引用现有 SVG**：
- `assets/llm-model-layer.svg`：模型解析主图。
- `assets/context-compaction.svg`：上下文治理。
- `assets/prompt-presets-hooks-skills.svg`：prompt/preset/skills。
- `assets/plugins-capabilities-memory.svg`：memory/Dream。
- `assets/protocol-sessions.svg`：transcript/session 段落轻引。

**源码锚点建议**：
- `packages/core/src/engine/resolve-llm-config.ts`、`llm/model-pool.ts`、`model-catalog/`：tag 与 catalog。
- `packages/core/src/llm/client-base.ts`、`llm/client-factory.ts`、`llm/providers/{openai,anthropic}.ts`：provider client、retry、deadline、stream watchdog。
- `packages/core/src/llm/capabilities/rules.ts`：capabilities 数据表。
- `packages/core/src/model-catalog/types.ts`：`ParamSpec`。
- `packages/core/src/prompt/composer.ts`、`prompt/instruction-scanner.ts`、`prompt/section-cache.ts`：prompt 组装。
- `packages/core/src/preset/index.ts`、`skills/scanner.ts`：preset 与 skills。
- `packages/core/src/session/transcript.ts`、`session/session-manager.ts`：transcript → messages。
- `packages/core/src/context/{manager,compaction,tool-result-storage}.ts`：context window 治理。
- `packages/core/src/session/memory.ts`、`services/dream-consolidation.ts`、`services/auto-dream.ts`：memory/Dream。
- `packages/core/src/onboarding.ts`、`data/model-metadata.json`：模型元数据外移。

**AI image 配图方案**：

1. 建议文件名：`assets/v2-04-model-resolution-capabilities.png`  
   尺寸：`1536x1024`  
   用途：解释模型 tag 如何变成 provider request，差异是数据。  
   Prompt: `Technical editorial systems diagram on dark navy background. Show a model tag flowing through settings, catalog, ModelPool, LLMConfig, provider client, and capabilities rules. Add compact labels "tag", "catalog", "capabilities", "wire request". Cyan/purple/amber highlights, clean futuristic style, readable labels only, avoid tiny text.`

2. 建议文件名：`assets/v2-04-prompt-cache-dynamic-context.png`  
   尺寸：`1536x1024`  
   用途：解释 prompt 缓存前缀与动态上下文分界。  
   Prompt: `Clean futuristic diagram, dark navy background. Show a prompt timeline split by a glowing cache breakpoint: stable system prefix on the left, dynamic context on the right. Include short labels for tools, behavior, instructions, skills, git status, memory index. Cyan/purple/amber highlights, readable abstract labels, avoid tiny text and long text.`

3. 建议文件名：`assets/v2-04-context-transcript-memory-layers.png`  
   尺寸：`1024x1536`  
   用途：作为本篇核心心智图：工作台、账本、长期知识。  
   Prompt: `Vertical technical editorial illustration on dark navy background. Show three stacked layers: "Context Window" as a focused workbench, "Transcript Log" as an append-only ledger, and "Persistent Memory" as curated long-term knowledge. Add arrows showing selected information moving upward into the model. Cyan, purple, amber highlights, readable labels only, avoid tiny text.`

4. 建议文件名：`assets/v2-04-dream-consolidation-cycle.png`  
   尺寸：`1536x1024`  
   用途：解释 Dream 是受限清理回路，不是随意改 user memory。  
   Prompt: `Technical editorial illustration, dark navy background. Show a restrained memory cleanup cycle labeled "Dream Consolidation": collect memories, dedupe, merge, prune, improve descriptions. Place a clear boundary around "dream scope only" with amber guardrails. Cyan/purple/amber highlights, clean futuristic systems diagram, readable short labels, no tiny text.`

**给 Claude Code 的单篇写作 context 摘要**：
- 本篇围绕“agent 的脑容量不是 prompt 长度”组织。先讲模型适配解决 provider 差异，再讲 prompt/context 决定本轮能看什么，transcript 决定事实可恢复，memory/Dream 决定跨会话沉淀。
- 必须把 `LLMConfig` 与 `ClientDefaults` 分开讲；把 capabilities RULES 写成“差异即数据”；把 `ParamSpec` 写成 UI 控件与 wire 请求同源。
- 必须解释 `Transcript.toMessages()` 是边界：transcript 不是聊天历史原文堆给模型。
- 必须讲故障模式：per-model switch 蔓延、4xx 重试浪费、maxTokens 默认截断、context 爆炸、大工具结果、memory 污染未来任务、Dream 越权写 user scope。
- 红线：不要说 Gemini 支持 Vertex OAuth token；不要说 cookie/memory secret 已加密；不要说 memory 是 transcript 替代品；不要把 context compaction 写成简单截断；不要把 core 写成 coding agent。

### 05 · `05-protocol-hosts-orchestration-deep-dive.md`

**建议标题**：《协议、宿主与长任务编排：同一个 Core 如何服务 TUI、桌面、手机、SDK 与自动化》

**文章任务**：收束前四篇，把 core/host 解耦与长任务平台化讲透。主线是：protocol/session 如何让不同宿主共享 core 语义；TUI/desktop/mobile/SDK 如何各自接入；RunManager/cron/goal 如何处理无人值守；plugins/arena/DriveAgent/DriveClaudeCode 如何把 core 变成可扩展平台。

**应吸收现有 12 篇内容**：
- `05-protocol-and-sessions.md`：JSON-RPC 接缝、transport、ChatSession queue、approval、background wakeup、config hot reload、session disk。
- `10-tui-host.md`：TUI in-process protocol、外部 store、50ms buffer、自绘 renderer、headless 输出。
- `11-desktop-mobile-host.md`：三进程模型、main broker、worker、renderer、mobile remote、CDP。
- `07-run-automation-goal.md`：RunManager、Automation/Cron、read-only contract、persistent goal、durable 边界。
- `09-arena-and-integrations.md`：Arena、IterativeArena、cc-orchestrator、DriveAgent/DriveClaudeCode、STT/review。
- `08-plugins-capabilities-credentials-memory.md`：plugins/capabilities 作为平台扩展。
- `12-module-map-and-recap.md`：磁盘布局与跨切面回顾。

**应借鉴 harness-agent-series**：
- `05-protocol-and-hosts.md`：Core 不应该知道自己跑在哪里；StreamEvent 和 Approval 是 UI 解耦关键；Desktop worker 的动机；Automation 可以有不同宿主策略。
- `06-harness-agent-checklist.md`：Advanced 层：Automation、Background Agents、Plugin/Skill、Multi-agent/Arena、Remote Control。
- `01-what-is-harness-agent.md`：把 harness 接进真实工作流的结尾论述。

**应引用现有 SVG**：
- `assets/protocol-sessions.svg`：protocol/session 主图。
- `assets/desktop-tui-hosts.svg`：TUI/desktop/mobile/CDP。
- `assets/run-automation-goal.svg`：长任务。
- `assets/arena-integrations.svg`：Arena/DriveAgent。
- `assets/plugins-capabilities-memory.svg`：插件/能力控制。
- `assets/module-map.svg`：收尾总图。

**源码锚点建议**：
- `packages/core/src/protocol/{types,server,client,transport,tcp-transport,factories,chat-session,chat-session-manager}.ts`：协议与 session queue。
- `packages/core/src/session/{session-manager,transcript,file-history,undo-target}.ts`、`state.ts`：磁盘恢复与 undo。
- `packages/tui/src/cli/main.ts`、`cli/commands/{run,repl}.ts`、`ui/App.tsx`、`ui/store.ts`、`render/`：TUI host。
- `packages/desktop/src/main/index.ts`、`main/agent-bridge.ts`、`src/preload/index.ts`、`src/renderer/App.tsx`、`renderer/lib/streamReducer.ts`、`src/mobile/`、`main/mobile-remote/`：desktop/mobile host。
- `packages/cdp/src/driver.ts`、`packages/desktop/src/main/browser-driver/`：CDP bridge。
- `packages/core/src/run/{RunManager,RunLock,Heartbeat,FileRunStore,EngineRunner,RunApprovalBackend}.ts`：RunManager。
- `packages/core/src/automation/{scheduler,cron-expr,store,runner,write-policy,write-run}.ts`：cron/automation。
- `packages/core/src/arena/arena.ts`、`arena/iterate/iterative-arena.ts`、`arena/{ledger,transitions,planner}.ts`：Arena。
- `packages/core/src/cc-orchestrator/{agent-adapter,external-agent-driver,cc-capability}.ts`：DriveAgent/DriveClaudeCode。
- `packages/core/src/plugins/`、`capability-control/`：平台扩展。

**AI image 配图方案**：

1. 建议文件名：`assets/v2-05-protocol-host-topology.png`  
   尺寸：`1536x1024`  
   用途：展示 core 与多宿主的协议拓扑。  
   Prompt: `Technical editorial systems diagram on dark navy background. Show one central "Protocol Seam" connecting TUI, desktop renderer, phone remote, SDK, and automation hosts to a shared core. Include short labels for AgentClient, Transport, AgentServer, StreamEvent, Approval. Cyan/purple/amber highlights, readable labels only, avoid tiny text.`

2. 建议文件名：`assets/v2-05-desktop-mobile-worker-topology.png`  
   尺寸：`1536x1024`  
   用途：解释桌面三进程与手机复用链路。  
   Prompt: `Clean futuristic technical diagram, dark navy background. Show Electron main as a broker, a per-session core worker running the engine, a thin React renderer, and a phone remote connected by WebSocket. Add a small CDP browser bridge path. Cyan/purple/amber highlights, readable abstract labels, avoid tiny text and long annotations.`

3. 建议文件名：`assets/v2-05-run-cron-goal-orchestration.png`  
   尺寸：`1536x1024`  
   用途：解释 RunManager/cron/persistent goal 的 durable 边界。  
   Prompt: `Technical editorial illustration on dark navy background. Show long-running orchestration as three connected systems: RunManager state machine, Cron scheduler, Persistent Goal. Add a visible boundary labeled "durable state" around snapshots, transcript, heartbeat, job specs. Keep model streams and child processes outside the durable boundary. Cyan/purple/amber highlights, readable short labels, avoid tiny text.`

4. 建议文件名：`assets/v2-05-platform-extensions-arena-driveagent.png`  
   尺寸：`1536x1024`  
   用途：收尾说明平台化：plugins、Arena、external CLI orchestration。  
   Prompt: `Futuristic systems map on dark navy background. Center "CodeShell Platform Core" with three extension arcs: plugins and skills, multi-model Arena, external CLI orchestration with Claude and Codex as black-box workers. Use cyan/purple/amber highlights, clean technical editorial style, readable abstract labels, no tiny text, no dense paragraphs.`

**给 Claude Code 的单篇写作 context 摘要**：
- 本篇是系列收束，不要变成 TUI/desktop/RunManager 三篇短文拼贴。主线是“同一个 core 语义如何被不同 host 消费，并如何支撑长任务与平台扩展”。
- 必须解释 `AgentClient ⇄ Transport ⇄ AgentServer ⇄ ChatSession ⇄ Engine` 的协议价值：StreamEvent、Approval、Cancel、Configure、Steer、BackgroundWork 都是语义契约。
- 必须区分物理接入方式：TUI 是 in-process protocol；desktop 交互式聊天由 main spawn worker；mobile 复用 worker/WS/approval path；SDK/专用 runner 可直接嵌入；automation 有自己的服务性策略。
- 必须讲 RunManager/cron/goal 的可恢复边界，并明确哪些不 durable。
- 必须讲故障模式：worker 崩溃、pending request reject、清 localStorage 后从磁盘恢复、cron sleep/wake misfire、approval 无 UI fail-closed、DriveAgent 子进程 non-detached、手机审批不能另起权限链。
- 红线：不要说所有 `Engine.run` 都经 protocol；不要说 desktop main 绝不运行 Engine；不要把 run/cron/goal 的 durable 性质推广给所有后台任务；不要把 external CLI 写成它们自己负责循环/调度。

## 4. 逐篇新 session 写作顺序

建议每篇单独开 Claude Code 新 session，按以下顺序推进：

1. **先写 `01-core-as-agent-harness.md`**：先立基调、读者模型和红线。验收后再写技术深潜，避免后文把 core 写窄成 coding agent。
2. **再写 `02-engine-turn-loop-deep-dive.md`**：这是后续工具、安全、协议、长任务的内部主线。成稿后确认 `Engine.run` / `TurnLoop.run` / context / goal 的事实基础无误。
3. **再写 `03-tool-system-security-deep-dive.md`**：在 loop 主线已清楚后展开 agent “能做事”的安全边界。
4. **再写 `04-model-context-memory-deep-dive.md`**：依托第 02 篇的 context loop，把模型适配、prompt、transcript、memory 合成长期上下文长文。
5. **最后写 `05-protocol-hosts-orchestration-deep-dive.md`**：收束到宿主解耦、长任务编排和平台化能力，引用前四篇概念。

每个新 session 的推荐输入：
- 本 `REWRITE-PLAN.md` 的全系列红线与对应篇章策划。
- 对应旧短文：上面“应吸收现有 12 篇内容”列出的文件。
- 对应 harness 归档文：上面“应借鉴 harness-agent-series”列出的文件。
- 对应 `docs/architecture/*.md` 章节，并用 `rg` 重新确认关键符号仍在当前源码中；不要照抄旧行号。

## 5. 统一验收标准

**深度要求**：
- 单篇 5000-9000 中文字，允许因技术密度略有浮动，但不得短成模块简介。
- 每篇至少包含 8 个以上具体源码锚点；第 02、03、05 篇建议 12 个以上。
- 必须按“问题 → 设计 → 源码链路 → 取舍 → 故障模式 → 收益”组织，不能只列文件名。
- 每篇至少讲 3 个真实故障模式或 footgun，例如孤儿 tool pair、上下文爆炸、链式 Bash 授权绕过、symlink 逃逸、Windows sandbox off、worker 崩溃、cron 误触发、memory 污染。

**准确性要求**：
- 成稿前逐条核对 §2 红线。
- 凡涉及 protocol、desktop main、durable background、core 是否 coding agent 的句子，都要避免绝对化。
- `docs/architecture/00-overview.md` 里关于 “Everything runs through protocol seam” 的概括不得照抄为绝对事实；以本规划红线和当前源码为准。
- 行号只写“在某文件/某函数附近”，不要把漂移行号当事实。

**素材与结构要求**：
- 不删除、不覆盖现有 12 篇；v2 新文使用本规划的 5 个文件名。
- 每篇正文可复用现有 SVG 作结构参考，但 PNG 图生成前只用占位或“待补图”清单，不要凭空描述未生成图的具体画面。
- 每篇成稿都要在文末列“源码阅读路线”和“常见误解与边界”。
- 每篇都要能独立阅读，但也要在开头或文末标出与其它 v2 篇的关系。

## 6. Image Prompt 汇总

本规划共建议 **19 个** AI image prompt：

- 第 01 篇：3 张。
- 第 02 篇：4 张。
- 第 03 篇：4 张。
- 第 04 篇：4 张。
- 第 05 篇：4 张。

统一风格关键词：`technical editorial illustration, clean futuristic systems diagram, dark navy background, cyan/purple/amber highlights, readable abstract labels, avoid tiny text`。所有 prompt 都应避免让模型生成大段小字，标签只保留 1-3 个词的抽象模块名。
