# codeshell 模块与链路参考(core / desktop / tui)

> 生成于 2026-06-10。本文是「模块 → 子模块 → 核心文件 → 关键链路」的索引式参考,基于对全仓库**非测试源文件**(core+desktop+tui 约 900 个文件)的逐目录扫描汇总而成。
>
> 配套交互页:[`codeshell-link-simulator.html`](./codeshell-link-simulator.html) —— 点入口即可高亮整条链路、看每一步干了什么。
>
> 已有的更深入文档(本文不重复,需要细节请直接看):
> - 引擎回合循环:[`engine-turnloop-architecture.md`](./engine-turnloop-architecture.md)
> - 工具系统:[`tool-system-architecture.md`](./tool-system-architecture.md)
> - 全量架构:[`codeshell-full-architecture.md`](./codeshell-full-architecture.md)
> - Arena:[`arena-evidence-driven-architecture.md`](./arena-evidence-driven-architecture.md)

---

## 0. 三大模块全景

codeshell 是一个 monorepo(`packages/*` workspace),分三个包:

| 包 | 角色 | 入口 | 怎么被消费 |
|----|------|------|-----------|
| **`@cjhyy/code-shell-core`** (`packages/core`) | 引擎与 SDK:回合循环、工具、LLM、协议、会话、记忆、arena、自动化、插件。**不含任何 UI** | `src/index.ts` 桶导出整个 SDK 表面;`src/cli/agent-server-*.ts` 是进程入口 | TUI 与 Desktop 都通过包导出消费;两者**都不直接 import core 内部路径**,只经 `index.ts` |
| **`tui`** (`packages/tui`) | 终端 REPL / headless CLI;含一套**自研的类 Ink 终端渲染引擎**(`src/render`) | `src/cli/main.ts`(bin `code-shell`) | 直接依赖 core;UI 组件按模块路径 import |
| **`desktop`** (`packages/desktop`) | Electron 三进程桌面端 + 手机/平板遥控 | `src/main/index.ts`(主进程,esbuild 打包) | 主进程派生 **agent worker 子进程**跑 core,renderer 经 preload bridge 通信 |

**关键设计约束(贯穿全仓):**
- **core 与宿主之间走 `protocol/` 定义的 JSON-RPC 风格线协议**(进程内 / stdio / TCP 三种传输),`StreamEvent` 是统一的事件流类型。宿主从不直接调 `TurnLoop`,而是经 `AgentClient → Transport → AgentServer → ChatSession → Engine`。
- **Desktop 不把 core 跑在主进程里**,而是派生一个独立 agent worker 子进程(`agent-bridge.ts` ↔ `cli/agent-server-stdio.ts`),用 stdio NDJSON 通信 —— 隔离崩溃、避免阻塞 UI。
- **TUI 直接在本进程内**用 `createInProcessTransport` 把 Engine 和 UI 接到一起。

---

## 1. CORE 模块(`packages/core/src`)

core 内部分为 ~28 个子模块。下面按「层」组织。

### 1.1 公共门面层 — `core/src`(根文件,9 个)
**职责:** 聚合导出整个 core SDK 表面,并就地定义横切基础设施。
- `index.ts` — **唯一对外入口**,re-export 所有子模块符号 + `VERSION`。
- `types.ts` — 全局类型:`Message`/`ContentBlock`/`ToolDefinition`/`ToolResult`/`TranscriptEvent`/`SessionState`/`PermissionDecision`/`StreamEvent`/`LLMConfig`/`Settings` 等。
- `exceptions.ts` — `FrameworkError` 根 + LLM/Tool/Permission/Session/Config/Sandbox 各类错误。
- `state.ts` — 进程级运行时单例(sessionId/cwd/projectRoot/成本累计)。
- `cost-tracker.ts` — token 用量与成本估算单例。
- `onboarding.ts` — provider 目录、API key 探测/解析、模型池构建、settings 持久化。
- `updater.ts`、`colorizer.ts`、`migrate-models.ts` — 自动更新、上色接口、配置迁移。

