# CCRoom frozen history and recovery acceptance

Branch: `codex/desktop/cc-room-durable-recovery-20261012`, based on `8ce3d2c8`.

## Room history phase

`RoomManager.getHistoryPage` freezes a validated complete JSONL copy before returning the first page. Its room-local signed cursor binds the room, immutable snapshot, physical offset and sequence. Copies and manifests are fsynced and survive a new Host process; appending to the live room does not move a frozen boundary. Eight copies are retained per room; expired cursors fail explicitly. An invalid record, sequence gap, torn final record, invalid UTF-8, modified snapshot, unsafe file or resource limit is an error, never an empty successful catchup.

The archive freeze limit is 256 MiB, a bounded implementation limit rather than a completeness guarantee beyond it. Views validate the entire requested frozen range before applying it and cap one catchup at 50,000 messages; both limits produce visible errors. Large-history archival/compaction and background streaming rendering remain future work. Legacy `getMessages`/`roomHistory` keep their old bounded array contract for compatibility; current Desktop and Mobile consumers use the new pages.

Room appends fsync before `onMessage`, first-file and metadata creation sync their directories. Active-writer external modifications and uncertain write failures latch a local failure; cold sequence seeding strictly scans the complete log. This does not claim protection against a malicious privileged process racing every filesystem operation or hardware that lies about fsync.

Desktop fetches all pages, validates continuity, buffers live messages and repairs a later sequence gap from its last contiguous room seq. Mobile requests pages with a viewer request id, ignores stale replies, buffers live messages, and only commits a validated frozen range. Page replies prefer the authenticated requesting viewer connection, then the requesting device for older hosts without a viewer identity. Neither path manufactures a native Session, Run, producer epoch or native output cursor.

Validation so far: guarded 75/75 Room history/scaling/existing Room/accumulator tests; guarded 113/113 Desktop/Mobile/validator/existing Room tests. Server build passes. Full build initially exposed a TypeScript overloaded Stats return-type issue; fixed and Server rebuilt. Remaining workspace/Desktop build and transcript checkpoint acceptance follow in the next phase.

## Transcript checkpoint phase

The production Main supplies a private `mobile-remote/transcript-checkpoints` store. A checkpoint binds the Room, actual CLI kind/cwd/session id, canonical locator file path, device/inode incarnation, last complete newline, SHA-256 of its consumed prefix, and Room seq. These are external file observation coordinates; there is no native Run or producer cursor.

Before ingesting new complete records, the previous committed boundary is fsynced as `pending`. Room messages include the actual source incarnation/line-end/event-index key and fsync before fan-out. The checkpoint advances only after ingestion. A new Host retries pending ranges; Room seeds source keys from its strict durable log and ignores already committed source keys. The existing text/time heuristic for resident user-input echoes remains a heuristic; source-key replay deduplication does not claim a native CLI input acknowledgement protocol.

Shrink, rotation, same-size or longer prefix rewrite, malformed complete JSON/UTF-8, unsafe files, and oversized records latch a visible failure and a durable failed checkpoint. Restoring an old inode/prefix does not silently reactivate a failed checkpoint. A missing checkpoint with existing Room transcript provenance and a corrupt/mismatched checkpoint are barriers. Replacement transcript recovery requires explicit operator inspection/rebinding; this change deliberately does not erase a failure marker or write the external CLI file automatically. All transcript access is read-only.

The follower pins device/inode/birthtime, captures the initial size through its last complete newline, then re-reads that captured prefix in 64 KiB chunks to verify it did not change. Pure concurrent append is accepted. Changed files require consumed-prefix hashing, but only new suffix records are decoded/parsed; a bounded 500-message history ring serves later snapshots and unchanged files use a stat-only fast path. Limits are a visible 64 MiB file, 4 MiB record/partial-line, and 10,000 normalized-event catchup. Fully asynchronous verification and archive compaction remain future work. Incomplete final bytes are held at the prior newline even when the fragment happens to be valid JSON. A snapshot never advances beyond the committed source boundary.

Recovery failures reach both Desktop IPC and Mobile WS and preserve a visible conversation barrier. Desktop buffers at most 10,000 live seqs, checks view cancellation before every continuation, and resumes a missing-live-message gap after a frozen read finishes. Mobile uses correlated paginated replies, buffers live suffixes, and rejects stale pages.

