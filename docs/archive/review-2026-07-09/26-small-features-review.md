# Small Features Review（8 条 finding 实现审查）

> 审查对象：F-03/F-02/F-01/F-06/F-04/N-07/N-02/N-09 的未提交工作树改动（基线 HEAD `1205ec7e`）。
> 审查方式：codex 独立只读会话（read-only 沙箱），本文件由主编排 agent 代为落盘。
> 实现记录见 `25-small-features-impl-notes.md`，原始修复设计见 `04`/`10`/`13`/`14`。

## 总体结论：APPROVE-with-nits

Blocker 0 · Major 0 · Minor 1 · Nit 1。

## Findings

### Minor

1. `packages/desktop/src/renderer/automation/mergeTranscripts.ts:69`
   - 问题：`mergeTranscripts()` 在 `disk.messages.length === 0` 或 `live.messages.length === 0` 时直接返回一侧 state，绕过了下面 `snapshotSeq: Math.max(disk.snapshotSeq, live.snapshotSeq)` 的合并逻辑。`App.tsx:880` 后续用 `base.snapshotSeq` 作为 `subscribeSession()` cursor；若 live 投影虽无 message 但已消费过带 seq 的 no-op/临时事件，可能从过低 cursor replay，带来重复 apply 风险。
   - 建议：early return 也保留 cursor，例如返回 `{ ...disk, snapshotSeq: Math.max(disk.snapshotSeq, live.snapshotSeq) }`，并补一条 mergeTranscripts snapshotSeq 测试。

### Nit

1. `packages/core/src/preset/index.ts:100`
   - 问题：注释仍写 “permission-gated (the tools declare permissionDefault: "ask")”，与本轮 N-07 定稿的「permissionDefault 只是 UI/metadata hint，不参与 classifier」口径不一致。
   - 建议：改成 “user-scope Save/Delete have no explicit allow rule, so default-mode classifier fallback asks”。

## 逐条判断

- **F-03**：实现忠实。segment-aware key 覆盖 text/tool args，boundary 后不回合并；`streamCoalescer.test.ts` 的「burst of boundary events flushes as ONE batch」仍为 1 batch；segment 单调递增只进短生命周期 key，JS number 下无溢出风险。
- **F-02**：实现忠实。`stream_request_start` 改看 `event.agentId`；顶层 dirty `activeAgents` 仍开主 slot；clean orphan 清非 backgrounded active；backgrounded agent 保留；`background_agent_completed` 清 active；子代理文本/工具仍只进 card。
- **F-01**：实现忠实。core 用 `assistant_${turnId}` 贯穿 start/tombstone/终态；desktop tombstone 删 active slot 时清 `streamingAssistantId`；带 `agentId` 的子代理终态被主 reducer 忽略；turnId 带时间+随机片段避免 resume/子 Engine `turn_1` 碰撞。
- **F-06**：实现忠实。`pre_tool_use: ask` 不再短路 classifier；合并顺序 deny > ask > allow；hook 只能收紧；merged ask 只走一次 `handleAsk()`；未见 deny 被 ask 批准绕过的路径。
- **F-04**：基本忠实。main 新增 `agent:streamEvent` 带可选 seq，legacy `agent:msg` fallback 保留；renderer batch 用 maxSeq 推进并持久化 `snapshotSeq`；hydrate 对非空 projection 也按 cursor replay tail。见上方 Minor（cursor 合并边角）。
- **N-07**：执行语义正确，`permissionDefault` 未接入 classifier；新增测试覆盖 allow 不自动放行、deny 不覆盖 explicit allow。仅一处 preset 注释残留（见 Nit）。
- **N-02**：只改注释，现描述与实际「完整 LLMResponse 后 enqueue，队列负责 post-response batch 并发/顺序」一致。
- **N-09**：`resultsToMessages()` 已删；`rg` 无 source caller；架构文档改指向 TurnLoop `toolResultToBlock(...)`。

## 验证命令

- `bun test packages/desktop/src/renderer/streamCoalescer.test.ts`：10 pass。
- `bun test packages/core/src/engine/turn-loop-streaming-fallback.test.ts packages/desktop/src/renderer/types.test.ts`：70 pass。
- `bun test packages/desktop/src/renderer/transcriptsReducer.test.ts packages/desktop/src/renderer/transcripts.test.ts`：14 pass。
- `bun test packages/desktop/src/main/parseStreamLine.test.ts`：10 pass。
- `bun test tests/hooks-on-permission-check.test.ts tests/hooks-pre-tool-deny.test.ts`：10 pass。
- `bun test packages/core/src/engine/streaming-tool-queue.test.ts`：2 pass。
- `bun test packages/core/src/tool-system/permission-default-ui-hint.test.ts`：2 pass。
- `bun test packages/core/src/tool-system/executor-permission-hooks.test.ts`：read-only 沙箱下 `mkdtemp` EPERM，未进入有效断言；不判为代码失败（实现会话在可写环境已跑过 `bun test` 全绿 5160 pass）。
- `bun run typecheck`：通过。
- `rg` guard：core 无 `@cjhyy/code-shell-tui` import；renderer 无 codeshell runtime import；`resultsToMessages` 无 source caller。
