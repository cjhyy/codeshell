# Goal 续跑机制重新设计（TODO 3.1 修订）

日期：2026-06-07
对照参考：Codex (`/Users/admin/codex/codex-rs`) 的 turn 循环与 pending_input 续跑模型

---

## 0. 问题陈述（来自 code-review）

当前 goal 模式有 **5 个互相独立的停止维度**，而「续跑（TODO 3.1）」只接到了其中
1~3 个，且**接错了最常触发的那个**：

| 维度 | 触发 | 终态 | 默认值 | 续跑能影响吗 |
|------|------|------|--------|--------------|
| maxTurns | turnCount ≥ maxTurns | max_turns | **300** | ✅ addTurns |
| goal token 预算 | tokensUsed > tokenBudget | goal_budget_exhausted | 无（可选） | ✅ addTokenBudget（但 seed 有 bug） |
| goal time 预算 | elapsed > timeBudgetMs | goal_budget_exhausted | 无（可选） | ⚠️ addTimeBudgetMs（**seed-from-0 bug → 秒停**） |
| **maxStopBlocks** | stopBlockCount ≥ cap | completed + `exhausted` | **25** | ❌ **不可续，且是终态** |
| judge 判定 | on_stop continueSession=false | completed(met) | — | ❌ |

**核心矛盾**：UI 的「再续 N 轮」按钮挂在 `approaching_limit`，而该事件只在
`turnsRemaining === 2`（即 maxTurns=300 时的第 298 轮）触发。但一个反复被裁判
block 的目标，会先撞上 `maxStopBlocks=25` 而 `exhausted`（终态、直接 return、
extend() 也无法抬高它）。**结果：真正掐死目标的限制永远不给续跑入口；给了续跑
入口的限制几乎永远不触发。**

外加 4 个具体 bug（详见 review）：
- B1 时间预算 seed-from-0：续时间预算反而秒停。
- B2 approaching_limit 同轮被 not_met 剪掉 → 按钮闪现即消失。
- B3 maxStopBlocks 默认 8→25 误伤非 goal 会话（插件 on_stop 钩子循环 25 次）。
- B4 附件错误吞掉（属另一 feature，本方案不含，单独修）。

---

## 1. 设计取向（已与用户确认）

参考 Codex 后确定三条原则：

1. **续跑作用于「卡住」这一个统一信号**，而不是 5 个维度各接各的。
   maxTurns 和 maxStopBlocks 都是「可能卡住」的表现，approaching_limit 在
   **任一**限制临近时都发出；extend() 能同时抬高 maxTurns **和** maxStopBlocks。

2. **吸收 Codex 的「续跑 = 注入输入」思想做底层**。Codex 没有计数器，靠
   pending_input 队列：用户随时往运行中的 turn 塞输入，下一次采样前合并。
   我们保留计数器作兜底（无人值守安全网），但让「续跑」语义上等价于
   「告诉循环：我还想让你继续，把卡住计数清零、把上限抬高」——即 extend() 既
   抬上限又重置 stopBlockCount（已有），并新增可选的 `injectMessage`（向运行
   中的 run 注入一条用户指引，复用现有 inject 通道）。

3. **maxStopBlocks 保留但可续 + 修默认值**：goal 用 25，非 goal 用更紧的默认
   （或不启用），避免 B3 的误伤。

提醒时序：**提前发 + 持久化**（`>=` 而非 `===`；not_met 不剪 approaching_limit）。

---

## 2. 统一的「卡住信号」模型

引入一个纯函数，把「离任一硬上限还有多远」归一化成一个信号：

