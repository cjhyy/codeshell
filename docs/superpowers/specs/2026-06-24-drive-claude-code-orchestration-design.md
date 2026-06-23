# 设计:codeshell 编排驱动外部 Claude Code

日期:2026-06-24
状态:设计已批准,待写实现计划

## 1. 背景与动机

codeshell 已经能把外部 `claude` CLI 当子进程驱动(`packages/desktop/src/main/mobile-remote/`
里的 `ResidentAgentProcess`,stream-json 模式,供手机遥控)。但这套能力局限在 mobile-remote
模块,且只有"单进程常驻一段对话"一种形态。

真实痛点(日志 `s-mqm1d3e2-6e62e119` 的失败案例):用户说"10 分钟后帮我打开小红书",
当前 agent 没有真正的定时原语,只能用 `Bash sleep 60…` 糊弄,回一句"已设置",然后 turn 在
14 秒后就 complete 了——**没有任何持久化定时器真的在 10 分钟后唤醒它**。

本设计把"驱动外部 Claude Code"提升为一等能力,并补上真正的定时/唤醒/循环编排。

### 对标 Claude Code 官方做法(供参考,不照抄)

- `/loop <interval> <prompt>`:会话内循环,固定间隔或让模型自我定速(1m~1h)。底层
  `CronCreate`/`CronList`/`CronDelete`,带 jitter,7 天过期。**是"会话内"循环**。
- `/goal <条件>`:条件驱动(非时间),每轮后小模型裁判条件是否满足→满足即停。
  headless 下 `claude -p "/goal <条件>"` 会阻塞到条件满足或中止。
- Desktop Scheduled Task:本地每分钟轮询,睡眠唤醒补跑最近一次(不补全部)。
- 程序化驱动:`claude -p <prompt> --output-format stream-json [--resume <id>]`,
  session 存 `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`,encoded-cwd =
  路径里非字母数字字符替换成破折号。

**我们的选择**:codeshell 在**外层**管调度 + 续/新裁决,每轮是独立的 headless
`claude -p` 进程,**不依赖 CC 内部 `/loop`**。控制权全在 codeshell。

## 2. 核心职责铁律

> **CC 侧无时间概念。所有延时/定时/循环/续新裁决,都在 codeshell 编排层。**

- **CC 侧(`ExternalAgentDriver`)**:只负责"现在跑这一轮"——spawn / resume / 喂 prompt /
  收 stream-json / 退出。纯粹、无状态、无时间概念。
- **codeshell 编排侧(房间/调度器)**:拥有全部时间与循环语义——延时、定时、循环、
  续/新/停裁决、session 绑定与回写、handoff 注入。

例:"10 分钟后用 cc 跑 X" = codeshell 房间调度器在 10 分钟后兑现 → 到点调 driver spawn claude。
两件事在不同层。**永远不会有工具去 `sleep` 自旋**(对齐
`project_background_shell_no_sleep_prompts` / `project_video_migrate_to_notification_wakeup`)。

## 3. 架构:层级与边界

定时/唤醒是 harness 层的**通用原语**(automation 用它、驱动外部 CC 用它、以后 codex 也用它),
因此核心单元放 **core**(对齐用户指示"定时能力应该加在 core 里"以及
`project_core_minimal_harness_business_layer`:业务边界清晰、可整块外移)。

```
core(新增 / 复用)
├── CCCapability        [新] 探测 claude CLI 是否可用 + 门控入口;多 adapter 口子(codex)
├── ExternalAgentDriver [从 ResidentAgentProcess 提炼] 无时间 spawn/resume/解析 stream-json
│   └── AgentAdapter 接口  claude 一个实现;codex 留空壳口子
├── SessionDiscovery    [新] 读 ~/.claude/projects/<encoded-cwd>/*.jsonl 列项目 session
├── RelevanceJudge      [新·复用 goal-judge 范式] aux LLM 裁决:续旧/开新+handoff/停
├── ScheduledCCTask     [复用 CronScheduler] 房间调度(延时/定时/循环)+ 续/新策略
├── 工具 DriveClaudeCode [新] agent 在任何对话里"现在用 cc 跑一轮"
└── 工具 ScheduleRoomTask[新] agent 把任务排进房间调度(通用,内容可为驱动 CC)

desktop(薄消费者)
├── CC 房间 UI:session 列表为主 + 选一个进去对话 / 新开 + 房间内定时
├── 定时任务 UI:创建/列/删
└── spawn 宿主 + IPC 桥

mobile(薄消费者)—— 同一份房间/session 列表的 RPC 视图
```

