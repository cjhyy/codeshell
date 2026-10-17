# Read-only cross-review — CHAT-R11-01

Reviewer: hooks_data_round11. Frozen product baseline: `b8b776d56e5982e59b18de0262d5c49367746625`. No tests, runner invocations, product edits, dependency changes, Git writes, external requests or platform operations were performed by this review. Inputs were enumerated with `rg --files` before reading. The initial evidence review was followed by a final read of `chat.md` and `chat-{findings,candidates,validation,source-manifest,artifact-receipt}.json` after those files appeared. This final review approves the recorded bounded claim and completed report wording.

## Verdict

**Support P3**, with the claim scoped to a rejected initial `NotificationDeliveryProgressStore.load()` poisoning that handler's later retries. This has a stronger normal producer and retry contract than the Hooks registration candidate: the production watcher explicitly retries failed handlers, and CLI/Desktop install the same notification handler and progress instance once for the watch lifetime. The final report keeps the limits below; no candidate downgrade is required.

`NotificationDeliveryProgress.ensureLoaded()` caches the promise using `this.loadTask ??= ...` (`packages/chat/src/notification-progress.ts:187–191`), and `begin()` awaits it on every event (`:114–116`). A rejected promise is never evicted. `createDesktopNotificationHandler()` constructs that progress object once and calls `begin()` before delivery (`packages/chat/src/notification-relay.ts:97`, `:123`). This is independent of event cursor, adapter failure handling or progress-file validation policy.

The normal recovery contract is visible in `DesktopControlClient.watchEvents()` (`packages/chat/src/desktop-control-client.ts:164–218`): a handler rejection reaches the catch, preserves cursor and retries with backoff; successful replay calls `onRecovered`. The existing source test explicitly names and verifies “retries a failed event handler and checkpoints only after success” (`desktop-control-client.test.ts:256` onward). This review only read that test; it did not execute it. Real CLI wiring (`packages/chat/src/cli.ts:116–136`) passes one handler plus `FileNotificationDeliveryProgressStore` and logs a retry status. Desktop wiring (`packages/desktop/src/main/im-gateway-service.ts:565–585`) does the same and clears the retry status on recovery. FileStore `load()` propagates non-ENOENT failures (`notification-progress.ts:46–75`), providing static reachability for ordinary read errors; no real I/O failure was produced here.

## Dynamic evidence and controls

The preserved first focused log confirms **4 pass, 0 fail, 0 skipped, 33 expect calls** with clean guarded completion. The fixture actually runs `DesktopControlClient.prototype.watchEvents`, actual relay creation/handler and actual progress class. It substitutes only an in-memory store, event-page callback, sleep callback and fake send adapter, calling the prototype against a minimal receiver without constructing a client. No descriptor, socket, credentials, real file, platform adapter, request path or client constructor is exercised.

The poisoned-handler case repeats the same error object three times, calls store.load once, sends zero messages, retains cursor 0 and backs off 1/2/4. A new handler with the same now-healthy fake store loads again and sends the exact ordinary event successfully. The healthy-first-load control delivers once; the write-failure control demonstrates same-instance write recovery and therefore distinguishes this initial-read cache from a general progress-store retry policy. The fourth focused test checks ordinary UTF-16-safe splitting. All are passing characterizations of current behavior, not regressions proving a fix. The unchanged capability baseline is separately **2 pass / 58 expect calls**, clean. No failure or repair/rerun was visible in these two logs.

Read artifacts: `chat-progress-load.test.ts`, `chat-progress-load.first.log`, `chat-progress-load.first.exit.json`, `chat-channel-baseline.first.log`, `chat-channel-baseline.first.exit.json`, `chat-progress-dedup.json`, `chat-primary-contracts.json`. Historical progress dedup contains prior source coverage but no same-root-cause confirmed initial-read recovery record.

## Limits for final integration

- Say a transient/repaired store read **can leave the same notification handler permanently replaying the cached rejection until recreated**; do not claim that real disk EIO/EMFILE, corrupt-file repair or real Desktop/CLI recovery was executed. FileStore reachability and production assembly are source-only.
- The fixture aborts after three retries. An indefinite poisoned handler follows from the unchanged cached promise and watcher loop, not an unbounded runtime observation.
- Checkpoint persistence was omitted in the focused fixture. Cursor behavior was observed in memory; do not claim a real durable cursor file, Desktop pruning or external delivery.
- Default in-memory configured-target selection runs as ordinary handler setup. No authorization, permission, credential, custody, attachment descriptor or security experiment is established or needed for this result.
- The Mattermost/WeCom external documentation reads are unrelated to this finding and do not upgrade it into a platform formatting claim. Their failures/skips remain excluded.

## Final report and receipt reconciliation

The final Chat report and JSON agree on **1 P3** (`CHAT-R11-01`) plus **1 static/unconfirmed/SKIP candidate** (`CHAT-R11-C1`, Markdown button rendering). That candidate has no product fixture and its unavailable external contract reads remain skips; the report does not claim an exact Mattermost renderer result. The WeCom old limit direction is excluded from new counts.

Validation JSON, first logs, report table and artifact summary agree on **2 clean first shards, 6 pass, 91 expect, 0 fail, 0 skipped**, comprising 4 focused and 2 unchanged baseline tests. All **24/24** source manifest rows were independently recomputed against their frozen Git blobs and current files; all source SHA fields and current equality flags matched. All **16/16** final artifact receipt rows matched actual byte sizes and SHA-256 hashes. The receipt intentionally does not include itself. All **22** final local Markdown links in `chat.md` resolve, including source anchors within file line counts and fixture/log/JSON references. These are metadata checks, not new product tests.

The finding's `dynamicScope`, source manifest and report all explicitly state prototype-only watcher invocation, no client constructor/request/descriptor/spawn/checkpoint; production CLI/Desktop/FileStore wiring remains static. The report correctly distinguishes the 3-retry observation from the indefinite-cache consequence, denies permanent event loss, and confines real-send evidence to the fake adapter. Final wording matches this review's supported bounds.

No actionable defect was found in the final report, JSON, fixture, count receipts, controls, source/artifact hashes, local references or bounded P3 root cause. This reviewer ran **0** new test commands and changed only this review note during the final reconciliation.


### Final all-history metadata supplement

After the first final reconciliation, Chat added `chat-all-history-dedup.json` and updated only the report/findings dedup scope wording and artifact receipt. The supplement covers **1601 prior docs/bugs MD and parsed JSON files**, including archive/_archive and ordinary filenames, with **35 path/helper-related matching files and 0 parse errors**. The earlier **1111** audit/review-named subset and its broader keyword counts remain distinct; their match counts are not subtracted or treated as new findings. The added ordinary design/roadmap matches discuss existing notification progress, not the cached initial-load rejection root cause.

This reviewer independently recomputed bytes and SHA-256 for all **1601/1601** corpus rows and compared the path/hash set to the independently collected Hooks all-history corpus: identical file set and identical hashes, with zero current-file mismatch. The updated report and finding dedup text accurately distinguish this all-history supplement from the earlier subset. The source manifest, validation and metadata assembler hashes remain unchanged from the preceding reconciliation; product evidence, claim severity, static/dynamic limits and first test logs are unchanged.

Rechecked final **16/16** artifact byte sizes/hashes and all **22** final local report links/line anchors: no mismatch or missing target. The new artifact is the all-history receipt; `chat.md` and `chat-findings.json` carry updated dedup wording. This last pass performed **0 product test runs**, changed only this review note, and found no reason to alter the supported narrow P3. Review writes are now finished for root indexing.