### 1.2 引擎层 — `core/src/engine`(19 个)★核心
**职责:** 代理回合循环。`Engine` 门面把模型/工具/上下文/Hook/会话串起来,`TurnLoop` 驱动状态机。
- `engine.ts` — **主门面 `Engine`**,装配所有子系统、驱动一次会话运行。
- `turn-loop.ts` — **回合循环状态机**:`pre_check → model_call → post_check → tool_exec → context_mgmt → hook_notify → 下一回合`。
- `query.ts` — 包 TurnLoop 的高层 async generator,产出 `StreamEvent`。
- `model-facade.ts` — 封装 LLM client 的模型调用门面。
- `runtime.ts` — 跨 Engine 实例共享的只读资源(modelPool/registry/settings/mcp)+ 沙箱缓存。
- `goal.ts` — goal 模式(目标 + 预算 + stop-block 上限)。
- `token-budget.ts` / `reactive-threshold.ts` — token 预算决策、上下文压缩阈值。
- `streaming-tool-queue.ts` — 流式工具调用排队。
- `parse-task.ts` / `image-policy.ts` / `image-compression.ts` — 任务图片解析与策略。
- `patch-orphaned-tools.ts` / `friendly-error.ts` / `tool-summary.ts` / `session-title.ts` — 周边修补与摘要。

### 1.3 LLM 层 — `core/src/llm`(23 个)
**职责:** 把模型配置变成流式 chat client,用「能力层」抹平各 provider 请求形状差异,管理模型注册表/拉取/缓存/重试/推理。
- `client-factory.ts` / `client-base.ts` — provider 注册表 + 抽象基类。
- `providers/anthropic.ts`、`providers/openai.ts` — 两个具体 provider(后者覆盖所有 OpenAI 兼容端点)。
- `model-pool.ts` — 运行时模型注册表(get/switch/list)。
- `provider-catalog.ts` / `provider-kinds.ts` / `provider-auth.ts` — 凭据目录、内置种类元数据、自定义鉴权($()authCommand)。
- `capabilities/{index,types,rules,reasoning-control}.ts` — **能力层**:`capabilitiesFor(kind,model)` 返回请求形状描述符。
- `model-fetcher.ts` / `model-cache.ts` — 拉 `/v1/models` 并 7 天 TTL 缓存。
- `reasoning-setting.ts` / `stream-watchdog.ts` / `retry.ts` / `stop-reason.ts` / `strip-vision.ts` / `clamp-max-tokens.ts` / `token-counter.ts` / `api-key-sanitize.ts` — 各类请求/流处理细节。

### 1.4 工具系统 — `core/src/tool-system`(64 个含 builtin/)★核心
**职责:** 注册/校验/权限分级/沙箱包裹并执行所有内置工具与 MCP 工具,是 Engine 调度模型工具调用的统一入口。
- `registry.ts` — 统一工具注册表(内置 + MCP)。
- `executor.ts` — **执行编排器**:权限分类 → hook → 校验 → plan-mode 门控 → 实际执行。
- `permission.ts` — **权限系统**:分类器 + 多种审批后端(无头/自动/交互)+ 规则匹配 + Bash 安全分级。
- `path-policy.ts` — 文件工具路径安全分类(解析符号链接、查敏感路径、对比工作区根),产出 allow/ask/deny。
- `context.ts` — 每 Engine 实例注入的工具运行时服务容器(askUser/llmConfig/modelPool/registry/subagent)。
- `mcp-manager.ts` — MCP 服务器管理(连接 stdio/http、包裹不可信输出防注入)。
- `validation.ts` / `investigation-guard.ts` / `task-guard.ts` / `plan-mode-allowlist.ts` — 入参校验与各类运行护栏。
- `builtin/` — 所有内置工具(read/write/edit/glob/grep/bash/agent/web/generate-image/...),`builtin/apply-patch/` 是 V4A 补丁原子写子系统,`builtin/agent-registry.ts` 是后台子代理注册表。
- `sandbox/{index,seatbelt,bwrap,off}.ts` — 按平台选 macOS seatbelt / Linux bubblewrap / 直通。

