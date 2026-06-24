# 调度去耦合:把定时能力从「驱动 CC 房间」剥离回通用层

日期:2026-06-24
范围:`packages/core`(工具层 + preset + automation 写策略) + `packages/desktop/src/main`(执行器接线)。
不动 `CronScheduler` 的 misfire / abort / 持久化既有算法。

## 背景与问题

2026-06-24 的 cc-orchestrator 一版(已合 main `8351d66e`)加了 `ScheduleRoomTask` 工具,
用于「定时/循环地驱动外部 Claude Code CLI」。但它把**通用的定时能力**和**驱动 CC 这个具体动作**焊死在了一起:

- 工具名 `ScheduleRoomTask` 暗示「定时是为 CC 房间服务的」——主从关系反了。
- 它在 cron job 之外旁挂了一套 CC 专属机制:`CCTaskStore`(`~/.code-shell/cc-tasks.json`)存
  `kind / continuation / goal / sessionId / handoffSummary`;`makeCCAwareExecutor` 在 cron fire 时
  按「该 job.id 在 CCTaskStore 里有没有 meta」分流到 `runCCTask`(直连 `runAgentOnce` 驱动外部 `claude` CLI)。

读码确认的现状:

1. **底层 `CronScheduler`(`automation/scheduler.ts`)本来就完全通用**——只认
   `name/schedule/prompt/cwd/timezone/permissionLevel`,支持 interval(`10m`)和 5 段 cron,
   有持久化、misfire 守卫、abort、runNow。它不认识「room」「CC」。
2. **codeshell 早就有通用 cron 工具** `CronCreate / CronList / CronDelete`(`builtin/cron.ts`),
   建在**同一个** `cronScheduler` 单例上。`CronCreate` 和 `ScheduleRoomTask` 90% 重叠。
3. `ScheduleRoomTask` 比 `CronCreate` 多的真实价值只有 **`kind: once`(一次性)**。
4. **`ScheduleRoomTask` 背后是一条真在工作的执行链**(不是死代码):
   `cron fire → makeCCAwareExecutor →(有 CCTaskStore meta)→ runCCTask → runAgentOnce 驱动外部 claude`。
   消费者:`cc-orchestrator/cc-scheduler-binding.ts`(`runCCTask` / `makeCCAwareExecutor`)、
   `desktop/src/main/index.ts`(4 处:装配 executor、CCTaskStore 读写、删除)。
5. 但这条链里 **`continuation` 裁判是占位的**——`desktop/index.ts:1074` 的 `ccJudge` 永远返回
   `continue-same`(注释明说「aux model not wired in this version」)。即 `goal / continuation` 的
   智能决策从未真正工作,只是「每轮都 resume 同一 session」。

### 正确的心智模型(用户拍板)

> 循环/定时是 **codeshell 自己**的能力。到点了驱动的是 **codeshell 引擎跑一轮**(喂一个 prompt)。
> 「驱动 CC」只是引擎那一轮里可能调用的一个子任务工具(`DriveClaudeCode`),
> 跟它调 Bash、调 subagent 平级。CC 不是定时的主人,是定时任务的一个用法。
> resume / fresh 由引擎那一轮临场决定(手里有上轮返回的 sessionId),不预先写进定时配置。

CC `/loop` 的做法印证此方向(claude-code-guide 调研):CC 的 `/loop` 是 **bundled skill**,
「固定间隔 → 编译成 CronCreate 调用」;一次性走 `CronCreate(recurring:false)`,不走 loop。
即底层一个通用调度工具,loop 是上层语法糖。本设计**只做底层收敛**(用户选 A),`/loop` skill 留待单独一轮。

## 决策(用户拍板)

1. **彻底走 A:删整条 CC 执行链。** 不保留「CC 类型的 job」这个概念。所有 cron job 走**同一条**
   headless Engine 路径;要驱动 CC 就在 prompt 里写「用 DriveClaudeCode 干 X」,由那轮引擎自己调。
   删:`ScheduleRoomTask` 工具 + `CCTaskStore` + `runCCTask` + `makeCCAwareExecutor`(及其裁判占位)。
2. **无人值守审批:无需定时层改动。** `DriveClaudeCode` 已默认 `bypassPermissions`(`4f1327c8`),
   不卡审批;定时层不加 bypass 标记/permissionMode,模型靠 prompt 表达即可(见上「无人值守审批」一节)。

三个 CC 专属概念的归宿:

