# Small Features Implementation Notes

Date: 2026-07-09

Scope: TODO.md "small features" architecture review findings, implemented serially.

## F-03 Coalescer Hard Boundaries

Implemented segment-aware coalescing in
`packages/desktop/src/renderer/streamCoalescer.ts`.

- Added a monotonic segment counter.
- Hard boundary events advance the segment after being queued:
  `stream_request_start`, `assistant_message`, `turn_complete`, `tool_use_start`,
  `tool_result`, agent lifecycle events, and `tombstone`.
- `text_delta` and `tool_use_args_delta` merge keys now include the segment, so text
  and tool argument deltas after a boundary cannot merge into the prior segment.
- Preserved the 50 ms dispatch-window behavior: multiple boundary events in one
  window still flush as one batch.

Tests:

- Updated `packages/desktop/src/renderer/streamCoalescer.test.ts`.
- Added coverage for text after `turn_complete`, text after `tool_use_start`, and
  tool args after `tool_result`.

## F-02 stream_request_start Ownership

Implemented agentId-based ownership in
`packages/desktop/src/renderer/types.ts`.

- `stream_request_start` now treats events with `agentId` as sub-agent traffic and
  no longer infers ownership from `activeAgents`.
- `turn_complete` orphan sealing removes stale non-backgrounded active agents.
- `background_agent_completed` removes the completed agent from `activeAgents`.
- Backgrounded agents still keep their active entry while backgrounded.

Tests:

- Updated `packages/desktop/src/renderer/types.test.ts`.
- Added regression coverage for dirty `activeAgents` not blocking a new top-level
  request, orphan cleanup, and background completion cleanup.
- Re-ran fold transcript tests to keep orphan seal behavior covered.

## F-01 Fallback Compensation Contract

Implemented a stable assistant message id shared by streaming, tombstone, and final
assistant events.

Files:

- `packages/core/src/engine/turn-loop.ts`
- `packages/core/src/types.ts`
- `packages/desktop/src/renderer/types.ts`

Core changes:

- Each top-level turn now derives `assistant_${turnId}`.
- `stream_request_start` emits `messageId`.
- Streaming fallback tombstones use the same `messageId`.
- Same-turn terminal `assistant_message` events include the same optional
  `messageId` where the turn loop can identify them.

Desktop changes:

- Streaming assistant slots prefer `event.messageId`.
- Tombstone removal clears `streamingAssistantId` when it deletes the active
  streaming slot.
- `assistant_message` with a matching id overwrites the partial streaming text with
  final content.
- `assistant_message` with `agentId` is ignored by the main assistant reducer.

Tests:

- Added `packages/core/src/engine/turn-loop-streaming-fallback.test.ts`.
- Updated `packages/desktop/src/renderer/types.test.ts`.
- Covered partial removal, final compensation append, canonical final overwrite,
  and sub-agent final-message isolation.

## F-06 Permission ask/deny Merge

Implemented deny > ask > allow across classifier, `pre_tool_use`, and
`on_permission_check`.

Files:

- `packages/core/src/tool-system/executor.ts`
- `packages/core/src/tool-system/permission.ts`

Behavior:

- `pre_tool_use: ask` no longer short-circuits classifier evaluation.
- User approval for an ask only approves the ask gate and cannot bypass classifier
  deny or rules.
- Hooks can tighten decisions, not relax them.
- Merged ask decisions produce one approval prompt with combined hook reasons.

Tests:

- Updated `packages/core/src/tool-system/executor-permission-hooks.test.ts`.
- Updated legacy root tests:
  `tests/hooks-on-permission-check.test.ts` and
  `tests/hooks-pre-tool-deny.test.ts`.
- Added explicit coverage for ask-after-deny, ask-after-allow, rejection, single
  merged prompt, and permission hook ask not relaxing deny.

## F-04 Live IPC Seq Cursor

Implemented live stream envelopes with optional snapshot sequence numbers and
snapshot tail replay from the last applied sequence.

Files:

- `packages/desktop/src/main/parseStreamLine.ts`
- `packages/desktop/src/main/agent-bridge.ts`
- `packages/desktop/src/preload/index.ts`
- `packages/desktop/src/preload/types.d.ts`
- `packages/desktop/src/renderer/App.tsx`
- `packages/desktop/src/renderer/types.ts`
- `packages/desktop/src/renderer/transcripts.ts`
- `packages/desktop/src/renderer/transcriptsReducer.ts`
- `packages/desktop/src/renderer/automation/mergeTranscripts.ts`

Behavior:

- Main process emits live stream events through `agent:streamEvent` with `seq` when
  the event also appended to the snapshot.
- Preload keeps a legacy `agent:msg` fallback for stream events without seq.
- Renderer state persists `snapshotSeq`.
- Batched live events advance `snapshotSeq` using the max live seq in that batch.
- Hydration replays snapshot tail events since `snapshotSeq`, even when an existing
  local transcript already has messages.

