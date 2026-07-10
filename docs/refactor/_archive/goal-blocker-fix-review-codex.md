# Goal blocker 未提交修复：独立代码审查

## 结论

**NEEDS-WORK**

审查范围严格限定为当前 HEAD `d97f95f4` 之上的 7 个 goal 相关 dirty 文件；明确排除了
`view_image`/image history 相关改动。除本报告外未修改源码，也未提交。

这版实现修好了两个重要的受限场景：在 terminal 仍位于最近 64 个、且 goal 已具有稳定
`goalId` 时，A 终结 → B 终结 → stale A 经当前 `saveState` 写回不会复活；foreign writer
只覆盖 `state.json`、抹掉所有内嵌 marker 后，独立 journal 也能在下一次 read/resume 时压制
该 goal。`goalId` 的纯 identity 规则本身也符合“任一方有 ID 就只认 ID，双方都没有才回退
legacy identity”的要求，同毫秒不同 ID 不再因严格时间比较而互相覆盖。

但两个 blocker 都还没有端到端闭环：

1. legacy goal 从无 ID 惰性迁移为有 ID 后，迁移前 stale 快照无法再和带 ID terminal 匹配，
   可重新 arm 已终结 goal；第 65 个 terminal 还会淘汰最老事实，使原始多代复活序列再次成立。
2. `goalId` 阻止了同一 live object 上的误清，但旧 run 使用 detached state 终结时仍会把磁盘
   上的新 replacement 整体覆盖掉；现有 same-objective 测试通过手工修改旧 run 的同一 live
   state，绕过了真正的 writer 竞争。

因此不能 SHIP，也不属于只有小问题的 SHIP-with-nits。

## Blockers

### 1. `[blocker]` legacy 惰性迁移形成 identity 断点，迁移前 stale writer 可复活已终结 goal

- `packages/core/src/engine/goal.ts:84-90` 规定只要任一侧存在 `goalId`，就禁止回退
  `objective + setAtMs`。该规则对现代 goal 是正确的。
- `packages/core/src/engine/engine.ts:2090-2096` 在 resume/arm 边界给 legacy active goal
  生成新 ID；随后 `packages/core/src/engine/engine.ts:2272-2286` 只记录带这个新 ID 的
  terminal。
- `packages/core/src/session/session-manager.ts:427-429,560-565` 用同一 strict identity
  读取 journal 并做 suppress。

由此存在如下升级窗口：

1. 旧 writer 持有迁移前的 `{ objective: "legacy", setAtMs: 200 }`；
2. 新 Engine resume，懒迁移为 `goalId=migrated-A`；
3. 该 run 终结，journal 只记录带 `migrated-A` 的 terminal；
4. 旧 writer 整体覆盖 `state.json`，恢复无 ID 的 active goal 并擦掉 state 内 markers；
5. journal terminal 有 ID、stale active goal 无 ID，strict identity 必然返回 false；Engine
   随后会再生成一个新 ID，把同一个已终结 goal 当成新实例 arm。

我在临时 session 复现后，`readActiveGoal()` 和 `resume().state.activeGoal` 都返回了迁移前的
legacy goal，而不是 `undefined`。这直接违反 Blocker 1 的 foreign whole-state writer guard，
也说明注释所称“先检查 legacy tombstone 再迁移”只覆盖 terminal 本身也没有 ID 的旧状态，
没有覆盖由本版迁移后产生的带 ID terminal。

现有 legacy 测试 `packages/core/src/engine/turn-loop-goal-lifecycle.test.ts:763-807` 只覆盖
“无 terminal 的 legacy active goal 正常迁移、运行、终结”，没有让迁移前快照在终结后写回，
所以无法发现该问题。

### 2. `[blocker]` detached 旧 run 终结仍会覆盖新 replacement，`goalId` 没有保护磁盘 writer 竞争

- `packages/core/src/engine/engine.ts:2283-2286` 在旧 run 的内存 state 仍是 A 时先把
  `activeGoal` 清为 `undefined`，再调用 `saveState`。
