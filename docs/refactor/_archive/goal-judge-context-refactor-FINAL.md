# Goal 裁判上下文重构最终方案

> 状态：**FINAL / SHIP-with-nits**。六项实施前 addendum 已落定，且各有 contract tests；可进入拆分后的 Phase -1。  
> 日期：2026-07-10。  
> 范围：CodeShell Goal 完成判断，核心落点在 `packages/core/`。本文是设计与实施契约，不包含本次生产代码或测试改动。

## 0. 文档沿革与结论

本文由“原方案 → 第一轮 Review（R1）→ v2 修订方案 → 第二轮 Review（R2）”收敛而来，并取代上述全部中间稿。R1 提出的 3 个 Blocker 与 6 个 Major 已由 v2 转为 Phase -1 前置契约、Phase 0 可证伪评测、Phase 1 安全投影、Phase 2 explicit-first hybrid 和路径矩阵；R2 的结论是：总体 A+C 路线无需重做，补齐 6 个实施前契约点后即可进入拆分的 Phase -1。

本定稿已经把 6 点分别写入 §3.1—§3.4 的“实施前必须敲定（addendum）”，并为每一点规定 contract tests。因此最终评审状态记为 **SHIP-with-nits**：Phase -1 总体工作量为 L，按 `-1a private merge`、`-1b route/ledger`、`-1c completion guard` 三个 PR 实施；Phase 0 的 fixture schema 和启动 seed 可与 Phase -1 并行。

最终架构固定为：**安全可接受的 `complete_goal` 显式完成优先；私有、受信任域和总预算约束的 contextual judge 兜底；公共 hook 只能额外阻止普通停止；既有 turn/stop/token/time 硬边界最终兜底。** Phase 3 的双模型/强 verifier 只在数据证明必要时另立 RFC。

## 1. 问题陈述与已核实事实

### 1.1 当前根因

Goal 模式的正常停止链路是：主模型返回无工具调用，`TurnLoop` 追加最终 assistant message，发出 `on_stop`，`createGoalStopHook()` 再调用一次 LLM；`met` 允许完成，`waiting` 在有后台工作时允许停泊，`not_met`、异常或不可解析则注入继续提示。关键实现位于 `packages/core/src/engine/turn-loop.ts:928`—`packages/core/src/engine/turn-loop.ts:1032` 和 `packages/core/src/hooks/goal-stop-hook.ts:172`—`packages/core/src/hooks/goal-stop-hook.ts:382`。

Engine 将该 judge 装配到 `auxSummaryClient`（`packages/core/src/engine/engine.ts:1927`、`packages/core/src/engine/engine.ts:2071`—`packages/core/src/engine/engine.ts:2074`）。aux 未配置、配置缺失、client 构建失败或 identity 与 primary 相同会回退 primary（`packages/core/src/engine/engine.ts:2449`—`packages/core/src/engine/engine.ts:2503`），所以“aux 必然更弱”不是事实；确定的风险是该高后果判断可以被路由到成本导向的另一模型，而实际 prompt 只含 objective、设定/当前时间、`finalText` 和后台任务（`packages/core/src/hooks/goal-stop-hook.ts:254`—`packages/core/src/hooks/goal-stop-hook.ts:287`），没有工作历史或工具证据。

`TurnLoop` 在判断前确实持有更好的证据源：工具调用/结果以结构化 block 进入工作 messages（`packages/core/src/engine/turn-loop.ts:1048`—`packages/core/src/engine/turn-loop.ts:1128`），且 messages 已经历 ContextManager、敏感结果替换和图片降级（`packages/core/src/engine/turn-loop.ts:680`—`packages/core/src/engine/turn-loop.ts:703`、`packages/core/src/engine/turn-loop.ts:790`—`packages/core/src/engine/turn-loop.ts:810`）。因此根因是“可能不同能力/信任域的独立模型 + 确定缺少受控执行证据”，不是数据不存在。

### 1.2 对原方案 5 处事实纠正

1. **`on_stop` 不是完整地只收三个字段。** 业务 emit 显式传 `goal/finalText/turnCount`，但 `TurnLoop.emitHook()` 还自动合并 `isSubAgent/sessionId/signal`（`packages/core/src/engine/turn-loop.ts:440`—`packages/core/src/engine/turn-loop.ts:452`、`packages/core/src/engine/turn-loop.ts:951`—`packages/core/src/engine/turn-loop.ts:955`）。公共 envelope 的兼容基线是这些既有字段；不得加入 judge DTO 或 digest。
2. **`finalText` 不是无条件等于最后一次无工具响应。** 只有 truthy `response.text` 才覆盖（`packages/core/src/engine/turn-loop.ts:901`—`packages/core/src/engine/turn-loop.ts:904`）；最后空响应会沿用更早文本，并在自然停止时把旧文本再次 push（`packages/core/src/engine/turn-loop.ts:928`—`packages/core/src/engine/turn-loop.ts:940`）。fixture 必须覆盖空 final，V1 evidence 不得把旧 `finalText` 误当最新证据。
3. **messages 是后处理工作上下文，不是主请求的逐字节副本。** 主调用前会 `manageAsync()`，返回后会替换已消费的 sensitive tool result、降级图片并追加 final assistant（`packages/core/src/engine/turn-loop.ts:680`—`packages/core/src/engine/turn-loop.ts:703`、`packages/core/src/engine/turn-loop.ts:790`—`packages/core/src/engine/turn-loop.ts:810`、`packages/core/src/engine/turn-loop.ts:940`）。它仍是 judge 最合适的结构化证据源，但必须称为“治理后的工作上下文”。
4. **Goal token/time 是检查点，不是调用前硬隔离。** 当前只在主响应完成后累计该响应 usage，再检查预算（`packages/core/src/engine/turn-loop.ts:887`—`packages/core/src/engine/turn-loop.ts:925`）；judge 又因 `recordUsage:false` 漏记（`packages/core/src/hooks/goal-stop-hook.ts:276`—`packages/core/src/hooks/goal-stop-hook.ts:284`、`packages/core/src/llm/client-base.ts:70`—`packages/core/src/llm/client-base.ts:79`）。本方案的“预算”同时包含调用前保守准入和调用后实际/保守计量。
5. **Goal helper 的 300 不是所有 host 的有效默认。** `GOAL_DEFAULT_MAX_TURNS=300` 只在没有显式 engine/goal override 时生效（`packages/core/src/engine/goal.ts:90`—`packages/core/src/engine/goal.ts:98`、`packages/core/src/engine/goal.ts:159`—`packages/core/src/engine/goal.ts:165`）；例如 EngineRunner 总是提供默认 30（`packages/core/src/run/EngineRunner.ts:182`—`packages/core/src/run/EngineRunner.ts:187`）。成本与最坏请求数必须按 host 有效配置估算。

### 1.3 必须保留的既有语义

