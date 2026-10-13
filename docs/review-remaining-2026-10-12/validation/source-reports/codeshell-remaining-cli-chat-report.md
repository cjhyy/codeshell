# Coding / actual TUI / Chat / Link review — 2026-10-12

Snapshot: `62a58ac8702835f848108e152234a6bdd6c3eb3f`.

Source root: `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell`.

Review only. This agent wrote only `/tmp/codeshell-remaining-cli-chat-*`. No product changes, build/install/clean commands, published artifacts, real account access, real coding CLI, or model requests. Read `CODESHELL.md` first. Root completed the clean build/package gate before authorizing execution; no fixture consumed partially emitted dist.

Execution platform: macOS, native Node25.8.1 and guarded Bun1.3.11. Other OS process/terminal/service implementations were not executed.

## Result and counts

Ten grouped confirmed findings are recommended below. Four LSP observations are consolidated into two lifecycle findings; Slack and DingTalk share one ACK finding. Notebook source decoding and replacement data loss remain two findings because they have separate causes and fixes. Priority is a review recommendation.

| Inventory under `src/` | Production/support | Tests | Total |
| --- | ---: | ---: | ---: |
| coding | 68 | 51 | 119 |
| tui | 218 | 41 | 259 |
| chat | 37 | 25 | 62 |
| link | 4 | 1 | 5 |
| Total | 327 | 118 | 445 |

Complete path inventory: `/tmp/codeshell-remaining-cli-chat-inventory.txt`. These are inventory counts, not a claim that all 445 files received a line-by-line review. Source/lifecycle depth and unexecuted limits appear below.

Final custom guarded Bun shard: **7 tests, 0 failures, 0 skips, 37 expect calls**. It covers queue retry ordering, actual Telegram polling/download path, actual Slack callback + real durable queue, actual DingTalk callback + real durable queue, two Notebook behaviors, and Link registry agreement. Link control: **10 provider IDs and 30 action IDs match production Core**.

Final maintained-isolator native smoke: **9 normal/failure observations plus 1 cleanup observation, exit 0**: LSP happy shutdown; failed initialize; concurrent cold initialize; exited server reuse; spawn error host; Codex happy turn; Codex crashed turn; cooperative Claude close; stubborn Claude close. Cleanup reported **`livePids: []`**.

Actual PTY final controls: **3 successful native executions**, exit 0: onboarding Esc; onboarding Ctrl+C failure observation; in-tree renderer ordinary x/backspace/q input and raw-mode recovery. These run the actual Ink renderer with a real terminal. They are not browser CLI rooms.

## Confirmed findings

### C1 [P2] Codex exit after accepted turn leaves the owning session busy indefinitely

Sources:

- `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/coding/src/external-runtimes/codex/app-server-client.ts:272`
- `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/coding/src/external-runtimes/codex/runtime.ts:218`
- `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/coding/src/external-runtimes/codex/runtime.ts:299`
- `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/coding/src/external-runtimes/session-factory.ts:246`
- `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/desktop/src/main/external-runtime-service.ts:1172`

Trigger: app-server acknowledges `turn/start`, announces `turn/started`, then exits before `turn/completed`. This can occur on provider crash/update/termination during an ordinary running turn.

`failAll()` closes the transport and rejects pending RPCs only. At this point `turn/start` already settled. Runtime's separate `activeTurn.done` is resolved only by translated `turn_complete` or explicit runtime.close, so the session factory's turn-sink cleanup and Desktop's `await turn.done` never complete. New sends remain busy; Stop's interrupt RPC targets the already closed client and rejects. Closing the entire runtime is the available recovery.

Owned protocol server control produced `done`, events `session_started, stream_request_start, turn_complete`; crash server exited 7 and produced `pending`, `clientClosed:true`, only `session_started, stream_request_start`. Native run3, cases `codex_crash` false/true. The 200ms observation is deliberately bounded; source proves no timer/exit callback settles this promise. No real Codex CLI/model used.

Recommendation: propagate transport terminal failure into runtime turn termination and resolve/clear active state with a classified error exactly once.

### C2 [P1] Slack and DingTalk ACK messages that the durable inbox rejected

Sources:

- `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/chat/src/slack.ts:67`
- `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/chat/src/slack.ts:78`
- `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/chat/src/dingtalk.ts:80`
- `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/chat/src/lifecycle.ts:17`
- `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/chat/src/chat-gateway.ts:162`

