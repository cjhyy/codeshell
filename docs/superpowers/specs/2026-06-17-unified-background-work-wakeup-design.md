# 统一后台工作唤醒路设计稿

**日期**: 2026-06-17
**状态**: 待 review
**前置**: `[[project_background_shell_no_wakeup]]`(后台 shell 唤醒已实现并 commit 27f6b0db)、`[[project_goal_background_busywait_bug]]`(视频停泊方案)、`[[project_persistent_goal_design]]`(goal 跨 turn 持久)

---

## 1. 问题与目标

### 现状:三种后台工作,三套机制,两条回收路径

系统里有三种「提交后异步跑、完成时发完成通知」的后台工作,本质相同,却被分散处理:

| 后台工作 | 进哪个 registry | 引擎是否 park | 完成怎么回到模型 |
|---|---|---|---|
| 后台 sub-agent(`run_in_background` Agent) | `asyncAgentRegistry` | **park**(同 run 内 summarize) | 引擎 `for(;;)` wait-loop 的 run-end `drainAll` |
| GenerateVideo poll | `backgroundJobRegistry` | **park** | 同上 |
| 后台 shell(`run_in_background` Bash) | (无) | 不 park | server `maybeWakeIdleSession` 通知唤醒(已实现) |

每加一种后台工作就要在 `engine.ts stillRunning()` + `goal-stop-hook` 短路 + wait-loop 三处各补一刀。历史上这是**三次同源 bug**:
- sub-agent 通知没人 drain → run 假完成(s-mpvf4rsj)
- 视频不在 registry → goal 逼 AI `sleep` 自旋烧 537 万 token(s-mqe0ox7n)
- 后台 shell 不在任何机制 → 下载完不唤醒(s-mqgienyz)

### 治本目标

收敛成 **CC 的单一原则**:任何后台工作都「**提交 → 让出 turn(run 结束)→ 完成事件唤醒空闲引擎跑一轮**」,**永不 park**。三套机制合一:

- 一条回收路:`maybeWakeIdleSession`(server)成为唯一的后台工作回收入口。
- 删掉 `engine.ts` 的 `for(;;)` 停泊循环 + `stillRunning()` + `waitForBackgroundAgentChange`。
- 删掉 `backgroundJobRegistry`(视频不再需要被引擎 park 而注册;goal 短路改用统一谓词)。
- `goal-stop-hook` 短路查统一的「本 session 有后台工作在跑」谓词。

调研依据(见 §7):CC 永不 park turn,一律 end-and-resume;实践界共识是「don't busy-poll, suspend & wake-on-event」。

---

## 2. 关键洞察:通知不丢,只差「在 run 边界 drain 一次」

`notificationQueue` 是**持久的 per-session 桶**——`enqueue` 后一直留着直到有人 `drainAll`。所以后台工作在父 run **还在跑(busy)**时完成,通知**稳稳躺在队列里,一条不丢**。

当前两个 drain 触发点:
1. **bus 事件** → `maybeWakeIdleSession`:`isBusy()` 为 true 时跳过(不 drain),且**之后不再 re-check**。
2. **引擎 `for(;;)` 的 run-end `drainAll`**(engine.ts:2040):**无条件执行**,是 busy 期间完成的通知的兜底。

→ 全量统一删掉 `for(;;)` 后,触发点 2 没了。若仅靠触发点 1,一条 busy 期间完成、且其后无新 bus 事件的通知就**没人去 drain**(消息在,但永远在等)。

**解法(钥匙)**:在**每个 run 结束的边界**补一次 `maybeWakeIdleSession(sid)`。run 结束 → session 变 idle → 主动 re-check 一次:queue 有躺着的通知就 drain + 唤醒,没有就干净结束。被唤醒的那一轮又可能 spawn 新后台任务,完成又发通知,run 再结束又 re-check……**事件驱动 + run-边界 re-check 两个触发点喂给同一个唤醒函数**,天然取代 `for(;;)` 外层循环(原二阶 bug——summarize turn 提交第 2 个任务——被同一机制 cover)。

---

## 3. 架构

### 唯一回收路:`maybeWakeIdleSession`,两个触发点

```
后台工作完成
  → notificationQueue.enqueue(item, sid)   [sub-agent / video / shell 都一样]
  → agentNotificationBus.publish(sid, evt)

触发点 A(事件):bus 订阅 → maybeWakeIdleSession(sid)
触发点 B(边界):每个 top-level run 结束 → maybeWakeIdleSession(sid)

maybeWakeIdleSession(sid):
  if 不是 chatManager 路径: return
  if session 不存在 / isBusy(): return        // busy → 等触发点 B 在 run 结束时再来
  if wasCancelledSinceLastTurn(): return       // 用户 Stop 抑制
  pending = notificationQueue.drainAll(sid)
  if pending 空: return
  session.enqueueTurn(<system-reminder 含 pending>, {onStream})  // 唤醒一轮,goal 仍裁判
```