- judge throw/不可解析继续 fail-closed，不得被当成 `met`（`packages/core/src/hooks/goal-stop-hook.ts:291`—`packages/core/src/hooks/goal-stop-hook.ts:325`）；但 ledger/time/token 已耗尽是硬终止，不归类为普通 `unavailable`。
- `waiting` 仍是独立第三态，且只有真实后台工作数量大于 0 才能停泊（`packages/core/src/hooks/goal-stop-hook.ts:342`—`packages/core/src/hooks/goal-stop-hook.ts:363`）；在 finite/service lifecycle 结构化前不得删除该 guard。
- `cancel_goal` 仅表示用户明确放弃，继续要求 `confirm:true`，不把未完成、困难或阻塞映射为 cancel（`packages/core/src/tool-system/builtin/cancel-goal.ts:1`—`packages/core/src/tool-system/builtin/cancel-goal.ts:16`、`packages/core/src/engine/turn-loop.ts:1179`—`packages/core/src/engine/turn-loop.ts:1194`）。
- `maxTurns`、`maxStopBlocks`、Goal token/time budget 都保留。cap=N 的自然停止上界是 N+1 次 `on_stop` invocation，因为 emit 发生在 cap 检查前（`packages/core/src/engine/turn-loop.ts:951`—`packages/core/src/engine/turn-loop.ts:997`）；现有 cap=2 测试证明的是 3 次 handler invocation，不是必然 3 次 LLM 请求（`packages/core/src/engine/turn-loop-goal-lifecycle.test.ts:158`—`packages/core/src/engine/turn-loop-goal-lifecycle.test.ts:188`）。
- `complete_goal` 是已有显式完成快路径，不与 `cancel_goal` 合并；接受成功时不调用 judge。当前工具和短路位置见 `packages/core/src/tool-system/builtin/complete-goal.ts:27`—`packages/core/src/tool-system/builtin/complete-goal.ts:53`、`packages/core/src/engine/turn-loop.ts:1159`—`packages/core/src/engine/turn-loop.ts:1176`。

## 2. 不可妥协的设计目标与取舍

1. 证据只走私有、run-scoped typed channel；第三方/settings/SDK hook 看不到 DTO。
2. 新增 V1 evidence 出 primary 信任域必须显式 opt-in；旧 V0 仅按 §3.2 的兼容性 grandfathering 规则处理。
3. 所选 route 的整个请求而非 DTO 局部必须可放入窗口和剩余 ledger；每次 judge 请求、token、延迟和 fallback 均可审计。
4. `complete_goal` 只有在本次外层 run 内能力允许、声明批次安全、实际结果成功且没有 queued steer 时才接受。
5. premature `met` 是最高权重错误；停止、cap 耗尽和真完成必须用由 `TurnLoop` 终止分支直接产生的内部 subtype 区分。
6. core 保持领域无关：测试、git、shell 只是 tool evidence，不是所有 Goal 的硬编码完成标准。
7. V1 不保留低收益 verdict cache；按 N+1 stop invocation 和所有 retry/fallback 网络尝试的最坏情况做 ledger 设计。
8. 不自造第二套压缩/摘要或“万能脱敏器”；投影只消费 ContextManager 已治理的结构化证据，默认只给 name/status/errorClass/keyed digest。

采用 A+C 的分层路线：Phase 1 用安全、受控上下文修复信息饥饿；Phase 2 让拥有完整上下文的主模型显式声明完成，contextual judge 负责遗忘、自然停止和 waiting 兜底。全量 primary 或双模型升级不进入首版。

## 3. Phase -1：实施前契约（L，拆为三个 PR）

Phase -1 建立安全/容量/兼容 seam；此阶段 judge 仍可只使用 V0 的 objective + clock + final + background，不得把 `GoalJudgeEvidenceV1` 写入 `HookContext.data`，也不得发送工具证据。总体工作量为 **L**，按以下边界交付：

- `-1a private merge`：私有 judge service/channel、公共 hook 合并、goal generation、UI/terminal subtype。
- `-1b route/ledger`：route metadata、trust/window provenance、完整渲染预算、跨 fallback 原子 ledger、外层 run 共享 tracker。
- `-1c completion guard`：三态 capability、executor seam、batch rejection、sole-call/finalize guard。

三个 PR 可各自 review/回滚，但必须共同满足本章 contract tests 才算 Phase -1 完成。Phase 0 fixture schema 与 36–48 条启动 seed 可并行准备。

### 3.1 私有 built-in judge 通道与多 handler 合并

#### 契约与依据

- 在 `TurnLoopDeps` 附近增加 run-scoped `runGoalJudge(input): Promise<BuiltinGoalJudgeResult>` typed callback；现有依赖定义在 `packages/core/src/engine/turn-loop.ts:110`—`packages/core/src/engine/turn-loop.ts:170`，Engine 装配点在 `packages/core/src/engine/engine.ts:2107`—`packages/core/src/engine/engine.ts:2155`。
- Engine 不再把 built-in goal judge 注册成公共 `on_stop` handler；当前注册/卸载点为 `packages/core/src/engine/engine.ts:2028`—`packages/core/src/engine/engine.ts:2095`、`packages/core/src/engine/engine.ts:2292`—`packages/core/src/engine/engine.ts:2298`。私有 callback 的 run closure 持有 goal generation、route、ledger 和持久化回调。
- 公共 `on_stop` 继续通过 `HookRegistry.emit()` 接收旧 envelope。Registry 对 handler chain 复用并合并可变 ctx（`packages/core/src/hooks/registry.ts:78`—`packages/core/src/hooks/registry.ts:123`），settings shell hook 会序列化整个 `{eventName,data}`（`packages/core/src/hooks/shell-runner.ts:206`—`packages/core/src/hooks/shell-runner.ts:209`）；symbol、浅 clone 或约定式不读都不构成隔离。
- settings/SDK handlers 可与 Goal 共存，settings 优先级为 50、现有 Goal handler 为 0（`packages/core/src/engine/engine.ts:490`—`packages/core/src/engine/engine.ts:508`、`packages/core/src/engine/engine.ts:616`—`packages/core/src/engine/engine.ts:618`）。当前插件 `Stop` 映射 `on_session_end` 而非 `on_stop`（`packages/core/src/plugins/loadPluginHooks.ts:25`—`packages/core/src/plugins/loadPluginHooks.ts:33`、`packages/core/src/plugins/loadPluginHooks.ts:56`—`packages/core/src/plugins/loadPluginHooks.ts:64`），威胁主体应准确称为 settings shell、SDK/config 和直接注册的 handler。

自然停止且 active goal 存在时，固定顺序为：

1. 捕获 `{goalId/generation, objective}`，形成 private、deep-frozen input，检查硬终止和 judge 准入；
2. 调 built-in judge，得到私有 `met | waiting | not_met | unavailable` 和可选 nudge，不在 callback 内清 goal；
3. await 后重新读取 live goal generation，并消费 finalize-backfill queued steer；generation 不同或有新 steer 时丢弃 verdict；
4. 在没有硬终止时发公共 `on_stop` 旧 envelope，公共 handlers 按既有优先级和 `stop` 语义运行；
5. 普通停止合并为 `continue = builtin.blocks || public.continueSession === true`。built-in `not_met/unavailable` 阻止停止；`met` 或有真实后台工作的 `waiting` 允许停止，但公共 hook 可额外阻止；
6. `HookResult.stop` 只截断公共 hook chain，保持 `packages/core/src/hooks/events.ts:38`—`packages/core/src/hooks/events.ts:41` 的既有含义，不能跳过、覆盖或强制通过 built-in 判定；
7. 公共 messages 保持 Registry 顺序；built-in 也阻止时把 judge nudge 追加在末尾。公共 `data.goalVerdict` 不是 Goal 状态权威来源；
8. 仅当 generation 仍相同、无 queued steer、没有硬终止、最终 `continue=false` 且私有 verdict=`met` 时清持久 goal。现有过早副作用点为 `packages/core/src/hooks/goal-stop-hook.ts:328`—`packages/core/src/hooks/goal-stop-hook.ts:339`；
9. 公共 handler throw 继续隔离为 no-op（`packages/core/src/hooks/registry.ts:124`—`packages/core/src/hooks/registry.ts:127`），不改变私有 verdict。

