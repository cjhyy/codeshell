# `d97f95f4` goal 生命周期修复代码审查

## 结论

**NEEDS-WORK**

审查范围严格限定为 `ba8076aa..d97f95f4`。提交已经修好最初现场的主路径：stop-block
exhausted 会返回结构化 goal 终结原因，Engine 在最终 writeback 前清理 live run 持有的
同一份 `session.state.activeGoal`；bare send/resume 也会拒绝 arm 仍带匹配 tombstone 的
goal。`goal_budget_exhausted`、goal-mode `max_turns` 和 waiting 分支也分别按预期处理。

但 tombstone/identity 设计尚不能兑现提交所声称的并发与 stale-writeback 安全保证：只有
一个“最后终结 goal”槽位，旧代 goal 在后续 goal 终结后仍可被 stale writer 复活；同目标
文本的配置替换也复用 `setAtMs`，旧 run 会把替换后的 goal 当成自己的实例清掉。两项都
直接落在本次审查重点 4，因此不能 SHIP。

## Blockers

### 1. 单槽 tombstone 不能防住跨两代 goal 的 stale writeback，旧 goal 仍可重新 arm

- `packages/core/src/types.ts:296-301` 只保存一个 `goalTerminal`，注释也明确它是“Last
  force-terminated goal instance”。
- `packages/core/src/session/session-manager.ts:524-529` 只选择 incoming/disk 中时间较新的
  **一个** tombstone；只有待写 `activeGoal` 恰好匹配这一个 marker 时才丢弃它。
- `packages/core/src/session/session-manager.ts:425-428` 与
  `packages/core/src/engine/engine.ts:2052-2059` 的 read/arm guard 同样只和这个单一 marker
  比较。

因此如下合法 stale 序列仍会复活 A：

1. writer 持有 goal A 的旧 state 快照；
2. A 终结，落 `goalTerminal=A`；
3. 新 goal B 终结，单槽 marker 被更新为 `goalTerminal=B`；
4. A 的旧快照经当前版本 `SessionManager.saveState` 写回；
5. save 时只看到 marker B，A 不匹配 B，故 A 被保留；下一次 `readActiveGoal`/Engine arm
   又把 A 当 active goal。

我用当前提交代码在临时 session 中按以上顺序复现，最终状态为：

```json
{
  "activeGoal": { "objective": "A", "setAtMs": 100 },
  "goalTerminal": {
    "objective": "B",
    "setAtMs": 200,
    "reason": "max_turns_exhausted",
    "terminatedAtMs": 2000
  }
}
```

此时 `SessionManager.readActiveGoal()` 返回 A，而不是 `undefined`。这意味着问题 B 仍可
发生，新的 TurnLoop 会重新从 round 1 开始。

此外，`packages/core/src/session/session-manager.ts:515-532` 的 read-merge-write 没有 CAS
或锁。跨进程 writer 若在 terminal writer 落盘前读到旧 state、却在其后 rename，仍会把
`activeGoal` 和 `goalTerminal` 一起覆盖；真正的旧版本/foreign whole-state writer 也不会
执行这里的 merge。新增 arm-guard 测试手工写回的是“stale `activeGoal` **仍带着**
tombstone”的状态，未覆盖旧 writer 同时擦掉 tombstone 的实际形状。

建议把终结事实放入不会被普通 whole-state writer 覆盖的、按不可变 goal id/revision
索引的记录（或给 state 引入真正的单调 revision + CAS/锁/字段级原子更新）。若仍放在
`state.json`，至少不能只保留最后一个 terminal instance。

### 2. `objective + setAtMs` 不是可靠 revision；同 objective 的替换会被旧 run 误清

- `packages/core/src/engine/goal.ts:59-76` 把 `objective + setAtMs` 定义为实例 identity。
- `packages/core/src/engine/engine.ts:2062-2076` 对“same objective”继续复用 stored
  `setAtMs`；只有它恰好碰到已有 tombstone 时才 `+1`。