触发点 A 处理「run 已经 idle 时完成」(下载场景);触发点 B 处理「busy 时完成、run 刚结束变 idle」(sub-agent / 顺序视频场景)。两者都 drain 同一个队列,`drainAll` 原子性保证不重复消费。

### `engine.ts` 简化

- **删**:`stillRunning()`、`for(;;)` 外层循环、`while(waitForBackgroundAgentChange)`、`waitForBackgroundAgentChange` 方法、对 `asyncAgentRegistry`/`backgroundJobRegistry`/`notificationQueue` 的 subscribe。
- top-level run 的尾部(`isTopLevel` 块)替换为:run 正常结束后,**让 chat-session 层在 run 边界触发 re-check**(见 §4 接线点)。
- **保留**:`asyncAgentRegistry`(sub-agent 仍需登记以做并发上限、AgentStatus 展示、cancel);只是引擎不再据它 park。

### `backgroundJobRegistry` 处置

- 视频不再需要被引擎 park,故 `start/finish` 的「让引擎等待」职责消失。
- 但 goal 短路仍需「本 session 有后台工作在跑」信号。**方案**:删 `backgroundJobRegistry`,改用统一谓词 `hasRunningBackgroundWork(sid)`:
  - `asyncAgentRegistry.hasRunningForSession(sid)`(已有)
  - `||` `backgroundShellManager.hasRunningTaskForSession(sid)`(**新增**,见 §4)
  - `||` 视频:视频 poll 是 detached promise,删 registry 后无登记。**保留一个极小的 `backgroundJobRegistry` 仅供此谓词查询**(不再驱动 park),或把视频也纳入一个轻量「running video jobs」集合。**决策**:保留 `backgroundJobRegistry` 但**只用于 `hasRunningBackgroundWork` 查询**,从 `engine.ts` 摘除对它的 park 依赖。这样视频在跑时 goal 短路仍能看到它(防自旋),而引擎不再 park。

> 注:这一步没有完全消灭 `backgroundJobRegistry`,但把它从「驱动引擎 park 的双重身份」降级为「纯查询表供 goal 短路」。完全消灭它需要让视频 poll 也走 shell-manager 式的可查询登记,属可选进一步收敛,本设计不强制。

### `goal-stop-hook` 短路

```
if (sessionId && hasRunningBackgroundWork(sessionId)) return {};  // 允许 stop,不判 goal,不逼自旋
```

`hasRunningBackgroundWork` = agent ∪ shell ∪ video(见上)。shell 和 video 对 goal 一视同仁。

---

## 4. 接线点(精确改动清单)

1. **`packages/core/src/runtime/background-shell.ts`** — 新增 `hasRunningTaskForSession(sessionId): boolean`:遍历 `this.shells`,`s.sessionId === sid && (status==="running"||status==="starting")`。(注:命名用 `...TaskForSession` 以区别 dev server 永不退——但本谓词只服务 goal 短路,dev server 在跑时 goal 短路也该允许 stop,所以**包含**所有 running shell 是正确的。)

2. **新增统一谓词** `hasRunningBackgroundWork(sid)` — 放 `tool-system/builtin/background-jobs.ts` 或新 helper:agent ∪ shell ∪ job。

