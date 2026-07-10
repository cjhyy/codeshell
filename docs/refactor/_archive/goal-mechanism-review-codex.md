# Goal 持久化新机制：独立第三方代码审查

## 结论

**NEEDS-WORK**

审查基线为当前 `HEAD d97f95f4` 上的未提交 goal 相关 diff。范围严格限定为用户指定的
`types.ts`、`goal.ts`、`engine.ts`、`session-manager.ts` 及 goal 测试；明确排除了
`compaction.ts`、`turn-loop.ts`、`view-image*` 和 image-history 改动。除本报告外没有修改
源码，也没有 commit。

这版的正常并发主路径比上一轮可靠得多：`goalId` 与 deadline anchor 已解耦；新进程都遵守
锁时，revision 在锁内分配且不会撞号；detached A 的终结写回不会删除磁盘上的 B；65 代以后
watermark 仍能压制旧 revision；waiting goal 在完整写入后也不会被正常 watermark 推进误杀。
我用 8 个真实 Bun 子进程同时从同一初始 session 设置不同 goal，实际得到唯一的 revision
`1..8`，最终 checkpoint 为 revision 8 / watermark 7。

但新机制自身还有三个确定的正确性 blocker，加上一个版本兼容 blocker：

1. lockfile 的 stale-owner 抢占与无条件 unlink 会制造 split-brain，不能保证临界区互斥；
2. legacy 迁移在 checkpoint 已发布、state 尚未发布时崩溃，会永久隐藏仍合法的 legacy/waiting
   goal；
3. legacy goal 的 disk-only clear 仍没有 revision/horizon，仓库中的测试甚至继续把 stale
   复活固定为预期行为；
4. 新旧 binary 只有 JSON shape 不崩，不具备双向行为兼容：旧 binary 设置的合法新 goal 会被
   新 binary 当成 stale revisionless value 拒绝。

因此当前不能 SHIP，也不属于只有小问题的 SHIP-with-nits。

## Blockers

### 1. `[blocker]` stale lock 抢占可让两个 writer 同时持有“锁”，旧 owner 还会删除新 owner 的锁

- `packages/core/src/session/session-manager.ts:645-665` 用
  `openSync(lockPath, "wx")` 创建零字节 lockfile；遇到 `EEXIST` 后，只凭 mtime 超过 30 秒就
  `unlinkSync`。
- `packages/core/src/session/session-manager.ts:666-676` release 时不验证路径当前是否仍属于自己，
  直接 close 自己的 fd 后 `unlinkSync(lockPath)`。

可复现的执行序列：

1. writer A 创建锁并继续持有 fd；进程暂停、机器 suspend/resume、debugger、长 GC 或慢文件系统
   使 lockfile 年龄超过 30 秒；
2. writer B 删除 A 的 lockfile，再用同一路径创建自己的 lockfile；
3. A 恢复并 release；A 关闭旧 inode 的 fd，却把路径上 **B 的新 lockfile** 删除；
4. writer C 随即成功创建该路径，在 B 仍处于临界区时进入。

我在临时目录直接驱动当前 lock primitive 复现：B 获取锁后路径存在；A release 后路径消失；
C 在 B 的 fd 尚未释放时成功获取锁。这样 `saveState` 的 read/compare/sidecar writes/state rename
就不再是串行 CAS，revision 可重新发生竞争，三文件写入也会交错。

对问题 (a) 的明确回答：

- 没有常规的多锁顺序死锁；这里只取一把 per-session 锁，且 `saveState` 内没有递归取锁。
- 持锁进程崩溃会留下 lockfile，但通常不是永久泄漏：30 秒后会尝试删除。问题是单次 waiter
  只等 5 秒（`:648,660-663`），所以崩溃后的前若干次保存会同步阻塞 5 秒再抛错；若 unlink
  因权限/文件系统语义持续失败，则可以永久写不进。
- 拿不到锁的降级是抛 `SessionError`，没有覆盖磁盘，属于 fail-closed；数据安全优于静默
  last-write-wins，但会把普通 turn boundary/final save 变成 run failure/5 秒主线程冻结。
- `O_EXCL` lockfile + mtime lease 不是经过验证的 Windows/NFS/SMB 锁协议。Windows 对仍打开文件
  的删除语义、网络文件系统的 attribute cache/时钟与原子创建语义都可能不同；当前没有平台
  限制说明或测试，不能宣称跨平台可靠。

