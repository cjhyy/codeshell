# 00 · 《深入浅出解析 CodeShell Core》系列写作规划

> 本文件是**写作规划**，不是正式文章。它定义系列文章的目录、每篇的源码入口与配图清单，
> 以及一组必须遵守的写作准确性约束。正式撰写时请逐篇对照本规划，并以
> `docs/architecture/*.md`（源码精确版，commit `060c22e0`）为事实底稿。
>
> 配图素材由 Codex 在后台生成于 `docs/core-deep-dive/assets/`。**写作时若图尚未就位，先写正文、
> 用占位引用并在文末「待补图」处登记，不要凭空描述图里有什么**，避免缺图引用错位。

## 0. 目标与读者

- **读者**：其他程序员（看得懂代码，但不熟悉本仓库）。希望快速建立「CodeShell Core 是怎么搭起来的」的心智模型。
- **风格**：深入浅出，中文。先讲「要解决什么问题」，再讲「为什么这么设计」，最后讲「这样带来什么好处 / 代价」。
- **底稿来源**：本系列是 `docs/architecture/` 十章的「科普重写版」。架构文档偏精确索引（`file:line`），
  本系列偏可读性与设计动机。**事实以架构文档与源码为准，本系列不得引入架构文档中没有的断言。**
- **核心立场（贯穿全系列）**：**Core 是一个通用的 Agent 编排内核，不是一个写死的 coding agent。**
  「会写代码」只是一个挂在通用引擎之上的 *preset*（`CONTRIBUTING.md`：core only carries mechanism, not policy）。
  全系列任何一处都不得把「编程能力」当成 core 的内建本质来叙述。

## 1. 系列文章目录（每个 core 主要模块一篇）

按「先全局、再主线、后旁支、最后宿主」编排。共 **12 篇**（含 1 篇总览 + 1 篇收尾地图）。
每篇对应一个 core 主要模块，与 `docs/architecture/` 章节大致 1:1，但叙述独立成篇。

| 篇号 | 文件名 | 对应架构章 | 对应 core 模块 |
|------|--------|-----------|----------------|
| 01 | `01-core-overview.md` | 00 | 全局 / `index.ts` |
| 02 | `02-engine-turn-loop.md` | 01 | `engine/`, `context/` |
| 03 | `03-tool-system.md` | 02 | `tool-system/` |
| 04 | `04-llm-model-layer.md` | 03 | `llm/`, `model-catalog/` |
| 05 | `05-protocol-and-sessions.md` | 04 | `protocol/`, `session/`, `state.ts` |
| 06 | `06-presets-prompt-hooks-skills.md` | 05 | `preset/`, `prompt/`, `hooks/`, `skills/` |
| 07 | `07-run-automation-goal.md` | 06 | `run/`, `automation/`, `cron/`, `engine/goal.ts` |
| 08 | `08-plugins-capabilities-credentials-memory.md` | 07 | `plugins/`, `capability-control/`, `credentials/`, `session/memory.ts`, `services/dream-*` |
| 09 | `09-arena-and-integrations.md` | 08 | `arena/`, `cc-orchestrator/`, `stt/`, `review/`, `external-agents/` |
| 10 | `10-tui-host.md` | 09 | `packages/tui/`（宿主，非 core，但说明 core 如何被消费） |
| 11 | `11-desktop-mobile-host.md` | 10 | `packages/desktop/`, `packages/cdp/`（宿主） |
| 12 | `12-module-map-and-recap.md` | —（新增收尾） | 全局回顾 + 模块地图 + 跨切面（settings/onboarding/runtime/磁盘布局） |

> 命名约定：两位数字前缀 + kebab-case，与架构文档同构但前缀错位（架构 00 对应本系列 01），
> 因为本系列把「总览」独立成第 1 篇、把「模块地图回顾」独立成最后一篇。

---

## 2. 分篇详表

每篇含：拟标题 / 源码入口 / 要解释的核心问题 / 为什么这样设计 / 带来的好处 / 配图。

