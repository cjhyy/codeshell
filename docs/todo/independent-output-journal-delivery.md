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

Existing Run-only records and cursors remain readable. The first independent
record is an additive v1 record extension with an explicit producer instead of a
Run ID. Older Core writers reject that record rather than replacing or extending
it; rollback therefore requires the compatible runtime, or restoring a verified
pre-upgrade Session backup. Mixed old/new writers are not supported. This is
forward compatibility with old data, not backwards write compatibility.

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

Remaining work for the full P1 recovery requirement: in-Main producers outside
Core's protocol, CC Room's separate transcript/room identity and historical
imports, automatic retention/rotation, evidence-preserving repair entry points,
and physical GUI/weak-network acceptance. The storage-spike prototype remains
inactive. These are outstanding requirements, not certified by the native
protocol increment.
