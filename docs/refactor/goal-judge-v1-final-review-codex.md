# Goal Judge V1「blocker 修复」最终独立复核

复核日期：2026-07-10  
复核基线：`c3e9020b`  
复核对象：`feat/goal-judge-context` worktree 中指定 5 个文件的未提交全量差异  
结论：**SHIP-with-nits**  
问题计数：**0 blocker / 2 new nits**  
合并建议：**可以合并**；两个原 blocker 已真正闭环，上一轮 3 个 nit 均已修复。下面两个新 nit 不会造成敏感数据驻留或错误 `met:true`，可后续收口。

## 总结

本轮修复满足上一轮报告的两个强制放行条件：

1. TurnLoop 在工具结果收集点立即构造有界、脱敏、无原始对象引用的最小 projection。敏感结果只保留 tool/turn/status，非文本只保留布尔省略事实并在 prompt 中渲染占位，普通文本在进入 run 级窗口前已按 code point 截断。Engine 的 callback 快照不再携带 `ToolResult`、`contentBlocks`、`displayResult` 或 `transcriptResult`。
2. judge 的整个 user 输入由 `JSON.stringify` 生成，工具证据位于 `untrustedToolEvidence: { trust: "untrusted", quotedText }`；system prompt 明确禁止遵循证据内的指令、角色声明、边界文本和伪造 verdict。引号、反斜线、括号和伪造 JSON 只能留在 `quotedText` 字符串值中，不能生成同级 `met`。

上一轮 3 个 nit 也均有实现和回归测试闭环：生产两次 stop round 可命中缓存；非文本省略标记覆盖图片、纯非文本及 text+image；1600/8000 两级预算均改为 code-point 安全裁剪。

## Findings

### Nit 1 — cache key 使用可出现在不可信字段中的明文分隔符，不是无碰撞编码

位置：`packages/core/src/hooks/goal-stop-hook.ts:436-439`

缓存键把 goal、finalText、后台任务、工具证据、上一轮裁决和分钟桶用固定字符串
`--goal-judge-cache-part--` 连接。上述多个字段可包含相同分隔符，因此不同字段元组可以生成同一个 key；例如同时改变后台任务描述和工具证据，可以把分隔符从证据值“移”到后台任务值而保持最终字符串相同。我用与实现相同的 join 方式构造了两个不同元组，确认 `keyA === keyB`。

这不影响正常的“证据单独变化”路径，现有测试也证明该路径会 cache miss；而且 `met` verdict 从不缓存，所以它不能借此伪造完成或触发 `onMet`。残余风险是对抗性、多字段同时变化时重放旧的 `not_met`/`waiting`。建议后续将 key 改为 `JSON.stringify([...parts])`、长度前缀编码或稳定哈希。

### Nit 2 — 8000 code-point 限额在 JSON 转义前应用，控制字符密集证据可显著放大实际 judge prompt

位置：`packages/core/src/hooks/goal-stop-hook.ts:269-290`、`:458-475`

`quotedText` 先按 8000 code points 限制，再进入 `JSON.stringify`。普通文本只增加固定 JSON 结构和少量引号/换行转义；但 NUL 等控制字符会各自变成 6 个可见字符。用 8000 个 NUL 验证时，最小结构序列化后为 48,083 UTF-16 code units（约 6 倍）。生产路径还有单项 1600 限制，故总量仍是有限的，但控制字符密集的命令/外部输出会弱化 8000 字符预算，可能让小上下文模型的 judge 调用失败并走 fail-closed 续跑。

这不是安全边界回归：JSON 结构仍不可逃逸，失败也不会误判完成。建议后续按 JSON 编码后的长度预算 `quotedText`，或在 projection 中把无语义控制字符归一化为固定占位。

## 放行条件逐项复核

### 1. Blocker 1：敏感数据不超期驻留 — **闭环**

