# chore(architecture): require types for uninitialized declarations

Draft PR: T2; stacked base `codex/architecture/t1-run-option-forwarding` at `68eca438f`; head `codex/architecture/t2-typed-declarations`. Rebase onto `main` after T1 merges, then rerun the required combined checks. Implementation checkout: `/private/tmp/codeshell-architecture-t3` (reused only after its independent T3 commit was clean).

Untyped declarations without initializers silently become `any` under the repository's `noImplicitAny: false`, which allowed T1's queued run-option omission to pass compilation. This change adds explicit types to the remaining 62 declarations and enables `custom-rules/no-untyped-uninitialized-variable` only for core, coding, server, web, host, pet, chat, link `src` and Desktop `src/main`. Test/spec files and declaration files are excluded; TUI and Desktop renderer are unchanged. `for-in` and `for-of` declarations retain inference from the loop source.

The initial AST inventory found 62 declarations across 50 files, exactly one fewer than the checklist because T1 already typed `session`. Counts against this stacked base:

| Package | Declarations | Files |
| --- | ---: | ---: |
| core | 28 | 24 |
| coding | 15 | 9 |
| server | 7 | 6 |
| web | 1 | 1 |
| desktop | 11 | 10 |

Typecheck findings:

- The first Core pass emitted 22 definite-assignment diagnostics for the same `response` variable in `TurnLoop`: TypeScript could not prove that the old `recovered` boolean implied a response assignment inside the retry loop. The recovery slot now stores the actual `LLMResponse`; its existing failure guard narrows the successful value before assigning `response`. The retry count, returned reasons and valid provider behavior remain unchanged. Existing success, exhausted-retry, continuation and error-path tests passed.
- One provisional annotation used `string` for the legacy GitHub action, which was too broad for the existing candidate contract. It now uses the already-defined `ReviewedGithubWrite` union. No runtime parsing or filtering changed.
- No other mismatch was exposed by the complete build and workspace typecheck, and the threshold of more than 10 distinct real type mismatches was not reached. No `as any`, suppression, public API change or fake was added.

TypeScript transpilation with comments removed produced byte-identical JavaScript for 49 of the 50 production files; only the recovery slot adjustment changes emitted statements. The lone Pet/Mimi file change is a local type annotation for the existing action receipt result, with identical emitted JavaScript; no Pet workflow was changed.

Validation:

- `bun run build`: passed.
- `bun run typecheck:workspaces` after build: all workspaces passed, including Desktop and Web SPA.
- `bun run lint`: 0 errors, 98 warnings (baseline 98).
- `bun run lint:test-shards`, `bun run lint:engine-bypass`, `git diff --check`: passed.
- Guarded tests: `tests/eslint-boundary-guard.test.ts`, `turn-loop-context-limit.test.ts`, `turn-loop-continuation.test.ts`, `turn-loop-error-safety.test.ts`: 18 passed, 0 failed. The new probe checks rejection of both empty `let` and `var` across all nine enabled source scopes, accepts annotated/initialized and `for-in`/`for-of` variables, and verifies test/TUI/renderer exclusions.
- Guarded three-contract run (`architecture-budgets`, `package-boundaries`, preload `ipc-contract`): 27 passed, 0 failed.
- Only changed ranges in the 52 affected files were formatted. No new test files, shard allowances, line budgets, Bun/React changes or composition fixtures.

Not validated in this individual PR: a complete successful run of every CI unit shard, GitHub required checks, or CC review. The same task's baseline controls already established that this restricted macOS environment cannot run `diskutil`/DiskManagement, causing Engine fixture `model_error` before fake-provider invocation; socket listeners are also restricted. The coordinator owns final combined CI verification. No PR was pushed or merged by this agent.

Local evidence: `/private/tmp/codeshell-t2-{build,typecheck,lint,tests,contracts,shards,engine-bypass}.log`, `/private/tmp/codeshell-t2-inventory.json`, `/private/tmp/codeshell-t2-runtime-diff.json`. The initial diagnostic pass is retained at `/private/tmp/codeshell-t2-core-typecheck-initial.log`.

