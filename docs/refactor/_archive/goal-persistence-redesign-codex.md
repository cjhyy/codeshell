# Goal 持久化与 session 状态一致性整体重构设计

> 状态：设计方案，不含实现。
>
> 基线：`HEAD d97f95f4`（`fix(goal): clear activeGoal on forced termination + tombstone guard against stale re-arm`）。
>
> 范围纪律：本文不要求、也不涉及 `compaction.ts`、`turn-loop.ts` 的 image 分支、
> `view-image*` 或其他 image history 代码。

## 1. 决策摘要

推荐**回到 `d97f95f4` 的正确行为基线重做**，不要继续在“revision + CAS + lockfile +
watermark + checkpoint + per-terminal journal + legacy bridge”上修补。

目标形态是：

1. 每个 session 只有一个持久化真相：`state.json`。
2. goal 在 `state.json` 内只有一个可判别的 `goalLifecycle` 字段；不再用
   `activeGoal` 与 terminal tombstone/sidecar 拼出状态。
3. 保留一个轻量、不可变的 `goalId`，用于防止旧 run 的延迟回调终结新 goal；不引入单调
   revision、CAS 或 watermark。
4. 普通运行进度、title、workspace、usage、goal transition 都通过“读取最新 state、只改自己
   字段、原子替换”的领域更新 API 落盘；运行期不再允许 detached snapshot 调通用
   whole-state `saveState`。
5. 明确产品契约：一个 session 同一时刻只有一个 CodeShell writer。跨进程显式同时
   `--resume` 同一 sid 不受支持；如果未来要支持，应升级整个 session store，而不是给 goal
   单独造分布式一致性协议。

工程判断：**报告中的实验机制对当前产品模型属于过度工程，而且复杂度已经反过来制造了比原始
bug 更严重的迁移丢 goal、锁 split-brain 和版本兼容问题。** 推荐方案的 goal 持久化复杂度显著
下降；为消除真实存在的进程内 stale writeback，会顺带收紧 session 写 API，但不做全局分布式
CAS。

## 2. 工作区事实与审查边界

四份报告描述了如下演化：

1. 原始根因是 forced termination 只发 stream event，没有持久化 goal 终结；下一 run 又把
   `activeGoal` 的存在直接当作可 arm（
   `docs/refactor/goal-stale-activegoal-root-cause-codex.md:6-25`）。
2. `d97f95f4` 已把 stop-block、budget、goal-mode max-turns 结构化交给 Engine，并在最终
   writeback 前清 live state；waiting 不误清；arm 前有 terminal guard（
   `docs/refactor/goal-fix-review-codex.md:7-15,84-137`）。
3. 第一轮复核把目标扩大到“任意多代 stale writer 永不复活”和“same-objective replacement
   identity”，产生不可变 identity、terminal history 等需求（
   `docs/refactor/goal-fix-review-codex.md:19-82`）。
4. 第二轮又发现 legacy identity 断点、detached replacement 覆盖、64 代淘汰，推动 bridge、
   revision 和 watermark（`docs/refactor/goal-blocker-fix-review-codex.md:28-102`）。
5. 第三轮证明新锁会 split-brain、三处真相不具备事务性、legacy clear 和 mixed-version 仍不
   成立（`docs/refactor/goal-mechanism-review-codex.md:30-152`）。

需要特别记录一个当前工作区事实：截至本文编写时，当前可见的
`packages/core/src/session/session-manager.ts` 已是 `d97f95f4` 的单 tombstone 形态，实际搜索不到
`goalRevision`、`goalTerminalWatermark`、`goal-lifecycle.json`、`goal-terminals/` 或 goal lock；
`SessionState` 当前仍是 `activeGoal + goalTerminal`（`packages/core/src/types.ts:291-305`），
`saveState` 当前仍是单文件 read/merge/write（
`packages/core/src/session/session-manager.ts:502-532`）。同时工作区含大量无关 staged changes，且
`turn-loop-goal-lifecycle.test.ts` 等文件存在未解决冲突。

因此，下文的“实验机制债务地图”依据四份审查报告所固定的被审版本；实际落地不得假定那份 diff
仍完整存在，也不得在当前脏树上盲目执行 reset/revert。应在干净 `d97f95f4` worktree 中重做，再
有选择地集成。

## 3. 前提与非目标

### 3.1 支持的并发模型

支持契约是：

> 一个 session 可以跨多轮、跨进程重启恢复，但同一时刻只能有一个 CodeShell writer；同进程内
> 所有写入必须经同一个 session 写协调入口串行化。

这不是“绝对不可能出现第二 writer”，而是对真实调用链的分层判断：

- Desktop 的 `AgentBridge` 是进程级单例式桥接，只维护一个 worker child，`spawnChild` 在 child
  存在时直接返回（`packages/desktop/src/main/agent-bridge.ts:123-136,190-205`）；多窗口共享它。
- worker 内 `ChatSessionManager` 以 sid 为 key 只创建一个 `ChatSession`（
  `packages/core/src/protocol/chat-session-manager.ts:43-88`）。
