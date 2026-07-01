# 定时续接对话 = 喂一条 user 输入 + 渐进插入折叠修复

日期: 2026-07-01
状态: 待用户确认 → 实现
Worktree: `.claude/worktrees/night-batch`（分支 night-batch）

本 spec 覆盖两件相关但独立的事,分开 commit:
1. **定时续接对话重构** —— 推翻 commit `1990ad35` 的 headless resume 老路,改为"到点往活 session 喂一条 user 输入"。
2. **渐进插入 message 导致渲染折叠 bug 修复** —— injected 消息不应折叠上一正在流的轮。

---

## 一、定时续接对话:从 headless resume 改为"喂输入"

### 背景与老路的问题
commit `1990ad35` 给 CronCreate 加了 `continueInSession`/`resumeSessionId`,实现方式是:cron 到点时 `buildDesktopAutomationRunner` **self-new 一个 `headless:true` Engine**,`engine.run({ sessionId })` 从磁盘 resume 那个 session 跑一轮。

Review(workflow 高强度审查 + 亲自复核)确认这条路有 5 个真问题:
- read-only 默认(权限走 cron tier,续接对话写操作被静默拒)
- 删除后冷启动空白会话(无 `exists()` 预检)
- cron 工具递归(resume 分支解除了 strip)
- cwd/settings 错配(按 jobCwd 解析 llm,却在 session 真实 cwd 执行)
- 侧边栏归属错(onSession 用 jobCwd)

**根因**:`server.ts:214 maybeWakeIdleSession` 里 `if (session.engine.isHeadless()) return` —— headless 被显式排除在后台完成的自动唤醒之外。所以 headless resume 里的后台活(DriveClaudeCode 默认 `background:true`、后台 shell)完成时**没有活着的引擎接续**,成孤儿。这不是引擎的限制,是 `headless:true` 这个运行模式决定的。

### 心智模型(用户拍板)
> session 唤醒就相当于人输入了一个指令,只是定时到什么时候输入。
> session 唤醒的逻辑 和 定时的逻辑是 2 个逻辑。

即:**定时续接侧根本不该"运行引擎"**。它只负责一件事——到点了,把 prompt 当成一条 user 输入,喂给那个 session。之后跑、后台、完成唤醒续接,全是 session 既有逻辑,与人手输入零区别。

"喂输入"有三个平级入口,共用同一出口 `session.enqueueTurn`:
- 人手打字(chat.send)
- 后台完成唤醒(`maybeWakeIdleSession` → enqueueTurn,server.ts:232)
- **定时到点(本 spec 新增)**

### 现有通道(全部已核实,不新增运行路径)
- `session.enqueueTurn(prompt, opts)`(`chat-session.ts:85`)= 喂一轮通用出口。
- main→worker 喂一轮 = `bridge.injectWorkerMessage({ method: "agent/run", params: { task, sessionId, cwd, permissionMode } })`(手机遥控 `index.ts:680` 就走这条)。
- cron scheduler 在 main 进程(`index.ts:1411 startAutomation`),能拿到 `bridge`。
- session 不活着也无妨:`agent/run` 带 `sessionId` → worker `engine.ts:1312 exists()→resume` 自动从磁盘拉起。用户选「先拉活再喂」= 直接 inject,无额外动作。

### 设计
**数据(不变)**:cron job 上的 `resumeSessionId`(commit 1990ad35 已加到 scheduler.ts + cron.ts,持久化进 cron.json,重启 loadJobs 恢复)。`continueInSession` 工具参数保留。这部分不动。

**执行(改)**:cron executor 分流——
- job 有 `resumeSessionId` → **不走 headless runner**,改为 main 侧 `bridge.injectWorkerMessage` 一条 `agent/run { task: job.prompt, sessionId: resumeSessionId }`,然后撒手。权限/cwd/工具/后台唤醒全继承 session。
- job 无 `resumeSessionId`(独立任务)→ 维持现状 `buildDesktopAutomationRunner` headless 一轮跑,不动。

