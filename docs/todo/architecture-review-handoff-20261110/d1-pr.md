Title: refactor(desktop): parse worker lines once before dispatch
Draft only: no push or PR creation; implementation awaits independent CC review.

Base: reviewed integration candidate 9c77751df (stacked architecture work, not main). Branch: codex/desktop/d1-parse-worker-line. Worktree: /private/tmp/codeshell-architecture-t3. C4 is independent of D1 and is not part of this branch's base.

A streamed worker message with a configured quick-chat fork router was decoded ten times in Electron Main. Parse it once at handleWorkerLine entry and pass an explicit ParsedWorkerLine carrier through every downstream reader. The carrier retains the raw line plus the decoded value; invalid JSON has an explicit carrier with message undefined, so optional helper parameters cannot accidentally parse the same invalid input again. Standalone line helpers keep their existing raw-string calls through an optional parsed argument.

Current dispatch inventory, in preserved order:
1. WebConfigurationGate.observe.
2. updateTentativeRunLifecycle.
3. workerHost.intercept; the Host dispatcher carries request.message to the existing operationBatch, credentials, browser, credentialCookie, workspace, panel, hostAction and automation handlers. The generic host-action envelope and argument parsers share the same result too.
4. maybeHandleCronChanged (consume/return).
5. routePetProjectionLine (consume/return).
6. routePetReportLine (consume/return).
7. quickChatForkRouter.routeWorkerResponse (newer than the checklist's original inventory).
8. log summary, parseSnapshotAppend, the existing output-ownership and snapshot checks, parseLiveStreamEnvelope fallback, and replaceStreamEventInLine for outbound taps.

All routing predicates, authority decisions, reply formats, event annotation, interception order and early returns remain in place. Pet changes are limited to these two AgentBridge methods receiving the parsed input; no Pet service, product design, or concurrent convergence work changes. WorkerBridgeCore is unchanged.

Validation:
- bun run build completed before Desktop tests (dependency dist rebuilt).
- Full workspace typecheck passed; Desktop-specific typecheck also passed.
- lint: 0 errors / 90 warnings on this candidate; lint:test-shards passed (2,664 files, largest process 765); lint:engine-bypass passed.
- The actual AgentBridge regression fixture covers 22 lines and observes exactly 22 JSON.parse calls: streams including browser annotation and snapshot-excluded steer, invalid JSON, ordinary/correlated responses, cron/Pet private notifications, Host authorities/loopbacks (including malformed host action), source rejection and snapshot failure. It asserts the original handler order and consume/return behavior as well as retained forwarding/projection. Persistence is in-memory and WorkerBridgeCore framing/correlation is outside the measured boundary.
- Meaningful negative probe: restore only pre-D1 production files while retaining that fixture; the first streamed line fails with actual 10 parses versus expected 1. Restore implementation and the same test passes. Probe production files restored after the check.
- Targeted suite including all four existing agent-bridge test files: 112 passed / 2 failed across 11 files. The two untouched remote-credentials/link-account fixtures fail at localhost listen before importing AgentBridge, then hit their 15-second child timeout (Bun reports port 0 unavailable). Environment limitation, NOT reported green.
- Remaining nine targeted files: 112 passed / 0 failed, including parseStreamLine, worker-host-runtime, web-configuration-gate, quick-chat-fork-router, host-action-dispatch, browser intercept and stream projection.
- Three required repository contracts (architecture budgets, package boundaries, Desktop preload IPC): 29 passed / 0 failed. An initial package-boundary attempt found an ignored packages/arena/node_modules directory retained by this reused checkout after R1. Moved that task-created artifact directory intact to /private/tmp/codeshell-d1-retired-arena-build and re-ran cleanly; no tracked code changed.
- Extra main-output-durability integration attempt: four cases fail before parsing at SessionOutputJournal construction because /usr/sbin/diskutil cannot use the DiskManagement framework in this sandbox. Unverified here.
- Desktop build:main passed and bundled the changed production code. Full Desktop build was attempted but failed downloading CUA driver v0.34.1 from GitHub (ConnectionRefused); full bundle/Electron execution is unverified. No build bypass was introduced.
- No new test file, mock.module call, public export, golden-fixture change, protocol change or budget increase. The count assertion extends the existing isolated agent-bridge.mcp-credentials fixture/test. Only changed ranges formatted.

Evidence: /private/tmp/codeshell-d1-{build-before,typecheck-initial,typecheck,lint,shards,engine-bypass,parse-count-baseline,parse-count-initial,targeted,targeted-final,contracts,contracts-final,desktop-build,main-build}.log.

Integration plan: cherry-pick both D1 commits (fa7c752cd and e563a6944) into the full architecture review candidate, retain the coordinator's C4/C3 and other independent changes, and re-run combined checks. Rebase onto updated origin/main only after the dependency PRs merge following CC review. Do not merge this Astra-stage candidate. This agent did not run CC or another agent CLI.

Shared-input follow-up audit (same D1 branch; separate reviewable test commit):
- Each receiver was traced for mutation of the shared decoded value and nested params. WebConfigurationGate, tentative-run tracking, Host classification and nonmatching parsers only read the frame. Matching Host actions consume the line before any later reader; operation/credential/automation/panel callbacks retain their original early-return semantics. Pet generation normalization copies its changed fields, Pet report parsing constructs a fresh event, and both private paths consume. Quick-chat routes with a copied response envelope and invokes its successful-fork callback asynchronously; the production callback only reads the result.
- normalizeStreamEnvelope returns a new envelope and retains the event reference. parseSnapshotAppend/live normalization do not mutate it. Browser annotation copies event plus toolCall/result; replaceStreamEventInLine copies envelope plus params. Worker ownership and ComputerUse read the event. MainOutputPublisher's cursor verification reads it; its fingerprint deletes fields only from its own top-level copy. SessionSnapshotStore/OutputCoverage/lifecycle reducers update owned state and snapshot cloning, not the input event. No existing shared-object mutation requiring a production fix was found.
- Existing real AgentBridge fixture now deeply freezes every decoded object before all receivers and verifies serialized input is unchanged after processing; all 22 original dispatch/count checks still pass. Existing stream-projection suite now covers deeply frozen nested args/results/extra params through normalization, actual SessionSnapshotStore, browser annotation and outbound replacement. This asserts independent retained snapshots and re-reading the original unprojected message.
- Negative probe temporarily introduces an in-place toolCall.uiVisibility write: the new test fails with TypeError at that exact write while all three older projection cases pass. Probe restored. No runtime freeze, defensive clone, parse, or behavior change was added; worker-line.ts only documents the shared read-only contract.
- Revalidation: 113 pass / 0 fail across nine targeted files (one new test), Desktop + mobile typecheck pass, changed TypeScript ESLint pass, shard guard pass. Logs: /private/tmp/codeshell-d1-immutability-{targeted,typecheck,lint,shards,negative}.log. Runtime sources unchanged since fa7c752cde288f041253baa7e617f063e54f4370; the existing built dependency dist remains valid.