### 01 · `01-core-overview.md`
- **拟标题**：《一套引擎三张脸：CodeShell Core 全景导览》
- **源码入口**：`packages/core/src/index.ts`（公共 API 面）；`CODESHELL.md`（构建/测试）；`packages/core/CONTRIBUTING.md`（边界契约）。
- **核心问题**：CodeShell 到底是什么？为什么 CLI、桌面 App、SDK 共用一个 core？四个包（core/tui/desktop/cdp）如何分工？
- **为什么这样设计**：core 保持 domain-agnostic，把「会写代码」做成 preset 而非 fork；宿主只负责 IO 与 UI。
- **带来的好处**：一处实现，三处复用；新增宿主无需改 core；行为靠配置切换而非分叉。
- **建议配图（2 张）**：
  - `core-big-picture.svg`（必备，开篇）——一套引擎 + CLI/桌面/SDK 三张脸 + 持久层。
  - `module-map.svg`（导览用，可在「本系列怎么读」处再引一次，详细版放第 12 篇）。

### 02 · `02-engine-turn-loop.md`
- **拟标题**：《Agent 的心跳：Engine 与 Turn Loop 是怎么转一圈的》
- **源码入口**：`engine/engine.ts`（`Engine.run` @ ~`:981`）、`engine/turn-loop.ts`（`TurnLoop.run` @ ~`:393`）、`context/manager.ts`、`context/compaction.ts`、`engine/goal.ts`、`engine/steer-queue.ts`。
- **核心问题**：一次 `run` 从输入到出结果经历哪五个阶段？turn loop 每一圈做什么？上下文快满了怎么压缩？引导（steering）怎么不打断当前轮？
- **为什么这样设计**：把「跑一个 agent」与「写代码」解耦；压缩分级（无损→有损）按需付费；步间插入用户消息避免中断流。
- **带来的好处**：可移植的循环；token 成本可控且估算逐轮收敛；不变量（tool_use↔tool_result 配对、abort 终态、goal 预算硬上限、图片策略 fail-closed）让系统可恢复。
- **建议配图（2 张）**：
  - `engine-turn-loop.svg`（必备）——一圈循环：pre-check → model call → post-model → tool 决策 → final/工具执行。
  - `context-compaction.svg`（必备）——Tier 0/1/2/3 分级压缩 + reactive probe + 冻结决策。
- **⚠️ 准确性注意**：见 §3 第 (1) 条——**不要把「所有 `Engine.run` 都经 protocol」写成绝对事实**（sub-agent 例外）。turn loop 本身不等于 protocol。

### 03 · `03-tool-system.md`
- **拟标题**：《一个收口、绝不抛错：工具系统的安全管线》
- **源码入口**：`tool-system/executor.ts`（`executeSingle` @ ~`:116`）、`registry.ts`、`permission.ts`、`path-policy.ts`、`mcp-manager.ts`、`sandbox/index.ts`、`builtin/index.ts`。
- **核心问题**：模型一个 `tool_use` 怎么变成被守卫的真实动作？权限、路径策略、plan-mode、沙箱、hooks、MCP 如何串在一条管线上？
- **为什么这样设计**：executor 作为唯一收口（single choke point），所有工具（含 MCP）同一套门；hooks 只能收紧不能放松（A1 硬化）；权限按「操作」而非「工具名」缓存；链式命令守卫防 `git status && rm -rf /` 搭便车。
- **带来的好处**：安全检查无旁路；executor 永不抛错（坏工具名不杀 turn）；MCP 工具继承同等门禁；路径策略 realpath 双侧防 symlink 逃逸。
- **建议配图（1 张）**：
  - `tool-executor-pipeline.svg`（必备）——abort 快路 → 能力门 → plan-mode → 校验 → pre_tool_use → path-policy → 权限分类 → 执行 → post hooks。
