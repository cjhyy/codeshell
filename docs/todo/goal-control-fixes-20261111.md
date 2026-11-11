# Goal control fixes — local development handoff (2026-11-11)

Status: implemented on the dedicated task branch; **not pushed, not merged, no PR**. This is development evidence, not the separately requested CC acceptance review.

- Worktree: `/private/tmp/codeshell-goal-fixes-20261111` only. Primary checkout and review worktree unchanged.
- Branch: `codex/core/goal-controls-fixes-20261111`.
- Base / fetched `origin/main`: `17e5524facb1a762505bc51b54676b21049a0142` (the prior review base was `e0152845d`; latest main was independently checked before writing).
- Implementation commits: `9622facd4` (`fix(goal): preserve lifecycle controls across startup and remote recovery`) and final incremental `8d3db6dfd` (`fix(goal): report rejected remote clear revisions`). Documentation-only commit follows; use `git rev-parse HEAD` for the final handoff head.
- A later comparison fetch advanced `origin/main` to `9e6330c102e9d9b6e5a465a4cd92e50c977b1110` (Mimi notification PR #338, no overlapping Goal implementation files). This development branch remains based on the user-specified base; integration/rebase and combined-main CI remain future work.
- Independent dependencies: `bun install --frozen-lockfile`, no primary-checkout dependency links.

## Six fixes and product behavior

| Finding                                                     | Root cause and fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Main implementation                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Startup pause/edit race (P1)                             | Startup yielded after opening a stale Session snapshot. Waiting rearm could overwrite a newer Goal. Resolve the full authoritative lifecycle after startup hooks and rearm with Goal identity/revision CAS; SessionManager refuses revision regression. Paused/user-wait automatic turns settle held with zero provider turns. An edit during initialization settles explicitly recoverable with “retry with the current Goal version”, preserving the notification for a new context. Only this typed hold is normal; real read/save errors remain errors. Held finalization includes client receipt and never runs title/memory provider work. | `packages/core/src/engine/run-goal.ts:35`, `:87`, `:125`; `packages/core/src/engine/run-finalize.ts:48`; `packages/core/src/session/session-manager.ts:1493`                                                                                                                                                                                |
| 2. Stop lost after idle eviction (P2)                       | Stop lived only on the discarded ChatSession. Retain stopped evicted owners in a bounded manager-local Set (same process, up to 4096). Cold acquisition restores Stop. Only real user input or explicit Goal resume clears it; background/host messages do not authorize wake. Explicit close/shutdown clear retained state; migration-delayed close honors explicit tombstones. Capacity holds the resident owner; explicit unload reports failure instead of claiming success. Shell results stay queued.                                                                                                                                      | `packages/core/src/protocol/chat-session-manager.ts:170`, `:458`, `:563`, `:718`; `packages/core/src/protocol/chat-session.ts:215`, `:527`                                                                                                                                                                                                  |
| 3. Extend lost after objective edit (P3)                    | Objective edits replaced the run tracker with persisted original budgets. Same-run/same-Goal edits retain token/time extensions (including unlimited) and the stop-block cap. Pause/resume still creates a fresh budget window. Runtime extensions are not written back as persisted budgets.                                                                                                                                                                                                                                                                                                                                                    | `packages/core/src/engine/turn-loop.ts:350`                                                                                                                                                                                                                                                                                                 |
| 4. Public SDK legacy AskUser timeout (P3)                   | Legacy single-Engine questions ignored AskUser lifecycle options and keepWaiting only looked in managed sessions. Model questions now use the tool’s 120000ms default/recommended-or-skip behavior; keepWaiting removes the deadline and republishes the same route. Timers, cancel, expiry-before-timer and duplicate answers are fenced. Permission/credential/tool approvals remain 600000ms and never auto-grant. Existing asynchronous-question flow is unchanged.                                                                                                                                                                          | `packages/core/src/protocol/user-decision-lifecycle.ts:194`, `:279`, `:374`                                                                                                                                                                                                                                                                 |
| 5. Web paused/idle resume (P2/P3)                           | Web always sent extend100 and lacked durable Goal identity/snapshot hydration. Add negotiated Goal get/update and correlated replies. Cold/reconnected views fetch the authoritative Goal; paused/idle controls send GoalUpdate CAS and preserve Goal identity; running controls extend100. UI distinguishes 恢复目标 / 追加轮次 / 处理中. Selected conversation, Goal revision and reducer-time CAS fence late replies/replacements. Old peers keep running extension/clear but explicitly reject unsupported resume.                                                                                                                           | `packages/web/src/hooks/useRemoteGoalControls.ts:17`; `packages/web/src/hooks/useRemoteApp.ts:305`, `:1105`; `packages/web/app/DesktopApp.tsx:1140`; `packages/desktop/src/main/mobile-remote/handle-client-event.ts:1052`; `packages/desktop/src/main/agent-bridge.ts:973`; `packages/server/src/mobile-remote/remote-host-manager.ts:162` |
| 6. Offline clear/no-worker replies and Web failures (P2/P3) | Mobile injection dropped no-child requests although native IPC had a reviewed disk fallback. Reuse that fallback after existing ingress fences and publish replies to isolated outbound taps with original correlation id. Web displays failures and only clears the captured Goal version; new capable peers use GoalDelete CAS. A refused versioned delete (`deleted:false`) becomes a visible correlated retry error. No arbitrary new disk RPC authority, worker spawning for clear, or workspace/owner bypass.                                                                                                                              | `packages/desktop/src/main/agent-bridge.ts:978`, `:2487`; `packages/desktop/src/main/mobile-remote/handle-client-event.ts:1052`; `packages/web/src/hooks/useRemoteGoalControls.ts:90`                                                                                                                                                       |

Native external runtimes retain their existing owner/routing policy. Automatic unsupported Goal snapshots are silent, explicit unsupported controls fail visibly; the mobile route never bypasses native ownership to call another runtime. Resume uses Core’s existing permission-aware continuation and rollback path.

## TDD and focused evidence

All Bun invocations use `node scripts/run-bun-test-shard.mjs --timeout 30000` with 1–8 explicit files and isolated HOME. New Engine/SDK fixtures install network guards before Core imports and use fake providers. Fixed diskutil volume identity exists only in fixtures. No live provider, credential, release or user-data operation was used.

| Evidence                                                                                     | Result                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/tmp/goal-controls-core-red.log`: cleaned real startup/edit/budget/evicted-Stop regressions | 6 tests: 2 pass, 4 fail on unmodified production. The original reproduction’s requirement to enter the model after pause was removed; final disk state is always checked.                                      |
| `/tmp/goal-controls-sdk-red.log`: public createServer + actual AskUser tool                  | 3 tests: 1 pass, 2 fail on unmodified production.                                                                                                                                                              |
| `/tmp/goal-controls-web-red.log`: actual hook/controller and real nochild injection          | 127 tests: 124 pass, 3 fail (snapshot missing, error silent, nochild request timeout).                                                                                                                         |
| `/tmp/goal-controls-stale-clear-red.log` → `/tmp/goal-controls-stale-clear-green.log`        | Incremental dispatcher control: 39 pass / 1 fail → 56/56 pass (dispatcher + real nochild/cold chain).                                                                                                          |
| `/tmp/goal-controls-final-incremental.log`                                                   | Final implementation `8d3db6dfd`: 238/238 pass across dispatcher, nochild, Web hook, actual Host capability and validator.                                                                                     |
| `/tmp/goal-controls-core-green.log`                                                          | First Core milestone: 22/22 pass.                                                                                                                                                                              |
| `/tmp/goal-controls-web-green.log`                                                           | First Web milestone: 127/127 pass.                                                                                                                                                                             |
| `/tmp/goal-controls-transport.log`                                                           | 24/24 pass, including mobile handler → AgentBridge → real Core cold resume/stale CAS and nochild disk clear.                                                                                                   |
| `/tmp/goal-controls-architecture-transport.log`                                              | 84/84 pass: architecture/file/mock budgets, nochild ingress, authority dispatcher and validation.                                                                                                              |
| `/tmp/goal-controls-migration-alone.log`                                                     | 6/6 pass, including sweep during resident migration followed by explicit close/reopen.                                                                                                                         |
| `/tmp/goal-controls-web-final.log`                                                           | Pre-final gate hook suite 113/113 pass, including no-id reply isolation and same-batch selection/replacement races. Final gate includes the subsequently added unsupported/legacy-kind/capability regressions. |

Later controls include real wake/claim → startup pause with exact notification envelope restored, waiting CAS failure vs real save error, expiry-before-timer/cancel/late-answer SDK behavior, migration explicit-close intent, old peers, reconnect, identity replacement, authority revocation and live-worker delete. Tests were added to relevant existing suites; the six original review scripts were not blindly merged.

Intermediate fixture failures were corrected rather than counted as product RED: initial package dist prerequisite; a public non-strict SDK route test incorrectly requiring strict connection ownership; migration fake missing a close-finalization seam; React act render ordering; dispatcher fake missing run context. A mixed Engine-fixture shard also failed an existing migration test, which passed standalone after fixture correction; final full-gate partitioning isolates the new Engine and SDK files. Final gate failures and controls are recorded below.

Representative exact commands (same guarded entry point for RED and GREEN, tests strengthened as described):

```sh
node scripts/run-bun-test-shard.mjs --timeout 30000 tests/engine-goal-startup-controls.test.ts
node scripts/run-bun-test-shard.mjs --timeout 30000 tests/sdk-legacy-ask-user.test.ts
node scripts/run-bun-test-shard.mjs --timeout 30000 packages/web/src/hooks/useRemoteApp.test.tsx packages/desktop/src/main/agent-bridge.nochild.test.ts
node scripts/run-bun-test-shard.mjs --timeout 30000 tests/architecture-budgets.test.ts packages/desktop/src/main/agent-bridge.nochild.test.ts packages/desktop/src/main/mobile-remote/handle-client-event.test.ts packages/server/src/mobile-remote/mobile-client-event-validator.test.ts
node scripts/run-bun-test-shard.mjs --timeout 30000 packages/core/src/protocol/chat-session-manager.migration.test.ts
node scripts/run-bun-test-shard.mjs --timeout 30000 packages/desktop/src/main/mobile-remote/handle-client-event.test.ts packages/desktop/src/main/agent-bridge.nochild.test.ts packages/web/src/hooks/useRemoteApp.test.tsx packages/server/src/mobile-remote/remote-host-manager.test.ts packages/server/src/mobile-remote/mobile-client-event-validator.test.ts
```

## Final gates

At implementation commit `9622facd4`:

- `caffeinate -i bun run test:package-release`: PASS, 10 tarballs / 55 typed entries; includes 53 runtime imports and packed Node auth/document lifecycle checks. Log `/tmp/goal-controls-package-release-final.log`.
- After package release completed, `caffeinate -i bun run typecheck`: PASS, all 12 workspaces (including Web SPA). Log `/tmp/goal-controls-typecheck-final.log`.
- Then `caffeinate -i bun run --cwd packages/desktop build`: PASS, main/preload/renderer/mobile/Chrome extension. Existing Vite chunk-size warnings remain. Log `/tmp/goal-controls-desktop-build-final.log`.
- `caffeinate -i bun run lint` and `bun run lint:engine-bypass`: PASS. ESLint reports 0 errors and 90 warnings (not zero warnings); no unrelated lint baseline changes. Logs `/tmp/goal-controls-lint-final.log`, `/tmp/goal-controls-engine-bypass-final.log`.
- Full unit first run completed: **2365 Bun files / 367 groups**, concurrency 4, max 8 explicit files per group; plus **44 Node files / 6 groups, 549 pass / 0 fail / 0 skip**. All 2409 non-documentation tracked test files were included; 129 historical `docs/**` reproductions are intentionally outside the current CI plan.
- The first full run had **4 failing Bun groups, 20 failing test cases**. It is not a single zero-failure full gate. The 363 successful groups passed the guarded JUnit completion check; 79 skipped cases are reported. Raw Bun stdout final-footer aggregation is 22057 pass / 20 fail / 79 skip. Nested subprocess summaries are also present, so no combined JUnit case total is asserted here; the failed-group table and preserved per-group logs are authoritative for investigation.
- This full run started at `9622facd4`; the small stale-clear incremental change landed while it was running. All affected dispatcher/bridge/Web/Host/validator files were then explicitly rechecked on final implementation `8d3db6dfd`: **238/238 pass**. Do not represent the mixed first run as an exact-final-HEAD all-green run.
- Final post-increment audit on `8d3db6dfd` completed in sequence: `caffeinate -i bun run test:package-release` **PASS (10 tarballs / 55 typed entries)**, then `caffeinate -i bun run typecheck` **PASS (all 12 workspaces)**, then `caffeinate -i bun run --cwd packages/desktop build` **PASS (main/preload/renderer/mobile/Chrome extension)**. Logs `/tmp/goal-controls-package-release-postincrement.log`, `/tmp/goal-controls-typecheck-postincrement.log`, `/tmp/goal-controls-desktop-build-postincrement.log`. No unit/dist reader ran concurrently with package-release cleanup.
- Incremental final files also passed `bunx eslint packages/desktop/src/main/mobile-remote/handle-client-event.ts packages/desktop/src/main/mobile-remote/handle-client-event.test.ts` with no diagnostics (`/tmp/goal-controls-lint-incremental.log`). The full-tree lint/engine-bypass results above remain valid; full lint warnings were not hidden.
- Timing/runtime controls are complete and listed below. No requested production fix remains unfinished; actual physical-worker/Electron E2E and the separately requested independent CC acceptance remain explicitly unverified.

Exact full-gate orchestration: `caffeinate -i node /tmp/goal-controls-full-unit.mjs`; it expands the exported `localTestPlan` from `scripts/run-unit-tests.ts`, classifies the Node scripts with the repository’s declared-runner rule, and isolates module-mock suites plus the new real Engine/SDK fixtures. Source plan `/tmp/goal-controls-ci-plan.json`; orchestrator is available locally for review.

The full local CI test plan is expanded to explicit file groups, rather than violating the user’s maximum-eight-files rule with directory shards. Plan and raw synthetic logs are outside the repository: `/tmp/goal-controls-unit/plan.json`, `/tmp/goal-controls-unit/results.json`, `/tmp/goal-controls-unit-progress.log`.

Failure control completed for shard 0126: the single failing `panel-background-services.integration.test.ts` test copies the Homebrew Node executable into a temporary runtime without its `@rpath/libnode.141.dylib`; `node --version` aborts in dyld before any application logic. The exact single-file command below gives **2 pass / 1 fail on both this branch and clean latest main `9e6330c10`**. Clean main was archived under ignored `artifacts/goal-main-control`, independently frozen-installed and built (`link` then `core`); no patched source or shared dist was used. Logs: `/tmp/goal-controls-branch-panel-control.log`, `/tmp/goal-controls-main-panel-control.log`. Initial missing-dist and nested-node_modules declaration-path setup failures were resolved before this comparison and are not comparison evidence.

```sh
node scripts/run-bun-test-shard.mjs --timeout 30000 packages/desktop/src/main/panel-background-services.integration.test.ts
```

## Full-gate failures and controlled rechecks

Initial failed groups are retained unchanged under `/tmp/goal-controls-unit/`:

| Group          | Initial result    | Branch / clean latest-main control                                                                                             | Outcome and remaining limit                                                                                                                                                                                               |
| -------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0126 (8 files) | 44 pass / 1 fail  | Default-Node single file: branch 2/1 and main 2/1, identical missing `libnode.141.dylib` abort.                                | A standalone supported Node fixes the fixture prerequisite; branch combined runtime controls pass 91/91.                                                                                                                  |
| 0230 (8 files) | 49 pass / 1 fail  | Exact known-cache controller case: branch 1 pass, main 1 pass; unchanged 1000ms per-operation budget and 30000ms test timeout. | Initial `budget_exhausted` is not reproducible serially. Parallel-load timing is plausible, but its exact trigger was not captured; do not claim a proven root cause or change the budget.                                |
| 0333 (4 files) | 71 pass / 17 fail | Clean main default Node: 71/17 with the same `SERVICE_NODE_SECURITY_VERSION_REQUIRED` errors.                                  | Homebrew Node 25.8.1 is intentionally unsupported by the existing native-service security gate. No version-policy change. Supported Node 24.22.1 branch controls pass 91/91 (these four files plus the 0126 failed file). |
| 0345 (8 files) | 116 pass / 1 fail | Same single performance test, original 30000ms timeout: branch 1 pass (~26.77s test), main 0/1 timeout (~40s command).         | The baseline also exceeds the deadline. The branch serial recheck passes, but the initial parallel full gate remains failed; performance timing margin is a known validation limit.                                       |

The clean-main Node 24 combined 5-file control was 90 pass / 1 fail: one additional guardian-loss case hit `SERVICE_CUSTODY_IO:ENOENT:connect`. Its exact isolated recheck passed (1 pass, 19 filtered), and the branch combined 91-test run had already passed. Both observations remain in the logs; no tests or production security checks were weakened.

The runtime control copied the existing standalone Node 24.22.1 executable read-only from the installed app into this task’s ignored `artifacts/goal-main-control/artifacts/validation-node/bin`. Only the test command’s PATH was prefixed; the installed app and system Node were unchanged. Clean main has independent dependencies and its own built link/core/host/web/server artifacts.

Exact control commands (run from this branch and then from the clean archive as noted in `/tmp/goal-controls-controls-results.json`):

```sh
node scripts/run-bun-test-shard.mjs --timeout 30000 packages/optimization-lab/src/controller.test.ts -t '^candidate cost tie-break requires comparable complete usage \(known cache\)$'
node scripts/run-bun-test-shard.mjs --timeout 30000 packages/core/src/session/output-journal-performance.test.ts
node scripts/run-bun-test-shard.mjs --timeout 30000 packages/server/src/panels/background-service-process.recovery.test.ts packages/server/src/panels/background-service-store.recovery.test.ts packages/server/src/panels/background-services.recovery.test.ts packages/server/src/panels/background-services.test.ts
goal_node_bin=/private/tmp/codeshell-goal-fixes-20261111/artifacts/goal-main-control/artifacts/validation-node/bin
env PATH="$goal_node_bin:$PATH" node scripts/run-bun-test-shard.mjs --timeout 30000 packages/desktop/src/main/panel-background-services.integration.test.ts packages/server/src/panels/background-service-process.recovery.test.ts packages/server/src/panels/background-service-store.recovery.test.ts packages/server/src/panels/background-services.recovery.test.ts packages/server/src/panels/background-services.test.ts
env PATH="$goal_node_bin:$PATH" node scripts/run-bun-test-shard.mjs --timeout 30000 packages/server/src/panels/background-services.test.ts -t '^I-1 actual coordinator counts guardian loss once and backs off after group exit$'
```

Control logs: `/tmp/goal-controls-{branch,main}-lab-control.log`, `/tmp/goal-controls-{branch,main}-perf-control.log`, `/tmp/goal-controls-main-server-default.log`, `/tmp/goal-controls-{branch,main}-node24.log`, `/tmp/goal-controls-main-custody-control.log`. Original full-run results were not overwritten. All 20 initially failing branch test cases passed in these bounded rechecks, while the first full run still has its four failed groups and is reported that way.

## Browser and integration boundaries

`node scripts/run-isolated-node-smoke.mjs packages/web/scripts/test-goal-controls-browser.mjs` ran real Chromium with actual useRemoteApp/useDesktopController and actual Goal buttons, using an exact loopback mock Host protocol. Five checks passed: cold paused snapshot, CAS resume, running extend100, visible clear failure and successful clear; browser errors and blocked requests were empty. Evidence: `/tmp/goal-controls-browser-final.log` and its printed temporary report path. This is a browser + mocked transport acceptance fixture, **not** a full Electron-to-Core E2E.

`agent-bridge-offline-goal.mjs` separately exercises real mobile dispatch, AgentBridge prepared injection, reviewed disk fallback, outbound reply correlation, and a real AgentServer/ChatSessionManager/Engine behind an in-process worker stdin boundary. It proves cold resume/one fake provider call, stale CAS rejection, real nochild clear with no spawned worker and a live-worker clear control. It does not launch a physical production worker/Electron process. Real shell completion is tested in the Core regression. Cross-process Stop persistence is intentionally outside scope; same-process bounded retention is the product contract.

## Reviewable implementation diff

`git diff 17e5524facb1a762505bc51b54676b21049a0142..8d3db6dfd` is the implementation and regression diff (documentation is additional).

```text
 packages/core/src/engine/run-finalize.ts           |  22 +
 packages/core/src/engine/run-goal.test.ts          |  37 ++
 packages/core/src/engine/run-goal.ts               |  45 +-
 packages/core/src/engine/turn-loop.ts              |  15 +-
 .../chat-session-manager.lifecycle.test.ts         |  57 +++
 .../chat-session-manager.migration.test.ts         |  32 ++
 packages/core/src/protocol/chat-session-manager.ts |  34 +-
 packages/core/src/protocol/chat-session.ts         |  13 +-
 packages/core/src/protocol/mobile-remote-types.ts  |  40 +-
 .../core/src/protocol/user-decision-lifecycle.ts   |  59 ++-
 packages/core/src/session/session-manager.ts       |   4 +
 .../agent-bridge-link-account-access.mjs           |  41 +-
 .../__fixtures__/agent-bridge-offline-goal.mjs     | 216 ++++++++
 .../main/__fixtures__/native-bridge-services.mjs   |  50 ++
 .../desktop/src/main/agent-bridge.nochild.test.ts  |  26 +
 packages/desktop/src/main/agent-bridge.ts          |  22 +-
 .../desktop/src/main/mobile-remote-orchestrator.ts |   1 +
 .../main/mobile-remote/handle-client-event.test.ts |  92 ++++
 .../src/main/mobile-remote/handle-client-event.ts  | 156 ++++--
 .../mobile-client-event-validator.test.ts          |  30 ++
 .../mobile-remote/mobile-client-event-validator.ts |  23 +-
 .../src/mobile-remote/remote-host-manager.test.ts  |  32 ++
 .../src/mobile-remote/remote-host-manager.ts       |  17 +-
 packages/web/app/DesktopApp.tsx                    |  18 +-
 .../web/scripts/test-goal-controls-browser.mjs     | 202 ++++++++
 packages/web/src/hooks/useRemoteApp.test.tsx       | 272 ++++++++++
 packages/web/src/hooks/useRemoteApp.ts             |  39 +-
 packages/web/src/hooks/useRemoteGoalControls.ts    | 219 ++++++++
 tests/engine-goal-startup-controls.test.ts         | 548 +++++++++++++++++++++
 tests/sdk-legacy-ask-user.test.ts                  | 275 +++++++++++
 30 files changed, 2504 insertions(+), 133 deletions(-)
```

## Independent CC acceptance suggestions

1. Review the implementation commit and final documentation diff against the recorded base; verify no primary checkout changes, pushes or merge occurred.
2. Re-run guarded startup, run-goal, lifecycle/migration, SDK, nochild, dispatcher, validator, Host capability and Web hook suites (explicit groups of at most eight files). Inspect persisted revisions after turn settlement and notification claim restoration, not just events.
3. Launch the actual Desktop/Web stack with a paused persisted Goal and a cold worker. Resume via Web, inspect one Core continuation with unchanged Goal identity/incremented revision; Stop and idle-evict with a long background shell, verify completion stays queued until new user input/resume.
4. Stop the worker and clear from Web; verify prompt correlated success and disk deletion with no worker spawned. Race a replacement Goal and verify old resume/clear cannot mutate it. Exercise disconnected/old peers and owner/workspace revocation.
5. Verify public SDK model question 2-minute recommended/skip, keepWaiting and cancel, plus ordinary approval 10-minute denial. Check same-run extension survives edit while pause/resume still resets its budget window.
6. Treat development read-only reviews as support, not as the user-requested independent CC sign-off. Remaining production E2E boundary above must not be described as tested.
