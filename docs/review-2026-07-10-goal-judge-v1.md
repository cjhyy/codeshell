# Goal Judge V1 只读代码审查

**总体结论：HOLD — 0 BLOCK / 3 MAJOR / 3 MINOR / 1 NIT。** V1 已修复“aux 模型只看 finalText”的主问题，且没有破坏非 goal 与 exhausted-goal 清理路径；但主模型 judge 的费用绕过硬预算、完成 verdict 校验过松，以及单轮 evidence 可被截掉过半，三项合在一起不宜把当前实现当成可靠的完成判据继续推广。

审查范围严格限定为 `git diff c3e9020b c40e76c9` 的 5 个文件。后续“最近 N 轮完整对话”方案只用于对照，没有作为本次必须实现项。

## Findings

| 级别 | file:line | 问题描述 | 建议改法 |
|---|---|---|---|
| **MAJOR** | `packages/core/src/hooks/goal-stop-hook.ts:448-497`；`packages/core/src/engine/turn-loop.ts:947-994,1018-1047`；`packages/core/src/engine/engine.ts:1943-1947` | **主模型 judge 的真实 token/费用不进入任何硬预算或成本统计。** V1 把调用改到 primary `llmClient`，但仍传 `recordUsage:false`，随后也完全忽略 `resp.usage`。TurnLoop 的 Goal tracker 只累计主 turn 的 `response.usage`，并且预算检查发生在 judge 之前。因此 judge 的上游 API 调用照常计费，却不进入 session cost、requestCount 或 Goal token budget；不可解析/抛错结果也不缓存，默认 stop-block 上限下可重复付费。切到主模型后，这不再只是“便宜 aux 的观测缺口”，而是违反 `GoalConfig.tokenBudget` 硬上限语义。 | 最小修法是给私有 judge seam 增加 usage 回传，拿到 `resp.usage` 后同时计入：独立 judge ledger、用户可见 cost、Goal token/time budget；在决定继续前再次检查硬预算。每个 run 另设 judge 请求上限，并给 judge 使用短于主生成的专用 timeout。不要只删除 `recordUsage:false`：那只能恢复部分统计，仍无法让 TurnLoop 的 Goal tracker 在本次 verdict 后及时执行硬限制。 |
| **MAJOR** | `packages/core/src/hooks/goal-stop-hook.ts:319-335,515-550` | **verdict parser 对“完成”校验过松，格式错误也会清除 goal。** `extractJson` 只强制 `met` 为 boolean；`waiting` 缺失就默认为 false，`gaps` 缺失就默认为空，也不验证三态互斥。只读复现确认 `{"met":true}` 以及 `{"met":true,"waiting":true,"gaps":"still incomplete"}` 都直接进入 met/onMet 分支。后者明确自相矛盾，却会清持久 goal。另一方面，函数注释称取“first balanced JSON”，实现实际是 first `{` 到 last `}`，对两个对象、尾部多余 `}` 等可恢复输出会错误降级。 | 复用仓库已有的 balanced JSON 提取器，随后做严格 schema 校验：`met`/`waiting` 必须都是 boolean、`gaps` 必须是 string、禁止 `met && waiting`，并要求 `met:true` 时 `gaps.trim()===""`。任何缺字段、冲突或多对象歧义都走现有 fail-closed continuation。优先使用 provider 支持的 JSON schema/structured output，同时保留本地校验。 |
| **MAJOR** | `packages/core/src/hooks/goal-stop-hook.ts:171-174,264-290`；`packages/core/src/engine/turn-loop.ts:1127,1165-1170` | **12 条上限会在同一个合法工具批次内丢掉关键 evidence，且总预算选择器不会补选更早的小结果。** Engine 默认每 turn 最多执行 25 个工具；TurnLoop 只保留最后 20 个 projection，renderer 又先 `slice(-12)`。只读复现一个 25-result turn 时，judge 只看到 `T14..T25`，前 13 个结果全部消失。若关键验收查询恰在批次前半，V1 会重新退化成无证据判断。8,000 字符循环遇到一个放不下的较旧 block 后直接 `break`，即使仍有空间也不会跳过它去保留更早的小型状态/错误项。新增测试只覆盖 1 条和正好 12 条，没有覆盖生产允许的 25 条。 | 不要求立即实现“最近 N 轮完整对话”。V1 的最小修法是按 turn/batch 保留：最新批次所有结果至少保留 `toolName + status + omitted` 元数据，再在全局字符预算内分配正文；错误结果和与目标验收相关的结果优先，不能简单取数组尾部。TurnLoop 的驻留上限至少不能小于实际 batch 大小。补 25-call 测试，并把关键结果分别放在首项、中间项、尾项。 |
| **MINOR** | `packages/core/src/hooks/goal-stop-hook.ts:231-250`；`packages/core/src/engine/turn-loop.ts:1165-1170` | **脱敏完全依赖 ToolResult producer 正确设置 `sensitive:true`，没有内容级兜底。** 对已标 sensitive 的结果，projection 的不可逆删除做得正确；但 Bash/Read/MCP/Web 等普通结果若意外打印 `API_KEY=...`、cookie 或 bearer，文本会被保存在 run 级窗口并再次发送给 primary judge。使用同一个 primary 避免了跨模型/跨供应商扩散，因此不升为 MAJOR；但它增加了敏感值驻留时间和重复传输面。现有测试只覆盖显式 `sensitive:true`。 | 在 projection 创建点增加针对文本结果的 secret scrub（常见 token、Authorization/cookie、`*_KEY/TOKEN/SECRET/PASSWORD=` 等），并让工具注册元数据能声明“结果敏感”，避免完全依赖每次返回值。测试至少覆盖未标 sensitive 的 Bash env、Authorization header、URL credential；快照与最终 prompt 都不得出现原值。 |
| **MINOR** | `packages/core/src/hooks/goal-stop-hook.ts:409-411,458-475`；`packages/core/src/engine/engine.ts:1941-1947,2056-2058` | **私有 runtime context 缺失时会静默回退到旧式盲判。** 当前 Engine 接线正确：on_stop 前总会发布 context；但 getter 是 optional，`undefined` 会渲染成“无工具结果/进度不可得”，随后 judge 仍可返回 `met:true`。这使未来接线回归无法显性暴露，正好可能复活本次要修的 blind-context 问题。所谓“本 run 无工具结果”应是一个存在的 context（空数组 + progress），与“context seam 没接上”区分。 | built-in Goal hook 遇到 `getJudgeContext` 缺失或返回 `undefined` 时记录 `goal_stop.context_missing` 并 fail-closed，不发起盲 judge；生产构造中把 getter 设为必需。旧单测统一提供空 context fixture，并新增“goal 有效但 context missing”测试。 |
| **MINOR** | `packages/core/src/hooks/goal-stop-hook.ts:269-290,458-475` | **8,000 字符预算在 JSON 编码前计算，实际 prompt 可放大约 6 倍。** 引号、反斜杠、换行会转义，NUL 等控制字符会变成 `\u0000`；因此 code-point 上限并不是实际请求字符/token 上限。上限仍受 12×1,600 约束，不是无界内存问题，但会放大主模型成本，甚至触发小上下文模型报错后 fail-closed 续跑。 | projection 时归一化/替换无语义控制字符；按 `JSON.stringify` 后的长度或 token 估算执行总预算，最后对完整 judge user message 再做一次硬上限断言。补控制字符密集结果测试，而不只测 emoji/code point。 |
| **NIT** | `packages/core/src/hooks/goal-stop-hook.ts:435-440,569-592` | **verdict cache key 的明文分隔符可碰撞。** goal、finalText、后台描述、工具文本和 gaps 都可能包含 `--goal-judge-cache-part--`，不同字段元组可拼出相同 key。met verdict 不缓存，所以不会直接伪造完成；残余影响是重放旧的 not_met/waiting。 | 用 `JSON.stringify([parts...])`、长度前缀编码或稳定哈希构造 key；加一个字段边界碰撞回归测试。 |