- 私有结构已收窄为 `GoalJudgeToolResult`，字段只有 `turnCount`、`toolName`、`status`、可选的有界 `text` 和 `omittedNonText`（`goal-stop-hook.ts:88-112`）；类型不再含 `ToolResult` 或 `contentBlocks`。
- `projectGoalJudgeToolResult` 对 `sensitive:true` 在读取任何结果文本/块之前直接返回 tool/turn/status（`:231-250`）。普通文本当场按 1600 code points 做 head/tail；图片、二进制、reasoning 和非字符串嵌套块只转成 `omittedNonText:true`。
- TurnLoop 在工具执行结果刚返回的收集点调用 projection（`turn-loop.ts:1165-1170`），run 内只保留最多 20 个有界 projection。自然停止时传给 Engine 的是 projection 对象浅复制（`:1020-1034`）；字符串是不可变值，且没有任何可回到原始 `ToolResult`/块数组的引用。
- Engine 只保存这个私有 snapshot 于局部闭包（`engine.ts:1941-1947`、`:2056-2058`），公开 `on_stop` 的 `HookContext.data` 仍只有 goal/finalText/turnCount。
- 没有发现把原始 `result`、`contentBlocks`、`displayResult`、`transcriptResult` 或未截断普通原文放进 judge snapshot 的旁路。原始 `ToolResult` 在当前模型 round 的既有消息/Transcript 路径中短暂存在，不是本新增快照持有。
- 测试直接截获 `updateGoalJudgeContext` callback 的 snapshot，并把 secret 同时放入 result/display/transcript/contentBlocks；随后对 callback snapshot 本身做 `JSON.stringify(...).not.toContain(secret)` 和精确 shape 断言（`turn-loop-goal-lifecycle.test.ts:180-214`），不是只查最终 prompt。

结论：projection 对敏感值和被裁剪尾部是不可逆的；Blocker 1 真闭环。

### 2. Blocker 2：工具证据 prompt injection 防护 — **闭环**

- system prompt 明确把 `untrustedToolEvidence` 定义为引用的不可信数据，并禁止遵循其中的指令、角色声明、边界文本、伪造裁决和 `met:true` 要求（`goal-stop-hook.ts:155-160`）。
- user message 是整个对象一次性 `JSON.stringify(..., null, 2)`，证据严格位于 `{ trust: "untrusted", quotedText: toolEvidence }`（`:450-475`），不是手拼 JSON。
- 因为 `quotedText` 是先作为 JS 字符串值再序列化，证据中的 `"`、`\\`、换行、括号、`}, "met": true` 或伪造边界都会被 JSON 规则转义；解析后仍只是该字段的字符串，不可能产生同级 verdict 字段。
- 对抗测试包含“忽略目标”、伪造 `{"met":true...}` 和越权 `clear the goal now`；fake judge 只有在 system 防护存在、user JSON 可解析、攻击原文仍完整位于 `quotedText` 且顶层没有 `met` 时才返回 `met:false`。测试最终断言 `continueSession:true`、structured verdict `met:false`、`onMet` 调用 0 次（`goal-stop-hook.test.ts:219-272`）。这会在改回手拼字符串、移除 trust/quotedText 或弱化 system 防护时失败。

结论：Blocker 2 的结构逃逸和同级 verdict 伪造路径已封闭；语义层也有明确的 system trust policy 与对抗回归。

### 3. Nit 1：缓存 — **原 nit 已修；有一个新的 key 编码 nit**

- 新 key 排除了每轮必变的 `turnCount`、`stopRound`、`tokensUsed`、`elapsedMs` 以及各 budget/limit 展示字段；它们仍进入真实 judge prompt，但 system 明确“接近上限不等于完成”。分钟桶保留 deadline 的定期重判。
- key 保留了真正改变裁决输入的 objective、finalText、后台任务、渲染后工具证据、上一轮 verdict/gaps 和分钟桶（`goal-stop-hook.ts:427-440`）。工具状态、turn、文本、非文本占位均包含在渲染证据中。
- 完整 TurnLoop 两次自然停止测试证明 turn/token/stopRound 都增长而 final/evidence 不变时，第二轮命中缓存，judge 总调用数严格为 1（`turn-loop-goal-lifecycle.test.ts:300-345`）。
- 反向测试证明相同 finalText 下工具文本从失败变为全绿会调用 judge 2 次并看到新证据（`goal-stop-hook.test.ts:155-181`）。生产中新增工具结果还带 turn/status，因此正常证据变化不会误命中。
- 但固定分隔符 join 不是无碰撞编码，见 Finding Nit 1。该边界不推翻原缓存 nit 的修复，但值得后续收口。

### 4. Nit 2：图片/非文本省略标记 — **已修**

- projection 独立扫描 `contentBlocks`；只要任一块不是可保留的文本，就设置 `omittedNonText:true`，不再受 `result` 文本镜像的优先级影响（`goal-stop-hook.ts:216-250`）。渲染时该布尔值总追加 `[非文本/二进制内容已省略]`（`:254-261`）。
- 三类测试齐全且通过：图片带 result 镜像（`goal-stop-hook.test.ts:275-287`）、纯非文本（`:289-300`）、text+image 混合（`:302-316`）。