```ts
// goal.ts 新增
export interface LimitProximity {
  /** 离 maxTurns 还剩几轮（maxTurns - turnCount）。 */
  turnsRemaining: number;
  /** 离 maxStopBlocks 还剩几次连续 block（maxStopBlocks - stopBlockCount）。 */
  stopBlocksRemaining: number;
  /** 任一维度进入「临近」阈值即为 true。 */
  approaching: boolean;
  /** 哪个维度最先到（用于 UI 文案与续跑默认值选择）。 */
  nearest: "turns" | "stopBlocks";
}

/** 临近阈值：离上限还剩这么多就提醒。turns 用 5，stopBlocks 用 3。 */
export const APPROACH_TURNS = 5;
export const APPROACH_STOP_BLOCKS = 3;

export function limitProximity(
  turnCount: number,
  maxTurns: number,
  stopBlockCount: number,
  maxStopBlocks: number,
): LimitProximity {
  const turnsRemaining = maxTurns - turnCount;
  const stopBlocksRemaining = maxStopBlocks - stopBlockCount;
  const turnsNear = turnsRemaining <= APPROACH_TURNS;
  const blocksNear = stopBlocksRemaining <= APPROACH_STOP_BLOCKS;
  return {
    turnsRemaining,
    stopBlocksRemaining,
    approaching: turnsNear || blocksNear,
    // stopBlocks 几乎总是先到（25 vs 300），优先报它。
    nearest: blocksNear ? "stopBlocks" : "turns",
  };
}
```

**为什么是纯函数**：和现有 `resolveMaxTurns`/`applyGoalExtension` 一致——
engine、turn-loop、测试三方对同一算术达成一致，可单测。

---

## 3. 逐处改动

### 3.1 `goal.ts` — 修 B1（时间预算 seed）+ 新增统一信号

**B1 修复**：`applyGoalExtension` 的时间分支从 `?? 0` 改为 `?? nowMs - startedAtMs`
的等价物。但 `applyGoalExtension` 是纯函数、拿不到 startedAtMs，所以新增一个
`elapsedMs` 入参（和 `tokensUsed` 对称）：

```ts
export function applyGoalExtension(
  currentMaxTurns: number,
  goal: GoalConfig | undefined,
  tokensUsed: number,
  elapsedMs: number,        // ← 新增，与 tokensUsed 对称
  ext: GoalExtension,
): { maxTurns: number; tokenBudget?: number; timeBudgetMs?: number } {
  ...
  if (typeof ext.addTimeBudgetMs === "number" && ext.addTimeBudgetMs > 0) {
    // 修复 B1：未设上限时从「已耗时」起算，保证新上限在当前用量之上，
    // 与 token 分支（?? tokensUsed）对称。原来 ?? 0 会让长跑任务秒停。
    timeBudgetMs = (timeBudgetMs ?? elapsedMs) + Math.floor(ext.addTimeBudgetMs);
  }
  ...
}
```

调用方 `TurnLoop.extend()` 传 `Date.now() - this.goalTracker.startedAtMs`。
（注：goal.ts 注释里「seeded ABOVE current usage」从「谎言」变成「事实」。）

新增 `limitProximity` + 常量（见 §2）。

### 3.2 `turn-loop.ts` — extend() 抬 maxStopBlocks + 统一提醒

**(a) extend() 支持抬高 maxStopBlocks**（修「不可续」）：

`GoalExtension` 新增 `addStopBlocks?: number`。`extend()`：

```ts
extend(opts: GoalExtension): { maxTurns; tokenBudget?; timeBudgetMs?; maxStopBlocks } {
  const elapsedMs = this.goalTracker ? Date.now() - this.goalTracker.startedAtMs : 0;
  const next = applyGoalExtension(this.config.maxTurns, this.goalTracker?.goal,
    this.goalTracker?.tokensUsed ?? 0, elapsedMs, opts);
  this.config = { ...this.config, maxTurns: next.maxTurns };

  // 新增：抬高 maxStopBlocks 上限（真正掐死目标的那个维度）。
  const curCap = this.config.maxStopBlocks ?? GOAL_DEFAULT_MAX_STOP_BLOCKS;
  const nextCap = opts.addStopBlocks && opts.addStopBlocks > 0
    ? curCap + Math.floor(opts.addStopBlocks) : curCap;
  this.config = { ...this.config, maxStopBlocks: nextCap };

  if (this.goalTracker) { /* 同现状更新 budgets */ }

  // 任一续跑动作都重置卡住计数，让刚续的 run 不被立刻重新打死。
  // 原来只有 addTurns 才重置 → 仅续 budget/stopBlocks 时仍被秒停。修复。
  if ((opts.addTurns && opts.addTurns > 0)
   || (opts.addStopBlocks && opts.addStopBlocks > 0)
   || (opts.addTokenBudget && opts.addTokenBudget > 0)
   || (opts.addTimeBudgetMs && opts.addTimeBudgetMs > 0)) {
    this.stopBlockCount = 0;
  }
  return { ...next, maxStopBlocks: nextCap };
}
```

