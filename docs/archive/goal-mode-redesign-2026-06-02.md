# Goal 模式重设计 — 对标 Codex goal 机制 (2026-06-02)

诊断 codeshell 当前 goal 模式为什么「不好用」,对照 Codex 的 goal 机制,给出改进方案。
背景:本设计服务于 [automation-plan-2026-05-31.md](./automation-plan-2026-05-31.md) 的 D6
(写型无人值守任务:读外部输入 → 改代码 → 提 PR)—— 长程无人值守任务最需要一个可靠的「盯住目标 + 预算护栏」机制。

---

## §1 codeshell 现状(基于源码,非推测)

### 实现
- **goal = 一个 string**,session 启动时传入 `config.goal`(`engine/turn-loop.ts` 读 `this.config.goal`)。
- **触发点:只在模型想停时**(`turn-loop.ts:450` `response.toolCalls.length === 0` = final answer)。
  此时跑 `on_stop` hook(`turn-loop.ts:466-487`)。
- **判定靠一个独立「裁判 LLM」**(`hooks/goal-stop-hook.ts:73-133`):给裁判喂「目标 + agent 最近输出」,
  让它返回 `{"met": bool, "gaps": string}` JSON(`goal-stop-hook.ts:49-53`)。
- **未达成 → 注入续跑消息**(`goal-stop-hook.ts:124-131`):`继续 —— 还差:{gaps}`,turn loop 再跑一轮。
- **护栏:仅 `maxStopBlocks`(默认 8)连续 block 上限**(`turn-loop.ts:464`);达上限强制停
  (`turn-loop.ts:496-511`)。
- **失败保守放行**:裁判抛错或 JSON 解析失败 → `return {}` 允许停止(`goal-stop-hook.ts:104-115`)。

### 流程图(现状)
```
模型想停(无 tool call)
   │
   ▼
on_stop hook → 裁判 LLM 二次调用:「met 了吗?」
   │
   ├─ met:true / 解析失败 / 抛错  → 允许停(completed)
   └─ met:false → 注入「还差 {gaps}」→ 再跑一轮(≤8 次)
```

---

## §2 为什么「不好用」—— 五个硬伤(逐条对照 Codex)

| # | codeshell 现状 | 问题 | Codex 怎么做 |
|---|---|---|---|
| **H1 完成判定** | 独立**裁判 LLM** 猜「met 了吗」(`goal-stop-hook.ts:87`) | 又贵又不准:每次想停都多一次 LLM 调用;裁判看不到完整执行历史(只喂了 `finalText`,`goal-stop-hook.ts:94`),判断质量差;**JSON 解析失败即放行**(`:112-115`)= goal 静默失效 | 模型**自己** `update_goal(status=Complete)` 显式声明完成(`tools/handlers/goal/update_goal.rs`)。无猜测、无额外 LLM |
| **H2 无预算护栏** | goal 只是 string,**无 token/时间预算**;唯一护栏是 `maxStopBlocks=8` 轮数 | 无人值守跑飞了**烧 token 没有任何上限**(8 次 block 是「想停被拦」的次数,不是「跑了多久」)。写型任务死循环 = 烧钱 | `ThreadGoal` 带 `token_budget`/`tokens_used`/`time_used_seconds`(`protocol/v2/thread.rs:666`);系统每个 tool 后结账,超了自动 `BudgetLimited`(`goals.rs:1094`) |
| **H3 goal 不进上下文** | goal **只在模型想停的瞬间**被裁判用一次;模型**正常跑的时候根本不知道有 goal** | 模型容易跑偏 —— 它从头到尾没被持续提醒目标是什么,只在「想交差」时被外部拦一下 | 每个 continuation turn 用 `<goal_context>` 标签、**以 user 角色**注入「目标 X,已用 N token,继续」(`context/goal_context.rs:33`)。持续提醒,不跑偏 |
| **H4 只有两态** | 裁判只输出 `met: true/false` | 模型无法表达「我被卡住了,缺前置条件」—— 要么假装完成,要么被无脑续跑到 8 次上限 | 状态机:`Active/Blocked/Complete/BudgetLimited/UsageLimited/Paused`(`goals.rs`)。模型可主动标 `Blocked`(且要求同一阻塞连续 3 turn 才允许,防滥用) |
| **H5 被动续跑** | 续跑只在「模型想停」时发生 | 如果模型**不主动停**(一直发 tool call 干别的),goal 永远不介入;goal 只能「拦停」,不能「推进」 | 系统在 turn 跑完且无新输入时**自动发起 continuation turn**(`goals.rs:1294`),主动续命直到 Complete 或预算耗尽 |

### 一句话定性
> codeshell 现在的 goal 是**「事后裁判」**:模型自管自跑,想交差时被一个外部 LLM 拦一下问「真完成了?」。
> Codex 的 goal 是**「全程伴随的自我监管」**:目标 + 预算持续在模型上下文里,完成靠模型显式声明,
> 失控有预算硬护栏,卡住能显式上报。前者对**交互式**够用,对**无人值守长程任务(D6)**几乎不可用。

---

## §3 改进方案

分两档:**P0 最小可用**(让 goal 在无人值守下安全),**P1 对齐 Codex**(完整体验)。
不必一步到位抄完 Codex;按 D6 的实际需要分期。