- 一个 `ChatSession` 只有一个 active turn，后续 turn 进入 FIFO；`pump()` 在当前 turn 完成后才取
  下一个（`packages/core/src/protocol/chat-session.ts:38-42,91-100,211-262`）。
- background completion 复用同一个 `ChatSession.enqueueTurn`，busy 时不额外 wake（
  `packages/core/src/protocol/server.ts:278-302`）。
- “续接会话”的 automation 也注入同一个 worker 的 `agent/run`，不是另起 headless Engine 写同一
  sid（`packages/desktop/src/main/index.ts:1736-1757`）。
- live goal clear 走 `ChatSession -> Engine.clearGoal`，优先修改当前 run 正在保存的 live bundle（
  `packages/core/src/protocol/server.ts:900-920`；
  `packages/core/src/engine/engine.ts:2789-2805`）。Desktop 的 disk-only fallback 仅在 child 不存在时
  执行（`packages/desktop/src/main/agent-bridge.ts:403-415`；
  `packages/desktop/src/main/agent-bridge-fallback.ts:67-71`）。

所以，**正常 Desktop/TUI/notification/cron-resume 路径不会主动制造两个同时运行的同 sid Engine。**

### 3.2 确实存在的并发/陈旧写入

仍有两类风险，必须区分：

1. **真实、正常的进程内 detached writer。** 首轮标题生成是 fire-and-forget；旧 run 的 promise
   resolve 后仍持有旧 `session.state`，并调用 whole-state `saveState`（
   `packages/core/src/engine/engine.ts:2263-2294`）。下一 queued turn 此时可能已经 resume 出另一份
   state。这个风险不需要第二进程，是本设计必须解决的 session 层问题。
2. **技术上可制造、但不属于支持契约的跨进程 writer。** 所有默认 SessionManager 指向共享的
   `~/.code-shell/sessions`（`packages/core/src/session/session-manager.ts:87-96,131-136`）；CLI
   `run --resume <sid>` 会直接复用指定 sid（`packages/tui/src/cli/commands/run.ts:194-205`）。因此用户
   可以同时运行 Desktop 和 CLI，或两个 CLI，显式 resume 同一 sid。代码没有跨进程 owner gate。

第二类若发生，受影响的不只是 goal：status、usage、workspace、title 都经 whole-state
`state.json` 保存，transcript 也由不同进程 append。只给 goal 加锁/CAS 并不能让“session 一致”成立。
本设计将其定义为 unsupported ownership conflict，而不是为 goal 实现一套局部分布式协议。

### 3.3 崩溃与文件系统前提

- 目标覆盖进程崩溃/kill 后的重启恢复；`state.json` 的 tmp + rename 继续作为单次提交的可见性
  原子边界。
- 不宣称在断电、内核崩溃、NFS/SMB 缓存语义下提供 durable transaction。当前实现没有文件和
  父目录 fsync（第三轮报告：
  `docs/refactor/goal-mechanism-review-codex.md:205-210`）。
- JSON 语义损坏时不得猜测 arm：拒绝 arm，保留原文件并向上报告可诊断错误；不能静默清空后
  继续。

### 3.4 非目标

- 不支持同一 sid 的新旧 binary rolling write、downgrade writer 或多个并发 CLI writer。
- 不保留无限 goal terminal 审计历史。当前 goal 的 terminal 诊断信息足够；需要审计时应写
  transcript/event log，而不是让 arm 正确性依赖无限 tombstone。
- 不持久化 run-scoped `stopBlockCount`、本 run token/time baseline；新 run 对一个仍 armable 的 goal
  重新计数是既有语义。
- 不在本重构中把所有 session 数据迁到数据库，也不改 image/compaction/view-image 路径。

## 4. 现状与债务地图

下表中的“实验机制”指第三轮报告审查的未提交版本，不等同于当前可见源码。