- `packages/core/src/engine/engine.ts:2259-2271` 的终结清理由该 identity 决定是否删除
  当前 `activeGoal`。

如果 run A 的 goal 为 `{ objective: "ship", setAtMs: 100, tokenBudget: 10 }`，另一个
writer 用显式 goal 把它更新为 `{ objective: "ship", setAtMs: 100, tokenBudget: 100 }`，
objective 未变使 `resolveGoalSetAt` 保留 100。A 随后终结时，比较函数认为新配置仍是 A，
会把用户刚写入的 goal 清除。`maxTurns`、`timeBudgetMs`、`maxStopBlocks` 的同 objective
替换同理。

新增并发测试 `packages/core/src/engine/turn-loop-goal-lifecycle.test.ts:492-534` 只用不同
objective 的 B，因此没有暴露该问题。`setAtMs` 还承担相对时间语义，不宜兼任唯一并发
revision。建议新增不可变 `goalId` 或单调 revision；每个被产品定义为“替换/重启”的显式
set 都创建新 revision，deadline anchor `setAtMs` 独立保留。

## 正确性核查

### A：终结时清 `activeGoal`

对最初事故路径，**已修好**：

- `packages/core/src/engine/turn-loop.ts:1008-1045` 在 stop-block cap 分支返回
  `goalTermination: "stop_blocks_exhausted"`，不再只发瞬时 stream event。
- `packages/core/src/engine/engine.ts:2259-2282` 在 `turnLoop.run()` 返回后立即调用
  `applyGoalTermination`，对 live run 捕获的同一份 `session.state` 写 tombstone，并在 identity
  匹配时清 `activeGoal`。
- 该步骤发生在 `packages/core/src/engine/engine.ts:2424-2437` 的最终 status/usage
  writeback 之前，因此本 run 自己的 heartbeat/final save 不会把刚清掉的 goal 写回来。

在没有上述 blocker 所描述的多代/并发覆盖时，exhausted 后 bare send 不会再出现 goal
progress，round 也不会重置为 1。新增端到端测试对此有直接断言。

### B：arm 前终结态 guard

对“`activeGoal` 与其 tombstone 同时存在”的状态，**已实现 guard**：

- Engine 在 hook 注册前清掉匹配 terminal 的 stored goal：
  `packages/core/src/engine/engine.ts:2052-2060`。
- 磁盘读取也隐藏匹配 terminal 的 goal：
  `packages/core/src/session/session-manager.ts:416-430`。

bare send、resume 和后台 wake 最终都进入这段 Engine goal resolution，因此只要 tombstone
仍在且匹配，终结态 goal 不会 arm。问题是该 guard 的事实来源可被 blocker 1 覆盖，故
只能判定为“条件成立时正确”，不是完整解决 B。

## 终结原因覆盖

本提交不是只补 stop-block；报告点名的强制终止分支均已接入统一 metadata/Engine 清理：

| 强制终止 | 代码结论 | 证据 |
|---|---|---|
| stop-block exhausted | 清 goal，reason=`stop_blocks_exhausted` | `turn-loop.ts:1008-1045` |
| goal token budget | 清 goal，reason=`token_budget_exhausted` | `goal.ts:318-329`; `turn-loop.ts:913-936` |
| goal time budget | 清 goal，reason=`time_budget_exhausted` | `goal.ts:318-329`; `turn-loop.ts:913-936` |
| goal-mode max turns | 清 goal，reason=`max_turns_exhausted` | `turn-loop.ts:1311-1368` |

Engine 对每次（包括 headless 背景结果回灌后的）`turnLoop.run` 都应用 transition：
`packages/core/src/engine/engine.ts:2281-2282,2341-2342`。

## waiting 场景核查

