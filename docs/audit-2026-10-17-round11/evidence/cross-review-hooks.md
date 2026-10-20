# Independent read-only cross-review: Hooks round11

Reviewer: host_metadata_round11. Reviewed existing artifacts and source only; no tests, product execution, Git writes or other reviewers' files changed.

**Conclusion: accept 0 confirmed findings and 1 observed candidate (HOOK-R11-C1). No blocking correction found.**

## Evidence and claim limits

- Candidate mechanism is directly supported by frozen `packages/core/src/hooks/registry.ts:43–45` (push/sort the existing array), `:86` (retain the array), and `:92–94` (iterate across awaited handlers). The focused fixture suspends the first handler with owned promises, registers a new higher-priority handler, and characterizes the observed calls/messages as existing-high twice, existing-low once, new-high zero times. Both before-emit registration and suspended-without-mutation controls are present.
- This is a fact about the actual HookRegistry class under a synthetic registration schedule. No Engine, hook reload consumer, plugin runner, shell command or prompt injection consumer executes in this fixture. The report and candidate JSON explicitly retain the missing normal supported producer and missing mid-emit visibility/once-per-chain contract. Public export at `index.ts:262–264` proves API availability only. Keeping severity null and confirmed findings empty is appropriate; promoting this to actual Engine duplicate prompt execution would exceed evidence.
- The five other focused cases use ordinary JSON/output shape and plain data/message propagation; no decision/permission case executes. Baseline files import registry and inject directly and exercise owned callback data, unregister identity and name-prefix removal. They do not start Engine or shell/plugin runners. Explicit last-write-wins is present at `events.ts:154,169` and `registry.ts:108–114`, so priority override behavior is correctly excluded.
- The settings matcher wording discrepancy is accurately bounded: `types.ts:1191–1194` describes ignored matchers for events without tool names, while the existing source-only test at `tests/hooks-shell-runner.test.ts:175–179` expects false when no tool name exists. Conflicting wording alone does not establish a new runtime bug.

## Counts, hashes and dedup

- First focused log: 8 pass, 0 fail, 30 expect, Completed 8 tests / 0 skipped / 0 failures; first receipt exit 0 and raw log SHA-256 match.
- First unchanged baseline log: 13 pass, 0 fail, 32 expect, Completed 13 tests / 0 skipped / 0 failures; first receipt exit 0 and raw log SHA-256 match.
- Aggregate 21 pass / 62 expect / 0 skipped from two clean shards agrees with report and validation. The 3 candidate/control cases are part of the 8 focused cases, not extra confirmations.
- Independently recomputed all 22 manifest SHA-256 values from frozen Git blobs at b8b776d56e5982e59b18de0262d5c49367746625; every digest and current-equality flag matches. The manifest correctly distinguishes actual source execution, full static reads, excerpts and searches.
- Independently verified bytes and SHA-256 for all 12 entries in hooks-artifact-receipt.json, including both raw logs, fixture, report and metadata. No mismatch.
- Dedup lists 1,601 scanned MD/JSON files, 556 parsed JSON, 1,045 Markdown, 169 nested archive/_archive files, 342 broad hits and no JSON errors. Targeted inspection of the saved hit text found no previous same-root mid-emit array reorder entry. This supports the stated corpus search, not a claim of globally complete historical uniqueness.
- One static navigation exit 2 is expressly labeled as tool-response transcription, separate from Bun execution. The three nonexistent path directions remain skipped, with no recovery experiment claimed. It is correctly excluded from failed Bun shard totals.

Remaining limitation: the reviewer did not independently execute the existing fixture and did not resolve the absent normal producer contract. This review validates source/record consistency and conservative classification, not native or Engine end-to-end behavior.