### P0 — 让 goal 无人值守下「安全」(最小改动,最高收益)

针对 H2(无预算)和 H1(裁判不可靠),这两条是无人值守的**安全底线**。

1. **加预算护栏(治 H2,最优先)**
   - `config.goal` 从 `string` 升为 `{ objective: string; tokenBudget?: number; timeBudgetMs?: number }`。
   - 在 turn loop 里累加 `tokensUsed` / 墙钟时间(turn-loop 已有 token 统计入口,`engine/token-budget.ts`)。
   - 超预算 → 强制终止,`TerminalReason` 加一个 `"goal_budget_exhausted"`(现有枚举 `types.ts:227`)。
   - **这一条独立成立**,不依赖其他改动 —— 先把「烧钱护栏」加上。

2. **完成判定改为「模型自报优先,裁判兜底」(治 H1)**
   - 加一个 `complete_goal` / `mark_done` 工具,模型完成时**显式调用**(对齐 Codex `update_goal`)。
     模型调了 → 直接 `completed`,不再跑裁判 LLM。
   - 保留现有裁判 hook 作**兜底**:模型没调 `complete_goal` 就想停时,才跑裁判。
     这样大多数情况省掉裁判调用,且完成信号来自模型自己(更准)。
   - **裁判失败不再静默放行成 completed**:解析失败时,若仍在预算内,改为「再问一次 / 注入提醒继续」
     而非直接放行(现状 `:112-115` 的放行在无人值守下等于 goal 失效)。

### P1 — 对齐 Codex 完整体验

3. **goal 进上下文(治 H3)**
   - 每轮(或每 N 轮)把当前 goal + 预算消耗,以 `<goal_context>` 包裹、**user 角色**注入
     (照抄 Codex `goal_context.rs:33` 的「伪装成用户提醒」技巧 —— 模型更不易忽略)。
   - 注意只注入摘要(objective + 已用/剩余预算),不灌历史,控制 token 成本。

4. **goal 状态机(治 H4)**
   - 状态:`Active / Blocked / Complete / BudgetLimited / Paused`。
   - 模型可主动标 `Blocked`(缺前置条件时),附原因 —— 无人值守下这会写进 Run 历史,
     比「无脑续跑到 8 次上限」可诊断得多。
   - 借鉴 Codex 的防滥用:`Blocked` 要求同一阻塞连续若干 turn 才采信。

5. **主动 continuation(治 H5,可选)**
   - turn 跑完且无新输入但 goal 仍 Active → 自动发起续跑 turn(对齐 Codex `goals.rs:1294`)。
   - ⚠️ 这条要谨慎:codeshell 是交互式为主,自动续跑可能打扰用户。
     **建议仅在无人值守 / headless / 定时任务下启用**(由宿主传 flag),交互式保持现状的「被动拦停」。

### 与 automation plan 的关系
- **P0(预算护栏 + 模型自报)是 D6 写型任务的前置**:无沙箱 + 无预算的无人值守写型任务 = 一把上膛的枪。
  建议把 P0 列为 automation-plan Phase 5(写型任务)的依赖项。
- P1 是体验增强,可在写型任务跑通后再补。

---

## §4 不抄 Codex 的地方(明确取舍)

- **不抄「一个 thread 只能一个 active goal」的硬限制** —— codeshell 有 RunManager 多 run 并发,
  goal 应**绑定到 run/session 维度**,而非全局单例(Codex 是 thread 内单 goal)。
- **不抄完整的 6 态机**(P0 阶段) —— 先上 `Active/Complete/BudgetLimited` 三态够用,
  `Blocked/Paused` 等 P1 再加,避免过度设计。
- **continuation 默认关**(见 P1 第 5 条) —— Codex 默认自动续跑因为它本就偏 agent 自主;
  codeshell 交互式场景下默认关,无人值守才开。

---

## §5 现状文件清单(改动定位)

| 关注点 | 文件 | 行 |
|---|---|---|
| goal 模式裁判 hook | `packages/core/src/hooks/goal-stop-hook.ts` | 73-133 |
| on_stop seam / maxStopBlocks 续跑 | `packages/core/src/engine/turn-loop.ts` | 450-514 |
| TerminalReason 枚举(加 budget_exhausted) | `packages/core/src/types.ts` | 227-236 |
| token 统计入口 | `packages/core/src/engine/token-budget.ts` | — |
| hook 注册 | `packages/core/src/hooks/registry.ts`、`events.ts` | — |

## §6 参考(Codex 对标证据)

- 数据结构 `ThreadGoal`(objective/status/token_budget/tokens_used/time_used_seconds):
  `codex-rs/app-server-protocol/src/protocol/v2/thread.rs:666`
- 三个工具 create/update/get:`codex-rs/core/src/tools/handlers/goal/`
- 运行时状态机 + 预算结账 + 自动 continuation:`codex-rs/core/src/goals.rs`(`:1094` budget、`:1294` continuation)
- 上下文注入(user 角色伪装):`codex-rs/core/src/context/goal_context.rs:33`
- Plan mode 禁用 goal:`codex-rs/core/src/goals.rs:1547`
