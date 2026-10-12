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
