# Pre-beta 08 · 安全修复第三轮复审（commit ae2191aa）

> codex 独立只读复审，主编排代为落盘。审查范围严格限定 commit ae2191aa（统一 redaction 出口）。

## 结论：SHIP-with-nits

Blocker 0 · Major 0 · Minor 1 · Nit 3。**明文泄露链路在本 commit 范围内已彻底兜住。**

## 明文是否还有泄露路径：**无（本 commit 范围内）**

- 统一出口：`run()`（turn-loop.ts:549）await `runUnredacted()`，`:551` 对 result.messages 兜底 redaction；`runUnredacted()` 是 private（`:554`），`rg runUnredacted` 只命中本文件。
- Engine 调用面：只在 `engine.ts:2232`、headless drain `:2291`、standalone `query.ts:126` 调公开 `run()`，无绕过。
- Engine 缓存/resume：`engine.ts:2305-2309` 缓存的是 `run()` 返回后的 redacted history；resume 读该缓存（`:1449`）→ 拿到 redacted。
- transcript/stream/summary：分别用 `transcriptResult`/`toolResultForDisplay`/`toolResultsForDisplay`，均不含明文。
- context manager：pending sensitive 时跳过普通 manage（`:676-687`）+ max-turns summary 前跳过 sync manage（`:1299-1308`）。
- 消费语义正确：明文只进它该进的那一次模型调用，之后 `:783` 立即 redaction；未消费明文不被提前抹（fast path `:417-424`）。abort 发生在消费前 → 兜底 redaction 抹掉（牺牲 resume 后再消费，符合 B1 目标）。
- streaming fallback：pending sensitive 时禁 `callWithoutStreaming()`（`:1410-1417`），发 tombstone → model_error → 统一 redaction。

## Findings（全部不阻塞 beta）

### Minor: max-turns pending sensitive 时可能丢最终总结（不泄露）
- `:1299-1308` 跳过 manage，`:1317` 发 final summary，`:1329` 失败只 warn。若 context 已超长，final summary 更易 prompt-too-long → 用户拿不到"turn limit reached"总结（但不泄露、不崩）。
- 建议：后续做 sensitive-aware final-summary 压缩（保留 pending sensitive 最新 round、压缩更早历史），或 summary 失败时发明确非明文 fallback。

### Nit×3（测试补强）
1. 缺 Engine 级端到端断言：cached history / resume 输入不含明文（代码证据足够，测试可补）。
2. 缺 pending-sensitive streaming fallback 禁用的专门测试（断言 callWithoutStreaming 未被调 + tombstone）。
3. 敏感终态组合未覆盖 complete_goal / goal_budget_exhausted（统一出口已覆盖其 return，属覆盖缺口非代码缺陷）。

## 回归判断：无阻塞回归
- 无敏感结果时 fast path 直接返回原 messages（`:417-424`），公开 `run()` 只多一次空 map 检查 + 浅拷贝；事件顺序不变（redaction 在 runUnredacted resolved 后、Engine 后处理前）。
- 非敏感工具结果不受影响：redaction map 只在 sensitive+有 transcript projection 时写入。

## 验证
- `rg runUnredacted`：只在 turn-loop.ts 内部。`rg '.run\(|new TurnLoop'`：Engine/query/tests 都走公开 run()。
- turn-loop-sensitive-result 6 pass；turn-loop streaming-fallback/max-turns/context-limit 7 pass；typecheck exit 0。
