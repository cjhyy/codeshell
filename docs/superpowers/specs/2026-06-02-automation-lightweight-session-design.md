# 自动化轻量化 — automation = 项目里的特殊 session(学 Codex)

日期:2026-06-02
状态:待审(已过一轮代码对峙 review,见 §9;权限映射 §4.3 方向待定)

## 1. 背景与问题(已实锤)

用户反馈三件事,挖盘后定位:

1. **「只有一个 checkpoint 没具体内容」** —— automation 走 RunManager 路径,RunManager 把
   onStream 事件喂 `CheckpointWriter`,而后者设计就是「state summary + pointers,NOT full
   text copy」(CheckpointWriter.ts:16):只抽 lastAssistantText / touchedTools /
   detectedPhases,**逐条 text/tool 明细全丢**,只 saveCheckpoint 摘要。`events.jsonl` 只有
   6 条骨架(created/queued/started/session_linked/checkpoint_written/completed)。
   → import 进 renderer 只能渲染那个 checkpoint_written,所以「只有一个 checkpoint」。
   **报告全文其实在 checkpoint.summary 里**,但前端没当正文展示。
2. **「配置该按项目走」** —— `automation-host.ts:31` 用 `process.cwd()`(app 启动目录)解析
   SettingsManager,不是 job 项目。实证:早间新闻 run 误加载了 `superpowers:using-superpowers`
   skill(summary 第一句),且「未配置搜索提供商」。
3. **「权限要可配、能读写」** —— `runner.ts:60` 写死 `HeadlessApprovalBackend("approve-read-only")`,
   不管 job 配了 workspace-write/full 都被强制只读。cron 字段 `permissionLevel` 存了但执行时被无视。

## 2. 参考:Codex 自动化(本机实测 ~/.codex/automations)

一个 automation 一个目录:`automation.toml`(配置)+ `memory.md`(运行记忆)。
- 无 checkpoint/RunStore/resume 重机制;轻量、一次性。
- `cwds = [...]` 配置目录,按项目解析。
- 跑完 agent 把一段「运行摘要」追加进 `memory.md`,下次运行先读它当上下文。
- 内容靠 agent 自述摘要,不靠存逐条 transcript。

## 3. 关键可行性(已核对)

- **headless Engine 自动落 transcript**:`Transcript.appendMessage/events` 是 append-即-写盘
  (transcript.ts:147 appendFileSync),SessionManager 用 `sessions/<sid>/transcript.jsonl`
  (session-manager.ts:110)。→ `new Engine({headless, onStream, sessionStorageDir})` 跑时
  **自动逐条落 transcript**,与聊天同构,无需额外 writer。
- **「agent 知道这是自动化」已有现成机制**:`AUTOMATION_RUN_SOURCE="automation"` +
  `AUTOMATION_PROMPT_NOTE`(EngineRunner.ts:34/40)+ Engine 原生 `appendSystemPrompt`
  (engine.ts:128)。NOTE 已含「无人值守、别问用户、别设自动化」。

## 4. 关键决策(已与用户逐条确认)

### 4.1 核心模型:一个 session,两种模式(按显式身份,NOT headless)

automation = 项目里一种带 `source:"automation"` 身份的普通 session。判据用**显式身份
`source==="automation"`**,**不用 headless**(headless 是技术副作用标志:控
InvestigationGuard 软模式 / sandbox 默认值,engine.ts:612/875/1151;拿它兼职表达业务身份会
让别处 headless 误触发禁 cron)。

