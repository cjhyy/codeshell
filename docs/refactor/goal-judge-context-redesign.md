# CodeShell Goal「达成判断」上下文重构设计

> 状态：调查完成 / 推荐方案待实施
>
> 日期：2026-07-10
>
> 范围：只讨论 Goal 的完成判断、继续、等待与完成声明；不修改本次源码、测试或提交历史。

## 0. 结论先行

当前问题可以定性为：**CodeShell 的 built-in Goal judge 不是“只看 finalText”，但确实是信息饥饿的独立裁判。**它看到 objective、目标设定时间、当前时间、最近 `finalText` 和仍在运行的后台任务；看不到对话历史、ContextManager summary、工具调用与结果、上一轮 gaps、真实 round、token/time 使用进度和已完成后台任务的结果。根因集中在 `packages/core/src/hooks/goal-stop-hook.ts:254-287` 的单条 user message 构造。

三个疑点的结论如下。

| 疑点 | 结论 | 核心证据 |
|---|---|---|
| 上下文太少 | **成立**，但“只有 finalText”不准确 | prompt 只拼 objective/setAt/now/final/background：`packages/core/src/hooks/goal-stop-hook.ts:254-287`；完整工作 messages 和工具结果明明仍在 TurnLoop：`packages/core/src/engine/turn-loop.ts:1124-1186` |
| 使用 aux、小模型能力不足 | **路由事实成立；能力不足未证实，故为部分成立** | Engine 把 `auxSummaryClient` 传给 judge：`packages/core/src/engine/engine.ts:1937-1942`；但 aux 未配置、缺失、同身份或构建失败会回退主模型：`packages/core/src/engine/engine.ts:2376-2430` |
| prompt/解析/降级脆弱 | **部分成立** | 自由文本 JSON + 首 `{`/末 `}` 解析、无 schema：`packages/core/src/hooks/goal-stop-hook.ts:103-146`；失败 fail-closed 是正确保护，但会继续重试到 stop cap：`packages/core/src/hooks/goal-stop-hook.ts:291-325`、`packages/core/src/engine/turn-loop.ts:1017-1066` |

推荐方案不是单独做 A、B 或 C，而是以下混合优先级：

```text
硬预算/取消
  → 可程序化 criterion（权威数值/状态）
  → 主模型成功、单独调用 complete_goal
  → 私有 GoalJudgeEvidenceV1 + contextual judge 兜底
  → 公共 on_stop hook 只可额外阻止
  → maxTurns/maxStopBlocks/token/time 最终兜底
```

模型策略为：**V1 上线初期 primary-first；同信任域、上下文窗口已知且离线评测达标的 aux 才进入 allowlist，aux 失败再回 primary。**这把“换强模型”从拍脑袋开关改成受测路由，同时保留小模型的成本优势。

## 1. 文档沿革与本次边界

### 1.1 与 memory 的关系

本地 memory `codeshell-goal-judge-aux-model-blind-context` 给出的 A/B/C 是正确的问题分解：A 增加上下文，B 换主模型，C 让主模型显式完成。但其“only finalText”是早期缩写，不是当前精确事实；当前 prompt 还包含 objective、时钟和运行中后台任务，见 §2.2。

### 1.2 与既有重构文档的关系

请求中提到的 `docs/refactor/goal-judge-context-refactor-codex.md` 当前工作树不存在。现有最近基线是 `docs/refactor/goal-judge-context-refactor-FINAL.md`；它已经把 A+C 收敛为“安全 `complete_goal` 优先 + 私有 contextual judge 兜底”，并补充了私有通道、信任域、judge ledger、能力探测、并发 finalize 和评测门槛。

本文不另起一套冲突架构，而是：

1. 按 2026-07-10 当前源码刷新所有关键行号和事实；
2. 直接回答本次三个疑点及 CC/Codex 对照；
3. 在既有 FINAL 基线上明确增加“可程序化 criterion 优先”；
4. 把第一批实现收敛成可执行的 TDD 顺序。

## 2. 现状精确画像

### 2.1 实际调用链

Goal judge 不是每个工具 turn 后都运行；它只在**主模型产生无工具调用的自然停止候选**时运行。

```text
Engine.run
  ├─ createLLMClient(config.llm)                         主模型
  ├─ resolveAuxClient(primary)                           aux 或 primary fallback
  ├─ createGoalStopHook({ llm: auxSummaryClient })
  └─ TurnLoop({ model: ModelFacade(primary), hooks })
       ├─ primary.call(systemPrompt, messages, tools)
       ├─ 若有 toolCalls：执行 → tool results 加回 messages → 下一轮
       └─ 若无 toolCalls：emit on_stop(goal, finalText, turnCount)
            └─ GoalStopHook 用独立 LLM 请求产出 met/waiting/gaps
```

逐段证据：

- primary client 从 `this.config.llm` 创建：`packages/core/src/engine/engine.ts:1521-1522`；`ModelFacade` 包装它：`packages/core/src/engine/engine.ts:1783-1786`；TurnLoop 的 `model` 是这个 facade：`packages/core/src/engine/engine.ts:1979-1986`。
- 主流程每次把完整 `messages`、system prompt 和工具定义交给主模型：`packages/core/src/engine/turn-loop.ts:1419-1459`。
- 工具调用和工具结果进入工作 messages：`packages/core/src/engine/turn-loop.ts:1120-1186`。
- 只有 `response.toolCalls.length === 0` 才进入自然停止，并发出 `on_stop`：`packages/core/src/engine/turn-loop.ts:983-1010`。
- `emitHook()` 还自动补入 `isSubAgent/sessionId/signal`：`packages/core/src/engine/turn-loop.ts:483-495`。
- Goal hook 注册为 run-scoped `on_stop` handler，并收到 `auxSummaryClient`：`packages/core/src/engine/engine.ts:1937-1966`。

### 2.2 judge 到底看到什么

下表严格区分“存在于 TurnLoop/HookContext”与“真正进入 judge prompt”。后者才决定判断能力。

