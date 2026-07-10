# Goal exhausted 后 `activeGoal` 残留并反复 re-arm：代码级根因分析

> 调查范围：`packages/core` 的 session 持久化、Engine goal 解析、TurnLoop goal 判定、
> GoalStopHook、协议唤醒链路及相关测试。本文只做调查和修复建议，不包含代码修改。

## 结论摘要

这是两个相互衔接、但位于不同层面的生命周期缺口：

1. **终止没有落到持久化 goal 状态。** `goal_progress: exhausted` 只是 TurnLoop 发出的
   流事件。stop-block 达上限后，TurnLoop 没有调用任何清 goal 回调，反而以通用的
   `reason: "completed"` 返回；Engine 随后把同一份仍含 `activeGoal` 的 `SessionState`
   写回。因此 `status: "completed"` 和 `activeGoal` 同时存在完全符合当前代码路径，
   并非 JSON 写入失败。
2. **下一次 arm 只看 `activeGoal` 是否存在，不看 goal 是否曾终结。** 新 run 按
   `options.goal -> session.state.activeGoal -> config.goal` 解析 goal；没有 goal 终结态
   guard。每个 run 又创建新的 `TurnLoop`，其 `stopBlockCount` 从 0 开始，所以第一次
   `not_met` 必然再次显示 `round: 1`。

简化为一句话：**A 让一个已经 exhausted 的 goal 仍然保持“可 arm”的持久化形状，B
又把“存在”直接等同于“仍 active”。**

`session-manager.cleargoal-stale-writeback.test.ts` 揭示的 detached-state 覆盖是相关的
第二种风险，但不是解释本次 00:42 现场所必需的原因：本次路径中首先就没有发生 clear；
不是“clear 成功后又被覆盖”。

## 运行时证据复核

### 历史现场

用户提供的现场快照中：

- `state.status === "completed"`；
- `state.activeGoal` 仍存在；
- `activeGoal.setAtMs === 1783619507739`，对应日志中第二次 `goal_set` 的时间
  `2026-07-09T17:51:47.740Z`（日志第 460 行附近）。

日志中的关键序列为：

| 时间（日志原始 UTC） | 事件 | 日志行 |
|---|---|---:|
| 2026-07-10 00:42:05.723 | `goal_progress(exhausted, round=25)` | 5150 |
| 2026-07-10 00:42:05.740 | `turn_complete(reason=completed)` | 5152 |
| 2026-07-10 00:59:01.671 | `goal_progress(not_met, round=1)` | 5163 |
| 2026-07-10 01:37:47.344 | `goal_progress(not_met, round=1)` | 7733 |
| 2026-07-10 02:03:07.162 | `goal_progress(not_met, round=1)` | 8594 |
| 2026-07-10 02:39:33.283 | `goal_progress(not_met, round=1)` | 9180 |
| 2026-07-10 02:50:36.955 | `goal_progress(not_met, round=1)` | 10016 |
| 2026-07-10 03:04:05.115 | `goal_progress(not_met, round=1)` | 10661 |

日志在第二次 `goal_set` 之后没有 `goal_cleared`；唯一的 `goal_cleared` 在更早的第一
个 goal 上（日志第 431 行），随后第 460 行又设置了本次问题中的新 goal。

### 现场可变性说明

调查期间该真实会话仍被继续使用。再次读取 `state.json` 时，文件已在
`2026-07-10 11:10:04 +0800` 被后续 run 改成 `status: "completed"` 且不再含
`activeGoal`。因此本文把用户提供的 state 内容视为 00:42 后的历史快照，并用追加式
日志验证该快照对应的行为；不把 11:10 的后续状态反推到早先现场。

### 现有测试验证

定向运行以下 4 个测试文件，结果为 15 pass / 0 fail：

- `turn-loop-goal-lifecycle.test.ts`
- `session-manager.cleargoal.test.ts`
- `session-manager.cleargoal-stale-writeback.test.ts`
- `session-manager.readgoal.test.ts`

这组测试确认了当前契约，而不是否定 bug：

- stop-block 达上限的测试明确把当前终止原因固定为 `completed`，同时只断言发出了
  `goal_progress: exhausted`，没有断言持久化 goal 被清除
  （`packages/core/src/engine/turn-loop-goal-lifecycle.test.ts:158-203`，尤其
  `:184-194`）。
- Engine 持久化测试只覆盖 `complete_goal` 和确认的 `cancel_goal` 会清除
  `activeGoal`（同文件 `:248-329`）；没有 exhausted 后不再继承的回归用例。

