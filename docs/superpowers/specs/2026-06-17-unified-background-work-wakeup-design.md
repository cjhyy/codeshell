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
- 但 goal 裁判需要「列出本 session 在跑的后台任务」喂 LLM(§3 goal 段)。视频 poll 是 detached promise——靠 `backgroundJobRegistry` 才能列出它。**决策**:**保留 `backgroundJobRegistry`**,从 `engine.ts` 的 park 路径摘除,降级为「纯登记表」,供 `listRunningBackgroundWork` 列视频任务用(需给它补一个「列当前 jobs(带描述)」的方法,目前只有 `hasRunningForSession`)。

> 注:这一步没有完全消灭 `backgroundJobRegistry`,但把它从「驱动引擎 park」降级为「纯登记表供 goal 裁判列任务」。完全消灭它需要让视频 poll 走 shell-manager 式可查询登记,属可选进一步收敛,本设计不强制。

### headless 收尾谓词

**headless 收尾等待只等 sub-agent** —— 直接用**已有的** `asyncAgentRegistry.hasRunningForSession(sid)`,**不含 shell、不含 video**:
- 不含 shell:永不退的 dev server shell 不能让 headless 永等。
- 不含 video:视频是长渲染任务,headless 一次性 run 不该为它干等几分钟;video 完成走通知唤醒即可(headless 默认不等视频)。
- 只有后台 sub-agent 的 summary 是「本次 run 结果」的一部分,headless 不等齐就残缺——故只等它。
- 无需新建谓词,复用现成 API。

### `goal-stop-hook`:从「机械短路」改为「喂信息给 LLM 裁判分辨」

**问题**:旧短路 `if (hasRunningBackgroundWork(sid)) return {}` 用机械布尔判定「有后台工作就允许 stop 歇着」。但**dev server 这种永不退的 shell 也是后台工作** → 短路永久生效 → goal 永远判不了、AI 永远歇着、目标永不推进。「会结束的下载」和「常驻的 dev server」机械上分不开。

**解法(让 LLM 自己分辨)**:删掉机械短路,改成把**当前在跑的后台任务清单**喂进 goal 裁判,让裁判 LLM 自己判断「是否只差等一个**会结束**的任务」:

- 裁判 verdict 从 `{met, gaps}` 扩成 **`{met, gaps, waiting}`** 三态:
  - `met:true` → 目标达成,允许 stop(同今天)。
  - `waiting:true` → 目标未达成,但**剩下的唯一工作是等一个会结束的后台任务**(下载/视频/会退出的脚本),它完成会唤醒我 → **允许 stop、不 push**(返回 `{}`,等通知唤醒)。
  - 两者皆 false(`not_met`)→ 还有 AI 能主动做的事 → `continueSession`(同今天)。
- 裁判输入新增「当前后台任务」段:列出 `{kind, 描述}`(sub-agent / video / shell+命令)。dev server 那条命令(如 `bun run dev`)摆在裁判面前,LLM 自然判它「不是会结束的任务、不是目标的一部分」→ 不会因为它而 `waiting`,goal 照常裁判目标本身。
- JUDGE_SYSTEM 增补:解释三态语义 + 「常驻服务(dev server/watch)不算‘在等的任务’,目标不依赖它就照常判达成与否」。

**为什么比机械谓词好**:下载 shell(会结束)在跑 → LLM 判 `waiting`、歇着等唤醒;dev server(常驻)在跑 → LLM 判它无关、正常裁目标。一个 LLM 判断替掉「含 shell 会卡死 / 不含 shell 下载又被逼」的两难。

---

## 4. 接线点(精确改动清单)

1. **`packages/core/src/runtime/background-shell.ts`** — 已有 `listForSession(sessionId)`(返回 running shell 列表带命令);goal 裁判用它列 shell 任务。无需新增谓词。

2. **新增 `listRunningBackgroundWork(sid)`**(放新 helper 或 `background-jobs.ts`)= sub-agent(`asyncAgentRegistry.listForSession`)+ video(`backgroundJobRegistry` 当前 job 列表)+ shell(`backgroundShellManager.listForSession`)→ 统一成 `{kind, description}[]` 喂 goal 裁判。headless 收尾**不用它**,直接用现成 `asyncAgentRegistry.hasRunningForSession(sid)`。(注:`backgroundJobRegistry` 需补一个「列当前 jobs」的方法,目前只有 `hasRunningForSession`。)

