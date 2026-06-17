# CodeShell core 系统设计评估

> 评估范围:`packages/core`(约 84,646 LoC)的整体设计、职责边界、依赖方向、抽象一致性、扩展性与技术债。
> 核心回答的问题:**「我感觉现在有好多业务逻辑在往 core 加,我应该怎么做下一步的迭代?」**

---

## TL;DR

- **骨架是好的,且明显是被认真设计过的。** 依赖方向干净(`engine` 不反向依赖 `arena`/`automation`/`run`)、`ToolContext` 注入取代了模块级单例、`EngineRuntime` 共享资源、多宿主(stdio/TCP/Desktop)走同一套 bootstrap。这是中大型项目里少见的纪律。
- **你的「业务逻辑在往 core 加」的感觉是真的,但没有你担心的那么糟。** 泄漏不是结构性的——绝大多数「业务」是以**内置工具(builtin tool)**和**数据表(hardcoded array)**的形式渗进来的,而不是污染了引擎/协议层。核心编排层是干净的。
- **#1 风险不是「core 太大」,而是「没有一条成文的『什么该进 core』准则」。** 在缺少准则时,每个新功能默认落点都是「再加一个 builtin tool + 在 core 里再 hardcode 一张表」。这是熵增的来源。
- **边界一句话答案:** core 应该只保留**机制(mechanism)**——引擎/turn-loop、工具执行框架、权限/沙箱框架、LLM 客户端抽象、会话/transcript、协议;而**策略与目录(policy & catalog)**——具体的 provider 列表、模型元数据、定价表、地域映射、Arena 这种端到端特性、产品名枚举——应该外移到 **data 文件 / 独立可选包 / host / plugin**。
- **真正值得动手的有 3 件:** (1) Arena 抽成 `@codeshell/arena` 可选包(~11% 的 core 体量);(2) 把所有 hardcoded 目录(provider 列表、模型元数据、定价、Vertex/AWS 地域、OpenRouter vendor 排序)收敛到 **data 层**,让更新模型不再需要发 core;(3) 删掉 Ant 内部环境探测(`isRunningOnHomespace`、`USER_TYPE='ant'`)这类部署假设。
- **Phase 0(现在就做、零成本):** 在 `packages/core/CONTRIBUTING.md` 或 `index.ts` 顶部写下一条「core 边界契约」,并把它变成 code review 的默认提问。这是止血,不是重构。
- **不要过度工程:** `engine.ts` 3183 行不需要拆;`BUILTIN_TOOLS` 数组不需要自动发现;image/video 的 switch 不需要现在就上 registry。这些是「显式 > 魔法」的合理选择。

---

## 1. 整体评价:架构骨架健康,问题在「边界纪律」而非「结构腐烂」

**给骨架打分:B+ / 偏 A-。** 这是一个被认真分层过的系统,核心编排链路是无环的、可测的、可多实例并发的。具体证据:

- **依赖方向正确。** `engine/engine.ts` 不 import `arena`/`automation`/`run`;反过来是这些高层特性 import Engine。`tool-system/executor.ts` 只依赖 hooks/permission/logging,不知道有哪些具体工具存在。这是教科书式的「低层编排 ← 高层特性」分层,从根上避免了循环装配死锁。
- **注入取代单例。** `ToolContext`(`tool-system/context.ts:126-273`)替代了历史上的 `setAskUserFn`/`setArenaLLMConfig` 全局态,每个 Engine 构造自己的 context,多 Engine 并发安全。`EngineRuntime`(`engine/runtime.ts`)让 ModelPool/ToolRegistry/MCPManager 这些昂贵资源跨 session 共享一次构造。
- **多宿主一致。** stdio 与 TCP 两个 host 用**同一套** bootstrap(seed Engine → 抽共享资源 → 包 `EngineRuntime` → `ChatSessionManager` + `engineFactory` 闭包),`computeEffectiveDisabledLists`、`settingsReader` 在两个 host 里调用方式一致。没有「每个 host 自己发明一遍」。
- **设计上做了正确的防漏。** `settingsScope` 默认 `project`,SDK 嵌入时不会静默继承用户 `~/.code-shell` 凭证;子代理工具/skill allowlist 在 `ctx.isSubAgent` 处做了纵深防御;hooks 不能把 deny/ask 提升成 allow(`executor.ts:40-50` 的 `clampHookDecision`)。