- `packages/core/src/session/session-manager.ts:540-544` 只有当 **incoming**
  `state.activeGoal` 匹配 terminal 时，才考虑保留磁盘上的非 terminal goal。Engine 已在调用前
  清掉 incoming A，因此该分支不会执行。

实际序列如下：

1. run A 持有 detached state，goal 为 `{ goalId: "A", objective: "same", setAtMs: 100,
   tokenBudget: 10 }`；
2. 另一个 writer 写入同 objective、同 deadline anchor、较大 budget 的 replacement B，
   `goalId="B"`；
3. A 终结，在自己的旧 state 上记录 terminal A、清掉 active A 并保存；
4. `saveState` 用 `activeGoal: undefined` 的旧 whole-state 覆盖磁盘，B 消失。

临时复现的最终 state 为 `activeGoal: null`、terminal IDs 只有 `A`。所以 immutable ID 的比较
没有误认 A/B，但 whole-state write 本身仍然删除了 B；从产品结果看，Blocker 2 描述的“旧 run
终结不得清新 goal”仍然失败。

测试 `packages/core/src/engine/turn-loop-goal-lifecycle.test.ts:712-756` 是假绿：回调直接修改
`engine.activeRunSession.state.activeGoal`，也就是 A run 即将保存的同一个对象，再用同一个
manager 保存。它证明的是“同一 live object 已经看见 B 时 ID 比较不清 B”，没有构造另一个
detached/foreign writer，也没有让 A 的 state 保持 stale。前一个 different-objective 测试
`packages/core/src/engine/turn-loop-goal-lifecycle.test.ts:668-705` 有同样局限。

### 3. `[blocker]` 64 代淘汰会重新开放原始 stale-generation 复活通道

- `packages/core/src/session/session-manager.ts:719` 把 terminal history 硬限制为 64。
- `packages/core/src/session/session-manager.ts:737-756` 在 merge 阶段先按 wall-clock
  `terminatedAtMs` 排序、再丢弃更早记录。
- `packages/core/src/session/session-manager.ts:611-625` 随后删除本次观察到、但未保留的
  journal 文件。

在 65 个不同 `goalId` 依次终结后，第一个 terminal 会同时从 `state.json` cache 和 journal
删除。此时让第一个 goal 的旧 whole-state 快照覆盖 `state.json`，`readActiveGoal()` 会再次
返回它。临时复现得到 `journalFiles: 64` 且 `revived.goalId: "g0"`。

“只保证最近 64 代”若是明确的产品一致性窗口，可以作为有意的折中；但当前 ship gate 和
注释声称的是 stale/foreign whole-state writer 不能复活 terminal goal，没有给 stale writer
年龄或 generation 上限。64 次强制终结在长寿命 session 中也不是不可达状态。因此当前实现
只是把单槽反例从第 2 代推迟到第 65 代，没有闭合 Blocker 1。

此外，retention 以本机 wall clock 而不是单调 revision 决定。存在时钟回拨或跨进程 clock
skew 时，一个刚产生但 `terminatedAtMs` 较小的第 65 个 terminal 可能在自己的首次 save 中
就被 slice 掉，连 journal 都不会写入；这进一步说明 64 项不能等同于“最近观察到的 64 代”。

## Nits / 非阻断问题

### 4. `[nit]` journal 的正常并发清理是有界的，但损坏与 orphan 文件不会收敛

正面结论：`packages/core/src/session/session-manager.ts:611-625` 只清理本轮 read 已观察到的
identity key。另一个 writer 在 read 之后创建的不同 key 不在 `observed` 中，不会被误删；
有效、规范命名的记录在后续无竞争 save 后也会收敛到 64 个。因此正常路径不是无限增长。

仍有以下健壮性缺口：

- `packages/core/src/session/session-manager.ts:578-585` 忽略 malformed `.json`，但清理只接收
  成功解析的 terminal，所以损坏/非规范命名 `.json` 永远不会被删除，每次 goal read/save 都会
  重新打开并解析失败。
- `packages/core/src/session/session-manager.ts:598-602` 看到 canonical target 已存在就直接跳过，
  不验证内容。若该文件已损坏，后续 state 中的正确 terminal 无法修复 journal；一旦 foreign
  writer 再擦掉 state 内 cache，该 goal 又可复活。