| | 自动执行态(cron 触发) | 交互态(事后续聊) |
|---|---|---|
| 判据 | runner 知道「这是 automation 执行」 | 无此身份 |
| agent 知情 | 注入 AUTOMATION_PROMPT_NOTE,明知「我在跑自动化」 | 普通会话 |
| cron 工具 | 软禁(NOTE)+ 硬禁(builtin 白名单不含 cron,见 §9 #3) | 恢复 |
| 落盘 | transcript.jsonl + 追加 memory.md | transcript.jsonl |

> 注:judging「自动执行态」的判据不依赖 RunManager 的 `metadata.source`(裸 Engine 路径没有该通道)。
> automation runner **自己**就知道它在跑 automation,据此(a)注入 NOTE、(b)用不含 cron 的 builtin
> 白名单构造 toolRegistry、(c)挂 UpdateAutomationMemory。详见 §9 #3。

### 4.2 执行路:绕开 RunManager(RunManager 降级保留)

```
scheduler 触发 cron
  → 建新 sessionId(带日期)
  → 读 任务级 memory.md 注入上下文
  → new Engine({
        cwd: job.cwd,                               // 4.4 单 cwd,按项目解析配置/skill
        sessionStorageDir,                          // → 自动落 transcript.jsonl
        permissionMode: <见 4.3,待定>,              // ⚠ 真字段名 permissionMode(engine.ts:123)
        approvalBackend: <见 4.3,待定>,             // 权限靠 permissionMode + approvalBackend 配合
        appendSystemPrompt: AUTOMATION_PROMPT_NOTE
          + "\n任务完成后,调用一次 UpdateAutomationMemory 写入本次运行的关键发现/状态,供下次运行参考。",
        // 工具集:经 EngineConfig.runtime.toolRegistry,用 ToolRegistry 的 builtinTools 白名单
        //         (registry.ts:18)传一个【不含 cron 工具、含 UpdateAutomationMemory】的白名单。
        //         无需 source/metadata 通道 —— 见 §9 #3。
     })
  → engine.run(prompt, { onStream })                // ⚠ onStream 是 run() 入参,非构造参数(engine.ts:622)
                                                    //   逐条事件自动落 transcript
  → agent 跑完调用 UpdateAutomationMemory({summary}) → 追加进 任务级 memory.md
     (memory 由 agent 经工具显式写入,runner 不截输出;比解析末尾文本更稳)
  → 该 session 按 job.cwd 归项目侧边栏,标题「⚙ <任务名> <日期>」,source:automation
```
RunManager / RunStore / checkpoint 代码**保留不删**(TUI runs、未来长任务可用),但不再是
automation 执行入口。⚠ 注意 index.ts:289 注入的是给 `startAutomation` 的 **`runManager`**,
不是裸 runner —— 绕开 RunManager 需改 `startAutomation` 的执行模型(它现期望一个 runManager),
不只是「换个 runner」。改动比一行替换大,落地计划须单列。详见 §9 #4。

### 4.3 权限:执行时真生效(🚧 方向待定 — 用户优化中)

**目标确定**:automation 不再写死只读(`runner.ts:60` 的 `approve-all/...`),要能按配置读写。
**方向待定**:用户在重想权限模型本身(可能重新分档 / 调整含义 / 与聊天那套的关系),故此处不锁定。

落地前已查实的事实底牌(供权限设计参考,不作结论):
- `HeadlessApprovalBackend` 当前仅 3 个 mode(permission.ts:19):
  `"approve-all"` / `"deny-all"` / `"approve-read-only"`。
- cron 现有 3 档(scheduler.ts:12)`read-only | workspace-write | full`。
- **错配点**:`workspace-write`(写但限 cwd)在 backend **没有对应 mode** —— 要么落 approve-all(太松),
  要么需新增一个「写但限 cwd」档。这是权限模型可能要动的核心原因。
- 另一维度 `permissionMode`(engine.ts:123)`default|acceptEdits|dontAsk|bypassPermissions|auto|plan`
  走分类器,与 approvalBackend 是**配合**关系。automation 该用哪套是待定项之一。
- 交互式聊天那套 4 档 plan/default/accept_edits/bypass 是另一概念维度。

→ 待用户定权限模型后,回填本节与 §4.2 伪代码的 `permissionMode`/`approvalBackend` 两个占位。

### 4.4 配置 / cwd / skill 按项目

Engine 用 `job.cwd` 解析 SettingsManager / skill,**不再用 process.cwd()**。项目没 skill 目录
就不加载 skill —— 修掉「新闻任务误加载 superpowers」。目前单项目,cron 保持**单个 cwd**
(不做 Codex 的 cwds 多目录数组)。

### 4.5 历史 / memory / 侧边栏

- **每次运行一个新 session**(带日期),归 job.cwd 项目。侧边栏可见每天历史。
- **跨运行 memory = 每任务一份独立 `memory.md`**,位置 `~/.code-shell/automations/<jobId>/memory.md`;
  **不挂项目主记忆**(不污染);下次运行先读注入。
- **写入方式 = 专用工具 `UpdateAutomationMemory`**(用户定):新增 builtin 工具,入参 `{summary}`,
  把摘要追加进该任务 memory.md;jobId 从 automation 执行上下文注入。只在 `source==="automation"`
  执行态挂载;prompt 要求 agent 任务完成后调用一次。runner **不截输出文本**——比解析末尾更稳、结构化。
- **逐条内容** → `sessions/<sid>/transcript.jsonl`,复用聊天展示。

### 4.6 Runs 视图

改存 session 后新 automation 不写 RunStore。Runs 视图**保留只读**展示历史旧 run(那 5 个),
不破坏。新 automation 在项目侧边栏看。

## 5. 组件与改动面

- **新增 desktop runner**(替代 buildDesktopRunManager 作为 cron 执行入口):headless Engine +
  按 job.cwd 解析 + permission 映射 + memory 读/写 + source 标记。
- **core 工具过滤**:按 `source==="automation"` 从工具集移除 cron 工具 + 挂上
  `UpdateAutomationMemory`(新增,现在没有)。
- **新增 builtin 工具 `UpdateAutomationMemory`**:入参 `{summary}`,jobId 从执行上下文注入,
  追加进任务 memory.md。
- **memory store**:读写 `~/.code-shell/automations/<jobId>/memory.md`(纯函数 + fs 包装,可单测);
  工具与 runner 读取均经它。
- **permission 映射**:`CronPermissionLevel → HeadlessApprovalBackend` 档位(纯函数,可单测)。
- **session 命名/归属**:run 建带日期标题的 session,source:automation,按 cwd 归项目
  (复用 [[project_automation_run_sidebar]] 已有的 run→sidebar 机制)。
- **AUTOMATION_PROMPT_NOTE**:末尾追加「跑完写运行摘要」一句。

## 6. 测试(纯函数优先,可单测)

- `mapPermissionLevel(level)`:read-only/workspace-write/full → 审批后端档位;未知→保守只读。
- memory store:append/read;空文件;不存在→空;按 jobId 隔离。
- `UpdateAutomationMemory` 工具:调用后摘要落对应 jobId 的 memory.md;缺 jobId 上下文时报错不静默。
- 工具过滤:source==="automation"→无 cron 工具、有 UpdateAutomationMemory;否则反之。
- runner 集成:headless Engine 跑完确实落 transcript.jsonl(临时 sessionStorageDir)。

## 7. YAGNI(明确不做)

- 不做 cwds 多目录(目前单项目,4.4)。
- 不删 RunManager/RunStore(降级保留,4.2)。
- memory 不挂项目主记忆、不做跨任务共享(每任务一份,4.5)。
- 不用 auxModel 生成摘要、不解析 agent 输出末尾(改 agent 调 UpdateAutomationMemory 工具,4.5)。
- 不合并 cron 3 档与聊天 4 档(各管各的,4.3)。

## 8. 与已交付工作的关系(⚠ 接线是必做项,非「确认」)

上一轮已交付「main 持 session 快照 + renderer 重订阅」(commits 2936f81/d270501/ccfd56f/b98760e)。
但 automation 跑在 **main 进程内**(scheduler),而 AgentBridge 的快照只喂 **stdio worker 子进程**
的转发流。**main 内直接 `new Engine` 的事件根本不经过 AgentBridge** —— 所以「automation 自动受益于
main 快照」目前**不成立**,是一条**必须新做的接线**:让 automation Engine 的 onStream 也喂进
`SessionSnapshotStore` + `safeSend("agent:msg", …)`。落地计划须单列此项。详见 §9 #5。

## 9. Review 发现(2026-06-02 代码对峙,落地前须消化)

文档的决策与方向正确,但伪代码/断言曾与真实 API 有出入,已在上文就地修正,要点留档:

1. **Engine 配置字段名**:`permission`→`permissionMode`(engine.ts:123);`onStream` 是
   `engine.run(task,{onStream})` 入参非构造项(:622);无 `tools` 构造项,工具走 `toolRegistry`。已修 §4.2。
2. **权限映射**(🔴→🚧):`HeadlessApprovalBackend` 仅 approve-all/deny-all/approve-read-only,
   表达不了 cron 的 workspace-write。已改 §4.3 为「方向待定」+ 事实底牌,等用户定权限模型。
3. **工具过滤入口**(原 #3 缺口,已解):cron 工具是 core builtin(builtin/cron.ts)。`ToolRegistry`
   构造支持 `builtinTools` 白名单(registry.ts:18/29)→ automation 传【不含 cron、含
   UpdateAutomationMemory】的白名单即可。**不需要 RunManager 的 metadata.source 通道**,判据由
   runner 自身持有。
4. **绕开 RunManager 的改动面**:index.ts:289 注入的是 `runManager` 给 `startAutomation`;绕开它要
   改 `startAutomation` 执行模型,非一行替换。落地计划单列。
5. **main 快照接线**:automation 在 main 进程跑,事件不经 AgentBridge;须新接线喂快照。见 §8。