**(b) 统一的 approaching_limit 发出**（修 B2 时序 + #5 接错限制）：

把现状 `turnsRemaining === 2` 的单点触发，改成在 §2 的统一信号上触发，
**两处发射点**——turn 顶（看 turns）和 stop-block 累加后（看 stopBlocks）：

- 删掉 turn 顶 `turnsRemaining === 2` 里那段 goal_progress 发射（line ~378-387）。
  保留给模型的 2 轮警告（那是给模型的，不动）。
- 新增：每轮 goal run 用 `limitProximity(...)` 算一次；若 `approaching` 且本轮
  **尚未**发过 approaching_limit（用一个 `this.approachAnnounced` 去重，met/
  exhausted/续跑后重置），就发一次：

```ts
if (this.config.goal) {
  const prox = limitProximity(this.turnCount, this.config.maxTurns,
    this.stopBlockCount, this.config.maxStopBlocks ?? GOAL_DEFAULT_MAX_STOP_BLOCKS);
  if (prox.approaching && !this.approachAnnounced) {
    this.approachAnnounced = true;
    this.config.onStream?.({
      type: "goal_progress",
      status: "approaching_limit",
      round: this.stopBlockCount,
      turnsRemaining: prox.turnsRemaining,
      stopBlocksRemaining: prox.stopBlocksRemaining,   // ← 新字段
      nearest: prox.nearest,                            // ← 新字段
    });
  }
}
```

在 stop-block 累加分支（line 630 后）也跑一遍同样的检查——这样「反复被裁判
block 接近 25 次」时就会发提醒，**在 exhausted 终态之前**。续跑成功（extend
重置 stopBlockCount）时把 `this.approachAnnounced = false`，允许下次再提醒。

> `round` 字段语义混淆（review 附带项）：approaching_limit 的 `round` 现在带的
> 是 stopBlockCount，与其他 status 的「第 N 轮」语义不一致。新增的
> `stopBlocksRemaining`/`turnsRemaining`/`nearest` 字段承载真实信息后，UI 不再
> 读 approaching_limit 的 `round`，歧义消除。

**(c) 修 B3 默认值误伤非 goal**：

问题根：`engine.ts:1686` 对**所有** run（含非 goal）调
`resolveMaxStopBlocks(undefined, undefined)` → 返回 25。改 `resolveMaxStopBlocks`：
非 goal 场景回退到一个更紧的 `INTERACTIVE_DEFAULT_MAX_STOP_BLOCKS = 8`（保持
历史行为），只有 goal 才用 25：

```ts
export const GOAL_DEFAULT_MAX_STOP_BLOCKS = 25;
export const INTERACTIVE_DEFAULT_MAX_STOP_BLOCKS = 8;  // 非 goal 回退（修 B3）

export function resolveMaxStopBlocks(configMaxStopBlocks, goal): number {
  if (typeof configMaxStopBlocks === "number" && configMaxStopBlocks > 0)
    return Math.floor(configMaxStopBlocks);
  if (goal?.maxStopBlocks && goal.maxStopBlocks > 0) return goal.maxStopBlocks;
  return goal ? GOAL_DEFAULT_MAX_STOP_BLOCKS : INTERACTIVE_DEFAULT_MAX_STOP_BLOCKS;
}
```