### 1.5 协议层 — `core/src/protocol`(11 个)★核心
**职责:** core 与宿主之间的 JSON-RPC 线协议:类型、传输、AgentServer/AgentClient、多会话管理、脱敏。
- `types.ts` — JSON-RPC 信封、`Methods`、`ErrorCodes`、各请求/结果/通知。
- `server.ts` — **AgentServer**:包 ChatSessionManager,分派 run/approve/cancel/configure/query/inject。
- `client.ts` — **AgentClient**:UI 侧句柄,以 EventEmitter 暴露 stream/approvalRequest/status。
- `transport.ts` / `tcp-transport.ts` — 进程内成对传输 + stdio NDJSON + TCP NDJSON。
- `chat-session.ts` / `chat-session-manager.ts` — 每个 UI tab 一个 ChatSession(持单 Engine + FIFO turn 队列);Manager 按 sessionId 管理多会话。
- `factories.ts` / `helpers.ts` — `createServer` / `createInProcessClient` 稳定公共工厂。
- `redact.ts` — 协议边界密钥脱敏。

### 1.6 受控运行 — `core/src/run`(15 个)
**职责:** 把 `Engine.run()` 包进队列、状态机、事件溯源、检查点、审批挂起恢复、产物追踪、跨进程锁/心跳、完成评估。
- `RunManager.ts` — 顶层协调器。`EngineRunner.ts` — 执行后端(桥到 Engine.run)。
- `RunStore.ts` / `FileRunStore.ts` / `RunQueue.ts` — 持久化接口 + 文件实现 + FIFO 队列。
- `RunApprovalBackend.ts` — 把审批/AskUser 桥进 Run 生命周期(挂起到 resume)。
- `CheckpointWriter.ts` / `ArtifactTracker.ts` / `RunLock.ts` / `Heartbeat.ts` / `Evaluator.ts` — 检查点、产物、锁、心跳、评估。

### 1.7 自动化 — `core/src/automation` + `cron`(垫片) + `remote`(11 个)
**职责:** 零环境依赖的 cron 调度;任意宿主注入 store+执行后端即可无头按 cron/间隔跑 agent。
- `index.ts`(`startAutomation`)、`scheduler.ts`(`CronScheduler`,含睡眠/唤醒误触防护)、`runner.ts`(bindCronToEngine/bindCronToRunManager)、`store.ts`(`~/.code-shell/cron.json`)、`cron-expr.ts`(零依赖 5 字段解析)、`write-policy.ts`(权限层→permissionMode+审批+sandbox)、`write-run.ts`(隔离 worktree 跑写类任务→开 PR)。
- `cron/*` 是向后兼容 re-export 垫片。`remote/bridge.ts` 是 SSH NDJSON 远程桥(预留)。

### 1.8 提示与扩展 — `prompt` + `hooks` + `skills` + `preset`(18 个)
- `prompt/composer.ts` — **系统提示词组装**:sections + 指令文件 + 技能 + 预设 + 记忆。
- `prompt/sections/*.md` — 分段提示模板(base/coding/tone/orchestration)。
- `prompt/instruction-scanner.ts` — 扫描 CLAUDE.md/AGENTS.md 层级。
- `hooks/registry.ts` — **钩子注册表**:按优先级注册/触发,聚合 messages、取最严权限决策。
- `hooks/goal-stop-hook.ts` — goal 终止裁判(on_stop,用 LLM 判目标是否达成)。
- `skills/scanner.ts` — 扫描全局/项目/插件 SKILL.md。`preset/index.ts` — agent 预设(sections+工具集+权限)。

### 1.9 会话/配置/上下文 — `session` + `settings` + `context`(16 个)
- `session/session-manager.ts` — 会话生命周期(创建/恢复/fork/保存 state.json)。
- `session/transcript.ts` — JSONL 事件日志,`toMessages()` 派生喂 LLM 的 `Message[]`。
- `session/memory.ts` — 跨会话持久记忆(user/dream 两 scope)。`file-history.ts` / `undo-target.ts` / `simple-diff.ts` — /undo 快照。
- `settings/manager.ts` — **多源配置合并**(CLI>local>project>user>managed)。`schema.ts`(Zod)、`disk-defaults.ts`(热重载 layer2)、`feature-flags.ts`、`personalization.ts`。
- `context/manager.ts` — **三层上下文管理**(microcompact / LLM summary / window compact)。`compaction.ts`、`token-counter.ts`、`tool-result-storage.ts`(大结果落盘换引用)。

