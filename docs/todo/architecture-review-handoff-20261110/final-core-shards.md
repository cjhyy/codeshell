# Final architecture-review core/SDK shard validation — 2026-11-10

Candidate: `b7062fba47282d823e52bb29ea81aed686b0eb3f`.
Worktree: `/private/tmp/codeshell-architecture-review-20261110`.
Commands: `TMPDIR=/private/tmp/codeshell-architecture-tmp bun run test --shard N` for N = 0, 1, 2, 31, 32, executed sequentially after the parent announced final dist readiness.
The repository runner isolates HOME/application state and allowlists inherited environment variables. No naked Bun test, source changes, branch switching, dependency installation, package-release run, provider credentials, paid evaluation, or agent CLI was used for this validation.
Each shard has a 1,200-second wall-clock limit; reaching that limit means incomplete, never passed. Complete failed shards remain failed despite matching environmental symptoms.

| Shard | Result | Exit | Pass | Fail | Skip | Tests / files | Seconds | Bun report complete | Wall limit |
| --- | --- | ---: | ---: | ---: | ---: | --- | ---: | --- | --- |
| 0 | failed | 1 | 0 | 10 | not reported | 10 / 1 | 0.52 | True | False |
| 1 | failed | 1 | 2257 | 196 | 3 | 2456 / 286 | 641.82 | True | False |
| 2 | failed | 1 | 3271 | 92 | not reported | 3363 / 415 | 975.33 | True | False |
| 31 | failed | 1 | 360 | 2 | not reported | 362 / 49 | 10.95 | True | False |
| 32 | failed | 1 | 508 | 115 | not reported | 623 / 57 | 19.24 | True | False |

## Evidence and interpretation

- Shard 0: all 10 controlled OAuth issuer fixtures fail while creating a local HTTP server with `Failed to start server. Is port 0 in use?` / `EADDRINUSE`.
- Shard 1: Engine cases chiefly report `model_error`, absent downstream events, or wait timeouts. Existing baseline controls `/private/tmp/codeshell-t3-baseline-model-error.log` and `/private/tmp/codeshell-t3-baseline-plugin-errors.log` expose `diskutil info -plist /dev/disk3s5` failing because DiskManagement / DiskArbitration are unavailable. This is corroborating environment evidence, not proof that every one of the 196 final failures is baseline-identical.
- Shard 1 also has 5 tool-system failures across 4 files: local MCP fixture bind failure; 2 skill-resource fixtures denied by `sandbox-exec: sandbox_apply: Operation not permitted`; a sandbox profile assertion expects the default macOS MDS cache path while the run uses the mandated TMPDIR under `/private/tmp`; and a native multi-root Seatbelt enforcement fixture.
- Shard 2 includes local TCP/HTTP fixture bind errors and repeated 30-second beforeEach/afterEach timeouts in remote-link tests. Its profile/catalog missing-repo assertion received the network-unavailable message instead of a repository-name hint because GitHub could not be reached. ModelTraceStore retention also exceeded the 30-second test timeout; this timeout has not been proved baseline-identical.
- Shard 2 has 92 failures in the final Bun report; 2 additional observed failure lines are from nested child runs and are preserved separately under `nested_or_uncounted_failure_lines` in the inventory. They must not be added to the final suite failure count.
- Shard 31: both failures are SessionStart matcher cases in loadPluginHooks.test.ts. The original baseline control above reproduces these exact two cases and exposes the diskutil initialization error.
- Shard 32: 114 of 115 primary failure contexts directly include diskutil / DiskArbitration errors. One additional output-journal-identity-migration assertion reports a missing repair-pending file (`expected true, received false`); its exact assertion is preserved in the log and is not counted as a directly observed diskutil error.

No failure has been changed into a pass based on an environmental diagnosis. The per-case inventory is the review handoff for distinguishing pre-existing environment constraints from regressions in a less restricted runner.

## Artifacts

- Canonical corrected classification: `/private/tmp/codeshell-final-core-shards-20261110/classified-results.json`.
- Exact failure files/cases: `/private/tmp/codeshell-final-core-shards-20261110/failure-inventory.json`.
- Runner raw records: `/private/tmp/codeshell-final-core-shards-20261110/results.json`. The raw parser missed singular `1 file.` for shard 0; corrected classification accepts both `file` and `files`. This changes report metadata only, never test execution or exit status.
- All five requested shards produced complete final Bun reports; all exited 1, and none hit the wall-clock limit. Final HEAD was rechecked as the candidate above. This worker made no repository edits; the parent-owned implementation-status document was concurrently updated.
- Shard 0: `/private/tmp/codeshell-final-core-shards-20261110/shard-0.log` and `/private/tmp/codeshell-final-core-shards-20261110/shard-0.json`.
- Shard 1: `/private/tmp/codeshell-final-core-shards-20261110/shard-1.log` and `/private/tmp/codeshell-final-core-shards-20261110/shard-1.json`.
- Shard 2: `/private/tmp/codeshell-final-core-shards-20261110/shard-2.log` and `/private/tmp/codeshell-final-core-shards-20261110/shard-2.json`.
- Shard 31: `/private/tmp/codeshell-final-core-shards-20261110/shard-31.log` and `/private/tmp/codeshell-final-core-shards-20261110/shard-31.json`.
- Shard 32: `/private/tmp/codeshell-final-core-shards-20261110/shard-32.log` and `/private/tmp/codeshell-final-core-shards-20261110/shard-32.json`.

## Failed files

### Shard 0

- `packages/desktop/src/main/mcp-oauth-issuer.test.ts`: 10

### Shard 1