（turn-loop 里 `?? GOAL_DEFAULT_MAX_STOP_BLOCKS` 的兜底保留——只在 config 完全
没传时生效，正常路径都经 resolveMaxStopBlocks。）

### 3.3 `types.ts`（core）— StreamEvent 扩字段

goal_progress 的 approaching_limit 增加 `stopBlocksRemaining?` 和
`nearest?: "turns" | "stopBlocks"`。

### 3.4 `types.ts`（desktop renderer）— 修 B2 剪枝

`applyStreamEvent` 的 goal_progress 剪枝：**只在 met/exhausted/续跑成功时**剪掉
旧的 approaching_limit，**not_met 不剪**（not_met 表示「还在干、还没到上限」，
提醒应继续在）：

```ts
case "goal_progress": {
  const msg: GoalProgressMessage = { ...带新字段 };
  // 修 B2：only prune when the moment truly passed. not_met 表示仍在推进，
  // 临近提醒应保留；met/exhausted 才说明上限维度已结算/已停。
  const shouldPrune = event.status === "met" || event.status === "exhausted";
  const base = shouldPrune
    ? state.messages.filter(m => !(m.kind === "goal_progress" && m.status === "approaching_limit"))
    : state.messages;
  // 永远不堆叠两个 approaching_limit：若本条就是 approaching_limit，先去重旧的。
  const deduped = event.status === "approaching_limit"
    ? base.filter(m => !(m.kind === "goal_progress" && m.status === "approaching_limit"))
    : base;
  return { ...state, messages: [...deduped, msg] };
}
```

GoalProgressMessage 同步加 `stopBlocksRemaining?` / `nearest?`。

### 3.5 `GoalProgressView.tsx` — 文案按 nearest + 去掉本地 state

- 文案：`nearest === "stopBlocks"` 时显示「目标接近续跑上限 · 还剩 N 次」，
  否则「目标接近轮次上限 · 还剩 N 轮」。
- 续跑默认值：按 nearest 选——stopBlocks 临近时按钮发 `{addStopBlocks: 15}`，
  turns 临近时发 `{addTurns: 50}`（也可两者都加，见 §4 协议）。
- **去掉本地 `extended` useState**（review 简化项）：点击后不靠组件 state 记忆，
  靠 §3.4 的剪枝——续跑成功后 met/not_met 事件到来时这条 approaching_limit 自然
  被替换/保留，避免 remount 后 state 重置导致重复续跑。点击后用 disabled 乐观
  禁用即可（一次性，无需持久 state）。

### 3.6 协议 / preload / engine — 透传 addStopBlocks

`GoalExtension` 加 `addStopBlocks?`；engine.extendGoalRun、chat-session、
server.handleGoalExtend、preload goalExtend、types.d.ts 的 opts 都加这个字段
（纯透传，跟现有 addTurns 一样）。

**顺带修 review #7（handleGoalExtend 无 legacy 兜底）**：给 handleGoalExtend 补
和 handleCancel 一样的「无 chatManager → 用 legacyEngine」回退分支，保持协议一致。

---

## 4. 续跑按钮的新语义

approaching_limit 携带 `nearest`，按钮据此给「对症」的默认续跑量：

| nearest | 按钮文案 | 续跑 opts |
|---------|----------|-----------|
| `turns` | 「再续 50 轮」 | `{ addTurns: 50 }` |
| `stopBlocks` | 「再续 15 次」 | `{ addStopBlocks: 15 }` |

（实现上可以两个都给一点冗余，例如 stopBlocks 临近时 `{addStopBlocks:15, addTurns:50}`，
反正 extend 重置 stopBlockCount，多给无害。）

这样无论目标是被 maxTurns 还是 maxStopBlocks 逼停，用户都能在**终态之前**收到
一个**对症**的续跑入口——彻底解决「按钮挂错限制」。

---

## 5. 不在本方案内（单独处理）

- **B4 附件错误吞掉** + 扩展名集合不一致（ico/svg/bmp/avif）：属 TODO 2.1 拖拽
  feature，与 goal 无关，单独一个改动。