公共 `on_stop` 的兼容验收只要求**字段集合、字段含义和序列化形状不变，且没有 V1 DTO、digest 或 tool evidence**。不得要求快照“没有代码/命令/路径”，因为既有 `goal` 与 `finalText` 本来就可能包含这些内容（`packages/core/src/engine/turn-loop.ts:951`）。

#### 实施前必须敲定（addendum）：goal generation、迟到 verdict 与 UI/subtype

**正式结论：** 每次 set/replace/clear active goal 都递增 run/session 可比较的 generation；judge input 捕获 generation，await 后与清 goal前各复核一次。clear、replace 或 post-judge queued steer 任一发生，in-flight verdict 一律标为 `stale_goal_judgment`，不注入旧 nudge、不发完成事件、不清 goal；steer 先进入 messages，下一轮用新验收条件重判。只比较 active boolean 不足以识别 replace。

当 `builtin=met` 但公共 hook `continueSession=true` 时，不发 `goal_progress.met`，也不伪造 `goal_progress.not_met`；goal 保持 active，只记录内部 terminal/continuation subtype `public_hook_blocked_after_met`，下一自然停止重新判断。这样符合公开 `goal_progress.met` 表示最终完成的既有含义（`packages/core/src/types.ts:477`、`packages/core/src/types.ts:496`）。

**Contract tests：**

- pending judge × `clearGoal()`：迟到 `met/not_met/waiting` 均无事件、无 nudge、无二次清理；
- pending judge × replace goal：旧 generation verdict 作废，新 objective 的下一轮 verdict 才能生效；
- pending judge/public hook × queued steer：steer 先消费、goal 不清、下一轮 evidence 含新条件；
- `met + public allow` 只清一次并发一次 `goal_progress.met`；`met + public continue` 不清、不发 met/not_met，只记 `public_hook_blocked_after_met`；
- `not_met + public stop` 仍继续，且公共 messages 在前、judge nudge 在后；
- 高/同/低优先级公共 handler 的 `stop/continue/data overwrite/throw` 组合不能覆盖 private verdict；
- shell stdin snapshot 的字段集合和序列化形状与旧契约相同，无 V1 DTO/digest/tool evidence；fixture 可保留 goal/final 中原有的代码或路径；
- private input 的嵌套 mutation 在 strict-mode 失败或不影响源值。

### 3.2 aux 数据信任域、route metadata 与窗口来源

#### 契约与依据

`LLMConfig` 已有 `provider/model/baseUrl/maxContextTokens/providerKind`（`packages/core/src/types.ts:654`—`packages/core/src/types.ts:690`），当前 aux 可由不同 provider/baseUrl 构建（`packages/core/src/engine/engine.ts:2467`—`packages/core/src/engine/engine.ts:2496`）。Phase -1 把 client 与元数据解析为内部 `GoalJudgeRoute`：`client`、`modelIdentity`、`trustDomain`、`effectiveEndpoint`、`maxContextTokens`、`contextWindowSource`、`maxOutputTokens`、`routeKind`；apiKey 不得进入结构或日志。

固定路由如下：

| 条件 | V1 evidence route | 明示 fallback |
|---|---|---|
| aux 与 primary 同信任域且容量已知 | aux | aux 失败后 primary V1；仍失败则合规 V0/无 LLM |
| 跨域且显式允许 `allowCrossTrustGoalEvidence` | aux，并记 `cross_trust_opt_in=true` | primary V1；再失败走合规 V0/无 LLM |
| 跨域且未 opt-in | primary V1，绝不向 aux 发 V1 | primary 不合格时可按下述 grandfathering 向既有 aux 发 V0，或零请求 |
| 容量未知、budget/cap 不准入或无 client | 不发 V1 | V0 也不能证明准入则零请求；普通 provider 故障为 `unavailable`，ledger exhausted 则硬终止 |

primary fallback 是安全路由，不是首版 `goalJudgeModel=aux|primary|auto` 设置。紧急开关只能把 V1 留在 primary 或整体关闭 V1，不能强制未授权跨域发送。

payload 日志只允许 context/policy version、各 section token/byte 数和 per-run keyed HMAC-SHA256 digest；HMAC key 仅在 run 内存活。指标可记 route kind、同域 boolean、opt-in、verdict enum、requestCount、latency、fallback code 和窗口来源；禁止记录 DTO、完整 prompt、preview、objective/final/background 原文、模型原始回复或 gaps 原文。现有 response/gaps 日志点（`packages/core/src/hooks/goal-stop-hook.ts:308`—`packages/core/src/hooks/goal-stop-hook.ts:317`、`packages/core/src/hooks/goal-stop-hook.ts:366`）在 V1 telemetry 中只记长度/digest/parse code。

#### 实施前必须敲定（addendum）：effective endpoint、custom path、V0 grandfathering 与 provenance

**正式结论：** `effectiveEndpoint` 必须是 SDK/client 实际将访问的 endpoint，而不是配置中可缺省的 `baseUrl` 字符串；已知 provider 的默认 endpoint 要先解析为真实 scheme/host/port。`trustDomain` 至少包含规范化 `providerKind`（缺失时用 provider）与 effective origin。对 `providerKind=custom`/OpenAI-compatible gateway，再包含规范化 pathname（去尾斜杠，空路径与 `/` 等价）；同 host 不同 custom path 默认跨域，因为可能代表不同租户/处理者。若部署确知两个 path 属同一处理者，只能通过显式 trust-alias 配置合并，并记录该 opt-in；凭证相同、模型名相同或 `sameLlmIdentity()` 均不能替代信任域判断。标准 provider 的普通 API path 差异不扩大 origin，但 providerKind 必须一致。

**V0 兼容决定：** 跨域 V0 **grandfathered**，仅限重构前已经发送的 objective + clock + final + background 字段，且只在既有 aux 配置路径、V1 未授权/不可用时使用；不得夹带 DTO、digest、tool status、summary、steering provenance 或任何新 evidence。telemetry 必须标 `cross_trust_v0_legacy=true`。此决定把“出域需 opt-in”的强约束明确限定为新增 V1 evidence，保留回滚兼容；后续若要禁用跨域 V0，另走 breaking-policy 迁移。

窗口必须带 `contextWindowSource: explicit | catalog | provider_cache | fallback | unknown`。`reloadCachedContextWindows()` 在 catalog/cache 失败后写入 200k fallback 且当前丢失来源（`packages/core/src/llm/model-pool.ts:128`、`packages/core/src/llm/model-pool.ts:153`、`packages/core/src/llm/model-pool.ts:175`），所以 **200k fallback 一律视为 unknown**，不得让 V1 准入。`explicit/catalog` 可作为已知；`provider_cache` 仅在缓存同时保留原始 catalog/provider 来源与版本时可作为已知，否则降为 unknown。显式用户值必须作为显式保守上限使用，不得被 fallback 放大。

**Contract tests：**

