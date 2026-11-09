# Goal 轮次与等待时间显示 · 技术方案

- 日期：2026-11-09
- 状态：已实现（分支 `claude/core/goal-rounds-wait-time-20261109`）；D1–D3 按建议确认（D3 定时回访不做）
- 基线：main `5130ee2b8`（已含 PR#312 `e19322c7f`）
- 触发：session `s-mw4q76at-82b430f2`，用户反馈“永远显示『目标未达成 · 第 1 轮』”“执行过程没有把等待时间算进去”

## 1. 现象（实测数据）

这个 session 在 11-09 用的是 Codex 外部运行时（`external-runtime.json` 里 `kind: "codex"`）。主 Codex 每次被唤醒，都会派 DriveAgent（Codex/CC）去干活，然后挂起，等后台任务完成通知再被唤醒。

| 指标 | 11-09 11:26–14:10 |
|---|---|
| 唤醒次数 / 进度条数 | 14 / 14，全部是 `round: 1` |
| 主 Codex 自己干活（14 张执行卡片“已处理”之和） | 约 33 分钟 |
| 卡片之间等后台任务的时间 | 约 131 分钟，**界面上看不到** |
| 顶部目标栏 | “目标已设置 2d”（从 11-07 设目标时算起，包含整夜闲置） |

11-08 那段走的是内置引擎，轮次显示 1→2→3→1→…→7 来回跳。

## 2. 根因

**R1 轮次是“单次运行内”的计数，不是目标级的。**

- 外部运行时：`external-runtime-goals.ts` 的 `start()` 每次唤醒都新建一个 `ExternalGoalRun`，`turns` 从 0 开始。这一轮干完后，`afterTurn()` 把 `turns` 加到 1，然后 `waitForBackgroundWork()` 用 `round: run.turns` 发出事件并挂起。所以永远显示 1。
- 内置引擎：`round = TurnLoop.stopBlockCount`。这个数是“连续几次不调工具就收尾”的计数，在 `turn-loop.ts:1278/1370` 只要这次回复里有工具调用就清零。它本来是给空转上限用的，不该拿来显示。

**R2 等待后台任务被显示成“目标未达成”。**

- 外部运行时用 `status: "not_met"` 加上 gaps 文案“等待后台任务完成…”来表示等待。界面显示“◎ 目标未达成 · 第 1 轮 — 还差：等待后台任务完成”，看起来像裁判判了没完成。
- 内置引擎走等待分支时（`goal-stop-hook.ts` 的 `waiting_on_background_task`，以及 `turn-loop.ts` 里 `met:false` 但不续跑、也没有 `waitingForUser` 的情况）**一个 `goal_progress` 都不发**。两条路径行为不一致。

**R3 没有任何地方显示等待时长，也没有目标级的“实际用时”。**

- 执行卡片的“已处理”只算这一次运行。两家竞品也是这样做的，这一点保持不变。
- 目标栏的“目标已设置 X”是 `now - setAtMs`，把暂停、等用户回复、应用关着的时间全算进去了。
- 存储里其实已经有等待起点：`goalLifecycle.phase === "waiting"` 时持久化了 `waitingSinceMs`，只是没人用。

**R4（顺带发现，需要写测试确认）合并去重的签名会撞车。**

`mergeTranscripts.ts:137` 用 `goal_progress|goalId|status|round|gaps` 当去重签名。R1 加 R2 之后，每次等待的进度条签名完全一样（round=1，gaps 相同），只在内存里的新进度条会被当成“已在磁盘上”，从而把 `lastCovered` 推后。修了 R1 之后签名自然就不同了，但还是建议把等待起点也加进签名。

## 3. 竞品对照（2026-11-09 最新代码）

来源：
- Codex：`openai/codex` main，通过 GitHub API 读取，涉及 `codex-rs/ext/goal/src/{accounting,runtime}.rs`、`tui/src/chatwidget/goal_status.rs`、`tui/src/goal_display.rs`。
- Claude Code：npm `@anthropic-ai/claude-code-darwin-arm64@2.1.319` 二进制里嵌入的 JS（只读取字符串，没有执行）。

