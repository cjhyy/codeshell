# Independent native output publication

This increment extends the existing production Session output journal to native
protocol events outside the Engine Run wrapper. Core's `AgentServer` persists
visible control/background events before sending the existing StreamEvent
notification. Cold Goal update/clear and the actual NotificationQueue completion
bus follow this path, so Desktop Main, standalone Hub and paired Mobile receive
real journal cursors without a new UI or transport.

A record names either its real Run or a distinct `protocol` publisher. Independent
records omit `runId`; no current Run is borrowed, created or completed. Appends
share the existing Session-state lock, immutable header pin, directory identity,
fsync boundary and hash chain. A still-current Run owner can extend a prefix
advanced by an independent producer after verifying that its own last committed
position is unchanged. Superseded Run owners still fail.

First native cursor observation or independent publication binds the existing
Session directory incarnation before writer admission and uses its exact
existing transcript cutover. An initial native cursor is verified against the
actual journal, so the first later no-Run notification cannot move to a deleted
and reused Session. Missing
and ephemeral Sessions are not created. The existing 1 MiB/4,096-record legacy
cutover bound remains conservative. Missing/replaced journals, invalid identity,
interior corruption and known coverage gaps remain failures. Preliminary user
echoes still wait for a real canonical user anchor; a later producer cursor never
clears historical `unpaired` coverage. A persistence failure receives no cursor
and retains `outputRecovery: incomplete` in the existing observation path.

One actual NotificationQueue envelope can fan out through multiple AgentServers.
They reuse the first committed publication in the same Session incarnation, so
each connection receives the same real cursor and recovery gets one event. This
memo is weakly held for the source object's lifetime; it is not a new durable
source-id registry, and does not claim to deduplicate unrelated enqueues. A new
connection cannot reuse an old memoized source after Session replacement.

Existing Run-only records and cursors remain readable. New records have explicit
storage version 2 and identify their real Run in `run.id`, or an independent
producer. The existing page contract still reports actual `frame.runId` and the
same cursor domain. Older Core writers reject those records rather than
replacing or extending them; rollback therefore requires the compatible runtime,
or restoring a verified pre-upgrade Session backup. Mixed old/new writers are not
supported. This is forward compatibility with old data, not backwards write
compatibility.

## Published watermark and automatic tail repair

After output fsync, each writer fsyncs its exact identity/sequence/offset/hash
watermark before returning a publishable cursor. Session state pins a fixed
4 KiB checksummed sidecar by inode and its immutable admission prefix; whole-state
saves preserve that pin. Per-frame writes update the same watermark inode and
do not replace Session state or fsync the directory. Missing, replaced, truncated,
checksum-invalid or torn sidecars fail closed and never fall back to the older
admission prefix. Earlier inline watermarks migrate under the Session-state lock
without changing existing cursors. Recovery captures publication before file
length, so a concurrent append cannot falsely invalidate the frozen prefix.
Recovery freezes a
published watermark; bytes written after it cannot become output coverage just
because a later reader finds a valid JSON event. New headers and record versions
require the watermark, so losing it remains a failure. A complete historical v1
file can acquire a watermark without changing its existing header, inode or
cursors. An old torn tail without publish evidence cannot be automatically cut.

A lost whole event or final fragment below the published watermark now blocks
all recovery and writer restart, including queries through an older cursor.
Previously the final-fragment case could be trimmed back to an empty log; that
discarded already published evidence. File replacement also cannot silently
change an existing watermarked Session into a fresh healthy cursor domain.

When the watermark proves a final partial event was never published, writer
restart copies the entire original file into a private evidence file, fsyncs it,
writes and fsyncs a SHA-256 receipt, and fsyncs their directory. Only then can it
truncate the same original inode to the unchanged published boundary. Evidence
or receipt failure leaves original bytes intact. Interior corruption, complete
unpublished events, watermark loss, known coverage gaps and sticky persistence
failures are not cleared by this automatic repair. A manual verified restoration
entry point and rotation are still outstanding.

Verification at the first implementation checkpoint:

- Core/link/web/server package builds pass.
- 29 guarded existing journal and Goal-control tests pass.
- Seven new guarded integration cases use actual native Goal disk mutations and
  NotificationQueue bus publication, then existing Main IPC/Desktop, Hub and
  Mobile recovery adapters. They prove commit before transport, cold Host
  restart, active Run continuation, absent fabricated Run IDs, stale owner
  rejection, persisted old-gap retention, deletion/reuse, corruption, invalid
  paths, pending input identity and physical state-lock failure. A result larger
  than Main's 8 MiB RAM budget is fragmented, reconstructed as exact UTF-8, and
  recovered after Host restart through all three UI adapters, preserving their
  existing bounded completion previews. The actual bus fans out to two native
  connections with one durable event.