| 组件 | 想解决的问题 | 引入的新风险/成本 | 与四轮复核的对应关系 | 处理决定 |
|---|---|---|---|---|
| 不可变 `goalId` + 单调 `goalRevision` + CAS | 将 identity 与 `objective/setAtMs` 解耦；让 A terminal 不误清 same-objective B；给 stale generation 排序 | revision 分配绑到通用 `saveState`；revisionless 值被 blanket suppress；上溢/损坏处理；CAS 正确性又依赖锁 | 第一轮 blocker 2 要求真正 identity（`goal-fix-review-codex.md:65-82`）；第二轮 blocker 2 证明只有 ID 仍挡不住 detached whole-state 覆盖（`goal-blocker-fix-review-codex.md:56-81`）；第三轮正常分配通过但受 lock、legacy clear、mixed-version blocker 影响（`goal-mechanism-review-codex.md:212-229`） | **只保留随机不可变 `goalId`；删除 revision/CAS** |
| per-session 跨进程 lockfile | 把 read/compare/revision 分配/多文件写变成跨进程临界区 | mtime stale 抢占 + 无条件 unlink 形成 split-brain；owner crash 后同步阻塞；Windows/NFS/SMB 未证明；所有 heartbeat 付锁成本 | 第一轮指出 read-merge-write 无锁（`goal-fix-review-codex.md:55-63`）；第二轮建议锁/CAS（`goal-blocker-fix-review-codex.md:240-246`）；第三轮 blocker 1 直接复现旧 owner 删除新锁（`goal-mechanism-review-codex.md:32-67`） | **删除；同 sid 多进程写改为 unsupported** |
| `goalTerminalWatermark` | terminal journal 只留 64 项后，仍永久压制更老 revision，关闭第 65 代复活 | 需要又一份权威 horizon；高/坏 watermark 可误杀合法 goal；revisionless legacy/旧 binary goal 被误清；安全整数边界 | 第一轮 blocker 1 暴露单槽不够（`goal-fix-review-codex.md:19-63`）；第二轮 blocker 3 暴露 64 代窗口（`goal-blocker-fix-review-codex.md:83-102`）；第三轮 blocker 2/4 与 nit 5/6 暴露误杀和损坏面（`goal-mechanism-review-codex.md:69-101,125-177`） | **删除** |
| `goal-lifecycle.json` checkpoint | 把 revision/watermark 放到不会被旧 `state.json` writer 擦掉的位置 | 与 `state.json` 形成双真相；checkpoint-before-state 的 migration/replacement 崩溃前缀会丢合法 goal；tmp/orphan/fsync 问题 | 第三轮 blocker 2（`goal-mechanism-review-codex.md:69-101`），nits 7-9（`:179-210`） | **删除，权威状态合回 `state.json`** |
| `goal-terminals/<hash>.json` terminal journal | 让 foreign whole-state writer 擦掉 state marker 后仍能 suppress terminal；保存多代/legacy identity | 第三处真相；目录扫描与同步小文件 I/O；corruption、自愈、prune、orphan；仍需 watermark 才能无限期防复活 | 第二轮确认“有限 journal”只部分修好且有 3 blockers（`goal-blocker-fix-review-codex.md:150-179`）；第三轮 nits 5/7/8（`goal-mechanism-review-codex.md:156-203`） | **删除** |
| legacy -> `goalId` migration bridge（legacy identity/hash） | 让迁移前无 ID stale snapshot 能匹配迁移后 terminal | migration 需跨 checkpoint/state 原子提交；disk-only clear 未建 bridge；旧 binary 新 set 与真正 stale legacy 在协议上不可区分 | 第二轮 blocker 1（`goal-blocker-fix-review-codex.md:28-54`）；第三轮 blockers 2-4（`goal-mechanism-review-codex.md:69-152`） | **删除 bridge；用单文件原子迁移，并禁止 mixed writer** |

还有一个不能遗漏的基础债务：当前 `saveState` 名为 atomic write，但 atomic 只防文件撕裂；它先读
磁盘 merge 一小部分 goal 字段，最后仍把调用者整份 state JSON rename 覆盖（
`packages/core/src/session/session-manager.ts:502-532`）。Engine 在 resume、turn boundary、goal
transition、title callback、final writeback 等处反复调用它（例如
`packages/core/src/engine/engine.ts:1332-1337,2080-2118,2281-2286,2298-2311`）。这正是 goal
补丁不断升级成持久化协议的根因。

## 5. 推荐方案：单文件 lifecycle + 领域更新 API

### 5.1 权威数据模型

`SessionState` 新增唯一的 goal 权威字段：

```ts
type GoalLifecycleV1 =
  | {
      version: 1;
      goalId: string;
      phase: "active";
      config: GoalConfig;
      updatedAtMs: number;
    }
  | {
      version: 1;
      goalId: string;
      phase: "waiting";
      config: GoalConfig;
      updatedAtMs: number;
      waitingSinceMs: number;
    }
  | {
      version: 1;
      goalId: string;
      phase: "terminal";
      config: GoalConfig;
      updatedAtMs: number;
      terminal: {
        reason:
          | "judge_met"
          | "complete_goal"
          | "cancel_goal"
          | "user_cleared"
          | "stop_blocks_exhausted"
          | "token_budget_exhausted"
          | "time_budget_exhausted"
          | "max_turns_exhausted";
        atMs: number;
      };
    };

interface SessionState {
  // existing fields...
  goalLifecycle?: GoalLifecycleV1;

  // legacy read/migration only; new writer removes them on migration
  activeGoal?: GoalConfig;
  goalTerminal?: GoalTerminal;
}
```

关键不变量：

1. `goalLifecycle` 是当前 goal 的完整状态，不能同时从另一个字段补信息。
2. 只有 `active` 和 `waiting` 可 arm；`terminal` 永远不可自动 arm。
3. `SessionState.status` 仍表示最近/当前 run 状态，不参与 goal arm 判定。当前类型本就明确二者语义
   不同（`packages/core/src/types.ts:195-203`）。
4. 每次显式 set/restart 都创建新的随机 `goalId`，包括 same-objective 配置/预算替换；
   `setAtMs` 只保留 deadline anchor 语义，不再兼任 identity。
5. terminal record 只保留“当前/最近一个 goal”。新显式 set 用新 active record 整体替换它；正确性
   不依赖历史 terminal 集合。