- **⚠️ 注意**：强调「新增内置工具要改两处（`BUILTIN_TOOLS` 表 + preset 白名单 `GENERAL_BUILTIN_TOOLS`），漏一处工具静默不可见」——这是反复复发的坑，但归属 preset 篇详述，这里点到为止并交叉引用第 06 篇。

### 04 · `04-llm-model-layer.md`
- **拟标题**：《把厂商差异写成数据：LLM 与模型层》
- **源码入口**：`llm/client-base.ts`、`llm/client-factory.ts`、`llm/providers/{anthropic,openai}.ts`、`llm/capabilities/rules.ts`、`llm/model-pool.ts`、`model-catalog/`、`engine/resolve-llm-config.ts`。
- **核心问题**：一个模型「tag」怎么解析成配置好的 provider 客户端？每个厂商/模型的怪癖（max_tokens 字段名、拒收参数、reasoning 形态）怎么治？
- **为什么这样设计**：模型身份（`LLMConfig`）与运行旋钮（`ClientDefaults`）分离，热切换不串台；厂商差异写进 `capabilities/RULES` 数据表，客户端里**没有** per-model 的 `switch`；`ParamSpec` 一处声明同时驱动 UI 控件与 wire 映射。
- **带来的好处**：加一个新模型多半只改数据；reasoning 控件与请求体单一来源；catalog 是单一事实源（legacy 存储已删）。
- **建议配图（1 张）**：
  - `llm-model-layer.svg`（必备）——tag → connections+credentials+catalog → ModelEntry → ModelPool → LLMConfig → client；旁挂 capabilities RULES 影响 wire。

### 05 · `05-protocol-and-sessions.md`
- **拟标题**：《引擎不直接面对 UI：协议接缝与可恢复的会话》
- **源码入口**：`protocol/{server,client,transport,tcp-transport,factories,types}.ts`、`protocol/chat-session*.ts`、`session/{session-manager,transcript,file-history,undo-target}.ts`、`state.ts`。
- **核心问题**：为什么要在引擎和 UI 之间放一层 JSON-RPC？三种 transport（in-process/stdio/tcp）有什么区别？会话怎么落盘、怎么从磁盘恢复、怎么按轮 undo？
- **为什么这样设计**：所有 `engine.run`（CLI/桌面 worker/in-process REPL）走 `AgentServer`+`AgentClient`，**让权限白名单与生命周期收口在一处**；transcript 是事实源（非聊天历史）；磁盘是权威恢复源。
- **带来的好处**：换 transport 不动业务；后台完成唤醒空闲引擎（非轮询）；清 localStorage 不丢数据；按轮 undo 对齐 CC。
- **建议配图（1 张）**：
  - `protocol-sessions.svg`（必备）——AgentClient ⇄ Transport ⇄ AgentServer ⇄ ChatSessionManager ⇄ Engine；旁挂磁盘会话目录结构。
- **⚠️ 准确性注意**：见 §3 第 (1) 条——这里是**最容易写绝对化**的一篇。务必写成「几乎所有 run 经协议接缝，**asyncAgentRegistry 里的 sub-agent 例外**：它们各自起带独立白名单的 Engine」。

### 06 · `06-presets-prompt-hooks-skills.md`
- **拟标题**：《行为即配置：preset、prompt 拼装、hooks 与 skills》
- **源码入口**：`preset/index.ts`、`prompt/{composer,section-cache,section-loader,instruction-scanner}.ts`、`hooks/{registry,events,inject,shell-runner}.ts`、`skills/scanner.ts`。
- **核心问题**：core 怎么保持「通用」？「会写代码」到底配在哪？system prompt 怎么围绕 cache 断点拼？16 个 hook 事件如何聚合（严格者胜）？skill 怎么被发现与隔离？
- **为什么这样设计**：preset 选「prompt 段 + 工具白名单 + 权限默认」四件套；工具白名单是「会编程」与「不会」的开关；prompt 分缓存前缀 + 动态上下文（跨断点）以省 token；hooks 是唯一跨层数组拼接（特例，勿推广）。
- **带来的好处**：换 agent 行为不 fork core；tool-gated section 让模型不读用不上的指令；shell hook 是受信任代码（配了即信任）但 fail-silent 不崩 turn。
- **建议配图（1 张）**：
  - `prompt-presets-hooks-skills.svg`（必备）——preset → 工具白名单 + prompt 段；prompt 拼装（缓存前缀 | 动态上下文）；hook 链严格者胜。