### 1.10 服务与子代理 — `services` + `agent` + `capability-control`(21 个)
- `services/memory-orchestrator.ts` — 会话结束记忆流水线(抽取→总结→记账→auto-dream)。`dream-consolidation.ts` — dream 整理 LLM 循环。`analytics`/`diagnostics`/`notifier`/`oauth`/`browser-open`。
- `agent/agent-definition.ts` / `agent-definition-registry.ts` — 子代理角色定义(Markdown 解析/合并)。`external-agents/` — 外部 CLI 代理(CC/Codex)配置解析。
- `capability-control/service.ts` — **能力控制唯一入口**:对内置工具/MCP/技能/插件/代理做只读投影 + 用户级/项目级三态开关。

### 1.11 Arena — `core/src/arena`(48 个)
**职责:** 多模型协作分析:证据驱动流水线(规划→证据→研究→声明→交叉验证→辩论→裁决→共识)做评审/讨论/规划;`iterate/` 子系统做「从零创作」的锦标赛+批评-修订循环。
- `arena.ts`(主编排器)、`planner.ts`(NL→ArenaPlan)、`ledger.ts`(append-only 共享状态)、`phases/*`、`strategies/*`、`providers/*`、`lenses/*`、`iterate/*`。

### 1.12 横切基础设施 — `runtime` + `cli` + `git` + `lsp` + `logging` + `product` + `data` + `review`(31 个)
- `runtime/background-shell.ts` — 后台长驻 shell 管理器单例。`safe-spawn.ts` / `spawn-common.ts` — 安全子进程封装、沙箱 env。
- `cli/agent-server-stdio.ts` / `agent-server-tcp.ts` — **两个进程入口**(stdio / TCP agent-server)。
- `git/utils.ts` / `worktree.ts` — git/gh 封装、worktree 生命周期。`lsp/*` — LSP 客户端。
- `logging/logger.ts` — 全局结构化 logger(AsyncLocalStorage 携带 sid)。`session-recorder.ts` — verbose 录制。
- `data/*` — 静态模型目录 JSON + OpenRouter 同步。`review/review-prompt.ts` — 代码审查 prompt。

---

## 2. DESKTOP 模块(`packages/desktop/src`)

Electron 三进程 + 手机遥控。

### 2.1 主进程 — `desktop/src/main`(42 个)★
**职责:** renderer(ipcMain)与 agent worker 子进程之间的 broker;窗口/菜单/更新生命周期 + 一组后端 service。
- `index.ts` — **主进程入口**:注册所有 ipcMain handler、引导 AgentBridge/移动遥控/各 service。
- `agent-bridge.ts` — **派生并管理 agent worker 子进程**(stdio JSON-RPC),按行解析快照流广播到 renderer,含重启限流。
- `SessionSnapshotStore.ts` / `parseStreamLine.ts` — 内存快照日志(供重放)、解析 worker 输出行。
- service 群:`fs-service`、`desktop-services`(git/worktree)、`sessions-service` / `rawTranscript` / `transcript-reader`、`memory-service` / `dream-service`、`skills-service` / `plugins-service` / `marketplace-service` / `mcp-probe-service`、`automation-service` / `automation-host` / `automationMemory` / `automationToolset`、`capabilities-service`、`model-meta-service` / `search-probe-service` / `image-probe-service`、`pty-service`(node-pty 终端)、`logs-service`、`settings-service`、`agents-service`、`github-skill-service`、`editor` / `image-save` / `file-search-service`。
- 持久化 store:`recents-store` / `session-titles-store` / `trust-store` / `window-state-store`。
- `updater.ts`(electron-updater)、`menu.ts`、`desktop-logger.ts` / `redact-secrets` / `safe-read` / `seed-defaults`。

### 2.2 手机/平板遥控服务端 — `desktop/src/main/mobile-remote`(11 个)
**职责:** 主进程内的 http+ws 遥控服务端,LAN 或 cloudflared 公网隧道暴露聊天/审批界面;设备配对/信任/口令鉴权 + 设备隔离。
- `remote-host-manager.ts`(遥控入口)、`types.ts`、`access-passcode.ts`(scrypt+HMAC 记住-token+限流)、`trusted-device-store.ts`(按 secretHash 去重)、`pairing.ts`(一次性 token)、`cloudflared-binary.ts` / `tunnel-manager.ts`(隧道)、`mobile-static.ts`(静态资源)、`resident-agent.ts`(常驻 claude stream-json 子进程)、`room-manager.ts`(房间/独立会话)、`mobile-history.ts`(复用 renderer reducer 回放历史)。