`waiting` 是“当前 run 已让出、goal 仍有效”的可恢复状态，不是 terminal。它单独建模能避免继续用
`completed + activeGoal` 猜测，同时保持 background completion 能重新 arm。

### 5.2 Session 持久化边界

重构 `SessionManager` 的写 API：

- 保留 `create`/`fork` 对全新 sid 的初始 full snapshot 写。
- 将运行期通用 `saveState(state)` 收窄为内部原语，业务代码不得直接传 detached snapshot。
- 提供同步、无 `await` 的领域更新入口。每次入口都：读最新 `state.json` -> 校验 -> 只改所拥有
  字段 -> tmp + rename -> 返回提交后的 state/字段。

建议的职责接口（名称可在实现时调整）：

| 领域更新 | 允许修改的字段 |
|---|---|
| `updateRunProgress` | `status=active`、turn/usage/context/cost 等运行进度 |
| `completeRun` | terminal `status`、最终 turn/usage/cost |
| `setTitle` | 仅 `title` |
| `setWorkspace` | 仅 `workspace`（及明确需要同步的 cwd） |
| `resetUsage` | 仅 usage/cost 相关字段 |
| `setGoal` | 仅 `goalLifecycle`；创建新 `goalId` |
| `markGoalWaiting(expectedGoalId)` | 仅在当前 ID 匹配且 armable 时改为 waiting |
| `armWaitingGoal(expectedGoalId)` | waiting -> active；ID 不变 |
| `terminateGoal(expectedGoalId, reason)` | 匹配时 active/waiting -> terminal；幂等 |
| `clearCurrentGoal(reason=user_cleared)` | 当前 armable goal -> terminal |

这不是跨进程 CAS。它依赖“同一 session 一个进程 writer”，并利用同步入口在 JS event loop 内不会
交错的事实，解决当前真实的 delayed callback：title promise 只能调用 `setTitle`，不再携带旧
goal/status/usage；下一 heartbeat 又从最新磁盘 state 上 patch，自然保留 title。

Engine 仍可保留 run 内 state view，但每个领域提交要返回新值并同步其拥有的 live 字段。尤其：

- mid-run goal clear 必须先提交同一个 ID 的 terminal；提交成功后立即同步 live goal view 并撤掉
  hook，提交失败则保持当前 run 为 active；
- workspace switch 必须同步 live tool context；
- 后续 run progress 写不得把自己未拥有的 goal/title/workspace 从旧 view 带回磁盘。

### 5.3 Goal 写入路径

#### 显式 set / replace

1. `normalizeGoal(options.goal)`。
2. 读取最新 lifecycle；若已有 active/waiting goal，新的显式 set 仍创建新 `goalId`。
3. `setAtMs` 按产品语义决定：新 objective 用 now；same-objective restart 可保留原 deadline anchor，
   但 ID 必须新建。
4. 原子提交完整 active lifecycle。
5. 提交成功后才发 `goal_set`，并用这份已提交 record arm run。

#### bare send / resume / notification wake

1. 在注册 hook、构造 TurnLoop 前读取/迁移 lifecycle。
2. terminal -> 无 stored goal；绝不根据 session `status` 猜测。
3. active -> 直接 arm。
4. waiting -> 先用相同 ID 转回 active，再 arm。background wake 与普通 bare send 共用这一逻辑，
   不能只在 server wake 层修。

当前 wake 本就不传显式 goal，而由 Engine 继承 persisted goal（
`packages/core/src/protocol/server.ts:294-302`；
`packages/core/src/protocol/chat-session.ts:220-229`），所以权威 guard 必须留在 Engine goal
resolution 边界。

#### waiting

GoalStopHook 的 `waiting:true` 只有在确有有限 background work 时才有效；当前 guard 位于
`packages/core/src/hooks/goal-stop-hook.ts:342-364`，必须保留。

Hook/TurnLoop 返回结构化 `goalDisposition: waiting`，Engine 在 run completion 前提交
`phase=waiting`。不能把普通 `reason=completed` 当作 clear 条件。

#### terminal

所有终结统一变成结构化 transition request，由 Engine 作为唯一持久化责任方处理：

- judge met -> `judge_met`
- `complete_goal` -> `complete_goal`
- confirmed `cancel_goal` -> `cancel_goal`
- UI/RPC clear -> `user_cleared`
- stop-block cap -> `stop_blocks_exhausted`
- token/time budget -> 对应 exhausted reason
- goal-mode max turns -> `max_turns_exhausted`

`terminateGoal(expectedGoalId, reason)` 必须在最新磁盘 record 上比较 ID：如果 A 的延迟回调到达时
当前已经是 B，则 no-op，不能清/终结 B。

当前 TurnLoop 已经为四类 forced termination 返回结构化 metadata（
`packages/core/src/engine/turn-loop.ts:953-980,1052-1089,1407-1412`），这部分设计应保留；需要改的是
把 judge met、complete/cancel、waiting 也统一成 Engine-owned transition，而不是分散的持久化回调。

### 5.4 事件与提交顺序

线性化顺序必须写入契约：