3. **`packages/core/src/engine/engine.ts`** — 删 `stillRunning()`/`for(;;)`/`waitForBackgroundAgentChange`/相关 subscribe;top-level run 结束改为触发 run-边界 re-check(见 #5)。

4. **`packages/core/src/protocol/chat-session.ts`** — `pump()` 的 `finally` 里(run 真正结束、`active=null` 之后),触发一次「run 边界 re-check」回调。chat-session 不该直接依赖 server,故:暴露一个 `onTurnSettled` 回调(构造期注入),或让 server 在 `enqueueTurn().then/finally` 里调 `maybeWakeIdleSession(sid)`。**决策**:server 持有 session,最简单——在 server 所有 `enqueueTurn(...)`(handleRunMulti + 唤醒自身)的 `.finally` 里调 `maybeWakeIdleSession(sid)`。这样 run 边界 re-check 完全在 server 层,chat-session 不动。

5. **`packages/core/src/protocol/server.ts`**:
   - `handleRunMulti` 的 `enqueueTurn(...).then(...)` 加 `.finally(() => this.maybeWakeIdleSession(sid))`。
   - `maybeWakeIdleSession` 自身的 `enqueueTurn` 也加同样 `.finally`(链式:被唤醒的 run 结束后再 re-check,cover 顺序任务)。
   - bus 订阅维持现状(触发点 A),不再需要 filter agent 事件——agent 也走这条了。

6. **`packages/core/src/hooks/goal-stop-hook.ts`** — 短路改用 `hasRunningBackgroundWork(sid)`。

7. **`packages/core/src/tool-system/builtin/agent.ts`** — 保留所有 `notificationQueue.enqueue`(completed/failed/handoff 四处);它们现在经触发点 A/B 被消费。无需改。

---

## 5. B2.2 语义变化与调用方影响(必须正视)

**变化**:sub-agent 的 summary 从「父 `engine.run` **返回前**在同 run 内产生」变成「父 run **返回后**、被唤醒的下一轮产生」。

**受影响调用方**(已核查):
- `server.ts handleRunMulti`(:339)把 `result.text` 作为 RPC 响应返回。
- `automation-host.ts`(:173)用 `result.text` 作为 headless run 结果。

**影响**:迁移后,有后台 sub-agent 的 run,其 `result.text` 在返回时**尚不含** sub-agent 的 summary(summary 在后续被唤醒的 run 里)。对**交互式 desktop** 无碍(后续唤醒的 turn 照常 stream 到同一 session,用户看得到)。对 **headless/automation** 有实质影响:headless run 返回的 text 不再包含 sub-agent 结果汇总。

**处置选项**(需 review 拍板):
- (a) **headless 保留 park**:`isHeadless()` 的 run 仍走旧 `for(;;)` 等待(headless 无「空闲被唤醒」概念,本就该等齐再返回);只有交互式 chatManager 路径走唤醒。→ 引擎保留一条精简的 headless-only 等待,交互式走唤醒。**推荐**:语义最稳,headless 调用方零影响。
- (b) headless 也唤醒,automation-host 改成等到 session 真正 idle 且队列空再收尾。→ 改动大,automation 语义重写。

**推荐 (a)**:全量统一只覆盖**交互式 chatManager 路径**;headless 保留「run 内等齐」语义。这样 §1 表里三种后台工作在交互式下合一,headless 不受 B2.2 语义变化冲击。

---

## 6. 测试影响

- **`tests/engine-goal-background-video.test.ts`**:判据从「引擎内 `backgroundJobRegistry.hasRunningForSession` + completed 计数」改为「通知唤醒后 goal 推进 / 第 2 个视频经唤醒提交并完成」。需重写为 server 层唤醒驱动。
- **`tests/goal-stop-hook.test.ts`**:短路两例改用 `hasRunningBackgroundWork`(mock agent/shell/job 任一在跑)。
- **sub-agent 相关测试**:验证父 run 返回后,sub-agent 完成经触发点 A/B 唤醒一轮 summarize(交互式路径);headless 路径仍 run 内等齐(若选 (a))。
- **新增** run-边界 re-check 测试:busy 期间 enqueue 通知 → run 结束 → 自动唤醒一轮 drain 之(钉死「不靠后续 bus 事件也能 drain」)。
- 回归:`background-shell.engine-regression.test.ts`(dev server 不让 turn 永不收尾)——删 `for(;;)` 后更要确认 dev server 永不进任何 park、永不唤醒。
- 全套 core 必须 0 fail;core rebuild(dist 被 desktop/tui import)。

---

## 7. 调研依据(CC/Codex)

- CC 永不 park turn,一律 **fire-and-forget + 完成 enqueue 通知 + idle 时 drain 成新 turn**(`docs/superpowers/specs/2026-05-20-bg-agent-completion-notification-design.md` 四件套:LocalAgentTaskState/completeAgentTask/enqueueAgentNotification/useQueueProcessor)。
- 同步 sub-agent「block」只是 tool call 未返回(同 turn tool_result),非 parked LLM turn;CC 超时自动转后台(=本仓库 autoBgMs)。
- 实践界共识:durable suspend/resume、wait-for-event,**不要 busy-poll**(Inngest / Google ADK event-loop & pause-resume)。
- 调研结论:**单一 submit→yield→wake 路 + 每个 job 带 `terminal`/`sessionId` 两个标志**,而不是靠"碰巧多个 registry"。本设计的统一谓词 + run-边界 re-check 即此原则的落地。

## 8. 非目标 / 后续

- 完全消灭 `backgroundJobRegistry`(让视频 poll 走 shell-manager 式可查询登记)——可选进一步收敛,本轮不做。
- headless 也迁唤醒(§5 选项 b)——本轮不做,保留 park 语义。
- seedance 视频 skill 优化——无关,另议。

## 9. 风险

- **最高**:B2.2 语义变化波及 automation/SDK(§5),靠「headless 保留 park」隔离。
- 删 `for(;;)` 是引擎核心控制流改动,blast radius 大;必须全套 core 测试 + run-边界 re-check 新测试 + 真机冒烟。
- run-边界 re-check 的链式 `.finally` 若实现错(漏触发 / 死循环)会让顺序任务卡住或空转;新测试钉死单发=1、顺序=2。