| 信息 | 进入 judge prompt？ | 精确证据与说明 |
|---|---:|---|
| goal objective | **有** | `goal = g.objective`：`packages/core/src/hooks/goal-stop-hook.ts:183-190`；拼入 prompt：`:260` |
| goal 设定时间 `setAtMs` | **有，若存在** | 格式化：`packages/core/src/hooks/goal-stop-hook.ts:223-232`；拼入：`:261` |
| 当前时间、时区 | **有** | `renderNow`：`packages/core/src/hooks/goal-stop-hook.ts:82-101`；拼入：`:262` |
| 最近 `finalText` | **有** | 从 hook data 读取：`packages/core/src/hooks/goal-stop-hook.ts:220-221`；拼入：`:263` |
| 当前仍在运行的后台任务 | **有，但有损** | 只列 still-running 的 subagent/job/shell：`packages/core/src/tool-system/builtin/background-work.ts:23-63`；prompt 仅含 kind、description、可选 port：`packages/core/src/hooks/goal-stop-hook.ts:149-170,264` |
| 完整对话历史 | **没有** | judge 请求只有一条新 user message：`packages/core/src/hooks/goal-stop-hook.ts:254-267`；没有传 TurnLoop `messages` |
| ContextManager rolling summary | **没有** | 主 messages 会经过 context management：`packages/core/src/engine/turn-loop.ts:727-748`；judge request 未读取它：`packages/core/src/hooks/goal-stop-hook.ts:254-287` |
| 工具调用、工具结果 | **没有** | 结果已在主 messages：`packages/core/src/engine/turn-loop.ts:1124-1186`；judge prompt 没有对应字段：`packages/core/src/hooks/goal-stop-hook.ts:260-265` |
| 已通过/失败的测试、benchmark、文件改动 | **没有结构化证据** | 只有主模型主动在 `finalText` 复述时才间接可见；hook 不读取工具证据，见同上 |
| 上一轮 `gaps` / verdict | **没有** | gaps 仅用于本轮 nudge 和 UI data：`packages/core/src/hooks/goal-stop-hook.ts:366-377`；下一次 prompt 不带 previous verdict |
| goal round / `stopBlockCount` | **没有** | round 在 TurnLoop 根据 `stopBlockCount` 生成：`packages/core/src/engine/turn-loop.ts:1017-1026`；hook 不读该值 |
| `turnCount` | **没有** | `on_stop` 明确传了它：`packages/core/src/engine/turn-loop.ts:1006-1010`；prompt 构造没有使用：`packages/core/src/hooks/goal-stop-hook.ts:254-265` |
| tokenBudget/timeBudget/maxTurns/maxStopBlocks | **没有** | `GoalConfig` 定义这些字段：`packages/core/src/engine/goal.ts:14-49`；hook 只读取 objective/setAt，prompt 未序列化预算：`packages/core/src/hooks/goal-stop-hook.ts:183-190,223-265` |
| 已用 tokens、elapsed、剩余额度 | **没有** | tracker 在 TurnLoop 内：`packages/core/src/engine/turn-loop.ts:610-617,934-980`；没有传给 hook |
| 已完成后台任务的 final result | **没有** | judge listing 只选 running work：`packages/core/src/tool-system/builtin/background-work.ts:36-63`；UI 的 richer listing 才有 finished/status/result：`:66-112` |
| sessionId | **不进 prompt；只用于运行时查询** | 用于 live goal 和 background lookup：`packages/core/src/hooks/goal-stop-hook.ts:191-218` |
| abort signal | **不作证据；会透传给 LLM** | 读取并传入：`packages/core/src/hooks/goal-stop-hook.ts:248,285-286` |

因此，memory 中“only finalText”的精确修正是：**judge 输入不是只有 finalText，但除 objective/time/background 外，能证明工作完成的历史和执行证据几乎都缺失。**

另有一个放大问题：`finalText` 只有在当前 response text 为 truthy 时才更新（`packages/core/src/engine/turn-loop.ts:948-951`）。如果最后一次自然停止返回空文本，它可能沿用更早轮次的文本，并仍被 push 后送给 judge（`packages/core/src/engine/turn-loop.ts:983-1009`）。当前 prompt 不标记 `current/empty/stale` provenance，裁判会把旧文本当作最新证据。

### 2.3 judge 实际使用哪个模型

结论：**配置了有效且与主模型身份不同的 `defaults.auxText` 时用独立 aux；否则用主模型 client。**所以“现在一定用小模型”不成立，“Engine 优先把 judge 路由到 aux 配置”成立。

1. 实际配置字段已经不是旧 `auxModelKey`，而是 `settings.defaults.auxText`：`packages/core/src/settings/schema.ts:190-200`。
2. `resolveAuxKey()` 只读 `defaults.auxText`，空串视为 unset，legacy `auxModelKey` 已删除：`packages/core/src/engine/aux-key.ts:1-12`；回归测试也明确不再读取旧字段：`packages/core/src/engine/aux-key.test.ts:5-12`。
3. Engine 先创建 primary，再 `resolveAuxClient(primary)`：`packages/core/src/engine/engine.ts:1521-1522,1770-1773`。
4. `resolveAuxClient()` 从 modelPool 取 connection，并经 `toLLMConfig()` 构建 client：`packages/core/src/engine/engine.ts:2406-2423`、`packages/core/src/llm/model-pool.ts:267-300`。
5. 以下情况回退 primary：settings 读取异常、未配置 key、aux 与 primary 完整身份相同、pool entry 缺失、client 构建失败：`packages/core/src/engine/engine.ts:2379-2430`。身份比较包含 model/baseUrl/provider/providerKind/maxTokens/reasoning：`packages/core/src/engine/engine.ts:143-163`。
6. judge 明确拿 `auxSummaryClient`，主流程拿 `ModelFacade(primary)`：`packages/core/src/engine/engine.ts:1937-1942,1979-1983`。

还有两个能力事实：judge 强制 `reasoning: { mode: "off" }`（`packages/core/src/hooks/goal-stop-hook.ts:279-284`），且其输入接口不带 tools（`:29-40`）。它不会获得显式 reasoning budget，也不能自己重跑测试、读文件或查额度；它只能解释传入文本。

### 2.4 prompt、输出契约与解析

系统 prompt 位于 `packages/core/src/hooks/goal-stop-hook.ts:103-122`，是中文规则，要求只返回：

```json
{"met": true, "waiting": false, "gaps": ""}
```

实际契约细节：

- `met` 必须是 boolean；`waiting` 缺失默认 `false`；`gaps` 缺失默认空串：`packages/core/src/hooks/goal-stop-hook.ts:124-143`。
- 注释称“balanced JSON”，实现却只是取首个 `{` 到最后一个 `}` 再 `JSON.parse`：`packages/core/src/hooks/goal-stop-hook.ts:130-146`。多个 JSON、尾随花括号或被引用的 brace 都可能破坏解析。
- 没有 provider-native JSON schema/structured-output 约束，也没有 tool-call schema。
- 不拒绝 `{met:true, waiting:true}`；控制流先走 `met`，见 `packages/core/src/hooks/goal-stop-hook.ts:328-340`。
- 调用是 non-stream、`maxTokens:1500`、`recordUsage:false`、reasoning off：`packages/core/src/hooks/goal-stop-hook.ts:254-287`。

`recordUsage:false` 会让 client 完全跳过 usage tracker：`packages/core/src/llm/client-base.ts:70-79`。这意味着 judge token/cost 不进主 session usage，也不进 Goal tracker；Goal 的 token/time check 在 judge 之前完成（`packages/core/src/engine/turn-loop.ts:934-980`）。默认 `maxStopBlocks=25`（`packages/core/src/engine/goal.ts:80-86`）时，若每次都自然停止且 cache miss，cap 路径会先评估第 26 次 judge 才强停：`packages/core/src/engine/turn-loop.ts:1017-1066`。这是未计量的附加成本面。

### 2.5 失败、超时与缓存降级

当前保护并非全无：

- judge throw：记录 warn，返回 `continueSession:true`，不会误判完成：`packages/core/src/hooks/goal-stop-hook.ts:291-305`。
- JSON 不可解析：记录 `stopReason` 和原文前 200 字，再返回 continue：`packages/core/src/hooks/goal-stop-hook.ts:308-325`。
- run abort signal 会传给 judge：`packages/core/src/hooks/goal-stop-hook.ts:248,285-286`。
- 实际 OpenAI/Anthropic client 使用 retry 和 per-attempt hard deadline：`packages/core/src/llm/providers/openai.ts:263-304`、`packages/core/src/llm/providers/anthropic.ts:130-165`；默认 client timeout 是 120 秒、hard deadline 是 `max(2×timeout,120s)`、默认最多三次尝试：`packages/core/src/llm/client-base.ts:47-61,93-145`。

但这仍有四个缺口：

1. Goal hook 没有更短的 judge 专用 timeout；一次辅助判断可继承面向主生成的长 timeout/retry。
2. throw/parse failure 没有结构化 `unavailable` 状态和专用 retry ledger，只会再次推动主模型工作。
3. 失败提示没有 `goalVerdict.gaps`，UI 只能显示无 gaps 的 `not_met`。
4. cache key 只有 `goal + finalText + running tasks + minute`：`packages/core/src/hooks/goal-stop-hook.ts:234-246`。工具结果、previous gaps、round、预算与 summary 都不在 key 中；即使真实证据改变，只要最后输出相同，旧的臆测 gaps 仍可能在同一分钟被重放。