```text
set:       commit active     -> emit goal_set       -> arm
waiting:   commit waiting    -> emit turn_complete  -> idle
terminal:  commit terminal   -> emit goal terminal/progress event -> emit turn_complete
clear:     commit terminal   -> unregister live hook -> emit goal_cleared/return success
```

当前 stop-block exhausted 在 TurnLoop 内先发 `goal_progress(exhausted)`，Engine 随后才持久化（
`packages/core/src/engine/turn-loop.ts:1052-1089`；
`packages/core/src/engine/engine.ts:2131-2155`）。目标实现应让 TurnLoop 返回 disposition，终结事件由
Engine 在 commit 后发，或缓冲到 commit 成功后再转发，避免用户已经看到 terminal、磁盘却仍 active
的崩溃窗口。

### 5.5 读取、恢复与损坏处理

读取规则：

1. 有且仅有合法 `goalLifecycle.version=1`：以它为准。
2. 没有 lifecycle，但有 legacy `activeGoal`：按 7.2 的规则在 arm 前原子迁移。
3. 有 lifecycle 又有 legacy activeGoal：视为 mixed/old writer 冲突，不静默二选一；拒绝 arm 并报告
   可诊断错误。
4. lifecycle schema/version 不合法：拒绝 arm，不自动清文件，不用 session status 回退推断。
5. `goalGet` 只对 active/waiting 返回 objective；terminal 返回 null。`goalClear` 对 terminal 幂等
   返回 false。

## 6. 崩溃恢复语义

因为 lifecycle 与 session state 同在一次 `state.json` rename 内，恢复只有两种完整版本：

| 操作 | rename 前崩溃 | rename 后崩溃 |
|---|---|---|
| set/replace | 旧 goal/no-goal 仍权威；新 `goal_set` 尚未确认 | 新 active goal 权威；即使事件没发也可恢复 |
| active -> waiting | 仍是 active，下一 run 仍可推进，不丢 goal | waiting 可被 background wake/bare send 重新 arm |
| terminal | 旧 active 仍在；终结事件不得已对外确认 | terminal 持久，任何 resume/wake 不 arm |
| legacy migration | 原 legacy activeGoal 仍完整可读 | lifecycle 完整存在，legacy 字段已移除 |

这消除了第三轮的 checkpoint-before-state 中间态：不存在“checkpoint 已说 revision 1、state 仍是
合法 legacy L”的组合（反例见
`docs/refactor/goal-mechanism-review-codex.md:69-101`）。

仍明确不保证：进程在 terminal 条件已经发生、但 commit 之前被硬杀时 exactly-once 终结。通过
“commit 前不发 terminal acknowledgement”把恢复语义定义成 at-least-once work / at-most-once
acknowledged terminal：可能再做一次未确认工作，但不会确认终结后自动复活。

## 7. 向后兼容与迁移

### 7.1 兼容边界

- 支持：新 binary 读取所有已发布 `state.json`（包括无 goal 字段、只有 `activeGoal`、以及
  `d97f95f4` 的 `activeGoal + goalTerminal`）。
- 不支持：旧 binary 与新 binary 同时写同一 sid；从新版本 downgrade 后继续同一 session。
- 新 writer 不持续写 `activeGoal` compatibility alias。alias 会重新制造双真相，并且旧 reader 无法
  区分 same-objective replacement；第二、三轮已证明 shape compatibility 不等于行为兼容（
  `docs/refactor/goal-blocker-fix-review-codex.md:136-148`；
  `docs/refactor/goal-mechanism-review-codex.md:125-152`）。

### 7.2 旧 `state.json` 的一次性迁移

在第一次 goal read-for-arm 或任何 goal transition 时做：

| 旧形状 | 新 lifecycle |
|---|---|
| 无 `activeGoal`、无 `goalTerminal` | 无 lifecycle |
| 有 `activeGoal`，无匹配 terminal | 新随机 ID，`phase=active`，原 config 原样规范化 |
| `activeGoal` 与 `goalTerminal` identity 匹配 | `phase=terminal`，config 来自 activeGoal，reason/at 来自 terminal |
| 无 activeGoal，只有 terminal | 可迁移为 terminal 诊断 record；若 config 不完整则只在严格校验通过时迁移，否则保留备份并报告 |

迁移在内存构造完整新 state，单次原子 rename 同时写 lifecycle 并删除 legacy 两字段。崩溃前仍是
完整旧形状，崩溃后是完整新形状；不需要 hash bridge。

实验性 sidecar 未发布，不能成为产品兼容契约。开发机若已运行过未提交版本，落地前应先做只读
盘点；默认实现不自动合并 `goal-lifecycle.json`/`goal-terminals/` 与 `state.json`。需要保留开发数据
时，另写一次性、人工确认的迁移工具/说明，不能让运行时长期维护三处真相。

### 7.3 版本 fence

`goalLifecycle.version` 是 goal 子结构的解析 fence。若未来 schema 变化，只允许显式迁移；unknown
version 不 arm。无需为了未支持的旧 binary 写回 alias。

## 8. 必须保留的行为与验收基线

以下行为重构后必须仍然为真：