Declaration inventory (line numbers at stacked base `68eca438f`):

| File:line | Variable | Type |
| --- | --- | --- |
| `packages/core/src/engine/input-attachments.ts:149` | `info` | `Stats` |
| `packages/core/src/engine/subagent-spawner.ts:258` | `result` | `Awaited<ReturnType<ChildEngineRuntime["run"]>>` |
| `packages/core/src/engine/turn-loop.ts:1174` | `response` | `LLMResponse` |
| `packages/core/src/hooks/shell-runner.ts:153` | `child` | `ReturnType<typeof spawn>` |
| `packages/core/src/links/operation-reader.ts:191` | `execution` | `Awaited<ReturnType<ToolExecutor["executeSingle"]>>` |
| `packages/core/src/links/operation-review.ts:307` | `output` | `LegacyLinkOperationOutput` |
| `packages/core/src/links/operation-review.ts:379` | `output` | `LegacyLinkOperationOutput` |
| `packages/core/src/links/remote.ts:522` | `resourceGroups` | `ReturnType<typeof parseRemoteLinkResourceGroups>` |
| `packages/core/src/links/remote.ts:603` | `secret` | `ReturnType<typeof parseOAuthCredentialSecret>` |
| `packages/core/src/links/remote.ts:807` | `value` | `ReturnType<typeof parseOAuthCredentialSecret>` |
| `packages/core/src/model-request-boundary/context.ts:210` | `signatures` | `Awaited<ReturnType<ModelRequestSigner["sign"]>>` |
| `packages/core/src/model-traces/native-process.ts:172` | `newline` | `number` |
| `packages/core/src/plugins/installer/installFromNpm.ts:98` | `manifestStat` | `Stats` |
| `packages/core/src/plugins/pluginCommandHook.ts:150` | `child` | `ReturnType<typeof spawn>` |
| `packages/core/src/plugins/pluginCommandsLoader.ts:139` | `dirEntries` | `Dirent[]` |
| `packages/core/src/plugins/pluginHookIntegrity.ts:130` | `pathStat` | `Stats` |
| `packages/core/src/profile/plugin-export.ts:126` | `profile` | `ReturnType<typeof readWorkspaceProfile>` |
| `packages/core/src/profile/plugin-export.ts:143` | `sources` | `ReturnType<typeof discoverProfileExportSources>` |
| `packages/core/src/protocol/server.ts:1531` | `source` | `ChatSession \| undefined` |
| `packages/core/src/session/output-history-recovery.ts:451` | `binding` | `ReturnType<typeof createOutputJournalBinding>` |
| `packages/core/src/session/output-journal-manual-repair.ts:266` | `head` | `ReturnType<typeof readPublishedOutputHead>` |
| `packages/core/src/session/profile-references.ts:16` | `directory` | `Awaited<ReturnType<typeof opendir>>` |
| `packages/core/src/session/session-fork.ts:72` | `entries` | `Dirent[]` |
| `packages/core/src/session/session-manager.ts:613` | `entries` | `Dirent[]` |
| `packages/core/src/session/session-state-file.ts:89` | `stat` | `Stats` |
| `packages/core/src/session/session-state-shape.ts:64` | `stat` | `Stats` |
| `packages/core/src/tool-system/builtin/agent-notifications.ts:504` | `pathInfo` | `Stats` |
| `packages/core/src/tool-system/builtin/view-image.ts:163` | `messages` | `Message[]` |
| `packages/coding/src/cc-orchestrator/codex-session-discovery.ts:71` | `entries` | `Dirent[]` |
| `packages/coding/src/cc-orchestrator/codex-session-discovery.ts:312` | `st` | `Stats` |
| `packages/coding/src/cc-orchestrator/codex-session-history.ts:230` | `st` | `Stats` |
| `packages/coding/src/cc-orchestrator/session-discovery.ts:226` | `st` | `Stats` |
| `packages/coding/src/cc-orchestrator/session-discovery.ts:393` | `dirStat` | `Stats` |
| `packages/coding/src/external-runtimes/claude-code/text-inference.ts:233` | `newline` | `number` |
| `packages/coding/src/review/review-target.ts:323` | `stat` | `Stats` |
| `packages/coding/src/tools/apply-patch/applier.ts:391` | `file` | `Awaited<ReturnType<typeof open>>` |
| `packages/coding/src/tools/apply-patch/backup-targets.ts:15` | `parsed` | `ReturnType<typeof parsePatch>` |
| `packages/coding/src/tools/apply-patch/backup-targets.ts:41` | `parsed` | `ReturnType<typeof parsePatch>` |
| `packages/coding/src/tools/apply-patch/index.ts:70` | `parsed` | `ReturnType<typeof parsePatch>` |
| `packages/coding/src/tools/apply-patch/index.ts:85` | `result` | `Awaited<ReturnType<typeof applyPatch>>` |
| `packages/coding/src/tools/drive-agent.ts:331` | `state` | `ReturnType<typeof inspectWorktreeChanges>` |
| `packages/coding/src/tools/drive-agent.ts:805` | `provenance` | `Awaited<ReturnType<typeof probeExternalChangedFiles>> \| undefined` |
| `packages/coding/src/tools/drive-agent.ts:1482` | `provenance` | `Awaited<ReturnType<typeof probeExternalChangedFiles>> \| undefined` |
| `packages/server/src/account/store.ts:106` | `metadata` | `Stats` |
| `packages/server/src/mobile-remote/mobile-chat-turn.ts:74` | `materialized` | `Awaited<ReturnType<typeof materializeMobileAttachments>>` |
| `packages/server/src/mobile-remote/remote-host-manager.ts:642` | `device` | `ReturnType<TrustedDeviceStore["authenticate"]>` |
| `packages/server/src/mobile-remote/remote-host-manager.ts:682` | `device` | `ReturnType<TrustedDeviceStore["authenticate"]>` |
| `packages/server/src/project-runtime/backup.ts:204` | `input` | `Awaited<ReturnType<typeof open>> \| undefined` |
| `packages/server/src/remote-relay/connector.ts:205` | `message` | `ReturnType<typeof parseRelayControlMessage>` |
| `packages/server/src/serve/headless-server.ts:279` | `cursor` | `ReturnType<typeof runReplay.append>` |
| `packages/web/src/hooks/useRemoteApp.ts:2514` | `attachments` | `Awaited<ReturnType<typeof prepareMobileAttachments>>` |
| `packages/desktop/src/main/agent-bridge.ts:624` | `snapshotEntry` | `(SnapshotEntry & { sessionId: string; epoch: string }) \| undefined` |
| `packages/desktop/src/main/agent-bridge.ts:2729` | `entry` | `SnapshotEntry` |
| `packages/desktop/src/main/desktop-services.ts:722` | `stat` | `Stats` |
| `packages/desktop/src/main/device-relay-store.ts:93` | `metadata` | `Stats` |
| `packages/desktop/src/main/fs-service.ts:30` | `info` | `Stats \| undefined` |
| `packages/desktop/src/main/mounted-project-root.ts:95` | `info` | `Stats` |
| `packages/desktop/src/main/pet/pet-dispatch-service.ts:3101` | `claim` | `Awaited<ReturnType<typeof receipts.claim>>` |
| `packages/desktop/src/main/project-runtime-store.ts:307` | `metadata` | `Stats` |
| `packages/desktop/src/main/run-history-service.ts:233` | `entries` | `Dirent[]` |
| `packages/desktop/src/main/runs-service.ts:239` | `entries` | `Dirent[]` |
| `packages/desktop/src/main/session-transcript-cache-worker.ts:13` | `value` | `TranscriptCacheWorkerReply["value"]` |