**没有误伤 waiting。** Goal judge 的 `waiting:true` + 确有有限后台任务会返回普通、非
`continueSession` 的 HookResult；TurnLoop 随后以 `completed` 返回但不带
`goalTermination`。Engine 只在显式 `goalTermination` 存在时清理
（`packages/core/src/engine/engine.ts:2259-2260`），没有按
`result.reason === "completed"` 一刀切。

新增测试 `packages/core/src/engine/turn-loop-goal-lifecycle.test.ts:456-490` 真实注册有限
background job，断言 run completed 后 active goal 仍在且没有 terminal marker，覆盖到位。

## 数据模型与向后兼容

- `SessionState.goalTerminal` 是 optional（`packages/core/src/types.ts:296-301`），旧
  `state.json` 缺字段时所有比较都安全返回 false，不会因反序列化而崩；这是向后兼容的
  additive change。
- `GoalTerminal.reason` 把 stop-block、token、time、max-turns 分开，诊断信息合理。
- 主要设计缺陷不是旧 state 兼容，而是 tombstone 只有一个、和可被 whole-state 覆盖的
  state 放在一起，以及 identity 没有真正 revision；见两个 blockers。
- `newestGoalTerminal` 使用严格 `incomingAt > persistedAt`
  （`packages/core/src/session/session-manager.ts:625-634`）。两个不同终结发生在同一毫秒时
  会保留 persisted marker、丢掉 incoming marker；引入单调 revision 后应一并消除该
  wall-clock tie。

## 测试充分性

新增测试覆盖良好部分：

- stop-block exhausted 后清除且 bare send 不再 arm；
- token-budget exhausted 后不再 arm；
- goal-mode max-turns 清除；
- waiting 保留；
- 不同 objective 的 A→B 替换不误删；
- 单代 tombstone + 当前版 `saveState` 的顺序 stale writeback；
- 手工构造“activeGoal 与 tombstone 并存”时的 arm guard。

明显缺口：

1. **Blocker 回归缺失：** A terminal → B terminal → stale A writer；以及 writer 同时覆盖
   `activeGoal` 和 `goalTerminal`。
2. **并发替换缺失：** same objective、不同 budget/limit 的替换不得被旧 run 清除。
3. **time budget 端到端缺失：** 现有新增 Engine 测试只覆盖 token budget；纯函数旧测试
   证明 time comparison，但没有固定 `time_budget_exhausted` tombstone/下一次不 arm。
4. **旧 state 显式回归较弱：** `session-manager.readgoal.test.ts:19-25` 间接覆盖了无
   `goalTerminal`/无 `setAtMs` 的 goal 可读，但没有 raw legacy state 经 resume + Engine
   arm 的专门用例。
5. **真实 wake 路径未单测：** bare send 与 wake 共用 Engine resolution，代码上可接受，
   但协议 notification wake 的回归测试能更直接固定事故场景。

## 验证结果

在 `d97f95f4` 工作树运行：

```text
bun test packages/core/src/engine/turn-loop-goal-lifecycle.test.ts \
  packages/core/src/session/session-manager.cleargoal.test.ts \
  packages/core/src/session/session-manager.cleargoal-stale-writeback.test.ts \
  packages/core/src/session/session-manager.readgoal.test.ts

22 pass / 0 fail / 68 expect()
```

补充运行直接受 goal helper/hook 影响的测试：

```text
bun test packages/core/src/engine/goal.test.ts \
  packages/core/src/hooks/goal-stop-hook.test.ts

58 pass / 0 fail / 99 expect()
```

测试全绿说明已覆盖路径工作，但不反驳上述未覆盖的 stale generation/concurrency 反例。

## Ship gate

在合入前至少需要：

1. 用不可变 goal id/revision 取代 `objective + setAtMs` 作为清理与 arm 的权威 identity；
2. 让 terminal lifecycle 能抵御多代 stale writer 与真正并发 whole-state writer，而非只保留
   最后一个内嵌 marker；
3. 为两个 blocker 序列补回归测试。

完成后，当前关于强制终止统一处理、waiting 保留和 live-state 清理的主体实现可以保留。
