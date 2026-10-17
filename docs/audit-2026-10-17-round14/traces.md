# Round 14 — Desktop model-trace presentation data

Frozen baseline: `badc2262a90966f6f903977b849adf1f22b55e9f`. Result: **0 new confirmed bugs, 0 formal candidates**. Product code unchanged.

## Actual execution

Read `packages/desktop/src/renderer/activity/modelTracePresentation.ts` in full. The first [pure fixture](evidence/root-trace-data.test.ts) imports that actual module; its imports of trace API and translation types are type-only, so no Core barrel, provider, IPC, React, or localization runtime executes. A key-echo callback supplies the label function. Summary/event objects contain the ordinary id/start/parent projection fields that these helpers read; they do not demonstrate full backend record construction.

First guarded command:

```text
node scripts/run-bun-test-shard.mjs --timeout 30000 docs/audit-2026-10-17-round14/evidence/root-trace-data.test.ts
```

[Raw combined stdout/stderr](evidence/root-trace-data.first.log) and [exit receipt](evidence/root-trace-data.first.exit.json) were saved before inspection: **6 pass, 32 expectations, 0 fail/skip**, guard completed. This is one focused control shard, not an existing UI suite.

Controls check status/coverage labels, finite/optional duration/time formatting, exact trace-id groups with earliest start, immutable input ordering, incoming call replacement by id, copied-result sorting, explicit parent ancestry, missing parents, bounded indentation and cycle termination. These match the inspected source contracts. Defensive malformed/cyclic controls are not new production-bug claims.

## Static consumers and unpromoted observations

- `ModelTraceEvents.tsx:22` uses indentation for padding and `:36` uses formatted duration. `ModelTraceExecutions.tsx:52` groups requests; `ModelTracesView.tsx:178–189` merges calls and associates event ancestry. Selected `ModelTraceDetail.tsx:158–159,238` uses duration/coverage labels. These component consumers are source-only; React/DOM/UI layout was not mounted.
- `openActivitySession.ts` was read in full, but not imported/executed. Its adapter-based local/disk selection includes current-intent and repeated-cursor guards. No ordinary failed selection or archive contract was established; no fake mutation race was promoted into a bug.
- `useModelTraceSessionTitles.ts` was source-only. It merges optional metadata and guards effect lifetime. Retaining previous optional titles after a failed/missing lookup is not enough to establish a stronger current-title or deletion contract, so no speculative candidate is registered.
- Only the relevant existing `ModelTracesView.interaction.test.tsx:825–860` source excerpt was read. Its UI fixture was not executed, and its old pass results are not counted as this batch's verification.
- An arbitrary enormous request group could exceed spread-argument limits, but this batch has no normal producer/current limit evidence for that shape. Invalid/foreign ids, unknown coverage values or non-finite timestamps likewise are not manufactured as confirmed input defects.

## Dedup, skips and baseline changes

[Whole historical dedup](evidence/root-dedup.json) covers all prior docs/bugs Markdown and parsed JSON, including archives and excluding this batch: **1,088 Markdown + 680 JSON = 1,768 files, 185,197 JSON string leaves, 0 parse errors**. Exact helper hits were inventory/validation metadata; broad relation hits were unrelated design material. Bounded keyword contexts are not semantic-completeness proof.

[Navigation diagnostic](evidence/root-navigation-skip.md) preserves the first failed guessed Core model-trace-folder inventory as a labeled tool-response transcription. That backend direction remains skipped. No alternative backend/runtime validation recovers it; trace production semantics are not claimed tested. The Desktop helpers and explicit preload/type consumers were independently inventoried.

[Baseline refresh](baseline-refresh.md) records other tasks' source repairs for older Unicode-summary and generated-image-path findings before this batch froze. Root read those diffs only and did not rerun the earlier bug experiments. Those source changes are not new findings here.

No real trace request/storage, model, network business call, accounts, user data, terminal/PTY, native app, actual automation, external message, permission/security/custody experiment, shared dependency/dist rebuild or full build/typecheck/lint/suite. Selected source pins and actual/static read ranges are recorded separately.
