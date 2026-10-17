# 第十五批：Core 注入缓存、steer 队列与 inline image 语法

冻结基线：`ae777b3fce6fc9986e69ceb62802f3bb3f6aa478`。本分区 **0 项正式 bug、2 项候选，无严重级别**。两个独立 guarded 首跑均完整结束，共 **35 pass / 97 expect / 0 fail / 0 skip**，其中 24 个既有测试、11 个聚焦观察/对照。没有修复产品代码。

## STEER-R15-C1：按当前队列长度生成的默认 id 可能在撤回后复用

状态：**候选；真实 helper 观察 + 静态默认 id 分支，没有执行 Engine。** [engine.ts:1160](../../packages/core/src/engine/engine.ts#L1160) 使用 ``id || `steer-${q.length}```，而 [steer-queue.ts:58](../../packages/core/src/engine/steer-queue.ts#L58) 按相等 id 过滤整个列表。按该表达式分别给前两条待消费项分配 `steer-0`、`steer-1`，撤回前者后，队列长度再次为 1；下一次默认 id 就会与仍在队列中的 `steer-1` 相同。

[聚焦 fixture](evidence/injection-cache-queue.test.ts) **只调用真实纯 helpers**，其 id 表达式手工对应静态检查到的默认分支；实际输出为第二、三条不同文本同时使用 `steer-1`，随后一次 `removeSteerItem(..., "steer-1")` 返回空列表。对照使用不同 host id 时只撤回目标一项，其他项按 FIFO drain；原输入数组保持不变。输出见 [combined raw log](evidence/injection-cache-queue.first.raw.log)。

[steer-queue.ts:3](../../packages/core/src/engine/steer-queue.ts#L3) 把稳定 id 用于草稿关联与单项撤回，[engine.ts:1155](../../packages/core/src/engine/engine.ts#L1155) 的参数有缺省值；[server-run-controls.ts:184](../../packages/core/src/protocol/server-run-controls.ts#L184) 静态透传 `params.id`。这些是候选的源码依据。没有确认普通 host 实际省略 id 的调用链，没有运行 Engine 默认分支、真实 active run、RPC 或 UI，所以不能把 helper 输入表达式复刻写成真实 Engine 复现，也不声称用户内容已经丢失。显式传入相同 id 的行为本身不另记一个 bug。此处不涉及旧 steer race/orphan、重复持久化、Hook emit 注册或 session 26-calls 问题。

## IMAGE-R15-C1：标签数量相同仍可能留下未拒绝的 malformed 图片标记

状态：**候选；真实 parser 语法观察，未建立普通生产者。** [parse-task.ts:127](../../packages/core/src/engine/parse-task.ts#L127) 说明 malformed block 抛 `ImageParseError`，不提供静默 fallback。但 [parse-task.ts:142](../../packages/core/src/engine/parse-task.ts#L142) 只先比较 opener/closer 数量，接着依赖从 opener 到后续 closer 的非重叠 regex 匹配；数量相同不保证顺序有效或全部标记被匹配。

[首次 fixture](evidence/injection-image-grammar.test.ts) 调用实际 `parseTaskWithImages`，输入一个先 closing、后 opening、没有后续 closing 的手工字符串：

```text
</codeshell-image><codeshell-image mime="image/png">data:image/png;base64,YQ==
```

实际返回原文字、`images: []`、`hasImages: false`，没有抛错。另一个观察先放一块正常 block，再接上述逆序尾巴：正常图片被提取，但逆序标记仍留在 text。二者是同一候选，不分拆计数。对照中真正数量不平衡的 opener 与非法 data URL body 均抛错；正常完整 block、escaped name/path metadata、图片源顺序正常。见 [combined raw log](evidence/injection-image-grammar.first.raw.log)。

这两种逆序字符串是**自造 malformed wire**；[attachments.ts:250](../../packages/desktop/src/renderer/chat/attachments.ts#L250) 的正常 encoder 静态上生成完整 opener/body/closer，目前未建立普通 encoder 或真实传输损坏会产生逆序 wire 的链。因此不升级为正式 bug。`YQ==` 只用于 base64 语法，不代表真实可解码 PNG。没有执行图片解码、staged 文件读取、压缩、Engine、provider，也不声称真实图片字节丢失或用户可见故障。

## 正常对照、已有策略与排除

`stripInjectedContextMessages` 的 [identity 契约](../../packages/core/src/engine/injected-context-cache.ts#L3) 与真实运行一致：删除精确的 run-scoped 对象，内容相等的 durable 用户消息仍保留；没有注入时返回新外层数组，消息对象 identity 不变。既有基线明确保留已经不在首位的 user-context 对象，本轮不把此行为改写为 bug。[run-context.ts:112](../../packages/core/src/engine/run-context.ts#L112) 与 [run-finalize.ts:239](../../packages/core/src/engine/run-finalize.ts#L239) 只作静态生产/消费定位，没有执行完整缓存生命周期。人为让 userContext 与 dynamicContext 共用同一对象、或构造没有普通生产者的克隆/重排，不登记正式问题。

steer 的 trim/drop blank 和浅复制附件数组是明确实现行为。聚焦对照只确认复制外层附件列表，未宣称 deep immutable snapshot。没有制造附件对象后续突变来登记缺陷，也没有恢复旧失败的 JSON summary、compaction、reminder 或 Session 方向。

parser 对普通正文中的孤立 `<codeshell-image` 抛错被 [既有测试](../../tests/parse-task.test.ts#L30) 明确锁定。本轮额外观察该策略但不登记新 bug。它与旧 [WEB-R14-C1](../audit-2026-10-17-round14/web.md) 都涉及内部标记与普通文本边界，但该旧候选位于另一套展示投影、另一些标签，且验证失败后已跳过；本轮没有导入或恢复 Web display 路线，也不宣称复现或消除该旧候选。

## 查重、首次收据与范围

[全历史查重](evidence/injection-dedup.json) 和 [聚焦补充](evidence/injection-focused-dedup.json) 均覆盖本批以外 docs/bugs 的 **1,102 个 Markdown + 723 个 JSON = 1,825 个文件**，递归解析 **200,618 个 JSON 字符串叶子**，包含 archive/_archive，0 解析错误。主查询覆盖函数名、identity cache、steer id/附件与 inline-image grammar；补充精确关注默认 id 复用和标签逆序。补充的 3/6 次匹配分别是旧 bridge 队列描述和旧 mobile image 展示计数，不是上述两候选的同根因已登记项。关键词查重仍不是语义穷尽证明。

| 首次 shard | 实际结果 | 证据 |
| --- | --- | --- |
| 缓存 + 队列既有基线及聚焦观察 | 15 pass / 39 expect / 0 fail / 0 skip；Completed；exit 0 | [raw](evidence/injection-cache-queue.first.raw.log)、[exit](evidence/injection-cache-queue.first.exit.json) |
| 图片语法既有基线及聚焦观察 | 20 pass / 58 expect / 0 fail / 0 skip；Completed；exit 0 | [raw](evidence/injection-image-grammar.first.raw.log)、[exit](evidence/injection-image-grammar.first.exit.json) |

[捕获器](evidence/injection-run-first.py) 先写 combined stdout/stderr 与退出收据再检查，拒绝覆盖首跑证据；全部产品执行仅由 `node scripts/run-bun-test-shard.mjs --timeout 30000` 驱动。两组各执行一次，没有 failed shard、修 fixture、重跑或替代验证。测试通过证明的是观察/对照断言，并不表示候选已修复或整个系统通过。

一次静态定位误附带不存在的旧 `packages/core/src/engine.ts` 路径，工具 exit 2；已在 [定位跳过说明](evidence/injection-navigation-skip.md) 保留原始诊断的明确转录。该不存在路径跳过，不是产品失败，不列入 source manifest。后续文件库存确认的真实 `engine/engine.ts` 仅作静态消费者阅读，没有执行 Engine。

[验证收据](evidence/injection-validation.json)、[源码 SHA 与逐文件范围](evidence/injection-source-manifest.json)、[候选列表](evidence/injection-candidates.json)、[artifact receipt](evidence/injection-artifact-receipt.json)。动态覆盖只含上述三份纯源码；其余生产者/消费者是明确选段静态证据。没有真实模型、工具、网络、账户、用户文件、native、TTY、自动化任务、权限/security/custody 实验，也没有 build、完整 suite、typecheck、lint 或 E2E 通过主张。