Trigger: a legitimate new inbound text event while pending + preparing reaches maxPending, or enqueue persistence throws. Production gateway wires handler directly to queue.enqueue; dispatchSafely swallows its rejection. Slack then calls ack, DingTalk sends status SUCCESS. After the success ACK, the application has not durably accepted the request and holds no in-app retry copy. Platform message history may still allow the user to resend manually; end-to-end permanent irrecoverability is not claimed.

Both real adapter.run callbacks were exercised against a real owner-only persisted DeliveryQueue with maxPending=1 and an owned blocked seed delivery. Full queue: one handler attempt, success ACK, persisted pending contains only `seed`. Empty-queue controls: success ACK and persisted `incoming`. Valid platform message shapes, actual SDK listener registration; only start/connect/disconnect and ACK transport were substituted. No malformed packet, account, socket connection, or platform redelivery claim tested. Final Bun cases `slack_ack` and `dingtalk_ack`, full false/true. These confirm adapter ACK policy; platform retry timing remains outside fixture scope.

Recommendation: catch callback failures without relabeling rejected acceptance as success; preserve upstream retry or explicitly persist a dead-letter before ACK.

### C3 [P2] Unauthorized Telegram senders download and spool files before allowlist enforcement

Sources:

- `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/chat/src/telegram.ts:113`
- `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/chat/src/delivery-queue.ts:183`
- `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/chat/src/delivery-queue.ts:367`
- `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/chat/src/chat-gateway.ts:153`
- `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/chat/src/chat-gateway.ts:240`
- `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/chat/src/cli.ts:97`

Trigger: bot receives a normal document message in an allowed target from a sender excluded by allowedUserIds. Actual adapter factory passes no sender/target prefilter to Telegram; adapter validates freshness/message shape then calls the handler. Gateway handler enqueues before dispatch. Durable enqueue invokes attachment.load() and writes spool bytes before middleware checks allowlist. An excluded sender can consume authenticated bot downloads, memory/disk and queue capacity despite never reaching the model. README line79 claims downloads occur after allowlist.

Actual TelegramAdapter.run polled a fixture-owned exact HTTP origin returning a valid current document update. For `stranger`, downstream admitted=0 but both `/botfixture/getFile` and `/file/botfixture/doc.bin` were called. For `owner`, same calls and admitted=1. This traces the real adapter → enqueue → load → middleware order, rather than injecting an invalid internal packet. Local HTTP server and all own temp directories closed/deleted. One-byte media proves ordering; no load-volume stress, account, unauthorized model dispatch or remote exploit tested. Other channels were inspected for early allowlist handling but only Telegram is dynamically asserted here.

Recommendation: run admission checks before queue attachment materialization, while retaining durable acceptance before platform ACK.

### C4 [P2] Failed LSP starts do not have complete error and process ownership

Sources:

- `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/coding/src/lsp/client.ts:48`
- `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/coding/src/lsp/manager.ts:72`
- `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/coding/src/lsp/manager.ts:84`

Two observed launch-failure manifestations share incomplete startup lifecycle ownership. (a) ChildProcess emits `error` for a now-invalid cwd/missing interpreter after availability probing. LSPClient installs exit but no error handler; native Node raises an unhandled error and terminates the host. (b) A running language server rejects initialize; manager catches and returns undefined, but client is scoped inside try and assigned to managed.client only after successful initialize. The live failed child cannot be reached by shutdownAll; repeated attempts can accumulate children.

Owned executable normal server initialized and shut down. Owned initialize-error server left PID alive after manager.getClient returned undefined and manager.shutdownAll completed. Fixture explicitly SIGKILLed that owned PID. Separate owned native host with missing cwd exited1, stderr classified `Unhandled 'error' event` + ENOENT. Happy native handshake is the availability/stdio normal control. No real language-server install, user process or interpreter invoked.

Recommendation: own the child from spawn onward, turn async spawn errors into the awaited startup failure, and close failed initialization in finally/catch with bounded exit escalation.

### C5 [P2] LSP readiness state can return a dead client or false unavailable result

Sources:

- `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/coding/src/lsp/client.ts:58`
- `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/coding/src/lsp/client.ts:154`
- `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/coding/src/lsp/manager.ts:42`
- `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/coding/src/lsp/manager.ts:46`

The manager's ready/starting decisions do not represent actual completion and liveness. After a server exits, process remains assigned and process.killed remains false (it means kill() was called, not process exited); manager keeps returning the same dead client. New LSP operations cannot recover by lazy restart. Concurrent cold calls instead wait a fixed2s and return managed.client regardless of initialize state; a valid server taking2.2s to initialize yields undefined to the second caller while the first succeeds. LSP tool reports server unavailable/install advice in this branch.

Owned server exited3 after initialize: isAlive=true and next manager.getClient returned the exact same object. Separate2200ms initialize: second call after20ms returned undefined, first then returned ready. Happy handshake/shutdown is the normal control. Fixture clears its private dead client handle before shutdown solely to avoid spending the known30s request timeout in test cleanup; product's broken state is asserted before that test-only cleanup.

Recommendation: share a startup promise; invalidate client/state on terminal child events and distinguish exited/failed/starting from ready.

### C6 [P2, lower-frequency trigger] Claude runtime close returns while the provider remains alive

Sources:

- `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/coding/src/external-runtimes/claude-code/runtime.ts:223`
- `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/coding/src/external-runtimes/claude-code/runtime.ts:229`
- `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/coding/src/external-runtimes/session-factory.ts:141` (close unregisters routing, closes runtime, then disposes tool host/bridge)

Trigger: CLI is temporarily unresponsive to SIGTERM, installs a handler, or has descendants not reaped by killing the direct child. close() awaits interrupt(), but interrupt only calls child.kill(SIGTERM) and returns; no exit wait/escalation. Host teardown can finish while provider still runs, keeps turn.done pending and may retain filesystem side effects after the owning session closes.

Final native cooperative control exited and done settled after close. Owned executable with a SIGTERM handler was still alive700ms after close returned; done remained pending. Fixture SIGKILLed it, awaited done, final livePids=[]. This confirms ignored-SIGTERM direct child behavior; real Claude behavior and descendants/platform process groups were not exercised. Its concrete source/fix differs from old R31 Panel cleanup, although both are process-reaping defects.

Recommendation: await actual exit, escalate within a bounded grace interval and reuse owned process-tree teardown.

### C7 [P2] Ctrl+C in first-run TUI onboarding removes UI but never returns

Sources:

- `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/tui/src/ui/onboarding-runner.tsx:16`
- `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/tui/src/ui/onboarding-runner.tsx:31`
- `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/tui/src/ui/onboarding-runner.tsx:42`
- `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/tui/src/cli/commands/repl.ts:112`

Trigger: new user starts interactive code-shell/repl without saved credentials and presses Ctrl+C at the provider selection screen. Renderer exitOnCtrlC=true unmounts Ink; useInput suppresses that Ctrl+C from component handlers. runInkOnboarding waits only on onComplete/onCancel and never subscribes to instance.waitUntilExit, so neither promise settlement nor keepAlive clear runs. Screen and raw mode are restored but the CLI stays alive without UI.

Actual PTY through the maintained HOME isolator: renderer initially isRaw=true. Ctrl+C emitted terminal teardown and isRaw=false, but onboarding outcome remained pending for15s and host was still running. Esc control settled cancelled and raw=false. Independent ordinary x/backspace/q actual renderer control exited with three expected key events and raw=false. Fixture forcibly exited only after recording the bounded pending observation, allowing isolator cleanup. No fake stdin/isTTY or browser room was used. Linux/Windows terminal backends were not executed.

Recommendation: attach render rejection and waitUntilExit to the same idempotent finish(null) path.

### C8 [P2, generic SDK scope] Retried earlier same-target message is overtaken despite maxPerTarget=1

Source: `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/chat/src/delivery-queue.ts:247`.

Trigger: per-target serial gateway, message a has a transient delivery failure, then b arrives for the same target. pump skips a while its nextAttemptAt is in the future and selects b; maxPerTarget only limits concurrent operations. It does not preserve the documented per-target ordering through retry, so stateful conversational middleware can apply b before a.