- crash 留下的 `*.tmp` 不被读取，也没有清理策略，可形成孤儿文件。它们不会误 suppress goal，
  但磁盘占用没有上界。

### 5. `[nit]` goal probe 与每次 state save 都引入最多 64 个同步小文件 I/O，缺少性能门槛

`readActiveGoal()` 经 `packages/core/src/session/session-manager.ts:550-556,573-590` 每次都会
同步 `readdir` 并逐个 `readFile + JSON.parse` journal；`saveState()` 在
`packages/core/src/session/session-manager.ts:526-535,593-603` 又会读全目录，并对所有 retained
entry 做 `existsSync`。merge/sort 还在 comparator 中重复计算 SHA-256 key
（`packages/core/src/session/session-manager.ts:727-755`）。

目录不存在、单个 JSON 损坏、文件在 readdir 后被并发删除都被安全降级为“无该条记录”，
atomic tmp+rename 也避免正常 reader 看到半写 target；这些路径不会崩。但 `readActiveGoal` 会被
goal stop hook 反复调用，`saveState` 又在 turn boundary/heartbeat 上很频繁，最坏路径会在主
线程执行大量同步 syscall。现有测试只验证正确性，没有 I/O 次数或 latency regression gate。

### 6. `[nit]` compatibility alias 可被新代码读取，但对旧单槽 reader 不是行为双向安全

新代码读取旧 state 的主路径是安全的：缺少 `goalTerminals`/`goalId` 不会反序列化失败；旧
`goalTerminal` 会由 `packages/core/src/session/session-manager.ts:527-539,550-565` 合并进数组、
在后续 save 写入 journal；只有 legacy active goal 时也会懒迁移。

新代码还持续写 `goalTerminal` alias，旧 JSON reader 不会因多出的 `goalTerminals`/`goalId`
字段崩溃。但这不是完整的降级兼容：same-objective replacement B 会保留 A 的 `setAtMs`
（`packages/core/src/engine/engine.ts:2071-2082`），而 d97f95f4 reader 不认识 ID，只按
`objective + setAtMs` 比较。若 alias 指向 terminal A、active goal 是新 ID 的 B，旧 reader
会误把 B 当 A suppress/clear。旧 binary 也完全不读取独立 journal。因此 alias 能提供 shape
兼容，不能提供新 lifecycle 语义的双向行为安全；需要明确版本/降级策略，不能把 alias 描述成
完整兼容层。

## 两个 blocker 的逐项判定

### Blocker 1：有限 terminal 集合 + 独立 journal

**部分修好，未闭环。**

| 核查项 | 判定 |
|---|---|
| A 终结 → B 终结 → stale A（现代 ID、两代） | 通过；history 保留 A/B，save/read 都 suppress A |
| foreign writer 整体擦掉 state markers | 通过，但仅限对应 journal 仍保留且可解析 |
| observed-file 并发清理 | 不会误删 read 之后创建的不同 identity；该点设计正确 |
| 64 代保留 | 不通过无界 stale-writer 保证；第 65 代可复现 A 复活 |
| 同毫秒不同 revision | 通过（未超过 64 时）；不再有严格 `incomingAt > persistedAt` 丢一条的问题 |
| legacy 迁移窗口 | 不通过；无 ID stale active 无法匹配迁移后带 ID terminal |
| journal 增长 | 正常 canonical entries 最终有界；malformed/noncanonical/tmp orphan 无界 |
| 目录缺失/并发读写 | 缺目录安全返回；atomic target + per-file catch 基本健壮 |
| 损坏 JSON | 不崩，但忽略且不能自愈，可丢失 terminal protection |

### Blocker 2：不可变 `goalId`

**identity primitive 修好，端到端并发语义未闭环。**

- `isSameGoalInstance` 的规则正确且无 fallback 歧义：同 ID 权威；任一侧有 ID 但不同/缺失则
  不匹配；双方无 ID 才使用 legacy `objective + setAtMs`。