## 正确性与兼容性核查

- 主数据流接线正确：`engine.ts:1943-1947` 将 judge 从 `auxSummaryClient` 切到 primary `llmClient`；`turn-loop.ts:1018-1035` 只在 goal 自然停止候选前发布私有快照；公开 `on_stop` data 没有新增工具输出字段。
- 非 goal 路径不会执行 projection 或发布快照：两处都受 `goalTracker` 条件保护。非 goal 的新增成本只有模块加载、一个空数组和一个未调用 callback，未发现行为回归。
- 工具 projection 对显式 `sensitive:true`、图片/非文本、超长 Unicode 的处理是有界且不可逆的；prompt 将工具文本放在 JSON 字符串 `untrustedToolEvidence.quotedText` 中，并有 system-level 不可信指令约束。结构性 prompt escape 已被封住，但 LLM 对不可信语义的抵抗仍是概率性的，不能代替 verdict schema 校验。
- previous gaps 在同一个 `createGoalStopHook`/run 闭包内传递正确，缓存命中时也不会因仅 progress counter 变化而重复付费。它不跨 run 持久化；等待后台任务后的新 run 主要依赖 notification 进入主模型上下文。这属于 V1 的已知上下文范围，后续完整对话方案可解决，本报告不把它单独列为必须修复项。