| 维度 | Codex | Claude Code 2.1.319 | CodeShell 现状 |
|---|---|---|---|
| 单轮耗时 | “Worked for Xm”只算这一轮实际在跑的时间；弹出审批框时 `pause_timer` 暂停计时 | 只算当前这一轮 | “已处理 Xm”只算这一次运行 ✅ |
| 目标轮数 | **不显示轮数** | `activeGoal.iterations`：目标级计数，每次裁判判“未完成”+1，不会因为工具调用清零，resume 时从记录恢复；完成时显示“N turns” | 单次运行内计数 ❌ |
| 目标用时 | `time_used_seconds`：目标处于 Active 时按真实时间累计。`start_turn` 不重置基线，所以**两轮之间的空档也算**；暂停、清除或改目标时重置基线；进程重启后从当时重新计 | `now - setAt`，从设目标起的总时间（含所有空档）；/goal 面板显示“running Xm · N turns · X tokens”，每秒刷新 | `now - setAtMs` ❌ |
| 每轮的进度提示 | 状态栏只显示 active / paused / blocked / budget-limited / complete | “Goal not yet met… continuing”，**不带轮数**；完成时显示“Goal achieved (5m · 7 turns · 1.2M tokens)” | “目标未达成 · 第 N 轮 — 还差：…” |
| 后台任务运行时 | 没有挂起的概念，自动续跑 | **推迟裁判**（`[goal] evaluation deferred — background work still running`），推迟期间不计轮数。按 `CLAUDE_CODE_GOAL_CHECKIN_MINUTES × 2^n` 退避，定时注入一次“Goal check-in: background work still running … deferred for N min”，并列出在跑的任务；到上限后不再注入 | 挂起，等后台完成通知唤醒；**没有定时回访** |
| 卡住时 | 同一个阻塞原因连续 3 轮 → `blocked` | 连续拦截上限 8（`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`）→ “Goal paused · … send a message to continue” | PR#312 已对齐：上限后进入 waiting |

结论：
1. 单轮“已处理”只算本轮时间，两家都这样，不改。
2. 轮数要做成目标级累计（CC 的 iterations），不能被工具调用清零。
3. 目标用时用 Codex 的口径：只在目标“活着”的时候计时（运行中 + 等后台任务），暂停和等用户时停表。这比 CC 的 `now - setAt` 更适合我们这种目标会跨天挂着的情况。
4. 等后台任务时，要像 CC 的 check-in 那样明确告诉用户“在等什么、等了多久”。

## 4. 方案

### 4.1 语义定义

| 名称 | 口径 |
|---|---|
| **第 N 轮**（目标级） | 这个目标从设立起，自动推进的累计次数。每发生下面任一事件 +1：裁判判“未完成”后续跑（内置引擎）；外部运行时的每个 provider turn；从后台等待中被唤醒后的那次运行。**不会因工具调用、新的运行或重启而清零**；改目标（新 goalId）时清零，编辑或暂停（revision 变化）时不清零。 |
| **已处理 Xm**（每张执行卡片） | 不变，只算这一次运行的时间。 |
| **等待 Xm**（新增，等待条） | 从挂起等后台任务（`waitingSinceMs`）到被唤醒的时间。 |
| **目标用时**（目标栏） | 运行中时间 + 等后台任务的时间之和。暂停、等用户回复、应用没开时都停表。 |

**D1（需要拍板）**：被后台任务唤醒的那次运行算不算一轮？CC 推迟裁判期间不计轮数。但我们这种由后台任务驱动的目标如果不算，轮数会长时间停在 0，又会回到“看起来没进展”的问题。**建议算。**

### 4.2 数据模型

**(a) `goal_progress` 事件**（`core/src/types.ts:793`）加两个可选字段：

```ts
/** 本次是挂起等待，不是裁判判“未完成” */
waiting?: {
  kind: "background_work";
  sinceMs: number;                                   // = lifecycle.waitingSinceMs
  tasks?: Array<{ id: string; label: string }>;      // 仅用于展示，不可信文本，截断到 80 字
};
/** 目标级累计数据（覆盖 round 的显示） */
progress?: { rounds: number; activeMs: number };
```