- **⚠️ 注意**：这是「**core 是通用编排核心而非 coding agent**」立场最该正面阐述的一篇——明确写出 `general` 与 `terminal-coding` 两个 preset 的差别就是配置差别。

### 07 · `07-run-automation-goal.md`
- **拟标题**：《跑完一轮就走，回来还能续：长任务编排（Run / Cron / 持久 Goal）》
- **源码入口**：`run/RunManager.ts`、`run/{RunLock,Heartbeat,FileRunStore,EngineRunner,RunApprovalBackend}.ts`、`automation/{scheduler,cron-expr,store,runner,write-policy,write-run}.ts`、`engine/goal.ts`。
- **核心问题**：怎么「点一下、走开、回来拿可恢复的结果」？RunManager 的状态机、跨进程锁、心跳恢复怎么工作？cron 的 read-only 契约是什么？持久 goal 怎么存、怎么续、靠什么收口？
- **为什么这样设计**：run 把状态机+队列+崩溃恢复+检查点+跨进程锁包在 Engine 外；cron 的权限靠「后端」而非分类器规则（`permissionMode` 恒为 default）；goal 走「stop-hook 裁判 + complete_goal 主动声明」双机制，token/时间预算是硬底线。
- **带来的好处**：unattended 执行可恢复（dead+stale 重排、alive+recent 跳过）；写型 cron 在独立 worktree 跑并开 PR，不碰用户工作区；goal 后台任务停泊而非自旋。
- **建议配图（1 张）**：
  - `run-automation-goal.svg`（必备）——RunManager 状态机（queued→running→{waiting/blocked/terminal}）+ cron 调度 + goal 双机制（裁判/主动）。
- **⚠️ 准确性注意**：见 §3 第 (2) 条——**这一篇可以说 run/cron/持久 goal 跨进程重启可恢复，但不得把这个性质推广到「所有后台任务」**。后台 shell 与同步 sub-agent 不是这样（详见第 05/09 篇交叉引用）。

### 08 · `08-plugins-capabilities-credentials-memory.md`
- **拟标题**：《运行时长能力：插件、能力总览、凭证与记忆/Dream》
- **源码入口**：`plugins/{pluginInstaller,loadPluginHooks,gitOps,marketplaceManager}.ts`、`capability-control/{service,project,overlay,disabled-lists}.ts`、`credentials/{store,use-credential-tool,use-gate}.ts`、`session/memory.ts`、`services/dream-consolidation.ts`。
- **核心问题**：怎么在运行时装 CC/Codex 格式插件并加载其 hooks/MCP/agents/skills？能力总览（tri-state 覆盖）怎么投射？凭证三档门怎么把关？记忆与 Dream 怎么跨会话工作？
- **为什么这样设计**：插件 keyed by 不可变 `plugin@marketplace`；git 子进程一律加 `--` 防 RCE；能力控制是只读投射 + tri-state（on/off/inherit）；凭证两 scope + 0o600 + 三档门；记忆软删可恢复 + pinned 免老化；Dream 是受限的 headless LLM 清理回路。
- **带来的好处**：扩展能力不动 core 主体；no-repo 纯聊天反转为白名单关掉 superpowers；SDK 嵌入时 project scope 看不到宿主凭证；记忆/Dream 类 Codex 的 consolidation。
- **建议配图（1 张）**：
  - `plugins-capabilities-memory.svg`（必备）——插件装载 → 四类加载器（tools/MCP/skills/plugins/agents）→ 能力总览投射 + tri-state；旁挂凭证三档门 + 记忆/Dream 注入。
