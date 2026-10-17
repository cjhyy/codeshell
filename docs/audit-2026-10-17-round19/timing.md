# Core stream timing：源时间与逻辑提交计时

冻结源码 `5f5cf69df8526470700712a4dc2d5ae6bd2da132`。本方向 **0 项新增确认缺陷、0 项新增候选、0 项旧问题关联**。一个首次 guarded shard 通过：**10 测试 / 37 断言 / 0 失败 / 0 跳过**，其中既有 2 测试、新增聚焦 8 测试。没有产品修改。

## 合同与实际范围

完整阅读并实际导入 41 行的 [`stream-timing.ts`](../../packages/core/src/session/stream-timing.ts:1)。唯一 import 为 type-only；实际执行的函数为 `stampStreamEvent`、`createRunTiming` 及其 `prepareEvent`。源码注释与 [StreamEvent 类型](../../packages/core/src/types.ts:659) 明确：源 Unix 时间戳跨回放保留；[session_started.startedAt](../../packages/core/src/types.ts:703) 表示准备之前的逻辑提交开始；[turn_complete](../../packages/core/src/types.ts:749) 附带整个提交的起止及单调耗时。

普通调用链只做静态选读：[Engine.run](../../packages/core/src/engine/engine.ts:1454) 在 `ready()` 前创建本次 timing；[wrapper](../../packages/core/src/engine/engine.ts:1660) 把事件交给 `prepareEvent`；[普通 session_started 生产者](../../packages/core/src/engine/engine.ts:2512) 不提供自己的 timing；[run-stream](../../packages/core/src/engine/run-stream.ts:118) 再次 stamp，并在 [child 分支](../../packages/core/src/engine/run-stream.ts:124) 按 `agentId` 分流；独立 [publisher](../../packages/core/src/session/output-publisher.ts:162) 只调用 stamp。没有导入或执行这些消费者，没有由静态可达性推导真实引擎、持久化或重连已验证。

所有新增 fixture 时钟由测试持有的普通数字变量提供；事件均为自有内存对象。没有改系统时钟或环境变量，没有实际 timer、模型、transport、journal、replay、recorder 或原生操作。

## 首次验证

[fixture](evidence/timing-normal.test.ts)、[首次 combined stdout/stderr](evidence/timing-normal.first.raw.log)、[exit 回执](evidence/timing-normal.first.exit.json) 保留该次执行；raw 与 exit 先落盘，再读取结果。唯一命令为：

```text
node scripts/run-bun-test-shard.mjs --timeout 30000 packages/core/src/session/stream-timing.test.ts docs/audit-2026-10-17-round19/evidence/timing-normal.test.ts
```

| 实际覆盖 | 观察结果及边界 |
| --- | --- |
| 既有两个测试 | 有效时间戳保留；undefined/NaN/Infinity/负时间戳替换；准备阶段开始时间、子事件隔离、墙上时间倒退、重复终止缓存符合现有合同。既有测试仅用受控数字时钟。 |
| epoch 与小数源时间 | `0`、`1.25`、普通当前量级 epoch 均保留值和原对象身份；没有把合法较早的源时间误当接收时间。 |
| 缺省时间 | 返回带 timestamp 的副本，原 delta 不被修改，text/runId 保留。 |
| 根 session start | startedAt 取创建 timing 时的逻辑开始，保留 source timestamp 与原输入对象；不从较晚 session_started 推回准备时间。 |
| 普通非终止事件 | text_delta 与 stream_request_start 保留有效源对象身份；没有额外 timing 字段。 |
| 根完成 | source timestamp 决定 completedAt，单调差 `150.4ms` 四舍五入为 `150ms`，原终止对象未加字段。仅测试该选定数值，不宣称覆盖所有时钟精度。 |
| 后续根终止 | 第一次起止/耗时固定，后一次 reason/text 与新 source timestamp 保留。这个防御控制不证明真实生产者会发出两个不同 reason 的终止。 |
| 尚未 stamp 的子终止 | 补源时间而保留子起止/耗时；随后父终止仍计算完整父耗时，未被子终止提前封口。 |
| 两次独立提交 | 共用 caller clock 的两个 timing 实例分别保留自己的开始与耗时，互不复用 terminal cache。 |

原始输出为 `10 pass / 0 fail / 37 expect() calls`，并含 `Completed Bun shard: 10 tests, 0 skipped; 0 failures.`。新增 8 测试 / 27 断言，既有 2 测试 / 10 断言；合计见 [validation](evidence/timing-validation.json)。没有重跑，也没有全仓 suite、build、typecheck、lint、真实应用或默认系统时钟集成结论。

## 去重、失败导航与保留缺口

[全历史索引脚本](evidence/timing-dedup.py) 读取 `docs`/`bugs` 全部 inventoried Markdown 和递归 JSON 值，含 archive/_archive、排除当前批：**2,050 文件 = 1,161 Markdown + 889 JSON；260,970 字符串叶 / 363,859 标量叶；0 读取或解析错误**。每 pattern 上下文上限 18；所有匹配 locator 和总计数独立保存于 [dedup](evidence/timing-dedup.json)。关键词只是检索索引，不证明语义穷尽。

确切 leaf/name 两次命中分别为最初源码库存和 [round4 选择性静态阅读](../audit-2026-10-17-round4/root.md:26)。进一步完整核对 round4 root、coverage、quality-coding，未把旧日志轮转问题或 recorder 跨日候选当作此纯 timing helper 的新增项。[旧 recorder 失败与跳过](../audit-2026-10-17-round4/root.md:28) 保持排除：本次没有导入或复制 recorder，没有用新时钟夹具恢复该方向。其余计时/时间戳索引上下文是 session history、trace 投影或架构计划，没有已确认的同一 leaf 根因；本次没有新 bug，亦不以零项宣称模块无 bug。

一次源导航命令误用了不存在的 `packages/core/src/types/stream*` shell glob，zsh 在执行 rg 前报 `no matches found`；[metadata skips](evidence/timing-metadata-skips.json) 原样保存失败命令和输出。随后通过实际 `rg --files packages/core/src` 清单定位 `types.ts`，属于只读导航，不是 Bun、依赖或产品失败，没有测试重试。源 manifest 首次标注 publisher 范围写到 180，实际文件 175 行；仅将描述修正为完整 1–175，字节 pin、fixture、raw 与测试均未变化。

[预检](evidence/timing-preflight.json) 仅核对实际源文件、绝对 leaf import、冻结 Git blob 与当前字节；9 个 pins 相符。精确选读范围及哈希见 [source manifest](evidence/timing-source-manifest.json)。默认 Date.now/performance.now 路径、异常 caller clock、空 agentId 生产合同、实际连续 Goal/steer/tools 调度、journal 时序、重连回放、默认时钟精度与平台行为均未执行；本次证据不能证明这些路径正确，也不把未建立普通触发的异常输入另记候选。只写本报告与 `evidence/timing-*`。
