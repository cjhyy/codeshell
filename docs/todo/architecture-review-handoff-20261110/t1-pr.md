Multi-session agent/run dropped operationBatchToken and sessionBrief at ChatSession.enqueueTurn → Engine.run. Forward both fields, type the server's session variable, and require an exhaustive explicit TurnOpts mapping at compile time. The single-Engine path is unchanged.

Behavior changes: native sessions now persist/use the host-authored team brief; operation batch authority now reaches the Engine, including the existing batch_incomplete behavior for plan/dontAsk/bypassPermissions runs with a token.

Evidence: the new regression in the existing task-boundary test failed with exactly the two missing fields before the fix; afterward all 6 tests passed. The test also checks an ordinary queued turn does not inherit them. No additional mismatch appeared from typing the session variable. The existing test's EngineRunOptions type import was corrected to its actual defining module.

Validation completed: bun run build; isolated guarded runner for the regression, tests/protocol/multi-session.test.ts and all three repository contracts (36 tests, 0 failures). Core-engine/core-rest CI partitions and workspace typecheck are still running; detailed results will follow. First workspace typecheck exposed stale copied Desktop workspace dependency snapshots; those local artifacts are being relinked to this checkout's freshly built packages before rerunning.

Not yet verified: full final CI; operation-batch worker/native E2E; CC independent review. This is T1 of the 2026-11-10 architecture checklist, based on fcd8406d5. Do not merge before the complete candidate is reviewed by the host-initiated CC stage.

Latest local results: workspace typecheck passed after restoring correct workspace links; lint 0 errors / 98 warnings, both guards passed. A negative probe adding an optional unforwarded TurnOpts key correctly failed compile-time checking. Full core-engine/core-rest partitions were attempted but interrupted (130) after repeated sandbox failures: baseline Engine diskutil/DiskManagement failure, and forbidden loopback listeners. Not a green shard claim. GitHub PR creation was refused by tool approval policy (never); this text remains a draft.