修复至少需要 owner token/nonce，并在 stale break 与 release 时确认路径仍是自己的 generation；
若允许抢占 live-but-slow owner，还要 heartbeat/lease fencing token，使旧 owner 恢复后无法提交。
更稳妥的是采用已有、明确支持目标平台的 advisory-lock/lockfile 实现。必须补真实多进程测试：
正常争用、owner crash、超过 stale threshold 但 owner 仍活、旧 owner 延迟 release、超时 fail-closed。

### 2. `[blocker]` checkpoint-before-state 的迁移崩溃前缀会误清合法 legacy goal

- Engine 对 raw legacy goal 生成 `goalId + legacyIdentity` 后调用 `saveState`
  （`packages/core/src/engine/engine.ts:2093-2103`）。
- `saveState` 在锁内给它分配 revision（`packages/core/src/session/session-manager.ts:567-585`）。
- 写入顺序是 terminal journal → `goal-lifecycle.json` → prune → `state.json`
  （`packages/core/src/session/session-manager.ts:631-639`）。
- 读取时，只要 checkpoint 表示 session 已有任意 modern revision，任何 revisionless active goal
  都被压制（`packages/core/src/session/session-manager.ts:967-980`）。

因此存在以下合法崩溃前缀：

1. `state.json` 中有一个仍 active、可能正在 waiting 的 legacy goal L；
2. resume 惰性迁移 L，锁内给迁移结果 M 分配 revision 1；
3. `goal-lifecycle.json={goalRevision:1, goalTerminalWatermark:0}` rename 成功；
4. 进程在 M 的 `state.json` rename 前崩溃，磁盘 state 仍是 revisionless L；
5. 下次 `readActiveGoal`/`resume` 看到 `currentRevision=1`，无 terminal 也把 L 清掉。

临时目录复现结果是：磁盘 `state.json.activeGoal` 仍完整包含合法 legacy goal，但
`readActiveGoal()` 与 `resume().state.activeGoal` 都为 `undefined`。这不是“新 set 未确认所以允许
丢失”：迁移没有创造产品层 replacement，L 在迁移前已经是已确认的持久化 active goal。

对问题 (b) 的明确回答：三文件不具备事务一致性。当前顺序对 terminal/clear 的普通**进程崩溃
前缀**偏保守——journal/checkpoint 先成功可防 stale arm——但对迁移不安全，会误清合法 goal；
replacement 发布中途也会出现旧 goal 已被 checkpoint 压制、新 goal 尚未出现在 state 的窗口。
此外所有写入都没有 `fsync` 文件与父目录，`writeFileSync + renameSync` 只提供可见性原子替换，
不提供掉电/内核崩溃后的持久顺序；prune 可能比 checkpoint 更持久，不能把该顺序视为
crash-durable transaction。

应让 authoritative checkpoint 同时包含足以恢复当前 active goal/迁移映射的数据，或把整个
goal lifecycle 合并为一个原子替换的权威文件。至少要加 fault-injection 测试，在每个
write/rename/prune 边界崩溃后重新构造 `SessionManager`，验证不会 arm terminal goal，也不会丢
waiting/legacy active goal。

### 3. `[blocker]` disk-only clear 一个 legacy goal 时不分配 revision，stale writer 仍可复活它

- `clearActiveGoal` 在锁外读 state，直接删除 `activeGoal` 再走通用 `saveState`
  （`packages/core/src/session/session-manager.ts:468-485`）。
- clear 只有在磁盘 goal 已有正 revision 时才推进 watermark
  （`packages/core/src/session/session-manager.ts:609-618`）。
- raw legacy goal 的 disk revision 和 caller revision 都是 0，因此该 clear 不留下 checkpoint
  horizon、terminal 或 legacy bridge。

结果是：pre-upgrade session 的 legacy goal 被 UI/idle Engine 成功 clear 后，只要迁移前的 detached
writer 再保存一次，goal 就重新出现。无需旧 binary；两个当前 `SessionManager` 对象即可复现。
现有测试已经直接证明并固定了这个未闭环行为：
`packages/core/src/session/session-manager.cleargoal-stale-writeback.test.ts:41-56` 名称仍是
`BUG: clearing a DETACHED copy is defeated...`，并断言 stale save 后 goal 复活。