| 概念 | 原设计位置 | A 方案归宿 |
|------|-----------|-----------|
| `kind`(once / loop) | `CCTaskStore` | **并入 `CronCreate`**(一次性是通用调度属性) |
| `goal`(干到啥时候停) | `CCTaskStore` + 占位裁判 | **删** —— 复用 codeshell 已有 `/goal` 机制,写进 prompt |
| `continuation`(resume/fresh) | `CCTaskStore` + 占位裁判 | **删** —— 引擎那轮拿上轮 sessionId 临场决定传不传 `resumeSessionId` |

## 目标(本轮范围)

1. 给 `CronCreate` 补「一次性」一档(`once: true`),成为完整通用定时工具(interval / cron / 一次性)。
2. 删除 `ScheduleRoomTask` 工具、`CCTaskStore`、`runCCTask` / `makeCCAwareExecutor` 整条 CC 执行链。
3. desktop 主进程改回**只装通用 automation executor**(原 `automationFallback` 那条);移除 CC-aware 包裹。
4. preset 白名单/注释清理 + `DriveClaudeCode` 描述修正 + 测试相应反转/删除。

**非目标:** `/loop` skill;self-pace 唤醒;真 aux 裁判;UI 改动;`CronScheduler` 核心算法改动;
**无人值守审批改动(已无需做,见下)**。

### 无人值守审批 —— 已解决,本轮不动(用户核实)

原担心:cron fire → 跑一轮 headless Engine → 这轮调 `DriveClaudeCode`(及其驱动的 CC)会卡审批。
核实代码后结论:**无需任何定时层改动**。

- **内层**(DriveClaudeCode 驱动的外部 claude CLI 自己的工具审批):已由 `4f1327c8`(已合 main)
  解决 —— `DriveClaudeCode` 默认 `bypassPermissions`,联网/工具不再被挡。
- **外层**(那轮 headless Engine 调 `DriveClaudeCode` 工具本身):由 prompt 表达即可。模型在
  `CronCreate` 的 prompt 里写「用 DriveClaudeCode 干 X」,工具自身已 bypass;automation 路径的
  工具放行由 `resolveWritePolicy` 既有三档处理。
- **不给 `CronCreate` 加 bypass 标记 / permissionMode 参数**(用户拍板):定时层啥都不懂、prompt 即一切;
  把 permissionMode 漏回定时层会重新引入 CC 特殊性,与去耦合方向相悖。`permission.ts:873`
  已保证 `bypassPermissions` mode override 一切,无需新档。

## 设计

### 1. `CronCreate` 增加一次性支持

底层 `CronScheduler` 当前无「跑一次就删」语义,补最小一档:

**a. `automation/scheduler.ts`**
- `CronJob` 增 `once?: boolean`;`CreateJobOptions` 增 `once?: boolean`,`create()` 透传写入 job。
- `fire()` 真实执行完成后(`finally` 内、`persistRunStats` 之后),若 `job.once === true` 调 `this.delete(job.id)`
  (走已有删除路径:清 timer + 从 store 移除 + reconcile 不会复活)。
- **一次性 cron 的 re-arm 时序**(唯一真实风险):`armCron` 的 setTimeout 闭包持有旧 job 引用,
  re-arm 前必须查 `this.jobs.has(job.id)` —— 已被 once 删除则不 re-arm。
- **TDD 锁死**:一次性 interval、一次性 cron 各「fire 一次后从 `list()` 消失且 timer 不再触发」;
  循环 job 不回归。

**b. `builtin/cron.ts`**
- inputSchema 增 `once: { type:"boolean", description:"true = 跑一次就自动删除(一次性提醒/任务);默认 false 按 schedule 反复跑。" }`。
- 描述补一次性用法 + 「N 分钟后 / 明早 7 点」→ interval/cron 的翻译指引。
- `cronCreateTool` 读 `args.once === true` 透传 `create(..., { once:true })`;返回文案区分一次性/循环。

### 2. 删除整条 CC 执行链

- 删文件:`builtin/schedule-room-task.ts`(+`.test.ts`)、`cc-orchestrator/cc-task-store.ts`、
  `cc-orchestrator/cc-scheduler-binding.ts`(+ 其测试)。
- `builtin/index.ts`:移除 `scheduleRoomTaskToolDef / scheduleRoomTaskTool` 导出与注册。
- `cc-orchestrator/index.ts`:移除 `export * from "./cc-task-store.js"`(及 binding 的导出)。
- `core/src/index.ts`:若有从顶层 re-export 这些符号,一并清。
- 全仓 grep `CCTaskStore / ScheduleRoomTask / cc-task-store / runCCTask / makeCCAwareExecutor / cc-scheduler-binding` 清零(test/dist 除外的源码引用)。
- **数据**:`~/.code-shell/cc-tasks.json` 是旧旁存文件,功能未 push、无需迁移;不主动删用户磁盘文件。
  `relevance-judge.ts` 若仅被 binding 消费,且无其它用途,一并删;否则保留(实现时确认)。

