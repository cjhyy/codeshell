# Native Core output recovery for Mobile

This source increment connects the existing Mobile conversation to the durable
Core journal. It adds no page, sidebar, or navigation entry. It is separate from
the frozen 0.9.29 release source and does not claim an installed release contains
this increment.

## Authorization and wire

An enabled Desktop advertises `outputJournal: 1` in both first pairing and later
authentication replies. The existing `session.select` negotiates an opaque
recovery selection. Main binds that selection to the authenticated socket viewer,
Session directory/incarnation, and the Session's current mounted project/root.
Every page resolves that authority before reading and again before replying.
The client cannot supply a storage root, filesystem path, page size, or arbitrary
selected Session. A different viewer, Session, selection, removed/replaced root,
retired connection, or revoked device cannot use the grant.

Main validates the exact bounded pre-journal transcript cutover with the Core
reader, then sends only `transcriptToStreamEvents` display events and the validated
cutover ID. Hidden injected/agent/system/policy input and image base64 do not enter
this new WS payload. File/image names, sizes, MIME and display paths, together with
stable submission IDs, survive. This is the existing display policy, not a claim
that all user text/tool arguments contain no private data. An incomplete or
oversized base does not become an approximate tail.

A stale asynchronous selection cannot overwrite a newer device selection. There
is one active page per viewer and at most eight across Main; overflow is rejected
without a pending-page queue. At most 128 viewer selections are retained. The
viewer response path closes and revokes a slow socket before its queued outbound
bytes plus the next message exceed 4 MiB. Viewer
close/revocation, new selection/create and room transitions revoke the old grant.

## Client join and bounds

The existing `useRemoteApp` builds a private candidate through the shared
`applyOutputJournalPage` whole-event validator, then replaces its display only
when the frozen prefix joins the latest actual Main snapshot/live durable cursor.
The Core cursor remains independent of the Main process epoch and sequence.
Append does not invalidate an older frozen upper bound. There is no content-based
deduplication or invented mapping from old Transcript IDs to Main sequences.

The Core frame budget stays 1 MiB / 512 frames per page, plus bounded cursor
metadata; individual decoded fragments stay at 64 KiB, assembled events at
16 MiB, and one journal at 128 MiB. The raw legacy prefix and its display
projection are each bounded at 1 MiB. Client recovery stops after 2048 pages or
eight catch-up rounds, with one outstanding request and a 10-second request
watchdog. No auxiliary unbounded live-output queue is kept.

Main also retains a bounded coverage proof independently of its evictable RAM
suffix: at most 128 cumulative preliminary input IDs / 32 KiB of UTF-8 ID payload
per Session snapshot lifetime in this Main process (not just concurrently pending inputs),
with a 4 MiB global ID payload budget. A preliminary user input must match an
actual candidate user record's stable submission ID. Missing, malformed or
unmatched IDs, invalid/non-advancing cursors, and uncovered visible events such
as wrapper-external errors or Goal updates fail closed even after RAM eviction.
Overflow discards the proof and keeps its barrier closed, rather than silently
forgetting a gap. This cap can close recovery after 129 different submissions;
IDs are not retired without an acknowledged coverage proof. Session deletion/forget
or a new Main snapshot domain starts a fresh proof; it does not retroactively make
outside-wrapper history durable. A new Run does not clear uncovered historical errors or Goal
state. Durable publication for those outside-wrapper/no-run producers remains a
separate TODO; this increment does not claim their history is recoverable.
A repeated submit ID is idempotent, as in the existing Core run-result contract:
it pairs to the original recorded user/result even if caller text differs. It
never becomes a new instruction by comparing text. The client immediately joins
the journal to prove a repeat without expecting a new start or model request;
unrecorded IDs remain temporary only if this selection observed them, and an
unknown missing ID fails closed.
The client holds a stable-ID preliminary input for at most 10 seconds, with
128 / 32 KiB bounded pending IDs; only a strictly advancing, recorded top-level
start with the same ID resumes a waiting new-input candidate join. Ordinary suffixes and terminal
events cannot bypass that wait, and a start cannot clear a failed selection.
Session title is existing metadata rather than coverage: a late title arriving
during recovery may require the subsequent metadata refresh.

A same-epoch missing sequence leaves applied output behind the barrier; its
suffix and terminal cannot leap across the missing frame. Negotiated recovery
repairs the gap from the journal. Cancellation, project/room change, reconnect,
unknown cursor, corruption, or a timed-out join discards the private candidate and
keeps existing visible content. EOF and a complete page are coverage statements;
only a recorded terminal can complete a run. Old peers and old/in-flight output
without a provable common cursor retain explicit conservative degradation.

## Verification and limits

The private-HOME guarded unit shards exercise the actual hook, Main dispatcher,
real journal reader/writer, two same-device viewer sockets and first-pairing
capability. They cover frozen append, stable input IDs, same/new Main epoch,
same-epoch gaps, wrong viewer/selection/Session, pending-selection cancellation,
project revocation, corrupt journals, legacy hidden/image wire sentinels, and
single-flight/global read limits.

`bun run test:mobile-output-journal` uses the isolated native launcher. Before
its first Core/Host import it installs the existing exact HTTP fixture-origin
guard and checks a rejected off-origin request. It then uses the compiled Engine
and real SDK via the actual AgentServer/ChatSessionManager input producer with synthetic local responses (>2000 frames and >8 MiB, followed by a small second request and an idempotent retry without a third model call), the
actual RemoteHostManager authenticated WS, production Main handler and mounted
root authorization, and the actual React hook. Its native WebSocket constructor
is locked to the same exact fixture `/ws` URL and has a negative probe; the HTTP
guard's rejection of custom transports is retained. Node >=22.16 is required for
this test's native WebSocket; the product runtime floor is unchanged. PID/PPID,
private-HOME hash and the pre-import guard receipt precede the native result.
The guard is fixture-level confinement, not an OS network sandbox.

The native receipt reports RAM eviction, recovered bytes/hash, page count/size,
stable submit identity, new Main epoch with stable journal cursor, a dropped live
frame repaired in the same epoch, unfinished EOF, retained visible content after
damage, revoked mounted-root authority and device, and an authenticated WS
reconnect. The Main epoch change is an actual transport restart in the same owned
PID, not a cold process restart. The fixture has a 90-second total watchdog and a
30-second build limit. The native model emits only text; sensitive-tool redaction
is covered by existing Core privacy tests and is not claimed as a native tool
end-to-end result here. No paid model, real account, physical
phone, or provider credentials are used.

External Runtime producers, CC Room transcripts, paired Panel business flows,
arbitrary historical imports, retention/rotation, repair UI, full physical Mobile
GUI and weak-network acceptance remain separate TODOs. This transport increment
does not mark the whole long-stream recovery TODO complete.