legacy bridge 只在 Engine arm/migrate 路径建立（`packages/core/src/engine/engine.ts:2093-2103`），
没有覆盖“用户在运行前直接 clear 旧 goal”这一合法生命周期入口。应把 clear 做成锁内的专用
goal transition：对当前 legacy disk goal 先建立可持久化的 migrated revision/legacy identity，
再原子推进 watermark，或记录等价的 legacy clear fact。补充
`legacy state → detached snapshot → clearActiveGoal → stale save/raw overwrite` 回归，并把当前
`BUG` 测试改成不可复活断言。

### 4. `[blocker]` 新旧 binary 仅 shape 兼容，不是双向行为兼容

新 binary 读取一份从未见过新机制的旧 state 时，正常路径是正确的：checkpoint 为 0，legacy
goal 不会在 resume 阶段被压制，Engine 随后能迁移它。SHA-256 bridge 也能压制迁移前 snapshot。

反方向不成立：

- 一旦 checkpoint 有任意 modern revision，`goalIsSuppressed` 会无条件拒绝所有 revisionless goal
  （`packages/core/src/session/session-manager.ts:977-980`）。
- `d97f95f4` binary 不知道 `goalId/goalRevision`；显式 set 经旧 `normalizeGoal` 后会写一个合法但
  revisionless 的新 goal。新 binary 看到独立 checkpoint 后会把它当成 stale snapshot，而不是新
  set。我用当前 checkpoint + 模拟旧 whole-state writer 复现：磁盘明明含“old binary 新设置的
  goal”，`readActiveGoal()` 返回 `undefined`。
- 旧 binary 读新 state 虽不会因额外 JSON 字段崩溃，但它仍按 `objective + setAtMs` 判断 identity
  （`d97f95f4 packages/core/src/engine/goal.ts:71-76` 和
  `session/session-manager.ts:425-428`）。当前实现允许 same-objective replacement 保留相同
  `setAtMs`（`packages/core/src/engine/engine.ts:2078-2085`），同时继续写单槽 compatibility alias
  （`packages/core/src/types.ts:311-314`）。因此 alias 若是 terminal A，旧 binary 会把拥有新 ID 的
  合法 replacement B 误认成 A 并压制。

这里的 SHA-256 **密码学碰撞**风险可忽略；输入是带 tag 的 JSON tuple，也没有拼接歧义。实际风险
是协议层不可区分：同 objective/setAt 的旧 binary 新 set 与真正的 pre-migration stale snapshot
具有完全相同的 legacy identity。不能靠换 hash 解决。

如果项目明确不支持 downgrade、rolling upgrade 或同一 session 的新旧进程并存，应删除“双向
兼容”的表述，落盘 lifecycle version fence，并让旧 binary fail clearly，而不是表面可读后静默
丢 goal。若必须支持混合版本，就需要旧 writer 也参与 revision 分配/锁协议；仅靠新 reader
无法区分“旧格式的新写入”和“旧格式的 stale 写回”。

## Nits / 非阻断问题

### 5. `[nit]` JSON 语法损坏可降级，但 schema-valid-looking corruption 可推进任意 watermark

`readGoalLifecycleCheckpoint` 对缺文件/无效 JSON 返回 0（
`packages/core/src/session/session-manager.ts:685-696`），journal 也逐文件 catch；它们不会直接让
resume 崩溃。locked save 还会删除 malformed/noncanonical journal 与 journal tmp，并可从
state cache 修复 canonical terminal（`:753-802`）；这一点比上一轮健壮。

但 `isGoalTerminal` 只检查 `objective` 和 `reason` 是字符串（`:920-924`），没有校验 reason union、
goalId、legacyIdentity、terminatedAtMs 或字段组合。随后任何看似合法的高 `goalRevision` 都被并入
watermark（`:557-562`）。一个语法合法但内容损坏的 terminal/checkpoint 可以把合法 active goal
整体压掉。反过来，checkpoint 损坏后若 state 又被 foreign writer 擦掉新字段、旧 terminal 已从
64 项 journal 淘汰，永久压制保证也会消失。建议用严格 schema/version 校验，拒绝不可能的
`watermark > goalRevision`、unknown version 和不合法 reason，并明确损坏时是 fail-open 还是
fail-closed；当前是两者混合。

### 6. `[nit]` revision 在 `Number.MAX_SAFE_INTEGER` 处没有显式失败，下一次分配会写出不可用 goal

读取只接受正的 safe integer（`packages/core/src/session/session-manager.ts:983-985`），但分配直接
执行 `currentRevision + 1`（`:578-584`）。当 current 已为 `Number.MAX_SAFE_INTEGER` 时，新值变成
unsafe integer；下一次读取把 active goal 的 revision 判为无效，再因 `currentRevision > 0` 将其
作为 revisionless stale value 压制。自然运行达到该值不现实，但持久化损坏/手工迁移可以触发。
应在加一前显式报“revision exhausted/corrupt”，不要成功写入随后立即不可见的 goal。