- 缺省 baseUrl 的 OpenAI/Anthropic fake client 解析到实际 effective origin，而不是 unknown/空字符串；
- provider 相同但 effective origin 不同、providerKind 不同均跨域；model/apiKey 相同不改变结果；
- custom 同 host 同规范化 path 同域，不同 path 跨域；`/v1` 与 `/v1/` 等价；显式 trust alias 才能合并 gateway paths，且 telemetry 标记；
- 跨域未 opt-in 的 fake aux 从未收到 V1；仅能收到字段严格等于 legacy schema 的 V0，或零请求；
- 跨域 opt-in 只放开 V1 route，不放宽日志规则；
- `explicit/catalog/provider_cache-with-source` 容量可准入；`fallback/unknown/provider_cache-without-source` 拒绝 V1；200k fallback 专项反例必须为 unknown；
- route fallback 不改变公共 `on_stop` envelope；
- secret/code/path/URL query/私钥 corpus 在日志原文零命中，per-run digest 跨 run 不同。

### 3.3 总请求预算、共享 ledger 与 hard terminal

#### 总窗口与 shrink 契约

当前 `GoalJudgeLLM` 只有输出 `maxTokens`，route 窗口元数据来自模型配置（`packages/core/src/hooks/goal-stop-hook.ts:29`—`packages/core/src/hooks/goal-stop-hook.ts:40`、`packages/core/src/types.ts:659`—`packages/core/src/types.ts:661`）。对已知 route window `W` 固定：

```text
outputReserve O = 1500
providerSafety S = max(512, ceil(W * 0.05))
windowInputCeiling = W - O - S
conservativeOutputCharge = O
effectiveInputCeiling = min(
  windowInputCeiling,
  remainingJudgeTokens - conservativeOutputCharge,
  remainingGoalTokens - conservativeOutputCharge
)
renderedInput = system + objective + clock + final + background + wrapper + DTO
准入条件：effectiveInputCeiling > fixedOverhead
        且 estimate(renderedInput) <= effectiveInputCeiling
```

没有用户 Goal `tokenBudget` 时，`remainingGoalTokens=∞`；但 judge 自身上限始终生效。使用 `packages/core/src/context/compaction.ts:17`—`packages/core/src/context/compaction.ts:23` 的同口径 estimator 对最终渲染串复算。它是带 padding 的 heuristic，不是 provider tokenizer；验收只能声称“本地估算不越界，provider 报超长时最多一次 shrink”，不能声称 provider 实际 token 数被数学证明。

从 effective ceiling 扣除 system/wrapper/clock 的真实估算后再分区：objective 25%、真实用户 acceptance/steering 20%（独立保留，未使用才归还）、final 10%、background 5%、rolling summary 15%、tool evidence 25%。objective/final/background 也 head+tail 截断并带长度/digest 标记，无字段享有无界豁免。

正常构建为 shrink level 0。若本地估算超限则发送前直接构建 level 1；若 provider 返回可识别 context-length error，只允许再发送一次 level 1。level 1 删除可选 preview，只留 tool name/status/hash；tool evidence 只留最新失败/未完成状态；summary/final/background quota 减半，objective 与真实 steering quota 不被挤占。所有网络尝试原子扣账；第二次仍失败走 route table 的明确 fallback/terminal，绝不依赖静默截断或无限重试。

#### per-run ledger 契约

新增 `GoalJudgeLedger`，记录 `requestCount/inputTokens/outputTokens/totalTokens/latencyMs/fallbackCount`。所有网络尝试（context retry、V0、fallback 和 provider error）都计 requestCount；有 provider usage 用实际值，无 usage 则按“渲染输入估算 + 实际输出估算，至少 1”保守计费。`recordUsage:false` 可避免污染主 client tracker，但不能替代 ledger。

首版内部默认值是保守工程假设，Phase 0 冻结 baseline 前可下调，上线后不得临时放宽：

- `judgeRequestLimit = min(maxStopBlocks + 1, 8)`，不假设 cache 节省请求；
- 无用户 tokenBudget 时 `judgeTokenLimit=32_000`；有用户 budget 时为 `min(32_000, floor(tokenBudget * 0.15))`；
- judge 实际/保守 token 同时计入用户 Goal tokenBudget，UI/telemetry 单列 main 与 judge；
- time budget 覆盖 judge wall time，调用前检查，调用后立即复查。

main 与 judge tracker 的所有权提升到一次外层 `Engine.run()`。同一外层 run 的 headless background drain 再次调用同一个 TurnLoop 时共享对象且不重置；新的 user send/resume/wakeup 创建新 run-scoped tracker。当前 tracker 在 `TurnLoop.runUnredacted()` 开头创建（`packages/core/src/engine/turn-loop.ts:561`—`packages/core/src/engine/turn-loop.ts:573`），headless drain 的 re-entry 位于 `packages/core/src/engine/engine.ts:2228`、`packages/core/src/engine/engine.ts:2289`。standalone TurnLoop 测试可在未注入时自建兼容 tracker。

#### 实施前必须敲定（addendum）：effective ceiling、exhausted 终态、共享对象与优先级

**正式结论：** 准入上限必须取窗口剩余、judge 剩余和 Goal 剩余三者的最小值，section quota 只基于扣除 fixed overhead 后的 `effectiveInputCeiling`。发送前预扣 conservative charge，响应后以实际/保守 usage 对账，多退少补；任何 retry/fallback 使用同一原子 ledger，不能各自拥有 cap。

request/token/time/Goal budget 在 judge 前已耗尽，或 judge 后跨线时，产生硬终止 subtype `judge_budget_exhausted` 或更具体的 `goal_budget_exhausted`，**不得**转成普通 `unavailable` 再 nudge 主模型。`unavailable` 只表示尚有 ledger 但 provider/parse 暂时失败，继续 fail-closed。硬终止可为通知兼容发一次旧 envelope 的公共 `on_stop`，但不附 built-in nudge，且公共 `continueSession`、messages 或 data 均不能重开循环；hard terminal 优先于 built-in/public continue。

外层 `Engine.run()` 创建并注入唯一共享 tracker；`TurnLoop.run()` 的所有内部 re-entry 以及 `TurnLoop.extend()`（现有实例 tracker 操作点为 `packages/core/src/engine/turn-loop.ts:227`、`packages/core/src/engine/turn-loop.ts:255`）必须读写**同一对象 identity**。不得复制数值、替换 tracker 或在 headless drain 重建，从而绕过 extend/ledger。

所有内部 terminal subtype 由 `TurnLoop` 的对应终止分支唯一生产并直接交给内部 telemetry；Engine 不得在末尾根据公共 `reason` 反推。当前公共 `EngineResult` 只有 reason（`packages/core/src/engine/types.ts:184`），session recorder 也只记录 reason（`packages/core/src/logging/session-recorder.ts:351`），因此 subtype 不改变公共 `TerminalReason`。

**Contract tests：**

- effective ceiling 分别被 W、remaining judge、remaining Goal 三者单独卡住，以及三者相等/只差一 token的边界；
- fixed overhead 已大于 ceiling 时零网络请求；objective/final/background 超大时仍按 quota 收敛；
- provider context error 最多一次 shrink；两次尝试共用 request/token cap，第二次失败进入枚举 fallback/terminal；
- provider usage 有/无都进入 judge ledger 与 Goal tokenBudget；有 usage 对账误差为 0，无 usage 只允许保守高估；
- request/token ledger exhausted 直接终止且不再有主模型调用；provider 临时失败但 ledger 未耗尽才返回 unavailable+nudge；
- judge 前 time 已耗尽、judge 中跨线、judge 后仍充足三种时序；abort signal 继续透传；
- hard terminal + public `continueSession:true` 仍终止，公共 hook 最多通知一次且不能注入续跑消息；
- 同一 Engine.run 的首次 loop/headless drain/`extend()` 断言 tracker object identity 相同、额度变化互相可见；bare resume/background wake 的新 Engine.run identity 不同；
- stop-block、max-turn、judge/Goal budget、explicit、waiting、cancel 等 subtype 均在各自 TurnLoop 分支产生；Engine 末尾不得从 `completed` 猜 subtype。