`round` 字段保留，值改成目标级累计轮数，这样旧版界面也会显示正确的数字。`status` 仍然发 `"not_met"`，旧版界面会退化成现在的样子，不会崩。

**(b) `goalLifecycle`**（`core/src/goal/lifecycle.ts`）在顶层加两个可选字段（不放进 `config`，`config` 只存用户的设置）：

```ts
progress?: {
  rounds: number;        // 累计轮数
  activeMs: number;      // 已经结算的目标用时
};
waitKind?: "background" | "user";   // 只在 phase === "waiting" 时有意义
```

- 这次**不**新增 `waitingFor` 的枚举值。memory 里 PR#312 的教训是：旧版本的严格校验遇到不认识的值，会把整个目标丢掉。`waitKind` 是一个新的独立键，旧版 `decodeGoalLifecycle` 用已知字段重建 base，会忽略它，不会拒绝整条数据。实现前要加一个测试，确认当前 main 的解码器读到带这两个字段的数据时，目标还在。
- 降级行为：旧版本重新写入时，`progress` 和 `waitKind` 会被丢掉。后果只是计数归零，或者那段等待不计入用时，目标本身不受影响。
- `progress` 的写入**不增加 revision**。revision 是给编辑、暂停做并发控制用的。写入时用 goalId 加 revision 做期望值校验，写入路径和 `markGoalWaiting` 一样，走同一把 state 锁，带冲突重试。

**(c) 什么时候结算 activeMs**（只在已有的状态转换点结算，不需要心跳）：

| 转换 | 结算 |
|---|---|
| 运行开始（active 或从 waiting 唤醒） | 在内存里记下 `runStartedAt`；如果是从 `waitKind:"background"` 唤醒，`activeMs += now - waitingSinceMs` |
| 运行结束（任何原因：挂起、终态、中断、出错） | 一次写入：`rounds += 本次运行增加的轮数`，`activeMs += now - runStartedAt` |
| 挂起等用户、到上限暂停、手动暂停 | 设 `waitKind:"user"`，之后不计时 |
| 进程崩溃 | 这次运行的增量丢失，算偏保守，可以接受 |

### 4.3 Host 侧改动

**内置引擎（core）**
1. `run-goal.ts`：开始运行时从 lifecycle 读出 `progress`，作为 `goalProgressBase` 传给 TurnLoop。运行结束时（在 `createGoalTerminationApplier` 和 run 的 finally 里）调用新的 `SessionManager.recordGoalProgress(state, goal, delta)`。终态和挂起这两种情况，把这次写入并进 `persistGoalTerminalOutcome` 和 `markGoalWaiting`，不另外再写一次。
2. `turn-loop.ts`：新增 `goalRoundsThisRun`，在判“未完成”续跑（1584）、等待挂起、判“已完成”时 +1。所有 `goal_progress` 都发 `round = base.rounds + goalRoundsThisRun`，并带上 `progress`。**`stopBlockCount` 的语义和清零逻辑不动**，它只负责空转上限。
3. 补上等待分支的进度事件：裁判结果是 `met:false`、不续跑、也没有 `waitingForUser` 时，发 `goal_progress{ waiting:{kind:"background_work", sinceMs, tasks} }`。`tasks` 用 `goal-stop-hook` 里已有的 `runningWork`（通过 `data.goalVerdict.waitingOn` 带出来）。
4. `markGoalWaiting(state, goal, { kind })`：增加 `waitKind` 参数。等用户和到上限暂停这两条路径传 `"user"`。