## 当前数据模型为何容许矛盾状态

`SessionState.status` 表示“上一 run 的终止原因”，不是 goal 的生命周期状态。
`SessionStatus` 的注释和类型都如此定义：除 `active` / `paused` 外，其余值对应最近一次
run 的 `TerminalReason`（`packages/core/src/types.ts:191-199`）。

另一方面，`activeGoal` 只是一个 `GoalConfig`。它包含 objective、预算、轮次上限和
`setAtMs`，但没有 `active/exhausted/met/cancelled` 状态，也没有持久化 round
（`packages/core/src/engine/goal.ts:14-50`；`packages/core/src/types.ts:286-295`）。

所以当前持久化模型中没有约束要求：

```text
session.status == completed  =>  activeGoal 必须为空
```

事实上该约束也不能简单成立：goal judge 若判断“只需等待有限后台任务”，会允许本 run
结束但故意保留 goal，以便后台任务完成后唤醒并继续
（`packages/core/src/hooks/goal-stop-hook.ts:342-360`；
`packages/core/src/protocol/server.ts:231-242`）。因此普通 `completed` 不能等价为
“goal 已完成”。

## 根因 A：exhausted/completed 后为什么没有清 `activeGoal`

### 1. 谁设置和写回 `activeGoal`

显式 goal 进入 Engine 后会被规范化、补上 `setAtMs`、赋给
`session.state.activeGoal`，然后立即 `saveState`
（`packages/core/src/engine/engine.ts:2049-2067`）。

运行过程中，Engine 的 turn-boundary heartbeat 反复保存整份 `session.state`
（`packages/core/src/engine/engine.ts:2177-2215`）。run 返回后，Engine 又设置
`session.state.status = result.reason`，再保存同一整份对象
（`packages/core/src/engine/engine.ts:2371-2384`）。底层 `saveState` 是把整个对象
JSON 序列化后 tmp+rename，不做字段级 merge、版本比较或 CAS
（`packages/core/src/session/session-manager.ts:499-510`）。

因此最终谁决定 `activeGoal` 是否还在，不是 `status` 字段，而是最终保存的那份内存
`SessionState` 有没有先被清掉该字段。

### 2. 当前有哪些清除责任方

| 清除入口 | 触发条件 | 清除代码 |
|---|---|---|
| judge 判定完成 | `GoalStopHook` 得到 `verdict.met === true` 后调用 `onMet` | Hook：`packages/core/src/hooks/goal-stop-hook.ts:328-339`；Engine 回调：`packages/core/src/engine/engine.ts:2075-2083` |
| 模型主动完成 | 本 run 调用了 `complete_goal` | `packages/core/src/engine/turn-loop.ts:1159-1176`，经 `clearPersistedGoal` 落盘：`packages/core/src/engine/engine.ts:2135-2147` |
| 模型确认取消 | 调用了 `cancel_goal` 且 `confirm === true` | `packages/core/src/engine/turn-loop.ts:1179-1194`，使用同一 `clearPersistedGoal` |
| 显式 RPC/UI clear | `Engine.clearGoal(sessionId)` | `packages/core/src/engine/engine.ts:2862-2888` |
| 无 live worker 的磁盘 clear | `SessionManager.clearActiveGoal(sessionId)` | `packages/core/src/session/session-manager.ts:431-465` |

没有一个入口是“只要 session 最终 status 为 completed 就清”。这是合理的，因为
`completed` 还覆盖普通交互完成和上述 waiting 场景。

### 3. exhausted 路径漏在哪里

本次日志中的 exhausted 来自 stop-block cap：

1. judge 仍返回未达成，因此 Hook 返回 `continueSession: true`
   （`packages/core/src/hooks/goal-stop-hook.ts:366-381`）。这当然不会进入 `onMet`。
2. TurnLoop 发现 `stopBlockCount >= maxStopBlocks`，只发送
   `goal_progress { status: "exhausted" }` 和一条说明消息
   （`packages/core/src/engine/turn-loop.ts:997-1017`）。
3. 该分支**没有**调用 `this.deps.clearPersistedGoal`，也没有返回 goal 专属的终结元数据。
4. 随后代码重置 `stopBlockCount` 并返回
   `{ reason: "completed" }`（`packages/core/src/engine/turn-loop.ts:1027-1032`）。
5. Engine 只把这个通用 reason 写进 `state.status`；因为
   `session.state.activeGoal` 从未被改动，最终 `saveState` 又将它原样写回
   （`packages/core/src/engine/engine.ts:2371-2384`）。