- **⚠️ 注意**：R-2 cookie 加密**暂缓**，现状是 0o600 明文——不要写成「已加密」。

### 09 · `09-arena-and-integrations.md`
- **拟标题**：《多模型对垒与外部 CLI 编排：Arena 与 cc-orchestrator》
- **源码入口**：`arena/arena.ts`（`Arena.run` @ ~`:83`）、`arena/iterate/iterative-arena.ts`、`arena/{transitions,ledger,planner}.ts`、`cc-orchestrator/{agent-adapter,external-agent-driver,cc-capability}.ts`、`stt/transcribe.ts`、`review/review-prompt.ts`、`external-agents/`。
- **核心问题**：Arena 怎么用多模型「评审」与「创作」？claim 生命周期与 ledger 怎么 append-only？CodeShell 当外部编排器驱动 `claude`/`codex` CLI 的铁律是什么？
- **为什么这样设计**：Arena 评审走证据驱动的 claim 管线，IterativeArena 创作走锦标赛+批评-修订；**CC/Codex 侧无任何时间/调度/循环逻辑**——所有定时/重试/审批回路在 codeshell 层（driver 跑一轮就退）；STT 是纯 UI 非 agent 工具。
- **带来的好处**：同一套评审机制换 lens 即换关注点；外部 CLI 当黑盒可换、可并、可循环；driver 子进程非 detached 绑 worker（避免孤儿）。
- **建议配图（1 张）**：
  - `arena-integrations.svg`（必备）——Arena 评审管线（Plan→Evidence→Research→Claims→Consensus）+ IterativeArena 创作环；旁挂 cc-orchestrator 驱动 claude/codex（铁律：时序在 codeshell 侧）。

### 10 · `10-tui-host.md`
- **拟标题**：《终端里的薄客户端：TUI 如何消费 Core》
- **源码入口**：`packages/tui/cli/main.ts`、`ui/{App.tsx,store.ts}`、`render/`（自绘渲染器）、`cli/commands/`。
- **核心问题**：TUI 怎么用 in-process protocol 接 core（不自己跑 Engine）？为什么 chat entry 走外部 store + 50ms 缓冲？为什么要手写 ~14K 行渲染器而不用 stock Ink？
- **为什么这样设计**：TUI 是协议接缝上的薄客户端；外部 store 避免整树重渲；自绘渲染器解决 Ink 增量渲染的闪烁/丢更新。
- **带来的好处**：与桌面共用同一协议；渲染率与 token 率解耦；全屏默认 = 重排干净。
- **建议配图（1 张）**：
  - `desktop-tui-hosts.svg`（与第 11 篇**共用**）——本篇用其中「TUI in-process」一侧；正文聚焦薄客户端关系。
- **说明**：TUI 属宿主层、非 core，但本系列收录它是为了展示「core 如何被消费」。标题与正文都点明这是宿主。

### 11 · `11-desktop-mobile-host.md`
- **拟标题**：《主进程只当经纪人：桌面/手机宿主与 CDP 浏览层》
- **源码入口**：`packages/desktop/src/main/index.ts`、`main/agent-bridge.ts`、`src/preload/index.ts`、`src/renderer/`、`src/mobile/`、`packages/cdp/`。
- **核心问题**：桌面三进程模型怎么分工？为什么主进程不在自己进程里跑 Engine，而是 per-session 起 worker？手机遥控怎么复用同一套 React/reducer？CDP 浏览层怎么做到环境无关？
- **为什么这样设计**：主进程是 IPC 服务经纪人，per-session 起 `agent-server-stdio` worker，把 stdout 管给 thin renderer（renderer 不 import 任何 core 代码）；隔离靠构建强制；CDP driver 无状态、注入 sender、派发**真实**输入事件（非合成 JS）。
- **带来的好处**：worker 崩溃可重启可重放；renderer/main/preload 三层物理隔离；桌面与手机共用 `streamReducer`；CDP 零运行时依赖、无 Playwright。
- **建议配图（1 张）**：
  - `desktop-tui-hosts.svg`（与第 10 篇共用）——本篇用其中「桌面三进程（main 经纪人 / worker Engine / renderer）+ 手机遥控 + CDP」一侧。