**外部运行时（desktop/main）**
1. `external-runtime-goals.ts` 的 `start()`：从持久化数据读出 `progress`，记为 `run.roundBase` 和 `run.activeBaseMs`。从后台等待唤醒时，按 4.2(c) 结算等待时长。
2. `afterTurn`、`waitForBackgroundWork`、`pause` 发出的 `round` 都改成 `run.roundBase + run.turns`，并带上 `progress`。`run.turns` 继续用来判断“本轮自动继续次数上限”（`maxTurns`），不改。
3. `waitForBackgroundWork` 改发 `waiting` 字段，任务列表取自 `deps.backgroundWork`；不再用 gaps 文案冒充“未完成”。
4. 运行结束时写入 `progress`（和 `markGoalWaiting` 合并成一次写）。

**磁盘回放路径**：`desktop/src/main/transcript-reader.ts:665`、`session-transcript-cache-store.ts:588` 要把新字段原样带出来；`session-manager.ts:364` 里 `goal_progress: "copy"` 已经是整体复制，不用改。另外要确认 `output-history-comparison` 对新字段不敏感。

### 4.4 界面改动

1. **`GoalProgressView`**：增加等待样式。
   - 正在等：`⏲ 等待后台任务 · 已等 12m`，每秒刷新；悬停时列出任务（`DriveAgent(codex)：…`）。
   - 已唤醒：定格成 `⏲ 等了 20m · 2 个后台任务`。
   - 判“未完成”的样式不变，数字改用目标级累计轮数。
2. **reducer**（`renderer/types.ts:1853`）：`GoalProgressMessage` 增加 `waiting` 和 `waitEndedAtMs`。下一次运行开始时（注入的唤醒消息或 run 开始事件，实现时确认具体用哪个事件），给最后一个还没结束的等待条打上结束时间；如果下一个 `goal_progress` 先到，就用它的时间兜底。内存和磁盘回放走同一个 reducer，结果一致。
3. **目标栏 `GoalBar`**：主文案从“目标已设置 2d”改成 **“已推进 2h 44m · 第 37 轮”**。计算方式是 `progress.activeMs` 加上当前这一段：运行中从 `runStartedAt` 起算，等后台任务时从 `waitingSinceMs` 起算；暂停或等用户时不刷新。悬停时显示“目标设于 11-07 10:05”。`ActiveGoal` 增加 `rounds`、`activeMs`、`segmentStartMs`，来源是 `goal_set`、`goal_updated`、`goal_progress` 事件和持久化读取（`App.tsx:1858` 那条路径）。
4. **`mergeTranscripts` 签名**：`goal_progress` 的签名加上 `waiting?.sinceMs`（修 R4）。

### 4.5 不做的事

- **不把等待时间算进“已处理”**：两家竞品都没这么做，算进去会让人以为主模型一直在忙。
- **不做 Codex 那种按 token 预算显示**：我们的目标默认没有 token 预算。等以后有预算 UI 了再说。

## 5. 分期

| PR | 内容 | 是否改持久化格式 |
|---|---|---|
| **A** | R2、R3 前半、R4：两条路径都发 `waiting` 事件，界面加等待条和“已等/等了 Xm”，补上内置引擎缺的等待事件，修签名 | 否（`waitingSinceMs` 已经有了） |
| **B** | R1 和目标用时：lifecycle 加 `progress` 和 `waitKind`，结算逻辑，两条路径改成发累计轮数，目标栏改文案 | 是（只加可选字段） |
| C（后续，可选） | CC 那种定时回访：后台任务很久没完成时，按退避间隔唤醒一次模型，让它看看任务是不是卡住了。现在如果 DriveAgent 卡死，目标会一直挂着 | 否 |

A 和 B 互不依赖，可以并行。用户看到的“第 1 轮”只有 B 能修好，但“目标未达成”的误导 A 就能消掉。

## 6. 测试