### 3.4 `complete_goal` 三态能力与接受规则

#### 契约与依据

默认 preset 列有 `complete_goal`（`packages/core/src/preset/index.ts:119`—`packages/core/src/preset/index.ts:127`），但 `disabledBuiltinTools` 可移除它（`packages/core/src/preset/index.ts:325`—`packages/core/src/preset/index.ts:346`），plan mode allowlist 不含它（`packages/core/src/tool-system/plan-mode-allowlist.ts:40`—`packages/core/src/tool-system/plan-mode-allowlist.ts:65`、`packages/core/src/engine/engine.ts:1859`—`packages/core/src/engine/engine.ts:1866`）。默认 permission 也可能 ask，headless read-only backend 会拒绝。仅检查最终 `toolDefs` 因而不等于可无批准执行。

Phase -1 增加内部 executor capability seam（例如 `hasExecutableTool(name)` + permission classifier），把本次外层 run 的完成能力快照定义为：

- `unavailable`：definition 不可见、无 executor、plan/disabled/host/backend 明确 deny；
- `callable_with_approval`：definition/executor 存在，但静态 classifier 为 ask 或 host 不能保证无交互批准；
- `callable_without_approval`：definition/executor 存在，当前 mode/host 静态允许无批准调用。

只有 `callable_without_approval` 进入 explicit-first；前两态直接 contextual hybrid，不累计 explicit nudge。permission/pre-tool hook 等动态 race 不能完全预演，始终由实际 tool result 非 error、未 dropped/未拒绝作最终 guard。

严格 sole-call 接受规则：

- assistant 本批原始 `response.toolCalls` 恰好一个且名字为 `complete_goal`，不是执行后剩一个；
- 调用实际执行且结果非 error；任何同批其他 action、error、dropped 或未执行 action 都拒绝；
- mixed batch 中普通 action 可按既有规则执行，`complete_goal` 返回结构化 rejection，不清 goal、不短路；
- 拒绝后下一轮给一次性审计提示，模型可 sole-call 重试；
- 接受的 sole-call 仍直接完成且 judge=0；schema 保持可选 summary，不增加自报 `evidence[]`；
- finalize 前必须先消费 queued steer，并复核 goal generation 与 capability/result guard。

#### 实施前必须敲定（addendum）：能力快照、mixed 上限与 finalize 顺序

**正式结论：** `completionCapability` 使用上述三态；必须由 executor capability seam 与本次最终 tool visibility/permission classifier 共同生成。它是**每个外层 `Engine.run()` 的快照**，不得跨 resume/wakeup 持久复用；plan/permission/host mode 在同一 run 内发生可观察变化时立即失效并重算，telemetry/canary cell 使用重算后的值。无论静态值为何，都以实际 result guard 为最终安全判据。

增加 per-run `completionRejectionCount`，mixed/error/dropped rejection 独立上限固定为 **2 次**，不借用只在自然停止分支增长的 `maxStopBlocks`。达到 2 次后隐藏 explicit retry nudge，本 run 回落 contextual hybrid；仍受 maxTurns/token/time 硬边界约束。新的 queued steer/generation 变化永远优先于清 goal：即使 sole-call 已成功，只要 finalize-backfill 非空，就先注入 steer、延后完成，不发 met、不清 goal。

**Contract tests：**

- 普通、plan、disabled、默认 ask、显式 allow、headless read-only 分别映射到准确三态；只有 `callable_without_approval` 注入 explicit-first 指令；
- registry definition 存在但 executor 缺失为 unavailable；executor seam 与 prompt/capability telemetry 一致；
- 每次外层 run 重算 capability；resume/wakeup 不沿用旧值；同 run mode 改变后旧快照失效；
- 动态 pre-tool/permission deny 即使静态可调用也因实际 error result 被拒，goal 不清；
- sole success、complete+成功 action、complete+失败 action、complete+cap dropped action、complete 自身 error、下一轮 sole retry分别断言 goal/judge/transcript；
- mixed rejection 第 1、2 次有审计提示，第 3 次不再提示并走 contextual judge，不出现无限 mixed loop；
- accepted sole-call + queued steer/replace/clear：steer/generation 优先，goal 不清、不发 met；无 steer 才只清一次且 judge=0；
- capability 前两态 explicit nudge=0；confirmed/unconfirmed `cancel_goal` 语义不变。

## 4. Phase 0：两级可证伪 baseline 与评测契约

Phase 0 不改变线上行为。fixture schema 和启动 seed 可与 Phase -1 三个 PR 并行；启动集足以开始 Phase 1 实现，发布集必须在默认启用 V1 或进入 Phase 2 canary 前冻结。

### 4.1 fixture schema 与标注

每条 fixture 必须包含：

- `id/language/provider/model/preset/toolCallingStrength/contextState/runPath`；
- objective 与逐条 acceptance criteria；
- 顺序化证据事件：真实 user/steering、assistant、tool name/status、失败/通过、绿灯后的修改、summary、background lifecycle、final/空 final；
- gold `met | not_met | waiting`、高后果等级和人工理由；
- evaluator prompt version、DTO policy version、route model version；
- annotator verdict、分歧、复核人与 adjudication；单人数据明确 `single-annotator`。

线上样本只能进入脱敏人工审计池或作为 stop-block/成本代理信号；绝不能把“最终停止”当 gold 标签。

### 4.2 启动集：36–48 条

高后果候选 `met` 12–16 条。必须覆盖：全部必含反例、`met/not_met/waiting` 三态、空 final、rolling summary/microcompact、bare/process resume、background wake、sole/mixed、sensitive/image/超大结果、MCP/web prompt injection、finite background/常驻 service、waiting 无后台、cap exhausted，以及 `config.goal` 与 RunManager active-goal resume 正反例。

所有候选 `met` 和所有分歧条目必须由第二人独立复核；其余条目可单标。单人项目应如实标 `single-annotator`，不得用延迟后的自审冒充双盲；应为全部高后果候选 met 寻求外部第二审。启动集冻结 schema/seed 后即可开始 Phase 1 projector/route 实现与离线回归。

### 4.3 发布集：120 条

发布集扩到至少 120 条，高后果候选 met 至少 30 条；补齐中文、英文、混合语言、至少两个 provider、强/弱 tool-calling、未压缩/rolling/microcompact、fresh/resume/restart/wake/automation/waiting、coding 和至少两类非 coding 目标。关键二元维度两侧原则上不少于 10 条；不做不可承受的全笛卡尔积，但 manifest 必须列空 cell 与原因。

团队具备两名标注者时，高后果 met 双人盲审，分歧保留原始记录并由第三人或明确 adjudicator 裁决；单人项目继续如实标注，不虚构双盲。发布集在默认启用 V1 或进入 Phase 2 canary 前冻结，之后只能版本化追加，不能为了结果调换旧 gold。

### 4.4 指标与 terminal subtype

分别计算：加权 `premature_met_rate`（高后果权重 10、普通 1）、`false_not_met_rate`、waiting false positive/negative、JSON/协议失败率、每次/每 run judge token/request/fallback、p50/p95 latency；Phase 2 另算 capability 可用时遗忘率、sole/mixed rejection 率和错误 completion 声明率。