- **⚠️ 准确性注意**：见 §3 第 (3) 条——可以说「**桌面主进程不在自己进程里跑 Engine，而是 spawn 一个跑 Engine 的 worker**」；**不要写成「desktop main 绝不运行 Engine」这种绝对句**（Engine 确实在桌面体系内运行，只是在被 main spawn 的 worker 子进程里）。措辞要落在「哪个进程」而非「跑不跑」。

### 12 · `12-module-map-and-recap.md`
- **拟标题**：《把地图拼完整：模块全景、跨切面与延伸阅读》
- **源码入口**：`settings/manager.ts`、`onboarding.ts`、`runtime/`、`utils/`、磁盘布局 `~/.code-shell/`。
- **核心问题**：前 11 篇拼起来是什么形状？设置合并顺序（managed<user<project<local<flags）与 SettingsScope 怎么影响一切？onboarding/runtime/磁盘布局这些跨切面在哪？
- **为什么这样设计**：跨切面（设置/onboarding/runtime/磁盘）underpin 每一篇，单独收尾避免散落；模型数据外移（`data/model-metadata.json`）让更新免重编。
- **带来的好处**：读者拿到一张可导航的全局地图 + 一份「想深入某模块去读哪篇架构文档」的对照表。
- **建议配图（1 张）**：
  - `module-map.svg`（必备，详细版）——core 全模块 + 它们的依赖/数据流关系，作为系列收尾的「拼图完成」图。

---

## 3. 写作准确性约束（**强制**，正式撰写时逐条核对）

这些是已知容易写错或写绝对化的点。每条都给出**正确措辞**与**错误措辞**对照。

1. **不要把「所有 `Engine.run` 都经 protocol」写成绝对事实。**
   - 正确：几乎所有 `engine.run`（CLI / 桌面 worker / in-process REPL）都走 `AgentServer`+`AgentClient` 接缝，
     以便权限白名单与生命周期收口在一处。**但 `asyncAgentRegistry` 里的 sub-agent 是例外**——它们各自起一个带独立白名单的 `Engine`。
   - 错误：「所有 run 一律经过 protocol」「没有任何例外」。
   - 出现位置：第 02、05 篇必查；第 07 篇（`EngineRunner` 把 run 包进 in-process 协议）也涉及。

2. **不要把「所有后台任务跨进程重启都能恢复」写成普适事实。**
   - 正确：**Run / cron / 持久 goal** 设计为跨进程重启可恢复（心跳 + 锁 + 快照）。
     而**后台 shell** 与**同步 sub-agent** 走的是「完成时唤醒空闲引擎」的路子，且 driver/部分子进程是**非 detached、绑 worker** 的——
     worker 重启不保留它们。两类后台机制不同，不能混为一谈。
   - 错误：「任何后台任务都能在重启后恢复」「后台 shell 也会自动续跑」。
   - 出现位置：第 05、07、09 篇必查。

3. **不要把「desktop main 绝不运行 Engine」写成绝对句。**
   - 正确：桌面**主进程**是 IPC 服务经纪人，**它不在自己这个进程里跑 `Engine`**；它 per-session spawn 一个
     `agent-server-stdio` **worker 子进程**，`Engine` 在那个 worker 里运行。措辞要落在「在哪个进程跑」。
   - 错误：「桌面端从不运行 Engine」「desktop 没有 Engine」——会让读者以为桌面靠远端，事实是 Engine 就在本机 worker 子进程里。
   - 出现位置：第 11 篇必查。