1. stop-block cap 返回结构化 `stop_blocks_exhausted`，goal 变 terminal；后续 bare send/resume/wake
   不产生新的 `goal_progress round=1`。
2. token budget、time budget、goal-mode max turns 分别写正确 terminal reason，且后续不 re-arm。
3. `waiting:true` 且确有有限 background work 时，goal 保留为 waiting；run 可以 completed，任务完成
   后 wake 能继续 goal。
4. `waiting:true` 但没有真实 background work 时不得进入 waiting，必须按 not_met 继续。现有 guard
   行为见 `packages/core/src/hooks/goal-stop-hook.ts:348-364`。
5. judge met、`complete_goal`、confirmed `cancel_goal` 都终结当前 goal；unconfirmed cancel 不终结。
6. UI/RPC clear 在 live run 与 idle/worker-dead session 都有效、幂等，并使 live hook 停止阻塞；
   `goal_cleared` 只在成功 transition 后发。
7. manual Stop/`aborted_streaming` 不自动终结 goal；下一次用户主动发送仍可继承它。
8. bare send 只继承 active/waiting goal；terminal goal 永不继承。arm guard 位于 Engine，不只位于
   server wake。
9. 显式新 goal 替换旧 goal；same-objective budget/limit restart 也得到新 `goalId`。A 的延迟终结
   不得改变 B。
10. `setAtMs` 继续作为相对 deadline anchor；不再作为 identity。
11. `SessionState.status=completed` 不等于 goal terminal；普通 completed 不清 goal。
12. run-scoped stop round、token/time budget baseline 在新 run 重置；只有仍 armable 的 goal 才能开始
    新 round。
13. `goalGet` 在 active/waiting 时可让 Desktop 重建 goal UI；terminal/no-goal 返回 null。
14. legacy state 能恢复；matching legacy terminal 不 arm；迁移过程不存在跨文件半提交。
15. title、usage、workspace、run status 等非 goal 更新不得覆盖 lifecycle；goal transition 不得丢失
    这些字段。
16. `readActiveGoal`/`goalGet` 对 unknown/traversal sid 仍安全；损坏 lifecycle 不执行 goal。

对应的现有绿测基线主要在：

- `packages/core/src/engine/turn-loop-goal-lifecycle.test.ts:125-616`
- `packages/core/src/session/session-manager.cleargoal.test.ts:18-60`
- `packages/core/src/session/session-manager.readgoal.test.ts:19-42`
- `packages/core/src/hooks/goal-stop-hook.test.ts:59-272`
- `tests/engine-goal-cancel.test.ts:107-132`
- `tests/engine-persistent-goal.test.ts:109-162`

其中当前名为 `BUG: clearing a DETACHED copy...` 的测试（
`packages/core/src/session/session-manager.cleargoal-stale-writeback.test.ts:41-56`）描述的是不再允许的
通用 snapshot 写法，不应继续当长期支持行为；它应被替换为“领域更新后，旧/延迟非 goal 更新不能
复活 goal”的断言。

## 9. 推荐落地路径

### 9.1 选择：回退实验机制，在 `d97f95f4` 上重做

不建议在 revision/lock/watermark 机制上“删到剩下简单版”。原因是它已经改变了：

- 持久化权威来源；
- 所有 `saveState` 的语义和性能；
- legacy/mixed-version 判定；
- failure mode 与清理逻辑；
- 大量测试的前提。

在其上删除很容易留下 blanket suppression、sidecar precedence、legacy alias 或锁清理残片。更可靠
的路径是从已经修复真实现场的 `d97f95f4` 开始，替换其单 tombstone 设计，同时保留正确行为。

由于当前工作区很脏且有 unmerged 文件，落地时应创建基于 `d97f95f4` 的独立干净 worktree/branch；
不得对现工作区使用 destructive reset。完成、测试通过后再按文件集成其他用户改动。

### 9.2 分步实施顺序

1. **建立干净基线与测试快照。** 在干净 `d97f95f4` 上跑 goal 定向套件，记录基线；确认不带任何
   experimental sidecar 代码。
2. **定义 lifecycle。** 在 goal/type 层加入 `GoalLifecycleV1`、完整 terminal reasons、armable
   predicate、immutable ID；保留现有 budget/limit helpers。
3. **收紧 session 写 API。** 将运行期 `saveState` call sites 分成 run progress、final、title、
   workspace、usage、goal transition；改成 latest-state field/domain updates。先补 title-after-next-run
   的真实 stale regression，再迁移调用点。
4. **实现单文件 legacy migration。** 覆盖无 goal、legacy active、d97 matching terminal、损坏/
   unknown version；迁移与 legacy 字段删除在一次 rename 内完成。
5. **统一 goal transition。** TurnLoop/Hook 只返回 disposition；Engine 对 set/waiting/terminal 负责
   commit 和事件顺序。保留 forced termination metadata、waiting guard、live clear hook 行为。
6. **改读路径。** `getGoal/readActiveGoal` 只返回 armable lifecycle；Engine resolution 在 hook 注册前
   guard；server/desktop fallback 的外部 API 形状可保持不变。