cap exhausted 当前仍可返回 `reason:"completed"`（`packages/core/src/engine/turn-loop.ts:997`—`packages/core/src/engine/turn-loop.ts:1032`；测试见 `packages/core/src/engine/turn-loop-goal-lifecycle.test.ts:184`—`packages/core/src/engine/turn-loop-goal-lifecycle.test.ts:193`）。公共 `TerminalReason` 保持兼容（`packages/core/src/types.ts:412`—`packages/core/src/types.ts:422`），内部 subtype 至少为：

```text
explicit_complete | judge_met | waiting_parked | public_hook_blocked_after_met |
stale_goal_judgment | stop_blocks_exhausted | max_turns_exhausted |
judge_budget_exhausted | goal_budget_exhausted | user_cancelled |
aborted | model_error | prompt_too_long
```

每个 subtype 由 `TurnLoop` 对应终止/继续分支唯一生产，内部 telemetry 直接消费；不得由 Engine 根据 `reason`、是否停止或 session status 反推。评测只认 subtype + gold。

### 4.5 预注册门槛

在看 V1 结果前锁定：高后果 fixture 不允许新增 premature met；加权 premature-met 比 V0 降低至少 30%（若 V0 为 0 则保持 0）；false-not-met 不恶化超过 2 个百分点；waiting 两类错误均不恶化且“无后台却 waiting”为 0；JSON 失败率不高于 1%；judge p95 相对 V0 增幅不超过 30% 且绝对增量不超过 2 秒；所有请求满足 Phase -1 window/ledger cap。

启动集用于 Phase 1 开工与快速回归；是否默认启用 V1 必须以冻结发布集和 canary SLO 为准。失败只能修正后重跑同一版本数据，不能把线上“停止率”当正确率替代。

## 5. Phase 1：最小 A，保持 contextual hybrid（M/L）

Phase 1 拆成可独立 review/回滚的 A1 安全投影和 A2 judge 接入。Phase -1 contract tests 与 Phase 0 启动集全绿后可开工；默认启用仍需 Phase 0 发布集。

### 5.1 A1：安全投影基础设施

#### 证据来源与 provenance

工作 `Message` 只有 role/content（`packages/core/src/types.ts:29`—`packages/core/src/types.ts:34`）；transcript event 保留 `injected/steerId/clientMessageId`（`packages/core/src/session/transcript.ts:42`—`packages/core/src/session/transcript.ts:74`），而 `toMessages()` 会丢掉它们（`packages/core/src/session/transcript.ts:149`—`packages/core/src/session/transcript.ts:164`）。V1 选择 transcript metadata 作为用户条件 provenance：

- 从 `Transcript.getEvents("message")` 选 role=user 且 `injected!==true`；初始真实输入无 injected，step-gap steering 有 `steerId`（`packages/core/src/engine/turn-loop.ts:1450`—`packages/core/src/engine/turn-loop.ts:1470`）；
- `injected:true` 的 background wake，以及未写入 transcript 的 hook reminder、dynamic context、goal nudge，不进入真实用户 quota；
- 首条 objective 来源和最近 steering 分别保留，按时序去重；新增 synthetic producer 必须标 injected；
- transcript 只提供真实用户约束，不回读 raw tool result，避免绕过 ContextManager。

#### 复用 ContextManager

tool/summary evidence 只消费 on_stop 时已治理的 typed `ContentBlock[]`。大结果已经落盘/截断并受 result budget 约束（`packages/core/src/context/manager.ts:364`—`packages/core/src/context/manager.ts:383`、`packages/core/src/context/manager.ts:489`—`packages/core/src/context/manager.ts:513`），旧结果已经 dedupe/microcompact（`packages/core/src/context/manager.ts:515`—`packages/core/src/context/manager.ts:550`），rolling summary 由 anchored marker 读取（`packages/core/src/context/compaction.ts:851`—`packages/core/src/context/compaction.ts:874`），切片复用 API tool-pair 保护（`packages/core/src/context/compaction.ts:253`—`packages/core/src/context/compaction.ts:307`），图片沿用 placeholder（`packages/core/src/context/compaction.ts:90`—`packages/core/src/context/compaction.ts:125`）。

projector 直接遍历内部 block，不 stringify provider wire、不回读完整 tool-result 文件、不重做图片算法、不调用第二次 LLM summary。ContextManager rolling summary 是唯一 summary 来源。

#### evidence 安全 contract

`GoalJudgeEvidenceV1` 是 private、versioned、deep-frozen DTO，最小字段为：真实用户条件片段、rolling summary、按 API round 配对的 `{toolName,status,errorClass?,preview?,digest}`、最终文本状态（含 `empty_response/stale_final`）和 background 状态；首版不含 raw tool args。

现有保护依赖 `ToolResult.sensitive` 和 replacement，不是通用扫描器（`packages/core/src/types.ts:51`—`packages/core/src/types.ts:70`、`packages/core/src/tool-system/tool-result-redaction.ts:3`—`packages/core/src/tool-system/tool-result-redaction.ts:50`）。因此 sensitive 只给 replacement 后的 `sensitive/status/digest`；默认只传 tool name、error/执行/丢弃状态和 keyed digest；preview 只对小型、内部、字段级 allowlist 且已有统一 redaction contract 的结构化 producer 开放。shell stdout、源码、URL/query、Authorization、私钥、MCP、browser/web 和任意第三方 text 默认无 preview。

整段 evidence 渲染在 `<untrusted_evidence>` quoted boundary 内，固定中英双语/语言中立 system rule 声明其中命令、角色或“忽略指令”仅为数据，不能覆盖 judge policy。quoted boundary 只是 prompt-injection 缓解，不是净化证明；主要安全保证仍是默认不传 raw preview。secret corpus 与 adversarial injection fixtures 是 release blocker。

### 5.2 A2：judge 接入、route/ledger 复用与 cache 取舍

在最终 assistant push、公共 `on_stop` 前的 seam（`packages/core/src/engine/turn-loop.ts:928`—`packages/core/src/engine/turn-loop.ts:955`）构造 private V1 并交给 Phase -1 callback。三态 prompt 迁入/复用私有 judge service，保留 clock/background/JSON contract，改为固定的中英双语/语言中立版本；当前全中文 prompt 在 `packages/core/src/hooks/goal-stop-hook.ts:103`—`packages/core/src/hooks/goal-stop-hook.ts:122`。

**V1 不复用 verdict cache。** 当前闭包单 entry key 是 goal + final + background + minute（`packages/core/src/hooks/goal-stop-hook.ts:175`—`packages/core/src/hooks/goal-stop-hook.ts:181`、`packages/core/src/hooks/goal-stop-hook.ts:234`—`packages/core/src/hooks/goal-stop-hook.ts:246`），而每次 stop 都追加 final 与 synthetic nudge（`packages/core/src/engine/turn-loop.ts:940`、`packages/core/src/engine/turn-loop.ts:976`—`packages/core/src/engine/turn-loop.ts:988`），上下文化后大概率 miss。V1 只生成 per-run HMAC evidenceDigest 用于日志/fixture 对照；V0 rollback adapter 可暂保旧 cache。