**所以,「腐烂」不是问题。** 你感觉到的「业务逻辑往 core 加」是真实的,但它发生在**叶子节点**(builtin tools 和 data 表),不是在动脉(engine/protocol/executor)。这意味着——好消息——清理是**增量可做的、低风险的**,不需要伤筋动骨。坏消息是:如果不立一条准则,这种叶子层的熵增会持续,几个版本后 core 会变成一个「什么都往里塞」的垃圾场。

---

## 2. 设计上做得好的地方

把分散在各维度的强项归并成几个主题,逐一给信用:

### 2.1 编排层与特性层的干净解耦
| 证据 | 价值 |
|---|---|
| `engine/engine.ts` 不 import arena/automation/run | 编排不依赖高层特性,无环 |
| `tool-system/executor.ts` 只依赖 hooks/permission/logging | 工具分派对「有哪些工具」无知,framework 与 contrib 分离 |
| `automation/index.ts:19-30` `StartAutomationDeps` 依赖注入 | core 定义生命周期与接口,**零文件路径、零调度策略**;同一模块跑在 Desktop/CLI/Agent 三处不分叉 |
| `product/types.ts` + `product/define.ts` | `defineProduct()` 适配器让外部 app 组合自己的 preset/adapter/contract,domain 逻辑天然在 core 之外 |

### 2.2 数据驱动的抽象(把 provider 差异收进单一声明点)
| 证据 | 价值 |
|---|---|
| `llm/client-factory.ts` `registerProvider`/`PROVIDER_REGISTRY` | Map 注册,加 provider = 建类 + 注册一次,无 if-else 散弹 |
| `llm/provider-kinds.ts:64-163` `PROVIDER_KINDS` | 每个 kind 自包含元数据(auth/baseUrl/protocol/chatFilter),加 OpenAI 兼容源 = 一个对象字面量 |
| `llm/capabilities/index.ts` + `rules.ts` | `capabilitiesFor(kind, model)` 纯函数,把「(provider,model) → 请求形状」差异收进单一规则表,client 不分支 |
| `types.ts:98-125` `RegisteredTool` 声明式元数据 | `pathPolicy`/`permissionDefault`/`isConcurrencySafe`/`timeoutMs` 在注册时声明,executor 统一强制,新工具自动继承安全检查 |

### 2.3 后端可替换的统一接口
- **审批后端**:`ApprovalBackend`(`permission.ts:23-25`)统一接口,Headless/Auto/Interactive/Run/Tier 多实现,加后端不动 executor 调用点,且支持组合(Auto 委托 inner backend)。
- **沙箱后端**:`SandboxBackend`(`sandbox/index.ts:35-62`)统一 `wrap`/`hint`,seatbelt/bwrap/off 各实现,加平台不动 Bash 工具。
- **Run 生命周期**:`run/types.ts:12-20` 的 `RunStatus` 是 domain-agnostic 的纯状态机,无硬编码 "code review"/"deployment" 语义,host 用 tag/metadata 表达 domain。

### 2.4 可靠性 / 工程纪律
- **原子写**:`atomicWriteJson`(`settings/manager.ts:351-356`)tmp+rename 模式被全项目复用;`FileRunStore` try/finally 清理临时文件。
- **abort 生命周期**:`registry.ts:120/142/157` 用 `{ once: true }` 注册、finally 移除,防 `MaxListenersExceeded`。
- **配置迁移**:`settings/migrate-config.ts` 有序 `MigrationStep[]` 纯函数,已处理 v0→v1→v2。
- **权限测试基建**:`permission.session-cache.test.ts` 7 个用例验证「批准一个操作不会自动放行另一个危险操作」与并发去重。
- **热重载分层**:`refreshRuntimeConfig`(`engine.ts:2539-2578`)增量(preset 软重解析 / hooks best-effort 重注册 / MCP 单独 reconcile)+ version stamp 丢弃陈旧投递。

---