## 与两个既有已知问题的关系

1. **exhausted 后 activeGoal 重 arm：目标 commit 中未见 V1 回归。** `engine.ts:2139-2156` 的 `applyGoalTermination` 会写 terminal tombstone 并清理同一 goal instance；`turn-loop-goal-lifecycle.test.ts:533-666` 覆盖 stop-block、token-budget 和 max-turns exhausted 后不再继承。定向及 Core 全套测试均通过。
2. **aux-model blind context：核心路径已修，但防回归不足。** primary 路由和本 run 工具 evidence 均已接通，测试也证明 finalText 未复述“91%”时 judge 能看到结果；残余风险是 Finding 3 的窗口丢证据和 Finding 5 的 missing-context 静默回退。后续“最近 N 轮完整对话”会进一步补齐 tool args、历史与跨 run 语境，但不是本次 HOLD 的前置条件。

## 测试评估

执行结果：

- `bun test packages/core/src/hooks/goal-stop-hook.test.ts packages/core/src/engine/turn-loop-goal-lifecycle.test.ts`：**43 pass / 0 fail / 127 expect**。
- `bun test packages/core`：**2521 pass / 21 skip / 0 fail / 6228 expect**（410 files）。
- `git diff --check c3e9020b c40e76c9 -- <5 files>`：通过。

新增测试的优点：

- 覆盖 primary/aux 路由、工具结果未在 finalText 复述、同 run previous gaps、evidence 变化导致 cache miss、仅 progress 变化 cache hit。
- 覆盖显式 sensitive 快照脱敏、工具 prompt injection 的结构隔离、图片/混合非文本省略、1600/8000 两级 Unicode 安全截断。
- 保留并通过 met/not_met/waiting、judge throw、不可解析 fail-closed、abort signal、时间桶及 exhausted-goal 生命周期测试。

关键缺口：

- parser 只测“完全不可解析”，没有测缺字段、错类型、`met && waiting`、met 带非空 gaps、多 JSON 对象。
- 没有验证 judge usage/cost 是否计入 Goal budget，也没有覆盖 repeated parse failure/timeout 的请求上限。
- 没有覆盖 13/20/25 条结果、单批次前半关键证据、错误结果优先级和大 block 后的小 block 选择。
- “无 goal”测试不等于“有效 goal 但 runtime context 缺失”；当前大量旧测试不提供 context，反而固化了静默盲判 fallback。
- 敏感测试只覆盖 producer 已设置 `sensitive:true`；没有覆盖普通 Bash/Read/MCP 输出中意外出现凭证。
- injection 测试验证的是 prompt 结构与 fake judge 逻辑，不是实际 primary 模型的对抗成功率；发布前仍应有小规模真实模型 eval。

## 建议修复顺序

1. **先修 verdict schema（MAJOR 2）**：这是唯一可直接把格式错误升级成 `met:true` 并清 goal 的路径；同时补严格 parser 测试。
2. **再把 judge 纳入预算/成本（MAJOR 1）**：增加 usage ledger、请求上限和专用 timeout，确保 primary judge 不绕过 Goal 的硬安全边界。
3. **修 evidence 选择（MAJOR 3）**：先保证最新完整 batch 的所有结果至少有元数据，再谈扩大正文或后续完整对话方案。
4. **补安全与接线防回归（MINOR 1、2）**：未标 sensitive 的 secret scrub；context missing 明确 fail-closed。
5. **最后收口预算编码与缓存键（MINOR 3、NIT）**：按序列化后大小限额，cache key 改成无碰撞编码。

前三项完成并补齐对应测试后，可重新评估为 **SHIP with fixes**；后续“最近 N 轮完整对话”优化无需阻塞这轮修复。
