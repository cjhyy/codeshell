# Goal 持久化设计（历史基线 + 2026-07-14 实施说明）

> 状态：**2026-07-14 已实施新版 V1 并完成复审整改。** 本文主体仍
> 保留基于 `2082ebcd` 的历史论证，实施以本节为准：保留现有 `stateRevision` CAS、proper-lockfile、
> edit/pause revision 和 deterministic legacy goalId；持久化权威已切为单字段 `goalLifecycle`。
>
> 仓库基线：`HEAD 2082ebcd780ade3c079cb4b5dbd305ef85a7a3f4`。
>
> 调研时间：2026-07-10。外部实现会继续演进，本文所有源码结论均固定到下文注明的
> commit/tag。
>
> 范围纪律：本轮只产出本文档，不修改源码、不 commit；不涉及 `view_image`、image history
> 或 compaction 的 image 分支。

## 2026-07-14 实施说明

worktree `codex/architecture-debt-goal-persistence` 已完成一致性边界与 schema migration：

- `saveGoalTerminal`、`saveActiveGoal`、`markGoalWaiting` 均从最新 persisted state 开始，
  commit 后回填 live bundle；terminal CAS retry 不再给后续 stale whole-state 保存授权。
- Engine 的 heartbeat/final/summary/usage reset/compact usage 主路径改为 field-level 或累加型领域 API，
  最终字段包含 `turnSeq`；运行期生产路径不再调用 whole-state `saveState`。
- Desktop workspace switch/cleanup 在有 active worker 时经 `agent/setWorkspace` 让 worker 持久化并 rebase
  live revision；busy session 的顶部切换/清理入口禁用。
- `GoalLifecycleV1` 使用 `active | paused | waiting | terminal` 判别联合；`goalId`、revision 位于顶层，
  config 不重复保存 identity/paused。waiting 在允许有限后台任务让出前提交，下一次 bare send 以同 ID arm。
- legacy `activeGoal` / `goalTerminal` / `goalTerminals` 只在 decoder 中读取；合法 V1 优先，未知版本
  fail-closed；下一次领域写原子迁移并删除 aliases，新 writer 只输出 `goalLifecycle`。
- Engine 运行期只读写 `goalLifecycle`；hydrate 不重建 legacy aliases。decoder 拒绝负预算、非整数 turn
  上限和跨 phase 字段，避免非法状态进入运行时。
- token/time/stop-block/max-turn 四类 forced termination 先持久化 terminal，再发布 exhausted 事件；
  commit 失败或已 obsolete 时不发布不存在的终态。
- 两个复审 HOLD 均有直接回归：并发新 summary 不被 terminal+final 覆盖；main 进程推进 workspace revision
  后第二轮 `turnSeq` 仍持久化为 2。

与历史草案的差异：本实现不删除已经上线的跨进程锁/CAS；terminal 只保存当前生命周期，不再保存
有界历史集合。旧 run 对新 goal 的延迟 terminal 通过 `(goalId, revision)` 变成 no-op。

## 0. 历史调研结论（已由上方实施说明修正）

### 0.1 对预设“业界共识”的核查结论

用户给出的原命题不能原样成立：**当前主流本地 agent harness 并不都是“单文件/追加式 +
原子写”，也不能说“没人使用锁、sequence 或条件更新”。**

- Claude Code 的核心会话 transcript 确实是每 session 一份 JSONL，持续追加；恢复时重开同一
  session 并继续追加。
- Codex 的 canonical thread history 也是每 thread 一份 rollout JSONL，但当前实现同时用
  SQLite 保存可查询 thread metadata，并在独立 `goals_1.sqlite` 中保存 goal lifecycle；goal
  更新可带 `expected_goal_id` 条件。
- OpenCode 最新稳定版 `v1.17.18` 已使用 SQLite WAL；durable session event 在事务内分配
  aggregate sequence，并带可选 owner，绝不是“无 sequence/无并发控制”的单 JSON 文件方案。

三家真正支持本设计的共同点更窄、也更可靠：

> **没有一家为单用户 session 中的一个 goal 自造“lockfile + revision/CAS + watermark +
> checkpoint + terminal sidecar/journal”多文件一致性协议。简单产品路径使用单 writer 顺序
> 追加；确实需要并发/可重放语义的实现直接使用 SQLite 事务、WAL、唯一键和条件更新。**

因此，本项目仍应采用一个 `state.json` 内的 `goalLifecycle`，配合不可变 `goalId`、进程内串行的
字段级领域更新和 tmp + rename；明确不支持同一 sid 多进程并发写。这个决策来自本项目的所有权
模型和现有存储边界，不依赖被调研推翻的绝对化行业表述。

### 0.2 当前 main 一句话

当前 `2082ebcd` 已是相对干净的 `activeGoal + goalTerminal` 单 tombstone 版本：forced
termination 清 goal、waiting 不清、arm 前有 tombstone guard；源码中没有 revision、CAS、
watermark、goal lock、sidecar 或 journal，但仍以 `objective + setAtMs` 充当 identity，并让通用
whole-state `saveState` 承担特殊 tombstone merge。

### 0.3 唯一推荐方案

每个 session 仍只有一个 goal 权威来源：`state.json.goalLifecycle`。它是带 `version` 和不可变
`goalId` 的 `active | waiting | terminal` 判别联合；只有 active/waiting 可进入下一 run，terminal
永不自动 arm。所有 goal transition 和延迟的 title/usage/workspace 更新都走“读最新 state →
只改本领域字段 → tmp + rename”的同步入口。删掉 `activeGoal + goalTerminal` 双字段、
`objective + setAtMs` identity 和 tombstone merge，不增加 revision、CAS、watermark、锁或任何
goal sidecar。

## 1. 调研口径与可信度

### 1.1 来源优先级

1. 官方公开源码的固定 commit/tag；
2. 官方产品文档；
3. 官方仓库 issue 中的可复现观察，仅作为非契约性补充；
4. 官方材料没有说明的细节一律标记“未证实”。

Codex 官方手册 helper 本次返回“缺少 `x-content-sha256`”而无法使用，所以 Codex 的低层存储结论
改由 OpenAI 官方公开仓库源码固定。Claude Code CLI 不是完整开源项目，因此其文件锁、fsync、
partial-line 修复等内部细节不能从公开源码核实。OpenCode 原 `sst/opencode` 仓库现已迁移/重命名为
`anomalyco/opencode`；本文以 2026-07-09 发布的稳定 tag `v1.17.18` 为准，不用旧版 JSON storage
推断当前行为。