## 3. 核心问题:core 边界正在被业务逻辑侵蚀

这是本报告的主干。下面把所有维度里「泄漏」类的发现去重、按**「它该住在哪」**重新归类。请注意:**没有一个泄漏是「污染了引擎/协议层」**——这也是为什么它可控。它们全部在两类叶子节点上:**(A) 端到端特性以 builtin tool 形式打进 core;(B) 产品策略/目录以 hardcoded 表形式打进 core。**

### 3.1 一张「该住哪」的去向表(全部泄漏项归类)

| 泄漏物 | 证据(file:line) | 现状 | 应该住在 | 优先级 |
|---|---|---|---|---|
| **Arena 整个特性**(planner/evidence/cross-review/debate/adjudication/consensus/render,9,282 LoC,~11% core,52 文件) | `arena/` 全目录;`tool-system/builtin/arena.ts`;`protocol/server.ts` getArenaStatus | 打进 core 单体构建,所有 host 都付编译/分发成本 | **独立可选包 `@codeshell/arena`** | 高 |
| Iterate(多稿锦标赛创作循环) | `arena/iterate/` 4 子目录 | Arena 子特性,随 Arena 包走 | 同上(随 Arena 包) | 高 |
| OpenRouter vendor 排序("anthropic 取 4、openai 取 5…") | `onboarding.ts:165-174` `OPENROUTER_VENDORS` | hardcode 的 UI 展示过滤(非目录本身) | **data 文件 / host 注入** | 中 |
| 模型 max-output / context-window 元数据 | `onboarding.ts:407-442/448-455` `KNOWN_MAX_OUTPUT`/`KNOWN_CONTEXT_WINDOWS` | direct provider 的 fallback 元数据,加模型要改 core | **model catalog data 层** | 中 |
| 定价表(60+ 模型) | `cost-tracker.ts:23-77` `MODEL_PRICING` | 手维护,会与现实漂移 | **data 文件 + 定期 sync + 时间戳** | 中 |
| Vertex/AWS 地域映射 | `utils/envUtils.ts:93-151` `VERTEX_REGION_OVERRIDES` | 函数纯但映射 hardcode,加模型改 core | **model catalog data 层**(与模型元数据放一起) | 低 |
| **Ant 内部环境探测** | `utils/envUtils.ts:114-159` `isRunningOnHomespace`/`isInProtectedNamespace`/`USER_TYPE='ant'` | 部署假设泄漏进通用引擎 | **删掉 / 移到独立集成 hook** | 中(信号坏) |
| Onboarding 中文 provider 文案 | `onboarding.ts:50/79/103/113/137/148` | 内部数据(未从 index.ts 导出),非真泄漏 | **data 文件**(顺手) | 低 |
| 外部 agent 产品名枚举 | `external-agents/types.ts:3-14` `ClaudeCodeSettings`/`CodexSettings` | 假设只有这两个外部产品 | `Record<string, AgentConfig>` 泛化(远期) | 低 |
| LSP/Brief/EnterWorktree(coding 专属工具) | `preset/index.ts:88-95` `TERMINAL_CODING_EXTRA_TOOLS` | preset 已正确隔离(运行时过滤) | **可选 toolpack**(打包优化,非边界问题) | 低 |
| Arena 终端渲染(颜色/emoji) | `arena/render/terminal.ts:1-80` | 假设 TTY 消费者;返回 string(已算克制) | 随 Arena 包走;另出 `renderArenaResultForAPI()` 纯 JSON | 低 |
| Onboarding 设置落盘 | `onboarding.ts:564-726` `saveSettings`/`appendOnboardingResult` | hardcode `~/.code-shell/settings.json` 路径 | 单 TUI 消费者,**保持现状**(注入 `SettingsWriter` 属过度设计) | 不动 |

### 3.2 两个真正的「泄漏模式」(这才是要立准则去堵的)