### 2.6 `met / waiting / not_met` 与 `goal_progress`

- `met`：hook 先调用 `onMet` 清 persisted goal，再返回 `{met:true}`：`packages/core/src/hooks/goal-stop-hook.ts:328-339`；TurnLoop 发 `goal_progress(status="met", round=stopBlockCount+1)`：`packages/core/src/engine/turn-loop.ts:1075-1082`。
- `waiting`：只有 judge 返回 waiting 且 `runningWork.length>0` 才允许停；空后台的 waiting 会降为 not_met：`packages/core/src/hooks/goal-stop-hook.ts:342-364`。该路径保留 active goal，等待后台完成唤醒；本分支本身不发 `goal_progress`。
- `not_met`：hook 把 gaps 写入 nudge 和 `data.goalVerdict`：`packages/core/src/hooks/goal-stop-hook.ts:366-377`；TurnLoop 增加 `stopBlockCount` 后发 `goal_progress(status="not_met", round, gaps)`：`packages/core/src/engine/turn-loop.ts:1017-1026`。
- cap exhausted：仍先跑本次 judge，随后发 `goal_progress(status="exhausted")` 并停止：`packages/core/src/engine/turn-loop.ts:1052-1074`。
- 公共事件 shape 定义于 `packages/core/src/types.ts:487-505`。

当前 built-in judge 和公共 hooks 共用 `HookRegistry`。registry 会聚合所有 handler 的 messages/data，只要任一 handler `continueSession` 就阻止停止：`packages/core/src/hooks/registry.ts:78-130`。但 built-in `met` 的 `onMet` 副作用发生在 registry 聚合完成前（`packages/core/src/hooks/goal-stop-hook.ts:328-339`）；另一个公共 hook 随后阻止停止时，goal 仍可能已清。这是把高后果内部 verdict 放在公共 hook 链里的额外时序风险。

### 2.7 已有 `complete_goal`：方向正确，接受规则不够严

主模型已经能调用 `complete_goal`，工具说明要求“只有完全完成才调用”：`packages/core/src/tool-system/builtin/complete-goal.ts:27-53`；主 prompt 也提醒 active goal 完成时调用：`packages/core/src/prompt/composer.ts:179-183`。默认 preset 暴露它：`packages/core/src/preset/index.ts:129-137`。

TurnLoop 在工具结果进入 messages 后，只要本批**请求过** `complete_goal` 就清 goal 并短路 judge：`packages/core/src/engine/turn-loop.ts:1216-1234`。它没有核对对应 `ToolResult` 是否 success，也不要求 sole-call。虽然该工具通常是 allow/read-only，项目禁用、plan/visibility race、执行 error、mixed batch 或 dropped call 都要求更严格的接受规则。explicit-first 上线前必须修成“原始 batch 唯一调用 + 实际执行成功 + goal generation 未变化 + 无 queued steer”才可完成。

## 3. 问题定性：三个疑点的根因

### 3.1 疑点 1：成立，且是当前主要症结

根因不是“系统没有证据”，而是“证据停留在 TurnLoop，没有投影到 judge”。主模型使用的工作 messages 保有对话、工具调用与结果（`packages/core/src/engine/turn-loop.ts:1124-1186,1419-1459`），judge 却重新构造一个只有五类字段的孤立请求（`packages/core/src/hooks/goal-stop-hook.ts:254-287`）。

这能直接解释用户看到的“还差 XX”臆测：`gaps` 不是由可验证的 unmet criterion 计算，而是模型根据 objective + 最近输出猜测。cache 又可能在证据变化后重放该猜测。

### 3.2 疑点 2：路由成立，能力因果未证实

`auxSummaryClient` 路由是事实，但以下推论不能当事实：

- 未证实当前用户配置的 aux 一定比 primary 弱；model、reasoning、endpoint 需要运行时 telemetry 才知道。
- 未配置/失效/同身份时其实就是 primary。
- Claude Code 当前 `/goal` 也使用 small fast model，说明“小模型”本身不是充分根因；关键差距是 CC 把 condition 和 conversation so far 一起送入 evaluator，见 §4。

所以正确工程判断是：**不应只换模型而保留盲 prompt；也不应让任意成本型 aux 未经质量、容量和信任域检查就承担完成判定。**

### 3.3 疑点 3：部分成立

成立部分：自由文本 JSON、弱 parser、互斥状态未验证、无专用 judge timeout/ledger、失败可重复到 cap、raw preview/gaps 日志、cache 缺 evidence identity。

不成立或已有保护部分：当前不是 parse failure 就放行；它是 fail-closed。reasoning off + 1500 output headroom 已修过推理 token 吃掉 JSON 的问题；waiting 也有“必须真有后台工作”的程序 guard。

## 4. 对照 Claude Code 与 Codex

### 4.1 Claude Code（CC）

当前官方文档已经公开 `/goal` 的实现：