- The compiled `test:output-journal` smoke performs a cold Goal mutation in a
  real stdio process, verifies the same no-Run cursor from a second process and
  Main/Desktop recovery, and recovers it through authenticated Hub HTTP/WS over
  two Host lifetimes. The existing exact-origin SDK smoke still validates a
  9,060,345-byte response, write-denial fencing, a journal near 128 MiB and frozen
  paging while a separate real writer appends.
- Network-denial guards precede Core/Host imports and verify two rejected probes.
  No operator HOME, credentials, provider request or paid model is used.

The watermark/repair follow-up adds guarded cases for published large-event
truncation, complete historical v1 migration, unknown legacy torn tails, absent
or malformed watermarks, stale whole-state saves, failed watermark commit,
evidence receipt failure, and exact original-byte preservation. Compiled SDK,
Main and authenticated Hub recovery still pass with the new record format.
The next checkpoint replaces per-frame atomic Session-state replacement with
the fixed watermark sidecar. All 66 guarded tests pass. The actual compiled SDK
fixture publishes 2,213 live frames and reconstructs the exact 9,060,345-byte
response in all existing consumers. Its instrumented model run takes 75,587 ms
on this Host; cold first-page recovery takes 217 ms and all 35 pages take 1,279 ms.
The near-128-MiB case takes 4,768 ms for 131 pages. Both real stdio workers and
authenticated Hub restart recovery pass. This still performs two synchronous
fsync operations per published event; batching/asynchronous storage remains
unresolved performance work, not a claimed elimination of stream latency.

Remaining work for the full P1 recovery requirement: in-Main producers outside
Core's protocol, CC Room's separate transcript/room identity and historical
imports, automatic retention/rotation, manual verified restoration entry points,
and physical GUI/weak-network acceptance. The storage-spike prototype remains
inactive. These are outstanding requirements, not certified by the native
protocol increment.

## Bounded rotation checkpoint

Production append/read now use `output-journal-storage.ts` after a whole-event
boundary reaches the 16 MiB soft segment threshold. A maximum-size event may
exceed that soft threshold but cannot cross segments; physical segments remain
below 32 MiB. The original `output-journal.jsonl` header and inode remain the
cursor identity anchor. Segment records retain the original absolute logical
offsets, sequence numbers and hash chain. A checksummed, inode-pinned 32 KiB
manifest records sealed boundaries, the active segment and the real retention
floor; state saves preserve its admission pin.

The retained journal budget is 256 MiB, including reserved space for the bounded
header/physical format marker, manifest and publication block, with at most 16
segments. Only complete sealed segments expire. The floor is fsynced before any
expired bytes are removed. The original anchor is retired by writing and
fsyncing a rejecting marker immediately after its header, then truncating that
same inode to header plus marker. A crash never exposes a header-only old-format
anchor. Repair evidence has a separate cumulative 128 MiB budget; exhausting it
refuses repair and preserves the source rather than deleting evidence.

Actual 0.9.34 code would otherwise ignore new metadata and incorrectly accept
header-only files. First migration therefore fsyncs a physical rejecting marker
before admitting the manifest. Its line deliberately lacks the old parser's
required record fields. The historical fixture is git blob
`4e5b336b9efca1fe890e41b286fa03eb28372537` from `4083718c`, with only three
relative import paths relocated; a test proves that exact blob identity. The
real historical reader and writer reject both first migration and a retired
anchor without changing source bytes.

A reader racing the first migration retries only a newly admitted, same-Session
storage format. In the prepare-marker window, it may freeze the exact older
published prefix only when the identity marker is precisely at that already
fsynced watermark and physical EOF is precisely after the marker. This does not
adopt unpublished records; a writer still rejects an interrupted unadmitted
migration. Other missing/damaged metadata, segments or identity pins fail closed.

Queries whose `after`/`through` range expired return existing `status: incomplete`,
`complete: false`, no frames and `reason: retention_expired`. A missing `after`
cannot claim a complete history after expiry. Retained cursors still identify
the same bytes and survive cold restart. This is bounded retention, not a claim
to reconstruct data deliberately expired by policy.

All 74 guarded tests pass, including nine first-migration flush fault points,
six retention flush fault points, truncate failure, exact historical parser
fencing, stale/missing/replaced segment authority, large native no-Run output
through Desktop/Hub/Mobile, and known coverage barrier preservation. The actual
compiled smoke passes after fixing the first-roll concurrency race: a separate
writer performs 84 appends and first rotation during 17 frozen pages while the
cursor and prefix hash remain unchanged. Compiled Main recovers a segmented
147,352,023-byte journal and rejects full recovery after retention expiry.
Authenticated Hub and two real stdio restart receipts still recover the exact
9,060,345-byte response. Instrumented model time is 81,939 ms; this checkpoint
does not solve synchronous per-event fsync latency or cold retained-prefix scan
cost.