Validation: guarded transcript + Desktop/Mobile shard 68/68, including actual synthetic JSONL files, cold new RoomManager/follower, crash after first Room fsync with a pending checkpoint, permanent inode/rewrite barriers, missing/corrupt checkpoint, delayed frozen-page/live interleaving and view cancellation. Server/Web builds and Desktop typecheck pass. Final production Desktop build and combined regression are recorded below after completion. No real CLI account, paid model or production service was used. The independent writer below is a synthetic local Node process writing only the test fixture.

## Independent writer and review follow-up

Root review identified and fixed an initial bug where size/mtime changes during a normal independent append were treated as permanent corruption. The replacement captures and verifies a frozen complete prefix while accepting same-incarnation growth. The guarded independent Node writer regression keeps writing split records during first subscription, later subscriptions, Room frozen pagination and a cold new follower. At 65,056,485 bytes, measured first capture was 773 ms, maximum changed drain 313 ms, cold subscription 456 ms and unchanged checks about 0.05 ms; no recovery barrier appeared. These local measurements are evidence, not a latency guarantee for all disks/hosts.

Checkpoint loads use a bounded 16 KiB descriptor read with descriptor/path/root checks after reading. Writes reject zero-progress and use exclusive UUID temporary files, cleaning only files created by that attempt. Room history manifests are capped at 512 KiB (4096 SHA-256 entries for a 256 MiB snapshot), with per-block verification while paging. A >10 MiB multi-page regression covers a manifest larger than the former 4 KiB cap. Retention errors preserve the already-published snapshot. Page and subscription replies prefer the authenticated viewer connection, avoiding same-device/multiple-tab collisions; two viewers using the same local request counter are tested.

Recovery/overflow failures latch on both clients; an in-flight final page cannot reopen the failed boundary. History errors carry the original request id so a stale failure cannot cancel a newer catchup. A guarded 58/58 affected client/handler shard covers these races. Claude and Codex recent-history regression cases start with 540 messages, exercise 500-message eviction, append interleaved user/assistant/tool/result records, and compare late-viewer limits 7/1 and a cold follower against the maintained full-history parser (5/5 follower tests).

Final affected dependency builds (Core, Web, Server), the complete production Desktop build (Main/preload/renderer/mobile/Chrome extension), Desktop renderer/mobile typechecks, Web library/app typechecks and ESLint pass. Generated Chrome extension output is excluded from the source change. The final guarded combined shard passed 160/160 tests, 652 assertions across 10 files in 82.15 seconds, including the five new client/ring regression cases. Its independent writer completed normally at 65,056,485 bytes with first capture 730 ms, maximum changed drain 330 ms and cold subscription 476 ms. The local regression log is `/tmp/ccroom-final-regression-20261012.log`.


## Architecture-budget and IPC review follow-up

The CCRoom follower wiring now lives with `transcript-subscriptions.ts`; Main
supplies its existing RoomManager, checkpoint directory, mobile broadcaster and
live BrowserWindow enumeration. Destroyed windows are still skipped. Frozen
Room history validators are re-exported through the existing browser-safe
message mapper entry, keeping Desktop package imports unchanged.

The typed `roomHistoryPage` preload method uses the existing
`ccRoom:roomHistory` channel and shared invoker. Undefined/number arguments retain
the legacy bounded-array contract. Only a validated plain object selects frozen
pages: reject unknown keys, arrays/null/non-records, unsafe or negative sequences,
limits outside 1–500, empty/non-string/over-2048 cursors and cursor+sinceSeq.
The existing Main IPC authority and the RoomManager's Room-bound signed cursor
remain in the path. Extracted history registrations are explicitly counted by
the architecture guard rather than hidden by moving them.

After normally merging reviewed project-chooser extraction `c2acd8d7` and
Electron smoke helper updates `7a558f99`, budgets remain unchanged: Main **7244 ≤
7245**, Web export statements **21 ≤ 21**, Main registrations **345 ≤ 345**, preload
invokes **338 ≤ 338**. Guard plus actual Main history registrar tests pass **7/7**,
including real disk RoomManager legacy reads, frozen multi-page continuation
after a cold Host manager restart, a concurrent live suffix, cross-Room cursor
rejection and malformed page inputs rejected before any storage read.

The affected seven-file CCRoom/client/mapping regression passed **100/100**, 434
assertions. Web build, combined complete Desktop build (Main/preload/renderer/
mobile/extension), Desktop typecheck and affected ESLint passed. Generated Chrome
extension output is excluded from source delivery. This supplements the earlier
160-test regression; it does not claim new physical-device or GUI acceptance.
Logs: `/tmp/ccroom-budget-{regression,combined,combined-desktop-build,combined-desktop-typecheck,lint}-20261012.log`.