### 7. `[nit]` 每次 `saveState` 都同步取锁并扫描 sidecars，影响范围远超 goal transition

`saveState` 无论 session 是否有 goal，都会创建/删除 lockfile、重读并 parse `state.json`、尝试读
checkpoint、扫描 journal，再写 state（`packages/core/src/session/session-manager.ts:521-643`）。
有 64 个 terminal 时还会同步 `readdir/readFile/JSON.parse/exists` 多个小文件；争用时
`Atomics.wait` 最多阻塞主线程 5 秒。该路径出现在 turn boundary、usage heartbeat、title 回写和
final save 等高频位置。锁粒度是 per-session，跨 session 不互相阻塞，这是正面点；但同 session
的非 goal 写也承担全部成本。

现有测试没有 I/O 次数、p95 latency 或 event-loop stall 门槛。建议把权威 goal transition 拆成
低频专用方法，普通 heartbeat 只写非 goal state/cache；至少增加 0/1/64 terminal 的本地与慢盘
基准。

### 8. `[nit]` 正常 terminal 目录会收敛，但 lifecycle tmp 与非规范非 tmp 文件没有完整清理策略

有效 canonical terminal 正常会收敛到 64 项；journal 内 malformed `.json`、noncanonical `.json`
和包含 `.tmp` 的文件会在 locked save 时清理（`packages/core/src/session/session-manager.ts:753-825`）。
所以正常 writer 产生的 terminal 文件不再无限增长。

仍有两个边角：

- `goal-lifecycle.json.<pid>.<time>.tmp` 位于 session 根目录，当前没有清理；每次恰好崩溃在该写入
  都可留下一个 orphan。`state.json.*.tmp` 是既有同类问题。
- journal 内既非 `.json`、名称又不含 `.tmp` 的文件永不清理；这不影响正常 writer，但损坏/
  外部文件会永久存在。

### 9. `[nit]` `atomic rename` 没有 durability 契约，网络文件系统支持也未定义

所有 sidecar/state 写都是 tmp + rename，但没有 fsync tmp、target 或父目录。若契约只覆盖进程
崩溃，可依赖已完成 syscall 的普通可见性；若“崩溃安全”包含断电/内核崩溃，就不能保证三个
rename 与 prune 的持久顺序。NFS/SMB 上 O_EXCL、rename、mtime cache 的组合还需按实际挂载协议
验证。建议明确支持矩阵与 crash model；否则评论中的“real cross-process CAS boundary”表述过强。

## 机制逐项判定

| 核查项 | 判定 |
|---|---|
| 当前 binary、正常本地文件系统、锁未过期的并发 revision 分配 | 通过；8 个真实进程得到唯一 `1..8` |
| 两个 writer 同时设置新 goal | 通过；锁获取顺序给出全序，后 linearize 的 writer 获得更高 revision |
| detached A terminal vs disk B | 通过；字段级 merge 保留 B、合入 A terminal |
| retention >64 / wall-clock 回拨 | 通过；revision 排序 + watermark 不依赖 terminatedAt wall clock |
| watermark 比较边界 | `revision <= watermark` 正确；等于 watermark 的 generation 已 terminal/clear/replaced |
| 完整落盘的合法高 revision 新 goal | 不会被正常 watermark 误伤；`N > N-1`，waiting 测试保留 active goal |
| revisionless legacy/旧 binary 新 goal | 不通过；只要 currentRevision >0 就一律压制 |
| legacy 迁移后 terminal bridge | 正常完整写入路径通过；迁移 checkpoint/state 崩溃前缀不通过 |
| legacy disk-only clear 的 stale writeback | 不通过；没有 revision/horizon，现有测试固定了复活行为 |
| stale-lock/live-owner | 不通过；可 split-brain，CAS 临界区失效 |
| terminal/checkpoint/state 进程崩溃中间态 | terminal/replacement 多数前缀 fail-closed；migration 前缀会丢合法 goal，整体不安全 |
| malformed journal / orphan journal tmp | 通过基本收敛；locked save 可删除并从 state cache 修复 |
| malformed checkpoint / semantic corruption | 不充分；语法错误归零，合法形状的坏 revision 可误杀/丢保护 |
| Windows/NFS/SMB | 未证明；没有支持声明或测试 |