### 1.2 版本锚点

| Harness | 本文锚点 |
|---|---|
| OpenAI Codex | `openai/codex@1f0566d3f59298d1bb88820a0d35294f1eeb07ea` |
| Claude Code | 2026-07-10 可见的官方 sessions / Agent SDK session storage 文档；内部源码未公开 |
| OpenCode | `anomalyco/opencode@v1.17.18`，commit `b1fc8113948b518835c2a39ece49553cffe9b30c` |

## 2. 三家 harness 持久化对比

### 2.1 对比表

| Harness | 存储形态 | 追加 vs 覆盖 | 并发控制 | 崩溃/恢复 | 生命周期表达 | 依据 |
|---|---|---|---|---|---|---|
| OpenAI Codex | canonical history 是 `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<thread-id>.jsonl`；另有 `state_5.sqlite` 作为可查询 thread metadata index、`session_index.jsonl` 兼容名称索引，当前 goal 在 `goals_1.sqlite` 的 `thread_goals` 单行中 | rollout 和名称索引追加；SQLite row 更新；名称索引删除时 temp + rename 重写 | 同进程每 thread 只允许一个 live recorder，单后台 writer task 经有界 channel 串行写；rollout 源码未见跨进程 file lock 或 revision。SQLite 使用 WAL/5 秒 busy timeout；goal 更新可用 `expected_goal_id` 作为 identity 条件，但没有单调 revision/watermark | rollout item 写成功后才从 pending 队列移除；flush 失败会丢句柄、重开并重试一次；读取逐行，坏 JSON 行被跳过。调用 `flush`，未见文件/目录 fsync，掉电 durability 未承诺。SQLite 依赖 WAL/事务恢复 | rollout item 重放会恢复会话；thread metadata 在 SQLite；goal row 有 `goal_id` 与 `active/paused/blocked/usage_limited/budget_limited/complete` 状态 | [rollout 路径与 append writer](https://github.com/openai/codex/blob/1f0566d3f59298d1bb88820a0d35294f1eeb07ea/codex-rs/rollout/src/recorder.rs#L1498-L1549)、[pending/flush/retry](https://github.com/openai/codex/blob/1f0566d3f59298d1bb88820a0d35294f1eeb07ea/codex-rs/rollout/src/recorder.rs#L1545-L1715)、[JSONL + SQLite 双层说明](https://github.com/openai/codex/blob/1f0566d3f59298d1bb88820a0d35294f1eeb07ea/codex-rs/thread-store/src/local/mod.rs#L45-L62)、[SQLite WAL](https://github.com/openai/codex/blob/1f0566d3f59298d1bb88820a0d35294f1eeb07ea/codex-rs/state/src/runtime.rs#L362-L370)、[goal schema](https://github.com/openai/codex/blob/1f0566d3f59298d1bb88820a0d35294f1eeb07ea/codex-rs/state/goals_migrations/0001_thread_goals.sql)、[expected goal ID](https://github.com/openai/codex/blob/1f0566d3f59298d1bb88820a0d35294f1eeb07ea/codex-rs/state/src/runtime/goals.rs#L183-L330) |
| Claude Code | 每 project、每 session 一份 `~/.claude/projects/<project>/<session-id>.jsonl`；每行是 message/tool/metadata。subagent transcript 使用独立 subpath。`sessions-index.json` 的存在可由官方 issue 观察到，但其当前内部 schema/权威性未正式文档化 | 官方明确“持续保存”，resume 同 session ID 后向既有 conversation 追加；Agent SDK mirror API 也是 batch `append()` | 官方明确同一 session 在两个 terminal resume 会让消息交错到一个 transcript，说明没有 single-owner 拒绝契约。是否用 `O_APPEND`、每行 advisory lock 或其他低层互斥：**未证实**；未发现公开 revision/CAS/watermark 契约 | 本地盘先写，外部 session store 只是 best-effort mirror；resume 读取 linked message chain。精确 partial-line、flush/fsync、崩溃尾行修复：**未证实**。官方 issue 报告过 parent chain 损坏，但 issue 不是实现契约 | 生命周期主要由 JSONL 中 message/tool/metadata 与 UUID parent chain 表达；compaction 后 resume 看到 linked post-compaction chain。独立“长任务状态表”：**未证实** | [Manage sessions：路径、连续保存、并发交错](https://code.claude.com/docs/en/sessions)、[How Claude Code works：JSONL 与 resume append](https://code.claude.com/docs/en/how-claude-code-works)、[Agent SDK storage：local-first、append、linked chain](https://code.claude.com/docs/en/agent-sdk/session-storage)、[parent chain 损坏报告（非契约）](https://github.com/anthropics/claude-code/issues/24304) |
| OpenCode | 最新稳定版把 session、message、part、todo、input inbox、context epoch、durable event 和 aggregate sequence 放在 data dir 的 `opencode.db`（非标准 channel 使用带 channel 后缀的 DB 名；Drizzle + SQLite） | row insert/update；durable event 是 append-only event rows，同时事务内更新 projections 和 aggregate sequence；不是每 session JSON 文件 | SQLite `WAL + synchronous=NORMAL + busy_timeout=5000`；durable publish 使用 `BEGIN IMMEDIATE` 类事务，读取 latest seq、校验 owner/replay、分配 `latest + 1`、运行 projector、写 event 与 sequence。进程内另有 per-session run coordinator 串行 run/wake | SQLite 事务提供提交前/后的原子可见性和 WAL 恢复；durable event 与 projection 在同一事务。当前 busy/idle execution owner 主要在内存 coordinator，进程崩溃后的“原 run 仍 busy”不会持久恢复——这是从源码作出的推断 | durable event 带 `{aggregateID, seq, version}`；`event_sequence` 有 `owner_id`；`session_message` 以 per-session `seq` 排序；tool state 用 `pending/running/completed/error` 判别联合；run/wake 在进程内串行 | [稳定版 v1.17.18](https://github.com/anomalyco/opencode/releases/tag/v1.17.18)、[DB 路径与 WAL 配置](https://github.com/anomalyco/opencode/blob/b1fc8113948b518835c2a39ece49553cffe9b30c/packages/core/src/database/database.ts#L20-L57)、[session/message 表](https://github.com/anomalyco/opencode/blob/b1fc8113948b518835c2a39ece49553cffe9b30c/packages/core/src/session/sql.ts#L22-L176)、[event sequence/owner schema](https://github.com/anomalyco/opencode/blob/b1fc8113948b518835c2a39ece49553cffe9b30c/packages/core/src/event/sql.ts)、[事务内 sequence + projection](https://github.com/anomalyco/opencode/blob/b1fc8113948b518835c2a39ece49553cffe9b30c/packages/core/src/event.ts#L205-L363)、[per-session run coordinator](https://github.com/anomalyco/opencode/blob/b1fc8113948b518835c2a39ece49553cffe9b30c/packages/core/src/session/run-coordinator.ts)、[官方 data dir 说明](https://opencode.ai/docs/troubleshooting/) |

### 2.2 Codex 的关键细节

Codex 当前不是“一个 rollout 文件包含所有状态”的纯单文件设计：

1. `RolloutRecorder` 为新 thread 计算日期分层路径，并在 create/resume 时用 append file handle；
   一个后台 task 独占该 handle，通过 channel 串行接收 item。
2. canonical history 仍是 JSONL，SQLite 只是可查询 metadata/index；源码明确要求 live append
   先 flush JSONL，再让 SQLite metadata 跟进，避免 metadata 超前于 canonical history。
3. `LocalThreadStore` 只在**同一进程**的 `live_recorders` map 中拒绝第二个 live writer；没有看到
   rollout 层跨进程 lockfile 或 revision。
4. 当前 Codex goal 并不靠 transcript 推断：`thread_goals` 每 thread 一行，使用随机 `goal_id` 和
   明确 status；更新 SQL 可把 `expected_goal_id` 放进 `WHERE`，防止旧 goal 的延迟回调更新新
   goal。它使用 SQLite 的事务/锁，而不是 goal sidecar、水位或历史 tombstone 集合。

这给本项目两条直接启示：`goalId` 和判别状态是合理的小原语；如果将来真要支持多进程同 sid，
应升级到事务 store，而不是在 JSON 文件旁继续堆协议。

### 2.3 Claude Code 的关键细节与未证实边界

官方文档已足够确认：

- transcript 路径与“一行一个 message/tool/metadata”；
- 会话工作中持续保存；resume 以原 session ID 继续追加；
- resume 恢复的是 UUID 链接后的消息链，compaction 前的 raw entries 仍可能存在但不进入当前链；
- 同 session 两 terminal 不会被拒绝，而是把消息交错进同一个 transcript。

官方文档没有公开 CLI 内部文件 writer，因此不能声称它“有”或“没有”advisory file lock，也不能
把 issue 中观察到的 `sessions-index.json`、`parentUuid` 修复脚本当成稳定 schema。本文据此只把
Claude 作为“append transcript、弱同-session并发隔离”的证据，不拿它证明精确 crash atomicity。

### 2.4 OpenCode 的关键细节

OpenCode 最新稳定版恰好是绝对化共识的反例：

1. `opencode.db` 开启 WAL、`synchronous=NORMAL`、5 秒 busy timeout 和 foreign keys。
2. `event_sequence(aggregate_id, seq, owner_id)` 为每个 aggregate 保存最新序号；event 表对
   `(aggregate_id, seq)` 有唯一索引。
3. durable publish 在 immediate transaction 中读取最新 seq，进行 owner/重复/divergence 校验，
   运行投影，最后写 event 和 sequence；失败则整个事务回滚。
4. 同进程 run coordinator 仍按 session key 串行执行并合并 wake，说明“数据库支持并发”不等于
   “让同 session 并行跑两个 agent loop”。

所以 OpenCode 支持的不是“给 JSON 加更多手工 CAS”，而是“需要该语义时把它交给数据库”。

### 2.5 可迁移到 CodeShell 的窄共识

| 观察 | 本项目决策 |
|---|---|
| 会话历史天然适合 append log；小型当前状态天然适合 snapshot/row | 保持现有 `transcript.jsonl + state.json` 分工；goal 只在 state snapshot，不另写 journal |
| 防旧回调误伤新任务需要 stable identity | 增加随机不可变 `goalId`，`setAtMs` 只做 deadline anchor |
| 生命周期应显式表达，而不是从“字段存在”或 session status 猜 | 一个 `goalLifecycle` 判别联合 |
| 同 session 的 agent loop 通常在进程内串行 | 继续依赖 ChatSession/Engine 的 single-writer ownership；领域更新同步串行 |
| 真正多 writer 一致性由 SQLite/事务 store 解决 | 本轮不实现同 sid 多进程写；未来若要支持，整体迁移 session store |
| 未见 goal 专属多 sidecar/watermark 协议成为主流做法 | 删除 tombstone merge，绝不引入 lock/CAS/watermark/sidecar/journal |

## 3. 当前 main 的真实现状快照

### 3.1 数据模型

- `SessionStatus` 只描述 run/session 最近状态，不是 goal lifecycle
  （`packages/core/src/types.ts:195-203`）。
- `SessionState` 当前把 `activeGoal?: GoalConfig` 和 `goalTerminal?: GoalTerminal` 分开保存
  （`packages/core/src/types.ts:229-305`）。旧 state 缺 terminal 字段不会因类型层新增而崩。
- `GoalConfig` 有 objective、token/time/max-turn/max-stop-block 配置与 `setAtMs`，没有 `goalId`
  （`packages/core/src/engine/goal.ts:14-50`）。
- `GoalTerminal` 只覆盖四种 forced termination；identity 是 `objective + setAtMs`
  （`packages/core/src/engine/goal.ts:52-76`）。judge met、complete、cancel、user clear 不留同一
  类型的 terminal lifecycle。

### 3.2 写入、读取与恢复

- `readActiveGoal` 直接读 `state.json`；若 active 与 terminal identity 相同则隐藏 active
  （`packages/core/src/session/session-manager.ts:405-432`）。
- disk-only clear 读整份 state、删除 `activeGoal`、再调用通用 `saveState`
  （`packages/core/src/session/session-manager.ts:434-468`）。
- `resume` 读 state/transcript，把内存 `status` 改为 active，但本身不落盘
  （`packages/core/src/session/session-manager.ts:470-500`）。
- `saveState` 先读磁盘，选择更新的单个 tombstone，尝试保留非 tombstoned disk goal，最后
  `writeFileSync(tmp) + renameSync(target)`（`packages/core/src/session/session-manager.ts:502-533`）；
  tombstone 新旧只按 `terminatedAtMs` 比较（`:625-634`）。
- `saveState` 注释中“保护两个进程不互相 clobber”表述过强：rename 能避免半个 JSON，可见性是
  原子的；它不能让两个 read-modify-write 避免 lost update。

### 3.3 goal set、arm、终结

- Engine 的 stored goal 来源仍是 `session.state.activeGoal`；注册 hook 前有“active 匹配 terminal
  则不 arm”的 guard（`packages/core/src/engine/engine.ts:1895-1904`）。
- 显式 set 会写 `activeGoal`；same-objective restart 仍围绕 `setAtMs` 避免与最后 tombstone
  碰撞（`:1905-1927`）。run 捕获的 persisted identity 也是 `objective + setAtMs`
  （`:1929-1936`）。
- judge met 的 hook 回调直接清 active；complete_goal/confirmed cancel 通过另一个回调直接清
  active（`:1937-1966`、`:2034-2050`）。这些路径不会保存统一 terminal reason。
- TurnLoop 已返回结构化 forced terminal metadata：token/time budget
  （`packages/core/src/engine/turn-loop.ts:953-980`）、stop-block cap（`:1052-1089`）、goal-mode
  max turns（`:1407-1412`）。Engine 在 run 返回后记录 tombstone并清匹配 active
  （`packages/core/src/engine/engine.ts:2131-2155`）。
- waiting 的正确 guard 已存在：只有 judge 返回 waiting 且确有有限后台工作才允许 run 停下；
  否则回到 not_met 继续（`packages/core/src/hooks/goal-stop-hook.ts:342-364`）。该路径没有
  `goalTermination`，所以当前不会误清 goal。
- title generation 是 fire-and-forget，延迟回调继续修改捕获的整个 `session.state` 并
  `saveState`（`packages/core/src/engine/engine.ts:2263-2294`）；final run state 又整份保存
  （`:2298-2311`）。这仍是进程内 detached stale writeback 的真实来源。
- get/clear API 都仍以 active 字段为中心；live clear 必须修改 `activeRunSession` 防后续整份保存
  复活（`:2767-2815`）。

### 3.4 是否残留实验机制

对 `packages/core/src` 做精确搜索，当前 HEAD 没有：

- `goalRevision` / revision allocator；
- CAS / expected revision；
- `goalTerminalWatermark`；
- goal lockfile / lease；
- `goal-lifecycle.json` checkpoint；
- `goal-terminals/` journal；
- legacy hash/identity bridge；
- terminal history 数组。

所以重实现起点不是“拆除一套已合入的复杂协议”，而是**替换干净但表达力不足的
`activeGoal + goalTerminal` 单 tombstone，并收紧 whole-state 写入边界**。本轮无需删除任何实际
sidecar 文件或 lock 代码；这些只存在于前几轮被否决的实验 diff/审查文档中。

### 3.5 当前正确行为基线

以下是重实现不得回退的绿线：

1. stop-block、token budget、time budget、goal-mode max turns 强制终结后不可再次 arm；
2. waiting + 真实有限后台任务不清 goal；无后台任务的虚假 waiting 不成立；
3. terminal guard 在 hook 注册前执行，bare send/resume/wake 都不能让 terminal goal 从 round 1
   重来；
4. legacy state 缺少新增字段时不崩；
5. complete_goal、confirmed cancel、judge met、UI/RPC clear 都停止当前 goal；unconfirmed cancel
   不清；
6. manual Stop/`aborted_streaming` 继续保留 goal；
7. A 的延迟终结不能清掉已经替换的 B；
8. goal get/clear 在 live 与 disk-only session 都可用且保持幂等。

## 4. 支持契约与非目标

### 4.1 支持的所有权模型

本轮支持：

> 一个 session 可跨多轮、跨进程重启恢复；同一时刻只允许一个 CodeShell 进程写该 sid。同一
> 进程内，所有 state 更新必须经同一个同步 SessionManager 领域更新入口串行化。

ChatSession 已把同 sid 的 user send、background wake 和续跑排队；正常产品路径不需要两个
Engine 同时持有同 sid。进程内仍可能有延迟 title promise 等 detached callback，所以必须用字段级
更新消除 stale whole-state writeback。

### 4.2 明确不支持

**同 session 多进程并发写 = 不支持。** 包括两个 CLI 同时 `--resume <sid>`、Desktop 与独立 CLI
同时写同一 sid、新旧 binary 混合写，以及 NFS/SMB 上的多机 writer。

这是可接受的，因为：

- 该行为需要用户显式绕过正常 sid owner/queue；
- 一旦发生，受影响的是 transcript、status、usage、workspace、title 和 goal 全部数据，goal-only
  lock/CAS 不会让 session 整体一致；
- Codex/OpenCode 在需要更强语义的层面使用 SQLite；Claude 对同 session 两 terminal 的官方语义
  甚至只是 interleave，而不是提供隔离；
- 为未支持路径支付每个 heartbeat 的 lock/watermark/journal 成本，会扩大真实故障面。

若未来把同 sid 多进程写列为产品需求，升级整个 session store 到 SQLite WAL/事务，连同 transcript
排序和 session ownership 一起设计；不得把本轮删除的机制逐个补回 goal 层。

### 4.3 非目标

- 不保存无限 terminal 历史；只保存当前/最近 goal lifecycle。
- 不持久化 run-scoped stop-block round、token baseline 或 wall-clock run start。
- 不承诺掉电、内核崩溃或网络文件系统下的 durable transaction。
- 不承诺 downgrade writer 或新旧 binary 同时写。
- 不改 transcript 格式，不迁移整个 session 到数据库。
- 不触碰 image/view_image 相关文件。

## 5. 唯一推荐数据模型

### 5.1 类型

```ts
type GoalTerminalReason =
  | "judge_met"
  | "complete_goal"
  | "cancel_goal"
  | "user_cleared"
  | "stop_blocks_exhausted"
  | "token_budget_exhausted"
  | "time_budget_exhausted"
  | "max_turns_exhausted";

type GoalLifecycleConfig = Omit<GoalConfig, "goalId" | "revision" | "paused">;
type GoalLifecycleV1 =
  | {
      version: 1;
      goalId: string;
      revision: number;
      phase: "active" | "paused";
      config: GoalLifecycleConfig;
      updatedAtMs: number;
    }
  | {
      version: 1;
      goalId: string;
      revision: number;
      phase: "waiting";
      config: GoalLifecycleConfig;
      updatedAtMs: number;
      waitingSinceMs: number;
      waitingFor: "finite_background_work";
    }
  | {
      version: 1;
      goalId: string;
      revision: number;
      phase: "terminal";
      config: GoalLifecycleConfig;
      updatedAtMs: number;
      terminal: {
        reason: GoalTerminalReason;
        atMs: number;
      };
    };

interface SessionState {
  // existing fields...
  goalLifecycle?: GoalLifecycleV1;

  // 仅 legacy decode/migration 期间存在；新 writer 不再输出
  activeGoal?: GoalConfig;
  goalTerminal?: GoalTerminal;
}
```

### 5.2 不变量

1. `goalLifecycle` 是当前 goal 的唯一权威字段；禁止从其他字段拼状态。
2. `goalId` 每次显式 set/restart 都新建，包括 same-objective budget/limit 调整；A/B 是否相同只看
   ID。
3. `setAtMs` 继续做相对 deadline anchor，不再承担 identity；same-objective restart 是否保留
   anchor 沿用现有产品语义，但 ID 一定变化。
4. `active` 与 `waiting` 是 armable；`paused` 可见但不 arm；`terminal` 永不自动 arm。
5. `waiting` 表示上一 run 因有限后台任务而让出，不表示 goal 完成。它不会保存 task ID；后台
   registry/notification queue 仍是任务真相，避免把短生命期 task handle 复制进 session state。
6. terminal record 保存完整 config、reason 和时间，便于诊断；下一次显式 set 用全新 active
   record 整体替换它，不保留 terminal 集合。
7. `SessionState.status` 与 goal phase 正交。`status=completed` 不能推导 terminal；manual stop
   也不能推导 terminal。
8. unknown lifecycle version/非法 phase 一律 fail-closed：不 arm、不自动覆写原文件，并给出可诊断
   错误。

### 5.3 状态机

```text
none/terminal -- explicit set(new goalId) -----------------> active
active ------- finite background wait --------------------> waiting
waiting ------ background wake / user bare send ----------> active (same goalId)
active/waiting -- judge met / complete / confirmed cancel -> terminal
active/waiting -- user clear ------------------------------> terminal
active -------- forced stop (4 reasons) ------------------> terminal
active -------- manual Stop / aborted_streaming ----------> active (no transition)
active/waiting -- explicit replace/restart(new goalId) ----> active
terminal ------ bare send / resume / notification wake ----> terminal (no arm)
```

## 6. SessionManager 持久化边界

### 6.1 单文件原子更新原语

SessionManager 内部保留一个私有同步原语：

```text
updateState(sessionId, domainMutator):
  validate sid
  read latest state.json
  strict decode / legacy normalize
  mutate only the domain-owned fields
  write unique tmp in same directory
  rename tmp -> state.json
  return committed state (or selected committed field)
```

同步 read/write/rename 在单个 JS 进程的 event loop 中不跨 `await`，所以同进程的领域更新不会在
read 与 rename 之间交错。它不是跨进程 CAS，不接受 expected revision，也不重试未知竞争。

tmp 与 target 必须同目录；rename 成功是“新 snapshot 已提交”的可见性边界。保留当前格式化 JSON
可读性。实现可给 tmp 加随机 suffix，避免 pid + millisecond 名称碰撞；不增加 lockfile。

### 6.2 领域更新 API

运行期业务代码不得再把 detached `SessionState` 传给 public whole-state `saveState`。建议接口：

| API | 可修改字段 | 关键返回/条件 |
|---|---|---|
| `writeInitialState` | 全部 | 仅 create/fork 新 sid 内部使用；private |
| `updateRunProgress` | status、turn/usage/context/cost/cumulative counters | 返回 committed run fields |
| `completeRun` | 最终 status、turn/usage/cost | 不携带 goal/title/workspace 旧值 |
| `setSummary` / `setTitle` | 各自单字段 | fire-and-forget title 只能调 `setTitle` |
| `setWorkspace` | workspace 与明确配套的 cwd | 不覆盖 goal/usage |
| `resetUsage` / `recordCompactUsage` | usage/cumulative counters | 不覆盖 goal/title |
| `setGoal` | `goalLifecycle` | 总是生成新 goalId，返回 committed active record |
| `markGoalWaiting(expectedGoalId)` | `goalLifecycle` | ID 匹配且 active 才转 waiting，否则 no-op |
| `armGoal(expectedGoalId)` | `goalLifecycle` | waiting → active；active 幂等；terminal/no-match 不 arm |
| `terminateGoal(expectedGoalId, reason)` | `goalLifecycle` | ID 匹配且 armable 才 terminal；幂等 |
| `clearCurrentGoal` | `goalLifecycle` | 当前 armable → terminal(user_cleared)；terminal/no-goal 返回 false |
| `readArmableGoal` | 无 | active/waiting 返回 view；terminal/none/invalid 返回无 armable goal |

`expectedGoalId` 是进程内 delayed callback 的 identity guard，不是跨进程 CAS：它不排序 generation，
不暴露 compare-and-retry 协议，也不承诺另一个进程不会在 read/rename 之间覆盖。

### 6.3 live state 同步

Engine 可以保留 run 内 view，但每次领域提交后必须以返回的 committed 字段同步 live view：

- goal clear/terminal 成功后，把 live `goalLifecycle` 同步为 terminal，再撤 hook；
- transition 因 ID 不匹配而 no-op，说明新 goal 已替换旧 goal，旧 run 不得改 live/disk 的 B；
- title/usage/workspace callback 不传整个 live snapshot；
- turn boundary 与 final write 只提交 run-owned fields，永远不携带 goal snapshot；
- tool visibility、`hasGoal`、goal get 都调用 armable predicate，不再看 legacy字段是否存在。

## 7. Goal 读写路径与事件顺序

### 7.1 显式 set / replace

1. `normalizeGoal(options.goal)`；
2. 计算 deadline anchor；
3. `setGoal` 创建新随机 `goalId` 并原子提交 active lifecycle；
4. 提交成功后才发 `goal_set`；
5. 用返回的 committed record arm 本 run。

same-objective set 也属于新实例；`replaced` 只影响 UI event，不改变 ID 规则。若 commit 失败，不发
`goal_set`、不注册 goal hook。

### 7.2 bare send / resume / notification wake

所有入口在 Engine goal resolution 边界收敛：

1. 读取/必要时原子迁移 lifecycle；
2. terminal/none/invalid → 没有 stored goal，绝不注册 hook；
3. active → 使用原 ID arm；
4. waiting → 先原子 `waiting -> active`（同 ID），成功后 arm；
5. 再考虑 run-scoped `config.goal` fallback。

guard 必须在 Engine 内且早于 tool visibility、hook 注册和 TurnLoop 构造；不能只在 server wake 层
过滤，因为普通 bare send 与 CLI resume 也会继承 persisted goal。

### 7.3 waiting

GoalStopHook 保留当前“judge waiting + 至少一个真实有限后台任务”guard。Hook/TurnLoop 不直接写盘，
而是返回结构化 `goalOutcome: { kind: "waiting" }`；Engine 用本 run 的 `goalId` 调
`markGoalWaiting`。

提交 waiting 后 run 可正常 completed。后台任务完成触发 wake 时，由 7.2 将 waiting 转 active。
judge 幻觉 waiting 但 registry 为空时仍按 not_met 继续，不写 waiting。

### 7.4 terminal

Hook/TurnLoop 只报告结构化结果，Engine 是唯一持久化责任方：

| 触发 | terminal reason |
|---|---|
| judge met | `judge_met` |
| `complete_goal` | `complete_goal` |
| confirmed `cancel_goal` | `cancel_goal` |
| UI/RPC clear | `user_cleared` |
| stop-block cap | `stop_blocks_exhausted` |
| token budget | `token_budget_exhausted` |
| time budget | `time_budget_exhausted` |
| goal-mode max turns | `max_turns_exhausted` |

Engine 调 `terminateGoal(persistedRunGoal.goalId, reason)`；若磁盘已是 B，ID 不匹配则 no-op。终结
提交成功后才撤 hook、发 terminal/progress/clear 事件和 `turn_complete`。

manual Stop、stream abort、普通模型错误没有上述 goal outcome，不做 lifecycle transition；下次用户
主动 send 可继续 active goal。

### 7.5 提交与事件的线性化顺序

```text
set:       commit active   -> emit goal_set       -> register hook / run
waiting:   commit waiting  -> emit turn_complete  -> idle
terminal:  commit terminal -> emit terminal/progress -> emit turn_complete
clear:     commit terminal -> unregister live hook -> emit goal_cleared / return true
```

不得先向 UI 确认 terminal 再落盘。若持久化失败，run 返回可诊断的 persistence error；保留旧 disk
状态，不发成功事件。

## 8. 读取、迁移与兼容

### 8.1 读取优先级

1. 合法 `goalLifecycle.version === 1`：它唯一权威；即便还残留 legacy 字段也忽略 legacy，并在
   下一次新 writer 提交时删除 alias。
2. 无 lifecycle：按旧字段派生 legacy view；真正 arm/transition 前做一次单文件迁移。
3. lifecycle unknown version 或 schema 非法：fail-closed，不 arm、不用 `activeGoal` fallback，不
   自动改写文件。
4. 无任何 goal 字段：无 goal。

“valid lifecycle wins”使单文件迁移后即便旧 reader 保留 unknown JSON 字段并重写，也不会让 legacy
alias 压过 terminal guard。若外部旧 writer 用更早、完全没有 lifecycle 的 snapshot 整体覆盖新
state，则属于明确不支持的 mixed-writer 场景。

### 8.2 legacy 一次性迁移

| 旧 state 形状 | `GoalLifecycleV1` |
|---|---|
| 无 `activeGoal`、无 `goalTerminal` | 无 lifecycle |
| 只有 `activeGoal` | 新随机 ID，active，config 原样 normalize |
| active 与 terminal 的 `objective + setAtMs` 匹配 | 新随机 ID，terminal；config 来自 active，reason/at 来自 terminal |
| active 与 terminal 不匹配 | 新随机 ID，active；旧 terminal 是前一 goal 的诊断残留，不迁入当前 lifecycle |
| 只有 terminal | 新随机 ID，terminal；用 objective/setAtMs 构成最小合法 config |

迁移在内存构造完整新 state，一次 tmp + rename 同时写 lifecycle并删除 legacy 两字段。rename 前崩溃
仍是完整旧形状；rename 后是完整新形状。旧 state 缺 `setAtMs`、terminal 或所有 goal 字段都不会
崩溃。

`readArmableGoal`/goalGet 可先纯读取派生 legacy view，保持 cheap/read-only；Engine 真正 arm、clear
或任何 state domain update 时完成迁移。这样 UI 读取旧 session 不必产生写副作用。

### 8.3 版本边界

- 新 writer 不持续写 `activeGoal` compatibility alias；alias 会重建双真相。
- 支持新 binary 读取已发布的旧 `state.json`。
- 不支持旧 binary 读取后继续写已迁移 session 的语义正确性；不承诺 downgrade。
- experimental sidecar 从未合入当前 main，不纳入 runtime migration，也不扫描/合并。

## 9. 崩溃恢复语义

| 操作 | rename 前进程崩溃 | rename 后进程崩溃 |
|---|---|---|
| explicit set | 旧 goal/no-goal 仍权威；`goal_set` 尚未发 | 新 active 权威；即使事件没来得及发，也可在下次 read 恢复 |
| active → waiting | 仍为 active；下次 run 可继续推进，不丢 goal | waiting 保留；wake/bare send 可转回 active |
| terminal/clear | 旧 armable 状态仍在；成功 terminal event 尚未发 | terminal 持久；任何 resume/wake 都不 arm |
| legacy migration | 完整旧字段仍可读 | 完整 lifecycle 存在且 legacy 已删除 |
| title/usage/workspace 更新 | 保留前一完整 snapshot | 只改变该领域字段，不回退 goal/其他领域 |

语义是“原子可见 snapshot”，不是 durable power-loss transaction：当前不做 file/parent-directory
fsync。进程在终结条件发生但 terminal commit 前被 kill，下一次可能重复少量未确认工作；一旦 UI
收到 terminal 成功事件，磁盘必须已经 terminal。

JSON 语法损坏继续由 `resume` 报 `SessionError`；cheap goal probe 可返回 undefined 并记录诊断。
合法 JSON 但 lifecycle schema 损坏时不 arm，保留原文件供人工修复。

## 10. TDD 实现计划（8 步）

每一步都先提交一个只描述目标行为的失败测试，再写最小实现使该步变绿；不得先大改源码再补测。

### 步骤 1：先固定 lifecycle 纯模型

**先红：** 在 `packages/core/src/engine/goal.test.ts` 增加：

- active/waiting armable、terminal 不 armable；
- terminal reason 完整枚举；
- 每次 set 产生新 goalId，same objective 也不同；
- `setAtMs` 与 identity 解耦；
- A/B expected ID 判定的纯函数。

**再绿：** 修改 `packages/core/src/engine/goal.ts` 与 `packages/core/src/types.ts`，加入
`GoalLifecycleV1`、reason、armable predicate 和 ID factory seam；暂不接 Engine。

### 步骤 2：先固定 legacy decode/migration

**先红：** 新增
`packages/core/src/session/session-manager.goal-lifecycle.test.ts`，用 raw `state.json` fixture 覆盖
8.2 的五种旧形状，以及 valid lifecycle + legacy alias、unknown version、非法 phase、缺字段。
断言旧 state 不崩、matching terminal 不 arm、unknown version fail-closed、迁移后只剩 lifecycle。

**再绿：** 在 `session-manager.ts` 实现纯 decoder、read-only armable view 与单文件 migration；不改
Engine 行为。

### 步骤 3：先消除 detached whole-state writeback

**先红：**

- 把 `session-manager.cleargoal-stale-writeback.test.ts` 中当前标记 `BUG` 的“goal 会复活”断言反转；
- 新增 `session-manager.state-domain-update.test.ts`：delayed title、turn heartbeat、usage reset、
  workspace update 与 goal terminal 任意顺序都不得互相覆盖；
- 加 fault seam 测试：rename 前失败保留旧完整 state，rename 后读到新完整 state。

**再绿：** 在 `session-manager.ts` 增加 private `updateState` 与 run/title/workspace/usage/goal 领域
API；先迁移 Engine 的全部非 goal delayed callback 和 heartbeat/final save call sites，使 title
不再持有旧 snapshot。尚未在步骤 4-6 接完的旧 goal call site 可暂时经过一个明确标记 deprecated
的内部兼容入口；不得让新非 goal 代码继续使用，步骤 8 必须将其连同 public whole-state writer
一并删除。

### 步骤 4：先固定 set、replace 与 arm guard

**先红：** 扩展 `turn-loop-goal-lifecycle.test.ts` 与 `tests/engine-persistent-goal.test.ts`：

- explicit set 持久化 active lifecycle；
- same-objective restart/new-objective replace 都生成新 ID；
- bare send 继承 active；waiting 恢复时同 ID 转 active；
- terminal lifecycle 在 bare send、resume 前不注册 hook、不显示 goal tool；
- run A 延迟回调不能改变 B。

**再绿：** 改 `engine.ts` goal resolution、tool visibility 与 hook registration，统一调用
SessionManager set/arm API；删除以 `objective + setAtMs` 捕获 run identity 的代码。

### 步骤 5：先固定四类 forced termination

**先红：** 在 `turn-loop-goal-lifecycle.test.ts` 补齐并统一断言：

- stop-block、token budget、time budget、goal-mode max turns 各写准确 terminal reason；
- terminal 后 state 没有 armable goal；
- 下一次 bare send/resume 不发 `goal_progress round=1`；
- terminal commit 失败时不发 exhausted/terminal 成功事件。

**再绿：** 保留 TurnLoop 已有 structured metadata，改 Engine 用 expected goalId 统一
`terminateGoal`；把 terminal/progress event 移到 commit 后。

### 步骤 6：先固定 waiting 与非 forced terminal

**先红：** 扩展 `goal-stop-hook.test.ts`、`turn-loop-goal-lifecycle.test.ts`、
`tests/engine-goal-cancel.test.ts`：

- 真实有限后台任务：active → waiting，run completed 但 goal 可恢复；
- waiting:true 无后台任务：不进入 waiting；
- judge met、complete_goal、confirmed cancel、user clear 写各自 reason；
- unconfirmed cancel 和 manual Stop 保留 active；
- clear commit 成功后才撤 hook/发 `goal_cleared`。

**再绿：** GoalStopHook/TurnLoop 改为只返回 `waiting | terminal` structured outcome；Engine 统一
持久化。删除 hook 内 `onMet` 直接写盘和 TurnLoop `clearPersistedGoal` 直接写盘副作用。

### 步骤 7：先固定 host 恢复链路

**先红：** 扩展 `server.goalget.test.ts`、`server.goalclear.test.ts`、
`tests/engine-goal-background-video.test.ts`，必要时新增 notification wake 集成测试：

- disk-only get 对 active/waiting 返回 objective，对 terminal 返回 null；
- live/disk-only clear 幂等并持久 terminal；
- background completion 只把 waiting goal 唤醒一次；
- terminal goal 的 notification 不 re-arm；
- worker restart 后 active/waiting/terminal 恢复符合第 9 节。

**再绿：** 保持外部 RPC shape，内部切到 lifecycle API；只在确有必要时修改
`protocol/server.ts`、`chat-session.ts` 和 desktop disk fallback，避免 host 层复制状态判断。

### 步骤 8：先用守卫测试驱动旧机制删除

**先红：** 加静态/行为 guard：

- 运行期业务源码不得直接调用 public whole-state `saveState`；
- 新 writer 输出不含 `activeGoal`/`goalTerminal`；
- 源码不含 revision/CAS/watermark/goal lock/sidecar/journal 路径；
- 全部旧绿线和新矩阵通过。

**再绿：** 删除 `GoalTerminal` runtime model、`isSameGoalInstance`、`newestGoalTerminal`、特殊
tombstone merge、Engine 的 direct field mutations 和过时注释；替换旧测试中的 tombstone shape
断言。最后跑 goal 定向套件与 `bun test packages/core`。

## 11. 必保留行为的回归清单

| 验收行为 | 主要测试落点 |
|---|---|
| 四类 forced termination 终结即无 armable goal | `turn-loop-goal-lifecycle.test.ts` 四个独立 case |
| waiting 不误清；无后台 work 的 waiting 不成立 | `goal-stop-hook.test.ts` + Engine waiting integration |
| terminal arm guard 覆盖 bare/resume/wake，round 不从 1 重来 | Engine lifecycle + protocol wake integration |
| 旧 state 缺新字段不崩 | `session-manager.goal-lifecycle.test.ts` raw fixtures |
| judge met / complete / confirmed cancel / clear 统一 terminal | Engine cancel/persistent goal tests |
| unconfirmed cancel/manual Stop 保留 goal | cancel + abort regression |
| A terminal 不改变 B | immutable ID + detached callback regression |
| title/usage/workspace/run 更新不覆盖 goal | state-domain-update permutation tests |
| get/clear live 与 disk-only 行为稳定 | protocol server goalget/goalclear tests |
| commit-before-event | stream event ordering/failure injection |
| corruption/unknown version 不 arm、不覆写 | lifecycle decoder tests |

## 12. 影响面与删除清单

### 12.1 必改源码

| 文件 | 变化 |
|---|---|
| `packages/core/src/types.ts` | `goalLifecycle` 成为权威；legacy 字段只留迁移 decode 期类型，最终新 writer 不输出 |
| `packages/core/src/engine/goal.ts` | lifecycle/reason/armable/ID helpers；删除 `GoalTerminal` 与 `objective+setAtMs` identity |
| `packages/core/src/session/session-manager.ts` | latest-state 领域更新、原子迁移、goal transitions；删除 tombstone merge/newest helper |
| `packages/core/src/engine/engine.ts` | set/arm/wait/terminal 单一入口，commit-before-event；所有 whole-state save call site 改为领域更新 |
| `packages/core/src/engine/turn-loop.ts` | forced metadata 保留；补 unified waiting/non-forced terminal outcome，移除持久化 callback |
| `packages/core/src/hooks/goal-stop-hook.ts` | 保留 judge/waiting guard；返回 outcome，不直接 onMet 写盘 |
| `packages/core/src/protocol/server.ts` / `chat-session.ts` | 外部 shape 不变，内部只消费 lifecycle API；仅按测试需要改 |
| desktop disk fallback | 继续调用稳定 get/clear API，不读取 state 内部字段；仅按测试需要改 |

### 12.2 必改/新增测试

- 修改现有 goal、hook、persistent/cancel、server goalget/goalclear 测试；
- 新增 `session-manager.goal-lifecycle.test.ts`；
- 新增 `session-manager.state-domain-update.test.ts`；
- 将 `session-manager.cleargoal-stale-writeback.test.ts` 从“记录 BUG”改为“不可复活”回归；
- 补 time-budget、真实 notification wake、commit-before-event 与 unknown-version case。

### 12.3 相对当前 main 要删除什么

当前 main 没有 CAS/watermark/sidecar/journal/goal lock，所以**没有对应实现文件可删**。实际删除项是：

- `SessionState.activeGoal` / `goalTerminal` 的新写路径；
- `GoalTerminal`、`isSameGoalInstance`、`newestGoalTerminal`；
- `saveState` 中 goal tombstone 的 read/merge/write 特判；
- Engine 中所有 direct `session.state.activeGoal = ...` / `goalTerminal = ...`；
- 以最后 tombstone、同毫秒 `setAtMs + 1` 为中心的 guard；
- 过时的 tombstone 测试与注释。

legacy 字段名可能暂时保留在 decoder/type 中，直到迁移测试证明旧 state 全覆盖；这不等于继续写
compatibility alias。

## 13. 风险与控制

| 风险 | 控制 |
|---|---|
| whole-state call site 漏迁移，旧 snapshot 仍可覆盖 | 先枚举全部 `saveState`；步骤 8 加源码 guard；领域更新 permutation 测试 |
| waiting 被 terminal 化或永远不醒 | 独立 waiting phase；真实 background-work guard；notification integration |
| terminal event 早于 commit | Engine 单一责任方；注入 commit failure，断言无成功 event |
| legacy matching 误清新 active | 只在“无 lifecycle”的一次迁移使用旧 identity；迁移后只认 goalId |
| same-objective restart 误判同实例 | 每次 explicit set 新 ID；anchor 与 identity 分离 |
| invalid lifecycle 静默丢 goal | strict decode、fail-closed、不覆写、可诊断错误 |
| 字段级 API 过度碎片化 | 按领域而非每字段分组；private update primitive，公开有限业务动作 |
| 用户实际启动两个 writer | 明确 unsupported；不提供虚假 goal-only safety；未来整体 SQLite 化 |
| tmp + rename 被误称为掉电事务 | 文档和测试只承诺进程崩溃下原子可见性；不承诺 fsync durability |
| 当前未跟踪 docs 被误伤 | 实现阶段在干净分支/worktree 工作；不得 reset 当前用户文件 |

## 14. 完成门槛

后续实现只有同时满足以下条件才可合入：

1. 第 10 节 8 个 TDD 步骤逐步完成；
2. 第 11 节回归矩阵全部绿；
3. runtime 不再有 public whole-state save；
4. 新 state 只写 `goalLifecycle`，旧 state 可一次性迁移；
5. 无 revision/CAS/watermark/goal lock/sidecar/journal；
6. 同 sid 多进程写在文档/API 契约中明确为 unsupported；
7. goal 定向套件和 `bun test packages/core` 通过；
8. 未修改任何 view_image/image-history 文件。

## 15. 最终决策记录

- **行业结论：** 原“所有人都只用单文件且没人用 sequence/锁”被当前 Codex/OpenCode 实现推翻；
  可用的窄共识是“简单路径单 writer，复杂并发直接用事务数据库，不给单个 goal 自造多文件一致性
  协议”。
- **当前起点：** `2082ebcd` 是 `activeGoal + goalTerminal` 单 tombstone，没有实验性复杂机制；
  forced terminal/waiting/arm guard 行为已经正确，主要债务是双字段状态、脆弱 identity 与
  whole-state writeback。
- **目标形态：** 一个 `state.json.goalLifecycle`，`active | waiting | terminal`，随机 goalId，
  Engine-owned transition，latest-state 领域更新，tmp + rename。
- **并发契约：** 同 sid 多进程 writer 不支持；未来若需求改变，整体迁移到 SQLite，而不是恢复
  lock/CAS/watermark/sidecar/journal。
- **实施方式：** 8 步 TDD，先固定模型和迁移，再收紧 state writer，最后接 Engine/host 并删除旧
  tombstone 路径。