这就是 `status: "completed"` 与旧 `activeGoal` 并存的确切路径。`exhausted` 只存在于
`StreamEvent` 联合类型中（`packages/core/src/types.ts:477-495`），并没有进入
`SessionState` 或 `TerminalReason`。测试还明确固定了“exhausted 流事件 + completed
终止原因”的当前组合（`packages/core/src/engine/turn-loop-goal-lifecycle.test.ts:184-194`）。

另一个类似缺口是 run 级 token/time budget：TurnLoop 返回
`goal_budget_exhausted`，但同样不调用清除回调
（`packages/core/src/engine/turn-loop.ts:906-925`）。它不是本次日志中的分支，但修复时
必须统一决定所有 goal 强制终止原因的语义，避免只补 stop-block cap。

### 4. stale writeback 在这里扮演什么角色

`SessionManager.clearActiveGoal` 会从磁盘解析出一个新的 detached state，清字段后保存。
如果 live run 仍持有旧 state 对象，它后续保存整份对象时可把 goal 复活。现有测试完整
复现了这个 last-writer-wins 问题
（`packages/core/src/session/session-manager.cleargoal-stale-writeback.test.ts:41-55`）。

当前 `Engine.clearGoal` 已针对 live run 做了局部防护：优先取得
`activeRunSession`，直接清除 loop 正在保存的同一个对象，再落盘
（`packages/core/src/engine/engine.ts:2864-2878`；该 live bundle 的设计说明在
`:407-417`）。

对本次证据应作如下区分：

- **直接根因是漏清除。** exhausted 分支根本没发起 clear，日志中第二个 goal 之后也
  没有 `goal_cleared`；不需要 stale overwrite 就能得到现场 state。
- **stale writeback 是修复时必须避免的放大器。** 如果未来在另一个 detached copy 上
  补 clear，而 live bundle 的 heartbeat/final save 仍持有 goal，修复会被悄悄覆盖。
  所以“立刻清”必须操作同一 live state，或引入能抵御旧写入的 revision/tombstone。

## 根因 B：为什么每次新 turn 都重新 arm，并从 round 1 开始

### 1. 唤醒 turn 没有携带新 goal，但会继承持久化 goal

后台通知唤醒路径调用 `session.enqueueTurn(...)`，只传 `injected` 和 `onStream`，没有
传 `goal`（`packages/core/src/protocol/server.ts:278-302`）。`ChatSession` 再把
`next.opts.goal` 原样传给 `engine.run`，此时仍是 `undefined`
（`packages/core/src/protocol/chat-session.ts:211-229`）。

这本应是无 goal 的普通 turn，但 Engine 的持久化 goal 解析规则明确为：

```text
explicitGoal ?? storedGoal ?? config.goal
```

对应代码是 `packages/core/src/engine/engine.ts:2040-2068`。只要 stale
`session.state.activeGoal` 还在，bare send、恢复和后台唤醒都会得到
`normalizedGoal`。

### 2. arm 判定没有终结态 guard

Engine 仅检查 `normalizedGoal` 是否非空；满足后便创建并注册新的 GoalStopHook
（`packages/core/src/engine/engine.ts:2068-2094`），再把它放入新 TurnLoop 的 config
（`packages/core/src/engine/engine.ts:2107-2176`）。这里没有读取：

- 前一 run 的 `status`；
- 前一 run 是否发过 `goal_progress: exhausted`；
- goal 自身的终结状态——因为该字段根本不存在。

Hook 的 `isGoalActive` 也只是
`readActiveGoal(sid) !== undefined`（`packages/core/src/engine/engine.ts:2085-2090`）。
Hook 内部的 mid-run guard 同样只在持久化 goal 已不存在时放行
（`packages/core/src/hooks/goal-stop-hook.ts:191-205`）。所以 stale `activeGoal` 对所有
这些判断都等价于“仍 active”。

`status: "completed"` 也无法自然挡住 arm：

1. 语义上它只是上一次 run 正常结束，并不证明 goal met；waiting goal 也会正常结束。
2. 技术上 `SessionManager.resume` 读盘后会无条件把内存中的 `state.status` 改为
   `"active"`（`packages/core/src/session/session-manager.ts:467-496`），Engine 随后在
   resume 路径马上保存该 active 状态
   （`packages/core/src/engine/engine.ts:1492-1497`）。
3. goal 解析代码本身无论如何都不检查 status。

