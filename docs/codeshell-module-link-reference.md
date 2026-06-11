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
- **Desktop 交互式聊天不把 core 跑在主进程里**,而是派生一个独立 agent worker 子进程(`agent-bridge.ts` ↔ `cli/agent-server-stdio.ts`),用 stdio NDJSON 通信 —— 隔离崩溃、避免阻塞 UI。例外:当前 Desktop automation 生产路径在 Electron main 中创建 one-shot headless `Engine` 执行。
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
**职责:** 解析 CLI 参数、做 CLI 进程环境初始化、装配 `Engine→AgentServer→AgentClient` 管线,headless 渲染 + 交互 REPL 入口 + 子命令 + 斜杠命令注册表。
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
      → provider client 按能力层/请求形状发起实际 API 调用；Engine 也会用 capabilitiesFor 做图片能力 gate (llm/capabilities/index.ts)
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
  → StreamingToolQueue 排队 (engine/streaming-tool-queue.ts；并发安全工具可立即执行,但当前 TurnLoop 是在完整 response 返回后 enqueue/drain,不是参数流到一半就开跑工具)
  → ToolExecutor.executeSingle() (tool-system/executor.ts)
    → abort / capability override / plan-mode 门控
    → validation 入参校验 (tool-system/validation.ts)
    → HookRegistry.emit(pre_tool_use)；可 deny / ask / rewrite args
    → InvestigationGuard preToolCheck
    → PermissionClassifier 分类 (tool-system/permission.ts)
    → HookRegistry.emit(on_permission_check)，只能降权不能提权
    → 需审批? → ApprovalBackend.request()
        · 交互:askUser(ToolContext) → 宿主审批 UI
        · 无头/自动:HeadlessApprovalBackend
        · Run 内:RunApprovalBackend 挂起到 resume (run/RunApprovalBackend.ts)
    → on_tool_start → registry.executeTool()
        · Bash → safe-spawn + Sandbox(seatbelt/bwrap/off) (runtime/safe-spawn.ts, tool-system/sandbox/*)
        · 文件 → read/write/edit/apply-patch；文件工具内部再走 classifyPath allow/ask/deny (tool-system/path-policy.ts)
        · MCP 工具 → MCPManager 转发 (tool-system/mcp-manager.ts)
        · 子代理 → Agent 工具 → 嵌套 Engine (tool-system/builtin/agent.ts)
    → on_tool_end / post_tool_use / file_changed
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
    → worker stdout JSON-RPC NDJSON line → parseStreamLine 只提取 agent/streamEvent 为 snapshot append → SessionSnapshotStore
    → AgentBridge 广播 streamEvent → ipcRenderer → preload 扇出
    → renderer streamRouting → streamCoalescer → reducer → MessageStream 渲染
```

### 链路 ⑤ 自动化 / 远程(cron 无头运行 + 手机遥控)
```
── A. cron 自动化 ──
startAutomation(deps) (automation/index.ts)
  → CronScheduler 加载任务 + 起定时器 (automation/scheduler.ts)
  → cron 表达式到点 (automation/cron-expr.ts) + 睡眠/唤醒误触防护
  → runner:bindCronToEngine / bindCronToRunManager (automation/runner.ts)
    → write-policy 把权限层→permissionMode+审批后端(+sandboxMode 策略值) (automation/write-policy.ts)
    → 当前 Desktop 生产路径:buildDesktopAutomationRunner → one-shot headless Engine.run() (desktop main/automation-host.ts)
    → RunManager.submit() → EngineRunner → Engine.run() 是存在的 fallback/future 路径,不是当前 Desktop main 绑定
    → write-run 隔离 worktree/PR 路径存在,但当前 Desktop runner 不调用
  → desktop main startAutomation({ store, runner }) 启动执行器
    → live session 经 automationSession 归项目入侧边栏;完成/历史经 importRuns 回填 (renderer/automation/importRuns.ts)

── B. 手机/平板遥控 ──
RemoteHostManager 起 http+ws (desktop main/mobile-remote/remote-host-manager.ts)
  → 设备配对 pairing + trusted-device-store + access-passcode(公网隧道 HTTP/WS gate)
  → cloudflared tunnel(可选公网) (tunnel-manager.ts)
  → 手机端 React App 连 WS (mobile/hooks/useRemoteSocket.ts)
    → B1 普通手机遥控:chat/approval/cancel → handleMobileClientEvent → AgentBridge 注入同一 JSON-RPC line → worker/core → 链路①/②
    → worker stdout raw line → mobile broadcastRaw → streamReducer 折叠渲染 (mobile/lib/streamReducer.ts)
    → B2 Rooms:RoomManager / ResidentAgent 常驻 claude CLI 会话 (mobile-remote/room-manager.ts, resident-agent.ts)
       · 这条不走 CodeShell worker / Engine / 链路②审批,权限由外部 Claude CLI permission-mode 处理
```

---

## 5. 源码引用与核验结论(2026-06-10)

本节是对上面 5 条链路的逐文件核验结果。格式为「文档链路节点 → 真实源码锚点 → 核验结论 / 风险」。

### 5.1 链路① 用户消息 → 回复(turn loop)

| 节点 | 源码引用 | 核验结论 |
|------|----------|----------|
| UI/宿主发起 run | `packages/core/src/protocol/client.ts:106`、`packages/core/src/protocol/client.ts:134` | `AgentClient.run()` 组装 `RunParams` 后发送 `Methods.Run` JSON-RPC 请求。 |
| Server 分派 run | `packages/core/src/protocol/server.ts:203`、`packages/core/src/protocol/server.ts:212`、`packages/core/src/protocol/server.ts:231` | `AgentServer.handleRun()` 在多会话路径中要求 `sessionId`，再通过 `ChatSessionManager.getOrCreate()` 取会话。 |
| AskUser 绑定 | `packages/core/src/protocol/server.ts:247`、`packages/core/src/protocol/server.ts:255` | 多会话路径会给非 headless engine 绑定 `requestAskUserForSession()`，避免 AskUserQuestion 在正常桌面/TUI 会话误走 headless 分支。 |
| FIFO turn 队列 | `packages/core/src/protocol/chat-session.ts:72`、`packages/core/src/protocol/chat-session.ts:137`、`packages/core/src/protocol/chat-session.ts:146` | `enqueueTurn()` 入队，`pump()` 串行消费，一次只让一个 `engine.run()` 活跃。 |
| 取消语义 | `packages/core/src/protocol/chat-session.ts:80`、`packages/core/src/protocol/chat-session.ts:88`、`packages/core/src/protocol/chat-session.ts:161` | `cancel()` 依赖底层 `engine.run()` 尊重 `AbortSignal`；若底层吞掉 abort，调用方会看到成功而非取消。 |
| Engine 组装 | `packages/core/src/engine/engine.ts:878`、`packages/core/src/engine/engine.ts:1418`、`packages/core/src/engine/engine.ts:1441`、`packages/core/src/engine/engine.ts:1455`、`packages/core/src/engine/engine.ts:1466` | `Engine.run()` 创建 LLM client、权限分类器/执行器、上下文管理器、PromptComposer 等运行时对象。 |
| 模型与 TurnLoop | `packages/core/src/engine/engine.ts:1640`、`packages/core/src/engine/engine.ts:1723`、`packages/core/src/engine/engine.ts:1742`、`packages/core/src/engine/engine.ts:1810` | `ModelFacade` 包装 LLM client；goal 模式注册 `GoalStopHook`；最终进入 `TurnLoop.run(messages)`。 |
| TurnLoop 主状态机 | `packages/core/src/engine/turn-loop.ts:365`、`packages/core/src/engine/turn-loop.ts:458`、`packages/core/src/engine/turn-loop.ts:500`、`packages/core/src/engine/turn-loop.ts:685` | 真实顺序是先 `contextManager.manageAsync()`，再模型调用；无工具时走 `on_stop` hook，goal 可阻止终止并继续。 |
| Transcript 与工具消息 | `packages/core/src/engine/turn-loop.ts:775`、`packages/core/src/engine/turn-loop.ts:785`、`packages/core/src/engine/turn-loop.ts:801`、`packages/core/src/engine/turn-loop.ts:808` | 工具 use/result 在 TurnLoop 内追加到 transcript 并通过 `onStream` 发给宿主。 |

**链路①风险/注意点:**
- `ChatSession.cancel()` 的正确性明确依赖 `Engine.run()` 全链路传递 `AbortSignal`，源码注释也承认该假设；后续排查取消/停止按钮异常时应从 `chat-session.ts:80-98` 与 `turn-loop.ts:392-500` 一起看。
- 文档原先把 `Transcript` 落盘写在链路末尾略简化；实际工具 use/result 会在 TurnLoop 中分阶段写入 transcript，session state/JSONL 也由 Engine/Session 子系统共同维护。

### 5.2 链路② 工具调用 / 审批 / 沙箱

| 节点 | 源码引用 | 核验结论 |
|------|----------|----------|
| tool_use 进入执行阶段 | `packages/core/src/engine/turn-loop.ts:765`、`packages/core/src/engine/turn-loop.ts:775`、`packages/core/src/engine/turn-loop.ts:794` | TurnLoop 把模型返回的 tool calls 转成 assistant `tool_use` blocks，再由 `StreamingToolQueue.drain()` 汇总结果。 |
| ToolExecutor 前置门控 | `packages/core/src/tool-system/executor.ts:104`、`packages/core/src/tool-system/executor.ts:116`、`packages/core/src/tool-system/executor.ts:130`、`packages/core/src/tool-system/executor.ts:139` | 真正入口是 `executeSingle()`；先处理 abort、disabled builtin、plan-mode。 |
| 参数校验与 pre_tool_use | `packages/core/src/tool-system/executor.ts:156`、`packages/core/src/tool-system/executor.ts:170`、`packages/core/src/tool-system/executor.ts:188` | schema 校验发生在权限分类前；`pre_tool_use` 可 deny/ask/rewrite args，rewrite 后会重新校验。 |
| 权限分类与降权 hook | `packages/core/src/tool-system/executor.ts:257`、`packages/core/src/tool-system/executor.ts:260`、`packages/core/src/tool-system/executor.ts:272`、`packages/core/src/tool-system/executor.ts:279` | `PermissionClassifier.classify()` 后触发 `on_permission_check`；hook 不能把 ask/deny 提权到 allow，只能降权或 ask。 |
| 审批后端 | `packages/core/src/tool-system/executor.ts:308`、`packages/core/src/tool-system/permission.ts:846`、`packages/core/src/tool-system/permission.ts:890` | ask 决策走 `PermissionClassifier.handleAsk()`，再调用注入的 `ApprovalBackend.requestApproval()`。 |
| bypass 模式 | `packages/core/src/tool-system/permission.ts:806`、`packages/core/src/tool-system/permission.ts:859` | `bypassPermissions` 在 classify 和 handleAsk 两处都会自动放行；如果 hook 把 allow 降成 ask，handleAsk 仍会自动 allow。 |
| acceptEdits allowlist | `packages/core/src/tool-system/permission.ts:764`、`packages/core/src/tool-system/permission.ts:835` | acceptEdits 只自动允许 `Write/Edit/ApplyPatch/NotebookEdit/TodoWrite`，不是全工具放行。 |
| 实际执行和后置 hook | `packages/core/src/tool-system/executor.ts:322`、`packages/core/src/tool-system/executor.ts:345`、`packages/core/src/tool-system/executor.ts:384`、`packages/core/src/tool-system/executor.ts:393`、`packages/core/src/tool-system/executor.ts:417` | 通过 registry 调用工具实现；执行后触发 `on_tool_end`、`post_tool_use`，文件变更再发 `file_changed`。 |
| 文件路径策略 | `packages/core/src/tool-system/path-policy.ts:1`、`packages/core/src/tool-system/path-policy.ts:12`、`packages/core/src/tool-system/path-policy.ts:27`、`packages/core/src/tool-system/path-policy.ts:76` | `classifyPath()` 是文件工具内部的共享安全层；敏感写 deny、外部路径 ask、workspace 非敏感 allow。 |

**链路②已修正文档点:** 原文把 `PermissionClassifier → path-policy → pre_tool_use → validation` 写成主顺序；源码真实顺序是 `plan/capability gate → validation → pre_tool_use → guard → PermissionClassifier → on_permission_check → approval → execute`。文件路径策略不在通用 executor 顶层统一调用，而由文件类工具内部调用。

**链路②风险/注意点:**
- `bypassPermissions` 语义强于 hook 降权到 ask：`classify()` 直接 allow，且 `handleAsk()` 在 bypass 下也 auto allow。若期望安全 hook 能在 bypass 模式强制二次确认，需要改 `permission.ts:859-866` 或 executor 对 hook ask 的处理策略。
- `path-policy.ts:103-109` 仍有 `CODESHELL_PATH_POLICY=off` 逃生开关；这是可逆 rollout 设计，但安全审计时应确认生产/用户环境没有误设置。

### 5.3 链路③ TUI 启动与渲染

| 节点 | 源码引用 | 核验结论 |
|------|----------|----------|
| CLI 入口 | `packages/tui/src/cli/main.ts:40`、`packages/tui/src/cli/main.ts:97`、`packages/tui/src/cli/main.ts:194` | commander 同时支持 `repl` 子命令和无 task 默认进 REPL；有 task 则走 headless `runCommand()`。 |
| REPL 装配 core 管线 | `packages/tui/src/cli/commands/repl.ts:62`、`packages/tui/src/cli/commands/repl.ts:198`、`packages/tui/src/cli/commands/repl.ts:222`、`packages/tui/src/cli/commands/repl.ts:226`、`packages/tui/src/cli/commands/repl.ts:229` | TUI 用 `ChatSessionManager + AgentServer + createInProcessTransport + AgentClient`，不是直接从 UI 调 Engine。 |
| TUI cron 绑定 | `packages/tui/src/cli/commands/repl.ts:237`、`packages/tui/src/cli/commands/repl.ts:239`、`packages/tui/src/cli/commands/repl.ts:251` | REPL 启动时给 cron singleton 装 store 并绑定 `bindCronToEngine()`，触发时新建 headless Engine 跑任务。 |
| UI 启动 | `packages/tui/src/cli/commands/repl.ts:258`、`packages/tui/src/ui/index.tsx:32`、`packages/tui/src/ui/index.tsx:57` | 固定/恢复 sessionId 后调用 `startInkRepl()`，再 render `<ThemeProvider><App />`。 |
| 自研 render root | `packages/tui/src/render/root.ts:76`、`packages/tui/src/render/root.ts:90`、`packages/tui/src/render/root.ts:107` | `render()` 保留一个 microtask 边界后创建/复用 Ink 实例。 |
| Ink 渲染核心 | `packages/tui/src/render/ink.tsx:122`、`packages/tui/src/render/ink.tsx:131`、`packages/tui/src/render/ink.tsx:28`、`packages/tui/src/render/ink.tsx:32` | Ink 类持有 React reconciler root、DOM root、renderer、screen/cell pools，负责提交后布局/渲染/终端 diff。 |

**链路③风险/注意点:**
- `commander preAction → setup()` 已确认存在：`program.hook("preAction")` 调用 `setup()`，见 `packages/tui/src/cli/main.ts:231`。
- `setup.ts` 实际做的是 CLI 进程环境初始化(日志、Node/cwd、安全、chdir、git 探测)，不是创建会话；文档中“会话启动初始化”应按这个理解。
- TUI bootstrap 当前检查 Node `>=18`，但项目约束是 Node `>=20.10`，存在版本门槛不一致风险。
- `repl.ts:231-253` 的 cron 是 TUI 进程内 singleton；Desktop worker 则禁用执行，只持久化 cron，两个宿主行为不同，文档中应区分。
- TUI 还有 headless `run` 分支：`cli/main.ts` 有 task 时走 `runCommand()`，同样装配 `ChatSessionManager → AgentServer → AgentClient`，但使用 headless renderer 而非 `startInkRepl()`。

### 5.4 链路④ Desktop 启动与三进程

| 节点 | 源码引用 | 核验结论 |
|------|----------|----------|
| main 入口与 bridge | `packages/desktop/src/main/index.ts:1`、`packages/desktop/src/main/index.ts:156`、`packages/desktop/src/main/index.ts:759` | Electron main 是 renderer 与 agent worker 的 broker；全局 `AgentBridge` 绑定 BrowserWindow。 |
| worker 派生 | `packages/desktop/src/main/agent-bridge.ts:43`、`packages/desktop/src/main/agent-bridge.ts:106`、`packages/desktop/src/main/agent-bridge.ts:114` | AgentBridge 用 `process.execPath + @cjhyy/code-shell-core/bin/agent-server-stdio` 派生 worker，并设置 `ELECTRON_RUN_AS_NODE=1`。 |
| renderer→worker | `packages/desktop/src/main/agent-bridge.ts:201`、`packages/desktop/src/main/agent-bridge.ts:208`、`packages/desktop/src/main/agent-bridge.ts:239` | main 监听 `agent:msg`；只有 `agent/run` 会触发 spawn；随后原样写入 worker stdin。 |
| worker→renderer | `packages/desktop/src/main/agent-bridge.ts:124`、`packages/desktop/src/main/agent-bridge.ts:135`、`packages/desktop/src/main/agent-bridge.ts:138`、`packages/desktop/src/main/agent-bridge.ts:139` | worker stdout 按行解析，streamEvent 写入 `SessionSnapshotStore`，再发给 renderer，并镜像给 mobile taps。 |
| worker 内 core server | `packages/core/src/cli/agent-server-stdio.ts:91`、`packages/core/src/cli/agent-server-stdio.ts:158`、`packages/core/src/cli/agent-server-stdio.ts:232`、`packages/core/src/cli/agent-server-stdio.ts:234` | stdio worker 创建 seed Engine、EngineRuntime、ChatSessionManager，最后用 `StdioTransport` 暴露 `AgentServer`。 |
| worker cron 只持久化 | `packages/core/src/cli/agent-server-stdio.ts:215`、`packages/core/src/cli/agent-server-stdio.ts:226`、`packages/core/src/cli/agent-server-stdio.ts:227` | worker 给 cronScheduler 设置 store，但 `setExecutionEnabled(false)`，避免与 main 进程重复执行自动化。 |
| preload 透明桥 | `packages/desktop/src/preload/index.ts:1`、`packages/desktop/src/preload/index.ts:50`、`packages/desktop/src/preload/index.ts:149`、`packages/desktop/src/preload/index.ts:185`、`packages/desktop/src/preload/index.ts:189` | preload 负责 JSON-RPC line over IPC、监听 stream/approval/status、暴露 `window.codeshell.run()` 等 API。 |
| renderer reducer | `packages/desktop/src/renderer/App.tsx:47`、`packages/desktop/src/renderer/App.tsx:100`、`packages/desktop/src/renderer/App.tsx:150`、`packages/desktop/src/renderer/App.tsx:176` | renderer 用 `resolveBucket` 路由事件，用 `createEventCoalescer` 合批，reducer 调 `applyStreamEvent()` 更新消息流。 |

**链路④风险/注意点:**
- `AgentBridge` 注释说 worker “after each run completes” clean exit，但实现是 `spawnChild()` 只在 `agent/run` 时启动，未读到主动在 run 完成后 kill worker 的逻辑；实际可能是 worker 长驻直到进程退出/崩溃。文档应避免写“每轮退出”。
- `agent-bridge.ts:216-236` 对没有 live worker 的非 run 请求会 drop；只特殊处理 `agent/backgroundShells` 返回空列表。审批/取消在 worker 已退出时会丢弃，这是合理降级但属于排障点。

### 5.5 链路⑤ 自动化 / 手机遥控

#### A. cron 自动化

| 节点 | 源码引用 | 核验结论 |
|------|----------|----------|
| startAutomation | `packages/core/src/automation/index.ts:43`、`packages/core/src/automation/index.ts:45`、`packages/core/src/automation/index.ts:52` | host 注入 store 与 runner/runManager，`startAutomation()` 创建 `CronScheduler` 并 load jobs。 |
| scheduler 状态 | `packages/core/src/automation/scheduler.ts:70`、`packages/core/src/automation/scheduler.ts:73`、`packages/core/src/automation/scheduler.ts:84`、`packages/core/src/automation/scheduler.ts:163` | scheduler 管 jobs/timers/running/runningControllers；`loadJobs()` 以磁盘为 source of truth 重建内存和 timer。 |
| 禁止重复执行 | `packages/core/src/automation/scheduler.ts:73`、`packages/core/src/automation/scheduler.ts:126` | `running` 和 `runningControllers` 防同 job 重入，并支持 abort 等待执行完全 settle。 |
| bindCronToEngine | `packages/core/src/automation/runner.ts:56`、`packages/core/src/automation/runner.ts:58`、`packages/core/src/automation/runner.ts:66` | 每次触发先 `resolveWritePolicy()`，再把 prompt/permissionMode/approvalBackend/signal 交给 host runner。 |
| bindCronToRunManager | `packages/core/src/automation/runner.ts:94`、`packages/core/src/automation/runner.ts:99`、`packages/core/src/automation/runner.ts:105` | RunManager 路径提交 run 并把 `lastRunId` 写回 job。 |
| Desktop main 绑定 | `packages/desktop/src/main/index.ts:843`、`packages/desktop/src/main/index.ts:850`、`packages/desktop/src/main/index.ts:853` | 当前 Desktop main 传入的是 `runner: buildDesktopAutomationRunner(...)`，不是 `runManager`。 |
| Desktop runner | `packages/desktop/src/main/automation-host.ts:1`、`packages/desktop/src/main/automation-host.ts:88`、`packages/desktop/src/main/automation-host.ts:105`、`packages/desktop/src/main/automation-host.ts:129`、`packages/desktop/src/main/automation-host.ts:168` | Desktop 当前生产路径是一轮一个 headless Engine；RunManager 路径在文件注释中标为 fallback/future。 |
| live session 归属 | `packages/desktop/src/main/automation-host.ts:145`、`packages/desktop/src/main/automation-host.ts:153`、`packages/desktop/src/main/automation-host.ts:161`、`packages/desktop/src/main/automation-host.ts:164` | runner 在 `session_started` 时拿真实 sessionId，通过 `onSession` 告诉 renderer 归属 cwd/title，并用真实 sid 转发后续 stream。 |
| RunManager fallback | `packages/core/src/automation/runner.ts:94`、`packages/core/src/automation/runner.ts:99`、`packages/core/src/run/RunManager.ts:115`、`packages/core/src/run/EngineRunner.ts:182` | RunManager/EngineRunner 路径存在，但不是当前 Desktop main 的生产绑定。 |

**cron 风险/注意点:**
- `automation-host.ts:170-188` 明确只有 engine.run 抛错且已宣布 session 时才合成 terminal error；若错误发生在 `session_started` 前，UI 可能没有 live spinner，但也不会有可归属会话。
- 自动化 prompt 通过 `AUTOMATION_PROMPT_NOTE` 防 nested automation，同时 `disabledBuiltinTools` 禁掉 cron 工具；这是符合当前记忆里“自动化里不要再创建自动化”的约束。

#### B. 手机/平板遥控

| 节点 | 源码引用 | 核验结论 |
|------|----------|----------|
| RemoteHostManager 构造 | `packages/desktop/src/main/index.ts:160`、`packages/desktop/src/main/index.ts:168`、`packages/desktop/src/main/mobile-remote/remote-host-manager.ts:76` | mobile remote 默认不启动，由 Settings IPC 启动；server 管 HTTP static + WS。 |
| LAN/tunnel 绑定 | `packages/desktop/src/main/mobile-remote/remote-host-manager.ts:21`、`packages/desktop/src/main/mobile-remote/remote-host-manager.ts:129`、`packages/desktop/src/main/mobile-remote/remote-host-manager.ts:227`、`packages/desktop/src/main/index.ts:1187` | LAN 绑定具体 LAN IP，不用 `0.0.0.0`；tunnel 模式绑定 `127.0.0.1` 后由 cloudflared 暴露。 |
| 配对/鉴权 | `packages/desktop/src/main/mobile-remote/remote-host-manager.ts:183`、`packages/desktop/src/main/mobile-remote/remote-host-manager.ts:195`、`packages/desktop/src/main/mobile-remote/remote-host-manager.ts:209` | WS 收到消息先处理 auth/pair；未鉴权的非 auth 事件直接 `auth.failed`。 |
| 手机端 socket | `packages/desktop/src/mobile/hooks/useRemoteSocket.ts:100`、`packages/desktop/src/mobile/hooks/useRemoteSocket.ts:118`、`packages/desktop/src/mobile/hooks/useRemoteSocket.ts:125`、`packages/desktop/src/mobile/hooks/useRemoteSocket.ts:173` | mobile app 连接 `/ws`，用 pairing token 或 stored device id 鉴权；raw JSON-RPC line 交给聊天 reducer。 |
| mobile → 主 worker 路由 | `packages/desktop/src/main/index.ts:323`、`packages/desktop/src/main/index.ts:329`、`packages/desktop/src/main/index.ts:379`、`packages/desktop/src/main/index.ts:402` | 已认证 mobile 事件被转成与 preload 相同的 JSON-RPC：chat/approval/cancel 复用同一 AgentBridge/permission path。 |
| worker → mobile 镜像 | `packages/desktop/src/main/index.ts:759`、`packages/desktop/src/main/index.ts:761`、`packages/desktop/src/main/index.ts:763`、`packages/desktop/src/main/agent-bridge.ts:139` | main 在 AgentBridge outbound tap 中把 worker stdout raw line broadcast 给手机。 |
| mobile stream reducer | `packages/desktop/src/mobile/lib/streamReducer.ts:96`、`packages/desktop/src/mobile/lib/streamReducer.ts:118`、`packages/desktop/src/mobile/lib/streamReducer.ts:134`、`packages/desktop/src/mobile/lib/streamReducer.ts:219` | 手机端 reducer 同时支持 JSON-RPC `agent/streamEvent` envelope 和 bare event，用 agentId 隔离主 agent/subagent。 |
| 房间 / resident agent | `packages/desktop/src/main/index.ts:207`、`packages/desktop/src/main/mobile-remote/room-manager.ts:176`、`packages/desktop/src/main/mobile-remote/room-manager.ts:212`、`packages/desktop/src/main/mobile-remote/resident-agent.ts:106`、`packages/desktop/src/main/mobile-remote/resident-agent.ts:157` | room 是独立的 Claude Code resident process，不走 CodeShell worker；RoomManager 持久化 messages.jsonl 并把用户输入写入 resident stdin。 |

**mobile 风险/注意点:**
- 文档原先把“手机审批 → ApprovalCard → 经 WS 回 → 进入链路②”写得偏 UI 化；源码真实关键是 `handleMobileClientEvent()` 把 `approval.respond` 转成 `agent/approve` JSON-RPC line，之后才进入 core 审批恢复链路。
- room/resident-agent 是另一条外部代理链路，不等同于 CodeShell Engine/TurnLoop；文档需要明确“房间”不走链路①/②，而是 `claude --print --input-format stream-json --output-format stream-json`。

### 5.6 本轮确认出的文档修正点 / 潜在 bug 清单

1. **已修正:** 链路②工具执行顺序。真实顺序不是“权限分类 → path-policy → pre_tool_use → validation”，而是 `validation/pre_tool_use` 早于 `PermissionClassifier`，`path-policy` 是文件工具内部安全层。
2. **已确认:** TUI 链路里的 `setup()` 确实由 commander `preAction` 调用，见 `packages/tui/src/cli/main.ts:231`。
3. **风险:** `bypassPermissions` 会让 hook 降权到 ask 后仍由 `handleAsk()` 自动批准；如果产品语义希望 hook 可强制拦截 bypass，需要改权限策略。
4. **风险:** `AgentBridge` 在无 live worker 时会 drop approve/cancel 等非 run 请求；大多数情况下合理，但排查“手机/桌面点了审批无效”时要看 worker 是否已退出。
5. **文档澄清:** Desktop agent worker 不是 renderer 或 main 直接跑 core；真正 core server 在 `agent-server-stdio.ts` 子进程中。
6. **文档澄清:** Desktop worker 的 cron scheduler 只持久化、不执行；真正执行在 Electron main 的 automation host。
7. **文档澄清:** Mobile room/resident-agent 是外部 Claude Code CLI 长驻链路，不是 CodeShell Engine TurnLoop 链路。
8. **风险:** Desktop automation 当前生产路径不是 RunManager/write-run/worktree/PR；如果读者按旧文档理解，会误以为 cron 都有 RunStore/checkpoint/resume/worktree PR 保障。
9. **风险:** `resolveWritePolicy()` 产出 `sandboxMode` 策略值，但当前 `CronRunRequest`/Desktop runner 只传 `permissionMode` 与 `approvalBackend`；若 sandbox 需要显式传入 Engine，这会造成安全预期落差。
10. **风险:** TUI bootstrap 的 Node 版本检查是 `>=18`，而项目约束是 Node `>=20.10`；低版本 Node 可能通过启动校验后在运行期出隐蔽错误。
11. **风险:** TUI REPL 的 cron runner 未把 `req.signal` 传给 `cronEngine.run()`，`CronScheduler.abort(jobId)` 可能无法取消正在执行的 REPL cron run。
12. **风险:** `startInkRepl()` 内部直接 `process.exit(0)`，使 `replCommand()` 后续 `chatManager.closeAll()` 清理路径理论上不可达；若依赖该清理释放后台资源，需要单独验证。
13. **风险:** Mobile room 操作多处 `broadcast` 给所有已认证设备；多设备场景下可能有房间历史/操作串扰或隐私风险。
14. **风险:** `RoomManager.nextSeq()` 每次 append 读取整个 `messages.jsonl`，长期 resident room 可能出现 O(n) 追加性能退化。
15. **风险:** `RunApprovalBackend` 未接 hooks 时当前默认批准，属于 fail-open 风险；若 wiring 漏接，run 生命周期审批可能被绕过。

---

## 附:跨模块依赖速记

- **谁都依赖 core**:tui、desktop 都只经 `@cjhyy/code-shell-core` 包入口。
- **core 内部依赖方向**(高层→低层):`protocol → engine → {tool-system, llm, context, hooks, prompt, session, settings, services, agent, capability-control}`,底层是 `utils / logging / data / types / exceptions`。
- **run / automation** 建在 engine + tool-system 之上;**arena** 独立建在 llm 之上,经 `tool-system/builtin/arena.ts` 和 `protocol/server.ts` 接入。
- **desktop renderer 经 preload → ipcMain → AgentBridge → worker(core)**,renderer 永不直接 import core 运行时(只 import type)。
- **tui 在同进程内**用 in-process transport 把 UI 接到 core。