### 2.3 preload 桥 — `desktop/src/preload`(2 个)
**职责:** 经 contextBridge 把 main 能力以类型化的 `window.codeshell` API 暴露给 renderer(renderer **永不直接 import core**),并以 JSON-RPC line over IPC 通道 `agent:msg` 中转。
- `index.ts`(运行时 rpc()/通知扇出)、`types.d.ts`(`CodeshellApi` 接口 + `declare global` window 类型)。

### 2.4 renderer 顶层 — `desktop/src/renderer`(24 个)★
**职责:** React 根入口 + 三栏布局 + 消息流 reducer + 本地持久化状态 + 流事件路由。
- `main.tsx`(挂载)、`App.tsx`(useReducer 管理消息状态、装配 Sidebar/TopBar/ChatView、订阅 StreamEvent)、`ChatView.tsx`、`MessageStream.tsx`、`Sidebar.tsx` / `SidebarNav.tsx` / `TopBar.tsx`。
- `types.ts` — **消息域类型 + reducer**:`Message` 联合、`applyStreamEvent`。
- 流处理:`streamRouting.ts`(StreamEvent→bucket)、`streamCoalescer.ts`(50ms 合批)、`snapshotReplay.ts`、`sessionStatus.ts`。
- 持久化纯逻辑:`transcripts.ts`(会话索引 CRUD)、`repos.ts`(项目)、`view`/`theme`/`uiLanguage`/`gitPrefs`/`promptHistory`/`queuedInput`、`settingsBus.ts`。

### 2.5 聊天与消息流 — `desktop/src/renderer/chat` + `messages`(37 个)
- `chat/` — 输入框周边:`ModelPill` / `PermissionPill` / `ProjectPicker` / `BranchPicker` / `GoalToggle` / `ContextRing`、`attachments` / `compress`(图片压缩)、`mention` / `MentionPopover`、`anchors`(标注)、`openWith`、`Lightbox`、`stickToBottom`。
- `messages/` — 把 StreamEvent 序列归并/折叠成可渲染分组:`streamGroups.ts`(核心 reconcile)、`agentGroup.ts`、`fileChangeAggregator.ts`,以及各类卡片 view(Assistant/Tool/TurnProcessGroup/Agent/Thinking/AskUser/TaskList/GoalProgress/FilesChanged/...)。

### 2.6 工具卡/审批/diff — `tool-cards` + `approvals` + `diff`(19 个)
- `tool-cards/` — 按工具类型分发的卡片(Bash/File/Search/Web/Agent/Generic)+ `ToolCardShell` + 附件卡。
- `approvals/` — `ApprovalCard` / `ApprovalsView` / `approvalDecision`(choice→decision)/ `RiskPill`。
- `diff/` — `UnifiedDiffViewer` / `parseUnifiedDiff` / `ChangedFilesList` / `reviewScope`。

### 2.7 设置页 — `desktop/src/renderer/settings`(19 个)
全屏设置页 + 各分区(模型/权限/MCP/记忆/子代理/外观/插件技能/能力总览/高级集合/连接面板/ProjectPicker)。经 settingsBus + preload IPC 读写多作用域配置。

### 2.8 工作区面板/外壳 — `shell` + `panels` + `sessions` + `runs`(15 个)
- `panels/` — 多标签面板区:`PanelArea` + 文件/浏览器(webview)/审查/终端(xterm)/后台 shell/聊天室面板。
- `shell/` — `CommandPalette`(Cmd+K)、`SearchBar`、`SessionSearchModal`。`topbar/StatusPopover` + `liveActivity`。`runs/RunsView`、`sessions/SessionsView`。

### 2.9 共享 UI 与杂项功能 — `ui`+`components/ui`+`markdown`+`lib`(29 个) / `features`(24 个)
- `ui/` + `components/ui/` — shadcn/ui 原子组件 + 应用级封装(DialogProvider/ToastProvider/Select/SimpleSelect)。`markdown/remarkPathLinks`(路径转可点链接)。`lib/utils`(cn)。
- `features` — 扩展(插件/技能/MCP/市场)管理、自动化(cron)视图 + 一批纯逻辑 helper(scheduleModel/foldTranscript/mergeTranscripts/...)、MCP 视图、日志、更新横幅、工作区信任门禁。