- `lifecycle`：解码带 `progress` 和 `waitKind` 的数据（新版本）；**用当前 main 的解码器读新格式，目标不能丢**；拒绝非法值（负数、非整数的轮数）。
- `turn-loop-goal-lifecycle.test.ts`：模拟“工具调用 → 判未完成 → 工具调用 → 判未完成”，round 要依次是 1、2（现在是 1、1）；`stopBlockCount` 上限的行为不变。
- 内置引擎的后台等待分支会发出 `waiting` 事件。
- `external-runtime-goals`：模拟三次唤醒，round 依次是 1、2、3；`activeMs` 包含后台等待时间，不包含等用户的时间。
- renderer reducer：等待条在下一次运行开始时拿到 `waitEndedAtMs`；内存和磁盘回放结果一致；`mergeTranscripts` 不再吞掉内容相同的等待条。
- `GoalBar`：暂停时不刷新；等后台任务时继续计时。
- 回放 `s-mw4q76at-82b430f2` 的 transcript，人工核对：11-09 那段应显示为 14 个等待条，等待时长加起来约 131 分钟。
- 新加的 TS 测试文件要在 `tests/suites.mjs` 登记；开 PR 前跑全仓的契约和预算测试。

## 7. 待确认

- **D1**：被后台任务唤醒的那次运行算不算一轮（建议算）。
- **D2**：目标用时用 Codex 口径，即运行中加等后台任务（建议用这个），还是 CC 口径，即从设目标起的总时间。
- **D3**：C（定时回访）这次做不做（建议另开）。

## 8. 实现记录（与上文的差异）

- **轮数口径**：每个“被判定的尝试”加 1，包括判“未完成”续跑、挂起等后台任务、挂起等用户、判“已完成”。“接近上限”（`approaching_limit`）和“已耗尽”（`exhausted`）的提示只复述当前轮数，不加轮。内置引擎由 `GoalProgressMeter`（`core/src/goal/progress-meter.ts`）在 Engine 的 `prepareEvent` 里统一改写 `round` 并附上 `progress`；TurnLoop 的 `stopBlockCount` 只管空转上限，没有改动。
- **goal/get 带上 `progress`（先拆分后再加）**：`server.ts`、`preload/types.d.ts` 原本的行数预算余量为 0。先把代码抽出去，再加字段：
  - `protocol/goal-rpc.ts`：goalExtend 的校验与路由（`goalExtendOutcome`），以及 goalGet 的响应拼装（`goalGetPayload`，只有同一个 goalId 的 progress 才会附上）。`server.ts` 只负责找目标、发送，从 4949 降到 4898 行。
  - `preload/goal-control-api.ts`：5 个 goal 方法的声明和 RPC 适配集中在一处。`types.d.ts` 通过 extends 接缝组合进来，`index.ts` 展开调用，两个文件各省 58 行，从 2990 降到 2932、从 1886 降到 1828。
  - 预算测试把这三个文件的上限钉在拆分后的实测值，并写了注释。`index.internal.ts` 的导出预算 +1，用于导出 `goalGetPayload`；桌面端的断线兜底和外部运行时都复用它，顺带修了兜底路径漏返回 `setAtMs` 的问题。
  - `App.tsx` 不需要改：对账时沿用累计数据的逻辑在 reducer 里（`carryGoalClock`）。
  - 界面水合：`useTranscriptBuckets` 拿到 goalGet 后调用 `adoptPersistedGoalProgress`。没有运行在跑时，以持久化的值为准；有运行在跑时，保留回放算出来的时钟。
- **任务清单**：只有 `{kind, label}`，不带 id（`listRunningBackgroundWork` 本来就不给 id）。最多列 8 项，每项 80 字以内，经过 scrub 处理。外部运行时通过 `ExternalRuntimeBackgroundWorkDelivery.listRunning` 提供 DriveAgent 作业的标签。
- **界面时钟**（`desktop/src/renderer/goalClock.ts`）：每条进度事件带来权威值；运行开始（`session_started`）启动时钟；运行结束（`turn_complete`）停表，但正在等后台任务时继续走；暂停、等用户、清除目标时停表。等待条在下一次运行开始、出现新进度事件、暂停或清除时，打上结束时间。
- **兼容性**：已用 origin/main 的 `decodeGoalLifecycle` 实测读取带 `progress` 和 `waitKind` 的 active、paused、waiting(background/user)、terminal 五种记录，目标全部保留。
- **可以接受的近似**：从挂起写盘到运行结束有几毫秒，会被重复计入。升级前就存在的目标，持久化的累计从 0 开始。