7. **删除旧复杂度。** 删除 `goalTerminal` runtime merge、`newestGoalTerminal`，以及实验机制中的
   revision/CAS、lock、watermark、checkpoint、journal、legacy hash bridge 与 compatibility alias。
8. **回归与 fault injection。** 通过第 11 节矩阵后再集成到主工作区；不以“现有测试全绿”替代新
   stale title、迁移 rename 边界和 field ownership 测试。

### 9.3 影响文件

| 文件 | 设计影响 |
|---|---|
| `packages/core/src/engine/goal.ts` | lifecycle/reason/armable/identity/migration helpers；保留 budgets |
| `packages/core/src/types.ts` | `SessionState.goalLifecycle`；legacy 字段仅用于迁移 |
| `packages/core/src/session/session-manager.ts` | 单文件领域更新、严格读取/迁移；移除 tombstone merge/实验 sidecars |
| `packages/core/src/engine/engine.ts` | goal resolution/transition、commit-before-event、title 等字段更新、live state 同步 |
| `packages/core/src/engine/turn-loop.ts` | 继续产出 structured disposition；terminal 事件改由 commit 后发送 |
| `packages/core/src/hooks/goal-stop-hook.ts` | judge met/waiting 只返回 disposition，不直接持久化 |
| `packages/core/src/protocol/server.ts` / `chat-session.ts` | 通常只需保持 route/queue 契约；更新注释与 goal read/clear 语义 |
| `packages/desktop/src/main/agent-bridge-fallback.ts` | 继续调用稳定的 disk-only read/clear API；不读取 sidecar |
| 上述 goal/session tests | 迁移为 lifecycle assertions，新增 session field ownership/crash tests |

明确不影响：`compaction.ts`、`turn-loop.ts` 的 image 分支、`view-image*`。

### 9.4 主要落地风险

| 风险 | 控制 |
|---|---|
| 拆通用 `saveState` 时漏掉字段 | 先枚举全部 call sites；每个领域方法声明 allowed fields；加互不覆盖矩阵 |
| waiting 被当 terminal 或永远不醒 | waiting 单独 phase；保留真实 background-work guard；协议 wake 集成测试 |
| terminal event 先于 commit | Engine 统一发终结事件；注入 commit 失败测试 |
| legacy matching 规则误清 | 迁移仅在无 lifecycle 时使用旧 `objective+setAtMs`；迁移后只认 ID |
| async title/其他回调覆盖新状态 | 禁止 detached full save；所有 delayed callback 只发领域 update |
| 当前脏树集成误伤无关改动 | 干净 worktree 实施；按文件/commit 集成；不 reset 用户工作区 |

## 10. 明确取舍：删除保护的理论场景

推荐方案不再防护：

1. 两个 CodeShell binary 同时 `--resume` 同一 sid 并写入；
2. 新旧 binary 同时写，或 downgrade binary 在新 lifecycle 上再 set legacy `activeGoal`；
3. 任意年龄的外部程序/手工脚本持续把旧 whole-state snapshot 覆盖回来；
4. NFS/SMB 上缺乏明确原子/缓存保证的多机 writer；
5. 掉电后无 fsync 的 durable ordering。

接受这些取舍的理由不是“它们不可能”，而是：

- 正常 host 已经按 sid 串行，第二 writer 需要显式越过产品所有权模型；
- 一旦发生第二 writer，整个 state 和 transcript 都不一致，goal-only lock/CAS 只能制造局部正确的
  假象；
- 当前实验协议事实上也没有提供这些保证，反而引入确定的 split-brain 和 migration goal loss；
- 本地单用户产品更应以 fail-fast 的单 owner 契约控制复杂度，而不是在高频 heartbeat 上维护三处
  真相。

如果产品以后把“同 sid 多进程同时写”提升为正式需求，必须采用第 12.2 方案并为整个 session
store 定义事务，不得重新把 watermark/journal 补回 goal 层。

## 11. 回归测试矩阵

### 11.1 Goal 生命周期

- explicit set 持久化 active，bare send 继承。
- same-objective restart：新 ID、deadline anchor 按规则保留。
- new objective replacement：新 ID；A terminal callback 对 B no-op。
- judge met / complete_goal / confirmed cancel / user clear 的 reason 与不可 re-arm。
- unconfirmed cancel、manual Stop 保留 armable goal。
- stop-block、token、time、max-turns 四类 forced terminal 与 bare/resume/wake no re-arm。
- active -> waiting -> background wake -> active；waiting 无后台任务不成立。
- terminal lifecycle 与 `SessionState.status=active/completed` 的交叉组合都不 arm。

### 11.2 Session 状态一致性

- run N 的 delayed title 在 run N+1 active/final save 前后落盘，均只改变 title；不得回退 status、
  usage、turnCount 或 goal。
- live clear 后连续 heartbeat/final/title update 均不能复活 goal。
- workspace update 与 heartbeat/title/goal transition 任意顺序，字段互不覆盖。
- usage reset 与 goal terminal 任意顺序，字段互不覆盖。
- 运行期源码扫描/测试 guard：除 SessionManager 内部初始 create/fork 外，不允许业务代码调用通用
  full-snapshot write。