**CronScheduler 正名**:核实(scheduler.ts)它本身是干净的通用 timer——零耦合,只依赖
`CronJob` + `CronStore` + 注入式 executor 回调。是 `bindCronToRunManager` / `startAutomation()`
那层胶合把它变成"automation"。我们复用这台 timer,注入**自己的执行器**(驱动 driver)+
**独立 store**(`~/.code-shell/cc-tasks/tasks.json`),完全不碰 RunManager / read-only 权限契约。

## 4. 两种使用形态(共享底层 5 个 core 单元)

### 形态一:子 agent 工具(任何对话里调)

注册进工具系统(像 `Agent`/`Bash`),任何 codeshell 对话里 agent 都能调:

- **`DriveClaudeCode`**(无时间):`{ prompt, resumeSessionId?, cwd }` → spawn claude 跑一轮,
  返回 `{ sessionId, finalText }`。**不加 depth/goal 旋钮**——若要单轮跑更深,靠 prompt 措辞;
  若要单轮自我循环到条件满足,在 prompt 里嵌 `/goal <条件>`。这条**写进工具描述**引导 agent,
  不给 UI 按钮(对齐"用工具描述引导模型,不加硬开关"的一贯做法)。
  > 落地前须真机验证 `claude -p "/goal …"` 在 headless 下确实阻塞到条件满足才退;
  > 验证不过则退回纯 prompt 措辞。
- **`ScheduleRoomTask`**(房间调度,与 CC 无关):`{ prompt, schedule, kind, goal?, continuation }`
  → 把任务排进房间的 CronScheduler。它**调度的内容**可为驱动 CC,但本身是通用房间调度能力。

例:"10 分钟后用 cc 跑 X" = agent 调 `ScheduleRoomTask` → 到点房间执行器调 `ExternalAgentDriver`。

### 形态二:CC 房间(专门进去对话)

房间 = 项目(cwd)。首屏 **session 列表为主**:列出该项目下所有 CC session(来自
`SessionDiscovery`,含首条消息/时间)+ 正在跑的 driver。用户:

- 选一个已有 session 进去继续对话(`--resume <id>`),或
- 新开一个 session,
- 沿用现有"模拟一直和 Claude Code 对话"的交互形态(现 resident-agent 房间形态)。
- 房间天然拥有调度能力:在房间里说"10 分钟后跑"就由房间调度器接住。

## 5. 数据模型与单元契约

### 5.1 CCCapability(探测门控)

```ts
interface CCAvailability {
  available: boolean;
  command: string;          // 解析到的 claude 可执行路径
  version?: string;
  reason?: "not-found" | "not-executable";
}
function probeClaudeCli(): Promise<CCAvailability>;        // PATH 解析(含 /opt/homebrew/bin
                                                          // 的 macOS GUI 修正)+ claude --version
function probeAgentCli(adapter: AgentAdapter): Promise<CCAvailability>;  // codex 同理
```

- **门控**:UI 渲染房间&定时入口前先查 `available`。不可用 → 入口**置灰 + 引导安装文案**
  ("未检测到 Claude Code CLI,点此了解如何安装")。
- **缓存 + 失效**:结果缓存,提供手动"重新检测"(用户中途装了 CLI)。
- 每轮 run 前轻量复查;CLI 中途消失 → 任务标 `disabled` + 通知,不静默失败。

### 5.2 ExternalAgentDriver(从 ResidentAgentProcess 提炼)

```ts
interface AgentAdapter {                 // claude 一个实现,codex 留空壳
  buildArgs(opts: { prompt: string; resumeSessionId?: string;
                    permissionMode: string; cwd: string }): string[];
  parseLine(line: string): AgentEvent | null;   // 复用现有 parseStreamJsonLine
}
interface AgentRunResult {
  sessionId: string;      // 从 stream-json init/result 事件取(新 session 时新生成)
  finalText: string;      // 末轮 assistant 文本(喂 RelevanceJudge)
  events: AgentEvent[];
  exitCode: number;
}
class ExternalAgentDriver {
  constructor(adapter: AgentAdapter, opts: { command: string; cwd: string });
  run(opts, signal): Promise<AgentRunResult>;   // 跑完整一轮就退出,不常驻
}
```