## 用户要求的四问直答

- **(a) 跨进程锁有无死锁/泄漏风险？** 没有常规多锁死锁；崩溃锁通常 30 秒后可回收，但期间
  waiter 会最多阻塞 5 秒并抛错，unlink 持续失败时可永久卡住。更严重的是 stale 抢占会让旧
  owner 删除新 owner 的锁并形成 split-brain，所以当前锁不满足 CAS 互斥保证。
- **(b) 三文件崩溃中间态是否安全？** 否。terminal/clear 的多数进程崩溃前缀会 fail-closed，
  但 migration 在 checkpoint 成功、state rename 前崩溃会误清合法 legacy/waiting goal；无 fsync
  时也不具备掉电持久顺序。
- **(c) watermark 会不会误伤合法新 goal？** 完整提交、带合法高 revision 的 modern goal 不会；
  `revision <= watermark` 的边界正确，正常 waiting goal 也会保留。但 revisionless 的合法旧
  binary 新 goal 会被 `currentRevision > 0` blanket guard 误杀，迁移 partial commit 也会误杀
  legacy goal；语义损坏的高 watermark/terminal 还可压掉合法 goal。
- **(d) 是否过度工程、能否简化？** 只修原始单会话 exhausted 残留时明显过度；若确实承诺任意
  stale 跨进程 writer 永不复活，则 revision/CAS/外部权威状态有必要，但三套持久化真相和每次
  heartbeat 全量参与没有必要。可简化成一个权威 lifecycle 文件 + 只在 goal transition 上取锁。

## 回归测试真实性与缺口

上一轮要求的三个直接回归，这次不是同一 live object 假绿：

1. detached A terminal vs disk B 使用两个 `SessionManager` 和两个不相同的 state 对象，A 从未观察
   B（`packages/core/src/session/session-manager.cleargoal-stale-writeback.test.ts:216-263`）；它
   真实覆盖字段级 stale merge。
2. 65 代测试保留 revision 1 的完整 stale state，淘汰其 terminal 后直接 foreign overwrite
   `state.json`，再靠 sidecar watermark 压制（`:265-309`）；它真实覆盖 retention blocker。
3. legacy migration 测试保存迁移前 snapshot，Engine 完成迁移+终结后用另一个 manager 写回
   snapshot（`packages/core/src/engine/turn-loop-goal-lifecycle.test.ts:841-904`）；它真实覆盖上一轮
   identity bridge blocker。

Engine 内的 replacement 测试 `turn-loop-goal-lifecycle.test.ts:686-788` 仍通过回调直接改同一 live
bundle，单独看仍不足以证明 detached writer 安全；但上面的 SessionManager 独立对象测试已经补上
了真正的 writer 竞争语义。

关键测试缺口：

1. 没有 child-process/worker 级锁争用；没有 owner crash、stale threshold、延迟 release、超时与
   stale breaker 测试。
2. 没有两个真实并发 writer 同时分配 revision 的仓库回归；当前测试全是顺序调用。我的临时
   8-process probe 通过，但不替代可持续回归。
3. 没有在 journal/checkpoint/prune/state 各 write/rename 边界注入崩溃；因此没有发现 blocker 2。
4. 有 journal corruption + orphan journal tmp 修复测试（
   `session-manager.cleargoal-stale-writeback.test.ts:341-368`），但没有 corrupt/missing checkpoint、
   semantically malformed terminal、高 watermark、goal-lifecycle tmp、掉电顺序测试。
5. waiting 测试覆盖正常完整写入保留（`turn-loop-goal-lifecycle.test.ts:603-637`），没有覆盖迁移
   checkpoint 已写/state 未写或合法 high revision 与异常 watermark 的组合。
6. 没有 downgrade/old binary 新 set 测试；没有 old reader 对 same-objective replacement + legacy
   alias 的误压制测试。
7. 现有 `session-manager.cleargoal-stale-writeback.test.ts:41-56` 反而继续断言 legacy clear 后可被
   detached save 复活；这是未闭环 blocker 的证据，不应作为可接受长期契约。

## 验证结果

用户指定的 goal 相关测试：

```text
bun test \
  packages/core/src/engine/turn-loop-goal-lifecycle.test.ts \
  packages/core/src/session/session-manager.cleargoal.test.ts \
  packages/core/src/session/session-manager.cleargoal-stale-writeback.test.ts \
  packages/core/src/session/session-manager.readgoal.test.ts \
  packages/core/src/engine/goal.test.ts \
  packages/core/src/hooks/goal-stop-hook.test.ts

98 pass / 0 fail / 231 expect() / 6 files / 1.11s
```

