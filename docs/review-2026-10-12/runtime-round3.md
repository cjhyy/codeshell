# Runtime review round 3

Baseline: `84740d56e55517b004948a0a0e07649ad6fbf998`.
Product files were not changed. Reproduction ran under the guarded runner with isolated HOME and temporary local files; no model or external service was used.

## Confirmed: P2 — A failed final job-record write silently leaves a completed native task running

- Primary source: `packages/server/src/panels/tool-jobs.ts:768-774` (the rejected `run()` is swallowed after removing its active executor), `:806-830` (terminal state/result only become visible through `commit`), `:430-434` (job map changes only after storage write succeeds).
- Trigger: A native/background Panel task completes while its job directory cannot be written (for example filesystem permission or disk availability changes). The fixture makes the temporary job directory mode `0500` immediately before releasing a controlled executor. It observes the original storage method rejecting with real `EACCES`; it does not inject an error.
- Observed: The executor has settled and `active.size === 0`, but `get()` and `job.json` still report `running`, no result or error exists, and subscribers only received `queued` then `running`. `activeCount() === 1`. Explicit retry rejects with `tool job must finish stopping before retry`.
- User impact: The task remains spinning with no indication that final persistence failed. Its completed result is lost, and the host continues treating it as active. Hub configuration mutations use this count (`packages/server/src/panels/runtime.ts:1850-1853`, `packages/server/src/serve/headless-server.ts:546`) so configuration stays blocked until a manual cancellation or restart repairs the stale job state. A restored writable disk alone does not republish the completion. This is a silent status/result failure, not an unrecoverable task.
- Recovery verified: After restoring directory mode `0700`, `get()` still reports `running`. Explicit `cancel()` then changes it to `cancelled`, clears `activeCount`, and `retry()` can succeed. A second fixture runs a real separate Host process, leaves the stale checkpoint and exits without service shutdown; after permission restoration a new service marks it `interrupted` / `HOST_INTERRUPTED` with `activeCount=0` and does not automatically rerun it.
- Existing error presentation checked: `ToolJob.error` and commit/subscriber events support ordinary executor failures, and the transport maps rejected request methods into error replies. This completion occurs after `start()` has returned; `pump()` swallows the asynchronous final-write rejection before any error event, logger or other storage-failure callback runs. The fixture subscriber sees only `queued` and `running`.
- Reproduction: `node scripts/run-bun-test-shard.mjs --timeout 30000 /tmp/codeshell-review-20261012-runtime-round3/tool-job-final-write.test.ts`
- Evidence: `/tmp/codeshell-review-20261012-runtime-round3/tool-job-final-write.test.ts`, `/tmp/codeshell-review-20261012-runtime-round3/tool-job-write-crash-child.ts`, `/tmp/codeshell-review-20261012-runtime-round3/tool-job-final-write.log`; 2 tests passed, 0 failed, including assertion that write error is `EACCES`.
- Expected: Surface a storage/persistence failure to task subscribers and retain a recoverable terminal outcome or equivalent explicit interrupted/error state; do not silently retain a nonexistent active task.

## Paths reviewed without a new confirmed issue

- Hub worker crash settles pending runs, clears approval leases and resets reload-failure gate; replacement workers preserve host replay cursor.
- Hub settings mutation reports a non-200 when disk write fails, and gives an explicit saved-but-not-applied 503 when configure RPC fails.
- Core stdio shutdown awaits session/module teardown and background-shell reaping.

## Static candidates

None promoted without a reproduction in this round.

## Confirmed: P2 — CLI shutdown can leave an ordinary native Panel process alive

- Primary source: `packages/server/src/panels/process-service.ts:1065-1079` (`close()` only starts revocation), `:1082-1089` (`terminate()` saves but does not await `killProcessGroup`); `packages/server/src/panels/runtime.ts:1916-1922` (the async runtime close does not wait for `processes.close()` termination); `packages/server/src/serve/cli.ts:228-233` (exits the host immediately when server close resolves).
- Trigger: Close a local Hub/serve CLI while a normal native Panel process needs longer to stop or ignores SIGTERM. Panel processes are detached on POSIX (`process-service.ts:710`); escalation is a Host timer three seconds later (`packages/core/src/runtime/spawn-common.ts:310,327-395`).
- Reproduction follows the real authenticated Hub APIs: temporary local Panel installation and binding, `process.find`, directory grant, confirmed `process.spawn` for a temporary Node process. The native fixture registers a SIGTERM handler, prints its PID, and otherwise idles. The child Host calls the real `server.close()` then the CLI's `process.exit(0)` final step. All HTTP traffic is exact-origin guarded to this temporary loopback Hub before any Core import.
- Observed: Real `server.close()` returned in 2 ms, Host exited 0, and the detached native process was still alive 3.3 seconds later, after the intended SIGKILL grace. Host exit discarded the timer that should have performed escalation.
- User impact: Closing the server reports a successful shutdown while Panel native work can continue in the background, keep files/ports open and consume resources. The service has no persistent process receipt/PID recovery for these page-owned processes.
- Recovery/scope: Confirmed on macOS/POSIX; Windows uses a different process-tree path and was not tested. A process that honors SIGTERM may exit normally. The fixture explicitly kills only its own recorded temporary process group and verifies that PID is gone; no user process is touched.
- Reproduction: `node scripts/run-bun-test-shard.mjs --timeout 30000 /tmp/codeshell-review-20261012-runtime-round3/panel-process-close.test.ts`
- Evidence: `panel-process-close.test.ts`, `hub-native-close-child.ts`, `panel-process-close.log` in this directory. The older direct service smoke fixture `panel-process-close-child.ts` is retained but the reported test uses the real Hub path.
- Expected: `server.close()` should wait until all ordinary native process groups finish or their forced termination completes before allowing the CLI host to exit.

## T3 [P2] A worker pipe error can terminate the Node Host instead of settling the failed run

- Primary source: `packages/server/src/worker-bridge-core.ts:197-265` installs ChildProcess error/exit listeners but no error listener on `child.stdin`; `:336-340` writes a line and returns true without a write completion callback. The queued outbox writes at `:262-265` have the same stream boundary.
- Trigger: the worker exits or closes its read pipe while the Host is still writing a JSON-RPC request. A 256 KiB task is below the production WebSocket limit of 1 MiB (`serve/headless-server.ts:771`). The fixture worker consumes input then exits, reproducing the ordinary lifecycle race without any model/provider call.
- Observed: the real compiled WorkerBridgeCore in a native Node v25.8.1 Host returns `sent:true`; its stdin then emits asynchronous `EPIPE`, which becomes an unhandled Socket error and terminates the Host with exit code 1. The surviving-host marker is absent. A synchronous try/catch in a caller cannot catch this later stream event.
- Impact: a worker failure can take down the surrounding Hub/desktop Host instead of producing the intended worker-exit recovery, disconnecting clients and losing other live Host state. The exact race depends on a write overlapping worker exit; ordinary clean exits between requests are covered by existing code.
- Evidence: `reproductions/runtime-round3/worker-pipe-close.test.ts` and adjacent log, 1 pass / 0 fail / 3 assertions. Only a temporary fixture process is used and cleaned up.
- Direction: handle writable-stream errors and write completion for the exact child generation, settle affected pending operations and retire the failed worker without allowing an unhandled stream error to terminate the Host.
