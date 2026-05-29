# `packages/core` 逐章阅读笔记

> **本批次成果(2026-05-29,提交 `a73f1a5`)** — 关联 `TODO-week.md` #10/#16
>
> 起因:`/goal 一章一章读 core`。逐章通读后核出 **8 个真问题**,逐个 TDD 修复(25 个回归测试,`packages/core` 146 pass/0 fail、typecheck 干净)。`ch08-fix-plans.md` 是修复总账。
>
> | 编号 | 问题 | 修复要点 |
> |---|---|---|
> | A1 | OpenAI 流式丢 `finish_reason`(硬编码 stopReason="stop")→ max_tokens 续写永不触发 | `isTruncatedStop`(认 length+max_tokens),openai 回填、turn-loop 用之 |
> | A2 | model 切换 worker 全局串台(= #10 根因) | `handleConfigure` per-session 分支补 model + `ChatSession.requestModelSwitch`(busy 挂到 run 边界) |
> | A3 | max_tokens 384000 跨模型泄漏 | `Capability.maxOutputTokens` + `clampMaxTokens` 钳制(= TODO-week #10 诊断的 Bug 2) |
> | A4 | `turnLoop.run` 抛错跳过 saveState → session 卡 "active" | 兜底 catch 返回 `model_error` |
> | A5 | `isClientError` 漏读 `LLMError.details.status` → 4xx 被重试 3× | 同时读 details.status(= TODO-week #10 诊断的 Bug 1 / abort 空烧根因) |
> | B1 | tool schema 双发(prompt 散文 + native tools 字段) | system-prompt listing 瘦身成 name+desc |
> | B2 | reactive compaction `% 2000` 永不命中 | 改跨 2000 桶判定 |
> | B3 | hook decision 合并 last-write-wins(低优先级能放松 deny) | 改取最严 deny>ask>allow |
>
> **顺带清理**:plan-mode 工具白名单 ×2 drift → 收口为共用 `PLAN_MODE_ALLOWED_TOOLS`;`forceCompact` 的 `require()` → 静态 import;删 3 套死代码(`executeToolsOverlapped` / `executeAll` / ContextManager 工具去重 `deduplicateToolCalls`+`toolCallHashes`,从未接线,实际去重靠 InvestigationGuard)。
>
> **未做(留给后续,详见 ch08 §C)**:重复实现收敛(token 估算 ×3 / orphan 修复 ×3 / 并发调度 ×3,大重构)、硬编码常量抽取、`persistActiveModel` 忽略 settingsScope(可能有意)。**陈旧测试**:`tests/protocol/in-process-client-drift.test.ts` import 了在 TodoWrite 重构(`7fa254a`)早就删掉的 `taskManager` → 加载即 SyntaxError,值得顺手修。

---

> 目标:一个章节一个章节地读 `core` 代码,理顺逻辑、记录"逻辑理顺问题"(读出来觉得别扭 / 可疑 / 需要确认的点)。
> 每章一个文件,结构统一:
>
> 1. **职责** — 这一块在系统里干什么。
> 2. **关键类型 / 入口** — 文件清单 + 核心 export。
> 3. **逻辑主线** — 按调用顺序把控制流走一遍。
> 4. **逻辑理顺问题** — 读出来的疑点 / 耦合 / 潜在 bug / 需确认项(❓标注)。
>
> 阅读顺序按控制流:Engine → Turn Loop → LLM → Tools → Context/Prompt → Protocol/Session → 支撑子系统。

## 章节进度

| # | 章节 | 覆盖目录/文件 | 状态 |
|---|---|---|---|
| 1 | [Engine 编排核心](ch01-engine.md) | `engine/engine.ts` `runtime.ts` `query.ts` `turn-state.ts` | ✅ |
| 2 | [Turn Loop(代理循环)](ch02-turn-loop.md) | `engine/turn-loop.ts` `streaming-tool-queue.ts` `token-budget.ts` `model-facade.ts` `tool-summary.ts` | ✅ |
| 3 | [LLM 层](ch03-llm.md) | `llm/client-base.ts` `client-factory.ts` `providers/*` `model-pool.ts` `capabilities/*` | ✅ |
| 4 | [Tool System](ch04-tool-system.md) | `tool-system/registry.ts` `executor.ts` `permission.ts` `mcp-manager.ts` `builtin/*` `sandbox/*` | ✅ |
| 5 | [Context & Prompt](ch05-context-prompt.md) | `context/manager.ts` `compaction.ts` `tool-result-storage.ts` `prompt/composer.ts` | ✅ |
| 6 | [Protocol & Session](ch06-protocol-session.md) | `protocol/server.ts` `client.ts` `chat-session-manager.ts` `session/transcript.ts` `session-manager.ts` | ✅ |
| 7 | [支撑子系统](ch07-subsystems.md) | `run/*` `arena/*` `plugins/*` `hooks/*` `skills/*` `capability-control/*` | ✅ |

## 跨章节关联

与已有 [`../session-isolation-state.md`](../session-isolation-state.md) 调研互为补充:那篇聚焦"多 session 共存时 model/tools/MCP 串台",本系列是全面通读。读到相关处会回链。
