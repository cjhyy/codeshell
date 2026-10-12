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

First independent publication binds the existing Session directory incarnation
before writer admission and uses its exact existing transcript cutover. Missing
and ephemeral Sessions are not created. The existing 1 MiB/4,096-record legacy
cutover bound remains conservative. Missing/replaced journals, invalid identity,
interior corruption and known coverage gaps remain failures. Preliminary user
echoes still wait for a real canonical user anchor; a later producer cursor never
clears historical `unpaired` coverage. A persistence failure receives no cursor
and retains `outputRecovery: incomplete` in the existing observation path.

Existing Run-only records and cursors remain readable. The first independent
record is an additive v1 record extension with an explicit producer instead of a
Run ID. Older Core writers reject that record rather than replacing or extending
it; rollback therefore requires the compatible runtime, or restoring a verified
pre-upgrade Session backup. Mixed old/new writers are not supported. This is
forward compatibility with old data, not backwards write compatibility.

Verification at the first implementation checkpoint:

- Core/link/web/server package builds pass.
- 29 guarded existing journal and Goal-control tests pass.
- Four new guarded integration cases use actual native Goal disk mutations and
  NotificationQueue bus publication, then existing Main IPC/Desktop, Hub and
  Mobile recovery adapters. They prove commit before transport, cold Host
  restart, active Run continuation, absent fabricated Run IDs, stale owner
  rejection, persisted old-gap retention, deletion/reuse, corruption, invalid
  paths, pending input identity and physical state-lock failure.
- Network-denial guards precede Core/Host imports and verify two rejected probes.
  No operator HOME, credentials, provider request or paid model is used.

Remaining work for the full P1 recovery requirement: in-Main producers outside
Core's protocol, CC Room's separate transcript/room identity and historical
imports, automatic retention/rotation, evidence-preserving repair entry points,
and physical GUI/weak-network acceptance. The storage-spike prototype remains
inactive. These are outstanding requirements, not certified by the native
protocol increment.