Tests:

- Updated `packages/desktop/src/main/parseStreamLine.test.ts`.
- Updated `packages/desktop/src/renderer/transcriptsReducer.test.ts`.
- Added `packages/desktop/src/renderer/transcripts.test.ts`.
- Re-ran snapshot replay, merge transcript, and hydrate-order tests.

## N-07 permissionDefault Semantics

Kept `RegisteredTool.permissionDefault` as a declarative UI/metadata hint only.

Files:

- `packages/core/src/types.ts`
- `packages/core/src/preset/index.ts`
- `packages/core/src/engine/engine.ts`
- `packages/core/src/tool-system/builtin/index.ts`
- `packages/desktop/src/main/agent-bridge.ts`

Reason:

- Review docs require this item to be settled before implementation.
- Wiring `permissionDefault` into classifier execution would change permission
  semantics globally.
- Current behavior is safer and backward compatible when documented clearly.

Tests:

- Added `packages/core/src/tool-system/permission-default-ui-hint.test.ts`.
- Covered `permissionDefault: "allow"` not bypassing default ask, and
  `permissionDefault: "deny"` not overriding an explicit allow rule.

## N-02 StreamingToolQueue Naming and Comments

Kept the class name for low churn and corrected the comments.

Files:

- `packages/core/src/engine/streaming-tool-queue.ts`
- `packages/core/src/engine/turn-loop.ts`

Behavior documented:

- Despite the historical class name, tools are enqueued only after
  `callModelWithFallback()` returns a complete `LLMResponse`.
- The queue coordinates post-response batch concurrency and deterministic result
  ordering. It does not execute tools during token streaming.

Tests:

- Re-ran `packages/core/src/engine/streaming-tool-queue.test.ts`.

## N-09 resultsToMessages Removal

Removed the unused helper after verifying there are no source callers.

Files:

- `packages/core/src/tool-system/executor.ts`
- `docs/architecture/02-tool-system.md`

Verification:

- `rg` found no source callers of `resultsToMessages`.
- Updated the architecture note to point at the current turn-loop
  `toolResultToBlock(...)` conversion path.

Tests:

- Re-ran turn-loop image result tests and executor permission hook tests.

## Commands Run

- `bun test packages/desktop/src/renderer/streamCoalescer.test.ts`: passed.
- `bun test packages/desktop/src/renderer/types.test.ts`: passed.
- `bun test packages/desktop/src/renderer/automation/foldTranscript.test.ts`: passed.
- `bun test packages/core/src/engine/turn-loop-streaming-fallback.test.ts`: passed.
- `bun test packages/core/src/tool-system/executor-permission-hooks.test.ts`: passed.
- `bun test packages/core/src/tool-system/executor-abort.test.ts packages/core/src/tool-system/executor-plan-bash.test.ts packages/core/src/tool-system/permission.path-rules.test.ts packages/core/src/tool-system/path-policy-string-arg.test.ts packages/core/src/tool-system/path-policy-array-arg.test.ts`: passed.
- `bun test packages/desktop/src/main/parseStreamLine.test.ts`: passed.
- `bun test packages/desktop/src/renderer/transcriptsReducer.test.ts packages/desktop/src/renderer/transcripts.test.ts packages/desktop/src/renderer/snapshotReplay.test.ts packages/desktop/src/renderer/automation/mergeTranscripts.test.ts packages/desktop/src/renderer/automation/hydrateOrder.test.ts`: passed.
- `bun test packages/core/src/tool-system/permission-default-ui-hint.test.ts`: passed.
- `bun test packages/core/src/engine/streaming-tool-queue.test.ts`: passed.
- `bun test packages/core/src/engine/turn-loop-image-result.test.ts packages/core/src/tool-system/executor-permission-hooks.test.ts`: passed.
- `bun test tests/hooks-on-permission-check.test.ts tests/hooks-pre-tool-deny.test.ts packages/core/src/tool-system/executor-permission-hooks.test.ts`: passed.
- `bun test`: passed, 5160 pass, 6 skip, 0 fail.
- `bun run typecheck`: passed.

## Review Fixes (26-small-features-review, APPROVE-with-nits)

- Minor (F-04): `mergeTranscripts()` early-return for empty disk/live now keeps
  `Math.max(disk.snapshotSeq, live.snapshotSeq)` so the subscribe cursor never
  regresses and replays already-applied events. Added a regression test
  "keeps the highest snapshotSeq even when one side has no messages"
  (`packages/desktop/src/renderer/automation/mergeTranscripts.test.ts`).
- Nit (N-07): corrected the memory-tools comment in
  `packages/core/src/preset/index.ts` — user-scope Save/Delete have no explicit
  allow rule so the default-mode classifier fallback asks; removed the stale
  "declare permissionDefault: ask" wording.
- `bun test packages/desktop/src/renderer/automation/mergeTranscripts.test.ts`: 16 pass / 0 fail.