### 2.10 手机端 React 应用 — `desktop/src/mobile`(20 个)
**职责:** 独立 React 应用(第二个 vite root),经 WebSocket 连 mobile-remote 服务,远程驱动桌面会话与「房间」。
- `App.tsx`(响应式根布局)、`hooks/useRemoteApp`(顶层状态机)、`hooks/useRemoteSocket`(WS 连接/配对/重连状态机)、`lib/streamReducer`(核心聊天 reducer)、组件(ApprovalCard/Composer/MessageStream/RoomList/SessionList/...)。

---

## 3. TUI 模块(`packages/tui/src`)

终端 REPL/headless CLI + 自研类 Ink 渲染引擎。

### 3.1 启动与命令层 — `cli` + `bootstrap`(34 个)★
**职责:** 解析 CLI 参数、初始化会话、装配 `Engine→AgentServer→AgentClient` 管线,headless 渲染 + 交互 REPL 入口 + 子命令 + 斜杠命令注册表。
- `cli/main.ts` — **bin 入口**(commander 装配 run/repl/sessions/arena/runs/plugin + 默认命令,preAction 调 setup)。
- `bootstrap/setup.ts` — 会话启动初始化(日志轮转、Node 版本/cwd 校验、bypass root 安全检查、git 探测)。
- `cli/commands/repl.ts` — **交互 REPL 入口**(装配管线 + cron 绑定 + 启动 Ink UI)。
- `cli/commands/run.ts` — **headless 单提示执行**(seed Engine→ChatSessionManager→Server/Client + headless renderer)。
- `cli/commands/registry.ts` — 斜杠命令注册表。`arena.ts` / `runs.ts` / `plugin.ts` 子命令。
- `cli/commands/builtin/*` — 各斜杠命令(/commit /diff /review /mcp /skills /image /init /permissions /features ...)。
- `cli/input/*`(read-stdin / ndjson-reader)、`cli/output/*`(headless renderer:text/json/jsonl/stream-json)。

### 3.2 React UI 层 — `tui/src/ui`(+ utils/voice/native-ts)(60 个)★
**职责:** 基于自研 render 框架的聊天 REPL 全部界面。
- `index.tsx`(`startInkRepl` 入口)、`App.tsx`(顶层组件:编排消息流/命令输入/工具+agent 卡/状态栏/弹窗)、`store.ts`(useSyncExternalStore 聊天 store)、`theme.ts`。
- `terminal-renderer.ts`(alt-screen/光标/同步更新)、`vim-mode.ts`、`input-history.ts`、`query-guard.ts`(并发守卫)、`slice-anchor.ts` / `useVirtualScroll`(虚拟滚动)、`fullscreen-mode.ts`、`onboarding-runner.tsx`。
- `components/*.tsx`(~36 个)— 消息渲染(MessageRow/CodeBlock/DiffView)、工具/agent 卡、各选择器与状态栏。
- `native-ts/yoga-layout/*` — **纯 TS 实现的 yoga flexbox 布局引擎**(供 render 层)。`utils/colorizer`(chalk)、`utils/fullscreen`、`voice/`(预留)。

### 3.3 自研类 Ink 渲染引擎 — `tui/src/render`(106 个,含 subsystems)★核心
**职责:** npm ink 的替代实现:同形的 React 组件/Hooks API,经 react-reconciler 把 DOM 树布局成屏幕单元格缓冲,diff/optimize 后写终端;负责 ANSI 解析、选区、搜索高亮、超链接、光标、终端能力探测。
- 顶层:`index.ts`(barrel)、`ink.tsx`(核心 Ink 实例类)、`root.ts`(render 入口)、`reconciler.ts`(react-reconciler host config)、`dom.ts`(自研 DOM 节点)。
- 屏幕/帧:`screen.ts`(单元格缓冲+池)、`renderer.ts`(双缓冲)、`render-node-to-output.ts`、`log-update.ts`(diff→ANSI)、`optimizer.ts`、`frame.ts`。
- 文本/样式:`styles` / `colorize` / `squash-text-nodes` / `stringWidth` / `wrap-text` / `measure-text` / `bidi` / `tabstops`。
- 交互:`selection.ts`(选区状态机)、`searchHighlight.ts`、`hit-test.ts`、`focus.ts`、`parse-keypress.ts`、`terminal.ts`(能力探测)、`terminal-querier.ts`。
- `components/*`(原语 Box/Text/ScrollBox/Button/Link/Static + 根 App + 各 Context)、`events/*`(DOM 风格事件分发)、`hooks/*`(use-input/use-selection/...)、`layout/*`(Yoga 适配)、`termio/*`(语义化 ANSI 解析器:csi/dec/esc/osc/sgr/parser/tokenize)。