因此问题既包含“stale activeGoal 被写回/保留”，也包含“arm 前缺少 goal 终结态 guard”；
不是二选一。前者提供了错误输入，后者让错误输入无条件生效。

### 3. round 为什么必然重置

`round` 来自 `TurnLoop.stopBlockCount`。它是实例字段，初始化为 0
（`packages/core/src/engine/turn-loop.ts:220-225`），没有持久化到 `SessionState`。
每次 `Engine.run` 都创建一个新 `TurnLoop`
（`packages/core/src/engine/engine.ts:2107-2108`），并创建一个新的 run-scoped
goal budget tracker（`packages/core/src/engine/turn-loop.ts:565-575`）。

新 run 第一次被 judge 阻止停止时，代码先把 0 加到 1，再发
`goal_progress(not_met, round=1)`
（`packages/core/src/engine/turn-loop.ts:962-971`）。上一个 run 结束时还会把计数清零
（`:1027`）。

所以 round 重置不是 writeback 把计数覆盖了，而是当前设计明确把 round 定义成
**run-scoped、非持久化**计数。真正的 bug 是已经终结的同一个 persisted goal 又启动了
一个全新 run。

## 生命周期时序：期望与实际

| 阶段 | 当前代码 | 期望的终结语义 | 本次实际结果 |
|---|---|---|---|
| set | 显式 goal 写入 `state.activeGoal`，补 `setAtMs`，立即保存并发 `goal_set` | goal 成为唯一 active goal | 正常 |
| arm | 每个 run 用 explicit/stored/config 解析；stored 存在即注册 Hook、构造 goal TurnLoop | 只允许 lifecycle 为 active 的 goal arm | 没有 lifecycle guard |
| progress | `not_met` 时 `stopBlockCount++`，发 round N 并继续 | run 内递增 | 首个 run 到 25 |
| exhausted | 达 cap 时只发 `goal_progress(exhausted)` | 将该 goal 清除，或持久化标为 exhausted/不可自动 arm | 未清除、未标记 |
| complete | TurnLoop 返回通用 `completed` | Engine 应知道这是 goal exhaustion，而不是普通 completed/waiting | 终结原因丢失在流事件里 |
| expected clear | 在 live session state 上清 `activeGoal`，再进行最终保存 | 下次 storedGoal 为空 | 完全没有执行 |
| final writeback | Engine 写 `status = completed` 并保存整份 state | 保存已清理或已标终结的 goal 状态 | 把旧 `activeGoal` 原样保留 |
| wake/new turn | 唤醒不传新 goal | 不再进入 goal mode | Engine 从 storedGoal 重新 arm |
| new round | 新 TurnLoop 的计数从 0 开始 | 不应出现新 goal round | 再次发 `round=1` |

## 修复方向一：终结时立刻清 `activeGoal`

这是最小、最直接的修复方向，适合产品语义为“exhausted 代表这个 goal 已结束，不再自动
续跑”的情况。

建议：

1. **让 TurnLoop 把 goal 终结原因结构化地交给 Engine。** 可以在 stop-block cap 分支
   调用现有 `clearPersistedGoal`，也可以让 `TurnLoopResult` 携带明确的
   `goalTermination: "stop_blocks_exhausted"`，由 Engine 统一清除。后者能让持久化副作用
   继续归 Engine 管理，边界更清楚。
2. **清除必须发生在 Engine 最终 `saveState` 之前，并操作 live run 的同一份
   `session.state`。** 这沿用 `activeRunSession` 修复 stale-writeback 的原则，不能只对
   detached disk copy 调 `clearActiveGoal`。
3. **不要按 `result.reason === "completed"` 一刀切清 goal。** `completed` 同时覆盖普通
   非 goal turn、judge met、stop-block exhausted，以及等待有限后台任务的暂停点。必须
   依据显式 goal 终结原因清除。
4. **统一定义所有强制终止分支。** 至少检查 stop-block exhausted、
   `goal_budget_exhausted`、goal-mode `max_turns`。如果三者都表示 goal 已终结，应都清；
   如果某些只表示“本 run 暂停”，则不能删除，而应进入方向二的持久化状态机。
5. **避免清掉并发替换的新 goal。** 最稳妥是给 goal 增加 `goalId`/revision；最低限度也
   应按本 run 捕获的 `setAtMs + objective` 比较后再清，防止旧 run 的终结回调删除刚被
   用户替换的新 goal。

优点是存量读取逻辑天然安全：`activeGoal` 不存在就不会 arm。缺点是 exhausted 的上下文
若还要供“继续/续额”使用，需要另存历史记录，不能再把它留在名为 `activeGoal` 的字段中。