3. **`packages/core/src/engine/engine.ts`** — 删 `stillRunning()`/`for(;;)`/`waitForBackgroundAgentChange`/相关 subscribe;top-level run 结束改为触发 run-边界 re-check(见 #5)。

4. **`packages/core/src/protocol/chat-session.ts`** — `pump()` 的 `finally` 里(run 真正结束、`active=null` 之后),触发一次「run 边界 re-check」回调。chat-session 不该直接依赖 server,故:暴露一个 `onTurnSettled` 回调(构造期注入),或让 server 在 `enqueueTurn().then/finally` 里调 `maybeWakeIdleSession(sid)`。**决策**:server 持有 session,最简单——在 server 所有 `enqueueTurn(...)`(handleRunMulti + 唤醒自身)的 `.finally` 里调 `maybeWakeIdleSession(sid)`。这样 run 边界 re-check 完全在 server 层,chat-session 不动。

5. **`packages/core/src/protocol/server.ts`**:
   - **交互式路径**:`handleRunMulti` 的 `enqueueTurn(...).then(...)` 加 `.finally(() => this.maybeWakeIdleSession(sid))`(触发点 B,run 边界 re-check)。`maybeWakeIdleSession` 自身的 `enqueueTurn` 也加同样 `.finally`(链式:被唤醒的 run 结束后再 re-check,cover 顺序任务)。
   - **headless 路径**(`session.engine.isHeadless()`):`handleRunMulti` 在返回前加「await 到后台 sub-agent 归零」收尾循环(§5):`do { drain+summarize 一轮 } while (asyncAgentRegistry.hasRunningForSession(sid))`,然后才把完整 `result` 作为 RPC 响应返回。**只等 sub-agent**(不等 shell/video)。这条**复用** `maybeWakeIdleSession` 的 drain/summarize 逻辑(可抽成共用的 `drainAndSummarizeOnce(sid)`),只是 headless 同步 await、交互式异步靠触发点回来。
   - bus 订阅维持现状(触发点 A),不再需要 filter agent 事件——agent 也走这条了。

6. **`packages/core/src/hooks/goal-stop-hook.ts`** — 删机械短路;裁判 verdict 扩成三态 `{met, gaps, waiting}`;裁判输入新增「当前后台任务清单」段;`waiting:true` → 返回 `{}`(允许 stop 等唤醒,不 push)。任务清单来源:`listRunningBackgroundWork(sid)` = sub-agent(`asyncAgentRegistry.listForSession`)+ video(`backgroundJobRegistry` 列表)+ shell(`backgroundShellManager.listForSession`,带命令文本好让 LLM 认出 dev server)。`extractJson` 解析 `waiting` 字段(缺省 false)。

7. **`packages/core/src/tool-system/builtin/agent.ts`** — 保留所有 `notificationQueue.enqueue`(completed/failed/handoff 四处);它们现在经触发点 A/B 被消费。无需改。

---

## 5. B2.2 语义变化:headless 用统一谓词 await 收尾(不是保留旧 park)

**变化**:后台 sub-agent 的 summary 从「父 `engine.run` **返回前**在同 run 内产生」变成「父 run **返回后**、被唤醒的下一轮产生」。

**根因**:`result.text` 在返回那一刻不含后台 sub-agent 汇总,因为它还没跑完。

**两种调用模型的诉求不同**:
- **交互式 desktop**:有一个长期挂着的 session(UI)接住后续每一轮唤醒。run 提交即返回,后台 sub-agent 完成→唤醒下一轮 summarize→照常 stream 到同 session,用户看得到。**不需要在 run 返回里等**。
- **headless / automation**(`automation-host.ts`:173、`handleRunMulti`:339 把 `result.text` 当最终结果):是「调一次 run、拿 result、结束」的一次性模型,**没有后续轮的接住者**。后台 sub-agent 即便被唤醒跑了一轮,那轮结果也没人读(调用方已 return)。所以 headless 必须**在返回前等到后台工作全清空**,result 才完整。

**关键:headless 完全能知道「还有没有后台子 agent 在跑」** —— 现成 `asyncAgentRegistry.hasRunningForSession(sid)`。

**处置(定稿,非二选一)**:headless 和交互式**共用同一套唤醒机制**,唯一区别是 headless 在 run 返回前加一个**基于统一谓词的 await 收尾**:

```
// headless-only 收尾(交互式不包这层,直接返回让 UI 接):
do {
  唤醒/summarize 一轮(drainAll 通知 → turnLoop.run)
} while (asyncAgentRegistry.hasRunningForSession(sid))
return result   // 此刻后台 sub-agent 归零,result 含其汇总,完整
```
> 等待条件**只看后台 sub-agent**(`asyncAgentRegistry.hasRunningForSession`):不含 shell(dev server 永不退,会让 headless 永等),不含 video(长渲染,headless 不为它干等;video 走通知唤醒)。只有 sub-agent summary 属于本次 run 结果。

这与旧 `for(;;)` **逻辑等价**,但**不再是引擎里写死的特例**:它复用同一个 drain/summarize 步骤 + 现成 `asyncAgentRegistry.hasRunningForSession`,只是 headless 多包一层「await 到 sub-agent 归零」。旧 `for(;;)` + `stillRunning()` + `waitForBackgroundAgentChange` **可以删干净**。

**因此 §3「删 `for(;;)`」成立**:删的是「引擎对所有 run 无条件 park」这件事;headless 的「等齐 sub-agent」改由 server 层在 `handleRunMulti` 的 `isHeadless()` 分支用 await 表达。交互式路径无此 await,纯靠触发点 A/B 唤醒。

---

## 6. 测试影响

- **`tests/engine-goal-background-video.test.ts`**:判据从「引擎内 `backgroundJobRegistry.hasRunningForSession` + completed 计数」改为「通知唤醒后 goal 推进 / 第 2 个视频经唤醒提交并完成」。需重写为 server 层唤醒驱动。
- **`tests/goal-stop-hook.test.ts`**:旧「机械短路」两例删除;新增三态裁判例——(a) 后台有下载 shell + 目标未达成 → 裁判 `waiting:true` → 返回 `{}`(允许 stop,不 push);(b) 后台只有 dev server shell(命令含 `dev`)+ 目标本身已达成 → 裁判 `met:true`(不因 dev server 而 waiting);(c) 无后台任务 + 未达成 → `not_met` → continueSession。用 scripted judge LLM 返回对应 JSON 验证三分支。
- **sub-agent 相关测试**:验证父 run 返回后,sub-agent 完成经触发点 A/B 唤醒一轮 summarize(交互式路径);headless 路径 await 到 `asyncAgentRegistry.hasRunningForSession` 归零、result 含汇总才返回。
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
- seedance 视频 skill 优化——无关,另议。

## 9. 风险

- **最高**:B2.2 语义变化(后台 sub-agent summary 移到后续轮)。交互式靠触发点 A/B 唤醒补上;headless 靠「await `asyncAgentRegistry.hasRunningForSession` 归零」收尾保证 result 含 sub-agent 汇总。无独立 park 机制,复用统一 drain/summarize。
- 删 `for(;;)` 是引擎核心控制流改动,blast radius 大;必须全套 core 测试 + run-边界 re-check 新测试 + headless await-收尾测试 + 真机冒烟。
- run-边界 re-check 的链式 `.finally`(交互式)/ headless await 循环若实现错(漏触发 / 死循环 / 空转)会让顺序任务卡住或烧 turn;新测试钉死:交互式单发=1、顺序=2;headless 有后台 sub-agent 时 result 含汇总且不死循环。
- headless await 循环的终止保证是**结构性**的:只等后台 sub-agent(`asyncAgentRegistry`,terminal),**不含 shell**(dev server 永不退会让 headless 永等)、**不含 video**(长渲染,headless 不为它干等)。不依赖 `allowBackgroundShells` 配置。
- **谓词职责分清**:headless 收尾用现成 `asyncAgentRegistry.hasRunningForSession`(仅 sub-agent);goal 裁判用 `listRunningBackgroundWork`(agent∪shell∪video 清单)喂 LLM。
- **goal 三态裁判依赖模型守规矩**:`waiting` 误判两个方向——(a) 把 dev server 误当「在等的任务」→ goal 永 waiting 不推进(缓解:JUDGE_SYSTEM 明示常驻服务不算 + 命令文本给 LLM 看);(b) 把真该等的下载误判 `not_met` → 退回 sleep 自旋(缓解:同今天的 maxStopBlocks + run 预算兜底,自旋有上限不会无限烧)。比旧机械短路灵活但多一个模型判断点;scripted-judge 测试钉死三分支,真机另验。