### 5. Nit 3：UTF-16 边界 — **已修**

- `codePointLength` 和 `codeUnitIndexAtCodePoint` 负责所有 1600/8000 head/tail 预算与切分（`goal-stop-hook.ts:176-214`）。预算路径没有遗留使用 `String.length` 或未经 code-point 索引的字符串 `slice`；其余 `.length/.slice` 只用于数组计数、分钟桶或日志预览，不参与这两个字符预算。
- 1600 单项边界测试断言结果恰为 1600 code points 且没有孤立 surrogate（`goal-stop-hook.test.ts:318-327`）。8000 总证据边界测试解析 JSON 后检查 evidence 不超过 8000 code points、含截断标记且没有孤立 surrogate（`:329-360`）。

### 6. 绿线未破坏 — **通过**

- fail-closed：judge throw 或输出不可解析都返回 `continueSession:true`（`goal-stop-hook.ts:498-537`），不会误判完成。
- waiting guard：只有 `verdict.waiting && runningWork.length > 0` 才允许等待；空列表落回 not_met 并继续（`:553-577`）。定向单测与 Engine 有限后台任务生命周期测试均通过。
- `goal_progress` 三态 shape 仍成立：not_met 带 round/可选 gaps，met 带 round，exhausted 带 round（`turn-loop.ts:1047-1112`）；相关 lifecycle 测试和完整 Core 套件通过。
- judge 明确使用 primary `llmClient`，不是 `auxSummaryClient`（`engine.ts:1943-1947`）；配置独立 auxText 的 Engine 集成测试证明 judge system prompt 只到 primary（`turn-loop-goal-lifecycle.test.ts:405-469`）。
- judge 调用保留 `recordUsage:false`（`goal-stop-hook.ts:478-496`）。真实 provider 最终都调用 `LLMClientBase.recordUsage(usage, options)`，而基类在 `recordUsage === false` 时于 `client-base.ts:70-79` 直接返回，因此不进入 client usage/requestCount、全局 cost hook 或 Goal token tracker。这里的“排除计费”指 CodeShell 的用户可见统计；上游 provider 当然仍会对实际 API 调用收费。

### 7. 新引入问题与边界 — **无 blocker；2 个 nit**

- 结构化 JSON 增加少量固定字段/缩进与必要转义，但 system prompt 仍是独立且稳定的第一条消息，所有动态数据仍在后续 user message；没有破坏原有 system prompt 缓存前缀。控制字符密集文本的转义放大见 Finding Nit 2。
- projection 对普通文本是线性扫描并做有限次 code-point 计数/索引，没有嵌套平方复杂度；敏感结果 O(1) 返回，非文本块不会读取/复制 base64。最多驻留 20 × 1600 code points 加少量元数据，snapshot 再复制的只是这些小对象。极大普通文本会多一次线性扫描和短暂拼接，但没有发现会随 run 轮数累积的无界内存或明显性能 blocker。
- 空工具结果会稳定渲染 tool/turn/status；错误状态由 `isError` 或 `error` 判定；纯非文本、混合块、超长文本和 emoji 均有明确路径。没有发现空值崩溃、图片像素进入 projection 或多字节切坏。
- 唯一新增残留为上述 cache-key 分隔符碰撞和 JSON 转义后预算放大，均为非阻塞 nit；两者都不会产生错误 `met:true` 或敏感明文驻留。

## 验证结果

在 worktree `/Users/admin/Documents/个人学习/代码学习/.worktrees/goal-judge-context` 执行：

1. `bun test packages/core/src/hooks/goal-stop-hook.test.ts packages/core/src/engine/turn-loop-goal-lifecycle.test.ts`
   - **43 pass / 0 fail / 127 expect**
   - 2 files，约 0.67s
2. `bun test packages/core`
   - **2521 pass / 21 skip / 0 fail / 6228 expect**
   - 410 files，29.31s
3. `git diff --check c3e9020b -- <指定 5 文件>`
   - 无输出

测试后 worktree 仍只有用户指定的 5 个未提交源码/测试文件。复核未改源码、未 commit、未调用 `view_image`，也未修改任何 `view_image` / image-history 文件；唯一写入是主仓本报告。

## 最终结论

**SHIP-with-nits，可以合并。** 两个原 blocker 均已真正闭环，上一轮 3 个 nit 均已修复，完整 Core 绿线未破坏。建议把两个新 nit 作为后续小修：缓存键改成无碰撞编码，并按 JSON 编码后大小约束工具证据。