- **#8 activeTurnLoop 单字段并发**：当前由「一 Engine 一串行 ChatSession」保证
  安全，是潜在隐患非现行 bug。若将来做 headless 并发共享 Engine 再处理（按
  sessionId/runId keying）。本方案不动。
- **migrate-config 未接线（#6）**：与 goal 无关，单独修或删。
- **Codex 式 pending_input 全量重构**：用户选了「1 也要 2 也要」，本方案已吸收
  Codex 的「续跑=让循环继续 + 清零卡住计数」思想，但**不做** turn-loop 的队列化
  大重构（风险过高、收益边际）。extend() 新增的可选 `injectMessage`（向运行中
  run 注入用户指引）作为「注入」思想的轻量落地，可放二期。

---

## 6. 测试计划（TDD）

新增/修改（均在 `packages/core/src/engine/goal.test.ts` + turn-loop on-stop 测试）：

1. `applyGoalExtension` 时间分支：无 timeBudgetMs + elapsedMs=120000 + add=60000
   → timeBudgetMs=180000（**不是** 60000）。**这条会先红**（暴露 B1），再改实现转绿。
2. `applyGoalExtension` 新增 addStopBlocks 入参不影响 budgets。
3. `resolveMaxStopBlocks`：无 goal → 8；有 goal 无 override → 25；override 优先。
   （**会红**：现状非 goal 返回 25。）
4. `limitProximity`：turns 临近 / stopBlocks 临近 / 都不临近 / nearest 选择。
5. TurnLoop.extend：addStopBlocks 抬高 cap 且重置 stopBlockCount；仅 addTimeBudgetMs
   也重置 stopBlockCount（**会红**：现状只有 addTurns 重置）。
6. TurnLoop goal_progress：stopBlocks 接近 cap（如 25 中第 22 次 block）发出
   approaching_limit（带 nearest="stopBlocks"），且在 exhausted 之前。
7. desktop applyStreamEvent：not_met 到来时 approaching_limit **保留**；met/exhausted
   到来时被剪。（**会红**：现状 not_met 也剪。）

先写 1/3/5/7 这几条「会红」的，确认复现 bug，再改实现。

---

## 7. 改动文件清单

| 文件 | 改动 |
|------|------|
| `packages/core/src/engine/goal.ts` | applyGoalExtension 加 elapsedMs 入参修 B1；新增 limitProximity + 常量；resolveMaxStopBlocks 非 goal 回退 8 修 B3；GoalExtension 加 addStopBlocks |
| `packages/core/src/engine/turn-loop.ts` | extend() 抬 maxStopBlocks + 任一续跑动作重置 stopBlockCount + 传 elapsedMs；统一 approaching_limit 发射（两点）+ approachAnnounced 去重；删旧 turnsRemaining===2 发射 |
| `packages/core/src/types.ts` | goal_progress approaching_limit 加 stopBlocksRemaining/nearest |
| `packages/core/src/engine/engine.ts` | extendGoalRun opts 加 addStopBlocks（透传） |
| `packages/core/src/protocol/chat-session.ts` | extendGoalRun opts 加 addStopBlocks |
| `packages/core/src/protocol/server.ts` | handleGoalExtend 透传 addStopBlocks + 补 legacyEngine 回退（#7） |
| `packages/desktop/src/preload/index.ts` + `types.d.ts` | goalExtend opts 加 addStopBlocks |
| `packages/desktop/src/renderer/types.ts` | GoalProgressMessage 加字段；applyStreamEvent 剪枝改为只 met/exhausted 剪（B2） |
| `packages/desktop/src/renderer/messages/GoalProgressView.tsx` | 按 nearest 选文案与续跑量；去本地 extended state |
| `packages/desktop/src/renderer/App.tsx` | extendGoal 接受 opts（可带 addStopBlocks） |
| 测试 | goal.test.ts + turn-loop on-stop 测试新增 §6 用例 |

core 改完记得 rebuild（tui/desktop 引 dist）。