### 3. desktop 主进程接线回退(`desktop/src/main/index.ts`)

当前(1033–1087)在 `startAutomation` 之后**替换**了 executor 为 CC-aware 版。改为:
- **删除整个 CC-aware 块**(`ccScheduler.setExecutor(ccAware)` 及 `ccStore / ccRunner / ccJudge / makeCCAwareExecutor`)。
- 保留 `startAutomation({ store, runner })` 默认装配的 executor(即原 `automationFallback` 逻辑:
  `resolveWritePolicy → CronRunRequest → automationRunner`)。所有 job 走这一条。
- 删除文件顶部 `CCTaskStore` 等 import。

这样 cron job 一律跑 headless Engine 一轮;驱动 CC 由那轮引擎调 `DriveClaudeCode` 完成。

### 4. preset 调整(`preset/index.ts`)

- `BUILTIN_TOOLS` 移除 `"ScheduleRoomTask"`。
- cc-orchestrator 注释改为只提 `DriveClaudeCode`;说明定时统一走 `CronCreate`。
- `CronCreate / CronList / CronDelete` 保持在白名单;`CronList` 的 `allow` 决策保留。

### 5. `DriveClaudeCode` 描述修正(`builtin/drive-claude-code.ts`)

`"...use ScheduleRoomTask instead (never sleep)."` →
`"...use CronCreate instead (never sleep). A scheduled CronCreate job runs one codeshell turn whose prompt can instruct it to call DriveClaudeCode; to continue a prior CC session across runs, have that turn pass the sessionId this tool returned as resumeSessionId."`

## 数据流(改造后)

```
用户:「每 30 分钟用 CC 看看有没有新 issue,有就处理,直到清空」
  ↓
引擎调 CronCreate(name, schedule="30m", once=false,
                  prompt="用 DriveClaudeCode 检查并处理新 issue;/goal issue 清空")
  ↓
cronScheduler 每 30m fire → 跑一轮 headless Engine(喂该 prompt;
                  DriveClaudeCode 自身已 bypass,不卡审批)
  ↓
那轮引擎自行:调 DriveClaudeCode(prompt, cwd[, resumeSessionId=上轮id])
            + 用已有 /goal 机制判断是否达成、是否继续
  ↓
一次性任务:once=true → fire 后 job 自删
```

## 测试

- **scheduler**(TDD 新增):一次性 interval / 一次性 cron 各 fire 一次后从 `list()` 消失、timer 不再触发;循环不回归。
- **cron 工具**:`CronCreate({once:true})` 透传;返回文案含「执行一次后删除」。
- **preset**:`general.builtinTools` **不含** `ScheduleRoomTask`(原断言反转);仍含
  `DriveClaudeCode / CronCreate / CronList / CronDelete`。
- **删除回归**:删 `cc-task-store` / `cc-scheduler-binding` 后,`bun test` 两包全绿、无悬空 import;
  `tsc` 两包(含 desktop 自己的 `tsc --noEmit`)0 新错。

## 风险与边界

- **一次性 cron re-arm 自删时序**:唯一算法风险,TDD 锁死(见 1a)。
- **删执行链的连带面**:`cc-scheduler-binding` / `relevance-judge` / desktop 装配三处必须同删,
  漏一处则 tsc 报悬空 import —— 用 tsc 当守卫。
- **desktop 有自己的 tsc/build**(见 `packages/desktop/CLAUDE.md`),改 `main/index.ts` 后必在
  desktop 包内单独跑 `bunx tsc --noEmit`。

## 实现顺序(给 writing-plans 的种子)

1. scheduler 加 `once`(TDD:先写一次性 interval/cron 失败测试 → 实现 → 绿)。
2. `CronCreate` 暴露 `once` + 文案。
3. 删整条 CC 执行链(工具 / store / binding / 顶层 export),tsc 当守卫扫悬空引用。
4. desktop `main/index.ts`:删 CC-aware 块,回退到默认 automation executor。
5. preset 白名单/注释 + `DriveClaudeCode` 描述 + 测试反转/删除。
6. 全量 `bun test`(core + desktop)+ `tsc`(含 desktop 包内)收口。

实现走 worktree(用户规矩:打工走 worktree 别动 main),完成后 rebase 本地 main → FF 合并。
真机冒烟(定一个一次性 CC 任务、定一个循环 CC 任务)留用户。