- `resumeSessionId` 有 → `--resume <id>`(续上下文);无 → 新 session。
- 必接 `AbortSignal`(对齐 `project_external_call_timeout_signal`)。

### 5.3 SessionDiscovery

```ts
interface DiscoveredSession {
  sessionId: string; firstMessage: string; lastModified: number; messageCount: number;
}
function encodeCwd(cwd: string): string;                       // 非字母数字→破折号(对齐 CC)
function discoverSessions(cwd: string): DiscoveredSession[];   // 读 jsonl
```

只读、按需扫描(对齐 SessionManager 的 two-pass 风格);大 jsonl 只读头尾取首条消息+计数,别全 parse。

### 5.4 RelevanceJudge(复用 goal-judge 范式)

```ts
interface JudgeDecision {
  action: "continue-same" | "continue-fresh" | "stop";
  handoffSummary?: string;   // continue-fresh 时:给新 session 的简短 context
  reason: string;
}
function judgeContinuation(
  opts: { goal?: string; lastResult: string; nextPrompt: string }, auxModel
): Promise<JudgeDecision>;
```

用 aux 小模型 + 指纹缓存(对齐 `project_automation_kkg28_diagnosis`)。仅
`continuation="auto"` 才调裁判;`always-resume`/`always-fresh` 直接走,省 LLM。

### 5.5 ScheduledCCTask(复用 CronScheduler)

```ts
interface CCTask {
  id: string; name: string;
  cwd: string;                          // 项目(房间)
  schedule: string;                     // "2h" 一次性 delay | "30m" 间隔 | cron 表达式
  kind: "once" | "loop";
  prompt: string;                       // 每轮喂 claude
  goal?: string;                        // loop 才有:总目标(给 RelevanceJudge 判停)
  sessionId?: string;                   // 当前绑定的 CC session;裁判开新会更新它
  continuation: "auto" | "always-resume" | "always-fresh";  // 续/新策略,可手动覆盖
  permissionMode: string;
  enabled: boolean;
  lastRunSessionId?: string; lastRunAt?: number; runCount: number;
}
```

独立 store:`~/.code-shell/cc-tasks/tasks.json`。

## 6. 数据流与生命周期

### 6.1 创建

```
用户(桌面/手机)在某项目房间说"2 小时后审 PR" / "每 30 分钟检查 CI 直到全绿"
→ desktop 收集 {cwd, schedule, kind, prompt, goal?, continuation, permissionMode}
→ ScheduledCCTask.create(task) → 写 tasks.json → CronScheduler.create() 上 timer
```

### 6.2 触发(核心链路)

```
CronScheduler timer fire
→ 注入的 executor(job, signal)              [非 RunManager,cc-orchestrator 自己的]
→ 选本轮 session:
    always-fresh  → 不传 resumeSessionId(开新)
    always-resume → resumeSessionId = task.sessionId
    auto          → 用 task.sessionId(首轮无则开新)
→ ExternalAgentDriver.run({prompt, resumeSessionId, cwd, permissionMode}, signal)
    → spawn `claude -p <prompt> --output-format stream-json [--resume <id>] ...`
    → 收集到退出 → AgentRunResult{sessionId, finalText, ...}
→ task.sessionId = result.sessionId(新 session 时回写)
→ 记一条到房间 messages.jsonl(手机/桌面可见)+ 通知唤醒空闲引擎
```

### 6.3 裁决(仅 loop + auto)

```
loop 跑完一轮:
  auto → RelevanceJudge.judge({goal, lastResult: finalText, nextPrompt})
    "stop"           → 禁用任务(goal 达成),记事件,不再 arm
    "continue-same"  → 下一轮 resume 同 session(前后相关,保上下文)
    "continue-fresh" → 下一轮开新 session,handoffSummary 作 prompt 前缀注入(前后不相关——核心场景)
  always-* → 跳过裁判,按固定策略;loop 靠 schedule 次数/手动停
once → 跑完即禁用
```