**模式 A:端到端特性以 builtin tool 形式进入 core。**
Arena 是最大例子。它**架构上是干净的**(只 import `core/llm`、`core/logging`、`core/types`、`core/tool-system`,core 引擎反向零依赖),但它是一个完整的多模型评审/辩论/共识系统,9,282 行、52 文件、~11% 的 core 体量。问题不在「它脏」,而在「它大且对多数 host 无用,却人人付编译/分发成本」。同类还有 `GenerateImage`/`GenerateVideo`/`BrowserTools`——重依赖的特性工具,minimal CLI host 也得全编译。
**判定**:这不是「立即必修的架构 bug」(运行时 host 不调就不付运行时成本),但**确实是 core 边界被侵蚀的最大单点**。Arena 该抽成 `@codeshell/arena`,把 `tool-system/builtin/arena.ts` 一并搬过去,core 通过可选 peer dep / feature-gated import 引用,避免循环。

**模式 B:产品策略 / 目录以 hardcoded 表形式进入 core。**
`onboarding.ts` 是重灾区:vendor 排序、模型元数据、context window;再加 `cost-tracker.ts` 的定价表、`envUtils.ts` 的地域映射。这些**全是产品配置 / 目录数据,不是基础设施**。
**重要澄清(避免你过度反应)**:经核实,「更新模型必须发 core」**对 OpenRouter 模型是假的**——OpenRouter 目录是 build 时从 `scripts/sync-models.ts` 拉的快照(~358 模型),`OPENROUTER_VENDORS` 只控制 picker 里每家**展示几个**。但对 **direct provider 模型**(Anthropic/DeepSeek 等,id 不含 `/`)而言,`KNOWN_MAX_OUTPUT`、定价、地域**确实只能靠改 core 更新**。所以泄漏是真的,只是范围比初判小。
**判定**:把这些表收敛进一个统一的 **model catalog data 层**(项目里已有 `model-catalog/` 雏形 + `~/.code-shell/model-catalog.user.json` 用户覆盖),让 core 只读目录、不内嵌目录。这同时能消掉「image/video 的 `CatalogEntry` 没有 `wireSpec`,而 LLM 有 capability 层」的不一致(`model-catalog/types.ts` 已定义 `wireSpec`/`ParamSpec` 和 `applyParams()`,只是 `generate-image.ts`/`generate-video.ts` 还在 hardcode 字段、没接上)。

**特殊项:Ant 内部探测必须删。** `isRunningOnHomespace`/`USER_TYPE='ant'`(`envUtils.ts:114-159`)即便是 stub,也在一个声称通用的引擎里暴露了**特定部署/雇主假设**。这是最该清理的「信号」类泄漏——它告诉所有读 core 的人「这其实是个内部工具」。成本极小,收益是边界纯净度。

---

## 4. 其它架构问题(按优先级)

### 4.1 [中] 工具元数据无注册期校验,`pathPolicy` 拼错会静默放行
- **证据**:`registry.ts:52-57` `registerTool` 接受 `RegisteredTool` 但不校验 `pathPolicy.arg` 是否匹配 `inputSchema` 字段;`executor.ts:519-527` 若 `args[policy.arg]` 因拼错为 `undefined`,返回空 targets,循环不执行,**返回 null(无报错),工具无防护运行**。`path-policy-metadata.test.ts` 也只测「有 path 字段的工具声明了 pathPolicy」,不测「pathPolicy.arg 真的存在于 schema」。
- **影响**:一个 typo(如 `arg:"pat"` 而非 `"path"`)会让该工具静默绕过路径权限层,无任何预警,只能靠人审。这是个真实的**安全静默失败**面。
- **建议**:加 `validateToolMetadata(tool)`,在 registry 构造或测试期校验每个 `pathPolicy.arg ∈ inputSchema.properties`,drift 即 fail。
- **工作量**:小。

### 4.2 [中] MCP 工具注册无结构校验
- **证据**:`mcp-manager.ts:221-232` 把 MCP server 返回的工具直接 wrap 成 `RegisteredTool`,不校验 `inputSchema`、不声明 `pathPolicy`。
- **影响缓解**:execution 期 `executor.ts:190-202` 仍会校验 inputSchema,MCP 工具默认 `permissionDefault="ask"` 有用户闸门。真实缺口是:操作文件的 MCP 工具因永不声明 `pathPolicy` 而**绕过集中式路径安全**(敏感路径/workspace 边界检查)——但这是「path policy 本就是 opt-in 声明制」的设计选择,非静默 bug。
- **建议**:加 `validateToolDefinition()` 做纵深防御,对 MCP 文件类工具要求 `pathPolicy` 声明或显式 `pathPolicyExempt`。
- **工作量**:小。