---

## 4. 五条关键链路(交互页可点击模拟)

下面是交互页里能「点入口→高亮整条链路」的 5 条链路。节点为子模块级,每步给出真实文件锚点。

### 链路 ① 用户发一条消息 → 回复(turn loop 主链路)
```
[宿主输入] → AgentClient.run() (protocol/client.ts)
  → Transport (protocol/transport.ts)
  → AgentServer.run() (protocol/server.ts)
  → ChatSession 入 FIFO turn 队列 (protocol/chat-session.ts)
  → Engine.run() (engine/engine.ts)
  → PromptComposer 组装系统提示 (prompt/composer.ts)
  → TurnLoop 状态机 (engine/turn-loop.ts)
    → ModelFacade.call() (engine/model-facade.ts)
      → createLLMClient → AnthropicClient/OpenAIClient (llm/client-factory.ts, llm/providers/*)
      → capabilitiesFor 抹平请求形状 (llm/capabilities/index.ts)
    → 流式增量 → StreamEvent → onStream 回调
    → 有 tool_use? → 见链路②;否则
    → ContextManager 检查压缩 (context/manager.ts)
    → HookRegistry.emit(on_stop) (hooks/registry.ts) → goal 未达成则续跑 (hooks/goal-stop-hook.ts)
  → Transcript 落 JSONL (session/transcript.ts)
  → StreamEvent 经 AgentServer → AgentClient → 宿主渲染
```

### 链路 ② 工具调用全链路(审批 / 权限 / 沙箱)
```
TurnLoop 收到 tool_use (engine/turn-loop.ts)
  → StreamingToolQueue 排队 (engine/streaming-tool-queue.ts)
  → ToolExecutor.execute() (tool-system/executor.ts)
    → PermissionClassifier 分类 (tool-system/permission.ts)
    → 文件类? → classifyPath allow/ask/deny (tool-system/path-policy.ts)
    → HookRegistry.emit(pre_tool_use) (hooks/registry.ts)
    → validation 入参校验 (tool-system/validation.ts)
    → plan-mode 门控 (tool-system/plan-mode-allowlist.ts)
    → 需审批? → ApprovalBackend.request()
        · 交互:askUser(ToolContext) → 宿主审批 UI
        · 无头/自动:HeadlessApprovalBackend
        · Run 内:RunApprovalBackend 挂起到 resume (run/RunApprovalBackend.ts)
    → 批准 → 执行:
        · Bash → safe-spawn + Sandbox(seatbelt/bwrap/off) (runtime/safe-spawn.ts, tool-system/sandbox/*)
        · 文件 → read/write/edit/apply-patch (tool-system/builtin/*)
        · MCP 工具 → MCPManager 转发 (tool-system/mcp-manager.ts)
        · 子代理 → Agent 工具 → 嵌套 Engine (tool-system/builtin/agent.ts)
    → ToolResult 回 TurnLoop → 下一回合
```

### 链路 ③ TUI 启动与渲染
```
bin code-shell (cli/main.ts)
  → commander preAction → setup() (bootstrap/setup.ts: 日志/Node 校验/git 探测)
  → replCommand (cli/commands/repl.ts)
    → onboarding gate (resolveApiKey)
    → 装配管线:Engine → EngineRuntime → ChatSessionManager → AgentServer
              → createInProcessTransport → AgentClient (protocol/*)
    → bindCronToEngine 绑 cron (automation/*)
    → startInkRepl(options) (ui/index.tsx)
      → ThemeProvider + App (ui/App.tsx)
      → 自研 render:render() (render/root.ts)
        → Ink 实例 (render/ink.tsx) → reconciler (render/reconciler.ts)
        → DOM 树 (render/dom.ts) → Yoga 布局 (render/layout/yoga.ts ← native-ts/yoga-layout)
        → Screen 单元格缓冲 (render/screen.ts) → diff → log-update → ANSI 写终端
      → useInput 订阅键盘 (render/hooks/use-input.ts ← parse-keypress)
  → 用户输入 → AgentClient.run() → 进入链路①
```