- 每次 top-level explicit set 都覆盖调用者输入并生成新 `nanoid(16)`，包括 same-objective
  budget/limit restart；现代 goal 的 `setAtMs` 只作为 deadline anchor，identity 不再依赖它。
- 同一 live state 已经观察到 replacement 时，A terminal 不会误清 B。
- 但 detached old run 的 whole-state save 仍会抹掉 B，legacy migration 又会把同一旧 goal
  重新发一个新 ID。因此需求所要求的“旧 run 终结不会误清新 goal”和“迁移窗口不误判”均未
  达成。legacy state 下 `setAtMs` 仍按设计承担 fallback identity；不能说所有状态都完全解耦。

## 回归测试审查

新增测试真实覆盖到的内容：

- 两代 A/B terminal history 和 foreign writer 擦掉 state markers；
- 两个不同 ID 在同毫秒终结；
- stop-block/token/time/max-turns terminal 及 bare follow-up 不 re-arm；
- waiting 保留 active goal；
- explicit same-objective 顺序 restart 会生成不同 ID，并保留 deadline anchor；
- raw legacy active goal 的普通 resume/migrate/terminate。

关键缺口或假绿：

1. 没有“迁移前 legacy snapshot → 迁移 → terminal → snapshot 写回”的测试。
2. 没有第 65 代淘汰后 stale writer 的边界测试，也没有 clock rollback/skew 测试。
3. same-objective 并发替换测试直接改旧 run 的 live object，不是 detached writer；断言无法证明
   磁盘 B 能抵抗 A 的 stale whole-state final writeback。
4. 没有损坏 canonical journal 的修复/降级测试，也没有 orphan 或 I/O 成本门槛。
5. 同毫秒测试只有 2 条，正确证明 tie 不会在容量内丢记录；它没有覆盖容量边界，这一点不应
   外推为任意 revision 数都保留。

## 验证结果

运行用户要求的全部受影响测试：

```text
bun test \
  packages/core/src/engine/turn-loop-goal-lifecycle.test.ts \
  packages/core/src/session/session-manager.cleargoal.test.ts \
  packages/core/src/session/session-manager.cleargoal-stale-writeback.test.ts \
  packages/core/src/session/session-manager.readgoal.test.ts \
  packages/core/src/engine/goal.test.ts \
  packages/core/src/hooks/goal-stop-hook.test.ts

92 pass / 0 fail / 208 expect() / 6 files
```

`git diff --check` 对审查范围内 7 个文件也通过。测试全绿证明已覆盖的 happy/constrained
路径工作，不反驳上述三个临时目录反例。

临时、未写入仓库的最小复现摘要：

```json
{
  "detachedReplacement": {
    "activeGoal": null,
    "terminalIds": ["A"]
  },
  "legacyMigrationWindow": {
    "readActiveGoal": { "objective": "legacy", "setAtMs": 200 },
    "resumedActiveGoal": { "objective": "legacy", "setAtMs": 200 }
  },
  "generation65": {
    "journalFiles": 64,
    "revived": { "objective": "g0", "goalId": "g0", "setAtMs": 300 }
  }
}
```

## Ship gate

合入前至少需要：

1. 让 A 的 terminal transition 在 detached writer 场景下保留磁盘上的非 A active goal；应由
   带 revision/CAS 的字段级 transition、锁，或等价的原子 merge 保证，不能只依赖调用前的
   live-object identity check。
2. 为 legacy → goalId 迁移保存可验证的 identity bridge，确保迁移前 stale snapshot 能被
   迁移后 terminal 压制，同时不把真正的 same-objective replacement 误认为旧 goal。
3. 明确定义 terminal protection 的 retention 契约。若保证是不受任意 stale writer 复活，
   不能在没有 writer horizon/CAS 的前提下删除第 65 条；若产品只接受 64 代窗口，必须把该
   限制写进契约并接受原 bug 在窗口外仍可复现。
4. 补三个直接回归：detached A terminal vs disk B、legacy migration-window stale writeback、
   retention 边界 stale writeback；不要通过修改旧 run 的同一 state object 模拟外部替换。