### 4.3 [中] turn-loop 状态机缺集成测试
- **证据**:`turn-loop.test.ts` 仅 36 行(类型契约);abort/continuation/error 三个集成测试稀疏(~4-6KB),**无**测试覆盖 `stopBlockCount` 循环、context-compaction-hook 顺序、goal-budget 耗尽时机。
- **影响**:turn 边界行为/context 压缩时机/hook 顺序的回归只能被用户发现。注意:这是**覆盖债**而非潜伏崩溃——goal 模式已在生产稳定,budget 算术有 `goal.test.ts`(216 行)单测,abort/异常安全有覆盖。
- **建议**:加 `turn-loop-state-machine.test.ts`,mock `ModelFacade`/`ToolExecutor`,跑 5-turn 场景(context 回滚 / hook block / goal 完成 / abort),只测状态流不测输出质量。
- **工作量**:中。

### 4.4 [中] 关键路径 JSON 读取静默吞错
- **证据**:67 处 `JSON.parse(readFileSync())`(去掉 25 处测试文件后),其中 onboarding/settings 层有 **3-4 处真静默失败**(如 `findSavedKeyForProvider:334` 对损坏文件返回 undefined,误导调用方)。多数 plugin/marketplace installer 实际有 `CSMeta.parse()` 或显式 throw,不算静默。
- **影响**:损坏配置在 onboarding 关键路径上被静默吞掉,无诊断信号;且无损坏 JSON 的测试覆盖。
- **建议**:抽 `safeReadJson(path, defaultValue?)`,**聚焦 10-15 个 settings/onboarding 关键实例**(不要机械重构全部 67 处),统一 `logger.debug` 落日志 + 补损坏文件测试。给真·intentional 的空 catch 加 `/* intentional: X */` 注释(`openai.ts:569`、`session-memory.ts:59`、`engine.ts:2132`)。
- **工作量**:小。

### 4.5 [低] image/video provider 工厂偏离 LLM 工厂模式
- **证据**:`image-providers.ts:222-231`、`video-providers.ts:270-279` 用 switch(openai/google;fake/fal),而 LLM 用 `registerProvider`/`PROVIDER_REGISTRY`。
- **影响**:目前各只 2 个 provider,switch 完全可维护(标记为 TODO 7.1 的未完工作)。随时间积累会偏离 LLM 模式,跨 provider 重构变难。
- **建议**:**等到第 4 个 provider 再上** `ProviderRegistry<T>` 泛型(配合 §3.2 的 catalog 统一一起做)。现在不动。
- **工作量**:小。

### 4.6 [低] 审批审计无跨会话持久
- **证据**:`permission.ts:142-143` `sessionAllowRules` 仅内存;但每次审批/拒绝**已**持久化到 `~/.code-shell/logs/engine-*.log`(经 `span.end()`,含 tool/decision/scope/时间/sessionId)。
- **缺口**:日志条目**不含实际 command/args**(用户看到 "approved Bash" 而非 "approved rm -rf /");无查询 CLI/UI;日志 7 天轮转。
- **判定**:审计信息存在但**隐式**(debug 日志),非显式审计文件。是 UX/可发现性问题,非「完全没审计」。
- **建议**:可选加 `~/.code-shell/approval-log.jsonl` + 未来 `show approvals` 命令(args 含凭证时 hash)。优先级低。
- **工作量**:中。

### 4.7 [低] settings 双源(`settings.model` vs `settings.providers`)
- **证据**:`settings/schema.ts` 同时维护 `settings.model` 与 `settings.providers[]`,`manager.ts:63-66` 注释承认是 legacy 兼容镜像。
- **建议**:加测试断言两者每次 mutation 后同步;未来主版本删 `settings.model`。现在不急。
- **工作量**:中。