- 普通 agent loop 让主模型收到 system prompt、tool definitions 和 conversation history；工具结果回流，主模型持续迭代，直到产生无工具调用的 final answer。[Claude Agent SDK loop](https://code.claude.com/docs/en/agent-sdk/agent-loop)
- `/goal` 在每轮后由 small fast model 判断，默认 Haiku；但发送给 evaluator 的是 **condition + conversation so far**，不是只有最后文本。evaluator 不调用工具，只能依据主模型已经在 conversation 中暴露的证据。[Claude Code `/goal`](https://code.claude.com/docs/en/goal)
- `/goal` 是 session-scoped prompt-based Stop hook 的包装。一般 Stop hook 还可以用 command/script 做确定性检查，或用 agent hook 读文件验证；Stop input 有 transcript path、last assistant、background tasks 和 cron 状态。[Claude Code hooks](https://code.claude.com/docs/en/hooks)

因此必须修正早期 memory 的笼统表述：**CC 的普通完成由带全历史的主模型自然停止；CC `/goal` 本身也有独立小模型 judge，但它得到 conversation so far。**确定性 hook 是可选的另一条路，不是所有 CC goal 的默认实现。

CC 相对 CodeShell 的关键优势不是“必用主模型”，而是：

1. evaluator 至少看到当前 conversation；
2. 官方明确要求 goal 可度量，并让 Claude 把验证结果放进 transcript；
3. script Stop hook 可把测试、文件数、队列等条件变成确定性判断；
4. evaluator reason 和 turn/token 进度是正式 Goal 状态的一部分。

### 4.2 Codex

Codex 官方 Goal 指南把 Goal 定义为 thread-scoped completion contract：objective、lifecycle、budget 和 progress 属于当前 thread；完成必须对照 thread 中的 files、commands、tests、benchmark output、artifacts 或 research evidence，而不是“模型觉得大概完成”。模型只能在证据支持时标记已有 Goal complete；pause/resume/clear/budget-limited 仍由用户或系统控制。[Using Goals in Codex](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex)

当前会话暴露的工具契约也与此一致：`update_goal(status="complete")` 是模型显式完成声明，系统要求只有 objective 真正达成且没有剩余工作时才能标 complete；budget exhausted 不能冒充 complete。

Codex 相对 CodeShell 当前路径的关键优势是：

1. 完成声明来自一直持有 thread context 和工具结果的工作模型；
2. 完成是显式 lifecycle transition，而不是从 final prose 猜测；
3. 指南把 evidence surface 写进 Goal 本身；
4. budget/blocked/complete 是不同状态。

### 4.3 对照总结

| 维度 | CodeShell 当前 | Claude Code `/goal` | Codex Goal |
|---|---|---|---|
| 工作模型上下文 | 完整 messages + tools | 完整 conversation + tools | thread evidence + tools |
| 独立 judge | 有，aux 优先 | 有，small fast model | 完成主要是显式 lifecycle tool；官方未说明另有 final-text judge |
| judge 输入 | objective/time/final/running bg | condition + conversation so far | 不适用/未公开独立 judge |
| 确定性条件 | 只有预算/waiting guard | 可用 script Stop hook | system/user lifecycle + evidence checks |
| 显式完成 | 已有，但接受规则宽 | `/goal` evaluator yes/no | 模型显式 mark complete |
| 最大差距 | judge 看不到执行证据 | evaluator 至少读 conversation | 主模型按 thread evidence 显式完成 |

对 Codex 是否还存在内部第二裁判，公开资料未证实；本文不作推断。

## 5. 推荐重构方案

### 5.1 设计原则

1. **证据优于叙述。** finalText 是候选总结，不是完成事实。
2. **确定性优于 LLM。** 可直接读数或检查状态的条件不交给模型猜。
3. **主模型显式完成优于旁路猜完成。**它已经看过工作历史和工具结果。
4. **contextual judge 是兼容兜底，不是每次停止都必须付费的真理源。**
5. **fail-closed 继续保留，但 unavailable 不伪装成有根据的 gaps。**
6. **built-in evidence 走私有通道。**公共 `on_stop` 协议不承载 transcript/tool evidence。
7. **所有完成路径统一在 finalize 时检查 goal generation、queued steer、预算与外部 hook。**

### 5.2 目标架构与判定优先级

每个自然停止或完成声明按以下顺序处理：

1. 用户 clear / confirmed cancel / abort / hard budget：沿现有权威路径终止或暂停，不调用 judge。
2. 成功解析为 structured criterion 的 Goal：调用已注册 provider，结果为 `met/not_met/unknown`。
3. 主模型 sole-call `complete_goal` 且真实 ToolResult success：直接候选完成，judge=0。
4. 若有真实 running background work：结合结构化 lifecycle 判断 `waiting`；无法程序判断 finite/service 时才交 contextual judge。
5. 主模型自然停止但没显式完成：
   - 对 `complete_goal` 可无批准调用的模型，前 1-2 次先注入 deterministic completion-audit nudge；
   - 随后或工具不可用时调用 contextual judge；
   - judge 只基于 `GoalJudgeEvidenceV1` 判断。
6. public `on_stop` hooks 仍可额外阻止自然完成，但不能覆盖 built-in `not_met` 为 met。
7. 只有 verdict 仍对应当前 goal generation、无 queued steer、无 hard terminal、public hooks 不阻止时，才清 persisted goal 并发一次 `goal_progress.met`。

### 5.3 A：judge 应看到什么上下文

新增私有、versioned DTO；不要把它塞进 `HookContext.data`：

```ts
interface GoalJudgeEvidenceV1 {
  version: 1;
  goal: {
    generation: string;
    objective: string;
    setAtMs?: number;
    criteria?: StructuredCriterion[];
  };
  progress: {
    turnCount: number;
    stopRound: number;
    elapsedMs: number;
    tokensUsed: number;
    tokenBudget?: number;
    timeBudgetMs?: number;
    maxTurns: number;
    maxStopBlocks: number;
    previousVerdict?: "not_met" | "waiting" | "unavailable";
    previousGaps?: string;
  };
  conversation: {
    rollingSummary?: string;
    recentUserConstraints: string[];
    recentRounds: ProjectedRound[];
  };
  evidence: {
    toolResults: ProjectedToolEvidence[];
    deterministicSignals: CriterionObservation[];
    finalCandidate: {
      text: string;
      provenance: "current" | "empty" | "stale";
    };
  };
  background: BackgroundWorkSnapshot[];
}
```

各 section 的必要性：

- `objective/criteria`：逐条判断验收条件，避免把目标改写成 judge 自己的标准。
- `recentUserConstraints`：包括真实 user steer，不包括 hook nudge、dynamic context 等 synthetic user message。
- `rollingSummary + recentRounds`：兼顾长历史与最近因果；不能只取 final。
- `toolResults`：至少包含 tool name、success/error/cancelled/dropped、受控结果摘要、时间与 digest；测试/benchmark 的结构化数值优先。
- `previousVerdict/gaps`：判断是否真有进展，避免同一句臆测循环。
- `budget/round`：judge 不能把“额度快耗尽”解释为“目标已完成”，也能生成诚实 blocker。
- `background`：需要 lifecycle（running/completed/failed/cancelled）和 classification（finite/service/unknown），不只是一段命令文字。
- `finalCandidate.provenance`：显式解决空 final 沿用旧文本的问题。

#### 私有 seam

在 TurnLoop 的自然停止 seam 构造 DTO，因为这里仍持有受 ContextManager 治理后的 `messages`、goal tracker、stopBlockCount 和 tool results。built-in Goal judge 不再注册为普通 public `on_stop` handler；Engine/TurnLoop 通过 private callback/service 调它。之后再按兼容 shape 发公共 `on_stop(goal, finalText, turnCount, sessionId, isSubAgent, signal)`。

原因：公共 registry 会把同一 ctx 交给 shell/plugin/user hooks（`packages/core/src/hooks/registry.ts:78-90`）。把 transcript/tool evidence 放进去会无意扩大数据暴露面，也允许低优先级 handler 篡改内部 DTO。

#### token 与数据控制

不把“全历史”理解为无界 stringify。投影规则如下：

1. 复用 ContextManager 已治理的 working messages/rolling summary，不回读原始大结果文件，不第二次做 LLM summary。
2. 固定保留 objective、structured criteria、最新真实 user constraints、deterministic signals 和 final provenance。
3. 工具证据按 goal generation 过滤；优先保留最新失败、最新成功验收、仍未完成项；普通成功读操作只保留 name/status/digest。
4. `ToolResult.sensitive` 只给 redacted marker/status/digest，绝不传 raw result；shell stdout、源码、URL query、MCP/web 任意文本默认不开放 preview。
5. 图片/二进制只保留 placeholder、mime/size/digest，不传 bytes。
6. 所有文本 section 做 head+tail 截断并标原长度；先按 route 的已知 context window 计算上限，再扣 output reserve 和 safety margin。
7. provider 报 context length error 时最多一次 shrink：去掉所有 preview，只留 status/digest；仍失败进入明确 fallback，不无限 retry。
8. 日志只记 schema/prompt version、section size、route、latency、parse code 和 per-run keyed digest；不记 objective/final/tool preview/raw judge reply/gaps 原文。

初版不复用当前 verdict cache。V1 evidence 每次自然 stop 都可能变化，旧 cache 的价值很低；先用 per-run request/token/time ledger 限额。若未来重新引入 cache，key 必须含 goal generation + canonical evidence digest + clock bucket，且不缓存 `met` 或 `unavailable`。

### 5.4 B：用什么模型

推荐内部 `auto` 路由，而不是立刻暴露一个新的用户设置矩阵。

| 条件 | V1 route | fallback |
|---|---|---|
| deterministic criterion 已给出权威结果 | 不调用模型 | unknown 才继续后续路径 |
| accepted `complete_goal` | 不调用模型 | 不适用 |
| V1 初始 rollout / aux 未经评测 | primary | unavailable+nudge |
| aux 与 primary 同信任域、窗口已知、fixture/canary 达标 | aux | primary |
| aux 跨 provider/origin 且用户未明确允许 evidence 出域 | primary | 不向 aux 发 V1 |
| route window 不足或 unknown | 选择可容纳的 primary；否则零请求 | fail-closed unavailable |

成本/准确性判断：

- 只做 B（永远切 primary）能改善 reasoning，但仍会根据片面输入自信误判，不能单独解决。
- 只做 A（继续任意 aux）能显著改善信息，但小窗口、跨域和模型质量仍可能出问题。
- explicit/deterministic 优先后，contextual judge 调用频率下降，此时 primary-first 的额外成本可控。
- CC 的 small-fast-model + conversation 做法表明，经过基准验证的 aux 完全可以成为后续优化，不必永久禁止。

judge usage 必须计入独立 `GoalJudgeLedger`，并同时占用 Goal token/time budget。建议首版每个外层 `Engine.run()` 的 judge request cap 不超过 `min(maxStopBlocks + 1, 8)`；任何 aux retry、shrink retry、primary fallback 都共享同一 cap，不能各算一份。

### 5.5 C：判断机制

#### 1. 可程序化 criterion：最高优先级

Core 保持 domain-agnostic，只定义 provider contract，不硬编码“Codex 7d 额度”：

```ts
interface GoalCriterionProvider {
  kind: string;
  evaluate(
    criterion: StructuredCriterion,
    ctx: GoalCriterionContext,
  ): Promise<{
    status: "met" | "not_met" | "unknown";
    observedAtMs: number;
    currentValue?: number | string | boolean;
    reasonCode: string;
  }>;
}
```

“干到 codex 7d 额度 90%”应被表达成类似：

```json
{
  "kind": "metric_threshold",
  "metric": "codex.usage.7d.percent",
  "operator": ">=",
  "target": 90,
  "provider": "codex-usage"
}
```

每次安全边界由可信 usage provider 读取当前数值：89% 程序返回 not_met，90% 返回 met，source 不可用返回 unknown。UI 的 gaps 也程序化为“当前 89%，目标 90%”，禁止 LLM 猜额度。自然语言可由模型建议转换，但只有成功绑定已注册 provider 的 criterion 才走确定性路径；不能解析时保持 natural-language goal，并明确没有权威 metric source。

同类条件包括：测试命令 exit 0、目录中剩余文件数为 0、队列为空、benchmark 指标过阈值、指定 artifact 存在且校验通过。命令是否安全执行仍走正常 permission/sandbox，不允许 judge 自己绕过工具层。

#### 2. 主模型显式完成：默认语义方向

动态 prompt 不只说“完成时调用”，而应要求主模型在 sole-call 前做短 audit：

1. objective/每条 criterion 是否满足；
2. 对应 evidence 是什么；
3. 是否存在失败、未执行、被拒绝或绿灯后的新修改；
4. 是否仍有 background work；
5. 若全部满足，单独调用 `complete_goal`，不要与其他 action 混批。

接受规则必须是：原始 response 恰好一个 `complete_goal`；调用未被 cap/drop；executor 实际返回 success；goal generation 未改变；queued steer 已先消费且为空。任何 mixed/error/dropped/deny 都不清 goal，下一轮只给一次审计提示，重复失败后回 contextual judge。

#### 3. contextual judge：兼容和遗忘兜底

模型工具调用能力弱、工具不可见/需批准、主模型忘记显式完成、或 waiting 无法程序分类时，调用 V1 judge。

输出改成互斥 enum，而不是两个 boolean：

```json
{
  "version": 1,
  "status": "met | not_met | waiting",
  "gaps": "string"
}
```

优先使用 provider-native JSON schema/structured output；不支持时用严格 JSON prompt + 真正的 balanced-object extractor + exact schema validation。未知字段可拒绝或忽略必须固定一种策略；`status=met` 时 gaps 必须空，`waiting` 必须再经真实 background guard。

#### 4. unavailable 与失败降级

网络失败、timeout、schema error 和 parse error统一为内部 `unavailable`，绝不转换成 `met`：

1. aux 失败且 ledger/trust/window 允许：最多一次 primary fallback；
2. 仍失败：fail-closed，注入“无法判定，请按 criteria/evidence 做完成审计”的通用 nudge；不要显示模型编造的 gaps；
3. evidence digest 未变化时不反复付费调用同一路由；等待新 evidence 或进入 cap；
4. judge ledger 或 Goal budget 耗尽属于 hard terminal，不再包装成 unavailable 继续烧主模型；
5. 保留用户 abort signal，并使用较短的 judge 专用 timeout（建议 30 秒，具体值由 latency baseline 冻结）。

#### 5. 纯 LLM / explicit-only / 双模型的定位

| 方案 | 优点 | 缺点 | 决策 |
|---|---|---|---|
| 纯 contextual LLM judge | 兼容弱 tool-calling 模型 | 仍是概率判断，高频且有成本 | 只作 fallback |
| explicit-only | 最接近 Codex，主模型有完整上下文 | 工具隐藏、弱 tool calling、模型遗忘会卡到 cap | 不直接全量启用；按 capability canary |
| 确定性 hook/provider | 数值条件准确、便宜、可审计 | 只覆盖可程序化目标 | 最高优先级，逐类扩展 |
| explicit + contextual hybrid | 兼容与准确性平衡 | 实现需处理 capability/finalize | **推荐主路径** |
| aux + primary 双模型串行投票 | 可降低单模型偶发误判 | 成本、延迟、冲突语义显著增加 | 后置，数据证明必要再立项 |

## 6. TDD 落地计划

### Phase 0：先冻结现状与评测集，不改行为

先写 characterization tests，使当前行为可审计：

1. judge 当前 request 精确等于 objective/setAt/now/final/running background；断言不含 history/tool results/round/budget。
2. aux configured/distinct、aux unset、missing、same identity、build failure 的 route matrix。
3. valid/met/not_met/waiting、缺 waiting、矛盾 boolean、multiple JSON、truncated、throw/abort/timeout。
4. empty current response 复用 stale finalText 的 fixture。
5. `maxStopBlocks=N` 最多进入 N+1 次 judge seam，且 `recordUsage:false` 不计入现 tracker。

建立 40 条左右的 seed fixture，至少覆盖：中文/英文、met/not_met/waiting、测试/benchmark、绿灯后修改、空 final、previous gaps、context compact、finite/service background、额度阈值、工具拒绝、resume/wakeup。所有候选 `met` 需人工复核，不能把“最终停止了”当 gold。

### Phase 1：先红——private seam、状态与计量契约

新增 failing tests：

- pending judge 时 clear/replace goal：迟到 verdict 必须丢弃；
- judge `met` + public hook continue：不清 goal、不发 met；
- queued steer 在 judge/complete finalize 前到达：先消费 steer，延后完成；
- judge token/time/request 全进入共享 ledger；hard terminal 后 public hook 不能重开；
- public `on_stop` ctx shape 不新增 evidence 字段；
- sub-agent、无 goal、confirmed cancel、budget exhausted 不构建 DTO、不调 judge。

再实现 private `GoalJudgeService`/callback，把 built-in judge 从公共 registry 中移出；public hook 保持兼容。

### Phase 2：先红——EvidenceV1 projector

按 section 写 projector tests：

- rolling summary + 最近 rounds + tool call/result pair；
- previous verdict/gaps、round、budget、background lifecycle；
- current/empty/stale final provenance；
- real user steer 与 synthetic nudge 分离；
- sensitive result、shell、MCP/web、URL query、源码默认只留 status/digest；
- 超大 result、图片/二进制 placeholder、已压缩历史；
- route window 较小、fixed overhead 超限、一次 shrink、第二次拒绝；
- 日志 secret corpus 零原文。

再实现 projector，直接消费已经治理的 working messages/summary，不重新总结原始 transcript。

### Phase 3：先红——structured verdict 与 route

测试并实现：

- strict enum schema；所有 malformed/timeout 都是 unavailable，永不 met；
- waiting 仍必须有真实 running work；finite/service/unknown 分类；
- V1 rollout primary-first；aux 只有同域、窗口已知、allowlist 达标才可用；
- aux failure → primary 至多一次；所有尝试共享 ledger；
- V1 不使用旧 verdict cache；相同 evidence 不重复失败调用，证据变化重新判断。

### Phase 4：先红——deterministic + explicit-first

测试并实现：

- metric 89% → not_met，90% → met，provider unavailable → unknown；
- test exit code、queue empty、artifact checksum 三种 provider 示例；
- `complete_goal` sole success 清 goal 且 judge=0；
- mixed、dropped、disabled、plan、permission/error result 都不清；
- capability unavailable/with approval 不进入 explicit-only nudge；
- 忘记 1/2 次后 contextual fallback，不一路 nudge 到 maxStopBlocks；
- accepted complete 与 contextual met 统一发一次 terminal/progress event。

### Phase 5：canary 与切换

按 `(provider, model, preset, completionCapability)` 建 eligible allowlist，不做全笛卡尔积。观察：premature met、false not_met、waiting 错误、judge unavailable、parse error、重复 gaps、main/judge token、p95 latency、explicit 遗忘率。高后果 premature met 必须为 0；未达标 cell 留在 primary contextual hybrid。

## 7. 影响文件

| 文件 | 预期职责变化 |
|---|---|
| `packages/core/src/engine/turn-loop.ts` | private judge seam；构造 evidence 所需 runtime snapshot；统一 finalize；安全接受 complete_goal；共享 ledger |
| `packages/core/src/engine/engine.ts` | 构造 GoalJudgeService、primary/aux route metadata、goal generation callback；不再把 built-in judge注册为 public hook |
| `packages/core/src/engine/goal.ts` | Goal criterion/result、judge ledger、完成/等待内部状态类型；保持 core domain-agnostic |
| `packages/core/src/hooks/goal-stop-hook.ts` | 迁成 legacy V0 adapter 或拆出 prompt/parser；最终只保留兼容测试需要的薄层 |
| `packages/core/src/prompt/composer.ts` | 按 completion capability 注入 explicit completion audit |
| `packages/core/src/tool-system/builtin/complete-goal.ts` | 工具 schema 可保持不变；接受安全性由 TurnLoop 的实际 result guard 保证 |
| `packages/core/src/tool-system/builtin/background-work.ts` | 为 judge 提供 lifecycle 与 finite/service/unknown，而非仅 description |
| `packages/core/src/types.ts` | 保持 public `goal_progress` shape；如需新增内部 subtype，避免扩大公共协议 |
| `packages/core/src/settings/schema.ts` | 首版不增加 `goalJudgeModel` 设置；只在未来开放 cross-trust/route policy 时加显式配置 |
| `packages/core/src/hooks/goal-stop-hook.test.ts` | V0 characterization、parser/failure/waiting 回归 |
| `packages/core/src/engine/turn-loop-goal-lifecycle.test.ts` | private/public merge、complete acceptance、events、budget、queued steer、generation |
| 新 projector/route/criterion tests | EvidenceV1 脱敏/容量、模型路由、数值 criterion |

## 8. 必须保留的行为

1. 无 goal 和 sub-agent 不启用 built-in Goal judge。
2. persistent goal 的 bare resume、process resume 和 background wake 继续生效。
3. goal 被用户清除或替换后，旧 run 的 verdict 不能作用于新 goal。
4. judge failure 绝不当 met；waiting 没有真实 wake source 绝不 park。
5. maxTurns、maxStopBlocks、Goal token/time budget 和用户 abort 继续作为硬边界。
6. confirmed `cancel_goal` 与 `complete_goal` 语义保持分离；blocked/困难不等于 cancel。
7. public `on_stop` handler 的既有字段、聚合和阻止能力保持兼容；内部 evidence 不公开。
8. `goal_progress` 的 public status/round/gaps shape 保持；不同完成路径最终统一只发一次 met。
9. `setAtMs` 与当前时钟仍可支持相对/绝对 deadline，但可程序化 deadline 应优先由 clock criterion 判定。
10. 敏感 tool result、图片/二进制、任意第三方文本不因 judge 重构扩大暴露面。

额外路径回归：只有 `config.goal`、没有 persisted active goal 时，当前 `isGoalActive` recheck 会让 hook直接放行（Engine 的 normalized goal：`packages/core/src/engine/engine.ts:1929-1939`；recheck：`:1956-1962`；hook 放行：`packages/core/src/hooks/goal-stop-hook.ts:198-205`）。重构时应明确使 `config.goal` 与 `options.goal` 语义一致，或把它标成不支持的配置，而不是继续静默绕过 judge。

## 9. 回归测试矩阵

| 维度 | 必测用例 |
|---|---|
| 输入证据 | full recent context、rolling summary、tool success/error/dropped、previous gaps、budget/round、stale final |
| 数据安全 | sensitive、shell stdout、MCP/web prompt injection、URL secret、源码、二进制、超大结果 |
| 模型 route | aux unset/missing/same/different、same model different endpoint、small window、cross trust、fallback |
| verdict | met/not_met/waiting/unavailable、malformed、contradiction、timeout、abort、context-too-long |
| explicit | sole success、mixed、error、permission deny、disabled、plan、dropped、queued steer |
| deterministic | threshold 边界、source stale/unavailable、clock deadline、test exit、queue empty |
| lifecycle | fresh、bare resume、restart、background wake、clear/replace while pending、public hook block |
| budgets | judge request/token/time、Goal token/time、stop block/max turn、extend 后共享 tracker |
| events | not_met gaps/round、waiting park、met exactly once、exhausted、unavailable 不伪造 gaps |

建议验证命令：

```bash
bun test packages/core/src/hooks/goal-stop-hook.test.ts \
  packages/core/src/engine/turn-loop-goal-lifecycle.test.ts \
  packages/core/src/engine/aux-key.test.ts \
  packages/core/src/engine/__tests__/aux-client-per-session-key.test.ts

bun test packages/core/src
bun test
```

## 10. 工程判断与预期改善

### 10.1 `aux + finalText` 是否是主要症结

**是，但要精确表述为“未经资格校验的 aux route + 缺少执行证据的窄 prompt”，其中上下文饥饿是首要根因。**

- 如果只把 aux 换成 primary，强模型仍只能根据片面文本猜；会改善但不会根治。
- 如果只喂更多上下文给任意 aux，能显著减少臆测，但仍有窗口、质量、隐私和跨域风险。
- explicit/deterministic 优先后，绝大多数可验证目标不再依赖旁路猜测；contextual judge 只处理兼容和遗忘场景。

### 10.2 预期改善

重构后预期：

1. “还差 XX”来自真实 unmet criterion、工具失败或数值差距，而不是 final prose 推断；
2. 测试通过、benchmark 达标、quota 到阈值等可审计条件不会因最后总结漏写而被误判；
3. 空/stale final、旧 cache、previous gap 循环得到显式处理；
4. aux 仍可节省成本，但不再因“设置了 auxText”就自动获得高后果判断权；
5. judge failure 的重试、token、time 和 fallback 可观测、有限额；
6. complete、waiting、blocked/unavailable、budget exhausted 不再混成同一种“停止”。

不能承诺 LLM judge 形式化正确；可承诺的是：消除已知信息饥饿，把可程序判断的条件移出 LLM，把模型完成声明与执行结果绑定，并让剩余概率判断可评测、可限额、可回滚。

## 11. 本次调查验证

- 定向现状测试：38 pass / 0 fail / 87 assertions，覆盖 goal hook、TurnLoop goal lifecycle、aux key 与 aux client identity/fallback。
- 三个外部对照链接均已读取自 OpenAI/Anthropic 官方文档。
- 本次只新增本文档；未修改生产源码或测试，未 commit。

## 12. 多条件裁决：Codex/CC 怎么做 + CodeShell 建议

本节是对 §4、§5 的专项补证；若前文把某个 deterministic criterion 的 `met` 写得像是可以直接完成整个 Goal，应以本节为准：**叶子条件成立不等于整个 Goal 成立，必须先按用户表达的逻辑关系和条件角色做组合裁决。**

### 12.1 查证范围与证据等级

本次在 2026-07-10 核对了以下一手来源：

1. OpenAI 官方 [Using Goals in Codex](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex)；该指南称 Goals 自 Codex 0.128.0 起可用。
2. `openai/codex` 公开源码稳定标签 [`rust-v0.144.1`](https://github.com/openai/codex/releases/tag/rust-v0.144.1)，对应 commit [`44918ea10c0f99151c6710411b4322c2f5c96bea`](https://github.com/openai/codex/commit/44918ea10c0f99151c6710411b4322c2f5c96bea)。同时复核了 2026-07-09 的 `main` commit [`1f0566d3f59298d1bb88820a0d35294f1eeb07ea`](https://github.com/openai/codex/commit/1f0566d3f59298d1bb88820a0d35294f1eeb07ea)，本文涉及的数据结构、工具契约和 completion audit 结论一致。
3. Anthropic 官方 [Claude Code `/goal`](https://code.claude.com/docs/en/goal)，页面标注需要 Claude Code v2.1.139 或更高版本。

下文把官方指南的产品语义与公开源码能直接证明的实现分开。公开源码之外是否还有服务端风控、实验性复核或未开源产品层逻辑，**未证实**；不能据此宣称所有 Codex 产品表面绝无任何内部二次检查。

### 12.2 Codex Goals 的真实机制

#### 1. Goal 的 completion contract 是自然语言，不是条件 AST

Codex 不是完全无结构：lifecycle status、token budget、tokens/time accounting 是结构化字段；但**决定“做完了什么”的 objective 是单个字符串**。公开的 `ThreadGoal` 只有 `objective`、`status`、budget/usage/time/timestamp 等字段，没有 `criteria[]`、condition id、group、`all/any` 或 AND/OR AST：[protocol `ThreadGoal`](https://github.com/openai/codex/blob/44918ea10c0f99151c6710411b4322c2f5c96bea/codex-rs/protocol/src/protocol.rs#L3995-L4009)、[state `ThreadGoal`](https://github.com/openai/codex/blob/44918ea10c0f99151c6710411b4322c2f5c96bea/codex-rs/state/src/model/thread_goal.rs#L60-L71)。`create_goal` 同样只接收自然语言 `objective` 和可选 `token_budget`：[goal tool schema](https://github.com/openai/codex/blob/44918ea10c0f99151c6710411b4322c2f5c96bea/codex-rs/ext/goal/src/spec.rs#L25-L57)。

因此，“多个条件如何组合”的权威来源首先是**用户写下的自然语言 objective 及其引用的文件/规格**，不是框架另存的一套勾选项。`且/同时/while/without`、`或/either/先到者`、前置关系和例外条件都由工作模型按文本语义解释。公开接口没有一个额外的 `operator: AND | OR` 让用户选择。

#### 2. 默认 completion 路径是主模型基于当前证据显式声明

官方指南把 Goal 定义为 thread-scoped completion contract：Codex 根据 thread 中的文件、命令、测试、日志、benchmark 和 artifact 等证据工作；接近完成时必须对 objective 做 evidence-based audit，而不能因为“看起来差不多”就完成。[官方架构说明](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex#how-goals-are-designed-in-codex)

公开源码进一步固定了裁决规则。自动 continuation 给工作模型的 prompt 要求：

- 从 objective、引用文件、计划、规格、issue 和用户指令中导出具体 requirements；
- 对每个明确 requirement、编号项、artifact、command、test、gate、invariant 和 deliverable 找权威证据；
- 不确定、间接或缺失的证据按未达成处理；
- 只有证据证明 **every requirement** 已满足且没有剩余必做工作，才调用 `update_goal(status="complete")`。

见稳定标签的 [completion audit prompt](https://github.com/openai/codex/blob/44918ea10c0f99151c6710411b4322c2f5c96bea/codex-rs/ext/goal/templates/goals/continuation.md#L30-L41)。完成是模型的结构化 lifecycle tool call；`update_goal` 只允许模型写 `complete` 或满足严格条件的 `blocked`，并再次声明“objective achieved and no required work remains”才可 complete：[update_goal schema](https://github.com/openai/codex/blob/44918ea10c0f99151c6710411b4322c2f5c96bea/codex-rs/ext/goal/src/spec.rs#L60-L93)。工具执行后才把持久化状态更新为 complete：[tool executor](https://github.com/openai/codex/blob/44918ea10c0f99151c6710411b4322c2f5c96bea/codex-rs/ext/goal/src/tool.rs#L221-L290)。

公开 Goal extension 的 turn-stop 路径只做进度记账，idle 时若 Goal 仍 active 则启动下一 continuation；本次审阅范围没有发现把 `objective + finalText` 交给另一模型的独立 completion judge：[turn-stop accounting](https://github.com/openai/codex/blob/44918ea10c0f99151c6710411b4322c2f5c96bea/codex-rs/ext/goal/src/extension.rs#L243-L268)、[idle continuation](https://github.com/openai/codex/blob/44918ea10c0f99151c6710411b4322c2f5c96bea/codex-rs/ext/goal/src/runtime.rs#L359-L414)。所以能由公开资料支持的结论是：**Codex 的主要完成判定者是一直在该 thread 中工作的模型，输出是显式 `update_goal(complete)`；未发现公开实现中的外部 LLM judge。**闭源层是否另有复核仍属未证实。

#### 3. 有确定性 check，但它不替用户组合 objective 的成功条件

Codex 有确定性的 lifecycle/accounting guard，例如 token budget 到线进入 `budget_limited`、usage limit 进入 `usage_limited`、错误和 idle/queued-work 条件控制是否继续。这些机制能决定“现在不能再继续”或“能否启动下一轮”，但**不是一个通用的 objective criterion engine**，不会把测试、额度、时间等自然语言叶子解析成布尔值后自动聚合为 complete。官方 prompt 反而要求主模型检查当前 worktree/external state，再显式声明完成。

预算尤其不能冒充成功。官方指南和源码都明确：budget reached 时应停止实质工作并总结，**budget limit is not completion**；prompt 也禁止仅因预算将尽或正在停止就 complete：[budget-limit prompt](https://github.com/openai/codex/blob/44918ea10c0f99151c6710411b4322c2f5c96bea/codex-rs/ext/goal/templates/goals/budget_limit.md#L1-L16)。

#### 4. 多条件的实际裁决规则

Codex 没有“任一叶子 true 就 complete”的规则。它的保守默认是：先从全文导出所有 required items，再逐项审计；凡是被理解为并列 requirement 或 constraint 的项目，全部满足才可完成。官方性能示例把“p95 低于 120 ms”和“correctness suite 保持绿色”放在同一 Goal 中，并明确说明：延迟仍高时未完成；延迟达标但正确性失败时也未完成。[官方多条件示例](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex#turning-a-weak-goal-into-a-strong-one)

这证明默认的并列成功条件/约束按 AND 审计，但不证明 Codex 把所有分号都机械解释为 AND。显式 `or`、alternative、deadline、stop clause、条件动作和先后关系仍由模型按自然语言整体解释。换言之：

- **谁定义 AND/OR：**用户的措辞和引用规格定义；
- **谁解释并裁决：**持有 thread context 和工具证据的工作模型；
- **框架是否保存显式 AND/OR：**公开结构没有；
- **措辞歧义怎么办：**官方建议先把 Goal 收紧到可度量 outcome、verification surface、constraints 和 blocked stop condition；若歧义会改变停止行为，应先向用户确认，不能靠某个叶子信号抢跑 complete。

### 12.3 Claude Code `/goal` 的 condition 表达对照

CC `/goal` 也是**一条自然语言 condition 字符串**，不是公开的结构化条件清单。官方页面建议 condition 有“one measurable end state”，但它可以在同一字符串中带检查、约束和多个子句，最长 4,000 字符。官方直接给出 AND 示例：`all tests ... pass and the lint step is clean`；也允许把边界写成 OR：`or stop after 20 turns`。[设置与 condition 写法](https://code.claude.com/docs/en/goal#set-a-goal)

与 Codex 的关键差别是裁决者：CC `/goal` 是 session-scoped prompt-based Stop hook 的包装。每轮结束后，它把 **condition + conversation so far** 发给配置的 small fast model（默认 Haiku）；evaluator 返回 yes/no 和短理由，yes 清 goal，no 把理由带入下一轮。evaluator 不调用工具，只能判断 Claude 已经在 conversation 中暴露的证据。[CC evaluation](https://code.claude.com/docs/en/goal#how-evaluation-works)

所以 CC 的结论是：

- 表达层是一个自然语言 condition，可含 `and`/`or`，没有公开 criteria AST 或 checkbox；
- 多子句由独立 evaluator 按全文语义整体判 yes/no；
- `/goal` 默认不是确定性 evaluator；要确定性检查，应改用自定义 command/script Stop hook。官方也明确区分了 script deterministic check 与 prompt/model check。[CC workflow comparison](https://code.claude.com/docs/en/goal#compare-ways-to-keep-a-session-running)

### 12.4 对 CodeShell 的明确建议

**结论：保留自然语言 objective 为唯一语义原文，同时引入可选的轻结构条件图；不要在“纯自然语言”与“强制结构化表单”之间二选一。**

建议 V1 采用双层表示：

```ts
interface GoalContractV1 {
  objective: string; // 用户原文，canonical source of truth
  compiled?: {
    leaves: GoalConditionLeaf[];
    success?: ConditionExpr; // all / any；仅在关系明确时生成
    invariants: string[];
    stopPolicy?: ConditionExpr; // deadline、quota、turn cap 等
    actions: ConditionalAction[]; // if X then Y
    provenance: "user_explicit" | "model_suggested_user_confirmed";
  };
}
```

这里的轻结构不是要求所有用户手写 JSON，也不是另造一份会漂移的 objective。它的用途是：

1. 区分 **成功条件**、**必须持续成立的约束**、**停止/预算条件** 和 **条件动作**；这比只有扁平 `criteria[]` 更重要。
2. 保存用户明确表达的 `all/any`。只有出现清楚的“且/全部/同时”或“或/任一/先到者为准”，或用户确认过模型建议，才固化 operator；歧义时保持 uncompiled/unknown 并询问，不擅自选 AND/OR。
3. 让 provider 对叶子产生可审计 observation，而不是直接产生整个 Goal 的 verdict。

推荐裁决管线是：

```text
raw objective + 可选轻结构
  -> deterministic providers 计算叶子事实
  -> 按明确的 all/any 聚合完全结构化的部分
  -> 把事实卡片、聚合结果、未知项和 thread evidence 交给主模型
  -> 主模型按 raw objective 做 requirement-by-requirement audit
  -> 全部 success requirements 满足且 invariants 未破坏，才显式 complete_goal
  -> contextual judge 只处理主模型遗忘/能力兼容，不能把单个叶子 true 提升为 met
```

这与 Codex **方向一致但不是原样复制**：一致之处是自然语言 contract 保持权威、当前证据优先、主模型逐项审计并显式完成；CodeShell 额外增加 deterministic leaf providers 和轻结构 condition graph，这是为了准确处理额度、时钟、测试等机器可读事实，公开 Codex 实现没有这套通用聚合器。

若整个 expression 已由用户明确确认、所有叶子都有权威 provider 且没有自然语言剩余项，Core 可以直接按 `all/any` 算出 goal-level result，省掉 LLM；否则“确定性条件先算 → 把事实卡片喂主模型 → 主模型按自然语言综合裁决”是推荐默认。关键限制是：**deterministic-first 指叶子事实优先，不是任一确定性叶子命中就优先完成。**

这也要求调整 §5.2 的优先级语义：structured criterion 的 `met/not_met/unknown` 默认是 `CriterionObservation`；只有 top-level expression 本身已明确且全可程序化时，aggregator 才能直接产出 Goal `met/not_met`。否则仍由主模型综合，contextual judge 只兜底。

### 12.5 具体例子：额度 90% + 08:30 收尾

原句：

> 按 goal.md 干活，直到 codex 7d 额度 90%；早上 8:30 收尾；额度快完设定时器。

它混合了至少四种语义，不能把分号后的每段都当成同类 success criterion：

1. `按 goal.md 干活`：artifact/work objective；`goal.md` 内的交付项通常是 success requirements。
2. `7d 额度 90%`：资源停止阈值。
3. `08:30 收尾`：clock deadline / wrap-up trigger。
4. `额度快完设定时器`：条件动作；“快完”的阈值还不明确。

推荐系统先向用户展示或确认如下归一化：

```text
Success: goal.md 的必做交付项全部完成且验证通过
Stop policy: codex.usage.7d.percent >= 90 OR local_time >= 08:30（先到者为准）
Action: usage 接近阈值时设置定时器（需明确“接近”的阈值）
```

假设用户确认“额度或时间先到者就收尾”，在当前额度已到 90%、时间尚未到 08:30 时：

1. usage provider 产出事实卡：`quota90 = true`，带 current value、source、observedAt；clock provider 产出 `time0830 = false`。
2. stop-policy aggregator 算 `any(true, false) = true`，因此现在进入收尾，不等待 08:30。
3. 同时单独审计 `goal.md`：若其全部交付项已完成，主模型可以显式 `complete_goal`；若未完成，则**不能把额度命中写成 `met`**，应以 `usage_limited/budget_limited/exhausted` 一类原因停止实质工作并总结剩余项。
4. 若只达到“快完”阈值但未到 90%，执行“设定时器”动作；这仍不代表 success 或 stop。

如果用户真正想表达的是“额度达到 90% **并且** 已到 08:30 才算结束”，则 expression 是 `all(quota90, time0830)`，一真一假必须继续。但从原句无法安全证明这一 AND；也无法安全证明“达到资源上限就算业务目标成功”。因此系统不应凭分号或某个 deterministic signal 自作主张，而应把 operator 与条件角色确认清楚。

最终裁决原则可以压缩成一句话：**事实由程序算，AND/OR 与条件角色由用户 contract 定义，主模型在完整证据上审计；资源/时间触发默认改变 lifecycle，不自动证明 objective 完成。**