Full P1 remains open: Main-produced asynchronous errors need source-incarnation
binding and ordered joining with worker output; explicit verified-backup repair
and diagnosis are not implemented; CC Room is a separate active branch; final
combined GUI/weak-network acceptance, full build/typecheck/lint and release
verification remain outstanding. Earlier text describing automatic rotation as
outstanding is superseded by this production checkpoint, not by the inactive
storage prototype.

## Main publication and bounded stream flush checkpoint

Main now captures an independent producer against the original Session before
Panel asynchronous dispatch. Before publishing a host event, it freezes recovery
through that event's real cursor and joins any committed worker events after
the last cursor actually applied to Main. An RPC response is not a notification
application fence. Only exact late notifications already applied from disk are
suppressed, using their actual cursor and canonical payload hash. Changed
replayed payloads and unknown backwards notifications retain coverage barriers.
Host events keep the external UI route; replayed worker events keep their
existing worker/outbound route. Rebinding or closing a Panel cannot redirect a
late failure; deleting and reusing its Session rejects that original producer.
Headless automation binds its first real Engine cursor and durably publishes
its later cleanup errors through the same producer lifetime.

Main stages at most 8,192 reconstructed events / 32 MiB per join, and admits at
most 8,192 pending replay identities. Overflow reports incomplete output rather
than discarding deduplication evidence or claiming complete coverage. This is an
explicit recovery bound; an expired initial range retains `retention_expired`.

The Run stream wrapper batches only text/thinking deltas for at most 8 ms,
64 events or 256 KiB. Every original event retains a distinct genuine cursor.
The writer fsyncs the complete batch and publication head before emitting any
of those events. Tool, approval, control and terminal events flush prior deltas
first. Run disposal flushes and releases its timer on completion, provider throw,
abort and Engine close. A timer write failure latches the durable failure fence;
pending deltas and later successful terminals are never published after it.

The compiled Core SDK/Main/Hub smoke after batching reconstructs the same
9,060,345 UTF-8 bytes with SHA-256
`8b43320c8ca500d14af6c51646c33f6f7397cd99ed2030be11d7ca324f0a9b71`.
On this Host, 2,213 frames take 6,120 ms (the rotation checkpoint took 81,939 ms).
Cold first-page/all-page times are 131/1,338 ms for the model journal and
296/7,250 ms for a 147,352,023-byte segmented journal. Frozen paging retains its
cursor while a separate actual worker appends 79 times and rotates storage.

`bun run test:output-paced` adds an independent loopback SSE process paced at
50 frames/second and a genuine compiled stdio worker/Main consumer. A 150-frame
run measures source-to-Main p50 44 ms, p95 69 ms, maximum 86 ms; 12 concurrent
control requests have p95 24 ms. A second run's cancellation produces a durable
terminal in 103 ms with no later timer output. Both p95 checks are bounded at
200 ms in the smoke. A second invocation measures stream/control p95 64/23 ms,
cancellation 187 ms, and additionally stops an active real worker with SIGTERM:
the original published prefix and durable non-success terminal recover after
that exact process exits. These are controlled fixture measurements, not a universal
latency promise. Network guards precede Core/worker imports, and credentials and
HOME are synthetic and isolated.

Actual Engine regressions prove pending-delta durability before non-success
terminals on provider throw, abort and close. A separate real process is killed
at accepted input without a result, then restarted against the original Session
inodes; a copied root is not substituted for crash recovery. Real Main methods
exercise late Panel dispatch failure after rebind, close and Session reuse.

The combined branch passes the complete guarded Core Engine/tool-system shard
(1,944 pass, three explicit live-model skips) and Core remainder (3,264 pass),
plus the 94 focused Main/journal cases, 32 source/coverage/consumer cases,
Desktop main typecheck, exact built exports and lint baseline (zero errors,
105 existing warnings). The full Core remainder initially found an unrelated
permission fixture that deleted HOME after cases which never set it; every case
now captures its original isolated HOME before cleanup. Its original ordered
permission/Collection/OAuth/real-SSE regression passes 41/41, without weakening
network confinement.

Remaining full-P1 delivery: merge and verify explicit manual backup/diagnostic/
restore and its fault matrix, integrate the separate CC Room and Services work,
and complete combined CI, physical UI/relaunch/weak-network acceptance and
authorized release. The pending repair marker already blocks all new journal
reader/writer admission. These items remain open until their actual production
paths and final combined checks pass.