Real DeliveryQueue maxConcurrent1/maxPerTarget1: control delivered[a,b]; transient a failure delivered[a,b,a]. Final guarded case fifo. Scope is exported generic ChatGateway/DeliveryQueue and configured serial consumers. Current product Chat CLI intentionally raises per-target concurrency to at least4 for Mimi steering; this finding does not claim that product path promises globally serial semantics.

Recommendation: hold later same-target records behind the first outstanding record when serial ordering is selected, while allowing other targets to progress.

### C9 [P2] NotebookEdit cannot read valid string-form notebook sources

Source: `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/coding/src/tools/notebook-edit.ts:77`.

Trigger: read a valid notebook whose source is a JSON string. readNotebook returns parsed JSON without normalization; read calls source.join unconditionally and throws instead of displaying cells. Jupyter permits either string or string[] on disk ([official format description](https://nbformat.readthedocs.io/en/latest/format_description.html#top-level-structure)).

Guarded real tool control with source["print(1)"] returned the preview; identical notebook with source"print(1)" rejected with join TypeError. Owned files deleted. No Jupyter process/libraries invoked. Recommendation: normalize string or array source when decoding.

### C10 [P2] NotebookEdit replace destroys cell metadata and required cell identity

Sources:

- `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/coding/src/tools/notebook-edit.ts:105`
- `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/coding/src/tools/notebook-edit.ts:145`

Trigger: replace the source of a tagged/annotated existing cell. Replacement constructs a fresh cell with metadata{} and no id/attachments, rather than preserving unrelated content. A parameters tag used by notebook automation disappears. Existing nbformat4.5 notebooks retain minor version5 but lose the required cell id ([official cell IDs](https://nbformat.readthedocs.io/en/latest/format_description.html#cell-ids)). New cells use the same constructor and also lack id.

Guarded actual replace changed a=1→a=2 successfully, while metadata.tags["parameters"] became{} and id"one" became undefined. Control verifies requested source update; data-loss assertions inspect the actual written file. Owned files deleted. Recommendation: preserve id/custom metadata/attachments on replace, clear only execution artifacts when appropriate, and allocate valid IDs for new cells.

## Execution ledger and safety boundary

Commands were run from the frozen review source root:

```text
node scripts/run-bun-test-shard.mjs --timeout 10000 /tmp/codeshell-remaining-cli-chat-core.test.ts
node scripts/run-isolated-node-smoke.mjs /tmp/codeshell-remaining-cli-chat-native.mjs
node scripts/run-isolated-node-smoke.mjs /tmp/codeshell-remaining-cli-chat-tui.mjs escape
node scripts/run-isolated-node-smoke.mjs /tmp/codeshell-remaining-cli-chat-tui.mjs ctrlc
node scripts/run-isolated-node-smoke.mjs /tmp/codeshell-remaining-cli-chat-tui.mjs input run3
```

Raw artifacts:

- `/tmp/codeshell-remaining-cli-chat-core.test.ts`
- `/tmp/codeshell-remaining-cli-chat-core-run1.log` (5pass0fail), `core-run2.log` (6pass0fail), `core-run3.log` (7pass0fail; authoritative final)
- `/tmp/codeshell-remaining-cli-chat-native.mjs`
- `/tmp/codeshell-remaining-cli-chat-native-run1.log` (failed fixture at missing claude.pid after earlier observations), `native-run2.log` (exit0), `native-run3.log` (added cooperative Claude control; exit0; authoritative final)
- `/tmp/codeshell-remaining-cli-chat-tui.mjs`
- `/tmp/codeshell-remaining-cli-chat-tui-escape-run2.log`
- `/tmp/codeshell-remaining-cli-chat-tui-ctrlc-run2.log`
- `/tmp/codeshell-remaining-cli-chat-tui-input-run2.log` (fixture failure: x/backspace/q sent as one paste)
- `/tmp/codeshell-remaining-cli-chat-tui-input-run3.log` (separate key writes; exit0)

First native run failed only when its owned executable without .mjs extension never wrote the expected pid; changing the fixture entry to .mjs made the full run pass. Do not treat this as a product finding. First onboarding Esc attempt used a2.5s observation window and arrived too late to demonstrate cancellation; expanding the window yielded an immediate cancelled control. First ordinary input attempt sent x/backspace/q as one paste, which useInput intentionally delivers as one string; separate0.5s key writes fixed the control. These fixture failures were retained; they are not counted as product regressions.

Bun fixture installs fetch/net/http/https/tls guards before product/Core imports. The only admitted network origins were exact127.0.0.1 HTTP server origins created by this fixture. Redirects were rejected. A negative fetch probe was blocked. Slack/DingTalk SDK connect/start calls were replaced before adapter.run, so no account connection occurred.

Native runtime fixture uses the maintained HOME isolator, asserts isolated HOME/application home, denies all networking before product imports, and permits only own hashed fixture subprocess entries under its own temp directory via Node or direct executable. It passes the network-denying preload to children; the one nested missing-cwd spawn is deliberately Node with an absent own cwd. No real language server, Codex, Claude, git command or paid model is launched. PTY fixture denies every network and subprocess path before Core imports.

Cleanup: real HTTP servers closed; origin grants removed; queue holds released and queue retry timers stopped; attachment/inbox/notebook temp dirs removed; all tracked owned child processes reaped or explicitly SIGKILLed; native final cleanup livePids=[]. PTY test processes ended0 after restoring raw mode and emitted terminal teardown; maintained isolator removes each private HOME. Parent review docs were the only observed untracked repo path; this agent made no tracked changes. Final HEAD remained62a58ac8.

Final read-only cleanup probe `ps -p 77273,77531,77892,77985,78466 -o pid=,stat=,comm=` returned no rows for this agent's recorded PTY child PIDs. `git diff --name-only` returned no tracked changes.

## Coverage by subsystem and limitations

The following lists identify files actually read at the stated level. Prefix all relative paths with the source root above. A source-directed review means the production entry, normal and error/stop/recovery path were followed; it does not imply every renderer layout branch or every existing test was executed.

**coding — source-directed and native/directed fixtures:** `src/lsp/{client,manager,servers,root-path}.ts`, `src/tools/lsp.ts`; `src/external-runtimes/codex/{runtime,app-server-client,model-discovery}.ts`; `src/external-runtimes/claude-code/runtime.ts`; `src/external-runtimes/{session-factory,index}.ts`; `src/external-runtimes/shared/{spawn-env,session-context-store}.ts`; `src/tools/{notebook-edit,brief,check-quota,drive-agent}.ts`; `src/quota/{index,credentials,types}.ts`; `src/cc-orchestrator/{agent-adapter,external-agent-driver,external-agent-bindings,external-agent-session-store,session-discovery,codex-session-discovery,cc-capability}.ts`; `src/external-agents/{config,types}.ts`; `src/capability-runtime.ts`; `src/index{,.capability,.git,.orchestration}.ts`; `src/tools/apply-patch/{index,applier}.ts`; `src/git/{parse-log,worktree/crud,worktree/git-exec}.ts`.

**coding — partial/supporting inspection:** `src/cc-orchestrator/session-history.ts` first200lines and discovery/session-store parser portions; `src/external-runtimes/shared/mcp-bridge.ts` entry/setup and close call chains; runtime/lifecycle tests; worktree CRUD initial210lines; apply-patch parser/types/backup helper inventory and references. Event translator internals, remaining session relevance/history parsers, git query/diff/slug and leaf prompt/review helpers were inventoried but not claimed dynamically covered. Quota endpoints were statically traced with credential source/timeout/cancellation; no provider quota endpoint called. CC orchestration driver's process tree teardown and DriveAgent foreground/background/abort/worktree-finalization flow were read; its real CLI integrations were not run. No new confirmed quota/orchestrator finding. Old R35 worktree create rollback race is excluded as duplicate.

**chat — source-directed:** all12 adapter production files `telegram,discord,slack,lark,dingtalk,wecom,wechat,matrix,mattermost,line,whatsapp,teams`; `src/{channel,adapter-factory,chat-gateway,delivery-queue,cli,gateway,bound-session-chat,ingress,attachments,lifecycle,media,webhook,config,desktop-control-client,instance-lock,notification-relay,notification-progress,wechat-storage,wechat-login,service-manager,codeshell}.ts`. Actual pre-load sender filtering was checked at adapter construction and adapter handlers: allowlist middleware is gateway dispatch-time, not an adapter admission callback. Signed webhook/SDK sender parsing, queues/dedupe/retry, reconnect supervising, credentials/context cursor storage and outbound notification checkpoints were followed statically. WeChat was reviewed through polling, media download/upload, stale context/tokenless fallback, account send serialization, QR/status requests and guarded state persistence.

**chat — remaining limits:** SDK/network protocol replacement is only dynamic for Telegram, Slack and DingTalk above. No real Discord/Lark/WeCom/Matrix/Mattermost/LINE/WhatsApp/Teams/iLink account, webhook credentials, QR login, platform retries, service install or Desktop auto-launch occurred. `platform-canary.ts`, vendor types and protocol/index leaf contracts were inventoried, with no live canary. Service definitions/config/load/status were reviewed statically across darwin/linux/win32, without claiming native service execution.

**tui — source-directed actual terminal entry and renderer lifecycle:** `src/cli/{main,exit,input/read-stdin,input/ndjson-reader,input-compiler}.ts`; `src/cli/commands/{repl,run,drain-notifications,link,plugin,settings-recovery,runs}.ts`; `src/bootstrap/setup.ts`; `src/ui/{index,onboarding-runner,App}.tsx`; `src/ui/components/{OnboardingPrompt,ProviderModelFlow,CommandInput}.tsx`; `src/render/{root,index}.ts`; lifecycle portions of `src/render/ink.tsx`, `src/render/components/App.tsx`, `src/render/hooks/{use-input,use-app}.ts`. Actual PTY runs cover provider-screen cancellation and ordinary input/exit/raw-mode restoration. App.tsx streaming/submit/exit/input routing and renderer mount/unmount/suspend paths were inspected by targeted sections; they are not claimed full-file deep coverage.

**tui — remaining limits:** no actual provider turn, external editor handoff, OS SIGSTOP/SIGCONT, SSH hangup, Windows console, saved model credential execution, or complete slash-command matrix. The rest of218 production/support renderer/UI/native-yoga/theme/leaf command files have inventory coverage, with selective searches and existing-test inspection only. No claim that Web CLI rooms verify TUI. CLI plugin/network installers and CLI Link credential detection were not executed. Existing full TUI suites were not rerun.

**link — complete portable source contract:** all4 production files `src/{catalog,types,management-types,index}.ts` and `catalog.test.ts` read. Catalog/auth guides/runtime/secret-location/availability/action IDs reviewed, final guarded contract compared all10provider IDs and30action IDs to Core's production local registry without executing any action. No manifest mismatch found. Provider documentation URLs/token scope correctness and live CLI login/browser OAuth are outside this no-account dynamic scope; manifests are metadata, not process/network authorization.

## Candidates not counted as confirmed findings

- REPL explicit model/provider/baseURL/API-key flags appear ignored when resolveLLMConfigForTag returns saved configuration (`packages/tui/src/cli/commands/repl.ts:134`), whereas run applies explicit overrides. Static candidate only: no actual saved-catalog startup fixture was executed, and seed Engine model-pool resolution may affect final behavior. Do not label as confirmed from this report.
- startInkRepl creates keepAlive before awaiting render, outside its cleanup try (`packages/tui/src/ui/index.tsx:67`), so a render rejection appears to leak interval/onExit. Static low-frequency candidate only; no render rejection or revoked TTY fixture. Distinguish from confirmed ordinary onboarding Ctrl+C.
- Lark dispatchSafely plus SDK callback completion may have the same acceptance issue as C2, but no actual SDK ACK boundary control was executed. Excluded from confirmed channel set.
- Unbounded attachment.load signal/cancellation in queue can retain preparation capacity; only pre-allowlist order was dynamically established. No timeout/cancel finding claimed.
- Failed attachment spooling intentionally falls back to memory-only records; restart durability implications are visible in source but were not added as a new finding without a separate real recovery fixture.
- Linux service ReadWritePaths/custom-path startup and systemd escaping were static possibilities only; no service-manager mutation or native service control run.
- Existing worktree rollback deletion risk duplicates old R35. Generic stdin EPIPE concerns overlap old R36; not re-reported. Claude native close is documented separately from old R31 Panel child cleanup because code ownership and teardown implementation differ.

Dedup sources read: `/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/README.md` and `priority-and-coverage.md` (86 findings at older84740/a66f). No confirmed finding here repeats an old issue's same source/root cause. R18 browser/server CLI busy handling is distinct from C1's coding runtime transport-to-turn contract; R63 notification priority queue is distinct from C8's per-target retry ordering.