## 7. 关键不变量与边界

- **并发**:同一 task 同一时刻只跑一轮(CronScheduler 已有重入保护 + per-job AbortController)。
- **sessionId 真相源**:`task.sessionId` 由裁判开新或用户手动改更新;每轮用 `result.sessionId` 回写
  (新 session id 由 claude 进程生成、从 stream-json 取)。
- **睡眠唤醒**:复用 CronScheduler 的 misfire guard(>90s 过点算 misfire,不补跑,re-arm 到下个
  occurrence,对齐 `project_automation_kkg28_diagnosis`)。
- **取消/停止**:停任务 → CronScheduler abort 在飞轮次 → signal 传进 driver → kill 子进程。
- **CLI 中途消失**:每轮 run 前轻量复查 CCCapability,不可用则标 disabled + 通知。
- **审批局限(已知)**:headless `claude -p` 拿不到中途审批交互;按 `permissionMode` 配置
  (`bypassPermissions` 全自动 / 工具被拒则该轮卡住到超时)。本版不解决跨进程审批桥接。

## 8. 复用与新建对照

| 单元 | 复用/新建 | 来源 |
|---|---|---|
| CronScheduler | 复用(注入自有 executor + 独立 store) | core automation/scheduler.ts |
| ExternalAgentDriver | 提炼 | mobile-remote/resident-agent.ts |
| parseStreamJsonLine | 复用 | mobile-remote/resident-agent.ts |
| RelevanceJudge | 复用范式 | goal-stop hook / aux 裁判 |
| 后台任务唤醒(多 CC / 完成通知 / 持续派活) | 复用 | backgroundJobRegistry / 通知唤醒机制 |
| CCCapability / SessionDiscovery | 新建 | — |
| DriveClaudeCode / ScheduleRoomTask 工具 | 新建 | — |

## 9. 明确不做(YAGNI / 本版范围外)

- 不接 CC 内部 `/loop`(codeshell 外层自己调度)。
- 不做跨进程审批桥接(headless 审批局限按 permissionMode 处理)。
- 不借 RunManager 的 run 状态机(语义不合:run 是"跑完一次",我们是"持续编排")。
- codex adapter 只留接口口子,本版只实现 claude。
- 不给"单轮深度"加 UI 旋钮(靠工具描述 + prompt 措辞)。

## 10. 后台多 CC 任务(复用现有后台体系,不新建机制)

需求:可派生多个 CC 后台任务并行跑;某个跑完时能知道;codeshell 可持续派活
(一个完了主 agent 决定再派下一件)。

**这套逻辑 codeshell 已经有了**(`project_video_migrate_to_notification_wakeup` /
`project_background_shell_no_wakeup` 的"统一后台工作唤醒"机制)。本设计**不新建机制**,
只把"后台 CC 进程"接进现有那套:

- **派生后台 CC** = `DriveClaudeCode` 支持后台模式 → 注册进现有 `backgroundJobRegistry`
  (与后台 shell / 后台视频 / 后台 sub-agent 同一注册表)。多个可并行。
- **完成通知** = CC 进程退出 → 走现有"后台完成 → 通知唤醒空闲引擎"路径
  (**不是**引擎 sleep 轮询)。
- **持续派活** = 唤醒后主 agent 看结果、自行决定要不要再调 `DriveClaudeCode` 派下一件。
  现成控制流,无需新增。

**唯一硬约束**:`ExternalAgentDriver` 的后台运行模式产出的完成事件,必须走 codeshell
现有的后台任务唤醒通道,**不另起炉灶**。

## 11. 落地前必须真机验证的点

1. `claude -p "/goal <条件>"` 在 headless 下确实阻塞到条件满足才退(否则退回纯 prompt 措辞)。
2. `claude -p --output-format stream-json --resume <id>` 续上下文行为符合预期,且能从事件流取到
   sessionId。
3. encodeCwd 对中文路径的编码与 CC 实际写盘目录名一致(核实 `~/.claude/projects/` 真实目录)。
4. GUI 启动的 Electron 下 PATH 能解析到 claude(/opt/homebrew/bin 修正是否够)。