完整 core 套件：

```text
bun test packages/core

2437 pass / 6 skip / 0 fail / 6022 expect() / 407 files / 26.58s
```

临时目录、未写入仓库的独立 probes：

```json
{
  "normalConcurrentAllocation": {
    "processes": 8,
    "allocatedRevisions": [1, 2, 3, 4, 5, 6, 7, 8],
    "checkpointRevision": 8,
    "checkpointWatermark": 7
  },
  "staleLockOwner": {
    "newOwnerLockExistedBeforeOldRelease": true,
    "lockExistedAfterOldRelease": false,
    "thirdWriterEnteredWhileNewOwnerStillHeldFd": true
  },
  "migrationCrashPrefix": {
    "diskStillContainedLegacyActiveGoal": true,
    "readActiveGoal": null,
    "resumeActiveGoal": null
  },
  "oldBinaryNewGoal": {
    "diskContainedRevisionlessNewGoal": true,
    "newReaderReturned": null
  }
}
```

全绿测试证明已覆盖的正常路径成立，不反驳上述未覆盖的 lock/partial-commit/legacy-clear 反例。

## 复杂度与更简单方案

对问题 (d) 的工程判断：**若原始产品目标只是修复单会话 exhausted 后 live state 残留，这套
“state cache + lifecycle checkpoint + per-terminal journal + 每次 saveState 锁与 merge”明显过度
工程。** 结构化 termination、在最终 writeback 前清 live bundle、每次显式 set 使用不可变 ID，
已经能修现场主路径。

若 ship gate 确实要求“同一 session 多进程并发，且任意年龄 stale/foreign whole-state writer 永不
复活 terminal goal”，那么单调 revision、CAS 与 state 外权威事实是合理且接近必要的；复杂度本身
不是错误。过度之处在于把权威状态拆成三个位置，并让所有非 goal heartbeat 都参与该协议。

更简单的等价方向：

1. 使用一个权威 `goal-lifecycle.json`，内容包含 `{version, revision, watermark, activeGoal,
   legacyBridge, recentTerminals}`；`state.json.activeGoal` 只作旧 UI/binary compatibility cache，
   新 reader 永远以 lifecycle 文件为准。
2. 只在 `set/replace/clear/terminal/migrate` 这些 goal transition 上取一把可靠的 per-session 锁，并
   原子替换这一份文件；heartbeat/final state save 不扫描 64 个文件，也不能改变 goal 权威状态。
3. transition 接受 `expectedRevision`，锁内 compare 后分配 `nextRevision`。clear legacy 时也在同一
   transition 内先建立 revision/bridge。一个文件使 crash recovery 与 fault injection 明显简单。
4. recent terminals 若只用于诊断就放在同一文件做 bounded ring；“永不复活”的语义只依赖
   watermark，不需要 64 个独立 inode。若确实需要 append-only audit，再使用真正 append-only log
   或 SQLite transaction，而不是同时维护 cache/checkpoint/目录三套真相。
5. 明确升级边界：要么要求同一 session 只能由新 binary 写并设置 version fence，要么给旧 binary
   升级协议；不要承诺无法实现的 mixed-version writer compatibility。

如果产品实际上不支持同一 session 的多进程 writer，最简单且风险最低的选择是明确 single-writer
ownership，保留 live-bundle clear + immutable goalId + arm guard，删除跨进程锁/journal。人类需要先
决定一致性契约，再决定是否承担分布式文件协议的维护成本。

## Ship gate

合入前至少需要：

1. 修复 lock ownership/fencing，证明旧 owner 不能删除新锁或在 lease 过期后继续提交；补真实多进程
   crash/timeout/stale-owner 测试。
2. 让 legacy migration 的每一个 crash prefix 可恢复，不得因仅 checkpoint 成功就丢掉合法 active/
   waiting goal；用逐边界 fault injection 固定。
3. 让 legacy disk-only clear 建立 revision/horizon，删除“stale save 可复活”的现有预期。
4. 明确 downgrade/mixed-version 契约；若声称双向兼容，必须解决旧 binary 新 set 被压制及旧 reader
   误杀 same-objective replacement。
5. 明确 crash model/平台支持；若覆盖掉电，增加 fsync 与父目录 durability；若覆盖 Windows/NFS/SMB，
   增加对应验证。