### 4.8 [低] TCP host 的 MCP 配置不随会话热读(多宿主一致性裂缝)
- **证据**:`agent-server-tcp.ts:42` 启动时读一次 `settings.mcpServers`,每会话复用;`agent-server-stdio.ts:167` 每会话 `freshSettings()` 重读。用户中途改 `mcpServers`,TCP 看到陈旧、stdio 看到新鲜。
- **判定**:TCP 是 headless 长跑服务器,config 改动本就期望重启生效——属**有意设计**,非 bug。
- **建议**:要么 TCP 的 engineFactory 也 `settingsManager.load()` 重读;要么在代码注释里写清「TCP 的 MCP 编辑需重启」,别让它成为意外。
- **工作量**:小。

### 4.9 [低] index.ts 混合 core API 与 TUI-only 导出,无层级标记
- **证据**:`index.ts` 有 `─── Tool-system (extended for TUI)`、`─── Arena (extended for TUI)` 等段落与 core 导出混排;`update-automation-memory.js` 这类内部工具工厂被公开导出。
- **影响**:SDK 消费者分不清哪些是稳定 core API、哪些是会随 UI 变的 TUI 工具。
- **建议**:给 TUI-only 导出加 `@internal`/`@unstable` JSDoc,或拆 `@code-shell/core/tui` 子入口。
- **工作量**:小。

---

## 5. 下一步迭代路线

目标:**在不伤动脉的前提下,把策略与目录从 core 里抽出去,并立一条准则防止再次熵增。** 顺序按「先止血 → 先低风险高收益」。

### Phase 0 —— 止血(本周,~半天,纯文档+流程)

**写下并采纳一条「什么该进 core」契约。** 放在 `packages/core/CONTRIBUTING.md`(或 `index.ts` 顶部),内容就是下面这张表,并约定:**任何 core PR 在 review 时先问这三句话。**

> **CodeShell core 边界契约**
> core 只装 **机制(mechanism)**,不装 **策略与目录(policy & catalog)**。
>
> | 进 core ✅ | 不进 core ❌(去 data / 包 / host / plugin) |
> |---|---|
> | 引擎、turn-loop、tool-system 框架、executor | 具体某个 provider 列表、模型元数据、定价、地域映射 |
> | 权限/沙箱/hook **框架**与接口 | 某个端到端特性(多模型评审、视频生成流水线) |
> | LLM 客户端抽象 + capability **机制** | 用户可见文案、产品名枚举、部署/雇主假设 |
> | 会话/transcript/协议 | 任何「更新它要发 core 版本」的目录数据 |
>
> **Review 三问:**
> 1. 这段逻辑**换个产品/换个部署**还成立吗?不成立 → 不进 core。
> 2. 更新它需要**发 core 版本**吗?需要 → 它是数据,该进 data 层。
> 3. 它是**机制**还是**某个特性的实现**?是特性 → 该进可选包或 plugin。

**收益**:零代码、立刻生效、把「默认落点 = 再加个 builtin + 再 hardcode 一张表」的惯性掐断。这是对你那句焦虑最直接的答复——**先有准则,再谈搬家。**

同时顺手做两件 5 分钟的事:删 `envUtils.ts` 的 Ant 内部探测(`isRunningOnHomespace`/`USER_TYPE='ant'`);给 `index.ts` 的 TUI-only 段落加 `@internal`。

### Phase 1 —— 把目录数据外移(1-2 周,中等工作量,高收益)

把所有 hardcoded 目录收敛到 **model catalog data 层**(复用已有的 `model-catalog/` + `model-catalog.user.json` 机制):

1. `cost-tracker.ts` 定价表 → catalog data + 时间戳(UI 可提示「定价数据已 X 天未更新」)。
2. `onboarding.ts` 的 `KNOWN_MAX_OUTPUT`/`KNOWN_CONTEXT_WINDOWS`/`OPENROUTER_VENDORS` → catalog data,core 只读。
3. `envUtils.ts` 的 `VERTEX_REGION_OVERRIDES` → 与模型元数据放一起。
4. onboarding 中文文案 → data 文件(为未来 i18n 留口,不现在做 i18n)。

