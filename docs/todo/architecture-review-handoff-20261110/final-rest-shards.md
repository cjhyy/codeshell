# Final assigned CI shard evidence

Candidate: `b7062fba47282d823e52bb29ea81aed686b0eb3f`, worktree `/private/tmp/codeshell-architecture-review-20261110`. Every invocation used `bun run test --shard N`, with `TMPDIR=/private/tmp/codeshell-architecture-tmp`; the repository runner isolated HOME. No source, branch, dependency or dist changes were made to that candidate. HEAD was checked before every shard. No paid eval, agent CLI, CC, push or merge was run.

All ten assigned shards were attempted. The final candidate plan has Node script suites at index 37 (the removed legacy Chromium shard shifts the old plan); this is not the earlier branch's Desktop Bun-script index.

| Shard | Suite | Result | Whole-shard totals | Exit |
|---|---|---|---|---|
| 4 | rest | incomplete | no whole-shard totals | 130 |
| 5 | rest-server | incomplete | no whole-shard totals | SIGTERM |
| 24 | Hub Panel packages | incomplete | no whole-shard totals | SIGTERM |
| 25 | Hub Panel runtime and scopes | fail | 40 pass / 81 fail | 1 |
| 26 | Hub Panel native processes | pass | 43 pass / 0 fail | 0 |
| 27 | Hub Panel background services | fail | 64 pass / 24 fail | 1 |
| 28 | Hub Panel tasks | fail | 73 pass / 2 fail | 1 |
| 29 | Hub Panel resources and files | fail | 70 pass / 15 fail | 1 |
| 30 | Hub Panel connections and automations | pass | 44 pass / 0 fail | 0 |
| 37 | isolated Node script suites | fail | 531 pass / 6 fail | 1 |

Each `shard-N.log` contains full output; `shard-N.json` records exit, counts, elapsed time and interruptions; `shard-N.failures.txt` removes duplicate reporter recaps. `results.json` aggregates the records. For incomplete shards, observed line counts are only partial and may include nested fixture output; they are not whole-shard counts. Shard 29's nested fixture printed 0/1, but its final outer total is 70/15. Node shard 37 completed all 537 tests (531 passed, 6 failed, no cancelled/skipped); its original generic Bun-only parser was corrected to read the native Node summary.

Incomplete shards and stop evidence:
- 4: `tests/visible-output-coverage.hub.test.ts:12` top-level await waits for a successful `reserve.listen(0, "127.0.0.1")` callback without rejecting on error. Sandbox listen failure leaves module import pending outside per-test timeout. `shard-4.interruption.json` has last-progress and stop timestamps. An external cross-exec process-group signal was refused with EPERM; the owning exec session was then interrupted with Ctrl-C (exit 130). The original orchestrator ended with that session; `resume.mjs` continued only the remaining shards.
- 5: `packages/server/src/links/remote-catalog.test.ts:39` awaits listen without error rejection, reached from the rejects assertion at line 78. No progress for over two 30-second test-timeout periods after sandbox listen rejection. Cooperative termination after 144 seconds is recorded in `shard-5.stop.json`; no whole-shard totals.
- 24: `packages/server/src/panels/management-http.test.ts:44` does the same in beforeEach. The fixture reports an unhandled between-tests listen error and cannot finish setup. Cooperative termination after 40 seconds is recorded in `shard-24.stop.json`.

Failure evidence and limits:
- Multiple suites report Bun `EADDRINUSE` on port 0; actual Node subprocess diagnostics report `listen EPERM`, establishing local-listener denial rather than a real allocated-port collision.
- Shard 4 also reports Engine `model_error`, active-close timeout, and the real sandbox-exec write test failure. These remain failed/unfinished; this run does not independently diagnose every Engine failure. Earlier baseline diskutil evidence is owned by the coordinator.
- Shard 27 reports `SERVICE_NODE_SECURITY_VERSION_REQUIRED:22.23.4/24.22.1/26.12.1` with installed Node 25.8.1 and `SERVICE_IDENTITY_UNAVAILABLE`; retained native custody fixture paths are in the log. No runtime or guard was weakened to make it pass.
- Shard 28's first failure is the local model server listen. Its second, “a delivered terminal event cannot bypass a missing final stdout receipt,” reproduced individually in the exact candidate (`tool-executor-recheck.log`). A temporary diagnostic in the agent's separate D1 worktree exposed owned native child stderr: `Error: EMFILE: too many open files, watch`, followed by process.exit code 1 (`tool-executor-diagnostic.log`). That diagnostic was restored and the agent worktree is clean; the final candidate remained read-only. No unexplained stdout-receipt change was papered over.
- Shard 37's six failures are: native process metadata query; native child cleanup identity query; fixed `/bin/ps` probe (`spawnSync /bin/ps EPERM`); actual HTTP upgrade (`listen EPERM`); SUID inventory expectation (observed mode 420 instead of 2468); and native wrapper cleanup receipt (`undefined` instead of `cleaned`). The last two are retained failures, not claimed green. All failure names and detailed native errors are in the per-shard artifacts.

D1 shared-message follow-up is independently committed as `e563a6944819b05b8ff6635cfdf4d5dc834cc6ae` on `codex/desktop/d1-parse-worker-line`, parent `fa7c752cde288f041253baa7e617f063e54f4370`, worktree `/private/tmp/codeshell-architecture-t3`. It adds existing-file regression coverage and a contract comment only, with no runtime behavior change. It was intentionally not integrated into this pinned CI candidate. Its own nine targeted files passed 113/0, Desktop/mobile typecheck and lint/shard checks passed. PR evidence: `/private/tmp/codeshell-d1-pr.md`.
