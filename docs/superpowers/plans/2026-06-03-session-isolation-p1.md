# Session 隔离 P1 根治 — Implementation Plan

> 对应 TODO #3 P1。调研结论(2026-06-03):两处**都已被既有基础设施大幅缓解**
> (per-session 延迟切模型、per-run 重建 client、请求时 `clampMaxTokens`),
> 本计划只收尾剩余的"共享可变态"边角,均为低风险外科手术。研究:`docs/research/session-isolation-state.md` §6。

## 问题 1 — `activeKey` 共享可变 → 并发切模型竞态(收尾)

**现状:** 每 Engine 已用自己的 `this.config.llm`(per-session,安全);per-session 切模型经
`chat-session.requestModelSwitch()` 延迟到 run 边界。**唯一仍读共享 `ModelPool.activeKey` 的功能性路径**是
`engine.ts:1730` `resolveAuxClient`:`if (auxKey === this.modelPool.getActiveKey()) return fallback;`
——用**共享池**的 activeKey 判断"aux 模型是否就是当前活动模型"。并发下,别的 session 切了池的 activeKey,
本 session 的 aux-client 决策就读到别人的模型(低危:aux 是 best-effort,最坏=用 fallback 或多建一个 client,不影响输出正确性)。

`server.ts:729` `active: m.key === pool.getActiveKey()` 是只读列表展示,并发下顶多显示不准,非正确性 bug(可选顺修)。

**修法(Option A,最小):** 给 Engine 加 `private activeModelKey?: string`,在 Engine 确立活动模型的每处写它:
`switchModel(key)`(有 `key` 入参)、`populateModelPoolFromSettings` 里的 `this.modelPool.switch(match.key)`(604)/
`switch(defaultEntry.key)`(678)、`reloadModelPool`。然后把 1730 改成 `if (auxKey === this.activeModelKey) return fallback;`。
**不动** ModelPool 的 `activeKey`/`getActiveKey()`(legacy/global 路径与 server.ts:729 仍用)。

**blast radius:** 仅 `resolveAuxClient` 一处行为改变(从"共享池活动键"→"本 Engine 活动键"),且更正确;
新增字段不影响其他读 `this.config.llm` 的路径(那些本就 per-session)。

## 问题 2 — maxTokens 跨模型残留(收尾)

**现状:** 384k→128k 的 400 已被 `clampMaxTokens`(请求时,`openai.ts:218`)挡住;`maxTokens===undefined` 时 OpenAI
**已省略该字段**让端点用自己默认(`openai.ts:225-233`,注释明说"rather than inventing 8192")。**唯一仍"凭空造 8192"**的是
`model-pool.ts:263` `maxTokens: entry.maxOutputTokens ?? 8192`——给没声明 maxOutputTokens 的模型塞了 8192,
可能截断长输出,也掩盖真实 per-model cap。

**修法:** `model-pool.ts:263` 改为 `maxTokens: entry.maxOutputTokens`(允许 undefined)。
- 安全性已验证:`LLMConfig.maxTokens?` 本就可选;OpenAI undefined→省略字段(端点默认);
  Anthropic `?? this.maxTokens ?? ANTHROPIC_FALLBACK_MAX_TOKENS`(169/215)有自己的兜底,undefined 安全。
- 配合既有 clamp = 纵深防御:有声明则 clamp 到真 cap,没声明则交端点,不再臆造 8192。

## 测试(TDD)

- **问题 1:** `resolveAuxClient` 用本 Engine 的 activeModelKey 判等:构造 Engine 切到模型 A,设 auxModelKey=A → 返回 fallback(不建 aux client);auxModelKey=B(≠当前) → 建 aux client。**关键回归:** 模拟"共享池被切到 B、但本 Engine 仍在 A"——断言本 Engine 的 aux 决策只看自己的 activeModelKey,不受池影响。
- **问题 2:** `toLLMConfig` 对无 maxOutputTokens 的 entry → `maxTokens === undefined`(不再 8192);有则原样带出。集成:DeepSeek(384k)→gpt-5.5(无声明)同进程切换,断言出站请求 max_tokens 省略或 ≤ gpt-5.5 cap(复用既有 openai clamp 测试风格)。

## 非目标

- 不重构 ModelPool 的全局 activeKey(legacy/global 路径与只读展示仍用,改动面大收益小)。
- 不动 sticky `_forceMaxCompletionTokens`/`_dropReasoningEffort`(per-run 重建 client + clamp 已使其低危;留观察)。
- server.ts:729 只读展示的并发不准——可选顺修,不强求。