## 修复方向二：arm 前增加 goal 终结态 guard

如果产品希望保留 exhausted goal 供用户查看、手动续跑或增加预算，就应把“保存 goal
内容”和“允许自动 arm”拆开，而不是继续让 `activeGoal` 的存在性承担两种语义。

建议：

1. **持久化 goal 专属 lifecycle。** 例如：

   ```ts
   goalState: {
     id: string;
     config: GoalConfig;
     status: "active" | "met" | "cancelled" | "exhausted";
     terminalReason?: "stop_blocks" | "token_budget" | "time_budget" | "max_turns";
   }
   ```

   也可以保留 `activeGoal`，另加以 goal revision 为键的 terminal tombstone；关键是终结态
   必须持久化并与具体 goal 实例绑定。
2. **在 Engine 的 goal resolution/Hook 注册之前做权威 guard。** 只有 status 为
   `active` 才能成为 `normalizedGoal`。server 的 wakeup 层可额外跳过无 armable goal 的
   自动唤醒，但不能只修 server，因为普通用户 bare send 也会走同一继承路径。
3. **不要用 `SessionState.status === "completed"` 代替 goal guard。** 它语义过宽，且
   resume 会先改成 active。guard 必须读 goal 自己的终结态。
4. **对旧/损坏 state 做防御性收敛。** 如果发现同一 goal revision 已有 terminal
   tombstone 却仍带 `activeGoal`，应拒绝 arm，并可惰性清理 stale 字段。这样即使旧的
   whole-state writer 把 goal 写回来，也不会再次执行。
5. **若允许用户“续跑”，续跑必须显式创建新 active revision。** 可保留 objective 和
   原终结原因用于 UI，但新的 run 应有新 revision、重新设定预算/round，而不是让后台
   任意通知自动复活旧 goal。

这一方向比“立即删除”改动大，但能同时表达“已 exhausted、仍可查看”和“禁止自动
re-arm”。实际工程上两条路最好组合：终结时立即移出 `activeGoal`，同时保留独立历史
状态；arm 处再用 lifecycle guard 做纵深防御。

## stale writeback 的配套加固建议

无论采用哪条主修复路径，都建议降低 whole-state last-writer-wins 的风险：

- 给 `SessionState` 增加单调 revision，保存时做 compare-and-swap；
- 或提供字段级原子更新，使普通 heartbeat 不再携带并覆盖自己不拥有的 goal 字段；
- 或把 goal 状态拆到独立、带 revision/tombstone 的持久化记录；
- 保留并扩展现有“必须清 live bundle”的回归测试。

现有 tmp+rename 只防止文件撕裂，不防止语义上的旧版本覆盖新版本。

## 建议补充的回归测试

1. Engine 级：`maxStopBlocks` exhausted 后，最终 state 不含 armable goal；下一次 bare
   send 不注册 goal hook、不发新的 `goal_progress round=1`。
2. Engine 级：明确覆盖 `goal_budget_exhausted` 和 goal-mode `max_turns` 的既定产品
   语义。
3. Engine/Hook 级：`waiting:true` 且确有有限后台任务时仍保留 active goal，避免把所有
   `completed` 都错误清除。
4. 恢复级：构造历史问题形状 `{ status: "completed", activeGoal: ... }` 加 terminal
   marker，验证 resume/wakeup 不 arm，并按策略惰性清理。
5. 并发级：goal A 终结时用户已替换为 goal B，A 的回调不得清掉 B。
6. stale-writeback 级：detached writer 在 terminal clear/tombstone 之后保存旧 state，
   goal 不能复活。

## 最终判定

- **问题 A 的确切根因：** stop-block exhausted 分支没有执行任何持久化 goal 终结
  transition；它把 goal 终结只作为瞬时 stream event 表达，随后以 `completed` 返回。
  Engine 的通用 final writeback 因而保存了仍带 `activeGoal` 的 state。
- **问题 B 的确切根因：** Engine 把 `activeGoal` 的存在性当作唯一 arm 条件，没有 goal
  终结态或 guard；resume 还会把 session status 改回 active。新 run/new TurnLoop 的
  run-scoped counter 从 0 开始，故再次出现 round 1。
- **writeback 还是 guard：** 两者都存在，但职责不同。现场首次残留是“漏 clear”；
  反复执行是“缺 guard”；detached stale writeback 是已知的额外复活通道，修复时必须
  同时防住，但不是本次日志序列成立的必要条件。