Phase 1 必测：tool pair、落盘 marker、microcompact、summary、image placeholder；真实 steering quota 与 synthetic 排除；restart provenance；sensitive/unknown/shell/MCP/web 默认 hash/status；allowlist preview；空 final stale/empty；route/window/ledger/hard terminal 全复用 Phase -1 tests；相同 V1 可重复请求且受 cap；证据/steering 改变使 digest 改变但日志无原文；accepted `complete_goal` 不构建 DTO、不调 judge。

行为开关 `goalJudgeEvidenceV1=false` 时私有通道只构建 V0；跨域 opt-in 默认 false。回滚不得把 DTO 放回公共 ctx，也不得恢复隐式跨域 V1。启用门槛是 A1/A2 安全容量 tests、路径矩阵 tests、冻结发布集和 canary SLO 全绿；否则关闭 V1，保留 V0 private judge。

## 6. 运行路径矩阵（目标语义与现有缺口）

共同规则：只有 top-level 外层 Engine run 存在 normalized active goal 且自然停止时才构建 V1；accepted `complete_goal`、无 goal、sub-agent 均不构建。route 走 §3.2；ledger 以一次外层 `Engine.run()` 为边界，同一 run 内 headless drain 不重置，新的 send/resume/wakeup 重置。

| 路径 | DTO / judge 目标语义 | wakeup 与 ledger | 依据、现状与必须回归语义 |
|---|---|---|---|
| top-level `options.goal` | 生效且自然停止时构建 | 新外层 run 新 ledger；同 run drain 共享 | `options.goal` 写 `activeGoal`：`packages/core/src/engine/engine.ts:2049`—`packages/core/src/engine/engine.ts:2061`；goal 解析在 `packages/core/src/engine/engine.ts:2040`—`packages/core/src/engine/engine.ts:2068` |
| top-level `config.goal` | **目标语义：应与 options.goal 相同；现有 bug 待 Phase -1a 修复** | 同上 | 当前虽进 `normalizedGoal`（`packages/core/src/engine/engine.ts:2068`），但 `packages/core/src/hooks/goal-stop-hook.ts:198`—`packages/core/src/hooks/goal-stop-hook.ts:205` 只读 `state.activeGoal`，读不到就放行；只有 options.goal 写 activeGoal。必须专项正反 fixture |
| bare resume（同进程） | persisted activeGoal 继承则构建，否则不构建 | 新 Engine.run 重置；`setAtMs` 保留 | resume messages：`packages/core/src/engine/engine.ts:1444`—`packages/core/src/engine/engine.ts:1497`；stored goal 优先级：`packages/core/src/engine/engine.ts:2040`—`packages/core/src/engine/engine.ts:2068` |
| process restart resume | state/transcript 恢复 active goal 后同 bare resume；provenance 另读 events | 新进程 run 新 ledger；objective/setAtMs 保留 | `toMessages()` 丢 metadata，projector 另读 events：`packages/core/src/session/transcript.ts:149`—`packages/core/src/session/transcript.ts:211` |
| background wake | 父 main session persisted goal 存在则构建；wake `injected:true` 不占 steering quota | 每个 wake 新外层 run；完成入队可继续 wake，常驻服务因不完成自然不 wake | `packages/core/src/protocol/server.ts:221`—`packages/core/src/protocol/server.ts:253`、`packages/core/src/protocol/server.ts:278`—`packages/core/src/protocol/server.ts:334` |
| desktop bound cron (`continueInSession`) | 注入既有 session；该 session 有 activeGoal 才构建 | cron fire 新 run；保留 interactive wake | cron session id：`packages/core/src/tool-system/builtin/cron.ts:115`—`packages/core/src/tool-system/builtin/cron.ts:128`；desktop 转发：`packages/desktop/src/main/index.ts:1671`—`packages/desktop/src/main/index.ts:1719` |
| standalone TUI cron | fresh headless Engine 未传 goal/sessionId，不构建 | 无 Goal ledger；仅本 run 自身 drain | `packages/tui/src/cli/commands/repl.ts:238`—`packages/tui/src/cli/commands/repl.ts:264` |
| RunManager automation | 普通 `run.objective` 不自动成为 Goal；**显式复用已有 activeGoal session 时按 resume 构建，此项是代码路径推测，必须正反 fixture 证实** | 每 execution attempt 新 run；host maxTurns 默认 30 | EngineRunner 只传 objective/sessionId：`packages/core/src/run/EngineRunner.ts:182`—`packages/core/src/run/EngineRunner.ts:203`、`packages/core/src/run/EngineRunner.ts:244`—`packages/core/src/run/EngineRunner.ts:248`；cron submit：`packages/core/src/automation/runner.ts:121`—`packages/core/src/automation/runner.ts:147` |
| sync/background sub-agent | 不继承/注册 main goal，不构建；父 wake 后由父判断 | child 无 Goal ledger；父 wake 是新 run | child `isSubAgent:true`：`packages/core/src/engine/engine.ts:1217`—`packages/core/src/engine/engine.ts:1247`、`packages/core/src/engine/engine.ts:1282`—`packages/core/src/engine/engine.ts:1295`；Goal 排除：`packages/core/src/engine/engine.ts:2050`、`packages/core/src/engine/engine.ts:2070` |

每行至少一个 integration fixture。resume/background 条件分支、`config.goal` 和 RunManager active-goal resume 必须各有正反例，断言 DTO 次数、route、wakeup、ledger identity/reset 和 goal clear：

- `config.goal` 正例：无 `options.goal`、有 `config.goal` 时 active goal 被规范化/持久化并在自然 stop 调 judge；反例：config 无 goal 时不构建、不调用 judge。
- RunManager 正例：显式复用含 activeGoal 的 session 时继承并判断；反例：普通 objective 或复用无 activeGoal 的 session 不生成 Goal/DTO。

## 7. Phase 2：explicit-first hybrid（C，不直接 explicit）

### 7.1 行为

1. 每次外层 run 在最终 tool visibility/executor classifier 后得到三态 `completionCapability`，再生成 active-goal dynamic prompt；当前 prompt 位置为 `packages/core/src/prompt/composer.ts:179`—`packages/core/src/prompt/composer.ts:183`。只对 `callable_without_approval` 要求逐条 requirement/evidence/failure/background audit 后 sole-call `complete_goal`。
2. accepted sole-call 是第一优先快路径，清 goal、judge=0；接受规则完全复用 §3.4。
3. 能力为 without-approval、无 running background 且自然 stop：第 1、2 次只注入 deterministic completion-audit nudge，不调用 judge；第 3 次回落 Phase 1 contextual judge，不一路 nudge 到 maxStopBlocks。
4. 有 running background 时立即跑三态 contextual judge，以便 finite work 进入 waiting；capability 为 unavailable/with-approval 时也直接 contextual judge，explicit nudge=0。
5. contextual verdict、generation 失效、公共 hook 合并、ledger/hard terminal 与 fallback 完全沿用 Phase -1/1。
6. `cancel_goal` 不变；未完成、阻塞、预算临近或 judge unavailable 不自动 cancel。

### 7.2 canary allowlist 与门槛

canary 只对主动登记的 **eligible-cell allowlist** 运行，不自动遍历 `provider × model × preset × completionCapability` 的笛卡尔积。未登记组合永久使用 contextual hybrid，不视为发布未完成。capability 按每个外层 run 重算，mode 变化使 cell 标签更新。