- `packages/core/src/engine/engine.prompt-cache.test.ts`: 4
- `packages/core/src/engine/engine.primary-cache-accounting.test.ts`: 2
- `packages/core/src/engine/engine.workspace-profile-session.test.ts`: 2
- `packages/core/src/engine/engine.agent-background-yield.test.ts`: 5
- `packages/core/src/engine/engine.session-title.test.ts`: 4
- `packages/core/src/engine/engine.concurrent-run.test.ts`: 3
- `packages/core/src/engine/engine.session-kind.test.ts`: 1
- `packages/core/src/engine/engine.todo-resume.test.ts`: 2
- `packages/core/src/engine/agent-direction-safe-point.test.ts`: 5
- `packages/core/src/engine/engine.bash-background-continuation.test.ts`: 3
- `packages/core/src/engine/engine.profile-input-change.test.ts`: 2
- `packages/core/src/engine/engine.child-host-bindings.test.ts`: 2
- `packages/core/src/engine/engine.prompt-too-long.test.ts`: 1
- `packages/core/src/engine/engine.turn-diff.test.ts`: 2
- `packages/core/src/engine/engine.file-history-home.test.ts`: 1
- `packages/core/src/engine/engine-sid-isolation.test.ts`: 1
- `packages/core/src/engine/engine.init-lifecycle.test.ts`: 6
- `packages/core/src/engine/engine.task-routing.test.ts`: 8
- `packages/core/src/engine/engine.run-yield.test.ts`: 13
- `packages/core/src/engine/engine.tool-selection-resume.test.ts`: 5
- `packages/core/src/engine/engine.session-fork-history.test.ts`: 4
- `packages/core/src/engine/run-stream.test.ts`: 8
- `packages/core/src/engine/engine.archive-persist.test.ts`: 4
- `packages/core/src/engine/engine.session-open.test.ts`: 1
- `packages/core/src/engine/engine.max-turns-stream.test.ts`: 4
- `packages/core/src/engine/engine-client-message-id.test.ts`: 3
- `packages/core/src/engine/subagent-reuse.integration.test.ts`: 1
- `packages/core/src/engine/engine.context-notes.test.ts`: 6
- `packages/core/src/engine/engine.mcp-health.test.ts`: 1
- `packages/core/src/engine/turn-loop-goal-lifecycle.test.ts`: 25
- `packages/core/src/engine/engine.background-output.test.ts`: 4
- `packages/core/src/engine/engine-steer-idle.test.ts`: 2
- `packages/core/src/engine/engine.external-file-provenance.test.ts`: 1
- `packages/core/src/engine/engine.model-traces.test.ts`: 1
- `packages/core/src/engine/engine-current-model.test.ts`: 3
- `packages/core/src/engine/engine.auto-compaction-goal.test.ts`: 4
- `packages/core/src/engine/engine.context-anchor.test.ts`: 3
- `packages/core/src/engine/engine.permission-boundary.test.ts`: 4
- `packages/core/src/engine/engine.output-journal.test.ts`: 11
- `packages/core/src/engine/engine.session-message.test.ts`: 2
- `packages/core/src/engine/engine.module-lifetime.test.ts`: 1
- `packages/core/src/engine/engine.profile-max-turns.test.ts`: 13
- `packages/core/src/engine/engine-structured-image-vision-gate.test.ts`: 7
- `packages/core/src/engine/engine.cost-ledger.test.ts`: 5
- `packages/core/src/engine/engine.quick-chat-restricted.test.ts`: 1
- `packages/core/src/tool-system/mcp-envelope.test.ts`: 1
- `packages/core/src/tool-system/sandbox/skill-resources.test.ts`: 2
- `packages/core/src/tool-system/sandbox/sandbox.test.ts`: 1
- `packages/core/src/tool-system/sandbox/multi-root.seatbelt.e2e.test.ts`: 1

### Shard 2

- `packages/core/src/protocol/tcp-transport.test.ts`: 2
- `packages/core/src/protocol/server.session-message.integration.test.ts`: 2
- `packages/core/src/protocol/server.run-model.test.ts`: 2
- `packages/core/src/protocol/server.project-model.test.ts`: 1
- `packages/core/src/protocol/server.tcp-approval-isolation.test.ts`: 3
- `packages/core/src/protocol/chat-session-manager.migration.test.ts`: 1
- `packages/core/src/cost-ledger/ledger.test.ts`: 1
- `packages/core/src/profile/catalog.test.ts`: 1
- `packages/core/src/links/remote-refresh-classification.test.ts`: 1
- `packages/core/src/links/operation-reconcile.test.ts`: 1
- `packages/core/src/links/verified-write.test.ts`: 9
- `packages/core/src/links/remote.test.ts`: 21
- `packages/core/src/links/remote-providers.test.ts`: 28
- `packages/core/src/links/link-action-run-authority.test.ts`: 1
- `packages/core/src/links/request-once.test.ts`: 5
- `packages/core/src/model-traces/store.test.ts`: 1
- `packages/core/src/services/oauth.test.ts`: 3
- `packages/core/src/llm/providers/openai-reasoning-stream.test.ts`: 9

### Shard 31

- `packages/core/src/plugins/loadPluginHooks.test.ts`: 2

### Shard 32

- `packages/core/src/session/output-journal-persistent-identity.test.ts`: 8
- `packages/core/src/session/output-journal-storage.test.ts`: 11
- `packages/core/src/session/output-journal-performance.test.ts`: 1
- `packages/core/src/session/output-journal-contention.test.ts`: 3
- `packages/core/src/session/output-journal-legacy-base.test.ts`: 16
- `packages/core/src/session/output-journal-identity-migration.test.ts`: 19
- `packages/core/src/session/output-history-recovery.test.ts`: 22
- `packages/core/src/session/output-journal.test.ts`: 34
- `packages/core/src/session/persistent-file-identity.test.ts`: 1
