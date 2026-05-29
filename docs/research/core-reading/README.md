# `packages/core` 逐章阅读笔记

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