**收益**:更新模型/定价**不再需要发 core**;`generate-image`/`generate-video` 可以顺势接上已存在的 `applyParams(inst.paramValues, preset.params)`,消掉 image/video 与 LLM 的抽象不一致。
**前置**:这步把 §4.5 的 image/video registry 问题也一并解决(catalog 驱动后 switch 自然消失)。

### Phase 2 —— Arena 抽成可选包(2-3 周,大工作量,高模块化收益)

1. 新建 `@codeshell/arena`,搬入 `arena/` 全目录 + `tool-system/builtin/arena.ts`。
2. Arena 只依赖 core 的 `llm`/`logging`/`types`/`tool-system`(已是现状,无循环)。
3. core 通过**可选 peer dependency / feature-gated import** 引用;想要多模型评审的 host 装 `@codeshell/arena`,minimal CLI host 跳过。
4. 顺手:`arena/render/terminal.ts` 旁边出一个 `renderArenaResultForAPI()` 返回纯 JSON,headless host 不再被迫编译终端渲染。

**收益**:core 瘦身 ~11%;minimal 构建更小更快;Arena 可独立演进/发版。
**注意**:这是**纯组织性重构,不是架构修复**——别因为它「大」就高估它的紧迫度。先做 Phase 1。

### Phase 3 —— 加固与债务清理(穿插进行,各项独立)

按 §4 的中优先级项,**TDD 方式**逐个做(每项都小):
- §4.1 `validateToolMetadata()`:registry/测试期校验 `pathPolicy.arg ∈ inputSchema`。**安全相关,建议优先。**
- §4.2 MCP 工具 `validateToolDefinition()` 纵深防御。
- §4.3 `turn-loop-state-machine.test.ts` 集成测试。
- §4.4 `safeReadJson` 聚焦 10-15 个 settings/onboarding 关键实例(**不要全量重构 67 处**)。
- §4.8 TCP host MCP 热读 or 注释澄清。

---

## 6. 明确不要做的(防过度工程)

这些经核实是**合理的、有意的设计**或**收益不抵成本**,**不要去重构**:

| 不要动 | 为什么 |
|---|---|
| **拆 `engine.ts`(3183 行)** | 它是有意的 facade,串联 12+ 组件且有真实排序约束。`EngineRuntime` 已抽出共享资源,多数方法是 10-40 行的配置 getter/纯 helper。拆成 ModelPoolManager/ConfigWatcher/… 只会**碎片化编排流**,得不偿失。 |
| **给 `BUILTIN_TOOLS` 数组上自动发现/装饰器** | 53 个工具的显式数组,TypeScript 会抓漏元数据,「显式 > 魔法」对可审计性有价值。手动注册是 tedious 但不易错。 |
| **现在就给 image/video/uploader 上 registry** | 各只 2-3 个 provider,switch 完全可维护。等第 4 个再做,且和 Phase 1 catalog 统一一起做。 |
| **给 onboarding 落盘注入 `SettingsWriter` 接口** | 单 TUI 消费者、无第三方 SDK 用户,抽接口是过度设计。`saveSettings` 保持现状。 |
| **泛化 `external-agents` 产品名枚举** | 服务于窄场景(Mobile Remote Room 权限闸门),加第三个产品成本极低(schema + 一个 resolver)。远期再说。 |
| **把 capability `RULES` 改成「从上游 API 自动同步」** | 不可行——vendor 不在 `/v1/models` 端点暴露请求形状(reasoning_effort vs thinking.budget_tokens),这些差异只在文档里。手维护 + `DEFAULT_CAPABILITY` fallback + HTTP 400 即时可见 + 按模型族测试覆盖,已是正解。 |
| **给 `configVersion`/`reloadSettings` 上原子整数/重入锁** | JS 单线程,实际无竞争。加注释「reloadSettings 非重入」即可,别上锁。 |
| **机械重构全部 67 处 JSON 读取** | 多数(plugin installer/sessions 层)已有显式校验或 `existsSync` 前置,25 处还是测试文件。只修关键路径的 3-4 处真静默失败。 |

---

*评估完成。骨架健康,边界焦虑合理但可控。先立准则(Phase 0),再外移目录(Phase 1),再抽 Arena(Phase 2)。不要拆引擎。*