### 链路 ④ Desktop 启动与三进程
```
electron . → main 进程 index.ts (main/index.ts)
  → 注册所有 ipcMain handler + 引导各 service
  → AgentBridge 派生 agent worker 子进程 (main/agent-bridge.ts)
      worker = node cli/agent-server-stdio.ts (core/src/cli/agent-server-stdio.ts)
        → 装配 Engine + ChatSessionManager + AgentServer(stdio NDJSON)
  → 创建 BrowserWindow,加载 renderer + preload
  → preload 经 contextBridge 暴露 window.codeshell (preload/index.ts)
  → renderer:main.tsx 挂载 App (renderer/main.tsx, App.tsx)
      → useReducer 管理消息 (renderer/types.ts: applyStreamEvent)
      → 装配 Sidebar/TopBar/ChatView
  ── 运行时数据流 ──
  renderer 发消息 → window.codeshell.run() (preload rpc)
    → ipcMain 'agent:msg' → AgentBridge → worker stdin (JSON-RPC line)
    → worker 内 AgentServer → ChatSession → Engine → 进入链路①
    → worker stdout 快照行 → parseStreamLine → SessionSnapshotStore
    → AgentBridge 广播 streamEvent → ipcRenderer → preload 扇出
    → renderer streamRouting → streamCoalescer → reducer → MessageStream 渲染
```

### 链路 ⑤ 自动化 / 远程(cron 无头运行 + 手机遥控)
```
── A. cron 自动化 ──
startAutomation(deps) (automation/index.ts)
  → CronScheduler 加载任务 + 起定时器 (automation/scheduler.ts)
  → cron 表达式到点 (automation/cron-expr.ts) + 睡眠/唤醒误触防护
  → runner:bindCronToRunManager / bindCronToEngine (automation/runner.ts)
    → write-policy 把权限层→permissionMode+审批后端+sandbox (automation/write-policy.ts)
    → 写类任务:write-run 建隔离 worktree → 跑 Engine → 有改动开 PR → 清理 (automation/write-run.ts)
    → RunManager.submit() → EngineRunner → Engine.run() (run/*) → 进入链路①(无头审批)
  → desktop:automation-host 构建桌面 RunManager+runner (desktop main/automation-host.ts)
    → 完成 run 经 importRuns 归项目入侧边栏 (renderer/automation/importRuns.ts)

── B. 手机/平板遥控 ──
RemoteHostManager 起 http+ws (desktop main/mobile-remote/remote-host-manager.ts)
  → 设备配对 pairing + trusted-device-store + access-passcode(公网隧道)
  → cloudflared tunnel(可选公网) (tunnel-manager.ts)
  → 手机端 React App 连 WS (mobile/hooks/useRemoteSocket.ts)
    → RoomManager / ResidentAgent 常驻 claude 会话 (mobile-remote/room-manager.ts, resident-agent.ts)
    → 事件经 WS → mobile streamReducer 折叠渲染 (mobile/lib/streamReducer.ts)
    → 手机审批 → ApprovalCard → 经 WS 回 → 进入链路② 审批节点
```

---

## 附:跨模块依赖速记

- **谁都依赖 core**:tui、desktop 都只经 `@cjhyy/code-shell-core` 包入口。
- **core 内部依赖方向**(高层→低层):`protocol → engine → {tool-system, llm, context, hooks, prompt, session, settings, services, agent, capability-control}`,底层是 `utils / logging / data / types / exceptions`。
- **run / automation** 建在 engine + tool-system 之上;**arena** 独立建在 llm 之上,经 `tool-system/builtin/arena.ts` 和 `protocol/server.ts` 接入。
- **desktop renderer 经 preload → ipcMain → AgentBridge → worker(core)**,renderer 永不直接 import core 运行时(只 import type)。
- **tui 在同进程内**用 in-process transport 把 UI 接到 core。