4. **始终强调：Core 是通用 Agent 编排内核，不是写死的 coding agent。**
   - 正确：turn loop / 上下文 / 权限 / MCP / hooks / 任务 / cron / sub-agent / 会话 / 记忆 全部是**通用机制**；
     「会写代码」是叠加在上面的 *preset*（`general` vs `terminal-coding` 的差别就是配置差别）。
   - 错误：「CodeShell 是一个 coding agent，core 内置了编程逻辑」「引擎专为写代码设计」。
   - 出现位置：全系列基调，第 01、06 篇正面阐述。

5. **其他事实性红线**（写到时顺手核对，避免过时/夸大）：
   - R-2 cookie 加密**暂缓**，现状 0o600 明文——不要写成「已加密」（第 08 篇）。
   - 沙箱 **Windows 无后端，`auto` 降级为 off**——不要写成「全平台沙箱」（第 03 篇）。
   - 新增内置工具要改**两处**（`BUILTIN_TOOLS` + preset 白名单），漏一处工具静默不可见（第 03/06 篇）。
   - Gemini 仅支持 AI-Studio（`AIza…`）口径，**不支持 Vertex OAuth token**（第 04 篇）。
   - hooks 是**唯一**跨层数组拼接的特例，**别推广**到其它设置（第 06 篇）。
   - `file:line` 行号会漂移——正文引用源码位置时写「在 ... 附近」，并提醒读者以当前源码为准（全系列）。

## 4. 配图清单与映射（assets 下假定文件名）

| 图名 | 必备/共用 | 主用篇 | 复用篇 |
|------|-----------|--------|--------|
| `core-big-picture.svg` | 必备 | 01 | — |
| `engine-turn-loop.svg` | 必备 | 02 | — |
| `context-compaction.svg` | 必备 | 02 | — |
| `tool-executor-pipeline.svg` | 必备 | 03 | — |
| `llm-model-layer.svg` | 必备 | 04 | — |
| `protocol-sessions.svg` | 必备 | 05 | — |
| `prompt-presets-hooks-skills.svg` | 必备 | 06 | — |
| `run-automation-goal.svg` | 必备 | 07 | — |
| `plugins-capabilities-memory.svg` | 必备 | 08 | — |
| `arena-integrations.svg` | 必备 | 09 | — |
| `desktop-tui-hosts.svg` | 共用 | 11 | 10 |
| `module-map.svg` | 必备 | 12 | 01（导览处轻引一次） |

**全系列建议配图数：12 篇共约 13 处引用**（每篇 1 张，第 02 篇 2 张、第 01 与 12 篇各轻量复用 `module-map.svg`）。

**配图引用纪律**：
- 图未就位时，正文先写完整，引用处留占位 `![待补：<图名>](assets/<图名>)` 并在文末「## 待补图」登记。
- **不要在正文里描述「图中显示了 X、Y、Z」直到亲眼确认 SVG 内容**——避免缺图引用错位（本任务的核心约束）。
- 每张图正文都应有一两句「这张图在说什么」的引导，但描述要与上面的「建议图意」一致，发现 Codex 产出的图与设想不符时，**以图为准改文字**，并在登记处标注偏差。

## 5. 正式写作流程建议（下一步）

1. **逐篇成稿，顺序建议 01 → 12**（先全景立基调，再主线，最后宿主与收尾）。
2. **每篇开写前**：重读对应的 `docs/architecture/0X-*.md` 作为事实底稿；对引用到的关键符号，
   去 `packages/core/src` 实际 grep 一遍确认还在（行号会漂移）。
3. **每篇收尾**：核对 §3 的强制约束逐条过；登记「待补图」；补「延伸阅读」指回对应架构章。
4. **配图回填**：等 Codex 把 `assets/` 产出后，把占位换成真引用，并按图实际内容微调描述。
5. **范围纪律**：只在 `docs/core-deep-dive/` 下增改文件；**不改源码、不改 `docs/architecture/`**。
6. **语言风格**：中文、深入浅出、每篇能独立读；避免照抄架构文档的 `file:line` 密度，改为讲清「问题→设计→好处」。