**删除**:commit 1990ad35 在 `automation-host.ts` 里加的整个 `isResume` 分支(resumeSid/isResume 及其所有 `...(isResume ? ...)` 三元)全部删掉——不再需要。scheduler.ts / cron.ts 的字段保留。

**接线点**:cron executor 当前由 `bindCronToEngine`(runner.ts:62) → `buildDesktopAutomationRunner` 提供。改动落在 desktop main:执行器在调 headless runner 前先判 `job.resumeSessionId`,有则走 inject 分支。需要把 `bridge` 句柄提供给该分支(main 进程内已有 `bridge`)。

**session 不活时**:不特殊处理——`agent/run` 带 sid 天然触发 worker 从磁盘 resume(engine.ts:1312)。等同人手点开旧对话再发言。

### 边界与不变量
- 独立自动化任务(无 resumeSessionId)完全不受影响。
- 续接任务的权限/cwd/工具面 = 该 session 本来的,不再由 cron tier 决定 → review 的 5 个坑随 headless 分支删除一并消失。
- 侧边栏归属:走正常 session 路径,由 session 自身 cwd 决定,天然正确。

### 测试
- cron executor:job 带 resumeSessionId → 调 inject(agent/run 带该 sid),不调 headless runner。
- job 无 resumeSessionId → 调 headless runner(现状回归)。
- (desktop 侧若难以单测 bridge,则测执行器分流决策函数——把"选哪条路"抽成纯函数便于测。)

---

## 二、渐进插入 message 导致渲染折叠 bug

### 根因(已亲自核实每一环)
steer / wakeup / 定时续接注入的 user 消息被 append 进 renderer 的 messages 后:
- 成为 `userIdxs` 最后一项 → `lastTurnStart` 前移(`streamGroups.ts:410`)。
- 正在流式输出的**上一轮** `start !== lastTurnStart` → `isLive` 从 true 翻 false(`streamGroups.ts:416`:`isLive = liveTurnActive && start === lastTurnStart && !turnHasDoneAssistant(...)`)。
- 该轮当场折叠进"已处理 Xs ⌄"卡片(`TurnProcessGroupCard.tsx:46` `useState(group.isLive)` 初值变 false → 默认 collapsed)。
- 注入消息成为一个还没内容的空 live 轮。

`liveTurnActive` 在注入后仍为 true(`App.tsx:823`:注入的 user 成 lastMessage,`kind==="user"` 满足),所以是"上一轮翻 false"而非全局关闭。

### 为什么是 bug
steer/wakeup/续接是"当前工作的延续"(引擎在步间隙消费,上一轮响应还没结束),不是用户主动开的新轮。把进行中的轮瞬间折叠是突兀的视觉跳变。

### 修复
注入的 user 消息带 `injected: true`(`types.ts:1041` 已有)。在 `foldTurnProcess` 计算 `lastTurnStart` 时**跳过 injected 的 user 消息**:一个 injected 消息不开启"新的一轮",它归属到它前面那一轮里(内容内联跟在原轮后)。这样上一轮保持 isLive 不折叠,注入文本作为该轮内续接显示。

具体:`lastTurnStart` 取"最后一个**非 injected** user 消息"的下标;`userIdxs` 的分组边界也把 injected user 视为轮内内容而非边界(否则会切出一个空的 injected 轮)。需保证:injected user 仍作为 user bubble 显示(不吞掉文本),只是不作为轮边界/不折叠上一轮。

### 测试(streamGroups.test.ts)
- 一个正在流的轮 + append 一个 injected user → 上一轮仍 `isLive: true`(不折叠)。
- 一个正常完成的轮 + append 一个**非 injected** user(真新轮)→ 上一轮 `isLive: false`(正常折叠,回归)。
- injected user 的文本仍出现在 stream items 里(不丢)。

---

## 实现顺序
1. 折叠 bug(独立、影响面小、先验证)→ commit。
2. 定时续接重构(删 headless isResume 分支 + main executor 分流 inject)→ commit。

两条各自 TDD + 回归。core 改动需 rebuild(desktop 从 dist 引 core)。