### 11.3 迁移与损坏

- pre-goal state、legacy activeGoal、d97 active+matching terminal、terminal-only。
- migration 写前失败：旧 goal 可恢复；rename 后失败：新 lifecycle 可恢复。
- lifecycle unknown version / invalid phase / missing terminal reason：不 arm、不覆写原文件、错误可诊断。
- lifecycle 与 legacy activeGoal 同时出现：报告 mixed-writer conflict，不静默选择。
- 实验 sidecar 存在但 state 为已发布格式：运行时不把 sidecar 当第二权威来源。

### 11.4 Host 路由

- 同 sid 两个 user sends FIFO。
- busy 时 background completion 不创建并发 turn；run boundary 后只 wake 一次。
- cron resume 与 user send 进入同一 ChatSession queue。
- worker-dead disk-only clear 后再启动 worker，goal 仍 terminal/no-goal。

### 11.5 建议测试命令

实现后至少运行：

```text
bun test \
  packages/core/src/engine/turn-loop-goal-lifecycle.test.ts \
  packages/core/src/session/session-manager.cleargoal.test.ts \
  packages/core/src/session/session-manager.cleargoal-stale-writeback.test.ts \
  packages/core/src/session/session-manager.readgoal.test.ts \
  packages/core/src/engine/goal.test.ts \
  packages/core/src/hooks/goal-stop-hook.test.ts \
  tests/engine-goal-cancel.test.ts \
  tests/engine-persistent-goal.test.ts
```

再跑 `bun test packages/core`。当前工作区有 unmerged 文件，本文阶段不以当前脏树运行结果作为设计
证据。

## 12. 备选方案

### 12.1 备选 A：最小化 d97 形态

若必须以最小 diff 紧急落地，可保留 `activeGoal + last goalTerminal` 两字段，但：

- 给两者加入不可变 `goalId`；迁移后只按 ID 比较；
- same-objective explicit set 也产生新 ID；
- forced terminal、met、complete/cancel/clear 全部写 terminal；
- 删除 revision/lock/watermark/sidecars/bridge；
- 至少把 delayed title、workspace、usage 改成字段更新，禁止旧 snapshot full save。

数据仍只在 `state.json`；set/terminal/clear 仍走 latest-state 领域更新，读取时只有“activeGoal
存在且不与 terminal.goalId 匹配”才可 arm。一次 rename 同时更新两个字段，进程崩溃语义与推荐
方案相同。旧 `activeGoal` 可在首次写入时补 ID；同样不支持 mixed-version writer，也不持续承诺
旧 binary 的行为兼容。

缺点是两个 optional 字段天然允许
`active A + terminal B`、`active A + terminal A` 等组合，arm 和迁移分支更多，未来很容易再次把
“存在”误当“状态”。因此只作为短期过渡，不作为最终目标。

### 12.2 备选 B：真正支持多进程 writer

只有产品明确要求同 sid 被 Desktop、CLI、automation 多进程同时写时采用。此时一致性边界必须是
整个 session：

- 用 SQLite WAL/事务型本地 store，或单一 session-owner daemon；不要使用多个 JSON sidecar。
- 数据模型仍使用上述单字段 lifecycle；`SessionState` 作为一行/一个事务单元，每次领域 update 在
  事务内读最新 row、比较 row revision、更新并递增。
- set/waiting/terminal/clear 与 run progress 均走事务；arm 只读取已提交的 active/waiting lifecycle，
  terminal guard 不依赖缓存或 sidecar。
- transcript/event append 也进入同一 store 或有明确的事务/排序协议。
- `state.json` 仅作为 import/export compatibility artifact，不再是并发权威。
- 旧 `state.json` 一次性 import 后写 store version fence；不承诺 mixed-version rolling write。

SQLite 能直接提供锁、崩溃恢复和事务边界，避免自行实现 lease fencing、stale breaker、三文件提交
顺序；崩溃后只会看到事务前或事务后的完整 row。代价是影响 session list、transcript、备份/迁移、
桌面和 CLI 启动路径，远超本次真实 bug；当前不推荐。

## 13. 最终决策

1. **要回退吗？** 要。以干净 `d97f95f4` 为行为基线重做；不在实验机制上继续加 blocker fix。
2. **推荐目标形态？** 单个 `state.json`、单个 `goalLifecycle` discriminated union、不可变随机
   `goalId`、Engine-owned transition、latest-state 领域更新 API。
3. **session 一致性边界？** 本轮顺带消除真实的进程内 detached whole-state writes；不引入全局
   revision/CAS，不承诺多进程同 sid writer。
4. **复杂度变化？** goal 持久化从三处真相和文件协议降为一次原子 state transition；session 写
   API 稍更严格，但总体复杂度、I/O 和 failure surface 明显下降。
5. **必须保留什么？** `d97f95f4` 的 forced terminal 清理、waiting 保留、live clear、arm guard 和
   structured termination；替换掉的是 tombstone/identity/并发防护的实现形态，不是这些产品行为。