每个 eligible cell 至少 100 个 canary stop，固定 prompt/tool schema 版本；人工复核全部错误 complete 和至少 20% 随机样本。门槛：高后果错误 complete=0；普通错误 complete <0.5%；两次 nudge 后仍遗忘并回落 judge <5%；mixed rejection 能 sole retry 或安全回落；waiting 不劣于 Phase 1；成本/p95 不越 Phase -1 cap/SLO。失败只回滚该 cell，不影响其他 cell。

### 7.3 测试与回滚

scripted main responses 覆盖首次 sole complete、忘记一次/两次、第三次 fallback、三态 capability、plan/disabled/approval/headless、running finite/service、mixed rejection 后 retry/超限回落、queued steer finalize。分别统计 main/judge calls；accepted complete 必须 judge=0，前两 capability explicit nudge=0。confirmed/unconfirmed cancel、goal clear、resume inherited `setAtMs`、waiting 不 busy-loop 全回归。

行为开关只保留 `legacyV0 | contextualHybridV1 | explicitFirstHybrid`；紧急回滚到 contextual 或 V0。未达标 cell 永久保留 contextual hybrid 是合格结果，不设全局 explicit 默认日期。

## 8. Phase 3：仅视数据立项

Phase 3 不属于首版实现。只有冻结发布集和线上人工审计同时证明 contextual judge 在高价值场景仍有不可接受的 premature met，且 Phase 2 工具遵从稳定，才另立 RFC 评估 primary 强制 override 或更强 verifier。

新 RFC 必须重新评审信任域、完整窗口、Goal/judge budget、延迟、fallback 与冲突语义；本方案不预实现双模型串行 adjudication，不以模型自报 `confidence` 触发升级，也不先引入 `evidenceRefs[]/uncertainReason`。

## 9. 阶段交付、验证命令与总验收

| 阶段 | 工作量与主要交付 | 可回滚点 | 进入下一阶段的硬门槛 |
|---|---|---|---|
| -1a | private merge、generation、公共 hook/UI/subtype | V0 public adapter（仅迁移期） | §3.1 contract tests 全绿 |
| -1b | route/trust/provenance、effective ceiling、共享 ledger/hard terminal | V0 private route；V1 关闭 | §3.2/§3.3 contract tests 全绿 |
| -1c | capability seam、sole/mixed/result/finalize guard | contextual hybrid | §3.4 contract tests 全绿 |
| Phase -1 总体 | **L**；三个 PR | 不允许 DTO 回公共 ctx | 原 B1/B2/B3 的剩余点全部关闭 |
| 0 启动集 | 36–48 seed，可与 -1 并行 | 无线上行为 | schema/必含覆盖/复核状态明确，可开工 Phase 1 |
| 0 发布集 | 120 条冻结集 | 无线上行为 | 默认 V1/Phase 2 canary 前冻结且 baseline 可复现 |
| 1 | A1 projector + A2 contextual judge，M/L | `goalJudgeEvidenceV1=false` 回 V0 | 零未授权泄漏、容量零越界、发布集/SLO、路径矩阵全绿 |
| 2 | explicit-first hybrid，eligible cell canary | 单 cell 回 contextual；全局回 V1/V0 | 各登记 cell 独立达到正确率/遗忘/waiting/成本门槛 |
| 3 | 数据触发的新 RFC，可能不做 | 不适用 | 先证明 Phase 1/2 单层不足 |

实现阶段聚焦测试：

```bash
bun test packages/core/src/hooks/goal-stop-hook.test.ts \
  packages/core/src/engine/turn-loop-goal-lifecycle.test.ts \
  packages/core/src/engine/goal.test.ts
```

然后运行：

```bash
bun test packages/core/src
bun test
```

`bun run typecheck` 可记录，但仓库有既有错误，不能把无关旧错当成本重构失败；新增相关错误仍须修复。Phase -1/1 还必须有 projector、route policy、hook composition、leak corpus、prompt injection、capability 和路径矩阵专测，不能只依赖现有三个文件。

## 10. 后置项与 Non-goals

首版明确后置：

- 双模型串行 adjudication 和完整方案 D；
- 模型自报 `confidence`；
- `evidenceRefs[]`、`uncertainReason`；
- `complete_goal.evidence[]` 等自报 evidence schema；
- `goalJudgeModel=aux|primary|auto`、judge reasoning 等多维设置矩阵；
- 递归扫描任意内容的“万能脱敏器”。

其他 Non-goals：

- 不拆分大型 `engine.ts`，不顺带解决 core/tool-system/engine import cycle；
- 不重写全部 HookRegistry/插件协议；仅把 built-in Goal judge 移到 private seam；
- 不取消 persistent goal、resume、background wake、Cron/Run/Sub-Agent 编排；
- 不让 judge 执行工具或产生外部副作用；验证仍由主 agent 完成；
- 不把 coding checks 写死为通用 Goal 标准；
- 不改变公共 `TerminalReason`；内部 subtype 仅供 telemetry/eval；
- 不把 cancel 与 complete/blocked 混为一谈；
- 不承诺 LLM judge 形式化正确，只要求消除已知信息饥饿并使风险可观测、可限额、可回滚；
- 本设计文档任务不修改任何 `.ts` 生产代码或测试。

## 11. 风险与回滚闸门

| 闸门 | 强制规则 | 触发回滚 |
|---|---|---|
| 行为 | `legacyV0 → contextualHybridV1 → explicitFirstHybrid` 分阶段；eligible cell 独立回退 | 正确率、遗忘、waiting 或兼容门槛失败 |
| private/公共合并 | DTO 永不进公共 ctx；generation/steer 可使迟到 verdict 失效；met+public continue 不发 met | 任一旧 verdict 生效、UI/持久 goal 分裂 |
| 数据版本 | DTO、policy/prompt、route/window source 进 telemetry；V1 无 verdict cache | 版本混用、解析失败率 >1% |
| 隐私/信任域 | V1 跨域默认拒绝；V0 仅 grandfathered schema；日志只记 keyed digest/尺寸 | 任一原文泄漏或未授权 V1 跨域立即关 V1 |
| 容量/ledger | effective ceiling 取三者 min；最多一次 shrink；所有尝试共享 request/token/time cap | 本地估算越界、ledger 漏记/低估、p95 越 SLO |
| hard terminal | ledger/time/Goal cap exhausted 直接终止；公共 continue 不得重开 | exhausted 后仍调用主模型或被 hook 续跑 |
| 完成语义 | 三态 capability；只有 without-approval explicit；sole-call + result + generation/steer guard | mixed/error/dropped/迟到声明仍清 goal |
| tracker | 外层 Engine.run 唯一对象；内部 drain/extend 共享 | re-entry 或 extend 更换对象、重置绕过预算 |
| terminal subtype | TurnLoop 各分支唯一生产，Engine 不反推 | exhausted/complete/waiting/cancel 再次混淆 |
| 既有边界 | 不移除 maxTurns/maxStopBlocks/token/time，按 host 有效值测试 | 任一路径 cap 失效 |
| waiting | lifecycle 未结构化前保留三态和 `runningWork.length>0` guard | 无 wake source却 parked，或 finite work busy-loop |
| cancel | 仅明确用户意图 + confirmed cancel 清 goal | blocked/未完成被自动 cancel |

执行顺序不是“先换更强模型”，而是：先完成 Phase -1 四类契约与两级 Phase 0 基线，再上线受控 evidence，最后按 eligible cell 验证显式完成。这样既保留 aux judge 的成本弹性和 `complete_goal` 的可靠快路径，也把数据边界、容量、并发时序、预算和回滚变成可以逐条验收的工程契约。
